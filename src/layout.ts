// Layout for MOSS-Image: drag boxes on a blank canvas the picture's shape to say where text and things go, each with
// what it is (and, for text, the words). The boxes and the prompt become MOSS-Image's JSON layout prompt (the format
// ComfyUI's MOSS-Image Layout Prompt node builds): the prompt as the summary, and each box in pixels from the
// picture's centre, [y0, x0, y1, x1]. Kept between renders (and restarts) until cleared.

const $ = <T extends HTMLElement = HTMLElement>(s: string, r: ParentNode = document) => r.querySelector(s) as T;

export type BoxKind = "text" | "object" | "character";
export interface LayoutBox {
  kind: BoxKind;
  caption: string; // what it is: "a red neon sign on the roof"
  text: string; // a text box's words
  x0: number; // 0–1 of the picture's width and height
  y0: number;
  x1: number;
  y1: number;
}

const KEY = "studio.layout";
const KINDS: [BoxKind, string][] = [
  ["text", "Text"],
  ["object", "Thing"],
  ["character", "Person or character"],
];
/** The smallest box a drag makes, as a share of the canvas (smaller drags are clicks). */
const MIN = 0.03;

let boxes: LayoutBox[] = load();
let picked = -1;
const listeners = new Set<() => void>();

function load(): LayoutBox[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((b) => b && typeof b.x0 === "number" && KINDS.some(([k]) => k === b.kind)) : [];
  } catch {
    return [];
  }
}

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(boxes));
  } catch {}
  listeners.forEach((f) => f());
}

export const layoutBoxes = () => boxes;
export const onLayoutChange = (f: () => void) => listeners.add(f);
export function clearLayout() {
  boxes = [];
  save();
}

/** The prompt MOSS-Image is given: the plain prompt with no boxes, else the layout JSON for a w×h picture. Boxes
 *  without a caption or words are left out. */
export function layoutPrompt(prompt: string, w: number, h: number): string {
  const items = boxes
    .filter((b) => b.caption.trim() || (b.kind === "text" && b.text.trim()))
    .map((b) => {
      const it: Record<string, unknown> = { label: b.kind, caption: b.caption.trim() || `the words "${b.text.trim()}"` };
      if (b.kind === "text") it.text = b.text.trim();
      it.bbox = [Math.floor(b.y0 * h) - (h >> 1), Math.floor(b.x0 * w) - (w >> 1), Math.ceil(b.y1 * h) - (h >> 1), Math.ceil(b.x1 * w) - (w >> 1)];
      return it;
    });
  if (!items.length) return prompt;
  return JSON.stringify({ summary: { caption: prompt.trim() }, items, bbox_coord_space: "abs_centralized", bbox_format: "yxyx" });
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** The layout editor for a picture of w×h. Resolves when it's closed. */
export function openLayout(w: number, h: number): Promise<void> {
  const dlg = $("#layout") as HTMLDialogElement;
  const stage = $("#lo-stage");
  stage.style.aspectRatio = `${w} / ${h}`;
  stage.style.width = `min(100%, ${(52 * w) / h}vh)`; // a tall picture stays within the stage's 52vh
  $("#lo-size").textContent = `${w} × ${h}`;
  picked = boxes.length ? 0 : -1;

  const draw = () => {
    stage.innerHTML = boxes
      .map(
        (b, i) =>
          `<div class="lo-box ${b.kind}${i === picked ? " on" : ""}" data-i="${i}" style="left:${b.x0 * 100}%;top:${b.y0 * 100}%;width:${(b.x1 - b.x0) * 100}%;height:${(b.y1 - b.y0) * 100}%"><span>${i + 1} · ${esc(b.kind === "text" && b.text ? `“${b.text}”` : b.caption || KINDS.find(([k]) => k === b.kind)![1])}</span></div>`,
      )
      .join("");
    const b = boxes[picked];
    const form = $("#lo-form");
    form.hidden = !b;
    $("#lo-hint").hidden = !!boxes.length;
    if (!b) return;
    ($("#lo-kind") as HTMLSelectElement).value = b.kind;
    ($("#lo-caption") as HTMLInputElement).value = b.caption;
    ($("#lo-text") as HTMLInputElement).value = b.text;
    $("#lo-text-row").hidden = b.kind !== "text";
    $("#lo-which").textContent = `Box ${picked + 1}`;
  };

  ($("#lo-kind") as HTMLSelectElement).innerHTML = KINDS.map(([k, l]) => `<option value="${k}">${l}</option>`).join("");
  ($("#lo-kind") as HTMLSelectElement).onchange = (e) => {
    boxes[picked].kind = (e.target as HTMLSelectElement).value as BoxKind;
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
      const label = stage.querySelector(`[data-i="${picked}"] span`);
      const b = boxes[picked];
      if (label) label.textContent = `${picked + 1} · ${b.kind === "text" && b.text ? `“${b.text}”` : b.caption || KINDS.find(([x]) => x === b.kind)![1]}`;
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
      const b: LayoutBox = { kind: boxes.some((x) => x.kind === "text") ? "object" : "text", caption: "", text: "", x0: p0.x, y0: p0.y, x1: p0.x, y1: p0.y };
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
