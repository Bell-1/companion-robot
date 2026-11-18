import { existsSync, readFileSync } from "node:fs";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { MultiServerMCPClient } from "@langchain/mcp-adapters";
import type { Connection } from "@langchain/mcp-adapters";
import type { Config } from "../env";

let cached: Promise<StructuredToolInterface[]> | null = null;

interface McpConfigFile {
  mcpServers?: Record<string, Connection>;
}

/**
 * 加载 mcp.json 中配置的 MCP 服务工具。
 * 没有配置文件、配置为空或某个服务连不上时都只 skip，不影响主体对话。
 */
export function loadMcpTools(config: Config): Promise<StructuredToolInterface[]> {
  if (!cached) cached = load(config);
  return cached;
}

/** 测试或热更新时可清空缓存。 */
export function resetMcpToolsCache(): void {
  cached = null;
}

async function load(config: Config): Promise<StructuredToolInterface[]> {
  const configPath = config.mcp.configPath;
  if (!configPath || !existsSync(configPath)) return [];

  try {
    const raw = readFileSync(configPath, "utf8");
    const parsed = JSON.parse(raw) as McpConfigFile;
    const servers = parsed.mcpServers ?? {};
    const names = Object.keys(servers);
    if (names.length === 0) return [];

    const client = new MultiServerMCPClient({ servers, onConnectionError: "ignore" });
    const tools = await client.listTools();
    if (tools.length > 0) {
      console.log(
        `[mcp] 已从 ${configPath} 加载 ${tools.length} 个工具: ${tools
          .map((item) => item.name)
          .join(", ")}`,
      );
    }
    return tools;
  } catch (error) {
    console.warn(
      `[mcp] 加载失败，已跳过 MCP 工具: ${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  }
}
