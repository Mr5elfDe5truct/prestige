// System screen: GPU meters with sparklines for every card, every chat model with load/unload, what's in each card's
// VRAM, system RAM and the services. Meters update every second; model state every 3 seconds while visible.
import { invoke } from "@tauri-apps/api/core";
import { errMsg, http, lastModels, ping, OLLAMA, LLAMA } from "./backends";
import { bestFor, capsFor, chipsHtml } from "./caps";
import {
  cardsFor, cardsText, freeGB, gpuPlan, heldOn, lastHolders, ollamaCtx, onPlanChange, othersText, readHolders, servicesOn, sharesCard, shortName, vramGB,
  SERVICE_NAMES, type Gpu, type Service,
} from "./gpus";

const $ = <T extends HTMLElement = HTMLElement>(s: string, r: ParentNode = document) => r.querySelector(s) as T;

interface Row {
  key: string;
  id: string;
  backend: "ollama" | "llama";
  name: string;
  role?: string;
  diskGB: number;
  needGB: number; // estimated VRAM when loaded
  loaded: boolean;
  vramGB?: number; // measured: Ollama's report, or llama.cpp's process from Windows' GPU counters (else estimated)
  measured?: boolean;
  loading?: boolean;
  sleeping?: boolean; // llama.cpp: idle past --sleep-idle-seconds, woken by the next request
  args?: string[]; // llama.cpp router command line (for capability detection)
  cards?: Map<number, number>; // GB on each card it's loaded on (nvidia-smi index)
}

const serviceOf = (r: Row): Service => (r.backend === "llama" ? "llama" : "ollama");

// What each model took the last time it was in VRAM (measured), so "will it fit" checks use that instead of a guess.
const SEEN_KEY = "prestige.vramSeen";
let seenGB: Record<string, number> = (() => {
  try {
    return JSON.parse(localStorage.getItem(SEEN_KEY) || "{}");
  } catch {
    return {};
  }
})();
const seen = (key: string): number | undefined => seenGB[key];
function remember(r: Row) {
  if (!r.vramGB || r.vramGB < 0.2 || Math.abs((seenGB[r.key] ?? 0) - r.vramGB) < 0.05) return;
  seenGB = { ...seenGB, [r.key]: Math.round(r.vramGB * 100) / 100 };
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(seenGB));
  } catch {}
}

interface Deps {
  toast: (msg: string, kind?: string) => void;
  nameFor: (id: string) => { name: string; role?: string; hide?: boolean; order: number };
  openCatalog: () => void;
}

const GB = 1024; // MiB per GiB
// Measured on a 12 GB card: Qwen3.6 35B with 25 expert layers in RAM (the 12 GB preset) uses about 10.8 GB of VRAM.
const KNOWN_VRAM: [RegExp, number][] = [[/qwen3\.6-35b/i, 10.8]];
// Ollama's q8 KV cache: roughly 1.2 GB on top of the weights at 32k, less with the smaller context of a small card.
const ollamaOverhead = () => (1.2 * ollamaCtx()) / 32768;

let deps: Deps;
let visible = false;
let rows: Row[] = [];
let lastGpus: Gpu[] = [];
const baselineMiB = new Map<number, number>(); // per card: desktop + driver use with no model loaded, refined as we see it
const baseline = (g: Gpu) => baselineMiB.get(g.index) ?? Math.min(900, g.mem_used);
const hist = new Map<number, { gpu: number[]; vram: number[] }>();
let builtFor = ""; // the cards (and plan) the GPU cards were built for
let modelTimer = 0;

export function initSystem(d: Deps) {
  deps = d;
  document.querySelector("#sys-catalog")?.addEventListener("click", () => deps.openCatalog());
  // start-all.ps1 moved services between cards: new headings and VRAM bars.
  onPlanChange(() => {
    builtFor = "";
    if (lastGpus.length) onGpus(lastGpus);
  });
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
    if (lastGpus.length) onGpus(lastGpus);
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

/** The load / VRAM / temperature / power cards, one row per GPU, headed by the services on it when there are several. */
function buildCards(list: Gpu[]) {
  const box = $("#gpu-cards");
  box.innerHTML = "";
  for (const g of list) {
    const sec = document.createElement("section");
    sec.className = "gpu-sec";
    sec.dataset.i = String(g.index);
    sec.innerHTML =
      (list.length > 1 ? `<div class="gpu-head"><h3></h3><span class="credit"></span></div>` : "") +
      `<div class="grid4">
        <div class="card c-gpu"><span class="eyebrow">GPU load</span><span class="big val">–</span><canvas class="spark"></canvas><span class="credit sub">–</span></div>
        <div class="card c-vram"><span class="eyebrow">VRAM</span><span class="big val">–</span><canvas class="spark"></canvas><span class="credit sub">–</span></div>
        <div class="card c-temp"><span class="eyebrow">Temperature</span><span class="big val">–</span><div class="bar wide"><i></i></div><span class="credit sub">–</span></div>
        <div class="card c-power"><span class="eyebrow">Board power</span><span class="big val">–</span><div class="bar wide"><i></i></div><span class="credit sub">–</span></div>
      </div>`;
    if (list.length > 1) {
      $("h3", sec).textContent = `${shortName(g)} · ${Math.round(g.mem_total / GB)} GB`;
      const on = servicesOn(g.index).filter((x) => x !== "openwebui");
      $(".credit", sec).textContent = on.length ? on.map((x) => SERVICE_NAMES[x]).join(", ") : "not used by the Workstation";
    }
    box.appendChild(sec);
  }
}

/** Called every second with fresh nvidia-smi numbers for every card, whether or not the screen is visible. */
export function onGpus(list: Gpu[]) {
  lastGpus = list;
  for (const g of list) {
    const h = hist.get(g.index) ?? { gpu: [], vram: [] };
    hist.set(g.index, h);
    h.gpu.push(g.util);
    h.vram.push(g.mem_used / GB);
    if (h.gpu.length > 60) h.gpu.shift();
    if (h.vram.length > 60) h.vram.shift();
    // The desktop's own share, measured only while no model is in (or on its way into) VRAM.
    // A model mid-load isn't marked loaded yet, so ignore readings far above an idle desktop.
    if (!rows.some((r) => r.loaded || r.loading) && g.mem_used < 3 * GB) baselineMiB.set(g.index, g.mem_used);
  }
  if (!visible) return;
  // Who holds what, for the bars below (cached 2 s, so this reads the counters every other second).
  void readHolders();

  const key = list.map((g) => `${g.index}:${g.mem_total}`).join() + JSON.stringify(gpuPlan()?.services ?? null);
  if (key !== builtFor) {
    builtFor = key;
    buildCards(list);
  }
  for (const g of list) {
    const sec = document.querySelector<HTMLElement>(`.gpu-sec[data-i="${g.index}"]`);
    if (!sec) continue;
    const h = hist.get(g.index)!;
    const c = (cls: string) => $(`.${cls}`, sec);
    const total = g.mem_total / GB;
    $(".val", c("c-gpu")).textContent = `${Math.round(g.util)}%`;
    $(".sub", c("c-gpu")).textContent = `last 60 s · peak ${Math.round(Math.max(...h.gpu))}%`;
    spark($("canvas", c("c-gpu")) as HTMLCanvasElement, h.gpu, 100);

    $(".val", c("c-vram")).textContent = `${(g.mem_used / GB).toFixed(1)} / ${total.toFixed(0)} GB`;
    $(".sub", c("c-vram")).textContent = `${((g.mem_total - g.mem_used) / GB).toFixed(1)} GB free`;
    spark($("canvas", c("c-vram")) as HTMLCanvasElement, h.vram, total, "--gold");
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
    for (const cls of ["c-temp", "c-power"]) {
      const bar = $(".bar > i", c(cls));
      bar.style.width = `${Math.max(0, Math.min(100, parseFloat(c(cls).style.getPropertyValue("--v") || "0")))}%`;
    }
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
        needGB: seen(`ollama:${m.name}`) ?? disk + ollamaOverhead(),
        loaded: running.has(m.name),
        vramGB: running.get(m.name),
        measured: running.has(m.name),
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
        // The 10.8 GB measurement is for the 12 GB preset; elsewhere llama.cpp's --fit fills the card(s) to ~1 GB short.
        needGB: seen(`llama:${m.id}`) ?? ((!gpuPlan()?.llamaFit && known) || Math.min(disk + 1.5, vramGB("llama") - 1)),
        loaded: m.status?.value === "loaded",
        loading: m.status?.value === "loading",
        sleeping: m.status?.value === "sleeping",
        args: m.status?.args ?? [],
      });
    });
  } else notes.push("llama.cpp isn't answering");

  // Ollama's models sit on its (first) card, at the size Ollama reports. llama.cpp's model is measured: Windows' GPU
  // counters give its model process's VRAM on each card (gpus.ts). Without the counters, on each of its cards what's in
  // use beyond the desktop and Ollama's share is put down to it, as before.
  const ollamaCard = cardsFor("ollama")[0]?.index;
  for (const r of next) if (r.backend === "ollama" && r.vramGB && ollamaCard != null) r.cards = new Map([[ollamaCard, r.vramGB]]);
  const llamaLoaded = next.filter((r) => r.backend === "llama" && r.loaded);
  const held = await readHolders();
  const llamaProcs = held.filter((h) => h.service === "llama" && h.model);
  if (llamaLoaded.length && llamaProcs.length) {
    const per = new Map<number, number>();
    for (const h of llamaProcs) per.set(h.gpu, (per.get(h.gpu) ?? 0) + h.mib / GB / llamaLoaded.length);
    for (const r of llamaLoaded) {
      r.cards = per;
      r.vramGB = [...per.values()].reduce((s, v) => s + v, 0);
      r.measured = true;
      remember(r);
    }
  } else if (llamaLoaded.length) {
    const ollamaGB = next.filter((r) => r.backend === "ollama" && r.loaded).reduce((s, r) => s + (r.vramGB ?? 0), 0);
    const per = new Map<number, number>();
    for (const g of cardsFor("llama")) {
      per.set(g.index, Math.max(0, (g.mem_used - baseline(g)) / GB - (g.index === ollamaCard ? ollamaGB : 0)) / llamaLoaded.length);
    }
    for (const r of llamaLoaded) {
      r.cards = per;
      r.vramGB = [...per.values()].reduce((s, v) => s + v, 0);
    }
  }
  for (const r of next) if (r.backend === "ollama" && r.loaded) remember(r);
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
    const state = r.loading ? "Loading…" : r.loaded ? "In VRAM" : r.sleeping ? "Asleep" : "On disk";
    const size =
      r.loaded && r.vramGB
        ? `${r.measured ? "" : "~"}${r.vramGB.toFixed(1)} GB in VRAM`
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
    body: JSON.stringify({ model: id, keep_alive: keep, options: { num_ctx: ollamaCtx() } }),
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

/** Frees the GPU for something else (ComfyUI, or another model). With `forService`, only the card(s) that service
 *  runs on: with several GPUs, a model on another card can stay. */
export async function unloadAll(except?: string, forService?: Service) {
  await refreshModels();
  const shares = (s: Service) => !forService || sharesCard(forService, s);
  // The voice server's Whisper and VoxCPM2 too (they reload on their next use).
  const voice = shares("voice")
    ? http("http://127.0.0.1:8890/v1/audio/unload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }).catch(() => {})
    : null;
  const doomed = rows.filter((r) => r.loaded && r.key !== except && shares(serviceOf(r)));
  await Promise.all([voice, ...doomed.map((r) => unloadRow(r).catch(() => {}))]);
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
  const svc = serviceOf(r);
  const free = freeGB(svc);
  if (free != null) {
    // llama.cpp's router holds one model at a time, so loading one of its models swaps out the other.
    const swapped = r.backend === "llama" ? rows.filter((o) => o.backend === "llama" && o.loaded).reduce((s, o) => s + (o.vramGB ?? 0), 0) : 0;
    const room = free + swapped;
    if (r.needGB > room) {
      // Only what shares this model's card(s) is in the way.
      const others = rows.filter((o) => o.loaded && o.key !== r.key && sharesCard(svc, serviceOf(o)));
      await readHolders(true);
      const apps = cardsFor(svc).map((g) => othersText(g.index)).filter(Boolean).join(", ");
      const comfy = cardsFor(svc).reduce((s, g) => s + lastHolders().filter((h) => h.gpu === g.index && h.service === "comfyui").reduce((t, h) => t + h.mib, 0), 0);
      $("#fit-text").textContent =
        `${r.name} needs ${seen(r.key) != null ? "" : "about "}${r.needGB.toFixed(1)} GB of VRAM` +
        `${seen(r.key) != null ? " (measured last time it loaded)" : ""} and only ${room.toFixed(1)} GB of ${cardsText(svc)} is free.` +
        (others.length ? ` Loaded now: ${others.map((o) => o.name).join(", ")}.` : "") +
        (comfy >= 300 ? ` ComfyUI holds ${(comfy / GB).toFixed(1)} GB.` : "") +
        (apps ? ` Other programs using it: ${apps}.` : "") +
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
      // A sleeping model is still the router's current one, so /models/load refuses it ("already running"); any
      // request wakes it instead.
      if (r.sleeping) {
        const w = await http(`${LLAMA}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: r.id, messages: [{ role: "user", content: "hi" }], max_tokens: 1 }),
        });
        if (!w.ok) throw new Error(`llama.cpp answered ${w.status}`);
        await w.text();
      } else await llamaCall("load", r.id);
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
/** One bar per card: each loaded model, the other Workstation services, the desktop and other apps by name (all
 *  measured per process, gpus.ts), and what's free. */
function renderStack() {
  if (!visible || !lastGpus.length) return;
  const box = $("#vram-cards");
  box.innerHTML = "";
  for (const g of lastGpus) {
    const total = g.mem_total;
    const wrap = document.createElement("div");
    wrap.className = "vram-card";
    if (lastGpus.length > 1) {
      const t = document.createElement("span");
      t.className = "eyebrow";
      t.textContent = shortName(g);
      wrap.appendChild(t);
    }
    const stack = document.createElement("div");
    stack.className = "vram-stack";
    const legend = document.createElement("div");
    legend.className = "legend";
    wrap.append(stack, legend);
    box.appendChild(wrap);

    const here = rows.filter((r) => r.loaded && (r.cards?.get(g.index) ?? 0) > 0);
    const modelMiB = here.reduce((s, r) => s + r.cards!.get(g.index)! * GB, 0);
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
    here.forEach((r) => seg(`s${rows.indexOf(r) % 5}`, r.cards!.get(g.index)! * GB, r.name + (r.measured ? "" : " (est.)")));
    const held = lastHolders().filter((h) => h.gpu === g.index);
    let shown = modelMiB;
    if (held.length) {
      // The other Workstation services (ComfyUI, the voice server…). Ollama's runner and llama.cpp's model process are
      // already in the models above.
      const svc = new Map<string, number>();
      for (const h of held) {
        if (!h.service || h.service === "ollama" || (h.service === "llama" && h.model && here.some((r) => r.backend === "llama"))) continue;
        svc.set(h.label, (svc.get(h.label) ?? 0) + h.mib);
      }
      // A service holding only its CUDA context (a few dozen MiB) isn't worth a segment.
      [...svc].filter(([, mib]) => mib >= 100).sort((a, b) => b[1] - a[1]).forEach(([label, mib], i) => {
        seg(`v${i % 3}`, mib, label);
        shown += mib;
      });
      // Then the desktop and other programs by name; small ones go into the rest.
      for (const [label, mib] of heldOn(g.index).byLabel.filter(([, m]) => m >= 150).slice(0, 4)) {
        seg("sys", mib, label);
        shown += mib;
      }
    }
    seg("sys2", g.mem_used - shown, held.length ? "Other apps & driver" : "Desktop & other apps");
    const free = document.createElement("span");
    free.textContent = `Free ${((total - g.mem_used) / GB).toFixed(1)} of ${(total / GB).toFixed(0)} GB`;
    legend.appendChild(free);
  }
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
  ["Voice server · Whisper, VoxCPM2", ":8890", "http://127.0.0.1:8890/health"],
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
