// Audio drama (/drama or /podcast): the chat model writes a short play or podcast for up to 16 voices, with cues like
// [laughs] and [whispering]; the cast card gives each character a saved voice (or Drama 3's own), the script can be
// changed there, and Fish Audio's Drama 3 reads it all in one pass (drama.rs), with an optional ACE-Step music bed.
import { streamChat, type ModelInfo } from "./backends";

/** "/drama a ghost story in a lighthouse" or "/podcast two hosts arguing about pineapple pizza". */
export const DRAMA_CMD = /^\/(drama|podcast)\b\s*/i;

export interface CastMember {
  name: string;
  about: string; // who they are and how they sound, for picking a voice
}
export interface Line {
  who: string;
  text: string; // may hold cues: [laughs], [sighs], [whispering]…
}
export interface Script {
  title: string;
  music: string; // a style for the music bed, or "" for none
  cast: CastMember[];
  lines: Line[];
}

/** Drama 3 takes speakers 0 to 15. */
export const MAX_CAST = 16;
/** Speech is ~2.6 words a second; a script is asked for at about this many seconds. */
const DEFAULT_SECONDS = 90;
/** Cues Drama 3 was trained to act. */
export const CUES = ["laughs", "chuckles", "sighs", "gasps", "whispering", "shouting", "crying", "clears throat", "pause"];

const SYSTEM = (seconds: number) => `You write short audio plays and podcasts that a speech model performs with several voices.

Write about ${seconds} seconds of spoken dialogue (about ${Math.round(seconds * 2.6)} words) for the request. Two to four characters suit most requests; never more than ${MAX_CAST}. Give each one a distinct way of speaking. Only dialogue: no narrator unless the request asks for one, no stage directions except these cues inside a line, used sparingly where they help: ${CUES.map((c) => `[${c}]`).join(", ")}. No sound effects, no music cues, no markdown.

Answer with JSON only:
{"title": "...", "music": "a short music style for a quiet background bed, or empty for none", "cast": [{"name": "...", "about": "who they are and how they sound"}], "lines": [{"who": "a cast name", "text": "what they say"}]}`;

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

/** How many seconds were asked for ("a 2 minute podcast", "30 seconds"), within 20 s to 5 min. */
export function askedSeconds(text: string): number {
  const m = text.match(/(\d+(?:\.\d+)?)\s*(seconds?|secs?|s\b|minutes?|mins?)/i);
  if (!m) return DEFAULT_SECONDS;
  const n = Number(m[1]) * (/^m/i.test(m[2]) ? 60 : 1);
  return Math.min(300, Math.max(20, Math.round(n)));
}

/** The chat model writes the script. */
export async function writeDrama(model: ModelInfo, request: string, signal: AbortSignal, onText?: (chars: number) => void): Promise<Script> {
  let out = "";
  await streamChat(
    model,
    [
      { role: "system", content: SYSTEM(askedSeconds(request)) },
      { role: "user", content: request },
    ],
    { onToken: (t) => (out += t, onText?.(out.length)), onThinking: () => {}, onStats: () => {} },
    signal,
    undefined,
    { think: false },
  );
  const j = firstJson(out);
  if (!j || !Array.isArray(j.lines)) throw new Error(`${model.name} didn't write a script`);
  const lines: Line[] = j.lines.map((l: any) => ({ who: String(l?.who ?? "").trim(), text: String(l?.text ?? "").trim() })).filter((l: Line) => l.who && l.text);
  const named = new Map<string, CastMember>();
  for (const c of Array.isArray(j.cast) ? j.cast : []) {
    const name = String(c?.name ?? "").trim();
    if (name) named.set(name.toLowerCase(), { name, about: String(c?.about ?? "").trim() });
  }
  // Anyone who speaks is in the cast, in the order they first speak.
  const cast: CastMember[] = [];
  for (const l of lines) {
    const k = l.who.toLowerCase();
    if (!cast.some((c) => c.name.toLowerCase() === k)) cast.push(named.get(k) ?? { name: l.who, about: "" });
  }
  if (!lines.length) throw new Error(`${model.name}'s script had no lines`);
  return { title: String(j.title ?? "").trim() || request.slice(0, 60), music: String(j.music ?? "").trim(), cast: cast.slice(0, MAX_CAST), lines };
}

/** The script as text to read and change: one "Name: words" line each. */
export const scriptText = (s: Script) => s.lines.map((l) => `${l.who}: ${l.text}`).join("\n");

/** Changed script text back into lines (a line without "Name:" carries on the line before it). */
export function parseScript(text: string, cast: CastMember[]): Line[] {
  const lines: Line[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const t = raw.trim();
    if (!t) continue;
    const m = t.match(/^([^:\[\]]{1,40}):\s*(.+)$/);
    if (m && cast.some((c) => c.name.toLowerCase() === m[1].trim().toLowerCase())) lines.push({ who: m[1].trim(), text: m[2].trim() });
    else if (lines.length) lines[lines.length - 1].text += ` ${t}`;
  }
  return lines;
}

/** The script with Drama 3's speaker tags (each cast member's number is their place in the cast), on one line so it's
 *  read as one request and Drama 3's own chunking keeps the voices consistent. */
export function taggedText(lines: Line[], cast: CastMember[]): string {
  const num = (who: string) => Math.max(0, cast.findIndex((c) => c.name.toLowerCase() === who.toLowerCase()));
  return lines.map((l) => `<|speaker:${num(l.who)}|> ${l.text.replace(/\s+/g, " ")}`).join(" ");
}

/** Seconds of speech a script makes, roughly. */
export const scriptSeconds = (lines: Line[]) => Math.max(5, lines.reduce((n, l) => n + l.text.replace(/\[[^\]]*\]/g, "").split(/\s+/).filter(Boolean).length, 0) / 2.6);
