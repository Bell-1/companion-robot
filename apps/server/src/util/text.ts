/** 文本处理：回声判定、流式分句。 */

const PUNCTUATION = /[\s，。！？、；：,.!?;:""''（）()【】\[\]—…·~～]/g;

export function normalizeText(text: string): string {
  return text.replace(PUNCTUATION, "").toLowerCase();
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length]!;
}

/**
 * 判断一句识别结果是否可能是机器人自己的播报被麦克风再次采集。
 * 前端在播放期间会静音上行，这里作为第二道防线。
 */
export function isLikelyEcho(text: string, lastAssistantText: string): boolean {
  const user = normalizeText(text);
  const assistant = normalizeText(lastAssistantText);
  if (user.length < 4 || assistant.length < 4) return false;
  if (assistant.includes(user)) return true;
  const distance = levenshtein(user, assistant);
  const ratio = 1 - distance / Math.max(user.length, assistant.length);
  return ratio >= 0.8;
}

/** 语气词/无内容应答，整句命中时不必走一轮模型和 TTS。 */
const FILLERS = new Set([
  "嗯",
  "恩",
  "啊",
  "哦",
  "噢",
  "呃",
  "额",
  "唉",
  "哎",
  "呀",
  "哈",
  "嘿",
  "呵",
  "唔",
  "咦",
  "嗯哼",
]);

/** 判断用户这句是不是「嗯」「啊」「嗯嗯」这类没有实际内容的语气词。 */
export function isFillerUtterance(text: string): boolean {
  const norm = normalizeText(text);
  if (!norm) return true;
  if (norm.length > 4) return false;
  if (FILLERS.has(norm)) return true;
  // 同一个语气词重复，如「嗯嗯嗯」「哈哈哈哈」；「谢谢」这类叠词不算。
  return /^[嗯恩啊哦噢呃额唉哎呀哈嘿呵唔咦]{2,4}$/.test(norm);
}

export const EMOTIONS = ["neutral", "happy", "angry", "sad", "caring", "excited"] as const;
export type Emotion = (typeof EMOTIONS)[number];

const EMOTION_TAGS: Record<string, Emotion> = {
  中性: "neutral",
  平静: "neutral",
  开心: "happy",
  高兴: "happy",
  愉快: "happy",
  生气: "angry",
  愤怒: "angry",
  不爽: "angry",
  难过: "sad",
  伤心: "sad",
  委屈: "sad",
  关心: "caring",
  温柔: "caring",
  兴奋: "excited",
  激动: "excited",
};

/**
 * 解析回复最开头的情绪标记，如「[开心]今天天气不错」。
 * 标记只用于控制合成语调，不会展示也不会被读出来。
 */
export function parseEmotionTag(text: string): { emotion: Emotion; text: string } | null {
  const match = /^\s*[\[【（(]([^\]】）)]{1,4})[\]】）)]\s*/.exec(text);
  if (!match) return null;
  const emotion = EMOTION_TAGS[match[1]!.trim()];
  if (!emotion) return null;
  return { emotion, text: text.slice(match[0].length) };
}

/**
 * 模型判断「这句话不是在跟助手说」时输出的静默标记。
 * 出现在回复开头时整轮不展示、不合成语音。
 */
export function isNoReplyTag(text: string): boolean {
  return /^\s*[\[【（(]不回应[\]】）)]/.test(text);
}

const SENTENCE_END = /[。！？!?；;\n]/;
const SOFT_BREAK = /[，,、：:]/;
const MAX_SENTENCE_CHARS = 48;
/** 第一句更早切分，让首包音频尽快开始播放。 */
const FIRST_CHUNK_MIN_CHARS = 10;
const SOFT_BREAK_MIN_CHARS = 18;

/** 把大模型流式输出切成适合逐句合成的片段。 */
export class SentenceChunker {
  private buffer = "";
  private first = true;

  push(delta: string): string[] {
    this.buffer += delta;
    const ready: string[] = [];
    const minSoft = this.first ? FIRST_CHUNK_MIN_CHARS : SOFT_BREAK_MIN_CHARS;
    let start = 0;
    for (let i = 0; i < this.buffer.length; i += 1) {
      const char = this.buffer[i]!;
      const segment = this.buffer.slice(start, i + 1);
      const isEnd = SENTENCE_END.test(char);
      const isSoft = SOFT_BREAK.test(char) && segment.length >= minSoft;
      const isTooLong = segment.length >= MAX_SENTENCE_CHARS;
      if (isEnd || isSoft || isTooLong) {
        if (segment.trim().length > 0) {
          ready.push(segment);
          this.first = false;
        }
        start = i + 1;
      }
    }
    this.buffer = this.buffer.slice(start);
    return ready;
  }

  flush(): string {
    const rest = this.buffer.trim();
    this.buffer = "";
    return rest.length > 0 ? rest : "";
  }
}
