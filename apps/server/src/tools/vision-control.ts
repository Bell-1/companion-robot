/**
 * 会话级的「观察频率」控制器注册表。
 * 工具与语音会话由不同的对象创建，这里用 sessionId 做桥接：
 * 模型调用 set_look_interval 时，直接改对应会话的抓帧节奏并通知前端。
 */

export type VisionIntervalController = (intervalMs: number) => boolean;

const controllers = new Map<string, VisionIntervalController>();

export function registerVisionController(
  sessionId: string,
  controller: VisionIntervalController,
): void {
  controllers.set(sessionId, controller);
}

export function unregisterVisionController(sessionId: string): void {
  controllers.delete(sessionId);
}

/** 返回 false 表示当前会话没有开摄像头，频率未生效。 */
export function setVisionInterval(sessionId: string, intervalMs: number): boolean {
  const controller = controllers.get(sessionId);
  return controller ? controller(intervalMs) : false;
}

/** 抓帧间隔的安全范围：2 秒 ~ 120 秒。 */
export const MIN_VISION_INTERVAL_MS = 2000;
export const MAX_VISION_INTERVAL_MS = 120000;

export function clampVisionInterval(intervalMs: number): number {
  if (!Number.isFinite(intervalMs)) return MIN_VISION_INTERVAL_MS;
  return Math.min(MAX_VISION_INTERVAL_MS, Math.max(MIN_VISION_INTERVAL_MS, Math.round(intervalMs)));
}

/** 会话当前可用的摄像头画面。 */
export interface VisionFrame {
  image: string;
  at: number;
}

export type VisionFrameProvider = () => VisionFrame | null;

const frameProviders = new Map<string, VisionFrameProvider>();

/** 会话把「取最新一帧」暴露给工具，模型可主动细看画面。 */
export function registerVisionFrameProvider(
  sessionId: string,
  provider: VisionFrameProvider,
): void {
  frameProviders.set(sessionId, provider);
}

export function unregisterVisionFrameProvider(sessionId: string): void {
  frameProviders.delete(sessionId);
}

/** 没有开摄像头或画面太旧时返回 null。 */
export function getVisionFrame(sessionId: string): VisionFrame | null {
  const provider = frameProviders.get(sessionId);
  return provider ? provider() : null;
}
