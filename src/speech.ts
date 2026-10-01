// Speech in and out, using the engines the stack already runs:
// - speech-to-text: Open WebUI's built-in faster-whisper (POST /api/v1/audio/transcriptions)
// - text-to-speech: Kokoro-FastAPI on :8880 (OpenAI-compatible /v1/audio/speech), voice af_heart by default
// Replies are spoken sentence by sentence while they stream, through a WebAudio analyser that drives the avatar.
import { errMsg, http } from "./backends";
import type { MemoryConfig } from "./memory";

export const KOKORO = "http://127.0.0.1:8880";
export const DEFAULT_VOICE = "af_heart"; // AUDIO_TTS_VOICE in start-all.ps1

// ---------- shared audio graph ----------
let ctx: AudioContext | null = null;
let outAnalyser: AnalyserNode | null = null;
let micAnalyser: AnalyserNode | null = null;

export function audio() {
  if (!ctx) {
    ctx = new AudioContext();
    outAnalyser = ctx.createAnalyser();
    outAnalyser.fftSize = 512;
    outAnalyser.connect(ctx.destination);
  }
  if (ctx.state === "suspended") ctx.resume();
  return ctx;
}

function rms(a: AnalyserNode | null) {
  if (!a) return 0;
  const buf = new Float32Array(a.fftSize);
  a.getFloatTimeDomainData(buf);
  let s = 0;
  for (const v of buf) s += v * v;
  return Math.sqrt(s / buf.length);
}

/** 0..1 loudness of what Prestige is saying right now. */
export const outputLevel = () => Math.min(1, rms(outAnalyser) * 4);
/** 0..1 loudness of the microphone (when it's open). */
export const micLevel = () => Math.min(1, rms(micAnalyser) * 6);
export const micRms = () => rms(micAnalyser);

// ---------- text cleanup ----------
/** What a person would read aloud: no code, no markdown symbols, no links. */
export function speakable(md: string) {
  return md
    .replace(/```[\s\S]*?(```|$)/g, " (code omitted) ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "a link")
    .replace(/^\s{0,3}#{1,6}\s*/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/\|/g, ", ")
    .replace(/(\*\*|__|\*|_|~~)/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------- text to speech ----------
interface Clip {
  text: string;
  audio: Promise<AudioBuffer | null>;
}

let queue: Clip[] = [];
let playing: AudioBufferSourceNode | null = null;
let pumping = false;
let generation = 0;
let pendingText = "";
let inFence = false;
let voice = DEFAULT_VOICE;
let onState: (speaking: boolean) => void = () => {};

export function setVoice(v: string) {
  voice = v || DEFAULT_VOICE;
}
export function onSpeakingChange(fn: (speaking: boolean) => void) {
  onState = fn;
}
export const isSpeaking = () => !!playing || queue.length > 0;

async function synth(text: string, gen: number): Promise<AudioBuffer | null> {
  try {
    const r = await http(`${KOKORO}/v1/audio/speech`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "kokoro", input: text, voice, response_format: "mp3", speed: 1.0 }),
    });
    if (!r.ok) throw new Error(`Kokoro answered ${r.status}`);
    const buf = await r.arrayBuffer();
    if (gen !== generation) return null;
    return await audio().decodeAudioData(buf);
  } catch (e) {
    console.warn("TTS failed:", errMsg(e));
    return null;
  }
}

function enqueue(sentence: string) {
  const text = speakable(sentence);
  if (!/[a-z0-9]/i.test(text)) return;
  // Start synthesizing right away so the next sentence is ready when this one ends.
  queue.push({ text, audio: synth(text, generation) });
  pump();
}

async function pump() {
  if (pumping) return;
  pumping = true;
  const gen = generation;
  onState(true);
  while (queue.length && gen === generation) {
    const clip = queue[0];
    const buf = await clip.audio;
    if (gen !== generation) break;
    queue.shift();
    if (!buf) continue;
    await new Promise<void>((done) => {
      const src = audio().createBufferSource();
      src.buffer = buf;
      src.connect(outAnalyser!);
      src.onended = () => done();
      playing = src;
      src.start();
    });
    playing = null;
  }
  pumping = false;
  if (gen === generation) onState(false);
}

/** Feed streamed reply text; complete sentences are spoken as soon as they arrive. */
export function speakDelta(delta: string) {
  pendingText += delta;
  for (;;) {
    // Hold back fenced code until the fence closes, so it's skipped as one block.
    const fence = pendingText.indexOf("```");
    if (!inFence && fence >= 0) {
      const before = pendingText.slice(0, fence);
      flushSentences(before, true);
      pendingText = pendingText.slice(fence + 3);
      inFence = true;
      continue;
    }
    if (inFence) {
      const end = pendingText.indexOf("```");
      if (end < 0) return;
      pendingText = pendingText.slice(end + 3);
      inFence = false;
      enqueue("(code omitted)");
      continue;
    }
    break;
  }
  pendingText = flushSentences(pendingText, false);
}

/** Speaks every finished sentence in `text`; returns the unfinished tail (or nothing when `all`). */
function flushSentences(text: string, all: boolean) {
  const re = /[^.!?\n]*?(?:[.!?]+["')\]]*(?=\s)|\n+)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (!m[0]) {
      re.lastIndex++;
      continue;
    }
    // Keep very short fragments ("e.g.", "1.") with the next sentence.
    if (m[0].trim().length < 12 && !m[0].includes("\n")) continue;
    enqueue(text.slice(last, re.lastIndex));
    last = re.lastIndex;
  }
  const rest = text.slice(last);
  if (all) {
    enqueue(rest);
    return "";
  }
  return rest;
}

/** The reply finished streaming: speak whatever is left. */
export function speakEnd() {
  if (!inFence) flushSentences(pendingText, true);
  pendingText = "";
  inFence = false;
}

export function speak(text: string) {
  speakDelta(text);
  speakEnd();
}

/** Stops talking immediately and drops anything queued. */
export function stopSpeaking() {
  generation++;
  queue = [];
  pendingText = "";
  inFence = false;
  try {
    playing?.stop();
  } catch {
    /* already stopped */
  }
  playing = null;
  pumping = false;
  onState(false);
}

export async function listVoices(): Promise<string[]> {
  try {
    const r = await http(`${KOKORO}/v1/audio/voices`);
    const j = await r.json();
    const v: string[] = Array.isArray(j) ? j : j.voices ?? [];
    return v.map((x: any) => (typeof x === "string" ? x : x.id ?? x.name)).filter(Boolean);
  } catch {
    return [];
  }
}

// ---------- microphone ----------
let micStream: MediaStream | null = null;

export async function openMic(): Promise<MediaStream> {
  if (micStream && micStream.getTracks().some((t) => t.readyState === "live")) return micStream;
  micStream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const src = audio().createMediaStreamSource(micStream);
  micAnalyser = audio().createAnalyser();
  micAnalyser.fftSize = 1024;
  src.connect(micAnalyser);
  return micStream;
}

export function closeMic() {
  micStream?.getTracks().forEach((t) => t.stop());
  micStream = null;
  micAnalyser = null;
}

/** Records the mic until stop() is called. */
export function record(stream: MediaStream) {
  const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
  const rec = new MediaRecorder(stream, { mimeType: mime });
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const done = new Promise<Blob>((res) => (rec.onstop = () => res(new Blob(chunks, { type: "audio/webm" }))));
  rec.start(250);
  return {
    stop: () => {
      if (rec.state !== "inactive") rec.stop();
      return done;
    },
    started: performance.now(),
  };
}

// ---------- speech to text ----------
export async function transcribe(cfg: MemoryConfig | null, blob: Blob): Promise<string> {
  if (!cfg) throw new Error("connect Open WebUI in Settings first (its Whisper does the speech-to-text)");
  const fd = new FormData();
  fd.append("file", new File([blob], "speech.webm", { type: "audio/webm" }));
  // Whisper guesses the language from the first seconds and can pick the wrong one on short or quiet takes.
  fd.append("language", "en");
  let r: Response;
  try {
    r = await http(`${cfg.url}/api/v1/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.key}` },
      body: fd,
    });
  } catch (e) {
    throw new Error(errMsg(e) === "not reachable" ? "Open WebUI isn't running" : errMsg(e));
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.detail ? String(j.detail) : `Open WebUI answered ${r.status}`);
  return String(j.text ?? "").trim();
}
