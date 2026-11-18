import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { safeSessionId } from "../tools/paths";

/** 单个会话最多记住多少个人。 */
export const MAX_PEOPLE = 20;
export const MAX_APPEARANCE_CHARS = 120;

export interface PersonProfile {
  id: string;
  name: string;
  /** 视觉模型总结的外貌特征，用来在摄像头画面里认出这个人。 */
  appearance?: string;
  createdAt: string;
  updatedAt?: string;
  /** 最近一次听到这个人说话。 */
  lastSpokeAt?: string;
  /** 最近一次在画面里看到这个人。 */
  lastSeenAt?: string;
  /** 互动次数，至少说过一次话或明确见过一次。 */
  interactions: number;
}

export function peopleDir(dataDir: string): string {
  return path.join(dataDir, "people");
}

function peopleFile(dir: string, sessionId: string): string {
  return path.join(dir, `${safeSessionId(sessionId)}.json`);
}

export async function readPeople(dir: string, sessionId: string): Promise<PersonProfile[]> {
  try {
    const raw = await readFile(peopleFile(dir, sessionId), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const people: PersonProfile[] = [];
    for (const entry of parsed) {
      if (!entry || typeof entry !== "object") continue;
      const person = entry as Partial<PersonProfile>;
      if (typeof person.id !== "string" || typeof person.name !== "string") continue;
      people.push({
        id: person.id,
        name: person.name,
        appearance:
          typeof person.appearance === "string"
            ? person.appearance.slice(0, MAX_APPEARANCE_CHARS)
            : undefined,
        createdAt:
          typeof person.createdAt === "string" ? person.createdAt : new Date(0).toISOString(),
        updatedAt: typeof person.updatedAt === "string" ? person.updatedAt : undefined,
        lastSpokeAt: typeof person.lastSpokeAt === "string" ? person.lastSpokeAt : undefined,
        lastSeenAt: typeof person.lastSeenAt === "string" ? person.lastSeenAt : undefined,
        interactions: typeof person.interactions === "number" ? person.interactions : 0,
      });
    }
    return people;
  } catch {
    return [];
  }
}

async function savePeople(dir: string, sessionId: string, people: PersonProfile[]): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(peopleFile(dir, sessionId), JSON.stringify(people, null, 2), "utf8");
}

export function findPerson(people: PersonProfile[], name: string): PersonProfile | undefined {
  const key = name.trim().toLowerCase();
  return people.find((person) => person.id === key || person.name.toLowerCase() === key);
}

/** 新建或更新一个人的资料；外貌为空时不覆盖已有描述。 */
export async function upsertPerson(
  dir: string,
  sessionId: string,
  name: string,
  patch: { appearance?: string; spoken?: boolean; seen?: boolean } = {},
): Promise<PersonProfile> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("人物名称不能为空");
  const people = await readPeople(dir, sessionId);
  const now = new Date().toISOString();
  const appearance = patch.appearance?.trim().slice(0, MAX_APPEARANCE_CHARS);

  const existing = findPerson(people, trimmed);
  if (existing) {
    if (appearance) existing.appearance = appearance;
    if (patch.spoken) {
      existing.lastSpokeAt = now;
      existing.interactions += 1;
    }
    if (patch.seen) existing.lastSeenAt = now;
    existing.updatedAt = now;
    await savePeople(dir, sessionId, people);
    return existing;
  }

  const person: PersonProfile = {
    id: randomUUID().slice(0, 8),
    name: trimmed,
    appearance,
    createdAt: now,
    lastSpokeAt: patch.spoken ? now : undefined,
    lastSeenAt: patch.seen ? now : undefined,
    interactions: patch.spoken ? 1 : 0,
  };
  const next = [...people, person];
  await savePeople(dir, sessionId, next.slice(-MAX_PEOPLE));
  return person;
}

export async function removePerson(
  dir: string,
  sessionId: string,
  nameOrId: string,
): Promise<boolean> {
  const key = nameOrId.trim().toLowerCase();
  if (!key) return false;
  const people = await readPeople(dir, sessionId);
  const next = people.filter((person) => person.id !== key && person.name.toLowerCase() !== key);
  if (next.length === people.length) return false;
  await savePeople(dir, sessionId, next);
  return true;
}

/** 拼给模型看的人物外貌记忆；没有外貌描述的不注入。 */
export function formatPeopleDigest(people: PersonProfile[], limit = 8): string {
  const known = people.filter((person) => person.appearance).slice(-limit);
  if (known.length === 0) return "";
  return known.map((person) => `- ${person.name}：${person.appearance}`).join("\n");
}
