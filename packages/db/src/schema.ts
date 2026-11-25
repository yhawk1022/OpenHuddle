/**
 * @module db/schema
 * @description OpenHuddle 核心 PostgreSQL 表结构定义（Drizzle ORM）。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 统一 PostgreSQL 方言：100% 兼容本地免容器 `@electric-sql/pglite` 与生产 `PostgreSQL 16+`，杜绝 SQLite/PG 双写语法分裂。
 * 2. 密钥只存哈希：`agents.token_hash` 仅存储 `oh_agt_` 令牌的 SHA-256 摘要，绝不落盘明文凭据。
 * 3. 房间序号与幂等唯一约束：`messages` 表以 `(room_id, seq)` 为联合主键，并对 `(room_id, op_key)` 建唯一索引保障重试幂等。
 */
import type {
  DecisionMandate,
  MessageMention,
  ProposalDraft,
  RoomGovernanceState,
  WorkDiffFileDto,
  WorkSliceProvenance,
  WorkTraceEntry,
  WorkspaceContextAssets,
  WorkspaceLifecycleHooks,
  WorkspaceRootEntry,
} from "@openhuddle/protocol";
import {
  boolean,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * 人类主人账户表（`users`）。
 * `password_hash` 仅存储 `scrypt` 强盐值单向哈希，绝不落盘明文密码。
 */
export const usersTable = pgTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    displayName: text("display_name").notNull(),
    avatarUrl: text("avatar_url"),
    passwordHash: text("password_hash"),
    emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
    passwordUpdatedAt: timestamp("password_updated_at", { withTimezone: true }),
    role: text("role").notNull().default("user"),
    status: text("status").notNull().default("active"),
    themePreference: text("theme_preference").notNull().default("auto"),
    suspendedAt: timestamp("suspended_at", { withTimezone: true }),
    suspendedReason: text("suspended_reason"),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("users_email_unique_idx").on(table.email),
    index("users_created_at_idx").on(table.createdAt),
  ],
);

/**
 * 人类注册激活、密码重置与旧版 OTP 登录一次性邮箱验证码表（`auth_otp_codes`）。
 * 仅存储 6 位验证码的 SHA-256 哈希摘要、用途隔离键（`purpose`）与错误尝试次数（`attempt_count`）。
 */
export const authOtpCodesTable = pgTable(
  "auth_otp_codes",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    purpose: text("purpose").notNull().default("login"),
    codeHash: text("code_hash").notNull(),
    attemptCount: integer("attempt_count").notNull().default(0),
    requestedDisplayName: text("requested_display_name"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("auth_otp_codes_email_purpose_created_idx").on(
      table.email,
      table.purpose,
      table.createdAt,
    ),
  ],
);

/**
 * 人类 Web 登录会话表（`user_sessions`）。
 * 仅存储 `oh_ses_` 会话令牌的 SHA-256 摘要，支持主动登出与过期清理。
 */
export const userSessionsTable = pgTable(
  "user_sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("user_sessions_token_hash_unique_idx").on(table.tokenHash),
    index("user_sessions_user_id_idx").on(table.userId),
    index("user_sessions_expires_at_idx").on(table.expiresAt),
  ],
);

/**
 * 归属于人类主人的个人智能体或托管模型表（`agents`）。
 */
export const agentsTable = pgTable(
  "agents",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    displayName: text("display_name").notNull(),
    slug: text("slug").notNull(),
    platform: text("platform").notNull(),
    intro: text("intro"),
    allowExternalDm: boolean("allow_external_dm").notNull().default(false),
    tokenHash: text("token_hash").notNull(),
    wakeKind: text("wake_kind").notNull().default("none"),
    wakeConfigJson: jsonb("wake_config_json").$type<Record<string, unknown>>(),
    checkinIntervalMin: integer("checkin_interval_min"),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("agents_token_hash_unique_idx").on(table.tokenHash),
    uniqueIndex("agents_owner_slug_unique_idx").on(table.ownerUserId, table.slug),
  ],
);

/**
 * 一次性短配对码与掉线重连认领表（`pairing_codes`）。
 */
export const pairingCodesTable = pgTable("pairing_codes", {
  code: text("code").primaryKey(),
  ownerUserId: text("owner_user_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  autoJoinRoomId: text("auto_join_room_id"),
  reclaimAgentId: text("reclaim_agent_id").references(() => agentsTable.id, {
    onDelete: "set null",
  }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * 人类用户间好友关系与待处理申请表（`friendships`，ADR-0005）。
 * 使用规范化无序对键 `pair_key`（`<lowUserId>:<highUserId>`）强制任意两人之间最多只有一条关系记录。
 * 私有备注按查看者的高低位身份存储，解除关系时随关系行删除。
 */
export const friendshipsTable = pgTable(
  "friendships",
  {
    id: text("id").primaryKey(),
    pairKey: text("pair_key").notNull(),
    userLowId: text("user_low_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    userHighId: text("user_high_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    requesterUserId: text("requester_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    addresseeUserId: text("addressee_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("pending"),
    note: text("note"),
    userLowRemark: text("user_low_remark"),
    userHighRemark: text("user_high_remark"),
    respondedAt: timestamp("responded_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("friendships_pair_key_unique_idx").on(table.pairKey),
    index("friendships_low_status_idx").on(table.userLowId, table.status),
    index("friendships_high_status_idx").on(table.userHighId, table.status),
    index("friendships_addressee_status_idx").on(table.addresseeUserId, table.status),
  ],
);

/**
 * 多模态会话房间表（`rooms`：同时承载多方群聊 `group`、单聊 Agent `direct_agent` 与人类好友私聊 `direct_human`）。
 */
export const roomsTable = pgTable(
  "rooms",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull().default("group"),
    directPairKey: text("direct_pair_key"),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    topic: text("topic").notNull().default(""),
    rules: text("rules").notNull().default(""),
    visibility: text("visibility").notNull().default("invite_only"),
    inviteToken: text("invite_token").notNull(),
    governanceJson: jsonb("governance_json").$type<RoomGovernanceState>().notNull(),
    lastSeq: integer("last_seq").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("rooms_invite_token_unique_idx").on(table.inviteToken),
    uniqueIndex("rooms_direct_pair_key_unique_idx").on(table.directPairKey),
    index("rooms_created_at_idx").on(table.createdAt),
  ],
);

/**
 * 房间成员、群备注与已读游标表（`room_members`）。
 * 使用 `member_key`（如 `human:usr_xxx` 或 `agent:agt_xxx`）配合 `room_id` 构成确定性联合主键。
 */
export const roomMembersTable = pgTable(
  "room_members",
  {
    roomId: text("room_id")
      .notNull()
      .references(() => roomsTable.id, { onDelete: "cascade" }),
    memberKey: text("member_key").notNull(),
    memberKind: text("member_kind").notNull(),
    userId: text("user_id").references(() => usersTable.id, { onDelete: "cascade" }),
    agentId: text("agent_id").references(() => agentsTable.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("member"),
    remark: text("remark"),
    lastReadSeq: integer("last_read_seq").notNull().default(0),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.roomId, table.memberKey] }),
    index("room_members_member_key_idx").on(table.memberKey),
    index("room_members_agent_id_idx").on(table.agentId),
  ],
);

/**
 * 房间严格连续递增消息流表（`messages`）。
 */
export const messagesTable = pgTable(
  "messages",
  {
    roomId: text("room_id")
      .notNull()
      .references(() => roomsTable.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    authorKind: text("author_kind").notNull(),
    authorUserId: text("author_user_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    authorAgentId: text("author_agent_id").references(() => agentsTable.id, {
      onDelete: "set null",
    }),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "restrict" }),
    type: text("type").notNull().default("text"),
    content: text("content").notNull(),
    payloadJson: jsonb("payload_json").$type<Record<string, unknown>>(),
    replyToSeq: integer("reply_to_seq"),
    mentionsJson: jsonb("mentions_json").$type<readonly MessageMention[]>().notNull(),
    opKey: text("op_key"),
    recalledAt: timestamp("recalled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.roomId, table.seq] }),
    uniqueIndex("messages_room_op_key_unique_idx").on(table.roomId, table.opKey),
    index("messages_created_at_idx").on(table.createdAt),
  ],
);

const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => "bytea",
});

/**
 * 消息媒体二进制表。将大字段与消息流分开，删除消息或房间时由外键级联清理。
 */
export const messageAttachmentsTable = pgTable(
  "message_attachments",
  {
    roomId: text("room_id").notNull(),
    seq: integer("seq").notNull(),
    bytes: bytea("bytes").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.roomId, table.seq] }),
    foreignKey({
      columns: [table.roomId, table.seq],
      foreignColumns: [messagesTable.roomId, messagesTable.seq],
      name: "message_attachments_message_fk",
    }).onDelete("cascade"),
  ],
);

/**
 * 结构化提案与人类决策拍板表（`proposals`）。
 */
export const proposalsTable = pgTable(
  "proposals",
  {
    id: text("id").primaryKey(),
    roomId: text("room_id")
      .notNull()
      .references(() => roomsTable.id, { onDelete: "cascade" }),
    originMessageSeq: integer("origin_message_seq").notNull(),
    status: text("status").notNull().default("open"),
    draftJson: jsonb("draft_json").$type<ProposalDraft>().notNull(),
    decidedOptionKey: text("decided_option_key"),
    decisionNote: text("decision_note"),
    decidedByUserId: text("decided_by_user_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    mandateJson: jsonb("mandate_json").$type<DecisionMandate>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("proposals_room_origin_seq_idx").on(table.roomId, table.originMessageSeq)],
);

/**
 * 提案结构化投票表（`proposal_votes`）。
 */
export const proposalVotesTable = pgTable(
  "proposal_votes",
  {
    proposalId: text("proposal_id")
      .notNull()
      .references(() => proposalsTable.id, { onDelete: "cascade" }),
    voterKey: text("voter_key").notNull(),
    voterKind: text("voter_kind").notNull(),
    voterUserId: text("voter_user_id").references(() => usersTable.id, { onDelete: "cascade" }),
    voterAgentId: text("voter_agent_id").references(() => agentsTable.id, {
      onDelete: "cascade",
    }),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    stance: text("stance").notNull(),
    preferredOptionKey: text("preferred_option_key"),
    rationale: text("rationale").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.proposalId, table.voterKey] })],
);

/**
 * 运营与治理管理后台操作审计日志表（`admin_audit_logs`）。
 * 保留操作发生时的管理员邮箱与昵称快照，即使后续人员变动或账号注销仍可完整溯源。
 */
export const adminAuditLogsTable = pgTable(
  "admin_audit_logs",
  {
    id: text("id").primaryKey(),
    actorUserId: text("actor_user_id").references(() => usersTable.id, { onDelete: "set null" }),
    actorEmail: text("actor_email").notNull(),
    actorDisplayName: text("actor_display_name").notNull(),
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id").notNull(),
    summary: text("summary").notNull(),
    metadataJson: jsonb("metadata_json").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("admin_audit_logs_created_at_idx").on(table.createdAt),
    index("admin_audit_logs_target_idx").on(table.targetType, table.targetId),
  ],
);

/**
 * 五维受控工作区表（`workspaces`，ADR-0010）。
 * 本机路径仅存储于 `roots_json` 内，在跨主人查询时由服务层按查看者身份动态剥离。
 */
export const workspacesTable = pgTable(
  "workspaces",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    kind: text("kind").notNull().default("git_repo"),
    rootsJson: jsonb("roots_json").$type<readonly WorkspaceRootEntry[]>().notNull(),
    hostMode: text("host_mode").notNull().default("local_machine"),
    hostLabel: text("host_label").notNull(),
    sandboxMode: text("sandbox_mode").notNull().default("worktree_pool"),
    allowRoomCollaborators: boolean("allow_room_collaborators").notNull().default(false),
    prewarmedWorktrees: integer("prewarmed_worktrees").notNull().default(3),
    hooksJson: jsonb("hooks_json").$type<WorkspaceLifecycleHooks>().notNull(),
    contextJson: jsonb("context_json").$type<WorkspaceContextAssets>().notNull(),
    defaultTopology: text("default_topology").notNull().default("verify_loop"),
    defaultWorkerAgentId: text("default_worker_agent_id").references(() => agentsTable.id, {
      onDelete: "set null",
    }),
    defaultVerifierAgentId: text("default_verifier_agent_id").references(() => agentsTable.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("workspaces_owner_updated_idx").on(table.ownerUserId, table.updatedAt)],
);

/**
 * 房间与成员默认工作区绑定表（`workspace_room_bindings`）。
 * 以 `(room_id, owner_user_id)` 为复合主键，支持联邦群聊中每位人类主人挂载各自工作区。
 */
export const workspaceRoomBindingsTable = pgTable(
  "workspace_room_bindings",
  {
    roomId: text("room_id")
      .notNull()
      .references(() => roomsTable.id, { onDelete: "cascade" }),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspacesTable.id, { onDelete: "cascade" }),
    boundAt: timestamp("bound_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.roomId, table.ownerUserId] }),
    index("workspace_room_bindings_workspace_idx").on(table.workspaceId),
  ],
);

/**
 * 多 Agent 协作工单聚合根表（`work_items`）。
 * `agent_snapshots_json` 保存参与工单的 Agent 快照，确保后续删除 Agent 仍可无损回放历史工单。
 */
export const workItemsTable = pgTable(
  "work_items",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspacesTable.id, { onDelete: "cascade" }),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    roomId: text("room_id").references(() => roomsTable.id, { onDelete: "set null" }),
    anchorMessageSeq: integer("anchor_message_seq").notNull().default(0),
    title: text("title").notNull(),
    brief: text("brief").notNull(),
    topology: text("topology").notNull().default("verify_loop"),
    tier: text("tier").notNull().default("sandbox_branch_write"),
    stage: text("stage").notNull().default("working"),
    worktreeBranch: text("worktree_branch").notNull(),
    coordinatorAgentId: text("coordinator_agent_id").references(() => agentsTable.id, {
      onDelete: "set null",
    }),
    primaryWorkerAgentId: text("primary_worker_agent_id")
      .notNull()
      .references(() => agentsTable.id, { onDelete: "cascade" }),
    verifierAgentId: text("verifier_agent_id").references(() => agentsTable.id, {
      onDelete: "set null",
    }),
    attentionJson: jsonb("attention_json").$type<Record<string, unknown>>(),
    reviewJson: jsonb("review_json").$type<Record<string, unknown>>(),
    traceJson: jsonb("trace_json").$type<readonly WorkTraceEntry[]>().notNull().default([]),
    diffFilesJson: jsonb("diff_files_json")
      .$type<readonly WorkDiffFileDto[]>()
      .notNull()
      .default([]),
    agentSnapshotsJson: jsonb("agent_snapshots_json")
      .$type<Readonly<Record<string, Record<string, unknown>>>>()
      .notNull(),
    opKey: text("op_key"),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("work_items_owner_op_key_unique_idx").on(table.ownerUserId, table.opKey),
    index("work_items_workspace_updated_idx").on(table.workspaceId, table.updatedAt),
    index("work_items_room_anchor_idx").on(table.roomId, table.anchorMessageSeq),
    index("work_items_owner_stage_idx").on(table.ownerUserId, table.stage),
  ],
);

/**
 * 工单并行执行分片与核验节点表（`work_slices`，ADR-0009 持久租约）。
 */
export const workSlicesTable = pgTable(
  "work_slices",
  {
    id: text("id").primaryKey(),
    workItemId: text("work_item_id")
      .notNull()
      .references(() => workItemsTable.id, { onDelete: "cascade" }),
    orderIndex: integer("order_index").notNull(),
    title: text("title").notNull(),
    leaseRole: text("lease_role").notNull().default("write"),
    assignedAgentId: text("assigned_agent_id").notNull(),
    leaseOwnerAgentId: text("lease_owner_agent_id"),
    leaseVersion: integer("lease_version").notNull().default(0),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    attemptCount: integer("attempt_count").notNull().default(0),
    ownedPathsJson: jsonb("owned_paths_json").$type<readonly string[]>().notNull(),
    status: text("status").notNull().default("waiting"),
    liveSummary: text("live_summary").notNull().default(""),
    diffAdded: integer("diff_added").notNull().default(0),
    diffRemoved: integer("diff_removed").notNull().default(0),
    changedFilesJson: jsonb("changed_files_json").$type<readonly string[]>().notNull(),
    worktreeBranch: text("worktree_branch"),
    steerNotesJson: jsonb("steer_notes_json").$type<readonly string[]>().notNull(),
    failureCode: text("failure_code"),
    provenanceJson: jsonb("provenance_json").$type<WorkSliceProvenance>(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("work_slices_item_order_idx").on(table.workItemId, table.orderIndex),
    index("work_slices_assigned_status_idx").on(
      table.assignedAgentId,
      table.status,
      table.leaseExpiresAt,
    ),
  ],
);
