// Laser: turns a picture into a file a laser engraver or cutter can use, at the size it'll be on the material.
//  - Engrave a photo: grayscale, then dithered to black dots (Jarvis by default, which LightBurn users favour for photos on
//    wood), or kept as grayscale for lasers that vary their power. A PNG whose DPI is written into the file, so LightBurn,
//    xTool Creative Space or LaserGRBL import it at the right size.
//  - Engrave line art: pure black and white at a threshold, the same PNG.
//  - Cut or score: the black shapes traced into an SVG in millimetres, as hairline red cut lines or filled shapes.
// Everything runs here on a canvas, so it's instant and needs no model. "/laser a celtic knot coaster" in chat draws a
// design first with the image model, made to be engraved (bold black lines on white), and opens it here.
import { convertFileSrc, invoke } from "@tauri-apps/api/core";

const $ = <T extends HTMLElement = HTMLElement>(s: string, r: ParentNode = document) => r.querySelector(s) as T;

/** "/laser a mandala coaster": a design made to be engraved or cut. */
export const LASER_CMD = /^\/(?:laser|engrave)\b\s*/i;

/** What the image model is asked for, so the design traces cleanly. */
export const laserPrompt = (idea: string) =>
  `${idea}. Laser engraving design: bold clean black line art on a pure white background, high contrast stencil style, ` +
  `crisp solid shapes, no shading, no gradients, no grey, no text, centered with a white margin.`;

export type LaserJob = "photo" | "lineart" | "cut";
export type Dither = "jarvis" | "floyd" | "atkinson" | "bayer" | "gray";

interface LaserSettings {
  job: LaserJob;
  dither: Dither;
  widthMm: number;
  dpi: number;
  brightness: number; // -100 to 100
  contrast: number; // -100 to 100
  threshold: number; // 0 to 255: darker than this is black (line art, cut)
  invert: boolean;
  mirror: boolean;
  speckMm: number; // cut: shapes smaller than this are left out
  smooth: boolean; // cut: curves instead of straight segments
  svgStyle: "cut" | "fill";
}

const DEFAULTS: LaserSettings = {
  job: "photo",
  dither: "jarvis",
  widthMm: 100,
  // 254 DPI is 10 lines per millimetre: about a diode laser's spot size (0.08 to 0.1 mm), the usual starting point.
  dpi: 254,
  brightness: 0,
  contrast: 20,
  threshold: 128,
  invert: false,
  mirror: false,
  speckMm: 0.5,
  smooth: true,
  svgStyle: "cut",
};

const KEY = "prestige.laser";
function loadSettings(): LaserSettings {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
  } catch {
    return { ...DEFAULTS };
  }
}
let s = loadSettings();
const saveSettings = () => localStorage.setItem(KEY, JSON.stringify(s));

/** The most pixels on a side: 8000 is 800 mm at 254 DPI, past any hobby laser's bed. */
const MAX_PX = 8000;
/** Shapes are traced at up to this many pixels on the long side (finer than a kerf at any size that fits a bed). */
const TRACE_PX = 1800;

// ---------- image processing ----------
/** The picture's brightness (0 dark to 255 light) at w × h, on white where it's transparent, with brightness, contrast and
 *  invert applied. */
function grayOf(img: HTMLImageElement, w: number, h: number): Float32Array {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  const out = new Float32Array(w * h);
  const c128 = s.contrast * 1.28;
  const cf = (259 * (c128 + 255)) / (255 * (259 - c128));
  const b = s.brightness * 1.28;
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    let v = 0.2126 * d[p] + 0.7152 * d[p + 1] + 0.0722 * d[p + 2];
    v = cf * (v - 128) + 128 + b;
    v = v < 0 ? 0 : v > 255 ? 255 : v;
    out[i] = s.invert ? 255 - v : v;
  }
  return out;
}

// Error diffusion kernels: [dx, dy, weight], over a divisor.
const KERNELS: Record<"jarvis" | "floyd" | "atkinson", { div: number; k: [number, number, number][] }> = {
  floyd: { div: 16, k: [[1, 0, 7], [-1, 1, 3], [0, 1, 5], [1, 1, 1]] },
  jarvis: {
    div: 48,
    k: [[1, 0, 7], [2, 0, 5], [-2, 1, 3], [-1, 1, 5], [0, 1, 7], [1, 1, 5], [2, 1, 3], [-2, 2, 1], [-1, 2, 3], [0, 2, 5], [1, 2, 3], [2, 2, 1]],
  },
  // Atkinson spreads only 3/4 of the error: lighter, crisper, good on leather and card.
  atkinson: { div: 8, k: [[1, 0, 1], [2, 0, 1], [-1, 1, 1], [0, 1, 1], [1, 1, 1], [0, 2, 1]] },
};

const BAYER = [0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38, 60, 28, 52, 20, 62, 30, 54, 22, 3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25, 15, 47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21];

/** Black (0) or white (255) per pixel, or gray levels for "gray". */
function toneMap(g: Float32Array, w: number, h: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h);
  if (s.job !== "photo") {
    for (let i = 0; i < g.length; i++) out[i] = g[i] < s.threshold ? 0 : 255;
    return out;
  }
  if (s.dither === "gray") {
    for (let i = 0; i < g.length; i++) out[i] = g[i];
    return out;
  }
  if (s.dither === "bayer") {
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) out[y * w + x] = g[y * w + x] > ((BAYER[(y & 7) * 8 + (x & 7)] + 0.5) * 255) / 64 ? 255 : 0;
    return out;
  }
  const { div, k } = KERNELS[s.dither];
  const e = g.slice();
  // Serpentine: every other row runs right to left, so the dots don't line up in streaks.
  for (let y = 0; y < h; y++) {
    const rtl = y & 1;
    for (let i = 0; i < w; i++) {
      const x = rtl ? w - 1 - i : i;
      const p = y * w + x;
      const v = e[p] < 128 ? 0 : 255;
      out[p] = v;
      const err = (e[p] - v) / div;
      for (const [dx, dy, wt] of k) {
        const xx = rtl ? x - dx : x + dx;
        const yy = y + dy;
        if (xx >= 0 && xx < w && yy < h) e[yy * w + xx] += err * wt;
      }
    }
  }
  return out;
}

/** The engraving at its real size: w × h pixels at the DPI, as RGBA for a canvas (mirrored if asked). */
function engraving(img: HTMLImageElement, w: number, h: number): ImageData {
  const t = toneMap(grayOf(img, w, h), w, h);
  const data = new ImageData(w, h);
  const d = data.data;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = t[y * w + (s.mirror ? w - 1 - x : x)];
      const p = (y * w + x) * 4;
      d[p] = d[p + 1] = d[p + 2] = v;
      d[p + 3] = 255;
    }
  return data;
}

// ---------- tracing ----------
type Pt = [number, number];

/** The outlines of the black areas: closed loops along the pixel edges, black on the right of each step (outer edges
 *  run clockwise, holes anticlockwise). Where two black pixels touch only at a corner, they stay separate shapes. */
function outlines(black: Uint8Array, w: number, h: number): Pt[][] {
  const W = w + 1;
  const out = new Uint8Array(W * (h + 1)); // per corner: bit d is set when an edge leaves it in direction d
  const at = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && black[y * w + x] === 1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (!black[y * w + x]) continue;
      if (!at(x, y - 1)) out[y * W + x] |= 1; // top edge, going right
      if (!at(x + 1, y)) out[y * W + x + 1] |= 2; // right edge, going down
      if (!at(x, y + 1)) out[(y + 1) * W + x + 1] |= 4; // bottom edge, going left
      if (!at(x - 1, y)) out[(y + 1) * W + x] |= 8; // left edge, going up
    }
  const step = [1, W, -1, -W];
  const loops: Pt[][] = [];
  for (let v0 = 0; v0 < out.length; v0++) {
    while (out[v0]) {
      let d = Math.log2(out[v0] & -out[v0]);
      out[v0] &= ~(1 << d);
      const pts: Pt[] = [[v0 % W, Math.floor(v0 / W)]];
      let v = v0;
      for (;;) {
        v += step[d];
        // Turn right if that edge is there, else straight on, else left.
        let next = -1;
        for (const t of [(d + 1) & 3, d, (d + 3) & 3]) if (out[v] & (1 << t)) { next = t; break; }
        if (next < 0) break;
        out[v] &= ~(1 << next);
        if (next !== d) pts.push([v % W, Math.floor(v / W)]);
        d = next;
      }
      loops.push(pts);
    }
  }
  return loops;
}

const area = (p: Pt[]) => {
  let a = 0;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) a += (p[j][0] - p[i][0]) * (p[j][1] + p[i][1]);
  return a / 2;
};

/** Douglas–Peucker: the fewest points that stay within tol of the line. */
function simplifyOpen(p: Pt[], tol: number): Pt[] {
  if (p.length < 3) return p;
  const keep = new Uint8Array(p.length);
  keep[0] = keep[p.length - 1] = 1;
  const stack: [number, number][] = [[0, p.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const [ax, ay] = p[a];
    const [bx, by] = p[b];
    const len = Math.hypot(bx - ax, by - ay) || 1;
    let far = -1;
    let dist = tol;
    for (let i = a + 1; i < b; i++) {
      const dd = Math.abs((bx - ax) * (ay - p[i][1]) - (ax - p[i][0]) * (by - ay)) / len;
      if (dd > dist) {
        dist = dd;
        far = i;
      }
    }
    if (far >= 0) {
      keep[far] = 1;
      stack.push([a, far], [far, b]);
    }
  }
  return p.filter((_, i) => keep[i]);
}

/** A closed loop simplified: split at its first point and the point farthest from it. */
function simplifyLoop(p: Pt[], tol: number): Pt[] {
  if (p.length < 4) return p;
  let far = 0;
  let best = -1;
  for (let i = 1; i < p.length; i++) {
    const dd = (p[i][0] - p[0][0]) ** 2 + (p[i][1] - p[0][1]) ** 2;
    if (dd > best) {
      best = dd;
      far = i;
    }
  }
  const a = simplifyOpen(p.slice(0, far + 1), tol);
  const b = simplifyOpen([...p.slice(far), p[0]], tol);
  return [...a.slice(0, -1), ...b.slice(0, -1)];
}

/** One loop as SVG path data in millimetres: straight lines, or curves through the segment midpoints that keep sharp
 *  corners sharp. */
function pathData(p: Pt[], k: number, flipW: number | null): string {
  const f = (n: number) => String(Math.round(n * 100) / 100);
  const X = (x: number) => f((flipW != null ? flipW - x : x) * k);
  const Y = (y: number) => f(y * k);
  const pt = (q: Pt) => `${X(q[0])} ${Y(q[1])}`;
  const n = p.length;
  if (!s.smooth || n < 3) return `M${p.map(pt).join("L")}Z`;
  const mid = (a: Pt, b: Pt): Pt => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const sharp = (i: number) => {
    const a = p[(i + n - 1) % n];
    const b = p[i];
    const c = p[(i + 1) % n];
    const t1 = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const t2 = Math.atan2(c[1] - b[1], c[0] - b[0]);
    let t = Math.abs(t2 - t1);
    if (t > Math.PI) t = 2 * Math.PI - t;
    // A curve is many short segments turning a little; a long straight edge turning by 30° or more is a corner.
    const short = Math.min(Math.hypot(b[0] - a[0], b[1] - a[1]), Math.hypot(c[0] - b[0], c[1] - b[1]));
    return t > Math.PI / 3 || (t > Math.PI / 6 && short > 6);
  };
  let d = `M${pt(mid(p[n - 1], p[0]))}`;
  for (let i = 0; i < n; i++) {
    const m = mid(p[i], p[(i + 1) % n]);
    d += sharp(i) ? `L${pt(p[i])}L${pt(m)}` : `Q${pt(p[i])} ${pt(m)}`;
  }
  return `${d}Z`;
}

/** The dark shapes as an SVG widthMm wide, and how many outlines it has (0 when nothing was dark enough). */
function traceSvg(img: HTMLImageElement, widthMm: number, heightMm: number, desc: string): { svg: string; shapes: number } {
  const ratio = img.naturalHeight / img.naturalWidth;
  const long = Math.min(TRACE_PX, Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(ratio <= 1 ? long : long / ratio));
  const h = Math.max(1, Math.round(ratio <= 1 ? long * ratio : long));
  const g = grayOf(img, w, h);
  const black = new Uint8Array(w * h);
  for (let i = 0; i < g.length; i++) black[i] = g[i] < s.threshold ? 1 : 0;
  const k = widthMm / w; // millimetres per traced pixel
  const minArea = (s.speckMm / k) ** 2;
  const loops = outlines(black, w, h).filter((l) => Math.abs(area(l)) >= Math.max(2, minArea));
  const d = loops.map((l) => pathData(simplifyLoop(l, 1), k, s.mirror ? w : null)).join("");
  const mm = (n: number) => Math.round(n * 100) / 100;
  const style =
    s.svgStyle === "cut"
      ? `fill="none" stroke="#ff0000" stroke-width="0.1" stroke-linejoin="round"`
      : `fill="#000000" fill-rule="evenodd" stroke="none"`;
  const esc = (t: string) => t.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const svg =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<svg xmlns="http://www.w3.org/2000/svg" width="${mm(widthMm)}mm" height="${mm(heightMm)}mm" viewBox="0 0 ${mm(widthMm)} ${mm(heightMm)}">\n` +
    `<title>${esc(desc)}</title>\n` +
    (d ? `<path ${style} d="${d}"/>\n` : "") +
    `</svg>\n`;
  return { svg, shapes: loops.length };
}

// ---------- PNG with its size in it ----------
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  let c = 0xffffffff;
  for (let i = 4; i < 8 + data.length; i++) c = CRC[(c ^ out[i]) & 0xff] ^ (c >>> 8);
  dv.setUint32(8 + data.length, (c ^ 0xffffffff) >>> 0);
  return out;
}

/** The canvas as a PNG with its DPI (pHYs) and a description the gallery shows (tEXt "prompt", the way ComfyUI tags its
 *  renders), so laser software imports it at the right size. */
async function pngWithDpi(c: HTMLCanvasElement, dpi: number, desc: string): Promise<Uint8Array> {
  const blob = await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("couldn't make the PNG"))), "image/png"));
  const png = new Uint8Array(await blob.arrayBuffer());
  const phys = new Uint8Array(9);
  const ppm = Math.round(dpi / 0.0254);
  new DataView(phys.buffer).setUint32(0, ppm);
  new DataView(phys.buffer).setUint32(4, ppm);
  phys[8] = 1; // the unit is the metre
  const tag = JSON.stringify({ "1": { class_type: "CLIPTextEncode", inputs: { text: desc } }, "2": { class_type: "Laser", inputs: { ckpt_name: "Laser" } } });
  const text = new TextEncoder().encode(`prompt\0${tag}`);
  const ihdrEnd = 8 + 25; // signature, then IHDR (13 bytes of data and 12 around it)
  const parts = [png.slice(0, ihdrEnd), chunk("pHYs", phys), chunk("tEXt", text), png.slice(ihdrEnd)];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// ---------- the panel ----------
interface Deps {
  toast: (msg: string, kind?: "warn") => void;
  root: () => string | null;
  /** Shows the saved PNG in the gallery's lightbox. */
  openRender: (path: string) => void;
}
let deps: Deps;
let img: HTMLImageElement | null = null;
let srcName = "";
let srcPrompt = "";
let timer: number | undefined;
let last: { kind: "png"; canvas: HTMLCanvasElement } | { kind: "svg"; svg: string } | null = null;
let svgUrl = "";

const JOB_HINT: Record<LaserJob, string> = {
  photo: "Dithered to dots the laser burns one by one: for photos and anything with shading.",
  lineart: "Pure black and white: logos, line art and text. Darker than the threshold burns.",
  cut: "Traced to vector shapes in millimetres, for cutting or scoring. Darker than the threshold becomes a shape.",
};

export function initLaser(d: Deps) {
  deps = d;
  const dlg = $("#laser") as HTMLDialogElement;
  dlg.addEventListener("close", () => {
    img = null;
    last = null;
    if (svgUrl) URL.revokeObjectURL(svgUrl);
    svgUrl = "";
    ($("#lz-canvas") as HTMLCanvasElement).width = 1;
  });
  for (const b of Array.from(dlg.querySelectorAll<HTMLButtonElement>("#lz-job button")))
    b.addEventListener("click", () => {
      s.job = b.dataset.job as LaserJob;
      changed();
    });
  for (const b of Array.from(dlg.querySelectorAll<HTMLButtonElement>("#lz-svg-style button")))
    b.addEventListener("click", () => {
      s.svgStyle = b.dataset.style as "cut" | "fill";
      changed();
    });
  const num = (id: string, k: keyof LaserSettings) =>
    $(id).addEventListener("input", (e) => {
      const v = Number((e.target as HTMLInputElement).value);
      if (Number.isFinite(v)) (s as any)[k] = v;
      changed();
    });
  num("#lz-width", "widthMm");
  num("#lz-dpi", "dpi");
  num("#lz-bright", "brightness");
  num("#lz-contrast", "contrast");
  num("#lz-threshold", "threshold");
  num("#lz-speck", "speckMm");
  $("#lz-dither").addEventListener("change", (e) => {
    s.dither = (e.target as HTMLSelectElement).value as Dither;
    changed();
  });
  for (const [id, k] of [["#lz-invert", "invert"], ["#lz-mirror", "mirror"], ["#lz-smooth", "smooth"]] as const)
    $(id).addEventListener("change", (e) => {
      s[k] = (e.target as HTMLInputElement).checked;
      changed();
    });
  $("#lz-reset").addEventListener("click", () => {
    s = { ...DEFAULTS, job: s.job, widthMm: s.widthMm, dpi: s.dpi };
    changed();
  });
  $("#lz-actual").addEventListener("change", (e) => $("#lz-view").classList.toggle("actual", (e.target as HTMLInputElement).checked));
  $("#lz-cancel").addEventListener("click", () => dlg.close());
  $("#lz-save").addEventListener("click", () => save(false));
  $("#lz-save-as").addEventListener("click", () => save(true));
}

/** Opens the panel for a picture (a render's path). `job` picks the kind of file to start with. */
export async function openLaser(path: string, name: string, prompt = "", job?: LaserJob) {
  const dlg = $("#laser") as HTMLDialogElement;
  srcName = name.replace(/\.[^.]+$/, "");
  srcPrompt = prompt;
  if (job) s.job = job;
  $("#lz-name").textContent = name;
  const im = new Image();
  im.src = convertFileSrc(path);
  try {
    await im.decode();
  } catch {
    deps.toast("Couldn't open that picture.", "warn");
    return;
  }
  img = im;
  if (!dlg.open) dlg.showModal();
  sync();
  redraw();
}

/** The output's size: width as set, height from the picture's shape, in mm and in pixels at the DPI. */
function size() {
  const wMm = Math.min(2000, Math.max(5, s.widthMm || DEFAULTS.widthMm));
  const hMm = img ? (wMm * img.naturalHeight) / img.naturalWidth : wMm;
  const dpi = Math.min(1200, Math.max(50, s.dpi || DEFAULTS.dpi));
  let w = Math.round((wMm / 25.4) * dpi);
  let h = Math.round((hMm / 25.4) * dpi);
  const over = Math.max(w, h) / MAX_PX;
  if (over > 1) {
    w = Math.round(w / over);
    h = Math.round(h / over);
  }
  return { wMm, hMm, dpi: over > 1 ? dpi / over : dpi, w: Math.max(1, w), h: Math.max(1, h) };
}

/** The controls show the settings (only the ones that matter for this kind of file). */
function sync() {
  const dlg = $("#laser");
  dlg.querySelectorAll<HTMLButtonElement>("#lz-job button").forEach((b) => b.classList.toggle("on", b.dataset.job === s.job));
  dlg.querySelectorAll<HTMLButtonElement>("#lz-svg-style button").forEach((b) => b.classList.toggle("on", b.dataset.style === s.svgStyle));
  ($("#lz-width") as HTMLInputElement).value = String(s.widthMm);
  ($("#lz-dpi") as HTMLSelectElement).value = String(s.dpi);
  ($("#lz-dither") as HTMLSelectElement).value = s.dither;
  ($("#lz-bright") as HTMLInputElement).value = String(s.brightness);
  ($("#lz-contrast") as HTMLInputElement).value = String(s.contrast);
  ($("#lz-threshold") as HTMLInputElement).value = String(s.threshold);
  ($("#lz-speck") as HTMLInputElement).value = String(s.speckMm);
  ($("#lz-invert") as HTMLInputElement).checked = s.invert;
  ($("#lz-mirror") as HTMLInputElement).checked = s.mirror;
  ($("#lz-smooth") as HTMLInputElement).checked = s.smooth;
  for (const el of Array.from(dlg.querySelectorAll<HTMLElement>("[data-for]"))) el.hidden = !el.dataset.for!.split(" ").includes(s.job);
  $("#lz-hint").textContent = JOB_HINT[s.job];
  $("#lz-bright-v").textContent = String(s.brightness);
  $("#lz-contrast-v").textContent = String(s.contrast);
  $("#lz-threshold-v").textContent = String(s.threshold);
  $("#lz-speck-v").textContent = `${s.speckMm} mm`;
  $("#lz-save").textContent = s.job === "cut" ? "Save SVG" : "Save PNG";
}

function changed() {
  saveSettings();
  sync();
  clearTimeout(timer);
  // Quick for small outputs, a little later for big ones (a 3000 px dither takes a moment).
  timer = window.setTimeout(redraw, 120);
}

function describe(): string {
  const { wMm, hMm, dpi } = size();
  const what = s.job === "cut" ? (s.svgStyle === "cut" ? "Laser cut lines" : "Laser vector shapes") : s.job === "lineart" ? "Laser engraving (line art)" : `Laser engraving (${s.dither === "gray" ? "grayscale" : `${s.dither} dither`})`;
  return `${what} · ${Math.round(wMm)} × ${Math.round(hMm)} mm${s.job === "cut" ? "" : ` · ${Math.round(dpi)} DPI`}${s.invert ? " · inverted" : ""}${s.mirror ? " · mirrored" : ""} · from ${srcName}${srcPrompt ? `: ${srcPrompt}` : ""}`;
}

function redraw() {
  if (!img) return;
  const { wMm, hMm, dpi, w, h } = size();
  const canvas = $("#lz-canvas") as HTMLCanvasElement;
  const pic = $("#lz-svg") as HTMLImageElement;
  const info = $("#lz-info");
  const t0 = performance.now();
  if (s.job === "cut") {
    const { svg, shapes } = traceSvg(img, wMm, hMm, describe());
    last = { kind: "svg", svg };
    if (svgUrl) URL.revokeObjectURL(svgUrl);
    // Shown on white with the cut lines thickened a little, so hairlines are visible in the preview.
    svgUrl = URL.createObjectURL(new Blob([svg.replace('stroke-width="0.1"', `stroke-width="${Math.max(0.1, wMm / 400)}"`)], { type: "image/svg+xml" }));
    pic.src = svgUrl;
    pic.hidden = false;
    canvas.hidden = true;
    info.textContent = shapes
      ? `${shapes} outline${shapes === 1 ? "" : "s"} · ${Math.round(wMm)} × ${Math.round(hMm)} mm · ${(svg.length / 1024).toFixed(0)} KB SVG`
      : "Nothing is dark enough to trace. Raise the threshold, or try Invert.";
  } else {
    canvas.width = w;
    canvas.height = h;
    canvas.getContext("2d")!.putImageData(engraving(img, w, h), 0, 0);
    last = { kind: "png", canvas };
    canvas.hidden = false;
    pic.hidden = true;
    const capped = Math.round(dpi) !== s.dpi ? ` (lowered to fit ${MAX_PX} px)` : "";
    info.textContent = `${w} × ${h} px · ${Math.round(wMm)} × ${Math.round(hMm)} mm at ${Math.round(dpi)} DPI${capped} · ${(25.4 / dpi).toFixed(3)} mm a dot`;
  }
  const ms = performance.now() - t0;
  if (ms > 400) info.textContent += ` · ${(ms / 1000).toFixed(1)} s to draw`;
}

async function save(ask: boolean) {
  if (!img || !last) return;
  const desc = describe();
  const btns = Array.from(document.querySelectorAll<HTMLButtonElement>("#lz-save, #lz-save-as"));
  btns.forEach((b) => (b.disabled = true));
  try {
    const bytes = last.kind === "svg" ? new TextEncoder().encode(last.svg) : await pngWithDpi(last.canvas, size().dpi, desc);
    const ext = last.kind;
    const suffix = s.job === "cut" ? "cut" : "engrave";
    const path = await invoke<string | null>("laser_save", bytes, {
      headers: { "x-ext": ext, "x-name": encodeURIComponent(`${srcName}-${suffix}`), "x-root": encodeURIComponent(deps.root() ?? ""), "x-ask": ask ? "1" : "" },
    });
    if (!path) return;
    ($("#laser") as HTMLDialogElement).close();
    if (ext === "png" && !ask) {
      deps.toast(`Saved the engraving at ${Math.round(size().dpi)} DPI. Import it into your laser software at its own size.`);
      deps.openRender(path);
    } else {
      deps.toast(`Saved ${path.split(/[\\/]/).pop()}.`);
      invoke("reveal", { path }).catch(() => {});
    }
  } catch (e) {
    deps.toast(`Couldn't save it: ${e instanceof Error ? e.message : String(e)}`, "warn");
  } finally {
    btns.forEach((b) => (b.disabled = false));
  }
}
