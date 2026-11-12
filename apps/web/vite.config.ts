/**
 * @module web/vite-config
 * @description Vite 6 前端构建分包优化与本地开发同源反向代理配置。
 *
 * 架构职责与关键不变量：
 * 1. 开发期将 `/api` 及外部 Agent 自举入口（`/install.md`、`/skill.md`、`/openhuddle.mjs`）同源代理至本地 Hono 后端（`localhost:3000`），与生产环境同端口静态托管保持零 CORS 一致性。
 * 2. 生产期将 React、TanStack Query、Markdown 引擎与图标库稳定分块，充分利用 HTTP 强缓存并保持单包轻快。
 */
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) {
            return undefined;
          }
          if (id.includes("react-markdown") || id.includes("remark-") || id.includes("micromark")) {
            return "vendor-markdown";
          }
          if (id.includes("@tanstack")) {
            return "vendor-query";
          }
          if (id.includes("lucide-react")) {
            return "vendor-icons";
          }
          if (id.includes("react-dom") || id.includes("/react/")) {
            return "vendor-react";
          }
          return undefined;
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
      "/install.md": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
      "/skill.md": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
      "/openhuddle.mjs": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
    },
  },
});
