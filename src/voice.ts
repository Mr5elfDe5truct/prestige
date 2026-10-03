// Voice: push-to-talk and hands-free conversation on the Voice screen, plus the composer's mic button.
// The avatar (the gold top-hat mark) follows the real audio: the eye and gold/red rings track Kokoro's
// output level while speaking, and a calmer ring tracks the mic while listening.
import {
  cloneVoice, closeMic, isSpeaking, isVox, listVoices, micLevel, micRms, onSpeakingChange, openMic, outputLevel, record,
  setVoice, speakDelta, speakEnd, stopSpeaking, transcribe, DEFAULT_VOICE,
} from "./speech";
import { errMsg } from "./backends";
import type { MemoryConfig } from "./memory";

const $ = <T extends HTMLElement = HTMLElement>(s: string, r: ParentNode = document) => r.querySelector(s) as T;

interface Deps {
  toast: (msg: string, kind?: string) => void;
  memCfg: () => MemoryConfig | null;
  /** Sends a chat message; `speak` hooks receive the streamed reply text. */
  send: (text: string, hooks: { onDelta: (t: string) => void; onDone: (ok: boolean) => void }) => void;
  stopReply: () => void;
  isReplying: () => boolean;
  getVoice: () => string | undefined;
  setVoiceSetting: (v: string) => void;
}

type State = "idle" | "listening" | "recording" | "transcribing" | "thinking" | "speaking";

let deps: Deps;
let state: State = "idle";
let handsFree = false;
let visible = false;
let recorder: ReturnType<typeof record> | null = null;
let raf = 0;
let vadTimer = 0;
let peak = 0;
let peakTimer = 0;
let lastUser = "";
let lastReply = "";

const LABEL: Record<State, string> = {
  idle: "Tap to talk, or hold Space",
  listening: "Listening… just start talking",
  recording: "I'm listening — release (or pause) when you're done",
  transcribing: "Transcribing…",
  thinking: "Thinking…",
  speaking: "Speaking… talk to interrupt",
};

function setState(s: State) {
  state = s;
  document.body.dataset.voice = s;
  $("#voice-status").textContent = handsFree && s === "idle" ? LABEL.listening : LABEL[s];
  $("#voice-talk").classList.toggle("on", s === "recording");
  $("#voice-talk-label").textContent = s === "recording" ? "Stop" : "Tap to talk";
  $("#voice-stop").hidden = !(s === "thinking" || s === "speaking" || s === "transcribing");
  $("#composer-mic").classList.toggle("on", s === "recording" && !visible);
}

export function initVoice(d: Deps) {
  deps = d;
  setVoice(d.getVoice() ?? DEFAULT_VOICE);
  onSpeakingChange((on) => {
    if (on) setState("speaking");
    else if (state === "speaking") setState(handsFree ? "listening" : "idle");
  });

  // Push-to-talk: tap to start/stop, or hold the button / Space.
  const talk = $("#voice-talk");
  let downAt = 0;
  talk.addEventListener("pointerdown", () => {
    downAt = performance.now();
    if (state !== "recording") startRecording();
  });
  talk.addEventListener("pointerup", () => {
    // A long press is hold-to-talk; a quick tap toggles.
    if (state === "recording" && performance.now() - downAt > 600) finishRecording();
  });
  talk.addEventListener("click", () => {
    if (state === "recording" && performance.now() - downAt <= 600 && performance.now() - (recorder?.started ?? 0) > 700) finishRecording();
  });
  document.addEventListener("keydown", (e) => {
    if (!visible || e.code !== "Space" || e.repeat || (e.target as HTMLElement).closest("input,textarea,select")) return;
    e.preventDefault();
    if (state !== "recording") startRecording();
  });
  document.addEventListener("keyup", (e) => {
    if (!visible || e.code !== "Space" || (e.target as HTMLElement).closest("input,textarea,select")) return;
    e.preventDefault();
    if (state === "recording" && !handsFree) finishRecording();
  });

  $("#voice-stop").addEventListener("click", interrupt);
  $("#voice-hands").addEventListener("change", () => setHandsFree(($("#voice-hands") as HTMLInputElement).checked));
  $("#voice-pick").addEventListener("change", () => {
    const v = ($("#voice-pick") as HTMLSelectElement).value;
    setVoice(v);
    deps.setVoiceSetting(v);
    engineNote();
  });
  $("#voice-clone").addEventListener("click", () => ($("#voice-clone-file") as HTMLInputElement).click());
  $("#voice-clone-file").addEventListener("change", async () => {
    const input = $("#voice-clone-file") as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    const suggested = file.name.replace(/\.[^.]+$/, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 24);
    const name = window.prompt("Name for this voice:", suggested)?.trim();
    if (!name) return;
    try {
      const id = await cloneVoice(name, file);
      deps.toast(`Added the voice "${id}". It speaks with VoxCPM2.`);
      await loadVoices(true);
      const v = `vox:${id}`;
      ($("#voice-pick") as HTMLSelectElement).value = v;
      setVoice(v);
      deps.setVoiceSetting(v);
      engineNote();
    } catch (e) {
      deps.toast(`Couldn't add that voice: ${errMsg(e)}`, "warn");
    }
  });

  // Composer mic: talk once, the transcript is sent, and the reply is spoken.
  $("#composer-mic").addEventListener("click", () => {
    if (state === "recording") finishRecording();
    else startRecording();
  });
}

export async function showVoice(on: boolean) {
  visible = on;
  cancelAnimationFrame(raf);
  if (on) {
    loadVoices();
    animate();
  } else if (handsFree) {
    // Leaving the screen ends hands-free listening.
    ($("#voice-hands") as HTMLInputElement).checked = false;
    setHandsFree(false);
  }
}

async function loadVoices(force = false) {
  const sel = $("#voice-pick") as HTMLSelectElement;
  if (sel.options.length > 1 && !force) return;
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
  group("Kokoro · quick", kokoro.length ? kokoro : isVox(cur) ? [DEFAULT_VOICE] : [cur], (v) => v);
  group("VoxCPM2 · expressive", vox.map((v) => `vox:${v}`), (v) => v.slice(4));
  // A saved voice that isn't offered right now (its server is off) falls back to Kokoro's default.
  sel.value = cur;
  if (sel.value !== cur) sel.value = DEFAULT_VOICE;
  setVoice(sel.value);
  ($("#voice-clone") as HTMLButtonElement).hidden = !vox.length;
  engineNote();
}

function engineNote() {
  const note = $("#voice-engine-note");
  const vox = isVox(($("#voice-pick") as HTMLSelectElement).value);
  note.hidden = !vox;
  note.textContent = vox
    ? "VoxCPM2 speaks once the reply is written. It needs about 6 GB of GPU memory, so the chat model steps aside while it talks and reloads for your next message."
    : "";
}

// ---------- recording ----------
async function startRecording() {
  if (state === "speaking" || state === "thinking") interrupt();
  try {
    const s = await openMic();
    recorder = record(s);
    // Track the loudest moment, so a take with no voice in it isn't sent to Whisper (it invents text from noise).
    peak = 0;
    clearInterval(peakTimer);
    peakTimer = window.setInterval(() => (peak = Math.max(peak, micRms())), 50);
    setState("recording");
    if (!visible) animate();
  } catch (e) {
    const name = (e as DOMException)?.name;
    deps.toast(
      name === "NotFoundError" ? "No microphone found." : name === "NotAllowedError" ? "Microphone access is blocked (Windows Settings → Privacy → Microphone)." : `Mic error: ${errMsg(e)}`,
      "warn",
    );
    setState("idle");
  }
}

async function finishRecording() {
  if (!recorder) return;
  const r = recorder;
  recorder = null;
  const ms = performance.now() - r.started;
  const blob = await r.stop();
  if (!handsFree) closeMic();
  clearInterval(peakTimer);
  if (ms < 400 || blob.size < 2000) {
    setState(handsFree ? "listening" : "idle");
    return;
  }
  if (peak < 0.015) {
    if (!handsFree) deps.toast("I didn't hear anything. Check the microphone, or speak a little louder.");
    setState(handsFree ? "listening" : "idle");
    return;
  }
  setState("transcribing");
  let text = "";
  try {
    text = await transcribe(deps.memCfg(), blob);
  } catch (e) {
    deps.toast(`Speech-to-text failed: ${errMsg(e)}`, "warn");
  }
  if (!text) {
    setState(handsFree ? "listening" : "idle");
    return;
  }
  lastUser = text;
  lastReply = "";
  renderCaptions();
  setState("thinking");
  deps.send(text, {
    onDelta: (t) => {
      lastReply += t;
      renderCaptions();
      speakDelta(t);
    },
    onDone: (ok) => {
      if (ok) speakEnd();
      if (!isSpeaking()) setState(handsFree ? "listening" : "idle");
    },
  });
}

function renderCaptions() {
  $("#voice-you").textContent = lastUser ? `You: ${lastUser}` : "";
  $("#voice-reply").textContent = lastReply;
}

/** Stops the reply and the speech, e.g. when the user starts talking over it. */
function interrupt() {
  stopSpeaking();
  if (deps.isReplying()) deps.stopReply();
  setState(handsFree ? "listening" : "idle");
}

// ---------- hands-free ----------
async function setHandsFree(on: boolean) {
  handsFree = on;
  clearInterval(vadTimer);
  if (!on) {
    if (recorder) {
      recorder.stop();
      recorder = null;
    }
    closeMic();
    setState(state === "speaking" || state === "thinking" ? state : "idle");
    return;
  }
  try {
    await openMic();
  } catch (e) {
    deps.toast(`Mic error: ${errMsg(e)}`, "warn");
    ($("#voice-hands") as HTMLInputElement).checked = false;
    handsFree = false;
    return;
  }
  setState(state === "speaking" || state === "thinking" ? state : "listening");
  // Simple voice-activity detection on the mic level, with an adaptive noise floor.
  let floor = 0.01;
  let voiced = 0;
  let silent = 0;
  vadTimer = window.setInterval(() => {
    const v = micRms();
    if (state === "listening" || state === "idle") floor = floor * 0.95 + Math.min(v, 0.05) * 0.05;
    // While Prestige talks, require a louder, longer voice to interrupt (echo cancellation removes most of it).
    const talking = state === "speaking";
    const thresh = Math.max(0.018, floor * (talking ? 5 : 3));
    const loud = v > thresh;
    voiced = loud ? voiced + 1 : 0;
    silent = loud ? 0 : silent + 1;
    if (state === "listening" && voiced >= 2) startRecording();
    else if ((talking || state === "thinking") && voiced >= 5) {
      interrupt();
      startRecording();
    } else if (state === "recording" && silent >= 9 && performance.now() - (recorder?.started ?? 0) > 800) finishRecording();
    else if (state === "recording" && performance.now() - (recorder?.started ?? 0) > 60_000) finishRecording();
  }, 100);
}

// ---------- avatar ----------
interface Ring {
  r: number;
  a: number;
  gold: boolean;
}
const rings: Ring[] = [];
let lastSpawn = 0;

function animate() {
  const canvas = $("#voice-rings") as HTMLCanvasElement;
  const eye = document.querySelectorAll<SVGCircleElement>(".voice-stage .eye-glow");
  const step = (t: number) => {
    raf = requestAnimationFrame(step);
    const speaking = state === "speaking";
    const listening = state === "recording" || state === "listening";
    const level = speaking ? outputLevel() : listening ? micLevel() * 0.6 : 0;
    eye.forEach((e) => {
      e.style.opacity = String(0.35 + Math.min(1, level * 1.6) * 0.65);
      e.style.filter = `drop-shadow(0 0 ${6 + level * 26}px #d6202b)`;
    });
    $("#voice-level").style.setProperty("--v", String(Math.round(level * 100)));
    if (!visible) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (canvas.width !== w * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }
    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const base = Math.min(w, h) * 0.2;
    // Spawn rings with the audio: more and brighter when louder.
    if (level > 0.06 && t - lastSpawn > (speaking ? 180 : 420) - level * 120) {
      rings.push({ r: base, a: Math.min(0.9, 0.25 + level), gold: !speaking || rings.length % 2 === 0 });
      lastSpawn = t;
    }
    for (let i = rings.length - 1; i >= 0; i--) {
      const ring = rings[i];
      ring.r += speaking ? 1.6 + level * 3 : 0.9;
      ring.a *= speaking ? 0.975 : 0.965;
      if (ring.a < 0.02 || ring.r > Math.max(w, h)) {
        rings.splice(i, 1);
        continue;
      }
      ctx.beginPath();
      ctx.arc(w / 2, h * 0.52, ring.r, 0, Math.PI * 2);
      ctx.strokeStyle = ring.gold ? `rgba(217,164,65,${ring.a})` : `rgba(214,32,43,${ring.a})`;
      ctx.lineWidth = speaking ? 2 : 1.2;
      ctx.stroke();
    }
    // A soft halo that breathes with the level.
    const g = ctx.createRadialGradient(w / 2, h * 0.52, base * 0.3, w / 2, h * 0.52, base * (1.6 + level));
    g.addColorStop(0, `rgba(214,32,43,${0.12 + level * 0.35})`);
    g.addColorStop(1, "rgba(214,32,43,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  };
  raf = requestAnimationFrame(step);
}
