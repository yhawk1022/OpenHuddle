/**
 * @module server/modules/auth/repo
 * @description 人类邮箱+密码注册与登录、用途隔离 OTP 验证码、Web 会话（`user_sessions`）与智能体身份自省的参数化数据库仓储层。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 严禁泄露密码哈希与令牌摘要：所有对外返回的 `HumanUserDto` 与 `SafeAgentRecord` 均在投影阶段物理剥离 `password_hash` / `token_hash`，绝不向上游透传凭据。
 * 2. 验证码原子核销与防爆破：`consumeOtpAtomically` 借助 `WHERE consumed_at IS NULL RETURNING id` 杜绝并发双花；`incrementOtpAttemptCount` 达阈值立即作废。
 * 3. 活跃时间追踪：Agent 每次通过 `oh_agt_` 令牌鉴权时原子刷新 `agents.last_seen_at`，为群成员列表可达性指示灯提供精准心跳依据。
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
  type OtpPurpose,
  OtpPurposeSchema,
  type OwnedAgentSummaryDto,
  type UserId,
  type UserRole,
  UserRoleSchema,
  type UserStatus,
  UserStatusSchema,
} from "@openhuddle/protocol";
import { and, asc, desc, eq, gt, gte, isNull, sql } from "drizzle-orm";
import { computeAgentReachState } from "../../infra/identity-stamp.js";
import type { RealtimeBus } from "../../infra/realtime-bus.js";
import { extractSqlRows } from "../../infra/sql-rows.js";

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
  readonly allowExternalDm: boolean;
  readonly wakeKind: string;
  readonly wakeConfigJson?: unknown;
  readonly checkinIntervalMin: number | null;
  readonly lastSeenAt: Date | null;
  readonly createdAt: Date;
}

/**
 * 仅供 `AuthService` 在内存中进行恒定时间比对与错误次数熔断的 OTP 验证记录。
 */
export interface OtpVerificationRecord {
  readonly id: string;
  readonly email: string;
  readonly purpose: OtpPurpose;
  readonly codeHash: string;
  readonly attemptCount: number;
  readonly requestedDisplayName: string | null;
  readonly expiresAt: Date;
}

/**
 * 仅供 `AuthService` 内部校验密码使用的账户凭据投影（严禁透传至路由层或响应 DTO）。
 */
export interface UserAuthRecord {
  readonly user: HumanUserDto;
  readonly passwordHash: string | null;
}

/**
 * 将 `users` 表行映射为协议层标准 `HumanUserDto`（物理剥离 `passwordHash`，仅保留 `hasPassword` / `emailVerified` 脱敏标记）。
 *
 * @param row - `users` 表查询记录
 * @param adminEmails - 可选 `ADMIN_EMAILS` 环境变量白名单集合（命中时实时升级为 `admin`）
 * @returns 强类型 `HumanUserDto`
 */
export function mapUserRowToDto(
  row: {
    readonly id: string;
    readonly email: string;
    readonly displayName: string;
    readonly passwordHash?: string | null;
    readonly emailVerifiedAt?: Date | null;
    readonly role?: string;
    readonly status?: string;
    readonly createdAt: Date;
  },
  adminEmails?: ReadonlySet<string>,
): HumanUserDto {
  const dbRole: UserRole = UserRoleSchema.parse(row.role ?? "user");
  const effectiveRole: UserRole = adminEmails?.has(row.email.toLowerCase()) ? "admin" : dbRole;
  const status: UserStatus = UserStatusSchema.parse(row.status ?? "active");
  const hasPassword = typeof row.passwordHash === "string" && row.passwordHash.length > 0;
  // 历史无密码 OTP 创建的用户默认邮箱已核验；显式查询到 emailVerifiedAt 时以实际时间戳为准
  const emailVerified = row.emailVerifiedAt !== undefined ? row.emailVerifiedAt !== null : true;

  return {
    id: row.id as UserId,
    email: row.email,
    displayName: row.displayName,
    role: effectiveRole,
    status,
    emailVerified,
    hasPassword,
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
    allowExternalDm: record.allowExternalDm,
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
  readonly allowExternalDm?: boolean;
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
    allowExternalDm: row.allowExternalDm === true,
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
   * 在单个数据库事务内原子执行注册、密码重置或会话轮换等跨表操作。
   *
   * @param fn - 接收事务级 `AuthRepository` 的异步回调
   * @returns 回调返回值
   */
  public async runInTransaction<T>(fn: (txRepo: AuthRepository) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      const txRepo = new AuthRepository(tx as unknown as OpenHuddleDb);
      return fn(txRepo);
    });
  }

  /**
   * 写入一条新的用途隔离邮箱一次性验证码哈希记录。
   *
   * @param input - 验证码主键、邮箱、用途、SHA-256 哈希及过期时间
   */
  public async insertOtpCode(input: {
    readonly id: string;
    readonly email: string;
    readonly purpose: OtpPurpose;
    readonly codeHash: string;
    readonly requestedDisplayName?: string;
    readonly expiresAt: Date;
  }): Promise<void> {
    await this.db.insert(authOtpCodesTable).values({
      id: input.id,
      email: input.email,
      purpose: input.purpose,
      codeHash: input.codeHash,
      attemptCount: 0,
      requestedDisplayName: input.requestedDisplayName ?? null,
      expiresAt: input.expiresAt,
    });
  }

  /**
   * 删除指定验证码记录（用于 SMTP 投递失败时回滚，避免用户被 60 秒重发冷却误伤）。
   *
   * @param otpId - 待撤销的验证码记录主键
   */
  public async deleteOtpCodeById(otpId: string): Promise<void> {
    await this.db.delete(authOtpCodesTable).where(eq(authOtpCodesTable.id, otpId));
  }

  /**
   * 查询指定邮箱在指定用途下最近一条「尚未消费」验证码的创建时间（用于跨进程持久化的重发冷却检查）。
   *
   * @remarks
   * 仅对未消费记录施加 60 秒重发冷却：若前一条验证码已正常核销（例如重新登录）或因输错 5 次熔断作废，
   * 允许用户立即申请新码，同时仍受每邮箱每小时总次数上限与 IP 滑动窗口双重保护。
   *
   * @param email - 规范化小写邮箱
   * @param purpose - 验证码业务用途
   * @returns 最近一次未消费验证码的创建时间或 `undefined`
   */
  public async findLatestUnconsumedOtpCreatedAtByEmailAndPurpose(
    email: string,
    purpose: OtpPurpose,
  ): Promise<Date | undefined> {
    const rows = await this.db
      .select({ createdAt: authOtpCodesTable.createdAt })
      .from(authOtpCodesTable)
      .where(
        and(
          eq(authOtpCodesTable.email, email),
          eq(authOtpCodesTable.purpose, purpose),
          isNull(authOtpCodesTable.consumedAt),
        ),
      )
      .orderBy(desc(authOtpCodesTable.createdAt))
      .limit(1);
    return rows[0]?.createdAt;
  }

  /**
   * 统计指定邮箱自 `since` 以来申请的验证码总数（跨用途合并统计，防止邮箱轰炸）。
   *
   * @param email - 规范化小写邮箱
   * @param since - 滑动统计起始时间
   * @returns 窗口内申请次数
   */
  public async countRecentOtpCodesByEmail(email: string, since: Date): Promise<number> {
    const result = await this.db
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(authOtpCodesTable)
      .where(and(eq(authOtpCodesTable.email, email), gte(authOtpCodesTable.createdAt, since)));
    return Number(result[0]?.count ?? 0);
  }

  /**
   * 查找指定邮箱与用途下最新一条未消费且未过期的验证码记录。
   *
   * @param email - 规范化小写邮箱
   * @param purpose - 验证码业务用途（严格隔离 `register` / `password_reset` / `login`）
   * @param now - 当前时间基准
   * @returns 待校验的 OTP 记录或 `undefined`
   */
  public async findLatestValidOtpByEmailAndPurpose(
    email: string,
    purpose: OtpPurpose,
    now: Date,
  ): Promise<OtpVerificationRecord | undefined> {
    const rows = await this.db
      .select({
        id: authOtpCodesTable.id,
        email: authOtpCodesTable.email,
        purpose: authOtpCodesTable.purpose,
        codeHash: authOtpCodesTable.codeHash,
        attemptCount: authOtpCodesTable.attemptCount,
        requestedDisplayName: authOtpCodesTable.requestedDisplayName,
        expiresAt: authOtpCodesTable.expiresAt,
      })
      .from(authOtpCodesTable)
      .where(
        and(
          eq(authOtpCodesTable.email, email),
          eq(authOtpCodesTable.purpose, purpose),
          isNull(authOtpCodesTable.consumedAt),
          gt(authOtpCodesTable.expiresAt, now),
        ),
      )
      .orderBy(desc(authOtpCodesTable.createdAt))
      .limit(1);

    const row = rows[0];
    if (!row) {
      return undefined;
    }
    return {
      ...row,
      purpose: OtpPurposeSchema.parse(row.purpose),
    };
  }

  /**
   * 原子累加验证码错误尝试次数；当达到上限 `maxAttempts` 时同步将 `consumed_at` 置为当前时间，彻底作废该码。
   *
   * @param otpId - 验证码主键
   * @param now - 当前时间基准
   * @param maxAttempts - 单码允许的最大错误次数（默认 5）
   * @returns 更新后的尝试次数及是否已触发熔断锁定
   */
  public async incrementOtpAttemptCount(
    otpId: string,
    now: Date,
    maxAttempts: number,
  ): Promise<{ readonly attemptCount: number; readonly lockedOut: boolean }> {
    const nowIso = now.toISOString();
    const result = await this.db.execute(sql`
      UPDATE auth_otp_codes
      SET
        attempt_count = attempt_count + 1,
        consumed_at = CASE
          WHEN attempt_count + 1 >= ${maxAttempts} THEN ${nowIso}::timestamptz
          ELSE consumed_at
        END
      WHERE id = ${otpId} AND consumed_at IS NULL
      RETURNING attempt_count AS "attemptCount"
    `);
    const row = extractSqlRows<{ readonly attemptCount: number | string }>(result)[0];
    const nextCount = Number(row?.attemptCount ?? maxAttempts);
    return {
      attemptCount: nextCount,
      lockedOut: nextCount >= maxAttempts,
    };
  }

  /**
   * 原子核销指定未消费验证码（防并发重放竞态条件：仅首个 `WHERE consumed_at IS NULL` 更新成功返回 `true`）。
   *
   * @param otpId - 验证码记录主键
   * @param consumedAt - 消费时间戳
   * @returns 若本次成功抢占核销返回 `true`，若已被其他并发请求消费则返回 `false`
   */
  public async consumeOtpAtomically(otpId: string, consumedAt: Date): Promise<boolean> {
    const updated = await this.db
      .update(authOtpCodesTable)
      .set({ consumedAt })
      .where(and(eq(authOtpCodesTable.id, otpId), isNull(authOtpCodesTable.consumedAt)))
      .returning({ id: authOtpCodesTable.id });
    return updated.length > 0;
  }

  /**
   * 按规范化邮箱查询人类用户公开档案（不含 `passwordHash`）。
   *
   * @param email - 规范化小写邮箱
   * @param adminEmails - 可选 `ADMIN_EMAILS` 白名单集合
   * @returns `HumanUserDto` 或 `undefined`
   */
  public async findUserByEmail(
    email: string,
    adminEmails?: ReadonlySet<string>,
  ): Promise<HumanUserDto | undefined> {
    const record = await this.findUserAuthByEmail(email, adminEmails);
    return record?.user;
  }

  /**
   * 按规范化邮箱查询含内部 `passwordHash` 的认证记录（仅供 `AuthService` 校验密码使用）。
   *
   * @param email - 规范化小写邮箱
   * @param adminEmails - 可选 `ADMIN_EMAILS` 白名单集合
   * @returns `UserAuthRecord` 或 `undefined`
   */
  public async findUserAuthByEmail(
    email: string,
    adminEmails?: ReadonlySet<string>,
  ): Promise<UserAuthRecord | undefined> {
    const rows = await this.db
      .select({
        id: usersTable.id,
        email: usersTable.email,
        displayName: usersTable.displayName,
        passwordHash: usersTable.passwordHash,
        emailVerifiedAt: usersTable.emailVerifiedAt,
        role: usersTable.role,
        status: usersTable.status,
        createdAt: usersTable.createdAt,
      })
      .from(usersTable)
      .where(eq(usersTable.email, email))
      .limit(1);

    const row = rows[0];
    if (!row) {
      return undefined;
    }
    return {
      user: mapUserRowToDto(row, adminEmails),
      passwordHash: row.passwordHash,
    };
  }

  /**
   * 按主键查询含内部 `passwordHash` 的认证记录（仅供 `AuthService` 修改密码校验当前口令使用）。
   *
   * @param userId - 人类用户主键
   * @param adminEmails - 可选 `ADMIN_EMAILS` 白名单集合
   * @returns `UserAuthRecord` 或 `undefined`
   */
  public async findUserAuthById(
    userId: UserId,
    adminEmails?: ReadonlySet<string>,
  ): Promise<UserAuthRecord | undefined> {
    const rows = await this.db
      .select({
        id: usersTable.id,
        email: usersTable.email,
        displayName: usersTable.displayName,
        passwordHash: usersTable.passwordHash,
        emailVerifiedAt: usersTable.emailVerifiedAt,
        role: usersTable.role,
        status: usersTable.status,
        createdAt: usersTable.createdAt,
      })
      .from(usersTable)
      .where(eq(usersTable.id, userId))
      .limit(1);

    const row = rows[0];
    if (!row) {
      return undefined;
    }
    return {
      user: mapUserRowToDto(row, adminEmails),
      passwordHash: row.passwordHash,
    };
  }

  /**
   * 统计全平台数据库内记录为管理员（`role = 'admin'`）的账号数量。
   *
   * @returns 管理员数量
   */
  public async countAdmins(): Promise<number> {
    const result = await this.db.execute(sql`
      SELECT COUNT(*)::int AS cnt FROM users WHERE role = 'admin'
    `);
    const row = extractSqlRows<{ readonly cnt: number | string }>(result)[0];
    return Number(row?.cnt ?? 0);
  }

  /**
   * 查询注册时间最早的用户主键（用于本地环境无 `ADMIN_EMAILS` 升级时的首个用户自动提权）。
   *
   * @returns 最早用户的 `UserId` 或 `undefined`
   */
  public async findEarliestUserId(): Promise<UserId | undefined> {
    const rows = await this.db
      .select({ id: usersTable.id })
      .from(usersTable)
      .orderBy(asc(usersTable.createdAt), asc(usersTable.id))
      .limit(1);
    return rows[0] ? (rows[0].id as UserId) : undefined;
  }

  /**
   * 将指定用户提权为平台管理员（`role = 'admin'`）。
   *
   * @param userId - 目标用户主键
   */
  public async promoteUserToAdmin(userId: UserId): Promise<void> {
    await this.db.update(usersTable).set({ role: "admin" }).where(eq(usersTable.id, userId));
  }

  /**
   * 持久化一名通过邮箱验证码核验完成注册的新人类用户。
   *
   * @param input - 新用户 ID、邮箱、昵称、scrypt 密码哈希、管理员授权标志与时间戳
   * @returns 创建后的脱敏 `HumanUserDto`
   */
  public async createRegisteredUser(input: {
    readonly id: UserId;
    readonly email: string;
    readonly displayName: string;
    readonly passwordHash: string;
    readonly grantAdmin: boolean;
    readonly now: Date;
    readonly adminEmails?: ReadonlySet<string>;
  }): Promise<HumanUserDto> {
    const inserted = await this.db
      .insert(usersTable)
      .values({
        id: input.id,
        email: input.email,
        displayName: input.displayName,
        passwordHash: input.passwordHash,
        emailVerifiedAt: input.now,
        passwordUpdatedAt: input.now,
        role: input.grantAdmin ? "admin" : "user",
        status: "active",
        lastLoginAt: input.now,
      })
      .returning();

    const created = inserted[0];
    if (!created) {
      throw new Error("Failed to insert registered user row.");
    }
    return mapUserRowToDto(created, input.adminEmails);
  }

  /**
   * 刷新密码登录用户的最近登录时间并在命中 `ADMIN_EMAILS` 时同步角色。
   *
   * @param input - 目标用户 ID、是否提权为管理员与登录时间
   * @returns 更新后的脱敏 `HumanUserDto`
   */
  public async touchUserLogin(input: {
    readonly userId: UserId;
    readonly grantAdmin: boolean;
    readonly now: Date;
    readonly adminEmails?: ReadonlySet<string>;
  }): Promise<HumanUserDto> {
    const updated = await this.db
      .update(usersTable)
      .set({
        ...(input.grantAdmin ? { role: "admin" } : {}),
        lastLoginAt: input.now,
      })
      .where(eq(usersTable.id, input.userId))
      .returning();

    const row = updated[0];
    if (!row) {
      throw new Error(`Failed to update lastLoginAt for user "${input.userId}".`);
    }
    return mapUserRowToDto(row, input.adminEmails);
  }

  /**
   * 更新用户 `scrypt` 密码哈希并标记邮箱已核验与密码更新时间（供重置密码与修改密码复用）。
   *
   * @param input - 目标用户 ID、新 `scrypt` 哈希、时间戳与管理员邮箱集合
   * @returns 更新后的脱敏 `HumanUserDto`
   */
  public async updateUserPasswordAndVerify(input: {
    readonly userId: UserId;
    readonly passwordHash: string;
    readonly now: Date;
    readonly adminEmails?: ReadonlySet<string>;
  }): Promise<HumanUserDto> {
    const nowIso = input.now.toISOString();
    const updated = await this.db
      .update(usersTable)
      .set({
        passwordHash: input.passwordHash,
        passwordUpdatedAt: input.now,
        emailVerifiedAt: sql`COALESCE(${usersTable.emailVerifiedAt}, ${nowIso}::timestamptz)`,
        lastLoginAt: input.now,
      })
      .where(eq(usersTable.id, input.userId))
      .returning();

    const row = updated[0];
    if (!row) {
      throw new Error(`Failed to update password for user "${input.userId}".`);
    }
    return mapUserRowToDto(row, input.adminEmails);
  }

  /**
   * [兼容旧版 OTP 路由] 按邮箱查找或创建人类用户，刷新最近登录时间与邮箱验证时间，并在满足条件时更新昵称或授予管理员角色。
   *
   * @param input - 邮箱、新建默认昵称、可选覆盖昵称、是否授予管理员及登录时间
   * @returns 最新的人类用户 DTO
   */
  public async upsertUserByEmail(input: {
    readonly newUserId: UserId;
    readonly email: string;
    readonly fallbackDisplayName: string;
    readonly explicitDisplayName?: string;
    readonly grantAdmin?: boolean;
    readonly now: Date;
    readonly adminEmails?: ReadonlySet<string>;
  }): Promise<HumanUserDto> {
    const existingRows = await this.db
      .select()
      .from(usersTable)
      .where(eq(usersTable.email, input.email))
      .limit(1);

    const existing = existingRows[0];
    if (existing) {
      const nextDisplayName =
        input.explicitDisplayName !== undefined &&
        input.explicitDisplayName !== existing.displayName
          ? input.explicitDisplayName
          : existing.displayName;
      const nextRole =
        input.grantAdmin === true && existing.role !== "admin" ? "admin" : existing.role;

      const updated = await this.db
        .update(usersTable)
        .set({
          displayName: nextDisplayName,
          role: nextRole,
          emailVerifiedAt: existing.emailVerifiedAt ?? input.now,
          lastLoginAt: input.now,
        })
        .where(eq(usersTable.id, existing.id))
        .returning();
      const row = updated[0] ?? existing;
      return mapUserRowToDto(row, input.adminEmails);
    }

    const inserted = await this.db
      .insert(usersTable)
      .values({
        id: input.newUserId,
        email: input.email,
        displayName: input.explicitDisplayName ?? input.fallbackDisplayName,
        emailVerifiedAt: input.now,
        role: input.grantAdmin ? "admin" : "user",
        status: "active",
        lastLoginAt: input.now,
      })
      .returning();

    const created = inserted[0];
    if (!created) {
      throw new Error("Failed to insert user row during OTP verification.");
    }
    return mapUserRowToDto(created, input.adminEmails);
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
   * 吊销指定用户的全部人类登录会话（密码重置与修改密码时的强制全端安全下线）。
   *
   * @param userId - 目标人类用户主键
   */
  public async deleteAllSessionsByUserId(userId: UserId): Promise<void> {
    await this.db.delete(userSessionsTable).where(eq(userSessionsTable.userId, userId));
  }

  /**
   * 根据未过期的会话令牌哈希解析当前登录的人类用户身份。
   *
   * @param tokenHash - `oh_ses_` 令牌的 SHA-256 摘要
   * @param now - 当前时间基准
   * @param adminEmails - 可选 `ADMIN_EMAILS` 环境变量白名单集合
   * @returns 人类用户 DTO 或 `undefined`
   */
  public async findHumanBySessionTokenHash(
    tokenHash: string,
    now: Date,
    adminEmails?: ReadonlySet<string>,
  ): Promise<HumanUserDto | undefined> {
    const rows = await this.db
      .select({
        id: usersTable.id,
        email: usersTable.email,
        displayName: usersTable.displayName,
        passwordHash: usersTable.passwordHash,
        emailVerifiedAt: usersTable.emailVerifiedAt,
        role: usersTable.role,
        status: usersTable.status,
        createdAt: usersTable.createdAt,
      })
      .from(userSessionsTable)
      .innerJoin(usersTable, eq(userSessionsTable.userId, usersTable.id))
      .where(and(eq(userSessionsTable.tokenHash, tokenHash), gt(userSessionsTable.expiresAt, now)))
      .limit(1);

    const row = rows[0];
    return row ? mapUserRowToDto(row, adminEmails) : undefined;
  }

  /**
   * 根据 `oh_agt_` 令牌哈希校验 Agent 身份及其主人账号状态；仅当主人处于活跃态时刷新 `last_seen_at` 心跳时间。
   *
   * @param tokenHash - `oh_agt_` 令牌的 SHA-256 摘要
   * @param now - 当前时间基准
   * @returns 包含脱敏 Agent 记录与归属主人状态的对象，未命中返回 `undefined`
   */
  public async findAgentByTokenHashAndTouch(
    tokenHash: string,
    now: Date,
  ): Promise<{ readonly agent: SafeAgentRecord; readonly ownerStatus: UserStatus } | undefined> {
    const rows = await this.db
      .select({
        id: agentsTable.id,
        ownerUserId: agentsTable.ownerUserId,
        displayName: agentsTable.displayName,
        slug: agentsTable.slug,
        platform: agentsTable.platform,
        intro: agentsTable.intro,
        allowExternalDm: agentsTable.allowExternalDm,
        wakeKind: agentsTable.wakeKind,
        wakeConfigJson: agentsTable.wakeConfigJson,
        checkinIntervalMin: agentsTable.checkinIntervalMin,
        lastSeenAt: agentsTable.lastSeenAt,
        createdAt: agentsTable.createdAt,
        ownerStatus: usersTable.status,
      })
      .from(agentsTable)
      .innerJoin(usersTable, eq(agentsTable.ownerUserId, usersTable.id))
      .where(eq(agentsTable.tokenHash, tokenHash))
      .limit(1);

    const row = rows[0];
    if (!row) {
      return undefined;
    }

    const ownerStatus = UserStatusSchema.parse(row.ownerStatus);
    if (ownerStatus === "active") {
      await this.db.update(agentsTable).set({ lastSeenAt: now }).where(eq(agentsTable.id, row.id));
      return {
        agent: toSafeAgentRecord({ ...row, lastSeenAt: now }),
        ownerStatus,
      };
    }

    return {
      agent: toSafeAgentRecord(row),
      ownerStatus,
    };
  }

  /**
   * 按主键查询人类用户公开资料。
   *
   * @param userId - 人类用户主键
   * @param adminEmails - 可选 `ADMIN_EMAILS` 白名单集合
   * @returns `HumanUserDto` 或 `undefined`
   */
  public async findUserById(
    userId: UserId,
    adminEmails?: ReadonlySet<string>,
  ): Promise<HumanUserDto | undefined> {
    const rows = await this.db
      .select({
        id: usersTable.id,
        email: usersTable.email,
        displayName: usersTable.displayName,
        passwordHash: usersTable.passwordHash,
        emailVerifiedAt: usersTable.emailVerifiedAt,
        role: usersTable.role,
        status: usersTable.status,
        createdAt: usersTable.createdAt,
      })
      .from(usersTable)
      .where(eq(usersTable.id, userId))
      .limit(1);

    const row = rows[0];
    return row ? mapUserRowToDto(row, adminEmails) : undefined;
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
        allowExternalDm: agentsTable.allowExternalDm,
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
        allowExternalDm: agentsTable.allowExternalDm,
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
