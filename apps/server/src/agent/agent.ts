import { ChatOpenAI } from "@langchain/openai";
import { MemorySaver } from "@langchain/langgraph";
import { createDeepAgent } from "deepagents";
import type { Config } from "../env";
import { createSessionTools } from "../tools";
import { describeLocation, getUserLocation } from "../tools/location";
import { loadMcpTools } from "../tools/mcp";
import { formatMemoryDigest, readMemories, selectMemoriesForContext } from "../tools/memory";
import { DATA_DIR, memoryDir } from "../tools/paths";
import { formatPeopleDigest, peopleDir, readPeople } from "../people/store";
import { formatWorldDigest, readObservations, worldDir } from "../tools/world";
import { buildDefaultSystemPrompt } from "./prompt";

/** 进程内会话记忆。生产环境可换成 Postgres / Redis checkpointer。 */
const checkpointer = new MemorySaver();

type CompanionAgent = Awaited<ReturnType<typeof createDeepAgent>>;

/** 工具按会话绑定，因此智能体也按会话缓存。 */
const agents = new Map<string, CompanionAgent>();
const MAX_CACHED_AGENTS = 100;

export async function getCompanionAgent(
  config: Config,
  sessionId: string,
): Promise<CompanionAgent> {
  const existing = agents.get(sessionId);
  if (existing) return existing;

  const model = new ChatOpenAI({
    model: config.deepseek.model,
    apiKey: config.deepseek.apiKey,
    temperature: config.deepseek.temperature,
    configuration: { baseURL: config.deepseek.baseUrl },
  });

  const mcpTools = await loadMcpTools(config);
  const agent = await createDeepAgent({
    model,
    systemPrompt: config.systemPrompt ?? buildDefaultSystemPrompt(config.assistant.name),
    checkpointer,
    tools: [...createSessionTools({ sessionId, weather: config.weather, config }), ...mcpTools],
  });

  if (agents.size >= MAX_CACHED_AGENTS) {
    const oldest = agents.keys().next().value;
    if (oldest) agents.delete(oldest);
  }
  agents.set(sessionId, agent);
  return agent;
}

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

/** 每轮拼进模型的实时上下文：定位 + 声纹说话人 + 人物外貌 + 相关记忆 + 环境观察。 */
async function buildContext(
  sessionId: string,
  query = "",
  speaker?: { matched: boolean; name?: string },
): Promise<string> {
  const lines: string[] = [];
  if (speaker) {
    lines.push(
      speaker.matched && speaker.name
        ? `当前说话人：${speaker.name}（已注册声纹，可以自然称呼，但不要每句都叫名字）。`
        : "当前说话人：未识别的其他人。不要透露已注册用户的私人信息；对方明确在跟你说话时正常回应。",
    );
  }
  const people = await readPeople(peopleDir(DATA_DIR), sessionId);
  const peopleDigest = formatPeopleDigest(people);
  if (peopleDigest) {
    lines.push(
      `你认识的人（外貌记忆，用来在画面里认人；只有画面特征明显相符时才认出，不要猜）：\n${peopleDigest}`,
    );
  }
  const location = getUserLocation(sessionId);
  if (location) {
    lines.push(
      `用户当前定位：${describeLocation(location)}。用户问天气时可直接调用 get_weather，不用再问坐标。`,
    );
  }
  const memories = await readMemories(memoryDir(), sessionId);
  const digest = formatMemoryDigest(selectMemoriesForContext(memories, query));
  if (digest) {
    lines.push(`关于用户的长期记忆（自然使用，不要逐条复述）：\n${digest}`);
  }
  const observations = await readObservations(worldDir(), sessionId);
  if (observations.length) {
    lines.push(
      `你平时安静观察到并记下的环境（最近几条，像相处久了自然知道，不要说成监控汇报）：\n${formatWorldDigest(observations)}`,
    );
  }
  return lines.join("\n");
}

/** 一次安静观察的结果。 */
export interface SceneObservation {
  scene: string;
  change?: string;
  fact?: string;
}

/** 解析观察模型输出的一行 JSON；解析失败时退化成纯文本场景描述。 */
export function parseObservation(raw: string): SceneObservation {
  const match = raw.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]) as Record<string, unknown>;
      const scene = typeof parsed.scene === "string" ? parsed.scene.trim() : "";
      const change = typeof parsed.change === "string" ? parsed.change.trim() : "";
      const fact = typeof parsed.fact === "string" ? parsed.fact.trim() : "";
      if (scene) {
        return {
          scene: scene.slice(0, 200),
          change: change ? change.slice(0, 200) : undefined,
          fact: fact ? fact.slice(0, 200) : undefined,
        };
      }
    } catch {
      // 落到下面的纯文本兜底。
    }
  }
  const text = raw.trim();
  return text ? { scene: text.slice(0, 200) } : { scene: "" };
}

/** 空闲时的静默观察：只描述与记录，不产生语音、不进入对话历史。 */
export async function observeFrame(params: {
  config: Config;
  imageBase64: string;
  previous?: string;
}): Promise<SceneObservation> {
  const model = new ChatOpenAI({
    model: params.config.deepseek.model,
    apiKey: params.config.deepseek.apiKey,
    temperature: 0.3,
    maxTokens: 220,
    configuration: { baseURL: params.config.deepseek.baseUrl },
  });

  const prompt = [
    "你在安静地观察环境，只做记录，不对用户说话。",
    '请只输出一行 JSON：{"scene":"一句话客观描述你看到的环境","change":"和上次相比的变化，没有就空字符串","fact":"值得长期记住的用户习惯或偏好，没有就空字符串"}',
    "scene 不超过 40 字；fact 只记稳定、可复用的信息（比如常喝咖啡、晚上工作），不记一次性画面细节。",
    params.previous ? `上一次观察：${params.previous}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const response = await model.invoke([
    {
      role: "user",
      content: [
        { type: "text", text: prompt },
        {
          type: "image_url",
          image_url: { url: `data:image/jpeg;base64,${params.imageBase64}` },
        },
      ],
    },
  ]);
  return parseObservation(extractText(response.content));
}

/** 按 token 流式产出回复文本。imageBase64 为摄像头最新一帧（JPEG），仅视觉模型可用。 */
export async function* streamAgentReply(params: {
  config: Config;
  sessionId: string;
  text: string;
  imageBase64?: string;
  /** 主动开口（不是回复用户）时为 true，用于调整画面说明。 */
  proactive?: boolean;
  /** 声纹识别出的说话人；没注册过声纹时为空。 */
  speaker?: { matched: boolean; name?: string; score?: number };
  signal: AbortSignal;
}): AsyncGenerator<string> {
  const agent = await getCompanionAgent(params.config, params.sessionId);
  // 主动开口时没有用户原话，按最近记忆给上下文即可。
  const context = await buildContext(
    params.sessionId,
    params.proactive ? "" : params.text,
    params.speaker,
  );
  type UserContent =
    | string
    | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>;
  const messages: Array<{ role: "system" | "user"; content: UserContent }> = [];
  if (context) messages.push({ role: "system", content: `[实时上下文]\n${context}` });

  const content: UserContent = params.imageBase64
    ? [
        {
          type: "text",
          text: params.proactive
            ? `${params.text}\n（附带摄像头最新画面，可作为主动开口的参考，不要朗读画面描述。）`
            : `用户正在看着摄像头和你说话。以下是摄像头最新画面，作为背景信息，不要朗读画面描述。\n用户说：${params.text}`,
        },
        {
          type: "image_url",
          image_url: { url: `data:image/jpeg;base64,${params.imageBase64}` },
        },
      ]
    : params.text;
  messages.push({ role: "user", content });

  const events = agent.streamEvents(
    { messages },
    {
      version: "v2",
      configurable: { thread_id: params.sessionId },
      signal: params.signal,
    },
  );

  for await (const event of events) {
    if (event.event !== "on_chat_model_stream") continue;
    const chunk = (event.data as { chunk?: { content?: unknown } } | undefined)?.chunk;
    const text = extractText(chunk?.content);
    if (text) yield text;
  }
}
