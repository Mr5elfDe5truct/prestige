// Turn-taking for Live calls with TYGER (the voice server's /v1/turns; the turns pack). It hears both sides of the
// call, the echo-cancelled mic and what Prestige is playing, resampled to 16 kHz and sent 320 ms at a time, and says
// when the user cut in on purpose (BARGE: not a "mm-hm") and when they've finished talking (ENDPOINT). live.ts uses
// it on top of its own voice detection, which still finds speech; without it, live.ts decides from the words.
import { VOICE_SERVER } from "./speech";

const SR = 16000;
const HOP = 5120; // 320 ms at 16 kHz, TYGER's hop

export interface TurnEvents {
  onBarge: (onset: number) => void; // seconds the user had been talking when TYGER was sure
  onEndpoint: () => void;
}

/** Linear resampling of blocks to 16 kHz, carrying the fractional position from one block to the next. */
class To16k {
  private pos = 0;
  constructor(private rate: number) {}
  push(b: Float32Array, out: number[]) {
    const step = this.rate / SR;
    for (; this.pos < b.length; this.pos += step) {
      const i = Math.floor(this.pos);
      const c = i + 1 < b.length ? b[i + 1] : b[i];
      out.push(b[i] + (c - b[i]) * (this.pos - i));
    }
    this.pos -= b.length;
  }
}

export class Turns {
  private ws: WebSocket | null = null;
  private user: number[] = [];
  private agent: number[] = [];
  private ru: To16k;
  private ra: To16k;
  private inFlight = 0;
  ready = false;

  constructor(rate: number, private ev: TurnEvents) {
    this.ru = new To16k(rate);
    this.ra = new To16k(rate);
  }

  /** Opens the connection; resolves true once TYGER is loaded (~30 s the first time), false if it can't be used. */
  open(): Promise<boolean> {
    return new Promise((res) => {
      let done = false;
      const finish = (ok: boolean) => {
        if (!done) (done = true), res(ok);
      };
      try {
        this.ws = new WebSocket(`${VOICE_SERVER.replace(/^http/, "ws")}/v1/turns`);
      } catch {
        return finish(false);
      }
      this.ws.binaryType = "arraybuffer";
      this.ws.onmessage = (m) => {
        const j = JSON.parse(String(m.data));
        if (j.ready) {
          this.ready = true;
          return finish(true);
        }
        if (j.error) return finish(false);
        this.inFlight = Math.max(0, this.inFlight - 1);
        for (const e of j.ev ?? []) {
          if (e.kind === "BARGE") this.ev.onBarge(Number(e.onset_s) || 0);
          else if (e.kind === "ENDPOINT") this.ev.onEndpoint();
        }
      };
      this.ws.onerror = () => finish(false);
      this.ws.onclose = () => {
        this.ready = false;
        finish(false);
      };
      setTimeout(() => finish(false), 90_000);
    });
  }

  /** A block of the mic and whether Prestige is speaking; sends a hop whenever 320 ms of the mic are in. */
  mic(b: Float32Array, speaking: boolean) {
    if (!this.ready) return;
    this.ru.push(b, this.user);
    while (this.user.length >= HOP) {
      const u = this.user.splice(0, HOP);
      // Prestige's side for the same 320 ms (silence where the tap is behind).
      const a = this.agent.splice(0, HOP);
      while (a.length < HOP) a.push(0);
      this.send(u, a, speaking);
    }
    // The playback tap can't run far ahead of the mic: keep it to one hop.
    if (this.agent.length > HOP * 2) this.agent.splice(0, this.agent.length - HOP);
  }

  /** A block of what Prestige is playing. */
  playback(b: Float32Array) {
    if (this.ready) this.ra.push(b, this.agent);
  }

  private send(u: number[], a: number[], speaking: boolean) {
    // A slow GPU mustn't build a queue: drop a hop rather than answer late.
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || this.inFlight > 2) return;
    const pcm = new Int16Array(2 * HOP);
    for (let i = 0; i < HOP; i++) {
      pcm[i] = Math.max(-32768, Math.min(32767, Math.round(u[i] * 32767)));
      pcm[HOP + i] = Math.max(-32768, Math.min(32767, Math.round(a[i] * 32767)));
    }
    // The mode byte, then the samples (an Int16Array can't start at byte 1, so they're copied in).
    const msg = new Uint8Array(1 + pcm.byteLength);
    msg[0] = speaking ? 1 : 0;
    msg.set(new Uint8Array(pcm.buffer), 1);
    this.inFlight++;
    this.ws.send(msg);
  }

  close() {
    this.ready = false;
    this.ws?.close();
    this.ws = null;
    this.user = [];
    this.agent = [];
  }
}

/** Words that mean "go on" (a backchannel), not "stop": said over Prestige, they don't cut it off. */
export const BACKCHANNEL = /^(m+-?h+m+|mhm+|uh-?huh|hm+|yeah|yep|yes|yup|right|okay|ok|sure|i see|got it|cool|nice|wow|oh|ah|aha|true|exactly|totally|go on|uh huh)[.!?,\s]*$/i;
