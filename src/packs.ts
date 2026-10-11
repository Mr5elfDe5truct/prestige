// The Packs sheet: the Workstation's model packs (packs.rs) with what's on this PC, whether each fits, Get with
// progress, Pause and Resume, and Remove; and the engines (llama.cpp, ComfyUI, Ollama) with Update and Roll back.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { errMsg } from "./backends";

interface PackRow {
  id: string;
  title: string;
  text: string;
  gb: number;
  state: "installed" | "partial" | "missing" | "unknown";
  have: number;
  items: number;
  unknown: number;
  bytes: number;
  missing: string[];
  fit: string[];
  running: boolean;
}
interface PackList {
  root: string;
  packs: PackRow[];
  freeBytes: number;
  ollamaUp: boolean;
}
interface PackEvent {
  id: string;
  state: "running" | "done" | "failed" | "paused";
  step: number;
  steps: number;
  label: string;
  done: number;
  total: number;
  error: string | null;
}
interface Engines {
  llama: { version: string | null; previous: string | null; latest: string | null; error: string | null; cuda: string };
  comfyui: { installed: boolean; own?: boolean; version?: string | null; commit?: string | null; canRollBack?: boolean };
  ollama: { version: string | null; installed: boolean };
}

interface Deps {
  root: () => string | null;
  toast: (msg: string, kind?: string) => void;
  confirm: (title: string, body: string, ok: string) => Promise<boolean>;
  /** Services need a restart to pick up a new environment (voice, transcribe, Open WebUI). */
  restartServices: () => Promise<void>;
}
let deps: Deps;
const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector(s) as T;
const GB = 1e9;
const gb = (b: number) => (b >= 10 * GB ? `${Math.round(b / GB)} GB` : `${(b / GB).toFixed(1)} GB`);
const live = new Map<string, PackEvent>();
let list: PackList | null = null;
let engines: Engines | null = null;
const ENV_PACKS = new Set(["voice", "transcribe", "openwebui"]);

function esc(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

function progressText(e: PackEvent) {
  const of = e.steps > 1 ? `${e.step} of ${e.steps} · ` : "";
  const bytes = e.total ? ` · ${gb(e.done)} of ${gb(e.total)}` : e.done ? ` · ${gb(e.done)}` : "";
  return `${of}${esc(e.label)}${bytes}`;
}

function render() {
  const box = $("#packs-list");
  if (!list) {
    box.innerHTML = `<p class="muted">Reading the Workstation…</p>`;
    return;
  }
  $("#packs-where").textContent = `${list.root} · ${gb(list.freeBytes)} free${list.ollamaUp ? "" : " · Ollama isn't running, so its models show as unknown"}`;
  box.innerHTML = "";
  for (const p of list.packs) {
    const e = live.get(p.id);
    const running = p.running || e?.state === "running";
    const row = document.createElement("div");
    row.className = `pack ${p.state}${running ? " running" : ""}`;
    const status =
      p.state === "installed" ? "Installed" :
      p.state === "partial" ? `Partly here (${p.have} of ${p.items})` :
      p.state === "unknown" ? "Unknown until Ollama runs" : "Not installed";
    const pct = e && e.total ? Math.round((e.done / e.total) * 100) : null;
    row.innerHTML = `
      <div class="pack-head"><b>${esc(p.title)}</b><span class="pack-size">${p.gb} GB</span><span class="pack-state">${running ? "Downloading" : status}</span></div>
      <p class="muted">${esc(p.text)}</p>
      ${p.fit.map((f) => `<p class="pack-warn">! This ${esc(f)}</p>`).join("")}
      ${running && e ? `<div class="pack-bar"><i style="width:${pct ?? 0}%"></i></div><p class="pack-prog">${progressText(e)}</p>` : ""}
      ${e?.state === "failed" ? `<p class="pack-warn">Stopped: ${esc(e.error ?? "")}</p>` : ""}
      ${p.state === "partial" && !running ? `<p class="muted pack-missing">Missing: ${esc(p.missing.join(", "))}</p>` : ""}
      <div class="pack-acts"></div>`;
    const acts = row.querySelector(".pack-acts")!;
    const btn = (text: string, f: () => void, primary = false) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = primary ? "btn primary" : "btn";
      b.textContent = text;
      b.addEventListener("click", f);
      acts.append(b);
    };
    if (running) btn("Pause", () => invoke("pack_pause", { id: p.id }));
    else {
      if (p.state !== "installed") btn(p.state === "partial" || e?.state === "paused" ? "Resume" : "Get", () => get(p), true);
      if (p.have > 0) btn("Remove", () => remove(p));
    }
    box.append(row);
  }
}

async function refresh() {
  try {
    list = await invoke<PackList>("packs_list", { root: deps.root() });
  } catch (e) {
    $("#packs-list").innerHTML = `<p class="pack-warn">${esc(errMsg(e))}</p>`;
    return;
  }
  render();
}

async function get(p: PackRow) {
  const need = Math.max(0, p.gb * GB - p.bytes);
  if (list && need > list.freeBytes) {
    const ok = await deps.confirm(`Not enough space for ${p.title}`, `It needs about ${gb(need)} more and ${gb(list.freeBytes)} is free. Get it anyway?`, "Get anyway");
    if (!ok) return;
  }
  live.set(p.id, { id: p.id, state: "running", step: 0, steps: 0, label: "starting", done: 0, total: 0, error: null });
  render();
  try {
    await invoke("pack_get", { root: deps.root(), id: p.id });
  } catch (e) {
    live.delete(p.id);
    deps.toast(`Couldn't start ${p.title}: ${errMsg(e)}`, "warn");
    render();
  }
}

async function remove(p: PackRow) {
  const r = await invoke<{ files: string[]; models: string[]; envs: string[]; bytes: number }>("pack_removal", { root: deps.root(), id: p.id });
  const what = [
    r.files.length ? `${r.files.length} ${r.files.length === 1 ? "file" : "files"} (${gb(r.bytes)})` : "",
    r.models.length ? `Ollama ${r.models.length === 1 ? "model" : "models"} ${r.models.join(", ")}` : "",
    r.envs.length ? `the ${r.envs.join(", ")} Python ${r.envs.length === 1 ? "environment" : "environments"}` : "",
  ].filter(Boolean);
  if (!what.length) return deps.toast(`Everything in ${p.title} is shared with another pack you have, so nothing would be removed.`);
  const files = r.files.slice(0, 8).map((f) => `• ${f}`).join("\n") + (r.files.length > 8 ? `\n• and ${r.files.length - 8} more` : "");
  const ok = await deps.confirm(`Remove ${p.title}?`, `This deletes ${what.join(", ")}. Files other packs use are kept.\n\n${files}`, "Remove");
  if (!ok) return;
  try {
    await invoke("pack_remove", { root: deps.root(), id: p.id });
    deps.toast(`${p.title} removed.`);
  } catch (e) {
    deps.toast(`Couldn't remove all of ${p.title}: ${errMsg(e)}`, "warn");
  }
  refresh();
}

async function onEvent(e: PackEvent) {
  if (e.id.startsWith("engine-")) return onEngineEvent(e);
  if (e.state === "running") {
    live.set(e.id, e);
    if ($<HTMLDialogElement>("#packs").open) render();
    return;
  }
  const title = list?.packs.find((p) => p.id === e.id)?.title ?? e.id;
  if (e.state === "done") {
    live.delete(e.id);
    deps.toast(`${title} is ready.`);
    if (ENV_PACKS.has(e.id) && (await deps.confirm(`${title} is ready`, "Restart the services so it starts?", "Restart services"))) await deps.restartServices();
  } else if (e.state === "paused") {
    live.set(e.id, e);
  } else {
    live.set(e.id, e);
    deps.toast(`${title} stopped: ${e.error}`, "warn");
  }
  await refresh();
}

// ---------- engines ----------
const engineLive = new Map<string, PackEvent>();

function renderEngines() {
  const box = $("#engines-list");
  if (!engines) {
    box.innerHTML = `<p class="muted">Reading versions…</p>`;
    return;
  }
  const l = engines.llama, c = engines.comfyui, o = engines.ollama;
  const busy = (k: string) => engineLive.get(k)?.state === "running";
  const prog = (k: string) => {
    const e = engineLive.get(k);
    if (!e) return "";
    if (e.state === "running") return `<p class="pack-prog">${e.total ? progressText(e) : "Working…"}</p>`;
    if (e.state === "failed") return `<p class="pack-warn">${esc(e.error ?? "")}</p>`;
    return "";
  };
  const newer = l.latest && l.version && l.latest !== l.version && Number(l.latest.slice(1)) > Number(l.version.slice(1));
  box.innerHTML = `
    <div class="engine" data-engine="llama"><b>llama.cpp</b><span>${l.version ?? "not installed"}${l.latest ? (newer ? ` · ${l.latest} is out` : " · up to date") : ""} · CUDA ${l.cuda} build</span>
      <span class="engine-acts">
        <button class="btn" type="button" data-act="check" ${busy("llama") ? "disabled" : ""}>Check</button>
        ${newer ? `<button class="btn primary" type="button" data-act="update" ${busy("llama") ? "disabled" : ""}>Update to ${l.latest}</button>` : ""}
        ${l.previous ? `<button class="btn" type="button" data-act="rollback" ${busy("llama") ? "disabled" : ""}>Back to ${l.previous}</button>` : ""}
      </span>${prog("llama")}${l.error ? `<p class="pack-warn">${esc(l.error)}</p>` : ""}</div>
    <div class="engine" data-engine="comfyui"><b>ComfyUI</b><span>${!c.installed ? "not installed" : c.own ? `${c.version ?? ""} (${c.commit ?? "?"})` : `${c.version ?? ""} in Comfy Desktop, which updates itself`}</span>
      <span class="engine-acts">
        ${c.installed && c.own ? `<button class="btn" type="button" data-act="update" ${busy("comfyui") ? "disabled" : ""}>Update</button>` : ""}
        ${c.canRollBack ? `<button class="btn" type="button" data-act="rollback" ${busy("comfyui") ? "disabled" : ""}>Roll back</button>` : ""}
      </span>${prog("comfyui")}</div>
    <div class="engine" data-engine="ollama"><b>Ollama</b><span>${o.installed ? o.version ?? "" : "not installed"}</span>
      <span class="engine-acts">${o.installed ? `<button class="btn" type="button" data-act="update" ${busy("ollama") ? "disabled" : ""}>Update</button>` : ""}</span>${prog("ollama")}</div>`;
  box.querySelectorAll<HTMLButtonElement>("button[data-act]").forEach((b) =>
    b.addEventListener("click", () => {
      const engine = b.closest<HTMLElement>(".engine")!.dataset.engine!;
      const act = b.dataset.act!;
      if (act === "check") return refreshEngines(true);
      engineLive.set(engine, { id: `engine-${engine}`, state: "running", step: 0, steps: 0, label: "", done: 0, total: 0, error: null });
      renderEngines();
      invoke("engine_action", { root: deps.root(), engine, action: act }).catch((e) => {
        engineLive.delete(engine);
        deps.toast(errMsg(e), "warn");
        renderEngines();
      });
    }),
  );
}

async function refreshEngines(check = false) {
  if (check && engines) engines.llama.error = null;
  try {
    engines = await invoke<Engines>("engines", { root: deps.root(), check });
  } catch (e) {
    $("#engines-list").innerHTML = `<p class="pack-warn">${esc(errMsg(e))}</p>`;
    return;
  }
  renderEngines();
}

function onEngineEvent(e: PackEvent) {
  const k = e.id.slice("engine-".length);
  engineLive.set(k, e);
  const names: Record<string, string> = { llama: "llama.cpp", comfyui: "ComfyUI", ollama: "Ollama" };
  if (e.state === "done") {
    engineLive.delete(k);
    deps.toast(`${names[k] ?? k}: ${e.label === "rolled back" ? "rolled back" : "updated"}.`);
    refreshEngines(k === "llama");
  } else if (e.state === "failed") {
    deps.toast(`${names[k] ?? k}: ${e.error}`, "warn");
    renderEngines();
  } else renderEngines();
}

export function openPacks() {
  const dlg = $<HTMLDialogElement>("#packs");
  render();
  renderEngines();
  if (!dlg.open) dlg.showModal();
  refresh();
  refreshEngines();
}

export function initPacks(d: Deps) {
  deps = d;
  listen<PackEvent>("pack", (e) => onEvent(e.payload));
  $("#open-packs")?.addEventListener("click", () => openPacks());
  $("#sys-packs")?.addEventListener("click", () => openPacks());
  $("#packs-refresh").addEventListener("click", () => refresh());
}
