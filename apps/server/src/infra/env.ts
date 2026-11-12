/**
 * @module server/infra/env
 * @description 服务端环境变量启动期快速失败（Fail-Fast）解析与类型校验模块。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 集中收敛：业务模块严禁直接读取裸 `process.env`，一律通过 `parseServerEnv()` 返回的只读强类型配置访问。
 * 2. 零配置友好默认：未指定 `DATABASE_URL` 时默认回退至嵌入式本地 `PGlite`，未指定总线时默认采用零内存开销的 `memory` 模式。
 */
import { z } from "zod";

/**
 * 服务端运行环境配置 Zod Schema。
 */
export const ServerEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  PUBLIC_BASE_URL: z.string().url().default("http://localhost:3000"),
  DATABASE_URL: z.string().min(1).default("file://./.data/pglite"),
  REALTIME_BUS_DRIVER: z.enum(["memory", "postgres"]).default("memory"),
  AUTH_SECRET: z.string().min(16).default("dev-only-insecure-secret-change-in-production-32chars"),
});

/** 服务端强类型只读运行环境配置 */
export type ServerEnv = Readonly<z.infer<typeof ServerEnvSchema>>;

/**
 * 校验并冻结服务端环境变量配置；若生产环境缺少关键合法参数则立即抛出异常阻断脏启动。
 *
 * @param rawEnv - 待解析的环境变量字典（默认读取 `process.env`）
 * @returns 校验通过的只读 `ServerEnv` 对象
 */
export function parseServerEnv(
  rawEnv: Readonly<Record<string, string | undefined>> = process.env,
): ServerEnv {
  const parsed = ServerEnvSchema.parse(rawEnv);
  if (
    parsed.NODE_ENV === "production" &&
    parsed.AUTH_SECRET.startsWith("dev-only-insecure-secret")
  ) {
    throw new Error("Refusing to start in production with default insecure AUTH_SECRET.");
  }
  return Object.freeze(parsed);
}
