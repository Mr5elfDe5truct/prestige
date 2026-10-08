// Appearance: the style (how surfaces are built and what moves behind them: Molded, Classic, Living Matrix…), the colour
// theme (a preset, or your own accent and trim colours), how strongly things glow, the ember drift, whether the
// background moves, your own background picture or video, and emote reactions. Changes show at once while Settings is
// open; Cancel puts them back.
// The look is also kept in this window's local storage, so the launch screen already has it before settings load.
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { setEmbers } from "./embers";
import { setLiveBg } from "./skins/backgrounds";

export interface Look {
  theme?: string; // a preset id, or "custom"
  accent?: string; // custom accent (the "signal" colour: buttons, the eye, rings)
  trim?: string; // custom trim (the "metal" colour: the mark, names, highlights)
  glow?: number; // glow and bloom, 0 (off) to 150 (%)
  embers?: boolean; // false = no ember drift
  emotes?: boolean; // false = no emote reactions
  style?: string; // a STYLES id; unset = the first (Molded)
  motion?: boolean; // false = a still background (no ember drift; the style's background and a video hold still)
  bg?: string; // your own background: a file in the app data folder's background folder (background.rs)
  bgDim?: number; // how much your background is darkened, 0 to 90 (%)
  bgBlur?: number; // how much it's blurred, 0 to 20 (px)
  molded?: boolean; // before styles: false meant flat panels, now the Classic style (read once, never written)
}

/**
 * Styles: how surfaces are built and what moves behind them, separate from the colours. Each one is
 * body[data-style="<id>"] and its own CSS file (imported in main.ts) that draws only from the theme's colour variables,
 * so every theme and Accent/Trim works in it. Classic is styles.css alone. The living styles also share
 * skins/living.css (body[data-living]), have a background renderer in skins/backgrounds.ts, and ship a matching
 * colour preset (`theme`, in PRESETS) that's picked with them. To add one: an entry here, its CSS file, and (for a
 * living one) its preset and renderer.
 */
export interface Style {
  id: string;
  name: string;
  about: string;
  living?: boolean;
  theme?: string; // the PRESETS id picked with it
}
export const STYLES: Style[] = [
  { id: "molded", name: "Molded", about: "Panels and keys rise out of one surface like a cast keybed, and grow into place" },
  { id: "classic", name: "Classic", about: "Flat black-lacquer panels with fine borders" },
  { id: "matrix", name: "Living Matrix", living: true, theme: "matrix", about: "Code rain behind glass panels with scanlines; it pours faster while Prestige thinks" },
  { id: "cyber", name: "Cyberpunk", living: true, theme: "cyber", about: "Neon cut-corner panels over a grid city floor that speeds up and glitches while Prestige thinks" },
  { id: "nature", name: "Earth & Nature", living: true, theme: "nature", about: "River-stone panels, fireflies and falling leaves; the fireflies gather while Prestige thinks" },
  { id: "electric", name: "Energy", living: true, theme: "electric", about: "Humming plasma-edged panels with lightning that arcs constantly while Prestige thinks" },
  { id: "waves", name: "Frequency", living: true, theme: "waves", about: "Frosted panels over sound waves that swell while Prestige thinks and follow its voice" },
  { id: "bio", name: "Biological", living: true, theme: "bio", about: "Breathing membrane panels with drifting cells that pulse while Prestige thinks" },
  { id: "clock", name: "Clockwork", living: true, theme: "clock", about: "Brass and walnut plates with rivets, over gears that spin up while Prestige thinks" },
  { id: "cosmic", name: "Cosmic", living: true, theme: "cosmic", about: "Frosted glass over a nebula; the stars stream past like a warp jump while Prestige thinks" },
  { id: "crystal", name: "Crystal", living: true, theme: "crystal", about: "Faceted glass panels; light flashes through the facets while Prestige thinks" },
];
/** The style a look uses (a look saved with the old Molded switch off is Classic). */
export const styleOf = (look: Look): string => STYLES.find((s) => s.id === look.style)?.id ?? (look.molded === false ? "classic" : STYLES[0].id);

interface Preset {
  id: string;
  name: string;
  accent: string;
  trim: string;
  /** Exact surface colours (Dragon keeps its original palette); the others are worked out from the accent. */
  exact?: Record<string, string>;
  /** A living style's own colours: shown in the Theme row only while that style is picked. */
  style?: boolean;
}
/** A living style's matching colours: background, panels, a line, text, muted text and a deep accent (the mockup's). */
const stylePreset = (id: string, name: string, accent: string, trim: string, c: string[]): Preset => {
  const [bg, panel, panel2, line, fg, muted, deep] = c;
  return { id, name, accent, trim, style: true, exact: { bg, panel, "panel-2": panel2, line, fg, muted, "red-deep": deep } };
};

export const PRESETS: Preset[] = [
  {
    id: "dragon",
    name: "Dragon",
    accent: "#d6202b",
    trim: "#d9a441",
    exact: {
      bg: "#0a0707", panel: "#120c0c", "panel-2": "#1a1111", line: "#2c1c1c", fg: "#efe4d6", muted: "#9c8a7f", "red-deep": "#7a0d12",
      // the molded surfaces (mesa.css): the ground, a raised thing's walls (lit top to shadowed foot), its top face, carved wells
      ground: "#170e0b", "wall-hi": "#6b4232", wall: "#3a241c", "wall-mid": "#22140f", "wall-lo": "#0e0706",
      "face-hi": "#3e261d", face: "#2a1913", "face-lo": "#22130e", well: "#110907", "gold-hi": "#f3cf7a",
    },
  },
  { id: "sapphire", name: "Sapphire", accent: "#2f6fe0", trim: "#c8d2e0" },
  { id: "emerald", name: "Emerald", accent: "#17a35e", trim: "#d9b44a" },
  { id: "amethyst", name: "Amethyst", accent: "#9246e0", trim: "#e6ad8f" },
  { id: "ember", name: "Ember", accent: "#ef6a1b", trim: "#f0c060" },
  { id: "frost", name: "Frost", accent: "#22b4d8", trim: "#e3ecf2" },
  { id: "rose", name: "Rose", accent: "#e0457b", trim: "#f2c2a8" },
  stylePreset("matrix", "Matrix", "#39ff7a", "#1fd15d", ["#010a04", "#001006", "#00280f", "#0b3a1a", "#c9ffd9", "#4fa86a", "#0d5a2a"]),
  stylePreset("cyber", "Cyberpunk", "#ff2bd6", "#00f0ff", ["#0a0614", "#1e0a32", "#280c3c", "#3a1a5a", "#f2e9ff", "#9a86c4", "#6a0a5a"]),
  stylePreset("nature", "Nature", "#c9d86a", "#e7b45a", ["#0d140c", "#2a3420", "#3d4a2c", "#4a5a33", "#ecf0dc", "#9aa982", "#4a5a1c"]),
  stylePreset("electric", "Energy", "#7fe3ff", "#b58cff", ["#03060f", "#060e1e", "#0a1830", "#163a5a", "#e6f3ff", "#7c95b8", "#164a6a"]),
  stylePreset("waves", "Frequency", "#ffb347", "#5ad1c8", ["#070a12", "#0e1220", "#161c30", "#2a3048", "#eaf0ff", "#8a95b5", "#6a4a14"]),
  stylePreset("bio", "Biological", "#ff7ab6", "#6ff2d0", ["#0e0710", "#3a1430", "#50162e", "#5a2a44", "#fbe9f2", "#b98aa3", "#6a1a44"]),
  stylePreset("clock", "Clockwork", "#e2b456", "#c46b3c", ["#120c07", "#2c1d12", "#3c2914", "#6b4b1e", "#f3e6cc", "#b39d78", "#6b4b1e"]),
  stylePreset("cosmic", "Cosmic", "#c9b6ff", "#ffd38a", ["#04030c", "#120e28", "#282050", "#3a3070", "#ece9ff", "#8f89b8", "#3a2a7a"]),
  stylePreset("crystal", "Crystal", "#9fe8ff", "#f5b3ff", ["#080a10", "#141a2c", "#283048", "#3a4664", "#eef6ff", "#93a2bb", "#2a5a6a"]),
];
export const DEFAULT_GLOW = 100;

// ---------- colour maths ----------
type RGB = [number, number, number];
const hex = (h: string): RGB => {
  const m = /^#?([0-9a-f]{6})$/i.exec(h.trim());
  const n = m ? parseInt(m[1], 16) : 0xd6202b;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const toHex = (c: RGB) => `#${c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("")}`;
function hsl([r, g, b]: RGB): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l * 100];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s * 100, l * 100];
}
const css = (h: number, s: number, l: number) => `hsl(${h.toFixed(1)} ${Math.max(0, Math.min(100, s)).toFixed(1)}% ${Math.max(0, Math.min(100, l)).toFixed(1)}%)`;

/** The accent and trim a look uses. */
export function colorsOf(look: Look): { accent: string; trim: string; preset?: Preset } {
  const preset = PRESETS.find((p) => p.id === (look.theme ?? "dragon"));
  if (preset) return { accent: preset.accent, trim: preset.trim, preset };
  return { accent: look.accent ?? PRESETS[0].accent, trim: look.trim ?? PRESETS[0].trim };
}

/** Every theme variable for a look. The surfaces take the accent's hue at Dragon's (very dark) lightness. */
function palette(look: Look): Record<string, string> {
  const { accent, trim, preset } = colorsOf(look);
  const [h, s, l] = hsl(hex(accent));
  const [th, ts, tl] = hsl(hex(trim));
  const vars: Record<string, string> = {
    red: accent,
    gold: trim,
    "red-hover": css(h, s, Math.min(l + 7, 70)),
    bg: css(h, Math.min(s, 18), 3.3),
    panel: css(h, Math.min(s, 20), 5.9),
    "panel-2": css(h, Math.min(s, 21), 8.4),
    line: css(h, Math.min(s, 22), 14),
    fg: css(th, Math.min(ts * 0.7, 47), 89),
    muted: css(th, Math.min(ts, 13), 55),
    "red-deep": css(h, Math.min(s + 7, 100), 26),
    // molded surfaces: stone tinted with the accent's hue at the lightness of Dragon's red-brown stone
    ground: css(h, Math.min(s, 35), 7),
    "wall-hi": css(h, Math.min(s, 36), 31),
    wall: css(h, Math.min(s, 35), 17),
    "wall-mid": css(h, Math.min(s, 38), 10),
    "wall-lo": css(h, Math.min(s, 40), 4),
    "face-hi": css(h, Math.min(s, 36), 18),
    face: css(h, Math.min(s, 38), 12),
    "face-lo": css(h, Math.min(s, 42), 9),
    well: css(h, Math.min(s, 40), 5),
    "gold-hi": css(th, Math.min(ts + 15, 100), Math.min(tl + 16, 90)),
  };
  return preset?.exact ? { ...vars, ...preset.exact } : vars;
}

// ---------- applying it ----------
let accentRgb: RGB = hex(PRESETS[0].accent);
let trimRgb: RGB = hex(PRESETS[0].trim);
let glow = 1;

/** For canvases: "r, g, b" of the accent and trim, and the glow strength (0 to 1.5). */
export const themeRgb = () => ({ accent: accentRgb.join(", "), trim: trimRgb.join(", "), glow });

export function applyLook(look: Look = {}) {
  const root = document.documentElement.style;
  for (const [k, v] of Object.entries(palette(look))) root.setProperty(`--${k}`, v);
  const { accent, trim } = colorsOf(look);
  accentRgb = hex(accent);
  trimRgb = hex(trim);
  glow = Math.max(0, Math.min(150, look.glow ?? DEFAULT_GLOW)) / 100;
  root.setProperty("--glow", String(glow));
  document.body.classList.toggle("no-glow", glow === 0);
  document.body.classList.toggle("no-emotes", look.emotes === false);
  const style = STYLES.find((s) => s.id === styleOf(look))!;
  document.body.dataset.style = style.id;
  document.body.toggleAttribute("data-living", !!style.living);
  const still = look.motion === false || reduced.matches;
  document.body.classList.toggle("still", still);
  root.setProperty("--bg-dim", String(Math.max(0, Math.min(90, look.bgDim ?? DEFAULT_DIM)) / 100));
  root.setProperty("--bg-blur", `${Math.max(0, Math.min(20, look.bgBlur ?? 0))}px`);
  document.body.classList.toggle("has-bg", !!look.bg);
  showBackground(look.bg, still);
  // Embers belong to Molded and Classic: a living style's own background replaces them, and so does yours.
  setEmbers(look.embers !== false && !still && !style.living && !look.bg);
  setLiveBg(style.living && !look.bg ? style.id : null, still);
  try {
    localStorage.setItem("prestige-look", JSON.stringify(look));
  } catch {
    /* storage off: settings still apply it once they load */
  }
}

// ---------- your own background ----------
export const DEFAULT_DIM = 55;
const inTauri = "__TAURI_INTERNALS__" in window;
const reduced = matchMedia("(prefers-reduced-motion: reduce)");
/** Outside the app (a browser preview) a picked file only lives for this session. */
const sessionBgs = new Map<string, string>();
const isVideo = (name: string) => /[.](mp4|webm)$/i.test(name);
let shownBg = "";

/** Puts your background (a picture or a video, cover-fit) behind everything, or takes it away. */
async function showBackground(name: string | undefined, still: boolean) {
  let box = document.getElementById("user-bg");
  if (!name) {
    box?.remove();
    shownBg = "";
    return;
  }
  if (!box) {
    box = document.createElement("div");
    box.id = "user-bg";
    box.setAttribute("aria-hidden", "true");
    document.body.prepend(box);
  }
  if (shownBg !== name) {
    shownBg = name;
    let src = sessionBgs.get(name);
    if (!src && inTauri) {
      const path = await invoke<string | null>("background_path", { name }).catch(() => null);
      if (path) src = convertFileSrc(path);
    }
    if (shownBg !== name) return; // picked another since
    if (!src) {
      box.remove();
      shownBg = "";
      return;
    }
    const el = document.createElement(isVideo(name) ? "video" : "img");
    if (el instanceof HTMLVideoElement) {
      el.muted = true;
      el.loop = true;
      el.playsInline = true;
      el.preload = "auto";
    } else el.alt = "";
    el.src = src;
    box.replaceChildren(el);
  }
  // With the background still, a video shows its first frame.
  const v = box.querySelector("video");
  if (v) {
    if (still) {
      v.pause();
      if (v.currentTime > 0) v.currentTime = 0;
    } else v.play().catch(() => {});
  }
}

/** Copies a picked picture or video into the app data folder, and returns its stored name. */
async function storeBackground(file: File): Promise<string> {
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  if (!["jpg", "jpeg", "png", "webp", "gif", "avif", "mp4", "webm"].includes(ext)) {
    throw new Error("Pick a picture (JPG, PNG, WebP, GIF, AVIF) or a video (MP4, WebM).");
  }
  if (file.size > 1024 ** 3) throw new Error("That file is over 1 GB; pick a smaller one.");
  if (!inTauri) {
    const name = `bg-local${sessionBgs.size}.${ext}`;
    sessionBgs.set(name, URL.createObjectURL(file));
    return name;
  }
  return invoke<string>("background_set", new Uint8Array(await file.arrayBuffer()), { headers: { "x-ext": ext } });
}

/** The look from the last run, applied before settings load so the launch screen isn't the wrong colour. */
export function applyCachedLook() {
  let look: Look = {};
  try {
    look = JSON.parse(localStorage.getItem("prestige-look") || "{}");
  } catch {
    /* none yet */
  }
  applyLook(look);
}

// ---------- the Appearance part of Settings ----------
const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector(s) as T;
let draft: Look = {};
let saved: Look = {};

/** Fills the Appearance controls from the saved look (called each time Settings opens). */
export function openAppearance(look: Look | undefined) {
  saved = { ...(look ?? {}) };
  draft = { ...saved };
  renderAppearance();
}

/** The dialog closed: keep the draft (returned, to be saved) or put the saved look back. */
export function closeAppearance(keep: boolean): Look {
  const look = keep ? draft : saved;
  applyLook(look);
  // Backgrounds picked and then not kept are deleted.
  if (inTauri) invoke("background_prune", { keep: look.bg ?? null }).catch(() => {});
  return keep ? { ...draft } : saved;
}

function update(change: Partial<Look>) {
  draft = { ...draft, ...change };
  applyLook(draft);
  renderAppearance();
}

function renderAppearance() {
  const box = $("#look-presets");
  const { accent, trim } = colorsOf(draft);
  const cur = draft.theme ?? "dragon";
  const style = STYLES.find((s) => s.id === styleOf(draft))!;
  box.innerHTML = "";
  // The seven themes, the picked style's own colours (if it has them), and your own.
  const shown = PRESETS.filter((p) => !p.style || p.id === style.theme || p.id === cur);
  for (const p of [...shown, { id: "custom", name: "Custom", accent, trim }]) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `look-swatch${p.id === cur ? " on" : ""}`;
    b.title = p.id === "custom" ? "Your own colours: pick them below" : "style" in p && p.style ? `${p.name}: the colours made for this style` : `${p.name} theme`;
    b.innerHTML = `<i></i><span></span>`;
    (b.firstElementChild as HTMLElement).style.background = `linear-gradient(135deg, ${p.accent} 0 50%, ${p.trim} 50% 100%)`;
    b.lastElementChild!.textContent = p.name;
    b.addEventListener("click", () => update(p.id === "custom" ? { theme: "custom", accent, trim } : { theme: p.id }));
    box.appendChild(b);
  }
  ($("#look-accent") as HTMLInputElement).value = accent;
  ($("#look-trim") as HTMLInputElement).value = trim;
  const g = draft.glow ?? DEFAULT_GLOW;
  ($("#look-glow") as HTMLInputElement).value = String(g);
  $("#look-glow-val").textContent = g === 0 ? "Off" : `${g}%`;
  ($("#look-embers") as HTMLInputElement).checked = draft.embers !== false;
  ($("#look-emotes") as HTMLInputElement).checked = draft.emotes !== false;
  const styles = $("#look-styles");
  const curStyle = styleOf(draft);
  styles.innerHTML = "";
  for (const st of STYLES) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `look-swatch look-style${st.id === curStyle ? " on" : ""}`;
    b.dataset.style = st.id;
    b.title = st.about;
    b.setAttribute("aria-pressed", String(st.id === curStyle));
    b.innerHTML = `<i></i><span></span>`;
    b.lastElementChild!.textContent = st.name;
    const own = PRESETS.find((p) => p.id === st.theme);
    if (own) (b.firstElementChild as HTMLElement).style.background = `radial-gradient(circle at 50% 50%, ${own.accent} 0 22%, ${own.exact!.panel} 26% 100%)`;
    // A living style comes with its own colours; going back to Molded or Classic leaves a style's colours behind.
    const fromStyle = PRESETS.find((p) => p.id === draft.theme)?.style;
    const theme = st.theme ?? (fromStyle ? undefined : draft.theme);
    b.addEventListener("click", () => update({ style: st.id === STYLES[0].id ? undefined : st.id, molded: undefined, theme }));
    styles.appendChild(b);
  }
  ($("#look-motion") as HTMLInputElement).checked = draft.motion !== false;
  const dim = draft.bgDim ?? DEFAULT_DIM;
  const blur = draft.bgBlur ?? 0;
  ($("#look-bg-dim") as HTMLInputElement).value = String(dim);
  $("#look-bg-dim-val").textContent = `${dim}%`;
  ($("#look-bg-blur") as HTMLInputElement).value = String(blur);
  $("#look-bg-blur-val").textContent = blur ? `${blur} px` : "Off";
  $("#look-bg-clear").hidden = !draft.bg;
  $("#look-bg-tune").hidden = !draft.bg;
  $("#look-bg-pick").textContent = draft.bg ? "Choose another…" : "Choose a picture or video…";
  $("#look-bg-what").textContent = draft.bg ? (isVideo(draft.bg) ? "Your video" : "Your picture") : `The style's own background`;
}

export function initAppearance() {
  // Picking a colour makes the theme "Custom", starting from the colours that were showing.
  const pick = (key: "accent" | "trim") => (e: Event) => {
    const { accent, trim } = colorsOf(draft);
    update({ theme: "custom", accent, trim, [key]: (e.target as HTMLInputElement).value });
  };
  $("#look-accent").addEventListener("input", pick("accent"));
  $("#look-trim").addEventListener("input", pick("trim"));
  $("#look-glow").addEventListener("input", (e) => update({ glow: Number((e.target as HTMLInputElement).value) }));
  $("#look-embers").addEventListener("change", (e) => update({ embers: (e.target as HTMLInputElement).checked ? undefined : false }));
  $("#look-emotes").addEventListener("change", (e) => update({ emotes: (e.target as HTMLInputElement).checked ? undefined : false }));
  $("#look-motion").addEventListener("change", (e) => update({ motion: (e.target as HTMLInputElement).checked ? undefined : false }));
  $("#look-bg-dim").addEventListener("input", (e) => update({ bgDim: Number((e.target as HTMLInputElement).value) }));
  $("#look-bg-blur").addEventListener("input", (e) => update({ bgBlur: Number((e.target as HTMLInputElement).value) || undefined }));
  const file = $("#look-bg-file") as HTMLInputElement;
  $("#look-bg-pick").addEventListener("click", () => file.click());
  file.addEventListener("change", async () => {
    const f = file.files?.[0];
    file.value = "";
    if (!f) return;
    const note = $("#look-bg-note");
    note.textContent = "Copying it into Prestige's folder…";
    try {
      update({ bg: await storeBackground(f) });
      note.textContent = "";
    } catch (e) {
      note.textContent = e instanceof Error ? e.message : String(e);
    }
  });
  $("#look-bg-clear").addEventListener("click", () => update({ bg: undefined }));
  $("#look-reset").addEventListener("click", () =>
    update({
      theme: undefined, accent: undefined, trim: undefined, glow: undefined, embers: undefined, emotes: undefined,
      style: undefined, molded: undefined, motion: undefined, bg: undefined, bgDim: undefined, bgBlur: undefined,
    }),
  );
}
