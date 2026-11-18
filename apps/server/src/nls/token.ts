import { createRequire } from "node:module";
import type { Config } from "../env";

const require = createRequire(import.meta.url);
const { RPCClient } = require("@alicloud/pop-core") as {
  RPCClient: new (options: {
    accessKeyId: string;
    accessKeySecret: string;
    endpoint: string;
    apiVersion: string;
  }) => { request: (action: string) => Promise<NlsTokenResult> };
};

interface NlsTokenResult {
  Token?: { Id?: string; ExpireTime?: number };
  Code?: string;
  Message?: string;
}

let cached: { token: string; expiresAt: number } | null = null;
let pending: Promise<string> | null = null;

/** 用 AccessKey 换取 NLS 临时 Token，24 小时有效，提前 10 分钟刷新。 */
export async function getNlsToken(config: Config): Promise<string> {
  const now = Date.now();
  if (cached && cached.expiresAt - now > 10 * 60_000) return cached.token;
  if (pending) return pending;

  pending = (async () => {
    const client = new RPCClient({
      accessKeyId: config.nls.accessKeyId,
      accessKeySecret: config.nls.accessKeySecret,
      endpoint: "http://nls-meta.cn-shanghai.aliyuncs.com",
      apiVersion: "2019-02-28",
    });
    const result = await client.request("CreateToken");
    const token = result.Token?.Id;
    if (!token) {
      throw new Error(`NLS Token 获取失败: ${result.Code ?? ""} ${result.Message ?? "未知错误"}`);
    }
    const expiresAt = result.Token?.ExpireTime
      ? result.Token.ExpireTime * 1000
      : now + 23 * 3600_000;
    cached = { token, expiresAt };
    return token;
  })();

  try {
    return await pending;
  } finally {
    pending = null;
  }
}

export function resetNlsToken(): void {
  cached = null;
}
