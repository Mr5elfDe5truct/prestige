// Workstation settings: every setting the Workstation's start-all.ps1 reads, in one sheet, so nothing needs a text
// editor. GPUs: data\gpu-settings.json (which card each service runs on; docs\GPUS.md there). Services:
// data\service-settings.json (Ollama, llama.cpp, which services start; docs\SETTINGS.md there). Models and Model file:
// bin\llama-models.ini, a key at a time or the whole file. Keys this sheet doesn't know are kept as they are.
// A service reads its settings when it starts, so a save offers to restart them (workstation.rs does the files).
import { invoke } from "@tauri-apps/api/core";
import { errMsg } from "./backends";
import { allGpus, gpuPlan, readGpus, shortName, SERVICE_NAMES, type Gpu, type Service } from "./gpus";

const $ = <T extends HTMLElement = HTMLElement>(s: string, r: ParentNode = document) => r.querySelector(s) as T;
const $$ = <T extends HTMLElement = HTMLElement>(s: string, r: ParentNode = document) => [...r.querySelectorAll(s)] as T[];
const inTauri = "__TAURI_INTERNALS__" in window;
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

type Json = Record<string, unknown>;
interface IniModel {
  id: string;
  note: string;
  keys: [string, string][];
}
interface WsState {
  root: string;
  found: boolean;
  servicesSupported: boolean;
  gpu: Json;
  gpuError: string | null;
  services: Json;
  servicesError: string | null;
  ini: string | null;
  models: IniModel[];
}

interface Deps {
  toast: (msg: string, kind?: string) => void;
  root: () => string | null;
  /** Stops every service, starts them again and waits for them (main.ts ticks them on the splash rows). */
  restartAll: () => Promise<void>;
}

/** data\service-settings.json's keys and the Workstation's defaults for them (scripts\service-settings.ps1 there). */
const SERVICE_DEFAULTS: Json = {
  ollamaKeepAlive: "5m",
  ollamaFlashAttention: "on",
  ollamaKvCache: "q8_0",
  llamaIdleSeconds: 180,
  llamaModelsMax: 1,
  comfyui: "on",
  openWebUI: "on",
  theme: "dragon",
};

/** The llama.cpp settings the Models tab offers for each model; the rest of a section shows as read-only text. */
const MODEL_KEYS: { key: string; label: string; hint: string; choices?: string[] }[] = [
  { key: "c", label: "Context", hint: "tokens it can keep in mind, e.g. 32768. More context takes more VRAM" },
  { key: "n-cpu-moe", label: "Experts in RAM", hint: "MoE models: expert layers kept in system RAM so the rest fits the card" },
  { key: "n-gpu-layers", label: "GPU layers", hint: "layers on the GPU (99: all of them)" },
  { key: "cache-type-k", label: "KV cache (K)", hint: "f16, q8_0 or q4_0: smaller fits more context", choices: ["", "f16", "q8_0", "q4_0"] },
  { key: "cache-type-v", label: "KV cache (V)", hint: "f16, q8_0 or q4_0", choices: ["", "f16", "q8_0", "q4_0"] },
  { key: "device", label: "Card", hint: "e.g. CUDA0. Empty: as the GPU plan says" },
];
const SHOWN = new Set(["model", ...MODEL_KEYS.map((k) => k.key)]);

let deps: Deps;
let state: WsState | null = null;
let tab = "gpus";
let fileDirty = false;
/** What the last save changed, for the Restart button: everything, or only llama.cpp's models. */
let pending: "all" | "llama" | null = null;

const dlg = () => $("#workstation") as HTMLDialogElement;

/** Open WebUI is switched off in the Workstation settings (start-all.ps1 then doesn't start it). */
let owuiOff = false;
export const openWebUIOn = () => !owuiOff;

export function initWorkstation(d: Deps) {
  deps = d;
  $("#open-workstation")?.addEventListener("click", () => openWorkstation());
  $("#sys-workstation")?.addEventListener("click", () => openWorkstation());
  $$("[data-ws-tab]").forEach((b) =>
    b.addEventListener("click", () => {
      if (!state) return;
      collect(); // keep edits made on this tab while looking at another
      tab = b.dataset.wsTab!;
      render();
    }),
  );
  $("#ws-save").addEventListener("click", () => save().catch((e) => deps.toast(`Couldn't save: ${errMsg(e)}`, "warn")));
  $("#ws-restart").addEventListener("click", () => restart());
  if (inTauri) load().catch(() => {});
}

async function load(): Promise<WsState> {
  state = await invoke<WsState>("ws_read", { root: deps.root() });
  owuiOff = state.services.openWebUI === "off" || state.services.openWebUI === false;
  return state;
}

export async function openWorkstation(at?: string) {
  if (!inTauri) return deps.toast("Workstation settings need the Prestige app.");
  try {
    await Promise.all([load(), readGpus().catch(() => [])]);
  } catch (e) {
    return deps.toast(`Couldn't read the Workstation settings: ${errMsg(e)}`, "warn");
  }
  if (at) tab = at;
  fileDirty = false;
  draft = null;
  $("#ws-apply").hidden = !pending;
  render();
  dlg().returnValue = "";
  if (!dlg().open) dlg().showModal();
}

// ---------- the draft: what's on screen, kept while switching tabs ----------

interface Draft {
  gpu: Json;
  services: Json;
  models: Map<string, Map<string, string>>; // model id → key → value as typed ("" removes it)
  file: string;
}
let draft: Draft | null = null;

function freshDraft(s: WsState): Draft {
  const models = new Map<string, Map<string, string>>();
  for (const m of s.models) models.set(m.id, new Map(m.keys));
  return { gpu: structuredClone(s.gpu), services: structuredClone(s.services), models, file: s.ini ?? "" };
}

/** Reads the visible tab's fields into the draft. */
function collect() {
  if (!draft) return;
  const body = $("#ws-body");
  for (const el of $$<HTMLSelectElement | HTMLInputElement>("[data-json]", body)) {
    const [file, ...path] = el.dataset.json!.split(".");
    let v: unknown;
    if (el instanceof HTMLInputElement && el.type === "checkbox") v = JSON.parse((el.checked ? el.dataset.on : el.dataset.off) ?? "null");
    else if (el instanceof HTMLSelectElement) v = JSON.parse(el.value);
    else v = el.value.trim() || null;
    setPath(file === "gpu" ? draft.gpu : draft.services, path, v);
  }
  const ex = $$<HTMLInputElement>("[data-exclude]", body);
  if (ex.length) {
    const keep = ((draft.gpu.exclude as unknown[]) ?? []).filter((v) => !allGpus().some((g) => matches(g, v)));
    const picked = ex.filter((c) => c.checked).map((c) => c.dataset.exclude!);
    setPath(draft.gpu, ["exclude"], keep.length || picked.length ? [...keep, ...picked] : null);
  }
  for (const el of $$<HTMLInputElement | HTMLSelectElement>("[data-model]", body)) {
    draft.models.get(el.dataset.model!)?.set(el.dataset.key!, el.value.trim());
  }
  const ta = $<HTMLTextAreaElement>("#ws-file", body);
  if (ta) {
    if (ta.value !== draft.file) fileDirty = true;
    draft.file = ta.value;
  }
}

/** Sets a key (dotted path) in a settings object; null removes it, and an emptied "services" goes too. */
function setPath(obj: Json, path: string[], v: unknown) {
  if (path.length === 1) {
    if (v === null || v === undefined) delete obj[path[0]];
    else obj[path[0]] = v;
    return;
  }
  const child = (obj[path[0]] && typeof obj[path[0]] === "object" ? obj[path[0]] : {}) as Json;
  setPath(child, path.slice(1), v);
  if (Object.keys(child).length) obj[path[0]] = child;
  else delete obj[path[0]];
}

// ---------- rendering ----------

function render() {
  const s = state!;
  if (!draft) draft = freshDraft(s);
  $$("[data-ws-tab]").forEach((b) => b.classList.toggle("on", b.dataset.wsTab === tab));
  $("#ws-where").innerHTML = s.found
    ? `In <b>${esc(s.root)}</b>. Services read these when they start.`
    : `<b>start-all.ps1 isn't in ${esc(s.root)}.</b> Set the Workstation folder in Settings first.`;
  const body = $("#ws-body");
  body.innerHTML = tab === "gpus" ? gpusHtml(draft.gpu, s.gpuError) : tab === "services" ? servicesHtml(draft.services, s) : tab === "models" ? modelsHtml(s) : fileHtml(draft.file);
  $("#ws-save").textContent = tab === "file" ? "Save file" : "Save";
}

/** A select whose options carry JSON values (null: leave the key out, so the Workstation decides). */
function select(json: string, current: unknown, options: [unknown, string][], label: string, hint = "") {
  const cur = JSON.stringify(current ?? null);
  const opts = [...options];
  if (!opts.some(([v]) => JSON.stringify(v ?? null) === cur)) opts.push([current, `${savedLabel(current)} (as saved)`]);
  return `<label>${esc(label)}<select data-json="${json}">${opts
    .map(([v, t]) => {
      const j = JSON.stringify(v ?? null);
      return `<option value="${esc(j)}"${j === cur ? " selected" : ""}>${esc(t)}</option>`;
    })
    .join("")}</select>${hint ? `<small class="muted">${hint}</small>` : ""}</label>`;
}

/** A checkbox and the value each state saves (null: leave the key out, so the Workstation's default applies). */
function check(json: string, on: boolean, label: string, values: { on: unknown; off: unknown }) {
  return `<label class="check"><input type="checkbox" data-json="${json}" data-on="${esc(JSON.stringify(values.on))}" data-off="${esc(JSON.stringify(values.off))}"${on ? " checked" : ""} /> ${label}</label>`;
}

/** A card named in gpu-settings.json: its nvidia-smi index, UUID or part of its name, as the Workstation reads it. */
function matches(g: Gpu, v: unknown): boolean {
  const s = String(v ?? "").trim();
  if (!s) return false;
  if (/^\d{1,2}$/.test(s)) return g.index === Number(s);
  return g.uuid === s || (g.name ?? "").toLowerCase().includes(s.toLowerCase());
}

function savedLabel(v: unknown): string {
  if (Array.isArray(v)) return v.map(savedLabel).join(" + ");
  const g = allGpus().find((g) => matches(g, v));
  return g ? shortName(g) : String(v);
}

const cardValue = (g: Gpu) => g.uuid ?? String(g.index);
const cardLabel = (g: Gpu) => `${shortName(g)} · ${Math.round(g.mem_total / 1024)} GB`;

function gpusHtml(g: Json, err: string | null): string {
  const cards = allGpus();
  const svc = (g.services ?? {}) as Json;
  const cardOpts: [unknown, string][] = cards.map((c) => [cardValue(c), cardLabel(c)]);
  const plan = gpuPlan();
  const now = plan && plan.mode !== "none"
    ? `Running now: <b>${esc(plan.mode)}</b>. ${(Object.keys(SERVICE_NAMES) as Service[])
        .map((k) => {
          const on = (plan.services[k] ?? []).map((i) => cards.find((c) => c.index === i)).filter(Boolean) as Gpu[];
          return on.length ? `${SERVICE_NAMES[k]} on the ${on.map(shortName).join(" + ")}` : "";
        })
        .filter(Boolean)
        .join(", ")}.`
    : "";
  const multi = cards.length > 1;
  return `
    ${err ? `<p class="warn">data\\gpu-settings.json couldn't be read (${esc(err)}), so the Workstation ignores it. Saving here writes a fresh one.</p>` : ""}
    <p class="muted">${now || "Which card each service runs on."} ${multi ? "" : "With one card everything runs on it; these matter once there's a second."}</p>
    <div class="ws-grid">
      ${select("gpu.mode", g.mode, [[null, "Auto (split with two cards)"], ["single", "One card: everything on the biggest"], ["split", "Split: small models on the second card"], ["pool", "Pool: llama.cpp spreads over every card"]], "Mode")}
      ${select("gpu.ollamaContext", g.ollamaContext, [[null, "Auto (by the card's VRAM)"], [8192, "8k"], [16384, "16k"], [32768, "32k"], [49152, "48k"], [65536, "64k"]], "Ollama context", "Prestige asks Ollama for the same")}
      ${select("gpu.bigGpu", g.bigGpu, [[null, "Auto (the biggest)"], ...cardOpts], "Big card")}
      ${select("gpu.smallGpu", g.smallGpu, [[null, "Auto (the second biggest)"], ...cardOpts], "Small card")}
    </div>
    <h3 class="ws-sub">Each service</h3>
    <div class="ws-grid">
      ${(Object.keys(SERVICE_NAMES) as Service[])
        .map((k) => select(`gpu.services.${k}`, svc[k], [[null, "As the mode says"], ["big", "Big card"], ["small", "Small card"], ["all", "Every card"], ...cardOpts], SERVICE_NAMES[k]))
        .join("")}
    </div>
    <h3 class="ws-sub">llama.cpp and ComfyUI</h3>
    <div class="ws-grid">
      ${select("gpu.llamaFit", g.llamaFit, [[null, "Auto (on unless one 12 GB card)"], ["on", "On: llama.cpp sizes itself to the cards"], ["off", "Off: use each model's own settings"]], "llama.cpp --fit")}
      <label>Tensor split<input data-json="gpu.tensorSplit" type="text" spellcheck="false" placeholder="auto, or e.g. 12,6" value="${esc(g.tensorSplit === "auto" ? "" : (g.tensorSplit ?? ""))}" /><small class="muted">pooled llama.cpp only; setting it turns --fit off</small></label>
      ${select("gpu.comfyAux", g.comfyAux, [[null, "Auto (the LTX upscaler)"], ["off", "Nothing: all on the main card"], ["upscaler,vae", "Upscaler and VAEs"], ["upscaler,vae,text_encoder", "Upscaler, VAEs and text encoders"]], "ComfyUI's second card holds", "only with ComfyUI on two cards")}
    </div>
    ${check("gpu.comfyQuick", g.comfyQuick === "on" || g.comfyQuick === true, "Quick ComfyUI on the small card for click to select (port 8189, ~2.4 GB of RAM)", { on: "on", off: null })}
    ${multi ? `<h3 class="ws-sub">Leave alone</h3>${cards
      .map((c) => `<label class="check"><input type="checkbox" data-exclude="${esc(cardValue(c))}"${((g.exclude as unknown[]) ?? []).some((v) => matches(c, v)) ? " checked" : ""} /> Don't use the ${esc(cardLabel(c))} (e.g. kept for games or the display)</label>`)
      .join("")}` : ""}`;
}

function servicesHtml(v: Json, s: WsState): string {
  const val = (k: string) => v[k] ?? SERVICE_DEFAULTS[k];
  const on = (k: string) => String(val(k)) !== "off" && val(k) !== false;
  // Defaults are left out of the file, so it holds only what was changed.
  const opt = (k: string, options: [unknown, string][], label: string, hint = "") =>
    select(`services.${k}`, String(v[k]) === String(SERVICE_DEFAULTS[k]) ? null : (v[k] ?? null), options.map(([o, t]) => [o === SERVICE_DEFAULTS[k] ? null : o, t] as [unknown, string]), label, hint);
  return `
    ${s.servicesSupported ? "" : `<p class="warn">This Workstation doesn't read these yet. Update it (git pull in the Workstation folder) first.</p>`}
    ${s.servicesError ? `<p class="warn">data\\service-settings.json couldn't be read (${esc(s.servicesError)}). Saving here writes a fresh one.</p>` : ""}
    <h3 class="ws-sub">Which services start</h3>
    ${check("services.comfyui", on("comfyui"), "ComfyUI: images, video, songs and 3D", { on: null, off: "off" })}
    ${check("services.openWebUI", on("openWebUI"), "Open WebUI, chat in a browser. Prestige keeps its own memory, so this can be off; off saves about 1 GB of RAM", { on: null, off: "off" })}
    <h3 class="ws-sub">Ollama</h3>
    <div class="ws-grid">
      ${opt("ollamaKeepAlive", [["0", "Unload at once"], ["1m", "1 minute"], ["5m", "5 minutes"], ["15m", "15 minutes"], ["30m", "30 minutes"], ["1h", "1 hour"], ["-1", "Until unloaded"]], "Keep an idle model loaded")}
      ${opt("ollamaKvCache", [["f16", "f16: full quality"], ["q8_0", "q8_0: half the memory"], ["q4_0", "q4_0: a quarter"]], "KV cache", "smaller caches fit more context")}
    </div>
    ${check("services.ollamaFlashAttention", on("ollamaFlashAttention"), "Flash attention (needed for a q8_0 or q4_0 cache)", { on: null, off: "off" })}
    <h3 class="ws-sub">llama.cpp</h3>
    <div class="ws-grid">
      ${opt("llamaIdleSeconds", [[0, "Never"], [60, "After 1 minute"], [180, "After 3 minutes"], [300, "After 5 minutes"], [600, "After 10 minutes"], [1800, "After 30 minutes"]], "Unload an idle model", "so ComfyUI gets the GPU back")}
      ${opt("llamaModelsMax", [[1, "One"], [2, "Two"], [3, "Three"]], "Models loaded at once")}
    </div>
    <h3 class="ws-sub">Open WebUI</h3>
    <div class="ws-grid">
      ${opt("theme", [["dragon", "Dragon Red & Gold"], ["neon", "Cyberpunk Neon"], ["glass", "Glass"], ["hud", "Terminal / HUD"], ["off", "Open WebUI's own"]], "Theme")}
    </div>`;
}

function modelsHtml(s: WsState): string {
  if (s.ini === null) return `<p class="warn">bin\\llama-models.ini isn't in the Workstation folder.</p>`;
  const rows = s.models
    .filter((m) => m.id !== "version")
    .map((m) => {
      const keys = draft!.models.get(m.id)!;
      const file = keys.get("model");
      const other = m.keys.filter(([k]) => !SHOWN.has(k));
      const title = m.id === "*" ? "Every model" : m.id;
      return `<div class="ws-model">
        <div class="ws-model-head"><b>${esc(title)}</b>${m.id === "*" ? `<small class="muted">shared by every llama.cpp model unless one sets its own</small>` : file ? `<small class="muted mono" title="${esc(file)}">${esc(file.split(/[\\/]/).pop())}</small>` : ""}</div>
        ${m.note ? `<p class="muted">${esc(m.note)}</p>` : ""}
        <div class="ws-grid three">
          ${MODEL_KEYS.map((k) => {
            const v = keys.get(k.key) ?? "";
            const field = k.choices
              ? `<select data-model="${esc(m.id)}" data-key="${k.key}">${[...new Set([...k.choices, v])].map((c) => `<option value="${esc(c)}"${c === v ? " selected" : ""}>${c ? esc(c) : "default"}</option>`).join("")}</select>`
              : `<input data-model="${esc(m.id)}" data-key="${k.key}" type="text" spellcheck="false" placeholder="default" value="${esc(v)}" />`;
            return `<label title="${esc(k.hint)}">${esc(k.label)}${field}</label>`;
          }).join("")}
        </div>
        ${other.length ? `<small class="muted mono">${other.map(([k, v]) => esc(`${k} = ${v}`)).join(" · ")}</small>` : ""}
      </div>`;
    })
    .join("");
  return `<p class="muted">llama.cpp's models (bin\\llama-models.ini). Empty means llama.cpp's default. Other settings are listed under each; the Model file tab edits everything.</p>${rows}`;
}

function fileHtml(text: string): string {
  return `<p class="muted">bin\\llama-models.ini as it is. The first change Prestige makes keeps the original as llama-models.ini.bak.</p>
    <textarea id="ws-file" class="mono" rows="22" spellcheck="false">${esc(text)}</textarea>`;
}

// ---------- saving ----------

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? {}) === JSON.stringify(b ?? {});

async function save() {
  const s = state!;
  collect();
  const d = draft!;
  const root = deps.root();
  let all = false;
  let llama = false;
  if (tab === "file") {
    if (!fileDirty) return deps.toast("Nothing changed in the file.");
    await invoke("ws_ini_write", { root, text: d.file });
    llama = true;
  } else {
    if (!same(d.gpu, s.gpu) || s.gpuError) {
      await invoke("ws_write_json", { root, name: "gpu", value: d.gpu });
      all = true;
    }
    if (!same(d.services, s.services) || s.servicesError) {
      await invoke("ws_write_json", { root, name: "services", value: d.services });
      all = true;
    }
    for (const m of s.models) {
      const now = d.models.get(m.id);
      if (!now) continue;
      const before = new Map(m.keys);
      const changes: [string, string | null][] = [];
      for (const { key } of MODEL_KEYS) {
        const a = before.get(key) ?? "";
        const b = now.get(key) ?? "";
        if (a !== b) changes.push([key, b || null]);
      }
      if (changes.length) {
        await invoke("ws_llama_set", { root, id: m.id, changes });
        llama = true;
      }
    }
    if (fileDirty) deps.toast("The Model file tab's edits weren't saved: save them on that tab.", "warn");
  }
  if (!all && !llama) return deps.toast("Nothing changed.");
  pending = all || pending === "all" ? "all" : "llama";
  await load();
  draft = null;
  fileDirty = false;
  render();
  $("#ws-apply-text").textContent =
    pending === "all"
      ? "Saved. The services use the new settings once they restart."
      : "Saved. llama.cpp uses the new model settings once it restarts (the other services keep running).";
  $("#ws-restart").textContent = pending === "all" ? "Restart services now" : "Restart llama.cpp now";
  $("#ws-apply").hidden = false;
}

async function restart() {
  const btn = $("#ws-restart") as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = "Restarting…";
  try {
    if (pending === "llama") {
      await invoke("restart_llama", { root: deps.root() });
      deps.toast("llama.cpp is restarting with the new settings.");
    } else {
      dlg().close();
      await deps.restartAll();
    }
    pending = null;
    $("#ws-apply").hidden = true;
  } catch (e) {
    deps.toast(`Couldn't restart: ${errMsg(e)}`, "warn");
  } finally {
    btn.disabled = false;
  }
}
