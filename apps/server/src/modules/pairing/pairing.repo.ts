/**
 * @module server/modules/pairing/repo
 * @description 一次性短配对码（`pairing_codes`）与 Agent 绑定/掉线认领（`--reclaim`）参数化数据库仓储层。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 行级并发互斥：消费配对码时必须通过 `SELECT ... FOR UPDATE` 锁定配对码行，防止两个并发配对请求同时使用同一个一次性配对码。
 * 2. 认领历史无损保留：`reclaim` 仅原地轮换 `agents.token_hash` 与基础资料，绝不删除重建 `agents` 主键，从而 100% 保留历史 `room_members` 已读游标与提案投票记录。
 */
import {
  type OpenHuddleDb,
  agentsTable,
  pairingCodesTable,
  roomMembersTable,
  roomsTable,
  usersTable,
} from "@openhuddle/db";
import {
  type AgentId,
  type AgentPlatform,
  AgentPlatformSchema,
  type HumanUserDto,
  type PairingCode,
  type RoomId,
  type UserId,
} from "@openhuddle/protocol";
import { and, eq, sql } from "drizzle-orm";
import { extractSqlRows } from "../../infra/sql-rows.js";
import { type SafeAgentRecord, mapUserRowToDto } from "../auth/auth.repo.js";

/**
 * 锁定后的配对码数据库记录投影。
 */
export interface LockedPairingCodeRecord {
  readonly code: PairingCode;
  readonly ownerUserId: UserId;
  readonly autoJoinRoomId: RoomId | null;
  readonly reclaimAgentId: AgentId | null;
  readonly expiresAt: Date;
  readonly usedAt: Date | null;
}

function mapAgentRowToSafe(row: {
  readonly id: string;
  readonly ownerUserId: string;
  readonly displayName: string;
  readonly slug: string;
  readonly platform: string;
  readonly intro: string | null;
  readonly wakeKind: string;
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
    checkinIntervalMin: row.checkinIntervalMin,
    lastSeenAt: row.lastSeenAt,
    createdAt: row.createdAt,
  };
}

/**
 * 配对码签发与消费仓储类。
 */
export class PairingRepository {
  private readonly db: OpenHuddleDb;

  /**
   * @param db - Drizzle PostgreSQL / PGlite 实例
   */
  public constructor(db: OpenHuddleDb) {
    this.db = db;
  }

  /**
   * 暴露底层事务包装器以执行跨表原子绑定。
   *
   * @param fn - 在同一事务上下文中执行的异步回调
   * @returns 回调返回值
   */
  public async runInTransaction<T>(fn: (txRepo: PairingRepository) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      const txRepo = new PairingRepository(tx as unknown as OpenHuddleDb);
      return fn(txRepo);
    });
  }

  /**
   * 检查房间是否存在。
   *
   * @param roomId - 目标房间主键
   * @returns 存在返回 `true`
   */
  public async roomExists(roomId: RoomId): Promise<boolean> {
    const rows = await this.db
      .select({ id: roomsTable.id })
      .from(roomsTable)
      .where(eq(roomsTable.id, roomId))
      .limit(1);
    return rows.length > 0;
  }

  /**
   * 检查指定人类成员是否已在目标房间内。
   *
   * @param roomId - 房间主键
   * @param userId - 人类用户主键
   * @returns 在群内返回 `true`
   */
  public async isHumanRoomMember(roomId: RoomId, userId: UserId): Promise<boolean> {
    const rows = await this.db
      .select({ memberKey: roomMembersTable.memberKey })
      .from(roomMembersTable)
      .where(
        and(eq(roomMembersTable.roomId, roomId), eq(roomMembersTable.memberKey, `human:${userId}`)),
      )
      .limit(1);
    return rows.length > 0;
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
        checkinIntervalMin: agentsTable.checkinIntervalMin,
        lastSeenAt: agentsTable.lastSeenAt,
        createdAt: agentsTable.createdAt,
      })
      .from(agentsTable)
      .where(eq(agentsTable.id, agentId))
      .limit(1);

    const row = rows[0];
    return row ? mapAgentRowToSafe(row) : undefined;
  }

  /**
   * 写入新签发的一次性配对码记录。
   *
   * @param input - 配对码、归属人类主键、可选自动入群房间、可选认领 Agent 与过期时间
   */
  public async insertPairingCode(input: {
    readonly code: PairingCode;
    readonly ownerUserId: UserId;
    readonly autoJoinRoomId?: RoomId;
    readonly reclaimAgentId?: AgentId;
    readonly expiresAt: Date;
  }): Promise<void> {
    await this.db.insert(pairingCodesTable).values({
      code: input.code,
      ownerUserId: input.ownerUserId,
      autoJoinRoomId: input.autoJoinRoomId ?? null,
      reclaimAgentId: input.reclaimAgentId ?? null,
      expiresAt: input.expiresAt,
    });
  }

  /**
   * 在事务中通过排他行锁（`FOR UPDATE`）查询配对码记录。
   *
   * @param code - 规范化大写配对码
   * @returns 锁定的配对码记录或 `undefined`
   */
  public async lockPairingCodeForUpdate(
    code: PairingCode,
  ): Promise<LockedPairingCodeRecord | undefined> {
    // 并发控制点：对 pairing_codes 单行加排他锁，防止同一配对码在并发请求下被重复核销生成双份凭据
    const result = await this.db.execute(sql`
      SELECT
        code,
        owner_user_id AS "ownerUserId",
        auto_join_room_id AS "autoJoinRoomId",
        reclaim_agent_id AS "reclaimAgentId",
        expires_at AS "expiresAt",
        used_at AS "usedAt"
      FROM pairing_codes
      WHERE code = ${code}
      FOR UPDATE
    `);

    const row = extractSqlRows<{
      readonly code: string;
      readonly ownerUserId: string;
      readonly autoJoinRoomId: string | null;
      readonly reclaimAgentId: string | null;
      readonly expiresAt: Date | string;
      readonly usedAt: Date | string | null;
    }>(result)[0];

    if (!row) {
      return undefined;
    }

    return {
      code: row.code as PairingCode,
      ownerUserId: row.ownerUserId as UserId,
      autoJoinRoomId: row.autoJoinRoomId !== null ? (row.autoJoinRoomId as RoomId) : null,
      reclaimAgentId: row.reclaimAgentId !== null ? (row.reclaimAgentId as AgentId) : null,
      expiresAt: row.expiresAt instanceof Date ? row.expiresAt : new Date(row.expiresAt),
      usedAt:
        row.usedAt === null ? null : row.usedAt instanceof Date ? row.usedAt : new Date(row.usedAt),
    };
  }

  /**
   * 查询指定人类主人公开资料。
   *
   * @param userId - 人类用户主键
   * @returns `HumanUserDto` 或 `undefined`
   */
  public async findOwnerById(userId: UserId): Promise<HumanUserDto | undefined> {
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
   * 按 `(ownerUserId, slug)` 查找已注册的同名 Agent。
   *
   * @param ownerUserId - 人类主人主键
   * @param slug - 规范化 Agent slug
   * @returns `SafeAgentRecord` 或 `undefined`
   */
  public async findAgentByOwnerAndSlug(
    ownerUserId: UserId,
    slug: string,
  ): Promise<SafeAgentRecord | undefined> {
    const rows = await this.db
      .select({
        id: agentsTable.id,
        ownerUserId: agentsTable.ownerUserId,
        displayName: agentsTable.displayName,
        slug: agentsTable.slug,
        platform: agentsTable.platform,
        intro: agentsTable.intro,
        wakeKind: agentsTable.wakeKind,
        checkinIntervalMin: agentsTable.checkinIntervalMin,
        lastSeenAt: agentsTable.lastSeenAt,
        createdAt: agentsTable.createdAt,
      })
      .from(agentsTable)
      .where(and(eq(agentsTable.ownerUserId, ownerUserId), eq(agentsTable.slug, slug)))
      .limit(1);

    const row = rows[0];
    return row ? mapAgentRowToSafe(row) : undefined;
  }

  /**
   * 插入全新绑定的 Agent 记录并返回脱敏投影。
   *
   * @param input - 新 Agent 字段与 SHA-256 令牌摘要
   * @returns 脱敏后的 `SafeAgentRecord`
   */
  public async insertAgent(input: {
    readonly id: AgentId;
    readonly ownerUserId: UserId;
    readonly displayName: string;
    readonly slug: string;
    readonly platform: AgentPlatform;
    readonly intro?: string;
    readonly tokenHash: string;
    readonly now: Date;
  }): Promise<SafeAgentRecord> {
    const inserted = await this.db
      .insert(agentsTable)
      .values({
        id: input.id,
        ownerUserId: input.ownerUserId,
        displayName: input.displayName,
        slug: input.slug,
        platform: input.platform,
        intro: input.intro ?? null,
        tokenHash: input.tokenHash,
        lastSeenAt: input.now,
      })
      .returning({
        id: agentsTable.id,
        ownerUserId: agentsTable.ownerUserId,
        displayName: agentsTable.displayName,
        slug: agentsTable.slug,
        platform: agentsTable.platform,
        intro: agentsTable.intro,
        wakeKind: agentsTable.wakeKind,
        checkinIntervalMin: agentsTable.checkinIntervalMin,
        lastSeenAt: agentsTable.lastSeenAt,
        createdAt: agentsTable.createdAt,
      });

    const row = inserted[0];
    if (!row) {
      throw new Error("Failed to insert new paired agent row.");
    }
    return mapAgentRowToSafe(row);
  }

  /**
   * 为掉线认领（`--reclaim`）的已有 Agent 原子轮换 `token_hash` 并刷新在线心跳。
   *
   * @param input - 待轮换的 Agent 主键、新 SHA-256 哈希及展示资料更新
   * @returns 轮换后的脱敏 `SafeAgentRecord`
   */
  public async rotateAgentTokenAndProfile(input: {
    readonly agentId: AgentId;
    readonly displayName: string;
    readonly platform: AgentPlatform;
    readonly intro?: string;
    readonly tokenHash: string;
    readonly now: Date;
  }): Promise<SafeAgentRecord> {
    const updated = await this.db
      .update(agentsTable)
      .set({
        displayName: input.displayName,
        platform: input.platform,
        ...(input.intro !== undefined ? { intro: input.intro } : {}),
        tokenHash: input.tokenHash,
        lastSeenAt: input.now,
      })
      .where(eq(agentsTable.id, input.agentId))
      .returning({
        id: agentsTable.id,
        ownerUserId: agentsTable.ownerUserId,
        displayName: agentsTable.displayName,
        slug: agentsTable.slug,
        platform: agentsTable.platform,
        intro: agentsTable.intro,
        wakeKind: agentsTable.wakeKind,
        checkinIntervalMin: agentsTable.checkinIntervalMin,
        lastSeenAt: agentsTable.lastSeenAt,
        createdAt: agentsTable.createdAt,
      });

    const row = updated[0];
    if (!row) {
      throw new Error(`Failed to rotate token for reclaimed agent ${input.agentId}.`);
    }
    return mapAgentRowToSafe(row);
  }

  /**
   * 标记一次性配对码为已消费。
   *
   * @param code - 配对码
   * @param usedAt - 核销时间
   */
  public async markPairingCodeUsed(code: PairingCode, usedAt: Date): Promise<void> {
    await this.db.update(pairingCodesTable).set({ usedAt }).where(eq(pairingCodesTable.code, code));
  }

  /**
   * 将配对成功的 Agent 幂等加入目标房间（若已在群内则保留原角色与 `lastReadSeq` 游标）。
   *
   * @param roomId - 自动入群的目标房间主键
   * @param agentId - Agent 主键
   */
  public async ensureAgentRoomMembership(roomId: RoomId, agentId: AgentId): Promise<void> {
    // 幂等入群：ON CONFLICT DO NOTHING 确保通过 --reclaim 重连的 Agent 不会丢失原先积累的 last_read_seq
    await this.db
      .insert(roomMembersTable)
      .values({
        roomId,
        memberKey: `agent:${agentId}`,
        memberKind: "agent",
        agentId,
        role: "member",
        lastReadSeq: 0,
      })
      .onConflictDoNothing();
  }
}
