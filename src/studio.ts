// Studio screen: the real renders in ComfyUI's output folder, and a create bar that queues the
// stack's own ComfyUI workflows (Qwen-Image-2.1 or its 4-step turbo for images, Z-Image-Turbo without
// them, Qwen-Image-2.1 to edit an image, LTX-2.5 for video with sound, Wan 2.2 to animate an image, or Wan 2.2 SVI
// to make a longer video from it in up to four chained shots), and ACE-Step 1.5 for songs (a style, lyrics, a length).
// A reference image (a character or an item, from reference.ts) puts that subject into a new scene with Qwen-Image-2.1;
// in Video mode that picture (or the reference itself) becomes LTX-2.5's first frame.
// The Webcam mode shows the camera pane from camera.ts. Chat uses renderMedia() to make images or a video the same way
// and show them inline. Size, quality, seed, count, length and fps come from gensettings.ts, shared with chat.
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { errMsg, http } from "./backends";
import { comfyCards } from "./gpus";
import { SONG_LANGUAGES, SONG_METERS, aboutTime, onSettingsChange, parseRes, settings, takeSeed, type MusicSettings, type VideoSettings } from "./gensettings";
import { mossRefPrompt, refKeep, refPrefs, refPrompt, uploadReference, type RefKind, type Reference } from "./reference";
import { initInpaint } from "./inpaint";
import { initLaser } from "./laser";
import { loadJobs, saveJobs } from "./queuestore";
import { editLayoutPrompt, layoutBoxes, layoutMask, layoutPrompt, layoutRefBox, boxWhat, onLayoutChange, openLayout, useLayout } from "./layout";
import { checkOcr } from "./ocr";
import { checkIdol } from "./idol";
import { checkTranslate } from "./translate";
import { initTrain, openTrain, trainedLoras, type TrainedLora } from "./train";
import { applyWanModels, diffusionModels } from "./uncensored";
import type { WorldState } from "./world";
import { type SongEdit } from "./songedit";
import { initSwapPanel, renderSwap, toggleSwap, setSwapVideo, sw, swapChip, swapOpen, swapShown } from "./swap";
import { openRender } from "./renderapi";
import { deleteRender } from "./fileactions";
import { editSong, songEditGraph, uploadMask } from "./renderactions";
import { clearSelection, closeLightbox, initLightboxZoom, initSelectionBar, lbAsset, loadStarred, pick, stepLightbox, toggleStar } from "./gallery";
import { refresh, render } from "./cards";
import { settingsForm } from "./settingsform";
import { initRefSlot, renderRefSlot } from "./refslot";
import { ACE_MODELS, ACE_PACK, apply, type Asset, CUT_STEPS, type Family, FOLEY_WINDOW, type GenMode, isVideo, KROMOSS, LIGHTNING, lightningOn, MANGA_MP, MANGA_PROMPT, type Mode, MODEL3D_STEPS, MODES, MP, type Override, plan, type Plan, QWEN_GGUF, QWEN_INT8, RESHOOT_LORAS, RESTORE, type RestoreKind, restorePrompt, settingsKey, shotPrompts, SONG_STEPS, songLength, type Source, stepsOf, SVI, SWAP, takenGB, TALK, TALK_STEPS, talkLabels, talkPlan, TURBO_SIGMAS, TURBO_UNET, UPSCALE_STEPS, type UpscaleSize, WORLD, ZIMAGE } from "./modes";

export const $ = <T extends HTMLElement = HTMLElement>(s: string, r: ParentNode = document) => r.querySelector(s) as T;
export const $$ = <T extends HTMLElement = HTMLElement>(s: string, r: ParentNode = document) => Array.from(r.querySelectorAll(s)) as T[];

export const COMFY = "http://127.0.0.1:8188";
// The Image mode's model: Qwen-Image-2.1, or its 4-step turbo when "fast" is picked (remembered).
let imageMode: ImageMode = (() => {
  try {
    const v = localStorage.getItem("studio.imageModel");
    return v === "fast" || v === "moss" ? v : "image";
  } catch {
    return "image";
  }
})();
// Animating a picture: one Wan 2.2 clip, or a long video in chained shots with Wan 2.2 SVI (remembered).
let animateMode: "animate" | "long" = (() => {
  try {
    return localStorage.getItem("studio.animateModel") === "long" ? "long" : "animate";
  } catch {
    return "animate";
  }
})();

interface Deps {
  toast: (msg: string, kind?: string) => void;
  root: () => string | null;
  freeGpu: () => Promise<void>;
  cameraPane: (on: boolean) => void;
  /** Switches to the Studio screen (from the lightbox when it was opened in chat). */
  show: () => void;
  /** Opens a 3D model (.glb) in the Canvas's 3D viewer. */
  openModel: (path: string, name: string) => void;
  /** Lyrics for a song in this style from the chat model, about `seconds` long (Music mode's "Write lyrics"). */
  writeLyrics: (style: string, seconds: number, signal: AbortSignal) => Promise<string>;
  /** Opens "Make it talk" for this picture: what to say and in which voice. */
  makeTalk: (path: string) => void;
  /** Storyboard mode: plans a music video from the idea and opens it as a storyboard; with no idea, opens the last one. */
  storyboard: (idea: string) => void;
  /** "Make a song about it": chat's /song with this picture, written by a model that can see it. */
  songFromPicture: (path: string) => void;
  /** Whether there's a storyboard to open again. */
  hasStoryboard: () => boolean;
  /** Film mode (film.ts): the chips under the prompt (the saved films), a new film from the idea, and a chip clicked;
   *  the film a swap can go into, and adding a swapped video to it as a new shot. */
  film: {
    opts: () => string;
    create: (idea: string) => void;
    click: (el: HTMLElement) => void;
    target: () => { id: string; name: string } | null;
    addClip: (path: string, note: string) => Promise<void>;
  };
}

export let deps: Deps;
export let items: Asset[] = [];
export let filter: "all" | "image" | "video" | "audio" | "starred" = "all";
export let query = ""; // the gallery's search box: words that must all be in the prompt, file name, model or lyrics
// Starred renders (by path), kept in this PC's settings.
export const starred = new Set<string>(loadStarred());
// Renders picked with Ctrl- or Shift-click, for the selection bar (gallery.ts).
export const selected = new Set<string>();
export let mode: "image" | "video" | "music" | "storyboard" | "film" | "webcam" = "image";
// The image being animated (Video mode) or edited (Image mode), picked from the lightbox.
export let srcAsset: Asset | null = null;
/** Switches the create bar to a mode, with the picture it edits or animates (none by default). */
export function setMode(m: typeof mode, src: Asset | null = null) {
  mode = m;
  srcAsset = src;
}
/** The gallery's list of renders, as read from ComfyUI's output folder (cards.ts). */
export function setItems(list: Asset[]) {
  items = list;
}
/** Takes a render out of the gallery's list. */
export function dropItem(path: string) {
  items = items.filter((x) => x.path !== path);
}
// The reference image (a character or item to put in a new scene), and how it's used. Kept across Image and Video.
export let ref: Reference | null = null;
// How it's used (Auto / Character / Item, and a video's first frame) is in reference.ts, shared with chat.
/** Sets the reference image (refslot.ts): one replaces a picked edit or animate source. */
export function putRef(r: Reference | null) {
  ref = r;
  if (r) srcAsset = null;
}
// Shown before the progress label during a two-step render ("Step 1 of 2 · first frame · ").
let stepNote = "";
export const workflows: Partial<Record<GenMode, any>> = {};
const active: Partial<Record<GenMode, Mode>> = {}; // the Mode (or fallback) each workflow was loaded from
// Kept across a page reload: the app's websocket to ComfyUI outlives the page and keeps the id it was opened with, and
// ComfyUI only tells that id how a render is going (a new one heard nothing, so a render after a reload never finished).
export const clientId = (() => {
  try {
    const id = localStorage.getItem("studio.clientId") || `prestige-${Math.random().toString(36).slice(2, 10)}`;
    localStorage.setItem("studio.clientId", id);
    return id;
  } catch {
    return `prestige-${Math.random().toString(36).slice(2, 10)}`;
  }
})();
export let job: { id: string; mode: GenMode; started: number; prompt: string; nodes: Record<string, string>; outputs: string[]; seed: number; count: number } | null = null;
export let starting = false; // freeing the GPU / uploading, before ComfyUI has the job
export let fresh = new Set<string>(); // names of the files the last render made
let workflowsLoaded: Promise<void> | null = null;
let settingsOpen = false;
// A render started from chat: it hears the progress and gets the finished files.
let waiter: { progress: (pct: number, label: string) => void; resolve: (a: Asset[]) => void; reject: (e: Error) => void } | null = null;

export const age = (ms: number) => {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
};

export function initStudio(d: Deps) {
  initInpaint();
  initTrain({ toast: d.toast, root: d.root, freeGpu: d.freeGpu, onLoras: () => renderCreate() });
  $("#rq-clear").addEventListener("click", () => {
    for (let i = rq.length - 1; i >= 0; i--) if (!["waiting", "running"].includes(rq[i].state)) rq.splice(i, 1);
    renderQueue();
  });
  deps = d;
  initLaser({ toast: d.toast, root: d.root, openRender });
  initLightboxZoom();
  $$(".filters [data-f]").forEach((b) =>
    b.addEventListener("click", () => {
      filter = b.dataset.f as typeof filter;
      $$(".filters [data-f]").forEach((x) => x.classList.toggle("on", x === b));
      render();
    }),
  );
  const search = $<HTMLInputElement>("#gal-search");
  search.addEventListener("input", () => {
    query = search.value;
    render();
  });
  initSelectionBar();
  $("#lb-prev").addEventListener("click", () => stepLightbox(-1));
  $("#lb-next").addEventListener("click", () => stepLightbox(1));
  $("#lb-star").addEventListener("click", () => lbAsset && toggleStar(lbAsset.path));
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
  initRefSlot();
  initSwapPanel();
  $("#gen-opts").addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    if (t.closest(".opt.set")) {
      settingsOpen = !settingsOpen;
      return renderCreate();
    }
    if (t.closest(".opt.model")) flipModel(mode === "video");
    if (t.closest(".opt.board")) deps.storyboard("");
    if (mode === "film" && !t.closest(".opt.swap")) deps.film.click(t);
    const lo = t.closest<HTMLElement>(".opt.layout");
    if (lo) lo.classList.contains("off") ? deps.toast(lo.title, "warn") : openLayoutFor(currentMode()).catch((err) => deps.toast(errMsg(err), "warn"));
    // The pictures selected in the gallery start the photo set.
    if (t.closest(".opt.teach")) openTrain(items.filter((a) => a.kind === "image" && selected.has(a.path)).map((a) => a.path));
    // The Swap chip shows or hides the Swap panel; one video selected in the gallery goes in it when it's empty.
    if (t.closest(".opt.swap")) {
      toggleSwap();
      const vids = items.filter((a) => a.kind === "video" && selected.has(a.path));
      renderCreate();
      if (swapOpen && !sw.video && vids.length === 1) setSwapVideo(vids[0]);
    }
  });
  onSettingsChange(() => renderCreate());
  onLayoutChange(() => renderCreate());
  initSongWriter();
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
    else if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && !(e.target as HTMLElement)?.closest?.("video, audio")) {
      // The arrow keys step through the gallery as it's filtered and searched (a focused player keeps them to seek).
      e.preventDefault();
      stepLightbox(e.key === "ArrowRight" ? 1 : -1);
    } else if (e.key.toLowerCase() === "s" && !e.ctrlKey && !e.altKey && !e.metaKey && lbAsset) toggleStar(lbAsset.path);
  });
  // Escape (with no window open) lets go of the picked renders.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !selected.size || !$("#lb").hidden || !studioShown() || (e.target as HTMLElement)?.closest?.("input, textarea, dialog")) return;
    clearSelection();
  });
  listen<any>("comfy", (e) => onComfy(e.payload));
  restoreQueue();
}

let holdersTimer: number | undefined;
export async function showStudio(on: boolean) {
  clearInterval(holdersTimer);
  if (!on) return;
  checkOcr();
  checkIdol(deps.root());
  checkTranslate();
  // While Studio is open, a program starting or closing on ComfyUI's card updates the warnings (takenGB redraws).
  holdersTimer = window.setInterval(() => {
    const main = comfyCards().main;
    if (main) takenGB(main.index);
  }, 3000);
  if (mode === "webcam") deps.cameraPane(true);
  await ensureWorkflows();
  await refresh();
}

let workflowsRoot: string | null | undefined; // the Workstation folder they were read from
let workflowsDone = false;
export function ensureWorkflows() {
  // Once read, read them again if the Workstation folder changed or one was missing (it may be installed since).
  const root = deps.root();
  if (workflowsDone && (root !== workflowsRoot || Object.values(workflows).some((w) => !w))) workflowsLoaded = null;
  return (workflowsLoaded ??= loadWorkflows());
}

async function loadWorkflows() {
  workflowsDone = false;
  workflowsRoot = deps.root();
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
  workflowsDone = true;
  renderCreate();
}

/** A new picture's workflow: the model picked on the chip, or MOSS-Image when Background is Transparent. */
const transparentOn = () => settings().image.transparent === "on" && !!workflows.moss;
export const pictureMode = (): GenMode => (transparentOn() ? "moss" : workflows[imageMode] ? imageMode : "fast");

/** The workflow the create bar runs now. */
function currentMode(): GenMode {
  if (mode === "music") return "song";
  if (mode === "video") return srcAsset ? animatePick() : ref ? "refvideo" : "video";
  if (srcAsset) return "edit";
  if (ref) return refImageMode();
  return pictureMode();
}

/** What layout boxes do in a mode (layout.ts): lay out a MOSS-Image picture, pick what an edit changes, or place a
 *  reference and the rest of its scene. "off" while animating a picture, which they can't steer; null where there's
 *  no layout. */
function layoutUse(gm: GenMode): "moss" | "edit" | "ref" | "off" | null {
  if (gm === "moss") return "moss";
  if (gm === "edit") return workflows.inpaint ? "edit" : null;
  if (gm === "ref" || gm === "reffast") return workflows.moss && workflows.inpaint ? "ref" : null;
  return gm === "animate" || gm === "long" || gm === "refvideo" ? "off" : null;
}

const LAYOUT_TEXT = {
  moss: { title: "Drag boxes for where text, things and people go" },
  edit: {
    title: "Drag boxes on the picture: only they change, each to what you say",
    intro: "Drag on the picture to box what should change, and say what goes in each box; drag a box to move it. Everything outside the boxes stays as it is.",
    hint: "No boxes yet: the edit follows your prompt over the whole picture.",
  },
  ref: {
    title: "Drag boxes for where your reference, other things and text go",
    intro: "Drag boxes for where your reference goes (the box marked Your reference) and where other things, people and text go. MOSS-Image lays out the scene, then Qwen-Image puts your reference in its box.",
    hint: "No boxes yet: Qwen-Image places your reference in the scene itself.",
  },
};

/** The layout boxes in use: an edit's are its picture's own. */
const syncLayout = (gm: GenMode) => (gm === "edit" && srcAsset ? useLayout("edit", srcAsset.path) : useLayout("scene"));

/** Whether a render will follow layout boxes: an edit with a box that says what goes in it, or a reference with boxes. */
const laidOut = (gm: GenMode) => {
  const use = layoutUse(gm);
  return use === "edit" ? editLayoutPrompt("") != null : use === "ref" && !!ref && layoutBoxes().length > 0;
};

/** A picture's size in pixels (read from the file when the gallery doesn't know it). */
async function pictureSize(a: Asset): Promise<{ w: number; h: number }> {
  if (a.width && a.height) return { w: a.width, h: a.height };
  const img = new Image();
  img.src = convertFileSrc(a.path);
  await img.decode();
  return { w: img.naturalWidth, h: img.naturalHeight };
}

/** Opens the layout editor for the mode: on the picture being edited, beside the reference, or on a blank canvas. */
async function openLayoutFor(gm: GenMode) {
  const use = layoutUse(gm);
  if (use === "edit" && srcAsset) {
    const { w, h } = await pictureSize(srcAsset);
    await openLayout(w, h, { picture: convertFileSrc(srcAsset.path), ...LAYOUT_TEXT.edit });
  } else if (use === "ref" && ref) {
    const p = plan(gm, ref);
    await openLayout(p.w, p.h, { reference: ref.url, ...LAYOUT_TEXT.ref });
  } else {
    const p = plan("moss");
    await openLayout(p.w, p.h);
  }
  renderCreate();
}

/** The workflow that animates a picture: the remembered pick, or whichever of the two is there. */
export const animatePick = (): GenMode => (animateMode === "long" ? (workflows.long ? "long" : "animate") : workflows.animate ? "animate" : workflows.long ? "long" : "animate");

/** The reference-image workflow for the Image mode's model pick (Qwen-Image-2.1 or its turbo). */
export const refImageMode = (): GenMode => (imageMode === "fast" ? (workflows.reffast ? "reffast" : "ref") : workflows.ref ? "ref" : "reffast");

/** Image mode's model: Qwen-Image-2.1, its turbo, or MOSS-Image (text to image only, so a reference or an edit uses
 *  Qwen-Image whatever is picked). */
type ImageMode = "image" | "fast" | "moss";
const IMAGE_MODES: ImageMode[] = ["image", "fast", "moss"];

/** A video from a reference: Qwen-Image makes the first frame first, unless the reference itself is the first frame. */
export const chained = (gm: GenMode) => gm === "refvideo" && refPrefs().frame === "scene";

/** The first frame's size for a video: the video's shape at about a megapixel (LTX scales it to the clip). */
export function frameSize(): Override {
  const [w, h] = parseRes(settings().video.res);
  const k = Math.sqrt(MP / (w * h));
  const r16 = (x: number) => Math.round((x * k) / 16) * 16;
  return { w: r16(w), h: r16(h), count: 1 };
}

export const modeOf = (gm: GenMode) => (gm === "refvideo" && wanFromPicture() ? (active.animate ?? MODES.animate) : (active[gm] ?? MODES[gm]));

/** A video from a picture runs on Wan 2.2 (uncensored models, no sound) unless Video's settings pick LTX-2.5 (sound). */
export const wanFromPicture = () => settings().video.fromPicture !== "ltx" && !!workflows.animate;
/** The workflow a mode runs (a video from a picture may run Animate's). */
export const workflowOf = (gm: GenMode) => (gm === "refvideo" && wanFromPicture() ? workflows.animate : workflows[gm]);

export function renderCreate() {
  const webcam = mode === "webcam";
  const gm = currentMode();
  syncLayout(gm);
  $$(".modes [data-mode]").forEach((x) => x.classList.toggle("on", x.dataset.mode === mode));
  // The Swap panel (Film's and Video's Swap chip) takes the place of the prompt and what goes with it.
  const swapping = swapShown();
  $("#swap-panel").hidden = !swapping;
  if (swapping) renderSwap();
  // Storyboard: the idea for a music video; the chat model plans it and it opens as a storyboard (storyboard.ts). Film:
  // the idea for a short film or a music video, which opens as a film to cast, plan, shoot and cut (film.ts).
  if (mode === "storyboard" || mode === "film") {
    for (const id of ["#animate-src", "#song-lyrics", "#ref-slot", "#gen-warn", "#gen-settings", "#cam-pane"]) $(id).hidden = true;
    deps?.cameraPane(false);
    $("#gen-form").hidden = swapping;
    $("#gen-opts").hidden = false;
    $("#create").classList.remove("disabled");
    ($("#gen-btn") as HTMLButtonElement).disabled = false;
    if (mode === "film") {
      $("#gen-btn").textContent = "New film";
      ($("#gen-prompt") as HTMLInputElement).placeholder = "What's the film about? e.g. two rival street chefs settle it with one dish at midnight (or leave it empty to start blank)";
      $("#gen-opts").innerHTML = (deps?.film.opts() ?? "") + swapChip();
      return;
    }
    $("#gen-btn").textContent = "Plan storyboard";
    ($("#gen-prompt") as HTMLInputElement).placeholder = "What's the music video about? e.g. a fox driving a vintage car through a neon city at night, 30 seconds";
    $("#gen-opts").innerHTML =
      `<span class="opt"><b>15 to 60 s</b> (30 unless you say)</span><span class="opt">a frame for every 5 s shot, to change before rendering</span><span class="opt">add <b>draft</b> for quicker shots</span>` +
      (deps?.hasStoryboard() ? `<button type="button" class="opt pick board" title="Open the storyboard you made last">Open the last storyboard</button>` : "");
    return;
  }
  $("#gen-form").hidden = webcam;
  $("#gen-opts").hidden = webcam;
  $("#cam-pane").hidden = !webcam;
  deps?.cameraPane(webcam);
  $("#animate-src").hidden = webcam || !srcAsset;
  if (srcAsset) {
    ($("#animate-img") as HTMLImageElement).src = convertFileSrc(srcAsset.path);
    $("#animate-what").textContent = `${gm === "edit" ? "Editing" : "Animating"} this image with ${modeOf(gm).label}`;
  }
  // A song takes lyrics beside its style (empty: an instrumental).
  $("#song-lyrics").hidden = gm !== "song";
  renderRefSlot(gm, webcam || gm === "song");
  if (webcam) {
    $("#gen-warn").hidden = true;
    $("#gen-settings").hidden = true;
    return;
  }
  const chain = chained(gm);
  const first = refImageMode();
  // A chained video also needs the reference-image workflow for its first frame.
  const missing = !workflowOf(gm) ? modeOf(gm).file : chain && !workflows[first] ? modeOf(first).file : "";
  const wf = workflowOf(gm) && !missing;
  const m = modeOf(gm);
  $("#create").classList.toggle("disabled", !wf);
  ($("#gen-btn") as HTMLButtonElement).disabled = !wf;
  // While something renders, the button adds to the queue.
  ($("#gen-btn") as HTMLButtonElement).textContent = buttonText(gm);
  ($("#gen-prompt") as HTMLInputElement).placeholder = promptHint(gm);
  // In Image mode the model chip switches between Qwen-Image-2.1 and its faster turbo (or Z-Image-Turbo);
  // when animating a picture, between one Wan 2.2 clip and a long Wan 2.2 SVI video.
  const animating = gm === "animate" || gm === "long";
  const label = chain ? `${modeOf(first).label} → ${m.label}` : gm === "moss" && transparentOn() ? "MOSS-Image · transparent" : gm === "moss" && settings().image.moss === "kromoss" ? "Kromoss" : mossEdits(gm) ? "MOSS-Image Edit" : m.label;
  const chip = canPick(gm)
    ? `<button type="button" class="opt pick model" title="${animating ? "Switch between one clip and a long video" : "Switch image model"}"><b>${label}</b> ⇄</button>`
    : `<span class="opt"><b>${label}</b></span>`;
  const p = plan(gm);
  // A chained video's time includes making its first frame.
  // So does a reference laid out by MOSS-Image first.
  const shown = chain ? { ...p, secs: p.secs + plan(first, ref, frameSize()).secs } : laidOut(gm) ? { ...p, count: 1, secs: p.secs + plan("moss").secs } : p;
  const what = gm === "song" ? "Length, tempo, key, language, seed" : `Size, quality, seed${isVideo(gm) ? ", length" : ", count"}`;
  const gear = `<button type="button" class="opt pick set${settingsOpen ? " on" : ""}" title="${what}…" aria-expanded="${settingsOpen}">⚙ Settings</button>`;
  // Qwen-Image modes can learn a face or a style (train.ts); select pictures in the gallery first to start from them.
  const teach = QWEN_LORA_MODES.includes(gm) ? `<button type="button" class="opt pick teach" title="Teach Qwen-Image a face or a style from your photos (select pictures in the gallery first to use them)">✦ Teach a face or style</button>` : "";
  // Layout boxes (layout.ts): where text and things go in a MOSS-Image picture, what an edit changes, or where a
  // reference goes in its scene. Animating a picture can't take them, so the button says why instead.
  const use = layoutUse(gm);
  const n = layoutBoxes().length;
  const layout =
    use === "off"
      ? `<button type="button" class="opt pick layout off" aria-disabled="true" title="Layout boxes can't steer an animation. Lay out the picture first (drop it on Edit and use Layout), then animate the result.">▦ Layout</button>`
      : use
        ? `<button type="button" class="opt pick layout" title="${LAYOUT_TEXT[use].title}">▦ Layout${n ? ` · ${n} box${n > 1 ? "es" : ""}` : ""}</button>`
        : "";
  // Video mode can also swap a character into a video (a selected one in the gallery, or one from the PC).
  const swap = mode === "video" ? swapChip() : "";
  $("#gen-opts").innerHTML = wf
    ? chip + summary(gm, shown).map((o) => `<span class="opt"><b>${o}</b></span>`).join("") + gear + teach + layout + swap
    : `<span class="opt">workflows\\${esc(missing)} not found, so this mode is off</span>`;
  const warn = $("#gen-warn");
  warn.hidden = !wf || !p.warn;
  warn.textContent = p.warn;
  const panel = $("#gen-settings");
  panel.hidden = !wf || !settingsOpen || swapping;
  if (!panel.hidden) settingsForm(panel, gm, false);
  // While swapping, the prompt and its reference, source picture and warning make way for the panel.
  if (swapping) for (const id of ["#gen-form", "#animate-src", "#ref-slot", "#gen-warn"]) $(id).hidden = true;
}

/** The create button's words: "Add to queue" while something renders. */
export const buttonText = (gm: GenMode) =>
  job || starting || current ? "Add to queue" : gm === "animate" || gm === "long" ? "Animate" : gm === "edit" ? "Edit" : gm === "song" ? "Make song" : "Generate";

/** Whether the model chip can switch: Qwen-Image-2.1 and its turbo, or one Wan 2.2 clip and a long SVI video. */
export const canPick = (gm: GenMode) =>
  !!(
    ((gm === "image" || gm === "fast" || gm === "moss") && IMAGE_MODES.filter((x) => workflows[x]).length > 1 && active.image !== ZIMAGE) ||
    ((gm === "ref" || gm === "reffast") && workflows.ref && workflows.reffast) ||
    ((gm === "animate" || gm === "long") && workflows.animate && workflows.long)
  );

/** The model chip: switches the image model, or one clip and a long video (Studio and the phone). */
export function flipModel(video: boolean) {
  if (video) {
    animateMode = animateMode === "long" ? "animate" : "long";
    try {
      localStorage.setItem("studio.animateModel", animateMode);
    } catch {}
  } else {
    // The next installed one: Qwen-Image-2.1 → its turbo → MOSS-Image → back.
    const have = IMAGE_MODES.filter((x) => workflows[x]);
    imageMode = have[(have.indexOf(imageMode) + 1) % have.length] ?? "fast";
    try {
      localStorage.setItem("studio.imageModel", imageMode);
    } catch {}
  }
  renderCreate();
}

/** What the prompt box asks for in a mode. */
export function promptHint(gm: GenMode) {
  const chain = chained(gm);
  return gm === "song"
      ? "Describe the style… e.g. dreamy indie pop, soft female vocals, warm guitars, summer night"
      : gm === "image" || gm === "fast" || gm === "moss"
      ? gm === "moss" && layoutBoxes().length
        ? "Describe the whole picture; the layout's boxes say what goes where…"
        : "Describe an image… e.g. a red and gold dragon coiled around a glowing GPU"
      : gm === "ref" || gm === "reffast"
        ? laidOut(gm)
          ? "Describe the whole scene; the boxes say where your reference and the rest go…"
          : "Describe the new scene… e.g. sitting at a café in Paris at golden hour, laughing"
        : gm === "edit"
          ? laidOut(gm)
            ? "Anything more for the boxes (optional)… e.g. hand-painted, in the evening light"
            : "Say what to change… e.g. make it night, swap the car for a horse, remove the sign"
          : gm === "animate"
            ? "Describe the motion… e.g. slow push-in, snow falling, warm light flickering"
            : gm === "long"
              ? settings().long.shots > 1
                ? "One prompt per shot, split with | … e.g. slow push-in | pans right along the porch | tilts up to the peaks"
                : "Describe the motion… e.g. slow push-in, snow falling, warm light flickering"
            : gm === "refvideo" && !chain
              ? wanFromPicture()
                ? "Describe the motion… e.g. turns to the camera and waves"
                : "Describe the motion and sound… e.g. turns to the camera and waves, birds singing"
              : gm === "refvideo" && wanFromPicture()
                ? "Describe the scene with your reference in it, and how it moves…"
                : `Describe a ${settings().video.seconds}-second scene${gm === "refvideo" ? " with your reference in it" : ""}, including any sound…`;
}

// ---------- song lyrics ----------
/** Music mode's "Write lyrics": the chat model writes lyrics for the style in the prompt box (click again to stop). */
function initSongWriter() {
  // A song from the PC (a demo, a voice memo, a hummed tune) opens in the song editor, on Cover.
  const own = $<HTMLInputElement>("#song-own-file");
  $("#song-own").onclick = () => {
    if (!workflows.songedit) return deps.toast(`Editing songs needs workflows\\${MODES.songedit.file} (update the Workstation).`, "warn");
    own.value = "";
    own.click();
  };
  own.onchange = () => {
    const f = own.files?.[0];
    if (f) editSong(f, "cover");
  };
  const btn = $<HTMLButtonElement>("#song-write");
  const box = $<HTMLTextAreaElement>("#song-lyrics-text");
  let writing: AbortController | null = null;
  btn.addEventListener("click", async () => {
    if (writing) return writing.abort();
    const style = ($("#gen-prompt") as HTMLInputElement).value.trim();
    if (!style) {
      deps.toast("Describe the song's style or what it's about first, then Write lyrics.");
      return $("#gen-prompt").focus();
    }
    if (box.value.trim() && !confirm("Replace the lyrics in the box?")) return;
    writing = new AbortController();
    btn.textContent = "Stop writing";
    box.classList.add("writing");
    try {
      box.value = await deps.writeLyrics(style, settings().music.seconds, writing.signal);
    } catch (e) {
      if (!writing.signal.aborted) deps.toast(`Couldn't write lyrics: ${errMsg(e)}`, "warn");
    } finally {
      writing = null;
      btn.textContent = "✍ Write lyrics for me";
      box.classList.remove("writing");
    }
  });
}

export const studioShown = () => !$('[data-screen="studio"]').hidden;

/** What happens to the reference in this mode. */
export const refWhat = (gm: GenMode) =>
  gm === "edit"
    ? `Image 2 of your edit: say what to take from it ("put the hat from image 2 on her"), with ${mossEdits(gm) ? "MOSS-Image" : modeOf(gm).label}`
    : gm === "refvideo"
    ? chained(gm)
      ? `Reference: ${modeOf(refImageMode()).label} puts it in the first frame, then ${modeOf(gm).label} animates it`
      : `Reference: ${modeOf(gm).label} animates this picture as it is`
    : laidOut(gm)
      ? `Reference: MOSS-Image lays out the scene from your boxes, then ${modeOf(gm).label} puts it in its box`
      : `Reference: ${modeOf(gm).label} puts it in the scene you describe`;

/** The settings as chips: size, steps, length, seed and a time estimate. */
export function summary(gm: GenMode, p: Plan): string[] {
  const m = modeOf(gm);
  const s = settings()[settingsKey(gm)];
  const out: string[] = [];
  if (p.song) {
    const sg = p.song;
    out.push(songLength(sg.seconds), `${sg.bpm} bpm`, sg.key, SONG_METERS.find(([v]) => v === sg.meter)?.[1].split(" ")[0] ?? sg.meter);
    if (sg.language !== "en") out.push(SONG_LANGUAGES.find(([c]) => c === sg.language)?.[1] ?? sg.language);
    out.push(s.seed != null ? `seed ${s.seed}` : "random seed", aboutTime(p.secs));
    return out;
  }
  if (p.w) out.push(`${p.w} × ${p.h}`);
  if (p.seconds) out.push(`${p.seconds} s · ${p.fps} fps`);
  if (p.steps) out.push(`${p.steps} steps`);
  if (p.draft) out.push("draft, one pass");
  if (m.family === "ltx" || m.family === "ltx1") out.push("with sound");
  if (p.shots) out.push(p.shots === 1 ? "1 shot" : `${p.shots} shots`);
  if (m.family === "wan" || m.family === "svi") out.push("no sound");
  if (p.count > 1) out.push(`${p.count} images`);
  if (m.note) out.push(m.note);
  if (gm === "refvideo") out.push(chained(gm) ? "your reference in a new first frame" : "your reference as the first frame");
  if (laidOut(gm)) out.push(gm === "edit" ? "only the boxes change" : "laid out by MOSS-Image");
  const lora = activeLora(gm);
  if (lora) out.push(`with ${lora.name || lora.trigger}`);
  out.push(s.seed != null ? `seed ${s.seed}` : "random seed");
  out.push(aboutTime(p.secs));
  return out;
}

export const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

// ---------- where a picture came from ----------
// Uncensored models only take what Prestige made (uncensored.ts). A render made from a photo brought in from outside
// stays "from outside", so an edit of it can't launder a real photo into the uncensored path.
export const outside = (() => {
  try {
    const v = JSON.parse(localStorage.getItem("studio.fromOutside") ?? "[]");
    return new Set<string>(Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);
  } catch {
    return new Set<string>();
  }
})();
function markOutside(added: Asset[]) {
  added.forEach((a) => outside.add(a.path));
  try {
    localStorage.setItem("studio.fromOutside", JSON.stringify([...outside]));
  } catch {}
}
/** Whether a render's source is Prestige's own: nothing (text to image), a render not made from an outside photo, or
 *  a reference taken from such a render. */
function madeHere(src: Source | null): boolean {
  if (!src) return true;
  if ("path" in src) return !outside.has(src.path) && (!src.path || items.some((x) => x.path === src.path));
  return !!src.made;
}

// ---------- generation ----------
async function generate() {
  const prompt = ($("#gen-prompt") as HTMLInputElement).value.trim();
  if (mode === "webcam") return;
  if (mode === "film") {
    ($("#gen-prompt") as HTMLInputElement).value = "";
    return deps.film.create(prompt);
  }
  if (mode === "storyboard") {
    if (!prompt) return deps.toast("Say what the music video is about, e.g. a lonely robot finds a flower, 30 seconds");
    ($("#gen-prompt") as HTMLInputElement).value = "";
    return deps.storyboard(prompt);
  }
  const gm = currentMode();
  syncLayout(gm);
  // An edit with layout boxes needs no prompt: the boxes say what changes.
  const boxedEdit = laidOut(gm) && gm === "edit";
  if ((!prompt && !boxedEdit) || !workflowOf(gm)) return;
  if (laidOut(gm) && gm !== "edit" && !layoutRefBox())
    return deps.toast("Mark one of the layout's boxes as Your reference, so Qwen-Image knows where it goes (or clear the layout).", "warn");
  // Something already rendering: this one waits its turn in the queue.
  const busy = rq.some((j) => j.state === "waiting" || j.state === "running");
  if (busy) deps.toast("Added to the render queue. It starts when the ones ahead of it finish.");
  if (boxedEdit) return layoutEdit(prompt, srcAsset!);
  if (laidOut(gm)) return layoutScene(prompt, ref!, gm);
  if (chained(gm)) {
    // Two renders: the reference in a new first frame, then the video from it. Errors arrive as a rejection.
    const t0 = Date.now();
    try {
      const got = await refVideo(prompt, ref!, refPrefs().kind);
      if (studioShown()) deps.toast(`Done in ${Math.round((Date.now() - t0) / 1000)} s: ${got[0].name}`);
    } catch (e) {
      if (errMsg(e) !== "stopped") deps.toast(`The render failed: ${errMsg(e)}`, "warn");
    }
    return;
  }
  const src = gm === "animate" || gm === "long" || gm === "edit" ? srcAsset : gm === "ref" || gm === "reffast" || gm === "refvideo" ? ref : null;
  const lyrics = gm === "song" ? ($("#song-lyrics-text") as HTMLTextAreaElement).value : undefined;
  try {
    const extra = gm === "edit" && ref ? [await uploadReference(ref)] : undefined;
    enqueue(gm, prompt, src, { kind: refPrefs().kind, lyrics, layout: true, extra });
  } catch (e) {
    deps.toast(`Couldn't add the render: ${errMsg(e)}`, "warn");
  }
}

/** Adds a render to the queue and resolves with its files when it's done (rejects if it fails or is stopped).
 *  `front`: straight after the running one (a chain's second step); `note`: shown before its progress. */
export function run(
  gm: GenMode,
  prompt: string,
  src: Source | null,
  opts: QueueOpts,
  progress?: (pct: number, label: string) => void,
  how: { front?: boolean; note?: string; from?: string; title?: string } = {},
) {
  return new Promise<Asset[]>((resolve, reject) => {
    try {
      enqueue(gm, prompt, src, opts, { ...how, waiter: { progress: progress ?? (() => {}), resolve, reject } });
    } catch (e) {
      reject(e);
    }
  });
}

/** An edit with layout boxes: one masked Qwen-Image edit redraws only the boxes, each with what it says (layout.ts). */
async function layoutEdit(prompt: string, a: Asset) {
  try {
    const { w, h } = await pictureSize(a);
    const name = await uploadMask(await layoutMask(w, h));
    enqueue("inpaint", editLayoutPrompt(prompt)!, a, { mask: { name, w, h }, regions: true }, { title: prompt || "Layout edit" });
  } catch (e) {
    deps.toast(`Couldn't add the render: ${errMsg(e)}`, "warn");
  }
}

/** A reference placed by layout boxes: MOSS-Image lays out the scene (the reference's box described), then a masked
 *  Qwen-Image edit puts the reference in place of what MOSS drew in its box. One picture, whatever the count. */
async function layoutScene(prompt: string, r: Reference, gm: GenMode) {
  const box = layoutRefBox()!;
  const kind = refPrefs().kind;
  const label = kind === "character" ? "character" : "object";
  const p = plan(gm, r);
  const t0 = Date.now();
  try {
    const [scene] = await run("moss", prompt, null, { layout: true, refLabel: label, override: { w: p.w, h: p.h, count: 1 } }, undefined, { note: "Step 1 of 2 · layout · " });
    const mask = await uploadMask(await layoutMask(p.w, p.h, box));
    const place = await uploadReference(r);
    const subject = kind === "character" ? "the character" : kind === "item" ? "the object" : "the subject";
    const text = `Replace ${boxWhat(box, label)} in image 1 with ${subject} from image 2. ${refKeep(kind, 2)} It should sit naturally in the scene, in the same light. Keep everything else exactly the same.`;
    const [out] = await run("inpaint", text, scene, { mask: { name: mask, w: p.w, h: p.h }, place, fast: gm === "reffast" }, undefined, {
      front: true,
      note: "Step 2 of 2 · your reference · ",
      title: prompt,
    });
    if (studioShown()) deps.toast(`Done in ${Math.round((Date.now() - t0) / 1000)} s: ${out.name}`);
  } catch (e) {
    if (errMsg(e) !== "stopped") deps.toast(`The render failed: ${errMsg(e)}`, "warn");
  }
}

/** A video featuring the reference: Qwen-Image puts it in a first frame at the video's shape, then LTX animates it. */
export async function refVideo(prompt: string, r: Reference, kind: RefKind, progress?: (pct: number, label: string) => void, from?: string) {
  const first = refImageMode();
  const [frame] = await run(first, prompt, r, { kind, override: frameSize() }, progress, { note: "Step 1 of 2 · first frame · ", from });
  return run("refvideo", prompt, frame, {}, progress, { front: true, note: "Step 2 of 2 · video · ", from });
}

interface QueueOpts {
  kind?: RefKind; // how a reference image is described to Qwen-Image
  override?: Override; // size and count for a chain's first frame
  mask?: { name: string; w: number; h: number }; // inpaint: the mask in ComfyUI's input folder, and the picture's size
  frames?: string; // Cut out a person: the .frames folder (under the output folder's video\) the frames go in
  lyrics?: string; // a song's (empty: an instrumental)
  song?: Partial<MusicSettings>; // a song's tempo, key or language over the saved settings (chat's songwriter)
  talk?: { audio: Blob; seconds: number }; // a talking video's voice recording and its length
  video?: Partial<VideoSettings>; // a video's length, size or quality over the saved settings (a Director shot)
  upscale?: UpscaleSize; // an upscale's shorter side
  foley?: { frames: number; w: number; h: number }; // Add sound: the frames at 24 fps and the size LTX hears them at
  swap?: SwapJob; // Swap a character: the picture, who's replaced, the frames and the size
  edit?: SongEdit; // the song editor's job
  audio?: Blob; // a song from the PC to edit (a gallery song goes as the source's path)
  outfit?: string; // Try on outfit: the outfit picture in ComfyUI's input folder
  restore?: RestoreKind; // Restore photo: what's wrong with the picture
  layout?: boolean; // MOSS-Image from Studio's create bar: with the layout's boxes (chat's /image goes without)
  refLabel?: "character" | "object"; // MOSS-Image laying out a reference's scene: what its box holds
  regions?: boolean; // inpaint: the prompt already says what fills each box (a layout edit)
  place?: string; // inpaint: a reference in ComfyUI's input folder to put in the masked area, as image 2
  fast?: boolean; // Lightning whatever the Speed setting (Reference's Turbo pick)
  world?: WorldState; // Explore a world: the world so far, rendered whole
  extra?: string[]; // an edit: more pictures in ComfyUI's input folder, as images 2 and 3
  seed?: number; // this seed rather than the settings' (a Film shot's retake)
}

/** ACE-Step's way of asking for no vocals. */
export const INSTRUMENTAL = "[Instrumental]";
export const isInstrumental = (l: string | null | undefined) => !l?.trim() || /^\[(instrumental|inst)\]$/i.test(l.trim());

/** What Qwen-Image is asked: it's an edit model, so it redraws the picture it's given unless told what to change, and
 *  it can't see the mask. The painted area is greyed out in its copy and it's told to fill the grey. */
const inpaintPrompt = (p: string) =>
  `Fill the flat gray area with: ${p.replace(/[.\s]+$/, "")}. It should blend naturally with the rest of the picture. Keep everything else exactly the same.`;

/** Turns the edit graph into an inpaint: the painted area is greyed out in the picture Qwen-Image sees, the source is
 *  encoded at the size it works at (its text encoder's latent is empty), only the masked part is noised and redrawn,
 *  and the result is scaled back and pasted over the original through the soft-edged mask, so the unpainted pixels
 *  stay exactly as they were. (Tested: mean change outside the mask 0.002 of 255.)
 *  A layout edit's prompt (`regions`) already names what fills each grey box. Placing a reference (`place`) keeps
 *  what's under the mask for Qwen-Image to replace (greyed out, it drew the reference smaller with a ghostly pane
 *  beside it) and gives it the reference as image 2. */
function inpaintGraph(g: any, mask: NonNullable<QueueOpts["mask"]>, how: Pick<QueueOpts, "regions" | "place"> = {}) {
  const res = Number(g["4"]?.inputs?.resolution) || 1024;
  const ratio = mask.w / mask.h;
  const w = Math.max(32, Math.round(Math.sqrt(res * res * ratio) / 32) * 32);
  const h = Math.max(32, Math.round(Math.sqrt((res * res) / ratio) / 32) * 32);
  g["20"] = { class_type: "LoadImageMask", inputs: { image: mask.name, channel: "red" } };
  let seen: [string, number] = ["9", 0];
  if (how.place) {
    g["28"] = { class_type: "LoadImage", inputs: { image: how.place } };
    g["4"].inputs["images.image_2"] = ["28", 0];
  } else {
    g["26"] = { class_type: "EmptyImage", inputs: { width: mask.w, height: mask.h, batch_size: 1, color: 0x808080 } };
    g["27"] = { class_type: "ImageCompositeMasked", inputs: { destination: ["9", 0], source: ["26", 0], x: 0, y: 0, resize_source: false, mask: ["20", 0] } };
    seen = ["27", 0];
    g["4"].inputs["images.image_1"] = seen;
    if (!how.regions) g["4"].inputs.prompt = inpaintPrompt(g["4"].inputs.prompt);
  }
  g["21"] = { class_type: "ImageScale", inputs: { image: seen, upscale_method: "lanczos", width: w, height: h, crop: "disabled" } };
  g["22"] = { class_type: "VAEEncode", inputs: { pixels: ["21", 0], vae: ["3", 0] } };
  g["23"] = { class_type: "SetLatentNoiseMask", inputs: { samples: ["22", 0], mask: ["20", 0] } };
  g["6"].inputs.latent_image = ["23", 0];
  g["24"] = { class_type: "ImageScale", inputs: { image: ["7", 0], upscale_method: "lanczos", width: mask.w, height: mask.h, crop: "disabled" } };
  g["25"] = { class_type: "ImageCompositeMasked", inputs: { destination: ["9", 0], source: ["24", 0], x: 0, y: 0, resize_source: false, mask: ["20", 0] } };
  g["8"].inputs.images = ["25", 0];
  g["8"].inputs.filename_prefix = "qwen-image-inpaint";
}

/** New camera angle and Try on outfit: the edit graph with its LoRA between the model and the sampler. An outfit is
 *  image 2, and the picture is encoded at its own size (resolution 0, as the Outfit Swap LoRA was measured), so the
 *  result lines up with the original. */
function reshootGraph(g: any, gm: "angle" | "outfit", outfit?: string) {
  const lora = RESHOOT_LORAS[gm]!;
  g["30"] = { class_type: "LoraLoaderModelOnly", inputs: { model: ["1", 0], lora_name: lora.file, strength_model: lora.strength } };
  g["6"].inputs.model = ["30", 0];
  if (gm === "outfit") {
    if (!outfit) throw new Error("no outfit picture");
    g["31"] = { class_type: "LoadImage", inputs: { image: outfit } };
    g["4"].inputs["images.image_2"] = ["31", 0];
    g["4"].inputs.resolution = 0;
  }
  g["8"].inputs.filename_prefix = gm === "angle" ? "qwen-image-angle" : "qwen-image-outfit";
}

/** Restore photo: the picture scaled to about 2 MP (sides in 32s) and given to the encoder at that size, so the result
 *  lines up with it, and the Restore LoRA between the model and the sampler. */
function restoreGraph(g: any, kind: RestoreKind) {
  g["10"] = { class_type: "ImageScaleToTotalPixels", inputs: { image: ["9", 0], upscale_method: "lanczos", megapixels: RESTORE.mp, resolution_steps: 32 } };
  g["4"].inputs["images.image_1"] = ["10", 0];
  g["4"].inputs.resolution = 0;
  g["4"].inputs.prompt = restorePrompt(kind);
  g["30"] = { class_type: "LoraLoaderModelOnly", inputs: { model: ["1", 0], lora_name: RESTORE.file, strength_model: kind === "blurry" ? 0.5 : 1 } };
  g["6"].inputs.model = ["30", 0];
  g["8"].inputs.filename_prefix = "qwen-image-restore";
}

/** MOSS-Image: Kromoss if it's picked, and its prompt (the layout's JSON prompt from Studio, see layout.ts). */
function mossGraph(g: any, prompt: string, alpha = false) {
  if (alpha) return mossAlphaGraph(g, prompt);
  if (settings().image.moss === "kromoss") {
    g["1"].inputs.unet_name = KROMOSS.unet;
    g["32"].inputs.lora_name = KROMOSS.lora;
    g["8"].inputs.filename_prefix = "kromoss";
  }
  g["4"].inputs.text = prompt;
}

/* Redraw upscale: AusBoss's Tiled Upscale (ComfyUI-AusBoss, MIT) enlarges the picture to 4 or 8 MP and cuts it into
 * tiles of up to 2 MP; Qwen-Image-2.1 with ausboss's Restore LoRA redraws each tile at its own size (resolution 0) from
 * the restore request, and Tiled Upscale Stitch blends them back, each tile's colours matched to the same tile of the
 * picture. A picture is redrawn at no more than 8 times its own megapixels and enlarged plainly from there, as the
 * node's max_growth does, so a small picture isn't invented past its detail. */
export const REDRAW_MP: Partial<Record<GenMode, number>> = { redraw4: 4, redraw8: 8 };
export const REDRAW = { tileMp: 2, overlap: 128, growth: 8 };
/** The megapixels a redraw makes of this picture. */
export const redrawMp = (gm: GenMode, src: Source | null) => {
  const own = src?.width && src.height ? (src.width * src.height) / MP : 1;
  return Math.min(REDRAW_MP[gm] ?? 4, own * REDRAW.growth);
};

function redrawGraph(g: any, mp: number) {
  g["u1"] = {
    class_type: "AUSBOSS_NODES_TiledUpscale",
    inputs: { image: ["9", 0], megapixels: mp, tile_megapixels: REDRAW.tileMp, overlap: REDRAW.overlap, multiple: 32, max_growth: REDRAW.growth },
  };
  g["4"].inputs["images.image_1"] = ["u1", 0];
  g["4"].inputs.resolution = 0;
  g["4"].inputs.prompt = restorePrompt("photo");
  g["30"] = { class_type: "LoraLoaderModelOnly", inputs: { model: ["1", 0], lora_name: RESTORE.file, strength_model: 1 } };
  g["6"].inputs.model = ["30", 0];
  g["u2"] = { class_type: "AUSBOSS_NODES_TiledUpscaleStitch", inputs: { tiles: ["7", 0], stitcher: ["u1", 1], keep_colors: 1 } };
  g["8"].inputs.images = ["u2", 0];
  g["8"].inputs.filename_prefix = `qwen-image-redraw-${mp >= 8 ? 8 : 4}mp`;
}

/* Transparent pictures (Background: Transparent in the image settings): paralaif's MOSS-Image Alpha LoRA on the SFT
 * model teaches it latents that carry an alpha channel, and trmz/flux2-klein-alpha's RGBA VAE (Apache-2.0, loaded by
 * the engine's Workstation RGBA VAE Loader) decodes them to a PNG with real, partial transparency. The LoRA's card
 * settings: strength 1, the prompt ending ", isolated on a transparent background", and with the 8-step DMD LoRA,
 * 8 steps at CFG 1 with er_sde. The LoRA is a proof of concept released for non-commercial research and evaluation
 * only (some of its training pictures came from Qwen-Image 2.1), which the setting says. On the RTX 3060
 * a 1024² sticker (a fox knight, a glass potion, a chrome logo) took 12 s (18 s with loading), peaking at 6.5 GB, with
 * the glass and the chrome partly see-through. */
const MOSS_ALPHA = {
  lora: "moss\\moss-alpha-v1.safetensors",
  vae: "moss\\flux2-klein-alpha-rgba-vae.safetensors",
  trigger: ", isolated on a transparent background",
};

/** MOSS-Image with the Alpha LoRA after its 8-step LoRA, decoded by the RGBA VAE: a transparent PNG. Always the SFT
 *  model, which the LoRA was trained on. */
function mossAlphaGraph(g: any, prompt: string) {
  g["4"].inputs.text = `${prompt.trim().replace(/[.,;\s]+$/, "")}${MOSS_ALPHA.trigger}`;
  g["33"] = { class_type: "LoraLoaderModelOnly", inputs: { model: ["32", 0], lora_name: MOSS_ALPHA.lora, strength_model: 1 } };
  g["6"].inputs.model = ["33", 0];
  g["6"].inputs.sampler_name = "er_sde";
  g["34"] = { class_type: "WorkstationRGBAVAELoader", inputs: { vae_name: MOSS_ALPHA.vae } };
  g["7"].inputs.vae = ["34", 0];
  g["8"].inputs.filename_prefix = "moss-image-alpha";
}

/** A transparent picture needs the engine's RGBA VAE node and the Alpha LoRA; say what to do if either is missing. */
async function checkAlpha(graph: any) {
  if (!(await hasNode("WorkstationRGBAVAELoader"))) throw new Error("Transparent pictures need the Workstation's RGBA VAE node: restart Prestige's services to copy it in");
  const r = await http(`${COMFY}/object_info/LoraLoaderModelOnly`).catch(() => null);
  const names: string[] = (await r?.json().catch(() => null))?.LoraLoaderModelOnly?.input?.required?.lora_name?.[0] ?? [];
  if (names.length && !names.includes(graph["33"].inputs.lora_name)) throw new Error("Transparent pictures need the MOSS-Image Alpha LoRA: add the Workstation's moss pack again");
}

/* MOSS-Image edits (Edit with: MOSS-Image in the image settings): chinoll's Moss-Image-Edit LoRA (rank 64, in
 * PedroMarinhoDev's ComfyUI key names) on the SFT model, through ComfyUI's own Text Encode MOSS-Image Edit node (ComfyUI
 * #17296, newer than 0.42.5). It takes Edit (with up to two more pictures), Paint to change, a layout edit and Reference;
 * a layout's reference is still placed by Qwen-Image (prepare). The LoRA's own settings are 30 steps at CFG 4 (Quality);
 * Fast adds lodestones' 8-step DMD LoRA at CFG 1. On the RTX 3060 a 1024² edit took 13 s Fast and 69 s Quality (warm),
 * peaking at 10.9 GB (11.7 GB with a second picture). With the picture at 512 px, as the LoRA's card suggests, the cabin
 * came out smaller and moved, so the picture goes in at about 1 MP; further pictures at 1 MP bled into it (a red knit
 * texture over the cabin), so they go in at 0.25 MP.
 * MOSS-Image has no filter, so the uncensored rule needs nothing here. */
export const MOSS_EDIT = {
  unet: "moss\\moss_image_sft_int8_convrot.safetensors",
  clip: "moss\\qwen3.5_9b_w4a8_gptq.safetensors",
  vae: "moss\\flux2-vae_small.safetensors",
  lora: "moss\\moss-image-edit-lora-bf16.safetensors",
  fastLora: "moss\\moss-image-sft-8-steps-dmd-lora.safetensors",
  fast: { steps: 8, cfg: 1, secs: 13 },
  quality: { steps: 30, cfg: 4, secs: 69 },
  refs: 3,
  moreMp: 0.25,
};
export const MOSS_EDIT_MODES: GenMode[] = ["edit", "inpaint", "ref", "reffast"];
export const mossEdits = (gm: GenMode) => MOSS_EDIT_MODES.includes(gm) && settings().image.editModel === "moss";

/** Turns a finished Qwen-Image edit, Paint to change or Reference graph into the same render on MOSS-Image: the same
 *  pictures as references (each at about 1 MP; an inpaint's is the greyed copy at the size it's sampled at) and the
 *  same prompt, the edit LoRA, and Fast or Quality steps. Qwen's LoRAs (Lightning, a taught face) are dropped. */
function mossEditGraph(g: any, fast: boolean) {
  const te = g["4"].inputs;
  const pics = Object.keys(te)
    .filter((k) => /^images\.image_\d+$/.test(k))
    .sort()
    .map((k) => te[k])
    .slice(0, MOSS_EDIT.refs);
  for (const id of ["35", "40"]) delete g[id];
  g["1"] = { class_type: "UNETLoader", inputs: { unet_name: MOSS_EDIT.unet, weight_dtype: "default" } };
  g["2"] = { class_type: "CLIPLoader", inputs: { clip_name: MOSS_EDIT.clip, type: "moss_image", device: "default" } };
  g["3"] = { class_type: "VAELoader", inputs: { vae_name: MOSS_EDIT.vae } };
  const k = g["6"].inputs;
  const inpaint = Array.isArray(k.latent_image) && k.latent_image[0] === "23";
  const refs = pics.map((pic, i): [string, number] => {
    if (inpaint && i === 0) return ["21", 0];
    g[`mref${i}`] = { class_type: "ImageScaleToTotalPixels", inputs: { image: pic, upscale_method: "lanczos", megapixels: i ? MOSS_EDIT.moreMp : 1, resolution_steps: 16 } };
    return [`mref${i}`, 0];
  });
  const encode = (prompt: string) => ({
    class_type: "TextEncodeMOSSImageEdit",
    inputs: { clip: ["2", 0], vae: ["3", 0], prompt, edit_format: "Moss-Image-Edit", image_strength: 1, ...Object.fromEntries(refs.map((r, i) => [`images.image_${i}`, r])) },
  });
  g["4"] = encode(te.prompt);
  g["4n"] = encode("");
  g["medit"] = { class_type: "LoraLoaderModelOnly", inputs: { model: ["1", 0], lora_name: MOSS_EDIT.lora, strength_model: 1 } };
  let model: [string, number] = ["medit", 0];
  if (fast) {
    g["mfast"] = { class_type: "LoraLoaderModelOnly", inputs: { model, lora_name: MOSS_EDIT.fastLora, strength_model: 1 } };
    model = ["mfast", 0];
  }
  const s = fast ? MOSS_EDIT.fast : MOSS_EDIT.quality;
  Object.assign(k, { model, positive: ["4", 0], negative: ["4n", 0], steps: s.steps, cfg: s.cfg, sampler_name: "euler", scheduler: "simple" });
  // An edit is the size of its picture: an encoded copy gives the sampler that size (denoise 1 keeps none of it).
  if (Array.isArray(k.latent_image) && k.latent_image[0] === "4") {
    g["mlat"] = { class_type: "VAEEncode", inputs: { pixels: refs[0], vae: ["3", 0] } };
    k.latent_image = ["mlat", 0];
  }
  if (g["5"]?.class_type === "EmptyLatentImage") g["5"].class_type = "EmptyFlux2LatentImage";
  g["8"].inputs.filename_prefix = String(g["8"].inputs.filename_prefix).replace("qwen-image", "moss-image");
}

/** Make it manga: the picture at about 2 MP redrawn as an inked panel, printed by Manga Finish and framed by Manga Panel. */
function mangaGraph(g: any) {
  g["10"] = { class_type: "ImageScaleToTotalPixels", inputs: { image: ["9", 0], upscale_method: "lanczos", megapixels: MANGA_MP, resolution_steps: 32 } };
  g["4"].inputs["images.image_1"] = ["10", 0];
  g["4"].inputs.resolution = 0;
  g["4"].inputs.prompt = MANGA_PROMPT;
  g["50"] = {
    class_type: "MangaFinish",
    inputs: { image: ["7", 0], screen_lines: 250, white_point: 0.8, black_point: 0.3, light_tone: 0.18, dark_tone: 0.42, gradation: 1, pen_threshold: 0.3, white_lines: 0.4 },
  };
  g["51"] = { class_type: "MangaPanel", inputs: { image: ["50", 0], frame: "original", crop_x: 0.5, crop_y: 0.4, border: 5, margin: 60, paper: "white", ink: 0.5 } };
  g["8"].inputs.images = ["51", 0];
  g["8"].inputs.filename_prefix = "qwen-image-manga";
}

/** An edit's other pictures (Studio's reference slot, or chat's further attachments) as images 2 and 3. */
function extraPictures(g: any, names: string[]) {
  names.slice(0, MOSS_EDIT.refs - 1).forEach((name, i) => {
    g[`x${i + 2}`] = { class_type: "LoadImage", inputs: { image: name } };
    g["4"].inputs[`images.image_${i + 2}`] = [`x${i + 2}`, 0];
  });
}

/** Fast: the Lightning LoRA last in the model's chain (after a taught face or style, or the Restore LoRA),
 *  4 steps at CFG 1. */
function lightningGraph(g: any) {
  g["35"] = { class_type: "LoraLoaderModelOnly", inputs: { model: g["6"].inputs.model, lora_name: LIGHTNING.file, strength_model: 1 } };
  g["6"].inputs.model = ["35", 0];
  g["6"].inputs.steps = LIGHTNING.steps;
  g["6"].inputs.cfg = 1;
}

/** Whether ComfyUI has a node (one from a custom node pack, say). Unreachable counts as yes: the render then says why. */
async function hasNode(name: string): Promise<boolean> {
  const r = await http(`${COMFY}/object_info/${name}`).catch(() => null);
  if (!r?.ok) return true;
  return name in ((await r.json().catch(() => ({}))) ?? {});
}

/* Faster video: SageAttention 2.2 (int8 attention kernels, through triton-windows) on Wan 2.2, by the engine's
 * Workstation Sage Attention node after each diffusion-model loader. The node passes the model through unchanged where
 * the kernels can't run (not installed, or a card older than Ampere, like the RTX 2060), so this is safe to leave on.
 * On the RTX 3060 a Wan 2.2 step went from 72-77 s to 55-61 s, and a 4-shot long video at 640 px from 1,769 s to
 * 1,525 s. Not LTX-2.5: its steps took 7.9 s with and without (KJNodes' LTX-2 patch too), and most of its time isn't
 * sampling. TeaCache and EasyCache were left out: at 4 and 8 distilled steps EasyCache skipped none on LTX, and TeaCache
 * saved 28 s of 368 on a Wan clip. */
export const SAGE_FAMILIES: Family[] = ["wan", "svi"];
export const SAGE_HINT = "SageAttention for Wan 2.2 on RTX 30-series and newer cards (a long video ~14% quicker); it does nothing where it can't run";
const MODEL_LOADERS = ["UNETLoader", "UnetLoaderGGUF"];

/** Puts Workstation Sage Attention between each diffusion-model loader and everything that uses its model. */
function sageGraph(g: any) {
  for (const id of Object.keys(g).filter((k) => MODEL_LOADERS.includes(g[k].class_type))) {
    const sage = `sage${id}`;
    for (const node of Object.values<any>(g))
      for (const [k, v] of Object.entries<any>(node.inputs ?? {})) if (Array.isArray(v) && v[0] === id && v[1] === 0) node.inputs[k] = [sage, 0];
    g[sage] = { class_type: "WorkstationSageAttention", inputs: { model: [id, 0], enabled: true } };
  }
}

/** Whether one of a ComfyUI node's choices is there (a model type a newer ComfyUI added). Unreachable counts as yes. */
async function comfyKnows(node: string, input: string, choice: string): Promise<boolean> {
  const r = await http(`${COMFY}/object_info/${node}`).catch(() => null);
  const info = r?.ok ? await r.json().catch(() => null) : null;
  const opts = info?.[node]?.input?.required?.[input]?.[0];
  return !Array.isArray(opts) || opts.includes(choice);
}

/** A MOSS-Image edit needs ComfyUI's MOSS edit node and the edit LoRA; say what to do if either is missing. */
async function checkMossEdit(graph: any) {
  if (!(await hasNode("TextEncodeMOSSImageEdit")))
    throw new Error("MOSS-Image edits need a ComfyUI newer than 0.42.5: update ComfyUI, or set Edit with to Qwen-Image in the image settings");
  const r = await http(`${COMFY}/object_info/LoraLoaderModelOnly`).catch(() => null);
  const names: string[] = (await r?.json().catch(() => null))?.LoraLoaderModelOnly?.input?.required?.lora_name?.[0] ?? [];
  if (names.length && !names.includes(MOSS_EDIT.lora)) throw new Error("MOSS-Image edits need the MOSS edit LoRA: add the Workstation's moss pack again");
  if (graph.mfast && names.length && !names.includes(MOSS_EDIT.fastLora)) {
    graph["6"].inputs.model = ["medit", 0];
    Object.assign(graph["6"].inputs, { steps: MOSS_EDIT.quality.steps, cfg: MOSS_EDIT.quality.cfg });
    delete graph.mfast;
  }
}

let lightningMissingSaid = false;
/** A LoRA a render needs must be in ComfyUI's loras folder; say which pack brings it if it isn't. Without the
 *  Lightning LoRA a Fast render runs at its Quality steps instead (Reference's Turbo on the turbo model). */
async function checkLora(graph: any, gm: GenMode) {
  const r = await http(`${COMFY}/object_info/LoraLoaderModelOnly`).catch(() => null);
  const names: string[] = (await r?.json().catch(() => null))?.LoraLoaderModelOnly?.input?.required?.lora_name?.[0] ?? [];
  if (!names.length) return;
  const fast = loraNode(graph, "35");
  if (fast && !names.includes(fast.inputs.lora_name)) {
    graph["6"].inputs.model = fast.inputs.model;
    delete graph["35"];
    if (gm === "reffast") graph["1"].inputs.unet_name = TURBO_UNET;
    else graph["6"].inputs.steps = stepsOf(modeOf(gm), settings().image.quality);
    if (!lightningMissingSaid) deps.toast("Fast edits need the Lightning LoRA: add the Images pack in Packs. Until then they run at Quality.");
    lightningMissingSaid = true;
  }
  const want = loraNode(graph, "30")?.inputs?.lora_name as string | undefined;
  if (want && !names.includes(want)) throw new Error(`${want} isn't installed: add the Reshoot pack in Packs`);
}

/** A graph's node by id when it's a LoRA loader. Other graphs use the same ids for other nodes: in every LTX graph
 *  35 decodes the sound, and taking it for the Lightning LoRA deleted it, so ComfyUI refused the render. */
function loraNode(graph: any, id: string): any {
  return graph[id]?.class_type === "LoraLoaderModelOnly" ? graph[id] : undefined;
}

/** Explore a world: per segment a World Prompt holding the world up to it (so ComfyUI can reuse the segments a
 *  continued world already has), the Segment's conditioning and empty latent with the world so far as history, an
 *  8-step sample, and Extend World's cache pass; then the whole world decoded to one video. A picture it starts from
 *  is segment 0 (Start From Image); the camera keys steer a segment instead of a written camera. */
function worldGraph(g: any, w: WorldState) {
  const upTo = (i: number) => JSON.stringify({ ...w.json, segments: w.json.segments.slice(0, i + 1) });
  let world: [string, number] | null = null;
  let first = 0;
  if (w.start) {
    // Start From Image wants segment 0 (the picture) and the first that moves; segment 1 doesn't change later.
    g["w0p"] = { class_type: "HyNomasWorldPrompt", inputs: { world_json: upTo(1) } };
    g["w0i"] = { class_type: "LoadImage", inputs: { image: w.start } };
    g["w0"] = {
      class_type: "HyNomasStartFromImage",
      inputs: { model: ["1", 0], clip: ["2", 0], encoder: ["4", 0], script: ["w0p", 0], image: ["w0i", 0], width: WORLD.w, height: WORLD.h, still_frames: 3, seed: w.seed },
    };
    world = ["w0", 0];
    first = 1;
  } else delete g["4"];
  let script: [string, number] = ["w0p", 0];
  for (let i = first; i < w.json.segments.length; i++) {
    const id = (s: string) => `w${i}${s}`;
    g[id("p")] = { class_type: "HyNomasWorldPrompt", inputs: { world_json: upTo(i) } };
    script = [id("p"), 0];
    const seg: any = { clip: ["2", 0], script, segment_index: i, width: WORLD.w, height: WORLD.h };
    if (world) seg.world = world;
    if (w.camera[i]) {
      g[id("c")] = { class_type: "HyNomasCameraKeys", inputs: { timeline: w.camera[i], translation_scale: 1, rotation_scale: 2.5 } };
      seg.camera = [id("c"), 0];
    }
    g[id("s")] = { class_type: "HyNomasSegment", inputs: seg };
    g[id("k")] = {
      class_type: "KSampler",
      inputs: { model: ["1", 0], positive: [id("s"), 0], negative: [id("s"), 1], latent_image: [id("s"), 2], seed: w.seed + i, steps: WORLD.steps, cfg: 1, sampler_name: "euler", scheduler: "simple", denoise: 1 },
    };
    g[id("x")] = { class_type: "HyNomasExtendWorld", inputs: { model: ["1", 0], positive: [id("s"), 0], samples: [id("k"), 0], seed: w.seed + i } };
    world = [id("x"), 0];
  }
  Object.assign(g["6"].inputs, { world, script, seed: w.seed, start_image: w.start ? "one frame" : "none" });
}

/** Add sound's graph: the video's frames at 24 fps, frozen (a noise mask of 0), and sound made for each 89-frame
 *  window in turn, the windows joined end to end into one track. The positive prompt ends with Lightricks' "no speech,
 *  no music" so effects aren't drowned out. */
function foleyGraph(g: any, f: NonNullable<QueueOpts["foley"]>, seed: number) {
  g["5"].inputs.text = `${String(g["5"].inputs.text).replace(/[.\s]+$/, "")}. No speech is present. No music is present.`;
  Object.assign(g["10"].inputs, { custom_width: f.w, custom_height: f.h, frame_load_cap: f.frames });
  Object.assign(g["11"].inputs, { width: f.w, height: f.h });
  const tpl: Record<string, any> = {};
  for (const id of Object.keys(g).filter((k) => k.startsWith("w0"))) {
    tpl[id.slice(2)] = g[id];
    delete g[id];
  }
  let audio: [string, number] | null = null;
  for (let start = 0, k = 0; start < f.frames; k++) {
    const n = Math.floor((Math.min(FOLEY_WINDOW, f.frames - start) - 1) / 8) * 8 + 1;
    if (n < 9) break;
    const id = (s: string) => `w${k}${s}`;
    const link = (v: any) => (Array.isArray(v) && typeof v[0] === "string" && v[0].startsWith("w0") ? [id(v[0].slice(2)), v[1]] : v);
    for (const [s, node] of Object.entries(tpl)) {
      const inputs = Object.fromEntries(Object.entries(node.inputs).map(([key, v]) => [key, link(v)]));
      g[id(s)] = { ...node, inputs };
    }
    g[id("f")].inputs.batch_index = start;
    g[id("f")].inputs.length = n;
    g[id("a")].inputs.frames_number = n;
    g[id("n")].inputs.noise_seed = seed + k;
    if (audio) {
      g[id("j")] = { class_type: "AudioConcat", inputs: { audio1: audio, audio2: [id("d"), 0], direction: "after" } };
      audio = [id("j"), 0];
    } else audio = [id("d"), 0];
    start += n;
  }
  if (!audio) throw new Error("the video is too short (it needs at least half a second)");
  g["30"].inputs.audio = audio;
}

/** A Swap a character render: the uploaded picture, who's replaced, the source's frames to swap and the size. */
export interface SwapJob {
  ref: string; // the character's picture in ComfyUI's input folder
  who: string; // what SAM 3.1 looks for in the video ("person", "the man in the red jacket")
  steps: number;
  frames: number;
  w: number;
  h: number;
}

/** A node's id by its class_type (the first, or the first `pick` accepts). Workflows reuse ids for other nodes, so
 *  they're found this way rather than by number. */
function classNode(g: any, cls: string, pick?: (n: any) => boolean): string | undefined {
  return Object.keys(g).find((k) => g[k].class_type === cls && (!pick || pick(g[k])));
}

/** How many 81-frame segments swap this many frames: the first makes 81, each after it 76 new ones. */
export const swapParts = (frames: number) => (frames <= SWAP.part ? 1 : 1 + Math.ceil((frames - SWAP.part) / SWAP.step));

/** Swap a character's graph: the workflow's segment nodes (marked "segment" in the file) repeated for every 81 frames
 *  of the video, 76 frames apart; a segment after the first gets the one before it as previous_frames (SCAIL-2 keeps
 *  its last 5), drops the 5 frames it repeats, and has its colours matched to the frame it carries on from, as
 *  Comfy-Org's template does. The segments are joined and saved at the video's own frame rate. */
function swapGraph(g: any, s: SwapJob, seed: number) {
  const need = (id: string | undefined, what: string) => {
    if (!id) throw new Error(`workflows\\${MODES.swap.file} has no ${what}`);
    return id;
  };
  g[need(classNode(g, "LoadImage"), "LoadImage")].inputs.image = s.ref;
  const sam = need(classNode(g, "CheckpointLoaderSimple"), "SAM 3.1 loader");
  const who = need(classNode(g, "CLIPTextEncode", (n) => n.inputs.clip?.[0] === sam), "SAM 3.1 prompt");
  g[who].inputs.text = s.who.trim() || "person";
  g[need(classNode(g, "BasicScheduler"), "BasicScheduler")].inputs.steps = s.steps;
  // The picture is padded to the video's shape: WanSCAILToVideo crops it to that shape, which cut a full-body
  // portrait to a strip of its middle, and the character came out headless or drawn far too big.
  Object.assign(g[need(classNode(g, "ResizeAndPadImage"), "ResizeAndPadImage")].inputs, { target_width: s.w, target_height: s.h });
  const tpl: Record<string, any> = {};
  for (const id of Object.keys(g).filter((k) => g[k]._meta?.title === "segment")) {
    tpl[id] = g[id];
    delete g[id];
  }
  const seg = (cls: string) => need(Object.keys(tpl).find((k) => tpl[k].class_type === cls), `segment ${cls}`);
  const [cut, scale, scail, sampler, decode] = ["ImageFromBatch", "ImageScale", "WanSCAILToVideo", "SamplerCustom", "VAEDecode"].map(seg);
  let out: [string, number] | null = null;
  let prev: [string, number] | null = null;
  for (let k = 0, start = 0; start === 0 || start + SWAP.overlap < s.frames; k++, start += SWAP.step) {
    // The model takes 1 + 4n frames.
    const n = Math.floor((Math.min(SWAP.part, s.frames - start) - 1) / 4) * 4 + 1;
    if (k > 0 && n <= SWAP.overlap) break;
    const id = (t: string) => `${t}~${k}`;
    for (const [t, node] of Object.entries(tpl)) {
      const inputs = Object.fromEntries(Object.entries<any>(node.inputs).map(([key, v]) => [key, Array.isArray(v) && tpl[v[0]] ? [id(v[0]), v[1]] : v]));
      g[id(t)] = { class_type: node.class_type, inputs };
    }
    Object.assign(g[id(cut)].inputs, { batch_index: start, length: n });
    Object.assign(g[id(scale)].inputs, { width: s.w, height: s.h });
    Object.assign(g[id(scail)].inputs, { width: s.w, height: s.h, length: n, ...(prev ? { previous_frames: prev } : {}) });
    g[id(sampler)].inputs.noise_seed = seed + k;
    // The next segment carries on from this one's frames as they're kept (colour-matched after the first).
    if (!out || !prev) out = prev = [id(decode), 0];
    else {
      g[id("new")] = { class_type: "ImageFromBatch", inputs: { image: [id(decode), 0], batch_index: SWAP.overlap, length: 4096 } };
      g[id("last")] = { class_type: "ImageFromBatch", inputs: { image: prev, batch_index: 4095, length: 1 } };
      g[id("match")] = { class_type: "ColorTransfer", inputs: { image_target: [id("new"), 0], image_ref: [id("last"), 0], method: "reinhard_lab", source_stats: "per_frame", strength: 1 } };
      g[id("join")] = { class_type: "ImageBatch", inputs: { image1: out, image2: [id("match"), 0] } };
      out = [id("join"), 0];
      prev = [id("match"), 0];
    }
  }
  g[need(classNode(g, "CreateVideo"), "CreateVideo")].inputs.images = out;
}

/** What a swap's progress line says, per segment: "Swapping part 2 of 3". */
const SWAP_LABELS: Record<string, string> = {
  SAM3_VideoTrack: "Finding who to replace",
  RemoveBackground: "Cutting the character out of the picture",
  CLIPVisionEncode: "Looking at the character",
  WanSCAILToVideo: "Reading the movement",
  ColorTransfer: "Matching the colours",
  CreateVideo: "Making the video",
  SaveVideo: "Saving the video",
};
function swapLabels(g: any, nodes: Record<string, string>) {
  const parts = Object.keys(g).filter((k) => g[k].class_type === "SamplerCustom").length;
  for (const [id, n] of Object.entries<any>(g)) {
    const k = Number(id.split("~")[1] ?? 0);
    const of = parts > 1 ? ` part ${k + 1} of ${parts}` : "";
    if (n.class_type === "SamplerCustom") nodes[id] = `Swapping${of || " the character"}`;
    if (n.class_type === "VAEDecode") nodes[id] = `Decoding${of || " the frames"}`;
    if (n.class_type === "SAM3_VideoTrack" && id.includes("~")) nodes[id] = `Finding who to replace${of}`;
  }
}

/** A swap needs ComfyUI's SCAIL-2 nodes and its model; say what to do if either is missing. */
async function checkSwap(graph: any) {
  if (!(await hasNode("WanSCAILToVideo"))) throw new Error("Swap a character needs a ComfyUI with SCAIL-2 (0.42 or newer): update ComfyUI in Comfy Desktop");
  for (const [cls, input] of [["UNETLoader", "unet_name"], ["LoadBackgroundRemovalModel", "bg_removal_name"]]) {
    const want = graph[classNode(graph, cls) ?? ""]?.inputs?.[input];
    const r = await http(`${COMFY}/object_info/${cls}`).catch(() => null);
    // A choice list is [names] on older nodes and ["COMBO", { options: names }] on newer ones.
    const spec = (await r?.json().catch(() => null))?.[cls]?.input?.required?.[input];
    const names: string[] = (Array.isArray(spec?.[0]) ? spec[0] : spec?.[1]?.options) ?? [];
    if (want && names.length && !names.includes(want)) throw new Error(`${want} isn't installed: add the Swap a character pack in Packs`);
  }
}

// ---------- the render queue ----------
// Every render (Studio, chat, Paint to change) goes through here and they run one at a time. A render's settings,
// seed and workflow are fixed when it's added, so changing the settings afterwards only affects new ones.
export interface QJob {
  id: number;
  gm: GenMode;
  prompt: string;
  label: string; // the model, e.g. "Qwen-Image-2.1"
  from: string; // "Studio", "chat", "Paint to change"
  src: Source | null;
  graph: any;
  nodes: Record<string, string>;
  seed: number;
  count: number;
  note: string; // "Step 1 of 2 · first frame · "
  state: "waiting" | "running" | "done" | "failed" | "stopped";
  pct: number;
  status: string;
  added: number;
  took?: number;
  result?: Asset[];
  error?: string;
  waiter?: { progress: (pct: number, label: string) => void; resolve: (a: Asset[]) => void; reject: (e: Error) => void };
  cancelled?: boolean; // stopped while it was getting ready
  audio?: Blob; // a talking video's voice recording, uploaded with the picture
  promptId?: string; // ComfyUI's id once it has the render, and when it started there
  started?: number;
  held?: boolean; // saved from before the page reloaded: waits for Resume
}
export const rq: QJob[] = [];
export let current: QJob | null = null;
let jobIds = 1;

// ---------- the queue kept on disk (queuestore.ts) ----------
// Not "" (an empty queue): the first save always writes, so what was restored and has since finished is cleared.
let savedKey: string | null = null;
let saving = Promise.resolve();
/** Saves the waiting and running renders when that changes (not on every progress tick). */
function persistQueue() {
  const live = rq.filter((j) => j.state === "waiting" || j.state === "running");
  const key = live.map((j) => `${j.id}${j.state}${j.promptId ?? ""}${j.held ? "h" : ""}`).join(",");
  if (key === savedKey) return;
  savedKey = key;
  const rows = live.map((j, pos) => {
    const { waiter: _w, result: _r, src, ...rest } = j;
    // A reference's object URL dies with the page; its picture (the Blob) is kept and the URL made again.
    return { ...rest, pos, src: src && "blob" in src ? { ...src, url: "" } : src };
  });
  saving = saving.then(() => saveJobs(rows)).catch(() => {});
}

/** After a reload: the render that was running is picked up from ComfyUI (still going, or already finished), or put
 *  back first in the queue if ComfyUI lost it. The waiting ones come back paused, for Resume or Clear. */
async function restoreQueue() {
  let saved: (QJob & { pos: number })[] = [];
  try {
    saved = (await loadJobs<QJob & { pos: number }>()).sort((a, b) => a.pos - b.pos);
  } catch {
    return;
  }
  if (!saved.length) return;
  for (const j of saved) {
    if (j.src && "blob" in j.src) j.src.url = URL.createObjectURL(j.src.blob);
    jobIds = Math.max(jobIds, j.id + 1);
  }
  const running = saved.find((j) => j.state === "running");
  let picked = false;
  if (running?.promptId) {
    const where = await comfyHas(running.promptId);
    if (where === "queued") {
      current = running;
      stepNote = running.note;
      job = { id: running.promptId, mode: running.gm, started: running.started ?? Date.now(), prompt: running.prompt, nodes: running.nodes, outputs: [], seed: running.seed, count: running.count };
      $("#job-what").textContent = running.prompt;
      $("#job").hidden = false;
      setJob(running.pct || 5, "Picked up after the reload…");
      picked = true;
    } else if (where === "done") {
      await refresh();
      const names = await comfyOutputs(running.promptId);
      Object.assign(running, { state: "done", result: items.filter((a) => names.includes(a.name)), took: Math.round((Date.now() - (running.started ?? Date.now())) / 1000) });
      picked = true;
    }
  }
  for (const j of saved) {
    if (j === running && picked) continue;
    Object.assign(j, { state: "waiting", pct: 0, status: "Waiting", held: true, promptId: undefined });
  }
  rq.unshift(...saved);
  if (picked && running) deps.toast(running.state === "done" ? `The render that was going finished while Prestige reloaded: ${running.prompt.slice(0, 60)}` : `Picked up the render that was going: ${running.prompt.slice(0, 60)}`);
  renderQueue();
  renderCreate();
}

/** Whether ComfyUI still has a render ("queued": running or waiting there), has finished it, or doesn't know it. */
async function comfyHas(id: string): Promise<"queued" | "done" | "gone"> {
  try {
    const q = await (await http(`${COMFY}/queue`)).json();
    const ids = [...(q.queue_running ?? []), ...(q.queue_pending ?? [])].map((x: any[]) => x[1]);
    if (ids.includes(id)) return "queued";
    return Object.keys(await (await http(`${COMFY}/history/${id}`)).json()).length ? "done" : "gone";
  } catch {
    return "gone";
  }
}

/** The files a finished ComfyUI render saved. */
async function comfyOutputs(id: string): Promise<string[]> {
  try {
    const h = (await (await http(`${COMFY}/history/${id}`)).json())[id];
    if (h?.status?.status_str === "error") return [];
    return Object.values<any>(h?.outputs ?? {}).flatMap((o) => Object.values<any>(o).flat()).filter((f) => f?.filename && f.type === "output").map((f) => f.filename);
  } catch {
    return [];
  }
}

/** Resume (or Clear) the renders that came back from before the reload. */
function releaseHeld(run: boolean) {
  for (let i = rq.length - 1; i >= 0; i--) {
    if (!rq[i].held) continue;
    if (run) rq[i].held = false;
    else rq.splice(i, 1);
  }
  renderQueue();
  pump();
}

/** Renders whose workflow has no Studio settings (and so no seed setting of their own). */
const NO_SETTINGS: Family[] = ["talk", "select", "cutout", "vidcut", "upscale", "songedit", "foley", "person", "world", "swap"];

/** The modes that render with Qwen-Image-2.1, so a face or style taught with Fizgig can join them. */
export const QWEN_LORA_MODES: GenMode[] = ["image", "fast", "edit", "inpaint", "ref", "reffast"];

/** The taught face or style picked in the image settings, if this mode can use it and it's still there. */
function activeLora(gm: GenMode): TrainedLora | null {
  const file = settings().image.lora;
  if (!file || !QWEN_LORA_MODES.includes(gm)) return null;
  return trainedLoras().find((l) => l.file === file) ?? null;
}

/** Builds a render's workflow now, with the current settings and a fresh seed (it may run much later). */
function prepare(gm: GenMode, prompt: string, src: Source | null, opts: QueueOpts) {
  // Reference's Turbo is Lightning on Qwen-Image-2.1 (the same nodes as the turbo model's graph), which keeps the
  // uncensored model loaded; checkLora puts the turbo model back if the LoRA isn't installed.
  const wf = gm === "reffast" && workflows.ref ? workflows.ref : workflowOf(gm);
  if (!wf) throw new Error(`workflows\\${MODES[gm].file} wasn't found`);
  const m = modeOf(gm);
  const graph = structuredClone(wf);
  // A taught face or style rides along on Qwen-Image (not Z-Image-Turbo), with its trigger word in the prompt.
  const lora = activeLora(gm);
  const qwen = /qwen/i.test(String(graph["1"]?.inputs?.unet_name ?? ""));
  if (lora && qwen) {
    if (!new RegExp(`\\b${lora.trigger}\\b`, "i").test(prompt)) prompt = `${lora.trigger}, ${prompt}`;
    graph["40"] = { class_type: "LoraLoaderModelOnly", inputs: { model: ["1", 0], lora_name: lora.file, strength_model: 1 } };
    graph["6"].inputs.model = ["40", 0];
  }
  // A layout's reference is placed by Qwen-Image either way: MOSS-Image left its box empty (or the grey it was given).
  const moss = mossEdits(gm) && !opts.place;
  if (m.promptNode)
    graph[m.promptNode].inputs[m.promptKey ?? "text"] = gm === "ref" || gm === "reffast" ? (moss ? mossRefPrompt : refPrompt)(opts.kind ?? "auto", prompt) : prompt;
  // Renders without generation settings keep their seed to themselves, rather than taking the Image settings' one.
  const seed = opts.seed ?? (NO_SETTINGS.includes(m.family) ? Math.floor(Math.random() * 2 ** 32) : takeSeed(settingsKey(gm)));
  const p = m.family === "talk" ? talkPlan(src, opts.talk?.seconds ?? 0) : plan(gm, src, opts.override, opts.song, opts.video);
  if (m.family === "svi") shotPrompts(prompt, p.shots!).forEach((t, i) => (graph[SVI.shots[i].prompt].inputs.text = t));
  if (m.family === "song") graph[m.promptNode].inputs.lyrics = isInstrumental(opts.lyrics) ? INSTRUMENTAL : opts.lyrics!.trim();
  if (m.family === "songedit") {
    if (!opts.edit) throw new Error("nothing to edit");
    songEditGraph(graph, opts.edit);
  }
  apply(m, graph, p, seed);
  // A transparent picture is one subject on nothing, so a layout's boxes don't apply to it.
  const alpha = gm === "moss" && transparentOn() && !opts.refLabel;
  if (gm === "moss") mossGraph(graph, opts.layout && !alpha ? layoutPrompt(prompt, p.w, p.h, opts.refLabel) : prompt, alpha);
  if (gm === "world") {
    if (!opts.world) throw new Error("no world to render");
    worldGraph(graph, opts.world);
  }
  if (gm === "foley") {
    if (!opts.foley) throw new Error("no video to hear");
    foleyGraph(graph, opts.foley, seed);
  }
  if (gm === "swap") {
    if (!opts.swap) throw new Error("no character to swap in");
    swapGraph(graph, opts.swap, seed);
  }
  if (gm === "inpaint") {
    if (!opts.mask) throw new Error("nothing is painted");
    inpaintGraph(graph, opts.mask, opts);
  }
  if (gm === "angle" || gm === "outfit") reshootGraph(graph, gm, opts.outfit);
  if (gm === "edit") extraPictures(graph, opts.extra ?? []);
  if (gm === "restore") restoreGraph(graph, opts.restore ?? "photo");
  if (REDRAW_MP[gm]) redrawGraph(graph, REDRAW_MP[gm]!);
  if (gm === "manga") mangaGraph(graph);
  if (gm === "person") {
    if (!opts.mask || !opts.frames) throw new Error("nobody is picked");
    graph["20"].inputs.image = opts.mask.name;
    graph["44"].inputs.filename_prefix = `video/${opts.frames}/frame`;
    graph["46"].inputs.filename_prefix = `video/${opts.frames.replace(/\.frames$/, "")}-matte`;
  }
  if (moss) mossEditGraph(graph, lightningOn(gm) || !!opts.fast);
  else if (lightningOn(gm) || opts.fast) lightningGraph(graph);
  // An upscale's size: the shorter side becomes 1080 or 2160 (the longer one follows the shape).
  if (m.family === "upscale") {
    graph["3"].inputs["resize_type.shorter_size"] = opts.upscale ?? 2160;
    graph[gm === "upvideo" ? "15" : "12"].inputs.filename_prefix = `${gm === "upvideo" ? "video/" : ""}upscaled-${opts.upscale === 1080 ? "1080p" : "4k"}`;
  }
  // A cut-out of a selection: its mask in place of BiRefNet's.
  if (gm === "cutout" && opts.mask) {
    graph["2"] = { class_type: "LoadImageMask", inputs: { image: opts.mask.name, channel: "red" } };
    graph["3"].inputs.mask = ["2", 0];
    delete graph["6"];
    delete graph["7"];
    graph["5"].inputs.filename_prefix = "selection";
  }
  const nodes: Record<string, string> = {};
  for (const [id, n] of Object.entries<any>(graph))
    nodes[id] =
      ((m.family === "song" || m.family === "songedit") && SONG_STEPS[n.class_type]) ||
      (m.family === "model3d" && MODEL3D_STEPS[n.class_type]) ||
      (m.family === "talk" && TALK_STEPS[n.class_type]) ||
      ((m.family === "cutout" || m.family === "vidcut") && CUT_STEPS[n.class_type]) ||
      (m.family === "upscale" && UPSCALE_STEPS[n.class_type]) ||
      (m.family === "swap" && SWAP_LABELS[n.class_type]) ||
      n.class_type;
  if (m.family === "talk") talkLabels(nodes, p.shots!);
  if (m.family === "swap") swapLabels(graph, nodes);
  return { graph, nodes, seed, count: p.count, label: alpha ? "MOSS-Image · transparent" : moss ? "MOSS-Image Edit" : modeOf(gm).label, audio: opts.talk?.audio ?? opts.audio };
}

/** Adds a render to the queue (throws when its workflow is missing). */
export function enqueue(
  gm: GenMode,
  prompt: string,
  src: Source | null,
  opts: QueueOpts,
  how: { front?: boolean; note?: string; from?: string; title?: string; waiter?: QJob["waiter"] } = {},
) {
  const j: QJob = {
    id: jobIds++,
    gm,
    prompt: how.title ?? prompt, // what the queue shows: a talking video's line rather than how they move
    src,
    ...prepare(gm, prompt, src, opts),
    from: how.from ?? "Studio",
    note: how.note ?? "",
    state: "waiting",
    pct: 0,
    status: "Waiting",
    added: Date.now(),
    waiter: how.waiter,
  };
  if (how.front) {
    const at = rq.findIndex((x) => x.state === "waiting");
    rq.splice(at < 0 ? rq.length : at, 0, j);
  } else rq.push(j);
  renderQueue();
  pump();
  return j;
}

/** Starts the next waiting render when nothing is running. */
async function pump() {
  if (current || job || starting) return;
  const next = rq.find((x) => x.state === "waiting" && !x.held);
  if (!next) return;
  current = next;
  next.state = "running";
  stepNote = next.note;
  waiter = next.waiter ?? null;
  renderQueue();
  try {
    await submit(next);
  } catch (e) {
    const msg = errMsg(e);
    next.state = msg === "stopped" ? "stopped" : "failed";
    next.error = msg;
    current = null;
    stepNote = "";
    const w = waiter;
    waiter = null;
    if (w) w.reject(new Error(msg));
    else if (msg !== "stopped") deps.toast(`Couldn't start the render: ${msg}`, "warn");
    notify(next);
    renderQueue();
    pump();
  }
}

/** Stops a render: takes a waiting one out of the queue, or interrupts the running one. */
export function cancelJob(j: QJob) {
  if (j.state === "waiting") {
    j.state = "stopped";
    j.waiter?.reject(new Error("stopped"));
    renderQueue();
  } else if (j.state === "running") {
    // Still getting ready (freeing the GPU, uploading): it's dropped before it reaches ComfyUI.
    j.cancelled = true;
    if (job) http(`${COMFY}/interrupt`, { method: "POST" }).catch(() => {});
  }
}

/** Puts a failed or stopped render back in the queue, as it was (same settings and seed). */
export function retryJob(j: QJob) {
  rq.push({ ...j, id: jobIds++, state: "waiting", pct: 0, status: "Waiting", error: undefined, result: undefined, took: undefined, added: Date.now(), waiter: undefined, note: "", cancelled: undefined, promptId: undefined, started: undefined, held: undefined });
  renderQueue();
  pump();
}

/** A finished render while Prestige is in the background (or on another screen) says so. */
async function notify(j: QJob) {
  if (j.state !== "done" && j.state !== "failed") return;
  const away = !document.hasFocus() || document.hidden;
  const title = j.state === "done" ? `${j.result && j.result.length > 1 ? `${j.result.length} renders` : "Your render"} is ready` : "A render failed";
  const body = `${j.label}: ${j.prompt.slice(0, 120)}${j.state === "failed" && j.error ? ` (${j.error.slice(0, 100)})` : ""}`;
  if (away) {
    try {
      let ok = await isPermissionGranted();
      if (!ok) ok = (await requestPermission()) === "granted";
      if (ok) sendNotification({ title, body });
    } catch {
      /* not in the app */
    }
  } else if (!j.waiter && !studioShown()) deps.toast(`${title}: ${j.prompt.slice(0, 60)}`);
}

const ago = (ms: number) => {
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s} s`;
};

const queueListeners = new Set<() => void>();
/** Runs whenever the render queue changes (a render added, its progress, finished), for phones. */
export const onQueueChange = (f: () => void) => queueListeners.add(f);

/** The queue under the create bar, and the count on the Studio button. */
export function renderQueue() {
  queueListeners.forEach((f) => f());
  persistQueue();
  const live = rq.filter((j) => j.state === "waiting" || j.state === "running");
  const badge = document.getElementById("studio-count");
  if (badge) badge.textContent = live.length ? String(live.length) : "";
  // Chat renders that are waiting hear how many are ahead.
  rq.filter((j) => j.state === "waiting" && j.waiter).forEach((j) => {
    const ahead = rq.filter((x) => (x.state === "waiting" || x.state === "running") && rq.indexOf(x) < rq.indexOf(j)).length;
    j.waiter!.progress(0, `Waiting in the render queue (${ahead} ahead)…`);
  });
  const box = document.getElementById("rq");
  if (!box) return;
  box.hidden = rq.length < 2 && !rq.some((j) => j.state === "waiting");
  const waiting = rq.filter((j) => j.state === "waiting").length;
  $("#rq-sum").textContent = [current ? "1 rendering" : "", waiting ? `${waiting} waiting` : "", rq.length - live.length ? `${rq.length - live.length} finished` : ""]
    .filter(Boolean)
    .join(" · ");
  const list = $("#rq-list");
  list.innerHTML = "";
  const held = rq.filter((j) => j.held && j.state === "waiting").length;
  if (held) {
    const bar = document.createElement("div");
    bar.className = "rq-held";
    bar.innerHTML = `<span></span><button type="button" class="linkish">resume</button><button type="button" class="linkish">clear</button>`;
    $("span", bar).textContent = `${held} render${held === 1 ? " was" : "s were"} waiting before Prestige reloaded.`;
    const [go, drop] = bar.querySelectorAll("button");
    go.addEventListener("click", () => releaseHeld(true));
    drop.addEventListener("click", () => releaseHeld(false));
    list.appendChild(bar);
  }
  for (const j of rq) {
    const row = document.createElement("div");
    row.className = `rq-row ${j.state}`;
    const icon = { waiting: "⏳", running: "●", done: "✓", failed: "✗", stopped: "■" }[j.state];
    const status =
      j.state === "running"
        ? j.status
        : j.state === "waiting" && j.held
          ? "Paused · from before the reload"
          : j.state === "waiting"
          ? `Waiting · ${rq.filter((x) => (x.state === "waiting" || x.state === "running") && rq.indexOf(x) < rq.indexOf(j)).length} ahead`
          : j.state === "done"
            ? `Done in ${ago((j.took ?? 0) * 1000)}${j.result && j.result.length > 1 ? ` · ${j.result.length} files` : ""}`
            : j.state === "failed"
              ? `Failed: ${j.error ?? ""}`
              : "Stopped";
    row.innerHTML = `<span class="rq-ico"></span><span class="rq-t"><b></b><small></small></span><span class="rq-acts"></span>`;
    $(".rq-ico", row).textContent = icon;
    $("b", row).textContent = j.prompt;
    $("b", row).title = j.prompt;
    $("small", row).textContent = `${j.label} · ${j.from} · ${status}`;
    if (j.state === "running") row.style.setProperty("--v", String(j.pct));
    const act = (label: string, fn: () => void) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "linkish";
      b.textContent = label;
      b.addEventListener("click", fn);
      $(".rq-acts", row).appendChild(b);
    };
    if (j.state === "waiting") act("remove", () => cancelJob(j));
    if (j.state === "running") act("stop", () => cancelJob(j));
    if (j.state === "done" && j.result?.[0]) act("open", () => openRender(j.result![0].path));
    if (j.state === "failed" || j.state === "stopped") act("try again", () => retryJob(j));
    list.appendChild(row);
  }
}

/** Puts a voice recording in ComfyUI's input folder (named from its content, so a retry reuses it). */
async function uploadAudio(audio: Blob): Promise<string> {
  const bytes = new Uint8Array(await audio.arrayBuffer());
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-1", bytes));
  const hex = Array.from(hash.slice(0, 6), (b) => b.toString(16).padStart(2, "0")).join("");
  const ext = audio.type.includes("mpeg") ? "mp3" : audio.type.includes("ogg") ? "ogg" : audio.type.includes("flac") ? "flac" : audio.type.includes("webm") ? "webm" : audio.type.includes("mp4") || audio.type.includes("m4a") ? "m4a" : "wav";
  return invoke<string>("comfy_upload_bytes", bytes, { headers: { "x-name": `prestige-voice-${hex}.${ext}` } });
}

/** Qwen-Image-2.1's int8 model as installed: the uncensored LoRA put between the model and everything that uses it,
 *  and the Turbo on its 8-step schedule. Without the int8 file, its GGUF in the GGUF loader (as before 0.57). */
async function qwenModels(graph: any) {
  const name = graph["1"]?.class_type === "UNETLoader" ? (graph["1"].inputs.unet_name as string) : "";
  if (!QWEN_GGUF[name]) return;
  const models = await diffusionModels();
  if (models.length && !models.includes(name)) {
    graph["1"] = { class_type: "UnetLoaderGGUF", inputs: { unet_name: QWEN_GGUF[name] } };
    return;
  }
  const r = await http(`${COMFY}/object_info/LoraLoaderModelOnly`).catch(() => null);
  const loras: string[] = (await r?.json().catch(() => null))?.LoraLoaderModelOnly?.input?.required?.lora_name?.[0] ?? [];
  if (loras.includes(QWEN_INT8.uncensored)) {
    for (const node of Object.values<any>(graph))
      for (const [k, v] of Object.entries<any>(node.inputs ?? {})) if (Array.isArray(v) && v[0] === "1" && v[1] === 0) node.inputs[k] = ["qlora", 0];
    graph.qlora = { class_type: "LoraLoaderModelOnly", inputs: { model: ["1", 0], lora_name: QWEN_INT8.uncensored, strength_model: 1 } };
  }
  const k = graph["6"];
  if (name === QWEN_INT8.turbo && k?.class_type === "KSampler") {
    const i = k.inputs;
    graph.qsampler = { class_type: "KSamplerSelect", inputs: { sampler_name: "euler" } };
    graph.qsigmas = { class_type: "ManualSigmas", inputs: { sigmas: TURBO_SIGMAS } };
    graph["6"] = {
      class_type: "SamplerCustom",
      inputs: { model: i.model, add_noise: true, noise_seed: i.seed, cfg: 1, positive: i.positive, negative: i.negative,
        sampler: ["qsampler", 0], sigmas: ["qsigmas", 0], latent_image: i.latent_image },
    };
  }
}

/** A song's ACE-Step model must be in ComfyUI's model folders; say which Workstation pack brings it if it isn't
 *  (the XL for High quality, the base model for stems). */
async function checkAceModel(graph: any) {
  const want = graph["1"]?.inputs?.unet_name as string | undefined;
  if (!want || !ACE_PACK[want]) return;
  const r = await http(`${COMFY}/object_info/UNETLoader`).catch(() => null);
  const names: string[] = (await r?.json().catch(() => null))?.UNETLoader?.input?.required?.unet_name?.[0] ?? [];
  if (names.length && !names.includes(want))
    throw new Error(`${want} isn't installed: add the Workstation's ${ACE_PACK[want]} pack (install.ps1)${want === ACE_MODELS.high ? ", or set Quality to Standard in the song settings" : ""}`);
}

/** Sends a prepared render to ComfyUI. Throws if it couldn't be queued; progress then arrives by websocket. */
async function submit(j: QJob) {
  const { gm, graph, nodes, seed, count, prompt, src } = j;
  const m = modeOf(gm);
  starting = true;
  renderCreate();
  setJob(0, "Freeing the GPU (unloading chat models)…");
  $("#job-what").textContent = j.prompt;
  $("#job").hidden = false;
  try {
    // ComfyUI needs the 12 GB card to itself.
    await deps.freeGpu();
    await invoke("comfy_listen", { clientId });
    if (src && m.imageNode) {
      setJob(1, `Uploading the ${"kind" in src && src.kind === "video" ? "video" : "image"} to ComfyUI…`);
      const id = (m.imageClass && classNode(graph, m.imageClass)) || m.imageNode;
      graph[id].inputs[m.imageKey ?? "image"] = "path" in src ? await invoke<string>("comfy_upload", { path: src.path }) : await uploadReference(src);
    }
    if (j.audio) {
      const song = m.family === "songedit";
      setJob(1, song ? "Uploading the song to ComfyUI…" : "Uploading the voice to ComfyUI…");
      graph[song ? m.imageNode! : TALK.audio].inputs.audio = await uploadAudio(j.audio);
    }
    if (m.family === "song" || m.family === "songedit") await checkAceModel(graph);
    // Uncensored models for what Prestige makes; a photo brought in from outside keeps the standard ones.
    const made = madeHere(src);
    if (m.family === "wan" || m.family === "svi") await applyWanModels(graph, [SVI.high, SVI.low], settings()[m.family === "svi" ? "long" : "animate"], m.family === "svi" ? SVI.fp16 : undefined, made);
    if (loraNode(graph, "30") || loraNode(graph, "35")) await checkLora(graph, gm);
    await qwenModels(graph);
    if (graph.medit) await checkMossEdit(graph);
    if (SAGE_FAMILIES.includes(m.family) && settings().video.sage !== "off" && (await hasNode("WorkstationSageAttention"))) sageGraph(graph);
    if (graph["34"]?.class_type === "WorkstationRGBAVAELoader") await checkAlpha(graph);
    if (gm === "moss" && !(await comfyKnows("CLIPLoader", "type", "moss_image"))) throw new Error("MOSS-Image needs ComfyUI 0.42 or newer: update ComfyUI in Comfy Desktop");
    if (gm === "person" && !(await hasNode("MatAnyone2Run"))) throw new Error("ComfyUI doesn't have MatAnyone2: add the Video matting pack, then restart the services");
    if (gm === "swap") await checkSwap(graph);
    if (gm === "world" && !(await hasNode("HyNomasGenerateWorld"))) throw new Error("ComfyUI doesn't have the Hy-Nomas nodes: add the Explore a world pack, then restart the services");
    if (REDRAW_MP[gm] && !(await hasNode("AUSBOSS_NODES_TiledUpscale"))) throw new Error("Redraw needs the ComfyUI-AusBoss nodes: get the Reshoot pack again in Packs, then restart the services");
    if (gm === "manga" && !(await hasNode("MangaFinish"))) throw new Error("ComfyUI doesn't have the Manga nodes yet: restart Prestige's services to copy them in");
    if (j.cancelled) throw new Error("stopped");
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
    job = { id: body.prompt_id, mode: gm, started: Date.now(), prompt, nodes, outputs: [], seed, count };
    Object.assign(j, { promptId: job.id, started: job.started });
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
  label = stepNote + label;
  ($("#job .progress") as HTMLElement).style.setProperty("--v", String(pct));
  $("#job-label").textContent = label;
  waiter?.progress(pct, label);
  if (current) {
    current.pct = pct;
    current.status = label;
    renderQueue();
  }
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
      // The files a save node wrote, so the finished render can be found by name. A LoadVideo reports the video it
      // read (type "input"), which can have the same name as the gallery video it came from.
      for (const list of Object.values<any>(d.output ?? {}))
        if (Array.isArray(list)) for (const f of list) if (f?.filename && f.type !== "temp" && f.type !== "input") job.outputs.push(f.filename);
      break;
    case "execution_success":
      finish(true);
      break;
    case "execution_interrupted":
      finish(false, "stopped");
      break;
    case "execution_error": {
      // PyTorch's out-of-memory message runs to a dozen lines of allocator stats; the first line says enough.
      const raw = String(d.exception_message ?? "").trim();
      const msg = /out of memory|OutOfMemory/i.test(raw)
        ? "the GPU ran out of memory. Close other programs using it, or try a smaller size."
        : raw.split("\n")[0] || "ComfyUI reported an error";
      if (!waiter) deps.toast(`The render failed: ${msg}`, "warn");
      finish(false, msg);
      break;
    }
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
  const q = current;
  current = null;
  stepNote = "";
  if (ok && added.length) {
    if (q && !madeHere(q.src)) markOutside(added);
    fresh = new Set(added.map((a) => a.name));
    render();
    if (q) Object.assign(q, { state: "done", result: added, took });
    if (w) w.resolve(added);
    else if (studioShown()) deps.toast(`Done in ${took} s (seed ${done.seed}): ${added[0].name}${added.length > 1 ? ` and ${added.length - 1} more` : ""}`);
  } else {
    const msg = why || "ComfyUI finished, but no new file appeared in its output folder";
    if (q) Object.assign(q, { state: why === "stopped" ? "stopped" : "failed", error: msg, took });
    w?.reject(new Error(msg));
  }
  if (q) notify(q);
  renderQueue();
  // The button goes back from "Add to queue" when nothing else is waiting.
  renderCreate();
  pump();
}

/** A render by path (looking again when it's new). */
export async function findItem(path: string) {
  let a = items.find((x) => x.path === path);
  if (!a) {
    await refresh();
    a = items.find((x) => x.path === path);
  }
  if (!a) throw new Error("That render isn't in ComfyUI's output folder any more.");
  return a;
}

