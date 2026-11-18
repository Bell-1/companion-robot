import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import basicSsl from "@vitejs/plugin-basic-ssl";

const useBasicSsl = process.env.VITE_HTTPS === "1";
const wsTarget = process.env.VITE_WS_TARGET ?? "ws://127.0.0.1:8787";

// 手机等非 localhost 设备必须通过 HTTPS 才能拿到麦克风权限。
// 优先使用 scripts/dev-cert.sh 生成的本地证书（根证书可装到手机，浏览器才会真正信任），
// 没有时再退回 VITE_HTTPS=1 的自签证书。
const certDir = fileURLToPath(new URL("../../certs", import.meta.url));
const hasLocalCert = existsSync(`${certDir}/dev.crt`) && existsSync(`${certDir}/dev.key`);
const https = hasLocalCert
  ? { cert: readFileSync(`${certDir}/dev.crt`), key: readFileSync(`${certDir}/dev.key`) }
  : undefined;

export default defineConfig({
  plugins: [react(), ...(useBasicSsl && !hasLocalCert ? [basicSsl()] : [])],
  server: {
    host: true,
    port: 5173,
    https,
    // 允许通过 ngrok / cloudflared 等隧道域名访问（iOS 真机麦克风需要 https）
    allowedHosts: [".ngrok-free.dev", ".ngrok-free.app", ".ngrok.io", ".trycloudflare.com"],
    proxy: {
      "/ws": {
        target: wsTarget,
        ws: true,
      },
      // 未开始对话时也要能读到助手名称等服务端配置。
      "/health": {
        target: wsTarget.replace(/^ws/, "http"),
      },
    },
  },
  optimizeDeps: {
    exclude: ["@companion/shared"],
  },
});
