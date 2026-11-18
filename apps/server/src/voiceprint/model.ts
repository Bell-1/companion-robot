import { existsSync } from "node:fs";
import { createRequire } from "node:module";

/** 声纹提取所需的最小有效语音时长（毫秒）。 */
const MIN_VOICED_MS = 800;
const FRAME_MS = 20;
/** 低于这个 RMS 视为静音，用来裁掉句子首尾。 */
const SILENCE_RMS = 0.012;

interface EmbeddingStream {
  acceptWaveform(input: { sampleRate: number; samples: Float32Array }): void;
}

interface EmbeddingExtractor {
  readonly dim: number;
  createStream(): EmbeddingStream;
  compute(stream: EmbeddingStream): Float32Array;
}

interface SherpaModule {
  SpeakerEmbeddingExtractor: new (config: {
    model: string;
    numThreads: number;
    debug: boolean;
  }) => EmbeddingExtractor;
}

const require = createRequire(import.meta.url);

let sherpa: SherpaModule | null = null;
let extractor: EmbeddingExtractor | null = null;
let loadedModelPath = "";
let loadError = "";

function loadSherpa(): SherpaModule | null {
  if (sherpa) return sherpa;
  try {
    sherpa = require("sherpa-onnx-node") as SherpaModule;
    return sherpa;
  } catch (error) {
    loadError = `加载本地声纹运行时失败：${error instanceof Error ? error.message : String(error)}`;
    return null;
  }
}

/** 懒加载声纹模型；模型缺失或运行时不可用时返回 false，不影响正常对话。 */
export function initVoiceprint(modelPath: string): boolean {
  if (extractor && loadedModelPath === modelPath) return true;
  loadError = "";
  if (!existsSync(modelPath)) {
    loadError = `声纹模型不存在：${modelPath}`;
    return false;
  }
  const module = loadSherpa();
  if (!module) return false;
  try {
    extractor = new module.SpeakerEmbeddingExtractor({
      model: modelPath,
      numThreads: 1,
      debug: false,
    });
    loadedModelPath = modelPath;
    return true;
  } catch (error) {
    extractor = null;
    loadError = `声纹模型加载失败：${error instanceof Error ? error.message : String(error)}`;
    return false;
  }
}

export function voiceprintLoadError(): string {
  return loadError;
}

/** 16k 单声道 PCM16 → [-1, 1] 浮点采样。 */
export function pcm16ToFloat(pcm: Buffer): Float32Array {
  const count = Math.floor(pcm.length / 2);
  const samples = new Float32Array(count);
  for (let i = 0; i < count; i += 1) {
    samples[i] = pcm.readInt16LE(i * 2) / 32768;
  }
  return samples;
}

/**
 * 裁掉首尾静音，只保留真正说话的部分。
 * 有效语音不足时返回 null，交给上层提示用户多说一句。
 */
export function trimSilence(
  samples: Float32Array,
  sampleRate = 16000,
  minVoicedMs = MIN_VOICED_MS,
): Float32Array | null {
  const frame = Math.round((sampleRate * FRAME_MS) / 1000);
  if (frame <= 0 || samples.length < frame) return null;

  let first = -1;
  let last = -1;
  for (let start = 0; start + frame <= samples.length; start += frame) {
    let energy = 0;
    for (let i = start; i < start + frame; i += 1) energy += samples[i]! * samples[i]!;
    if (Math.sqrt(energy / frame) >= SILENCE_RMS) {
      if (first < 0) first = start;
      last = start + frame;
    }
  }
  if (first < 0 || last <= first) return null;

  const voicedMs = ((last - first) / sampleRate) * 1000;
  if (voicedMs < minVoicedMs) return null;

  // 前后各留 150ms，避免把字头字尾的辅音削掉。
  const pad = Math.round(sampleRate * 0.15);
  const from = Math.max(0, first - pad);
  const to = Math.min(samples.length, last + pad);
  return samples.subarray(from, to);
}

export function normalizeEmbedding(embedding: ArrayLike<number>): Float32Array {
  const output = Float32Array.from(embedding);
  let norm = 0;
  for (let i = 0; i < output.length; i += 1) norm += output[i]! * output[i]!;
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < output.length; i += 1) output[i] = output[i]! / norm;
  }
  return output;
}

export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const length = Math.min(a.length, b.length);
  if (length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < length; i += 1) {
    const left = a[i]!;
    const right = b[i]!;
    dot += left * right;
    normA += left * left;
    normB += right * right;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / Math.sqrt(normA * normB);
}

export interface ExtractOptions {
  modelPath: string;
  sampleRate?: number;
}

/** 从一段 16k PCM 里提取归一化的说话人向量；音频太短或模型不可用时返回 null。 */
export function extractEmbedding(pcm: Buffer, options: ExtractOptions): Float32Array | null {
  if (!initVoiceprint(options.modelPath) || !extractor) return null;
  const sampleRate = options.sampleRate ?? 16000;
  const voiced = trimSilence(pcm16ToFloat(pcm), sampleRate);
  if (!voiced) return null;
  try {
    const stream = extractor.createStream();
    stream.acceptWaveform({ sampleRate, samples: voiced });
    return normalizeEmbedding(extractor.compute(stream));
  } catch {
    return null;
  }
}
