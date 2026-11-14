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
} from "@openhuddle/protocol";
import {
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
 */
export const usersTable = pgTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    displayName: text("display_name").notNull(),
    avatarUrl: text("avatar_url"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("users_email_unique_idx").on(table.email)],
);

/**
 * 人类登录与自助绑定一次性邮箱验证码表（`auth_otp_codes`）。
 * 仅存储 6 位验证码的 SHA-256 哈希摘要与过期时间。
 */
export const authOtpCodesTable = pgTable("auth_otp_codes", {
  id: text("id").primaryKey(),
  email: text("email").notNull(),
  codeHash: text("code_hash").notNull(),
  requestedDisplayName: text("requested_display_name"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

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
  (table) => [uniqueIndex("user_sessions_token_hash_unique_idx").on(table.tokenHash)],
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
 * 多方群聊与决策房间表（`rooms`）。
 */
export const roomsTable = pgTable(
  "rooms",
  {
    id: text("id").primaryKey(),
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
  (table) => [uniqueIndex("rooms_invite_token_unique_idx").on(table.inviteToken)],
);

/**
 * 房间成员与已读游标表（`room_members`）。
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
    lastReadSeq: integer("last_read_seq").notNull().default(0),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.roomId, table.memberKey] })],
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
  ],
);

/**
 * 结构化提案与人类决策拍板表（`proposals`）。
 */
export const proposalsTable = pgTable("proposals", {
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
});

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
