// Appearance: the colour theme (a preset, or your own accent and trim colours), how strongly things glow, the ember
// drift behind the app, emote reactions and the molded surfaces (mesa.ts). Changes show at once while Settings is open; Cancel puts them back.
// The look is also kept in this window's local storage, so the launch screen already has it before settings load.
import { setEmbers } from "./embers";

export interface Look {
  theme?: string; // a preset id, or "custom"
  accent?: string; // custom accent (the "signal" colour: buttons, the eye, rings)
  trim?: string; // custom trim (the "metal" colour: the mark, names, highlights)
  glow?: number; // glow and bloom, 0 (off) to 150 (%)
  embers?: boolean; // false = no ember drift
  emotes?: boolean; // false = no emote reactions
  molded?: boolean; // false = flat panels instead of the molded (Mesa) surfaces
}

interface Preset {
  id: string;
  name: string;
  accent: string;
  trim: string;
  /** Exact surface colours (Dragon keeps its original palette); the others are worked out from the accent. */
  exact?: Record<string, string>;
}

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
  document.body.classList.toggle("mesa", look.molded !== false);
  setEmbers(look.embers !== false);
  try {
    localStorage.setItem("prestige-look", JSON.stringify(look));
  } catch {
    /* storage off: settings still apply it once they load */
  }
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
  applyLook(keep ? draft : saved);
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
  box.innerHTML = "";
  for (const p of [...PRESETS, { id: "custom", name: "Custom", accent, trim }]) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `look-swatch${p.id === cur ? " on" : ""}`;
    b.title = p.id === "custom" ? "Your own colours: pick them below" : `${p.name} theme`;
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
  ($("#look-molded") as HTMLInputElement).checked = draft.molded !== false;
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
  $("#look-molded").addEventListener("change", (e) => update({ molded: (e.target as HTMLInputElement).checked ? undefined : false }));
  $("#look-reset").addEventListener("click", () =>
    update({ theme: undefined, accent: undefined, trim: undefined, glow: undefined, embers: undefined, emotes: undefined, molded: undefined }),
  );
}
