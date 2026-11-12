/**
 * @module server/app
 * @description OpenHuddle Hono 核心网关组装工厂（全局日志追踪、标准错误信封拦截、OpenAPI `/api/docs` 交互文档与各业务域路由挂载）。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 依赖显式注入：通过 `AppDependencies` 注入数据库连接、实时事件总线与配置，使集成测试可在零端口监听模式下直接调用 `app.request()` 秒级自验。
 * 2. 错误响应不泄露内部细节：未知异常在生产模式下隐藏原始堆栈，仅回传标准 `INTERNAL_SERVER_ERROR` 与 `requestId`。
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import type { ManagedDatabase } from "@openhuddle/db";
import type { ApiErrorEnvelope } from "@openhuddle/protocol";
import { Scalar } from "@scalar/hono-api-reference";
import { ZodError } from "zod";
import type { ServerEnv } from "./infra/env.js";
import { AppError } from "./infra/errors.js";
import { createRequestContextMiddleware, createRootLogger } from "./infra/logger.js";
import type { RealtimeBus } from "./infra/realtime-bus.js";
import { createSystemRouter } from "./modules/system/system.routes.js";

/**
 * 组装 Hono 应用所需的外部基础设施依赖。
 */
export interface AppDependencies {
  readonly env: ServerEnv;
  readonly database: ManagedDatabase;
  readonly realtimeBus: RealtimeBus;
}

/**
 * 创建并配置完整的 OpenHuddle HTTP / SSE / OpenAPI 应用实例。
 *
 * @param deps - 已初始化的环境配置、数据库与实时事件总线
 * @returns 类型完备的 `OpenAPIHono` 实例
 */
export function createServerApp(deps: Readonly<AppDependencies>): OpenAPIHono {
  const rootLogger = createRootLogger(deps.env.LOG_LEVEL);
  const app = new OpenAPIHono({
    defaultHook: (result) => {
      if (!result.success) {
        throw new AppError({
          code: "VALIDATION_ERROR",
          statusCode: 400,
          message: "Request payload or query parameters failed schema validation.",
          details: result.error.flatten(),
        });
      }
    },
  });

  app.use("*", createRequestContextMiddleware(rootLogger));

  // 挂载 v1 业务 API 子路由
  const apiV1 = new OpenAPIHono();
  apiV1.route(
    "/",
    createSystemRouter({
      databaseDriver: deps.database.driver,
      realtimeBusDriver: deps.env.REALTIME_BUS_DRIVER,
    }),
  );
  app.route("/api/v1", apiV1);

  // 自动暴露 OpenAPI 3.1 JSON 契约与在线交互调试面板 (/api/docs)
  app.doc("/api/openapi.json", {
    openapi: "3.1.0",
    info: {
      title: "OpenHuddle API",
      version: "0.1.0",
      description:
        "Multi-agent group huddle, governance state machine, and human decision platform API.",
    },
  });

  app.get(
    "/api/docs",
    Scalar({
      url: "/api/openapi.json",
    }),
  );

  app.notFound((c) => {
    const body: ApiErrorEnvelope = {
      ok: false,
      error: {
        code: "NOT_FOUND",
        message: `Route not found: ${c.req.method} ${c.req.path}`,
        requestId: c.get("requestId") ?? "unknown",
      },
    };
    return c.json(body, 404);
  });

  app.onError((err, c) => {
    const requestId = c.get("requestId") ?? "unknown";
    const log = c.get("logger") ?? rootLogger;

    if (err instanceof AppError) {
      log.warn({ code: err.code, details: err.details }, err.message);
      const body: ApiErrorEnvelope = {
        ok: false,
        error: {
          code: err.code,
          message: err.message,
          requestId,
          ...(err.details !== undefined ? { details: err.details } : {}),
        },
      };
      return c.json(body, err.statusCode);
    }

    if (err instanceof ZodError) {
      const body: ApiErrorEnvelope = {
        ok: false,
        error: {
          code: "VALIDATION_ERROR",
          message: "Request validation failed.",
          requestId,
          details: err.flatten(),
        },
      };
      return c.json(body, 400);
    }

    log.error({ err }, "Unhandled internal server exception");
    const body: ApiErrorEnvelope = {
      ok: false,
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message:
          deps.env.NODE_ENV === "production"
            ? "An unexpected internal server error occurred."
            : err.message,
        requestId,
      },
    };
    return c.json(body, 500);
  });

  return app;
}
