import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  addReminder,
  completeReminder,
  dueReminders,
  formatDue,
  listPendingReminders,
  parseDueAt,
  readReminders,
  remindersDir,
  sortPending,
} from "./reminders";

async function withDir(run: (dir: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "companion-reminders-"));
  try {
    await run(remindersDir(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("提醒和待办分开排序，待办排最后", () => {
  const items = [
    {
      id: "t",
      text: "买牛奶",
      kind: "todo" as const,
      createdAt: "2026-01-03T00:00:00Z",
      status: "pending" as const,
    },
    {
      id: "b",
      text: "晚点",
      kind: "reminder" as const,
      dueAt: "2026-01-02T10:00:00Z",
      createdAt: "2026-01-01T00:00:00Z",
      status: "pending" as const,
    },
    {
      id: "a",
      text: "早点",
      kind: "reminder" as const,
      dueAt: "2026-01-02T09:00:00Z",
      createdAt: "2026-01-01T00:00:00Z",
      status: "done" as const,
    },
  ];
  assert.deepEqual(
    sortPending(items).map((item) => item.id),
    ["b", "t"],
  );
});

test("新增、读取和完成提醒", async () => {
  await withDir(async (dir) => {
    const dueAt = new Date(Date.now() + 60_000).toISOString();
    const reminder = await addReminder(dir, "session-a", {
      text: " 喝水 ",
      kind: "reminder",
      dueAt,
    });
    assert.equal(reminder.text, "喝水");
    assert.equal((await readReminders(dir, "session-a")).length, 1);

    // 同样的内容不重复记。
    await addReminder(dir, "session-a", { text: "喝水", kind: "reminder", dueAt });
    assert.equal((await listPendingReminders(dir, "session-a")).length, 1);

    const done = await completeReminder(dir, "session-a", reminder.id);
    assert.equal(done?.status, "done");
    assert.equal((await listPendingReminders(dir, "session-a")).length, 0);
  });
});

test("待办没有时间也能记录", async () => {
  await withDir(async (dir) => {
    const todo = await addReminder(dir, "session-b", { text: "交报告", kind: "todo" });
    assert.equal(todo.dueAt, undefined);
    const pending = await listPendingReminders(dir, "session-b");
    assert.equal(pending.length, 1);
    assert.equal(pending[0]?.id, todo.id);
  });
});

test("只有到点的提醒才会被选出", async () => {
  await withDir(async (dir) => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const future = new Date(Date.now() + 60 * 60_000).toISOString();
    await addReminder(dir, "session-c", { text: "已经到点", kind: "reminder", dueAt: past });
    await addReminder(dir, "session-c", { text: "还没到", kind: "reminder", dueAt: future });
    await addReminder(dir, "session-c", { text: "待办", kind: "todo" });

    const due = await dueReminders(dir, "session-c");
    assert.deepEqual(
      due.map((item) => item.text),
      ["已经到点"],
    );
  });
});

test("时间解析与展示", () => {
  const parsed = parseDueAt("2026-11-18 08:00");
  assert.ok(parsed);
  assert.equal(parseDueAt("不是时间"), undefined);
  assert.equal(parseDueAt(""), undefined);

  const today = new Date();
  today.setHours(18, 30, 0, 0);
  assert.match(formatDue(today.toISOString()), /^今天 18:30$/);
  assert.equal(formatDue(undefined), "待办");
});
