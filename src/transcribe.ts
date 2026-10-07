// Transcribe: drop a recording or a video into a chat (or /transcribe to pick one) and get the words with who said them,
// then a summary from the chat model. The Workstation does the listening (tools\transcribe.py: Phonon-2 for the words on
// the CPU, Nemotron 3 Diarization for the speakers on a GPU); transcribe.rs runs it and passes on its progress.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/** "/transcribe" (or /tr) opens the file picker; a file can also be dropped or attached. */
export const TRANSCRIBE_CMD = /^\/(?:transcribe|tr)\b\s*/i;

const EXT = /\.(mp3|wav|m4a|aac|flac|ogg|opus|wma|aiff?|amr|mp4|mkv|mov|webm|avi|wmv|m4v|mpe?g|3gp|ts)$/i;

/** Audio and video files go to Transcribe rather than Knowledge. */
export const isMedia = (f: File) => /^(audio|video)\//.test(f.type) || EXT.test(f.name);

export interface Turn {
  speaker: number;
  start: number;
  end: number;
  text: string;
}

export interface Transcript {
  duration: number;
  speakers: number; // 0 when the speakers couldn't be told apart (or weren't asked for)
  turns: Turn[];
  text: string;
  seconds: { convert: number; speakers: number; words: number; total: number };
  engines: { words: string; speakers: string | null; speakers_error: string | null; clips: number };
}

/** A file from the chat (its bytes) or a path from the picker. */
export type MediaSource = { file: File } | { path: string; name: string };

/** Runs the transcription; `progress` hears the Workstation's steps. */
export async function transcribeMedia(src: MediaSource, root: string | null, progress: (pct: number, what: string) => void): Promise<Transcript> {
  const off = await listen<{ pct: number; what: string }>("transcribe", (e) => progress(e.payload.pct, e.payload.what));
  try {
    if ("path" in src) return await invoke<Transcript>("transcribe_file", { root, path: src.path, speakers: true });
    const bytes = new Uint8Array(await src.file.arrayBuffer());
    return await invoke<Transcript>("transcribe_bytes", bytes, { headers: { "x-name": src.file.name, "x-root": root ?? "", "x-speakers": "1" } });
  } finally {
    off();
  }
}

/** "1:05", "1:02:09". */
export function clock(s: number) {
  const t = Math.max(0, Math.round(s));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const ss = String(t % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

const who = (t: Transcript, n: number) => (t.speakers ? `Speaker ${n}` : "");

/** The transcript as Markdown: one paragraph per turn, with the speaker and the time it starts. */
export function transcriptMd(t: Transcript): string {
  return t.turns
    .map((x) => {
      const head = [who(t, x.speaker), clock(x.start)].filter(Boolean).join(" · ");
      return `**${head}**  \n${x.text.replace(/([*_`<>])/g, "\\$1")}`;
    })
    .join("\n\n");
}

/** The transcript as plain lines for the summarising model (cut to `max` characters, keeping the start and end). */
export function transcriptText(t: Transcript, max = 40_000): string {
  const all = t.turns.map((x) => `[${clock(x.start)}] ${who(t, x.speaker) || "Speaker"}: ${x.text}`).join("\n");
  if (all.length <= max) return all;
  return `${all.slice(0, max * 0.75)}\n…(${Math.round((all.length - max) / 1000)}k characters of the middle left out)…\n${all.slice(-max * 0.25)}`;
}

/** What the chat model is asked for. */
export function summaryPrompt(name: string, t: Transcript): string {
  return (
    `Here is an automatic transcript of "${name}" (${clock(t.duration)} long${t.speakers ? `, ${t.speakers} speaker${t.speakers === 1 ? "" : "s"} told apart by voice; the labels may be imperfect` : ""}).\n\n` +
    "Write, in Markdown:\n" +
    "1. **Overview**: two or three sentences on what it is and what happened.\n" +
    "2. **Key points**: the main points as bullets.\n" +
    "3. **Decisions** and **Action items** (who does what, by when), if there are any; leave a section out when there's nothing for it.\n" +
    "Refer to people as the transcript does (Speaker 1, Speaker 2…) unless they're named in it. Don't repeat the transcript.\n\n" +
    `Transcript:\n${transcriptText(t)}`
  );
}
