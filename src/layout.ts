// Layout: drag boxes on the picture to say where text and things go, each with what it is (and, for text, the words).
// - MOSS-Image (text to image): the boxes and the prompt become its JSON layout prompt (the format ComfyUI's MOSS-Image
//   Layout Prompt node builds): the prompt as the summary, and each box in pixels from the picture's centre, [y0, x0, y1, x1].
// - Edit: the boxes are drawn on the picture and only they are redrawn, in one masked Qwen-Image edit whose prompt
//   names each grey box by where it is (editLayoutPrompt). On the RTX 3060 four boxes took 47 s and followed the boxes
//   as well as four separate edits (183 s); boxes in colours named by colour left coloured fringes.
// - Reference: MOSS-Image lays out the scene with the reference's box described, then a masked Qwen-Image edit puts the
//   reference in place of what MOSS drew there (studio.ts layoutScene): about 3 min for a 1024² scene on the RTX 3060,
//   peaking at 8.8 GB. Qwen-Image alone, given the boxes as a guide picture, kept the likeness but not the places.
// A new picture's boxes ("scene", shared by MOSS-Image and Reference) and an edit's ("edit", cleared when the picture
// changes) are kept apart, between renders and restarts, until cleared.

const $ = <T extends HTMLElement = HTMLElement>(s: string, r: ParentNode = document) => r.querySelector(s) as T;

export type BoxKind = "text" | "object" | "character" | "ref";
export interface LayoutBox {
  kind: BoxKind; // "ref": where the reference image goes (Reference mode)
  caption: string; // what it is: "a red neon sign on the roof"
  text: string; // a text box's words
  x0: number; // 0–1 of the picture's width and height
  y0: number;
  x1: number;
  y1: number;
}

export type LayoutSet = "scene" | "edit";
const KEYS: Record<LayoutSet, string> = { scene: "studio.layout", edit: "studio.layout.edit" };
const KINDS: [BoxKind, string][] = [
  ["text", "Text"],
  ["object", "Thing"],
  ["character", "Person or character"],
  ["ref", "Your reference"],
];
/** The smallest box a drag makes, as a share of the canvas (smaller drags are clicks). */
const MIN = 0.03;

let set: LayoutSet = "scene";
let owner = ""; // the picture an edit's boxes were drawn on
let boxes: LayoutBox[] = load(set);
let picked = -1;
const listeners = new Set<() => void>();

function load(which: LayoutSet): LayoutBox[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEYS[which]) ?? "[]");
    if (which === "edit") owner = typeof raw?.owner === "string" ? raw.owner : "";
    const v = which === "edit" ? raw?.boxes : raw;
    return Array.isArray(v) ? v.filter((b) => b && typeof b.x0 === "number" && KINDS.some(([k]) => k === b.kind)) : [];
  } catch {
    return [];
  }
}

function save() {
  try {
    localStorage.setItem(KEYS[set], JSON.stringify(set === "edit" ? { owner, boxes } : boxes));
  } catch {}
  listeners.forEach((f) => f());
}

/** Picks the boxes in use: a new picture's, or an edit's of the picture at `picture` (another picture starts empty). */
export function useLayout(which: LayoutSet, picture = "") {
  if (which !== set) {
    set = which;
    boxes = load(which);
  }
  if (which === "edit" && picture !== owner) {
    owner = picture;
    boxes = [];
    save();
  }
}

export const layoutBoxes = () => boxes;
export const onLayoutChange = (f: () => void) => listeners.add(f);
export function clearLayout() {
  boxes = [];
  save();
}

/** The boxes that say something: a caption, a text box's words, or (with a reference) the reference's place. */
const filled = (ref: boolean) => boxes.filter((b) => b.caption.trim() || (b.kind === "text" && b.text.trim()) || (ref && b.kind === "ref"));

/** The reference's box, when one is marked. */
export const layoutRefBox = () => boxes.find((b) => b.kind === "ref");

/** What a box holds in words: `the words "MOON DINER" (a red neon sign)`, or its caption. */
export function boxWhat(b: LayoutBox, ref?: "character" | "object") {
  const c = b.caption.trim();
  if (b.kind === "text" && b.text.trim()) return `the words "${b.text.trim()}"${c ? ` (${c})` : ""}`;
  if (b.kind === "ref" && !c && ref) return ref === "character" ? "a person" : "an object";
  return c;
}

/** How far inside the reference's box MOSS-Image is asked to draw its stand-in, as a share of the box. */
const REF_INSET = 0.08;

/** The prompt MOSS-Image is given: the plain prompt with no boxes, else the layout JSON for a w×h picture. Boxes
 *  without a caption or words are left out. `ref`: what the reference shows, for its box (Reference mode). */
export function layoutPrompt(prompt: string, w: number, h: number, ref?: "character" | "object"): string {
  const items = filled(!!ref).map((b) => {
    const it: Record<string, unknown> = { label: b.kind === "ref" ? (ref ?? "object") : b.kind, caption: boxWhat(b, ref) };
    if (b.kind === "text") it.text = b.text.trim();
    // What MOSS draws for the reference is replaced through the reference's mask (layoutMask), so it's asked for a
    // little inside the box: drawn to the edge, it can poke out past the mask and be left behind.
    if (ref && b.kind === "ref") {
      const dx = (b.x1 - b.x0) * REF_INSET;
      const dy = (b.y1 - b.y0) * REF_INSET;
      b = { ...b, x0: b.x0 + dx, x1: b.x1 - dx, y0: b.y0 + dy, y1: b.y1 - dy };
    }
    it.bbox = [Math.floor(b.y0 * h) - (h >> 1), Math.floor(b.x0 * w) - (w >> 1), Math.ceil(b.y1 * h) - (h >> 1), Math.ceil(b.x1 * w) - (w >> 1)];
    return it;
  });
  if (!items.length) return prompt;
  return JSON.stringify({ summary: { caption: prompt.trim() }, items, bbox_coord_space: "abs_centralized", bbox_format: "yxyx" });
}

/** Where each box is, in words Qwen-Image follows: "at the top left", "in the centre". Boxes in the same place are
 *  told apart from left to right. */
function places(bs: LayoutBox[]): string[] {
  const third = (v: number) => (v < 1 / 3 ? 0 : v > 2 / 3 ? 2 : 1);
  const words = bs.map((b) => {
    const v = ["top", "middle", "bottom"][third((b.y0 + b.y1) / 2)];
    const h = ["left", "centre", "right"][third((b.x0 + b.x1) / 2)];
    return v === "middle" ? (h === "centre" ? "in the centre" : `on the ${h}`) : `at the ${v} ${h}`;
  });
  const ORD = ["first", "second", "third", "fourth", "fifth", "sixth"];
  return words.map((w, i) => {
    const same = bs.map((b, j) => ({ b, j })).filter(({ j }) => words[j] === w);
    if (same.length < 2) return w;
    const rank = same.sort((p, q) => p.b.x0 + p.b.x1 - (q.b.x0 + q.b.x1)).findIndex(({ j }) => j === i);
    return `${w} (the ${ORD[rank] ?? `${rank + 1}th`} of those from the left)`;
  });
}

/** An edit's prompt for its boxes: each grey box filled with what it holds, the rest kept. `prompt` (optional) applies
 *  to all of them. Null when no box says what goes in it. */
export function editLayoutPrompt(prompt: string): string | null {
  const bs = filled(false);
  if (!bs.length) return null;
  const at = places(bs);
  const fill = bs.length === 1 ? `Fill the flat gray area with: ${boxWhat(bs[0])}.` : `Fill each flat gray area: ${bs.map((b, i) => `the gray area ${at[i]}: ${boxWhat(b)}`).join("; ")}.`;
  const all = prompt.trim().replace(/[.\s]+$/, "");
  return `${fill}${all ? ` For all of them: ${all}.` : ""} ${bs.length === 1 ? "It" : "Each"} should blend naturally with the rest of the picture. Keep everything else exactly the same.`;
}

/** How far the reference's mask reaches past its box, to the sides and below, as a share of the picture. Held to the
 *  box, Qwen-Image cut the reference off at the box's edge; grown upwards as well, it smudged a sign above it. */
const REF_GROW = 0.03;

/** The boxes as a mask for a w×h picture (white inside, edges softened), a PNG for ComfyUI's LoadImageMask: every box
 *  that says something, or with `ref` the reference's box, a little larger, kept off the other boxes. */
export function layoutMask(w: number, h: number, ref?: LayoutBox): Promise<Blob> {
  const shape = document.createElement("canvas");
  shape.width = w;
  shape.height = h;
  const s = shape.getContext("2d")!;
  const rect = (x0: number, y0: number, x1: number, y1: number) => s.fillRect(x0 * w, y0 * h, (x1 - x0) * w, (y1 - y0) * h);
  s.fillStyle = "#fff";
  if (ref) {
    rect(Math.max(0, ref.x0 - REF_GROW), ref.y0, Math.min(1, ref.x1 + REF_GROW), Math.min(1, ref.y1 + REF_GROW));
    s.fillStyle = "#000";
    for (const b of filled(true)) if (b !== ref) rect(b.x0, b.y0, b.x1, b.y1);
  } else for (const b of filled(false)) rect(b.x0, b.y0, b.x1, b.y1);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d")!;
  g.fillStyle = "#000";
  g.fillRect(0, 0, w, h);
  g.filter = `blur(${ref ? 8 : 4}px)`;
  g.drawImage(shape, 0, 0);
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("Couldn't draw the layout's mask"))), "image/png"));
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export interface LayoutView {
  picture?: string; // the picture the boxes are drawn on (an edit)
  reference?: string; // the reference image, shown beside the canvas, and its box kind offered (Reference)
  intro?: string; // what the boxes do here
  hint?: string; // what happens with no boxes
}

/** The layout editor for a picture of w×h. Resolves when it's closed. */
export function openLayout(w: number, h: number, view: LayoutView = {}): Promise<void> {
  const dlg = $("#layout") as HTMLDialogElement;
  const stage = $("#lo-stage");
  stage.style.aspectRatio = `${w} / ${h}`;
  stage.style.width = `min(100%, ${(52 * w) / h}vh)`; // a tall picture stays within the stage's 52vh
  stage.style.backgroundImage = view.picture ? `url("${view.picture}")` : "";
  stage.classList.toggle("pic", !!view.picture);
  $("#lo-size").textContent = `${w} × ${h}`;
  $("#lo-intro").textContent = view.intro ?? "Drag on the picture to add a box where text, a thing or a person goes; drag a box to move it. Your prompt describes the whole picture.";
  $("#lo-hint").textContent = view.hint ?? "No boxes yet: MOSS-Image places everything itself.";
  const refImg = $<HTMLImageElement>("#lo-ref");
  refImg.hidden = !view.reference;
  if (view.reference) refImg.src = view.reference;
  const label = (b: LayoutBox) => (b.kind === "text" && b.text ? `“${b.text}”` : b.caption || KINDS.find(([k]) => k === b.kind)![1]);
  picked = boxes.length ? 0 : -1;

  const draw = () => {
    stage.innerHTML = boxes
      .map(
        (b, i) =>
          `<div class="lo-box ${b.kind}${i === picked ? " on" : ""}" data-i="${i}" style="left:${b.x0 * 100}%;top:${b.y0 * 100}%;width:${(b.x1 - b.x0) * 100}%;height:${(b.y1 - b.y0) * 100}%"><span>${i + 1} · ${esc(label(b))}</span></div>`,
      )
      .join("");
    const b = boxes[picked];
    const form = $("#lo-form");
    form.hidden = !b;
    $("#lo-hint").hidden = !!boxes.length;
    if (!b) return;
    // "Your reference" only with a reference (or on a box already marked so).
    const kind = $<HTMLSelectElement>("#lo-kind");
    kind.innerHTML = KINDS.filter(([k]) => k !== "ref" || view.reference || b.kind === "ref")
      .map(([k, l]) => `<option value="${k}">${l}</option>`)
      .join("");
    kind.value = b.kind;
    ($("#lo-caption") as HTMLInputElement).value = b.caption;
    ($("#lo-caption") as HTMLInputElement).placeholder = b.kind === "ref" ? "optional, e.g. sitting on the bench" : "e.g. a red neon sign on the roof";
    ($("#lo-text") as HTMLInputElement).value = b.text;
    $("#lo-text-row").hidden = b.kind !== "text";
    $("#lo-which").textContent = `Box ${picked + 1}`;
  };

  ($("#lo-kind") as HTMLSelectElement).onchange = (e) => {
    const k = (e.target as HTMLSelectElement).value as BoxKind;
    // One box is the reference's.
    if (k === "ref") boxes.forEach((x) => x.kind === "ref" && (x.kind = "character"));
    boxes[picked].kind = k;
    save();
    draw();
  };
  for (const [id, k] of [
    ["#lo-caption", "caption"],
    ["#lo-text", "text"],
  ] as const)
    ($(id) as HTMLInputElement).oninput = (e) => {
      boxes[picked][k] = (e.target as HTMLInputElement).value;
      save();
      const span = stage.querySelector(`[data-i="${picked}"] span`);
      if (span) span.textContent = `${picked + 1} · ${label(boxes[picked])}`;
    };
  $("#lo-delete").onclick = () => {
    boxes.splice(picked, 1);
    picked = Math.min(picked, boxes.length - 1);
    save();
    draw();
  };
  $("#lo-clear").onclick = () => {
    boxes = [];
    picked = -1;
    save();
    draw();
  };

  // Drag on the canvas to draw a box; click a box to pick it, or drag it to move it.
  stage.onpointerdown = (e) => {
    const r = stage.getBoundingClientRect();
    const at = (ev: PointerEvent) => ({ x: Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height)) });
    const p0 = at(e);
    const hit = (e.target as HTMLElement).closest<HTMLElement>(".lo-box");
    stage.setPointerCapture(e.pointerId);
    let moved = false;
    if (hit) {
      picked = Number(hit.dataset.i);
      const b = boxes[picked];
      const start = { ...b };
      stage.onpointermove = (ev) => {
        const p = at(ev);
        const dx = Math.min(Math.max(p.x - p0.x, -start.x0), 1 - start.x1);
        const dy = Math.min(Math.max(p.y - p0.y, -start.y0), 1 - start.y1);
        Object.assign(b, { x0: start.x0 + dx, x1: start.x1 + dx, y0: start.y0 + dy, y1: start.y1 + dy });
        moved = true;
        draw();
      };
    } else {
      // The first box with a reference is the reference's; on an edit, a thing; else text first.
      const kind: BoxKind = view.reference && !layoutRefBox() ? "ref" : view.picture || boxes.some((x) => x.kind === "text") ? "object" : "text";
      const b: LayoutBox = { kind, caption: "", text: "", x0: p0.x, y0: p0.y, x1: p0.x, y1: p0.y };
      let added = false;
      stage.onpointermove = (ev) => {
        const p = at(ev);
        Object.assign(b, { x0: Math.min(p0.x, p.x), x1: Math.max(p0.x, p.x), y0: Math.min(p0.y, p.y), y1: Math.max(p0.y, p.y) });
        if (!added && b.x1 - b.x0 > MIN && b.y1 - b.y0 > MIN) {
          boxes.push(b);
          picked = boxes.length - 1;
          added = true;
        }
        moved = true;
        if (added) draw();
      };
    }
    stage.onpointerup = () => {
      stage.onpointermove = stage.onpointerup = null;
      if (moved) save();
      draw();
      if (!hit && picked >= 0) ($("#lo-caption") as HTMLInputElement).focus();
    };
  };

  draw();
  dlg.showModal();
  return new Promise((res) => dlg.addEventListener("close", () => res(), { once: true }));
}
