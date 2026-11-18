import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isFillerUtterance,
  isLikelyEcho,
  isNoReplyTag,
  parseEmotionTag,
  SentenceChunker,
} from "./text";

test("回声判定：与上一条回复高度相似时认为可能是回声", () => {
  const assistant = "当然可以呀，我就在这儿呢。想说说是什么事让你心情不好吗？";
  assert.equal(isLikelyEcho("我就在这儿呢", assistant), true);
  assert.equal(isLikelyEcho("想说说是什么事让你心情不好吗", assistant), true);
  assert.equal(isLikelyEcho("今天天气怎么样", assistant), false);
});

test("回声判定：太短的句子不参与判定，避免误伤", () => {
  assert.equal(isLikelyEcho("好的", "好的，我知道了"), false);
});

test("分句：第一句满 10 字遇到逗号就切，尽早开始合成", () => {
  const chunker = new SentenceChunker();
  assert.deepEqual(chunker.push("当然可以我就在这儿陪着你，"), ["当然可以我就在这儿陪着你，"]);
});

test("分句：后续句子需要满 18 字才在逗号处切分", () => {
  const chunker = new SentenceChunker();
  chunker.push("你好呀，"); // 第一句，逗号在 4 字处不切
  chunker.push("。"); // 句末标点，切出第一句
  assert.deepEqual(chunker.push("今天天气不错我们出去走走吧，"), []);
  assert.deepEqual(chunker.push("我觉得挺好的呀。"), [
    "今天天气不错我们出去走走吧，我觉得挺好的呀。",
  ]);
});

test("分句：句末标点立即切分，剩余内容留在缓冲区", () => {
  const chunker = new SentenceChunker();
  assert.deepEqual(chunker.push("你好呀。今天想"), ["你好呀。"]);
  assert.equal(chunker.flush(), "今天想");
});

test("分句：超长无标点时强制切分", () => {
  const chunker = new SentenceChunker();
  const longText = "啊".repeat(60);
  const chunks = chunker.push(longText);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0]!.length, 48);
});

test("分句：flush 后不残留", () => {
  const chunker = new SentenceChunker();
  chunker.push("没有结束标点的内容");
  assert.equal(chunker.flush(), "没有结束标点的内容");
  assert.equal(chunker.flush(), "");
});

test("语气词：嗯/啊/嗯嗯/哈哈哈 不触发回复", () => {
  for (const text of ["嗯", "啊？", "哦哦", "嗯嗯嗯", "哈哈哈哈", "呃……"]) {
    assert.equal(isFillerUtterance(text), true, text);
  }
  for (const text of ["好的", "今天天气怎么样", "我不想说", "谢谢"]) {
    assert.equal(isFillerUtterance(text), false, text);
  }
});

test("情绪标记：解析开头标记并剥掉", () => {
  assert.deepEqual(parseEmotionTag("[开心]今天天气真好！"), {
    emotion: "happy",
    text: "今天天气真好！",
  });
  assert.deepEqual(parseEmotionTag("【委屈】你怎么才来呀"), {
    emotion: "sad",
    text: "你怎么才来呀",
  });
  assert.deepEqual(parseEmotionTag("[关心] 最近睡得好吗"), {
    emotion: "caring",
    text: "最近睡得好吗",
  });
});

test("情绪标记：没有标记或标记不合法时返回 null", () => {
  assert.equal(parseEmotionTag("今天天气不错"), null);
  assert.equal(parseEmotionTag("[坏笑]被我发现了吧"), null);
  assert.equal(parseEmotionTag("["), null);
});

test("静默标记：识别 [不回应] 及其变体", () => {
  assert.equal(isNoReplyTag("[不回应]"), true);
  assert.equal(isNoReplyTag("【不回应】"), true);
  assert.equal(isNoReplyTag("  [不回应]今天天气"), true);
  assert.equal(isNoReplyTag("不回应"), false);
  assert.equal(isNoReplyTag("[中性]我在"), false);
});
