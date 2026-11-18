import type { ClientEvent, ServerEvent } from "@companion/shared";

export interface ClientHandlers {
  onEvent: (event: ServerEvent) => void;
  onAudio: (buffer: ArrayBuffer) => void;
  onStatus: (status: "connecting" | "open" | "closed") => void;
}

function resolveUrl(): string {
  const configured = import.meta.env.VITE_WS_URL;
  if (configured) return configured;
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  return `${protocol}://${window.location.host}/ws`;
}

/** 与后端保持长连接；断线后自动重连并重新初始化会话。 */
export class CompanionClient {
  private ws: WebSocket | null = null;
  private timer: number | null = null;
  private disposed = false;

  constructor(
    private readonly handlers: ClientHandlers,
    /** 固定会话 ID，保证刷新/重连后记忆与观察记录还能对上。 */
    private readonly sessionId?: string,
  ) {}

  connect(): void {
    if (this.disposed || this.ws) return;
    this.handlers.onStatus("connecting");
    const ws = new WebSocket(resolveUrl());
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.onopen = () => {
      this.handlers.onStatus("open");
      this.send({ type: "session.init", sessionId: this.sessionId });
    };
    ws.onmessage = (event) => {
      if (typeof event.data === "string") {
        try {
          this.handlers.onEvent(JSON.parse(event.data) as ServerEvent);
        } catch {
          // 忽略非法消息
        }
        return;
      }
      this.handlers.onAudio(event.data as ArrayBuffer);
    };
    ws.onclose = () => {
      this.ws = null;
      this.handlers.onStatus("closed");
      if (!this.disposed) {
        this.timer = window.setTimeout(() => this.connect(), 1500);
      }
    };
    ws.onerror = () => ws.close();
  }

  send(event: ClientEvent): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(event));
  }

  sendAudio(buffer: ArrayBuffer): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(buffer);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.ws?.close();
    this.ws = null;
  }
}
