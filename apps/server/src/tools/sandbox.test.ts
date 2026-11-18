import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  deleteSandboxPath,
  listSandboxFiles,
  readSandboxFile,
  resolveSandboxPath,
  writeSandboxFile,
} from "./sandbox";

async function withRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "companion-sandbox-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("沙箱路径：拒绝 .. 穿越与绝对路径", async () => {
  await withRoot(async (root) => {
    assert.throws(() => resolveSandboxPath(root, "../secret.txt"), /越界/);
    assert.throws(() => resolveSandboxPath(root, "a/../../secret.txt"), /越界/);
    assert.throws(() => resolveSandboxPath(root, "/etc/passwd"), /绝对路径/);
    assert.throws(() => resolveSandboxPath(root, ""), /不能为空/);

    const ok = resolveSandboxPath(root, "notes/todo.md");
    assert.equal(ok, path.join(root, "notes/todo.md"));
  });
});

test("沙箱文件：写入后可读回并列出", async () => {
  await withRoot(async (root) => {
    await writeSandboxFile(root, "notes/todo.md", "买牛奶");
    assert.equal(await readSandboxFile(root, "notes/todo.md"), "买牛奶");

    const entries = await listSandboxFiles(root, "notes");
    assert.deepEqual(
      entries.map((entry) => entry.name),
      ["todo.md"],
    );
  });
});

test("沙箱文件：超过 200KB 拒绝写入", async () => {
  await withRoot(async (root) => {
    const big = "a".repeat(200 * 1024 + 1);
    await assert.rejects(writeSandboxFile(root, "big.txt", big), /上限/);
  });
});

test("沙箱文件：删除后不可读", async () => {
  await withRoot(async (root) => {
    await writeSandboxFile(root, "temp.txt", "临时");
    await deleteSandboxPath(root, "temp.txt");
    await assert.rejects(readSandboxFile(root, "temp.txt"));
  });
});
