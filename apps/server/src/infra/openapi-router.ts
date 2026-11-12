/**
 * @module server/infra/openapi-router
 * @description 统一注入 Zod 校验错误转换钩子（`defaultHook`）的 `OpenAPIHono` 子路由工厂。
 *
 * 架构职责与关键不变量（Invariants）：
 * `@hono/zod-openapi` 的子路由实例不会自动继承父应用的 `defaultHook`；
 * 全站所有模块路由统一经本工厂创建，确保任意 Body / Query / Params 校验失败均抛出标准 `VALIDATION_ERROR (400)`。
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { AppError } from "./errors.js";

/**
 * 创建统一携带 `VALIDATION_ERROR` 校验拦截钩子的 `OpenAPIHono` 实例。
 *
 * @returns 配置好标准错误信封钩子的 `OpenAPIHono` 路由器
 */
export function createOpenApiRouter(): OpenAPIHono {
  return new OpenAPIHono({
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
}
