import type { Config } from "../env";
import { askVision } from "../tools/look";

const MAX_APPEARANCE_CHARS = 120;

/**
 * 让视觉模型给一个人总结可复用的外貌特征。
 * 只描述稳定的外在特征，看不清或多个人分不清时返回 null。
 */
export async function describeAppearance(params: {
  config: Config;
  imageBase64: string;
  name?: string;
}): Promise<string | null> {
  const who = params.name ? `「${params.name}」` : "当前说话的人";
  const prompt = [
    `你在帮一个陪伴机器人记住${who}的样子，以后要在摄像头画面里认出 TA。`,
    "只描述稳定的外在特征：发型、眼镜、胡子、常穿的衣服颜色和款式、明显配饰。",
    "不要评价美丑，不要猜年龄、职业、身份，不要念画面里的文字，不要描述背景。",
    "画面里有好几个人时，优先描述离镜头最近、正对镜头的那个人；分不清是谁就只输出：看不清。",
    "画面里没有人、人太小或被遮挡看不清时，也只输出：看不清。",
    "否则输出一句 80 字以内的中文描述，不要加前缀。",
  ].join("\n");

  const answer = await askVision({
    config: params.config,
    imageBase64: params.imageBase64,
    prompt,
    maxTokens: 180,
  });
  const cleaned = answer
    .replace(/\s+/g, " ")
    .replace(/^[「『"]|[」』"]$/g, "")
    .trim();
  if (!cleaned || /看不清|无法辨认|没有人/.test(cleaned)) return null;
  return cleaned.slice(0, MAX_APPEARANCE_CHARS);
}
