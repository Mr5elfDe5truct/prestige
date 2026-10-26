// Film: a short film or a music video made the way an editor works (after Blizaine's Maestro). Each film is a project
// of its own in the app data folder (store\film-<id>.json, listed in store\films.json), in four steps:
//  1. Cast: Characters (their face and voice), or any picture as a cast member with a name.
//  2. Plan: the chat model writes it. A short film is shots with who's in each, what happens and what's said; a music
//     video is the Director's plan (director.ts), a song and 5-second shots. Every word of it can be changed after.
//  3. Shots: one card per shot. Draw its frame (a cast member's picture put in the scene with Qwen-Image), then shoot
//     it (LTX-2.5 with sound, from the frame), take it again with a new seed, make a long take (Wan 2.2 SVI), swap a
//     cast member into it or into a clip of your own (SCAIL-2), sharpen it to 1080p (SeedVR2), give it sound (LTX-2.3
//     Foley) or lip-sync a close-up (InfiniteTalk). Each goes through Studio's render queue, one model at a time with
//     the chat model unloaded first; every result is kept as a take, and the one picked is the one the film uses.
//  4. Timeline: the picked takes in order with title cards, trimmed, cut or crossfaded, over the clips' sound, the
//     dialogue (each line spoken in its cast member's voice by Kokoro or VoxCPM2) and a music bed, exported to MP4 by
//     ffmpeg (film.rs). "Send back" on a clip opens its shot; a new take there lands in the same place on the timeline.
// There's no Extend: none of the workflows carries a clip on past its end (Wan SVI's long take starts from a picture).
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { errMsg, streamChat, type ModelInfo } from "./backends";
import { characterById, characters, faceBlob, onCharactersChange } from "./characters";
import { SHOT_SECONDS, planVideo } from "./director";
import { aboutTime } from "./gensettings";
import { CONSENT, loadReference } from "./reference";
import { listVoices, synthesize } from "./speech";
import {
  allowRenders,
  askLine,
  cancelFilm,
  filmTools,
  longTake,
  refreshCreate,
  renderCastFrame,
  renderFrame,
  renderLongTake,
  renderShot,
  renderSong,
  renderTalk,
  shotSecs,
  soundClip,
  soundClipSecs,
  swapClip,
  swapClipSecs,
  upscaleClip,
  upscaleClipSecs,
} from "./studio";

const $ = <T extends HTMLElement = HTMLElement>(s: string, r: ParentNode = document) => r.querySelector(s) as T;
const $$ = <T extends HTMLElement = HTMLElement>(s: string, r: ParentNode = document) => Array.from(r.querySelectorAll(s)) as T[];
const inTauri = "__TAURI_INTERNALS__" in window;

export type FilmKind = "short" | "music";

interface Member {
  id: string;
  name: string;
  character?: string; // a Character's id: its face and voice
  picture?: string; // a picture of them in the film's folder (a cast member who isn't a Character)
  voice?: string; // a Kokoro voice or "vox:<name>"; a Character's own when not set
  looks: string; // how they look, for shots made from text
}

interface Line {
  id: string;
  who: string; // a cast member's id
  text: string;
  audio?: string; // the spoken line in the film's folder
  said?: string; // the voice and text it was spoken from, to tell when it's out of date
  secs?: number;
}

type TakeHow = "shot" | "long" | "swap" | "upscale" | "sound" | "talk";

interface Take {
  id: string;
  path: string;
  how: TakeHow;
  note: string; // what made it: "LTX-2.5 from the frame", "Mara swapped in"
  seconds: number;
  took: number; // seconds it took to render
  made: number;
}

interface Shot {
  id: string;
  action: string;
  seconds: number;
  cast: string[]; // the members in it
  lines: Line[];
  frame?: string;
  framePrompt?: string;
  takes: Take[];
  pick?: string; // the take the film uses
}

/** A piece of the timeline: a shot (its picked take, trimmed) or a title card. `fade`: crossfades in from the one
 *  before. `volume`: the clip's own sound. */
interface Clip {
  id: string;
  shot?: string;
  title?: string;
  seconds: number; // a title card's length
  in: number;
  out: number; // 0: to the end of the take
  fade: boolean;
  volume: number;
}

interface Song {
  title: string;
  style: string;
  bpm?: number;
  key?: string;
  language?: string;
  lyrics: string;
  seconds: number;
  path?: string;
}

interface Film {
  id: string;
  name: string;
  kind: FilmKind;
  idea: string;
  seconds: number; // the length asked of the plan
  look: string;
  cast: Member[];
  shots: Shot[];
  clips: Clip[];
  song?: Song;
  bed?: { path: string; volume: number }; // a music bed of your own (a music video's is its song)
  bedVolume: number;
  lineVolume: number;
  size: string;
  draft: boolean;
  exports: string[];
  created: number;
  updated: number;
}

interface Entry {
  id: string;
  name: string;
  kind: FilmKind;
  updated: number;
}

interface Deps {
  toast: (msg: string, kind?: "warn") => void;
  root: () => string | null;
  /** The chat model that plans films. */
  model: () => ModelInfo | undefined;
  /** Prestige's own voice, for a cast member with none. */
  voice: () => string;
  /** Opens a take or an export in Studio's viewer. */
  openRender: (path: string) => void;
}

/** A shot is 2 to 10 seconds (LTX-2.5's lengths); a short film is planned at up to 3 minutes. */
const SHOT_MIN = 2;
const SHOT_MAX = 10;
const SHORT_LENGTHS = [30, 45, 60, 90, 120, 180];
const MUSIC_LENGTHS = [15, 20, 30, 45, 60];
const MAX_SHOTS = 40;
/** Speech is about 2.6 words a second; lines are asked for at a little less so they fit their shot. */
const WORDS_A_SECOND = 2.4;
/** A shot's lines start this far in, with this much between them. */
const LINE_START = 0.3;
const LINE_GAP = 0.25;
/** As in film.rs. */
const FADE = 0.5;
/* Measured on the RTX 3060 12 GB: planning a 3-shot short film with Qwen3.6 35B on llama.cpp took 247 s, loading it included;
 * three 3:2 frames with a cast member in them (Qwen-Image with the reference) took ~285 s in all, the first one loading the
 * model; a frame from text alone is the image model's own time (not measured here). */
const PLAN_SECS = 240;
const FRAME_SECS = { cast: 90, text: 30 };

let deps: Deps;
let entries: Entry[] = [];
let film: Film | null = null;
let tab: "cast" | "plan" | "shots" | "cut" = "cast";
let newKind: FilmKind = "short";
let saveTimer: number | undefined;
let planning: AbortController | null = null;
let exporting = false;
let voicing = false;
let songJob: { pct: number; label: string } | null = null;
/** What each shot has in the render queue: the step, how far along. */
const jobs = new Map<string, { what: string; pct: number; label: string; started?: number }>();
let selected: string | null = null; // the timeline clip being changed
let pps = 28; // the timeline's pixels a second
let tools = { long: false, swap: false, upscale: false, sound: false, talk: false };
let voices: string[] = [];
const thumbs = new Map<string, string>();

const newId = () => Math.random().toString(36).slice(2, 10).padEnd(8, "0");
const esc = (t: string) => t.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
const clamp = (n: number, a: number, b: number) => Math.min(b, Math.max(a, n));
const member = (id: string) => film?.cast.find((m) => m.id === id);
const shotOf = (id?: string) => film?.shots.find((s) => s.id === id);
const pickOf = (sh?: Shot) => sh?.takes.find((t) => t.id === sh.pick) ?? sh?.takes[sh.takes.length - 1];
const fmtS = (s: number) => (s < 60 ? `${Math.round(s * 10) / 10} s` : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`);

// ---------- saving ----------

async function loadEntries() {
  try {
    const v = inTauri ? await invoke<Entry[] | null>("store_get", { name: "films" }) : null;
    entries = Array.isArray(v) ? v : [];
  } catch {
    entries = [];
  }
}

function persist() {
  if (!film) return;
  film.updated = Date.now();
  const f = film;
  const e = entries.find((x) => x.id === f.id);
  if (e) Object.assign(e, { name: f.name, kind: f.kind, updated: f.updated });
  else entries.unshift({ id: f.id, name: f.name, kind: f.kind, updated: f.updated });
  entries.sort((a, b) => b.updated - a.updated);
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(async () => {
    try {
      await invoke("store_set", { name: `film-${f.id}`, value: f });
      await invoke("store_set", { name: "films", value: entries });
    } catch (err) {
      deps.toast(`Couldn't save the film: ${errMsg(err)}`, "warn");
    }
    refreshCreate();
  }, 400);
}

/** A file of the film's, saved in its folder (data\comfy-output\film.frames\<id>). */
async function writeFile(name: string, blob: Blob): Promise<string> {
  const body = new Uint8Array(await blob.arrayBuffer());
  return invoke<string>("film_write", body, { headers: { "x-film": film!.id, "x-name": name, "x-root": encodeURIComponent(deps.root() ?? "") } });
}

// ---------- Studio's Film tab ----------

/** The chips under Studio's prompt in Film mode: what a new film will be, and the saved films. */
function opts(): string {
  const kind = `<button type="button" class="opt pick film-kind" title="What a new film is">${newKind === "short" ? "<b>Short film</b> ⇄" : "<b>Music video</b> ⇄"}</button>`;
  const list = entries
    .slice(0, 14)
    .map((e) => `<button type="button" class="opt pick film-open" data-id="${e.id}" title="${e.kind === "music" ? "Music video" : "Short film"} · changed ${new Date(e.updated).toLocaleString()}">🎞 ${esc(e.name)}</button>`)
    .join("");
  return kind + (list || `<span class="opt">no films yet</span>`);
}

function click(el: HTMLElement) {
  if (el.closest(".film-kind")) {
    newKind = newKind === "short" ? "music" : "short";
    return refreshCreate();
  }
  const open = el.closest<HTMLElement>(".film-open");
  if (open?.dataset.id) openFilm(open.dataset.id);
}

/** A new film from Studio's prompt: with an idea it opens on the plan and starts planning; without, on the cast. */
async function create(idea: string) {
  if (!inTauri) return deps.toast("Films are made in the desktop app.");
  const kind: FilmKind = /\bmusic[\s-]?video\b/i.test(idea) ? "music" : newKind;
  const f: Film = {
    id: newId(),
    name: idea ? idea.replace(/\s+/g, " ").slice(0, 48) : `Film ${entries.length + 1}`,
    kind,
    idea,
    seconds: kind === "music" ? 30 : 60,
    look: "",
    cast: [],
    shots: [],
    clips: [],
    bedVolume: kind === "music" ? 1 : 0.3,
    lineVolume: 1,
    size: "768x512",
    draft: false,
    exports: [],
    created: Date.now(),
    updated: Date.now(),
  };
  // A length in the idea ("a 2 minute film") is the plan's.
  const m = idea.match(/(\d+(?:\.\d+)?)\s*(s|secs?|seconds?|min(?:ute)?s?)\b/i);
  if (m) {
    const n = Number(m[1]) * (/^m/i.test(m[2]) ? 60 : 1);
    const lengths = kind === "music" ? MUSIC_LENGTHS : SHORT_LENGTHS;
    f.seconds = lengths.reduce((a, b) => (Math.abs(b - n) < Math.abs(a - n) ? b : a));
  }
  film = f;
  jobs.clear();
  persist();
  await show(idea ? "plan" : "cast");
  if (idea) plan();
}

async function openFilm(id: string) {
  if (film?.id !== id) {
    const f = await invoke<Film | null>("store_get", { name: `film-${id}` }).catch(() => null);
    if (!f) {
      entries = entries.filter((e) => e.id !== id);
      refreshCreate();
      return deps.toast("That film isn't there any more.", "warn");
    }
    film = f;
    jobs.clear();
    selected = null;
  }
  show(film.shots.length ? "shots" : "cast");
}

// ---------- the sheet ----------

export function initFilm(d: Deps) {
  deps = d;
  loadEntries().then(refreshCreate);
  onCharactersChange(() => film && tab === "cast" && renderCast());
  const dlg = $("#film") as HTMLDialogElement;
  $("#fm-close").addEventListener("click", () => dlg.close());
  $$("#fm-tabs [data-tab]").forEach((b) => b.addEventListener("click", () => show(b.dataset.tab as typeof tab)));
  $("#fm-name").addEventListener("input", (e) => {
    if (!film) return;
    film.name = (e.target as HTMLInputElement).value.trim() || "Untitled film";
    persist();
  });
  // Deleting asks by changing the button first: a second click within 4 s deletes.
  let armed = 0;
  $("#fm-delete").addEventListener("click", async () => {
    if (!film) return;
    const b = $("#fm-delete");
    if (Date.now() - armed > 4000) {
      armed = Date.now();
      b.textContent = "Click again to delete";
      setTimeout(() => (b.textContent = "Delete film"), 4000);
      return;
    }
    const id = film.id;
    cancelFilm();
    film = null;
    entries = entries.filter((e) => e.id !== id);
    dlg.close();
    try {
      await invoke("store_delete", { name: `film-${id}` });
      await invoke("store_set", { name: "films", value: entries });
      await invoke("film_remove", { root: deps.root(), film: id });
    } catch (e) {
      deps.toast(`Couldn't delete all of the film: ${errMsg(e)}`, "warn");
    }
    refreshCreate();
  });
  initCast();
  initPlan();
  initShots();
  initCut();
  initSwap();
}

let showing = 0;
async function show(t: typeof tab) {
  if (!film) return;
  tab = t;
  // A tab clicked while this one was getting ready wins.
  const me = ++showing;
  await allowRenders().catch(() => {});
  tools = await filmTools().catch(() => tools);
  if (me !== showing || !film) return;
  ($("#fm-name") as HTMLInputElement).value = film.name;
  $$("#fm-tabs [data-tab]").forEach((b) => b.classList.toggle("on", b.dataset.tab === t));
  $$("#film .fm-page").forEach((p) => (p.hidden = p.dataset.page !== t));
  if (t === "cast") renderCast();
  if (t === "plan") renderPlan();
  if (t === "shots") renderShots();
  if (t === "cut") renderCut();
  status();
  const dlg = $("#film") as HTMLDialogElement;
  if (!dlg.open) dlg.showModal();
}

/** The line at the bottom: what's rendering for this film. */
function status() {
  if (!film) return;
  const busy = [...jobs.entries()].map(([id, j]) => {
    const i = film!.shots.findIndex((s) => s.id === id);
    return `Shot ${i + 1}: ${j.what} · ${j.label}`;
  });
  if (songJob) busy.unshift(`The song · ${songJob.label}`);
  if (planning) busy.unshift("Planning…");
  if (voicing) busy.push("Voicing the lines…");
  if (exporting) busy.push("Exporting…");
  $("#fm-status").textContent = busy.length ? busy.join("   ·   ") : `${film.kind === "music" ? "Music video" : "Short film"} · ${film.shots.length} shots · ${film.cast.length} in the cast`;
}

// ---------- 1. cast ----------

function initCast() {
  const add = $("#fm-add-char") as HTMLSelectElement;
  add.addEventListener("change", () => {
    const c = characterById(add.value);
    add.value = "";
    if (!film || !c) return;
    if (film.cast.some((m) => m.character === c.id)) return deps.toast(`${c.name} is already in the cast.`);
    film.cast.push({ id: newId(), name: c.name, character: c.id, looks: "" });
    persist();
    renderCast();
  });
  const file = $("#fm-pic-file") as HTMLInputElement;
  $("#fm-add-pic").addEventListener("click", () => file.click());
  file.addEventListener("change", async () => {
    const f = file.files?.[0];
    file.value = "";
    if (!f || !film) return;
    try {
      // Scaled to at most 2048 px and kept as a JPEG, as a reference picture is.
      const r = await loadReference(f);
      URL.revokeObjectURL(r.url);
      const id = newId();
      const picture = await writeFile(`cast-${id}.jpg`, r.blob);
      const name = f.name.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").slice(0, 30) || "New cast member";
      film.cast.push({ id, name, picture, looks: "" });
      persist();
      renderCast();
    } catch (e) {
      deps.toast(`Couldn't add the picture: ${errMsg(e)}`, "warn");
    }
  });
  const list = $("#fm-cast");
  list.addEventListener("input", (e) => {
    const el = e.target as HTMLInputElement;
    const m = member((el.closest(".fm-member") as HTMLElement | null)?.dataset.id ?? "");
    if (!m || !el.dataset.k) return;
    if (el.dataset.k === "name") m.name = el.value.trim() || "Unnamed";
    if (el.dataset.k === "looks") m.looks = el.value;
    if (el.dataset.k === "voice") m.voice = el.value || undefined;
    persist();
  });
  list.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-act]");
    const m = member((b?.closest(".fm-member") as HTMLElement | null)?.dataset.id ?? "");
    if (!film || !b || !m || b.dataset.act !== "remove") return;
    film.cast = film.cast.filter((x) => x !== m);
    for (const sh of film.shots) {
      sh.cast = sh.cast.filter((x) => x !== m.id);
      sh.lines = sh.lines.filter((l) => l.who !== m.id);
    }
    persist();
    renderCast();
  });
  listVoices()
    .then((v) => (voices = [...v.kokoro, ...v.vox.map((x) => `vox:${x}`)]))
    .catch(() => {});
}

/** A cast member's picture: their Character's face, or the one added. */
function pictureUrl(m: Member): string {
  const c = characterById(m.character);
  if (c?.face) return `data:image/jpeg;base64,${c.face}`;
  return m.picture ? convertFileSrc(m.picture) : "";
}

async function pictureBlob(m: Member): Promise<Blob | null> {
  const c = characterById(m.character);
  if (c?.face) return faceBlob(c);
  if (!m.picture) return null;
  return fetch(convertFileSrc(m.picture))
    .then((r) => (r.ok ? r.blob() : null))
    .catch(() => null);
}

const voiceOfMember = (m: Member) => m.voice || characterById(m.character)?.voice || deps.voice();

function renderCast() {
  if (!film) return;
  const add = $("#fm-add-char") as HTMLSelectElement;
  add.innerHTML = `<option value="">Pick one…</option>` + characters().map((c) => `<option value="${c.id}">${esc(c.name)}${c.face ? "" : " (no face yet)"}</option>`).join("");
  $("#fm-consent").textContent = `${CONSENT} Never make sexual content of anyone under 18.`;
  const voiceOpts = (cur: string, own: string) =>
    `<option value="">${esc(own)}</option>` + voices.map((v) => `<option value="${esc(v)}"${v === cur ? " selected" : ""}>${esc(v.startsWith("vox:") ? `${v.slice(4)} (VoxCPM2)` : v)}</option>`).join("");
  $("#fm-cast").innerHTML = film.cast.length
    ? film.cast
        .map((m) => {
          const c = characterById(m.character);
          const url = pictureUrl(m);
          const own = c ? `${c.name}'s voice (${c.voice || deps.voice()})` : `Prestige's voice (${deps.voice()})`;
          return `<div class="fm-member sb-shot" data-id="${m.id}">
            <div class="fm-face">${url ? `<img src="${url}" alt="${esc(m.name)}" />` : `<span>No picture: shots with them are made from text</span>`}</div>
            <div class="fm-member-fields">
              <label>Name<input data-k="name" type="text" value="${esc(m.name)}" autocomplete="off" /></label>
              <label>Voice<select data-k="voice">${voiceOpts(m.voice ?? "", own)}</select></label>
              <label>How they look (for shots made from text)<textarea data-k="looks" rows="2" placeholder="age, build, hair, clothes">${esc(m.looks)}</textarea></label>
              <span class="credit">${c ? "A Character" : "From a picture"} · <button type="button" class="linkish" data-act="remove">remove</button></span>
            </div>
          </div>`;
        })
        .join("")
    : `<p class="muted">Nobody yet. A film can have no cast too: then every shot is made from its text.</p>`;
  status();
}

// ---------- 2. plan ----------

function initPlan() {
  $$("#fm-kind [data-kind]").forEach((b) =>
    b.addEventListener("click", () => {
      if (!film) return;
      film.kind = b.dataset.kind as FilmKind;
      const lengths = film.kind === "music" ? MUSIC_LENGTHS : SHORT_LENGTHS;
      if (!lengths.includes(film.seconds)) film.seconds = film.kind === "music" ? 30 : 60;
      persist();
      renderPlan();
    }),
  );
  $("#fm-length").addEventListener("change", (e) => {
    if (!film) return;
    film.seconds = Number((e.target as HTMLSelectElement).value);
    persist();
  });
  const text = (id: string, set: (f: Film, v: string) => void) =>
    $(id).addEventListener("input", (e) => {
      if (!film) return;
      set(film, (e.target as HTMLInputElement).value);
      persist();
    });
  text("#fm-idea", (f, v) => (f.idea = v));
  text("#fm-look", (f, v) => (f.look = v));
  text("#fm-song-title", (f, v) => f.song && (f.song.title = v));
  text("#fm-song-style", (f, v) => f.song && (f.song.style = v));
  text("#fm-song-lyrics", (f, v) => f.song && (f.song.lyrics = v));
  // Planning again replaces the shots: with takes already made, a second click within 4 s does it.
  let armed = 0;
  $("#fm-plan").addEventListener("click", () => {
    if (!film) return;
    if (planning) return planning.abort();
    const made = film.shots.filter((s) => s.takes.length).length;
    if (made && Date.now() - armed > 4000) {
      armed = Date.now();
      $("#fm-plan").textContent = `Replace ${film.shots.length} shots? Click again`;
      setTimeout(() => renderPlan(), 4000);
      return;
    }
    plan();
  });
  $("#fm-song-make").addEventListener("click", makeSong);
}

function renderPlan() {
  if (!film) return;
  const f = film;
  $$("#fm-kind [data-kind]").forEach((b) => b.classList.toggle("on", b.dataset.kind === f.kind));
  const lengths = f.kind === "music" ? MUSIC_LENGTHS : SHORT_LENGTHS;
  ($("#fm-length") as HTMLSelectElement).innerHTML = lengths.map((s) => `<option value="${s}"${s === f.seconds ? " selected" : ""}>${fmtS(s)}</option>`).join("");
  ($("#fm-idea") as HTMLTextAreaElement).value = f.idea;
  ($("#fm-look") as HTMLTextAreaElement).value = f.look;
  const m = deps.model();
  $("#fm-plan").textContent = planning ? "Stop planning" : f.shots.length ? "Plan it again" : "Plan it";
  $("#fm-plan").title = m ? `${m.name} writes the ${f.kind === "music" ? "song and the shots" : "shots, who's in them and what they say"} (${aboutTime(PLAN_SECS)})` : "No chat model is running";
  ($("#fm-plan") as HTMLButtonElement).disabled = !m && !planning;
  $("#fm-song").hidden = f.kind !== "music";
  if (f.kind === "music") {
    const s = f.song;
    ($("#fm-song-title") as HTMLInputElement).value = s?.title ?? "";
    ($("#fm-song-style") as HTMLInputElement).value = s?.style ?? "";
    ($("#fm-song-lyrics") as HTMLTextAreaElement).value = s?.lyrics ?? "";
    for (const id of ["#fm-song-title", "#fm-song-style", "#fm-song-lyrics"]) ($(id) as HTMLInputElement).disabled = !s;
    const audio = $("#fm-song-audio") as HTMLAudioElement;
    audio.hidden = !s?.path;
    if (s?.path && audio.dataset.path !== s.path) {
      audio.src = convertFileSrc(s.path);
      audio.dataset.path = s.path;
    }
    ($("#fm-song-make") as HTMLButtonElement).disabled = !s || !!songJob;
    $("#fm-song-make").textContent = s?.path ? "Make it again" : "Make the song";
    $("#fm-song-state").textContent = songJob ? `${songJob.label} (${Math.round(songJob.pct)}%)` : s ? `${fmtS(s.seconds)} with ACE-Step 1.5` : "Plan it first: the song is part of the plan.";
  }
  const shots = f.shots.length;
  $("#fm-plan-note").textContent = shots
    ? `${shots} shots, ${fmtS(f.shots.reduce((n, s) => n + s.seconds, 0))}. Change them on the Shots page.`
    : f.kind === "music"
      ? "The Director writes a song and a 5-second shot for every part of it, with the cast in the look."
      : `The chat model writes the shots with the cast by name, what happens and what they say. Shots are ${SHOT_MIN} to ${SHOT_MAX} s; lines are spoken in each one's voice.`;
}

/** The cast as the planner gets them: "Mara (a tall woman in a red coat)". */
const castText = (f: Film) => f.cast.map((m) => `${m.name}${m.looks.trim() ? ` (${m.looks.trim()})` : ""}`).join("; ");

const SHORT_SYSTEM = (seconds: number, cast: string) => {
  const lo = Math.max(2, Math.round(seconds / 8));
  const hi = Math.min(MAX_SHOTS, Math.round(seconds / 3));
  return `You write short films that a text-to-video model shoots one short shot at a time, and a speech model voices.
Reply with one JSON object and nothing else:
{"title": "...", "look": "...", "cast": [{"name": "...", "looks": "..."}], "shots": [{"action": "...", "cast": ["..."], "seconds": 5, "lines": [{"who": "...", "text": "..."}]}]}
- About ${seconds} seconds in all: ${lo} to ${hi} shots, each ${SHOT_MIN} to ${SHOT_MAX} seconds (most 4 to 6).
- look: one sentence for the visual style of every shot (e.g. cinematic 35 mm film with a warm grade; anime; claymation) and the era. Not the people.
- cast: everyone who appears.${cast ? ` Use these cast members, by these names, where the story allows: ${cast}. Keep the looks given; add others only if the story needs them.` : ""} looks: their appearance in one short phrase (age, build, hair, clothes).
- shots: in story order. action: 25 to 50 words for a text-to-video model: what happens, where, the light and one camera move, naming who is in it. No words, signs or captions on screen, no cuts inside a shot. cast: the names of who is in the shot.
- lines: what is said in the shot, at most ${WORDS_A_SECOND} words for each of its seconds; many shots have none. No narrator unless asked. who is a cast name. No stage directions in a line.`;
};

function firstJson(text: string): any {
  const t = text.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/```(?:json)?/g, "");
  const a = t.indexOf("{");
  const b = t.lastIndexOf("}");
  if (a < 0 || b < a) return null;
  try {
    return JSON.parse(t.slice(a, b + 1));
  } catch {
    return null;
  }
}

/** The chat model plans the film (no thinking, so it's quick); the shots, the look and, for a music video, the song
 *  replace what's there. New cast members the plan names join the cast. */
async function plan() {
  if (!film || planning) return;
  const model = deps.model();
  if (!model) return deps.toast("No chat model is running to plan the film. Start the services first.", "warn");
  const f = film;
  if (!f.idea.trim()) {
    show("plan");
    return deps.toast("Say what the film is about first.");
  }
  planning = new AbortController();
  renderPlan();
  status();
  const signal = planning.signal;
  try {
    if (f.kind === "music") {
      const idea = f.cast.length ? `${f.idea}\nStarring ${castText(f)}.` : f.idea;
      const p = await planVideo(model, idea, f.seconds, signal, (n) => ($("#fm-status").textContent = `${model.name} is planning the song and the shots… ${n} characters`));
      f.look = p.look;
      f.song = { title: p.title, style: p.style, bpm: p.bpm, key: p.key, language: p.language, lyrics: p.lyrics, seconds: p.seconds };
      if (/^Film \d+$/.test(f.name) || f.name === f.idea.replace(/\s+/g, " ").slice(0, 48)) f.name = p.title;
      f.shots = p.shots.map((s) => ({ id: newId(), action: s.action, seconds: SHOT_SECONDS, cast: castIn(f, s.action), lines: [], takes: [] }));
      // Who the look is about is in every shot of a music video.
      const star = f.cast.find((m) => new RegExp(`\\b${reEsc(m.name)}\\b`, "i").test(p.look));
      if (star) for (const s of f.shots) if (!s.cast.includes(star.id)) s.cast.unshift(star.id);
    } else {
      let out = "";
      await streamChat(
        model,
        [
          { role: "system", content: SHORT_SYSTEM(f.seconds, castText(f)) },
          { role: "user", content: f.idea },
        ],
        {
          onToken: (t) => {
            out += t;
            $("#fm-status").textContent = `${model.name} is writing the shots… ${out.length} characters`;
          },
          onThinking: () => {},
          onStats: () => {},
        },
        signal,
        undefined,
        { think: false },
      );
      const j = firstJson(out);
      if (!j || !Array.isArray(j.shots) || !j.shots.length) throw new Error(`${model.name} didn't plan the shots (try again, or another model)`);
      // Cast members it named that aren't in the cast yet join it (without a picture: made from text).
      for (const c of Array.isArray(j.cast) ? j.cast : []) {
        const name = String(c?.name ?? "").trim();
        if (!name) continue;
        const have = f.cast.find((m) => m.name.toLowerCase() === name.toLowerCase());
        const looks = String(c?.looks ?? "").trim();
        if (have) have.looks ||= looks;
        else if (f.cast.length < 12) f.cast.push({ id: newId(), name, looks });
      }
      const byName = (n: unknown) => f.cast.find((m) => m.name.toLowerCase() === String(n ?? "").trim().toLowerCase());
      let total = 0;
      f.shots = [];
      for (const s of j.shots.slice(0, MAX_SHOTS)) {
        const action = String(s?.action ?? "").trim();
        if (!action) continue;
        const seconds = clamp(Math.round(Number(s?.seconds) || 5), SHOT_MIN, SHOT_MAX);
        if (total + seconds > 180) break;
        total += seconds;
        const named = (Array.isArray(s?.cast) ? s.cast : []).map(byName).filter(Boolean) as Member[];
        const cast = [...new Set([...named.map((m) => m.id), ...castIn(f, action)])];
        const lines: Line[] = (Array.isArray(s?.lines) ? s.lines : [])
          .map((l: any) => ({ who: byName(l?.who)?.id ?? "", text: String(l?.text ?? "").trim() }))
          .filter((l: { who: string; text: string }) => l.who && l.text)
          .map((l: { who: string; text: string }) => ({ id: newId(), ...l }));
        for (const l of lines) if (!cast.includes(l.who)) cast.push(l.who);
        f.shots.push({ id: newId(), action, seconds, cast, lines, takes: [] });
      }
      if (!f.shots.length) throw new Error(`${model.name}'s plan had no shots`);
      f.look = String(j.look ?? "").trim();
      const title = String(j.title ?? "").trim();
      if (title && (/^Film \d+$/.test(f.name) || f.name === f.idea.replace(/\s+/g, " ").slice(0, 48))) f.name = title;
    }
    f.clips = [];
    jobs.clear();
    persist();
    if (film === f) show("shots");
    deps.toast(`Planned: ${f.shots.length} shots. Draw their frames and shoot them, then cut them together on the Timeline.`);
  } catch (e) {
    if (!signal.aborted) deps.toast(`Couldn't plan the film: ${errMsg(e)}`, "warn");
  } finally {
    planning = null;
    if (film === f && tab === "plan") renderPlan();
    status();
  }
}

const reEsc = (s: string) => s.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** The cast members a text names. */
const castIn = (f: Film, text: string) => f.cast.filter((m) => m.name.trim() && new RegExp(`\\b${reEsc(m.name)}\\b`, "i").test(text)).map((m) => m.id);

/** A music video's song, with ACE-Step 1.5 at the plan's length. */
async function makeSong() {
  if (!film?.song || songJob) return;
  const f = film;
  const s = f.song!;
  songJob = { pct: 0, label: "Waiting…" };
  renderPlan();
  try {
    const out = await renderSong(s.style, s.lyrics, (pct, label) => {
      songJob = { pct, label };
      if (film === f && tab === "plan") $("#fm-song-state").textContent = `${label} (${Math.round(pct)}%)`;
      status();
    }, { seconds: s.seconds, bpm: s.bpm, key: s.key, language: s.language });
    s.path = out[0].path;
    persist();
  } catch (e) {
    if (errMsg(e) !== "stopped") deps.toast(`Couldn't make the song: ${errMsg(e)}`, "warn");
  } finally {
    songJob = null;
    if (film === f && tab === "plan") renderPlan();
    status();
  }
}

// ---------- 3. shots ----------

/** What LTX-2.5 (or the image model) gets for a shot: the look, who's in it and how they look, then the action. */
function promptOf(f: Film, sh: Shot, asRef?: Member): string {
  const who = sh.cast
    .map(member)
    .filter((m): m is Member => !!m && m !== asRef && !!m.looks.trim())
    .map((m) => `${m.name} is ${m.looks.trim()}.`)
    .join(" ");
  const p = [f.look.trim(), who, sh.action.trim()].filter(Boolean).join(" ");
  // The cast member whose picture goes in is "the character" Qwen-Image keeps from it.
  return asRef ? p.replace(new RegExp(`\\b${reEsc(asRef.name)}\\b`, "gi"), "the character") : p;
}

/** The first cast member in a shot who has a picture: their picture goes in its frame. */
const refMember = (sh: Shot) => sh.cast.map(member).find((m): m is Member => !!m && !!(m.picture || characterById(m.character)?.face));

function initShots() {
  ($("#fm-draft") as HTMLInputElement).addEventListener("change", (e) => {
    if (!film) return;
    film.draft = (e.target as HTMLInputElement).checked;
    persist();
    renderShots();
  });
  $("#fm-add-shot").addEventListener("click", () => {
    if (!film) return;
    if (film.shots.length >= MAX_SHOTS) return deps.toast(`A film has ${MAX_SHOTS} shots at most.`);
    film.shots.push({ id: newId(), action: "", seconds: 5, cast: [], lines: [], takes: [] });
    persist();
    renderShots();
    ($(`#fm-shots [data-id="${film.shots[film.shots.length - 1].id}"] .sb-action`) as HTMLTextAreaElement | null)?.focus();
  });
  $("#fm-frames").addEventListener("click", () => {
    if (!film) return;
    const todo = film.shots.filter((s) => s.action.trim() && !s.frame && !jobs.has(s.id));
    if (!todo.length) return deps.toast("Every shot has a frame (or is busy).");
    for (const s of todo) drawFrame(s);
  });
  $("#fm-shoot").addEventListener("click", () => {
    if (!film) return;
    const todo = film.shots.filter((s) => s.action.trim() && !s.takes.length && !jobs.has(s.id));
    if (!todo.length) return deps.toast("Every shot has a take (or is busy).");
    for (const s of todo) shoot(s);
  });
  $("#fm-voice").addEventListener("click", () => voiceLines().catch((e) => deps.toast(`Couldn't voice the lines: ${errMsg(e)}`, "warn")));
  const list = $("#fm-shots");
  list.addEventListener("input", (e) => {
    const el = e.target as HTMLInputElement;
    const sh = shotOf((el.closest(".fm-shot") as HTMLElement | null)?.dataset.id);
    if (!film || !sh) return;
    if (el.matches(".sb-action")) sh.action = el.value;
    else if (el.dataset.k === "seconds") sh.seconds = clamp(Number(el.value) || 5, SHOT_MIN, SHOT_MAX);
    else if (el.dataset.line) {
      const l = sh.lines.find((x) => x.id === el.dataset.line);
      if (!l) return;
      if (el.dataset.k === "who") l.who = el.value;
      if (el.dataset.k === "text") l.text = el.value;
    } else return;
    persist();
    if (el.tagName === "SELECT") renderShots();
  });
  list.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-act]");
    const card = b?.closest<HTMLElement>(".fm-shot");
    const sh = shotOf(card?.dataset.id);
    if (!film || !b || !sh) return;
    const i = film.shots.indexOf(sh);
    const act = b.dataset.act!;
    if (act === "up" && i > 0) film.shots.splice(i - 1, 0, ...film.shots.splice(i, 1));
    else if (act === "down" && i < film.shots.length - 1) film.shots.splice(i + 1, 0, ...film.shots.splice(i, 1));
    else if (act === "add") {
      if (film.shots.length >= MAX_SHOTS) return deps.toast(`A film has ${MAX_SHOTS} shots at most.`);
      film.shots.splice(i + 1, 0, { id: newId(), action: "", seconds: 5, cast: [], lines: [], takes: [] });
    } else if (act === "remove") {
      if (jobs.has(sh.id)) return deps.toast("Wait for this shot's render to finish (or stop it).");
      film.shots.splice(i, 1);
      film.clips = film.clips.filter((c) => c.shot !== sh.id);
    } else if (act === "cast") {
      const id = b.dataset.who!;
      sh.cast = sh.cast.includes(id) ? sh.cast.filter((x) => x !== id) : [...sh.cast, id];
    } else if (act === "line") sh.lines.push({ id: newId(), who: sh.cast[0] ?? film.cast[0]?.id ?? "", text: "" });
    else if (act === "unline") sh.lines = sh.lines.filter((l) => l.id !== b.dataset.line);
    else if (act === "take") {
      sh.pick = b.dataset.take;
      clampClips(sh);
    } else if (act === "play") {
      // The take plays in its card; a frame opens across the page (and back), as on the storyboard.
      const t = pickOf(sh);
      if (t) b.outerHTML = `<video class="fm-video" src="${convertFileSrc(t.path)}" controls autoplay playsinline></video>`;
      else card!.classList.toggle("zoom");
      return;
    }
    else if (act === "drop") {
      const t = pickOf(sh);
      if (!t) return;
      sh.takes = sh.takes.filter((x) => x !== t);
      sh.pick = sh.takes[sh.takes.length - 1]?.id;
      clampClips(sh);
    } else if (act === "frame") return drawFrame(sh);
    else if (act === "shoot") return shoot(sh);
    else if (act === "long") return longShot(sh);
    else if (act === "swap") return swapShot(sh);
    else if (act === "upscale") return upscaleShot(sh);
    else if (act === "sound") return soundShot(sh);
    else if (act === "talk") return talkShot(sh);
    else if (act === "stop") return cancelFilm();
    else return;
    persist();
    renderShots();
  });
}

/** A clip's trim can't run past its take's end once the take changes. */
function clampClips(sh: Shot) {
  const t = pickOf(sh);
  if (!film || !t) return;
  for (const c of film.clips.filter((x) => x.shot === sh.id)) {
    c.in = clamp(c.in, 0, Math.max(0, t.seconds - 0.5));
    if (c.out) c.out = clamp(c.out, c.in + 0.5, t.seconds);
  }
}

async function thumbOf(path: string): Promise<string> {
  const have = thumbs.get(path);
  if (have) return have;
  const t = await invoke<string>("thumbnail", { path, mtime: 0 }).catch(() => "");
  const url = t ? convertFileSrc(t) : "";
  if (url) thumbs.set(path, url);
  return url;
}

/** Puts the takes' pictures in once they're made (the first time a video's is asked for, ffmpeg draws it). */
function fillThumbs(root: ParentNode) {
  for (const img of $$<HTMLImageElement>("img[data-thumb]", root)) {
    const p = img.dataset.thumb!;
    const have = thumbs.get(p);
    if (have) img.src = have;
    else thumbOf(p).then((u) => u && (img.src = u));
  }
}

function renderShots() {
  if (!film) return;
  const f = film;
  ($("#fm-draft") as HTMLInputElement).checked = f.draft;
  const list = $("#fm-shots");
  if (!f.shots.length) {
    list.innerHTML = `<p class="muted">No shots yet: plan the film, or add a shot.</p>`;
    return;
  }
  let at = 0;
  list.innerHTML = f.shots
    .map((sh, i) => {
      const j = jobs.get(sh.id);
      const t = pickOf(sh);
      const ref = refMember(sh);
      const start = at;
      at += sh.seconds;
      const pic = t
        ? `<button type="button" class="sb-frame" data-act="play" title="Play this take"><img data-thumb="${esc(t.path)}" alt="Shot ${i + 1}" /></button>`
        : sh.frame
          ? `<button type="button" class="sb-frame" data-act="play" title="See the frame"><img src="${convertFileSrc(sh.frame)}" alt="Shot ${i + 1}" loading="lazy" /></button>`
          : `<div class="sb-frame empty">${j ? "" : ref ? `No frame yet: draw it to put ${esc(ref.name)} in the scene` : "No frame yet: the shot can be made from its text alone"}</div>`;
      const cast = f.cast.length
        ? `<div class="fm-chips">${f.cast.map((m) => `<button type="button" class="fm-chip${sh.cast.includes(m.id) ? " on" : ""}" data-act="cast" data-who="${m.id}" title="${sh.cast.includes(m.id) ? "In this shot" : "Not in this shot"}">${esc(m.name)}</button>`).join("")}</div>`
        : "";
      const whoOpts = (cur: string) => f.cast.map((m) => `<option value="${m.id}"${m.id === cur ? " selected" : ""}>${esc(m.name)}</option>`).join("");
      const lines = sh.lines
        .map(
          (l) =>
            `<div class="fm-line"><select data-k="who" data-line="${l.id}" aria-label="Who says it">${whoOpts(l.who)}</select><input data-k="text" data-line="${l.id}" type="text" value="${esc(l.text)}" placeholder="What they say" autocomplete="off" /><button type="button" class="icon-btn" data-act="unline" data-line="${l.id}" title="Remove this line">×</button></div>`,
        )
        .join("");
      const words = sh.lines.reduce((n, l) => n + l.text.split(/\s+/).filter(Boolean).length, 0);
      const long = words > sh.seconds * 2.8 ? `<span class="fm-warn credit">the lines are longer than the shot</span>` : "";
      const takes = sh.takes.length
        ? `<div class="fm-takes">${sh.takes.map((x, k) => `<button type="button" class="fm-take${x === t ? " on" : ""}" data-act="take" data-take="${x.id}" title="Take ${k + 1}: ${esc(x.note)} · ${fmtS(x.seconds)} · rendered in ${fmtS(x.took)}"><img data-thumb="${esc(x.path)}" alt="" /><span>${k + 1}</span></button>`).join("")}</div>`
        : "";
      const busy = !!j;
      const can = (on: boolean) => (on && !busy ? "" : " disabled");
      const est = shotSecs(sh.seconds, f.draft) + (ref && !sh.frame ? FRAME_SECS.cast : 0);
      const acts = [
        `<button type="button" class="btn" data-act="frame"${can(!!sh.action.trim())} title="${ref ? `Qwen-Image puts ${esc(ref.name)} from their picture in the scene` : "The image model draws where the shot starts"} (${aboutTime(ref ? FRAME_SECS.cast : FRAME_SECS.text)})">${sh.frame ? "Redraw frame" : "Draw frame"}</button>`,
        `<button type="button" class="btn primary" data-act="shoot"${can(!!sh.action.trim())} title="LTX-2.5 with sound, ${sh.frame ? "from the frame" : ref ? "from a frame with the cast member in it, drawn first" : "from the text"}, a new seed each time (${aboutTime(est)})">${sh.takes.length ? "Retake" : "Shoot"}</button>`,
        tools.long ? `<button type="button" class="btn" data-act="long"${can(!!sh.frame)} title="${sh.frame ? `A ${fmtS(longTake().seconds)} take from the frame with Wan 2.2 SVI, silent (the Long video settings; ${aboutTime(longTake().secs)})` : "Draw the frame first"}">Long take</button>` : "",
        tools.swap ? `<button type="button" class="btn" data-act="swap"${can(f.cast.some((m) => pictureUrl(m)))} title="Put a cast member in place of someone in this take or in a clip of your own (SCAIL-2)">Swap…</button>` : "",
        tools.upscale ? `<button type="button" class="btn" data-act="upscale"${can(!!t && t.how !== "upscale")} title="${t ? `SeedVR2 sharpens the take to 1080p (${aboutTime(upscaleClipSecs(t.seconds))})` : "Shoot it first"}">Upscale</button>` : "",
        tools.sound ? `<button type="button" class="btn" data-act="sound"${can(!!t)} title="${t ? `LTX-2.3 Foley makes the take's sound effects (${aboutTime(soundClipSecs(t.seconds))})` : "Shoot it first"}">Sound…</button>` : "",
        tools.talk ? `<button type="button" class="btn" data-act="talk"${can(talkable(sh))} title="${talkable(sh) ? "InfiniteTalk makes a close-up of the speaker saying the lines, lip-synced (about 1.5 min a second of speech)" : "Needs lines from one cast member who has a picture"}">Lip-sync</button>` : "",
        t ? `<button type="button" class="linkish" data-act="drop"${busy ? " disabled" : ""} title="Remove the take being used from this shot (the file stays in the gallery)">drop take</button>` : "",
        busy ? `<button type="button" class="linkish" data-act="stop" title="Stop this film's renders">stop</button>` : "",
      ].join("");
      return `<div class="sb-shot fm-shot${busy ? " busy" : ""}" data-id="${sh.id}">
        <div class="sb-pic">${pic}<div class="sb-progress"${j ? "" : " hidden"}><div class="progress"><i style="--v:${j?.pct ?? 0}"></i></div><span>${esc(j ? `${j.what} · ${j.label}` : "")}</span></div></div>
        <div class="sb-head"><b>Shot ${i + 1}</b><span class="credit">${fmtS(start)}</span>
          <select data-k="seconds" aria-label="Length" title="How long the shot is">${Array.from({ length: SHOT_MAX - SHOT_MIN + 1 }, (_, k) => k + SHOT_MIN).map((s) => `<option value="${s}"${s === sh.seconds ? " selected" : ""}>${s} s</option>`).join("")}</select>
          <span class="sb-tools"><button type="button" class="icon-btn" data-act="up" title="Move earlier"${i ? "" : " disabled"}>↑</button><button type="button" class="icon-btn" data-act="down" title="Move later"${i < f.shots.length - 1 ? "" : " disabled"}>↓</button><button type="button" class="icon-btn" data-act="add" title="Add a shot after this one">+</button><button type="button" class="icon-btn" data-act="remove" title="Remove this shot">×</button></span></div>
        ${cast}
        <textarea class="sb-action" rows="4" placeholder="What happens, naming who's in it: the setting, the light and one camera move">${esc(sh.action)}</textarea>
        ${lines ? `<div class="fm-lines">${lines}</div>` : ""}
        ${f.cast.length ? `<button type="button" class="linkish fm-addline" data-act="line">+ a line of dialogue</button>${long}` : ""}
        ${takes}
        <div class="fm-acts-row">${acts}</div>
      </div>`;
    })
    .join("");
  fillThumbs(list);
  status();
}

/** A shot's progress, without drawing every card again. */
function progress(sh: Shot, what: string) {
  return (pct: number, label: string) => {
    // When the render left the queue: a take's time is its own, not the renders' ahead of it.
    const was = jobs.get(sh.id)?.started;
    jobs.set(sh.id, { what, pct, label, started: /^Waiting/.test(label) ? undefined : (was ?? Date.now()) });
    const el = document.querySelector<HTMLElement>(`#fm-shots [data-id="${sh.id}"]`);
    if (el) {
      ($(".progress i", el) as HTMLElement | null)?.style.setProperty("--v", String(pct));
      const l = $(".sb-progress span", el);
      if (l) l.textContent = `${what} · ${label}`;
    }
    status();
  };
}

/** Runs one of a shot's renders: its card shows how far along it is, and a failure says so. */
async function work(sh: Shot, what: string, fn: (p: (pct: number, label: string) => void) => Promise<void>) {
  if (jobs.has(sh.id)) return deps.toast("This shot is already rendering: wait for it (or stop it).");
  const f = film!;
  jobs.set(sh.id, { what, pct: 0, label: "Waiting…" });
  if (film === f) renderShots();
  status();
  try {
    await fn(progress(sh, what));
  } catch (e) {
    if (errMsg(e) !== "stopped") deps.toast(`Shot ${f.shots.indexOf(sh) + 1}: couldn't ${what.toLowerCase()} (${errMsg(e)})`, "warn");
  } finally {
    jobs.delete(sh.id);
    if (film === f && tab === "shots") renderShots();
    if (film === f && tab === "cut") renderCut();
    status();
  }
}

/** The new take becomes the one used (its slot on the timeline stays where it is). */
async function addTake(f: Film, sh: Shot, path: string, how: TakeHow, note: string, t0: number) {
  t0 = jobs.get(sh.id)?.started ?? t0;
  const info = await invoke<{ seconds: number }>("video_info", { path }).catch(() => ({ seconds: sh.seconds }));
  const t: Take = { id: newId(), path, how, note, seconds: Math.round(info.seconds * 100) / 100 || sh.seconds, took: Math.round((Date.now() - t0) / 1000), made: Date.now() };
  sh.takes.push(t);
  sh.pick = t.id;
  clampClips(sh);
  // A shot's first take goes on the timeline after the shot before it.
  if (!f.clips.some((c) => c.shot === sh.id)) {
    const before = f.shots.slice(0, f.shots.indexOf(sh)).map((s) => s.id);
    let at = 0;
    f.clips.forEach((c, k) => c.shot && before.includes(c.shot) && (at = k + 1));
    f.clips.splice(at, 0, { id: newId(), shot: sh.id, seconds: 0, in: 0, out: 0, fade: false, volume: defaultVolume(f, sh, t) });
  }
  if (film === f) persist();
  else saveOther(f);
}

/** A film that was closed (or another opened) while its render ran is still saved. */
function saveOther(f: Film) {
  f.updated = Date.now();
  invoke("store_set", { name: `film-${f.id}`, value: f }).catch(() => {});
}

/** How loud a clip's own sound starts: none under a music video's song, quiet under dialogue (the speech LTX makes up
 *  isn't the cast's), full otherwise; a lip-synced take is the dialogue. */
const defaultVolume = (f: Film, sh: Shot, t: Take) => (t.how === "talk" ? 1 : f.kind === "music" ? 0 : sh.lines.length ? 0.25 : 1);

async function frameFor(f: Film, sh: Shot, p: (pct: number, label: string) => void) {
  const ref = refMember(sh);
  const title = `${f.name}: frame for shot ${f.shots.indexOf(sh) + 1}`;
  let path: string;
  if (ref) {
    const blob = await pictureBlob(ref);
    if (!blob) throw new Error(`${ref.name}'s picture isn't there any more`);
    const r = await loadReference(blob);
    URL.revokeObjectURL(r.url);
    const prompt = promptOf(f, sh, ref);
    path = (await renderCastFrame(prompt, r, p, title))[0].path;
    sh.framePrompt = prompt;
  } else {
    const prompt = promptOf(f, sh);
    path = (await renderFrame(prompt, p, title))[0].path;
    sh.framePrompt = prompt;
  }
  sh.frame = path;
  if (film === f) persist();
  else saveOther(f);
}

function drawFrame(sh: Shot) {
  const f = film!;
  return work(sh, "Draw the frame", (p) => frameFor(f, sh, p));
}

/** LTX-2.5 with sound from the frame (one is drawn first when a cast member is in the shot), with a new seed. */
function shoot(sh: Shot) {
  const f = film!;
  return work(sh, sh.takes.length ? "Retake" : "Shoot", async (p) => {
    if (!sh.frame && refMember(sh)) await frameFor(f, sh, p);
    const t0 = Date.now();
    const out = await renderShot(promptOf(f, sh), sh.seconds, p, {
      title: `${f.name}: shot ${f.shots.indexOf(sh) + 1}`,
      quality: f.draft ? "draft" : "standard",
      frame: sh.frame,
      seed: Math.floor(Math.random() * 2 ** 32),
      from: "Film",
    });
    await addTake(f, sh, out[0].path, "shot", `LTX-2.5 ${sh.frame ? "from the frame" : "from the text"}${f.draft ? ", draft" : ""}`, t0);
  });
}

function longShot(sh: Shot) {
  const f = film!;
  if (!sh.frame) return deps.toast("Draw the shot's frame first: a long take starts from it.");
  return work(sh, "Long take", async (p) => {
    const t0 = Date.now();
    const path = await renderLongTake(promptOf(f, sh), sh.frame!, p, `${f.name}: long take of shot ${f.shots.indexOf(sh) + 1}`);
    await addTake(f, sh, path, "long", "Wan 2.2 SVI long take from the frame", t0);
  });
}

function upscaleShot(sh: Shot) {
  const f = film!;
  const t = pickOf(sh);
  if (!t) return;
  return work(sh, "Upscale", async (p) => {
    const t0 = Date.now();
    const path = await upscaleClip(t.path, p);
    await addTake(f, sh, path, "upscale", `${t.note}, upscaled to 1080p`, t0);
  });
}

async function soundShot(sh: Shot) {
  const f = film!;
  const t = pickOf(sh);
  if (!t) return;
  const what = await askLine(
    "Sound for this shot",
    `Say what should be heard, tied to what happens: the sources and how they sound. LTX-2.3 Foley makes it (${aboutTime(soundClipSecs(t.seconds))}), on a copy of the take; any sound it has is replaced.`,
    "e.g. rain on a tin roof, footsteps on wet stone, a door slams",
  );
  if (!what) return;
  return work(sh, "Sound", async (p) => {
    const t0 = Date.now();
    const path = await soundClip(t.path, t.seconds, what, p);
    await addTake(f, sh, path, "sound", `${t.note}, with Foley: ${what}`, t0);
    // The Foley is what's wanted: its clip plays at full level.
    for (const c of f.clips.filter((x) => x.shot === sh.id)) c.volume = Math.max(c.volume, 1);
    if (film === f) persist();
  });
}

/** Lip-sync: all of a shot's lines are one cast member's, who has a picture (or the shot has a frame with them in). */
const talkable = (sh: Shot) => {
  const who = new Set(sh.lines.filter((l) => l.text.trim()).map((l) => l.who));
  const m = who.size === 1 ? member([...who][0]) : undefined;
  return !!m && !!(sh.frame || pictureUrl(m));
};

function talkShot(sh: Shot) {
  const f = film!;
  if (!talkable(sh)) return;
  const m = member(sh.lines[0].who)!;
  return work(sh, "Lip-sync", async (p) => {
    const text = sh.lines.map((l) => l.text.trim()).filter(Boolean).join(" ");
    p(0, `Speaking the lines in ${m.name}'s voice…`);
    const audio = await synthesize(text, voiceOfMember(m));
    const seconds = await blobSeconds(audio);
    // The frame when it has them in it (they speak in the scene), otherwise their own picture.
    const pic = sh.frame && refMember(sh) === m ? sh.frame : m.picture ? m.picture : await loadReference((await pictureBlob(m))!);
    if (typeof pic !== "string") URL.revokeObjectURL(pic.url);
    const t0 = Date.now();
    const out = await renderTalk(pic, audio, seconds, `A person talking with natural expressions, blinking and slight head movement. ${f.look}`.trim(), p, "Film", `${f.name}: ${m.name} says "${text.slice(0, 60)}"`);
    await addTake(f, sh, out[0].path, "talk", `InfiniteTalk lip-sync of ${m.name}`, t0);
  });
}

/** How long a recording is. */
async function blobSeconds(b: Blob): Promise<number> {
  const ctx = new OfflineAudioContext(1, 1, 44100);
  const buf = await ctx.decodeAudioData(await b.arrayBuffer());
  return buf.duration;
}

/** A line that needs speaking: never spoken, or its words or voice changed since. */
const unvoiced = (l: Line) => {
  const m = member(l.who);
  return !!l.text.trim() && !!m && (!l.audio || l.said !== `${voiceOfMember(m)}|${l.text.trim()}`);
};

/** Every line spoken in its cast member's voice (those already spoken, in the same voice and words, are kept). */
async function voiceLines() {
  if (!film || voicing) return;
  const f = film;
  const todo = f.shots.flatMap((s) => s.lines).filter(unvoiced);
  if (!todo.length) return deps.toast("Every line is voiced.");
  voicing = true;
  status();
  try {
    for (const [k, l] of todo.entries()) {
      const m = member(l.who)!;
      const v = voiceOfMember(m);
      $("#fm-status").textContent = `Voicing line ${k + 1} of ${todo.length} (${m.name})…`;
      const wav = await synthesize(l.text.trim(), v);
      l.audio = await writeFile(`line-${l.id}-${newId().slice(0, 4)}.wav`, wav);
      l.secs = Math.round((await blobSeconds(wav)) * 100) / 100;
      l.said = `${v}|${l.text.trim()}`;
    }
    if (film === f) persist();
    else saveOther(f);
    deps.toast(`Voiced ${todo.length} line${todo.length > 1 ? "s" : ""}.`);
  } finally {
    voicing = false;
    status();
    if (film === f && tab === "cut") renderCut();
  }
}

// ---------- swap ----------

let swapFor: Shot | null = null;

function initSwap() {
  const dlg = $("#fm-swap") as HTMLDialogElement;
  const est = () => {
    const t = pickOf(swapFor ?? undefined);
    const own = ($("#fs-from") as HTMLSelectElement).value === "own";
    const q = ($("#fs-quality") as HTMLSelectElement).value as "draft" | "standard";
    $("#fs-est").textContent = own ? "Takes about 12 min for a 5 s clip at Draft on the RTX 3060." : t ? `Takes ${aboutTime(swapClipSecs(t.seconds, q))} on the RTX 3060.` : "";
  };
  $("#fs-from").addEventListener("change", est);
  $("#fs-quality").addEventListener("change", est);
  dlg.addEventListener("close", async () => {
    const sh = swapFor;
    swapFor = null;
    if (dlg.returnValue !== "go" || !sh || !film) return;
    const f = film;
    const m = member(($("#fs-who") as HTMLSelectElement).value);
    if (!m) return;
    const q = ($("#fs-quality") as HTMLSelectElement).value as "draft" | "standard";
    const who = ($("#fs-target") as HTMLInputElement).value.trim() || "person";
    let src = pickOf(sh)?.path;
    if (($("#fs-from") as HTMLSelectElement).value === "own") {
      src = (await invoke<string | null>("film_pick", { kind: "video" }).catch(() => null)) ?? undefined;
      if (!src) return;
    }
    if (!src) return deps.toast("This shot has no take to swap into: shoot it, or pick a clip of your own.");
    const from = src;
    work(sh, "Swap", async (p) => {
      const pic = await pictureBlob(m);
      if (!pic) throw new Error(`${m.name}'s picture isn't there any more`);
      const t0 = Date.now();
      const path = await swapClip(from, pic, who, q, p);
      await addTake(f, sh, path, "swap", `${m.name} swapped in for ${who}${pickOf(sh)?.path === from ? "" : ` in ${from.split(/[\\/]/).pop()}`}`, t0);
    });
  });
}

function swapShot(sh: Shot) {
  if (!film) return;
  swapFor = sh;
  const who = $("#fs-who") as HTMLSelectElement;
  const can = film.cast.filter((m) => pictureUrl(m));
  who.innerHTML = can.map((m) => `<option value="${m.id}"${sh.cast.includes(m.id) ? " selected" : ""}>${esc(m.name)}</option>`).join("");
  const from = $("#fs-from") as HTMLSelectElement;
  from.value = pickOf(sh) ? "take" : "own";
  (from.querySelector('[value="take"]') as HTMLOptionElement).disabled = !pickOf(sh);
  ($("#fs-target") as HTMLInputElement).value = "person";
  $("#fs-consent").textContent = `${CONSENT} Never make sexual content of anyone under 18.`;
  from.dispatchEvent(new Event("change"));
  const dlg = $("#fm-swap") as HTMLDialogElement;
  dlg.returnValue = "";
  dlg.showModal();
}

// ---------- 4. timeline ----------

/** How long a clip lasts on the timeline. */
function clipLen(c: Clip): number {
  if (c.title != null) return c.seconds || 3;
  const t = pickOf(shotOf(c.shot));
  if (!t) return 0;
  return Math.max(0.2, (c.out || t.seconds) - c.in);
}

/** The clips that can be cut (a shot clip needs a take), each with where it starts; as in film.rs. */
function cutLayout(f: Film) {
  const live = f.clips.filter((c) => c.title != null || pickOf(shotOf(c.shot)));
  const out: { clip: Clip; start: number; len: number; fade: number }[] = [];
  let t = 0;
  live.forEach((c, i) => {
    const len = clipLen(c);
    const fade = i > 0 && c.fade ? Math.min(FADE, out[i - 1].len / 2, len / 2) : 0;
    out.push({ clip: c, start: t - fade, len, fade });
    t += len - fade;
  });
  return { pieces: out, total: t };
}

/** Where a shot's lines fall, from its start: one after another. */
function linePlaces(sh: Shot) {
  let at = LINE_START;
  return sh.lines
    .filter((l) => l.text.trim())
    .map((l) => {
      const p = { line: l, at, secs: l.secs ?? Math.max(1, l.text.split(/\s+/).length / 2.6) };
      at += p.secs + LINE_GAP;
      return p;
    });
}

function initCut() {
  $("#fm-zoom").addEventListener("input", (e) => {
    pps = Number((e.target as HTMLInputElement).value);
    renderCut();
  });
  $("#fm-title").addEventListener("click", () => {
    if (!film) return;
    const at = selected ? film.clips.findIndex((c) => c.id === selected) + 1 : 0;
    const c: Clip = { id: newId(), title: film.clips.some((x) => x.title != null) ? "The end" : film.name, seconds: 3, in: 0, out: 0, fade: true, volume: 0 };
    film.clips.splice(at, 0, c);
    selected = c.id;
    persist();
    renderCut();
  });
  $("#fm-reset").addEventListener("click", () => {
    if (!film) return;
    const f = film;
    // Titles keep their place before the shot they were in front of; shots go in the shots' order.
    const kept = new Map(f.clips.filter((c) => c.shot).map((c) => [c.shot!, c]));
    const titles = f.clips.map((c, i) => ({ c, next: f.clips.slice(i + 1).find((x) => x.shot)?.shot })).filter((x) => x.c.title != null);
    const out: Clip[] = [];
    for (const sh of f.shots) {
      const t = pickOf(sh);
      for (const x of titles.filter((x) => x.next === sh.id)) out.push(x.c);
      if (t) out.push(kept.get(sh.id) ?? { id: newId(), shot: sh.id, seconds: 0, in: 0, out: 0, fade: false, volume: defaultVolume(f, sh, t) });
    }
    for (const x of titles.filter((x) => !x.next || !out.includes(x.c))) out.push(x.c);
    f.clips = out;
    persist();
    renderCut();
  });
  const lane = $("#fm-lane-v");
  lane.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>(".fm-clip");
    selected = b?.dataset.id ?? null;
    renderCut();
  });
  // Drag a clip onto another to put it there.
  lane.addEventListener("dragstart", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>(".fm-clip");
    if (b?.dataset.id) e.dataTransfer?.setData("text/x-film-clip", b.dataset.id);
  });
  lane.addEventListener("dragover", (e) => {
    if (Array.from(e.dataTransfer?.types ?? []).includes("text/x-film-clip")) e.preventDefault();
  });
  lane.addEventListener("drop", (e) => {
    const id = e.dataTransfer?.getData("text/x-film-clip");
    if (!film || !id) return;
    e.preventDefault();
    const from = film.clips.findIndex((c) => c.id === id);
    const target = (e.target as HTMLElement).closest<HTMLElement>(".fm-clip");
    let to = film.clips.length;
    if (target?.dataset.id) {
      const r = target.getBoundingClientRect();
      to = film.clips.findIndex((c) => c.id === target.dataset.id) + (e.clientX > r.left + r.width / 2 ? 1 : 0);
    }
    if (from < 0 || to === from || to === from + 1) return;
    const [c] = film.clips.splice(from, 1);
    film.clips.splice(to > from ? to - 1 : to, 0, c);
    persist();
    renderCut();
  });
  const insp = $("#fm-inspect");
  insp.addEventListener("input", (e) => {
    const el = e.target as HTMLInputElement;
    const c = film?.clips.find((x) => x.id === selected);
    if (!film || !c || !el.dataset.k) return;
    const t = pickOf(shotOf(c.shot));
    const v = Number(el.value);
    if (el.dataset.k === "in" && t) c.in = clamp(v || 0, 0, Math.max(0, (c.out || t.seconds) - 0.5));
    if (el.dataset.k === "out" && t) c.out = v >= t.seconds - 0.01 ? 0 : clamp(v, c.in + 0.5, t.seconds);
    if (el.dataset.k === "fade") c.fade = el.value === "fade";
    if (el.dataset.k === "volume") c.volume = v;
    if (el.dataset.k === "title") c.title = el.value;
    if (el.dataset.k === "seconds") c.seconds = clamp(v || 3, 1, 15);
    persist();
    // The lanes follow; the inspector keeps its focus.
    renderLanes();
  });
  insp.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-act]");
    const c = film?.clips.find((x) => x.id === selected);
    if (!film || !b || !c) return;
    if (b.dataset.act === "remove") {
      film.clips = film.clips.filter((x) => x !== c);
      selected = null;
      persist();
      renderCut();
    }
    // Send back: the shot's card, where a new take replaces this one in the same slot.
    if (b.dataset.act === "back" && c.shot) {
      show("shots").then(() => {
        const el = document.querySelector<HTMLElement>(`#fm-shots [data-id="${c.shot}"]`);
        el?.scrollIntoView({ block: "center" });
        el?.classList.add("flash");
        setTimeout(() => el?.classList.remove("flash"), 1600);
      });
    }

  });
  $("#fm-bed").addEventListener("change", async (e) => {
    if (!film) return;
    const v = (e.target as HTMLSelectElement).value;
    if (v === "pick") {
      const path = await invoke<string | null>("film_pick", { kind: "audio" }).catch(() => null);
      if (path) film.bed = { path, volume: film.bedVolume };
    } else if (v === "none") film.bed = undefined;
    else if (v === "song") film.bed = undefined;
    if (v === "none") film.bedVolume = 0;
    else if (!film.bedVolume) film.bedVolume = film.kind === "music" ? 1 : 0.3;
    persist();
    renderCut();
  });
  $("#fm-bed-vol").addEventListener("input", (e) => {
    if (!film) return;
    film.bedVolume = Number((e.target as HTMLInputElement).value);
    persist();
  });
  $("#fm-line-vol").addEventListener("input", (e) => {
    if (!film) return;
    film.lineVolume = Number((e.target as HTMLInputElement).value);
    persist();
  });
  $("#fm-size").addEventListener("change", (e) => {
    if (!film) return;
    film.size = (e.target as HTMLSelectElement).value;
    persist();
  });
  $("#fm-export").addEventListener("click", () => exportFilm());
}

/** The music bed: your own song, else a music video's song (when it's made). */
const bedOf = (f: Film) => (f.bed ? f.bed.path : f.bedVolume > 0 && f.song?.path ? f.song.path : undefined);

function renderCut() {
  if (!film) return;
  const f = film;
  ($("#fm-zoom") as HTMLInputElement).value = String(pps);
  ($("#fm-size") as HTMLSelectElement).value = f.size;
  ($("#fm-line-vol") as HTMLInputElement).value = String(f.lineVolume);
  ($("#fm-bed-vol") as HTMLInputElement).value = String(f.bedVolume);
  const bed = $("#fm-bed") as HTMLSelectElement;
  const own = f.bed ? f.bed.path.split(/[\\/]/).pop() : "";
  bed.innerHTML =
    `<option value="none">None</option>` +
    (f.song?.path ? `<option value="song">The film's song</option>` : "") +
    (own ? `<option value="own">${esc(own)}</option>` : "") +
    `<option value="pick">A song from the PC…</option>`;
  bed.value = f.bed ? "own" : f.song?.path && f.bedVolume > 0 ? "song" : "none";
  ($("#fm-bed-vol") as HTMLInputElement).disabled = !bedOf(f);
  $("#fm-exports").innerHTML = f.exports.length
    ? `Exported: ${f.exports.map((p) => `<button type="button" class="linkish" data-open="${esc(p)}">${esc(p.split(/[\\/]/).pop()!)}</button>`).join(", ")}`
    : "";
  $$<HTMLElement>("#fm-exports [data-open]").forEach((b) => b.addEventListener("click", () => deps.openRender(b.dataset.open!)));
  ($("#fm-export") as HTMLButtonElement).disabled = exporting || !cutLayout(f).pieces.length;
  $("#fm-export").textContent = exporting ? "Exporting…" : "Export MP4";
  renderLanes();
  renderInspector();
}

function renderLanes() {
  if (!film) return;
  const f = film;
  const { pieces, total } = cutLayout(f);
  const px = (s: number) => `${(s * pps).toFixed(1)}px`;
  const width = `${Math.max(600, (total + 4) * pps)}px`;
  for (const id of ["#fm-lane-v", "#fm-lane-s", "#fm-lane-d", "#fm-lane-m"]) $(id).style.width = width;
  $("#fm-total").textContent = pieces.length ? `${fmtS(total)} · ${pieces.length} clips` : "Shoot some shots: each one's first take lands here.";
  const missing = f.clips.filter((c) => c.shot && !pickOf(shotOf(c.shot))).length;
  if (missing) $("#fm-total").textContent += ` (${missing} without a take left out)`;
  $("#fm-lane-v").innerHTML = pieces
    .map(({ clip: c, start, len, fade }) => {
      const sh = shotOf(c.shot);
      const t = pickOf(sh);
      const n = sh ? f.shots.indexOf(sh) + 1 : 0;
      const label = c.title != null ? `“${esc(c.title)}”` : `Shot ${n}`;
      return `<div class="fm-clip${c.title != null ? " title" : ""}${c.id === selected ? " on" : ""}${fade ? " fade" : ""}" draggable="true" data-id="${c.id}" style="left:${px(start)};width:${px(len)}" title="${label} · ${fmtS(len)}${fade ? " · crossfades in" : ""} (drag to move it)">${t ? `<img data-thumb="${esc(t.path)}" alt="" draggable="false" />` : ""}<span>${label}</span></div>`;
    })
    .join("");
  fillThumbs($("#fm-lane-v"));
  $("#fm-lane-s").innerHTML = pieces
    .filter((p) => p.clip.shot)
    .map(({ clip: c, start, len }) => `<div class="fm-bar" style="left:${px(start)};width:${px(len)};--v:${Math.min(1, c.volume)}" title="The clip's own sound at ${Math.round(c.volume * 100)}%"></div>`)
    .join("");
  $("#fm-lane-d").innerHTML = pieces
    .flatMap(({ clip: c, start, len }) => {
      const sh = shotOf(c.shot);
      if (!sh || pickOf(sh)?.how === "talk") return [];
      return linePlaces(sh)
        .filter((p) => p.at >= c.in && p.at < c.in + len)
        .map((p) => {
          const who = member(p.line.who)?.name ?? "?";
          const w = Math.min(p.secs, c.in + len - p.at);
          return `<div class="fm-line-bar${p.line.audio ? "" : " unvoiced"}" style="left:${px(start + p.at - c.in)};width:${px(w)}" title="${esc(who)}: ${esc(p.line.text)}${p.line.audio ? "" : " (not voiced yet)"}">${esc(who)}</div>`;
        });
    })
    .join("");
  const b = bedOf(f);
  $("#fm-lane-m").innerHTML = b && total ? `<div class="fm-bar music" style="left:0;width:${px(total)};--v:${Math.min(1, f.bedVolume)}" title="${esc(b.split(/[\\/]/).pop()!)} at ${Math.round(f.bedVolume * 100)}%">${esc(b.split(/[\\/]/).pop()!)}</div>` : "";
}

function renderInspector() {
  const f = film;
  const c = f?.clips.find((x) => x.id === selected);
  const el = $("#fm-inspect");
  if (!f || !c) {
    el.innerHTML = `<p class="muted">Click a clip to trim it, crossfade into it or set its sound; drag it to move it.</p>`;
    return;
  }
  const fade = `<label>Into it<select data-k="fade"><option value="cut"${c.fade ? "" : " selected"}>Cut</option><option value="fade"${c.fade ? " selected" : ""}>Crossfade</option></select></label>`;
  const remove = `<button type="button" class="btn danger" data-act="remove">Take it off</button>`;
  if (c.title != null) {
    el.innerHTML = `<div class="fm-row"><label class="grow">Title card<input data-k="title" type="text" value="${esc(c.title)}" autocomplete="off" /></label><label>Seconds<input data-k="seconds" type="number" min="1" max="15" step="0.5" value="${c.seconds}" /></label>${fade}${remove}</div>`;
    return;
  }
  const sh = shotOf(c.shot);
  const t = pickOf(sh);
  if (!sh || !t) {
    el.innerHTML = `<div class="fm-row"><p class="muted grow">This shot has no take any more.</p>${remove}</div>`;
    return;
  }
  el.innerHTML = `<div class="fm-row">
    <b>Shot ${f.shots.indexOf(sh) + 1}</b><span class="credit">${esc(t.note)} · ${fmtS(t.seconds)}</span>
    <label>In (s)<input data-k="in" type="number" min="0" max="${t.seconds}" step="0.1" value="${c.in}" /></label>
    <label>Out (s)<input data-k="out" type="number" min="0" max="${t.seconds}" step="0.1" value="${c.out || t.seconds}" /></label>
    ${fade}
    <label>Its sound<input data-k="volume" type="range" min="0" max="1.5" step="0.05" value="${c.volume}" /></label>
    <span class="grow"></span>
    <button type="button" class="btn" data-act="back" title="Open its shot: a new take there replaces this one here">Send back</button>
    ${remove}</div>
    <video class="fm-preview" src="${convertFileSrc(t.path)}#t=${c.in},${c.out || t.seconds}" controls preload="metadata" playsinline></video>`;
}

/** A title card as a picture at the film's size: the words in the middle, light on black. */
async function titleCard(text: string, w: number, h: number): Promise<Blob> {
  const cv = document.createElement("canvas");
  cv.width = w;
  cv.height = h;
  const g = cv.getContext("2d")!;
  g.fillStyle = "#000";
  g.fillRect(0, 0, w, h);
  const size = Math.round(h / 11);
  await document.fonts.load(`600 ${size}px Cinzel`).catch(() => {});
  g.font = `600 ${size}px Cinzel, Fraunces, Georgia, serif`;
  g.fillStyle = "#f2ece2";
  g.textAlign = "center";
  g.textBaseline = "middle";
  // Wrapped to 80% of the width.
  const lines: string[] = [];
  for (const para of text.split(/\n/)) {
    let line = "";
    for (const word of para.split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (g.measureText(next).width > w * 0.8 && line) {
        lines.push(line);
        line = word;
      } else line = next;
    }
    lines.push(line);
  }
  const lh = size * 1.3;
  lines.forEach((l, i) => g.fillText(l, w / 2, h / 2 + (i - (lines.length - 1) / 2) * lh));
  return new Promise((res, rej) => cv.toBlob((b) => (b ? res(b) : rej(new Error("couldn't draw the title card"))), "image/png"));
}

/** The timeline to an MP4: the lines are voiced first if they need it, the title cards drawn, then ffmpeg cuts it. */
async function exportFilm() {
  if (!film || exporting) return;
  const f = film;
  const { pieces } = cutLayout(f);
  if (!pieces.length) return;
  exporting = true;
  renderCut();
  status();
  const t0 = Date.now();
  try {
    if (f.shots.some((s) => s.lines.some(unvoiced))) await voiceLines();
    const [w, h] = f.size.split("x").map(Number);
    const out: { path: string; start: number; end: number; fade: boolean; volume: number; still: boolean }[] = [];
    const overlays: { piece: number; at: number; path: string; volume: number }[] = [];
    for (const [i, { clip: c, len, fade }] of pieces.entries()) {
      if (c.title != null) {
        $("#fm-status").textContent = "Drawing the title cards…";
        const path = await writeFile(`title-${c.id}.png`, await titleCard(c.title || " ", w, h));
        out.push({ path, start: 0, end: len, fade: fade > 0, volume: 0, still: true });
        continue;
      }
      const sh = shotOf(c.shot)!;
      const t = pickOf(sh)!;
      out.push({ path: t.path, start: c.in, end: c.in + len, fade: fade > 0, volume: c.volume, still: false });
      // A lip-synced take says its lines itself.
      if (t.how === "talk") continue;
      for (const p of linePlaces(sh)) if (p.line.audio && p.at >= c.in && p.at < c.in + len) overlays.push({ piece: i, at: p.at - c.in, path: p.line.audio, volume: f.lineVolume });
    }
    const b = bedOf(f);
    $("#fm-status").textContent = `Cutting ${fmtS(cutLayout(f).total)} together (ffmpeg)…`;
    const path = await invoke<string>("film_export", {
      root: deps.root(),
      pieces: out,
      overlays,
      bed: b ? { path: b, volume: f.bedVolume } : null,
      width: w,
      height: h,
      fps: 24,
      title: f.name,
    });
    f.exports.push(path);
    if (film === f) persist();
    else saveOther(f);
    deps.toast(`Exported in ${Math.round((Date.now() - t0) / 1000)} s: ${path.split(/[\\/]/).pop()}`);
    deps.openRender(path);
  } catch (e) {
    deps.toast(`Couldn't export the film: ${errMsg(e)}`, "warn");
  } finally {
    exporting = false;
    if (film === f && tab === "cut") renderCut();
    status();
  }
}

/** Studio's Film mode. */
export const filmMode = { opts, create, click };
