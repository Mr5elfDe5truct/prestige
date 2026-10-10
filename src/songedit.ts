// The song editor: work on a song that exists, a Prestige one or your own recording, with ACE-Step 1.5 (the
// Workstation's workstation_music node, workflows\ace-step-15-edit.api.json). Three jobs:
//   Redo a part: drag over a stretch of the song and it's made again, the rest kept as it was. Change its lines in
//     the lyrics to change the words, or leave them for a new take.
//   Extend: carry on from a point (the end, or earlier to leave out an ending) with up to 4 minutes more.
//   Cover: the same melody and structure in a new style, with the same or new lyrics.
// It asks here and studio.ts renders it in the queue like any other song.
import { audio } from "./speech";
import { SONG_BPMS, SONG_KEYS, SONG_LANGUAGES, SONG_METERS } from "./gensettings";

const $ = <T extends HTMLElement = HTMLElement>(s: string, r: ParentNode = document) => r.querySelector(s) as T;

export type EditTask = "repaint" | "extend" | "cover";

/** A song's tempo, key, meter and language, as its workflow had them. */
export interface SongMusic {
  bpm?: number;
  key?: string;
  meter?: string;
  language?: string;
}

/** The song to work on: a file in the gallery (path) or one picked from the PC (blob). */
export interface SongSource {
  name: string;
  url: string; // something the webview can play
  path?: string;
  blob?: Blob;
  style: string;
  lyrics: string;
  music?: SongMusic | null;
}

/** What the editor hands back to render. */
export interface SongEdit {
  task: EditTask;
  start: number; // repaint: the part, in seconds
  end: number;
  keepUntil: number; // extend: carry on from here (the song's length to keep all of it)
  add: number; // extend: seconds of new music
  strength: number; // cover: how much of the steps follow the original (0.3–1)
  style: string;
  lyrics: string;
  bpm: number;
  key: string;
  meter: string;
  language: string;
  seconds: number; // the new song's length
  source: number; // the original's length
  sourceLyrics: string; // the original's words
}

export const EXTEND_SECONDS = [15, 30, 45, 60, 90, 120, 180, 240];
/** The longest song an edit makes (ACE-Step 1.5 takes up to 10 minutes; 8 measured on an RTX 3060). */
export const EDIT_MAX_SECONDS = 480;

/* An edit on an RTX 3060 12 GB (no language model, 8 steps): a 60 s song redone or covered in 20–26 s and extended to
 * 90 s in 26–30 s, with the models loading each time. */
export const editSecs = (seconds: number) => 12 + 0.18 * seconds;

const fmt = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

let waveCache: { url: string; peaks: Float32Array; seconds: number } | null = null;

/** The song's loudness in `n` columns (for the waveform) and its length. */
async function peaksOf(url: string, blob: Blob | undefined, n: number) {
  if (waveCache?.url === url) return waveCache;
  const data = blob ? await blob.arrayBuffer() : await (await fetch(url)).arrayBuffer();
  let buf: AudioBuffer;
  try {
    buf = await audio().decodeAudioData(data);
  } catch {
    throw new Error("that file isn't audio Prestige can read (try an MP3, WAV or FLAC)");
  }
  const ch = buf.getChannelData(0);
  const step = Math.max(1, Math.floor(ch.length / n));
  const peaks = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let m = 0;
    for (let j = i * step, e = Math.min(ch.length, j + step); j < e; j += 16) m = Math.max(m, Math.abs(ch[j]));
    peaks[i] = m;
  }
  waveCache = { url, peaks, seconds: buf.duration };
  return waveCache;
}

/** Opens the editor on `task` and resolves with the edit (null when cancelled). */
export async function askSongEdit(src: SongSource, task: EditTask, toast: (m: string, k?: string) => void): Promise<SongEdit | null> {
  const dlg = $("#songedit") as HTMLDialogElement;
  const canvas = $("#se-wave") as HTMLCanvasElement;
  const player = $("#se-audio") as HTMLAudioElement;
  const style = $("#se-style") as HTMLInputElement;
  const lyrics = $("#se-lyrics") as HTMLTextAreaElement;
  const startIn = $("#se-start") as HTMLInputElement;
  const endIn = $("#se-end") as HTMLInputElement;
  const fromIn = $("#se-from") as HTMLInputElement;
  const addSel = $("#se-add") as HTMLSelectElement;
  const strength = $("#se-strength") as HTMLInputElement;
  const bpm = $("#se-bpm") as HTMLSelectElement;
  const key = $("#se-key") as HTMLSelectElement;
  const meter = $("#se-meter") as HTMLSelectElement;
  const lang = $("#se-lang") as HTMLSelectElement;
  const go = $("#se-go") as HTMLButtonElement;

  $("#se-name").textContent = src.name;
  player.src = src.url;
  let wave: Awaited<ReturnType<typeof peaksOf>>;
  try {
    wave = await peaksOf(src.url, src.blob, 600);
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e), "warn");
    return null;
  }
  const len = wave.seconds;
  if (len > EDIT_MAX_SECONDS + 1) {
    toast(`That's ${Math.round(len / 60)} minutes; the song editor takes up to ${EDIT_MAX_SECONDS / 60}.`, "warn");
    return null;
  }

  // The tempo, key and language: the song's own, or the nearest choices (the PC's own recordings have none).
  const fill = (sel: HTMLSelectElement, opts: [string, string][], v: string) => {
    sel.innerHTML = "";
    for (const [val, label] of opts) sel.appendChild(new Option(label, val));
    if (!opts.some(([x]) => x === v)) sel.appendChild(new Option(v, v));
    sel.value = v;
  };
  const m = src.music ?? {};
  fill(bpm, [...new Set([...SONG_BPMS, ...(m.bpm ? [m.bpm] : [])])].sort((a, b) => a - b).map((n) => [String(n), `${n} bpm`]), String(m.bpm ?? 120));
  fill(key, SONG_KEYS.map((k) => [k, k]), m.key ?? "C major");
  fill(meter, SONG_METERS, m.meter ?? "4");
  fill(lang, SONG_LANGUAGES, m.language ?? "en");
  $("#se-music-note").textContent = src.music
    ? "The song's own tempo, key and language. Keep them so the new part fits."
    : "Set these to match the song as near as you can: the new part follows them.";
  style.value = src.style;
  addSel.innerHTML = "";
  for (const s of EXTEND_SECONDS) addSel.appendChild(new Option(s < 60 ? `${s} s` : `${s / 60} min`, String(s)));
  addSel.value = "30";
  strength.value = "0.8";

  // The part to redo: a fifth of the song in the middle to start with.
  let sel = { a: Math.round(len * 0.4 * 10) / 10, b: Math.round(Math.min(len, len * 0.4 + Math.max(8, len / 5)) * 10) / 10 };
  let from = Math.round(len * 10) / 10;
  let mode: EditTask = task;
  // The lyrics box holds the whole song's for Redo and Cover, and only the new part's for Extend; each is kept while
  // switching between them.
  const words = { song: src.lyrics, extend: "" };

  const draw = () => {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    const c = canvas.getContext("2d")!;
    c.scale(dpr, dpr);
    const css = getComputedStyle(canvas);
    const fg = css.getPropertyValue("--fg").trim() || "#eee";
    const hi = css.getPropertyValue("--gold").trim() || "#d4a64a";
    const x = (t: number) => (t / len) * w;
    // The new part (redo, or the extension past the carry-on point) is shaded.
    c.fillStyle = hi + "33";
    if (mode === "repaint") c.fillRect(x(sel.a), 0, x(sel.b) - x(sel.a), h);
    if (mode === "extend") c.fillRect(x(from), 0, w - x(from), h);
    const n = wave.peaks.length;
    for (let i = 0; i < n; i++) {
      const t = (i / n) * len;
      const on = (mode === "repaint" && t >= sel.a && t <= sel.b) || (mode === "extend" && t >= from);
      c.fillStyle = on ? hi : mode === "extend" && t >= from ? fg + "44" : fg + "99";
      const v = Math.max(1, wave.peaks[i] * h * 0.9);
      c.fillRect((i / n) * w, (h - v) / 2, Math.max(1, w / n - 0.5), v);
    }
    // Where it's playing.
    if (!player.paused || player.currentTime > 0) {
      c.fillStyle = fg;
      c.fillRect(x(player.currentTime) - 0.5, 0, 1.5, h);
    }
  };

  const update = () => {
    for (const b of dlg.querySelectorAll<HTMLButtonElement>("#se-tabs button")) b.classList.toggle("on", b.dataset.task === mode);
    for (const el of dlg.querySelectorAll<HTMLElement>("[data-for]")) el.hidden = !el.dataset.for!.split(" ").includes(mode);
    startIn.value = sel.a.toFixed(1);
    endIn.value = sel.b.toFixed(1);
    fromIn.value = from.toFixed(1);
    const seconds = mode === "extend" ? from + Number(addSel.value) : len;
    const over = seconds > EDIT_MAX_SECONDS;
    go.disabled = over || (mode === "repaint" && sel.b - sel.a < 1) || !style.value.trim();
    go.textContent = mode === "repaint" ? "Redo this part" : mode === "extend" ? "Extend the song" : "Make the cover";
    $("#se-hint").textContent =
      mode === "repaint"
        ? `Drag over the part to redo (${fmt(sel.a)} to ${fmt(sel.b)}). Change its lines in the lyrics for new words, or leave them for a new take. The rest stays exactly as it is.`
        : mode === "extend"
          ? `Click where it should carry on from (${fmt(from)}${from < len - 0.5 ? `; the ${Math.round(len - from)} s after it are left out` : ", the end"}). The new part is sung from the lyrics below.`
          : "The same melody and structure in the style you give, with the lyrics below.";
    $("#se-est").textContent = over
      ? `That makes ${Math.round(seconds)} s; songs go up to ${EDIT_MAX_SECONDS / 60} minutes.`
      : `Makes a new ${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, "0")} song next to the original, in about ${Math.round(editSecs(seconds))} s on an RTX 3060.`;
    draw();
  };

  const setTask = (t: EditTask) => {
    words[mode === "extend" ? "extend" : "song"] = lyrics.value;
    mode = t;
    lyrics.value = words[t === "extend" ? "extend" : "song"];
    lyrics.placeholder = t === "extend" ? "[Bridge]\nWhat the new part sings (empty for music only)" : "[Verse]\n…";
    $("#se-lyrics-label").firstChild!.textContent = t === "extend" ? "Lyrics for the new part" : "Lyrics";
    update();
  };
  for (const b of dlg.querySelectorAll<HTMLButtonElement>("#se-tabs button")) b.onclick = () => setTask(b.dataset.task as EditTask);

  // Drag on the waveform to pick the part to redo; click to pick where an extension carries on from.
  const timeAt = (e: PointerEvent) => clamp(((e.clientX - canvas.getBoundingClientRect().left) / canvas.clientWidth) * len, 0, len);
  canvas.onpointerdown = (e) => {
    const t0 = Math.round(timeAt(e) * 10) / 10;
    if (mode === "cover") {
      player.currentTime = t0;
      return draw();
    }
    canvas.setPointerCapture(e.pointerId);
    if (mode === "extend") from = Math.max(1, t0);
    else sel = { a: t0, b: t0 };
    update();
    canvas.onpointermove = (ev) => {
      const t = Math.round(timeAt(ev) * 10) / 10;
      if (mode === "extend") from = Math.max(1, t);
      else sel = { a: Math.min(t0, t), b: Math.max(t0, t) };
      update();
    };
    canvas.onpointerup = () => {
      canvas.onpointermove = canvas.onpointerup = null;
      // A click without a drag in Redo selects 8 s from there.
      if (mode === "repaint" && sel.b - sel.a < 0.5) sel = { a: sel.a, b: Math.min(len, sel.a + 8) };
      player.currentTime = mode === "repaint" ? sel.a : Math.max(0, from - 5);
      update();
    };
  };
  startIn.onchange = () => {
    sel.a = clamp(Number(startIn.value) || 0, 0, len - 1);
    if (sel.b <= sel.a) sel.b = Math.min(len, sel.a + 8);
    update();
  };
  endIn.onchange = () => {
    sel.b = clamp(Number(endIn.value) || len, sel.a + 1, len);
    update();
  };
  fromIn.onchange = () => {
    from = clamp(Number(fromIn.value) || len, 1, len);
    update();
  };
  addSel.onchange = style.oninput = update;
  // Play the part being worked on: the selection, or the few seconds before the carry-on point.
  $("#se-play").onclick = () => {
    if (!player.paused) return player.pause();
    if (mode === "repaint" && (player.currentTime < sel.a || player.currentTime >= sel.b)) player.currentTime = sel.a;
    if (mode === "extend" && (player.currentTime < from - 8 || player.currentTime >= from)) player.currentTime = Math.max(0, from - 8);
    player.play();
  };
  let raf = 0;
  const tick = () => {
    if (mode === "repaint" && player.currentTime >= sel.b) player.pause();
    if (mode === "extend" && player.currentTime >= from) player.pause();
    draw();
    if (!player.paused) raf = requestAnimationFrame(tick);
  };
  player.onplay = () => {
    $("#se-play").textContent = "❚❚ Pause";
    raf = requestAnimationFrame(tick);
  };
  player.onpause = () => {
    $("#se-play").textContent = "▶ Play";
    cancelAnimationFrame(raf);
    draw();
  };

  lyrics.value = words[task === "extend" ? "extend" : "song"];
  setTask(task);
  dlg.returnValue = "";
  dlg.showModal();
  requestAnimationFrame(update); // the canvas has its size once it's shown
  const onResize = () => draw();
  window.addEventListener("resize", onResize);
  await new Promise((r) => dlg.addEventListener("close", r, { once: true }));
  window.removeEventListener("resize", onResize);
  player.pause();
  player.removeAttribute("src");
  if (dlg.returnValue !== "go") return null;
  return {
    task: mode,
    start: sel.a,
    end: sel.b,
    keepUntil: from,
    add: Number(addSel.value),
    strength: Number(strength.value),
    style: style.value.trim(),
    lyrics: lyrics.value.trim(),
    bpm: Number(bpm.value),
    key: key.value,
    meter: meter.value,
    language: lang.value,
    seconds: mode === "extend" ? from + Number(addSel.value) : len,
    source: len,
    sourceLyrics: src.lyrics,
  };
}
