/**
 * @module server/modules/rooms/repo
 * @description 房间元数据（`rooms`）、成员名册与已读游标（`room_members`）参数化数据库仓储层。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 行级并发保护：涉及房间治理状态或可见性变更时，必须通过 `lockRoomByIdForUpdate` 获取排他行锁后再计算新快照。
 * 2. 透明可达性聚合：查询房间成员列表时单次关联人类与 Agent 所属主人昵称，并结合 `RealtimeBus` 实时计算每个 Agent 的 `reach` 状态灯，绝不暴露 `token_hash`。
 */
import { type OpenHuddleDb, roomMembersTable, roomsTable } from "@openhuddle/db";
import {
  ActorKindSchema,
  type AgentId,
  AgentPlatformSchema,
  type RoomDetailDto,
  type RoomGovernanceState,
  RoomGovernanceStateSchema,
  type RoomId,
  type RoomMemberDto,
  type RoomMemberRole,
  RoomMemberRoleSchema,
  type RoomSummaryDto,
  type RoomVisibility,
  RoomVisibilitySchema,
  type UserId,
  asReadCursorSeq,
} from "@openhuddle/protocol";
import { and, desc, eq, sql } from "drizzle-orm";
import { computeAgentReachState } from "../../infra/identity-stamp.js";
import type { RealtimeBus } from "../../infra/realtime-bus.js";
import { extractSqlRows } from "../../infra/sql-rows.js";

/**
 * 数据库 `rooms` 表强类型内部记录投影。
 */
export interface RoomRecord {
  readonly id: RoomId;
  readonly ownerUserId: UserId;
  readonly name: string;
  readonly topic: string;
  readonly rules: string;
  readonly visibility: RoomVisibility;
  readonly inviteToken: string;
  readonly governanceJson: RoomGovernanceState;
  readonly lastSeq: number;
  readonly createdAt: Date;
}

/**
 * 房间成员基础权限与已读游标记录。
 */
export interface RoomMembershipRecord {
  readonly roomId: RoomId;
  readonly memberKey: string;
  readonly memberKind: "human" | "agent";
  readonly role: RoomMemberRole;
  readonly lastReadSeq: number;
}

function parseGovernanceJson(raw: unknown): RoomGovernanceState {
  const obj = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
  return RoomGovernanceStateSchema.parse(obj);
}

function mapRoomRow(row: {
  readonly id: string;
  readonly ownerUserId: string;
  readonly name: string;
  readonly topic: string;
  readonly rules: string;
  readonly visibility: string;
  readonly inviteToken: string;
  readonly governanceJson: unknown;
  readonly lastSeq: number;
  readonly createdAt: Date | string;
}): RoomRecord {
  return {
    id: row.id as RoomId,
    ownerUserId: row.ownerUserId as UserId,
    name: row.name,
    topic: row.topic,
    rules: row.rules,
    visibility: RoomVisibilitySchema.parse(row.visibility),
    inviteToken: row.inviteToken,
    governanceJson: parseGovernanceJson(row.governanceJson),
    lastSeq: Number(row.lastSeq),
    createdAt: row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt),
  };
}

/**
 * 将内部 `RoomRecord` 与成员列表组装为对外 `RoomDetailDto`。
 *
 * @param room - 房间持久层记录
 * @param members - 已水合可达状态的成员列表
 * @param options - 当前查看者的已读游标及是否隐藏 `inviteToken`（如公开只读分享页）
 * @returns 标准 `RoomDetailDto`
 */
export function buildRoomDetailDto(
  room: Readonly<RoomRecord>,
  members: readonly RoomMemberDto[],
  options: {
    readonly yourLastReadSeq: number;
    readonly includeInviteToken: boolean;
  },
): RoomDetailDto {
  return {
    id: room.id,
    ownerUserId: room.ownerUserId,
    name: room.name,
    topic: room.topic,
    rules: room.rules,
    visibility: room.visibility,
    ...(options.includeInviteToken ? { inviteToken: room.inviteToken } : {}),
    lastSeq: asReadCursorSeq(room.lastSeq),
    yourLastReadSeq: asReadCursorSeq(options.yourLastReadSeq),
    governance: room.governanceJson,
    members: [...members],
    createdAtIso: room.createdAt.toISOString(),
  };
}

/**
 * 房间与成员名册数据库仓储类。
 */
export class RoomsRepository {
  private readonly db: OpenHuddleDb;

  /**
   * @param db - Drizzle PostgreSQL / PGlite 实例
   */
  public constructor(db: OpenHuddleDb) {
    this.db = db;
  }

  /**
   * 在数据库事务中运行房间与成员的原子变更。
   *
   * @param fn - 接收事务级 `RoomsRepository` 的异步回调
   * @returns 回调结果
   */
  public async runInTransaction<T>(fn: (txRepo: RoomsRepository) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      const txRepo = new RoomsRepository(tx as unknown as OpenHuddleDb);
      return fn(txRepo);
    });
  }

  /**
   * 通过排他行锁（`SELECT ... FOR UPDATE`）读取房间记录，供治理热更新安全演进状态。
   *
   * @param roomId - 房间主键
   * @returns 锁定的 `RoomRecord` 或 `undefined`
   */
  public async lockRoomByIdForUpdate(roomId: RoomId): Promise<RoomRecord | undefined> {
    // 并发控制点：热更新房间治理配置或续命预算时锁定 rooms 单行，防止与正在提交发言的事务互相覆盖 governance_json
    const result = await this.db.execute(sql`
      SELECT
        id,
        owner_user_id AS "ownerUserId",
        name,
        topic,
        rules,
        visibility,
        invite_token AS "inviteToken",
        governance_json AS "governanceJson",
        last_seq AS "lastSeq",
        created_at AS "createdAt"
      FROM rooms
      WHERE id = ${roomId}
      FOR UPDATE
    `);

    const row = extractSqlRows<{
      readonly id: string;
      readonly ownerUserId: string;
      readonly name: string;
      readonly topic: string;
      readonly rules: string;
      readonly visibility: string;
      readonly inviteToken: string;
      readonly governanceJson: unknown;
      readonly lastSeq: number;
      readonly createdAt: Date | string;
    }>(result)[0];

    return row ? mapRoomRow(row) : undefined;
  }

  /**
   * 按主键查询房间记录。
   *
   * @param roomId - 房间主键
   * @returns `RoomRecord` 或 `undefined`
   */
  public async findRoomById(roomId: RoomId): Promise<RoomRecord | undefined> {
    const rows = await this.db.select().from(roomsTable).where(eq(roomsTable.id, roomId)).limit(1);
    const row = rows[0];
    return row ? mapRoomRow(row) : undefined;
  }

  /**
   * 按 `inviteToken` 查找房间记录（供邀请入群与公开只读分享页使用）。
   *
   * @param inviteToken - 房间邀请令牌（`inv_...`）
   * @returns `RoomRecord` 或 `undefined`
   */
  public async findRoomByInviteToken(inviteToken: string): Promise<RoomRecord | undefined> {
    const rows = await this.db
      .select()
      .from(roomsTable)
      .where(eq(roomsTable.inviteToken, inviteToken))
      .limit(1);
    const row = rows[0];
    return row ? mapRoomRow(row) : undefined;
  }

  /**
   * 列出指定成员（人类或 Agent）已加入的所有房间摘要，按房间创建时间倒序排列。
   *
   * @param memberKey - 确定性成员键（`human:usr_...` 或 `agent:agt_...`）
   * @returns `RoomSummaryDto` 列表
   */
  public async listJoinedRooms(memberKey: string): Promise<readonly RoomSummaryDto[]> {
    const rows = await this.db
      .select({
        id: roomsTable.id,
        name: roomsTable.name,
        topic: roomsTable.topic,
        visibility: roomsTable.visibility,
        lastSeq: roomsTable.lastSeq,
        yourLastReadSeq: roomMembersTable.lastReadSeq,
        governanceJson: roomsTable.governanceJson,
        createdAt: roomsTable.createdAt,
      })
      .from(roomMembersTable)
      .innerJoin(roomsTable, eq(roomMembersTable.roomId, roomsTable.id))
      .where(eq(roomMembersTable.memberKey, memberKey))
      .orderBy(desc(roomsTable.createdAt));

    return rows.map((row) => ({
      id: row.id as RoomId,
      name: row.name,
      topic: row.topic,
      visibility: RoomVisibilitySchema.parse(row.visibility),
      lastSeq: asReadCursorSeq(row.lastSeq),
      yourLastReadSeq: asReadCursorSeq(row.yourLastReadSeq),
      governance: parseGovernanceJson(row.governanceJson),
      createdAtIso: row.createdAt.toISOString(),
    }));
  }

  /**
   * 插入新创建的房间记录。
   *
   * @param input - 新房间完整字段
   * @returns 持久化的 `RoomRecord`
   */
  public async insertRoom(input: {
    readonly id: RoomId;
    readonly ownerUserId: UserId;
    readonly name: string;
    readonly topic: string;
    readonly rules: string;
    readonly visibility: RoomVisibility;
    readonly inviteToken: string;
    readonly governanceJson: RoomGovernanceState;
  }): Promise<RoomRecord> {
    const inserted = await this.db
      .insert(roomsTable)
      .values({
        id: input.id,
        ownerUserId: input.ownerUserId,
        name: input.name,
        topic: input.topic,
        rules: input.rules,
        visibility: input.visibility,
        inviteToken: input.inviteToken,
        governanceJson: input.governanceJson,
        lastSeq: 0,
      })
      .returning();

    const row = inserted[0];
    if (!row) {
      throw new Error("Failed to insert room row.");
    }
    return mapRoomRow(row);
  }

  /**
   * 幂等插入房间成员记录（若已在群内则保持现有角色与 `lastReadSeq` 不变）。
   *
   * @param input - 成员绑定参数
   */
  public async addRoomMemberIfAbsent(input: {
    readonly roomId: RoomId;
    readonly memberKey: string;
    readonly memberKind: "human" | "agent";
    readonly userId?: UserId;
    readonly agentId?: AgentId;
    readonly role: RoomMemberRole;
    readonly lastReadSeq?: number;
  }): Promise<void> {
    await this.db
      .insert(roomMembersTable)
      .values({
        roomId: input.roomId,
        memberKey: input.memberKey,
        memberKind: input.memberKind,
        userId: input.userId ?? null,
        agentId: input.agentId ?? null,
        role: input.role,
        lastReadSeq: input.lastReadSeq ?? 0,
      })
      .onConflictDoNothing();
  }

  /**
   * 查询指定成员在房间内的角色与已读游标。
   *
   * @param roomId - 房间主键
   * @param memberKey - 确定性成员键
   * @returns 成员关系记录或 `undefined`
   */
  public async findMembership(
    roomId: RoomId,
    memberKey: string,
  ): Promise<RoomMembershipRecord | undefined> {
    const rows = await this.db
      .select({
        roomId: roomMembersTable.roomId,
        memberKey: roomMembersTable.memberKey,
        memberKind: roomMembersTable.memberKind,
        role: roomMembersTable.role,
        lastReadSeq: roomMembersTable.lastReadSeq,
      })
      .from(roomMembersTable)
      .where(and(eq(roomMembersTable.roomId, roomId), eq(roomMembersTable.memberKey, memberKey)))
      .limit(1);

    const row = rows[0];
    if (!row) {
      return undefined;
    }

    return {
      roomId: row.roomId as RoomId,
      memberKey: row.memberKey,
      memberKind: ActorKindSchema.parse(row.memberKind),
      role: RoomMemberRoleSchema.parse(row.role),
      lastReadSeq: row.lastReadSeq,
    };
  }

  /**
   * 将指定成员移出房间。
   *
   * @param roomId - 房间主键
   * @param memberKey - 确定性成员键
   */
  public async removeMember(roomId: RoomId, memberKey: string): Promise<void> {
    await this.db
      .delete(roomMembersTable)
      .where(and(eq(roomMembersTable.roomId, roomId), eq(roomMembersTable.memberKey, memberKey)));
  }

  /**
   * 更新房间的治理状态快照及可选的公开可见性策略。
   *
   * @param roomId - 房间主键
   * @param patch - 新治理快照与可选 `visibility`
   * @returns 更新后的 `RoomRecord`
   */
  public async updateGovernanceAndVisibility(
    roomId: RoomId,
    patch: {
      readonly governanceJson: RoomGovernanceState;
      readonly visibility?: RoomVisibility;
    },
  ): Promise<RoomRecord> {
    const updated = await this.db
      .update(roomsTable)
      .set({
        governanceJson: patch.governanceJson,
        ...(patch.visibility !== undefined ? { visibility: patch.visibility } : {}),
      })
      .where(eq(roomsTable.id, roomId))
      .returning();

    const row = updated[0];
    if (!row) {
      throw new Error(`Failed to update governance state for room ${roomId}.`);
    }
    return mapRoomRow(row);
  }

  /**
   * 查询房间内全部成员详情并注入实时 `reach` 可达状态（严禁读取或返回 `agents.token_hash`）。
   *
   * @param roomId - 房间主键
   * @param realtimeBus - 实时事件总线（查询 Agent 活跃 SSE 连接）
   * @returns 按入群时间升序排列的 `RoomMemberDto` 列表
   */
  public async listHydratedMembers(
    roomId: RoomId,
    realtimeBus: RealtimeBus,
  ): Promise<readonly RoomMemberDto[]> {
    const result = await this.db.execute(sql`
      SELECT
        rm.member_kind AS "memberKind",
        rm.user_id AS "userId",
        rm.agent_id AS "agentId",
        rm.role AS "role",
        rm.last_read_seq AS "lastReadSeq",
        rm.joined_at AS "joinedAt",
        u_human.display_name AS "humanDisplayName",
        a.owner_user_id AS "agentOwnerUserId",
        a.display_name AS "agentDisplayName",
        a.platform AS "agentPlatform",
        a.wake_kind AS "agentWakeKind",
        a.checkin_interval_min AS "agentCheckinIntervalMin",
        a.last_seen_at AS "agentLastSeenAt",
        u_owner.display_name AS "agentOwnerDisplayName"
      FROM room_members rm
      LEFT JOIN users u_human ON rm.user_id = u_human.id
      LEFT JOIN agents a ON rm.agent_id = a.id
      LEFT JOIN users u_owner ON a.owner_user_id = u_owner.id
      WHERE rm.room_id = ${roomId}
      ORDER BY rm.joined_at ASC
    `);

    const nowMs = Date.now();
    return extractSqlRows<{
      readonly memberKind: string;
      readonly userId: string | null;
      readonly agentId: string | null;
      readonly role: string;
      readonly lastReadSeq: number;
      readonly joinedAt: Date | string;
      readonly humanDisplayName: string | null;
      readonly agentOwnerUserId: string | null;
      readonly agentDisplayName: string | null;
      readonly agentPlatform: string | null;
      readonly agentWakeKind: string | null;
      readonly agentCheckinIntervalMin: number | null;
      readonly agentLastSeenAt: Date | string | null;
      readonly agentOwnerDisplayName: string | null;
    }>(result).map((row): RoomMemberDto => {
      const kind = ActorKindSchema.parse(row.memberKind);
      const role = RoomMemberRoleSchema.parse(row.role);
      const joinedAt = row.joinedAt instanceof Date ? row.joinedAt : new Date(row.joinedAt);

      if (kind === "human") {
        const userId = (row.userId ?? "") as UserId;
        const displayName = row.humanDisplayName ?? "Owner";
        return {
          memberKind: "human",
          userId,
          ownerUserId: userId,
          ownerDisplayName: displayName,
          displayName,
          role,
          lastReadSeq: asReadCursorSeq(Number(row.lastReadSeq)),
          joinedAtIso: joinedAt.toISOString(),
        };
      }

      const agentId = (row.agentId ?? "") as AgentId;
      const ownerUserId = (row.agentOwnerUserId ?? "") as UserId;
      const platform = AgentPlatformSchema.parse(row.agentPlatform ?? "custom");
      const lastSeenAt =
        row.agentLastSeenAt === null
          ? null
          : row.agentLastSeenAt instanceof Date
            ? row.agentLastSeenAt
            : new Date(row.agentLastSeenAt);

      const reach = computeAgentReachState(
        {
          id: agentId,
          platform,
          wakeKind: row.agentWakeKind ?? "none",
          checkinIntervalMin: row.agentCheckinIntervalMin,
          lastSeenAt,
        },
        realtimeBus,
        nowMs,
      );

      return {
        memberKind: "agent",
        agentId,
        ownerUserId,
        ownerDisplayName: row.agentOwnerDisplayName ?? "Owner",
        displayName: row.agentDisplayName ?? "Agent",
        role,
        platform,
        reach,
        lastReadSeq: asReadCursorSeq(Number(row.lastReadSeq)),
        joinedAtIso: joinedAt.toISOString(),
      };
    });
  }
}
