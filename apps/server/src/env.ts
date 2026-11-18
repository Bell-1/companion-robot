/** 服务端配置，全部来自环境变量（见仓库根目录 .env.example）。 */
import path from "node:path";
import { fileURLToPath } from "node:url";

function readString(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value.trim() === "" ? fallback : value.trim();
}

function readNumber(name: string, fallback: number): number {
  const value = Number(readString(name, String(fallback)));
  return Number.isFinite(value) ? value : fallback;
}

function readBoolean(name: string, fallback: boolean): boolean {
  const value = readString(name, String(fallback)).toLowerCase();
  return value === "true" || value === "1" || value === "yes";
}

export interface Config {
  port: number;
  /** 助手名称，所有展示与人设都从这里取。 */
  assistant: {
    name: string;
  };
  nls: {
    accessKeyId: string;
    accessKeySecret: string;
    appKey: string;
    url: string;
    asrSampleRate: number;
    asrMaxSentenceSilenceMs: number;
    /** 语义断句会把一句话拆成多段、后段延迟明显，实时对话默认关闭。 */
    asrSemanticSentence: boolean;
    /** 定制泛热词，提升人名、地名、专有词识别率。 */
    asrVocabularyId?: string;
    /** 自学习语言模型 ID。 */
    asrCustomizationId?: string;
    ttsVoice: string;
    ttsSampleRate: number;
    ttsVolume: number;
    ttsSpeechRate: number;
    ttsPitchRate: number;
  };
  deepseek: {
    apiKey: string;
    baseUrl: string;
    model: string;
    temperature: number;
  };
  mcp: {
    /** MCP 服务配置文件，默认仓库根目录 mcp.json；文件不存在则不加载。 */
    configPath: string;
  };
  /** 联网搜索使用 DeepSeek Search API，和模型共用 Key。 */
  search: {
    enabled: boolean;
    /** 每次搜索默认返回几条结果。 */
    count: number;
  };
  weather: {
    key: string;
    /** 和风天气控制台分配的专属 API Host，形如 xxx.re.qweatherapi.com。 */
    host: string;
  };
  vision: {
    /** 是否启用摄像头「眼睛」。 */
    enabled: boolean;
    /** 抓帧间隔，默认 2 秒一帧。 */
    intervalMs: number;
    /** 画面在这个时长内才认为有效。 */
    maxAgeMs: number;
  };
  /** 本地声纹识别：区分说话人、记住每个人的声音。 */
  voiceprint: {
    enabled: boolean;
    /** CAM++ 等 sherpa-onnx 说话人模型路径。 */
    modelPath: string;
    /** 余弦相似度阈值，越高越保守。 */
    threshold: number;
  };
  /** 主动说话（环境变化或安静太久时自己开口）。 */
  proactive: {
    enabled: boolean;
    idleMinMs: number;
    idleMaxMs: number;
    /** 两次主动说话之间的最小间隔。 */
    minGapMs: number;
  };
  /** 空闲时自动观察环境并积累记忆。 */
  learning: {
    enabled: boolean;
    minIntervalMs: number;
    maxIntervalMs: number;
  };
  systemPrompt?: string;
}

export function loadConfig(): Config {
  const assistantName = readString("ASSISTANT_NAME", "悠悠");
  return {
    port: readNumber("PORT", 8787),
    assistant: { name: assistantName },
    nls: {
      accessKeyId: readString("ALIYUN_ACCESS_KEY_ID", ""),
      accessKeySecret: readString("ALIYUN_ACCESS_KEY_SECRET", ""),
      appKey: readString("NLS_APP_KEY", ""),
      url: readString("NLS_URL", "wss://nls-gateway-cn-shanghai.aliyuncs.com/ws/v1"),
      asrSampleRate: readNumber("NLS_ASR_SAMPLE_RATE", 16000),
      asrMaxSentenceSilenceMs: readNumber("NLS_ASR_MAX_SENTENCE_SILENCE_MS", 1000),
      // 语义断句会把一句话拆成多段，后段常延迟 2 秒才出，实时对话里反而拖慢并导致半句丢答。
      asrSemanticSentence: readBoolean("NLS_ASR_SEMANTIC_SENTENCE", false),
      asrVocabularyId: readString("NLS_ASR_VOCABULARY_ID", "") || undefined,
      asrCustomizationId: readString("NLS_ASR_CUSTOMIZATION_ID", "") || undefined,
      ttsVoice: readString("NLS_TTS_VOICE", "aixia"),
      ttsSampleRate: readNumber("NLS_TTS_SAMPLE_RATE", 24000),
      ttsVolume: readNumber("NLS_TTS_VOLUME", 50),
      ttsSpeechRate: readNumber("NLS_TTS_SPEECH_RATE", 0),
      ttsPitchRate: readNumber("NLS_TTS_PITCH_RATE", 0),
    },
    deepseek: {
      apiKey: readString("DEEPSEEK_API_KEY", ""),
      baseUrl: readString("DEEPSEEK_BASE_URL", "https://api.deepseek.com/v1"),
      model: readString("DEEPSEEK_MODEL", "deepseek-chat"),
      temperature: readNumber("DEEPSEEK_TEMPERATURE", 0.8),
    },
    mcp: {
      configPath: process.env.MCP_CONFIG_PATH?.trim()
        ? path.resolve(process.env.MCP_CONFIG_PATH.trim())
        : fileURLToPath(new URL("../../../mcp.json", import.meta.url)),
    },
    search: {
      enabled: readBoolean("WEB_SEARCH_ENABLED", true),
      count: readNumber("WEB_SEARCH_COUNT", 5),
    },
    weather: {
      key: readString("QWEATHER_API_KEY", ""),
      host: readString("QWEATHER_API_HOST", "devapi.qweather.com"),
    },
    vision: {
      enabled: readBoolean("EYE_ENABLED", true),
      intervalMs: readNumber("EYE_INTERVAL_MS", 2000),
      maxAgeMs: readNumber("EYE_MAX_AGE_MS", 6000),
    },
    voiceprint: {
      enabled: readBoolean("VOICEPRINT_ENABLED", true),
      modelPath: readString(
        "VOICEPRINT_MODEL_PATH",
        fileURLToPath(
          new URL("../models/3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx", import.meta.url),
        ),
      ),
      threshold: readNumber("VOICEPRINT_THRESHOLD", 0.6),
    },
    proactive: {
      enabled: readBoolean("PROACTIVE_ENABLED", true),
      idleMinMs: readNumber("PROACTIVE_IDLE_MIN_MS", 90000),
      idleMaxMs: readNumber("PROACTIVE_IDLE_MAX_MS", 180000),
      minGapMs: readNumber("PROACTIVE_MIN_GAP_MS", 60000),
    },
    learning: {
      enabled: readBoolean("LEARN_ENABLED", true),
      minIntervalMs: readNumber("LEARN_MIN_INTERVAL_MS", 300000),
      maxIntervalMs: readNumber("LEARN_MAX_INTERVAL_MS", 900000),
    },
    systemPrompt: process.env.SYSTEM_PROMPT?.trim() || undefined,
  };
}

export function assertConfig(config: Config): string[] {
  const missing: string[] = [];
  if (!config.nls.accessKeyId) missing.push("ALIYUN_ACCESS_KEY_ID");
  if (!config.nls.accessKeySecret) missing.push("ALIYUN_ACCESS_KEY_SECRET");
  if (!config.nls.appKey) missing.push("NLS_APP_KEY");
  if (!config.deepseek.apiKey) missing.push("DEEPSEEK_API_KEY");
  return missing;
}
