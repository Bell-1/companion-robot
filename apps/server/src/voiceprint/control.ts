/** 会话把「刚说完的这一句」暴露给声纹工具与识别流程。 */
export interface UtteranceAudio {
  audio: Buffer;
  at: number;
}

export type UtteranceProvider = () => UtteranceAudio | null;

const providers = new Map<string, UtteranceProvider>();

export function registerUtteranceProvider(sessionId: string, provider: UtteranceProvider): void {
  providers.set(sessionId, provider);
}

export function unregisterUtteranceProvider(sessionId: string): void {
  providers.delete(sessionId);
}

/** 取最近一句用户语音；超过 maxAgeMs 视为过期（比如用户改成打字输入）。 */
export function getLastUtterance(sessionId: string, maxAgeMs = 15000): UtteranceAudio | null {
  const provider = providers.get(sessionId);
  if (!provider) return null;
  const utterance = provider();
  if (!utterance) return null;
  return Date.now() - utterance.at <= maxAgeMs ? utterance : null;
}
