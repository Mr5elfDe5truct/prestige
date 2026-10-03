// Live mode's microphone tap: hands the main thread the raw (echo-cancelled) samples in ~20 ms blocks, so it can
// keep a short pre-roll and cut each utterance exactly, instead of starting a recorder after speech is detected.
class MicTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(1024);
    this.n = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.n++] = ch[i];
        if (this.n === this.buf.length) {
          this.port.postMessage(this.buf, [this.buf.buffer]);
          this.buf = new Float32Array(1024);
          this.n = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor("mic-tap", MicTap);
