import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DATA_DIR, safeSessionId } from "./paths";

/** 空闲时自动观察到的环境记录，用于让角色积累对环境的认识。 */
export interface Observation {
  at: string;
  scene: string;
  change?: string;
}

/** 每个会话最多保留的观察条数。 */
export const MAX_OBSERVATIONS = 40;

export function worldDir(dataDir = DATA_DIR): string {
  return path.join(dataDir, "world");
}

function worldFile(dir: string, sessionId: string): string {
  return path.join(dir, `${safeSessionId(sessionId)}.json`);
}

export async function readObservations(dir: string, sessionId: string): Promise<Observation[]> {
  try {
    const raw = await readFile(worldFile(dir, sessionId), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is Observation =>
        !!item &&
        typeof item === "object" &&
        typeof (item as Observation).at === "string" &&
        typeof (item as Observation).scene === "string",
    );
  } catch {
    return [];
  }
}

export async function appendObservation(
  dir: string,
  sessionId: string,
  observation: Observation,
): Promise<Observation[]> {
  const items = await readObservations(dir, sessionId);
  items.push(observation);
  const trimmed = items.slice(-MAX_OBSERVATIONS);
  await mkdir(dir, { recursive: true });
  await writeFile(worldFile(dir, sessionId), JSON.stringify(trimmed, null, 2), "utf8");
  return trimmed;
}

/** 取最近几条观察，拼成给模型的上下文摘要。 */
export function formatWorldDigest(items: Observation[], limit = 3): string {
  return items
    .slice(-limit)
    .map((item) => {
      const time = item.at.slice(5, 16).replace("T", " ");
      const change = item.change ? `（${item.change}）` : "";
      return `- ${time} ${item.scene}${change}`;
    })
    .join("\n");
}
