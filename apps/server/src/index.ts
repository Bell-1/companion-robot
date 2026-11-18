import Fastify from "fastify";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { RawData } from "ws";
import { assertConfig, loadConfig } from "./env";
import { VoiceSession } from "./session/session";

const config = loadConfig();
const missing = assertConfig(config);
if (missing.length > 0) {
  console.warn(`[companion] 缺少环境变量: ${missing.join(", ")}，语音与模型调用会失败。`);
}

const app = Fastify({ logger: false });

await app.register(websocket);

// 生产模式：若前端已构建，则由同一个端口直接托管静态产物。
const webDist = fileURLToPath(new URL("../../web/dist", import.meta.url));
if (existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist });
  app.setNotFoundHandler((request, reply) => {
    if (request.raw.url?.startsWith("/ws") || request.raw.url?.startsWith("/health")) {
      void reply.code(404).send({ error: "not found" });
      return;
    }
    void reply.sendFile("index.html");
  });
  console.log(`[companion] 已托管前端产物: ${webDist}`);
}

app.get("/health", async () => ({
  ok: missing.length === 0,
  missing,
  assistantName: config.assistant.name,
  asr: "NLS SpeechTranscriber",
  tts: `NLS SpeechSynthesizer / ${config.nls.ttsVoice}`,
  llmModel: config.deepseek.model,
}));

app.get("/ws", { websocket: true }, (socket) => {
  const send = (payload: unknown) => {
    if (socket.readyState === 1)
      socket.send(typeof payload === "string" ? payload : JSON.stringify(payload));
  };

  const session = new VoiceSession(
    {
      sendEvent: (event) => send(event),
      sendAudio: (chunk) => {
        if (socket.readyState === 1) socket.send(chunk);
      },
    },
    config,
  );

  socket.on("message", (data: RawData, isBinary: boolean) => {
    try {
      if (isBinary) {
        session.handleAudio(toBuffer(data));
        return;
      }
      const text = data.toString();
      if (!text) return;
      session.handleClientEvent(JSON.parse(text));
    } catch (error) {
      send({
        type: "error",
        code: "bad_request",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  socket.on("close", () => session.close());
  socket.on("error", () => session.close());
});

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data as ArrayBuffer);
}

await app.listen({ port: config.port, host: "0.0.0.0" });
console.log(`[companion] WebSocket 服务已启动: ws://localhost:${config.port}/ws`);
