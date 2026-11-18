import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  addMemory,
  forgetMemory,
  formatMemoryDigest,
  inferMemoryKind,
  rankMemories,
  readMemories,
  searchMemories,
  selectMemoriesForContext,
} from "./memory";

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "companion-memory-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("记忆：新增后落盘可读回，重复内容不重复记", async () => {
  await withDir(async (dir) => {
    const first = await addMemory(dir, "s1", "用户喜欢喝美式");
    const again = await addMemory(dir, "s1", "用户喜欢喝美式");
    assert.equal(first.id, again.id);

    const items = await readMemories(dir, "s1");
    assert.equal(items.length, 1);
    assert.equal(items[0]?.text, "用户喜欢喝美式");
  });
});

test("记忆：按会话隔离", async () => {
  await withDir(async (dir) => {
    await addMemory(dir, "s1", "喜欢猫");
    await addMemory(dir, "s2", "喜欢狗");
    const s1 = await readMemories(dir, "s1");
    assert.deepEqual(
      s1.map((item) => item.text),
      ["喜欢猫"],
    );
  });
});

test("记忆：关键词检索与按编号删除", async () => {
  await withDir(async (dir) => {
    await addMemory(dir, "s1", "生日是十月一号");
    const cat = await addMemory(dir, "s1", "养了一只叫豆豆的猫");

    const hits = await searchMemories(dir, "s1", "豆豆");
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.id, cat.id);

    assert.equal(await forgetMemory(dir, "s1", cat.id), true);
    assert.equal(await forgetMemory(dir, "s1", cat.id), false);
    assert.equal((await readMemories(dir, "s1")).length, 1);
  });
});

test("记忆：按内容推断分类，也可以显式指定", async () => {
  assert.equal(inferMemoryKind("用户喜欢喝美式"), "preference");
  assert.equal(inferMemoryKind("养了一只叫豆豆的猫"), "person");
  assert.equal(inferMemoryKind("说好周六一起去看电影"), "agreement");
  assert.equal(inferMemoryKind("昨天去了一趟杭州"), "event");
  assert.equal(inferMemoryKind("住在十二楼"), "fact");

  await withDir(async (dir) => {
    const item = await addMemory(dir, "s1", "住在十二楼", "fact");
    assert.equal(item.kind, "fact");
  });
});

test("记忆：说法高度接近的只保留一条，并更新为更完整的表述", async () => {
  await withDir(async (dir) => {
    const first = await addMemory(dir, "s1", "用户喜欢喝美式");
    const again = await addMemory(dir, "s1", "用户喜欢喝美式咖啡");
    assert.equal(again.id, first.id);
    const items = await readMemories(dir, "s1");
    assert.equal(items.length, 1);
    assert.equal(items[0]?.text, "用户喜欢喝美式咖啡");
  });
});

test("记忆：按与当前输入的相关度排序，不相关的排后面", async () => {
  await withDir(async (dir) => {
    await addMemory(dir, "s1", "用户喜欢喝美式咖啡");
    const cat = await addMemory(dir, "s1", "用户养了一只叫豆豆的猫");
    await addMemory(dir, "s1", "用户生日是十月一号");

    const ranked = rankMemories(await readMemories(dir, "s1"), "豆豆今天怎么样");
    assert.equal(ranked[0]?.id, cat.id);
    assert.ok(ranked.length < 3, "不相关的记忆不应全部注入");
  });
});

test("记忆：上下文优先放相关的，再补最近几条", async () => {
  await withDir(async (dir) => {
    await addMemory(dir, "s1", "用户在学吉他");
    const background = ["喜欢下雨天", "住在十二楼", "早上喝豆浆", "怕冷", "养了绿萝", "在追一部剧"];
    for (const text of background) await addMemory(dir, "s1", text);
    const items = await readMemories(dir, "s1");
    const selected = selectMemoriesForContext(items, "我吉他练得怎么样了", 3);
    assert.equal(selected.length, 3);
    assert.equal(selected[0]?.text, "用户在学吉他");
  });
});

test("记忆：摘要带分类标签", async () => {
  await withDir(async (dir) => {
    await addMemory(dir, "s1", "怕冷");
    await addMemory(dir, "s1", "晚上十一点睡");
    const digest = formatMemoryDigest(await readMemories(dir, "s1"));
    assert.equal(digest, "- [偏好] 怕冷\n- [事实] 晚上十一点睡");
  });
});
