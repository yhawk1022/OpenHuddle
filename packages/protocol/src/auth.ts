/**
 * @module protocol/auth
 * @description 人类邮箱验证码认证（OTP）、双层身份自省（`/api/v1/me`）与个人资料更新契约。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 同一 `/api/v1/me` 接口通过判别式 `callerKind`（`"human"` | `"agent"`）同时服务 Web 协作舱与本地 Agent CLI `whoami` 校验。
 * 2. 开发或测试环境可选返回 `devOtpCode` 实现零配置一键登录，生产环境严格隐藏验证码明文。
 */
import { z } from "zod";
import { AgentPlatformSchema, AgentReachStateSchema } from "./identity.js";
import { AgentIdSchema, UserIdSchema } from "./ids.js";

/**
 * 人类用户公开资料 DTO Schema。
 */
export const HumanUserDtoSchema = z.object({
  id: UserIdSchema,
  email: z.string().email(),
  displayName: z.string().min(1).max(80),
  createdAtIso: z.string().datetime(),
});
export type HumanUserDto = z.infer<typeof HumanUserDtoSchema>;

/**
 * 归属于某个主人的 Agent 概览 DTO Schema（严禁包含任何密钥或哈希字段）。
 */
export const OwnedAgentSummaryDtoSchema = z.object({
  id: AgentIdSchema,
  ownerUserId: UserIdSchema,
  displayName: z.string().min(1).max(80),
  slug: z.string().min(1).max(80),
  platform: AgentPlatformSchema,
  intro: z.string().max(280).optional(),
  reach: AgentReachStateSchema,
  checkinIntervalMin: z.number().int().min(1).max(1_440).optional(),
  lastSeenAtIso: z.string().datetime().optional(),
  createdAtIso: z.string().datetime(),
});
export type OwnedAgentSummaryDto = z.infer<typeof OwnedAgentSummaryDtoSchema>;

/**
 * 请求发送 6 位邮箱登录验证码的请求体 Schema。
 */
export const RequestOtpBodySchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  displayName: z.string().trim().min(1).max(80).optional(),
});
export type RequestOtpBody = z.infer<typeof RequestOtpBodySchema>;

/**
 * 请求发送验证码响应体 Schema。
 */
export const RequestOtpResponseSchema = z.object({
  ok: z.literal(true),
  email: z.string().email(),
  expiresInSec: z.number().int().positive(),
  devOtpCode: z.string().length(6).optional(),
});
export type RequestOtpResponse = z.infer<typeof RequestOtpResponseSchema>;

/**
 * 校验 6 位邮箱验证码并签发人类会话的请求体 Schema。
 */
export const VerifyOtpBodySchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, "OTP code must be 6 digits"),
  displayName: z.string().trim().min(1).max(80).optional(),
});
export type VerifyOtpBody = z.infer<typeof VerifyOtpBodySchema>;

/**
 * 验证码登录成功响应体 Schema。
 */
export const VerifyOtpResponseSchema = z.object({
  ok: z.literal(true),
  user: HumanUserDtoSchema,
  sessionToken: z.string().min(16),
});
export type VerifyOtpResponse = z.infer<typeof VerifyOtpResponseSchema>;

/**
 * `GET /api/v1/me` 双模态身份自省响应可辨识联合 Schema。
 */
export const MeResponseSchema = z.discriminatedUnion("callerKind", [
  z.object({
    ok: z.literal(true),
    callerKind: z.literal("human"),
    user: HumanUserDtoSchema,
    agents: z.array(OwnedAgentSummaryDtoSchema),
  }),
  z.object({
    ok: z.literal(true),
    callerKind: z.literal("agent"),
    agent: OwnedAgentSummaryDtoSchema,
    owner: HumanUserDtoSchema,
    siblingAgents: z.array(OwnedAgentSummaryDtoSchema),
  }),
]);
export type MeResponse = z.infer<typeof MeResponseSchema>;

/**
 * `PATCH /api/v1/me` 更新当前主体展示名称、简介或巡检周期请求体 Schema。
 */
export const UpdateMeBodySchema = z.object({
  displayName: z.string().trim().min(1).max(80).optional(),
  intro: z.string().trim().max(280).optional(),
  checkinIntervalMin: z.number().int().min(1).max(1_440).optional(),
});
export type UpdateMeBody = z.infer<typeof UpdateMeBodySchema>;
