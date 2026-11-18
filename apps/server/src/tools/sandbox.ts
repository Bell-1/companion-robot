import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

/** 单个文件上限，超过则拒绝写入，避免模型把大文件塞进来。 */
export const MAX_FILE_BYTES = 200 * 1024;
/** 一次列目录最多返回的条目数。 */
const MAX_LIST_ENTRIES = 200;

/** 会话沙箱：所有路径都限制在 root 目录内，拒绝绝对路径与 .. 穿越。 */
export function resolveSandboxPath(root: string, input: string): string {
  const trimmed = input.trim().replace(/^\.\//, "");
  if (!trimmed) throw new Error("路径不能为空");
  if (path.isAbsolute(trimmed)) throw new Error("只支持沙箱内的相对路径，不要用绝对路径");
  if (trimmed.includes("\0")) throw new Error("路径包含非法字符");

  const normalized = path.normalize(trimmed);
  if (normalized === "." || normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
    throw new Error("路径越界：不允许访问沙箱外的文件");
  }

  const resolved = path.resolve(root, normalized);
  const rootWithSep = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (resolved !== root && !resolved.startsWith(rootWithSep)) {
    throw new Error("路径越界：不允许访问沙箱外的文件");
  }
  return resolved;
}

export async function writeSandboxFile(
  root: string,
  input: string,
  content: string,
): Promise<string> {
  const target = resolveSandboxPath(root, input);
  const size = Buffer.byteLength(content, "utf8");
  if (size > MAX_FILE_BYTES) {
    throw new Error(`文件太大（${size} 字节），单文件上限 ${MAX_FILE_BYTES} 字节`);
  }
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");
  return `已写入 ${input}（${size} 字节）`;
}

export async function readSandboxFile(root: string, input: string): Promise<string> {
  const target = resolveSandboxPath(root, input);
  const info = await stat(target);
  if (info.isDirectory()) throw new Error(`${input} 是目录，请用 os_list_files 查看`);
  if (info.size > MAX_FILE_BYTES) {
    throw new Error(`文件太大（${info.size} 字节），无法读取`);
  }
  return readFile(target, "utf8");
}

export async function listSandboxFiles(
  root: string,
  input = "",
): Promise<Array<{ name: string; type: "file" | "dir"; size?: number }>> {
  const target = input.trim() ? resolveSandboxPath(root, input) : root;
  const entries = await readdir(target, { withFileTypes: true });
  const result: Array<{ name: string; type: "file" | "dir"; size?: number }> = [];
  for (const entry of entries.slice(0, MAX_LIST_ENTRIES)) {
    if (entry.isDirectory()) {
      result.push({ name: entry.name, type: "dir" });
    } else {
      const info = await stat(path.join(target, entry.name)).catch(() => null);
      result.push({ name: entry.name, type: "file", size: info?.size });
    }
  }
  return result;
}

export async function deleteSandboxPath(root: string, input: string): Promise<string> {
  const target = resolveSandboxPath(root, input);
  await rm(target, { recursive: true, force: false });
  return `已删除 ${input}`;
}
