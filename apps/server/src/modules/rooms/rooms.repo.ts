/**
 * @module server/modules/rooms/repo
 * @description 多模态会话房间元数据（`rooms`：群聊 `group` / 单聊 Agent `direct_agent` / 人类私聊 `direct_human`）、成员名册与已读游标（`room_members`）参数化数据库仓储层。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 行级并发保护：涉及房间治理状态或可见性变更时，必须通过 `lockRoomByIdForUpdate` 获取排他行锁后再计算新快照。
 * 2. 单聊对端动态视角水合：查询 `direct_agent` 与 `direct_human` 列表或详情时，基于当前 `viewer` 动态解析对端 `DirectChatPeerDto` 并实时覆盖展示标题，确保对方改昵称或上线后即时反映且绝不暴露 `token_hash`。
 * 3. 单聊邀请码物理隔离：`buildRoomDetailDto` 对非 `group` 房间强制剥离 `inviteToken`，从源头阻断通过邀请码向 1v1 私聊拉入第三人。
 */
import { type OpenHuddleDb, pairingCodesTable, roomMembersTable, roomsTable } from "@openhuddle/db";
import {
  ActorKindSchema,
  type AgentId,
  AgentPlatformSchema,
  type AuthenticatedCaller,
  type DirectChatPeerDto,
  type RoomDetailDto,
  type RoomGovernanceState,
  RoomGovernanceStateSchema,
  type RoomId,
  type RoomKind,
  RoomKindSchema,
  type RoomMemberDto,
  type RoomMemberRole,
  RoomMemberRoleSchema,
  type RoomSummaryDto,
  type RoomVisibility,
  RoomVisibilitySchema,
  type UserId,
  asReadCursorSeq,
} from "@openhuddle/protocol";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { computeAgentReachState } from "../../infra/identity-stamp.js";
import type { RealtimeBus } from "../../infra/realtime-bus.js";
import { extractSqlRows } from "../../infra/sql-rows.js";

/**
 * 数据库 `rooms` 表强类型内部记录投影。
 */
export interface RoomRecord {
  readonly id: RoomId;
  readonly kind: RoomKind;
  readonly directPairKey: string | null;
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

interface InternalHydratedMemberRow {
  readonly roomId: string;
  readonly memberKind: string;
  readonly userId: string | null;
  readonly agentId: string | null;
  readonly role: string;
  readonly lastReadSeq: number;
  readonly joinedAt: Date | string;
  readonly humanDisplayName: string | null;
  readonly humanEmail: string | null;
  readonly agentOwnerUserId: string | null;
  readonly agentDisplayName: string | null;
  readonly agentSlug: string | null;
  readonly agentIntro: string | null;
  readonly agentAllowExternalDm: boolean | null;
  readonly agentPlatform: string | null;
  readonly agentWakeKind: string | null;
  readonly agentCheckinIntervalMin: number | null;
  readonly agentLastSeenAt: Date | string | null;
  readonly agentOwnerDisplayName: string | null;
}

interface InternalMemberWithEmail {
  readonly dto: RoomMemberDto;
  readonly humanEmail?: string;
}

function parseGovernanceJson(raw: unknown): RoomGovernanceState {
  const obj = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
  return RoomGovernanceStateSchema.parse(obj);
}

function mapRoomRow(row: {
  readonly id: string;
  readonly kind?: string;
  readonly directPairKey?: string | null;
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
    kind: RoomKindSchema.parse(row.kind ?? "group"),
    directPairKey: row.directPairKey ?? null,
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

function mapInternalMemberRow(
  row: InternalHydratedMemberRow,
  realtimeBus: RealtimeBus | undefined,
  nowMs: number,
): InternalMemberWithEmail {
  const kind = ActorKindSchema.parse(row.memberKind);
  const role = RoomMemberRoleSchema.parse(row.role);
  const joinedAt = row.joinedAt instanceof Date ? row.joinedAt : new Date(row.joinedAt);

  if (kind === "human") {
    const userId = (row.userId ?? "") as UserId;
    const displayName = row.humanDisplayName ?? "Owner";
    return {
      dto: {
        memberKind: "human",
        userId,
        ownerUserId: userId,
        ownerDisplayName: displayName,
        displayName,
        role,
        lastReadSeq: asReadCursorSeq(Number(row.lastReadSeq)),
        joinedAtIso: joinedAt.toISOString(),
      },
      ...(row.humanEmail !== null ? { humanEmail: row.humanEmail } : {}),
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

  const reach =
    realtimeBus !== undefined
      ? computeAgentReachState(
          {
            id: agentId,
            platform,
            wakeKind: row.agentWakeKind ?? "none",
            checkinIntervalMin: row.agentCheckinIntervalMin,
            lastSeenAt,
          },
          realtimeBus,
          nowMs,
        )
      : row.agentCheckinIntervalMin !== null
        ? "polling"
        : "offline";

  return {
    dto: {
      memberKind: "agent",
      agentId,
      ownerUserId,
      ownerDisplayName: row.agentOwnerDisplayName ?? "Owner",
      displayName: row.agentDisplayName ?? "Agent",
      ...(row.agentSlug !== null ? { slug: row.agentSlug } : {}),
      ...(row.agentIntro !== null && row.agentIntro.trim().length > 0
        ? { intro: row.agentIntro }
        : {}),
      allowExternalDm: row.agentAllowExternalDm === true,
      role,
      platform,
      reach,
      lastReadSeq: asReadCursorSeq(Number(row.lastReadSeq)),
      joinedAtIso: joinedAt.toISOString(),
    },
  };
}

/**
 * 从 1v1 单聊成员列表中针对当前 `viewer` 解析对端 `DirectChatPeerDto`。
 */
export function resolveDirectPeerForViewer(
  kind: RoomKind,
  members: readonly InternalMemberWithEmail[],
  viewer: Readonly<AuthenticatedCaller> | undefined,
): DirectChatPeerDto | undefined {
  if (kind === "group" || viewer === undefined) {
    return undefined;
  }

  if (kind === "direct_agent") {
    if (viewer.kind === "human") {
      const agt = members.find((m) => m.dto.memberKind === "agent")?.dto;
      if (agt?.agentId !== undefined) {
        return {
          kind: "agent",
          agentId: agt.agentId,
          displayName: agt.displayName,
          slug: agt.slug ?? agt.displayName,
          platform: agt.platform ?? "custom",
          ...(agt.intro !== undefined ? { intro: agt.intro } : {}),
          reach: agt.reach ?? "offline",
          ownerUserId: agt.ownerUserId,
          ownerDisplayName: agt.ownerDisplayName,
          allowExternalDm: agt.allowExternalDm === true,
        };
      }
    } else {
      const hum = members.find((m) => m.dto.memberKind === "human");
      if (hum?.dto.userId !== undefined) {
        return {
          kind: "human",
          userId: hum.dto.userId,
          displayName: hum.dto.displayName,
          ...(hum.humanEmail !== undefined ? { email: hum.humanEmail } : {}),
        };
      }
    }
    return undefined;
  }

  // kind === "direct_human"
  const peerHuman =
    members.find(
      (m) =>
        m.dto.memberKind === "human" && (viewer.kind !== "human" || m.dto.userId !== viewer.userId),
    ) ?? members.find((m) => m.dto.memberKind === "human");

  if (peerHuman?.dto.userId !== undefined) {
    return {
      kind: "human",
      userId: peerHuman.dto.userId,
      displayName: peerHuman.dto.displayName,
      ...(peerHuman.humanEmail !== undefined ? { email: peerHuman.humanEmail } : {}),
    };
  }
  return undefined;
}

/**
 * 将内部 `RoomRecord` 与成员列表组装为对外 `RoomDetailDto`。
 *
 * @param room - 房间持久层记录
 * @param members - 已水合可达状态的成员列表
 * @param options - 当前查看者的已读游标、是否允许包含 `inviteToken` 及可选查看者身份
 * @returns 标准 `RoomDetailDto`
 */
export function buildRoomDetailDto(
  room: Readonly<RoomRecord>,
  members: readonly RoomMemberDto[],
  options: {
    readonly yourLastReadSeq: number;
    readonly includeInviteToken: boolean;
    readonly viewer?: Readonly<AuthenticatedCaller>;
    readonly peerOverride?: DirectChatPeerDto;
  },
): RoomDetailDto {
  const peer =
    options.peerOverride ??
    resolveDirectPeerForViewer(
      room.kind,
      members.map((dto) => ({ dto })),
      options.viewer,
    );
  const displayTitle = room.kind !== "group" && peer !== undefined ? peer.displayName : room.name;
  // 安全不变量：1v1 单聊会话永远不对外下发 inviteToken，防止邀请链接泄漏破坏双人私密边界
  const canExposeInviteToken = options.includeInviteToken && room.kind === "group";

  return {
    id: room.id,
    kind: room.kind,
    ownerUserId: room.ownerUserId,
    name: displayTitle,
    topic: room.topic,
    rules: room.rules,
    visibility: room.visibility,
    ...(canExposeInviteToken ? { inviteToken: room.inviteToken } : {}),
    lastSeq: asReadCursorSeq(room.lastSeq),
    yourLastReadSeq: asReadCursorSeq(options.yourLastReadSeq),
    governance: room.governanceJson,
    ...(peer !== undefined ? { peer } : {}),
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
        kind,
        direct_pair_key AS "directPairKey",
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
      readonly kind: string;
      readonly directPairKey: string | null;
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
   * 按确定性 `directPairKey` 查询已存在的 1v1 单聊房间记录（ADR-0005）。
   *
   * @param directPairKey - 唯一对键（`dm_agent:...` 或 `dm_human:...`）
   * @returns `RoomRecord` 或 `undefined`
   */
  public async findRoomByDirectPairKey(directPairKey: string): Promise<RoomRecord | undefined> {
    const rows = await this.db
      .select()
      .from(roomsTable)
      .where(eq(roomsTable.directPairKey, directPairKey))
      .limit(1);
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
   * 列出指定成员（人类或 Agent）已加入的所有房间摘要，按房间创建时间倒序排列，并批量水合 1v1 单聊对端信息。
   *
   * @param memberKey - 确定性成员键（`human:usr_...` 或 `agent:agt_...`）
   * @param viewer - 可选当前查看者身份（用于动态解析单聊对端 `peer` 与显示标题）
   * @param realtimeBus - 可选实时事件总线（用于实时计算单聊 Agent 的 `reach` 状态灯）
   * @returns `RoomSummaryDto` 列表
   */
  public async listJoinedRooms(
    memberKey: string,
    viewer?: Readonly<AuthenticatedCaller>,
    realtimeBus?: RealtimeBus,
  ): Promise<readonly RoomSummaryDto[]> {
    const rows = await this.db
      .select({
        id: roomsTable.id,
        kind: roomsTable.kind,
        ownerUserId: roomsTable.ownerUserId,
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

    const directRoomIds = rows.filter((r) => r.kind !== "group").map((r) => r.id);

    const membersByDirectRoom = new Map<string, InternalMemberWithEmail[]>();
    if (directRoomIds.length > 0 && viewer !== undefined) {
      const memberRows = await this.listInternalMembersForRoomIds(directRoomIds, realtimeBus);
      for (const entry of memberRows) {
        const list = membersByDirectRoom.get(entry.roomId) ?? [];
        list.push(entry.member);
        membersByDirectRoom.set(entry.roomId, list);
      }
    }

    return rows.map((row): RoomSummaryDto => {
      const kind = RoomKindSchema.parse(row.kind);
      const peer =
        kind !== "group"
          ? resolveDirectPeerForViewer(kind, membersByDirectRoom.get(row.id) ?? [], viewer)
          : undefined;
      const displayTitle = kind !== "group" && peer !== undefined ? peer.displayName : row.name;

      return {
        id: row.id as RoomId,
        kind,
        ownerUserId: row.ownerUserId as UserId,
        name: displayTitle,
        topic: row.topic,
        visibility: RoomVisibilitySchema.parse(row.visibility),
        lastSeq: asReadCursorSeq(row.lastSeq),
        yourLastReadSeq: asReadCursorSeq(row.yourLastReadSeq),
        governance: parseGovernanceJson(row.governanceJson),
        ...(peer !== undefined ? { peer } : {}),
        createdAtIso: row.createdAt.toISOString(),
      };
    });
  }

  /**
   * 插入新创建的房间记录。
   *
   * @param input - 新房间完整字段
   * @returns 持久化的 `RoomRecord`
   */
  public async insertRoom(input: {
    readonly id: RoomId;
    readonly kind?: RoomKind;
    readonly directPairKey?: string;
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
        kind: input.kind ?? "group",
        directPairKey: input.directPairKey ?? null,
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
   * 尝试以 `ON CONFLICT (direct_pair_key) DO NOTHING` 幂等插入 1v1 单聊房间（防并发重复点击竞态）。
   *
   * @param input - 单聊房间参数
   * @returns 若本次成功创建返回 `RoomRecord`，若已被并发事务先行创建则返回 `undefined`
   */
  public async tryInsertDirectRoom(input: {
    readonly id: RoomId;
    readonly kind: "direct_agent" | "direct_human";
    readonly directPairKey: string;
    readonly ownerUserId: UserId;
    readonly name: string;
    readonly topic: string;
    readonly inviteToken: string;
    readonly governanceJson: RoomGovernanceState;
  }): Promise<RoomRecord | undefined> {
    const inserted = await this.db
      .insert(roomsTable)
      .values({
        id: input.id,
        kind: input.kind,
        directPairKey: input.directPairKey,
        ownerUserId: input.ownerUserId,
        name: input.name,
        topic: input.topic,
        rules: "",
        visibility: "invite_only",
        inviteToken: input.inviteToken,
        governanceJson: input.governanceJson,
        lastSeq: 0,
      })
      .onConflictDoNothing({ target: roomsTable.directPairKey })
      .returning();

    const row = inserted[0];
    return row ? mapRoomRow(row) : undefined;
  }

  /**
   * 幂等插入房间成员记录（若已在群内则保持现有角色与 `lastReadSeq` 不变）。
   *
   * @param input - 成员绑定参数
   * @returns 若实际新增了成员返回 `true`，已在房间内返回 `false`
   */
  public async addRoomMemberIfAbsent(input: {
    readonly roomId: RoomId;
    readonly memberKey: string;
    readonly memberKind: "human" | "agent";
    readonly userId?: UserId;
    readonly agentId?: AgentId;
    readonly role: RoomMemberRole;
    readonly lastReadSeq?: number;
  }): Promise<boolean> {
    const inserted = await this.db
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
      .onConflictDoNothing()
      .returning({ memberKey: roomMembersTable.memberKey });
    return inserted.length > 0;
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
   * 清空指向待删除房间的待用配对码自动入群引用（`pairing_codes.auto_join_room_id = NULL`）。
   *
   * @param roomId - 待删除的房间主键
   */
  public async clearPairingCodesForRoom(roomId: RoomId): Promise<void> {
    await this.db
      .update(pairingCodesTable)
      .set({ autoJoinRoomId: null })
      .where(eq(pairingCodesTable.autoJoinRoomId, roomId));
  }

  /**
   * 按主键彻底物理删除房间记录。
   *
   * @param roomId - 待删除的房间主键
   * @returns 若实际删除了房间行则返回 `true`
   */
  public async deleteRoomById(roomId: RoomId): Promise<boolean> {
    const deleted = await this.db
      .delete(roomsTable)
      .where(eq(roomsTable.id, roomId))
      .returning({ id: roomsTable.id });
    return deleted.length > 0;
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

  private async listInternalMembersForRoomIds(
    roomIds: readonly string[],
    realtimeBus: RealtimeBus | undefined,
  ): Promise<ReadonlyArray<{ readonly roomId: string; readonly member: InternalMemberWithEmail }>> {
    if (roomIds.length === 0) {
      return [];
    }
    const idFragments = roomIds.map((id) => sql`${id}`);
    const inClause = sql.join(idFragments, sql`, `);
    const result = await this.db.execute(sql`
      SELECT
        rm.room_id AS "roomId",
        rm.member_kind AS "memberKind",
        rm.user_id AS "userId",
        rm.agent_id AS "agentId",
        rm.role AS "role",
        rm.last_read_seq AS "lastReadSeq",
        rm.joined_at AS "joinedAt",
        u_human.display_name AS "humanDisplayName",
        u_human.email AS "humanEmail",
        a.owner_user_id AS "agentOwnerUserId",
        a.display_name AS "agentDisplayName",
        a.slug AS "agentSlug",
        a.intro AS "agentIntro",
        a.allow_external_dm AS "agentAllowExternalDm",
        a.platform AS "agentPlatform",
        a.wake_kind AS "agentWakeKind",
        a.checkin_interval_min AS "agentCheckinIntervalMin",
        a.last_seen_at AS "agentLastSeenAt",
        u_owner.display_name AS "agentOwnerDisplayName"
      FROM room_members rm
      LEFT JOIN users u_human ON rm.user_id = u_human.id
      LEFT JOIN agents a ON rm.agent_id = a.id
      LEFT JOIN users u_owner ON a.owner_user_id = u_owner.id
      WHERE rm.room_id IN (${inClause})
      ORDER BY rm.joined_at ASC
    `);

    const nowMs = Date.now();
    return extractSqlRows<InternalHydratedMemberRow>(result).map((row) => ({
      roomId: row.roomId,
      member: mapInternalMemberRow(row, realtimeBus, nowMs),
    }));
  }

  /**
   * 查询指定房间成员并连带内部人类邮箱投影（供单聊对端解析复用）。
   */
  public async listHydratedMembersWithPeerMeta(
    roomId: RoomId,
    realtimeBus: RealtimeBus,
  ): Promise<{
    readonly members: readonly RoomMemberDto[];
    readonly internal: readonly InternalMemberWithEmail[];
  }> {
    const entries = await this.listInternalMembersForRoomIds([roomId], realtimeBus);
    const internal = entries.map((e) => e.member);
    return {
      members: internal.map((m) => m.dto),
      internal,
    };
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
    const { members } = await this.listHydratedMembersWithPeerMeta(roomId, realtimeBus);
    return members;
  }

  /**
   * 查询多个房间的人类成员主键集合（用于删除房间后通知对端）。
   */
  public async listHumanMemberUserIds(roomId: RoomId): Promise<readonly UserId[]> {
    const rows = await this.db
      .select({ userId: roomMembersTable.userId })
      .from(roomMembersTable)
      .where(
        and(eq(roomMembersTable.roomId, roomId), inArray(roomMembersTable.memberKind, ["human"])),
      );
    const ids: UserId[] = [];
    for (const row of rows) {
      if (row.userId !== null) {
        ids.push(row.userId as UserId);
      }
    }
    return ids;
  }
}
