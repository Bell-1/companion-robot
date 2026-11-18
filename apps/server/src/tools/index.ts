import { tool } from "@langchain/core/tools";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";
import type { Config } from "../env";
import { inspectFrame } from "./look";
import {
  addMemory,
  forgetMemory,
  MAX_MEMORIES,
  MEMORY_KIND_LABELS,
  MEMORY_KINDS,
  readMemories,
  searchMemories,
} from "./memory";
import { getUserLocation, isValidCoordinate } from "./location";
import { DATA_DIR, memoryDir, sessionSandboxDir } from "./paths";
import { refreshReminderSession } from "./reminder-control";
import {
  addReminder,
  cancelReminder,
  completeReminder,
  describeReminder,
  formatDue,
  listPendingReminders,
  parseDueAt,
  remindersDir,
} from "./reminders";
import { deleteSandboxPath, listSandboxFiles, readSandboxFile, writeSandboxFile } from "./sandbox";
import { searchWeb } from "./search";
import { fetchWeather, fetchWeatherByCity } from "./weather";
import type { WeatherConfig } from "./weather";
import { clampVisionInterval, getVisionFrame, setVisionInterval } from "./vision-control";
import { getLastUtterance } from "../voiceprint/control";
import { extractEmbedding, initVoiceprint, voiceprintLoadError } from "../voiceprint/model";
import { learnAppearanceFromFrame } from "../people/learn";
import { MAX_PEOPLE, peopleDir, readPeople, removePerson } from "../people/store";
import {
  enrollVoiceprint,
  MAX_VOICE_NAME_CHARS,
  MAX_VOICEPRINTS,
  readVoiceprints,
  removeVoiceprint,
  voiceprintDir,
} from "../voiceprint/store";

export interface SessionToolsOptions {
  sessionId: string;
  weather: WeatherConfig;
  /** 细看画面时复用同一套模型配置。 */
  config: Config;
  /** 便于测试时指向临时目录。 */
  dataDir?: string;
}

function errorText(error: unknown): string {
  return `操作失败：${error instanceof Error ? error.message : String(error)}`;
}

function currentTime(timeZone: string): string {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat("zh-CN", {
    timeZone,
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return `${formatter.format(now)}（${timeZone}）`;
}

/** 为单个会话创建工具集：时间、定位天气、记忆、沙箱文件读写。 */
export function createSessionTools(options: SessionToolsOptions): StructuredToolInterface[] {
  const { sessionId } = options;
  const weatherConfig = options.weather;
  const sandboxRoot = sessionSandboxDir(sessionId, options.dataDir);
  const memoriesDir = memoryDir(options.dataDir);
  const remindersRoot = remindersDir(options.dataDir);

  const getCurrentTimeTool = tool(
    async ({ timeZone }) => {
      const zone = timeZone?.trim() || "Asia/Shanghai";
      try {
        return currentTime(zone);
      } catch {
        return currentTime("Asia/Shanghai");
      }
    },
    {
      name: "get_current_time",
      description:
        "查询当前日期和时间。用户问现在几点、今天星期几、今天几号时调用。默认时区 Asia/Shanghai。",
      schema: z.object({
        timeZone: z
          .string()
          .optional()
          .describe("IANA 时区，例如 Asia/Shanghai、America/New_York；不填则用 Asia/Shanghai"),
      }),
    },
  );

  const getWeatherTool = tool(
    async ({ latitude, longitude, city }) => {
      try {
        const stored = getUserLocation(sessionId);
        const cityName = city?.trim();
        // 用户点名了城市时以城市为准，否则用坐标（显式参数或浏览器上报的定位）。
        if (cityName && latitude === undefined && longitude === undefined) {
          return await fetchWeatherByCity(weatherConfig, cityName);
        }

        const lat = latitude ?? stored?.latitude;
        const lon = longitude ?? stored?.longitude;

        if (lat === undefined || lon === undefined) {
          return "还没有拿到用户的定位。可以请用户打开定位权限，或者直接告诉你想查的城市名。";
        }

        if (!isValidCoordinate(lat, lon)) return "坐标不合法，无法查询天气。";
        return await fetchWeather(weatherConfig, lat, lon);
      } catch (error) {
        return `${errorText(error)}。先跟用户说天气暂时查不到，不要编造天气。`;
      }
    },
    {
      name: "get_weather",
      description:
        "查询用户所在地或指定城市的实时天气、今天温度范围，以及明天和后天的预报。不传坐标时优先用浏览器已上报的定位；也没有定位就用 city 参数。",
      schema: z.object({
        latitude: z.number().optional().describe("纬度，可省略"),
        longitude: z.number().optional().describe("经度，可省略"),
        city: z.string().optional().describe("城市名，如「杭州」，仅在缺少定位时使用"),
      }),
    },
  );

  const webSearchTool = tool(
    async ({ query, count }) => {
      try {
        return await searchWeb(
          {
            enabled: options.config.search.enabled,
            apiKey: options.config.deepseek.apiKey,
            baseUrl: options.config.deepseek.baseUrl,
            count: options.config.search.count,
          },
          query,
          count,
        );
      } catch (error) {
        return `${errorText(error)}。不要编造搜索结果，先告诉用户暂时查不到。`;
      }
    },
    {
      name: "web_search",
      description:
        "联网搜索实时信息。用户问新闻、最新动态、价格、赛事、政策、产品发布，或你不确定的事实时调用；日常闲聊和常识不用搜。",
      schema: z.object({
        query: z.string().describe("搜索词，保留关键人名、产品名和时间"),
        count: z.number().min(1).max(10).optional().describe("返回条数，默认 5"),
      }),
    },
  );

  const rememberTool = tool(
    async ({ text, kind }) => {
      try {
        const item = await addMemory(memoriesDir, sessionId, text, kind);
        return `已记住（${MEMORY_KIND_LABELS[item.kind]}，编号 ${item.id}）：${item.text}`;
      } catch (error) {
        return errorText(error);
      }
    },
    {
      name: "remember",
      description:
        "长期记住用户的一个事实、喜好或约定，比如名字、生日、忌口、正在做的事。用户说「记住」「以后别忘」时调用；对方无意中提到的稳定信息也可以主动记。分类：preference 偏好、person 人物、agreement 约定、event 事件、fact 其他事实。",
      schema: z.object({
        text: z.string().describe("要记住的一句话，尽量精炼"),
        kind: z.enum(MEMORY_KINDS).optional().describe("记忆分类，不确定就省略，会按内容自动判断"),
      }),
    },
  );

  const recallTool = tool(
    async ({ query }) => {
      try {
        const items = await searchMemories(memoriesDir, sessionId, query);
        if (items.length === 0) return "没有找到相关记忆。";
        return items
          .map((item) => `- [${MEMORY_KIND_LABELS[item.kind]}] [${item.id}] ${item.text}`)
          .join("\n");
      } catch (error) {
        return errorText(error);
      }
    },
    {
      name: "recall",
      description: "按相关度检索之前记住的内容。用户提到过去说过的事、或需要回忆偏好时调用。",
      schema: z.object({
        query: z.string().describe("检索内容；留空则返回全部记忆"),
      }),
    },
  );

  const listMemoriesTool = tool(
    async ({ kind }) => {
      try {
        const items = await readMemories(memoriesDir, sessionId);
        const filtered = kind ? items.filter((item) => item.kind === kind) : items;
        if (filtered.length === 0)
          return kind ? "这个分类下还没有记忆。" : "目前还没有记住任何事。";
        return filtered
          .slice(-50)
          .map((item) => `- [${MEMORY_KIND_LABELS[item.kind]}] [${item.id}] ${item.text}`)
          .join("\n");
      } catch (error) {
        return errorText(error);
      }
    },
    {
      name: "list_memories",
      description: `列出长期记忆（最多保留 ${MAX_MEMORIES} 条），可按分类筛选。`,
      schema: z.object({
        kind: z.enum(MEMORY_KINDS).optional().describe("只看某一类记忆，可省略"),
      }),
    },
  );

  const forgetMemoryTool = tool(
    async ({ idOrText }) => {
      try {
        const removed = await forgetMemory(memoriesDir, sessionId, idOrText);
        return removed ? `已忘记：${idOrText}` : `没有找到记忆：${idOrText}`;
      } catch (error) {
        return errorText(error);
      }
    },
    {
      name: "forget_memory",
      description: "删除一条长期记忆。用户让你忘掉某事时调用，参数可以是记忆编号或原文。",
      schema: z.object({
        idOrText: z.string().describe("记忆编号或原文"),
      }),
    },
  );

  const osWriteFileTool = tool(
    async ({ path: relativePath, content }) => {
      try {
        return await writeSandboxFile(sandboxRoot, relativePath, content);
      } catch (error) {
        return errorText(error);
      }
    },
    {
      name: "os_write_file",
      description:
        "把文本写入会话专属的本地沙箱文件。适合保存笔记、清单、草稿。路径是相对路径，如 notes/todo.md；单文件不超过 200KB。",
      schema: z.object({
        path: z.string().describe("沙箱内的相对路径"),
        content: z.string().describe("要写入的完整文本内容"),
      }),
    },
  );

  const osReadFileTool = tool(
    async ({ path: relativePath }) => {
      try {
        return await readSandboxFile(sandboxRoot, relativePath);
      } catch (error) {
        return errorText(error);
      }
    },
    {
      name: "os_read_file",
      description: "读取会话沙箱里的文本文件。",
      schema: z.object({
        path: z.string().describe("沙箱内的相对路径"),
      }),
    },
  );

  const osListFilesTool = tool(
    async ({ path: relativePath }) => {
      try {
        const entries = await listSandboxFiles(sandboxRoot, relativePath);
        if (entries.length === 0) return "目录为空。";
        return entries
          .map((entry) =>
            entry.type === "dir"
              ? `[目录] ${entry.name}`
              : `[文件] ${entry.name} (${entry.size ?? 0} 字节)`,
          )
          .join("\n");
      } catch (error) {
        return errorText(error);
      }
    },
    {
      name: "os_list_files",
      description: "列出会话沙箱里的文件和目录。不传路径则列出根目录。",
      schema: z.object({
        path: z.string().optional().describe("沙箱内的相对目录，可省略"),
      }),
    },
  );

  const osDeleteFileTool = tool(
    async ({ path: relativePath }) => {
      try {
        return await deleteSandboxPath(sandboxRoot, relativePath);
      } catch (error) {
        return errorText(error);
      }
    },
    {
      name: "os_delete_file",
      description: "删除会话沙箱里的文件或目录。仅在用户明确要求删除时调用。",
      schema: z.object({
        path: z.string().describe("沙箱内的相对路径"),
      }),
    },
  );

  const setLookIntervalTool = tool(
    async ({ seconds }) => {
      const intervalMs = clampVisionInterval(seconds * 1000);
      if (!setVisionInterval(sessionId, intervalMs)) {
        return "当前没有开启摄像头，观察频率无法调整。";
      }
      return `已把观察频率调整为每 ${intervalMs / 1000} 秒一帧。`;
    },
    {
      name: "set_look_interval",
      description:
        "决定下一次抓取摄像头画面的时间（抓帧间隔）。每轮回复都应调用一次：日常闲聊、画面没什么变化时用 20~60 秒；用户让你看仔细、帮你盯着、或画面正在变化时用 2~5 秒。范围 2~120 秒。",
      schema: z.object({
        seconds: z.number().min(2).max(120).describe("下一次隔多少秒抓一帧，2~120"),
      }),
    },
  );

  const createReminderTool = tool(
    async ({ text, delaySeconds, at }) => {
      try {
        const dueAt = delaySeconds
          ? new Date(Date.now() + delaySeconds * 1000).toISOString()
          : parseDueAt(at);
        if (!dueAt) {
          return "没有拿到有效的提醒时间，请给 delaySeconds 或 at（例如 2026-11-18T08:00:00+08:00）。";
        }
        if (new Date(dueAt).getTime() <= Date.now()) {
          return "这个时间已经过去了，请确认是今天还是明天。";
        }
        const item = await addReminder(remindersRoot, sessionId, {
          text,
          kind: "reminder",
          dueAt,
        });
        refreshReminderSession(sessionId);
        return `已设定：${formatDue(item.dueAt)}提醒你「${item.text}」。`;
      } catch (error) {
        return errorText(error);
      }
    },
    {
      name: "create_reminder",
      description:
        "设定到点提醒/闹钟。用户说「X 分钟后提醒我…」「明天早上八点叫我」「半小时后看看汤」时调用。相对时间用 delaySeconds（例如 10 分钟=600，2 小时=7200），绝对时间用 at（ISO 8601，带日期与时间）。",
      schema: z.object({
        text: z.string().describe("提醒内容，用用户的原话或简洁转述，例如「喝水」「出门带伞」"),
        delaySeconds: z
          .number()
          .min(1)
          .max(31_536_000)
          .optional()
          .describe("多久之后提醒，单位秒；与 at 二选一"),
        at: z
          .string()
          .optional()
          .describe("绝对时间，ISO 8601，例如 2026-11-18T08:00:00+08:00；与 delaySeconds 二选一"),
      }),
    },
  );

  const createTodoTool = tool(
    async ({ text }) => {
      try {
        const item = await addReminder(remindersRoot, sessionId, { text, kind: "todo" });
        refreshReminderSession(sessionId);
        return `已加入待办：「${item.text}」，编号 ${item.id}。`;
      } catch (error) {
        return errorText(error);
      }
    },
    {
      name: "create_todo",
      description:
        "添加一条没有时间的待办，例如「记一下明天要交报告」「把这件事加到待办」。用户没说时间时用这个，不要编造时间。",
      schema: z.object({
        text: z.string().describe("待办内容"),
      }),
    },
  );

  const listRemindersTool = tool(
    async () => {
      try {
        const items = await listPendingReminders(remindersRoot, sessionId);
        if (items.length === 0) return "目前没有待办或提醒。";
        return items.map((item) => `- ${describeReminder(item)}`).join("\n");
      } catch (error) {
        return errorText(error);
      }
    },
    {
      name: "list_reminders",
      description: "查看当前的提醒和待办。用户问「我有什么待办」「还有哪些提醒」时调用。",
      schema: z.object({}),
    },
  );

  const completeReminderTool = tool(
    async ({ idOrText }) => {
      try {
        const item = await completeReminder(remindersRoot, sessionId, idOrText);
        if (!item) return `没有找到未完成的条目：${idOrText}`;
        refreshReminderSession(sessionId);
        return `已完成：${item.text}`;
      } catch (error) {
        return errorText(error);
      }
    },
    {
      name: "complete_reminder",
      description:
        "把一条提醒或待办标记为完成。参数可以是编号或原文。用户说「做完了」「那个提醒不用了」时调用。",
      schema: z.object({
        idOrText: z.string().describe("提醒/待办的编号或原文"),
      }),
    },
  );

  const cancelReminderTool = tool(
    async ({ idOrText }) => {
      try {
        const item = await cancelReminder(remindersRoot, sessionId, idOrText);
        if (!item) return `没有找到要取消的条目：${idOrText}`;
        refreshReminderSession(sessionId);
        return `已取消：${item.text}`;
      } catch (error) {
        return errorText(error);
      }
    },
    {
      name: "cancel_reminder",
      description:
        "取消一条还没到的提醒或待办，不当作完成。用户说「取消那个提醒」「别提醒了」时调用，参数可以是编号或原文。",
      schema: z.object({
        idOrText: z.string().describe("提醒/待办的编号或原文"),
      }),
    },
  );

  const lookCloselyTool = tool(
    async ({ question }) => {
      try {
        const frame = getVisionFrame(sessionId);
        if (!frame) return "现在没有可用的摄像头画面，可能没开摄像头，或者画面太旧了。";
        const answer = await inspectFrame({
          config: options.config,
          imageBase64: frame.image,
          question,
        });
        return answer || "画面里看不清具体内容。";
      } catch (error) {
        return errorText(error);
      }
    },
    {
      name: "look_closely",
      description:
        "仔细看摄像头当前画面：读上面的文字、认出手里的物品、看表情或动作。用户说「看看这是什么」「上面写的什么」「帮我读一下」「我这样好看吗」时调用。画面只是背景时不要调用。",
      schema: z.object({
        question: z.string().optional().describe("想从画面里确认什么，例如「纸上写了什么字」"),
      }),
    },
  );

  const rememberVoiceTool = tool(
    async ({ name }) => {
      try {
        const { voiceprint } = options.config;
        if (!voiceprint.enabled) return "声纹功能现在没有开启。";
        if (!initVoiceprint(voiceprint.modelPath)) {
          return `声纹模型还没准备好：${voiceprintLoadError()}。先运行 pnpm voiceprint:model 下载模型。`;
        }
        const utterance = getLastUtterance(sessionId);
        if (!utterance) return "刚才没录到你的声音，先说一句话，再让我记住你的声音。";
        const embedding = extractEmbedding(utterance.audio, {
          modelPath: voiceprint.modelPath,
        });
        if (!embedding) {
          return "刚才的声音太短或太轻，说一句长一点、清楚一点的话，再让我记一次。";
        }
        const provided = name?.trim();
        const { profile, isNew } = await enrollVoiceprint(
          voiceprintDir(options.dataDir ?? DATA_DIR),
          sessionId,
          provided || "用户",
          embedding,
        );
        // 顺手从当前画面记一下长相，之后就能在画面里认人。
        void learnAppearanceFromFrame({
          config: options.config,
          sessionId,
          name: profile.name,
          dataDir: options.dataDir,
        }).catch(() => undefined);
        if (!isNew) return `又记住了一点你的声音，${profile.name}。`;
        return provided
          ? `好，我记住你的声音了，以后叫你${profile.name}。`
          : "好，我记住你的声音了。";
      } catch (error) {
        return errorText(error);
      }
    },
    {
      name: "remember_voice",
      description:
        "记住当前说话人的声音。用户说「记住我的声音」「记住我是谁」时调用；用户报了名字就传 name，没说就省略。需要用户已经说出一句完整的话。",
      schema: z.object({
        name: z
          .string()
          .max(MAX_VOICE_NAME_CHARS)
          .optional()
          .describe("用户希望被称呼的名字，没说就省略"),
      }),
    },
  );

  const listVoicesTool = tool(
    async () => {
      try {
        const profiles = await readVoiceprints(
          voiceprintDir(options.dataDir ?? DATA_DIR),
          sessionId,
        );
        if (profiles.length === 0) return "还没有记住任何人的声音。";
        return profiles
          .map((profile) => `- ${profile.name}（${profile.embeddings.length} 段声音样本）`)
          .join("\n");
      } catch (error) {
        return errorText(error);
      }
    },
    {
      name: "list_voices",
      description: `列出已经记住的声音（最多 ${MAX_VOICEPRINTS} 个人）。`,
      schema: z.object({}),
    },
  );

  const forgetVoiceTool = tool(
    async ({ nameOrId }) => {
      try {
        const removed = await removeVoiceprint(
          voiceprintDir(options.dataDir ?? DATA_DIR),
          sessionId,
          nameOrId,
        );
        return removed ? `已经不记得${nameOrId}的声音了。` : "没有找到这个人的声音记录。";
      } catch (error) {
        return errorText(error);
      }
    },
    {
      name: "forget_voice",
      description: "删掉某个人的声纹记录。用户说「别记我的声音了」「忘掉我的声音」时调用。",
      schema: z.object({
        nameOrId: z.string().describe("要删除的名字"),
      }),
    },
  );

  const rememberPersonTool = tool(
    async ({ name }) => {
      try {
        if (!getVisionFrame(sessionId)) return "现在没有摄像头画面，打开摄像头再试一次。";
        const appearance = await learnAppearanceFromFrame({
          config: options.config,
          sessionId,
          name,
          dataDir: options.dataDir,
        });
        if (!appearance) return "画面里看不清人，靠近一点、正对镜头再说一次。";
        return `记住了${name}的样子：${appearance}`;
      } catch (error) {
        return errorText(error);
      }
    },
    {
      name: "remember_person",
      description:
        "记住一个人的长相，之后能在摄像头画面里认出 TA。用户说「记住我长什么样」「记住这个人」时调用；name 用当前说话人的名字，不知道就先问一句。",
      schema: z.object({
        name: z.string().describe("这个人的名字"),
      }),
    },
  );

  const listPeopleTool = tool(
    async () => {
      try {
        const people = await readPeople(peopleDir(options.dataDir ?? DATA_DIR), sessionId);
        if (people.length === 0) return "还没有记住任何人的样子。";
        return people
          .map(
            (person) =>
              `- ${person.name}：${person.appearance ?? "还没记住样子"}${person.lastSpokeAt ? "（说过话）" : ""}`,
          )
          .join("\n");
      } catch (error) {
        return errorText(error);
      }
    },
    {
      name: "list_people",
      description: `列出记住的人以及他们的外貌特征（最多 ${MAX_PEOPLE} 个人）。`,
      schema: z.object({}),
    },
  );

  const forgetPersonTool = tool(
    async ({ nameOrId }) => {
      try {
        const removed = await removePerson(
          peopleDir(options.dataDir ?? DATA_DIR),
          sessionId,
          nameOrId,
        );
        return removed ? `已经不记得${nameOrId}的样子了。` : "没有找到这个人的记录。";
      } catch (error) {
        return errorText(error);
      }
    },
    {
      name: "forget_person",
      description: "删掉某个人的外貌记忆。用户说「别记我长什么样了」「忘了这个人」时调用。",
      schema: z.object({
        nameOrId: z.string().describe("要删除的名字"),
      }),
    },
  );

  return [
    getCurrentTimeTool,
    getWeatherTool,
    ...(options.config.search.enabled ? [webSearchTool] : []),
    createReminderTool,
    createTodoTool,
    listRemindersTool,
    completeReminderTool,
    cancelReminderTool,
    rememberTool,
    recallTool,
    listMemoriesTool,
    forgetMemoryTool,
    osWriteFileTool,
    osReadFileTool,
    osListFilesTool,
    osDeleteFileTool,
    setLookIntervalTool,
    lookCloselyTool,
    rememberVoiceTool,
    listVoicesTool,
    forgetVoiceTool,
    rememberPersonTool,
    listPeopleTool,
    forgetPersonTool,
  ];
}
