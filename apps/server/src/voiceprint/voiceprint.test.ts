import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { cosineSimilarity, normalizeEmbedding, pcm16ToFloat, trimSilence } from "./model";
import {
  enrollVoiceprint,
  identifyVoiceprint,
  MAX_VOICE_SAMPLES,
  readVoiceprints,
  removeVoiceprint,
  voiceprintDir,
} from "./store";

async function withDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "companion-voiceprint-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** 生成一段带静音的正弦波，模拟一句话。 */
function toneWithSilence(silenceSec: number, toneSec: number): Float32Array {
  const rate = 16000;
  const total = Math.round(rate * (silenceSec * 2 + toneSec));
  const samples = new Float32Array(total);
  const start = Math.round(rate * silenceSec);
  const end = start + Math.round(rate * toneSec);
  for (let i = start; i < end; i += 1) {
    samples[i] = Math.sin((2 * Math.PI * 440 * (i - start)) / rate) * 0.1;
  }
  return samples;
}

test("声纹：PCM16 转浮点", () => {
  const pcm = Buffer.alloc(4);
  pcm.writeInt16LE(16384, 0);
  pcm.writeInt16LE(-32768, 2);
  const samples = pcm16ToFloat(pcm);
  assert.equal(samples.length, 2);
  assert.ok(Math.abs(samples[0]! - 0.5) < 1e-4);
  assert.equal(samples[1], -1);
});

test("声纹：裁掉首尾静音，只保留说话部分", () => {
  const samples = toneWithSilence(1, 2);
  const voiced = trimSilence(samples);
  assert.ok(voiced);
  const seconds = voiced.length / 16000;
  assert.ok(seconds >= 2 && seconds <= 2.4, `实际 ${seconds}`);
});

test("声纹：有效语音太短时返回 null", () => {
  assert.equal(trimSilence(toneWithSilence(0.5, 0.3)), null);
  assert.equal(trimSilence(new Float32Array(16000)), null);
});

test("声纹：余弦相似度与归一化", () => {
  assert.ok(Math.abs(cosineSimilarity([1, 0], [1, 0]) - 1) < 1e-6);
  assert.ok(Math.abs(cosineSimilarity([1, 0], [0, 1])) < 1e-6);

  const normalized = normalizeEmbedding([3, 4]);
  assert.ok(Math.abs(normalized[0]! - 0.6) < 1e-6);
  assert.ok(Math.abs(normalized[1]! - 0.8) < 1e-6);
});

test("声纹：注册、识别与陌生人拒绝", async () => {
  await withDir(async (dataDir) => {
    const dir = voiceprintDir(dataDir);
    const { profile, isNew } = await enrollVoiceprint(dir, "s1", "小明", [1, 0, 0, 0]);
    assert.equal(isNew, true);
    assert.equal(profile.name, "小明");

    const profiles = await readVoiceprints(dir, "s1");
    const match = identifyVoiceprint(profiles, normalizeEmbedding([0.95, 0.1, 0, 0]), 0.6);
    assert.equal(match?.profile.name, "小明");
    assert.ok((match?.score ?? 0) > 0.9);

    assert.equal(identifyVoiceprint(profiles, normalizeEmbedding([0, 1, 0, 0]), 0.6), null);
  });
});

test("声纹：同名追加样本，最多保留三段", async () => {
  await withDir(async (dataDir) => {
    const dir = voiceprintDir(dataDir);
    await enrollVoiceprint(dir, "s1", "Alice", [1, 0, 0, 0]);
    const second = await enrollVoiceprint(dir, "s1", "alice", [0, 1, 0, 0]);
    assert.equal(second.isNew, false);
    assert.equal(second.profile.embeddings.length, 2);

    await enrollVoiceprint(dir, "s1", "ALICE", [0, 0, 1, 0]);
    await enrollVoiceprint(dir, "s1", "Alice", [0, 0, 0, 1]);
    const profiles = await readVoiceprints(dir, "s1");
    assert.equal(profiles.length, 1);
    assert.equal(profiles[0]?.embeddings.length, MAX_VOICE_SAMPLES);
  });
});

test("声纹：多段样本取均值，抵抗单段噪声", async () => {
  await withDir(async (dataDir) => {
    const dir = voiceprintDir(dataDir);
    await enrollVoiceprint(dir, "s1", "小明", [1, 0, 0, 0]);
    await enrollVoiceprint(dir, "s1", "小明", [0, 1, 0, 0]);
    const profiles = await readVoiceprints(dir, "s1");
    // 真实声音落在两段样本中间：均值分数明显高于任何单段。
    const match = identifyVoiceprint(profiles, normalizeEmbedding([0.6, 0.8, 0, 0]), 0.6);
    assert.equal(match?.profile.name, "小明");
    assert.ok((match?.score ?? 0) > 0.98, `实际 ${match?.score}`);
  });
});

test("声纹：两人分数太接近时判定为不确定，不猜名字", async () => {
  await withDir(async (dataDir) => {
    const dir = voiceprintDir(dataDir);
    await enrollVoiceprint(dir, "s1", "小明", [1, 0, 0, 0]);
    await enrollVoiceprint(dir, "s1", "小红", [1, 0.05, 0, 0]);
    const profiles = await readVoiceprints(dir, "s1");
    assert.equal(identifyVoiceprint(profiles, normalizeEmbedding([1, 0.02, 0, 0]), 0.6), null);
  });
});

test("声纹：按名字删除", async () => {
  await withDir(async (dataDir) => {
    const dir = voiceprintDir(dataDir);
    await enrollVoiceprint(dir, "s1", "小明", [1, 0, 0, 0]);
    assert.equal(await removeVoiceprint(dir, "s1", "小明"), true);
    assert.equal(await removeVoiceprint(dir, "s1", "小明"), false);
    assert.equal((await readVoiceprints(dir, "s1")).length, 0);
  });
});
