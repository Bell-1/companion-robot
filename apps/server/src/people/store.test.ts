import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  findPerson,
  formatPeopleDigest,
  MAX_APPEARANCE_CHARS,
  peopleDir,
  readPeople,
  removePerson,
  upsertPerson,
} from "./store";

async function withDir(run: (dir: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "companion-people-"));
  try {
    await run(peopleDir(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("人物：新建并更新外貌", async () => {
  await withDir(async (dir) => {
    const created = await upsertPerson(dir, "s1", "小明", { appearance: "黑色短发，戴黑框眼镜" });
    assert.equal(created.name, "小明");
    assert.equal(created.interactions, 0);

    const updated = await upsertPerson(dir, "s1", "小明", { appearance: "寸头，戴黑框眼镜" });
    assert.equal(updated.appearance, "寸头，戴黑框眼镜");
    assert.equal(updated.createdAt, created.createdAt);

    const people = await readPeople(dir, "s1");
    assert.equal(people.length, 1);
  });
});

test("人物：同名大小写合并，空外貌不覆盖已有描述", async () => {
  await withDir(async (dir) => {
    await upsertPerson(dir, "s1", "Alice", { appearance: "金色长发" });
    const merged = await upsertPerson(dir, "s1", "alice", { spoken: true });

    const people = await readPeople(dir, "s1");
    assert.equal(people.length, 1);
    assert.equal(merged.appearance, "金色长发");
    assert.equal(merged.interactions, 1);
    assert.ok(merged.lastSpokeAt);

    assert.equal(findPerson(people, "ALICE")?.id, merged.id);
  });
});

test("人物：每次说话累加互动次数", async () => {
  await withDir(async (dir) => {
    await upsertPerson(dir, "s1", "小明", { spoken: true });
    const second = await upsertPerson(dir, "s1", "小明", { spoken: true });
    assert.equal(second.interactions, 2);
  });
});

test("人物：按名字或 id 删除", async () => {
  await withDir(async (dir) => {
    const person = await upsertPerson(dir, "s1", "小明", { appearance: "戴眼镜" });
    assert.equal(await removePerson(dir, "s1", person.id), true);
    assert.equal(await removePerson(dir, "s1", person.id), false);

    await upsertPerson(dir, "s1", "Alice", {});
    assert.equal(await removePerson(dir, "s1", "ALICE"), true);
    assert.equal((await readPeople(dir, "s1")).length, 0);
  });
});

test("人物：摘要只包含有外貌的人", async () => {
  await withDir(async (dir) => {
    await upsertPerson(dir, "s1", "小明", { appearance: "戴眼镜" });
    await upsertPerson(dir, "s1", "小红", { spoken: true });

    const people = await readPeople(dir, "s1");
    const digest = formatPeopleDigest(people);
    assert.match(digest, /小明：戴眼镜/);
    assert.doesNotMatch(digest, /小红/);
  });
});

test("人物：外貌描述按上限截断", async () => {
  await withDir(async (dir) => {
    const long = await upsertPerson(dir, "s1", "小明", { appearance: "长".repeat(500) });
    assert.equal(long.appearance?.length, MAX_APPEARANCE_CHARS);
  });
});
