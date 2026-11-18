import { fileURLToPath } from "node:url";
import path from "node:path";

/** 服务端本地数据目录（记忆、沙箱文件），已在 .gitignore 中忽略。 */
export const DATA_DIR = process.env.COMPANION_DATA_DIR?.trim()
  ? path.resolve(process.env.COMPANION_DATA_DIR.trim())
  : fileURLToPath(new URL("../../data", import.meta.url));

/** 会话 ID 只允许安全字符，避免拼路径时逃出沙箱。 */
export function safeSessionId(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function sessionSandboxDir(sessionId: string, dataDir = DATA_DIR): string {
  return path.join(dataDir, "sandbox", safeSessionId(sessionId));
}

export function memoryDir(dataDir = DATA_DIR): string {
  return path.join(dataDir, "memory");
}
