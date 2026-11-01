// Quick talk (Live's Quick mode, quicktalk.rs): one small model, LFM3-Audio 2B, hears the call and answers aloud. Live
// keeps its mic, voice detection and call screen; each utterance goes to llama-server's /v1/realtime websocket as
// it's spoken, and the reply comes back as speech (with its words) while it's made. Measured on an RTX 3060: ~0.4 s
// from the end of a question to the first sound (after Live's 0.65 s wait to know you've finished), ~2.4 GB of VRAM.
import { invoke } from "@tauri-apps/api/core";
import { audio, outputNode } from "./speech";

/** What Quick talk is told. Liquid's voice chat prompt, with who it is and to keep it short. */
const INSTRUCTIONS =
  "You are Prestige, a friendly assistant on the user's PC, in a voice call. Answer in one or two short sentences. " +
  "Respond with interleaved text and audio.";

export interface QuickHooks {
  onText: (delta: string) => void;
  /** The first sound of a reply is about to play (performance.now() time). */
  onFirstAudio: (at: number) => void;
  onDone: () => void;
  onError: (msg: string) => void;
}

/** Gets the model ready (the pack, a new enough llama.cpp, the router entry) and connects. */
export async function openQuick(root: string | null, hooks: QuickHooks): Promise<QuickLink> {
  const url = await invoke<string>("quick_talk_prepare", { root });
  // A model the router put to sleep after its idle minutes can drop the first try while it wakes.
  for (let tries = 1; ; tries++) {
    const link = new QuickLink(hooks);
    try {
      await link.connect(url);
      return link;
    } catch (e) {
      link.close();
      if (tries === 3) throw e;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
}

export class QuickLink {
  private ws: WebSocket | null = null;
  private inRate = 16000;
  private outRate = 24000;
  private player = new PcmPlayer();
  private answering = false;
  private first = false;

  constructor(private hooks: QuickHooks) {}

  /** Opens the websocket and sets the call up. The router loads the model on the first connection (~3 s). */
  connect(url: string) {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;
      let ready = false;
      ws.onerror = () => (ready ? this.hooks.onError("llama.cpp stopped answering") : reject(new Error("llama.cpp didn't answer on /v1/realtime")));
      ws.onclose = () => {
        if (!ready) reject(new Error("llama.cpp hung up before the call started (it needs v0.8.0 or newer)"));
      };
      ws.onmessage = (e) => {
        const ev = JSON.parse(String(e.data));
        if (ev.type === "error") {
          const msg = String(ev.error?.message ?? "llama.cpp reported an error");
          return ready ? this.hooks.onError(msg) : reject(new Error(msg));
        }
        if (ev.type === "session.created") {
          const a = ev.session?.audio ?? {};
          this.inRate = a.input?.format?.rate ?? this.inRate;
          this.outRate = a.output?.format?.rate ?? this.outRate;
          this.send({ type: "session.update", session: { type: "realtime", instructions: INSTRUCTIONS, output_modalities: ["audio", "text"] } });
        } else if (ev.type === "session.updated" && !ready) {
          ready = true;
          resolve();
        } else this.onEvent(ev);
      };
    });
  }

  private send(o: object) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(o));
  }

  private onEvent(ev: any) {
    if (!this.answering) return;
    if (ev.type === "response.output_audio.delta") {
      const b = atob(ev.delta);
      const pcm = new Int16Array(b.length >> 1);
      for (let i = 0; i < pcm.length; i++) pcm[i] = b.charCodeAt(2 * i) | (b.charCodeAt(2 * i + 1) << 8);
      const at = this.player.feed(pcm, this.outRate);
      if (!this.first) {
        this.first = true;
        this.hooks.onFirstAudio(at);
      }
    } else if (ev.type === "response.output_text.delta" || ev.type === "response.output_audio_transcript.delta") {
      this.hooks.onText(String(ev.delta ?? ""));
    } else if (ev.type === "response.done") {
      this.answering = false;
      this.hooks.onDone();
    }
  }

  /** Mic audio (Float32 at the AudioContext's rate) for the turn being spoken. */
  append(blocks: Float32Array[], rate: number) {
    const pcm = toPcm16(blocks, rate, this.inRate);
    let s = "";
    const bytes = new Uint8Array(pcm.buffer);
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    this.send({ type: "input_audio_buffer.append", audio: btoa(s) });
  }

  /** The user finished: the audio so far is their turn, and the reply starts. */
  respond() {
    this.answering = true;
    this.first = false;
    this.send({ type: "response.create" });
  }

  /** Talking over it: the reply stops, in the speakers and on the server. */
  cancel() {
    this.player.stop();
    if (this.answering) this.send({ type: "response.cancel" });
    this.answering = false;
  }

  get replying() {
    return this.answering;
  }

  get speaking() {
    return this.player.busy;
  }

  close() {
    this.player.stop();
    this.ws?.close();
    this.ws = null;
  }
}

/** Plays 16-bit PCM pieces back to back on WebAudio, through the output that Live's rings and eye follow. */
class PcmPlayer {
  private at = 0;
  private sources = new Set<AudioBufferSourceNode>();

  /** Schedules a piece; returns when it starts (performance.now() time). */
  feed(pcm: Int16Array, rate: number): number {
    const ctx = audio();
    const buf = ctx.createBuffer(1, pcm.length, rate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 32768;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(outputNode());
    // A little slack on the first piece so the next ones arrive before it ends.
    const start = Math.max(this.at, ctx.currentTime + (this.sources.size ? 0 : 0.05));
    src.start(start);
    this.at = start + buf.duration;
    this.sources.add(src);
    src.onended = () => this.sources.delete(src);
    return performance.now() + (start - ctx.currentTime) * 1000;
  }

  get busy() {
    return this.sources.size > 0;
  }

  stop() {
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {
        /* not started */
      }
    }
    this.sources.clear();
    this.at = 0;
  }
}

/** Float32 blocks at `from` Hz to 16-bit PCM at `to` Hz (averaging the samples that fold into each one). */
function toPcm16(blocks: Float32Array[], from: number, to: number): Int16Array {
  const n = blocks.reduce((a, b) => a + b.length, 0);
  const all = new Float32Array(n);
  let o = 0;
  for (const b of blocks) {
    all.set(b, o);
    o += b.length;
  }
  const step = from / to;
  const len = Math.floor(n / step);
  const out = new Int16Array(len);
  for (let i = 0; i < len; i++) {
    const a = Math.floor(i * step);
    const z = Math.min(n, Math.max(a + 1, Math.floor((i + 1) * step)));
    let s = 0;
    for (let j = a; j < z; j++) s += all[j];
    out[i] = Math.max(-1, Math.min(1, s / (z - a))) * 32767;
  }
  return out;
}
