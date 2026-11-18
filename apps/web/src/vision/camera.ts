/** 摄像头「眼睛」：按固定间隔抓一帧 JPEG，交给服务端做视觉理解。 */

export interface VisionCameraOptions {
  intervalMs: number;
  /** changed 表示这一帧跟上一帧的明暗分布差别明显，可用于判断环境变化。 */
  onFrame: (imageBase64: string, changed: boolean) => void;
  onError: (message: string) => void;
  /** 把实时流交给界面做预览，null 表示摄像头已关闭。 */
  onStream?: (stream: MediaStream | null) => void;
}

export class VisionCamera {
  private stream: MediaStream | null = null;
  private video: HTMLVideoElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  /** 8x8 灰度图的感知哈希，用来判断画面是否明显变化。 */
  private hashCanvas: HTMLCanvasElement | null = null;
  private lastHash: [number, number] | null = null;

  constructor(private readonly options: VisionCameraOptions) {}

  async start(): Promise<void> {
    if (this.running) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("当前浏览器不支持摄像头，或页面不是 HTTPS");
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
    });

    const video = document.createElement("video");
    video.playsInline = true;
    video.muted = true;
    video.srcObject = stream;
    // iOS Safari 对不在文档里的 video 可能不解码帧，放到屏幕外挂着。
    video.style.position = "fixed";
    video.style.left = "-10px";
    video.style.bottom = "-10px";
    video.style.width = "1px";
    video.style.height = "1px";
    video.style.opacity = "0";
    video.style.pointerEvents = "none";
    document.body.appendChild(video);
    try {
      await video.play();
    } catch {
      // Safari 偶尔拒绝自动播放，画面仍在解码，后续 capture 会重试。
    }

    this.stream = stream;
    this.video = video;
    this.options.onStream?.(stream);
    this.canvas = document.createElement("canvas");
    this.hashCanvas = document.createElement("canvas");
    this.hashCanvas.width = 8;
    this.hashCanvas.height = 8;
    this.lastHash = null;
    this.running = true;

    // 先立刻抓一帧，让「看看这个」不必等下一次定时。
    this.capture();
    this.schedule();
  }

  /** 按当前的间隔安排下一次抓帧（一次性定时，不固定轮询）。 */
  private schedule(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    if (!this.running) return;
    this.timer = setTimeout(
      () => {
        this.capture();
        this.schedule();
      },
      Math.max(1000, this.options.intervalMs),
    );
  }

  /** 服务端要求「此刻」的画面时立即抓一帧，并重新计算下一次抓帧时间。 */
  captureNow(): void {
    if (!this.running) return;
    this.capture();
    this.schedule();
  }

  /** 更新下一次抓帧的间隔：由模型在回复里决定，不再固定轮询。 */
  setIntervalMs(intervalMs: number): void {
    this.options.intervalMs = Math.max(1000, intervalMs);
    if (!this.running) return;
    this.schedule();
  }

  stop(): void {
    this.running = false;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.options.onStream?.(null);
    if (this.video) {
      this.video.srcObject = null;
      this.video.remove();
    }
    this.video = null;
    this.canvas = null;
    this.hashCanvas = null;
    this.lastHash = null;
  }

  private capture(): void {
    if (!this.running) return;
    const video = this.video;
    const canvas = this.canvas;
    if (!video || !canvas || video.readyState < 2 || !video.videoWidth) return;

    const width = 640;
    const height = Math.max(1, Math.round((video.videoHeight / video.videoWidth) * width));
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.drawImage(video, 0, 0, width, height);
    const changed = this.detectChange(video);

    try {
      const base64 = canvas.toDataURL("image/jpeg", 0.7).split(",")[1];
      if (base64) this.options.onFrame(base64, changed);
    } catch (error) {
      this.options.onError(error instanceof Error ? error.message : String(error));
    }
  }

  /** 8x8 灰度均值哈希：汉明距离超过阈值就认为环境有明显变化。 */
  private detectChange(video: HTMLVideoElement): boolean {
    const canvas = this.hashCanvas;
    if (!canvas) return false;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return false;
    context.drawImage(video, 0, 0, 8, 8);
    const { data } = context.getImageData(0, 0, 8, 8);
    const gray: number[] = [];
    for (let i = 0; i < data.length; i += 4) {
      gray.push(data[i]! * 0.299 + data[i + 1]! * 0.587 + data[i + 2]! * 0.114);
    }
    const average = gray.reduce((sum, value) => sum + value, 0) / gray.length;
    let high = 0;
    let low = 0;
    for (let i = 0; i < 64; i += 1) {
      const bit = gray[i]! > average ? 1 : 0;
      if (i < 32) high = (high << 1) | bit;
      else low = (low << 1) | bit;
    }

    const previous = this.lastHash;
    this.lastHash = [high, low];
    if (!previous) return false;
    return popcount(high ^ previous[0]) + popcount(low ^ previous[1]) >= 12;
  }
}

function popcount(value: number): number {
  let count = 0;
  let remaining = value >>> 0;
  while (remaining) {
    remaining &= remaining - 1;
    count += 1;
  }
  return count;
}
