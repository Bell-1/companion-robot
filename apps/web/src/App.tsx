import { useEffect, useRef, useState } from "react";
import type { AssistantEmotion, ReminderItem, ServerEvent, SessionState } from "@companion/shared";
import { AudioEngine } from "./audio/engine";
import { Avatar } from "./components/Avatar";
import { CompanionClient } from "./lib/client";
import { useCompanionStore } from "./store";
import { VisionCamera } from "./vision/camera";

const STATE_LABEL: Record<SessionState, string> = {
  idle: "待机",
  listening: "聆听中",
  thinking: "思考中",
  speaking: "说话中",
};

const SESSION_KEY = "companion.sessionId";

/** 会话 ID 固定存在本地，刷新或断线重连后仍能延续记忆与环境观察。 */
function loadSessionId(): string {
  const existing = localStorage.getItem(SESSION_KEY);
  if (existing) return existing;
  const id = crypto.randomUUID();
  localStorage.setItem(SESSION_KEY, id);
  return id;
}

/** 提醒时间显示成「今天 18:30 / 明天 08:00 / 11月20日 09:00」。 */
function formatReminderTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "提醒";
  const now = new Date();
  const hhmm = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  if (date.toDateString() === now.toDateString()) return `今天 ${hhmm}`;
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (date.toDateString() === tomorrow.toDateString()) return `明天 ${hhmm}`;
  return `${date.getMonth() + 1}月${date.getDate()}日 ${hhmm}`;
}

/** 上报浏览器定位，供天气等需要地理位置的工具使用；失败时静默降级。 */
function reportLocation(client: CompanionClient): void {
  if (typeof navigator === "undefined" || !navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(
    (position) => {
      client.send({
        type: "client.location",
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        accuracy: position.coords.accuracy || undefined,
      });
    },
    () => {
      // 用户拒绝或定位超时：不打扰对话，服务端会退化为按城市名查询。
    },
    { enableHighAccuracy: false, timeout: 8000, maximumAge: 10 * 60 * 1000 },
  );
}

export default function App() {
  const {
    connection,
    sessionState,
    micOn,
    partial,
    notice,
    messages,
    error,
    setConnection,
    setSessionState,
    setMicOn,
    setPartial,
    setNotice,
    setError,
  } = useCompanionStore();

  const engineRef = useRef<AudioEngine | null>(null);
  const clientRef = useRef<CompanionClient | null>(null);
  const turnRef = useRef<string | null>(null);
  const playingRef = useRef(false);
  const playedAudioRef = useRef(false);
  const lastUserMessageRef = useRef<string | null>(null);
  const sampleRateRef = useRef(24000);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const cameraRef = useRef<VisionCamera | null>(null);
  const visionIntervalRef = useRef(5000);
  const previewRef = useRef<HTMLVideoElement | null>(null);

  /** 助手名称由服务端环境变量决定，前端只负责展示。 */
  const [assistantName, setAssistantName] = useState("");
  const [emotion, setEmotion] = useState<AssistantEmotion>("neutral");
  const [eyeAvailable, setEyeAvailable] = useState(false);
  const [eyeOn, setEyeOn] = useState(false);
  const [eyeInterval, setEyeInterval] = useState(5000);
  const [reminders, setReminders] = useState<ReminderItem[]>([]);
  /** 声纹识别出的当前说话人；没有注册声纹时为空。 */
  const [speaker, setSpeaker] = useState<{ name?: string; matched: boolean } | null>(null);
  const pendingReminders = reminders.filter((item) => item.status === "pending");

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, partial]);

  // 还没开始对话时先从服务端读一次名称，避免界面上出现写死的默认名。
  useEffect(() => {
    let cancelled = false;
    fetch("/health")
      .then((response) => (response.ok ? response.json() : null))
      .then((data: { assistantName?: string } | null) => {
        if (!cancelled && data?.assistantName) setAssistantName(data.assistantName);
      })
      .catch(() => {
        // 读取失败时保持空白，开始对话后 session.ready 会再下发一次。
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    document.title = assistantName ? `${assistantName} · 陪伴机器人` : "陪伴机器人";
  }, [assistantName]);

  useEffect(() => {
    return () => {
      clientRef.current?.dispose();
      void engineRef.current?.stop();
      cameraRef.current?.stop();
    };
  }, []);

  const startCamera = async (intervalMs = visionIntervalRef.current): Promise<void> => {
    if (cameraRef.current) return;
    visionIntervalRef.current = intervalMs;
    const camera = new VisionCamera({
      intervalMs,
      onFrame: (image, changed) =>
        clientRef.current?.send({ type: "vision.frame", image, changed }),
      onStream: (stream) => {
        const video = previewRef.current;
        if (!video) return;
        video.srcObject = stream;
        if (stream) void video.play().catch(() => {});
      },
      onError: (message) => {
        stopCamera();
        setError(`摄像头出错：${message}`);
      },
    });
    cameraRef.current = camera;
    try {
      await camera.start();
      setEyeOn(true);
    } catch (err) {
      cameraRef.current = null;
      setEyeOn(false);
      setError(`无法访问摄像头：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const stopCamera = (): void => {
    cameraRef.current?.stop();
    cameraRef.current = null;
    setEyeOn(false);
  };

  const handleServerEvent = (event: ServerEvent) => {
    const store = useCompanionStore.getState();
    const engine = engineRef.current;
    const client = clientRef.current;

    switch (event.type) {
      case "session.ready":
        store.setSessionState(event.state);
        store.setTtsSampleRate(event.tts.sampleRate);
        sampleRateRef.current = event.tts.sampleRate;
        setAssistantName(event.assistantName);
        setEyeAvailable(event.vision.enabled);
        visionIntervalRef.current = event.vision.intervalMs;
        setEyeInterval(event.vision.intervalMs);
        if (event.vision.enabled && !cameraRef.current) {
          void startCamera(event.vision.intervalMs);
        }
        break;
      case "state":
        store.setSessionState(event.state);
        break;
      case "asr.partial":
        store.setNotice(null);
        store.setPartial(event.text);
        break;
      case "asr.final": {
        const id = `user-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        lastUserMessageRef.current = id;
        store.addMessage({ id, role: "user", text: event.text });
        store.setPartial("");
        store.setNotice(null);
        break;
      }
      case "user.accepted": {
        const id = lastUserMessageRef.current;
        if (id) store.updateMessage(id, event.text);
        store.setPartial("");
        setEmotion("neutral");
        break;
      }
      case "asr.ignored": {
        store.setPartial("");
        // 识别出来的话没有被采用时，明确告诉用户原因，而不是让文字凭空消失。
        const reason =
          event.reason === "echo" ? "像是扬声器回声，已忽略：" : "只是语气词，已忽略：";
        store.setNotice(`${reason}${event.text}`);
        break;
      }
      case "assistant.emotion":
        setEmotion(event.emotion);
        break;
      case "assistant.delta":
        store.appendAssistant(event.turnId, event.text);
        break;
      case "assistant.done":
        store.finalizeAssistant(event.turnId, event.text);
        break;
      case "tts.start":
        turnRef.current = event.turnId;
        playingRef.current = true;
        playedAudioRef.current = false;
        engine?.flush();
        engine?.setMuted(true);
        client?.send({ type: "playback.start", turnId: event.turnId });
        break;
      case "tts.end":
        // 没有任何音频（例如合成失败）时不会有 drained，这里兜底恢复。
        if (!playedAudioRef.current && playingRef.current) {
          playingRef.current = false;
          engine?.setMuted(false);
          const turnId = turnRef.current;
          turnRef.current = null;
          if (turnId) client?.send({ type: "playback.end", turnId });
        }
        break;
      case "turn.cancelled":
        playingRef.current = false;
        engine?.flush();
        engine?.setMuted(false);
        break;
      case "vision.interval":
        visionIntervalRef.current = event.intervalMs;
        setEyeInterval(event.intervalMs);
        cameraRef.current?.setIntervalMs(event.intervalMs);
        break;
      case "vision.capture":
        // 用户刚发消息：立刻抓一帧，让这轮回复对应此刻的画面。
        cameraRef.current?.captureNow();
        break;
      case "reminder.list":
        setReminders(event.items);
        break;
      case "reminder.fired":
        setReminders((items) =>
          items.map((item) => (item.id === event.item.id ? event.item : item)),
        );
        break;
      case "voiceprint.speaker":
        setSpeaker({ matched: event.matched, name: event.name });
        break;
      case "turn.ignored":
        // 环境里的旁人对白，不是对助手说的：保留在列表里当历史日志，只是不回复、不出声。
        lastUserMessageRef.current = null;
        store.setPartial("");
        break;
      case "error":
        store.setError(event.message);
        break;
    }
  };

  const start = async () => {
    if (engineRef.current) return;
    setError(null);
    setSpeaker(null);
    const engine = new AudioEngine();
    try {
      await engine.start();
    } catch (err) {
      setError(`无法访问麦克风：${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    engineRef.current = engine;

    const client = new CompanionClient(
      {
        onEvent: handleServerEvent,
        onAudio: (buffer) => {
          playedAudioRef.current = true;
          engineRef.current?.playChunk(buffer, sampleRateRef.current);
        },
        onStatus: (status) => {
          setConnection(status);
          // 握手完成后才通知开始聆听（session.init 先到）。
          if (status === "open") {
            clientRef.current?.send({ type: "mic.start" });
            if (clientRef.current) reportLocation(clientRef.current);
          }
        },
      },
      loadSessionId(),
    );
    clientRef.current = client;

    engine.handlers = {
      onMicrophone: (chunk) => client.sendAudio(chunk),
      onBargeIn: () => {
        engine.flush();
        client.send({ type: "interrupt" });
      },
      onDrained: () => {
        if (!playingRef.current || !playedAudioRef.current) return;
        playingRef.current = false;
        playedAudioRef.current = false;
        engine.setMuted(false);
        const turnId = turnRef.current;
        turnRef.current = null;
        if (turnId) client.send({ type: "playback.end", turnId });
      },
    };

    client.connect();
    setMicOn(true);
  };

  const stop = async () => {
    stopCamera();
    clientRef.current?.dispose();
    clientRef.current = null;
    await engineRef.current?.stop();
    engineRef.current = null;
    playingRef.current = false;
    turnRef.current = null;
    setMicOn(false);
    setSessionState("idle");
    setConnection("idle");
    setEmotion("neutral");
    setSpeaker(null);
  };

  const interrupt = () => {
    engineRef.current?.flush();
    engineRef.current?.setMuted(false);
    playingRef.current = false;
    clientRef.current?.send({ type: "interrupt" });
  };

  const toggleEye = () => {
    if (eyeOn) stopCamera();
    else void startCamera(visionIntervalRef.current);
  };

  return (
    <div className="app">
      <div className="main">
        <header className="header">
          <div className="brand">
            <span className={`dot dot-${connection === "open" ? "live" : connection}`} />
            <h1>{assistantName || "陪伴机器人"}</h1>
          </div>
          <div className="status">
            {speaker?.matched && speaker.name && (
              <span className="speaker-tag">正在和{speaker.name}对话</span>
            )}
            {micOn ? STATE_LABEL[sessionState] : "未开始"}
          </div>
        </header>

        {error && (
          <div className="banner" onClick={() => setError(null)}>
            {error}
          </div>
        )}

        <main className="chat">
          {messages.length === 0 && (
            <div className="empty">
              <p>点下面的圆钮开始对话。</p>
            </div>
          )}
          {messages.map((message) => (
            <div key={message.id} className={`bubble bubble-${message.role}`}>
              {message.text}
            </div>
          ))}
          {partial && <div className="partial">{partial}</div>}
          {notice && <div className="notice">{notice}</div>}
          <div ref={bottomRef} />
        </main>

        <footer className="footer">
          <div className="controls">
            <button className="ghost" onClick={interrupt} disabled={!micOn}>
              打断
            </button>
            <button className="ghost" onClick={toggleEye} disabled={!micOn || !eyeAvailable}>
              {eyeOn ? "眼睛 开" : "眼睛 关"}
            </button>
            <button
              className={`mic ${micOn ? "mic-on" : ""}`}
              onClick={() => (micOn ? void stop() : void start())}
              aria-label={micOn ? "结束对话" : "开始对话"}
            >
              <span className="mic-inner" />
            </button>
            <div className="spacer" />
          </div>
          <p className="tip">
            {micOn
              ? eyeOn
                ? `直接说话即可，眼睛每 ${Math.round(eyeInterval / 1000)} 秒看一次。`
                : "直接说话即可，我会在你说完后回应。"
              : "首次使用需要允许麦克风和摄像头权限。"}
          </p>
        </footer>
      </div>

      <aside className="stage">
        <div className={`stage-avatar ${micOn ? "is-live" : ""}`}>
          <Avatar
            name={assistantName || "陪伴机器人"}
            emotion={emotion}
            state={micOn ? sessionState : "idle"}
          />
          <div className="stage-caption">
            <strong>{assistantName || "陪伴机器人"}</strong>
            <span>{micOn ? STATE_LABEL[sessionState] : "未开始"}</span>
          </div>
        </div>

        <div className={`stage-camera ${eyeOn ? "on" : ""}`}>
          <video ref={previewRef} autoPlay muted playsInline />
          {!eyeOn && <span className="stage-camera-off">眼睛关闭</span>}
        </div>

        <div className="stage-reminders">
          <div className="stage-reminders-title">提醒 · 待办</div>
          {pendingReminders.length === 0 ? (
            <p className="stage-reminders-empty">还没有</p>
          ) : (
            <ul>
              {pendingReminders.map((item) => (
                <li key={item.id}>
                  <span className="reminder-time">
                    {item.dueAt ? formatReminderTime(item.dueAt) : "待办"}
                  </span>
                  <span className="reminder-text">{item.text}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>
    </div>
  );
}
