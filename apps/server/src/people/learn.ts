import type { Config } from "../env";
import { DATA_DIR } from "../tools/paths";
import { getVisionFrame } from "../tools/vision-control";
import { describeAppearance } from "./appearance";
import { peopleDir, upsertPerson } from "./store";

/**
 * 从当前摄像头画面学习一个人的外貌，并写进人物记忆。
 * 没有画面、画面太旧或看不清时返回 null。
 */
export async function learnAppearanceFromFrame(params: {
  config: Config;
  sessionId: string;
  name: string;
  dataDir?: string;
}): Promise<string | null> {
  const frame = getVisionFrame(params.sessionId);
  if (!frame) return null;
  if (Date.now() - frame.at > Math.max(params.config.vision.maxAgeMs, 30000)) return null;

  const appearance = await describeAppearance({
    config: params.config,
    imageBase64: frame.image,
    name: params.name,
  });
  if (!appearance) return null;

  await upsertPerson(peopleDir(params.dataDir ?? DATA_DIR), params.sessionId, params.name, {
    appearance,
    seen: true,
  });
  return appearance;
}
