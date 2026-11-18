/**
 * 联网搜索：直接调用 DeepSeek Search API。
 * 和对话模型共用同一套 API Key 与 Base URL，不需要额外的搜索服务。
 */

const TIMEOUT_MS = 10_000;
const MAX_SUMMARY_CHARS = 320;

export interface SearchConfig {
  enabled: boolean;
  apiKey: string;
  baseUrl: string;
  /** 默认返回条数。 */
  count: number;
}

interface SearchApiItem {
  title?: string;
  url?: string;
  snippet?: string;
  summary?: string;
  site_name?: string | null;
  date?: string | null;
}

interface SearchApiResponse {
  results?: SearchApiItem[];
}

/** Base URL 可能带或不带 /v1，统一拼成搜索接口地址。 */
export function searchEndpoint(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, "");
  return base.endsWith("/v1") ? `${base}/tools/search` : `${base}/v1/tools/search`;
}

function clip(text: string | undefined, max: number): string {
  if (!text) return "";
  const value = text.trim().replace(/\s+/g, " ");
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/**
 * 搜索网页并整理成模型可直接阅读的纯文本。
 * 失败时抛出带原因的错误，由工具层转成口语化提示。
 */
export async function searchWeb(
  config: SearchConfig,
  query: string,
  count?: number,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const trimmed = query.trim();
  if (!trimmed) throw new Error("搜索词不能为空");
  if (!config.apiKey) throw new Error("没有配置 DEEPSEEK_API_KEY，无法联网搜索");

  const limit = Math.min(Math.max(Math.round(count ?? config.count), 1), 10);
  const response = await fetchImpl(searchEndpoint(config.baseUrl), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query: trimmed, count: limit, need_content: false }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!response.ok) throw new Error(`联网搜索失败（HTTP ${response.status}）`);
  const data = (await response.json()) as SearchApiResponse;
  const results = (data.results ?? []).filter(
    (item) => item && typeof item.title === "string" && item.title.trim(),
  );
  if (results.length === 0) return "没有搜到相关结果，可以换个说法再搜，或者直接告诉用户没查到。";

  const lines = results.map((item, index) => {
    const meta = [item.site_name, item.date?.slice(0, 10)].filter(Boolean).join(" · ");
    const summary = clip(item.summary || item.snippet, MAX_SUMMARY_CHARS);
    const head = `${index + 1}. ${item.title}${meta ? `（${meta}）` : ""}`;
    const url = item.url ? `\n${item.url}` : "";
    return `${head}\n${summary}${url}`;
  });

  return `联网搜索结果：\n${lines.join("\n\n")}`;
}
