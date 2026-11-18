import assert from "node:assert/strict";
import { test } from "node:test";
import { searchEndpoint, searchWeb } from "./search";

const config = {
  enabled: true,
  apiKey: "sk-test",
  baseUrl: "https://api.deepseek.com/v1",
  count: 5,
};

test("搜索地址：兼容带不带 /v1 的 Base URL", () => {
  assert.equal(
    searchEndpoint("https://api.deepseek.com/v1"),
    "https://api.deepseek.com/v1/tools/search",
  );
  assert.equal(
    searchEndpoint("https://api.deepseek.com/v1/"),
    "https://api.deepseek.com/v1/tools/search",
  );
  assert.equal(
    searchEndpoint("https://api.deepseek.com"),
    "https://api.deepseek.com/v1/tools/search",
  );
});

test("联网搜索：带鉴权请求并整理结果", async () => {
  let calledUrl = "";
  let calledInit: RequestInit | undefined;
  const fakeFetch = (async (url: string, init?: RequestInit) => {
    calledUrl = url;
    calledInit = init;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        results: [
          {
            title: "DeepSeek V4.1 发布",
            url: "https://example.com/a",
            summary: "摘要内容",
            site_name: "示例新闻",
            date: "2026-11-15T00:00:00Z",
          },
          { title: "第二条", url: "https://example.com/b", snippet: "短摘要" },
        ],
      }),
    };
  }) as unknown as typeof fetch;

  const text = await searchWeb(config, "DeepSeek V4.1", 3, fakeFetch);

  assert.equal(calledUrl, "https://api.deepseek.com/v1/tools/search");
  assert.equal((calledInit?.headers as Record<string, string>).Authorization, "Bearer sk-test");
  assert.deepEqual(JSON.parse(String(calledInit?.body)), {
    query: "DeepSeek V4.1",
    count: 3,
    need_content: false,
  });
  assert.match(text, /DeepSeek V4\.1 发布/);
  assert.match(text, /示例新闻 · 2026-11-15/);
  assert.match(text, /https:\/\/example\.com\/a/);
  assert.match(text, /短摘要/);
});

test("联网搜索：没有结果时给出可执行的提示", async () => {
  const fakeFetch = (async () => ({
    ok: true,
    status: 200,
    json: async () => ({ results: [] }),
  })) as unknown as typeof fetch;
  const text = await searchWeb(config, "不存在的关键词", undefined, fakeFetch);
  assert.match(text, /没有搜到/);
});

test("联网搜索：HTTP 失败时抛出错误", async () => {
  const fakeFetch = (async () => ({ ok: false, status: 429 })) as unknown as typeof fetch;
  await assert.rejects(() => searchWeb(config, "测试", undefined, fakeFetch), /429/);
});
