// Reference images: a picture of a character or an item that Studio and chat put into a new scene with
// Qwen-Image-2.1 (and then animate with LTX for a video). A picked, pasted or dropped image is read here,
// scaled down to at most 2048 px on its long side and kept as a JPEG; studio.ts uploads it to ComfyUI.
import { invoke } from "@tauri-apps/api/core";

/** What the reference shows, which picks the wording Qwen-Image gets. "auto" lets the model work it out. */
export type RefKind = "auto" | "character" | "item";

export interface Reference {
  blob: Blob; // JPEG
  url: string; // object URL for the thumbnail
  name: string; // file name in ComfyUI's input folder, from the content's hash
  width: number;
  height: number;
}

export const CONSENT = "Only use photos of real people with their permission.";

const MAX_SIDE = 2048;

/** Reads an image file (or any image blob) into a Reference. Throws if it isn't a picture the webview can read. */
export async function loadReference(src: Blob): Promise<Reference> {
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(src);
  } catch {
    throw new Error("That file isn't an image Prestige can read (try a PNG, JPEG or WebP)");
  }
  const k = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  const width = Math.round(bmp.width * k);
  const height = Math.round(bmp.height * k);
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  const g = c.getContext("2d")!;
  // Transparent areas (cut-out product shots) become white rather than black.
  g.fillStyle = "#fff";
  g.fillRect(0, 0, width, height);
  g.drawImage(bmp, 0, 0, width, height);
  bmp.close();
  const blob = await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("Couldn't read the image"))), "image/jpeg", 0.95));
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-1", await blob.arrayBuffer()));
  const hex = Array.from(hash.slice(0, 6), (b) => b.toString(16).padStart(2, "0")).join("");
  return { blob, url: URL.createObjectURL(blob), name: `prestige-ref-${hex}.jpg`, width, height };
}

/** A Reference from a base64 JPEG (chat attachments and webcam frames). */
export function referenceFromBase64(b64: string) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return loadReference(new Blob([bytes], { type: "image/jpeg" }));
}

/** The base64 JPEG of an image file, scaled down like a reference (for chat attachments). */
export async function imageToBase64(src: Blob): Promise<string> {
  const r = await loadReference(src);
  URL.revokeObjectURL(r.url);
  const bytes = new Uint8Array(await r.blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** The first image file in a paste or drop, if there is one. */
export function imageIn(data: DataTransfer | null): File | null {
  for (const f of Array.from(data?.files ?? [])) if (f.type.startsWith("image/")) return f;
  for (const it of Array.from(data?.items ?? [])) {
    if (it.kind === "file" && it.type.startsWith("image/")) {
      const f = it.getAsFile();
      if (f) return f;
    }
  }
  return null;
}

/** True while something with files is dragged over the window (to highlight drop targets). */
export const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");

/** Sends the reference to ComfyUI's input folder and returns the name for its LoadImage node. */
export async function uploadReference(r: Reference): Promise<string> {
  const body = new Uint8Array(await r.blob.arrayBuffer());
  return invoke<string>("comfy_upload_bytes", body, { headers: { "x-name": r.name } });
}

/** The prompt Qwen-Image gets: keep the subject of image 1 the same and put it in the scene described. */
export function refPrompt(kind: RefKind, scene: string) {
  const keep =
    kind === "character"
      ? "Keep the character from image 1 exactly the same: same face, hair, eyes, body and clothes."
      : kind === "item"
        ? "Keep the object from image 1 exactly the same: same shape, colours, materials, markings and details."
        : // Naming people and objects together here made Qwen-Image put a person into an item, so Auto stays neutral.
          "Keep the subject of image 1 exactly as it looks, with all of its details.";
  return `${keep} New scene: ${scene}`;
}

/** The scene part of a prompt written by refPrompt (what to show and reuse), or the prompt as it is. */
export const sceneOf = (prompt: string) =>
  prompt
    .replace(/^Keep the (?:character from|object from|subject of) image 1[\s\S]*?New scene: /, "")
    // A Paint to change prompt (studio.ts inpaintPrompt).
    .replace(/^Fill the flat gray area with: ([\s\S]*?)\. It should blend naturally[\s\S]*$/, "$1");

export const REF_KINDS: [RefKind, string][] = [
  ["auto", "Auto"],
  ["character", "Character"],
  ["item", "Item"],
];

// ---------- how a reference is used, shared by Studio and chat ----------
/** For a video: put the reference in a new first frame first ("scene"), or animate the picture itself ("itself"). */
export type RefFrame = "scene" | "itself";
export interface RefPrefs {
  kind: RefKind;
  frame: RefFrame;
}

const stored = (k: string, ok: string[], def: string) => {
  try {
    const v = localStorage.getItem(k);
    return v && ok.includes(v) ? v : def;
  } catch {
    return def;
  }
};
let prefs: RefPrefs = {
  kind: stored("studio.refKind", ["auto", "character", "item"], "auto") as RefKind,
  frame: stored("studio.refFrame", ["scene", "itself"], "scene") as RefFrame,
};
const listeners = new Set<() => void>();

export const refPrefs = () => prefs;

export function setRefPrefs(patch: Partial<RefPrefs>) {
  prefs = { ...prefs, ...patch };
  try {
    localStorage.setItem("studio.refKind", prefs.kind);
    localStorage.setItem("studio.refFrame", prefs.frame);
  } catch {}
  listeners.forEach((f) => f());
}

/** Runs whenever a choice changes, so Studio and chat show the same picks. */
export const onRefPrefsChange = (f: () => void) => listeners.add(f);

const escHtml = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
const seg = (attr: string, cur: string, opts: [string, string][], title: string) =>
  `<span class="seg" role="group" aria-label="${title}">` +
  opts.map(([v, l]) => `<button type="button" data-${attr}="${v}" class="${v === cur ? "on" : ""}" aria-pressed="${v === cur}">${escHtml(l)}</button>`).join("") +
  `</span>`;

/** The choice buttons for a reference: what it shows (when Qwen-Image makes a picture with it) and, for a video, the first frame. */
export function refChoicesHtml(video: boolean) {
  const kinds = !video || prefs.frame === "scene" ? seg("kind", prefs.kind, REF_KINDS, "What the reference shows") : "";
  const frames = video ? seg("frame", prefs.frame, [["scene", "New scene first"], ["itself", "Animate this picture"]], "First frame") : "";
  return kinds + frames;
}

/** Makes the buttons from refChoicesHtml inside `el` work (once per element; it can be re-rendered freely). */
export function bindRefChoices(el: HTMLElement) {
  el.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-kind], [data-frame]");
    if (!b || !el.contains(b)) return;
    if (b.dataset.kind) setRefPrefs({ kind: b.dataset.kind as RefKind });
    if (b.dataset.frame) setRefPrefs({ frame: b.dataset.frame as RefFrame });
  });
}
