/**
 * @module root/vitest-config
 * @description 全仓 Vitest 统一测试编排配置。
 *
 * 架构职责与关键不变量：
 * 1. 聚合 packages/* 与 apps/server 的纯函数状态机单测与基于内存态 PGlite 的并发集成测试。
 * 2. 通过源码级路径别名支持未预编译状态下直接运行 `pnpm test`，所有测试零外部容器依赖。
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const rootDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@openhuddle/protocol": resolve(rootDir, "packages/protocol/src/index.ts"),
      "@openhuddle/core-governance": resolve(rootDir, "packages/core-governance/src/index.ts"),
      "@openhuddle/db": resolve(rootDir, "packages/db/src/index.ts"),
      "@openhuddle/mcp": resolve(rootDir, "packages/mcp/src/index.ts"),
    },
  },
  test: {
    include: ["packages/*/src/**/*.test.ts", "apps/server/src/**/*.test.ts"],
    environment: "node",
    testTimeout: 15_000,
    hookTimeout: 15_000,
    passWithNoTests: false,
  },
});
