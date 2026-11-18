import { createRequire } from "node:module";
import type { Config } from "../env";
import { getNlsToken } from "../nls/token";

const require = createRequire(import.meta.url);
const Nls = require("alibabacloud-nls") as typeof import("alibabacloud-nls");

export interface AsrSentence {
  text: string;
  sentenceEnd: boolean;
}

export interface NlsAsrOptions {
  config: Config;
  onSentence: (sentence: AsrSentence) => void;
  onError: (error: Error) => void;
  onClosed: () => void;
}

/**
 * 阿里云智能语音交互「实时语音识别」(SpeechTranscriber)。
 * 一句话结束时服务端推 SentenceEnd，等价于 DashScope 的 sentence_end=true。
 */
export class NlsAsr {
  private transcriber: any = null;
  private ready = false;
  private closing = false;

  constructor(private readonly options: NlsAsrOptions) {}

  get isReady(): boolean {
    return this.ready;
  }

  async connect(timeoutMs = 10000): Promise<void> {
    if (this.ready) return;
    const token = await getNlsToken(this.options.config);
    const transcriber = new Nls.SpeechTranscription({
      url: this.options.config.nls.url,
      appkey: this.options.config.nls.appKey,
      token,
    });

    transcriber.on("changed", (raw: string) => {
      const text = parseResult(raw);
      if (text) this.options.onSentence({ text, sentenceEnd: false });
    });

    transcriber.on("end", (raw: string) => {
      const text = parseResult(raw);
      if (text) this.options.onSentence({ text, sentenceEnd: true });
    });

    transcriber.on("failed", (raw: string) => {
      const error = new Error(`NLS ASR 失败: ${parseError(raw)}`);
      this.ready = false;
      this.options.onError(error);
    });

    transcriber.on("closed", () => {
      this.ready = false;
      this.transcriber = null;
      if (!this.closing) this.options.onClosed();
    });

    this.transcriber = transcriber;

    let timer: NodeJS.Timeout | null = null;
    const { nls } = this.options.config;
    // 语义断句会参考上下文断句，官方说明可提升准确率；它依赖中间结果开关。
    const params: Record<string, unknown> = {
      format: "pcm",
      sample_rate: nls.asrSampleRate,
      enable_intermediate_result: true,
      enable_punctuation_prediction: true,
      enable_inverse_text_normalization: true,
      enable_voice_detection: true,
      max_sentence_silence: nls.asrMaxSentenceSilenceMs,
      enable_semantic_sentence_detection: nls.asrSemanticSentence,
    };
    if (nls.asrVocabularyId) params.vocabulary_id = nls.asrVocabularyId;
    if (nls.asrCustomizationId) params.customization_id = nls.asrCustomizationId;
    try {
      await Promise.race([
        transcriber.start(params, true, 6000),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("NLS ASR 连接超时")), timeoutMs);
        }),
      ]);
      this.ready = true;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  sendAudio(chunk: Buffer): void {
    if (!this.ready || !this.transcriber) return;
    this.transcriber.sendAudio(chunk);
  }

  close(): void {
    this.closing = true;
    this.ready = false;
    const transcriber = this.transcriber;
    this.transcriber = null;
    try {
      transcriber?.shutdown();
    } catch {
      // 忽略关闭异常
    }
  }
}

function parseResult(raw: string): string {
  try {
    const message = JSON.parse(raw);
    return typeof message?.payload?.result === "string" ? message.payload.result : "";
  } catch {
    return "";
  }
}

function parseError(raw: string): string {
  try {
    const message = JSON.parse(raw);
    return `${message?.header?.status_text ?? message?.header?.status ?? "unknown"} ${
      message?.payload?.error_message ?? ""
    }`.trim();
  } catch {
    return raw;
  }
}
