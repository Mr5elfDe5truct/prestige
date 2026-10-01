// Studio screen: the real renders in ComfyUI's output folder, and a create bar that queues the
// stack's own ComfyUI workflows (Z-Image-Turbo for images, LTX-2.3 for video with sound, Wan 2.2 to
// animate an image). The Webcam mode shows the camera pane from camera.ts.
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { errMsg, http } from "./backends";

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
}

type GenMode = "image" | "video" | "animate";

interface Mode {
  file: string;
  label: string;
  promptNode: string;
  seed: [string, string]; // node id, input name
  opts: string[];
  imageNode?: string; // LoadImage node for image-to-video
}

// The prompt and seed nodes in the stack's exported API workflows (workflows\*.api.json).
const MODES: Record<GenMode, Mode> = {
  image: {
    file: "z-image-turbo.api.json",
    label: "Z-Image-Turbo",
    promptNode: "4",
    seed: ["7", "seed"],
    opts: ["Z-Image-Turbo", "1024 × 1024", "8 steps", "about 30–45 s"],
  },
  video: {
    file: "ltx23-t2v-distilled.api.json",
    label: "LTX-2.3",
    promptNode: "5",
    seed: ["16", "noise_seed"],
    opts: ["LTX-2.3 distilled", "768 × 512", "4 s with sound", "about 6 min"],
  },
  animate: {
    file: "wan22-i2v-4step.api.json",
    label: "Wan 2.2",
    promptNode: "6",
    seed: ["11", "noise_seed"],
    imageNode: "9",
    opts: ["Wan 2.2 I2V 4-step", "832 × 480", "5 s, no sound", "about 10 min"],
  },
};

interface Deps {
  toast: (msg: string, kind?: string) => void;
  root: () => string | null;
  freeGpu: () => Promise<void>;
  cameraPane: (on: boolean) => void;
}

let deps: Deps;
let items: Asset[] = [];
let filter: "all" | "image" | "video" = "all";
let mode: GenMode | "webcam" = "image";
let animateSrc: Asset | null = null;
const workflows: Partial<Record<GenMode, any>> = {};
const clientId = `prestige-${Math.random().toString(36).slice(2, 10)}`;
let job: { id: string; mode: GenMode; started: number; prompt: string; nodes: Record<string, string> } | null = null;
let freshName = "";
let loaded = false;

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
      if (mode !== "video") animateSrc = null;
      renderCreate();
    }),
  );
  $("#animate-clear").addEventListener("click", () => {
    animateSrc = null;
    mode = "image";
    renderCreate();
  });
  $("#gen-form").addEventListener("submit", (e) => {
    e.preventDefault();
    generate();
  });
  $("#lb-close").addEventListener("click", closeLightbox);
  $("#lb").addEventListener("click", (e) => {
    if (e.target === $("#lb")) closeLightbox();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("#lb").hidden) closeLightbox();
  });
  listen<any>("comfy", (e) => onComfy(e.payload));
}

export async function showStudio(on: boolean) {
  if (!on) return;
  if (mode === "webcam") deps.cameraPane(true);
  if (!loaded) {
    loaded = true;
    await loadWorkflows();
  }
  await refresh();
}

async function loadWorkflows() {
  for (const m of ["image", "video", "animate"] as const) {
    try {
      workflows[m] = await invoke("read_workflow", { root: deps.root(), name: MODES[m].file });
    } catch {
      workflows[m] = null;
    }
  }
  renderCreate();
}

function renderCreate() {
  const webcam = mode === "webcam";
  const gm: GenMode = mode === "video" && animateSrc ? "animate" : mode === "webcam" ? "image" : mode;
  $$(".modes [data-mode]").forEach((x) => x.classList.toggle("on", x.dataset.mode === mode));
  $("#gen-form").hidden = webcam;
  $("#gen-opts").hidden = webcam;
  $("#cam-pane").hidden = !webcam;
  deps?.cameraPane(webcam);
  $("#animate-src").hidden = gm !== "animate";
  if (animateSrc) ($("#animate-img") as HTMLImageElement).src = convertFileSrc(animateSrc.path);
  if (webcam) return;
  const wf = workflows[gm];
  const m = MODES[gm];
  $("#create").classList.toggle("disabled", !wf);
  ($("#gen-btn") as HTMLButtonElement).disabled = !wf || !!job;
  ($("#gen-btn") as HTMLButtonElement).textContent = gm === "animate" ? "Animate" : "Generate";
  ($("#gen-prompt") as HTMLInputElement).placeholder =
    gm === "image"
      ? "Describe an image… e.g. a red and gold dragon coiled around a glowing GPU"
      : gm === "animate"
        ? "Describe the motion… e.g. slow push-in, snow falling, warm light flickering"
        : "Describe a 4-second scene, including any sound…";
  $("#gen-opts").innerHTML = wf
    ? m.opts.map((o) => `<span class="opt"><b>${o}</b></span>`).join("")
    : `<span class="opt">workflows\\${m.file} not found, so this mode is off</span>`;
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
    const vid = job.mode !== "image";
    p.innerHTML = `<div class="pic"><span class="badge ${vid ? "vid" : ""}">${vid ? "VIDEO" : "IMAGE"}</span></div><figcaption><span class="p"></span><span class="m">rendering…</span></figcaption>`;
    $(".p", p).textContent = job.prompt;
    g.appendChild(p);
  }
  for (const a of list) {
    const fig = document.createElement("button");
    fig.className = "thumb pending" + (a.name === freshName ? " fresh" : "");
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
    g.appendChild(fig);
    io.observe(fig);
  }
}

// ---------- lightbox ----------
function openLightbox(a: Asset) {
  const media = $("#lb-media");
  media.innerHTML = "";
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
  $("#lb-animate").onclick = () => {
    animateSrc = a;
    mode = "video";
    ($("#gen-prompt") as HTMLInputElement).value = "";
    closeLightbox();
    renderCreate();
    $("#gen-prompt").focus();
  };
  ($("#lb-reuse") as HTMLButtonElement).disabled = !a.prompt;
  $("#lb-reveal").onclick = () => invoke("reveal", { path: a.path }).catch((e) => deps.toast(errMsg(e), "warn"));
  $("#lb-copy").onclick = () => copy(a.prompt || "");
  $("#lb-reuse").onclick = () => {
    ($("#gen-prompt") as HTMLInputElement).value = a.prompt || "";
    animateSrc = null;
    mode = a.kind === "video" ? "video" : "image";
    renderCreate();
    closeLightbox();
    $("#gen-prompt").focus();
  };
  $("#lb").hidden = false;
}

function closeLightbox() {
  const v = $("#lb-media video") as HTMLVideoElement | null;
  v?.pause();
  $("#lb-media").innerHTML = "";
  $("#lb").hidden = true;
}

async function copy(text: string) {
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
  deps.toast("Prompt copied.");
}

// ---------- generation ----------
async function generate() {
  const prompt = ($("#gen-prompt") as HTMLInputElement).value.trim();
  if (mode === "webcam") return;
  const gm: GenMode = mode === "video" && animateSrc ? "animate" : mode;
  const wf = workflows[gm];
  if (!prompt || !wf || job) return;
  const m = MODES[gm];
  const src = gm === "animate" ? animateSrc : null;
  const graph = structuredClone(wf);
  graph[m.promptNode].inputs.text = prompt;
  graph[m.seed[0]].inputs[m.seed[1]] = Math.floor(Math.random() * 2 ** 32);
  const nodes: Record<string, string> = {};
  for (const [id, n] of Object.entries<any>(graph)) nodes[id] = n.class_type;

  const btn = $("#gen-btn") as HTMLButtonElement;
  btn.disabled = true;
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
    job = { id: body.prompt_id, mode: gm, started: Date.now(), prompt, nodes };
    setJob(2, "Queued. Loading models…");
    render();
  } catch (e) {
    const msg = errMsg(e);
    deps.toast(`Couldn't start the render: ${msg === "not reachable" ? "ComfyUI isn't running" : msg}`, "warn");
    $("#job").hidden = true;
    job = null;
    renderCreate();
  }
}

function setJob(pct: number, label: string) {
  ($("#job .progress") as HTMLElement).style.setProperty("--v", String(pct));
  $("#job-label").textContent = label;
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
      else $("#job-label").textContent = `${job.nodes[d.node] ?? d.node} · ${elapsed}`;
      break;
    case "execution_success":
      finish(true);
      break;
    case "execution_error":
      deps.toast(`The render failed: ${d.exception_message ?? "ComfyUI reported an error"}`, "warn");
      finish(false);
      break;
  }
}

async function finish(ok: boolean) {
  if (!job) return;
  const took = Math.round((Date.now() - job.started) / 1000);
  job = null;
  $("#job").hidden = true;
  renderCreate();
  const before = new Set(items.map((a) => a.path));
  await refresh();
  const added = items.find((a) => !before.has(a.path));
  if (ok && added) {
    freshName = added.name;
    render();
    deps.toast(`Done in ${took} s: ${added.name}`);
  }
}
