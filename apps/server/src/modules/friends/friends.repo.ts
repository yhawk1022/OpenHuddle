/**
 * @module server/modules/friends/repo
 * @description 人类好友关系状态机（`friendships`）、站内用户脱敏检索与跨主人开放私聊 Agent 发现数据库仓储层（ADR-0005）。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 无序规范化对键唯一性：任意两名人类用户（`userA`, `userB`）通过字典序构造唯一的 `pair_key = "<lowId>:<highId>"`，杜绝双向交叉插入产生重复好友行。
 * 2. 严格脱敏与封禁过滤：搜索与好友水合统一过滤 `users.status = 'active'`，且物理排除 `password_hash`、`token_hash` 等敏感字段。
 */
import { type OpenHuddleDb, friendshipsTable, usersTable } from "@openhuddle/db";
import {
  type AgentId,
  AgentPlatformSchema,
  type DirectoryUserSearchItemDto,
  type FriendContactDto,
  type FriendRequestDto,
  type FriendshipId,
  type PublicUserProfileDto,
  type RoomId,
  type SharedExternalAgentDto,
  type UserId,
  type UserRelationshipStatus,
} from "@openhuddle/protocol";
import { and, eq, or, sql } from "drizzle-orm";
import { computeAgentReachState } from "../../infra/identity-stamp.js";
import type { RealtimeBus } from "../../infra/realtime-bus.js";
import { extractSqlRows } from "../../infra/sql-rows.js";

/**
 * 内部持久化的好友关系记录投影。
 */
export interface FriendshipRecord {
  readonly id: FriendshipId;
  readonly pairKey: string;
  readonly userLowId: UserId;
  readonly userHighId: UserId;
  readonly requesterUserId: UserId;
  readonly addresseeUserId: UserId;
  readonly status: "pending" | "accepted";
  readonly note: string | null;
  readonly respondedAt: Date | null;
  readonly createdAt: Date;
}

/**
 * 将两个无序 `UserId` 确定性地映射为字典序规范化对键及高低位主键。
 *
 * @param userA - 用户 A 主键
 * @param userB - 用户 B 主键
 * @returns 规范化 `{ pairKey, userLowId, userHighId }`
 */
export function toCanonicalUserPair(
  userA: UserId,
  userB: UserId,
): {
  readonly pairKey: string;
  readonly userLowId: UserId;
  readonly userHighId: UserId;
} {
  if (userA <= userB) {
    return {
      pairKey: `${userA}:${userB}`,
      userLowId: userA,
      userHighId: userB,
    };
  }
  return {
    pairKey: `${userB}:${userA}`,
    userLowId: userB,
    userHighId: userA,
  };
}

/**
 * 生成两名人类好友之间全局唯一的 `rooms.direct_pair_key`。
 *
 * @param userA - 用户 A 主键
 * @param userB - 用户 B 主键
 * @returns 形如 `dm_human:<lowId>:<highId>` 的唯一键
 */
export function toDirectHumanPairKey(userA: UserId, userB: UserId): string {
  const { pairKey } = toCanonicalUserPair(userA, userB);
  return `dm_human:${pairKey}`;
}

/**
 * 生成指定人类与指定 Agent 之间全局唯一的 `rooms.direct_pair_key`。
 *
 * @param humanUserId - 人类参与者主键
 * @param agentId - 目标 Agent 主键
 * @returns 形如 `dm_agent:<humanUserId>:<agentId>` 的唯一键
 */
export function toDirectAgentPairKey(humanUserId: UserId, agentId: AgentId): string {
  return `dm_agent:${humanUserId}:${agentId}`;
}

function toDate(val: Date | string): Date {
  return val instanceof Date ? val : new Date(val);
}

function mapFriendshipRow(row: {
  readonly id: string;
  readonly pairKey: string;
  readonly userLowId: string;
  readonly userHighId: string;
  readonly requesterUserId: string;
  readonly addresseeUserId: string;
  readonly status: string;
  readonly note: string | null;
  readonly respondedAt: Date | string | null;
  readonly createdAt: Date | string;
}): FriendshipRecord {
  return {
    id: row.id as FriendshipId,
    pairKey: row.pairKey,
    userLowId: row.userLowId as UserId,
    userHighId: row.userHighId as UserId,
    requesterUserId: row.requesterUserId as UserId,
    addresseeUserId: row.addresseeUserId as UserId,
    status: row.status === "accepted" ? "accepted" : "pending",
    note: row.note,
    respondedAt: row.respondedAt !== null ? toDate(row.respondedAt) : null,
    createdAt: toDate(row.createdAt),
  };
}

/**
 * 好友关系、申请与站内用户检索仓储类。
 */
export class FriendsRepository {
  private readonly db: OpenHuddleDb;

  /**
   * @param db - Drizzle PostgreSQL / PGlite 实例
   */
  public constructor(db: OpenHuddleDb) {
    this.db = db;
  }

  /**
   * 在数据库事务内原子执行好友申请与状态转换。
   *
   * @param fn - 事务回调
   * @returns 回调结果
   */
  public async runInTransaction<T>(fn: (txRepo: FriendsRepository) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      const txRepo = new FriendsRepository(tx as unknown as OpenHuddleDb);
      return fn(txRepo);
    });
  }

  /**
   * 按主键查询处于正常活跃态（`status = 'active'`）的人类公开名片。
   *
   * @param userId - 目标用户主键
   * @returns `PublicUserProfileDto` 或 `undefined`
   */
  public async findActiveUserById(userId: UserId): Promise<PublicUserProfileDto | undefined> {
    const rows = await this.db
      .select({
        userId: usersTable.id,
        displayName: usersTable.displayName,
        email: usersTable.email,
      })
      .from(usersTable)
      .where(and(eq(usersTable.id, userId), eq(usersTable.status, "active")))
      .limit(1);

    const row = rows[0];
    if (!row) {
      return undefined;
    }
    return {
      userId: row.userId as UserId,
      displayName: row.displayName,
      email: row.email,
    };
  }

  /**
   * 按规范化邮箱查询处于正常活跃态（`status = 'active'`）的人类公开名片。
   *
   * @param email - 小写邮箱地址
   * @returns `PublicUserProfileDto` 或 `undefined`
   */
  public async findActiveUserByEmail(email: string): Promise<PublicUserProfileDto | undefined> {
    const rows = await this.db
      .select({
        userId: usersTable.id,
        displayName: usersTable.displayName,
        email: usersTable.email,
      })
      .from(usersTable)
      .where(and(eq(usersTable.email, email.trim().toLowerCase()), eq(usersTable.status, "active")))
      .limit(1);

    const row = rows[0];
    if (!row) {
      return undefined;
    }
    return {
      userId: row.userId as UserId,
      displayName: row.displayName,
      email: row.email,
    };
  }

  /**
   * 校验两名人类用户当前是否已建立 `accepted` 好友关系且双方账号均处于 `active` 正常状态。
   *
   * @param userA - 用户 A 主键
   * @param userB - 用户 B 主键
   * @returns 若互为有效好友返回 `true`
   */
  public async areUsersAcceptedFriends(userA: UserId, userB: UserId): Promise<boolean> {
    if (userA === userB) {
      return false;
    }
    const { pairKey } = toCanonicalUserPair(userA, userB);
    const result = await this.db.execute(sql`
      SELECT f.id
      FROM friendships f
      INNER JOIN users u_low ON f.user_low_id = u_low.id
      INNER JOIN users u_high ON f.user_high_id = u_high.id
      WHERE f.pair_key = ${pairKey}
        AND f.status = 'accepted'
        AND u_low.status = 'active'
        AND u_high.status = 'active'
      LIMIT 1
    `);
    return extractSqlRows<{ readonly id: string }>(result).length > 0;
  }

  /**
   * 在事务中按 `pairKey` 施加排他行锁（`SELECT ... FOR UPDATE`）读取好友记录。
   *
   * @param pairKey - 规范化对键
   * @returns 锁定的 `FriendshipRecord` 或 `undefined`
   */
  public async lockByPairKeyForUpdate(pairKey: string): Promise<FriendshipRecord | undefined> {
    const result = await this.db.execute(sql`
      SELECT
        id,
        pair_key AS "pairKey",
        user_low_id AS "userLowId",
        user_high_id AS "userHighId",
        requester_user_id AS "requesterUserId",
        addressee_user_id AS "addresseeUserId",
        status,
        note,
        responded_at AS "respondedAt",
        created_at AS "createdAt"
      FROM friendships
      WHERE pair_key = ${pairKey}
      FOR UPDATE
    `);

    const row = extractSqlRows<{
      readonly id: string;
      readonly pairKey: string;
      readonly userLowId: string;
      readonly userHighId: string;
      readonly requesterUserId: string;
      readonly addresseeUserId: string;
      readonly status: string;
      readonly note: string | null;
      readonly respondedAt: Date | string | null;
      readonly createdAt: Date | string;
    }>(result)[0];

    return row ? mapFriendshipRow(row) : undefined;
  }

  /**
   * 在事务中按主键 `friendshipId` 施加排他行锁读取好友记录。
   *
   * @param friendshipId - 好友关系主键
   * @returns 锁定的 `FriendshipRecord` 或 `undefined`
   */
  public async lockByIdForUpdate(
    friendshipId: FriendshipId,
  ): Promise<FriendshipRecord | undefined> {
    const result = await this.db.execute(sql`
      SELECT
        id,
        pair_key AS "pairKey",
        user_low_id AS "userLowId",
        user_high_id AS "userHighId",
        requester_user_id AS "requesterUserId",
        addressee_user_id AS "addresseeUserId",
        status,
        note,
        responded_at AS "respondedAt",
        created_at AS "createdAt"
      FROM friendships
      WHERE id = ${friendshipId}
      FOR UPDATE
    `);

    const row = extractSqlRows<{
      readonly id: string;
      readonly pairKey: string;
      readonly userLowId: string;
      readonly userHighId: string;
      readonly requesterUserId: string;
      readonly addresseeUserId: string;
      readonly status: string;
      readonly note: string | null;
      readonly respondedAt: Date | string | null;
      readonly createdAt: Date | string;
    }>(result)[0];

    return row ? mapFriendshipRow(row) : undefined;
  }

  /**
   * 尝试以 `ON CONFLICT (pair_key) DO NOTHING` 原子插入一条待处理好友申请。
   *
   * @remarks
   * 并发控制点：当甲乙双方在同一毫秒互发首次好友申请时，唯一索引确保仅一方插入成功，另一方返回 `undefined` 后回退至 `lockByPairKeyForUpdate` 自动升级为双向接受。
   *
   * @param input - 好友申请完整字段
   * @returns 若本次成功插入则返回 `FriendshipRecord`，若命中唯一键冲突则返回 `undefined`
   */
  public async tryInsertPendingRequest(input: {
    readonly id: FriendshipId;
    readonly pairKey: string;
    readonly userLowId: UserId;
    readonly userHighId: UserId;
    readonly requesterUserId: UserId;
    readonly addresseeUserId: UserId;
    readonly note?: string;
  }): Promise<FriendshipRecord | undefined> {
    const inserted = await this.db
      .insert(friendshipsTable)
      .values({
        id: input.id,
        pairKey: input.pairKey,
        userLowId: input.userLowId,
        userHighId: input.userHighId,
        requesterUserId: input.requesterUserId,
        addresseeUserId: input.addresseeUserId,
        status: "pending",
        note: input.note ?? null,
      })
      .onConflictDoNothing()
      .returning();

    const row = inserted[0];
    return row ? mapFriendshipRow(row) : undefined;
  }

  /**
   * 更新待处理好友申请的附言文本。
   *
   * @param friendshipId - 好友申请主键
   * @param note - 新附言
   */
  public async updatePendingNote(friendshipId: FriendshipId, note: string): Promise<void> {
    await this.db
      .update(friendshipsTable)
      .set({ note })
      .where(eq(friendshipsTable.id, friendshipId));
  }

  /**
   * 原子更新已接受关系中调用者自己的备注。
   *
   * @param friendshipId - 当前好友关系主键
   * @param viewerUserId - 已认证的备注所有者
   * @param remark - 规范化备注，`null` 表示清空
   * @returns 是否命中已接受且属于调用者的关系
   */
  public async updateFriendRemark(
    friendshipId: FriendshipId,
    viewerUserId: UserId,
    remark: string | null,
  ): Promise<boolean> {
    const isLowUser = eq(friendshipsTable.userLowId, viewerUserId);
    const isHighUser = eq(friendshipsTable.userHighId, viewerUserId);
    // 资格校验和更新使用同一条语句，并发改备注时保留对方锁定后的当前值。
    const updated = await this.db
      .update(friendshipsTable)
      .set({
        userLowRemark: sql`CASE WHEN ${isLowUser} THEN ${remark} ELSE ${friendshipsTable.userLowRemark} END`,
        userHighRemark: sql`CASE WHEN ${isHighUser} THEN ${remark} ELSE ${friendshipsTable.userHighRemark} END`,
      })
      .where(
        and(
          eq(friendshipsTable.id, friendshipId),
          eq(friendshipsTable.status, "accepted"),
          or(isLowUser, isHighUser),
        ),
      )
      .returning({ id: friendshipsTable.id });
    return updated.length > 0;
  }

  /**
   * 将好友申请标记为已接受（`status = 'accepted'`）。
   *
   * @param friendshipId - 好友关系主键
   * @param now - 接受时间
   * @returns 更新后的 `FriendshipRecord`
   */
  public async markAccepted(friendshipId: FriendshipId, now: Date): Promise<FriendshipRecord> {
    const updated = await this.db
      .update(friendshipsTable)
      .set({
        status: "accepted",
        respondedAt: now,
      })
      .where(eq(friendshipsTable.id, friendshipId))
      .returning();

    const row = updated[0];
    if (!row) {
      throw new Error(`Failed to mark friendship "${friendshipId}" as accepted.`);
    }
    return mapFriendshipRow(row);
  }

  /**
   * 按主键物理删除好友申请或已建立的好友关系。
   *
   * @param friendshipId - 好友关系主键
   */
  public async deleteById(friendshipId: FriendshipId): Promise<void> {
    await this.db.delete(friendshipsTable).where(eq(friendshipsTable.id, friendshipId));
  }

  /**
   * 按规范化 `pairKey` 删除两名用户之间的好友关系并返回原记录（若存在）。
   *
   * @param pairKey - 规范化对键
   * @returns 被删除的记录或 `undefined`
   */
  public async deleteByPairKey(pairKey: string): Promise<FriendshipRecord | undefined> {
    const deleted = await this.db
      .delete(friendshipsTable)
      .where(eq(friendshipsTable.pairKey, pairKey))
      .returning();
    const row = deleted[0];
    return row ? mapFriendshipRow(row) : undefined;
  }

  /**
   * 按昵称或邮箱模糊检索站内活跃用户，并注入与当前调用者（`viewerUserId`）的实时社交关系状态。
   *
   * @param viewerUserId - 当前查询者人类主键
   * @param rawQuery - 搜索关键词
   * @param limit - 最大返回条数（默认 20）
   * @returns `DirectoryUserSearchItemDto` 列表
   */
  public async searchActiveUsers(
    viewerUserId: UserId,
    rawQuery: string,
    limit = 20,
  ): Promise<readonly DirectoryUserSearchItemDto[]> {
    const trimmed = rawQuery.trim();
    const likePattern = `%${trimmed}%`;

    const result = await this.db.execute(sql`
      SELECT
        u.id AS "userId",
        u.display_name AS "displayName",
        u.email AS "email",
        f.id AS "friendshipId",
        f.status AS "friendshipStatus",
        f.requester_user_id AS "requesterUserId",
        COALESCE(a_agg."sharedAgentCount", 0)::int AS "sharedAgentCount"
      FROM users u
      LEFT JOIN friendships f
        ON f.pair_key = CASE
          WHEN ${viewerUserId} <= u.id THEN ${viewerUserId} || ':' || u.id
          ELSE u.id || ':' || ${viewerUserId}
        END
      LEFT JOIN (
        SELECT owner_user_id, COUNT(*)::int AS "sharedAgentCount"
        FROM agents
        WHERE allow_external_dm = TRUE
        GROUP BY owner_user_id
      ) a_agg ON a_agg.owner_user_id = u.id
      WHERE u.status = 'active'
        AND (u.display_name ILIKE ${likePattern} OR u.email ILIKE ${likePattern})
      ORDER BY
        CASE WHEN u.id = ${viewerUserId} THEN 1 ELSE 0 END ASC,
        CASE WHEN LOWER(u.email) = LOWER(${trimmed}) OR LOWER(u.display_name) = LOWER(${trimmed}) THEN 0 ELSE 1 END ASC,
        u.display_name ASC
      LIMIT ${limit}
    `);

    return extractSqlRows<{
      readonly userId: string;
      readonly displayName: string;
      readonly email: string;
      readonly friendshipId: string | null;
      readonly friendshipStatus: string | null;
      readonly requesterUserId: string | null;
      readonly sharedAgentCount: number;
    }>(result).map((row): DirectoryUserSearchItemDto => {
      const targetId = row.userId as UserId;
      let relationship: UserRelationshipStatus = "none";
      if (targetId === viewerUserId) {
        relationship = "self";
      } else if (row.friendshipStatus === "accepted") {
        relationship = "friends";
      } else if (row.friendshipStatus === "pending") {
        relationship =
          row.requesterUserId === viewerUserId ? "outgoing_pending" : "incoming_pending";
      }

      return {
        user: {
          userId: targetId,
          displayName: row.displayName,
          email: row.email,
        },
        relationship,
        ...(row.friendshipId !== null ? { friendshipId: row.friendshipId as FriendshipId } : {}),
        sharedAgentCount: Number(row.sharedAgentCount),
      };
    });
  }

  /**
   * 加载指定人类用户的完整通讯录视图（已通过好友、收发待审申请以及全站开启 `allow_external_dm` 的外部 Agent）。
   *
   * @param viewerUserId - 当前登录人类主键
   * @param realtimeBus - 实时事件总线（计算外部开放 Agent 的 `reach` 状态）
   * @returns 结构化通讯录数据集合
   */
  public async getFriendsOverviewData(
    viewerUserId: UserId,
    realtimeBus: RealtimeBus,
  ): Promise<{
    readonly friends: readonly FriendContactDto[];
    readonly incomingRequests: readonly FriendRequestDto[];
    readonly outgoingRequests: readonly FriendRequestDto[];
    readonly discoverableAgents: readonly SharedExternalAgentDto[];
  }> {
    const nowMs = Date.now();

    const [relationRes, externalAgentsRes] = await Promise.all([
      this.db.execute(sql`
        SELECT
          f.id AS "friendshipId",
          f.pair_key AS "pairKey",
          f.requester_user_id AS "requesterUserId",
          f.addressee_user_id AS "addresseeUserId",
          f.status AS "status",
          f.note AS "note",
          CASE WHEN f.user_low_id = ${viewerUserId}
            THEN f.user_low_remark ELSE f.user_high_remark END AS "viewerRemark",
          f.responded_at AS "respondedAt",
          f.created_at AS "createdAt",
          u_peer.id AS "peerUserId",
          u_peer.display_name AS "peerDisplayName",
          u_peer.email AS "peerEmail",
          r_dm.id AS "directRoomId"
        FROM friendships f
        INNER JOIN users u_peer
          ON u_peer.id = CASE
            WHEN f.user_low_id = ${viewerUserId} THEN f.user_high_id
            ELSE f.user_low_id
          END
        LEFT JOIN rooms r_dm
          ON r_dm.direct_pair_key = ('dm_human:' || f.pair_key)
        WHERE (f.user_low_id = ${viewerUserId} OR f.user_high_id = ${viewerUserId})
          AND u_peer.status = 'active'
        ORDER BY COALESCE(f.responded_at, f.created_at) DESC
      `),
      this.db.execute(sql`
        SELECT
          a.id AS "id",
          a.owner_user_id AS "ownerUserId",
          u.display_name AS "ownerDisplayName",
          a.display_name AS "displayName",
          a.slug AS "slug",
          a.platform AS "platform",
          a.intro AS "intro",
          a.wake_kind AS "wakeKind",
          a.checkin_interval_min AS "checkinIntervalMin",
          a.last_seen_at AS "lastSeenAt"
        FROM agents a
        INNER JOIN users u ON a.owner_user_id = u.id
        WHERE a.allow_external_dm = TRUE
          AND a.owner_user_id <> ${viewerUserId}
          AND u.status = 'active'
        ORDER BY a.created_at DESC
        LIMIT 100
      `),
    ]);

    const discoverableAgents: SharedExternalAgentDto[] = extractSqlRows<{
      readonly id: string;
      readonly ownerUserId: string;
      readonly ownerDisplayName: string;
      readonly displayName: string;
      readonly slug: string;
      readonly platform: string;
      readonly intro: string | null;
      readonly wakeKind: string;
      readonly checkinIntervalMin: number | null;
      readonly lastSeenAt: Date | string | null;
    }>(externalAgentsRes).map((row) => {
      const agentId = row.id as AgentId;
      const platform = AgentPlatformSchema.parse(row.platform);
      const lastSeenAt = row.lastSeenAt !== null ? toDate(row.lastSeenAt) : null;
      const reach = computeAgentReachState(
        {
          id: agentId,
          wakeKind: row.wakeKind,
          checkinIntervalMin: row.checkinIntervalMin,
          lastSeenAt,
        },
        realtimeBus,
        nowMs,
      );
      return {
        id: agentId,
        ownerUserId: row.ownerUserId as UserId,
        ownerDisplayName: row.ownerDisplayName,
        displayName: row.displayName,
        slug: row.slug,
        platform,
        ...(row.intro !== null && row.intro.trim().length > 0 ? { intro: row.intro } : {}),
        reach,
        allowExternalDm: true,
      };
    });

    const sharedAgentsByOwner = new Map<UserId, SharedExternalAgentDto[]>();
    for (const agt of discoverableAgents) {
      const existing = sharedAgentsByOwner.get(agt.ownerUserId) ?? [];
      existing.push(agt);
      sharedAgentsByOwner.set(agt.ownerUserId, existing);
    }

    const friends: FriendContactDto[] = [];
    const incomingRequests: FriendRequestDto[] = [];
    const outgoingRequests: FriendRequestDto[] = [];

    for (const row of extractSqlRows<{
      readonly friendshipId: string;
      readonly pairKey: string;
      readonly requesterUserId: string;
      readonly addresseeUserId: string;
      readonly status: string;
      readonly note: string | null;
      readonly viewerRemark: string | null;
      readonly respondedAt: Date | string | null;
      readonly createdAt: Date | string;
      readonly peerUserId: string;
      readonly peerDisplayName: string;
      readonly peerEmail: string;
      readonly directRoomId: string | null;
    }>(relationRes)) {
      const peerUserId = row.peerUserId as UserId;
      const peerProfile: PublicUserProfileDto = {
        userId: peerUserId,
        displayName: row.peerDisplayName,
        email: row.peerEmail,
      };
      const friendshipId = row.friendshipId as FriendshipId;
      const createdAt = toDate(row.createdAt);

      if (row.status === "accepted") {
        const friendsSince = row.respondedAt !== null ? toDate(row.respondedAt) : createdAt;
        friends.push({
          friendshipId,
          user: peerProfile,
          ...(row.viewerRemark !== null ? { remark: row.viewerRemark } : {}),
          friendsSinceIso: friendsSince.toISOString(),
          ...(row.directRoomId !== null ? { directRoomId: row.directRoomId as RoomId } : {}),
          sharedAgents: sharedAgentsByOwner.get(peerUserId) ?? [],
        });
      } else if (row.addresseeUserId === viewerUserId) {
        incomingRequests.push({
          friendshipId,
          direction: "incoming",
          peer: peerProfile,
          ...(row.note !== null && row.note.trim().length > 0 ? { note: row.note } : {}),
          createdAtIso: createdAt.toISOString(),
        });
      } else {
        outgoingRequests.push({
          friendshipId,
          direction: "outgoing",
          peer: peerProfile,
          ...(row.note !== null && row.note.trim().length > 0 ? { note: row.note } : {}),
          createdAtIso: createdAt.toISOString(),
        });
      }
    }

    return {
      friends,
      incomingRequests,
      outgoingRequests,
      discoverableAgents,
    };
  }
}
