/** 生成指定时长的静音 PCM，供播放期间保持 ASR 连接使用。 */
export function pcmSilence(ms: number, sampleRate: number): Buffer {
  const samples = Math.round((ms / 1000) * sampleRate);
  return Buffer.alloc(samples * 2);
}

export function isPcm16Silent(chunk: Buffer): boolean {
  for (let i = 0; i + 1 < chunk.length; i += 2) {
    if (chunk.readInt16LE(i) !== 0) return false;
  }
  return true;
}
