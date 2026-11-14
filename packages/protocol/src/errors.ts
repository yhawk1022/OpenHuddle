/**
 * @module protocol/errors
 * @description 平台全局标准错误码、统一 HTTP 错误响应信封与穷尽检查工具。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 所有可预期的业务拦截（如 409 未读并发冲突、429 轮次预算挂起、403 非主人越权）均通过稳定枚举码暴露，方便 CLI 与外部 Agent 编程分支处理。
 * 2. 任何 HTTP 错误响应统一包含 `requestId`，确保可与服务端 Pino 结构化日志一一对应排障。
 */
import { z } from "zod";

/**
 * 平台级稳定业务与协议错误码枚举。
 */
export const ErrorCodeSchema = z.enum([
  "VALIDATION_ERROR",
  "UNAUTHORIZED",
  "FORBIDDEN_NOT_OWNER",
  "FORBIDDEN_NOT_ROOM_MEMBER",
  "NOT_FOUND",
  "PAIRING_CODE_INVALID_OR_EXPIRED",
  "AGENT_ALREADY_ACTIVE",
  "CONFLICT_UNREAD_MESSAGES",
  "GOVERNANCE_BUDGET_PAUSED",
  "GOVERNANCE_COOLDOWN_ACTIVE",
  "GOVERNANCE_ROUND_TABLE_WAIT",
  "MESSAGE_RECALL_WINDOW_EXPIRED",
  "ATTENTION_HUMAN_ONLY",
  "INTERNAL_SERVER_ERROR",
]);

/** 平台标准错误码联合类型 */
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

/**
 * 标准 API 失败响应信封 Schema。
 */
export const ApiErrorEnvelopeSchema = z.object({
  ok: z.literal(false),
  error: z.object({
    code: ErrorCodeSchema,
    message: z.string(),
    requestId: z.string(),
    details: z.unknown().optional(),
  }),
});

/** 标准 API 失败响应类型 */
export type ApiErrorEnvelope = z.infer<typeof ApiErrorEnvelopeSchema>;

/**
 * 编译期可辨识联合类型（Discriminated Union）穷尽检查断言辅助函数。
 *
 * @remarks
 * 当联合类型新增分支但 `switch` 未处理时，TypeScript 编译器会在此处直接报错，阻断漏处理分支上线。
 *
 * @param value - 理论上不可达的 `never` 值
 * @param message - 可选自定义异常描述
 * @throws {Error} 运行时意外命中的兜底保护异常
 */
export function assertNever(value: never, message?: string): never {
  throw new Error(message ?? `Unhandled discriminated union variant: ${JSON.stringify(value)}`);
}
