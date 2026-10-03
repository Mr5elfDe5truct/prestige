// Live mode's speech out: each sentence is streamed as raw PCM from Kokoro (24 kHz) or VoxCPM2 (48 kHz, from the
// voice server's streaming endpoint) and scheduled on one WebAudio timeline, so talking starts after the first
// piece of the first clause instead of after the whole reply. VoxCPM2 runs a little slower than real time on a
// 12 GB card, so each sentence waits for just enough audio that it plays through without gaps.
import { errMsg, http } from "./backends";
import { audio, isVox, outputNode, speakable, KOKORO, VOICE_SERVER } from "./speech";

/** VoxCPM2 diffusion steps in Live: 4 is ~20% quicker than the voice screen's 6 and still sounds clean. */
const VOX_STEPS = 4;
/** The longest first piece of a reply, in characters, before it's broken between words. Kokoro (on the CPU) only
 *  sends a piece once it's all made, so its first piece is shorter; VoxCPM2 streams, so a longer one costs less. */
const FIRST_MAX = { vox: 72, kokoro: 44 };
/** Characters a second of ordinary speech, to guess how long a sentence will play. */
const CHARS_PER_SEC = 14.5;

export class LiveSpeaker {
  voice = "af_heart";
  /** Called once per reply with the performance.now() time its first sound reaches the speakers. */
  onFirstAudio: (at: number) => void = () => {};
  onError: (msg: string) => void = () => {};

  private gen = 0;
  private pending = "";
  private sentences: string[] = [];
  private running = false;
  private ctl: AbortController | null = null;
  private sources = new Set<AudioBufferSourceNode>();
  private playEnd = 0; // AudioContext time the last scheduled piece ends
  private firstOfReply = true;
  private spokeAny = false;
  private warned = false;
  // Measured generation speed (seconds of work per second of audio), per engine.
  private rtf = { vox: 1.25, kokoro: 0.7 };
  /** Pauses where playback caught up with generation mid-sentence. */
  gaps = { count: 0, secs: 0 };

  /** True while there's speech playing, being made, or waiting to be made. */
  get busy() {
    return this.running || this.sentences.length > 0 || this.playEnd > audio().currentTime + 0.02;
  }

  /** Starts a new reply (after stop() or the last one finished). */
  begin() {
    this.pending = "";
    this.firstOfReply = true;
    this.spokeAny = false;
    this.warned = false;
  }

  /** Streamed reply text: each finished clause or sentence is spoken as soon as it's complete. */
  feed(delta: string) {
    this.pending += delta;
    this.flush(false);
  }

  /** The reply finished: speak whatever is left. */
  end() {
    this.flush(true);
  }

  /** Stops talking at once: drops queued sentences, aborts the one being made and silences what's scheduled. */
  stop() {
    this.gen++;
    this.sentences = [];
    this.pending = "";
    this.ctl?.abort();
    this.ctl = null;
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {
        /* already ended */
      }
    }
    this.sources.clear();
    this.playEnd = 0;
    this.running = false;
  }

  private flush(all: boolean) {
    // The first piece of a reply is kept short (a clause, or a few words), so the voice starts sooner: a voice
    // slower than real time has to work ahead by a share of each piece's length before it starts playing it.
    // After that, whole sentences (they sound more natural and keep VoxCPM2's prosody).
    for (;;) {
      const first = !this.spokeAny && !this.sentences.length;
      const re = first ? /[.!?…]+["')\]]*\s|\n+|[,;:—–]\s/g : /[.!?…]+["')\]]*\s|\n+/g;
      let cut = -1;
      let m: RegExpExecArray | null;
      while ((m = re.exec(this.pending))) {
        const end = m.index + m[0].length;
        const piece = this.pending.slice(0, end).trim();
        const isClause = /[,;:—–]\s$/.test(m[0]) || /[,;:—–]$/.test(piece);
        if (piece.length >= (isClause ? (isVox(this.voice) ? 28 : 18) : 12) || m[0].includes("\n")) {
          cut = end;
          break;
        }
      }
      const firstMax = FIRST_MAX[isVox(this.voice) ? "vox" : "kokoro"];
      if (cut < 0 && first && this.pending.length >= firstMax) {
        // No punctuation yet: break before a joining word ("because", "and", …), else at the last space.
        const head = this.pending.slice(0, firstMax);
        let at = -1;
        for (const j of head.matchAll(/\s(?:because|but|and|so|which|that|when|while|if|since|though|although|or)\s/gi)) {
          if (j.index! >= 24) at = j.index!;
        }
        cut = (at > 0 ? at : head.lastIndexOf(" ")) + 1 || firstMax;
      }
      if (cut < 0) {
        if (this.pending.length < 220) break;
        // A run-on sentence: break it at a comma (or a space) so no piece is longer than the voice warmed up for.
        const head = this.pending.slice(0, 200);
        const at = Math.max(head.lastIndexOf(", "), head.lastIndexOf("; "));
        cut = (at > 60 ? at + 1 : head.lastIndexOf(" ")) + 1 || 200;
      }
      this.push(this.pending.slice(0, cut));
      this.pending = this.pending.slice(cut);
    }
    if (all) {
      this.push(this.pending);
      this.pending = "";
    }
  }

  private push(text: string) {
    const t = speakable(text).replace(/\p{Extended_Pictographic}\uFE0F?/gu, "").trim();
    if (!/[a-z0-9]/i.test(t)) return;
    this.sentences.push(t);
    this.spokeAny = true;
    if (!this.running) this.pump();
  }

  private async pump() {
    this.running = true;
    const gen = this.gen;
    while (this.sentences.length && gen === this.gen) {
      const text = this.sentences.shift()!;
      try {
        await this.streamSentence(text, gen);
      } catch (e) {
        if (gen !== this.gen) break;
        console.warn("Live TTS failed:", errMsg(e));
        if (!this.warned) {
          this.warned = true;
          this.onError(`Couldn't speak with ${isVox(this.voice) ? "VoxCPM2" : "Kokoro"}: ${errMsg(e)}`);
        }
      }
    }
    if (gen === this.gen) this.running = false;
  }

  private async streamSentence(text: string, gen: number) {
    const vox = isVox(this.voice);
    const ctl = new AbortController();
    this.ctl = ctl;
    const t0 = performance.now();
    const r = vox
      ? await http(`${VOICE_SERVER}/v1/audio/speech`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: "voxcpm2", input: text, voice: this.voice.slice(4), stream: true, steps: VOX_STEPS }),
          signal: ctl.signal,
        })
      : await http(`${KOKORO}/v1/audio/speech`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: "kokoro", input: text, voice: this.voice, response_format: "pcm", stream: true, speed: 1.0 }),
          signal: ctl.signal,
        });
    if (!r.ok || !r.body) {
      const detail = ((await r.json().catch(() => ({}))) as any).detail;
      throw new Error(detail ? String(detail) : `${vox ? "the voice server" : "Kokoro"} answered ${r.status}`);
    }
    const rate = Number(r.headers.get("x-sample-rate")) || (vox ? 48000 : 24000);
    const ctx = audio();
    const engine = vox ? "vox" : "kokoro";
    // How much audio to hold before starting, so a slower-than-real-time stream doesn't run dry mid-sentence.
    const est = Math.max(0.6, text.length / CHARS_PER_SEC);
    const lead = Math.max(0.12, est * (1 - 1 / Math.max(1, this.rtf[engine])) * 1.1) + 0.15;
    const held: Float32Array<ArrayBuffer>[] = [];
    let heldSecs = 0;
    let started = false;
    let inSentence = false;
    let total = 0;
    let odd: number | null = null; // a byte left over when a network chunk splits a 16-bit sample

    const schedule = (pcm: Float32Array<ArrayBuffer>) => {
      const buf = ctx.createBuffer(1, pcm.length, rate);
      buf.copyToChannel(pcm, 0);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(outputNode());
      const at = Math.max(this.playEnd, ctx.currentTime + 0.03);
      // Ran dry mid-sentence: a gap the listener hears (counted for tuning; see the cushion above).
      if (inSentence && at - this.playEnd > 0.02) {
        this.gaps.count++;
        this.gaps.secs += at - this.playEnd;
      }
      src.start(at);
      inSentence = true;
      this.playEnd = at + buf.duration;
      this.sources.add(src);
      src.onended = () => this.sources.delete(src);
      if (this.firstOfReply) {
        this.firstOfReply = false;
        this.onFirstAudio(performance.now() + (at - ctx.currentTime) * 1000);
      }
    };
    const release = () => {
      started = true;
      for (const p of held) schedule(p);
      held.length = 0;
    };

    const reader = r.body.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (gen !== this.gen) {
        reader.cancel().catch(() => {});
        return;
      }
      if (done) break;
      let bytes = value;
      if (odd !== null) {
        const joined = new Uint8Array(bytes.length + 1);
        joined[0] = odd;
        joined.set(bytes, 1);
        bytes = joined;
        odd = null;
      }
      if (bytes.length % 2) {
        odd = bytes[bytes.length - 1];
        bytes = bytes.subarray(0, bytes.length - 1);
      }
      if (!bytes.length) continue;
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
      const pcm = new Float32Array(bytes.length / 2);
      for (let i = 0; i < pcm.length; i++) pcm[i] = view.getInt16(i * 2, true) / 32768;
      total += pcm.length;
      if (started) schedule(pcm);
      else {
        held.push(pcm);
        heldSecs += pcm.length / rate;
        // Audio still queued from the previous sentence counts towards the cushion.
        const queued = Math.max(0, this.playEnd - ctx.currentTime);
        if (heldSecs + queued >= lead) release();
      }
    }
    if (!started) release();
    // Learn the real speed for the next sentence's cushion.
    const secs = total / rate;
    if (secs > 0.5) this.rtf[engine] = this.rtf[engine] * 0.5 + ((performance.now() - t0) / 1000 / secs) * 0.5;
    if (this.ctl === ctl) this.ctl = null;
  }
}
