/** 浏览器与后端之间的实时协议定义。 */

/** 音频统一为 16kHz / 单声道 / PCM Signed 16-bit Little Endian。 */
export const CLIENT_AUDIO_SAMPLE_RATE = 16000;

export type SessionState = "idle" | "listening" | "thinking" | "speaking";

/** 回复情绪，用于语音语调与前端形象的表情。 */
export type AssistantEmotion = "neutral" | "happy" | "angry" | "sad" | "caring" | "excited";

export type ClientEvent =
  | { type: "session.init"; sessionId?: string }
  | { type: "mic.start" }
  | { type: "mic.stop" }
  /** 前端开始播放本轮语音，服务端据此暂停把麦克风数据当作有效语音。 */
  | { type: "playback.start"; turnId: string }
  | { type: "playback.end"; turnId: string }
  /** 用户打断：停止当前回复与播放。 */
  | { type: "interrupt" }
  /** 浏览器上报定位，供天气等需要地理位置的工具使用。 */
  | {
      type: "client.location";
      latitude: number;
      longitude: number;
      accuracy?: number;
      label?: string;
    }
  | { type: "text.input"; text: string }
  /** 摄像头抓帧：image 为去掉 data: 前缀的 JPEG base64，changed 表示画面跟上一帧差别明显。 */
  | { type: "vision.frame"; image: string; changed?: boolean };

export type ServerEvent =
  | {
      type: "session.ready";
      sessionId: string;
      /** 助手名称，由服务端环境变量 ASSISTANT_NAME 决定。 */
      assistantName: string;
      state: SessionState;
      tts: { sampleRate: number; format: "pcm"; voice: string };
      /** 摄像头「眼睛」配置，前端据此决定是否抓帧。 */
      vision: { enabled: boolean; intervalMs: number };
    }
  | { type: "state"; state: SessionState }
  | { type: "asr.partial"; text: string }
  | { type: "asr.final"; text: string }
  | { type: "asr.ignored"; text: string; reason: "echo" | "filler" }
  | { type: "user.accepted"; turnId: string; text: string }
  | { type: "assistant.delta"; turnId: string; text: string }
  /** 本轮回复的情绪，前端据此切换虚拟形象的表情。 */
  | { type: "assistant.emotion"; turnId: string; emotion: AssistantEmotion }
  | { type: "assistant.done"; turnId: string; text: string }
  | { type: "tts.start"; turnId: string; sampleRate: number }
  | { type: "tts.end"; turnId: string }
  /** 模型决定了下一次抓帧的延迟，前端据此安排下一次采集。 */
  | { type: "vision.interval"; intervalMs: number }
  /** 服务端要求立刻抓一帧：用户刚发出消息，本轮要配此刻的画面。 */
  | { type: "vision.capture" }
  | { type: "turn.cancelled"; turnId: string; reason: "interrupt" | "superseded" }
  /** 模型判断这句话不是在跟助手说，整轮静默（用于撤回前端已显示的用户消息）。 */
  | { type: "turn.ignored"; turnId: string }
  /** 当前会话的提醒与待办列表（仅本次连接期间有效，数据按 sessionId 落盘）。 */
  | { type: "reminder.list"; items: ReminderItem[] }
  /** 某条提醒到点，服务端即将语音播报。 */
  | { type: "reminder.fired"; item: ReminderItem }
  /** 本轮说话人的声纹识别结果；没注册过声纹时不会发。 */
  | { type: "voiceprint.speaker"; turnId: string; matched: boolean; name?: string; score?: number }
  | { type: "error"; code: string; message: string };

export type ClientEventType = ClientEvent["type"];

/** 提醒与待办。todo 没有 dueAt，reminder 一定有时间。 */
export type ReminderKind = "reminder" | "todo";
export type ReminderStatus = "pending" | "done" | "cancelled";

export interface ReminderItem {
  id: string;
  text: string;
  kind: ReminderKind;
  dueAt?: string;
  createdAt: string;
  status: ReminderStatus;
}

export type ServerEventType = ServerEvent["type"];
