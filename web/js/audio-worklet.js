// Runs on the audio thread: mixes to mono and posts ~100 ms blocks to the page.
class CaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.block = options.processorOptions.blockSize;
    this.buf = new Float32Array(this.block);
    this.n = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (input && input.length) {
      const left = input[0];
      const right = input[1];
      for (let i = 0; i < left.length; i++) {
        this.buf[this.n++] = right ? (left[i] + right[i]) / 2 : left[i];
        if (this.n === this.block) {
          this.port.postMessage(this.buf.slice(0));
          this.n = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor("capture", CaptureProcessor);
