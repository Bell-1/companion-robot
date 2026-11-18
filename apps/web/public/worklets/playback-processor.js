/**
 * 播放队列：主线程推入已重采样到设备采样率的 Float32 片段，
 * 这里按 128 样本的渲染量子顺序取出，队尾静音。
 * 连续安静 3 个量子后上报 drained，用于切换回聆听态。
 */
class PlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.offset = 0;
    this.emptyFrames = 0;
    this.port.onmessage = (event) => {
      const data = event.data;
      if (data.type === "push") {
        this.queue.push(new Float32Array(data.samples));
        this.emptyFrames = 0;
      } else if (data.type === "flush") {
        this.queue = [];
        this.offset = 0;
        this.emptyFrames = 0;
      }
    };
  }

  process(_inputs, outputs) {
    const out = outputs[0][0];
    if (!out) return true;

    let written = 0;
    while (written < out.length && this.queue.length > 0) {
      const current = this.queue[0];
      const count = Math.min(out.length - written, current.length - this.offset);
      out.set(current.subarray(this.offset, this.offset + count), written);
      written += count;
      this.offset += count;
      if (this.offset >= current.length) {
        this.queue.shift();
        this.offset = 0;
      }
    }
    if (written < out.length) out.fill(0, written);

    if (this.queue.length === 0) {
      this.emptyFrames += 1;
      if (this.emptyFrames === 3) this.port.postMessage({ type: "drained" });
    } else {
      this.emptyFrames = 0;
    }
    return true;
  }
}

registerProcessor("playback-processor", PlaybackProcessor);
