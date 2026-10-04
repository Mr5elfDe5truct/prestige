// Live mode: a hands-free call with Prestige, like a video call. The mic is always open; a voice-activity detector
// cuts each utterance (with a short pre-roll so the first syllable isn't lost), Whisper turbo transcribes it, the
// Live model answers (with the current webcam frame when the camera is on) and the reply is spoken sentence by
// sentence as it streams. Talking over Prestige stops its speech and its reply at once and it listens again.
// Every turn lands in the normal chat history. Everything runs on this PC.
// Its own file, not an inlined data: URL, which the app's content security policy would block.
import workletUrl from "./mic-worklet.js?url&no-inline";
import markSvg from "./assets/rg-mark.svg?raw";
import { errMsg, freeLlamaVram, http, OLLAMA, type ModelInfo } from "./backends";
import { freeGB, readGpus, sharesCard } from "./gpus";
import { audio, isVox, listVoices, outputLevel, transcribe, DEFAULT_VOICE, VOICE_SERVER } from "./speech";
import { LiveSpeaker } from "./livespeech";
import { snapshot } from "./camera";
import type { MemoryConfig } from "./memory";

const $ = <T extends HTMLElement = HTMLElement>(s: string, r: ParentNode = document) => r.querySelector(s) as T;

/** Context for the Live model: a call needs far less than chat's 32k, and the smaller cache leaves VRAM headroom. */
export const LIVE_CTX = 16384;
/** Live models, best first, with the GPU memory each takes in a call (measured with nvidia-smi: weights, a 16k
 *  context and a camera frame; GB of 10^9 bytes, as the voice server reports free memory). Both can see. The 4B is used when it fits; next to VoxCPM2 (~6 GB) and Whisper
 *  (~1 GB) on a 12 GB card it doesn't leave enough room, so a VoxCPM2 voice gets the 2B. */
export const LIVE_MODELS = [
  { id: "qwen3.5:4b", gb: 4.4 },
  { id: "qwen3.5:2b", gb: 3.4 },
];
/** GPU memory kept free for Windows, Prestige's window and the camera. Short of it, Windows spills into system RAM
 *  and speech slows to a crawl instead of failing. */
const HEADROOM_GB = 1.0;

interface Hooks {
  onDelta: (t: string) => void;
  onDone: (ok: boolean) => void;
}

interface Deps {
  toast: (msg: string, kind?: string) => void;
  memCfg: () => MemoryConfig | null;
  /** The installed Live models, best first. */
  liveModels: () => ModelInfo[];
  /** A call starts its own chat in the history. */
  beginChat: () => void;
  /** One turn: the transcript (and camera frame) go into the chat; the reply streams to the hooks. */
  send: (text: string, images: string[] | undefined, model: ModelInfo, hooks: Hooks) => void;
  stopReply: () => void;
  isReplying: () => boolean;
  /** Takes back the last turn (a reply cut off before it said anything, when the user was only pausing). */
  retractTurn: () => string | null;
  getVoice: () => string | undefined;
  setVoiceSetting: (v: string) => void;
  getCamera: () => string | undefined;
  getLiveCamera: () => boolean;
  setLiveCamera: (on: boolean) => void;
  openCatalog: () => void;
  /** The call ended; show the chat it was saved to. */
  ended: () => void;
}

type State = "off" | "starting" | "listening" | "hearing" | "transcribing" | "thinking" | "speaking" | "error";

const STATUS: Record<State, string> = {
  off: "",
  starting: "Getting ready…",
  listening: "Listening · just talk",
  hearing: "Listening…",
  transcribing: "Got it…",
  thinking: "Thinking…",
  speaking: "Speaking · talk to interrupt",
  error: "",
};

// Voice-activity detection, on ~21 ms blocks of the echo-cancelled mic.
const PREROLL_SEC = 0.45; // kept from before speech is detected
const BARGE_PREROLL_SEC = 1.0; // more when interrupting: the words that did it are part of what they're saying
const HANGOVER_MS = 650; // this much silence ends an utterance
// Voice in 4 of the last 6 blocks (~85 ms) starts listening; talking over Prestige takes louder voice in 9 of the
// last 14 (~190 ms of a ~300 ms window, so the gaps between words don't reset it).
const START = { need: 4, of: 6 };
const BARGE = { need: 9, of: 14 };
const MIN_SPEECH_MS = 260; // shorter bursts (a cough, a click) are ignored
const MAX_UTTERANCE_MS = 30_000;

let deps: Deps;
let state: State = "off";
let model: ModelInfo | null = null;
let micStream: MediaStream | null = null;
let camStream: MediaStream | null = null;
let node: AudioWorkletNode | null = null;
let source: MediaStreamAudioSourceNode | null = null;
let muted = false;
let camOn = false;
let callStart = 0;
let timer = 0;
let warmTimer = 0;
let raf = 0;
let micLvl = 0;
const speaker = new LiveSpeaker();

// VAD state
let floor = 0.008;
let recent: boolean[] = []; // loud or not, for the last few blocks
let ring: Float32Array[] = [];
let utter: Float32Array[] | null = null;
let utterStart = 0;
let lastVoiced = 0;
let voicedMs = 0;
// A turn in flight
let turn: { end: number; stt?: number; token?: number; audio?: number; heard?: boolean } | null = null;
let replyText = "";
let interruptedSilent = false; // the reply was stopped before it said anything: merge the next utterance into it
let carry = "";
let replying = false; // a reply for this call is streaming
let spoken = ""; // the reply that was playing when the user cut in

export function initLive(d: Deps) {
  deps = d;
  $("#live-mark").innerHTML = markSvg;
  speaker.onError = (m) => deps.toast(m, "warn");
  speaker.onFirstAudio = (at) => {
    if (!turn || turn.audio) return;
    turn.audio = at;
    report();
  };
  $("#live-end").addEventListener("click", () => end());
  $("#live-mute").addEventListener("click", () => setMuted(!muted));
  $("#live-cam").addEventListener("click", () => setCamera(!camOn));
  $("#live-voice").addEventListener("change", async () => {
    const v = ($("#live-voice") as HTMLSelectElement).value;
    const wasVox = isVox(speaker.voice);
    deps.setVoiceSetting(v);
    speaker.voice = v;
    if (state === "off" || state === "starting" || state === "error") return;
    if (!isVox(v)) {
      if (wasVox) unloadVox(); // Kokoro runs on the CPU; VoxCPM2's memory goes back
      return;
    }
    const prev = state;
    if (wasVox) {
      setStatus("Loading the voice…");
      await warmVoice().catch(() => null);
    } else {
      // VoxCPM2 needs ~6 GB: the Live model steps out, the voice loads, then the model that fits beside it.
      // (Not listening meanwhile: there'd be nothing to answer with.)
      speaker.stop();
      if (replying) deps.stopReply();
      setState("starting");
      setStatus("Switching to VoxCPM2…");
      try {
        await unloadOllama(() => true);
        const free = await warmVoice();
        await loadModel(pickModel(free));
      } catch (e) {
        deps.toast(`Couldn't switch the voice: ${errMsg(e)}`, "warn");
      }
      if ((state as State) === "starting") setState("listening"); // (unless the call ended meanwhile)
      return;
    }
    if (state === prev) setState(state);
  });
  $("#live-get-model").addEventListener("click", () => {
    end();
    deps.openCatalog();
  });
  document.addEventListener("keydown", (e) => {
    if (state === "off") return;
    if (e.key === "Escape") {
      e.preventDefault();
      end();
    }
  });
}

function setState(s: State) {
  state = s;
  document.body.dataset.live = s;
  if (STATUS[s]) setStatus(muted && (s === "listening" || s === "hearing") ? "Muted · unmute to talk" : STATUS[s]);
}

function setStatus(t: string) {
  $("#live-status").textContent = t;
}

// ---------- start / end ----------
export async function startLive() {
  if (state !== "off") return;
  muted = false;
  carry = "";
  replyText = "";
  interruptedSilent = false;
  replying = false;
  spoken = "";
  $("#live").hidden = false;
  $("#live-timer").textContent = "00:00";
  $("#live-mute-label").textContent = "Mute";
  $("#live-mute").setAttribute("aria-pressed", "false");
  $("#live-you").textContent = "";
  $("#live-reply").textContent = "";
  $("#live-lat").textContent = "";
  $("#live-need").hidden = true;
  $("#live-mute").classList.remove("on");
  setState("starting");
  animate();

  model = null;
  $("#live-model").textContent = "";
  if (!deps.liveModels().length) {
    setState("error");
    setStatus("Live needs Qwen3.5 2B or 4B");
    $("#live-need").hidden = false;
    return;
  }
  speaker.voice = deps.getVoice() ?? DEFAULT_VOICE;
  await loadVoices().catch(() => {}); // (falls back to Kokoro's voice when the saved one's server is off)

  try {
    await openMic();
  } catch (e) {
    const name = (e as DOMException)?.name;
    setState("error");
    setStatus(
      name === "NotFoundError" ? "No microphone found" : name === "NotAllowedError" ? "Microphone access is blocked (Windows Settings → Privacy → Microphone)" : `Mic error: ${errMsg(e)}`,
    );
    return;
  }
  if (deps.getLiveCamera()) setCamera(true);

  try {
    await prepareGpu();
  } catch (e) {
    if (state === "off") return;
    setState("error");
    setStatus(`Couldn't get ready: ${errMsg(e)}`);
    return;
  }
  if (state === "off") return;
  deps.beginChat();
  callStart = performance.now();
  clearInterval(timer);
  timer = window.setInterval(tick, 1000);
  tick();
  // Whisper and VoxCPM2 unload after a few idle minutes; keep them in while the call lasts.
  clearInterval(warmTimer);
  warmTimer = window.setInterval(() => warmVoice().catch(() => {}), 60_000);
  setState("listening");
}

/** Makes room on the GPU, then loads Whisper, the voice and the Live model that fits beside them, so the first
 *  answer is quick. */
async function prepareGpu() {
  setStatus("Making room on the GPU…");
  // With several GPUs only the cards the call uses (Ollama's and the voice server's) need room.
  const comfy =
    sharesCard("comfyui", "ollama") || sharesCard("comfyui", "voice")
      ? http("http://127.0.0.1:8188/free", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ unload_models: true, free_memory: true }),
        }).catch(() => {})
      : null;
  // (VoxCPM2 too, when a Kokoro voice is speaking: then the better Live model fits.)
  await Promise.all([freeLlamaVram(["ollama", "voice"]), unloadOllama(() => true), comfy, isVox(speaker.voice) ? null : unloadVox()]);
  // The voice first: VoxCPM2 needs ~6 GB in one piece, and the Live model is picked to fit what's left.
  setStatus(isVox(speaker.voice) ? "Loading Whisper and VoxCPM2…" : "Loading Whisper…");
  let free: number | null = null;
  try {
    free = await warmVoice();
  } catch (e) {
    if (isVox(speaker.voice)) throw new Error(`the voice server didn't load VoxCPM2 (${errMsg(e)})`);
    // Without the voice pack, speech-to-text falls back to Open WebUI's Whisper.
  }
  if (state === "off") return;
  // The voice server reports its own card. When Ollama is on another one, it's that card's room that counts.
  if (!sharesCard("voice", "ollama")) {
    await readGpus().catch(() => []);
    const gib = freeGB("ollama");
    free = gib == null ? null : gib * 1.073741824; // GiB to the 10^9-byte GB the Live model sizes use
  }
  await loadModel(pickModel(free));
}

/** The best installed Live model that fits in `free` GB with room to spare (the smallest if none does). */
function pickModel(free: number | null): ModelInfo {
  const have = deps.liveModels();
  if (free == null) return have[0];
  const fits = have.find((m) => free >= (LIVE_MODELS.find((x) => x.id === m.id)?.gb ?? 4) + HEADROOM_GB);
  return fits ?? have[have.length - 1];
}

async function loadModel(m: ModelInfo) {
  model = m;
  $("#live-model").textContent = m.name;
  setStatus(`Loading ${m.name}…`);
  const r = await http(`${OLLAMA}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: m.id,
      messages: [{ role: "user", content: "hi" }],
      stream: false,
      think: false,
      keep_alive: "30m",
      options: { num_ctx: LIVE_CTX, num_predict: 1 },
    }),
  });
  if (!r.ok) throw new Error(`Ollama answered ${r.status}`);
}

async function unloadOllama(which: (name: string) => boolean) {
  try {
    const ps = await (await http(`${OLLAMA}/api/ps`)).json();
    await Promise.all(
      (ps.models ?? [])
        .filter((m: any) => which(m.name))
        .map((m: any) =>
          http(`${OLLAMA}/api/generate`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model: m.name, keep_alive: 0 }),
          }),
        ),
    );
  } catch {
    /* Ollama is checked when the model loads */
  }
}

/** Loads (or keeps warm) Whisper, and VoxCPM2 with the voice when it's the one speaking. Returns free VRAM in GB. */
async function warmVoice(): Promise<number | null> {
  const vox = isVox(speaker.voice);
  const r = await http(`${VOICE_SERVER}/v1/audio/load`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ models: vox ? ["stt", "tts"] : ["stt"], voice: vox ? speaker.voice.slice(4) : "" }),
  });
  const j = (await r.json().catch(() => ({}))) as any;
  if (!r.ok) throw new Error(j.detail ?? `the voice server answered ${r.status}`);
  return typeof j.free_vram_gb === "number" ? j.free_vram_gb : null;
}

export function end() {
  if (state === "off") return;
  const wasVox = isVox(speaker.voice);
  const hadCall = callStart > 0;
  speaker.stop();
  if (deps.isReplying()) deps.stopReply();
  setState("off");
  clearInterval(timer);
  clearInterval(warmTimer);
  cancelAnimationFrame(raf);
  closeMic();
  setCamera(false, false);
  utter = null;
  turn = null;
  callStart = 0;
  $("#live").hidden = true;
  delete document.body.dataset.live;
  // Give VoxCPM2's 6 GB back to the chat models (it reloads in a few seconds next time), and let the Live model
  // unload after Ollama's usual 5 idle minutes instead of the call's 30.
  if (wasVox) unloadVox();
  if (model) {
    http(`${OLLAMA}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: model.id, keep_alive: "5m" }),
    }).catch(() => {});
  }
  replying = false;
  if (hadCall) deps.ended();
}

function unloadVox() {
  return http(`${VOICE_SERVER}/v1/audio/unload`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "tts" }),
  }).catch(() => {});
}

function tick() {
  const s = Math.floor((performance.now() - callStart) / 1000);
  $("#live-timer").textContent = `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

// ---------- voice picker ----------
async function loadVoices() {
  const sel = $("#live-voice") as HTMLSelectElement;
  const { kokoro, vox } = await listVoices();
  const cur = deps.getVoice() ?? DEFAULT_VOICE;
  sel.innerHTML = "";
  const group = (label: string, values: string[], text: (v: string) => string) => {
    if (!values.length) return;
    const g = document.createElement("optgroup");
    g.label = label;
    for (const v of values) {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = text(v);
      g.appendChild(o);
    }
    sel.appendChild(g);
  };
  group("VoxCPM2 · designed and cloned", vox.map((v) => `vox:${v}`), (v) => v.slice(4));
  group("Kokoro · quick", kokoro.length ? kokoro : [DEFAULT_VOICE], (v) => v);
  sel.value = cur;
  if (sel.value !== cur) sel.value = DEFAULT_VOICE; // its server isn't running
  speaker.voice = sel.value;
}

// ---------- mic ----------
async function openMic() {
  micStream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
  });
  const ctx = audio();
  await ctx.audioWorklet.addModule(workletUrl);
  source = ctx.createMediaStreamSource(micStream);
  node = new AudioWorkletNode(ctx, "mic-tap");
  node.port.onmessage = (e) => onBlock(e.data as Float32Array);
  source.connect(node);
  // The node has to be pulled by the graph to run; a muted gain keeps it out of the speakers.
  const sink = ctx.createGain();
  sink.gain.value = 0;
  node.connect(sink).connect(ctx.destination);
  ring = [];
  utter = null;
  recent = [];
  floor = 0.008;
}

function closeMic() {
  node?.port.close();
  node?.disconnect();
  source?.disconnect();
  node = null;
  source = null;
  micStream?.getTracks().forEach((t) => t.stop());
  micStream = null;
}

function setMuted(on: boolean) {
  muted = on;
  micStream?.getAudioTracks().forEach((t) => (t.enabled = !on));
  if (on) utter = null;
  $("#live-mute").classList.toggle("on", on);
  $("#live-mute").setAttribute("aria-pressed", String(on));
  $("#live-mute-label").textContent = on ? "Unmute" : "Mute";
  if (state === "listening" || state === "hearing") setState("listening");
}

/** Prestige's turn: it's answering or speaking, so a voice now means "stop, I'm talking". */
const aiTurn = () => state === "thinking" || state === "speaking" || state === "transcribing";

/** Speaking while there's sound to play, thinking while the reply is still coming, then listening again.
 *  (Run from the mic blocks, not the animation, which stops while the window is minimised.) */
function syncState() {
  if (state !== "thinking" && state !== "speaking") return;
  const next = speaker.busy ? "speaking" : replying ? "thinking" : "listening";
  if (next !== state) setState(next);
}

function onBlock(b: Float32Array) {
  if (state === "off" || state === "starting" || state === "error") return;
  syncState();
  const rate = audio().sampleRate;
  const blockMs = (b.length / rate) * 1000;
  let s = 0;
  for (let i = 0; i < b.length; i++) s += b[i] * b[i];
  const rms = Math.sqrt(s / b.length);
  micLvl = muted ? 0 : rms;
  if (muted) return;
  const now = performance.now();

  if (!utter) {
    // Learn the room's noise floor while nobody is talking.
    // While Prestige's voice is playing, what's left of it after echo cancellation mustn't count as the user, so
    // interrupting takes a louder, longer voice.
    const echo = speaker.busy;
    if (!aiTurn()) floor = floor * 0.97 + Math.min(rms, 0.04) * 0.03;
    ring.push(b);
    while (ring.length * blockMs > BARGE_PREROLL_SEC * 1000) ring.shift();
    const thresh = echo ? Math.max(0.03, floor * 6) : Math.max(0.012, floor * 3);
    const rule = echo ? BARGE : START;
    recent.push(rms > thresh);
    while (recent.length > rule.of) recent.shift();
    if (recent.filter(Boolean).length >= rule.need) {
      recent = [];
      if (aiTurn()) interrupt();
      utter = ring.slice(-Math.ceil(((echo ? BARGE_PREROLL_SEC : PREROLL_SEC) * 1000) / blockMs));
      ring = [];
      utterStart = now - utter.length * blockMs;
      lastVoiced = now;
      voicedMs = rule.need * blockMs;
      setState("hearing");
    }
    return;
  }

  utter.push(b);
  const keep = Math.max(0.009, floor * 2.2);
  if (rms > keep) {
    lastVoiced = now;
    voicedMs += blockMs;
  }
  if (now - lastVoiced > HANGOVER_MS || now - utterStart > MAX_UTTERANCE_MS) {
    const blocks = utter;
    utter = null;
    if (voicedMs < MIN_SPEECH_MS) {
      setState("listening");
      return;
    }
    finishUtterance(blocks, rate, lastVoiced);
  }
}

/** The user started talking over Prestige: silence it and drop the reply. */
function interrupt() {
  const saidNothing = !turn?.audio;
  // What it was saying, to recognise its own voice if that's what set this off (see isEcho).
  if (!saidNothing) spoken = replyText;
  speaker.stop();
  if (replying) {
    // Cut off before it said a word: they were only pausing, so the next utterance continues their last one.
    if (saidNothing) interruptedSilent = true;
    deps.stopReply();
  }
  turn = null;
}

async function finishUtterance(blocks: Float32Array[], rate: number, endedAt: number) {
  const thisTurn: NonNullable<typeof turn> = { end: endedAt };
  turn = thisTurn;
  setState("transcribing");
  const frame = camOn ? snapshot($("#live-self") as HTMLVideoElement, 640) : null;
  let text = "";
  try {
    text = await stt(toWav(blocks, rate));
  } catch (e) {
    deps.toast(`Speech-to-text failed: ${errMsg(e)}`, "warn");
  }
  if (turn !== thisTurn) {
    // They kept talking while this was transcribing: it leads into what they say next.
    if (text) carry = `${carry} ${text}`.trim();
    return;
  }
  thisTurn.stt = performance.now();
  // Whisper's usual inventions on breath and room noise, or Prestige hearing itself through the speakers.
  const echo = isEcho(text, spoken);
  spoken = "";
  if (echo) console.info("[live] ignored an echo of its own voice:", text);
  if (echo || !text || /^(\W*|you\.?|thank you\.?|thanks for watching!?|\[.*\]|\(.*\))$/i.test(text.trim())) {
    turn = null;
    setState("listening");
    return;
  }
  if (carry) {
    text = `${carry} ${text}`;
    carry = "";
  }
  $("#live-you").textContent = text;
  $("#live-reply").textContent = "";
  replyText = "";
  speaker.begin();
  setState("thinking");
  if (!model) return;
  replying = true;
  deps.send(text, frame ? [frame] : undefined, model, {
    onDelta: (t) => {
      if (turn !== thisTurn) return;
      if (!thisTurn.token) thisTurn.token = performance.now();
      replyText += t;
      const box = $("#live-reply");
      box.textContent = replyText;
      box.scrollTop = box.scrollHeight;
      speaker.feed(t);
    },
    onDone: (ok) => {
      replying = false;
      if (interruptedSilent) {
        interruptedSilent = false;
        // Take the cut-off turn back out of the chat; its words lead the next utterance.
        carry = deps.retractTurn() ?? "";
        return;
      }
      if (turn !== thisTurn) return;
      if (ok) speaker.end();
      else if (state !== "off") deps.toast("No answer came back from the model (the error is in the chat).", "warn");
    },
  });
}

/** True when most of what was "heard" is words Prestige was saying: echo cancellation let its voice through and
 *  that, not the user, interrupted it. */
function isEcho(heard: string, said: string) {
  // Runs of three words in the same order, so answering with its words ("pasta, please") doesn't count.
  const tri = (t: string) => {
    const w = t.toLowerCase().match(/[a-z0-9']+/g) ?? [];
    return w.slice(2).map((_, i) => `${w[i]} ${w[i + 1]} ${w[i + 2]}`);
  };
  const h = tri(heard);
  if (!said || h.length < 2) return false;
  const s = new Set(tri(said));
  return h.filter((x) => s.has(x)).length / h.length >= 0.6;
}

/** Whisper turbo on the voice server (greedy decoding: quicker on short turns), else Open WebUI's Whisper. */
async function stt(wav: Blob): Promise<string> {
  const fd = new FormData();
  fd.append("file", new File([wav], "speech.wav", { type: "audio/wav" }));
  fd.append("language", "en");
  fd.append("beam_size", "1");
  try {
    const r = await http(`${VOICE_SERVER}/v1/audio/transcriptions`, { method: "POST", body: fd });
    if (r.ok) return String((await r.json()).text ?? "").trim();
  } catch {
    /* no voice pack */
  }
  return transcribe(deps.memCfg(), wav);
}

/** 16 kHz mono 16-bit WAV: what Whisper wants, so the server doesn't have to decode or resample. */
function toWav(blocks: Float32Array[], rate: number): Blob {
  const n = blocks.reduce((a, b) => a + b.length, 0);
  const all = new Float32Array(n);
  let o = 0;
  for (const b of blocks) {
    all.set(b, o);
    o += b.length;
  }
  const out = 16000;
  const len = Math.floor((n * out) / rate);
  const buf = new ArrayBuffer(44 + len * 2);
  const v = new DataView(buf);
  const str = (off: number, s: string) => [...s].forEach((c, i) => v.setUint8(off + i, c.charCodeAt(0)));
  str(0, "RIFF");
  v.setUint32(4, 36 + len * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, out, true);
  v.setUint32(28, out * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, len * 2, true);
  const step = rate / out;
  for (let i = 0; i < len; i++) {
    // Average the samples that fold into this one (a cheap low-pass), then convert.
    const a = Math.floor(i * step);
    const z = Math.min(n, Math.floor((i + 1) * step));
    let s = 0;
    for (let j = a; j < z; j++) s += all[j];
    const x = Math.max(-1, Math.min(1, s / Math.max(1, z - a)));
    v.setInt16(44 + i * 2, x * 32767, true);
  }
  return new Blob([buf], { type: "audio/wav" });
}

/** End of speech → first sound of the answer, with where the time went. */
function report() {
  const t = turn;
  if (!t?.audio) return;
  const total = t.audio - t.end;
  const stt = t.stt ? t.stt - t.end : 0;
  const llm = t.token && t.stt ? t.token - t.stt : 0;
  const tts = t.token ? t.audio - t.token : 0;
  $("#live-lat").textContent = `${(total / 1000).toFixed(1)} s`;
  $("#live-lat").title = `End of your speech → first sound: ${Math.round(total)} ms (includes ${HANGOVER_MS} ms of silence to know you'd finished). ` +
    `Whisper ${Math.round(stt - HANGOVER_MS)} ms · first word ${Math.round(llm)} ms · voice ${Math.round(tts)} ms`;
  const stats = { total: Math.round(total), hangover: HANGOVER_MS, stt: Math.round(stt - HANGOVER_MS), llm: Math.round(llm), tts: Math.round(tts), voice: speaker.voice, camera: camOn };
  ((window as any).__liveTurns ??= []).push(stats);
  console.info("[live] latency", JSON.stringify(stats));
}

// ---------- camera ----------
async function setCamera(on: boolean, remember = true) {
  camOn = on;
  if (remember) deps.setLiveCamera(on);
  const v = $("#live-self") as HTMLVideoElement;
  $("#live-cam").classList.toggle("on", on);
  $("#live-cam").setAttribute("aria-pressed", String(on));
  if (!on) {
    camStream?.getTracks().forEach((t) => t.stop());
    camStream = null;
    v.srcObject = null;
    v.hidden = true;
    return;
  }
  try {
    const id = deps.getCamera();
    const video: MediaTrackConstraints = { width: { ideal: 1280 }, height: { ideal: 720 } };
    if (id) video.deviceId = { ideal: id };
    camStream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
    if (!camOn) {
      camStream.getTracks().forEach((t) => t.stop());
      camStream = null;
      return;
    }
    v.srcObject = camStream;
    v.hidden = false;
    await v.play().catch(() => {});
  } catch (e) {
    camOn = false;
    $("#live-cam").classList.remove("on");
    deps.toast(`Camera: ${errMsg(e)}`, "warn");
  }
}

// ---------- avatar ----------
interface Ring {
  r: number;
  a: number;
  gold: boolean;
}

function animate() {
  cancelAnimationFrame(raf);
  const canvas = $("#live-rings") as HTMLCanvasElement;
  const eye = $("#live-mark").querySelector<SVGElement>(".eye-glow");
  const rings: Ring[] = [];
  let lastSpawn = 0;
  let smooth = 0;
  const step = (t: number) => {
    raf = requestAnimationFrame(step);
    const talking = state === "speaking";
    const level = talking ? outputLevel() : state === "hearing" ? Math.min(1, micLvl * 6) * 0.6 : 0;
    smooth = smooth * 0.6 + level * 0.4;
    if (eye) {
      eye.style.opacity = String(talking ? 0.45 + Math.min(1, smooth * 1.6) * 0.55 : state === "thinking" ? 0.5 : 0.28);
      eye.style.filter = talking ? `drop-shadow(0 0 ${8 + smooth * 30}px #d6202b)` : "drop-shadow(0 0 4px #d6202b)";
    }
    $("#live-level").style.setProperty("--v", String(Math.round(Math.min(1, (talking ? smooth : micLvl * 6)) * 100)));
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return;
    if (canvas.width !== Math.round(w * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const g = canvas.getContext("2d")!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const cx = w / 2;
    const cy = h / 2;
    const base = Math.min(w, h) * 0.17;
    if (smooth > 0.05 && t - lastSpawn > (talking ? 170 : 420) - smooth * 110) {
      rings.push({ r: base, a: Math.min(0.9, 0.25 + smooth), gold: !talking || rings.length % 2 === 0 });
      lastSpawn = t;
    }
    for (let i = rings.length - 1; i >= 0; i--) {
      const ring = rings[i];
      ring.r += talking ? 1.7 + smooth * 3 : 0.9;
      ring.a *= talking ? 0.975 : 0.963;
      if (ring.a < 0.02 || ring.r > Math.max(w, h)) {
        rings.splice(i, 1);
        continue;
      }
      g.beginPath();
      g.arc(cx, cy, ring.r, 0, Math.PI * 2);
      g.strokeStyle = ring.gold ? `rgba(217,164,65,${ring.a})` : `rgba(214,32,43,${ring.a})`;
      g.lineWidth = talking ? 2 : 1.2;
      g.stroke();
    }
    const halo = g.createRadialGradient(cx, cy, base * 0.3, cx, cy, base * (1.7 + smooth));
    halo.addColorStop(0, `rgba(214,32,43,${0.1 + smooth * 0.35})`);
    halo.addColorStop(1, "rgba(214,32,43,0)");
    g.fillStyle = halo;
    g.fillRect(0, 0, w, h);
  };
  raf = requestAnimationFrame(step);
}

if (import.meta.env.DEV) (window as any).__live = { speaker, state: () => state };
