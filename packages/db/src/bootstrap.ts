/**
 * @module db/bootstrap
 * @description 幂等初始化核心 PostgreSQL 表结构 DDL（支持内存态 PGlite 集成测试与单机零配置冷启动）。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 幂等安全：全部采用 `CREATE TABLE IF NOT EXISTS` 与 `CREATE UNIQUE INDEX IF NOT EXISTS`，重复执行不会破坏已有数据。
 * 2. 单语句逐条执行：PostgreSQL Extended Query 协议（Prepared Statement）禁止在单次 `db.execute` 中拼接多条分号语句，因此必须按依赖拓扑顺序逐条提交。
 */
import { sql } from "drizzle-orm";
import type { OpenHuddleDb } from "./client.js";

const CORE_DDL_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    display_name TEXT NOT NULL,
    avatar_url TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique_idx ON users (email)",
  `CREATE TABLE IF NOT EXISTS auth_otp_codes (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    code_hash TEXT NOT NULL,
    requested_display_name TEXT,
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS user_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS user_sessions_token_hash_unique_idx ON user_sessions (token_hash)",
  `CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    display_name TEXT NOT NULL,
    slug TEXT NOT NULL,
    platform TEXT NOT NULL,
    intro TEXT,
    token_hash TEXT NOT NULL,
    wake_kind TEXT NOT NULL DEFAULT 'none',
    wake_config_json JSONB,
    checkin_interval_min INTEGER,
    last_seen_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS agents_token_hash_unique_idx ON agents (token_hash)",
  "CREATE UNIQUE INDEX IF NOT EXISTS agents_owner_slug_unique_idx ON agents (owner_user_id, slug)",
  `CREATE TABLE IF NOT EXISTS pairing_codes (
    code TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    auto_join_room_id TEXT,
    reclaim_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    name TEXT NOT NULL,
    topic TEXT NOT NULL DEFAULT '',
    rules TEXT NOT NULL DEFAULT '',
    visibility TEXT NOT NULL DEFAULT 'invite_only',
    invite_token TEXT NOT NULL,
    governance_json JSONB NOT NULL,
    last_seq INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS rooms_invite_token_unique_idx ON rooms (invite_token)",
  `CREATE TABLE IF NOT EXISTS room_members (
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    member_key TEXT NOT NULL,
    member_kind TEXT NOT NULL,
    user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
    agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'member',
    last_read_seq INTEGER NOT NULL DEFAULT 0,
    joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (room_id, member_key)
  )`,
  `CREATE TABLE IF NOT EXISTS messages (
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    author_kind TEXT NOT NULL,
    author_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    author_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
    owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    type TEXT NOT NULL DEFAULT 'text',
    content TEXT NOT NULL,
    payload_json JSONB,
    reply_to_seq INTEGER,
    mentions_json JSONB NOT NULL,
    op_key TEXT,
    recalled_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (room_id, seq)
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS messages_room_op_key_unique_idx ON messages (room_id, op_key)",
  `CREATE TABLE IF NOT EXISTS proposals (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    origin_message_seq INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    draft_json JSONB NOT NULL,
    decided_option_key TEXT,
    decision_note TEXT,
    decided_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    decided_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS proposal_votes (
    proposal_id TEXT NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
    voter_key TEXT NOT NULL,
    voter_kind TEXT NOT NULL,
    voter_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
    voter_agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE,
    owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    stance TEXT NOT NULL,
    preferred_option_key TEXT,
    rationale TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (proposal_id, voter_key)
  )`,
];

/**
 * 在目标 PostgreSQL / PGlite 实例中幂等创建 OpenHuddle 核心表结构与唯一索引。
 *
 * @param db - 已连接的 Drizzle PostgreSQL 数据库实例
 */
export async function ensureCoreSchema(db: OpenHuddleDb): Promise<void> {
  // 为什么逐条执行而非合并为一个多语句 SQL：
  // Drizzle 在 PGlite 与 pg 驱动上使用 PostgreSQL 扩展查询协议（Prepared Statement），单次仅允许提交一条命令。
  for (const ddl of CORE_DDL_STATEMENTS) {
    await db.execute(sql.raw(ddl));
  }
}
