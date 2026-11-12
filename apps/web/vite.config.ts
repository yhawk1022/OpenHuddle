/**
 * @module web/vite-config
 * @description Vite 6 前端构建与本地开发反向代理配置。
 *
 * 架构职责与关键不变量：
 * 1. 开发期将 `/api` 同源代理至本地 Hono 后端（`localhost:3000`），与生产环境同端口静态托管保持零 CORS 一致性。
 */
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
    },
  },
});
