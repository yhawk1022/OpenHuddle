/**
 * @module protocol/auth
 * @description 人类邮箱+密码注册与登录、邮箱 6 位验证码核验、找回/修改密码、旧版 OTP 兼容、双层身份自省（`/api/v1/me`）及个人资料更新契约。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 同一 `/api/v1/me` 接口通过判别式 `callerKind`（`"human"` | `"agent"`）同时服务 Web 协作舱与本地 Agent CLI `whoami` 校验。
 * 2. 邮箱验证码用途严格隔离（`OtpPurpose`: `"register"` | `"password_reset"` | `"login"`），跨场景禁止复用。
 * 3. `HumanUserDto` 仅暴露 `emailVerified` / `hasPassword` 等脱敏布尔标记，严禁任何密码哈希或令牌摘要进入协议层。
 * 4. 开发或测试环境在未配置 SMTP 时允许回退 `devOtpCode` 实现零配置体验，生产环境严禁静默丢失验证码或泄露明文。
 */
import { z } from "zod";
import { AgentWakePolicySchema } from "./governance.js";
import {
  AgentPlatformSchema,
  AgentReachStateSchema,
  UserRoleSchema,
  UserStatusSchema,
} from "./identity.js";
import { AgentIdSchema, UserIdSchema } from "./ids.js";

/** 密码最小长度基线（对齐 NIST SP 800-63B） */
export const PASSWORD_MIN_LENGTH = 8;

/** 密码最大长度上限（防止超长口令触发 KDF CPU 拒绝服务攻击） */
export const PASSWORD_MAX_LENGTH = 128;

/**
 * 人类用户登录密码契约（8–128 位，不可全为空白字符）。
 */
export const PasswordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Password must be at least ${PASSWORD_MIN_LENGTH} characters`)
  .max(PASSWORD_MAX_LENGTH, `Password must be at most ${PASSWORD_MAX_LENGTH} characters`)
  .refine((val) => /\S/.test(val), "Password cannot be whitespace only");

/**
 * 6 位纯数字邮箱验证码契约。
 */
export const VerificationCodeSchema = z
  .string()
  .trim()
  .regex(/^\d{6}$/, "Verification code must be 6 digits");

/**
 * 邮箱验证码业务用途枚举（用于数据库查询级严格隔离，防止跨场景重放）。
 */
export const OtpPurposeSchema = z.enum(["register", "password_reset", "login"]);
export type OtpPurpose = z.infer<typeof OtpPurposeSchema>;

/**
 * 服务端验证码邮件投递通道模式。
 * - `smtp`：已配置真实 SMTP 中继（如阿里云 DirectMail SSL 465）
 * - `dev_echo`：开发/测试或显式允许回显模式，直接回传 `devOtpCode`
 * - `unavailable`：生产环境未配置 SMTP 且未开启回显，发信请求将明确返回 503
 */
export const EmailDeliveryModeSchema = z.enum(["smtp", "dev_echo", "unavailable"]);
export type EmailDeliveryMode = z.infer<typeof EmailDeliveryModeSchema>;

/**
 * 人类用户公开资料 DTO Schema（严禁包含 `password_hash` 等敏感字段）。
 */
export const HumanUserDtoSchema = z.object({
  id: UserIdSchema,
  email: z.string().email(),
  displayName: z.string().min(1).max(80),
  role: UserRoleSchema.default("user"),
  status: UserStatusSchema.default("active"),
  emailVerified: z.boolean().default(true),
  hasPassword: z.boolean().default(false),
  createdAtIso: z.string().datetime(),
});
export type HumanUserDto = z.infer<typeof HumanUserDtoSchema>;

/**
 * 归属于某个主人的 Agent 概览 DTO Schema（严禁包含任何密钥或哈希字段）。
 */
export const OwnedAgentSummaryDtoSchema = z.object({
  /** ADR-0002 主人私有唤醒策略（存于 agents.wake_config_json，主人可随时改写） */
  wakePolicy: AgentWakePolicySchema.optional(),
  id: AgentIdSchema,
  ownerUserId: UserIdSchema,
  displayName: z.string().min(1).max(80),
  slug: z.string().min(1).max(80),
  platform: AgentPlatformSchema,
  intro: z.string().max(280).optional(),
  /** ADR-0005：主人是否显式开启允许站内其他用户与该 Agent 进行 1v1 单聊（外部消息恒标记为 external_participant） */
  allowExternalDm: z.boolean().default(false),
  reach: AgentReachStateSchema,
  checkinIntervalMin: z.number().int().min(1).max(1_440).optional(),
  lastSeenAtIso: z.string().datetime().optional(),
  createdAtIso: z.string().datetime(),
});
export type OwnedAgentSummaryDto = z.infer<typeof OwnedAgentSummaryDtoSchema>;

/**
 * 面向未登录前端公开的认证策略与注册能力发现响应 Schema（零敏感信息）。
 */
export const AuthPublicConfigResponseSchema = z.object({
  ok: z.literal(true),
  allowPublicSignup: z.boolean(),
  allowedEmailDomains: z.array(z.string()),
  emailDeliveryMode: EmailDeliveryModeSchema,
  otpResendCooldownSec: z.number().int().nonnegative(),
  otpTtlSec: z.number().int().positive(),
  passwordMinLength: z.number().int().positive(),
});
export type AuthPublicConfigResponse = z.infer<typeof AuthPublicConfigResponseSchema>;

/**
 * 发送邮箱验证码（注册或重置密码）的通用成功响应体 Schema。
 */
export const AuthCodeSentResponseSchema = z.object({
  ok: z.literal(true),
  email: z.string().email(),
  expiresInSec: z.number().int().positive(),
  resendCooldownSec: z.number().int().nonnegative(),
  delivery: z.enum(["smtp", "dev_echo"]),
  devOtpCode: z.string().length(6).optional(),
});
export type AuthCodeSentResponse = z.infer<typeof AuthCodeSentResponseSchema>;

/**
 * 人类认证成功（注册、登录、重置密码或修改密码）统一会话签发响应体 Schema。
 */
export const AuthSessionResponseSchema = z.object({
  ok: z.literal(true),
  user: HumanUserDtoSchema,
  sessionToken: z.string().min(16),
});
export type AuthSessionResponse = z.infer<typeof AuthSessionResponseSchema>;

/**
 * 注册前请求发送 6 位邮箱激活验证码的请求体 Schema。
 */
export const RequestRegisterCodeBodySchema = z.object({
  email: z.string().trim().toLowerCase().email(),
});
export type RequestRegisterCodeBody = z.infer<typeof RequestRegisterCodeBodySchema>;

/**
 * 核验 6 位邮箱激活码并完成新用户注册的请求体 Schema。
 */
export const RegisterWithPasswordBodySchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  code: VerificationCodeSchema,
  displayName: z.string().trim().min(1).max(80),
  password: PasswordSchema,
});
export type RegisterWithPasswordBody = z.infer<typeof RegisterWithPasswordBodySchema>;

/**
 * 日常邮箱 + 密码登录请求体 Schema。
 */
export const LoginWithPasswordBodySchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
});
export type LoginWithPasswordBody = z.infer<typeof LoginWithPasswordBodySchema>;

/**
 * 忘记密码时请求发送 6 位邮箱重置验证码的请求体 Schema。
 */
export const RequestPasswordResetCodeBodySchema = z.object({
  email: z.string().trim().toLowerCase().email(),
});
export type RequestPasswordResetCodeBody = z.infer<typeof RequestPasswordResetCodeBodySchema>;

/**
 * 核验 6 位重置验证码并更新登录密码的请求体 Schema（同步吊销该账号全部历史设备会话）。
 */
export const ConfirmPasswordResetBodySchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  code: VerificationCodeSchema,
  newPassword: PasswordSchema,
});
export type ConfirmPasswordResetBody = z.infer<typeof ConfirmPasswordResetBodySchema>;

/**
 * 已登录人类修改密码（或早期无密码账号首次补设密码）请求体 Schema。
 */
export const ChangePasswordBodySchema = z.object({
  currentPassword: z.string().min(1).max(PASSWORD_MAX_LENGTH).optional(),
  newPassword: PasswordSchema,
});
export type ChangePasswordBody = z.infer<typeof ChangePasswordBodySchema>;

/**
 * [兼容旧版 OTP 路由] 请求发送 6 位邮箱登录验证码的请求体 Schema。
 */
export const RequestOtpBodySchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  displayName: z.string().trim().min(1).max(80).optional(),
});
export type RequestOtpBody = z.infer<typeof RequestOtpBodySchema>;

/**
 * [兼容旧版 OTP 路由] 请求发送验证码响应体 Schema。
 */
export const RequestOtpResponseSchema = z.object({
  ok: z.literal(true),
  email: z.string().email(),
  expiresInSec: z.number().int().positive(),
  resendCooldownSec: z.number().int().nonnegative().optional(),
  delivery: z.enum(["smtp", "dev_echo"]).optional(),
  devOtpCode: z.string().length(6).optional(),
});
export type RequestOtpResponse = z.infer<typeof RequestOtpResponseSchema>;

/**
 * [兼容旧版 OTP 路由] 校验 6 位邮箱验证码并签发人类会话的请求体 Schema。
 */
export const VerifyOtpBodySchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  code: VerificationCodeSchema,
  displayName: z.string().trim().min(1).max(80).optional(),
});
export type VerifyOtpBody = z.infer<typeof VerifyOtpBodySchema>;

/**
 * [兼容旧版 OTP 路由] 验证码登录成功响应体 Schema。
 */
export const VerifyOtpResponseSchema = AuthSessionResponseSchema;
export type VerifyOtpResponse = AuthSessionResponse;

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
