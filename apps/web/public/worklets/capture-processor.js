/**
 * 麦克风采集：多声道下混 + 线性插值重采样到 16kHz + 每 100ms 输出一帧 PCM16。
 * 同时回传 RMS，供前端在播放期间做打断判断。
 */
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;
    this.phase = 0;
    this.last = 0;
    this.chunkSize = 1600; // 16kHz 下约 100ms
    this.acc = new Float32Array(this.chunkSize);
    this.accLen = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0 || !input[0]) return true;

    const channels = input.length;
    const length = input[0].length;
    const mono = new Float32Array(length);
    for (let i = 0; i < length; i += 1) {
      let sum = 0;
      for (let c = 0; c < channels; c += 1) sum += input[c][i];
      mono[i] = sum / channels;
    }

    const combinedLength = length + 1;
    let pos = this.phase;
    while (pos < combinedLength - 1) {
      const index = Math.floor(pos);
      const fraction = pos - index;
      const a = index === 0 ? this.last : mono[index - 1];
      const b = mono[index];
      this.pushSample(a + (b - a) * fraction);
      pos += this.ratio;
    }
    this.phase = pos - (combinedLength - 1);
    this.last = mono[length - 1];
    return true;
  }

  pushSample(value) {
    this.acc[this.accLen] = value;
    this.accLen += 1;
    if (this.accLen >= this.chunkSize) this.flush();
  }

  flush() {
    const pcm = new Int16Array(this.accLen);
    let sumSquares = 0;
    for (let i = 0; i < this.accLen; i += 1) {
      const v = Math.max(-1, Math.min(1, this.acc[i]));
      sumSquares += v * v;
      pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
    }
    const rms = Math.sqrt(sumSquares / this.accLen);
    this.port.postMessage({ type: "chunk", pcm: pcm.buffer, rms }, [pcm.buffer]);
    this.accLen = 0;
  }
}

registerProcessor("capture-processor", CaptureProcessor);
