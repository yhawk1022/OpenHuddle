/**
 * @module server/modules/auth/service
 * @description 双层身份认证（Human OTP Session + Agent Bearer Token）与 `/api/v1/me` 自省编排服务。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 双模态凭据严格分流：`oh_ses_` 前缀仅解析为 `kind: "human"`，`oh_agt_` 前缀仅解析为 `kind: "agent"`，两套命名空间物理隔离。
 * 2. 恒定时间防爆破：邮箱 6 位 OTP 校验强制走 SHA-256 哈希后的 `constantTimeEqualHex` 比较，并在成功后立即核销，阻断重放。
 * 3. 生产环境零验证码回显：仅当 `NODE_ENV !== "production"` 或显式开启 `ALLOW_DEV_OTP_ECHO === "true"` 时才返回 `devOtpCode`。
 */
import type {
  AuthenticatedCaller,
  MeResponse,
  RequestOtpBody,
  RequestOtpResponse,
  UpdateMeBody,
  VerifyOtpBody,
  VerifyOtpResponse,
} from "@openhuddle/protocol";
import {
  constantTimeEqualHex,
  generateOtpCode,
  generatePrefixedId,
  generateSessionToken,
  generateUserId,
  sha256Hex,
} from "../../infra/crypto.js";
import type { ServerEnv } from "../../infra/env.js";
import { AppError } from "../../infra/errors.js";
import type { RealtimeBus } from "../../infra/realtime-bus.js";
import { type AuthRepository, mapAgentRecordToSummaryDto } from "./auth.repo.js";

/** OTP 验证码有效期（10 分钟） */
const OTP_TTL_SEC = 600;

/** Web 登录会话有效期（30 天，与 Cookie `Max-Age=2592000` 对齐） */
export const SESSION_TTL_SEC = 2_592_000;

/**
 * 构造 `AuthService` 所需的依赖。
 */
export interface AuthServiceDeps {
  readonly repo: AuthRepository;
  readonly env: ServerEnv;
  readonly realtimeBus: RealtimeBus;
}

/**
 * 人类与个人 Agent 统一认证及资料编排服务。
 */
export class AuthService {
  private readonly repo: AuthRepository;
  private readonly env: ServerEnv;
  private readonly realtimeBus: RealtimeBus;

  /**
   * @param deps - 认证仓储、环境配置与实时事件总线
   */
  public constructor(deps: Readonly<AuthServiceDeps>) {
    this.repo = deps.repo;
    this.env = deps.env;
    this.realtimeBus = deps.realtimeBus;
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

    if (trimmed.startsWith("oh_ses_")) {
      const user = await this.repo.findHumanBySessionTokenHash(tokenHash, now);
      if (!user) {
        throw new AppError({
          code: "UNAUTHORIZED",
          statusCode: 401,
          message: "Human session token is invalid or has expired.",
        });
      }
      return {
        kind: "human",
        userId: user.id,
        displayName: user.displayName,
      };
    }

    if (trimmed.startsWith("oh_agt_")) {
      const agent = await this.repo.findAgentByTokenHashAndTouch(tokenHash, now);
      if (!agent) {
        throw new AppError({
          code: "UNAUTHORIZED",
          statusCode: 401,
          message: "Agent bearer token is invalid or has been rotated.",
        });
      }
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

  /**
   * 生成并存储 6 位邮箱登录验证码。
   *
   * @param body - 包含规范化邮箱与可选初始昵称的请求体
   * @returns 包含过期秒数（及开发/测试环境下的 `devOtpCode`）的响应体
   */
  public async requestOtp(body: Readonly<RequestOtpBody>): Promise<RequestOtpResponse> {
    const otpCode = generateOtpCode();
    const codeHash = sha256Hex(otpCode);
    const expiresAt = new Date(Date.now() + OTP_TTL_SEC * 1_000);

    await this.repo.insertOtpCode({
      id: generatePrefixedId("otp"),
      email: body.email,
      codeHash,
      ...(body.displayName !== undefined ? { requestedDisplayName: body.displayName } : {}),
      expiresAt,
    });

    const shouldEchoDevOtp =
      this.env.NODE_ENV !== "production" || this.env.ALLOW_DEV_OTP_ECHO === "true";

    return {
      ok: true,
      email: body.email,
      expiresInSec: OTP_TTL_SEC,
      ...(shouldEchoDevOtp ? { devOtpCode: otpCode } : {}),
    };
  }

  /**
   * 校验邮箱 6 位验证码并签发人类长期登录会话（`oh_ses_...`）。
   *
   * @param body - 邮箱、6 位验证码与可选昵称
   * @returns 登录用户信息与明文 `sessionToken`
   * @throws {AppError} 当验证码不存在、已过期或不匹配时抛出 `401 UNAUTHORIZED`
   */
  public async verifyOtp(body: Readonly<VerifyOtpBody>): Promise<VerifyOtpResponse> {
    const now = new Date();
    const otpRecord = await this.repo.findLatestValidOtpByEmail(body.email, now);
    const candidateHash = sha256Hex(body.code);

    // 安全防御点：使用恒定时间摘要比较，杜绝按位计时侧信道猜解 6 位数字验证码
    if (!otpRecord || !constantTimeEqualHex(otpRecord.codeHash, candidateHash)) {
      throw new AppError({
        code: "UNAUTHORIZED",
        statusCode: 401,
        message: "Invalid or expired verification code.",
      });
    }

    await this.repo.markOtpConsumed(otpRecord.id, now);

    const emailPrefix = body.email.split("@")[0] ?? "Owner";
    const fallbackDisplayName = otpRecord.requestedDisplayName ?? emailPrefix.slice(0, 80);

    const user = await this.repo.upsertUserByEmail({
      newUserId: generateUserId(),
      email: body.email,
      fallbackDisplayName: fallbackDisplayName.length > 0 ? fallbackDisplayName : "Owner",
      ...(body.displayName !== undefined ? { explicitDisplayName: body.displayName } : {}),
    });

    const sessionToken = generateSessionToken();
    await this.repo.createSession({
      id: generatePrefixedId("ses"),
      userId: user.id,
      tokenHash: sha256Hex(sessionToken),
      expiresAt: new Date(now.getTime() + SESSION_TTL_SEC * 1_000),
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
    if (caller.kind === "human") {
      const user = await this.repo.findUserById(caller.userId);
      if (!user) {
        throw new AppError({
          code: "UNAUTHORIZED",
          statusCode: 401,
          message: "Authenticated user record no longer exists.",
        });
      }
      const ownedAgents = await this.repo.listAgentsByOwner(user.id);
      return {
        ok: true,
        callerKind: "human",
        user,
        agents: ownedAgents.map((record) => mapAgentRecordToSummaryDto(record, this.realtimeBus)),
      };
    }

    const agentRecord = await this.repo.findAgentById(caller.agentId);
    const owner = await this.repo.findUserById(caller.ownerUserId);
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
      owner,
      siblingAgents,
    };
  }

  /**
   * 更新当前人类或 Agent 的展示资料并返回最新自省快照。
   *
   * @param caller - 当前已认证调用者
   * @param body - 资料变更项
   * @returns 更新后的 `MeResponse`
   */
  public async updateMe(
    caller: Readonly<AuthenticatedCaller>,
    body: Readonly<UpdateMeBody>,
  ): Promise<MeResponse> {
    if (caller.kind === "human") {
      if (body.displayName !== undefined) {
        await this.repo.updateHumanDisplayName(caller.userId, body.displayName);
      }
      return this.getMe(caller);
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
