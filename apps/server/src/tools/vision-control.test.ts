import assert from "node:assert/strict";
import test from "node:test";
import {
  clampVisionInterval,
  getVisionFrame,
  MAX_VISION_INTERVAL_MS,
  MIN_VISION_INTERVAL_MS,
  registerVisionController,
  registerVisionFrameProvider,
  setVisionInterval,
  unregisterVisionController,
  unregisterVisionFrameProvider,
} from "./vision-control";

test("观察频率：限制在 2 秒到 120 秒之间", () => {
  assert.equal(clampVisionInterval(5000), 5000);
  assert.equal(clampVisionInterval(100), MIN_VISION_INTERVAL_MS);
  assert.equal(clampVisionInterval(999_999), MAX_VISION_INTERVAL_MS);
  assert.equal(clampVisionInterval(Number.NaN), MIN_VISION_INTERVAL_MS);
});

test("观察频率：按会话分发给对应控制器", () => {
  const received: number[] = [];
  registerVisionController("session-a", (ms) => {
    received.push(ms);
    return true;
  });

  assert.equal(setVisionInterval("session-a", 20000), true);
  assert.deepEqual(received, [20000]);
  assert.equal(setVisionInterval("session-b", 20000), false);

  unregisterVisionController("session-a");
  assert.equal(setVisionInterval("session-a", 30000), false);
});

test("画面：按会话提供最新一帧，没有画面时返回 null", () => {
  registerVisionFrameProvider("session-frame", () => ({ image: "jpeg", at: 123 }));
  assert.deepEqual(getVisionFrame("session-frame"), { image: "jpeg", at: 123 });
  assert.equal(getVisionFrame("session-other"), null);

  unregisterVisionFrameProvider("session-frame");
  assert.equal(getVisionFrame("session-frame"), null);
});
