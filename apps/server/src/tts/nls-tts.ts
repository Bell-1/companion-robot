import { createRequire } from "node:module";
import type { Config } from "../env";
import { getNlsToken } from "../nls/token";
import type { Emotion } from "../util/text";

const require = createRequire(import.meta.url);
const Nls = require("alibabacloud-nls") as typeof import("alibabacloud-nls");

export interface NlsTtsOptions {
  config: Config;
  onAudio: (chunk: Buffer) => void;
  onError: (error: Error) => void;
}

/** 不同情绪在默认音色上的语速/音调/音量偏移。 */
const EMOTION_PARAMS: Record<Emotion, { speechRate: number; pitchRate: number; volume: number }> = {
  neutral: { speechRate: 0, pitchRate: 0, volume: 0 },
  happy: { speechRate: 12, pitchRate: 10, volume: 8 },
  angry: { speechRate: 18, pitchRate: 12, volume: 10 },
  sad: { speechRate: -12, pitchRate: -10, volume: -4 },
  caring: { speechRate: -6, pitchRate: -8, volume: -4 },
  excited: { speechRate: 18, pitchRate: 16, volume: 10 },
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * 阿里云智能语音交互「语音合成」(SpeechSynthesizer)。
 * NLS 一次请求合成一段文本，因此按句排队，保证音频顺序与文本一致。
 */
export class NlsTts {
  private token: string | null = null;
  private queue: string[] = [];
  private active: any = null;
  private running = false;
  private finished = false;
  private cancelled = false;
  private finishResolve: (() => void) | null = null;
  private emotion: Emotion = "neutral";

  constructor(private readonly options: NlsTtsOptions) {}

  /** 设置本轮情绪，后续合成按情绪调整语速、音调和音量。 */
  setEmotion(emotion: Emotion): void {
    this.emotion = emotion;
  }

  /** 预取 token，避免第一句才开始握手。 */
  async connect(): Promise<void> {
    this.token = await getNlsToken(this.options.config);
  }

  pushText(text: string): void {
    if (this.cancelled || !text.trim()) return;
    this.queue.push(text);
    void this.pump();
  }

  /** 所有文本已入队，等待队列合成完毕。 */
  finish(timeoutMs = 30000): Promise<void> {
    this.finished = true;
    if (!this.running && this.queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.finishResolve = null;
        resolve();
      }, timeoutMs);
      this.finishResolve = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  cancel(): void {
    this.cancelled = true;
    this.queue = [];
    const active = this.active;
    this.active = null;
    try {
      active?.shutdown();
    } catch {
      // 忽略
    }
    const resolve = this.finishResolve;
    this.finishResolve = null;
    resolve?.();
  }

  private async pump(): Promise<void> {
    if (this.running || this.cancelled) return;
    const text = this.queue.shift();
    if (!text) {
      if (this.finished) {
        const resolve = this.finishResolve;
        this.finishResolve = null;
        resolve?.();
      }
      return;
    }

    this.running = true;
    try {
      await this.synthesize(text);
    } catch (error) {
      if (!this.cancelled) {
        this.options.onError(error instanceof Error ? error : new Error(String(error)));
      }
    } finally {
      this.running = false;
      this.active = null;
      if (!this.cancelled) void this.pump();
    }
  }

  private synthesize(text: string): Promise<void> {
    const { config } = this.options;
    return new Promise<void>(async (resolve, reject) => {
      if (this.cancelled) return resolve();
      const token = this.token ?? (await getNlsToken(config));
      this.token = token;

      const synthesizer = new Nls.SpeechSynthesizer({
        url: config.nls.url,
        appkey: config.nls.appKey,
        token,
      });
      this.active = synthesizer;

      let settled = false;
      const done = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (error) reject(error);
        else resolve();
      };

      synthesizer.on("data", (buffer: Buffer) => {
        if (this.cancelled) return;
        this.options.onAudio(Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer));
      });
      synthesizer.on("completed", () => done());
      synthesizer.on("failed", (raw: string) =>
        done(new Error(`NLS TTS 失败: ${raw.slice(0, 200)}`)),
      );
      synthesizer.on("closed", () => done(new Error("NLS TTS 连接提前关闭")));

      try {
        const tuning = EMOTION_PARAMS[this.emotion];
        await synthesizer.start({
          text,
          voice: config.nls.ttsVoice,
          format: "pcm",
          sample_rate: config.nls.ttsSampleRate,
          volume: clamp(config.nls.ttsVolume + tuning.volume, 0, 100),
          speech_rate: clamp(config.nls.ttsSpeechRate + tuning.speechRate, -500, 500),
          pitch_rate: clamp(config.nls.ttsPitchRate + tuning.pitchRate, -500, 500),
          enable_subtitle: false,
        });
      } catch (error) {
        done(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
}
