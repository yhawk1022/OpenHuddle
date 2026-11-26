/**
 * @module server/modules/messages/repo
 * @description 房间单调递增消息流（`messages`）、排他房间锁与乐观已读游标推进数据库仓储层。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 严格锁顺序（`rooms FOR UPDATE -> room_members -> messages`）：任何分配 `seq` 的写入路径都必须先锁住目标 `rooms` 行，杜绝跳号与并发撞键。
 * 2. 原始归属与视角解耦：仓储层仅还原数据库真实的 `RawAuthorIdentity`（严禁从消息 JSON 负载读取身份），交由服务层按查看者动态计算 `AuthorStamp`。
 * 3. 单调游标推进：更新 `room_members.last_read_seq` 时强制使用 `GREATEST(last_read_seq, nextSeq)`，防止乱序并发读请求导致游标倒退。
 */
import {
  type OpenHuddleDb,
  messageAttachmentsTable,
  messagesTable,
  roomMembersTable,
  roomsTable,
} from "@openhuddle/db";
import {
  ActorKindSchema,
  type AgentId,
  AgentPlatformSchema,
  type AttentionPayload,
  AttentionPayloadSchema,
  type AuthenticatedCaller,
  type MessageAttachment,
  MessageAttachmentSchema,
  type MessageDto,
  type MessageMention,
  MessageMentionSchema,
  type MessageSeq,
  type MessageType,
  MessageTypeSchema,
  type OperationKey,
  type RawAuthorIdentity,
  type ReadCursorSeq,
  type RoomGovernanceState,
  RoomGovernanceStateSchema,
  type RoomId,
  type RoomKind,
  RoomKindSchema,
  type RoomMemberRole,
  RoomMemberRoleSchema,
  type UserId,
  asMessageSeq,
  computeAuthorStamp,
} from "@openhuddle/protocol";
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { extractSqlRows } from "../../infra/sql-rows.js";

const MentionsArraySchema = z.array(MessageMentionSchema);
const AttachmentPayloadSchema = z.object({
  attachment: MessageAttachmentSchema,
});

/**
 * 已校验的附件元数据与字节，仅在发送事务或独立下载时使用。
 */
export interface StoredMessageAttachment {
  readonly metadata: MessageAttachment;
  readonly bytes: Uint8Array;
}

/**
 * 包含真实作者归属信息但尚未绑定特定查看者视角的内部消息记录。
 */
export interface HydratedRawMessageRecord {
  readonly roomId: RoomId;
  readonly seq: MessageSeq;
  readonly type: MessageType;
  readonly rawAuthor: RawAuthorIdentity;
  readonly content: string;
  readonly replyToSeq: MessageSeq | undefined;
  readonly mentions: readonly MessageMention[];
  readonly attention: AttentionPayload | undefined;
  readonly attachment: MessageAttachment | undefined;
  readonly recalledAt: Date | null;
  readonly createdAt: Date;
}

/**
 * 锁定后的房间核心序号与治理记录。
 */
export interface LockedRoomForMessageRecord {
  readonly id: RoomId;
  readonly kind: RoomKind;
  readonly ownerUserId: UserId;
  readonly name: string;
  readonly topic: string;
  readonly governanceJson: RoomGovernanceState;
  readonly lastSeq: number;
}

/**
 * 房间在席 Agent 的唤醒匹配标识与归属权限快照（支持通过正文 `@昵称` / `@slug` 自动补全提及及跨主人私聊鉴权）。
 */
export interface RoomAgentMentionTarget {
  readonly agentId: AgentId;
  readonly ownerUserId: UserId;
  readonly allowExternalDm: boolean;
  readonly displayName: string;
  readonly slug: string;
}

export interface RawSqlMessageRow {
  readonly roomId: string;
  readonly seq: number;
  readonly authorKind: string;
  readonly authorUserId: string | null;
  readonly authorAgentId: string | null;
  readonly ownerUserId: string;
  readonly type: string;
  readonly content: string;
  readonly replyToSeq: number | null;
  readonly mentionsJson: unknown;
  readonly payloadJson: unknown;
  readonly recalledAt: Date | string | null;
  readonly createdAt: Date | string;
  readonly humanDisplayName: string | null;
  readonly agentDisplayName: string | null;
  readonly agentPlatform: string | null;
}

function parseJsonColumn(raw: unknown): unknown {
  return typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
}

/**
 * 将联合查询得到的原始消息 SQL 行映射为领域内部的 `HydratedRawMessageRecord`。
 *
 * @param row - 联合 `users` 与 `agents` 表查询到的消息行
 * @returns 未绑定查看者视角的 `HydratedRawMessageRecord`
 */
export function mapSqlRowToHydratedMessage(row: RawSqlMessageRow): HydratedRawMessageRecord {
  const authorKind = ActorKindSchema.parse(row.authorKind);
  const ownerUserId = row.ownerUserId as UserId;

  const rawAuthor: RawAuthorIdentity =
    authorKind === "human"
      ? {
          kind: "human",
          ...(row.authorUserId !== null ? { userId: row.authorUserId as UserId } : {}),
          ownerUserId,
          displayName: row.humanDisplayName ?? "Unknown Owner",
        }
      : {
          kind: "agent",
          ...(row.authorAgentId !== null ? { agentId: row.authorAgentId as AgentId } : {}),
          ownerUserId,
          displayName: row.agentDisplayName ?? "Unknown Agent",
          ...(row.agentPlatform !== null
            ? { platform: AgentPlatformSchema.parse(row.agentPlatform) }
            : {}),
        };

  const mentions = MentionsArraySchema.parse(parseJsonColumn(row.mentionsJson ?? []));
  const parsedType = MessageTypeSchema.parse(row.type);
  const recalledAt =
    row.recalledAt === null
      ? null
      : row.recalledAt instanceof Date
        ? row.recalledAt
        : new Date(row.recalledAt);
  const createdAt = row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt);
  const payload = parseJsonColumn(row.payloadJson);
  const attention = parsedType === "attention" ? AttentionPayloadSchema.safeParse(payload) : null;
  const attachment = recalledAt === null ? AttachmentPayloadSchema.safeParse(payload) : null;

  return {
    roomId: row.roomId as RoomId,
    seq: asMessageSeq(Number(row.seq)),
    type: parsedType,
    rawAuthor,
    content: row.content,
    replyToSeq: row.replyToSeq !== null ? asMessageSeq(Number(row.replyToSeq)) : undefined,
    mentions,
    attention: attention?.data,
    attachment: attachment?.data?.attachment,
    recalledAt,
    createdAt,
  };
}

/**
 * 针对当前查看者（`viewer`）计算权威 `AuthorStamp` 并产出对外 `MessageDto`。
 *
 * @param record - 数据库还原的原始消息记录
 * @param viewer - 当前读取者或 SSE 接收者身份
 * @returns 带有防伪造 `trustLevel` 印章的 `MessageDto`
 */
export function stampRawMessageForViewer(
  record: Readonly<HydratedRawMessageRecord>,
  viewer: Readonly<AuthenticatedCaller>,
): MessageDto {
  return {
    roomId: record.roomId,
    seq: record.seq,
    type: record.type,
    // 安全边界：严格根据服务端数据库外键与当前已验证 viewer 实时盖章
    author: computeAuthorStamp(record.rawAuthor, viewer),
    content: record.content,
    ...(record.replyToSeq !== undefined ? { replyToSeq: record.replyToSeq } : {}),
    mentions: [...record.mentions],
    ...(record.attention !== undefined ? { attention: record.attention } : {}),
    ...(record.attachment !== undefined ? { attachment: record.attachment } : {}),
    ...(record.recalledAt !== null ? { recalledAtIso: record.recalledAt.toISOString() } : {}),
    createdAtIso: record.createdAt.toISOString(),
  };
}

/**
 * 房间消息流与并发游标仓储类。
 */
export class MessagesRepository {
  private readonly db: OpenHuddleDb;

  /**
   * @param db - Drizzle PostgreSQL / PGlite 实例
   */
  public constructor(db: OpenHuddleDb) {
    this.db = db;
  }

  /**
   * 在单个数据库事务中执行排他锁取号、治理状态演进与消息落库。
   *
   * @param fn - 事务回调
   * @returns 回调结果
   */
  public async runInTransaction<T>(fn: (txRepo: MessagesRepository) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      const txRepo = new MessagesRepository(tx as unknown as OpenHuddleDb);
      return fn(txRepo);
    });
  }

  /**
   * 在事务中对目标 `rooms` 行施加 `FOR UPDATE` 排他行锁。
   *
   * @param roomId - 房间主键
   * @returns 锁定后的房间序号与治理快照，不存在则返回 `undefined`
   */
  public async lockRoomForUpdate(roomId: RoomId): Promise<LockedRoomForMessageRecord | undefined> {
    // 关键并发不变量：必须在校验 lastReadSeq 与计算 nextSeq 之前获取 rooms 行级排他锁，串行化同房间并发写入
    const result = await this.db.execute(sql`
      SELECT
        id,
        kind,
        owner_user_id AS "ownerUserId",
        name,
        topic,
        governance_json AS "governanceJson",
        last_seq AS "lastSeq"
      FROM rooms
      WHERE id = ${roomId}
      FOR UPDATE
    `);

    const row = extractSqlRows<{
      readonly id: string;
      readonly kind?: string;
      readonly ownerUserId: string;
      readonly name: string;
      readonly topic: string;
      readonly governanceJson: unknown;
      readonly lastSeq: number;
    }>(result)[0];

    if (!row) {
      return undefined;
    }

    return {
      id: row.id as RoomId,
      kind: RoomKindSchema.parse(row.kind ?? "group"),
      ownerUserId: row.ownerUserId as UserId,
      name: row.name,
      topic: row.topic,
      governanceJson: RoomGovernanceStateSchema.parse(parseJsonColumn(row.governanceJson)),
      lastSeq: Number(row.lastSeq),
    };
  }

  /**
   * 无锁读取房间当前序号与治理状态快照（供 `GET /messages` 使用）。
   *
   * @param roomId - 房间主键
   * @returns 房间状态记录或 `undefined`
   */
  public async findRoomSnapshot(roomId: RoomId): Promise<LockedRoomForMessageRecord | undefined> {
    const rows = await this.db
      .select({
        id: roomsTable.id,
        kind: roomsTable.kind,
        ownerUserId: roomsTable.ownerUserId,
        name: roomsTable.name,
        topic: roomsTable.topic,
        governanceJson: roomsTable.governanceJson,
        lastSeq: roomsTable.lastSeq,
      })
      .from(roomsTable)
      .where(eq(roomsTable.id, roomId))
      .limit(1);

    const row = rows[0];
    if (!row) {
      return undefined;
    }

    return {
      id: row.id as RoomId,
      kind: RoomKindSchema.parse(row.kind),
      ownerUserId: row.ownerUserId as UserId,
      name: row.name,
      topic: row.topic,
      governanceJson: RoomGovernanceStateSchema.parse(parseJsonColumn(row.governanceJson)),
      lastSeq: row.lastSeq,
    };
  }

  /**
   * 查询调用者在房间内的成员角色与当前已读游标。
   *
   * @param roomId - 房间主键
   * @param memberKey - 确定性成员键
   * @returns `{ role, lastReadSeq }` 或 `undefined`
   */
  public async findMemberState(
    roomId: RoomId,
    memberKey: string,
  ): Promise<{ readonly role: RoomMemberRole; readonly lastReadSeq: number } | undefined> {
    const rows = await this.db
      .select({
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
      role: RoomMemberRoleSchema.parse(row.role),
      lastReadSeq: row.lastReadSeq,
    };
  }

  /**
   * 使用同一个查询快照校验房间成员资格与消息撤回状态，再读取附件。
   *
   * @param roomId - 房间主键
   * @param seq - 消息序号
   * @param memberKey - 由已认证身份派生的成员键
   * @returns 所在房间的访问结果；房间不存在时返回 `undefined`
   */
  public async findAttachment(
    roomId: RoomId,
    seq: MessageSeq,
    memberKey: string,
  ): Promise<
    | { readonly isMember: false }
    | {
        readonly isMember: true;
        readonly attachment?: StoredMessageAttachment;
        readonly rawAuthor?: RawAuthorIdentity;
      }
    | undefined
  > {
    const [row] = await this.db
      .select({
        memberKey: roomMembersTable.memberKey,
        payload: messagesTable.payloadJson,
        authorKind: messagesTable.authorKind,
        authorUserId: messagesTable.authorUserId,
        authorAgentId: messagesTable.authorAgentId,
        ownerUserId: messagesTable.ownerUserId,
        bytes: messageAttachmentsTable.bytes,
      })
      .from(roomsTable)
      .leftJoin(
        roomMembersTable,
        and(eq(roomMembersTable.roomId, roomsTable.id), eq(roomMembersTable.memberKey, memberKey)),
      )
      .leftJoin(
        messagesTable,
        and(
          eq(messagesTable.roomId, roomMembersTable.roomId),
          eq(messagesTable.seq, seq),
          isNull(messagesTable.recalledAt),
        ),
      )
      .leftJoin(
        messageAttachmentsTable,
        and(
          eq(messageAttachmentsTable.roomId, messagesTable.roomId),
          eq(messageAttachmentsTable.seq, messagesTable.seq),
        ),
      )
      .where(eq(roomsTable.id, roomId));

    if (row === undefined) {
      return undefined;
    }
    if (row.memberKey === null) {
      return { isMember: false };
    }
    if (row.bytes === null || row.authorKind === null || row.ownerUserId === null) {
      return { isMember: true };
    }
    const authorKind = ActorKindSchema.parse(row.authorKind);
    const rawAuthor: RawAuthorIdentity =
      authorKind === "human"
        ? {
            kind: "human",
            ...(row.authorUserId !== null ? { userId: row.authorUserId as UserId } : {}),
            ownerUserId: row.ownerUserId as UserId,
            displayName: "Author",
          }
        : {
            kind: "agent",
            ...(row.authorAgentId !== null ? { agentId: row.authorAgentId as AgentId } : {}),
            ownerUserId: row.ownerUserId as UserId,
            displayName: "Author",
          };
    const { attachment: metadata } = AttachmentPayloadSchema.parse(row.payload);
    return { isMember: true, attachment: { bytes: row.bytes, metadata }, rawAuthor };
  }

  /**
   * 列出当前房间内所有在席 Agent 的主键、展示名称与 `slug`（供正文 `@昵称` / `@slug` 提及解析与治理过滤使用）。
   *
   * @param roomId - 房间主键
   * @returns 在席 Agent 提及目标列表
   */
  public async listRoomAgentTargets(roomId: RoomId): Promise<readonly RoomAgentMentionTarget[]> {
    const result = await this.db.execute(sql`
      SELECT
        a.id AS "agentId",
        a.owner_user_id AS "ownerUserId",
        a.allow_external_dm AS "allowExternalDm",
        a.display_name AS "displayName",
        a.slug AS "slug"
      FROM room_members rm
      INNER JOIN agents a ON rm.agent_id = a.id
      WHERE rm.room_id = ${roomId} AND rm.member_kind = 'agent'
    `);

    return extractSqlRows<{
      readonly agentId: string;
      readonly ownerUserId: string;
      readonly allowExternalDm: boolean | null;
      readonly displayName: string;
      readonly slug: string;
    }>(result).map((row) => ({
      agentId: row.agentId as AgentId,
      ownerUserId: row.ownerUserId as UserId,
      allowExternalDm: row.allowExternalDm === true,
      displayName: row.displayName,
      slug: row.slug,
    }));
  }

  /**
   * 列出当前房间内所有人类成员的主键列表（供 1v1 好友私聊在事务内校验好友关系）。
   *
   * @param roomId - 房间主键
   * @returns 在席人类 `UserId` 数组
   */
  public async listRoomHumanUserIds(roomId: RoomId): Promise<readonly UserId[]> {
    const rows = await this.db
      .select({ userId: roomMembersTable.userId })
      .from(roomMembersTable)
      .where(and(eq(roomMembersTable.roomId, roomId), eq(roomMembersTable.memberKind, "human")));
    const ids: UserId[] = [];
    for (const row of rows) {
      if (row.userId !== null) {
        ids.push(row.userId as UserId);
      }
    }
    return ids;
  }

  /**
   * 在当前事务连接内直接校验两名人类用户是否保持有效 `accepted` 好友关系（避免 PGlite 单连接嵌套查库死锁）。
   *
   * @param userA - 用户 A 主键
   * @param userB - 用户 B 主键
   * @returns 互为有效好友返回 `true`
   */
  public async areUsersAcceptedFriends(userA: UserId, userB: UserId): Promise<boolean> {
    if (userA === userB) {
      return false;
    }
    const pairKey = userA <= userB ? `${userA}:${userB}` : `${userB}:${userA}`;
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
   * 列出当前房间内所有在席 Agent 的主键列表（供圆桌治理模式与广播提及过滤使用）。
   *
   * @param roomId - 房间主键
   * @returns 在席 `AgentId` 数组
   */
  public async listRoomAgentIds(roomId: RoomId): Promise<readonly AgentId[]> {
    const rows = await this.db
      .select({ agentId: roomMembersTable.agentId })
      .from(roomMembersTable)
      .where(and(eq(roomMembersTable.roomId, roomId), eq(roomMembersTable.memberKind, "agent")));

    const ids: AgentId[] = [];
    for (const row of rows) {
      if (row.agentId !== null) {
        ids.push(row.agentId as AgentId);
      }
    }
    return ids;
  }

  /**
   * 按 `(roomId, opKey)` 查询是否已有幂等成功写入的历史消息。
   *
   * @param roomId - 房间主键
   * @param opKey - 客户端幂等去重键
   * @returns 已存在的 `HydratedRawMessageRecord` 或 `undefined`
   */
  public async findByOpKey(
    roomId: RoomId,
    opKey: OperationKey,
  ): Promise<HydratedRawMessageRecord | undefined> {
    const result = await this.db.execute(sql`
      SELECT
        m.room_id AS "roomId",
        m.seq AS "seq",
        m.author_kind AS "authorKind",
        m.author_user_id AS "authorUserId",
        m.author_agent_id AS "authorAgentId",
        m.owner_user_id AS "ownerUserId",
        m.type AS "type",
        m.content AS "content",
        m.reply_to_seq AS "replyToSeq",
        m.mentions_json AS "mentionsJson",
          m.payload_json AS "payloadJson",
        m.recalled_at AS "recalledAt",
        m.created_at AS "createdAt",
        u.display_name AS "humanDisplayName",
        a.display_name AS "agentDisplayName",
        a.platform AS "agentPlatform"
      FROM messages m
      LEFT JOIN users u ON m.author_user_id = u.id
      LEFT JOIN agents a ON m.author_agent_id = a.id
      WHERE m.room_id = ${roomId} AND m.op_key = ${opKey}
      LIMIT 1
    `);

    const row = extractSqlRows<RawSqlMessageRow>(result)[0];
    return row ? mapSqlRowToHydratedMessage(row) : undefined;
  }

  /**
   * 按 `(roomId, seq)` 查询单条消息记录。
   *
   * @param roomId - 房间主键
   * @param seq - 消息序号
   * @returns `HydratedRawMessageRecord` 或 `undefined`
   */
  public async findBySeq(
    roomId: RoomId,
    seq: MessageSeq,
  ): Promise<HydratedRawMessageRecord | undefined> {
    const result = await this.db.execute(sql`
      SELECT
        m.room_id AS "roomId",
        m.seq AS "seq",
        m.author_kind AS "authorKind",
        m.author_user_id AS "authorUserId",
        m.author_agent_id AS "authorAgentId",
        m.owner_user_id AS "ownerUserId",
        m.type AS "type",
        m.content AS "content",
        m.reply_to_seq AS "replyToSeq",
        m.mentions_json AS "mentionsJson",
          m.payload_json AS "payloadJson",
        m.recalled_at AS "recalledAt",
        m.created_at AS "createdAt",
        u.display_name AS "humanDisplayName",
        a.display_name AS "agentDisplayName",
        a.platform AS "agentPlatform"
      FROM messages m
      LEFT JOIN users u ON m.author_user_id = u.id
      LEFT JOIN agents a ON m.author_agent_id = a.id
      WHERE m.room_id = ${roomId} AND m.seq = ${seq}
      LIMIT 1
    `);

    const row = extractSqlRows<RawSqlMessageRow>(result)[0];
    return row ? mapSqlRowToHydratedMessage(row) : undefined;
  }

  /**
   * 按 `seq > afterSeq` 升序拉取增量消息列表。
   *
   * @param roomId - 房间主键
   * @param afterSeq - 起始游标（不含）
   * @param limit - 最大返回条数
   * @returns 升序排列的 `HydratedRawMessageRecord` 数组
   */
  public async listAfterSeq(
    roomId: RoomId,
    afterSeq: ReadCursorSeq,
    limit: number,
  ): Promise<readonly HydratedRawMessageRecord[]> {
    const result = await this.db.execute(sql`
      SELECT
        m.room_id AS "roomId",
        m.seq AS "seq",
        m.author_kind AS "authorKind",
        m.author_user_id AS "authorUserId",
        m.author_agent_id AS "authorAgentId",
        m.owner_user_id AS "ownerUserId",
        m.type AS "type",
        m.content AS "content",
        m.reply_to_seq AS "replyToSeq",
        m.mentions_json AS "mentionsJson",
          m.payload_json AS "payloadJson",
        m.recalled_at AS "recalledAt",
        m.created_at AS "createdAt",
        u.display_name AS "humanDisplayName",
        a.display_name AS "agentDisplayName",
        a.platform AS "agentPlatform"
      FROM messages m
      LEFT JOIN users u ON m.author_user_id = u.id
      LEFT JOIN agents a ON m.author_agent_id = a.id
      WHERE m.room_id = ${roomId} AND m.seq > ${afterSeq}
      ORDER BY m.seq ASC
      LIMIT ${limit}
    `);

    return extractSqlRows<RawSqlMessageRow>(result).map(mapSqlRowToHydratedMessage);
  }

  /**
   * 拉取房间内最近 `limit` 条消息并按时间正序（`seq ASC`）返回，供 AI 主持人提炼提案使用。
   *
   * @param roomId - 房间主键
   * @param limit - 回溯窗口大小
   * @returns 按 `seq ASC` 排列的最近消息列表
   */
  public async listRecentChronological(
    roomId: RoomId,
    limit: number,
  ): Promise<readonly HydratedRawMessageRecord[]> {
    const result = await this.db.execute(sql`
      SELECT * FROM (
        SELECT
          m.room_id AS "roomId",
          m.seq AS "seq",
          m.author_kind AS "authorKind",
          m.author_user_id AS "authorUserId",
          m.author_agent_id AS "authorAgentId",
          m.owner_user_id AS "ownerUserId",
          m.type AS "type",
          m.content AS "content",
          m.reply_to_seq AS "replyToSeq",
          m.mentions_json AS "mentionsJson",
          m.payload_json AS "payloadJson",
          m.recalled_at AS "recalledAt",
          m.created_at AS "createdAt",
          u.display_name AS "humanDisplayName",
          a.display_name AS "agentDisplayName",
          a.platform AS "agentPlatform"
        FROM messages m
        LEFT JOIN users u ON m.author_user_id = u.id
        LEFT JOIN agents a ON m.author_agent_id = a.id
        WHERE m.room_id = ${roomId}
        ORDER BY m.seq DESC
        LIMIT ${limit}
      ) recent
      ORDER BY recent."seq" ASC
    `);

    return extractSqlRows<RawSqlMessageRow>(result).map(mapSqlRowToHydratedMessage);
  }

  /**
   * 插入一条新房间消息并返回水合后的作者归属记录。
   *
   * @param input - 严格由服务端根据已认证 `caller` 派生的消息字段
   * @returns 新写入的 `HydratedRawMessageRecord`
   */
  public async insertMessage(input: {
    readonly roomId: RoomId;
    readonly seq: MessageSeq;
    readonly caller: AuthenticatedCaller;
    readonly type: MessageType;
    readonly content: string;
    readonly payloadJson?: Record<string, unknown>;
    readonly attachment?: StoredMessageAttachment;
    readonly replyToSeq?: MessageSeq;
    readonly mentions: readonly MessageMention[];
    readonly opKey?: OperationKey;
  }): Promise<HydratedRawMessageRecord> {
    const authorKind = input.caller.kind;
    const authorUserId = input.caller.kind === "human" ? input.caller.userId : null;
    const authorAgentId = input.caller.kind === "agent" ? input.caller.agentId : null;
    const ownerUserId =
      input.caller.kind === "human" ? input.caller.userId : input.caller.ownerUserId;

    await this.db.insert(messagesTable).values({
      roomId: input.roomId,
      seq: input.seq,
      authorKind,
      authorUserId,
      authorAgentId,
      ownerUserId,
      type: input.type,
      content: input.content,
      payloadJson:
        input.attachment === undefined
          ? (input.payloadJson ?? null)
          : { ...input.payloadJson, attachment: input.attachment.metadata },
      replyToSeq: input.replyToSeq ?? null,
      mentionsJson: input.mentions,
      opKey: input.opKey ?? null,
    });

    // 依赖外层的房间写入事务，避免同一 seq 出现只有元数据或只有附件的中间状态。
    if (input.attachment !== undefined) {
      await this.db.insert(messageAttachmentsTable).values({
        roomId: input.roomId,
        seq: input.seq,
        bytes: input.attachment.bytes,
      });
    }

    const loaded = await this.findBySeq(input.roomId, input.seq);
    if (!loaded) {
      throw new Error(`Failed to reload inserted message (${input.roomId}, seq=${input.seq}).`);
    }
    return loaded;
  }

  /**
   * 原子更新房间的 `last_seq` 与最新治理快照。
   *
   * @param roomId - 房间主键
   * @param lastSeq - 新单调递增序号
   * @param governanceJson - 演进后的房间治理快照
   */
  public async updateRoomSeqAndGovernance(
    roomId: RoomId,
    lastSeq: number,
    governanceJson: RoomGovernanceState,
  ): Promise<void> {
    await this.db
      .update(roomsTable)
      .set({
        lastSeq,
        governanceJson,
      })
      .where(eq(roomsTable.id, roomId));
  }

  /**
   * 单调推进成员在指定房间的 `last_read_seq` 游标（绝不倒退）。
   *
   * @param roomId - 房间主键
   * @param memberKey - 确定性成员键
   * @param targetReadSeq - 目标已读序号
   */
  public async advanceReadCursorMonotonically(
    roomId: RoomId,
    memberKey: string,
    targetReadSeq: number,
  ): Promise<void> {
    if (targetReadSeq <= 0) {
      return;
    }
    await this.db.execute(sql`
      UPDATE room_members
      SET last_read_seq = GREATEST(last_read_seq, ${targetReadSeq})
      WHERE room_id = ${roomId} AND member_key = ${memberKey}
    `);
  }

  /**
   * 将指定消息标记为撤回，清空正文、提及列表与附件。
   *
   * @param roomId - 房间主键
   * @param seq - 待撤回消息序号
   * @param recalledAt - 撤回时间戳
   * @returns 更新后的 `HydratedRawMessageRecord`
   */
  public async recallMessage(
    roomId: RoomId,
    seq: MessageSeq,
    recalledAt: Date,
  ): Promise<HydratedRawMessageRecord> {
    await this.db
      .update(messagesTable)
      .set({
        content: "[Message recalled]",
        mentionsJson: [],
        payloadJson: sql`${messagesTable.payloadJson} - 'attachment'`,
        recalledAt,
      })
      .where(and(eq(messagesTable.roomId, roomId), eq(messagesTable.seq, seq)));

    await this.db
      .delete(messageAttachmentsTable)
      .where(and(eq(messageAttachmentsTable.roomId, roomId), eq(messageAttachmentsTable.seq, seq)));

    const updated = await this.findBySeq(roomId, seq);
    if (!updated) {
      throw new Error(`Failed to reload recalled message (${roomId}, seq=${seq}).`);
    }
    return updated;
  }
}
