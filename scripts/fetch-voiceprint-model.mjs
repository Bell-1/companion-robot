/**
 * 下载本地声纹模型（CAM++ 中文/英文，192 维）。
 * 默认走 HuggingFace 镜像，失败时依次尝试官方站与 GitHub Release。
 */
import { createWriteStream, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const modelsDir = path.join(root, "apps/server/models");
const fileName = "3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx";
const target = path.join(modelsDir, fileName);
const minSize = 20 * 1024 * 1024;

const sources = [
  `https://hf-mirror.com/csukuangfj/speaker-embedding-models/resolve/main/${fileName}`,
  `https://huggingface.co/csukuangfj/speaker-embedding-models/resolve/main/${fileName}`,
  `https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/${fileName}`,
];

if (existsSync(target) && statSync(target).size >= minSize) {
  console.log(`声纹模型已存在：${target}`);
  process.exit(0);
}

mkdirSync(modelsDir, { recursive: true });

for (const url of sources) {
  const temp = `${target}.download`;
  try {
    console.log(`下载声纹模型：${url}`);
    const response = await fetch(url, { redirect: "follow" });
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(temp));
    const size = statSync(temp).size;
    if (size < minSize) throw new Error(`文件不完整（${size} 字节）`);
    renameSync(temp, target);
    console.log(`已保存：${target}（${(size / 1024 / 1024).toFixed(1)} MB）`);
    process.exit(0);
  } catch (error) {
    console.warn(`下载失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

console.error("所有下载源都失败了，请手动下载模型放到 apps/server/models/ 下。");
process.exit(1);
