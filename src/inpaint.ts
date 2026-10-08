// Paint to change: an overlay over a render where you paint the part to change and say what should be there. Only that
// area is regenerated (Qwen-Image-2.1 with a noise mask, then pasted back over the original through a soft-edged mask,
// so everything you didn't paint stays exactly as it was). With nothing painted it's an instruction edit of the whole
// picture ("make it night"). studio.ts runs the render; this file is the painting.
// Click to select: the Select tool asks SAM 3.1 for the object under a click (or for things by name), and paints its
// outline for you. The selection can then be changed, removed, or cut out as a transparent PNG.

const $ = <T extends HTMLElement = HTMLElement>(s: string, r: ParentNode = document) => r.querySelector(s) as T;

export interface InpaintRequest {
  prompt: string;
  /** White where to change, black elsewhere, at the picture's own size; null for a whole-picture edit. */
  mask: Blob | null;
  width: number;
  height: number;
}

/** Where to look, in the picture's own pixels: clicks on it (and on parts to leave out), or what it is called. */
export interface SelectQuery {
  points: { x: number; y: number }[];
  negative: { x: number; y: number }[];
  text?: string;
}

export interface InpaintOptions {
  /** SAM 3.1: the mask (white = selected) for a query. Without it, there's no Select tool. */
  select?: (q: SelectQuery) => Promise<Blob>;
  /** Cut out: the painted area as a transparent PNG (a crisp mask, white = keep). */
  cutout?: (mask: Blob, width: number, height: number) => void;
  /** Open with the Select tool picked. */
  selecting?: boolean;
}

/** What Qwen-Image is asked when the selection is to be removed. */
const REMOVE_PROMPT = "nothing, just the background that was behind it, continuing the surroundings naturally";

let paint: HTMLCanvasElement; // the strokes on transparent, at the picture's size
let ctx: CanvasRenderingContext2D;
let img: HTMLImageElement;
let undo: ImageData[] = [];
let tool: "brush" | "erase" | "select" = "brush";
let painted = false;
let submit: ((r: InpaintRequest) => void) | null = null;
let opts: InpaintOptions = {};
let drawing = false;
let last: { x: number; y: number } | null = null;
// The object being selected: its clicks (or name), and the paint from before it, which each new answer is drawn over.
let sel: (SelectQuery & { base: ImageData }) | null = null;
let selGen = 0; // only the newest answer is drawn
let selecting = false;

const brush = () => Number(($("#ip-size") as HTMLInputElement).value);

/** Brush size in picture pixels: the slider is in screen pixels, so it feels the same at any zoom. */
function brushPx() {
  const scale = paint.width / paint.getBoundingClientRect().width || 1;
  return Math.max(2, brush() * scale);
}

function at(e: PointerEvent) {
  const r = paint.getBoundingClientRect();
  return { x: ((e.clientX - r.left) / r.width) * paint.width, y: ((e.clientY - r.top) / r.height) * paint.height };
}

function stroke(from: { x: number; y: number }, to: { x: number; y: number }) {
  ctx.globalCompositeOperation = tool === "erase" ? "destination-out" : "source-over";
  ctx.strokeStyle = "#e0242f"; // shown in red; the mask only uses where it's painted
  ctx.lineWidth = brushPx();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();
}

/** Whether any of the picture is painted (checked on a small copy, so it's quick). */
function hasPaint() {
  const s = document.createElement("canvas");
  s.width = 64;
  s.height = Math.max(1, Math.round((64 * paint.height) / paint.width));
  const c = s.getContext("2d")!;
  c.drawImage(paint, 0, 0, s.width, s.height);
  const d = c.getImageData(0, 0, s.width, s.height).data;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 8) return true;
  return false;
}

function hint() {
  if (selecting) return "Selecting…";
  if (tool === "select")
    return painted
      ? "Click more of it to add, Shift-click a part to leave out, Ctrl-click to select something else too. Then say what should be there, remove it, or cut it out."
      : "Click on something to select it, or type what to select (e.g. the car, all the people).";
  return painted
    ? "Only the painted area changes; the rest stays exactly as it is. Say what should be there."
    : "Paint over what to change, or just type an instruction to edit the whole picture (e.g. make it night).";
}

function update() {
  painted = hasPaint();
  const prompt = ($("#ip-prompt") as HTMLInputElement).value.trim();
  const go = $("#ip-go") as HTMLButtonElement;
  go.textContent = painted ? "Change the painted area" : "Edit the whole picture";
  go.disabled = !prompt || selecting;
  $("#ip-hint").textContent = hint();
  ($("#ip-undo") as HTMLButtonElement).disabled = !undo.length;
  ($("#ip-remove") as HTMLButtonElement).disabled = !painted || selecting;
  ($("#ip-cut") as HTMLButtonElement).disabled = !painted || selecting;
  for (const t of ["brush", "erase", "select"] as const) $(`#ip-${t}`).classList.toggle("on", tool === t);
  $("#inpaint").classList.toggle("selecting", tool === "select");
}

/** The mask Qwen-Image gets: the strokes in white on black, with softened edges so the new part blends in. A cut-out's
 *  is crisp (`soft` false): just the painted pixels. */
async function maskBlob(soft = true): Promise<Blob> {
  const w = paint.width;
  const h = paint.height;
  const white = document.createElement("canvas");
  white.width = w;
  white.height = h;
  const wc = white.getContext("2d")!;
  wc.drawImage(paint, 0, 0);
  wc.globalCompositeOperation = "source-in";
  wc.fillStyle = "#fff";
  wc.fillRect(0, 0, w, h);
  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  const oc = out.getContext("2d")!;
  oc.fillStyle = "#000";
  oc.fillRect(0, 0, w, h);
  if (soft) {
    // Grow the strokes a little (a second, wider pass), then feather by about 1% of the picture.
    const feather = Math.max(3, Math.round(Math.max(w, h) / 100));
    oc.filter = `blur(${feather}px)`;
    oc.drawImage(white, 0, 0);
    oc.drawImage(white, 0, 0);
    oc.filter = "none";
  }
  oc.drawImage(white, 0, 0);
  return new Promise((res, rej) => out.toBlob((b) => (b ? res(b) : rej(new Error("Couldn't make the mask"))), "image/png"));
}

/** Draws SAM's mask (white = selected) as paint, over what was painted before this selection. Returns how much of the
 *  picture it covers (0..1). */
async function paintMask(mask: Blob, base: ImageData) {
  const bmp = await createImageBitmap(mask);
  const c = document.createElement("canvas");
  c.width = paint.width;
  c.height = paint.height;
  const mc = c.getContext("2d")!;
  mc.drawImage(bmp, 0, 0, c.width, c.height);
  const d = mc.getImageData(0, 0, c.width, c.height);
  let on = 0;
  for (let i = 0; i < d.data.length; i += 4) {
    const a = d.data[i]; // grey: red, green and blue are all the mask
    d.data[i] = 0xe0;
    d.data[i + 1] = 0x24;
    d.data[i + 2] = 0x2f;
    d.data[i + 3] = a;
    if (a > 127) on++;
  }
  mc.putImageData(d, 0, 0);
  ctx.putImageData(base, 0, 0);
  ctx.globalCompositeOperation = "source-over";
  ctx.drawImage(c, 0, 0);
  return on / (c.width * c.height);
}

/** Asks SAM 3.1 for the current selection and paints it. */
async function runSelect() {
  if (!opts.select || !sel) return;
  const my = ++selGen;
  const q = { points: [...sel.points], negative: [...sel.negative], text: sel.text };
  const base = sel.base;
  selecting = true;
  update();
  try {
    const mask = await opts.select(q);
    if (my !== selGen || !submit) return;
    const cover = await paintMask(mask, base);
    selecting = false;
    update();
    if (cover === 0) $("#ip-hint").textContent = q.text ? `Nothing called "${q.text}" was found. Try another word, or click on it.` : "Nothing was found there. Click on the middle of something.";
  } catch (e) {
    if (my !== selGen) return;
    selecting = false;
    update();
    $("#ip-hint").textContent = `Couldn't select: ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    if (my === selGen) selecting = false;
  }
}

/** Starts a new selection on top of what's painted now (one undo step for the whole selection). */
function newSelection(text?: string): NonNullable<typeof sel> {
  const base = ctx.getImageData(0, 0, paint.width, paint.height);
  undo.push(base);
  if (undo.length > 25) undo.shift();
  sel = { points: [], negative: [], text, base };
  return sel;
}

function setTool(t: typeof tool) {
  tool = t;
  sel = null; // a new click starts a new selection
  update();
}

function close() {
  $("#inpaint").hidden = true;
  submit = null;
  sel = null;
  selGen++;
  selecting = false;
  document.removeEventListener("keydown", onKey);
}

function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") {
    e.preventDefault();
    close();
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
    e.preventDefault();
    $("#ip-undo").click();
  } else if (e.key === "[" || e.key === "]") {
    if ((e.target as HTMLElement).closest("input[type=text]")) return;
    const s = $("#ip-size") as HTMLInputElement;
    s.value = String(Number(s.value) + (e.key === "]" ? 6 : -6));
  }
}

/** Opens the painting overlay on a picture. `onSubmit` gets the prompt and mask when the user clicks the button. */
export function openInpaint(url: string, name: string, onSubmit: (r: InpaintRequest) => void, o: InpaintOptions = {}) {
  submit = onSubmit;
  opts = o;
  undo = [];
  sel = null;
  selecting = false;
  tool = o.selecting && o.select ? "select" : "brush";
  $("#ip-select").hidden = $("#ip-find-wrap").hidden = !o.select;
  $("#ip-cut").hidden = !o.cutout;
  $("#ip-remove").hidden = !o.select;
  ($("#ip-prompt") as HTMLInputElement).value = "";
  ($("#ip-find") as HTMLInputElement).value = "";
  $("#ip-name").textContent = name;
  $("#ip-title").textContent = tool === "select" ? "Select to change" : "Paint to change";
  $("#inpaint").hidden = false;
  document.addEventListener("keydown", onKey);
  img.onload = () => {
    paint.width = img.naturalWidth;
    paint.height = img.naturalHeight;
    ctx.clearRect(0, 0, paint.width, paint.height);
    update();
  };
  img.src = url;
  (tool === "select" ? $("#ip-find") : $("#ip-prompt")).focus();
}

export function initInpaint() {
  paint = $("#ip-paint") as HTMLCanvasElement;
  ctx = paint.getContext("2d")!;
  img = $("#ip-img") as HTMLImageElement;
  paint.addEventListener("contextmenu", (e) => tool === "select" && e.preventDefault());
  paint.addEventListener("pointerdown", (e) => {
    if (tool === "select") {
      // A click selects what's under it: more clicks add to it, Shift (or right-click) leaves a part out, Ctrl starts
      // another object on top of this one.
      if (e.button !== 0 && e.button !== 2) return;
      const p = at(e);
      const pt = { x: Math.round(p.x), y: Math.round(p.y) };
      if (!sel || sel.text || e.ctrlKey || e.metaKey) newSelection();
      (e.shiftKey || e.altKey || e.button === 2 ? sel!.negative : sel!.points).push(pt);
      if (!sel!.points.length) return; // only parts to leave out so far
      runSelect();
      return;
    }
    if (e.button !== 0) return;
    paint.setPointerCapture(e.pointerId);
    undo.push(ctx.getImageData(0, 0, paint.width, paint.height));
    if (undo.length > 25) undo.shift();
    drawing = true;
    last = at(e);
    stroke(last, last);
  });
  paint.addEventListener("pointermove", (e) => {
    // The brush outline follows the pointer.
    const ring = $("#ip-ring");
    const r = paint.getBoundingClientRect();
    ring.style.width = ring.style.height = `${brush()}px`;
    ring.style.left = tool === "select" ? "-999px" : `${e.clientX - r.left}px`;
    ring.style.top = `${e.clientY - r.top}px`;
    if (!drawing || !last) return;
    const p = at(e);
    stroke(last, p);
    last = p;
  });
  const end = () => {
    if (!drawing) return;
    drawing = false;
    last = null;
    sel = null; // painting by hand ends the selection
    update();
  };
  paint.addEventListener("pointerup", end);
  paint.addEventListener("pointercancel", end);
  paint.addEventListener("pointerleave", () => ($("#ip-ring").style.left = "-999px"));
  $("#ip-brush").addEventListener("click", () => setTool("brush"));
  $("#ip-erase").addEventListener("click", () => setTool("erase"));
  $("#ip-select").addEventListener("click", () => setTool("select"));
  // Select by name: "the car", "all the people". A name replaces the clicks of the selection being made.
  const find = () => {
    const text = ($("#ip-find") as HTMLInputElement).value.trim();
    if (!text || !opts.select) return;
    tool = "select";
    newSelection(text);
    runSelect();
  };
  $("#ip-find-go").addEventListener("click", find);
  $("#ip-find").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      find();
    }
  });
  $("#ip-undo").addEventListener("click", () => {
    const prev = undo.pop();
    if (prev) ctx.putImageData(prev, 0, 0);
    sel = null;
    selGen++;
    selecting = false;
    update();
  });
  $("#ip-clear").addEventListener("click", () => {
    undo.push(ctx.getImageData(0, 0, paint.width, paint.height));
    ctx.clearRect(0, 0, paint.width, paint.height);
    sel = null;
    update();
  });
  $("#ip-prompt").addEventListener("input", update);
  // Remove it: the selection is redrawn as the background that would be behind it.
  $("#ip-remove").addEventListener("click", async () => {
    if (!painted || !submit) return;
    const fn = submit;
    const r = { prompt: REMOVE_PROMPT, mask: await maskBlob(), width: paint.width, height: paint.height };
    close();
    fn(r);
  });
  // Cut out: what's painted, on transparent, as a new PNG.
  $("#ip-cut").addEventListener("click", async () => {
    if (!painted || !opts.cutout) return;
    const fn = opts.cutout;
    const mask = await maskBlob(false);
    const [w, h] = [paint.width, paint.height];
    close();
    fn(mask, w, h);
  });
  $("#ip-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const prompt = ($("#ip-prompt") as HTMLInputElement).value.trim();
    if (!prompt || !submit || selecting) return;
    const fn = submit;
    const mask = painted ? await maskBlob() : null;
    const r = { prompt, mask, width: paint.width, height: paint.height };
    close();
    fn(r);
  });
  $("#ip-cancel").addEventListener("click", close);
}
