/**
 * @module server/infra/errors
 * @description 服务端统一可预期业务异常（`AppError`）层级定义。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 严格区分「可预期业务拦截（Operational Error）」与「未知运行时故障（Bug）」。
 * 2. 所有业务错误强制绑定 `@openhuddle/protocol` 中的稳定 `ErrorCode` 与精确 HTTP 状态码，由全局 `app.onError` 统一序列化。
 */
import type { ErrorCode } from "@openhuddle/protocol";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/**
 * 构造 `AppError` 所需的配置项。
 */
export interface AppErrorOptions {
  readonly code: ErrorCode;
  readonly statusCode: ContentfulStatusCode;
  readonly message: string;
  readonly details?: unknown;
}

/**
 * 携带标准协议错误码与 HTTP 状态码的可预期业务异常基类。
 */
export class AppError extends Error {
  public readonly code: ErrorCode;
  public readonly statusCode: ContentfulStatusCode;
  public readonly details: unknown;

  /**
   * @param options - 错误码、HTTP 状态码、人类可读消息与可选结构化附加信息（如 409 错失消息列表）
   */
  public constructor(options: Readonly<AppErrorOptions>) {
    super(options.message);
    this.name = "AppError";
    this.code = options.code;
    this.statusCode = options.statusCode;
    this.details = options.details;
  }
}
