// System screen: GPU meters with sparklines, every chat model with load/unload, what's in VRAM,
// system RAM and the services. Meters update every second; model state every 3 seconds while visible.
import { invoke } from "@tauri-apps/api/core";
import { errMsg, http, lastModels, ping, OLLAMA, LLAMA } from "./backends";
import { bestFor, capsFor, chipsHtml } from "./caps";

const $ = <T extends HTMLElement = HTMLElement>(s: string, r: ParentNode = document) => r.querySelector(s) as T;

export interface Gpu {
  util: number;
  mem_used: number; // MiB
  mem_total: number;
  temp: number;
  fan?: number | null;
  power?: number | null;
  power_limit?: number | null;
  slowdown_temp?: number | null;
  target_temp?: number | null;
}

interface Row {
  key: string;
  id: string;
  backend: "ollama" | "llama";
  name: string;
  role?: string;
  diskGB: number;
  needGB: number; // estimated VRAM when loaded
  loaded: boolean;
  vramGB?: number; // measured (Ollama) or estimated (llama.cpp)
  loading?: boolean;
  args?: string[]; // llama.cpp router command line (for capability detection)
}

interface Deps {
  toast: (msg: string, kind?: string) => void;
  nameFor: (id: string) => { name: string; role?: string; hide?: boolean; order: number };
  openCatalog: () => void;
}

const GB = 1024; // MiB per GiB
// Measured on this PC: Qwen3.6 35B with 25 expert layers in RAM uses about 10.8 GB of VRAM.
const KNOWN_VRAM: [RegExp, number][] = [[/qwen3\.6-35b/i, 10.8]];
// Ollama runs every model with a 32k q8 KV cache (start-all.ps1), roughly 1.2 GB on top of the weights.
const OLLAMA_OVERHEAD = 1.2;

let deps: Deps;
let visible = false;
let rows: Row[] = [];
let lastGpu: Gpu | null = null;
let baselineMiB = 900; // desktop + driver use when no model is loaded; refined as we see it
const hist = { gpu: [] as number[], vram: [] as number[] };
let modelTimer = 0;

export function initSystem(d: Deps) {
  deps = d;
  document.querySelector("#sys-catalog")?.addEventListener("click", () => deps.openCatalog());
}

export function showSystem(on: boolean) {
  visible = on;
  clearInterval(modelTimer);
  if (on) {
    refreshModels();
    refreshServices();
    refreshRam();
    modelTimer = window.setInterval(() => {
      refreshModels();
      refreshServices();
      refreshRam();
    }, 3000);
    if (lastGpu) onGpu(lastGpu);
  }
}

// ---------- meters ----------
function spark(canvas: HTMLCanvasElement, data: number[], max: number, colorVar = "--red") {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (!w || !h) return;
  if (canvas.width !== w * dpr) {
    canvas.width = w * dpr;
    canvas.height = h * dpr;
  }
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const color = getComputedStyle(document.documentElement).getPropertyValue(colorVar).trim() || "#d6202b";
  const n = 60;
  const pts = data.slice(-n);
  const x = (i: number) => (w * (i + n - pts.length)) / (n - 1);
  const y = (v: number) => h - 2 - (Math.min(v, max) / max) * (h - 4);
  ctx.beginPath();
  pts.forEach((v, i) => (i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v))));
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  if (pts.length > 1) {
    ctx.lineTo(x(pts.length - 1), h);
    ctx.lineTo(x(0), h);
    ctx.closePath();
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, color + "55");
    g.addColorStop(1, color + "00");
    ctx.fillStyle = g;
    ctx.fill();
  }
}

/** Called every second with fresh nvidia-smi numbers, whether or not the screen is visible. */
export function onGpu(g: Gpu) {
  lastGpu = g;
  hist.gpu.push(g.util);
  hist.vram.push(g.mem_used / GB);
  if (hist.gpu.length > 60) hist.gpu.shift();
  if (hist.vram.length > 60) hist.vram.shift();
  // The desktop's own share, measured only while no model is in (or on its way into) VRAM.
  // A model mid-load isn't marked loaded yet, so ignore readings far above an idle desktop.
  if (!rows.some((r) => r.loaded || r.loading) && g.mem_used < 3 * GB) baselineMiB = g.mem_used;
  if (!visible) return;

  const total = g.mem_total / GB;
  const c = (id: string) => $(`#${id}`);
  $(".val", c("c-gpu")).textContent = `${Math.round(g.util)}%`;
  $(".sub", c("c-gpu")).textContent = `last 60 s · peak ${Math.round(Math.max(...hist.gpu))}%`;
  spark($("canvas", c("c-gpu")) as HTMLCanvasElement, hist.gpu, 100);

  $(".val", c("c-vram")).textContent = `${(g.mem_used / GB).toFixed(1)} / ${total.toFixed(0)} GB`;
  $(".sub", c("c-vram")).textContent = `${((g.mem_total - g.mem_used) / GB).toFixed(1)} GB free`;
  spark($("canvas", c("c-vram")) as HTMLCanvasElement, hist.vram, total, "--gold");
  c("c-vram").classList.toggle("hot", g.mem_used / g.mem_total > 0.92);

  const limit = g.slowdown_temp ?? 95;
  $(".val", c("c-temp")).textContent = `${Math.round(g.temp)}°C`;
  c("c-temp").style.setProperty("--v", String((g.temp / limit) * 100));
  c("c-temp").classList.toggle("hot", g.temp >= (g.target_temp ?? 83));
  $(".sub", c("c-temp")).textContent = [
    g.fan != null ? `Fans ${Math.round(g.fan)}%` : null,
    g.target_temp ? `target ${g.target_temp}°C` : null,
    g.slowdown_temp ? `throttles at ${g.slowdown_temp}°C` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  if (g.power != null) {
    $(".val", c("c-power")).textContent = `${Math.round(g.power)} W`;
    c("c-power").style.setProperty("--v", String(g.power_limit ? (g.power / g.power_limit) * 100 : 0));
    $(".sub", c("c-power")).textContent = g.power_limit ? `limit ${Math.round(g.power_limit)} W` : "";
  } else {
    $(".val", c("c-power")).textContent = "n/a";
  }
  // The bars inside the temperature and power cards read --v from their card.
  for (const id of ["c-temp", "c-power"]) {
    const bar = $(".bar > i", c(id));
    bar.style.width = `${Math.max(0, Math.min(100, parseFloat(c(id).style.getPropertyValue("--v") || "0")))}%`;
  }
  renderStack();
}

// ---------- models ----------
async function getJson(url: string) {
  const r = await http(url);
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
}

async function refreshModels() {
  const next: Row[] = [];
  const notes: string[] = [];
  const [tags, ps, lm] = await Promise.allSettled([
    getJson(`${OLLAMA}/api/tags`),
    getJson(`${OLLAMA}/api/ps`),
    getJson(`${LLAMA}/models`),
  ]);
  if (tags.status === "fulfilled") {
    const running = new Map<string, number>();
    if (ps.status === "fulfilled") for (const m of ps.value.models ?? []) running.set(m.name, (m.size_vram ?? m.size ?? 0) / 1024 ** 3);
    for (const m of tags.value.models ?? []) {
      const info = deps.nameFor(m.name);
      if (info.hide) continue;
      const disk = (m.size ?? 0) / 1024 ** 3;
      next.push({
        key: `ollama:${m.name}`,
        id: m.name,
        backend: "ollama",
        name: info.name,
        role: info.role,
        diskGB: disk,
        needGB: disk + OLLAMA_OVERHEAD,
        loaded: running.has(m.name),
        vramGB: running.get(m.name),
      });
    }
  } else notes.push("Ollama isn't answering");
  if (lm.status === "fulfilled") {
    const list = lm.value.data ?? [];
    const paths = list.map((m: any) => {
      const a: string[] = m.status?.args ?? [];
      const i = a.indexOf("--model");
      return i >= 0 ? a[i + 1] : "";
    });
    const sizes: number[] = await invoke<number[]>("file_sizes", { paths }).catch(() => paths.map(() => 0));
    list.forEach((m: any, i: number) => {
      const info = deps.nameFor(m.id);
      const disk = sizes[i] / 1024 ** 3;
      const known = KNOWN_VRAM.find(([re]) => re.test(m.id))?.[1];
      next.push({
        key: `llama:${m.id}`,
        id: m.id,
        backend: "llama",
        name: info.hide ? `${info.name} (computer use)` : info.name,
        role: info.role,
        diskGB: disk,
        needGB: known ?? Math.min(disk + 1.5, 11.5),
        loaded: m.status?.value === "loaded",
        loading: m.status?.value === "loading",
        args: m.status?.args ?? [],
      });
    });
  } else notes.push("llama.cpp isn't answering");

  // llama.cpp can't report per-model VRAM on Windows, so attribute what's left after Ollama's share.
  if (lastGpu) {
    const ollamaGB = next.filter((r) => r.backend === "ollama" && r.loaded).reduce((s, r) => s + (r.vramGB ?? 0), 0);
    const llamaLoaded = next.filter((r) => r.backend === "llama" && r.loaded);
    const rest = Math.max(0, (lastGpu.mem_used - baselineMiB) / GB - ollamaGB);
    for (const r of llamaLoaded) r.vramGB = rest / llamaLoaded.length;
  }
  // Keep "Loading…" on rows we're working on.
  for (const r of next) if (rows.find((o) => o.key === r.key)?.loading && !r.loaded) r.loading = true;
  next.sort((a, b) => deps.nameFor(a.id).order - deps.nameFor(b.id).order || a.name.localeCompare(b.name));
  rows = next;
  $("#models-note").textContent = notes.join(" · ") || "llama.cpp holds one model at a time";
  renderRows();
  renderStack();
}

function renderRows() {
  const box = $("#model-rows");
  box.innerHTML = rows.length ? "" : `<p class="credit">No models answered. Start the services from the Chat screen.</p>`;
  for (const r of rows) {
    const el = document.createElement("div");
    el.className = "mrow" + (r.loaded ? " loaded" : "") + (r.loading ? " busy" : "");
    const state = r.loading ? "Loading…" : r.loaded ? "In VRAM" : "On disk";
    const size =
      r.loaded && r.vramGB
        ? `${r.backend === "llama" ? "~" : ""}${r.vramGB.toFixed(1)} GB in VRAM`
        : `${r.diskGB.toFixed(1)} GB on disk`;
    el.innerHTML = `<span class="n"></span><button class="btn"></button><span class="meta"></span><span class="caps"></span>`;
    // Models hidden from the chat menu (UI-TARS) still get their capabilities shown here.
    const mi = lastModels.find((m) => m.key === r.key) ?? { key: r.key, id: r.id, backend: r.backend, name: r.name, detail: "", order: 99, args: r.args };
    capsFor(mi).then((c) => {
      $(".caps", el).innerHTML = chipsHtml(c);
      ($(".caps", el) as HTMLElement).title = `Best for ${bestFor(c)}`;
    });
    $(".n", el).textContent = r.name;
    if (r.role) {
      const s = document.createElement("small");
      s.textContent = r.role;
      $(".n", el).appendChild(s);
    }
    $(".meta", el).innerHTML = `${size} · ${r.backend === "llama" ? "llama.cpp" : "Ollama"} · <span class="state">${state}</span>`;
    const btn = $("button", el) as HTMLButtonElement;
    btn.textContent = r.loaded ? "Unload" : "Load";
    btn.disabled = !!r.loading;
    btn.addEventListener("click", () => (r.loaded ? unload(r) : load(r)));
    box.appendChild(el);
  }
}

async function ollamaKeepAlive(id: string, keep: string | number) {
  const r = await http(`${OLLAMA}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // No prompt: Ollama just loads (or unloads) the model. 5m matches OLLAMA_KEEP_ALIVE in start-all.ps1.
    body: JSON.stringify({ model: id, keep_alive: keep, options: { num_ctx: 32768 } }),
  });
  if (!r.ok) throw new Error(`Ollama answered ${r.status}`);
  await r.text();
}

async function llamaCall(action: "load" | "unload", id: string) {
  const r = await http(`${LLAMA.replace(/\/v1$/, "")}/models/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: id }),
  });
  if (!r.ok) throw new Error(`llama.cpp answered ${r.status}: ${(await r.text()).slice(0, 120)}`);
}

async function unloadRow(r: Row) {
  if (r.backend === "ollama") await ollamaKeepAlive(r.id, 0);
  else await llamaCall("unload", r.id);
}

/** Frees the GPU for something else (ComfyUI, or another model). */
export async function unloadAll(except?: string) {
  await refreshModels();
  await Promise.all(rows.filter((r) => r.loaded && r.key !== except).map((r) => unloadRow(r).catch(() => {})));
}

async function unload(r: Row) {
  r.loading = true;
  renderRows();
  try {
    await unloadRow(r);
    deps.toast(`Unloaded ${r.name}.`);
  } catch (e) {
    deps.toast(`Couldn't unload ${r.name}: ${errMsg(e)}`, "warn");
  }
  r.loading = false;
  setTimeout(refreshModels, 800);
}

async function load(r: Row) {
  if (lastGpu) {
    // llama.cpp's router holds one model at a time, so loading one of its models swaps out the other.
    const swapped = r.backend === "llama" ? rows.filter((o) => o.backend === "llama" && o.loaded).reduce((s, o) => s + (o.vramGB ?? 0), 0) : 0;
    const freeGB = (lastGpu.mem_total - lastGpu.mem_used) / GB + swapped;
    if (r.needGB > freeGB) {
      const others = rows.filter((o) => o.loaded && o.key !== r.key);
      $("#fit-text").textContent =
        `${r.name} needs about ${r.needGB.toFixed(1)} GB of VRAM and only ${freeGB.toFixed(1)} GB of the 12 GB is free.` +
        (others.length ? ` Loaded now: ${others.map((o) => o.name).join(", ")}.` : "") +
        " Loading it anyway may spill into system RAM and run slowly, or fail.";
      const dlg = $("#fit") as HTMLDialogElement;
      dlg.returnValue = "";
      dlg.showModal();
      const choice = await new Promise<string>((res) => dlg.addEventListener("close", () => res(dlg.returnValue), { once: true }));
      if (choice === "cancel" || !choice) return;
      if (choice === "free") {
        await Promise.all(others.map((o) => unloadRow(o).catch(() => {})));
        await new Promise((res) => setTimeout(res, 1500));
      }
    }
  }
  r.loading = true;
  renderRows();
  try {
    if (r.backend === "ollama") await ollamaKeepAlive(r.id, "5m");
    else {
      await llamaCall("load", r.id);
      // The router returns at once; wait for the model to report "loaded".
      for (let i = 0; i < 90; i++) {
        await new Promise((res) => setTimeout(res, 2000));
        const m = (await getJson(`${LLAMA}/models`)).data?.find((x: any) => x.id === r.id);
        if (m?.status?.value === "loaded") break;
        if (m?.status?.value === "unloaded" && i > 2) throw new Error("it stopped loading (out of memory?)");
      }
    }
    deps.toast(`${r.name} is in VRAM.`);
  } catch (e) {
    deps.toast(`Couldn't load ${r.name}: ${errMsg(e)}`, "warn");
  }
  r.loading = false;
  refreshModels();
}

// ---------- VRAM stack, RAM, services ----------
function renderStack() {
  if (!visible || !lastGpu) return;
  const total = lastGpu.mem_total;
  const stack = $("#vram-stack");
  const legend = $("#vram-legend");
  stack.innerHTML = "";
  legend.innerHTML = "";
  const loaded = rows.filter((r) => r.loaded && r.vramGB);
  const modelMiB = loaded.reduce((s, r) => s + r.vramGB! * GB, 0);
  const other = Math.max(0, lastGpu.mem_used - modelMiB);
  const seg = (cls: string, mib: number, label: string) => {
    if (mib <= 0) return;
    const s = document.createElement("div");
    s.className = `seg ${cls}`;
    s.style.width = `${(mib / total) * 100}%`;
    s.title = `${label} · ${(mib / GB).toFixed(1)} GB`;
    stack.appendChild(s);
    const l = document.createElement("span");
    l.innerHTML = `<i class="seg ${cls}"></i>`;
    l.append(`${label} ${(mib / GB).toFixed(1)} GB`);
    legend.appendChild(l);
  };
  seg("sys", other, "Desktop & other apps");
  loaded.forEach((r, i) => seg(`s${i % 5}`, r.vramGB! * GB, r.name + (r.backend === "llama" ? " (est.)" : "")));
  const free = document.createElement("span");
  free.textContent = `Free ${((total - lastGpu.mem_used) / GB).toFixed(1)} of ${(total / GB).toFixed(0)} GB`;
  legend.appendChild(free);
}

async function refreshRam() {
  try {
    const m = await invoke<{ total: number; avail: number }>("sys_memory");
    const used = m.total - m.avail;
    $("#ram-val").textContent = `${(used / GB).toFixed(1)} / ${(m.total / GB).toFixed(0)} GB`;
    ($("#ram-bar > i") as HTMLElement).style.width = `${(used / m.total) * 100}%`;
  } catch {
    $("#ram-val").textContent = "n/a";
  }
}

const SERVICES: [string, string, string][] = [
  ["Ollama", ":11434", `${OLLAMA}/api/version`],
  ["llama.cpp router", ":8081", `${LLAMA}/models`],
  ["Open WebUI", ":8080", "http://127.0.0.1:8080/api/config"],
  ["ComfyUI", ":8188", "http://127.0.0.1:8188/system_stats"],
  ["Kokoro voice", ":8880", "http://127.0.0.1:8880/v1/models"],
];

async function refreshServices() {
  const ok = await Promise.all(SERVICES.map(([, , url]) => ping(url)));
  const box = $("#svc-list");
  box.innerHTML = "";
  SERVICES.forEach(([name, port], i) => {
    const dot = document.createElement("i");
    dot.className = ok[i] ? "ok" : "off";
    dot.title = ok[i] ? "running" : "not answering";
    const n = document.createElement("span");
    n.textContent = name;
    const p = document.createElement("span");
    p.className = "port";
    p.textContent = port;
    box.append(dot, n, p);
  });
}
