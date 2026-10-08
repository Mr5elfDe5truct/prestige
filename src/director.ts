// Director: one prompt becomes a short music video. The chat model plans it (a song: title, style, tempo, lyrics; and
// the shots that tell it, each with the same main subject), ACE-Step makes the song, LTX-2.5 renders each shot, Whisper
// times the lyrics for subtitles, and ffmpeg joins it all (director.rs). It only uses models the Workstation already has,
// one at a time: the chat model is unloaded before ComfyUI renders, and each render unloads before the next.
import { streamChat, type ModelInfo } from "./backends";
import { http } from "./backends";
import { SONG_KEYS, SONG_LANGUAGES } from "./gensettings";
import { VOICE_SERVER } from "./speech";

/** "/director a lonely robot finds a flower" (or /mv, /musicvideo). */
export const DIRECTOR_CMD = /^\/(?:director|mv|music-?video)\b\s*/i;
/** "make me a music video about…", "can you direct a 45 second music video of…". */
export const DIRECTOR_ASK =
  /^(?:(?:hey|ok|okay)[,!]?\s+)?(?:please\s+)?(?:(?:can|could|would|will)\s+you\s+(?:please\s+)?)?(?:make|create|direct|shoot|produce|generate)\s+(?:me\s+|us\s+)?(?:an?\s+)?(?:[\w'-]+\s+){0,3}?music[\s-]?video\b/i;

/** One shot is one LTX-2.5 clip this long (121 frames at 24 fps). */
export const SHOT_SECONDS = 5;
export const MIN_SECONDS = 15;
export const MAX_SECONDS = 60;

export interface Shot {
  action: string; // what happens: the setting, lighting and camera move
  prompt: string; // what LTX-2.5 gets: the look, then the action
}

/* Measured on an RTX 3060 12 GB with Qwen3.8 27B planning: ~45 s to plan (loading the model included), ~95 s for the
 * song (ACE-Step loading after the chat model unloads, then rendering), each 5 s shot ~230 s at 768×512 (~145 s as a
 * draft, which skips the upscale pass but still loads the models), and ~15 s to time the lyrics and join it all. A
 * 20 s video took 1075 s; a 15 s draft 574 s. */
const PLAN_SECS = 45;
export const SONG_SECS = 95;
const SHOT_SECS = { draft: 145, standard: 230 };
const FINISH_SECS = 15;
/** How long a music video takes, in seconds. */
export const directorSecs = (seconds: number, draft: boolean) => PLAN_SECS + SONG_SECS + shotsFor(seconds) * SHOT_SECS[draft ? "draft" : "standard"] + FINISH_SECS;

export interface VideoPlan {
  title: string;
  style: string;
  bpm?: number;
  key?: string;
  language?: string;
  lyrics: string;
  look: string; // the main subject and the visual style, the same in every shot
  shots: Shot[];
  seconds: number;
}

/** The length asked for ("a 45 second music video", "1 minute"), within 15 to 60 s; 30 s otherwise. */
export function askedSeconds(idea: string): number {
  const m = idea.match(/(\d+(?:\.\d+)?)\s*(s|secs?|seconds?|min(?:ute)?s?)\b/i);
  if (!m) return 30;
  const n = Number(m[1]) * (/^m/i.test(m[2]) ? 60 : 1);
  return Math.min(MAX_SECONDS, Math.max(MIN_SECONDS, Math.round(n / SHOT_SECONDS) * SHOT_SECONDS));
}

const shotsFor = (seconds: number) => Math.ceil(seconds / SHOT_SECONDS);

const SYSTEM = (seconds: number) => {
  const n = shotsFor(seconds);
  const lines = Math.max(4, Math.round(seconds / 5));
  return `You direct short music videos. For the idea you're given, write the song and plan the shots that tell it.
Reply with one JSON object and nothing else:
{"title": "...", "style": "...", "bpm": 100, "key": "A minor", "language": "en", "lyrics": "...", "look": "...", "shots": [{"action": "..."}]}
- The song is ${seconds} seconds long. style: 8 to 20 comma-separated tags for the music model: genre, mood, instruments, vocal type and gender, production. bpm: 60 to 180. key: like "C major" or "F# minor". language: the lyrics' language code, English unless asked otherwise.
- lyrics: ${lines} short sung lines at most, with each part's tag on its own line ([Verse], [Chorus]) and a blank line between parts. Singable lines that rhyme. If the idea asks for an instrumental, set lyrics to "".
- look: one sentence that fixes the main subject (who or what, their appearance, clothes, colours) and the visual style (e.g. cinematic, anime, claymation, film grain). It goes in front of every shot, so the subject looks the same in each.
- shots: exactly ${n}, in story order, ${SHOT_SECONDS} seconds each, following the song (verse, then chorus). Each action is for a text-to-video model: 30 to 60 words in one paragraph saying what happens, the setting, the lighting and one camera move. Call the subject by a short name ("the fox", "she") and don't describe its looks again. Vary the framing (wide, medium, close-up) and the places. No words, signs or captions on screen, no cuts inside a shot.`;
};

function firstJson(text: string): any {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}

function normKey(k: unknown): string | undefined {
  const m = String(k ?? "").trim().match(/^([A-Ga-g])\s*(#|b|♯|♭)?\s*(maj(?:or)?|min(?:or)?|m)?$/);
  if (!m) return undefined;
  const flats: Record<string, string> = { Db: "C#", "D#": "Eb", Gb: "F#", "G#": "Ab", "A#": "Bb", Cb: "B", Fb: "E", "E#": "F", "B#": "C" };
  let root = m[1].toUpperCase() + (m[2] === "♯" ? "#" : m[2] === "♭" ? "b" : (m[2] ?? ""));
  root = flats[root] ?? root;
  const key = `${root} ${m[3] && /^m(in|$)/i.test(m[3]) ? "minor" : "major"}`;
  return SONG_KEYS.includes(key) ? key : undefined;
}

/** The chat model plans the video: the song and one prompt per shot (no thinking, so it's quick). */
export async function planVideo(model: ModelInfo, idea: string, seconds: number, signal: AbortSignal, onText?: (chars: number) => void): Promise<VideoPlan> {
  let out = "";
  await streamChat(
    model,
    [
      { role: "system", content: SYSTEM(seconds) },
      { role: "user", content: idea },
    ],
    {
      onToken: (t) => {
        out += t;
        onText?.(out.length);
      },
      onThinking: () => {},
      onStats: () => {},
    },
    signal,
    undefined,
    { think: false },
  );
  const j = firstJson(out.replace(/<think>[\s\S]*?<\/think>/g, ""));
  if (!j || !Array.isArray(j.shots) || !j.shots.length) throw new Error(`${model.name} didn't plan the shots (try again, or another model)`);
  const n = shotsFor(seconds);
  const look = String(j.look ?? "").trim();
  let actions: string[] = j.shots.map((s: any) => String(s?.action ?? s?.prompt ?? s ?? "").trim()).filter(Boolean);
  if (!actions.length) throw new Error(`${model.name} didn't plan the shots (try again, or another model)`);
  // Exactly enough shots for the song: the first ideas again if the model gave too few.
  while (actions.length < n) actions.push(actions[actions.length % Math.max(1, actions.length)]);
  actions = actions.slice(0, n);
  // The look goes in front of every shot, so the subject looks the same in each.
  const shots: Shot[] = actions.map((action) => ({ action, prompt: look ? `${look} ${action}` : action }));
  const lyrics = String(j.lyrics ?? "").replace(/\r/g, "").trim();
  const bpm = Math.round(Number(j.bpm));
  const lang = String(j.language ?? "").toLowerCase().trim();
  return {
    title: String(j.title ?? "").trim() || idea.slice(0, 60),
    style: String(j.style ?? "").trim() || idea,
    bpm: bpm >= 40 && bpm <= 220 ? bpm : undefined,
    key: normKey(j.key),
    language: SONG_LANGUAGES.some(([c]) => c === lang) ? lang : undefined,
    lyrics: /^\[?(instrumental|inst)\]?$/i.test(lyrics) ? "" : lyrics,
    look,
    shots,
    seconds,
  };
}

// ---------- subtitles ----------
interface Word {
  start: number;
  end: number;
  word: string;
}

const norm = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");

/** The sung lines (no [Verse] / [Chorus] tags, no blank lines). */
export const sungLines = (lyrics: string) =>
  lyrics
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^\[.*\]$/.test(l));

/** When each lyric line is sung: Whisper writes down the song with a time on every word, and the lyrics are matched to
 *  those words in order (the longest common run of words), so each line starts at its first matched word and ends at
 *  its last. Lines Whisper missed are fitted between their neighbours. Returns the subtitles as SRT. */
export async function lyricsSrt(song: Blob, lyrics: string, seconds: number): Promise<string> {
  const lines = sungLines(lyrics);
  if (!lines.length) return "";
  const fd = new FormData();
  fd.append("file", song, "song.mp3");
  fd.append("response_format", "verbose_json");
  const r = await http(`${VOICE_SERVER}/v1/audio/transcriptions`, { method: "POST", body: fd });
  if (!r.ok) throw new Error(`the voice server answered ${r.status}`);
  const j = await r.json();
  const heard: Word[] = (j.segments ?? []).flatMap((s: any) => s.words ?? []).filter((w: Word) => norm(w.word));
  // The lyrics' words, each knowing its line.
  const lyr: { w: string; line: number }[] = [];
  lines.forEach((l, i) => l.split(/\s+/).forEach((w) => norm(w) && lyr.push({ w: norm(w), line: i })));
  // Longest common subsequence of the two word lists (a few hundred words at most).
  const a = lyr.map((x) => x.w);
  const b = heard.map((x) => norm(x.word));
  const L = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--)
    for (let k = b.length - 1; k >= 0; k--) L[i][k] = a[i] === b[k] ? L[i + 1][k + 1] + 1 : Math.max(L[i + 1][k], L[i][k + 1]);
  const times: { start?: number; end?: number }[] = lines.map(() => ({}));
  for (let i = 0, k = 0; i < a.length && k < b.length; ) {
    if (a[i] === b[k]) {
      const t = times[lyr[i].line];
      t.start ??= heard[k].start;
      t.end = heard[k].end;
      i++;
      k++;
    } else if (L[i + 1][k] >= L[i][k + 1]) i++;
    else k++;
  }
  // Lines with no match share the gap between the lines around them.
  for (let i = 0; i < lines.length; i++) {
    if (times[i].start != null) continue;
    let j2 = i;
    while (j2 < lines.length && times[j2].start == null) j2++;
    const from = i ? (times[i - 1].end ?? 0) : 0;
    const to = j2 < lines.length ? times[j2].start! : seconds;
    const step = (to - from) / (j2 - i);
    for (let x = i; x < j2; x++) times[x] = { start: from + step * (x - i), end: from + step * (x - i + 1) };
  }
  const ts = (s: number) => {
    const ms = Math.max(0, Math.round(s * 1000));
    const p = (n: number, w = 2) => String(n).padStart(w, "0");
    return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
  };
  let shown = 0; // where the previous line came off the screen
  return lines
    .map((l, i) => {
      let s = Math.min(times[i].start!, seconds);
      // Keep a line up for a second and a half after it's sung, or until the next one starts.
      const next = i + 1 < lines.length ? times[i + 1].start! : seconds;
      const e = Math.min(seconds, next, times[i].end! + 1.5);
      // A line Whisper barely caught still gets ~1.5 s, from the gap before it.
      if (e - s < 1.5) s = Math.max(shown, Math.min(s, e - 1.5));
      if (e <= s) return "";
      shown = e;
      return `${i + 1}\n${ts(s)} --> ${ts(e)}\n${l}\n`;
    })
    .filter(Boolean)
    .join("\n");
}
