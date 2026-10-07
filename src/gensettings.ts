// Generation settings for images, video and songs, shared by Studio and chat: shape and size, quality (steps),
// how many, seed, for video the resolution, length and frame rate, for a long video its shots and models, and for a
// song its length, tempo, key and language. The defaults are what the reference
// RTX 3060 12 GB renders comfortably; studio.ts turns them into workflow inputs and warns when a pick is
// likely to run past the VRAM of ComfyUI's card.

export type Quality = "draft" | "standard" | "high" | "max";
export type Aspect = "1:1" | "4:3" | "3:4" | "3:2" | "2:3" | "16:9" | "9:16";
export type ImgSize = "small" | "standard" | "large";

export interface ImageSettings {
  aspect: Aspect;
  size: ImgSize;
  quality: Quality;
  count: number;
  seed: number | null; // null = a new random seed each time
}
export interface VideoSettings {
  res: string; // "768x512", or "auto" (Wan: match the picture's shape)
  seconds: number;
  fps: number;
  quality: Quality;
  seed: number | null;
}
export interface LongSettings {
  size: number; // the longest side while rendering; the saved video is upscaled 2×
  frames: number; // per shot, 4n + 1
  shots: number; // 1–4, chained by SVI so each continues the last
  quality: Quality;
  seed: number | null;
  high: string | null; // the high- and low-noise models (null = the workflow's own), from ComfyUI's model folders
  low: string | null;
}
export interface MusicSettings {
  seconds: number; // the song's length
  bpm: number;
  key: string; // "C major", "A minor"…
  meter: string; // beats per bar: "4" (4/4), "3" (3/4), "6" (6/8), "2" (2/4)
  language: string; // the lyrics' language, as ACE-Step names it (en, es, ja…)
  seed: number | null;
}
export interface GenSettings {
  image: ImageSettings; // Qwen-Image-2.1 and its turbo, Z-Image-Turbo; edits use its quality and seed
  video: VideoSettings; // LTX text-to-video
  animate: VideoSettings; // Wan 2.2 image-to-video
  long: LongSettings; // Wan 2.2 SVI long video: several shots from one picture
  music: MusicSettings; // ACE-Step 1.5 songs
}
export type SettingsKey = keyof GenSettings;

export const DEFAULTS: GenSettings = {
  image: { aspect: "1:1", size: "standard", quality: "standard", count: 1, seed: null },
  video: { res: "768x512", seconds: 4, fps: 24, quality: "standard", seed: null },
  animate: { res: "auto", seconds: 5, fps: 16, quality: "standard", seed: null },
  long: { size: 640, frames: 49, shots: 4, quality: "standard", seed: null, high: null, low: null },
  music: { seconds: 120, bpm: 120, key: "C major", meter: "4", language: "en", seed: null },
};

export const ASPECTS: [Aspect, string][] = [
  ["1:1", "Square 1:1"],
  ["4:3", "Landscape 4:3"],
  ["3:2", "Landscape 3:2"],
  ["16:9", "Wide 16:9"],
  ["3:4", "Portrait 3:4"],
  ["2:3", "Portrait 2:3"],
  ["9:16", "Tall 9:16"],
];
// Megapixels per size: Large is Qwen-Image's native 1328².
const AREA: Record<ImgSize, number> = { small: 768 * 768, standard: 1024 * 1024, large: 1328 * 1328 };
export const SIZES: [ImgSize, string][] = [
  ["small", "Small"],
  ["standard", "Standard"],
  ["large", "Large"],
];
export const QUALITY_NAMES: Record<Quality, string> = { draft: "Draft", standard: "Standard", high: "High", max: "Max" };

// LTX renders at half size and upscales 2×, so both halves must be multiples of 32.
export const LTX_RES: [string, string][] = [
  ["768x512", "768 × 512 · 3:2"],
  ["512x768", "512 × 768 · 2:3 portrait"],
  ["1024x576", "1024 × 576 · 16:9"],
  ["576x1024", "576 × 1024 · 9:16 tall"],
  ["640x640", "640 × 640 · square"],
  ["960x640", "960 × 640 · 3:2 large"],
  ["1280x704", "1280 × 704 · 16:9 HD"],
];
export const WAN_RES: [string, string][] = [
  ["auto", "Match the picture"],
  ["832x480", "832 × 480 · landscape"],
  ["480x832", "480 × 832 · portrait"],
  ["640x640", "640 × 640 · square"],
  ["1280x720", "1280 × 720 · 720p"],
];
// Wan 2.2 SVI: the longest side while rendering, frames per shot and the number of shots.
export const SVI_SIZES = [480, 640, 832];
export const SVI_FRAMES = [33, 49, 65, 81];
export const SVI_SHOTS = [1, 2, 3, 4];
/** The SVI workflow plays its frames at 24 fps, then doubles them to 48 with FILM; shots overlap by 5 frames. */
export const SVI_FPS = 24;
export const SVI_OVERLAP = 5;
export const sviSeconds = (frames: number, shots: number) => Math.round(((frames * shots - SVI_OVERLAP * (shots - 1)) / SVI_FPS) * 10) / 10;
export const LTX_SECONDS = [2, 3, 4, 5, 6, 8, 10];
export const WAN_SECONDS = [2, 3, 4, 5, 6, 8];
export const LTX_FPS = [24, 25, 30];

// ACE-Step 1.5 songs: length, tempo, key, meter and the lyrics' language (the codes its text encoder takes).
export const SONG_SECONDS = [30, 60, 90, 120, 150, 180, 240];
export const SONG_BPMS = [70, 80, 90, 100, 110, 120, 128, 140, 160, 174];
export const SONG_KEYS = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"].flatMap((r) => [`${r} major`, `${r} minor`]);
export const SONG_METERS: [string, string][] = [
  ["4", "4/4"],
  ["3", "3/4 (waltz)"],
  ["6", "6/8"],
  ["2", "2/4"],
];
export const SONG_LANGUAGES: [string, string][] = [
  ["en", "English"],
  ["es", "Spanish"],
  ["fr", "French"],
  ["de", "German"],
  ["it", "Italian"],
  ["pt", "Portuguese"],
  ["nl", "Dutch"],
  ["sv", "Swedish"],
  ["pl", "Polish"],
  ["ru", "Russian"],
  ["uk", "Ukrainian"],
  ["tr", "Turkish"],
  ["ar", "Arabic"],
  ["hi", "Hindi"],
  ["ja", "Japanese"],
  ["ko", "Korean"],
  ["zh", "Chinese"],
  ["yue", "Cantonese"],
  ["vi", "Vietnamese"],
  ["th", "Thai"],
  ["id", "Indonesian"],
];

/** Width and height for an image setting, multiples of 16. */
export function imageDims(aspect: Aspect, size: ImgSize): [number, number] {
  const [a, b] = aspect.split(":").map(Number);
  const w = Math.sqrt((AREA[size] * a) / b);
  const r16 = (x: number) => Math.max(256, Math.round(x / 16) * 16);
  return [r16(w), r16((w * b) / a)];
}

export const parseRes = (r: string): [number, number] => {
  const [w, h] = r.split("x").map(Number);
  return [w || 768, h || 512];
};

/** Wan's size for "Match the picture": landscape, portrait or square from the source image's shape. */
export function wanAuto(srcW?: number | null, srcH?: number | null): [number, number] {
  const r = srcW && srcH ? srcW / srcH : 16 / 9;
  return r > 1.2 ? [832, 480] : r < 0.83 ? [480, 832] : [640, 640];
}

/** LTX frame counts are 8n + 1. */
export const ltxFrames = (seconds: number, fps: number) => Math.max(1, Math.round((seconds * fps) / 8)) * 8 + 1;
/** Wan renders at 16 fps and needs 4n + 1 frames. */
export const wanFrames = (seconds: number) => Math.max(1, Math.round((seconds * 16) / 4)) * 4 + 1;

// ---------- storage ----------
const KEY = "prestige.genSettings";
const LAST_KEY = "prestige.lastSeeds";
let current: GenSettings = load();
let lastSeeds: Partial<Record<SettingsKey, number>> = loadJson(LAST_KEY) ?? {};
const listeners = new Set<() => void>();

function loadJson(k: string): any {
  try {
    const t = localStorage.getItem(k);
    return t ? JSON.parse(t) : null;
  } catch {
    return null;
  }
}

/** The saved picks over the defaults, dropping any that aren't valid: a wrong type, NaN, or a choice that doesn't
 *  exist. 0.15.0 and 0.16.0 saved an image's size as null, which rendered as width and height null. */
function sane<T extends object>(defaults: T, saved: any, valid: Partial<Record<keyof T, (v: any) => boolean>> = {}): T {
  const out: any = { ...defaults };
  for (const [k, d] of Object.entries(defaults)) {
    const v = saved?.[k];
    if (v === undefined) continue;
    const finite = typeof v !== "number" || Number.isFinite(v);
    // A null default (seed, the long video's models) takes null, a number or a string; others need their own type.
    const typeOk = v === null ? d === null : finite && (d === null ? typeof v === "number" || typeof v === "string" : typeof v === typeof d);
    const check = valid[k as keyof T];
    if (typeOk && (v === null || !check || check(v))) out[k] = v;
  }
  return out;
}

// A function declaration: load() runs as this module initialises, before later consts exist.
function isQuality(v: any) {
  return v in QUALITY_NAMES;
}

function load(): GenSettings {
  const s = loadJson(KEY) ?? {};
  return {
    image: sane(DEFAULTS.image, s.image, {
      aspect: (v) => ASPECTS.some(([a]) => a === v),
      size: (v) => v in AREA,
      quality: isQuality,
      count: (v) => v >= 1,
    }),
    video: sane(DEFAULTS.video, s.video, { quality: isQuality, seconds: (v) => v > 0, fps: (v) => v > 0 }),
    animate: sane(DEFAULTS.animate, s.animate, { quality: isQuality, seconds: (v) => v > 0 }),
    long: sane(DEFAULTS.long, s.long, { quality: isQuality, size: (v) => v > 0, frames: (v) => v > 0, shots: (v) => v >= 1 }),
    music: sane(DEFAULTS.music, s.music, {
      seconds: (v) => v > 0,
      bpm: (v) => v >= 30 && v <= 300,
      key: (v) => SONG_KEYS.includes(v),
      meter: (v) => SONG_METERS.some(([m]) => m === v),
      language: (v) => SONG_LANGUAGES.some(([c]) => c === v),
    }),
  };
}

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
    localStorage.setItem(LAST_KEY, JSON.stringify(lastSeeds));
  } catch {}
  listeners.forEach((f) => f());
}

export const settings = () => current;

export function update<K extends SettingsKey>(k: K, patch: Partial<GenSettings[K]>) {
  current = { ...current, [k]: { ...current[k], ...patch } };
  save();
}

export function reset(k: SettingsKey) {
  // The long video's model picks aren't sizes or quality: they stay.
  const keep = k === "long" ? { high: current.long.high, low: current.long.low } : {};
  current = { ...current, [k]: { ...DEFAULTS[k], ...keep } };
  save();
}

/** Runs whenever a setting changes, so Studio and chat show the same picks. */
export function onSettingsChange(f: () => void) {
  listeners.add(f);
}

export const lastSeed = (k: SettingsKey) => lastSeeds[k];

/** The seed to render with: the fixed one, or a new random one. Remembered so it can be reused. */
export function takeSeed(k: SettingsKey): number {
  const s = current[k].seed ?? Math.floor(Math.random() * 2 ** 32);
  lastSeeds = { ...lastSeeds, [k]: s };
  save();
  return s;
}

/** "about 40 s", "about 2.5 min". */
export function aboutTime(secs: number) {
  if (secs < 55) return `about ${Math.max(5, Math.round(secs / 5) * 5)} s`;
  const min = secs / 60;
  return `about ${min < 10 ? Math.round(min * 2) / 2 : Math.round(min)} min`;
}
