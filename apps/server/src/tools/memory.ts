import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { safeSessionId } from "./paths";

/** 单个会话最多保留的记忆条数与单条长度上限。 */
export const MAX_MEMORIES = 200;
export const MAX_MEMORY_CHARS = 500;

/** 记忆分类：偏好、人物、约定、事件、事实。 */
export const MEMORY_KINDS = ["preference", "person", "agreement", "event", "fact"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export const MEMORY_KIND_LABELS: Record<MemoryKind, string> = {
  preference: "偏好",
  person: "人物",
  agreement: "约定",
  event: "事件",
  fact: "事实",
};

export interface MemoryItem {
  id: string;
  text: string;
  kind: MemoryKind;
  createdAt: string;
  /** 最近一次被重申或更新的时间。 */
  updatedAt?: string;
  /** 被检索/注入上下文的次数，用于了解哪些记忆真正有用。 */
  hits?: number;
}

function memoryFile(dir: string, sessionId: string): string {
  return path.join(dir, `${safeSessionId(sessionId)}.json`);
}

/** 关键词规则推断分类，旧数据也能补上。 */
export function inferMemoryKind(text: string): MemoryKind {
  if (/喜欢|爱|讨厌|害怕|怕|不吃|忌口|过敏|习惯|想要|希望|偏爱/.test(text)) return "preference";
  if (
    /叫|名字|是我|我的朋友|同事|妈妈|爸爸|母亲|父亲|老婆|老公|对象|女朋友|男朋友|孩子|儿子|女儿|宠物|猫|狗/.test(
      text,
    )
  ) {
    return "person";
  }
  if (/说好|约好|答应|约定|下周|明天要|回头|记得要|别忘/.test(text)) return "agreement";
  if (/今天|昨天|刚才|刚刚|上次|那天|去了|参加|发生|见了/.test(text)) return "event";
  return "fact";
}

function normalizeKind(kind: unknown, text: string): MemoryKind {
  return typeof kind === "string" && (MEMORY_KINDS as readonly string[]).includes(kind)
    ? (kind as MemoryKind)
    : inferMemoryKind(text);
}

/** 记忆按会话落盘，重启后仍在。文件损坏时按空列表处理。 */
export async function readMemories(dir: string, sessionId: string): Promise<MemoryItem[]> {
  try {
    const raw = await readFile(memoryFile(dir, sessionId), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const items: MemoryItem[] = [];
    for (const rawItem of parsed) {
      if (!rawItem || typeof rawItem !== "object") continue;
      const item = rawItem as Partial<MemoryItem>;
      if (typeof item.id !== "string" || typeof item.text !== "string") continue;
      items.push({
        id: item.id,
        text: item.text,
        kind: normalizeKind(item.kind, item.text),
        createdAt: typeof item.createdAt === "string" ? item.createdAt : new Date(0).toISOString(),
        updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : undefined,
        hits: typeof item.hits === "number" ? item.hits : undefined,
      });
    }
    return items;
  } catch {
    return [];
  }
}

async function saveMemories(dir: string, sessionId: string, items: MemoryItem[]): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(memoryFile(dir, sessionId), JSON.stringify(items, null, 2), "utf8");
}

function normalized(text: string): string {
  return text.toLowerCase().replace(/[\s\p{P}]/gu, "");
}

/** 字符二元组，用来在中文里做轻量语义近似。 */
function bigrams(text: string): string[] {
  if (text.length <= 2) return text ? [text] : [];
  const grams: string[] = [];
  for (let i = 0; i < text.length - 1; i += 1) grams.push(text.slice(i, i + 2));
  return grams;
}

/** Dice 系数：两段文本的二元组重合度，0~1。 */
export function similarity(a: string, b: string): number {
  const left = bigrams(normalized(a));
  const right = bigrams(normalized(b));
  if (left.length === 0 || right.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const gram of left) counts.set(gram, (counts.get(gram) ?? 0) + 1);
  let overlap = 0;
  for (const gram of right) {
    const count = counts.get(gram) ?? 0;
    if (count > 0) {
      overlap += 1;
      counts.set(gram, count - 1);
    }
  }
  return (2 * overlap) / (left.length + right.length);
}

/** 一条记忆与当前这句话的相关度，越相关越高。 */
export function memoryRelevance(item: MemoryItem, query: string): number {
  const q = normalized(query);
  const text = normalized(item.text);
  if (!q || !text) return 0;

  let score = 0;
  if (text.includes(q) || q.includes(text)) score += 2;
  score += similarity(q, text) * 3;

  // 命中查询里的二字片段，按命中比例加分，避免只有个别字重合就排前面。
  const grams = [...new Set(bigrams(q))];
  if (grams.length > 0) {
    const hits = grams.filter((gram) => text.includes(gram)).length;
    score += (hits / grams.length) * 2;
  }
  return score;
}

/** 按与当前输入的相关度排序；相关度相同时新的优先。 */
export function rankMemories(items: MemoryItem[], query: string): MemoryItem[] {
  const q = query.trim();
  if (!q) return [...items].reverse();
  return items
    .map((item) => ({ item, score: memoryRelevance(item, q) }))
    .filter((entry) => entry.score > 0.25)
    .sort((a, b) => b.score - a.score || b.item.createdAt.localeCompare(a.item.createdAt))
    .map((entry) => entry.item);
}

/**
 * 挑选这一轮要注入上下文的记忆：先放与当前话题相关的，
 * 不够再补最近几条作为背景，而不是固定塞最近 N 条。
 */
export function selectMemoriesForContext(
  items: MemoryItem[],
  query: string,
  limit = 10,
): MemoryItem[] {
  if (items.length <= limit) return items;
  const selected = rankMemories(items, query).slice(0, limit);
  if (selected.length >= limit) return selected;

  const chosen = new Set(selected.map((item) => item.id));
  for (let i = items.length - 1; i >= 0 && selected.length < limit; i -= 1) {
    const item = items[i]!;
    if (chosen.has(item.id)) continue;
    selected.push(item);
    chosen.add(item.id);
  }
  return selected;
}

/** 判断两条记忆是不是在说同一件事：原文相同、一方包含另一方，或说法几乎一样。 */
function isDuplicateMemory(a: string, b: string): boolean {
  const left = normalized(a);
  const right = normalized(b);
  if (!left || !right) return false;
  if (left === right) return true;
  const [short, long] = left.length <= right.length ? [left, right] : [right, left];
  if (short.length >= 4 && long.includes(short) && long.length - short.length <= 6) return true;
  return similarity(a, b) >= 0.92;
}

export async function addMemory(
  dir: string,
  sessionId: string,
  text: string,
  kind?: MemoryKind,
): Promise<MemoryItem> {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("记忆内容不能为空");
  const limited = trimmed.slice(0, MAX_MEMORY_CHARS);
  const items = await readMemories(dir, sessionId);

  // 同一条内容、或说法高度接近的不重复记，只刷新更新时间。
  const existing = items.find((item) => isDuplicateMemory(item.text, limited));
  if (existing) {
    existing.updatedAt = new Date().toISOString();
    if (limited.length > existing.text.length) existing.text = limited;
    if (kind) existing.kind = kind;
    await saveMemories(dir, sessionId, items);
    return existing;
  }

  const item: MemoryItem = {
    id: randomUUID().slice(0, 8),
    text: limited,
    kind: kind ?? inferMemoryKind(limited),
    createdAt: new Date().toISOString(),
  };
  items.push(item);
  await saveMemories(dir, sessionId, items.slice(-MAX_MEMORIES));
  return item;
}

export async function forgetMemory(
  dir: string,
  sessionId: string,
  idOrText: string,
): Promise<boolean> {
  const key = idOrText.trim();
  if (!key) return false;
  const items = await readMemories(dir, sessionId);
  const next = items.filter((item) => item.id !== key && item.text !== key);
  if (next.length === items.length) return false;
  await saveMemories(dir, sessionId, next);
  return true;
}

/** 按相关度检索，相关度太低的不会返回。 */
export async function searchMemories(
  dir: string,
  sessionId: string,
  query: string,
): Promise<MemoryItem[]> {
  const items = await readMemories(dir, sessionId);
  const keyword = query.trim();
  if (!keyword) return items;
  return rankMemories(items, keyword);
}

/** 把选好的记忆拼成给模型的摘要；带分类标签，便于自然使用。 */
export function formatMemoryDigest(items: MemoryItem[], limit?: number): string {
  if (items.length === 0) return "";
  const chosen = limit ? items.slice(-limit) : items;
  return chosen
    .map((item) => `- [${MEMORY_KIND_LABELS[item.kind] ?? "事实"}] ${item.text}`)
    .join("\n");
}
