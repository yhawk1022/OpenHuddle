/**
 * @module server/infra/logger
 * @description 基于 Pino 的结构化 JSON 日志器与请求链路追踪（`requestId`）Hono 中间件。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 服务端全面禁用 `console.log`，所有日志输出结构化 JSON，便于排障多 Agent 并发唤醒链路。
 * 2. 每个进入网关的 HTTP/SSE 请求自动分配或透传 `x-request-id`，并绑定到子 Logger 与响应头上。
 */
import { randomUUID } from "node:crypto";
import { createMiddleware } from "hono/factory";
import pino, { type Logger } from "pino";

/**
 * 扩展 Hono 请求上下文中的强类型变量映射。
 */
declare module "hono" {
  interface ContextVariableMap {
    requestId: string;
    logger: Logger;
  }
}

/**
 * 创建根 Pino 结构化日志实例。
 *
 * @param level - 日志输出最低级别
 * @returns 配置完成的 Pino `Logger`
 */
export function createRootLogger(level: string): Logger {
  return pino({
    level,
    base: { service: "openhuddle-server" },
  });
}

/**
 * 创建自动注入 `requestId` 与请求级子 Logger 的 Hono 中间件。
 *
 * @param rootLogger - 服务端根日志实例
 * @returns Hono 中间件处理器
 */
export function createRequestContextMiddleware(rootLogger: Logger) {
  return createMiddleware(async (c, next) => {
    const incomingId = c.req.header("x-request-id")?.trim();
    const requestId = incomingId && incomingId.length <= 64 ? incomingId : randomUUID();

    const childLogger = rootLogger.child({
      requestId,
      method: c.req.method,
      path: c.req.path,
    });

    c.set("requestId", requestId);
    c.set("logger", childLogger);
    c.header("x-request-id", requestId);

    const startMs = performance.now();
    await next();
    const durationMs = Math.round(performance.now() - startMs);

    childLogger.info({ status: c.res.status, durationMs }, "http.request.completed");
  });
}
