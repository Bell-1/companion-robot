import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { safeSessionId } from "../tools/paths";
import { cosineSimilarity, normalizeEmbedding } from "./model";

/** 单个会话最多记住几个人、每个人保留几个声音样本。 */
export const MAX_VOICEPRINTS = 10;
export const MAX_VOICE_SAMPLES = 3;
export const MAX_VOICE_NAME_CHARS = 20;

export interface VoiceprintProfile {
  id: string;
  name: string;
  /** 同一个人可以有多段注册音频，识别时取最相似的一段。 */
  embeddings: number[][];
  createdAt: string;
  updatedAt?: string;
}

export interface VoiceprintMatch {
  profile: VoiceprintProfile;
  score: number;
}

export function voiceprintDir(dataDir: string): string {
  return path.join(dataDir, "voiceprints");
}

function profileFile(dir: string, sessionId: string): string {
  return path.join(dir, `${safeSessionId(sessionId)}.json`);
}

/** 声纹按会话落盘；文件损坏时当作没有注册过。 */
export async function readVoiceprints(
  dir: string,
  sessionId: string,
): Promise<VoiceprintProfile[]> {
  try {
    const raw = await readFile(profileFile(dir, sessionId), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const profiles: VoiceprintProfile[] = [];
    for (const entry of parsed) {
      if (!entry || typeof entry !== "object") continue;
      const profile = entry as Partial<VoiceprintProfile>;
      if (typeof profile.id !== "string" || typeof profile.name !== "string") continue;
      if (!Array.isArray(profile.embeddings)) continue;
      const embeddings = profile.embeddings.filter(
        (embedding): embedding is number[] =>
          Array.isArray(embedding) && embedding.every((value) => typeof value === "number"),
      );
      if (embeddings.length === 0) continue;
      profiles.push({
        id: profile.id,
        name: profile.name,
        embeddings,
        createdAt:
          typeof profile.createdAt === "string" ? profile.createdAt : new Date(0).toISOString(),
        updatedAt: typeof profile.updatedAt === "string" ? profile.updatedAt : undefined,
      });
    }
    return profiles;
  } catch {
    return [];
  }
}

async function saveVoiceprints(
  dir: string,
  sessionId: string,
  profiles: VoiceprintProfile[],
): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(profileFile(dir, sessionId), JSON.stringify(profiles, null, 2), "utf8");
}

/** 注册或补充一个人的声音；同名时追加样本，超过上限时保留最近的几段。 */
export async function enrollVoiceprint(
  dir: string,
  sessionId: string,
  name: string,
  embedding: ArrayLike<number>,
): Promise<{ profile: VoiceprintProfile; isNew: boolean }> {
  const trimmed = name.trim().slice(0, MAX_VOICE_NAME_CHARS);
  if (!trimmed) throw new Error("请告诉我该叫你什么");
  const values = Array.from(normalizeEmbedding(embedding));
  const profiles = await readVoiceprints(dir, sessionId);
  const now = new Date().toISOString();

  const existing = profiles.find(
    (profile) => profile.id === trimmed || profile.name.toLowerCase() === trimmed.toLowerCase(),
  );
  if (existing) {
    const duplicate = existing.embeddings.some(
      (sample) => cosineSimilarity(sample, values) >= 0.995,
    );
    if (!duplicate) {
      existing.embeddings = [...existing.embeddings, values].slice(-MAX_VOICE_SAMPLES);
    }
    existing.updatedAt = now;
    await saveVoiceprints(dir, sessionId, profiles);
    return { profile: existing, isNew: false };
  }

  if (profiles.length >= MAX_VOICEPRINTS) {
    throw new Error(`这个会话最多只能记住 ${MAX_VOICEPRINTS} 个人的声音`);
  }
  const profile: VoiceprintProfile = {
    id: randomUUID().slice(0, 8),
    name: trimmed,
    embeddings: [values],
    createdAt: now,
  };
  await saveVoiceprints(dir, sessionId, [...profiles, profile]);
  return { profile, isNew: true };
}

export async function removeVoiceprint(
  dir: string,
  sessionId: string,
  nameOrId: string,
): Promise<boolean> {
  const key = nameOrId.trim().toLowerCase();
  if (!key) return false;
  const profiles = await readVoiceprints(dir, sessionId);
  const next = profiles.filter(
    (profile) => profile.id !== key && profile.name.toLowerCase() !== key,
  );
  if (next.length === profiles.length) return false;
  await saveVoiceprints(dir, sessionId, next);
  return true;
}

/**
 * 在每个注册人里取「最像的一段样本」和「样本均值向量」中更高的分数，
 * 再把不同人按分数排序。低于阈值视为陌生人；
 * 第一名与第二名差距太小则视为分不清，宁可当作陌生人也不猜错。
 */
export function identifyVoiceprint(
  profiles: VoiceprintProfile[],
  embedding: ArrayLike<number>,
  threshold: number,
): VoiceprintMatch | null {
  const ranked: VoiceprintMatch[] = [];
  for (const profile of profiles) {
    let bestSample = -1;
    for (const sample of profile.embeddings) {
      const score = cosineSimilarity(sample, embedding);
      if (score > bestSample) bestSample = score;
    }
    // 多段样本取平均后再比一次，能抵消单段录音的偶然噪声。
    const meanScore = cosineSimilarity(meanEmbedding(profile.embeddings), embedding);
    ranked.push({ profile, score: Math.max(bestSample, meanScore) });
  }
  ranked.sort((a, b) => b.score - a.score);

  const top = ranked[0];
  if (!top || top.score < threshold) return null;
  const second = ranked[1];
  if (second && top.score - second.score < 0.02) return null;
  return top;
}

/** 把同一个人的多段归一化向量取平均并重新归一化。 */
function meanEmbedding(embeddings: number[][]): Float32Array {
  const dim = embeddings[0]?.length ?? 0;
  const sum = new Float32Array(dim);
  for (const sample of embeddings) {
    for (let i = 0; i < dim; i += 1) sum[i] = (sum[i] ?? 0) + (sample[i] ?? 0);
  }
  let norm = 0;
  for (let i = 0; i < dim; i += 1) norm += sum[i]! * sum[i]!;
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < dim; i += 1) sum[i] = sum[i]! / norm;
  }
  return sum;
}
