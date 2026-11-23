/**
 * @module server/modules/auth/service
 * @description 双层身份认证（Human Email+Password + SMTP 邮箱核验 + Legacy OTP 兼容 + Agent Bearer Token）与 `/api/v1/me` 自省编排服务。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 双模态凭据严格分流：`oh_ses_` 前缀仅解析为 `kind: "human"`，`oh_agt_` 前缀仅解析为 `kind: "agent"`，两套命名空间物理隔离。
 * 2. 密码与验证码安全边界：密码使用异步 `scrypt` 随机盐哈希存储，登录恒定时间防账号枚举；6 位验证码严格按 `purpose` 隔离、恒定时间比对、错误 5 次自动熔断并在事务内原子核销。
 * 3. 注册准入与防刷护栏：受 `ALLOW_PUBLIC_SIGNUP`、`ALLOWED_EMAIL_DOMAINS` 约束，叠加 IP 滑动窗口限流、数据库级 60 秒重发冷却与每邮箱每小时发送上限；SMTP 失败自动回滚验证码记录。
 * 4. 改密全端失效：重置密码与主动修改密码均在同一事务内清空该账号全部旧 `user_sessions` 并签发全新会话令牌。
 */
import type {
  AuthCodeSentResponse,
  AuthPublicConfigResponse,
  AuthSessionResponse,
  AuthenticatedCaller,
  ChangePasswordBody,
  ConfirmPasswordResetBody,
  EmailDeliveryMode,
  LoginWithPasswordBody,
  MeResponse,
  OtpPurpose,
  RegisterWithPasswordBody,
  RequestOtpBody,
  RequestOtpResponse,
  RequestPasswordResetCodeBody,
  RequestRegisterCodeBody,
  UpdateMeBody,
  VerifyOtpBody,
  VerifyOtpResponse,
} from "@openhuddle/protocol";
import type { Logger } from "pino";
import { assertHumanCaller } from "../../infra/auth-middleware.js";
import {
  constantTimeEqualHex,
  generateOtpCode,
  generatePrefixedId,
  generateSessionToken,
  generateUserId,
  getDummyPasswordHash,
  hashPasswordScrypt,
  sha256Hex,
  verifyPasswordScrypt,
} from "../../infra/crypto.js";
import { renderVerificationEmail } from "../../infra/email-templates.js";
import { type ServerEnv, parseAdminEmailSet, parseAllowedEmailDomainSet } from "../../infra/env.js";
import { AppError } from "../../infra/errors.js";
import type { EmailMailer } from "../../infra/mailer.js";
import type { SlidingWindowRateLimiter } from "../../infra/rate-limiter.js";
import type { RealtimeBus } from "../../infra/realtime-bus.js";
import {
  type AuthRepository,
  type OtpVerificationRecord,
  mapAgentRecordToSummaryDto,
} from "./auth.repo.js";

/** 邮箱 6 位验证码有效期（10 分钟） */
export const OTP_TTL_SEC = 600;

/** 单条验证码允许的最大连续输错次数（达上限立即作废防爆破） */
export const MAX_OTP_ATTEMPTS = 5;

/** 单个邮箱每小时允许申请验证码的最大次数（跨用途合并统计防轰炸） */
const MAX_OTP_PER_EMAIL_PER_HOUR = 10;

/** 认证限流滑动窗口（15 分钟） */
const AUTH_RATE_WINDOW_MS = 15 * 60_000;

/** 单 IP 在 15 分钟内请求发送验证码上限 */
const MAX_CODE_REQUESTS_PER_IP = 20;

/** 单 IP 在 15 分钟内提交验证码校验上限 */
const MAX_CODE_VERIFIES_PER_IP = 25;

/** 单 IP 在 15 分钟内密码登录请求总上限 */
const MAX_LOGIN_REQUESTS_PER_IP = 40;

/** 同一 `(IP, email)` 在 15 分钟内允许的密码失败次数上限 */
const MAX_LOGIN_FAILURES_PER_IP_EMAIL = 10;

/** Web 登录会话有效期（30 天，与 Cookie `Max-Age=2592000` 对齐） */
export const SESSION_TTL_SEC = 2_592_000;

/**
 * 构造 `AuthService` 所需的依赖。
 */
export interface AuthServiceDeps {
  readonly repo: AuthRepository;
  readonly env: ServerEnv;
  readonly realtimeBus: RealtimeBus;
  readonly mailer: EmailMailer;
  readonly rateLimiter: SlidingWindowRateLimiter;
  readonly logger: Logger;
}

function isPgUniqueViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) {
    return false;
  }
  const directCode = (err as { readonly code?: unknown }).code;
  if (directCode === "23505") {
    return true;
  }
  const cause = (err as { readonly cause?: unknown }).cause;
  if (typeof cause === "object" && cause !== null) {
    return (cause as { readonly code?: unknown }).code === "23505";
  }
  return false;
}

/**
 * 人类与个人 Agent 统一认证及资料编排服务。
 */
export class AuthService {
  private readonly repo: AuthRepository;
  private readonly env: ServerEnv;
  private readonly realtimeBus: RealtimeBus;
  private readonly mailer: EmailMailer;
  private readonly rateLimiter: SlidingWindowRateLimiter;
  private readonly logger: Logger;

  /**
   * @param deps - 认证仓储、环境配置、实时事件总线、SMTP 投递器、限流器与日志实例
   */
  public constructor(deps: Readonly<AuthServiceDeps>) {
    this.repo = deps.repo;
    this.env = deps.env;
    this.realtimeBus = deps.realtimeBus;
    this.mailer = deps.mailer;
    this.rateLimiter = deps.rateLimiter;
    this.logger = deps.logger;
  }

  /**
   * 计算当前运行环境下的验证码投递模式（`smtp` | `dev_echo` | `unavailable`）。
   */
  public getEmailDeliveryMode(): EmailDeliveryMode {
    if (this.mailer.isConfigured) {
      return "smtp";
    }
    const devFallbackAllowed =
      (this.env.NODE_ENV !== "production" && this.env.ALLOW_DEV_OTP_ECHO !== "false") ||
      this.env.ALLOW_DEV_OTP_ECHO === "true";
    return devFallbackAllowed ? "dev_echo" : "unavailable";
  }

  /**
   * 返回面向未登录前端的认证策略与能力配置（零密钥、零敏感信息）。
   *
   * @returns 注册开关、邮箱域名白名单、发信模式与冷却参数
   */
  public getPublicConfig(): AuthPublicConfigResponse {
    const allowedDomains = [...parseAllowedEmailDomainSet(this.env.ALLOWED_EMAIL_DOMAINS)].sort();
    return {
      ok: true,
      allowPublicSignup: this.env.ALLOW_PUBLIC_SIGNUP === "true",
      allowedEmailDomains: allowedDomains,
      emailDeliveryMode: this.getEmailDeliveryMode(),
      otpResendCooldownSec: this.env.OTP_RESEND_COOLDOWN_SEC,
      otpTtlSec: OTP_TTL_SEC,
      passwordMinLength: 8,
    };
  }

  private assertRateLimit(key: string, limit: number, windowMs: number, message: string): void {
    const check = this.rateLimiter.checkAndConsume(key, limit, windowMs);
    if (!check.allowed) {
      throw new AppError({
        code: "AUTH_RATE_LIMITED",
        statusCode: 429,
        message,
        details: { retryAfterSec: check.retryAfterSec },
      });
    }
  }

  private assertRegistrationAllowed(email: string): void {
    if (this.env.ALLOW_PUBLIC_SIGNUP !== "true") {
      throw new AppError({
        code: "SIGNUP_DISABLED",
        statusCode: 403,
        message: "Public registration is currently disabled on this instance.",
      });
    }

    const allowedDomains = parseAllowedEmailDomainSet(this.env.ALLOWED_EMAIL_DOMAINS);
    if (allowedDomains.size > 0) {
      const domain = email.split("@")[1]?.toLowerCase() ?? "";
      if (!allowedDomains.has(domain)) {
        throw new AppError({
          code: "EMAIL_DOMAIN_NOT_ALLOWED",
          statusCode: 403,
          message: "This email domain is not permitted to register on this instance.",
          details: { allowedEmailDomains: [...allowedDomains].sort() },
        });
      }
    }
  }

  private assertPasswordNotEqualEmail(email: string, password: string): void {
    if (password.trim().toLowerCase() === email.trim().toLowerCase()) {
      throw new AppError({
        code: "VALIDATION_ERROR",
        statusCode: 400,
        message: "Password cannot be identical to your email address.",
      });
    }
  }

  private async issueAndDeliverCode(params: {
    readonly email: string;
    readonly purpose: OtpPurpose;
    readonly requestedDisplayName?: string;
  }): Promise<AuthCodeSentResponse> {
    const now = new Date();
    const cooldownSec = this.env.OTP_RESEND_COOLDOWN_SEC;

    if (cooldownSec > 0) {
      const latestCreatedAt = await this.repo.findLatestUnconsumedOtpCreatedAtByEmailAndPurpose(
        params.email,
        params.purpose,
      );
      if (latestCreatedAt) {
        const elapsedSec = (now.getTime() - latestCreatedAt.getTime()) / 1_000;
        if (elapsedSec < cooldownSec) {
          const retryAfterSec = Math.max(1, Math.ceil(cooldownSec - elapsedSec));
          throw new AppError({
            code: "AUTH_RATE_LIMITED",
            statusCode: 429,
            message: `Please wait ${retryAfterSec} seconds before requesting another verification code.`,
            details: { retryAfterSec },
          });
        }
      }
    }

    const oneHourAgo = new Date(now.getTime() - 3_600_000);
    const recentCount = await this.repo.countRecentOtpCodesByEmail(params.email, oneHourAgo);
    if (recentCount >= MAX_OTP_PER_EMAIL_PER_HOUR) {
      throw new AppError({
        code: "AUTH_RATE_LIMITED",
        statusCode: 429,
        message: "Too many verification emails sent to this address. Please try again later.",
        details: { retryAfterSec: 3_600 },
      });
    }

    const deliveryMode = this.getEmailDeliveryMode();
    if (deliveryMode === "unavailable") {
      throw new AppError({
        code: "EMAIL_DELIVERY_UNAVAILABLE",
        statusCode: 503,
        message:
          "Email delivery service is not configured on this server. Please contact the administrator.",
      });
    }

    const otpId = generatePrefixedId("otp");
    const otpCode = generateOtpCode();
    const codeHash = sha256Hex(otpCode);
    const expiresAt = new Date(now.getTime() + OTP_TTL_SEC * 1_000);

    await this.repo.insertOtpCode({
      id: otpId,
      email: params.email,
      purpose: params.purpose,
      codeHash,
      ...(params.requestedDisplayName !== undefined
        ? { requestedDisplayName: params.requestedDisplayName }
        : {}),
      expiresAt,
    });

    if (deliveryMode === "smtp") {
      const rendered = renderVerificationEmail({
        purpose: params.purpose,
        code: otpCode,
        expiresInMinutes: Math.round(OTP_TTL_SEC / 60),
        publicBaseUrl: this.env.PUBLIC_BASE_URL,
      });

      try {
        await this.mailer.sendEmail({
          to: params.email,
          subject: rendered.subject,
          text: rendered.text,
          html: rendered.html,
        });
      } catch (err) {
        // 关键不变量：SMTP 投递失败时立即撤销刚刚落库的验证码记录，避免用户无辜触发 60 秒重发冷却
        await this.repo.deleteOtpCodeById(otpId).catch(() => undefined);
        this.logger.error(
          {
            purpose: params.purpose,
            recipientDomain: params.email.split("@")[1] ?? "unknown",
            err: err instanceof Error ? err.message : String(err),
          },
          "Failed to deliver verification email via SMTP",
        );
        throw new AppError({
          code: "EMAIL_DELIVERY_FAILED",
          statusCode: 502,
          message:
            "Failed to send verification email. Please verify your email or try again later.",
        });
      }

      const echoAlongsideSmtp =
        this.env.NODE_ENV !== "production" && this.env.ALLOW_DEV_OTP_ECHO === "true";

      return {
        ok: true,
        email: params.email,
        expiresInSec: OTP_TTL_SEC,
        resendCooldownSec: cooldownSec,
        delivery: "smtp",
        ...(echoAlongsideSmtp ? { devOtpCode: otpCode } : {}),
      };
    }

    this.logger.info(
      {
        purpose: params.purpose,
        recipientDomain: params.email.split("@")[1] ?? "unknown",
        delivery: "dev_echo",
      },
      "SMTP unconfigured; returning verification code via dev_echo fallback",
    );

    return {
      ok: true,
      email: params.email,
      expiresInSec: OTP_TTL_SEC,
      resendCooldownSec: cooldownSec,
      delivery: "dev_echo",
      devOtpCode: otpCode,
    };
  }

  private async verifyOtpCodeOrThrow(params: {
    readonly email: string;
    readonly purpose: OtpPurpose;
    readonly code: string;
    readonly now: Date;
    readonly legacyErrorMode?: boolean;
  }): Promise<OtpVerificationRecord> {
    const otpRecord = await this.repo.findLatestValidOtpByEmailAndPurpose(
      params.email,
      params.purpose,
      params.now,
    );

    const invalidCodeError = (): AppError =>
      params.legacyErrorMode
        ? new AppError({
            code: "UNAUTHORIZED",
            statusCode: 401,
            message: "Invalid or expired verification code.",
          })
        : new AppError({
            code: "OTP_INVALID_OR_EXPIRED",
            statusCode: 400,
            message: "Invalid or expired verification code.",
          });

    if (!otpRecord) {
      throw invalidCodeError();
    }

    if (otpRecord.attemptCount >= MAX_OTP_ATTEMPTS) {
      throw new AppError({
        code: "OTP_ATTEMPTS_EXCEEDED",
        statusCode: 429,
        message:
          "Too many invalid attempts. This verification code has expired; please request a new one.",
      });
    }

    const candidateHash = sha256Hex(params.code);
    // 安全防御点：使用恒定时间摘要比较，杜绝按位计时侧信道猜解 6 位数字验证码
    if (!constantTimeEqualHex(otpRecord.codeHash, candidateHash)) {
      const attemptResult = await this.repo.incrementOtpAttemptCount(
        otpRecord.id,
        params.now,
        MAX_OTP_ATTEMPTS,
      );
      if (attemptResult.lockedOut) {
        throw new AppError({
          code: "OTP_ATTEMPTS_EXCEEDED",
          statusCode: 429,
          message:
            "Too many invalid attempts. This verification code has expired; please request a new one.",
        });
      }
      const remainingAttempts = Math.max(0, MAX_OTP_ATTEMPTS - attemptResult.attemptCount);
      throw new AppError({
        code: params.legacyErrorMode ? "UNAUTHORIZED" : "OTP_INVALID_OR_EXPIRED",
        statusCode: params.legacyErrorMode ? 401 : 400,
        message: "Invalid or expired verification code.",
        details: { remainingAttempts },
      });
    }

    return otpRecord;
  }

  /**
   * 根据客户端携带的原始令牌字符串（`oh_ses_...` 或 `oh_agt_...`）验证并还原调用者权威身份。
   *
   * @param rawToken - 来自 Cookie、Bearer Header 或 SSE Query 的原始令牌
   * @returns 服务端权威身份上下文 `AuthenticatedCaller`
   * @throws {AppError} 当令牌为空、前缀非法、不存在或已过期时抛出 `401 UNAUTHORIZED`
   */
  public async authenticateToken(rawToken: string | undefined): Promise<AuthenticatedCaller> {
    const trimmed = rawToken?.trim();
    if (!trimmed) {
      throw new AppError({
        code: "UNAUTHORIZED",
        statusCode: 401,
        message: "Authentication credentials are required.",
      });
    }

    // 统一将客户端明文令牌做 SHA-256 单向摘要后再查询索引，数据库不保存任何明文 Token
    const tokenHash = sha256Hex(trimmed);
    const now = new Date();
    const adminEmails = parseAdminEmailSet(this.env.ADMIN_EMAILS);

    if (trimmed.startsWith("oh_ses_")) {
      // 查询原始数据库角色后再比对 ADMIN_EMAILS，确保白名单热提权同步写入 users.role 列
      const user = await this.repo.findHumanBySessionTokenHash(tokenHash, now);
      if (!user) {
        throw new AppError({
          code: "UNAUTHORIZED",
          statusCode: 401,
          message: "Human session token is invalid or has expired.",
        });
      }
      if (user.status === "suspended") {
        throw new AppError({
          code: "ACCOUNT_SUSPENDED",
          statusCode: 403,
          message: "This account has been suspended by an administrator.",
        });
      }

      let effectiveRole = user.role;
      const isEnvAdmin = adminEmails.has(user.email.toLowerCase());
      // 命中 ADMIN_EMAILS 白名单但数据库尚未落库为 admin 时，立即同步持久化，确保后台列表/KPI/护栏统计一致
      if (isEnvAdmin && effectiveRole !== "admin") {
        await this.repo.promoteUserToAdmin(user.id);
        effectiveRole = "admin";
      } else if (
        effectiveRole !== "admin" &&
        this.env.NODE_ENV === "development" &&
        adminEmails.size === 0 &&
        (await this.repo.countAdmins()) === 0 &&
        (await this.repo.findEarliestUserId()) === user.id
      ) {
        // 本地开发无缝升级：当未配置 ADMIN_EMAILS 且库内尚无管理员时，将最早注册的用户自动提权为管理员
        await this.repo.promoteUserToAdmin(user.id);
        effectiveRole = "admin";
      }

      return {
        kind: "human",
        userId: user.id,
        email: user.email,
        displayName: user.displayName,
        role: effectiveRole,
      };
    }

    if (trimmed.startsWith("oh_agt_")) {
      const agentResult = await this.repo.findAgentByTokenHashAndTouch(tokenHash, now);
      if (!agentResult) {
        throw new AppError({
          code: "UNAUTHORIZED",
          statusCode: 401,
          message: "Agent bearer token is invalid or has been rotated.",
        });
      }
      if (agentResult.ownerStatus === "suspended") {
        throw new AppError({
          code: "ACCOUNT_SUSPENDED",
          statusCode: 403,
          message: "The owner account of this agent has been suspended.",
        });
      }
      const { agent } = agentResult;
      return {
        kind: "agent",
        agentId: agent.id,
        ownerUserId: agent.ownerUserId,
        displayName: agent.displayName,
        platform: agent.platform,
      };
    }

    throw new AppError({
      code: "UNAUTHORIZED",
      statusCode: 401,
      message: "Unrecognized token prefix; expected oh_ses_ or oh_agt_.",
    });
  }

  /* ─────────────────────────────────────────────────────────────
   * 1. 邮箱 + 密码 注册流（邮箱验证码核验激活）
   * ───────────────────────────────────────────────────────────── */

  /**
   * 为新用户注册请求发送 6 位邮箱激活验证码。
   *
   * @param body - 规范化后的待注册邮箱
   * @param clientIp - 客户端 IP（用于滑动窗口防刷）
   * @returns 验证码有效期、重发冷却秒数与投递方式
   * @throws {AppError} 关闭注册（403）、域名不在白名单（403）、邮箱已注册（409）、频控（429）或邮件服务异常（502/503）
   */
  public async requestRegisterCode(
    body: Readonly<RequestRegisterCodeBody>,
    clientIp: string,
  ): Promise<AuthCodeSentResponse> {
    this.assertRateLimit(
      `code-req-ip:${clientIp}`,
      MAX_CODE_REQUESTS_PER_IP,
      AUTH_RATE_WINDOW_MS,
      "Too many verification code requests from this network. Please try again later.",
    );
    this.assertRegistrationAllowed(body.email);

    const existingUser = await this.repo.findUserByEmail(body.email);
    if (existingUser) {
      throw new AppError({
        code: "EMAIL_ALREADY_REGISTERED",
        statusCode: 409,
        message: "This email address is already registered. Please sign in or reset your password.",
      });
    }

    return this.issueAndDeliverCode({
      email: body.email,
      purpose: "register",
    });
  }

  /**
   * 核验 6 位邮箱激活验证码，创建已验证的人类账号并签发登录会话。
   *
   * @param body - 邮箱、6 位验证码、昵称与登录密码
   * @param clientIp - 客户端 IP
   * @returns 新建人类用户档案与明文 `oh_ses_` 会话令牌
   */
  public async registerWithPassword(
    body: Readonly<RegisterWithPasswordBody>,
    clientIp: string,
  ): Promise<AuthSessionResponse> {
    this.assertRateLimit(
      `code-verify-ip:${clientIp}`,
      MAX_CODE_VERIFIES_PER_IP,
      AUTH_RATE_WINDOW_MS,
      "Too many registration attempts from this network. Please try again later.",
    );
    this.assertRegistrationAllowed(body.email);
    this.assertPasswordNotEqualEmail(body.email, body.password);

    const now = new Date();
    const otpRecord = await this.verifyOtpCodeOrThrow({
      email: body.email,
      purpose: "register",
      code: body.code,
      now,
    });

    // 在数据库事务外执行 CPU 密集型 scrypt 派生，避免长耗时哈希拉长行锁与事务连接占用时间
    const passwordHash = await hashPasswordScrypt(body.password);
    const adminEmails = parseAdminEmailSet(this.env.ADMIN_EMAILS);
    const sessionToken = generateSessionToken();
    const sessionTokenHash = sha256Hex(sessionToken);

    try {
      const user = await this.repo.runInTransaction(async (txRepo) => {
        const consumed = await txRepo.consumeOtpAtomically(otpRecord.id, now);
        if (!consumed) {
          throw new AppError({
            code: "OTP_INVALID_OR_EXPIRED",
            statusCode: 400,
            message: "This verification code has already been used.",
          });
        }

        const existingUser = await txRepo.findUserByEmail(body.email, adminEmails);
        if (existingUser) {
          throw new AppError({
            code: "EMAIL_ALREADY_REGISTERED",
            statusCode: 409,
            message:
              "This email address is already registered. Please sign in or reset your password.",
          });
        }

        const grantAdmin =
          adminEmails.has(body.email) ||
          (adminEmails.size === 0 && (await txRepo.countAdmins()) === 0);

        const createdUser = await txRepo.createRegisteredUser({
          id: generateUserId(),
          email: body.email,
          displayName: body.displayName,
          passwordHash,
          grantAdmin,
          now,
          adminEmails,
        });

        await txRepo.createSession({
          id: generatePrefixedId("ses"),
          userId: createdUser.id,
          tokenHash: sessionTokenHash,
          expiresAt: new Date(now.getTime() + SESSION_TTL_SEC * 1_000),
        });

        return createdUser;
      });

      return {
        ok: true,
        user,
        sessionToken,
      };
    } catch (err) {
      if (isPgUniqueViolation(err)) {
        throw new AppError({
          code: "EMAIL_ALREADY_REGISTERED",
          statusCode: 409,
          message:
            "This email address is already registered. Please sign in or reset your password.",
        });
      }
      throw err;
    }
  }

  /* ─────────────────────────────────────────────────────────────
   * 2. 日常邮箱 + 密码登录流
   * ───────────────────────────────────────────────────────────── */

  /**
   * 校验邮箱与密码并签发人类长期登录会话（`oh_ses_...`）。
   *
   * @remarks
   * 防账号枚举策略：邮箱不存在或早期无密码账号仍执行同等耗时虚拟 `scrypt` 校验，统一返回 `401 INVALID_CREDENTIALS`。
   *
   * @param body - 规范化邮箱与明文密码
   * @param clientIp - 客户端 IP（用于防爆破限流）
   * @returns 人类用户档案与会话令牌
   */
  public async loginWithPassword(
    body: Readonly<LoginWithPasswordBody>,
    clientIp: string,
  ): Promise<AuthSessionResponse> {
    this.assertRateLimit(
      `login-ip:${clientIp}`,
      MAX_LOGIN_REQUESTS_PER_IP,
      AUTH_RATE_WINDOW_MS,
      "Too many login requests from this network. Please try again later.",
    );

    const failKey = `login-fail:${clientIp}:${body.email}`;
    const failCheck = this.rateLimiter.checkOnly(
      failKey,
      MAX_LOGIN_FAILURES_PER_IP_EMAIL,
      AUTH_RATE_WINDOW_MS,
    );
    if (!failCheck.allowed) {
      throw new AppError({
        code: "AUTH_RATE_LIMITED",
        statusCode: 429,
        message: `Too many failed login attempts. Please wait ${failCheck.retryAfterSec} seconds before retrying.`,
        details: { retryAfterSec: failCheck.retryAfterSec },
      });
    }

    const adminEmails = parseAdminEmailSet(this.env.ADMIN_EMAILS);
    // 读取数据库原始 role，确保命中 ADMIN_EMAILS 时能够准确触发 grantAdmin 落库同步
    const authRecord = await this.repo.findUserAuthByEmail(body.email);

    // 安全防御点：无论邮箱是否存在或是否已设置密码，均执行完整 scrypt 校验以消除响应时间差
    const targetHash = authRecord?.passwordHash ?? (await getDummyPasswordHash());
    const passwordMatches = await verifyPasswordScrypt(body.password, targetHash);

    if (!authRecord || !authRecord.passwordHash || !passwordMatches) {
      this.rateLimiter.recordHit(failKey, AUTH_RATE_WINDOW_MS);
      throw new AppError({
        code: "INVALID_CREDENTIALS",
        statusCode: 401,
        message: "Invalid email or password.",
      });
    }

    if (authRecord.user.status === "suspended") {
      throw new AppError({
        code: "ACCOUNT_SUSPENDED",
        statusCode: 403,
        message: "This account has been suspended by an administrator.",
      });
    }

    this.rateLimiter.reset(failKey);

    const now = new Date();
    const grantAdmin = adminEmails.has(body.email) && authRecord.user.role !== "admin";
    const sessionToken = generateSessionToken();

    const user = await this.repo.runInTransaction(async (txRepo) => {
      const updatedUser = await txRepo.touchUserLogin({
        userId: authRecord.user.id,
        grantAdmin,
        now,
        adminEmails,
      });
      await txRepo.createSession({
        id: generatePrefixedId("ses"),
        userId: updatedUser.id,
        tokenHash: sha256Hex(sessionToken),
        expiresAt: new Date(now.getTime() + SESSION_TTL_SEC * 1_000),
      });
      return updatedUser;
    });

    return {
      ok: true,
      user,
      sessionToken,
    };
  }

  /* ─────────────────────────────────────────────────────────────
   * 3. 忘记密码 / 邮箱验证码重置密码（兼支持旧无密码用户首次设密）
   * ───────────────────────────────────────────────────────────── */

  /**
   * 忘记密码时请求发送 6 位邮箱重置验证码（对未注册邮箱返回防枚举静默成功）。
   *
   * @param body - 规范化目标邮箱
   * @param clientIp - 客户端 IP
   * @returns 标准验证码下发回执
   */
  public async requestPasswordResetCode(
    body: Readonly<RequestPasswordResetCodeBody>,
    clientIp: string,
  ): Promise<AuthCodeSentResponse> {
    this.assertRateLimit(
      `code-req-ip:${clientIp}`,
      MAX_CODE_REQUESTS_PER_IP,
      AUTH_RATE_WINDOW_MS,
      "Too many password reset requests from this network. Please try again later.",
    );

    const deliveryMode = this.getEmailDeliveryMode();
    if (deliveryMode === "unavailable") {
      throw new AppError({
        code: "EMAIL_DELIVERY_UNAVAILABLE",
        statusCode: 503,
        message:
          "Email delivery service is not configured on this server. Please contact the administrator.",
      });
    }

    const existingUser = await this.repo.findUserByEmail(body.email);
    if (!existingUser) {
      // 安全边界：未注册邮箱不落库、不发信、不回显 devOtpCode，返回统一 200 防止邮箱探测枚举
      return {
        ok: true,
        email: body.email,
        expiresInSec: OTP_TTL_SEC,
        resendCooldownSec: this.env.OTP_RESEND_COOLDOWN_SEC,
        delivery: deliveryMode,
      };
    }

    if (existingUser.status === "suspended") {
      throw new AppError({
        code: "ACCOUNT_SUSPENDED",
        statusCode: 403,
        message: "This account has been suspended by an administrator.",
      });
    }

    return this.issueAndDeliverCode({
      email: body.email,
      purpose: "password_reset",
    });
  }

  /**
   * 核验 6 位重置验证码并重设登录密码，同时原子吊销该账号全部历史会话并签发新会话。
   *
   * @param body - 邮箱、6 位重置码与新密码
   * @param clientIp - 客户端 IP
   * @returns 更新后的用户资料与全新会话令牌
   */
  public async confirmPasswordReset(
    body: Readonly<ConfirmPasswordResetBody>,
    clientIp: string,
  ): Promise<AuthSessionResponse> {
    this.assertRateLimit(
      `code-verify-ip:${clientIp}`,
      MAX_CODE_VERIFIES_PER_IP,
      AUTH_RATE_WINDOW_MS,
      "Too many password reset attempts from this network. Please try again later.",
    );
    this.assertPasswordNotEqualEmail(body.email, body.newPassword);

    const now = new Date();
    const otpRecord = await this.verifyOtpCodeOrThrow({
      email: body.email,
      purpose: "password_reset",
      code: body.code,
      now,
    });

    const passwordHash = await hashPasswordScrypt(body.newPassword);
    const adminEmails = parseAdminEmailSet(this.env.ADMIN_EMAILS);
    const sessionToken = generateSessionToken();
    const sessionTokenHash = sha256Hex(sessionToken);

    const user = await this.repo.runInTransaction(async (txRepo) => {
      const consumed = await txRepo.consumeOtpAtomically(otpRecord.id, now);
      if (!consumed) {
        throw new AppError({
          code: "OTP_INVALID_OR_EXPIRED",
          statusCode: 400,
          message: "This verification code has already been used.",
        });
      }

      const existing = await txRepo.findUserByEmail(body.email, adminEmails);
      if (!existing) {
        throw new AppError({
          code: "OTP_INVALID_OR_EXPIRED",
          statusCode: 400,
          message: "Invalid or expired verification code.",
        });
      }
      if (existing.status === "suspended") {
        throw new AppError({
          code: "ACCOUNT_SUSPENDED",
          statusCode: 403,
          message: "This account has been suspended by an administrator.",
        });
      }

      const updatedUser = await txRepo.updateUserPasswordAndVerify({
        userId: existing.id,
        passwordHash,
        now,
        adminEmails,
      });

      // 安全不变量：重置密码后立即吊销该账号全部旧设备会话，阻断被盗令牌继续访问
      await txRepo.deleteAllSessionsByUserId(existing.id);
      await txRepo.createSession({
        id: generatePrefixedId("ses"),
        userId: existing.id,
        tokenHash: sessionTokenHash,
        expiresAt: new Date(now.getTime() + SESSION_TTL_SEC * 1_000),
      });

      return updatedUser;
    });

    this.rateLimiter.reset(`login-fail:${clientIp}:${body.email}`);

    return {
      ok: true,
      user,
      sessionToken,
    };
  }

  /* ─────────────────────────────────────────────────────────────
   * 4. 已登录用户修改密码 / 补设初始密码
   * ───────────────────────────────────────────────────────────── */

  /**
   * 已登录人类用户修改密码（或无密码历史账号补设初始密码），同步轮换会话并踢出其余设备。
   *
   * @param caller - 已认证的人类调用者（拒绝 Agent）
   * @param body - 可选旧密码与新密码
   * @returns 更新后的用户资料与轮换后的新会话令牌
   */
  public async changePassword(
    caller: Readonly<AuthenticatedCaller>,
    body: Readonly<ChangePasswordBody>,
  ): Promise<AuthSessionResponse> {
    const human = assertHumanCaller(caller);
    const adminEmails = parseAdminEmailSet(this.env.ADMIN_EMAILS);
    const authRecord = await this.repo.findUserAuthById(human.userId, adminEmails);
    if (!authRecord) {
      throw new AppError({
        code: "UNAUTHORIZED",
        statusCode: 401,
        message: "Authenticated user record no longer exists.",
      });
    }

    if (authRecord.passwordHash !== null) {
      if (!body.currentPassword) {
        throw new AppError({
          code: "INVALID_CREDENTIALS",
          statusCode: 401,
          message: "Current password is required.",
        });
      }
      const valid = await verifyPasswordScrypt(body.currentPassword, authRecord.passwordHash);
      if (!valid) {
        throw new AppError({
          code: "INVALID_CREDENTIALS",
          statusCode: 401,
          message: "Current password is incorrect.",
        });
      }
    }

    this.assertPasswordNotEqualEmail(authRecord.user.email, body.newPassword);

    const now = new Date();
    const nextPasswordHash = await hashPasswordScrypt(body.newPassword);
    const sessionToken = generateSessionToken();
    const sessionTokenHash = sha256Hex(sessionToken);

    const user = await this.repo.runInTransaction(async (txRepo) => {
      const updatedUser = await txRepo.updateUserPasswordAndVerify({
        userId: authRecord.user.id,
        passwordHash: nextPasswordHash,
        now,
        adminEmails,
      });
      await txRepo.deleteAllSessionsByUserId(authRecord.user.id);
      await txRepo.createSession({
        id: generatePrefixedId("ses"),
        userId: authRecord.user.id,
        tokenHash: sessionTokenHash,
        expiresAt: new Date(now.getTime() + SESSION_TTL_SEC * 1_000),
      });
      return updatedUser;
    });

    return {
      ok: true,
      user,
      sessionToken,
    };
  }

  /* ─────────────────────────────────────────────────────────────
   * 5. 旧版邮箱 OTP 兼容路由（保留向后兼容与集成测试自验）
   * ───────────────────────────────────────────────────────────── */

  /**
   * [兼容旧版 OTP 路由] 生成并发送 6 位邮箱登录验证码。
   *
   * @param body - 包含规范化邮箱与可选初始昵称的请求体
   * @param clientIp - 客户端 IP
   * @returns 包含过期秒数（及开发/测试无 SMTP 环境下的 `devOtpCode`）的响应体
   * @throws {AppError} 当账号已被封禁、禁止注册或频控触发时抛出对应错误
   */
  public async requestOtp(
    body: Readonly<RequestOtpBody>,
    clientIp = "local",
  ): Promise<RequestOtpResponse> {
    this.assertRateLimit(
      `code-req-ip:${clientIp}`,
      MAX_CODE_REQUESTS_PER_IP,
      AUTH_RATE_WINDOW_MS,
      "Too many verification code requests from this network. Please try again later.",
    );

    const existingUser = await this.repo.findUserByEmail(body.email);
    if (existingUser?.status === "suspended") {
      throw new AppError({
        code: "ACCOUNT_SUSPENDED",
        statusCode: 403,
        message: "This account has been suspended by an administrator.",
      });
    }
    if (!existingUser) {
      this.assertRegistrationAllowed(body.email);
    }

    return this.issueAndDeliverCode({
      email: body.email,
      purpose: "login",
      ...(body.displayName !== undefined ? { requestedDisplayName: body.displayName } : {}),
    });
  }

  /**
   * [兼容旧版 OTP 路由] 校验邮箱 6 位验证码并签发人类长期登录会话（`oh_ses_...`）。
   *
   * @param body - 邮箱、6 位验证码与可选昵称
   * @param clientIp - 客户端 IP
   * @returns 登录用户信息与明文 `sessionToken`
   * @throws {AppError} 当验证码不存在、已过期或不匹配时抛出 `401 UNAUTHORIZED`；账号已封禁抛出 `403 ACCOUNT_SUSPENDED`
   */
  public async verifyOtp(
    body: Readonly<VerifyOtpBody>,
    clientIp = "local",
  ): Promise<VerifyOtpResponse> {
    this.assertRateLimit(
      `code-verify-ip:${clientIp}`,
      MAX_CODE_VERIFIES_PER_IP,
      AUTH_RATE_WINDOW_MS,
      "Too many verification attempts from this network. Please try again later.",
    );

    const now = new Date();
    const otpRecord = await this.verifyOtpCodeOrThrow({
      email: body.email,
      purpose: "login",
      code: body.code,
      now,
      legacyErrorMode: true,
    });

    const adminEmails = parseAdminEmailSet(this.env.ADMIN_EMAILS);
    const existingUser = await this.repo.findUserByEmail(body.email, adminEmails);
    if (existingUser?.status === "suspended") {
      throw new AppError({
        code: "ACCOUNT_SUSPENDED",
        statusCode: 403,
        message: "This account has been suspended by an administrator.",
      });
    }
    if (!existingUser) {
      this.assertRegistrationAllowed(body.email);
    }

    const sessionToken = generateSessionToken();
    const sessionTokenHash = sha256Hex(sessionToken);

    const user = await this.repo.runInTransaction(async (txRepo) => {
      const consumed = await txRepo.consumeOtpAtomically(otpRecord.id, now);
      if (!consumed) {
        throw new AppError({
          code: "UNAUTHORIZED",
          statusCode: 401,
          message: "Invalid or expired verification code.",
        });
      }

      const emailPrefix = body.email.split("@")[0] ?? "Owner";
      const fallbackDisplayName = otpRecord.requestedDisplayName ?? emailPrefix.slice(0, 80);
      const grantAdmin =
        adminEmails.has(body.email) ||
        (adminEmails.size === 0 && (await txRepo.countAdmins()) === 0);

      const savedUser = await txRepo.upsertUserByEmail({
        newUserId: generateUserId(),
        email: body.email,
        fallbackDisplayName: fallbackDisplayName.length > 0 ? fallbackDisplayName : "Owner",
        ...(body.displayName !== undefined ? { explicitDisplayName: body.displayName } : {}),
        grantAdmin,
        now,
        adminEmails,
      });

      await txRepo.createSession({
        id: generatePrefixedId("ses"),
        userId: savedUser.id,
        tokenHash: sessionTokenHash,
        expiresAt: new Date(now.getTime() + SESSION_TTL_SEC * 1_000),
      });

      return savedUser;
    });

    return {
      ok: true,
      user,
      sessionToken,
    };
  }

  /**
   * 吊销指定的人类会话令牌（若存在）。
   *
   * @param rawToken - 客户端携带的 `oh_ses_` 令牌（可为空）
   */
  public async logout(rawToken: string | undefined): Promise<void> {
    const trimmed = rawToken?.trim();
    if (!trimmed || !trimmed.startsWith("oh_ses_")) {
      return;
    }
    await this.repo.deleteSessionByTokenHash(sha256Hex(trimmed));
  }

  /**
   * 查询当前调用者的双模态身份自省视图（含每个绑定 Agent 的实时 `reach` 在线灯）。
   *
   * @param caller - 已认证的人类或 Agent 身份
   * @returns 匹配 `MeResponseSchema` 的可辨识联合响应
   * @throws {AppError} 当底层账户记录意外缺失时抛出 `401 UNAUTHORIZED`
   */
  public async getMe(caller: Readonly<AuthenticatedCaller>): Promise<MeResponse> {
    const adminEmails = parseAdminEmailSet(this.env.ADMIN_EMAILS);
    if (caller.kind === "human") {
      const profile = await this.repo.findUserById(caller.userId, adminEmails);
      if (!profile) {
        throw new AppError({
          code: "UNAUTHORIZED",
          statusCode: 401,
          message: "Authenticated user record no longer exists.",
        });
      }
      const { user, themePreference } = profile;
      const ownedAgents = await this.repo.listAgentsByOwner(user.id);
      return {
        ok: true,
        callerKind: "human",
        user,
        themePreference,
        agents: ownedAgents.map((record) => mapAgentRecordToSummaryDto(record, this.realtimeBus)),
      };
    }

    const agentRecord = await this.repo.findAgentById(caller.agentId);
    const owner = await this.repo.findUserById(caller.ownerUserId, adminEmails);
    if (!agentRecord || !owner) {
      throw new AppError({
        code: "UNAUTHORIZED",
        statusCode: 401,
        message: "Authenticated agent or owner record no longer exists.",
      });
    }

    const allOwned = await this.repo.listAgentsByOwner(caller.ownerUserId);
    const siblingAgents = allOwned
      .filter((item) => item.id !== caller.agentId)
      .map((record) => mapAgentRecordToSummaryDto(record, this.realtimeBus));

    return {
      ok: true,
      callerKind: "agent",
      agent: mapAgentRecordToSummaryDto(agentRecord, this.realtimeBus),
      owner: owner.user,
      siblingAgents,
    };
  }

  /**
   * 更新当前人类或 Agent 的资料并返回最新自省快照。
   *
   * @param caller - 当前已认证调用者
   * @param body - 资料变更项
   * @returns 更新后的 `MeResponse`
   * @throws {AppError} Agent 尝试写入人类账号的外观偏好时返回 403。
   */
  public async updateMe(
    caller: Readonly<AuthenticatedCaller>,
    body: Readonly<UpdateMeBody>,
  ): Promise<MeResponse> {
    if (caller.kind === "human") {
      if (body.displayName !== undefined || body.themePreference !== undefined) {
        await this.repo.updateHumanProfile(caller.userId, {
          ...(body.displayName !== undefined ? { displayName: body.displayName } : {}),
          ...(body.themePreference !== undefined ? { themePreference: body.themePreference } : {}),
        });
      }
      return this.getMe(caller);
    }

    if (body.themePreference !== undefined) {
      assertHumanCaller(caller);
    }
    await this.repo.updateAgentProfile(caller.agentId, {
      ...(body.displayName !== undefined ? { displayName: body.displayName } : {}),
      ...(body.intro !== undefined ? { intro: body.intro } : {}),
      ...(body.checkinIntervalMin !== undefined
        ? { checkinIntervalMin: body.checkinIntervalMin }
        : {}),
    });

    return this.getMe(caller);
  }
}
