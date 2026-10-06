// Paint to change: an overlay over a render where you paint the part to change and say what should be there. Only that
// area is regenerated (Qwen-Image-2.1 with a noise mask, then pasted back over the original through a soft-edged mask,
// so everything you didn't paint stays exactly as it was). With nothing painted it's an instruction edit of the whole
// picture ("make it night"). studio.ts runs the render; this file is the painting.

const $ = <T extends HTMLElement = HTMLElement>(s: string, r: ParentNode = document) => r.querySelector(s) as T;

export interface InpaintRequest {
  prompt: string;
  /** White where to change, black elsewhere, at the picture's own size; null for a whole-picture edit. */
  mask: Blob | null;
  width: number;
  height: number;
}

let paint: HTMLCanvasElement; // the strokes on transparent, at the picture's size
let ctx: CanvasRenderingContext2D;
let img: HTMLImageElement;
let undo: ImageData[] = [];
let erasing = false;
let painted = false;
let submit: ((r: InpaintRequest) => void) | null = null;
let drawing = false;
let last: { x: number; y: number } | null = null;

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
  ctx.globalCompositeOperation = erasing ? "destination-out" : "source-over";
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

function update() {
  painted = hasPaint();
  const prompt = ($("#ip-prompt") as HTMLInputElement).value.trim();
  const go = $("#ip-go") as HTMLButtonElement;
  go.textContent = painted ? "Change the painted area" : "Edit the whole picture";
  go.disabled = !prompt;
  $("#ip-hint").textContent = painted
    ? "Only the painted area changes; the rest stays exactly as it is. Say what should be there."
    : "Paint over what to change, or just type an instruction to edit the whole picture (e.g. make it night).";
  ($("#ip-undo") as HTMLButtonElement).disabled = !undo.length;
}

/** The mask Qwen-Image gets: the strokes in white on black, with softened edges so the new part blends in. */
async function maskBlob(): Promise<Blob> {
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
  // Grow the strokes a little (a second, wider pass), then feather by about 1% of the picture.
  const feather = Math.max(3, Math.round(Math.max(w, h) / 100));
  oc.filter = `blur(${feather}px)`;
  oc.drawImage(white, 0, 0);
  oc.drawImage(white, 0, 0);
  oc.filter = "none";
  oc.drawImage(white, 0, 0);
  return new Promise((res, rej) => out.toBlob((b) => (b ? res(b) : rej(new Error("Couldn't make the mask"))), "image/png"));
}

function close() {
  $("#inpaint").hidden = true;
  submit = null;
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
export function openInpaint(url: string, name: string, onSubmit: (r: InpaintRequest) => void) {
  submit = onSubmit;
  undo = [];
  erasing = false;
  $("#ip-brush").classList.add("on");
  $("#ip-erase").classList.remove("on");
  ($("#ip-prompt") as HTMLInputElement).value = "";
  $("#ip-name").textContent = name;
  $("#inpaint").hidden = false;
  document.addEventListener("keydown", onKey);
  img.onload = () => {
    paint.width = img.naturalWidth;
    paint.height = img.naturalHeight;
    ctx.clearRect(0, 0, paint.width, paint.height);
    update();
  };
  img.src = url;
  ($("#ip-prompt") as HTMLInputElement).focus();
}

export function initInpaint() {
  paint = $("#ip-paint") as HTMLCanvasElement;
  ctx = paint.getContext("2d")!;
  img = $("#ip-img") as HTMLImageElement;
  paint.addEventListener("pointerdown", (e) => {
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
    ring.style.left = `${e.clientX - r.left}px`;
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
    update();
  };
  paint.addEventListener("pointerup", end);
  paint.addEventListener("pointercancel", end);
  paint.addEventListener("pointerleave", () => ($("#ip-ring").style.left = "-999px"));
  $("#ip-brush").addEventListener("click", () => {
    erasing = false;
    $("#ip-brush").classList.add("on");
    $("#ip-erase").classList.remove("on");
  });
  $("#ip-erase").addEventListener("click", () => {
    erasing = true;
    $("#ip-erase").classList.add("on");
    $("#ip-brush").classList.remove("on");
  });
  $("#ip-undo").addEventListener("click", () => {
    const prev = undo.pop();
    if (prev) ctx.putImageData(prev, 0, 0);
    update();
  });
  $("#ip-clear").addEventListener("click", () => {
    undo.push(ctx.getImageData(0, 0, paint.width, paint.height));
    ctx.clearRect(0, 0, paint.width, paint.height);
    update();
  });
  $("#ip-prompt").addEventListener("input", update);
  $("#ip-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const prompt = ($("#ip-prompt") as HTMLInputElement).value.trim();
    if (!prompt || !submit) return;
    const fn = submit;
    const mask = painted ? await maskBlob() : null;
    const r = { prompt, mask, width: paint.width, height: paint.height };
    close();
    fn(r);
  });
  $("#ip-cancel").addEventListener("click", close);
}
