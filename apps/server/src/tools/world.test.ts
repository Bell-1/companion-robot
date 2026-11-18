import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseObservation } from "../agent/agent";
import { appendObservation, formatWorldDigest, MAX_OBSERVATIONS, readObservations } from "./world";

test("环境观察：追加后可读回，并按数量上限裁剪", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "companion-world-"));
  try {
    for (let i = 0; i < MAX_OBSERVATIONS + 5; i += 1) {
      await appendObservation(dir, "session-a", {
        at: new Date(2026, 0, 1, 10, i).toISOString(),
        scene: `场景${i}`,
      });
    }
    const items = await readObservations(dir, "session-a");
    assert.equal(items.length, MAX_OBSERVATIONS);
    assert.equal(items[items.length - 1]!.scene, `场景${MAX_OBSERVATIONS + 4}`);
    assert.deepEqual(await readObservations(dir, "session-b"), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("环境观察：摘要只取最近几条，包含变化", () => {
  const digest = formatWorldDigest([
    { at: "2026-11-17T10:00:00.000Z", scene: "书桌，有咖啡杯" },
    { at: "2026-11-17T10:10:00.000Z", scene: "客厅，灯开着", change: "换到了客厅" },
  ]);
  assert.match(digest, /书桌，有咖啡杯/);
  assert.match(digest, /换到了客厅/);
});

test("观察解析：正常 JSON、带说明文字、纯文本兜底", () => {
  const parsed = parseObservation(
    '好的：{"scene":"桌上有咖啡杯","change":"杯子变多了","fact":"用户常喝美式"}',
  );
  assert.equal(parsed.scene, "桌上有咖啡杯");
  assert.equal(parsed.change, "杯子变多了");
  assert.equal(parsed.fact, "用户常喝美式");

  assert.equal(parseObservation("画面很暗").scene, "画面很暗");
  assert.equal(parseObservation("").scene, "");
});
