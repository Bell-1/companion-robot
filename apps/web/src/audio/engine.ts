/** 线性插值重采样，保持跨调用相位连续。 */
class Pcm16Resampler {
  private phase = 0;
  private last = 0;

  constructor(
    private readonly srcRate: number,
    private readonly dstRate: number,
  ) {
    this.ratio = srcRate / dstRate;
  }

  private readonly ratio: number;

  process(input: Int16Array): Float32Array {
    if (input.length === 0) return new Float32Array(0);
    const combinedLength = input.length + 1;
    const samples = new Float32Array(combinedLength);
    samples[0] = this.last;
    for (let i = 0; i < input.length; i += 1) samples[i + 1] = input[i]! / 32768;

    const out: number[] = [];
    let pos = this.phase;
    while (pos < combinedLength - 1) {
      const index = Math.floor(pos);
      const fraction = pos - index;
      const a = samples[index]!;
      const b = samples[index + 1]!;
      out.push(a + (b - a) * fraction);
      pos += this.ratio;
    }
    this.phase = pos - (combinedLength - 1);
    this.last = samples[combinedLength - 1]!;
    return new Float32Array(out);
  }
}

/** 播放期间用于打断检测的能量阈值与连续帧数。 */
const BARGE_IN_RMS = 0.03;
const BARGE_IN_CHUNKS = 3;

export interface AudioEngineHandlers {
  onMicrophone: (chunk: ArrayBuffer) => void;
  onBargeIn: () => void;
  onDrained: () => void;
}

/**
 * 音频引擎：麦克风采集 + 播放队列。
 * 播放期间上行改为静音帧，既是回声抑制，也让服务端 ASR 连接保持活跃。
 */
export class AudioEngine {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private capture: AudioWorkletNode | null = null;
  private playback: AudioWorkletNode | null = null;
  private resampler: Pcm16Resampler | null = null;
  private resamplerRate = 0;
  private muted = false;
  private loudChunks = 0;

  handlers: AudioEngineHandlers = {
    onMicrophone: () => {},
    onBargeIn: () => {},
    onDrained: () => {},
  };

  get isRunning(): boolean {
    return this.ctx !== null;
  }

  async start(): Promise<void> {
    if (this.ctx) return;

    // 非 localhost 的 http 页面不是安全上下文，浏览器会禁用麦克风与 AudioWorklet。
    if (!window.isSecureContext) {
      throw new Error(
        `当前地址不是安全上下文（${location.origin}），浏览器已禁用麦克风。请改用 https 或 localhost 访问。`,
      );
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("当前浏览器不支持麦克风采集，请升级浏览器或改用 Chrome / Safari。");
    }
    if (typeof AudioContext === "undefined" || !("audioWorklet" in AudioContext.prototype)) {
      throw new Error("当前浏览器不支持 AudioWorklet，请使用 Chrome 66+ 或 iOS Safari 14.5+。");
    }

    const ctx = new AudioContext({ latencyHint: "interactive" });
    this.ctx = ctx;

    await ctx.audioWorklet.addModule("/worklets/capture-processor.js");
    await ctx.audioWorklet.addModule("/worklets/playback-processor.js");

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        // 浏览器自带的降噪/回声消除/自动增益会改造音色，中文识别经常被削掉辅音。
        // 回声已由播放期间静音上行 + 服务端文本相似度兜底，这里保留原始信号给 ASR。
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
      },
    });
    this.stream = stream;

    const source = ctx.createMediaStreamSource(stream);
    const capture = new AudioWorkletNode(ctx, "capture-processor");
    capture.port.onmessage = (event: MessageEvent) => this.handleCapture(event.data);
    // 必须连到 destination 才会被持续渲染，用 0 增益避免自听。
    const silent = ctx.createGain();
    silent.gain.value = 0;
    source.connect(capture);
    capture.connect(silent);
    silent.connect(ctx.destination);
    this.capture = capture;

    const playback = new AudioWorkletNode(ctx, "playback-processor", { outputChannelCount: [1] });
    playback.port.onmessage = (event: MessageEvent) => {
      if (event.data?.type === "drained") this.handlers.onDrained();
    };
    playback.connect(ctx.destination);
    this.playback = playback;

    await ctx.resume();
  }

  async stop(): Promise<void> {
    this.capture?.disconnect();
    this.playback?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    this.capture = null;
    this.playback = null;
    this.stream = null;
    const ctx = this.ctx;
    this.ctx = null;
    if (ctx) await ctx.close();
    this.muted = false;
    this.loudChunks = 0;
    this.resampler = null;
  }

  setMuted(muted: boolean): void {
    if (this.muted === muted) return;
    this.muted = muted;
    this.loudChunks = 0;
  }

  /** 播放一段 16-bit PCM。 */
  playChunk(buffer: ArrayBuffer, sampleRate: number): void {
    if (!this.playback || !this.ctx) return;
    if (this.resamplerRate !== sampleRate || !this.resampler) {
      this.resamplerRate = sampleRate;
      this.resampler = new Pcm16Resampler(sampleRate, this.ctx.sampleRate);
    }
    const int16 = new Int16Array(buffer);
    const samples = this.resampler.process(int16);
    if (samples.length === 0) return;
    this.playback.port.postMessage({ type: "push", samples: samples.buffer }, [samples.buffer]);
  }

  flush(): void {
    this.playback?.port.postMessage({ type: "flush" });
    this.resampler = null;
    this.resamplerRate = 0;
  }

  private handleCapture(data: { pcm: ArrayBuffer; rms: number }): void {
    if (this.muted) {
      if (data.rms > BARGE_IN_RMS) {
        this.loudChunks += 1;
        if (this.loudChunks >= BARGE_IN_CHUNKS) {
          this.loudChunks = 0;
          this.setMuted(false);
          this.handlers.onBargeIn();
        }
      } else {
        this.loudChunks = 0;
      }
      this.handlers.onMicrophone(new ArrayBuffer(data.pcm.byteLength));
      return;
    }
    this.loudChunks = 0;
    this.handlers.onMicrophone(data.pcm);
  }
}
