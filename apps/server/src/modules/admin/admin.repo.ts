/**
 * @module server/modules/admin/repo
 * @description 运营与治理管理后台聚合统计、用户/会话/房间/消息/Agent/提案/配对码及审计日志数据库仓储层。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 双驱动 SQL 兼容：所有聚合统计与联表查询同时兼容本地 `@electric-sql/pglite` 与生产 `PostgreSQL 16+`。
 * 2. 零明文密钥与哈希泄露：任何列表或详情查询一律物理排除 `token_hash` 与 `code_hash`。
 * 3. 安全级联删户与 Owner-First 防护：删除用户时先删除其名下房间，再清理其在他人房间中的残留消息（绝不将归属主人改挂给他人），满足外键 `ON DELETE RESTRICT` 且杜绝错位身份。
 * 4. 只读审查不污染已读游标：管理员查看任意房间消息流时绝不推进任何成员的 `room_members.last_read_seq`。
 */
import {
  type OpenHuddleDb,
  adminAuditLogsTable,
  agentsTable,
  authOtpCodesTable,
  messagesTable,
  pairingCodesTable,
  proposalsTable,
  roomsTable,
  userSessionsTable,
  usersTable,
} from "@openhuddle/db";
import {
  type AdminAgentItem,
  type AdminAgentListQuery,
  type AdminAuditAction,
  AdminAuditActionSchema,
  type AdminAuditLogItem,
  type AdminAuditLogListQuery,
  type AdminAuditTargetType,
  AdminAuditTargetTypeSchema,
  type AdminDailyTrendPoint,
  type AdminDistributionEntry,
  type AdminOverviewKpis,
  type AdminPagination,
  type AdminPairingCodeItem,
  type AdminPairingCodeListQuery,
  type AdminPairingCodeStatus,
  type AdminProposalItem,
  type AdminProposalListQuery,
  type AdminRoomItem,
  type AdminRoomListQuery,
  type AdminRoomMessagesQuery,
  type AdminSessionItem,
  type AdminSessionListQuery,
  type AdminTopRoomItem,
  type AdminTopUserItem,
  type AdminUserItem,
  type AdminUserListQuery,
  type AdminUserRoomBrief,
  type AgentId,
  type AgentPlatform,
  AgentPlatformSchema,
  type AgentReachState,
  type AuditLogId,
  type GovernanceMode,
  type PairingCode,
  type ProposalDraft,
  ProposalDraftSchema,
  type ProposalId,
  ProposalStatusSchema,
  type RoomGovernanceState,
  RoomGovernanceStateSchema,
  RoomGovernanceStatusSchema,
  type RoomId,
  RoomMemberRoleSchema,
  type RoomVisibility,
  RoomVisibilitySchema,
  type SessionId,
  type UserId,
  type UserRole,
  UserRoleSchema,
  type UserStatus,
  UserStatusSchema,
  asMessageSeq,
  asReadCursorSeq,
} from "@openhuddle/protocol";
import { eq, sql } from "drizzle-orm";
import { computeAgentReachState } from "../../infra/identity-stamp.js";
import type { RealtimeBus } from "../../infra/realtime-bus.js";
import { extractSqlRows } from "../../infra/sql-rows.js";
import {
  type HydratedRawMessageRecord,
  MessagesRepository,
  type RawSqlMessageRow,
  mapSqlRowToHydratedMessage,
} from "../messages/messages.repo.js";
import { RoomsRepository } from "../rooms/rooms.repo.js";

const PLATFORM_LABELS: Readonly<Record<AgentPlatform, string>> = {
  antigravity: "Antigravity",
  codex: "Codex",
  claude_code: "Claude Code",
  cursor: "Cursor",
  deepseek: "DeepSeek",
  openclaw: "OpenClaw",
  gemini: "Gemini",
  chatgpt: "ChatGPT",
  hosted: "Hosted",
  custom: "Custom",
};

const REACH_LABELS: Readonly<Record<AgentReachState, string>> = {
  online_sse: "SSE 实时在线",
  webhook: "Webhook 回调",
  hosted_ready: "托管模型就绪",
  polling: "轮询活跃",
  offline: "离线",
};

const GOVERNANCE_MODE_LABELS: Readonly<Record<GovernanceMode, string>> = {
  free: "自由讨论",
  round_table: "圆桌轮流",
  proposal: "提案收敛",
};

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function toNullableDate(value: Date | string | null | undefined): Date | null {
  if (value === null || value === undefined) {
    return null;
  }
  return toDate(value);
}

function parseJsonObject<T>(raw: unknown): T {
  const parsed = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
  return parsed as T;
}

function buildPagination(page: number, pageSize: number, total: number): AdminPagination {
  return {
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

function formatUtcDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * 写入审计日志所需的载荷。
 */
export interface InsertAuditLogInput {
  readonly id: AuditLogId;
  readonly actorUserId: UserId;
  readonly actorEmail: string;
  readonly actorDisplayName: string;
  readonly action: AdminAuditAction;
  readonly targetType: AdminAuditTargetType;
  readonly targetId: string;
  readonly summary: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * 级联删除用户后的清理统计与待清理内存订阅目标。
 */
export interface DeletedUserCascadeResult {
  readonly deletedRoomIds: readonly RoomId[];
  readonly deletedAgentIds: readonly AgentId[];
  readonly deletedSessionCount: number;
}

/**
 * 后台管理仓储类。
 */
export class AdminRepository {
  private readonly db: OpenHuddleDb;

  /**
   * @param db - Drizzle PostgreSQL / PGlite 实例
   */
  public constructor(db: OpenHuddleDb) {
    this.db = db;
  }

  /**
   * 在单个数据库事务内执行多表管理写操作。
   *
   * @param fn - 接收事务级 `AdminRepository` 的异步回调
   * @returns 回调返回值
   */
  public async runInTransaction<T>(fn: (txRepo: AdminRepository) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      const txRepo = new AdminRepository(tx as unknown as OpenHuddleDb);
      return fn(txRepo);
    });
  }

  /**
   * 构造共享当前连接或事务上下文的 `RoomsRepository`，用于跨仓储原子锁定与清理房间。
   */
  public getRoomsRepo(): RoomsRepository {
    return new RoomsRepository(this.db);
  }

  /**
   * 构造共享当前连接或事务上下文的 `MessagesRepository`，用于按标准锁序强制撤回消息。
   */
  public getMessagesRepo(): MessagesRepository {
    return new MessagesRepository(this.db);
  }

  /**
   * 查询指定人类用户名下绑定的全部 Agent 主键列表（供封禁账号后驱逐内存 SSE 订阅）。
   */
  public async listOwnedAgentIds(userId: UserId): Promise<readonly AgentId[]> {
    const rows = await this.db
      .select({ id: agentsTable.id })
      .from(agentsTable)
      .where(eq(agentsTable.ownerUserId, userId));
    return rows.map((row) => row.id as AgentId);
  }

  /* ─────────────────────────────────────────────────────────────
   * 1. 统计大盘聚合查询
   * ───────────────────────────────────────────────────────────── */

  /**
   * 汇总平台核心 KPI 指标计数（不含动态内存 SSE 在线数，后者在服务层注入）。
   */
  public async getDatabaseOverviewKpis(
    now: Date,
    since24h: Date,
    since7d: Date,
  ): Promise<Omit<AdminOverviewKpis, "onlineSseAgents">> {
    const nowIso = now.toISOString();
    const since24hIso = since24h.toISOString();
    const since7dIso = since7d.toISOString();

    const [userRes, sessionRes, agentRes, roomRes, msgRes, propRes, voteRes, pairRes] =
      await Promise.all([
        this.db.execute(sql`
          SELECT
            COUNT(*)::int AS "totalUsers",
            COALESCE(SUM(CASE WHEN role = 'admin' THEN 1 ELSE 0 END), 0)::int AS "adminUsers",
            COALESCE(SUM(CASE WHEN status = 'suspended' THEN 1 ELSE 0 END), 0)::int AS "suspendedUsers",
            COALESCE(SUM(CASE WHEN created_at >= ${since7dIso}::timestamptz THEN 1 ELSE 0 END), 0)::int AS "newUsers7d"
          FROM users
        `),
        this.db.execute(sql`
          SELECT
            COALESCE(SUM(CASE WHEN expires_at > ${nowIso}::timestamptz THEN 1 ELSE 0 END), 0)::int AS "activeSessions",
            COALESCE(SUM(CASE WHEN expires_at <= ${nowIso}::timestamptz THEN 1 ELSE 0 END), 0)::int AS "expiredSessions"
          FROM user_sessions
        `),
        this.db.execute(sql`
          SELECT COUNT(*)::int AS "totalAgents" FROM agents
        `),
        this.db.execute(sql`
          SELECT
            COUNT(*)::int AS "totalRooms",
            COALESCE(SUM(CASE WHEN visibility = 'public_shareable' THEN 1 ELSE 0 END), 0)::int AS "publicShareableRooms",
            COALESCE(SUM(CASE WHEN governance_json->>'status' = 'paused_budget' THEN 1 ELSE 0 END), 0)::int AS "pausedBudgetRooms"
          FROM rooms
        `),
        this.db.execute(sql`
          SELECT
            COUNT(*)::int AS "totalMessages",
            COALESCE(SUM(CASE WHEN created_at >= ${since24hIso}::timestamptz THEN 1 ELSE 0 END), 0)::int AS "messages24h",
            COALESCE(SUM(CASE WHEN created_at >= ${since7dIso}::timestamptz THEN 1 ELSE 0 END), 0)::int AS "messages7d",
            COALESCE(SUM(CASE WHEN recalled_at IS NOT NULL THEN 1 ELSE 0 END), 0)::int AS "recalledMessages"
          FROM messages
        `),
        this.db.execute(sql`
          SELECT
            COUNT(*)::int AS "totalProposals",
            COALESCE(SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END), 0)::int AS "openProposals",
            COALESCE(SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END), 0)::int AS "approvedProposals",
            COALESCE(SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END), 0)::int AS "rejectedProposals"
          FROM proposals
        `),
        this.db.execute(sql`
          SELECT COUNT(*)::int AS "totalVotes" FROM proposal_votes
        `),
        this.db.execute(sql`
          SELECT COUNT(*)::int AS "activePairingCodes"
          FROM pairing_codes
          WHERE used_at IS NULL AND expires_at > ${nowIso}::timestamptz
        `),
      ]);

    const userRow = extractSqlRows<{
      readonly totalUsers: number;
      readonly adminUsers: number;
      readonly suspendedUsers: number;
      readonly newUsers7d: number;
    }>(userRes)[0];
    const sessionRow = extractSqlRows<{
      readonly activeSessions: number;
      readonly expiredSessions: number;
    }>(sessionRes)[0];
    const agentRow = extractSqlRows<{ readonly totalAgents: number }>(agentRes)[0];
    const roomRow = extractSqlRows<{
      readonly totalRooms: number;
      readonly publicShareableRooms: number;
      readonly pausedBudgetRooms: number;
    }>(roomRes)[0];
    const msgRow = extractSqlRows<{
      readonly totalMessages: number;
      readonly messages24h: number;
      readonly messages7d: number;
      readonly recalledMessages: number;
    }>(msgRes)[0];
    const propRow = extractSqlRows<{
      readonly totalProposals: number;
      readonly openProposals: number;
      readonly approvedProposals: number;
      readonly rejectedProposals: number;
    }>(propRes)[0];
    const voteRow = extractSqlRows<{ readonly totalVotes: number }>(voteRes)[0];
    const pairRow = extractSqlRows<{ readonly activePairingCodes: number }>(pairRes)[0];

    return {
      totalUsers: Number(userRow?.totalUsers ?? 0),
      adminUsers: Number(userRow?.adminUsers ?? 0),
      suspendedUsers: Number(userRow?.suspendedUsers ?? 0),
      newUsers7d: Number(userRow?.newUsers7d ?? 0),
      activeSessions: Number(sessionRow?.activeSessions ?? 0),
      expiredSessions: Number(sessionRow?.expiredSessions ?? 0),
      totalAgents: Number(agentRow?.totalAgents ?? 0),
      totalRooms: Number(roomRow?.totalRooms ?? 0),
      publicShareableRooms: Number(roomRow?.publicShareableRooms ?? 0),
      pausedBudgetRooms: Number(roomRow?.pausedBudgetRooms ?? 0),
      totalMessages: Number(msgRow?.totalMessages ?? 0),
      messages24h: Number(msgRow?.messages24h ?? 0),
      messages7d: Number(msgRow?.messages7d ?? 0),
      recalledMessages: Number(msgRow?.recalledMessages ?? 0),
      totalProposals: Number(propRow?.totalProposals ?? 0),
      openProposals: Number(propRow?.openProposals ?? 0),
      approvedProposals: Number(propRow?.approvedProposals ?? 0),
      rejectedProposals: Number(propRow?.rejectedProposals ?? 0),
      totalVotes: Number(voteRow?.totalVotes ?? 0),
      activePairingCodes: Number(pairRow?.activePairingCodes ?? 0),
    };
  }

  /**
   * 统计指定天数窗口内（按 UTC 自然日对齐并零值补齐）的每日增长与消息活跃趋势。
   */
  public async getDailyTrends(
    windowDays: number,
    now: Date,
  ): Promise<readonly AdminDailyTrendPoint[]> {
    const endDayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const startDayUtc = new Date(endDayUtc.getTime() - (windowDays - 1) * 86_400_000);
    const startIso = startDayUtc.toISOString();

    const [userTrends, roomTrends, msgTrends, propTrends] = await Promise.all([
      this.db.execute(sql`
        SELECT
          TO_CHAR(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS "day",
          COUNT(*)::int AS "cnt"
        FROM users
        WHERE created_at >= ${startIso}::timestamptz
        GROUP BY 1
      `),
      this.db.execute(sql`
        SELECT
          TO_CHAR(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS "day",
          COUNT(*)::int AS "cnt"
        FROM rooms
        WHERE created_at >= ${startIso}::timestamptz
        GROUP BY 1
      `),
      this.db.execute(sql`
        SELECT
          TO_CHAR(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS "day",
          COUNT(*)::int AS "total",
          COALESCE(SUM(CASE WHEN author_kind = 'human' THEN 1 ELSE 0 END), 0)::int AS "humanCnt",
          COALESCE(SUM(CASE WHEN author_kind = 'agent' THEN 1 ELSE 0 END), 0)::int AS "agentCnt"
        FROM messages
        WHERE created_at >= ${startIso}::timestamptz
        GROUP BY 1
      `),
      this.db.execute(sql`
        SELECT
          TO_CHAR(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS "day",
          COUNT(*)::int AS "cnt"
        FROM proposals
        WHERE created_at >= ${startIso}::timestamptz
        GROUP BY 1
      `),
    ]);

    const userMap = new Map<string, number>();
    for (const row of extractSqlRows<{ readonly day: string; readonly cnt: number }>(userTrends)) {
      userMap.set(row.day, Number(row.cnt));
    }
    const roomMap = new Map<string, number>();
    for (const row of extractSqlRows<{ readonly day: string; readonly cnt: number }>(roomTrends)) {
      roomMap.set(row.day, Number(row.cnt));
    }
    const msgMap = new Map<
      string,
      { readonly total: number; readonly human: number; readonly agent: number }
    >();
    for (const row of extractSqlRows<{
      readonly day: string;
      readonly total: number;
      readonly humanCnt: number;
      readonly agentCnt: number;
    }>(msgTrends)) {
      msgMap.set(row.day, {
        total: Number(row.total),
        human: Number(row.humanCnt),
        agent: Number(row.agentCnt),
      });
    }
    const propMap = new Map<string, number>();
    for (const row of extractSqlRows<{ readonly day: string; readonly cnt: number }>(propTrends)) {
      propMap.set(row.day, Number(row.cnt));
    }

    const points: AdminDailyTrendPoint[] = [];
    for (let i = 0; i < windowDays; i += 1) {
      const dayDate = new Date(startDayUtc.getTime() + i * 86_400_000);
      const dateKey = formatUtcDateKey(dayDate);
      const msg = msgMap.get(dateKey);
      points.push({
        date: dateKey,
        newUsers: userMap.get(dateKey) ?? 0,
        newRooms: roomMap.get(dateKey) ?? 0,
        totalMessages: msg?.total ?? 0,
        humanMessages: msg?.human ?? 0,
        agentMessages: msg?.agent ?? 0,
        newProposals: propMap.get(dateKey) ?? 0,
      });
    }

    return points;
  }

  /**
   * 统计全平台 Agent 宿主平台分布、实时可达状态分布及 `online_sse` 在线总数。
   */
  public async getAgentDistributions(
    realtimeBus: RealtimeBus,
    nowMs: number,
  ): Promise<{
    readonly onlineSseAgents: number;
    readonly platformDistribution: readonly AdminDistributionEntry[];
    readonly reachDistribution: readonly AdminDistributionEntry[];
  }> {
    const rows = await this.db
      .select({
        id: agentsTable.id,
        platform: agentsTable.platform,
        wakeKind: agentsTable.wakeKind,
        checkinIntervalMin: agentsTable.checkinIntervalMin,
        lastSeenAt: agentsTable.lastSeenAt,
      })
      .from(agentsTable);

    const platformCounts = new Map<AgentPlatform, number>();
    const reachCounts = new Map<AgentReachState, number>();
    let onlineSseAgents = 0;

    for (const row of rows) {
      const platform = AgentPlatformSchema.parse(row.platform);
      platformCounts.set(platform, (platformCounts.get(platform) ?? 0) + 1);

      const reach = computeAgentReachState(
        {
          id: row.id as AgentId,
          platform,
          wakeKind: row.wakeKind,
          checkinIntervalMin: row.checkinIntervalMin,
          lastSeenAt: row.lastSeenAt,
        },
        realtimeBus,
        nowMs,
      );
      if (reach === "online_sse") {
        onlineSseAgents += 1;
      }
      reachCounts.set(reach, (reachCounts.get(reach) ?? 0) + 1);
    }

    const platformDistribution: AdminDistributionEntry[] = [...platformCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([key, count]) => ({
        key,
        label: PLATFORM_LABELS[key],
        count,
      }));

    const reachOrder: readonly AgentReachState[] = [
      "online_sse",
      "hosted_ready",
      "webhook",
      "polling",
      "offline",
    ];
    const reachDistribution: AdminDistributionEntry[] = reachOrder
      .map((key) => ({
        key,
        label: REACH_LABELS[key],
        count: reachCounts.get(key) ?? 0,
      }))
      .filter((entry) => entry.count > 0 || rows.length === 0);

    return {
      onlineSseAgents,
      platformDistribution,
      reachDistribution,
    };
  }

  /**
   * 统计房间治理讨论模式分布。
   */
  public async getRoomGovernanceDistribution(): Promise<readonly AdminDistributionEntry[]> {
    const result = await this.db.execute(sql`
      SELECT
        COALESCE(governance_json->'config'->>'mode', 'free') AS "mode",
        COUNT(*)::int AS "cnt"
      FROM rooms
      GROUP BY 1
    `);

    const counts = new Map<string, number>();
    for (const row of extractSqlRows<{ readonly mode: string; readonly cnt: number }>(result)) {
      counts.set(row.mode, Number(row.cnt));
    }

    const modes: readonly GovernanceMode[] = ["free", "round_table", "proposal"];
    return modes.map((mode) => ({
      key: mode,
      label: GOVERNANCE_MODE_LABELS[mode],
      count: counts.get(mode) ?? 0,
    }));
  }

  /**
   * 查询消息最活跃的 Top N 群聊房间。
   */
  public async getTopActiveRooms(limit: number): Promise<readonly AdminTopRoomItem[]> {
    const result = await this.db.execute(sql`
      SELECT
        r.id AS "id",
        r.name AS "name",
        u.display_name AS "ownerDisplayName",
        r.visibility AS "visibility",
        COALESCE(r.governance_json->>'status', 'active') AS "governanceStatus",
        r.last_seq AS "lastSeq",
        COALESCE(rm_agg."memberCount", 0)::int AS "memberCount",
        COALESCE(msg_agg."messageCount", 0)::int AS "messageCount",
        COALESCE(prop_agg."proposalCount", 0)::int AS "proposalCount",
        msg_agg."lastMessageAt" AS "lastMessageAt"
      FROM rooms r
      INNER JOIN users u ON r.owner_user_id = u.id
      LEFT JOIN (
        SELECT room_id, COUNT(*)::int AS "memberCount"
        FROM room_members
        GROUP BY room_id
      ) rm_agg ON rm_agg.room_id = r.id
      LEFT JOIN (
        SELECT room_id, COUNT(*)::int AS "messageCount", MAX(created_at) AS "lastMessageAt"
        FROM messages
        GROUP BY room_id
      ) msg_agg ON msg_agg.room_id = r.id
      LEFT JOIN (
        SELECT room_id, COUNT(*)::int AS "proposalCount"
        FROM proposals
        GROUP BY room_id
      ) prop_agg ON prop_agg.room_id = r.id
      ORDER BY COALESCE(msg_agg."messageCount", 0) DESC, r.last_seq DESC, r.created_at DESC
      LIMIT ${limit}
    `);

    return extractSqlRows<{
      readonly id: string;
      readonly name: string;
      readonly ownerDisplayName: string;
      readonly visibility: string;
      readonly governanceStatus: string;
      readonly lastSeq: number;
      readonly memberCount: number;
      readonly messageCount: number;
      readonly proposalCount: number;
      readonly lastMessageAt: Date | string | null;
    }>(result).map((row) => {
      const lastMsgDate = toNullableDate(row.lastMessageAt);
      return {
        id: row.id as RoomId,
        name: row.name,
        ownerDisplayName: row.ownerDisplayName,
        visibility: RoomVisibilitySchema.parse(row.visibility),
        governanceStatus: RoomGovernanceStatusSchema.parse(row.governanceStatus),
        memberCount: Number(row.memberCount),
        messageCount: Number(row.messageCount),
        proposalCount: Number(row.proposalCount),
        lastSeq: asReadCursorSeq(Number(row.lastSeq)),
        ...(lastMsgDate !== null ? { lastMessageAtIso: lastMsgDate.toISOString() } : {}),
      };
    });
  }

  /**
   * 查询消息贡献最活跃的 Top N 人类用户（聚合本人及其名下 Agent 发言总数）。
   */
  public async getTopActiveUsers(
    limit: number,
    adminEmails: ReadonlySet<string>,
  ): Promise<readonly AdminTopUserItem[]> {
    const result = await this.db.execute(sql`
      SELECT
        u.id AS "id",
        u.email AS "email",
        u.display_name AS "displayName",
        u.role AS "role",
        u.status AS "status",
        u.last_login_at AS "lastLoginAt",
        COALESCE(a_agg."agentCount", 0)::int AS "agentCount",
        COALESCE(r_agg."ownedRoomCount", 0)::int AS "ownedRoomCount",
        COALESCE(m_agg."messageCount", 0)::int AS "messageCount"
      FROM users u
      LEFT JOIN (
        SELECT owner_user_id, COUNT(*)::int AS "agentCount"
        FROM agents
        GROUP BY owner_user_id
      ) a_agg ON a_agg.owner_user_id = u.id
      LEFT JOIN (
        SELECT owner_user_id, COUNT(*)::int AS "ownedRoomCount"
        FROM rooms
        GROUP BY owner_user_id
      ) r_agg ON r_agg.owner_user_id = u.id
      LEFT JOIN (
        SELECT owner_user_id, COUNT(*)::int AS "messageCount"
        FROM messages
        GROUP BY owner_user_id
      ) m_agg ON m_agg.owner_user_id = u.id
      ORDER BY COALESCE(m_agg."messageCount", 0) DESC, COALESCE(a_agg."agentCount", 0) DESC, u.created_at ASC
      LIMIT ${limit}
    `);

    return extractSqlRows<{
      readonly id: string;
      readonly email: string;
      readonly displayName: string;
      readonly role: string;
      readonly status: string;
      readonly lastLoginAt: Date | string | null;
      readonly agentCount: number;
      readonly ownedRoomCount: number;
      readonly messageCount: number;
    }>(result).map((row) => {
      const dbRole = UserRoleSchema.parse(row.role);
      const effectiveRole: UserRole = adminEmails.has(row.email.toLowerCase()) ? "admin" : dbRole;
      const lastLogin = toNullableDate(row.lastLoginAt);
      return {
        id: row.id as UserId,
        email: row.email,
        displayName: row.displayName,
        role: effectiveRole,
        status: UserStatusSchema.parse(row.status),
        agentCount: Number(row.agentCount),
        ownedRoomCount: Number(row.ownedRoomCount),
        messageCount: Number(row.messageCount),
        ...(lastLogin !== null ? { lastLoginAtIso: lastLogin.toISOString() } : {}),
      };
    });
  }

  /* ─────────────────────────────────────────────────────────────
   * 2. 用户账号与会话管理仓储
   * ───────────────────────────────────────────────────────────── */

  private buildUserWhereClause(query: {
    readonly search?: string | undefined;
    readonly role?: UserRole | undefined;
    readonly status?: UserStatus | undefined;
  }) {
    const conditions = [sql`1 = 1`];
    if (query.search && query.search.trim().length > 0) {
      const pattern = `%${query.search.trim()}%`;
      conditions.push(
        sql`(u.email ILIKE ${pattern} OR u.display_name ILIKE ${pattern} OR u.id ILIKE ${pattern})`,
      );
    }
    if (query.role !== undefined) {
      conditions.push(sql`u.role = ${query.role}`);
    }
    if (query.status !== undefined) {
      conditions.push(sql`u.status = ${query.status}`);
    }
    return sql.join(conditions, sql` AND `);
  }

  /**
   * 分页查询全平台用户列表及其关联资源统计。
   */
  public async listUsers(
    query: Readonly<AdminUserListQuery>,
    now: Date,
    adminEmails: ReadonlySet<string>,
  ): Promise<{ readonly users: readonly AdminUserItem[]; readonly pagination: AdminPagination }> {
    const whereClause = this.buildUserWhereClause(query);
    const nowIso = now.toISOString();
    const offset = (query.page - 1) * query.pageSize;

    const countRes = await this.db.execute(sql`
      SELECT COUNT(*)::int AS "total"
      FROM users u
      WHERE ${whereClause}
    `);
    const total = Number(extractSqlRows<{ readonly total: number }>(countRes)[0]?.total ?? 0);

    const rowsRes = await this.db.execute(sql`
      SELECT
        u.id AS "id",
        u.email AS "email",
        u.display_name AS "displayName",
        u.role AS "role",
        u.status AS "status",
        u.suspended_at AS "suspendedAt",
        u.suspended_reason AS "suspendedReason",
        u.last_login_at AS "lastLoginAt",
        u.created_at AS "createdAt",
        COALESCE(a_agg."agentCount", 0)::int AS "agentCount",
        COALESCE(r_agg."ownedRoomCount", 0)::int AS "ownedRoomCount",
        COALESCE(rm_agg."joinedRoomCount", 0)::int AS "joinedRoomCount",
        COALESCE(s_agg."activeSessionCount", 0)::int AS "activeSessionCount",
        COALESCE(m_agg."messageCount", 0)::int AS "messageCount"
      FROM users u
      LEFT JOIN (
        SELECT owner_user_id, COUNT(*)::int AS "agentCount" FROM agents GROUP BY owner_user_id
      ) a_agg ON a_agg.owner_user_id = u.id
      LEFT JOIN (
        SELECT owner_user_id, COUNT(*)::int AS "ownedRoomCount" FROM rooms GROUP BY owner_user_id
      ) r_agg ON r_agg.owner_user_id = u.id
      LEFT JOIN (
        SELECT user_id, COUNT(*)::int AS "joinedRoomCount"
        FROM room_members WHERE member_kind = 'human' AND user_id IS NOT NULL
        GROUP BY user_id
      ) rm_agg ON rm_agg.user_id = u.id
      LEFT JOIN (
        SELECT user_id, COUNT(*)::int AS "activeSessionCount"
        FROM user_sessions WHERE expires_at > ${nowIso}::timestamptz
        GROUP BY user_id
      ) s_agg ON s_agg.user_id = u.id
      LEFT JOIN (
        SELECT owner_user_id, COUNT(*)::int AS "messageCount" FROM messages GROUP BY owner_user_id
      ) m_agg ON m_agg.owner_user_id = u.id
      WHERE ${whereClause}
      ORDER BY u.created_at DESC, u.id ASC
      LIMIT ${query.pageSize} OFFSET ${offset}
    `);

    const users = extractSqlRows<{
      readonly id: string;
      readonly email: string;
      readonly displayName: string;
      readonly role: string;
      readonly status: string;
      readonly suspendedAt: Date | string | null;
      readonly suspendedReason: string | null;
      readonly lastLoginAt: Date | string | null;
      readonly createdAt: Date | string;
      readonly agentCount: number;
      readonly ownedRoomCount: number;
      readonly joinedRoomCount: number;
      readonly activeSessionCount: number;
      readonly messageCount: number;
    }>(rowsRes).map((row) => this.mapUserRowToAdminItem(row, adminEmails));

    return {
      users,
      pagination: buildPagination(query.page, query.pageSize, total),
    };
  }

  /**
   * 按主键查询单个用户完整管理摘要。
   */
  public async findUserItemById(
    userId: UserId,
    now: Date,
    adminEmails: ReadonlySet<string>,
  ): Promise<AdminUserItem | undefined> {
    const nowIso = now.toISOString();
    const res = await this.db.execute(sql`
      SELECT
        u.id AS "id",
        u.email AS "email",
        u.display_name AS "displayName",
        u.role AS "role",
        u.status AS "status",
        u.suspended_at AS "suspendedAt",
        u.suspended_reason AS "suspendedReason",
        u.last_login_at AS "lastLoginAt",
        u.created_at AS "createdAt",
        COALESCE(a_agg."agentCount", 0)::int AS "agentCount",
        COALESCE(r_agg."ownedRoomCount", 0)::int AS "ownedRoomCount",
        COALESCE(rm_agg."joinedRoomCount", 0)::int AS "joinedRoomCount",
        COALESCE(s_agg."activeSessionCount", 0)::int AS "activeSessionCount",
        COALESCE(m_agg."messageCount", 0)::int AS "messageCount"
      FROM users u
      LEFT JOIN (
        SELECT owner_user_id, COUNT(*)::int AS "agentCount" FROM agents GROUP BY owner_user_id
      ) a_agg ON a_agg.owner_user_id = u.id
      LEFT JOIN (
        SELECT owner_user_id, COUNT(*)::int AS "ownedRoomCount" FROM rooms GROUP BY owner_user_id
      ) r_agg ON r_agg.owner_user_id = u.id
      LEFT JOIN (
        SELECT user_id, COUNT(*)::int AS "joinedRoomCount"
        FROM room_members WHERE member_kind = 'human' AND user_id IS NOT NULL
        GROUP BY user_id
      ) rm_agg ON rm_agg.user_id = u.id
      LEFT JOIN (
        SELECT user_id, COUNT(*)::int AS "activeSessionCount"
        FROM user_sessions WHERE expires_at > ${nowIso}::timestamptz
        GROUP BY user_id
      ) s_agg ON s_agg.user_id = u.id
      LEFT JOIN (
        SELECT owner_user_id, COUNT(*)::int AS "messageCount" FROM messages GROUP BY owner_user_id
      ) m_agg ON m_agg.owner_user_id = u.id
      WHERE u.id = ${userId}
      LIMIT 1
    `);

    const row = extractSqlRows<{
      readonly id: string;
      readonly email: string;
      readonly displayName: string;
      readonly role: string;
      readonly status: string;
      readonly suspendedAt: Date | string | null;
      readonly suspendedReason: string | null;
      readonly lastLoginAt: Date | string | null;
      readonly createdAt: Date | string;
      readonly agentCount: number;
      readonly ownedRoomCount: number;
      readonly joinedRoomCount: number;
      readonly activeSessionCount: number;
      readonly messageCount: number;
    }>(res)[0];

    return row ? this.mapUserRowToAdminItem(row, adminEmails) : undefined;
  }

  private mapUserRowToAdminItem(
    row: {
      readonly id: string;
      readonly email: string;
      readonly displayName: string;
      readonly role: string;
      readonly status: string;
      readonly suspendedAt: Date | string | null;
      readonly suspendedReason: string | null;
      readonly lastLoginAt: Date | string | null;
      readonly createdAt: Date | string;
      readonly agentCount: number;
      readonly ownedRoomCount: number;
      readonly joinedRoomCount: number;
      readonly activeSessionCount: number;
      readonly messageCount: number;
    },
    adminEmails: ReadonlySet<string>,
  ): AdminUserItem {
    const isEnvPinnedAdmin = adminEmails.has(row.email.toLowerCase());
    const dbRole = UserRoleSchema.parse(row.role);
    const effectiveRole: UserRole = isEnvPinnedAdmin ? "admin" : dbRole;
    const suspendedAt = toNullableDate(row.suspendedAt);
    const lastLoginAt = toNullableDate(row.lastLoginAt);
    const createdAt = toDate(row.createdAt);

    return {
      id: row.id as UserId,
      email: row.email,
      displayName: row.displayName,
      role: effectiveRole,
      status: UserStatusSchema.parse(row.status),
      isEnvPinnedAdmin,
      ...(suspendedAt !== null ? { suspendedAtIso: suspendedAt.toISOString() } : {}),
      ...(row.suspendedReason !== null && row.suspendedReason.length > 0
        ? { suspendedReason: row.suspendedReason }
        : {}),
      ...(lastLoginAt !== null ? { lastLoginAtIso: lastLoginAt.toISOString() } : {}),
      createdAtIso: createdAt.toISOString(),
      stats: {
        agentCount: Number(row.agentCount),
        ownedRoomCount: Number(row.ownedRoomCount),
        joinedRoomCount: Number(row.joinedRoomCount),
        activeSessionCount: Number(row.activeSessionCount),
        messageCount: Number(row.messageCount),
      },
    };
  }

  /**
   * 统计全平台处于活跃态的管理员数量（用于防止删除/降权/封禁最后一名管理员）。
   */
  public async countActiveAdmins(): Promise<number> {
    const res = await this.db.execute(sql`
      SELECT COUNT(*)::int AS cnt
      FROM users
      WHERE role = 'admin' AND status = 'active'
    `);
    const row = extractSqlRows<{ readonly cnt: number }>(res)[0];
    return Number(row?.cnt ?? 0);
  }

  /**
   * 列出指定用户已加入的群聊房间简报。
   */
  public async listUserJoinedRoomBriefs(userId: UserId): Promise<readonly AdminUserRoomBrief[]> {
    const res = await this.db.execute(sql`
      SELECT
        r.id AS "id",
        r.name AS "name",
        rm.role AS "memberRole",
        r.owner_user_id AS "ownerUserId",
        r.visibility AS "visibility",
        r.last_seq AS "lastSeq",
        rm.joined_at AS "joinedAt"
      FROM room_members rm
      INNER JOIN rooms r ON rm.room_id = r.id
      WHERE rm.user_id = ${userId} AND rm.member_kind = 'human'
      ORDER BY rm.joined_at DESC
    `);

    return extractSqlRows<{
      readonly id: string;
      readonly name: string;
      readonly memberRole: string;
      readonly ownerUserId: string;
      readonly visibility: string;
      readonly lastSeq: number;
      readonly joinedAt: Date | string;
    }>(res).map((row) => ({
      id: row.id as RoomId,
      name: row.name,
      memberRole: RoomMemberRoleSchema.parse(row.memberRole),
      isRoomOwner: row.ownerUserId === userId,
      visibility: RoomVisibilitySchema.parse(row.visibility),
      lastSeq: asReadCursorSeq(Number(row.lastSeq)),
      joinedAtIso: toDate(row.joinedAt).toISOString(),
    }));
  }

  /**
   * 更新用户展示昵称、权限角色及封禁状态。
   */
  public async updateUserGovernance(
    userId: UserId,
    patch: {
      readonly displayName?: string;
      readonly role?: UserRole;
      readonly status?: UserStatus;
      readonly suspendedAt?: Date | null;
      readonly suspendedReason?: string | null;
    },
  ): Promise<void> {
    const updates: {
      displayName?: string;
      role?: string;
      status?: string;
      suspendedAt?: Date | null;
      suspendedReason?: string | null;
    } = {};

    if (patch.displayName !== undefined) {
      updates.displayName = patch.displayName;
    }
    if (patch.role !== undefined) {
      updates.role = patch.role;
    }
    if (patch.status !== undefined) {
      updates.status = patch.status;
    }
    if (patch.suspendedAt !== undefined) {
      updates.suspendedAt = patch.suspendedAt;
    }
    if (patch.suspendedReason !== undefined) {
      updates.suspendedReason = patch.suspendedReason;
    }

    if (Object.keys(updates).length === 0) {
      return;
    }

    await this.db.update(usersTable).set(updates).where(eq(usersTable.id, userId));
  }

  /**
   * 查询指定用户的全部登录会话（含已过期，供详情抽屉核查）。
   */
  public async listSessionsForUser(
    userId: UserId,
    now: Date,
    adminEmails: ReadonlySet<string>,
  ): Promise<readonly AdminSessionItem[]> {
    const { sessions } = await this.listSessions(
      {
        page: 1,
        pageSize: 50,
        userId,
        status: "all",
      },
      now,
      adminEmails,
    );
    return sessions;
  }

  /**
   * 在事务中安全级联删除用户及名下房间、Agent、会话、跨房残留消息与 OTP 记录。
   *
   * @remarks
   * 安全不变量：在他人房间中由该用户或该用户 Agent 发送的历史消息会被直接删除，
   * 绝不会通过改写 `owner_user_id` 伪造归属关系以破坏 Owner-First 信任模型。
   */
  public async deleteUserCascadeInTx(
    userId: UserId,
    email: string,
  ): Promise<DeletedUserCascadeResult> {
    const ownedRoomRows = await this.db
      .select({ id: roomsTable.id })
      .from(roomsTable)
      .where(eq(roomsTable.ownerUserId, userId));
    const deletedRoomIds = ownedRoomRows.map((row) => row.id as RoomId);

    const ownedAgentRows = await this.db
      .select({ id: agentsTable.id })
      .from(agentsTable)
      .where(eq(agentsTable.ownerUserId, userId));
    const deletedAgentIds = ownedAgentRows.map((row) => row.id as AgentId);

    const deletedSessions = await this.db
      .delete(userSessionsTable)
      .where(eq(userSessionsTable.userId, userId))
      .returning({ id: userSessionsTable.id });

    // 先清理指向名下待删除房间的配对码外延引用，再逐一删除名下房间（触发 messages / room_members / proposals 级联删除）
    for (const roomId of deletedRoomIds) {
      await this.db
        .update(pairingCodesTable)
        .set({ autoJoinRoomId: null })
        .where(eq(pairingCodesTable.autoJoinRoomId, roomId));
      await this.db.delete(roomsTable).where(eq(roomsTable.id, roomId));
    }

    // 清理该用户（或其名下 Agent）在其他人房间中产生的消息，满足 messages.owner_user_id ON DELETE RESTRICT
    await this.db.delete(messagesTable).where(eq(messagesTable.ownerUserId, userId));
    await this.db.delete(authOtpCodesTable).where(eq(authOtpCodesTable.email, email));
    await this.db.delete(usersTable).where(eq(usersTable.id, userId));

    return {
      deletedRoomIds,
      deletedAgentIds,
      deletedSessionCount: deletedSessions.length,
    };
  }

  /* ─────────────────────────────────────────────────────────────
   * 3. 登录会话管理仓储
   * ───────────────────────────────────────────────────────────── */

  /**
   * 分页检索登录会话列表（严格剥离 `token_hash`）。
   */
  public async listSessions(
    query: Readonly<AdminSessionListQuery>,
    now: Date,
    adminEmails: ReadonlySet<string>,
  ): Promise<{
    readonly sessions: readonly AdminSessionItem[];
    readonly pagination: AdminPagination;
  }> {
    const nowIso = now.toISOString();
    const offset = (query.page - 1) * query.pageSize;
    const conditions = [sql`1 = 1`];

    if (query.userId !== undefined) {
      conditions.push(sql`s.user_id = ${query.userId}`);
    }
    if (query.status === "active") {
      conditions.push(sql`s.expires_at > ${nowIso}::timestamptz`);
    } else if (query.status === "expired") {
      conditions.push(sql`s.expires_at <= ${nowIso}::timestamptz`);
    }
    if (query.search && query.search.trim().length > 0) {
      const pattern = `%${query.search.trim()}%`;
      conditions.push(
        sql`(u.email ILIKE ${pattern} OR u.display_name ILIKE ${pattern} OR s.id ILIKE ${pattern})`,
      );
    }

    const whereClause = sql.join(conditions, sql` AND `);

    const countRes = await this.db.execute(sql`
      SELECT COUNT(*)::int AS "total"
      FROM user_sessions s
      INNER JOIN users u ON s.user_id = u.id
      WHERE ${whereClause}
    `);
    const total = Number(extractSqlRows<{ readonly total: number }>(countRes)[0]?.total ?? 0);

    const rowsRes = await this.db.execute(sql`
      SELECT
        s.id AS "id",
        s.user_id AS "userId",
        u.email AS "userEmail",
        u.display_name AS "userDisplayName",
        u.role AS "userRole",
        u.status AS "userStatus",
        s.expires_at AS "expiresAt",
        s.created_at AS "createdAt"
      FROM user_sessions s
      INNER JOIN users u ON s.user_id = u.id
      WHERE ${whereClause}
      ORDER BY s.created_at DESC
      LIMIT ${query.pageSize} OFFSET ${offset}
    `);

    const nowMs = now.getTime();
    const sessions = extractSqlRows<{
      readonly id: string;
      readonly userId: string;
      readonly userEmail: string;
      readonly userDisplayName: string;
      readonly userRole: string;
      readonly userStatus: string;
      readonly expiresAt: Date | string;
      readonly createdAt: Date | string;
    }>(rowsRes).map((row): AdminSessionItem => {
      const expiresAt = toDate(row.expiresAt);
      const dbRole = UserRoleSchema.parse(row.userRole);
      const userRole: UserRole = adminEmails.has(row.userEmail.toLowerCase()) ? "admin" : dbRole;
      return {
        id: row.id as SessionId,
        userId: row.userId as UserId,
        userEmail: row.userEmail,
        userDisplayName: row.userDisplayName,
        userRole,
        userStatus: UserStatusSchema.parse(row.userStatus),
        isExpired: expiresAt.getTime() <= nowMs,
        expiresAtIso: expiresAt.toISOString(),
        createdAtIso: toDate(row.createdAt).toISOString(),
      };
    });

    return {
      sessions,
      pagination: buildPagination(query.page, query.pageSize, total),
    };
  }

  /**
   * 按主键查找单个会话元数据（不含 `token_hash`）。
   */
  public async findSessionById(sessionId: SessionId): Promise<
    | {
        readonly id: SessionId;
        readonly userId: UserId;
        readonly userEmail: string;
      }
    | undefined
  > {
    const rows = await this.db
      .select({
        id: userSessionsTable.id,
        userId: userSessionsTable.userId,
        userEmail: usersTable.email,
      })
      .from(userSessionsTable)
      .innerJoin(usersTable, eq(userSessionsTable.userId, usersTable.id))
      .where(eq(userSessionsTable.id, sessionId))
      .limit(1);

    const row = rows[0];
    return row
      ? {
          id: row.id as SessionId,
          userId: row.userId as UserId,
          userEmail: row.userEmail,
        }
      : undefined;
  }

  /**
   * 吊销单条指定登录会话。
   */
  public async deleteSessionById(sessionId: SessionId): Promise<boolean> {
    const deleted = await this.db
      .delete(userSessionsTable)
      .where(eq(userSessionsTable.id, sessionId))
      .returning({ id: userSessionsTable.id });
    return deleted.length > 0;
  }

  /**
   * 强制吊销指定用户名下的全部登录会话。
   */
  public async deleteAllSessionsByUserId(userId: UserId): Promise<number> {
    const deleted = await this.db
      .delete(userSessionsTable)
      .where(eq(userSessionsTable.userId, userId))
      .returning({ id: userSessionsTable.id });
    return deleted.length;
  }

  /**
   * 批量清理截止当前时间已过期的会话记录。
   */
  public async purgeExpiredSessions(now: Date): Promise<number> {
    const nowIso = now.toISOString();
    const res = await this.db.execute(sql`
      DELETE FROM user_sessions
      WHERE expires_at <= ${nowIso}::timestamptz
      RETURNING id
    `);
    return extractSqlRows<{ readonly id: string }>(res).length;
  }

  /* ─────────────────────────────────────────────────────────────
   * 4. 群聊房间与内容监管仓储
   * ───────────────────────────────────────────────────────────── */

  private buildRoomWhereClause(query: {
    readonly search?: string | undefined;
    readonly visibility?: RoomVisibility | undefined;
    readonly governanceStatus?: string | undefined;
  }) {
    const conditions = [sql`1 = 1`];
    if (query.search && query.search.trim().length > 0) {
      const pattern = `%${query.search.trim()}%`;
      conditions.push(
        sql`(r.name ILIKE ${pattern} OR r.topic ILIKE ${pattern} OR r.id ILIKE ${pattern} OR u.email ILIKE ${pattern})`,
      );
    }
    if (query.visibility !== undefined) {
      conditions.push(sql`r.visibility = ${query.visibility}`);
    }
    if (query.governanceStatus !== undefined) {
      conditions.push(sql`r.governance_json->>'status' = ${query.governanceStatus}`);
    }
    return sql.join(conditions, sql` AND `);
  }

  /**
   * 分页查询全平台群聊房间及活跃统计汇总。
   */
  public async listRooms(
    query: Readonly<AdminRoomListQuery>,
  ): Promise<{ readonly rooms: readonly AdminRoomItem[]; readonly pagination: AdminPagination }> {
    const whereClause = this.buildRoomWhereClause(query);
    const offset = (query.page - 1) * query.pageSize;

    const countRes = await this.db.execute(sql`
      SELECT COUNT(*)::int AS "total"
      FROM rooms r
      INNER JOIN users u ON r.owner_user_id = u.id
      WHERE ${whereClause}
    `);
    const total = Number(extractSqlRows<{ readonly total: number }>(countRes)[0]?.total ?? 0);

    const rowsRes = await this.db.execute(sql`
      SELECT
        r.id AS "id",
        r.name AS "name",
        r.topic AS "topic",
        r.rules AS "rules",
        r.owner_user_id AS "ownerUserId",
        u.email AS "ownerEmail",
        u.display_name AS "ownerDisplayName",
        r.visibility AS "visibility",
        r.governance_json AS "governanceJson",
        r.last_seq AS "lastSeq",
        r.created_at AS "createdAt",
        COALESCE(rm_agg."memberCount", 0)::int AS "memberCount",
        COALESCE(rm_agg."humanMemberCount", 0)::int AS "humanMemberCount",
        COALESCE(rm_agg."agentMemberCount", 0)::int AS "agentMemberCount",
        COALESCE(msg_agg."messageCount", 0)::int AS "messageCount",
        msg_agg."lastMessageAt" AS "lastMessageAt",
        COALESCE(prop_agg."openProposalCount", 0)::int AS "openProposalCount"
      FROM rooms r
      INNER JOIN users u ON r.owner_user_id = u.id
      LEFT JOIN (
        SELECT
          room_id,
          COUNT(*)::int AS "memberCount",
          COALESCE(SUM(CASE WHEN member_kind = 'human' THEN 1 ELSE 0 END), 0)::int AS "humanMemberCount",
          COALESCE(SUM(CASE WHEN member_kind = 'agent' THEN 1 ELSE 0 END), 0)::int AS "agentMemberCount"
        FROM room_members
        GROUP BY room_id
      ) rm_agg ON rm_agg.room_id = r.id
      LEFT JOIN (
        SELECT room_id, COUNT(*)::int AS "messageCount", MAX(created_at) AS "lastMessageAt"
        FROM messages
        GROUP BY room_id
      ) msg_agg ON msg_agg.room_id = r.id
      LEFT JOIN (
        SELECT room_id, COUNT(*)::int AS "openProposalCount"
        FROM proposals
        WHERE status = 'open'
        GROUP BY room_id
      ) prop_agg ON prop_agg.room_id = r.id
      WHERE ${whereClause}
      ORDER BY COALESCE(msg_agg."lastMessageAt", r.created_at) DESC, r.created_at DESC
      LIMIT ${query.pageSize} OFFSET ${offset}
    `);

    const rooms = extractSqlRows<{
      readonly id: string;
      readonly name: string;
      readonly topic: string;
      readonly rules: string;
      readonly ownerUserId: string;
      readonly ownerEmail: string;
      readonly ownerDisplayName: string;
      readonly visibility: string;
      readonly governanceJson: unknown;
      readonly lastSeq: number;
      readonly createdAt: Date | string;
      readonly memberCount: number;
      readonly humanMemberCount: number;
      readonly agentMemberCount: number;
      readonly messageCount: number;
      readonly lastMessageAt: Date | string | null;
      readonly openProposalCount: number;
    }>(rowsRes).map((row) => this.mapRoomRowToAdminItem(row));

    return {
      rooms,
      pagination: buildPagination(query.page, query.pageSize, total),
    };
  }

  /**
   * 按主键查询单个房间监管聚合摘要（含 `inviteToken`）。
   */
  public async findAdminRoomById(
    roomId: RoomId,
  ): Promise<{ readonly room: AdminRoomItem; readonly inviteToken: string } | undefined> {
    const res = await this.db.execute(sql`
      SELECT
        r.id AS "id",
        r.name AS "name",
        r.topic AS "topic",
        r.rules AS "rules",
        r.owner_user_id AS "ownerUserId",
        u.email AS "ownerEmail",
        u.display_name AS "ownerDisplayName",
        r.visibility AS "visibility",
        r.invite_token AS "inviteToken",
        r.governance_json AS "governanceJson",
        r.last_seq AS "lastSeq",
        r.created_at AS "createdAt",
        COALESCE(rm_agg."memberCount", 0)::int AS "memberCount",
        COALESCE(rm_agg."humanMemberCount", 0)::int AS "humanMemberCount",
        COALESCE(rm_agg."agentMemberCount", 0)::int AS "agentMemberCount",
        COALESCE(msg_agg."messageCount", 0)::int AS "messageCount",
        msg_agg."lastMessageAt" AS "lastMessageAt",
        COALESCE(prop_agg."openProposalCount", 0)::int AS "openProposalCount"
      FROM rooms r
      INNER JOIN users u ON r.owner_user_id = u.id
      LEFT JOIN (
        SELECT
          room_id,
          COUNT(*)::int AS "memberCount",
          COALESCE(SUM(CASE WHEN member_kind = 'human' THEN 1 ELSE 0 END), 0)::int AS "humanMemberCount",
          COALESCE(SUM(CASE WHEN member_kind = 'agent' THEN 1 ELSE 0 END), 0)::int AS "agentMemberCount"
        FROM room_members
        GROUP BY room_id
      ) rm_agg ON rm_agg.room_id = r.id
      LEFT JOIN (
        SELECT room_id, COUNT(*)::int AS "messageCount", MAX(created_at) AS "lastMessageAt"
        FROM messages
        GROUP BY room_id
      ) msg_agg ON msg_agg.room_id = r.id
      LEFT JOIN (
        SELECT room_id, COUNT(*)::int AS "openProposalCount"
        FROM proposals
        WHERE status = 'open'
        GROUP BY room_id
      ) prop_agg ON prop_agg.room_id = r.id
      WHERE r.id = ${roomId}
      LIMIT 1
    `);

    const row = extractSqlRows<{
      readonly id: string;
      readonly name: string;
      readonly topic: string;
      readonly rules: string;
      readonly ownerUserId: string;
      readonly ownerEmail: string;
      readonly ownerDisplayName: string;
      readonly visibility: string;
      readonly inviteToken: string;
      readonly governanceJson: unknown;
      readonly lastSeq: number;
      readonly createdAt: Date | string;
      readonly memberCount: number;
      readonly humanMemberCount: number;
      readonly agentMemberCount: number;
      readonly messageCount: number;
      readonly lastMessageAt: Date | string | null;
      readonly openProposalCount: number;
    }>(res)[0];

    if (!row) {
      return undefined;
    }

    return {
      room: this.mapRoomRowToAdminItem(row),
      inviteToken: row.inviteToken,
    };
  }

  private mapRoomRowToAdminItem(row: {
    readonly id: string;
    readonly name: string;
    readonly topic: string;
    readonly rules: string;
    readonly ownerUserId: string;
    readonly ownerEmail: string;
    readonly ownerDisplayName: string;
    readonly visibility: string;
    readonly governanceJson: unknown;
    readonly lastSeq: number;
    readonly createdAt: Date | string;
    readonly memberCount: number;
    readonly humanMemberCount: number;
    readonly agentMemberCount: number;
    readonly messageCount: number;
    readonly lastMessageAt: Date | string | null;
    readonly openProposalCount: number;
  }): AdminRoomItem {
    const governance = RoomGovernanceStateSchema.parse(
      parseJsonObject<unknown>(row.governanceJson),
    );
    const lastMessageAt = toNullableDate(row.lastMessageAt);
    return {
      id: row.id as RoomId,
      name: row.name,
      topic: row.topic,
      rules: row.rules,
      ownerUserId: row.ownerUserId as UserId,
      ownerEmail: row.ownerEmail,
      ownerDisplayName: row.ownerDisplayName,
      visibility: RoomVisibilitySchema.parse(row.visibility),
      governance,
      lastSeq: asReadCursorSeq(Number(row.lastSeq)),
      memberCount: Number(row.memberCount),
      humanMemberCount: Number(row.humanMemberCount),
      agentMemberCount: Number(row.agentMemberCount),
      messageCount: Number(row.messageCount),
      openProposalCount: Number(row.openProposalCount),
      ...(lastMessageAt !== null ? { lastMessageAtIso: lastMessageAt.toISOString() } : {}),
      createdAtIso: toDate(row.createdAt).toISOString(),
    };
  }

  /**
   * 管理员热更新房间基础元信息、可见性与治理状态快照。
   */
  public async updateRoomMetaAndGovernance(
    roomId: RoomId,
    patch: {
      readonly name?: string;
      readonly topic?: string;
      readonly rules?: string;
      readonly visibility?: RoomVisibility;
      readonly governanceJson: RoomGovernanceState;
    },
  ): Promise<void> {
    const updates: {
      name?: string;
      topic?: string;
      rules?: string;
      visibility?: string;
      governanceJson: RoomGovernanceState;
    } = {
      governanceJson: patch.governanceJson,
    };

    if (patch.name !== undefined) {
      updates.name = patch.name;
    }
    if (patch.topic !== undefined) {
      updates.topic = patch.topic;
    }
    if (patch.rules !== undefined) {
      updates.rules = patch.rules;
    }
    if (patch.visibility !== undefined) {
      updates.visibility = patch.visibility;
    }

    await this.db.update(roomsTable).set(updates).where(eq(roomsTable.id, roomId));
  }

  /**
   * 管理员只读审查房间历史消息流（支持搜索、筛选与 `beforeSeq` 游标回溯，不推进任何成员已读游标）。
   */
  public async listRoomMessagesForAdmin(
    roomId: RoomId,
    query: Readonly<AdminRoomMessagesQuery>,
  ): Promise<{
    readonly messages: readonly HydratedRawMessageRecord[];
    readonly hasMore: boolean;
  }> {
    const conditions = [sql`m.room_id = ${roomId}`];
    if (query.beforeSeq !== undefined) {
      conditions.push(sql`m.seq < ${query.beforeSeq}`);
    }
    if (query.authorKind !== undefined) {
      conditions.push(sql`m.author_kind = ${query.authorKind}`);
    }
    if (query.type !== undefined) {
      conditions.push(sql`m.type = ${query.type}`);
    }
    if (!query.includeRecalled) {
      conditions.push(sql`m.recalled_at IS NULL`);
    }
    if (query.search && query.search.trim().length > 0) {
      const pattern = `%${query.search.trim()}%`;
      conditions.push(
        sql`(m.content ILIKE ${pattern} OR COALESCE(u.display_name, '') ILIKE ${pattern} OR COALESCE(a.display_name, '') ILIKE ${pattern})`,
      );
    }

    const whereClause = sql.join(conditions, sql` AND `);
    const fetchLimit = query.limit + 1;

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
      WHERE ${whereClause}
      ORDER BY m.seq DESC
      LIMIT ${fetchLimit}
    `);

    const rows = extractSqlRows<RawSqlMessageRow>(result);
    const hasMore = rows.length > query.limit;
    const sliced = hasMore ? rows.slice(0, query.limit) : rows;
    // 反转为时间正序（seq ASC）返回，方便前端直接像聊天记录一样自上而下阅读
    const chronological = [...sliced].reverse().map(mapSqlRowToHydratedMessage);

    return {
      messages: chronological,
      hasMore,
    };
  }

  /* ─────────────────────────────────────────────────────────────
   * 5. 全局 Agent、提案、配对码与审计日志仓储
   * ───────────────────────────────────────────────────────────── */

  /**
   * 分页查询全平台已绑定 Agent（动态水合实时 `reach` 状态，支持 `reach` 筛选与安全分页）。
   */
  public async listAgents(
    query: Readonly<AdminAgentListQuery>,
    realtimeBus: RealtimeBus,
    nowMs: number,
  ): Promise<{ readonly agents: readonly AdminAgentItem[]; readonly pagination: AdminPagination }> {
    const conditions = [sql`1 = 1`];
    if (query.platform !== undefined) {
      conditions.push(sql`a.platform = ${query.platform}`);
    }
    if (query.ownerUserId !== undefined) {
      conditions.push(sql`a.owner_user_id = ${query.ownerUserId}`);
    }
    if (query.search && query.search.trim().length > 0) {
      const pattern = `%${query.search.trim()}%`;
      conditions.push(
        sql`(a.display_name ILIKE ${pattern} OR a.slug ILIKE ${pattern} OR a.id ILIKE ${pattern} OR u.email ILIKE ${pattern} OR u.display_name ILIKE ${pattern})`,
      );
    }

    const whereClause = sql.join(conditions, sql` AND `);

    const res = await this.db.execute(sql`
      SELECT
        a.id AS "id",
        a.owner_user_id AS "ownerUserId",
        u.email AS "ownerEmail",
        u.display_name AS "ownerDisplayName",
        a.display_name AS "displayName",
        a.slug AS "slug",
        a.platform AS "platform",
        a.intro AS "intro",
        a.wake_kind AS "wakeKind",
        a.checkin_interval_min AS "checkinIntervalMin",
        a.last_seen_at AS "lastSeenAt",
        a.created_at AS "createdAt",
        COALESCE(rm_agg."roomCount", 0)::int AS "roomCount",
        COALESCE(msg_agg."messageCount", 0)::int AS "messageCount"
      FROM agents a
      INNER JOIN users u ON a.owner_user_id = u.id
      LEFT JOIN (
        SELECT agent_id, COUNT(*)::int AS "roomCount"
        FROM room_members
        WHERE member_kind = 'agent' AND agent_id IS NOT NULL
        GROUP BY agent_id
      ) rm_agg ON rm_agg.agent_id = a.id
      LEFT JOIN (
        SELECT author_agent_id, COUNT(*)::int AS "messageCount"
        FROM messages
        WHERE author_kind = 'agent' AND author_agent_id IS NOT NULL
        GROUP BY author_agent_id
      ) msg_agg ON msg_agg.author_agent_id = a.id
      WHERE ${whereClause}
      ORDER BY COALESCE(a.last_seen_at, a.created_at) DESC, a.created_at DESC
    `);

    const hydrated = extractSqlRows<{
      readonly id: string;
      readonly ownerUserId: string;
      readonly ownerEmail: string;
      readonly ownerDisplayName: string;
      readonly displayName: string;
      readonly slug: string;
      readonly platform: string;
      readonly intro: string | null;
      readonly wakeKind: string;
      readonly checkinIntervalMin: number | null;
      readonly lastSeenAt: Date | string | null;
      readonly createdAt: Date | string;
      readonly roomCount: number;
      readonly messageCount: number;
    }>(res).map((row): AdminAgentItem => {
      const agentId = row.id as AgentId;
      const platform = AgentPlatformSchema.parse(row.platform);
      const lastSeenAt = toNullableDate(row.lastSeenAt);
      const reach = computeAgentReachState(
        {
          id: agentId,
          platform,
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
        ownerEmail: row.ownerEmail,
        ownerDisplayName: row.ownerDisplayName,
        displayName: row.displayName,
        slug: row.slug,
        platform,
        ...(row.intro !== null && row.intro.length > 0 ? { intro: row.intro } : {}),
        wakeKind: row.wakeKind,
        reach,
        ...(row.checkinIntervalMin !== null
          ? { checkinIntervalMin: Number(row.checkinIntervalMin) }
          : {}),
        roomCount: Number(row.roomCount),
        messageCount: Number(row.messageCount),
        ...(lastSeenAt !== null ? { lastSeenAtIso: lastSeenAt.toISOString() } : {}),
        createdAtIso: toDate(row.createdAt).toISOString(),
      };
    });

    const filtered =
      query.reach !== undefined ? hydrated.filter((item) => item.reach === query.reach) : hydrated;
    const total = filtered.length;
    const offset = (query.page - 1) * query.pageSize;
    const paged = filtered.slice(offset, offset + query.pageSize);

    return {
      agents: paged,
      pagination: buildPagination(query.page, query.pageSize, total),
    };
  }

  /**
   * 按主键查询单个 Agent 基本信息（用于删除前校验与审计摘要）。
   */
  public async findAgentBasicById(agentId: AgentId): Promise<
    | {
        readonly id: AgentId;
        readonly displayName: string;
        readonly ownerUserId: UserId;
      }
    | undefined
  > {
    const rows = await this.db
      .select({
        id: agentsTable.id,
        displayName: agentsTable.displayName,
        ownerUserId: agentsTable.ownerUserId,
      })
      .from(agentsTable)
      .where(eq(agentsTable.id, agentId))
      .limit(1);
    const row = rows[0];
    return row
      ? {
          id: row.id as AgentId,
          displayName: row.displayName,
          ownerUserId: row.ownerUserId as UserId,
        }
      : undefined;
  }

  /**
   * 物理删除指定 Agent（级联清理群成员与投票，保留历史消息连续性）。
   */
  public async deleteAgentById(agentId: AgentId): Promise<boolean> {
    const deleted = await this.db
      .delete(agentsTable)
      .where(eq(agentsTable.id, agentId))
      .returning({ id: agentsTable.id });
    return deleted.length > 0;
  }

  /**
   * 分页查询全平台结构化提案与拍板决议。
   */
  public async listProposals(query: Readonly<AdminProposalListQuery>): Promise<{
    readonly proposals: readonly AdminProposalItem[];
    readonly pagination: AdminPagination;
  }> {
    const conditions = [sql`1 = 1`];
    if (query.status !== undefined) {
      conditions.push(sql`p.status = ${query.status}`);
    }
    if (query.roomId !== undefined) {
      conditions.push(sql`p.room_id = ${query.roomId}`);
    }
    if (query.search && query.search.trim().length > 0) {
      const pattern = `%${query.search.trim()}%`;
      conditions.push(
        sql`(p.id ILIKE ${pattern} OR r.name ILIKE ${pattern} OR COALESCE(p.draft_json->>'title', '') ILIKE ${pattern})`,
      );
    }

    const whereClause = sql.join(conditions, sql` AND `);
    const offset = (query.page - 1) * query.pageSize;

    const countRes = await this.db.execute(sql`
      SELECT COUNT(*)::int AS "total"
      FROM proposals p
      INNER JOIN rooms r ON p.room_id = r.id
      WHERE ${whereClause}
    `);
    const total = Number(extractSqlRows<{ readonly total: number }>(countRes)[0]?.total ?? 0);

    const rowsRes = await this.db.execute(sql`
      SELECT
        p.id AS "id",
        p.room_id AS "roomId",
        r.name AS "roomName",
        p.origin_message_seq AS "originMessageSeq",
        p.status AS "status",
        p.draft_json AS "draftJson",
        p.decided_option_key AS "decidedOptionKey",
        p.decision_note AS "decisionNote",
        u_decider.display_name AS "decidedByDisplayName",
        p.decided_at AS "decidedAt",
        p.created_at AS "createdAt",
        COALESCE(v_agg."voteCount", 0)::int AS "voteCount"
      FROM proposals p
      INNER JOIN rooms r ON p.room_id = r.id
      LEFT JOIN users u_decider ON p.decided_by_user_id = u_decider.id
      LEFT JOIN (
        SELECT proposal_id, COUNT(*)::int AS "voteCount"
        FROM proposal_votes
        GROUP BY proposal_id
      ) v_agg ON v_agg.proposal_id = p.id
      WHERE ${whereClause}
      ORDER BY p.created_at DESC
      LIMIT ${query.pageSize} OFFSET ${offset}
    `);

    const proposals = extractSqlRows<{
      readonly id: string;
      readonly roomId: string;
      readonly roomName: string;
      readonly originMessageSeq: number;
      readonly status: string;
      readonly draftJson: unknown;
      readonly decidedOptionKey: string | null;
      readonly decisionNote: string | null;
      readonly decidedByDisplayName: string | null;
      readonly decidedAt: Date | string | null;
      readonly createdAt: Date | string;
      readonly voteCount: number;
    }>(rowsRes).map((row): AdminProposalItem => {
      const draft: ProposalDraft = ProposalDraftSchema.parse(
        parseJsonObject<unknown>(row.draftJson),
      );
      const decidedAt = toNullableDate(row.decidedAt);
      return {
        id: row.id as ProposalId,
        roomId: row.roomId as RoomId,
        roomName: row.roomName,
        originMessageSeq: asMessageSeq(Number(row.originMessageSeq)),
        status: ProposalStatusSchema.parse(row.status),
        draft,
        voteCount: Number(row.voteCount),
        ...(row.decidedOptionKey !== null ? { decidedOptionKey: row.decidedOptionKey } : {}),
        ...(row.decisionNote !== null && row.decisionNote.length > 0
          ? { decisionNote: row.decisionNote }
          : {}),
        ...(row.decidedByDisplayName !== null
          ? { decidedByDisplayName: row.decidedByDisplayName }
          : {}),
        ...(decidedAt !== null ? { decidedAtIso: decidedAt.toISOString() } : {}),
        createdAtIso: toDate(row.createdAt).toISOString(),
      };
    });

    return {
      proposals,
      pagination: buildPagination(query.page, query.pageSize, total),
    };
  }

  /**
   * 按主键查询提案基础信息（用于删除前校验与审计日志）。
   */
  public async findProposalBasicById(proposalId: ProposalId): Promise<
    | {
        readonly id: ProposalId;
        readonly roomId: RoomId;
        readonly title: string;
      }
    | undefined
  > {
    const rows = await this.db
      .select({
        id: proposalsTable.id,
        roomId: proposalsTable.roomId,
        draftJson: proposalsTable.draftJson,
      })
      .from(proposalsTable)
      .where(eq(proposalsTable.id, proposalId))
      .limit(1);

    const row = rows[0];
    if (!row) {
      return undefined;
    }
    const draft = ProposalDraftSchema.parse(parseJsonObject<unknown>(row.draftJson));
    return {
      id: row.id as ProposalId,
      roomId: row.roomId as RoomId,
      title: draft.title,
    };
  }

  /**
   * 物理删除指定提案（级联清理关联投票）。
   */
  public async deleteProposalById(proposalId: ProposalId): Promise<boolean> {
    const deleted = await this.db
      .delete(proposalsTable)
      .where(eq(proposalsTable.id, proposalId))
      .returning({ id: proposalsTable.id });
    return deleted.length > 0;
  }

  /**
   * 分页查询全平台一次性配对码及状态。
   */
  public async listPairingCodes(
    query: Readonly<AdminPairingCodeListQuery>,
    now: Date,
  ): Promise<{
    readonly pairingCodes: readonly AdminPairingCodeItem[];
    readonly pagination: AdminPagination;
  }> {
    const nowIso = now.toISOString();
    const conditions = [sql`1 = 1`];

    if (query.status === "used") {
      conditions.push(sql`pc.used_at IS NOT NULL`);
    } else if (query.status === "active") {
      conditions.push(sql`pc.used_at IS NULL AND pc.expires_at > ${nowIso}::timestamptz`);
    } else if (query.status === "expired") {
      conditions.push(sql`pc.used_at IS NULL AND pc.expires_at <= ${nowIso}::timestamptz`);
    }

    if (query.search && query.search.trim().length > 0) {
      const pattern = `%${query.search.trim()}%`;
      conditions.push(
        sql`(pc.code ILIKE ${pattern} OR u.email ILIKE ${pattern} OR u.display_name ILIKE ${pattern})`,
      );
    }

    const whereClause = sql.join(conditions, sql` AND `);
    const offset = (query.page - 1) * query.pageSize;

    const countRes = await this.db.execute(sql`
      SELECT COUNT(*)::int AS "total"
      FROM pairing_codes pc
      INNER JOIN users u ON pc.owner_user_id = u.id
      WHERE ${whereClause}
    `);
    const total = Number(extractSqlRows<{ readonly total: number }>(countRes)[0]?.total ?? 0);

    const rowsRes = await this.db.execute(sql`
      SELECT
        pc.code AS "code",
        pc.owner_user_id AS "ownerUserId",
        u.email AS "ownerEmail",
        u.display_name AS "ownerDisplayName",
        pc.auto_join_room_id AS "autoJoinRoomId",
        r.name AS "autoJoinRoomName",
        pc.reclaim_agent_id AS "reclaimAgentId",
        pc.expires_at AS "expiresAt",
        pc.used_at AS "usedAt",
        pc.created_at AS "createdAt"
      FROM pairing_codes pc
      INNER JOIN users u ON pc.owner_user_id = u.id
      LEFT JOIN rooms r ON pc.auto_join_room_id = r.id
      WHERE ${whereClause}
      ORDER BY pc.created_at DESC
      LIMIT ${query.pageSize} OFFSET ${offset}
    `);

    const nowMs = now.getTime();
    const pairingCodes = extractSqlRows<{
      readonly code: string;
      readonly ownerUserId: string;
      readonly ownerEmail: string;
      readonly ownerDisplayName: string;
      readonly autoJoinRoomId: string | null;
      readonly autoJoinRoomName: string | null;
      readonly reclaimAgentId: string | null;
      readonly expiresAt: Date | string;
      readonly usedAt: Date | string | null;
      readonly createdAt: Date | string;
    }>(rowsRes).map((row): AdminPairingCodeItem => {
      const expiresAt = toDate(row.expiresAt);
      const usedAt = toNullableDate(row.usedAt);
      let status: AdminPairingCodeStatus;
      if (usedAt !== null) {
        status = "used";
      } else if (expiresAt.getTime() <= nowMs) {
        status = "expired";
      } else {
        status = "active";
      }
      return {
        code: row.code as PairingCode,
        ownerUserId: row.ownerUserId as UserId,
        ownerEmail: row.ownerEmail,
        ownerDisplayName: row.ownerDisplayName,
        ...(row.autoJoinRoomId !== null ? { autoJoinRoomId: row.autoJoinRoomId as RoomId } : {}),
        ...(row.autoJoinRoomName !== null ? { autoJoinRoomName: row.autoJoinRoomName } : {}),
        ...(row.reclaimAgentId !== null ? { reclaimAgentId: row.reclaimAgentId as AgentId } : {}),
        status,
        expiresAtIso: expiresAt.toISOString(),
        ...(usedAt !== null ? { usedAtIso: usedAt.toISOString() } : {}),
        createdAtIso: toDate(row.createdAt).toISOString(),
      };
    });

    return {
      pairingCodes,
      pagination: buildPagination(query.page, query.pageSize, total),
    };
  }

  /**
   * 吊销删除单个配对码。
   */
  public async deletePairingCode(code: PairingCode): Promise<boolean> {
    const deleted = await this.db
      .delete(pairingCodesTable)
      .where(eq(pairingCodesTable.code, code))
      .returning({ code: pairingCodesTable.code });
    return deleted.length > 0;
  }

  /**
   * 批量清理全部已使用或已过期的历史配对码。
   */
  public async purgeInactivePairingCodes(now: Date): Promise<number> {
    const nowIso = now.toISOString();
    const res = await this.db.execute(sql`
      DELETE FROM pairing_codes
      WHERE used_at IS NOT NULL OR expires_at <= ${nowIso}::timestamptz
      RETURNING code
    `);
    return extractSqlRows<{ readonly code: string }>(res).length;
  }

  /**
   * 写入一条管理员操作审计日志。
   */
  public async insertAuditLog(input: Readonly<InsertAuditLogInput>): Promise<void> {
    await this.db.insert(adminAuditLogsTable).values({
      id: input.id,
      actorUserId: input.actorUserId,
      actorEmail: input.actorEmail,
      actorDisplayName: input.actorDisplayName,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      summary: input.summary,
      metadataJson: input.metadata ? { ...input.metadata } : null,
    });
  }

  /**
   * 分页检索管理员操作审计日志列表。
   */
  public async listAuditLogs(query: Readonly<AdminAuditLogListQuery>): Promise<{
    readonly logs: readonly AdminAuditLogItem[];
    readonly pagination: AdminPagination;
  }> {
    const conditions = [sql`1 = 1`];
    if (query.targetType !== undefined) {
      conditions.push(sql`target_type = ${query.targetType}`);
    }
    if (query.action !== undefined) {
      conditions.push(sql`action = ${query.action}`);
    }
    if (query.search && query.search.trim().length > 0) {
      const pattern = `%${query.search.trim()}%`;
      conditions.push(
        sql`(actor_email ILIKE ${pattern} OR actor_display_name ILIKE ${pattern} OR target_id ILIKE ${pattern} OR summary ILIKE ${pattern})`,
      );
    }

    const whereClause = sql.join(conditions, sql` AND `);
    const offset = (query.page - 1) * query.pageSize;

    const countRes = await this.db.execute(sql`
      SELECT COUNT(*)::int AS "total"
      FROM admin_audit_logs
      WHERE ${whereClause}
    `);
    const total = Number(extractSqlRows<{ readonly total: number }>(countRes)[0]?.total ?? 0);

    const rowsRes = await this.db.execute(sql`
      SELECT
        id AS "id",
        actor_user_id AS "actorUserId",
        actor_email AS "actorEmail",
        actor_display_name AS "actorDisplayName",
        action AS "action",
        target_type AS "targetType",
        target_id AS "targetId",
        summary AS "summary",
        metadata_json AS "metadataJson",
        created_at AS "createdAt"
      FROM admin_audit_logs
      WHERE ${whereClause}
      ORDER BY created_at DESC, id DESC
      LIMIT ${query.pageSize} OFFSET ${offset}
    `);

    const logs = extractSqlRows<{
      readonly id: string;
      readonly actorUserId: string | null;
      readonly actorEmail: string;
      readonly actorDisplayName: string;
      readonly action: string;
      readonly targetType: string;
      readonly targetId: string;
      readonly summary: string;
      readonly metadataJson: unknown;
      readonly createdAt: Date | string;
    }>(rowsRes).map((row): AdminAuditLogItem => {
      const rawMeta =
        row.metadataJson !== null && row.metadataJson !== undefined
          ? parseJsonObject<Record<string, unknown>>(row.metadataJson)
          : undefined;
      return {
        id: row.id as AuditLogId,
        ...(row.actorUserId !== null ? { actorUserId: row.actorUserId as UserId } : {}),
        actorEmail: row.actorEmail,
        actorDisplayName: row.actorDisplayName,
        action: AdminAuditActionSchema.parse(row.action),
        targetType: AdminAuditTargetTypeSchema.parse(row.targetType),
        targetId: row.targetId,
        summary: row.summary,
        ...(rawMeta !== undefined ? { metadata: rawMeta } : {}),
        createdAtIso: toDate(row.createdAt).toISOString(),
      };
    });

    return {
      logs,
      pagination: buildPagination(query.page, query.pageSize, total),
    };
  }
}
