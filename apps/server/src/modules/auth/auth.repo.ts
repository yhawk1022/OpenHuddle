/**
 * @module server/modules/auth/repo
 * @description 人类邮箱 OTP、Web 会话（`user_sessions`）与智能体身份自省的参数化数据库仓储层。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 严禁泄露密钥哈希：所有对外返回的 `HumanUserDto` 与 `SafeAgentRecord` 均在投影阶段物理剥离 `token_hash`，绝不向上游透传凭据摘要。
 * 2. 活跃时间追踪：Agent 每次通过 `oh_agt_` 令牌鉴权时原子刷新 `agents.last_seen_at`，为群成员列表可达性指示灯提供精准心跳依据。
 */
import {
  type OpenHuddleDb,
  agentsTable,
  authOtpCodesTable,
  userSessionsTable,
  usersTable,
} from "@openhuddle/db";
import {
  type AgentId,
  type AgentPlatform,
  AgentPlatformSchema,
  AgentWakePolicySchema,
  type HumanUserDto,
  type OwnedAgentSummaryDto,
  type UserId,
} from "@openhuddle/protocol";
import { and, asc, desc, eq, gt, isNull } from "drizzle-orm";
import { computeAgentReachState } from "../../infra/identity-stamp.js";
import type { RealtimeBus } from "../../infra/realtime-bus.js";

/**
 * 剥离了 `tokenHash` 的安全 Agent 持久层投影记录。
 */
export interface SafeAgentRecord {
  readonly id: AgentId;
  readonly ownerUserId: UserId;
  readonly displayName: string;
  readonly slug: string;
  readonly platform: AgentPlatform;
  readonly intro: string | null;
  readonly wakeKind: string;
  readonly wakeConfigJson?: unknown;
  readonly checkinIntervalMin: number | null;
  readonly lastSeenAt: Date | null;
  readonly createdAt: Date;
}

/**
 * 仅供 `AuthService` 在内存中进行恒定时间比对的 OTP 验证记录。
 */
export interface OtpVerificationRecord {
  readonly id: string;
  readonly email: string;
  readonly codeHash: string;
  readonly requestedDisplayName: string | null;
  readonly expiresAt: Date;
}

/**
 * 将 `users` 表行映射为协议层标准 `HumanUserDto`。
 *
 * @param row - `users` 表查询记录
 * @returns 强类型 `HumanUserDto`
 */
export function mapUserRowToDto(row: {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly createdAt: Date;
}): HumanUserDto {
  return {
    id: row.id as UserId,
    email: row.email,
    displayName: row.displayName,
    createdAtIso: row.createdAt.toISOString(),
  };
}

/**
 * 将 `SafeAgentRecord` 结合实时总线状态映射为协议层标准 `OwnedAgentSummaryDto`。
 *
 * @param record - 不含敏感哈希的 Agent 记录
 * @param realtimeBus - 实时事件总线（用于计算 `online_sse` 连接数）
 * @returns 强类型 `OwnedAgentSummaryDto`
 */
export function mapAgentRecordToSummaryDto(
  record: Readonly<SafeAgentRecord>,
  realtimeBus: RealtimeBus,
): OwnedAgentSummaryDto {
  return {
    id: record.id,
    ownerUserId: record.ownerUserId,
    displayName: record.displayName,
    slug: record.slug,
    platform: record.platform,
    ...(record.intro !== null ? { intro: record.intro } : {}),
    // ADR-0002：主人私有唤醒策略（wake_config_json），脏数据安全降级为不展示
    ...(() => {
      const parsed = AgentWakePolicySchema.safeParse(
        typeof record.wakeConfigJson === "string"
          ? (JSON.parse(record.wakeConfigJson) as unknown)
          : record.wakeConfigJson,
      );
      return parsed.success ? { wakePolicy: parsed.data } : {};
    })(),
    reach: computeAgentReachState(record, realtimeBus),
    ...(record.checkinIntervalMin !== null
      ? { checkinIntervalMin: record.checkinIntervalMin }
      : {}),
    ...(record.lastSeenAt !== null ? { lastSeenAtIso: record.lastSeenAt.toISOString() } : {}),
    createdAtIso: record.createdAt.toISOString(),
  };
}

function toSafeAgentRecord(row: {
  readonly id: string;
  readonly ownerUserId: string;
  readonly displayName: string;
  readonly slug: string;
  readonly platform: string;
  readonly intro: string | null;
  readonly wakeKind: string;
  readonly wakeConfigJson?: unknown;
  readonly checkinIntervalMin: number | null;
  readonly lastSeenAt: Date | null;
  readonly createdAt: Date;
}): SafeAgentRecord {
  return {
    id: row.id as AgentId,
    ownerUserId: row.ownerUserId as UserId,
    displayName: row.displayName,
    slug: row.slug,
    platform: AgentPlatformSchema.parse(row.platform),
    intro: row.intro,
    wakeKind: row.wakeKind,
    wakeConfigJson: row.wakeConfigJson,
    checkinIntervalMin: row.checkinIntervalMin,
    lastSeenAt: row.lastSeenAt,
    createdAt: row.createdAt,
  };
}

/**
 * 认证与身份自省仓储类。
 */
export class AuthRepository {
  private readonly db: OpenHuddleDb;

  /**
   * @param db - Drizzle PostgreSQL / PGlite 实例
   */
  public constructor(db: OpenHuddleDb) {
    this.db = db;
  }

  /**
   * 写入一条新的邮箱一次性验证码哈希记录。
   *
   * @param input - 验证码主键、邮箱、SHA-256 哈希及过期时间
   */
  public async insertOtpCode(input: {
    readonly id: string;
    readonly email: string;
    readonly codeHash: string;
    readonly requestedDisplayName?: string;
    readonly expiresAt: Date;
  }): Promise<void> {
    await this.db.insert(authOtpCodesTable).values({
      id: input.id,
      email: input.email,
      codeHash: input.codeHash,
      requestedDisplayName: input.requestedDisplayName ?? null,
      expiresAt: input.expiresAt,
    });
  }

  /**
   * 查找指定邮箱最新一条未消费且未过期的验证码记录。
   *
   * @param email - 规范化小写邮箱
   * @param now - 当前时间基准
   * @returns 待校验的 OTP 记录或 `undefined`
   */
  public async findLatestValidOtpByEmail(
    email: string,
    now: Date,
  ): Promise<OtpVerificationRecord | undefined> {
    const rows = await this.db
      .select({
        id: authOtpCodesTable.id,
        email: authOtpCodesTable.email,
        codeHash: authOtpCodesTable.codeHash,
        requestedDisplayName: authOtpCodesTable.requestedDisplayName,
        expiresAt: authOtpCodesTable.expiresAt,
      })
      .from(authOtpCodesTable)
      .where(
        and(
          eq(authOtpCodesTable.email, email),
          isNull(authOtpCodesTable.consumedAt),
          gt(authOtpCodesTable.expiresAt, now),
        ),
      )
      .orderBy(desc(authOtpCodesTable.createdAt))
      .limit(1);

    return rows[0];
  }

  /**
   * 将指定验证码标记为已消费，防止重放攻击。
   *
   * @param otpId - 验证码记录主键
   * @param consumedAt - 消费时间戳
   */
  public async markOtpConsumed(otpId: string, consumedAt: Date): Promise<void> {
    await this.db
      .update(authOtpCodesTable)
      .set({ consumedAt })
      .where(eq(authOtpCodesTable.id, otpId));
  }

  /**
   * 按邮箱查找或创建人类用户，并在显式提供新昵称时更新展示名称。
   *
   * @param input - 邮箱、新建默认昵称与可选覆盖昵称
   * @returns 最新的人类用户 DTO
   */
  public async upsertUserByEmail(input: {
    readonly newUserId: UserId;
    readonly email: string;
    readonly fallbackDisplayName: string;
    readonly explicitDisplayName?: string;
  }): Promise<HumanUserDto> {
    const existingRows = await this.db
      .select()
      .from(usersTable)
      .where(eq(usersTable.email, input.email))
      .limit(1);

    const existing = existingRows[0];
    if (existing) {
      if (
        input.explicitDisplayName !== undefined &&
        input.explicitDisplayName !== existing.displayName
      ) {
        const updated = await this.db
          .update(usersTable)
          .set({ displayName: input.explicitDisplayName })
          .where(eq(usersTable.id, existing.id))
          .returning();
        const row = updated[0] ?? existing;
        return mapUserRowToDto(row);
      }
      return mapUserRowToDto(existing);
    }

    const inserted = await this.db
      .insert(usersTable)
      .values({
        id: input.newUserId,
        email: input.email,
        displayName: input.explicitDisplayName ?? input.fallbackDisplayName,
      })
      .returning();

    const created = inserted[0];
    if (!created) {
      throw new Error("Failed to insert user row during OTP verification.");
    }
    return mapUserRowToDto(created);
  }

  /**
   * 持久化人类登录会话哈希记录。
   *
   * @param input - 会话主键、所属用户 ID、令牌 SHA-256 哈希与过期时间
   */
  public async createSession(input: {
    readonly id: string;
    readonly userId: UserId;
    readonly tokenHash: string;
    readonly expiresAt: Date;
  }): Promise<void> {
    await this.db.insert(userSessionsTable).values({
      id: input.id,
      userId: input.userId,
      tokenHash: input.tokenHash,
      expiresAt: input.expiresAt,
    });
  }

  /**
   * 根据会话令牌 SHA-256 哈希删除会话记录（幂等登出）。
   *
   * @param tokenHash - `oh_ses_` 令牌的 SHA-256 摘要
   */
  public async deleteSessionByTokenHash(tokenHash: string): Promise<void> {
    await this.db.delete(userSessionsTable).where(eq(userSessionsTable.tokenHash, tokenHash));
  }

  /**
   * 根据未过期的会话令牌哈希解析当前登录的人类用户身份。
   *
   * @param tokenHash - `oh_ses_` 令牌的 SHA-256 摘要
   * @param now - 当前时间基准
   * @returns 人类用户 DTO 或 `undefined`
   */
  public async findHumanBySessionTokenHash(
    tokenHash: string,
    now: Date,
  ): Promise<HumanUserDto | undefined> {
    const rows = await this.db
      .select({
        id: usersTable.id,
        email: usersTable.email,
        displayName: usersTable.displayName,
        createdAt: usersTable.createdAt,
      })
      .from(userSessionsTable)
      .innerJoin(usersTable, eq(userSessionsTable.userId, usersTable.id))
      .where(and(eq(userSessionsTable.tokenHash, tokenHash), gt(userSessionsTable.expiresAt, now)))
      .limit(1);

    const row = rows[0];
    return row ? mapUserRowToDto(row) : undefined;
  }

  /**
   * 根据 `oh_agt_` 令牌哈希校验 Agent 身份并原子刷新 `last_seen_at` 心跳时间。
   *
   * @param tokenHash - `oh_agt_` 令牌的 SHA-256 摘要
   * @param now - 当前时间基准
   * @returns 脱敏后的 `SafeAgentRecord` 或 `undefined`
   */
  public async findAgentByTokenHashAndTouch(
    tokenHash: string,
    now: Date,
  ): Promise<SafeAgentRecord | undefined> {
    const updated = await this.db
      .update(agentsTable)
      .set({ lastSeenAt: now })
      .where(eq(agentsTable.tokenHash, tokenHash))
      .returning({
        id: agentsTable.id,
        ownerUserId: agentsTable.ownerUserId,
        displayName: agentsTable.displayName,
        slug: agentsTable.slug,
        platform: agentsTable.platform,
        intro: agentsTable.intro,
        wakeKind: agentsTable.wakeKind,
        wakeConfigJson: agentsTable.wakeConfigJson,
        checkinIntervalMin: agentsTable.checkinIntervalMin,
        lastSeenAt: agentsTable.lastSeenAt,
        createdAt: agentsTable.createdAt,
      });

    const row = updated[0];
    return row ? toSafeAgentRecord(row) : undefined;
  }

  /**
   * 按主键查询人类用户公开资料。
   *
   * @param userId - 人类用户主键
   * @returns `HumanUserDto` 或 `undefined`
   */
  public async findUserById(userId: UserId): Promise<HumanUserDto | undefined> {
    const rows = await this.db
      .select({
        id: usersTable.id,
        email: usersTable.email,
        displayName: usersTable.displayName,
        createdAt: usersTable.createdAt,
      })
      .from(usersTable)
      .where(eq(usersTable.id, userId))
      .limit(1);

    const row = rows[0];
    return row ? mapUserRowToDto(row) : undefined;
  }

  /**
   * 按主键查询脱敏后的 Agent 记录。
   *
   * @param agentId - Agent 主键
   * @returns `SafeAgentRecord` 或 `undefined`
   */
  public async findAgentById(agentId: AgentId): Promise<SafeAgentRecord | undefined> {
    const rows = await this.db
      .select({
        id: agentsTable.id,
        ownerUserId: agentsTable.ownerUserId,
        displayName: agentsTable.displayName,
        slug: agentsTable.slug,
        platform: agentsTable.platform,
        intro: agentsTable.intro,
        wakeKind: agentsTable.wakeKind,
        wakeConfigJson: agentsTable.wakeConfigJson,
        checkinIntervalMin: agentsTable.checkinIntervalMin,
        lastSeenAt: agentsTable.lastSeenAt,
        createdAt: agentsTable.createdAt,
      })
      .from(agentsTable)
      .where(eq(agentsTable.id, agentId))
      .limit(1);

    const row = rows[0];
    return row ? toSafeAgentRecord(row) : undefined;
  }

  /**
   * 列出指定人类主人名下绑定的全部 Agent 记录（按创建时间升序）。
   *
   * @param ownerUserId - 归属人类主人主键
   * @returns 脱敏后的 `SafeAgentRecord` 数组
   */
  public async listAgentsByOwner(ownerUserId: UserId): Promise<readonly SafeAgentRecord[]> {
    const rows = await this.db
      .select({
        id: agentsTable.id,
        ownerUserId: agentsTable.ownerUserId,
        displayName: agentsTable.displayName,
        slug: agentsTable.slug,
        platform: agentsTable.platform,
        intro: agentsTable.intro,
        wakeKind: agentsTable.wakeKind,
        wakeConfigJson: agentsTable.wakeConfigJson,
        checkinIntervalMin: agentsTable.checkinIntervalMin,
        lastSeenAt: agentsTable.lastSeenAt,
        createdAt: agentsTable.createdAt,
      })
      .from(agentsTable)
      .where(eq(agentsTable.ownerUserId, ownerUserId))
      .orderBy(asc(agentsTable.createdAt));

    return rows.map(toSafeAgentRecord);
  }

  /**
   * 更新人类用户的公开展示名称。
   *
   * @param userId - 人类用户主键
   * @param displayName - 新展示昵称
   */
  public async updateHumanDisplayName(userId: UserId, displayName: string): Promise<void> {
    await this.db.update(usersTable).set({ displayName }).where(eq(usersTable.id, userId));
  }

  /**
   * 更新 Agent 的展示名称、个人简介或轮询周期。
   *
   * @param agentId - Agent 主键
   * @param patch - 待更新的可选资料项
   */
  public async updateAgentProfile(
    agentId: AgentId,
    patch: {
      readonly displayName?: string;
      readonly intro?: string;
      readonly checkinIntervalMin?: number;
    },
  ): Promise<void> {
    const updates: {
      displayName?: string;
      intro?: string;
      checkinIntervalMin?: number;
    } = {};

    if (patch.displayName !== undefined) {
      updates.displayName = patch.displayName;
    }
    if (patch.intro !== undefined) {
      updates.intro = patch.intro;
    }
    if (patch.checkinIntervalMin !== undefined) {
      updates.checkinIntervalMin = patch.checkinIntervalMin;
    }

    if (Object.keys(updates).length === 0) {
      return;
    }

    await this.db.update(agentsTable).set(updates).where(eq(agentsTable.id, agentId));
  }
}
