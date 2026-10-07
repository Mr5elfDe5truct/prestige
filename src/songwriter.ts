// Songwriting for ACE-Step: the chat model turns a request ("a sea shanty about debugging") into a title, a style
// (the tags ACE-Step reads: genre, mood, instruments, voice), a tempo, a key, the lyrics' language and lyrics marked
// with [Verse] / [Chorus] / [Bridge], sized to the song's length. Chat's /song renders the result; Studio's Music
// mode uses it to fill the lyrics box.
import { streamChat, type ModelInfo } from "./backends";
import { SONG_KEYS, SONG_LANGUAGES } from "./gensettings";

/** "/song a sea shanty about debugging" (or /music). */
export const SONG_CMD = /^\/(?:song|music)\b\s*/i;

export interface Song {
  title: string;
  style: string;
  lyrics: string; // "" for an instrumental
  bpm?: number;
  key?: string;
  language?: string;
}

/** About how many sung lines fit a song this long (a line every ~5 s, with room for an intro and breaks). */
const linesFor = (seconds: number) => Math.max(6, Math.round(seconds / 5));
/** The parts that fit a song this long. */
const partsFor = (seconds: number) =>
  seconds <= 45
    ? "one verse and a chorus"
    : seconds <= 100
      ? "a verse, a chorus, a second verse and the chorus again"
      : seconds <= 170
        ? "two verses, a chorus after each, a short bridge and a last chorus"
        : "an intro, two verses with pre-choruses, choruses, a bridge, a last chorus and an outro";

const SYSTEM = (seconds: number) =>
  `You write songs for ACE-Step, a music model that sings the lyrics you give it in the style you describe.
Reply with one JSON object and nothing else:
{"title": "...", "style": "...", "bpm": 120, "key": "A minor", "language": "en", "lyrics": "..."}
- style: 8 to 20 comma-separated tags: genre, mood, instruments, vocal type and gender, production. Example: "indie folk, warm, acoustic guitar, soft male vocals, harmonica, intimate".
- bpm: a whole number from 60 to 180 that suits the style. key: like "C major" or "F# minor".
- language: the lyrics' language as a code (en, es, fr, de, ja, ko, zh, pt, it, ru…), English unless asked otherwise.
- lyrics: for a ${seconds}-second song, ${linesFor(seconds)} sung lines at most (not counting the tags): ${partsFor(seconds)}. More lines than that get rushed or cut off. Put each part's tag on its own line ([Intro], [Verse 1], [Pre-Chorus], [Chorus], [Verse 2], [Bridge], [Outro]) and leave a blank line between parts. Short, singable lines that rhyme; a chorus that repeats. No stage directions, no notes, no title inside the lyrics.
- If the request asks for an instrumental (no vocals), set lyrics to "".
- If the request already contains lyrics, keep them as they are, adding part tags only where they're missing.`;

/** The first JSON object in a reply (models wrap it in prose or code fences). */
function firstJson(text: string): any {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}

/** A key the workflow accepts ("a minor" → "A minor", "F#m" → "F# minor"), or undefined. */
function normKey(k: unknown): string | undefined {
  const m = String(k ?? "").trim().match(/^([A-Ga-g])\s*(#|b|♯|♭)?\s*(maj(?:or)?|min(?:or)?|m)?$/);
  if (!m) return undefined;
  const flats: Record<string, string> = { Db: "C#", "D#": "Eb", Gb: "F#", "G#": "Ab", "A#": "Bb", Cb: "B", Fb: "E", "E#": "F", "B#": "C" };
  let root = m[1].toUpperCase() + (m[2] === "♯" ? "#" : m[2] === "♭" ? "b" : m[2] ?? "");
  root = flats[root] ?? root;
  const key = `${root} ${m[3] && /^m(in|$)/i.test(m[3]) ? "minor" : "major"}`;
  return SONG_KEYS.includes(key) ? key : undefined;
}

/** Writes a song for the request with the chat model (no thinking, so it's quick). */
export async function writeSong(model: ModelInfo, request: string, seconds: number, signal: AbortSignal, onText?: (chars: number) => void): Promise<Song> {
  let out = "";
  await streamChat(
    model,
    [
      { role: "system", content: SYSTEM(seconds) },
      { role: "user", content: request },
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
  out = out.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  const j = firstJson(out);
  if (!j) {
    // No JSON: take the reply as lyrics and the request as the style.
    const lyrics = out.replace(/^```\w*|```$/g, "").trim();
    if (!lyrics) throw new Error(`${model.name} didn't write anything`);
    return { title: request.slice(0, 60), style: request, lyrics };
  }
  const bpm = Math.round(Number(j.bpm));
  const lang = String(j.language ?? "").toLowerCase().trim();
  const lyrics = String(j.lyrics ?? "").replace(/\r/g, "").trim();
  return {
    title: String(j.title ?? "").trim() || request.slice(0, 60),
    style: String(j.style ?? "").trim() || request,
    lyrics: /^\[?(instrumental|inst)\]?$/i.test(lyrics) ? "" : lyrics,
    bpm: bpm >= 40 && bpm <= 220 ? bpm : undefined,
    key: normKey(j.key),
    language: SONG_LANGUAGES.some(([c]) => c === lang) ? lang : undefined,
  };
}
