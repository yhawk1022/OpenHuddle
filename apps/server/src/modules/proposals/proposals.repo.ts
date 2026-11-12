/**
 * @module server/modules/proposals/repo
 * @description 结构化提案卡片（`proposals`）、分歧投票（`proposal_votes`）与拍板落库参数化仓储层。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 房间序号锁一致性：提案创建、结构化投票与人类拍板均会向 `messages` 表追加事件消息（`proposal` | `vote` | `decision`），因此必须在同一事务内先 `FOR UPDATE` 锁定 `rooms` 行再递增 `last_seq`。
 * 2. 投票幂等覆盖：`proposal_votes` 以 `(proposal_id, voter_key)` 为主键，同一 Agent 或人类修正立场时执行原子 Upsert，避免同一主体重复计票。
 */
import {
  type OpenHuddleDb,
  messagesTable,
  proposalVotesTable,
  proposalsTable,
  roomsTable,
} from "@openhuddle/db";
import {
  ActorKindSchema,
  type AgentId,
  AgentPlatformSchema,
  type AuthenticatedCaller,
  type MessageSeq,
  type MessageType,
  type ProposalCardDto,
  type ProposalDraft,
  ProposalDraftSchema,
  type ProposalId,
  type ProposalStatus,
  ProposalStatusSchema,
  type ProposalVoteStance,
  ProposalVoteStanceSchema,
  type RawAuthorIdentity,
  type RoomId,
  type RoomMemberRole,
  RoomMemberRoleSchema,
  type UserId,
  asMessageSeq,
  computeAuthorStamp,
} from "@openhuddle/protocol";
import { eq, sql } from "drizzle-orm";
import { extractSqlRows } from "../../infra/sql-rows.js";
import { type HydratedRawMessageRecord, MessagesRepository } from "../messages/messages.repo.js";

/**
 * 尚未绑定查看者视角的内部投票记录。
 */
export interface HydratedRawVoteRecord {
  readonly rawVoter: RawAuthorIdentity;
  readonly stance: ProposalVoteStance;
  readonly preferredOptionKey: string | undefined;
  readonly rationale: string;
  readonly createdAt: Date;
}

/**
 * 尚未绑定查看者视角的内部提案卡片完整记录。
 */
export interface HydratedRawProposalRecord {
  readonly id: ProposalId;
  readonly roomId: RoomId;
  readonly originMessageSeq: MessageSeq;
  readonly status: ProposalStatus;
  readonly draft: ProposalDraft;
  readonly votes: readonly HydratedRawVoteRecord[];
  readonly decidedOptionKey: string | undefined;
  readonly decisionNote: string | undefined;
  readonly rawDecidedBy: RawAuthorIdentity | undefined;
  readonly decidedAt: Date | null;
  readonly createdAt: Date;
}

function parseJsonColumn(raw: unknown): unknown {
  return typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
}

/**
 * 针对当前查看者（`viewer`）计算所有投票者与拍板人的 `AuthorStamp`，组装标准 `ProposalCardDto`。
 *
 * @param record - 原始提案与投票聚合记录
 * @param viewer - 当前查看者身份
 * @returns 强类型 `ProposalCardDto`
 */
export function stampRawProposalForViewer(
  record: Readonly<HydratedRawProposalRecord>,
  viewer: Readonly<AuthenticatedCaller>,
): ProposalCardDto {
  return {
    id: record.id,
    roomId: record.roomId,
    originMessageSeq: record.originMessageSeq,
    status: record.status,
    draft: record.draft,
    votes: record.votes.map((vote) => ({
      voter: computeAuthorStamp(vote.rawVoter, viewer),
      stance: vote.stance,
      ...(vote.preferredOptionKey !== undefined
        ? { preferredOptionKey: vote.preferredOptionKey }
        : {}),
      rationale: vote.rationale,
      createdAtIso: vote.createdAt.toISOString(),
    })),
    ...(record.decidedOptionKey !== undefined ? { decidedOptionKey: record.decidedOptionKey } : {}),
    ...(record.decisionNote !== undefined ? { decisionNote: record.decisionNote } : {}),
    ...(record.rawDecidedBy !== undefined
      ? { decidedBy: computeAuthorStamp(record.rawDecidedBy, viewer) }
      : {}),
    ...(record.decidedAt !== null ? { decidedAtIso: record.decidedAt.toISOString() } : {}),
    createdAtIso: record.createdAt.toISOString(),
  };
}

/**
 * 提案、投票与拍板仓储类。
 */
export class ProposalsRepository {
  private readonly db: OpenHuddleDb;

  /**
   * @param db - Drizzle PostgreSQL / PGlite 实例
   */
  public constructor(db: OpenHuddleDb) {
    this.db = db;
  }

  /**
   * 在数据库事务中执行提案、投票或拍板与房间消息序号推进的原子写入。
   *
   * @param fn - 接收事务级 `ProposalsRepository` 的回调
   * @returns 回调结果
   */
  public async runInTransaction<T>(fn: (txRepo: ProposalsRepository) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      const txRepo = new ProposalsRepository(tx as unknown as OpenHuddleDb);
      return fn(txRepo);
    });
  }

  /**
   * 在事务中锁定目标房间行并返回其主键、群主 ID 与最新 `lastSeq`。
   *
   * @param roomId - 房间主键
   * @returns 锁定的房间记录或 `undefined`
   */
  public async lockRoomBasicForUpdate(roomId: RoomId): Promise<
    | {
        readonly id: RoomId;
        readonly ownerUserId: UserId;
        readonly lastSeq: number;
      }
    | undefined
  > {
    // 并发控制点：与普通消息发送保持相同锁顺序，先对 rooms 行加 FOR UPDATE 排他锁再分配消息序号
    const result = await this.db.execute(sql`
      SELECT
        id,
        owner_user_id AS "ownerUserId",
        last_seq AS "lastSeq"
      FROM rooms
      WHERE id = ${roomId}
      FOR UPDATE
    `);

    const row = extractSqlRows<{
      readonly id: string;
      readonly ownerUserId: string;
      readonly lastSeq: number;
    }>(result)[0];

    if (!row) {
      return undefined;
    }

    return {
      id: row.id as RoomId,
      ownerUserId: row.ownerUserId as UserId,
      lastSeq: Number(row.lastSeq),
    };
  }

  /**
   * 检查房间是否存在（无锁只读查询）。
   *
   * @param roomId - 房间主键
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
   * 查询指定成员在房间内的角色。
   *
   * @param roomId - 房间主键
   * @param memberKey - 确定性成员键
   * @returns 成员角色或 `undefined`
   */
  public async findMemberRole(
    roomId: RoomId,
    memberKey: string,
  ): Promise<RoomMemberRole | undefined> {
    const result = await this.db.execute(sql`
      SELECT role
      FROM room_members
      WHERE room_id = ${roomId} AND member_key = ${memberKey}
      LIMIT 1
    `);

    const row = extractSqlRows<{ readonly role: string }>(result)[0];
    return row ? RoomMemberRoleSchema.parse(row.role) : undefined;
  }

  /**
   * 按提案主键读取基础元数据。
   *
   * @param proposalId - 提案主键
   * @returns 提案基础行或 `undefined`
   */
  public async findProposalMetaById(proposalId: ProposalId): Promise<
    | {
        readonly id: ProposalId;
        readonly roomId: RoomId;
        readonly originMessageSeq: MessageSeq;
        readonly status: ProposalStatus;
        readonly draft: ProposalDraft;
      }
    | undefined
  > {
    const rows = await this.db
      .select()
      .from(proposalsTable)
      .where(eq(proposalsTable.id, proposalId))
      .limit(1);

    const row = rows[0];
    if (!row) {
      return undefined;
    }

    return {
      id: row.id as ProposalId,
      roomId: row.roomId as RoomId,
      originMessageSeq: asMessageSeq(row.originMessageSeq),
      status: ProposalStatusSchema.parse(row.status),
      draft: ProposalDraftSchema.parse(parseJsonColumn(row.draftJson)),
    };
  }

  /**
   * 在已持有 `rooms FOR UPDATE` 锁的事务中追加一条提案相关事件消息，并同步推进 `rooms.last_seq` 与发送者已读游标。
   *
   * @param input - 消息内容、类型与发送者信息
   * @returns 水合后的 `HydratedRawMessageRecord`
   */
  public async appendTimelineMessageUnderRoomLock(input: {
    readonly roomId: RoomId;
    readonly nextSeq: MessageSeq;
    readonly memberKey: string;
    readonly caller: AuthenticatedCaller;
    readonly type: Extract<MessageType, "proposal" | "vote" | "decision">;
    readonly content: string;
    readonly payloadJson: Record<string, unknown>;
    readonly replyToSeq?: MessageSeq;
  }): Promise<HydratedRawMessageRecord> {
    const authorUserId = input.caller.kind === "human" ? input.caller.userId : null;
    const authorAgentId = input.caller.kind === "agent" ? input.caller.agentId : null;
    const ownerUserId =
      input.caller.kind === "human" ? input.caller.userId : input.caller.ownerUserId;

    await this.db.insert(messagesTable).values({
      roomId: input.roomId,
      seq: input.nextSeq,
      authorKind: input.caller.kind,
      authorUserId,
      authorAgentId,
      ownerUserId,
      type: input.type,
      content: input.content,
      payloadJson: input.payloadJson,
      replyToSeq: input.replyToSeq ?? null,
      mentionsJson: [],
      opKey: null,
    });

    await this.db
      .update(roomsTable)
      .set({ lastSeq: input.nextSeq })
      .where(eq(roomsTable.id, input.roomId));

    await this.db.execute(sql`
      UPDATE room_members
      SET last_read_seq = GREATEST(last_read_seq, ${input.nextSeq})
      WHERE room_id = ${input.roomId} AND member_key = ${input.memberKey}
    `);

    const msgRepo = new MessagesRepository(this.db);
    const message = await msgRepo.findBySeq(input.roomId, input.nextSeq);
    if (!message) {
      throw new Error(`Failed to load appended ${input.type} message (seq=${input.nextSeq}).`);
    }
    return message;
  }

  /**
   * 插入新的结构化提案记录。
   *
   * @param input - 提案主键、房间主键、关联消息序号与草案结构
   */
  public async insertProposal(input: {
    readonly id: ProposalId;
    readonly roomId: RoomId;
    readonly originMessageSeq: MessageSeq;
    readonly draft: ProposalDraft;
  }): Promise<void> {
    await this.db.insert(proposalsTable).values({
      id: input.id,
      roomId: input.roomId,
      originMessageSeq: input.originMessageSeq,
      status: "open",
      draftJson: input.draft,
    });
  }

  /**
   * 幂等插入或覆盖更新调用者对指定提案的结构化表态投票。
   *
   * @param input - 投票主体、立场、倾向方案与理由
   */
  public async upsertVote(input: {
    readonly proposalId: ProposalId;
    readonly voterKey: string;
    readonly caller: AuthenticatedCaller;
    readonly stance: ProposalVoteStance;
    readonly preferredOptionKey?: string;
    readonly rationale: string;
  }): Promise<void> {
    const voterUserId = input.caller.kind === "human" ? input.caller.userId : null;
    const voterAgentId = input.caller.kind === "agent" ? input.caller.agentId : null;
    const ownerUserId =
      input.caller.kind === "human" ? input.caller.userId : input.caller.ownerUserId;
    const now = new Date();

    await this.db
      .insert(proposalVotesTable)
      .values({
        proposalId: input.proposalId,
        voterKey: input.voterKey,
        voterKind: input.caller.kind,
        voterUserId,
        voterAgentId,
        ownerUserId,
        stance: input.stance,
        preferredOptionKey: input.preferredOptionKey ?? null,
        rationale: input.rationale,
        createdAt: now,
      })
      .onConflictDoUpdate({
        target: [proposalVotesTable.proposalId, proposalVotesTable.voterKey],
        set: {
          stance: input.stance,
          preferredOptionKey: input.preferredOptionKey ?? null,
          rationale: input.rationale,
          createdAt: now,
        },
      });
  }

  /**
   * 记录人类决策者对提案的最终拍板结论（`approved` | `rejected`）。
   *
   * @param input - 提案主键、最终结论、选定方案、批注与拍板人类 ID
   */
  public async updateProposalDecision(input: {
    readonly proposalId: ProposalId;
    readonly decision: "approved" | "rejected";
    readonly decidedOptionKey?: string;
    readonly decisionNote?: string;
    readonly decidedByUserId: UserId;
    readonly decidedAt: Date;
  }): Promise<void> {
    await this.db
      .update(proposalsTable)
      .set({
        status: input.decision,
        decidedOptionKey: input.decidedOptionKey ?? null,
        decisionNote: input.decisionNote ?? null,
        decidedByUserId: input.decidedByUserId,
        decidedAt: input.decidedAt,
      })
      .where(eq(proposalsTable.id, input.proposalId));
  }

  /**
   * 水合加载单张提案卡片及其全部投票与拍板人身份。
   *
   * @param proposalId - 提案主键
   * @returns `HydratedRawProposalRecord` 或 `undefined`
   */
  public async findHydratedProposalById(
    proposalId: ProposalId,
  ): Promise<HydratedRawProposalRecord | undefined> {
    const proposalResult = await this.db.execute(sql`
      SELECT
        p.id AS "id",
        p.room_id AS "roomId",
        p.origin_message_seq AS "originMessageSeq",
        p.status AS "status",
        p.draft_json AS "draftJson",
        p.decided_option_key AS "decidedOptionKey",
        p.decision_note AS "decisionNote",
        p.decided_by_user_id AS "decidedByUserId",
        p.decided_at AS "decidedAt",
        p.created_at AS "createdAt",
        u_decider.display_name AS "deciderDisplayName"
      FROM proposals p
      LEFT JOIN users u_decider ON p.decided_by_user_id = u_decider.id
      WHERE p.id = ${proposalId}
      LIMIT 1
    `);

    const pRow = extractSqlRows<{
      readonly id: string;
      readonly roomId: string;
      readonly originMessageSeq: number;
      readonly status: string;
      readonly draftJson: unknown;
      readonly decidedOptionKey: string | null;
      readonly decisionNote: string | null;
      readonly decidedByUserId: string | null;
      readonly decidedAt: Date | string | null;
      readonly createdAt: Date | string;
      readonly deciderDisplayName: string | null;
    }>(proposalResult)[0];

    if (!pRow) {
      return undefined;
    }

    const votes = await this.loadVotesForProposal(proposalId);
    return this.assembleProposalRecord(pRow, votes);
  }

  /**
   * 列出指定房间内所有提案卡片（按 `originMessageSeq` 升序排列）。
   *
   * @param roomId - 房间主键
   * @returns 水合后的 `HydratedRawProposalRecord` 列表
   */
  public async listHydratedProposalsByRoom(
    roomId: RoomId,
  ): Promise<readonly HydratedRawProposalRecord[]> {
    const proposalResult = await this.db.execute(sql`
      SELECT
        p.id AS "id",
        p.room_id AS "roomId",
        p.origin_message_seq AS "originMessageSeq",
        p.status AS "status",
        p.draft_json AS "draftJson",
        p.decided_option_key AS "decidedOptionKey",
        p.decision_note AS "decisionNote",
        p.decided_by_user_id AS "decidedByUserId",
        p.decided_at AS "decidedAt",
        p.created_at AS "createdAt",
        u_decider.display_name AS "deciderDisplayName"
      FROM proposals p
      LEFT JOIN users u_decider ON p.decided_by_user_id = u_decider.id
      WHERE p.room_id = ${roomId}
      ORDER BY p.origin_message_seq ASC
    `);

    const pRows = extractSqlRows<{
      readonly id: string;
      readonly roomId: string;
      readonly originMessageSeq: number;
      readonly status: string;
      readonly draftJson: unknown;
      readonly decidedOptionKey: string | null;
      readonly decisionNote: string | null;
      readonly decidedByUserId: string | null;
      readonly decidedAt: Date | string | null;
      readonly createdAt: Date | string;
      readonly deciderDisplayName: string | null;
    }>(proposalResult);

    const output: HydratedRawProposalRecord[] = [];
    for (const pRow of pRows) {
      const votes = await this.loadVotesForProposal(pRow.id as ProposalId);
      output.push(this.assembleProposalRecord(pRow, votes));
    }
    return output;
  }

  private async loadVotesForProposal(
    proposalId: ProposalId,
  ): Promise<readonly HydratedRawVoteRecord[]> {
    const voteResult = await this.db.execute(sql`
      SELECT
        v.voter_kind AS "voterKind",
        v.voter_user_id AS "voterUserId",
        v.voter_agent_id AS "voterAgentId",
        v.owner_user_id AS "ownerUserId",
        v.stance AS "stance",
        v.preferred_option_key AS "preferredOptionKey",
        v.rationale AS "rationale",
        v.created_at AS "createdAt",
        u.display_name AS "humanDisplayName",
        a.display_name AS "agentDisplayName",
        a.platform AS "agentPlatform"
      FROM proposal_votes v
      LEFT JOIN users u ON v.voter_user_id = u.id
      LEFT JOIN agents a ON v.voter_agent_id = a.id
      WHERE v.proposal_id = ${proposalId}
      ORDER BY v.created_at ASC
    `);

    return extractSqlRows<{
      readonly voterKind: string;
      readonly voterUserId: string | null;
      readonly voterAgentId: string | null;
      readonly ownerUserId: string;
      readonly stance: string;
      readonly preferredOptionKey: string | null;
      readonly rationale: string;
      readonly createdAt: Date | string;
      readonly humanDisplayName: string | null;
      readonly agentDisplayName: string | null;
      readonly agentPlatform: string | null;
    }>(voteResult).map((row): HydratedRawVoteRecord => {
      const voterKind = ActorKindSchema.parse(row.voterKind);
      const ownerUserId = row.ownerUserId as UserId;

      const rawVoter: RawAuthorIdentity =
        voterKind === "human"
          ? {
              kind: "human",
              ...(row.voterUserId !== null ? { userId: row.voterUserId as UserId } : {}),
              ownerUserId,
              displayName: row.humanDisplayName ?? "Unknown Owner",
            }
          : {
              kind: "agent",
              ...(row.voterAgentId !== null ? { agentId: row.voterAgentId as AgentId } : {}),
              ownerUserId,
              displayName: row.agentDisplayName ?? "Unknown Agent",
              ...(row.agentPlatform !== null
                ? { platform: AgentPlatformSchema.parse(row.agentPlatform) }
                : {}),
            };

      return {
        rawVoter,
        stance: ProposalVoteStanceSchema.parse(row.stance),
        preferredOptionKey: row.preferredOptionKey ?? undefined,
        rationale: row.rationale,
        createdAt: row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt),
      };
    });
  }

  private assembleProposalRecord(
    pRow: {
      readonly id: string;
      readonly roomId: string;
      readonly originMessageSeq: number;
      readonly status: string;
      readonly draftJson: unknown;
      readonly decidedOptionKey: string | null;
      readonly decisionNote: string | null;
      readonly decidedByUserId: string | null;
      readonly decidedAt: Date | string | null;
      readonly createdAt: Date | string;
      readonly deciderDisplayName: string | null;
    },
    votes: readonly HydratedRawVoteRecord[],
  ): HydratedRawProposalRecord {
    const rawDecidedBy: RawAuthorIdentity | undefined =
      pRow.decidedByUserId !== null
        ? {
            kind: "human",
            userId: pRow.decidedByUserId as UserId,
            ownerUserId: pRow.decidedByUserId as UserId,
            displayName: pRow.deciderDisplayName ?? "Owner",
          }
        : undefined;

    const decidedAt =
      pRow.decidedAt === null
        ? null
        : pRow.decidedAt instanceof Date
          ? pRow.decidedAt
          : new Date(pRow.decidedAt);

    return {
      id: pRow.id as ProposalId,
      roomId: pRow.roomId as RoomId,
      originMessageSeq: asMessageSeq(Number(pRow.originMessageSeq)),
      status: ProposalStatusSchema.parse(pRow.status),
      draft: ProposalDraftSchema.parse(parseJsonColumn(pRow.draftJson)),
      votes,
      decidedOptionKey: pRow.decidedOptionKey ?? undefined,
      decisionNote: pRow.decisionNote ?? undefined,
      rawDecidedBy,
      decidedAt,
      createdAt: pRow.createdAt instanceof Date ? pRow.createdAt : new Date(pRow.createdAt),
    };
  }
}
