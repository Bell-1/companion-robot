import { randomUUID } from "node:crypto";
import type { ClientEvent, ReminderItem, ServerEvent, SessionState } from "@companion/shared";
import { observeFrame, streamAgentReply } from "../agent/agent";
import { NlsAsr } from "../asr/nls-asr";
import { NlsTts } from "../tts/nls-tts";
import type { Config } from "../env";
import {
  clampVisionInterval,
  registerVisionController,
  registerVisionFrameProvider,
  unregisterVisionController,
  unregisterVisionFrameProvider,
} from "../tools/vision-control";
import { addMemory } from "../tools/memory";
import { DATA_DIR, memoryDir } from "../tools/paths";
import {
  getLastUtterance,
  registerUtteranceProvider,
  unregisterUtteranceProvider,
} from "../voiceprint/control";
import { extractEmbedding } from "../voiceprint/model";
import { identifyVoiceprint, readVoiceprints, voiceprintDir } from "../voiceprint/store";
import { learnAppearanceFromFrame } from "../people/learn";
import { findPerson, peopleDir, readPeople, upsertPerson } from "../people/store";
import {
  registerReminderController,
  unregisterReminderController,
} from "../tools/reminder-control";
import { completeReminder, dueReminders, readReminders, remindersDir } from "../tools/reminders";
import { appendObservation, readObservations, worldDir } from "../tools/world";
import { clearUserLocation, setUserLocation } from "../tools/location";
import {
  isFillerUtterance,
  isLikelyEcho,
  isNoReplyTag,
  parseEmotionTag,
  SentenceChunker,
} from "../util/text";
import type { Emotion } from "../util/text";

/** ASR 握手期间最多缓存 2 秒 16k PCM16 音频。 */
const MAX_PENDING_AUDIO_BYTES = 64_000;
/** 声纹识别最多回溯最近 12 秒音频。 */
const MAX_UTTERANCE_AUDIO_BYTES = 16_000 * 2 * 12;

export interface SessionTransport {
  sendEvent: (event: ServerEvent) => void;
  sendAudio: (chunk: Buffer) => void;
}

/**
 * 一次 WebSocket 连接对应一个语音会话：
 * 上行音频 -> ASR -> 回声/语气词过滤 -> DeepAgent -> 分句 TTS -> 下行音频。
 */
export class VoiceSession {
  sessionId: string;
  private state: SessionState = "idle";
  private asr: NlsAsr | null = null;
  private tts: NlsTts | null = null;
  private abortController: AbortController | null = null;
  private turnId: string | null = null;
  private lastAssistantText = "";
  private closed = false;
  private asrConnecting = false;
  private nextAsrAttemptAt = 0;
  /** ASR 握手期间暂存的音频帧。 */
  private pendingAudio: Buffer[] = [];
  /** 用户说完话（ASR 出句）的时刻，用于延迟统计。 */
  private speechEndAt: number | null = null;
  /** 摄像头最新一帧（JPEG base64），只存内存。 */
  private latestFrame: { image: string; at: number } | null = null;
  /** 用户刚发消息时请求的画面时刻；本轮会等这一帧再问模型。 */
  private lastFrameRequestAt = 0;
  /** 正在等新画面的本轮回调。 */
  private frameWaiters = new Set<() => void>();
  /** 当前抓帧间隔，模型可通过 set_look_interval 工具动态调整。 */
  private visionIntervalMs: number;
  /** 主动说话相关：定时器与最近一次开口/用户出声的时间。 */
  private proactiveTimer: ReturnType<typeof setTimeout> | null = null;
  private sceneTimer: ReturnType<typeof setTimeout> | null = null;
  private lastProactiveAt = 0;
  private lastVoiceAt = 0;
  /** 空闲时静默观察环境的定时器。 */
  private learningTimer: ReturnType<typeof setTimeout> | null = null;
  private learning = false;
  private lastLearnAt = 0;
  /** 到点提醒的定时器；每次只睡到最近一条提醒，最多 60 秒后重新检查。 */
  private reminderTimer: ReturnType<typeof setTimeout> | null = null;
  /** 最近一句用户语音的 PCM，用来提取声纹；只保留最近 12 秒。 */
  private utteranceAudio: Buffer[] = [];
  private utteranceBytes = 0;
  private lastUtterance: { audio: Buffer; at: number } | null = null;
  /** 正在从画面学习外貌的人，避免同一轮重复调用视觉模型。 */
  private personLearning = new Set<string>();

  constructor(
    private readonly transport: SessionTransport,
    private readonly config: Config,
    sessionId?: string,
  ) {
    this.sessionId = sessionId ?? randomUUID();
    this.visionIntervalMs = clampVisionInterval(config.vision.intervalMs);
    this.registerVisionBridge();
    this.registerReminderBridge();
    this.registerVoiceprintBridge();
  }

  /** 声纹工具要拿到「刚才那一句」的音频。 */
  private registerVoiceprintBridge(): void {
    registerUtteranceProvider(this.sessionId, () => this.lastUtterance);
  }

  /** 工具改动提醒后，立刻刷新前端的提醒列表并重排定时器。 */
  private registerReminderBridge(): void {
    registerReminderController(this.sessionId, {
      refresh: () => {
        void this.refreshReminders();
      },
    });
  }

  /** 模型通过工具调整观察频率时，直接通知当前会话与前端。 */
  private registerVisionBridge(): void {
    registerVisionController(this.sessionId, (intervalMs) => {
      if (!this.config.vision.enabled) return false;
      this.visionIntervalMs = clampVisionInterval(intervalMs);
      this.transport.sendEvent({ type: "vision.interval", intervalMs: this.visionIntervalMs });
      return true;
    });
    // 模型调用 look_closely 时取当前最新一帧，画面太旧就不给。
    registerVisionFrameProvider(this.sessionId, () => {
      if (!this.config.vision.enabled) return null;
      const frame = this.latestFrame;
      if (!frame) return null;
      return Date.now() - frame.at <= this.config.vision.maxAgeMs ? frame : null;
    });
  }

  /** 前端可以带一个稳定的 sessionId，让记忆与观察记录在刷新后延续。 */
  private adoptSessionId(candidate?: string): void {
    const next = candidate?.trim();
    if (!next || next === this.sessionId) return;
    if (!/^[a-zA-Z0-9_-]{6,64}$/.test(next)) return;
    const previous = this.sessionId;
    unregisterVisionController(previous);
    unregisterVisionFrameProvider(previous);
    unregisterReminderController(previous);
    unregisterUtteranceProvider(previous);
    clearUserLocation(previous);
    this.lastUtterance = null;
    this.utteranceAudio = [];
    this.utteranceBytes = 0;
    this.sessionId = next;
    this.registerVisionBridge();
    this.registerReminderBridge();
    this.registerVoiceprintBridge();
  }

  init(override?: { sessionId?: string }): void {
    this.adoptSessionId(override?.sessionId);
    this.transport.sendEvent({
      type: "session.ready",
      sessionId: this.sessionId,
      assistantName: this.config.assistant.name,
      state: this.state,
      tts: {
        sampleRate: this.config.nls.ttsSampleRate,
        format: "pcm",
        voice: this.config.nls.ttsVoice,
      },
      vision: {
        enabled: this.config.vision.enabled,
        intervalMs: this.visionIntervalMs,
      },
    });
    void this.ensureAsr();
    this.scheduleProactive();
    this.scheduleLearning();
    void this.refreshReminders();
  }

  handleClientEvent(event: ClientEvent): void {
    switch (event.type) {
      case "session.init":
        this.init({ sessionId: event.sessionId });
        break;
      case "mic.start":
        this.setState("listening");
        void this.ensureAsr();
        this.scheduleProactive();
        this.scheduleLearning();
        void this.refreshReminders();
        break;
      case "mic.stop":
        this.cancelTurn("interrupt");
        this.latestFrame = null;
        this.lastUtterance = null;
        this.utteranceAudio = [];
        this.utteranceBytes = 0;
        this.clearProactiveTimers();
        this.clearLearningTimer();
        this.setState("idle");
        break;
      case "playback.start":
        if (this.turnId === event.turnId) this.setState("speaking");
        break;
      case "playback.end":
        if (this.state === "speaking") this.setState("listening");
        break;
      case "interrupt":
        this.cancelTurn("interrupt");
        this.setState("listening");
        break;
      case "client.location":
        setUserLocation(this.sessionId, {
          latitude: event.latitude,
          longitude: event.longitude,
          accuracy: event.accuracy,
          label: event.label,
        });
        break;
      case "vision.frame": {
        // 单帧限制约 400KB，避免前端异常时把内存撑爆。
        if (!this.config.vision.enabled) break;
        const image = event.image.trim();
        if (!image || image.length > 400 * 1024) break;
        this.latestFrame = { image, at: Date.now() };
        this.resolveFrameWaiters();
        if (event.changed) this.onSceneChanged();
        break;
      }
      case "text.input": {
        const text = event.text.trim();
        if (!text) break;
        this.handleUtterance(text, { skipFiller: true });
        break;
      }
    }
  }

  handleAudio(chunk: Buffer): void {
    if (this.closed) return;
    this.rememberUtteranceAudio(chunk);
    if (!this.asr?.isReady) {
      // ASR 还在握手时先缓存最新 2 秒音频，连上后补发，避免吞掉用户开头的话。
      this.pendingAudio.push(chunk);
      let bytes = this.pendingAudio.reduce((sum, item) => sum + item.length, 0);
      while (bytes > MAX_PENDING_AUDIO_BYTES && this.pendingAudio.length > 1) {
        bytes -= this.pendingAudio.shift()!.length;
      }
      void this.ensureAsr();
      return;
    }
    this.asr.sendAudio(chunk);
  }

  /** 只保留最近 12 秒音频，供声纹识别与「记住我的声音」使用。 */
  private rememberUtteranceAudio(chunk: Buffer): void {
    if (!this.config.voiceprint.enabled) return;
    this.utteranceAudio.push(chunk);
    this.utteranceBytes += chunk.length;
    while (this.utteranceBytes > MAX_UTTERANCE_AUDIO_BYTES && this.utteranceAudio.length > 1) {
      this.utteranceBytes -= this.utteranceAudio.shift()!.length;
    }
  }

  /** ASR 出句时把这一句的音频固定下来，随后清空缓冲准备下一句。 */
  private captureUtterance(): void {
    if (this.utteranceBytes === 0) return;
    this.lastUtterance = {
      audio: Buffer.concat(this.utteranceAudio),
      at: Date.now(),
    };
    this.utteranceAudio = [];
    this.utteranceBytes = 0;
  }

  /** 有新的摄像头帧到达时，唤醒正在等待画面的本轮对话。 */
  private resolveFrameWaiters(): void {
    const waiters = [...this.frameWaiters];
    this.frameWaiters.clear();
    for (const resolve of waiters) resolve();
  }

  /** 等一帧比 since 更新的画面；超时后返回，用现有画面兜底。 */
  private waitForFreshFrame(since: number, timeoutMs: number): Promise<void> {
    if (!this.config.vision.enabled) return Promise.resolve();
    if (this.latestFrame && this.latestFrame.at >= since) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.frameWaiters.delete(waiter);
        resolve();
      }, timeoutMs);
      const waiter = () => {
        clearTimeout(timer);
        resolve();
      };
      this.frameWaiters.add(waiter);
    });
  }

  close(): void {
    this.closed = true;
    this.cancelTurn("interrupt");
    this.clearProactiveTimers();
    this.clearLearningTimer();
    this.pendingAudio = [];
    this.latestFrame = null;
    this.lastUtterance = null;
    this.utteranceAudio = [];
    this.utteranceBytes = 0;
    this.personLearning.clear();
    this.asr?.close();
    this.asr = null;
    unregisterVisionController(this.sessionId);
    unregisterVisionFrameProvider(this.sessionId);
    unregisterReminderController(this.sessionId);
    unregisterUtteranceProvider(this.sessionId);
    if (this.reminderTimer) {
      clearTimeout(this.reminderTimer);
      this.reminderTimer = null;
    }
    clearUserLocation(this.sessionId);
  }

  /** 推送提醒列表，并按最近一条待触发提醒重排定时器。 */
  private async refreshReminders(): Promise<void> {
    if (this.closed) return;
    try {
      const items = await readReminders(remindersDir(), this.sessionId);
      if (this.closed) return;
      this.transport.sendEvent({ type: "reminder.list", items });
      this.armReminderTimer(items);
    } catch {
      // 提醒数据损坏不应该影响对话。
    }
  }

  private armReminderTimer(items: ReminderItem[]): void {
    if (this.reminderTimer) {
      clearTimeout(this.reminderTimer);
      this.reminderTimer = null;
    }
    // 没开麦时不播报；等 mic.start 后再重新排。
    if (this.closed || this.state === "idle") return;
    const next = items
      .filter((item) => item.status === "pending" && item.dueAt)
      .sort((a, b) => (a.dueAt ?? "").localeCompare(b.dueAt ?? ""))[0];
    if (!next?.dueAt) return;
    const delay = new Date(next.dueAt).getTime() - Date.now();
    const wait = Math.max(0, Math.min(delay, 60_000));
    this.reminderTimer = setTimeout(() => {
      void this.fireDueReminders();
    }, wait);
    this.reminderTimer.unref?.();
  }

  /** 会话已关闭或还没开始听时，不播报提醒。 */
  private get remindersInactive(): boolean {
    return this.closed || this.state === "idle";
  }

  /** 到点后先标记完成再播报；正在对话/播报时晚几秒重试，避免插嘴。 */
  private async fireDueReminders(): Promise<void> {
    this.reminderTimer = null;
    if (this.remindersInactive) return;
    if (this.turnId || this.state === "speaking") {
      this.reminderTimer = setTimeout(() => {
        void this.fireDueReminders();
      }, 5000);
      this.reminderTimer.unref?.();
      return;
    }

    const due = await dueReminders(remindersDir(), this.sessionId);
    for (const item of due) {
      if (this.remindersInactive) break;
      if (this.turnId) {
        this.reminderTimer = setTimeout(() => {
          void this.fireDueReminders();
        }, 5000);
        this.reminderTimer.unref?.();
        return;
      }
      const done = await completeReminder(remindersDir(), this.sessionId, item.id);
      if (!done) continue;
      this.transport.sendEvent({
        type: "reminder.fired",
        item: { ...done, status: "done" },
      });
      await this.speakReminder(done.text);
    }
    await this.refreshReminders();
  }

  /** 不走模型，直接用 TTS 播报提醒，保证到点一定说得出来。 */
  private async speakReminder(text: string): Promise<void> {
    if (this.remindersInactive) return;
    const turnId = randomUUID();
    this.turnId = turnId;
    const speech = `提醒你一下：${text}`;
    let audioStarted = false;

    const tts = new NlsTts({
      config: this.config,
      onAudio: (chunk) => {
        if (this.turnId !== turnId) return;
        if (!audioStarted) {
          audioStarted = true;
          this.setState("speaking");
          this.transport.sendEvent({
            type: "tts.start",
            turnId,
            sampleRate: this.config.nls.ttsSampleRate,
          });
        }
        this.transport.sendAudio(chunk);
      },
      onError: (error) => {
        this.transport.sendEvent({ type: "error", code: "tts_error", message: error.message });
      },
    });
    this.tts = tts;
    this.setState("thinking");
    this.transport.sendEvent({ type: "assistant.emotion", turnId, emotion: "caring" });
    this.transport.sendEvent({ type: "assistant.delta", turnId, text: speech });
    this.transport.sendEvent({ type: "assistant.done", turnId, text: speech });

    try {
      await tts.connect();
      if (this.turnId !== turnId) return;
      tts.setEmotion("caring");
      tts.pushText(speech);
      await tts.finish();
      if (this.turnId !== turnId) return;
      this.transport.sendEvent({ type: "tts.end", turnId });
      this.lastAssistantText = speech;
    } catch (error) {
      if (this.turnId === turnId) {
        this.transport.sendEvent({
          type: "error",
          code: "tts_error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      if (this.tts === tts) this.tts = null;
      if (this.turnId === turnId) {
        this.turnId = null;
        if (this.state === "thinking") this.setState("listening");
      }
    }
  }

  private setState(next: SessionState): void {
    if (this.state === next) return;
    this.state = next;
    this.transport.sendEvent({ type: "state", state: next });
  }

  private async ensureAsr(): Promise<void> {
    if (this.closed || this.asrConnecting || this.asr?.isReady) return;
    // 鉴权失败等场景下避免每个音频帧都重连。
    if (Date.now() < this.nextAsrAttemptAt) return;
    this.asrConnecting = true;
    const asr = new NlsAsr({
      config: this.config,
      onSentence: (sentence) => {
        if (!sentence.sentenceEnd) {
          this.lastVoiceAt = Date.now();
          this.transport.sendEvent({ type: "asr.partial", text: sentence.text });
          return;
        }
        this.speechEndAt = performance.now();
        this.captureUtterance();
        this.handleUtterance(sentence.text);
      },
      onError: (error) => {
        this.transport.sendEvent({ type: "error", code: "asr_error", message: error.message });
      },
      onClosed: () => {
        this.asr = null;
        if (!this.closed) setTimeout(() => void this.ensureAsr(), 500);
      },
    });

    try {
      await asr.connect();
      this.asr = asr;
      this.nextAsrAttemptAt = 0;
      const pending = this.pendingAudio;
      this.pendingAudio = [];
      for (const chunk of pending) asr.sendAudio(chunk);
    } catch (error) {
      this.pendingAudio = [];
      this.nextAsrAttemptAt = Date.now() + 5000;
      this.transport.sendEvent({
        type: "error",
        code: "asr_connect_failed",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.asrConnecting = false;
    }
  }

  private handleUtterance(text: string, options?: { skipFiller?: boolean }): void {
    const trimmed = text.trim();
    if (!trimmed) return;

    // 播放期间收到"用户语音"极大概率是扬声器回声，直接丢弃，不要显示成用户发言。
    if (this.state === "speaking") {
      this.transport.sendEvent({ type: "asr.ignored", text: trimmed, reason: "echo" });
      return;
    }

    if (isLikelyEcho(trimmed, this.lastAssistantText)) {
      this.transport.sendEvent({ type: "asr.ignored", text: trimmed, reason: "echo" });
      return;
    }

    // 「嗯」「啊」「哦」这类语气词没有实际内容，不触发模型和语音。
    if (!options?.skipFiller && isFillerUtterance(trimmed)) {
      this.transport.sendEvent({ type: "asr.ignored", text: trimmed, reason: "filler" });
      return;
    }

    this.acceptUtterance(trimmed);
  }

  private acceptUtterance(displayText: string, modelText = displayText): void {
    this.lastVoiceAt = Date.now();
    if (this.sceneTimer) {
      clearTimeout(this.sceneTimer);
      this.sceneTimer = null;
    }
    // 这句话发出的同时让前端抓一帧，模型看到的画面和对话就能对上同一时刻。
    if (this.config.vision.enabled) {
      this.lastFrameRequestAt = Date.now();
      this.transport.sendEvent({ type: "vision.capture" });
    } else {
      this.lastFrameRequestAt = 0;
    }
    this.transport.sendEvent({ type: "asr.final", text: displayText });
    this.startTurn(displayText, modelText);
  }

  private startTurn(text: string, modelText = text): void {
    this.cancelTurn("superseded");
    if (this.closed) return;

    const turnId = randomUUID();
    this.turnId = turnId;
    const abortController = new AbortController();
    this.abortController = abortController;

    this.setState("thinking");
    this.transport.sendEvent({ type: "user.accepted", turnId, text });

    void this.runTurn(turnId, modelText, abortController);
  }

  /** 用刚才那一句音频识别说话人；没注册声纹或音质太差时返回空。 */
  private async identifySpeaker(
    turnId: string,
  ): Promise<{ matched: boolean; name?: string; score?: number } | undefined> {
    if (!this.config.voiceprint.enabled) return;
    const utterance = getLastUtterance(this.sessionId);
    if (!utterance) return;
    try {
      const profiles = await readVoiceprints(voiceprintDir(DATA_DIR), this.sessionId);
      if (profiles.length === 0) return;
      const embedding = extractEmbedding(utterance.audio, {
        modelPath: this.config.voiceprint.modelPath,
      });
      if (!embedding) return;
      const match = identifyVoiceprint(profiles, embedding, this.config.voiceprint.threshold);
      const result = match
        ? { matched: true, name: match.profile.name, score: Math.round(match.score * 1000) / 1000 }
        : { matched: false };
      if (match) void this.noteKnownSpeaker(match.profile.name);
      if (this.turnId === turnId) {
        this.transport.sendEvent({ type: "voiceprint.speaker", turnId, ...result });
      }
      return result;
    } catch {
      // 声纹只是增强信息，失败不影响本轮对话。
      return;
    }
  }

  /**
   * 认出说话人后更新人物记忆；如果还没有长相记录，顺手从当前画面学一次，
   * 下次就能在画面里把人和名字对上。
   */
  private async noteKnownSpeaker(name: string): Promise<void> {
    try {
      const dir = peopleDir(DATA_DIR);
      const people = await readPeople(dir, this.sessionId);
      const existing = findPerson(people, name);
      const lastSpoken = existing?.lastSpokeAt ? Date.parse(existing.lastSpokeAt) : 0;
      if (!Number.isFinite(lastSpoken) || Date.now() - lastSpoken > 5 * 60_000) {
        await upsertPerson(dir, this.sessionId, name, { spoken: true });
      }
      if (!existing?.appearance && !this.personLearning.has(name)) {
        this.personLearning.add(name);
        void learnAppearanceFromFrame({
          config: this.config,
          sessionId: this.sessionId,
          name,
        })
          .catch(() => undefined)
          .finally(() => this.personLearning.delete(name));
      }
    } catch {
      // 人物记忆失败不影响对话。
    }
  }

  private async runTurn(
    turnId: string,
    text: string,
    abortController: AbortController,
    options?: { proactive?: boolean },
  ): Promise<void> {
    const { signal } = abortController;
    // 声纹识别与模型推理并行，避免额外等待。
    const speakerPromise = options?.proactive ? null : this.identifySpeaker(turnId);

    const startedAt = this.speechEndAt ?? performance.now();
    this.speechEndAt = null;
    const speaker = speakerPromise ? await speakerPromise : undefined;
    if (signal.aborted) return;
    // 用户刚发消息时已请求前端立即抓帧；这轮最多等 500ms 拿到这张「此刻」的画面。
    if (!options?.proactive && this.lastFrameRequestAt) {
      await this.waitForFreshFrame(this.lastFrameRequestAt, 500);
      if (signal.aborted) return;
    }
    let audioStarted = false;
    let firstTokenAt = 0;
    let firstAudioAt = 0;

    const tts = new NlsTts({
      config: this.config,
      onAudio: (chunk) => {
        if (signal.aborted) return;
        if (!audioStarted) {
          audioStarted = true;
          firstAudioAt = performance.now();
          this.setState("speaking");
          this.transport.sendEvent({
            type: "tts.start",
            turnId,
            sampleRate: this.config.nls.ttsSampleRate,
          });
        }
        this.transport.sendAudio(chunk);
      },
      onError: (error) => {
        this.transport.sendEvent({ type: "error", code: "tts_error", message: error.message });
      },
    });
    this.tts = tts;

    // TTS 连接与模型推理并行，节省首包时间。
    const ttsReady = tts.connect().catch((error: unknown) => {
      this.transport.sendEvent({
        type: "error",
        code: "tts_connect_failed",
        message: error instanceof Error ? error.message : String(error),
      });
    });

    const chunker = new SentenceChunker();
    let reply = "";
    let emotion: Emotion = "neutral";
    let emotionResolved = false;
    let ignored = false;
    let lead = "";
    // 只把足够新的画面交给模型，避免拿几秒前的旧画面回答。
    const frame =
      this.latestFrame && Date.now() - this.latestFrame.at <= this.config.vision.maxAgeMs
        ? this.latestFrame.image
        : undefined;

    // 情绪标记只在最开头，解析出来后立刻把正文按正常流式推给前端和 TTS。
    const emit = async (chunk: string): Promise<void> => {
      if (!chunk) return;
      reply += chunk;
      this.transport.sendEvent({ type: "assistant.delta", turnId, text: chunk });
      for (const sentence of chunker.push(chunk)) {
        await ttsReady;
        if (signal.aborted) return;
        tts.pushText(sentence);
      }
    };

    try {
      for await (const delta of streamAgentReply({
        config: this.config,
        sessionId: this.sessionId,
        text,
        imageBase64: frame,
        proactive: options?.proactive,
        speaker,
        signal,
      })) {
        if (signal.aborted) return;
        if (!firstTokenAt) firstTokenAt = performance.now();

        if (ignored) continue;

        if (emotionResolved) {
          await emit(delta);
          if (signal.aborted) return;
          continue;
        }

        lead += delta;
        // [不回应] 只对主动开口生效；被动回复一律当作正常内容。
        if (options?.proactive && isNoReplyTag(lead)) {
          ignored = true;
          emotionResolved = true;
          lead = "";
          tts.cancel();
          continue;
        }

        const parsed = parseEmotionTag(lead);
        if (parsed) {
          if (options?.proactive && isNoReplyTag(parsed.text)) {
            ignored = true;
            emotionResolved = true;
            lead = "";
            tts.cancel();
            continue;
          }
          emotion = parsed.emotion;
          emotionResolved = true;
          this.transport.sendEvent({ type: "assistant.emotion", turnId, emotion });
          tts.setEmotion(emotion);
          lead = "";
          await emit(parsed.text);
          if (signal.aborted) return;
          continue;
        }

        // 开头不是括号说明没有情绪标记，按中性立刻放行，别为了等标记拖慢首包。
        const trimmed = lead.trimStart();
        const looksLikeTag = trimmed.length === 0 || /^[\[【（(]/.test(trimmed);
        if (!looksLikeTag || trimmed.length > 8) {
          emotionResolved = true;
          this.transport.sendEvent({ type: "assistant.emotion", turnId, emotion });
          const pending = lead;
          lead = "";
          await emit(pending);
          if (signal.aborted) return;
        }
      }
      if (signal.aborted) return;

      if (ignored) {
        // 主动开口时允许「没什么可说」：不显示、不播报，直接回到聆听。
        if (this.turnId === turnId) {
          this.turnId = null;
          if (this.state === "thinking") this.setState("listening");
        }
        return;
      }

      if (!emotionResolved && lead) {
        await emit(lead);
        lead = "";
      }

      const tail = chunker.flush();
      if (tail) {
        await ttsReady;
        tts.pushText(tail);
      }

      this.transport.sendEvent({ type: "assistant.done", turnId, text: reply });
      if (reply.trim()) {
        this.lastAssistantText = reply;
        if (options?.proactive) this.lastProactiveAt = Date.now();
      }

      await tts.finish();
      if (signal.aborted) return;
      this.transport.sendEvent({ type: "tts.end", turnId });
      this.logLatency(turnId, startedAt, firstTokenAt, firstAudioAt);
      if (this.turnId === turnId) {
        this.turnId = null;
        // 没有音频输出时不会有 playback.end，这里兜底回到聆听态。
        if (this.state === "thinking") this.setState("listening");
      }
    } catch (error) {
      if (signal.aborted) return;
      this.transport.sendEvent({
        type: "error",
        code: "agent_error",
        message: error instanceof Error ? error.message : String(error),
      });
      if (this.turnId === turnId) {
        this.turnId = null;
        this.setState("listening");
      }
    } finally {
      tts.cancel();
      if (this.tts === tts) this.tts = null;
      this.scheduleProactive();
      this.scheduleLearning();
    }
  }

  private clearLearningTimer(): void {
    if (this.learningTimer) clearTimeout(this.learningTimer);
    this.learningTimer = null;
  }

  /** 空闲观察：间隔较长，且只在不打扰对话的时候进行。 */
  private scheduleLearning(delayMs?: number): void {
    if (this.learningTimer) {
      clearTimeout(this.learningTimer);
      this.learningTimer = null;
    }
    const { enabled, minIntervalMs, maxIntervalMs } = this.config.learning;
    if (!enabled || this.closed) return;
    const min = Math.max(10000, minIntervalMs);
    const max = Math.max(min, maxIntervalMs);
    const delay = delayMs ?? min + Math.random() * (max - min);
    this.learningTimer = setTimeout(() => {
      this.learningTimer = null;
      void this.maybeLearn();
    }, delay);
  }

  private async maybeLearn(): Promise<void> {
    const { enabled, minIntervalMs } = this.config.learning;
    if (!enabled || this.closed || this.learning) {
      this.scheduleLearning();
      return;
    }
    if (this.turnId || this.state !== "listening" || !this.config.vision.enabled) {
      this.scheduleLearning();
      return;
    }
    const frame = this.latestFrame;
    const frameMaxAge = Math.max(this.config.vision.maxAgeMs, this.visionIntervalMs * 3);
    if (!frame || Date.now() - frame.at > frameMaxAge) {
      this.scheduleLearning();
      return;
    }
    // 刚说过话就先不观察，避免和对话抢注意力。
    if (Date.now() - this.lastVoiceAt < 30000) {
      this.scheduleLearning();
      return;
    }
    if (Date.now() - this.lastLearnAt < minIntervalMs) {
      this.scheduleLearning();
      return;
    }

    this.learning = true;
    this.lastLearnAt = Date.now();
    try {
      const items = await readObservations(worldDir(), this.sessionId);
      const last = items[items.length - 1];
      const previous = last ? `${last.scene}${last.change ? `（${last.change}）` : ""}` : undefined;
      const observation = await observeFrame({
        config: this.config,
        imageBase64: frame.image,
        previous,
      });
      if (!observation.scene) return;

      await appendObservation(worldDir(), this.sessionId, {
        at: new Date().toISOString(),
        scene: observation.scene,
        change: observation.change,
      });
      if (observation.fact) {
        await addMemory(memoryDir(), this.sessionId, `[观察] ${observation.fact}`);
      }
      console.log(
        `[learning] ${this.sessionId.slice(0, 8)} ${observation.scene}${
          observation.fact ? ` / 记住：${observation.fact}` : ""
        }`,
      );
    } catch (error) {
      console.warn("[learning] 观察失败", error instanceof Error ? error.message : String(error));
    } finally {
      this.learning = false;
      if (!this.closed) this.scheduleLearning();
    }
  }

  private clearProactiveTimers(): void {
    if (this.proactiveTimer) clearTimeout(this.proactiveTimer);
    this.proactiveTimer = null;
    if (this.sceneTimer) clearTimeout(this.sceneTimer);
    this.sceneTimer = null;
  }

  /** 安排下一次「安静久了主动开口」，每次对话结束都会重新计时。 */
  private scheduleProactive(delayMs?: number): void {
    if (this.proactiveTimer) {
      clearTimeout(this.proactiveTimer);
      this.proactiveTimer = null;
    }
    const { enabled, idleMinMs, idleMaxMs } = this.config.proactive;
    if (!enabled || this.closed) return;
    const min = Math.max(5000, idleMinMs);
    const max = Math.max(min, idleMaxMs);
    const delay = delayMs ?? min + Math.random() * (max - min);
    this.proactiveTimer = setTimeout(() => {
      this.proactiveTimer = null;
      this.maybeSpeakProactively("idle");
    }, delay);
  }

  /** 画面明显变化后，稍等一下再决定要不要开口，避免刚动一下就插话。 */
  private onSceneChanged(): void {
    const { enabled, minGapMs } = this.config.proactive;
    if (!enabled || this.closed || this.turnId || this.state !== "listening") return;
    if (Date.now() - this.lastProactiveAt < minGapMs) return;
    if (this.sceneTimer) return;
    this.sceneTimer = setTimeout(() => {
      this.sceneTimer = null;
      this.maybeSpeakProactively("scene");
    }, 2500);
  }

  private maybeSpeakProactively(reason: "idle" | "scene"): void {
    const { enabled, minGapMs } = this.config.proactive;
    if (!enabled || this.closed) return;
    if (this.turnId || this.state !== "listening") {
      this.scheduleProactive();
      return;
    }
    const now = Date.now();
    // 用户刚出过声、或者刚主动说过，就先不打扰。
    if (now - this.lastVoiceAt < 4000) {
      this.scheduleProactive();
      return;
    }
    if (now - this.lastProactiveAt < minGapMs) {
      this.scheduleProactive();
      return;
    }
    if (reason === "scene" && !this.latestFrame) return;

    this.lastProactiveAt = now;
    const turnId = randomUUID();
    this.turnId = turnId;
    const abortController = new AbortController();
    this.abortController = abortController;

    const prompt =
      reason === "scene"
        ? "（系统提示：摄像头画面刚刚有明显变化。你可以自然地提一句你注意到的变化，像陪在身边的人随口一说，1~2 句。如果没什么值得说的，只输出 [不回应]。）"
        : "（系统提示：周围安静了一阵，用户没有在跟你说话。你可以主动开口说点什么：一点小情绪、发发牢骚、说说当下的感受，或者轻轻关心对方，1~2 句。如果没话可说，只输出 [不回应]。）";

    this.setState("thinking");
    void this.runTurn(turnId, prompt, abortController, { proactive: true });
  }

  private logLatency(
    turnId: string,
    startedAt: number,
    firstTokenAt: number,
    firstAudioAt: number,
  ): void {
    const end = performance.now();
    const ms = (from: number, to: number) => (from && to ? `${Math.round(to - from)}ms` : "-");
    console.log(
      `[latency] turn=${turnId.slice(0, 8)} 出句→首token=${ms(startedAt, firstTokenAt)} ` +
        `首token→首音频=${ms(firstTokenAt, firstAudioAt)} 出句→首音频=${ms(startedAt, firstAudioAt)} ` +
        `整轮=${Math.round(end - startedAt)}ms`,
    );
  }

  private cancelTurn(reason: "interrupt" | "superseded"): void {
    const turnId = this.turnId;
    if (!turnId) return;
    this.turnId = null;
    this.abortController?.abort();
    this.abortController = null;
    this.tts?.cancel();
    this.tts = null;
    this.transport.sendEvent({ type: "turn.cancelled", turnId, reason });
  }
}
