// Studio screen: the real renders in ComfyUI's output folder, and a create bar that queues the
// stack's own ComfyUI workflows (Qwen-Image-2.1 or its 4-step turbo for images, Z-Image-Turbo without
// them, Qwen-Image-2.1 to edit an image, LTX-2.5 for video with sound, Wan 2.2 to animate an image).
// The Webcam mode shows the camera pane from camera.ts. Chat uses renderMedia() to make images or a video the same way
// and show them inline. Size, quality, seed, count, length and fps come from gensettings.ts, shared with chat.
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { errMsg, http } from "./backends";
import {
  ASPECTS,
  LTX_FPS,
  LTX_RES,
  LTX_SECONDS,
  QUALITY_NAMES,
  SIZES,
  WAN_RES,
  WAN_SECONDS,
  aboutTime,
  imageDims,
  lastSeed,
  ltxFrames,
  onSettingsChange,
  parseRes,
  reset,
  settings,
  takeSeed,
  update,
  wanAuto,
  wanFrames,
  type Quality,
  type SettingsKey,
} from "./gensettings";

const $ = <T extends HTMLElement = HTMLElement>(s: string, r: ParentNode = document) => r.querySelector(s) as T;
const $$ = <T extends HTMLElement = HTMLElement>(s: string, r: ParentNode = document) => Array.from(r.querySelectorAll(s)) as T[];

const COMFY = "http://127.0.0.1:8188";

interface Asset {
  path: string;
  name: string;
  kind: "image" | "video";
  mtime: number;
  size: number;
  prompt?: string | null;
  model?: string | null;
  width?: number | null;
  height?: number | null;
  seed?: number | null;
}

type GenMode = "image" | "fast" | "edit" | "video" | "animate";

// How a workflow takes the generation settings: an image model with a latent size and batch, an edit
// (size follows the picture), LTX with a 2× upscale pass ("ltx") or without ("ltx1"), or Wan's two samplers.
type Family = "image" | "edit" | "ltx" | "ltx1" | "wan";

interface Mode {
  file: string;
  label: string;
  family: Family;
  promptNode: string;
  promptKey?: string; // the prompt input's name, "text" unless set
  seed: [string, string]; // node id, input name (for images also the sampler, which takes the steps)
  latent?: string; // the empty latent's node (width, height, batch_size)
  steps?: Partial<Record<Quality, number>>; // sampler steps per quality
  secs: number; // render time at the default settings on the reference RTX 3060 12 GB
  note?: string;
  imageNode?: string; // LoadImage node for image-to-video and edits
  fallback?: Mode; // used when this workflow file isn't there
}

// The nodes in the stack's exported API workflows (workflows\*.api.json) that the settings go into.
const QWEN_STEPS = { draft: 12, standard: 20, high: 30, max: 40 };
const ZIMAGE: Mode = {
  file: "z-image-turbo.api.json",
  label: "Z-Image-Turbo",
  family: "image",
  promptNode: "4",
  seed: ["7", "seed"],
  latent: "6",
  steps: { draft: 6, standard: 8, high: 12, max: 16 },
  secs: 40,
};
const MODES: Record<GenMode, Mode> = {
  image: {
    file: "qwen-image-21.api.json",
    label: "Qwen-Image-2.1",
    family: "image",
    promptNode: "4",
    promptKey: "prompt",
    seed: ["6", "seed"],
    latent: "5",
    steps: QWEN_STEPS,
    secs: 90,
    note: "best with text and signs",
    fallback: ZIMAGE,
  },
  fast: {
    file: "qwen-image-21-turbo.api.json",
    label: "Qwen-Image-2.1 Turbo",
    family: "image",
    promptNode: "4",
    promptKey: "prompt",
    seed: ["6", "seed"],
    latent: "5",
    steps: { draft: 3, standard: 4, high: 6, max: 8 },
    secs: 25,
    fallback: ZIMAGE,
  },
  edit: {
    file: "qwen-image-21-edit.api.json",
    label: "Qwen-Image-2.1 Edit",
    family: "edit",
    promptNode: "4",
    promptKey: "prompt",
    seed: ["6", "seed"],
    steps: QWEN_STEPS,
    secs: 90,
    note: "keeps the image's size",
    imageNode: "9",
  },
  video: {
    file: "ltx25-t2v-distilled.api.json",
    label: "LTX-2.5",
    family: "ltx",
    promptNode: "5",
    seed: ["16", "noise_seed"],
    secs: 360,
    fallback: {
      file: "ltx23-t2v-distilled.api.json",
      label: "LTX-2.3",
      family: "ltx1",
      promptNode: "5",
      seed: ["16", "noise_seed"],
      secs: 360,
    },
  },
  animate: {
    file: "wan22-i2v-4step.api.json",
    label: "Wan 2.2",
    family: "wan",
    promptNode: "6",
    seed: ["11", "noise_seed"],
    steps: { standard: 4, high: 6, max: 8 },
    secs: 600,
    imageNode: "9",
  },
};

// ---------- generation settings → workflow inputs ----------
interface Plan {
  w: number; // output size; 0 when it follows the source picture (edits)
  h: number;
  steps?: number;
  count: number;
  seconds?: number;
  frames?: number;
  fps?: number;
  draft?: boolean; // LTX without its upscale pass: half size, much quicker
  load: number; // VRAM use relative to the defaults, which fit a 12 GB card
  secs: number; // rough render time on the reference PC
  warn: string; // "" when it should fit
}

const settingsKey = (gm: GenMode): SettingsKey => (gm === "video" ? "video" : gm === "animate" ? "animate" : "image");

/** The quality levels a model offers, with their steps. */
const levels = (m: Mode) => (Object.keys(QUALITY_NAMES) as Quality[]).filter((q) => m.steps?.[q] != null);
const stepsOf = (m: Mode, q: Quality) => m.steps?.[q] ?? m.steps?.standard;

const LTX_BASE = 768 * 512 * 97;
const WAN_BASE = 832 * 480 * 81;
const MP = 1024 * 1024;

/** What a render with the current settings will be: sizes, steps, frames, and a VRAM and time estimate. */
function plan(gm: GenMode, src: Asset | null = srcAsset): Plan {
  const m = modeOf(gm);
  let p: Omit<Plan, "warn">;
  if (m.family === "image" || m.family === "edit") {
    const s = settings().image;
    const steps = stepsOf(m, s.quality)!;
    const ratio = steps / m.steps!.standard!;
    if (m.family === "edit") {
      const px = src?.width && src.height ? (src.width * src.height) / MP : 1;
      p = { w: 0, h: 0, steps, count: 1, load: px, secs: m.secs * px * ratio };
    } else {
      const [w, h] = imageDims(s.aspect, s.size);
      const px = (w * h) / MP;
      p = { w, h, steps, count: s.count, load: px * s.count, secs: m.secs * px * s.count * ratio };
    }
  } else if (m.family === "wan") {
    const s = settings().animate;
    const [w, h] = s.res === "auto" ? wanAuto(src?.width, src?.height) : parseRes(s.res);
    const frames = wanFrames(s.seconds);
    const steps = stepsOf(m, s.quality)!;
    const load = (w * h * frames) / WAN_BASE;
    p = { w, h, steps, count: 1, seconds: s.seconds, frames, fps: 16, load, secs: m.secs * load * (steps / 4) };
  } else {
    const s = settings().video;
    const [w, h] = parseRes(s.res);
    const frames = ltxFrames(s.seconds, s.fps);
    const draft = m.family === "ltx" && s.quality === "draft";
    const work = (w * h * frames) / LTX_BASE;
    p = { w: draft ? w / 2 : w, h: draft ? h / 2 : h, count: 1, seconds: s.seconds, frames, fps: s.fps, draft, load: draft ? work / 4 : work, secs: m.secs * work * (draft ? 0.3 : 1) };
  }
  // Videos hold every frame in VRAM at once, so they reach the limit sooner than images.
  const [soft, hard] = m.family === "image" || m.family === "edit" ? [2.2, 3.5] : [1.35, 2.2];
  const warn =
    p.load > hard
      ? "Likely more than 12 GB of VRAM: it may fail with out of memory. Try a smaller size, a shorter length or fewer images."
      : p.load > soft
        ? "Heavy for a 12 GB card: ComfyUI may spill into system RAM and render much slower."
        : "";
  return { ...p, warn };
}

/** Sets a node's inputs if the workflow has that node. */
function set(g: any, id: string, inputs: Record<string, unknown>) {
  if (g[id]) Object.assign(g[id].inputs, inputs);
}

/** Writes the plan and seed into a copy of the workflow. */
function apply(m: Mode, g: any, p: Plan, seed: number) {
  set(g, m.seed[0], { [m.seed[1]]: seed });
  switch (m.family) {
    case "image":
      set(g, m.latent!, { width: p.w, height: p.h, batch_size: p.count });
      set(g, m.seed[0], { steps: p.steps });
      break;
    case "edit":
      set(g, m.seed[0], { steps: p.steps });
      break;
    case "ltx":
    case "ltx1": {
      // LTX-2.5 makes the clip at half size, then upscales it 2× and refines (nodes 40–46).
      const half = m.family === "ltx" ? 2 : 1;
      const [w, h] = p.draft ? [p.w * 2, p.h * 2] : [p.w, p.h];
      set(g, "14", { width: w / half, height: h / half, length: p.frames });
      set(g, "13", { frames_number: p.frames, frame_rate: p.fps });
      set(g, "23", { frame_rate: p.fps });
      set(g, "36", { fps: p.fps });
      set(g, "43", { noise_seed: seed + 1 });
      if (p.draft) {
        // Decode the first pass directly and drop the upscale.
        set(g, "35", { samples: ["19", 1] });
        set(g, "37", { samples: ["19", 0] });
        for (const id of ["40", "41", "42", "43", "44", "45", "46"]) delete g[id];
      }
      break;
    }
    case "wan": {
      // Two samplers split the steps: high-noise model first, low-noise model second.
      const n = p.steps!;
      set(g, "10", { width: p.w, height: p.h, length: p.frames });
      set(g, "11", { steps: n, end_at_step: n / 2 });
      set(g, "12", { steps: n, start_at_step: n / 2, end_at_step: n, noise_seed: seed });
      break;
    }
  }
}
// The Image mode's model: Qwen-Image-2.1, or its 4-step turbo when "fast" is picked (remembered).
let imageMode: "image" | "fast" = (() => {
  try {
    return localStorage.getItem("studio.imageModel") === "fast" ? "fast" : "image";
  } catch {
    return "image";
  }
})();

interface Deps {
  toast: (msg: string, kind?: string) => void;
  root: () => string | null;
  freeGpu: () => Promise<void>;
  cameraPane: (on: boolean) => void;
  /** Switches to the Studio screen (from the lightbox when it was opened in chat). */
  show: () => void;
}

let deps: Deps;
let items: Asset[] = [];
let filter: "all" | "image" | "video" = "all";
let mode: "image" | "video" | "webcam" = "image";
// The image being animated (Video mode) or edited (Image mode), picked from the lightbox.
let srcAsset: Asset | null = null;
const workflows: Partial<Record<GenMode, any>> = {};
const active: Partial<Record<GenMode, Mode>> = {}; // the Mode (or fallback) each workflow was loaded from
const clientId = `prestige-${Math.random().toString(36).slice(2, 10)}`;
let job: { id: string; mode: GenMode; started: number; prompt: string; nodes: Record<string, string>; outputs: string[]; seed: number } | null = null;
let starting = false; // freeing the GPU / uploading, before ComfyUI has the job
let fresh = new Set<string>(); // names of the files the last render made
let workflowsLoaded: Promise<void> | null = null;
let settingsOpen = false;
// A render started from chat: it hears the progress and gets the finished files.
let waiter: { progress: (pct: number, label: string) => void; resolve: (a: Asset[]) => void; reject: (e: Error) => void } | null = null;

const age = (ms: number) => {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
};

export function initStudio(d: Deps) {
  deps = d;
  $$(".filters [data-f]").forEach((b) =>
    b.addEventListener("click", () => {
      filter = b.dataset.f as typeof filter;
      $$(".filters [data-f]").forEach((x) => x.classList.toggle("on", x === b));
      render();
    }),
  );
  $$(".modes [data-mode]").forEach((b) =>
    b.addEventListener("click", () => {
      mode = b.dataset.mode as typeof mode;
      srcAsset = null;
      renderCreate();
    }),
  );
  $("#animate-clear").addEventListener("click", () => {
    srcAsset = null;
    renderCreate();
  });
  $("#gen-opts").addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    if (t.closest(".opt.set")) {
      settingsOpen = !settingsOpen;
      return renderCreate();
    }
    if (!t.closest(".opt.model")) return;
    imageMode = imageMode === "fast" ? "image" : "fast";
    try {
      localStorage.setItem("studio.imageModel", imageMode);
    } catch {}
    renderCreate();
  });
  onSettingsChange(() => renderCreate());
  $("#gen-form").addEventListener("submit", (e) => {
    e.preventDefault();
    generate();
  });
  $("#lb-close").addEventListener("click", closeLightbox);
  $("#lb").addEventListener("click", (e) => {
    if (e.target === $("#lb")) closeLightbox();
  });
  document.addEventListener("keydown", (e) => {
    if ($("#lb").hidden || (e.target as HTMLElement)?.closest?.("input, textarea, dialog")) return;
    if (e.key === "Escape") closeLightbox();
    else if (e.key === "Delete" && lbAsset) deleteRender(lbAsset);
  });
  listen<any>("comfy", (e) => onComfy(e.payload));
}

export async function showStudio(on: boolean) {
  if (!on) return;
  if (mode === "webcam") deps.cameraPane(true);
  await ensureWorkflows();
  await refresh();
}

function ensureWorkflows() {
  return (workflowsLoaded ??= loadWorkflows());
}

async function loadWorkflows() {
  for (const gm of Object.keys(MODES) as GenMode[]) {
    workflows[gm] = null;
    for (let m: Mode | undefined = MODES[gm]; m; m = m.fallback) {
      try {
        workflows[gm] = await invoke("read_workflow", { root: deps.root(), name: m.file });
        active[gm] = m;
        break;
      } catch {}
    }
  }
  renderCreate();
}

/** The workflow the create bar runs now. */
function currentMode(): GenMode {
  if (mode === "video") return srcAsset ? "animate" : "video";
  if (srcAsset) return "edit";
  return workflows[imageMode] ? imageMode : "fast";
}

const modeOf = (gm: GenMode) => active[gm] ?? MODES[gm];

function renderCreate() {
  const webcam = mode === "webcam";
  const gm = currentMode();
  $$(".modes [data-mode]").forEach((x) => x.classList.toggle("on", x.dataset.mode === mode));
  $("#gen-form").hidden = webcam;
  $("#gen-opts").hidden = webcam;
  $("#cam-pane").hidden = !webcam;
  deps?.cameraPane(webcam);
  $("#animate-src").hidden = webcam || !srcAsset;
  if (srcAsset) {
    ($("#animate-img") as HTMLImageElement).src = convertFileSrc(srcAsset.path);
    $("#animate-what").textContent = `${gm === "edit" ? "Editing" : "Animating"} this image with ${modeOf(gm).label}`;
  }
  if (webcam) {
    $("#gen-warn").hidden = true;
    $("#gen-settings").hidden = true;
    return;
  }
  const wf = workflows[gm];
  const m = modeOf(gm);
  $("#create").classList.toggle("disabled", !wf);
  ($("#gen-btn") as HTMLButtonElement).disabled = !wf || !!job || starting;
  ($("#gen-btn") as HTMLButtonElement).textContent = gm === "animate" ? "Animate" : gm === "edit" ? "Edit" : "Generate";
  ($("#gen-prompt") as HTMLInputElement).placeholder =
    gm === "image" || gm === "fast"
      ? "Describe an image… e.g. a red and gold dragon coiled around a glowing GPU"
      : gm === "edit"
        ? "Say what to change… e.g. make it night, swap the car for a horse, remove the sign"
        : gm === "animate"
          ? "Describe the motion… e.g. slow push-in, snow falling, warm light flickering"
          : `Describe a ${settings().video.seconds}-second scene, including any sound…`;
  // In Image mode the model chip switches between Qwen-Image-2.1 and its faster turbo (or Z-Image-Turbo).
  const canPick = (gm === "image" || gm === "fast") && workflows.fast && workflows.image && active.image !== ZIMAGE;
  const chip = canPick
    ? `<button type="button" class="opt pick model" title="Switch image model"><b>${m.label}</b> ⇄</button>`
    : `<span class="opt"><b>${m.label}</b></span>`;
  const p = plan(gm);
  const gear = `<button type="button" class="opt pick set${settingsOpen ? " on" : ""}" title="Size, quality, seed${gm === "video" || gm === "animate" ? ", length" : ", count"}…" aria-expanded="${settingsOpen}">⚙ Settings</button>`;
  $("#gen-opts").innerHTML = wf
    ? chip + summary(gm, p).map((o) => `<span class="opt"><b>${o}</b></span>`).join("") + gear
    : `<span class="opt">workflows\\${m.file} not found, so this mode is off</span>`;
  const warn = $("#gen-warn");
  warn.hidden = !wf || !p.warn;
  warn.textContent = p.warn;
  const panel = $("#gen-settings");
  panel.hidden = !wf || !settingsOpen;
  if (!panel.hidden) settingsForm(panel, gm, false);
}

/** The settings as chips: size, steps, length, seed and a time estimate. */
function summary(gm: GenMode, p: Plan): string[] {
  const m = modeOf(gm);
  const s = settings()[settingsKey(gm)];
  const out: string[] = [];
  if (p.w) out.push(`${p.w} × ${p.h}`);
  if (p.seconds) out.push(`${p.seconds} s · ${p.fps} fps`);
  if (p.steps) out.push(`${p.steps} steps`);
  if (p.draft) out.push("draft, one pass");
  if (m.family === "ltx" || m.family === "ltx1") out.push("with sound");
  if (m.family === "wan") out.push("no sound");
  if (p.count > 1) out.push(`${p.count} images`);
  if (m.note) out.push(m.note);
  out.push(s.seed != null ? `seed ${s.seed}` : "random seed");
  out.push(aboutTime(p.secs));
  return out;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
const optionList = (pairs: [string | number, string][], cur: string | number) =>
  pairs.map(([v, l]) => `<option value="${v}"${String(v) === String(cur) ? " selected" : ""}>${esc(l)}</option>`).join("");

/** The settings form for a mode (Studio's panel and chat's popover). Changes are saved and shared. */
function settingsForm(el: HTMLElement, gm: GenMode, withWarn: boolean) {
  const m = modeOf(gm);
  const key = settingsKey(gm);
  const s = settings()[key];
  const p = plan(gm);
  const field = (label: string, k: string, opts: string, hint = "") =>
    `<label class="field">${label}<select data-k="${k}">${opts}</select>${hint ? `<small>${hint}</small>` : ""}</label>`;
  const f: string[] = [];
  if (m.family === "image") {
    const img = settings().image;
    f.push(field("Shape", "aspect", optionList(ASPECTS, img.aspect)));
    f.push(field("Size", "size", optionList(SIZES.map(([v, l]) => [v, `${l} · ${imageDims(img.aspect, v).join(" × ")}`]), img.size)));
  }
  if (m.family === "ltx" || m.family === "ltx1") {
    const v = settings().video;
    f.push(field("Resolution", "res", optionList(LTX_RES, v.res)));
    f.push(field("Length", "seconds", optionList(LTX_SECONDS.map((n) => [n, `${n} seconds`]), v.seconds)));
    f.push(field("Frame rate", "fps", optionList(LTX_FPS.map((n) => [n, `${n} fps`]), v.fps), `${ltxFrames(v.seconds, v.fps)} frames`));
  }
  if (m.family === "wan") {
    const v = settings().animate;
    const auto = wanAuto(srcAsset?.width, srcAsset?.height).join(" × ");
    f.push(field("Resolution", "res", optionList(WAN_RES.map(([r, l]) => [r, r === "auto" ? `${l} (${auto})` : l]), v.res)));
    f.push(field("Length", "seconds", optionList(WAN_SECONDS.map((n) => [n, `${n} seconds`]), v.seconds), `${wanFrames(v.seconds)} frames at 16 fps, Wan's own rate`));
  }
  if (m.family === "ltx")
    f.push(field("Quality", "quality", optionList([["draft", "Draft · half size, one pass"], ["standard", "Standard · upscaled 2×"]], s.quality === "draft" ? "draft" : "standard")));
  else if (m.steps) {
    const q = m.steps[s.quality] != null ? s.quality : "standard";
    f.push(field("Quality", "quality", optionList(levels(m).map((l) => [l, `${QUALITY_NAMES[l]} · ${m.steps![l]} steps`]), q)));
  }
  if (m.family === "image") f.push(field("How many", "count", optionList([1, 2, 3, 4].map((n) => [n, n === 1 ? "1 image" : `${n} images`]), settings().image.count)));
  const last = lastSeed(key);
  f.push(
    `<label class="field seed">Seed<span class="seed-row"><input type="number" min="0" step="1" data-k="seed" placeholder="random" value="${s.seed ?? ""}" />` +
      `<button type="button" class="btn mini" data-seed="random" title="A new random seed every time">Random</button>` +
      (last != null ? `<button type="button" class="btn mini" data-seed="last" title="Keep the seed of the last render">Last · ${last}</button>` : "") +
      `</span></label>`,
  );
  el.innerHTML =
    `<div class="set-grid">${f.join("")}</div>` +
    (withWarn && p.warn ? `<p class="vram-warn">${esc(p.warn)}</p>` : "") +
    `<div class="set-foot"><span class="credit">${m.label} · ${aboutTime(p.secs)} on an RTX 3060 12 GB · shared by Studio and chat</span><button type="button" class="linkish" data-reset>Reset to defaults</button></div>`;
  $$<HTMLSelectElement>("select", el).forEach((sel) =>
    sel.addEventListener("change", () => {
      const k = sel.dataset.k!;
      const num = ["seconds", "fps", "count"].includes(k);
      update(key, { [k]: num ? Number(sel.value) : sel.value } as any);
    }),
  );
  const seedIn = $<HTMLInputElement>("input[data-k=seed]", el);
  seedIn.addEventListener("change", () => {
    const n = Math.floor(Number(seedIn.value));
    update(key, { seed: seedIn.value.trim() === "" || !Number.isFinite(n) || n < 0 ? null : n });
  });
  $$("[data-seed]", el).forEach((b) => b.addEventListener("click", () => update(key, { seed: b.dataset.seed === "last" ? (lastSeed(key) ?? null) : null })));
  $("[data-reset]", el).addEventListener("click", () => reset(key));
}

async function refresh() {
  try {
    const res = await invoke<{ dir: string; exists: boolean; items: Asset[] }>("gallery_list", { root: deps.root() });
    items = res.items;
    $("#gallery-note").textContent = res.exists
      ? `${items.length} renders in ${res.dir}`
      : `ComfyUI's output folder (${res.dir}) doesn't exist yet. Renders will appear here.`;
  } catch (e) {
    $("#gallery-note").textContent = `Couldn't read the renders: ${errMsg(e)}`;
  }
  render();
}

// Thumbnails are made (or read from cache) only when a tile scrolls into view.
const io = new IntersectionObserver(
  (entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      io.unobserve(en.target);
      const fig = en.target as HTMLElement;
      const a = items.find((x) => x.path === fig.dataset.path);
      if (!a) continue;
      invoke<string>("thumbnail", { path: a.path, mtime: a.mtime })
        .then((t) => {
          const img = document.createElement("img");
          img.alt = "";
          img.src = convertFileSrc(t);
          $(".pic", fig).prepend(img);
          fig.classList.remove("pending");
        })
        .catch(() => fig.classList.remove("pending"));
    }
  },
  { rootMargin: "300px" },
);

function render() {
  const g = $("#gallery");
  g.innerHTML = "";
  const list = items.filter((a) => filter === "all" || a.kind === filter);
  if (!list.length && !job) g.innerHTML = `<p class="note">Nothing here yet.</p>`;
  if (job) {
    const p = document.createElement("div");
    p.className = "thumb pending";
    const vid = job.mode === "video" || job.mode === "animate";
    const n = vid ? 1 : plan(job.mode).count;
    p.innerHTML = `<div class="pic"><span class="badge ${vid ? "vid" : ""}">${vid ? "VIDEO" : n > 1 ? `${n} IMAGES` : "IMAGE"}</span></div><figcaption><span class="p"></span><span class="m">rendering…</span></figcaption>`;
    $(".p", p).textContent = job.prompt;
    g.appendChild(p);
  }
  for (const a of list) {
    const fig = document.createElement("button");
    fig.className = "thumb pending" + (fresh.has(a.name) ? " fresh" : "");
    fig.dataset.path = a.path;
    fig.innerHTML = `<div class="pic"><span class="badge ${a.kind === "video" ? "vid" : ""}">${a.kind.toUpperCase()}</span></div><figcaption><span class="p"></span><span class="m"></span></figcaption>`;
    $(".p", fig).textContent = a.prompt || a.name;
    $(".p", fig).title = a.prompt || a.name;
    $(".m", fig).textContent = [a.model, age(a.mtime)].filter(Boolean).join(" · ");
    if (a.kind === "video") {
      // Hovering plays the clip, muted.
      fig.addEventListener("mouseenter", () => {
        const v = document.createElement("video");
        v.src = convertFileSrc(a.path);
        v.muted = true;
        v.loop = true;
        v.playsInline = true;
        v.addEventListener("playing", () => v.classList.add("playing"));
        $(".pic", fig).appendChild(v);
        v.play().catch(() => {});
      });
      fig.addEventListener("mouseleave", () => {
        const v = $("video", fig) as HTMLVideoElement | null;
        if (v) {
          v.pause();
          v.removeAttribute("src");
          v.load();
          v.remove();
        }
      });
    }
    fig.addEventListener("click", () => openLightbox(a));
    fig.addEventListener("contextmenu", (e) => showMenu(e, a));
    g.appendChild(fig);
    io.observe(fig);
  }
}

// ---------- lightbox ----------
let lbAsset: Asset | null = null;

function openLightbox(a: Asset) {
  closeMenu();
  lbAsset = a;
  const media = $("#lb-media");
  media.innerHTML = "";
  media.oncontextmenu = (e) => showMenu(e, a);
  if (a.kind === "video") {
    const v = document.createElement("video");
    v.src = convertFileSrc(a.path);
    v.controls = true;
    v.autoplay = true;
    v.loop = true;
    media.appendChild(v);
  } else {
    const img = document.createElement("img");
    img.src = convertFileSrc(a.path);
    img.alt = a.prompt || a.name;
    media.appendChild(img);
  }
  $("#lb-p").textContent = a.prompt || "No prompt saved in this file.";
  const dl = $("#lb-dl");
  dl.innerHTML = "";
  const rows: [string, string][] = [
    ["File", a.name],
    ["Type", a.kind === "video" ? "Video" : "Image"],
    ["Model", a.model || "unknown"],
    ["Size", a.width ? `${a.width} × ${a.height}` : "–"],
    ["Seed", a.seed != null ? String(a.seed) : "–"],
    ["File size", `${(a.size / 1048576).toFixed(1)} MB`],
    ["Made", `${new Date(a.mtime).toLocaleString()} (${age(a.mtime)})`],
  ];
  for (const [k, v] of rows) {
    const dt = document.createElement("dt");
    dt.textContent = k;
    const dd = document.createElement("dd");
    dd.textContent = v;
    dl.append(dt, dd);
  }
  ($("#lb-copy") as HTMLButtonElement).disabled = !a.prompt;
  ($("#lb-animate") as HTMLButtonElement).hidden = a.kind !== "image" || !workflows.animate;
  ($("#lb-edit") as HTMLButtonElement).hidden = a.kind !== "image" || !workflows.edit;
  $("#lb-edit").onclick = () => startFrom(a, "image");
  $("#lb-animate").onclick = () => startFrom(a, "video");
  ($("#lb-reuse") as HTMLButtonElement).disabled = !a.prompt;
  $("#lb-reveal").onclick = () => revealFile(a);
  $("#lb-copy").onclick = () => copy(a.prompt || "");
  $("#lb-reuse").onclick = () => reusePrompt(a);
  $("#lb-save").onclick = () => saveAs(a);
  $("#lb-delete").onclick = () => deleteRender(a);
  $("#lb").hidden = false;
}

function closeLightbox() {
  const v = $("#lb-media video") as HTMLVideoElement | null;
  v?.pause();
  $("#lb-media").innerHTML = "";
  $("#lb").hidden = true;
  lbAsset = null;
}

// ---------- actions on a render (lightbox buttons and the right-click menu) ----------
/** Edit (Image mode) or animate (Video mode) this image: the create bar takes it as the source. */
function startFrom(a: Asset, m: "image" | "video") {
  deps.show();
  srcAsset = a;
  mode = m;
  ($("#gen-prompt") as HTMLInputElement).value = "";
  closeLightbox();
  renderCreate();
  $("#gen-prompt").focus();
}

function reusePrompt(a: Asset) {
  deps.show();
  ($("#gen-prompt") as HTMLInputElement).value = a.prompt || "";
  srcAsset = null;
  mode = a.kind === "video" ? "video" : "image";
  renderCreate();
  closeLightbox();
  $("#gen-prompt").focus();
}

/** Fixes the seed for the next render of this kind, to vary a render you liked. */
function reuseSeed(a: Asset) {
  const key: SettingsKey = a.kind === "image" ? "image" : /wan/i.test(a.model ?? a.name) ? "animate" : "video";
  update(key, { seed: a.seed ?? null });
  deps.toast(`The next ${key === "image" ? "image" : "video"} uses seed ${a.seed}. Pick Random in Settings to go back.`);
}

const revealFile = (a: Asset) => invoke("reveal", { path: a.path }).catch((e) => deps.toast(errMsg(e), "warn"));

/** Runs a Studio command on a render's file and toasts the outcome. */
async function fileAction(cmd: string, a: Asset, args: Record<string, unknown>, done?: string) {
  try {
    await invoke(cmd, { root: deps.root(), path: a.path, ...args });
    if (done) deps.toast(done);
  } catch (e) {
    deps.toast(errMsg(e), "warn");
  }
}

async function saveAs(a: Asset) {
  try {
    const dest = await invoke<string | null>("save_render_as", { root: deps.root(), path: a.path });
    if (dest) deps.toast(`Saved a copy as ${dest}`);
  } catch (e) {
    deps.toast(`Couldn't save it: ${errMsg(e)}`, "warn");
  }
}

/** Asks first, then moves the file to the Recycle Bin and takes it out of the gallery and chats. */
async function deleteRender(a: Asset) {
  closeMenu();
  const dlg = $("#del-confirm") as HTMLDialogElement;
  $("#del-name").textContent = a.name;
  $("#del-kind").textContent = a.kind;
  dlg.returnValue = "";
  dlg.showModal();
  await new Promise((r) => dlg.addEventListener("close", r, { once: true }));
  if (dlg.returnValue !== "delete") return;
  try {
    await invoke("delete_render", { root: deps.root(), path: a.path, mtime: a.mtime });
  } catch (e) {
    deps.toast(`Couldn't delete ${a.name}: ${errMsg(e)}`, "warn");
    return;
  }
  if (lbAsset?.path === a.path) closeLightbox();
  items = items.filter((x) => x.path !== a.path);
  render();
  // Chat messages that showed it say it's gone instead of a broken picture.
  $$<HTMLElement>("figure.chat-render").forEach((f) => f.dataset.path === a.path && f.classList.add("missing"));
  deps.toast(`Moved ${a.name} to the Recycle Bin.`);
}

// ---------- right-click menu ----------
type MenuItem = { label: string; run: () => void; key?: string; danger?: boolean } | "-";
let menuEl: HTMLElement | null = null;

function closeMenu() {
  menuEl?.remove();
  menuEl = null;
}

function showMenu(e: MouseEvent, a: Asset) {
  e.preventDefault();
  e.stopPropagation();
  closeMenu();
  const image = a.kind === "image";
  const list: MenuItem[] = [
    { label: image ? "Open" : "Play", run: () => fileAction("open_render", a, {}), key: "in default app" },
    { label: "Show info", run: () => openLightbox(a) },
    { label: "Open in folder", run: () => revealFile(a) },
    "-",
    ...(image && workflows.edit ? [{ label: "Edit with Qwen-Image…", run: () => startFrom(a, "image") }] : []),
    ...(image && workflows.animate ? [{ label: "Animate (image → video)…", run: () => startFrom(a, "video") }] : []),
    ...(a.prompt ? [{ label: "Reuse prompt", run: () => reusePrompt(a) }] : []),
    ...(a.seed != null ? [{ label: "Reuse seed", run: () => reuseSeed(a), key: String(a.seed) }] : []),
    "-",
    ...(image ? [{ label: "Copy image", run: () => fileAction("copy_render", a, { asImage: true }, "Image copied.") }] : []),
    { label: "Copy file", run: () => fileAction("copy_render", a, { asImage: false }, "File copied. Paste it into a folder or a chat app."), key: "to paste elsewhere" },
    ...(a.prompt ? [{ label: "Copy prompt", run: () => copy(a.prompt || "") }] : []),
    { label: "Copy file path", run: () => copy(a.path, "Path") },
    { label: "Save a copy as…", run: () => saveAs(a) },
    "-",
    { label: "Delete…", run: () => deleteRender(a), key: "Recycle Bin", danger: true },
  ];
  const m = document.createElement("div");
  m.className = "ctx-menu";
  m.setAttribute("role", "menu");
  let prev: MenuItem | null = "-";
  for (const it of list) {
    if (it === "-") {
      if (prev !== "-") m.appendChild(document.createElement("hr"));
    } else {
      const b = document.createElement("button");
      b.type = "button";
      b.setAttribute("role", "menuitem");
      if (it.danger) b.className = "danger";
      b.innerHTML = `<span></span>${it.key ? "<kbd></kbd>" : ""}`;
      $("span", b).textContent = it.label;
      if (it.key) $("kbd", b).textContent = it.key;
      b.addEventListener("click", () => {
        closeMenu();
        it.run();
      });
      m.appendChild(b);
    }
    prev = it;
  }
  if (m.lastElementChild?.tagName === "HR") m.lastElementChild.remove();
  document.body.appendChild(m);
  // Keep it on screen: open up or left when there's no room.
  const r = m.getBoundingClientRect();
  m.style.left = `${Math.max(4, Math.min(e.clientX, innerWidth - r.width - 4))}px`;
  m.style.top = `${Math.max(4, Math.min(e.clientY, innerHeight - r.height - 4))}px`;
  menuEl = m;
  ($("button", m) as HTMLButtonElement | null)?.focus();
}

document.addEventListener("mousedown", (e) => {
  if (menuEl && !menuEl.contains(e.target as Node)) closeMenu();
});
document.addEventListener("keydown", (e) => {
  if (!menuEl) return;
  if (e.key === "Escape") {
    e.stopPropagation();
    closeMenu();
  } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    const bs = $$<HTMLButtonElement>("button", menuEl);
    const i = bs.indexOf(document.activeElement as HTMLButtonElement);
    bs[(i + (e.key === "ArrowDown" ? 1 : bs.length - 1)) % bs.length]?.focus();
  }
}, true);
addEventListener("blur", closeMenu);
addEventListener("resize", closeMenu);
addEventListener("scroll", closeMenu, true);

async function copy(text: string, what = "Prompt") {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
  deps.toast(`${what} copied.`);
}

// ---------- generation ----------
async function generate() {
  const prompt = ($("#gen-prompt") as HTMLInputElement).value.trim();
  if (mode === "webcam") return;
  const gm = currentMode();
  if (!prompt || !workflows[gm] || job || starting) return;
  try {
    await queue(gm, prompt, gm === "animate" || gm === "edit" ? srcAsset : null);
  } catch (e) {
    deps.toast(`Couldn't start the render: ${errMsg(e)}`, "warn");
  }
}

/** Sends one of the workflows to ComfyUI. Throws if it couldn't be queued; progress then arrives by websocket. */
async function queue(gm: GenMode, prompt: string, src: Asset | null) {
  const wf = workflows[gm];
  if (!wf) throw new Error(`workflows\\${MODES[gm].file} wasn't found`);
  if (job || starting) throw new Error("Studio is already rendering something; wait for it to finish");
  const m = modeOf(gm);
  const graph = structuredClone(wf);
  graph[m.promptNode].inputs[m.promptKey ?? "text"] = prompt;
  const seed = takeSeed(settingsKey(gm));
  apply(m, graph, plan(gm, src), seed);
  const nodes: Record<string, string> = {};
  for (const [id, n] of Object.entries<any>(graph)) nodes[id] = n.class_type;

  starting = true;
  renderCreate();
  setJob(0, "Freeing the GPU (unloading chat models)…");
  $("#job").hidden = false;
  try {
    // ComfyUI needs the 12 GB card to itself.
    await deps.freeGpu();
    await invoke("comfy_listen", { clientId });
    if (src && m.imageNode) {
      setJob(1, "Uploading the image to ComfyUI…");
      graph[m.imageNode].inputs.image = await invoke<string>("comfy_upload", { path: src.path });
    }
    const r = await http(`${COMFY}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: graph, client_id: clientId }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok || !body.prompt_id) {
      const why = body.error?.message || body.node_errors ? JSON.stringify(body.node_errors ?? body.error).slice(0, 200) : `HTTP ${r.status}`;
      throw new Error(why);
    }
    job = { id: body.prompt_id, mode: gm, started: Date.now(), prompt, nodes, outputs: [], seed };
    setJob(2, "Queued. Loading models…");
    render();
  } catch (e) {
    $("#job").hidden = true;
    job = null;
    const msg = errMsg(e);
    throw new Error(msg === "not reachable" ? "ComfyUI isn't running" : msg);
  } finally {
    starting = false;
    renderCreate();
  }
}

let jobPct = 0;
function setJob(pct: number, label: string) {
  jobPct = pct;
  ($("#job .progress") as HTMLElement).style.setProperty("--v", String(pct));
  $("#job-label").textContent = label;
  waiter?.progress(pct, label);
}

function onComfy(msg: any) {
  if (!job) return;
  const d = msg.data ?? {};
  if (d.prompt_id && d.prompt_id !== job.id) return;
  const secs = Math.round((Date.now() - job.started) / 1000);
  const elapsed = secs >= 60 ? `${Math.floor(secs / 60)} min ${secs % 60} s` : `${secs} s`;
  switch (msg.type) {
    case "progress":
      setJob(Math.max(5, (d.value / d.max) * 100), `${job.nodes[d.node] ?? "Working"} · step ${d.value} of ${d.max} · ${elapsed}`);
      break;
    case "executing":
      if (d.node == null) finish(true);
      else setJob(jobPct, `${job.nodes[d.node] ?? d.node} · ${elapsed}`);
      break;
    case "executed":
      // The files a save node wrote, so the finished render can be found by name.
      for (const list of Object.values<any>(d.output ?? {}))
        if (Array.isArray(list)) for (const f of list) if (f?.filename && f.type !== "temp") job.outputs.push(f.filename);
      break;
    case "execution_success":
      finish(true);
      break;
    case "execution_interrupted":
      finish(false, "stopped");
      break;
    case "execution_error":
      if (!waiter) deps.toast(`The render failed: ${d.exception_message ?? "ComfyUI reported an error"}`, "warn");
      finish(false, d.exception_message ?? "ComfyUI reported an error");
      break;
  }
}

async function finish(ok: boolean, why = "") {
  if (!job) return;
  const done = job;
  const took = Math.round((Date.now() - done.started) / 1000);
  job = null;
  const w = waiter;
  waiter = null;
  $("#job").hidden = true;
  renderCreate();
  const before = new Set(items.map((a) => a.path));
  await refresh();
  const named = items.filter((a) => done.outputs.includes(a.name));
  const added = named.length ? named : items.filter((a) => !before.has(a.path));
  if (ok && added.length) {
    fresh = new Set(added.map((a) => a.name));
    render();
    if (w) w.resolve(added);
    else deps.toast(`Done in ${took} s (seed ${done.seed}): ${added[0].name}${added.length > 1 ? ` and ${added.length - 1} more` : ""}`);
  } else w?.reject(new Error(why || "ComfyUI finished, but no new file appeared in its output folder"));
}

// ---------- used from chat ----------
export type MediaKind = "image" | "video";
/** The workflow chat uses: the Studio's Image mode pick, or LTX text-to-video. */
const chatMode = (kind: MediaKind): GenMode => (kind === "video" ? "video" : workflows[imageMode] ? imageMode : "fast");

/** The model chat images (or videos) are made with. */
export async function modelLabel(kind: MediaKind) {
  await ensureWorkflows();
  return modeOf(chatMode(kind)).label;
}

/** Makes an image (or as many as the settings ask for) or a video and resolves with the saved files. */
export async function renderMedia(kind: MediaKind, prompt: string, progress: (pct: number, label: string) => void): Promise<Asset[]> {
  await ensureWorkflows();
  const gm = chatMode(kind);
  return new Promise<Asset[]>((resolve, reject) => {
    if (job || starting) return reject(new Error("Studio is already rendering something; wait for it to finish"));
    waiter = { progress, resolve, reject };
    queue(gm, prompt, null).catch((e) => {
      waiter = null;
      reject(e);
    });
  });
}

/** The generation settings form for chat's popover (the same settings as Studio's). */
export async function chatSettings(el: HTMLElement, kind: MediaKind) {
  await ensureWorkflows();
  const gm = chatMode(kind);
  if (!workflows[gm]) {
    el.innerHTML = `<p class="credit">workflows\${esc(modeOf(gm).file)} wasn't found, so chat can't make ${kind === "video" ? "videos" : "images"} yet.</p>`;
    return;
  }
  settingsForm(el, gm, true);
}

/** Stops the current render (ComfyUI's Cancel). */
export async function cancelRender() {
  await http(`${COMFY}/interrupt`, { method: "POST" }).catch(() => {});
}

let allowed: Promise<void> | null = null;
/** Lets the webview show files from ComfyUI's output folder (needed before showing a saved render in chat). */
export function allowRenders() {
  return (allowed ??= refresh());
}

/** Opens a render in the lightbox (Animate, Reuse prompt and Open in folder work from there). */
export async function openRender(path: string) {
  await allowRenders();
  let a = items.find((x) => x.path === path);
  if (!a) {
    await refresh();
    a = items.find((x) => x.path === path);
  }
  if (a) openLightbox(a);
  else deps.toast("That image isn't in ComfyUI's output folder any more.", "warn");
}

/** The right-click menu for a render shown in chat. */
export async function renderMenu(e: MouseEvent, path: string) {
  e.preventDefault();
  await allowRenders();
  let a = items.find((x) => x.path === path);
  if (!a) {
    await refresh();
    a = items.find((x) => x.path === path);
  }
  if (a) showMenu(e, a);
  else deps.toast("That file isn't in ComfyUI's output folder any more.", "warn");
}

export type { Asset };
