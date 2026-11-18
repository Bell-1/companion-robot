import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ReminderItem, ReminderKind } from "@companion/shared";
import { DATA_DIR, safeSessionId } from "./paths";

/** 单个会话最多保留的提醒/待办条数。 */
export const MAX_REMINDERS = 100;
export const MAX_REMINDER_CHARS = 200;

function reminderFile(dir: string, sessionId: string): string {
  return path.join(dir, `${safeSessionId(sessionId)}.json`);
}

/** 读取全部提醒与待办；文件损坏或不存在时按空列表处理。 */
export async function readReminders(dir: string, sessionId: string): Promise<ReminderItem[]> {
  try {
    const raw = await readFile(reminderFile(dir, sessionId), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is ReminderItem =>
        !!item &&
        typeof item === "object" &&
        typeof (item as ReminderItem).id === "string" &&
        typeof (item as ReminderItem).text === "string" &&
        ((item as ReminderItem).kind === "reminder" || (item as ReminderItem).kind === "todo"),
    );
  } catch {
    return [];
  }
}

async function saveReminders(dir: string, sessionId: string, items: ReminderItem[]): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(reminderFile(dir, sessionId), JSON.stringify(items, null, 2), "utf8");
}

/** 未完成的提醒按时间排序，待办排在最后。 */
export function sortPending(items: ReminderItem[]): ReminderItem[] {
  return items
    .filter((item) => item.status === "pending")
    .sort((a, b) => {
      if (a.dueAt && b.dueAt) return a.dueAt.localeCompare(b.dueAt);
      if (a.dueAt) return -1;
      if (b.dueAt) return 1;
      return a.createdAt.localeCompare(b.createdAt);
    });
}

export async function listPendingReminders(
  dir: string,
  sessionId: string,
): Promise<ReminderItem[]> {
  return sortPending(await readReminders(dir, sessionId));
}

export async function addReminder(
  dir: string,
  sessionId: string,
  input: { text: string; kind: ReminderKind; dueAt?: string },
): Promise<ReminderItem> {
  const text = input.text.trim().slice(0, MAX_REMINDER_CHARS);
  if (!text) throw new Error("内容不能为空");

  const items = await readReminders(dir, sessionId);
  // 同样的待办/同一时间的提醒不重复记。
  const existing = items.find(
    (item) =>
      item.status === "pending" &&
      item.text === text &&
      (input.kind === "todo" ? item.kind === "todo" : item.dueAt === input.dueAt),
  );
  if (existing) return existing;

  const item: ReminderItem = {
    id: randomUUID().slice(0, 8),
    text,
    kind: input.kind,
    dueAt: input.dueAt,
    createdAt: new Date().toISOString(),
    status: "pending",
  };
  items.push(item);
  await saveReminders(dir, sessionId, items.slice(-MAX_REMINDERS));
  return item;
}

/** 把一条提醒标记为已完成；支持编号或原文。 */
export async function completeReminder(
  dir: string,
  sessionId: string,
  idOrText: string,
): Promise<ReminderItem | null> {
  const key = idOrText.trim();
  if (!key) return null;
  const items = await readReminders(dir, sessionId);
  const target = items.find(
    (item) => item.status === "pending" && (item.id === key || item.text === key),
  );
  if (!target) return null;
  target.status = "done";
  await saveReminders(dir, sessionId, items);
  return target;
}

/** 取消一条提醒（不当作完成）。 */
export async function cancelReminder(
  dir: string,
  sessionId: string,
  idOrText: string,
): Promise<ReminderItem | null> {
  const key = idOrText.trim();
  if (!key) return null;
  const items = await readReminders(dir, sessionId);
  const target = items.find(
    (item) => item.status === "pending" && (item.id === key || item.text === key),
  );
  if (!target) return null;
  target.status = "cancelled";
  await saveReminders(dir, sessionId, items);
  return target;
}

/** 到点且仍未完成的提醒。 */
export async function dueReminders(
  dir: string,
  sessionId: string,
  now = Date.now(),
): Promise<ReminderItem[]> {
  const items = await listPendingReminders(dir, sessionId);
  return items.filter((item) => item.dueAt && new Date(item.dueAt).getTime() <= now);
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** 用本地时区把截止时间说成人话，例如「今天 18:30」「明天 08:00」。 */
export function formatDue(dueAt?: string): string {
  if (!dueAt) return "待办";
  const date = new Date(dueAt);
  if (Number.isNaN(date.getTime())) return dueAt;
  const now = new Date();
  const hhmm = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (date.toDateString() === now.toDateString()) return `今天 ${hhmm}`;
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (date.toDateString() === tomorrow.toDateString()) return `明天 ${hhmm}`;
  return `${date.getMonth() + 1}月${date.getDate()}日 ${hhmm}`;
}

/** 工具返回给人/模型看的一行描述。 */
export function describeReminder(item: ReminderItem): string {
  const time = item.dueAt ? formatDue(item.dueAt) : "待办";
  return `[${item.id}] ${time} · ${item.text}`;
}

/** 把模型给的时间参数解析成 ISO；支持 ISO 与「2026-11-18 08:00」。 */
export function parseDueAt(value?: string): string | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  const date = new Date(text.replace(" ", "T"));
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString();
}

export function remindersDir(dataDir = DATA_DIR): string {
  return path.join(dataDir, "reminders");
}
