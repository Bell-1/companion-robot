import { ChatOpenAI } from "@langchain/openai";
import type { Config } from "../env";

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const block of content) {
    if (typeof block === "string") {
      text += block;
    } else if (block && typeof block === "object") {
      const record = block as { type?: string; text?: string };
      if (record.type === "text" && typeof record.text === "string") text += record.text;
    }
  }
  return text;
}

/** 用视觉模型看一帧画面，返回纯文本结论。 */
export async function askVision(params: {
  config: Config;
  imageBase64: string;
  prompt: string;
  maxTokens?: number;
}): Promise<string> {
  const model = new ChatOpenAI({
    model: params.config.deepseek.model,
    apiKey: params.config.deepseek.apiKey,
    temperature: 0.2,
    maxTokens: params.maxTokens ?? 400,
    configuration: { baseURL: params.config.deepseek.baseUrl },
  });

  const response = await model.invoke([
    {
      role: "user",
      content: [
        { type: "text", text: params.prompt },
        {
          type: "image_url",
          image_url: { url: `data:image/jpeg;base64,${params.imageBase64}` },
        },
      ],
    },
  ]);
  return extractText(response.content).trim();
}

/**
 * 按需细看摄像头最新一帧：读文字、认物品、看表情动作。
 * 只在模型确实需要时调用一次，结果作为工具返回值。
 */
export async function inspectFrame(params: {
  config: Config;
  imageBase64: string;
  question?: string;
}): Promise<string> {
  const question = params.question?.trim() || "画面里有什么？注意文字、物品和人的动作。";
  const prompt = [
    "你在看用户摄像头的最新一帧画面。",
    `用户想知道：${question}`,
    "只回答被问到的内容，客观、简短，不超过 80 字。",
    "画面里有文字就照原样读出来；看不清、被挡住或没有画面内容时直接说看不清，不要猜。",
    "不要说「根据画面」「我看到」这类话，直接给结论。",
  ].join("\n");

  return askVision({
    config: params.config,
    imageBase64: params.imageBase64,
    prompt,
  });
}
