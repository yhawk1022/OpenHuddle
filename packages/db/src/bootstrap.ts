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
    password_hash TEXT,
    email_verified_at TIMESTAMPTZ,
    password_updated_at TIMESTAMPTZ,
    role TEXT NOT NULL DEFAULT 'user',
    status TEXT NOT NULL DEFAULT 'active',
    theme_preference TEXT NOT NULL DEFAULT 'auto',
    suspended_at TIMESTAMPTZ,
    suspended_reason TEXT,
    last_login_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  "ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT",
  "ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ",
  "ALTER TABLE users ADD COLUMN IF NOT EXISTS password_updated_at TIMESTAMPTZ",
  "ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'user'",
  "ALTER TABLE users ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active'",
  "ALTER TABLE users ADD COLUMN IF NOT EXISTS theme_preference TEXT NOT NULL DEFAULT 'auto'",
  "ALTER TABLE users ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ",
  "ALTER TABLE users ADD COLUMN IF NOT EXISTS suspended_reason TEXT",
  "ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ",
  "CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique_idx ON users (email)",
  "CREATE INDEX IF NOT EXISTS users_created_at_idx ON users (created_at DESC)",
  `CREATE TABLE IF NOT EXISTS auth_otp_codes (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    purpose TEXT NOT NULL DEFAULT 'login',
    code_hash TEXT NOT NULL,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    requested_display_name TEXT,
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  "ALTER TABLE auth_otp_codes ADD COLUMN IF NOT EXISTS purpose TEXT NOT NULL DEFAULT 'login'",
  "ALTER TABLE auth_otp_codes ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0",
  "CREATE INDEX IF NOT EXISTS auth_otp_codes_email_purpose_created_idx ON auth_otp_codes (email, purpose, created_at DESC)",
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
    allow_external_dm BOOLEAN NOT NULL DEFAULT FALSE,
    token_hash TEXT NOT NULL,
    wake_kind TEXT NOT NULL DEFAULT 'none',
    wake_config_json JSONB,
    checkin_interval_min INTEGER,
    last_seen_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  "ALTER TABLE agents ADD COLUMN IF NOT EXISTS allow_external_dm BOOLEAN NOT NULL DEFAULT FALSE",
  "CREATE UNIQUE INDEX IF NOT EXISTS agents_token_hash_unique_idx ON agents (token_hash)",
  "CREATE UNIQUE INDEX IF NOT EXISTS agents_owner_slug_unique_idx ON agents (owner_user_id, slug)",
  `CREATE TABLE IF NOT EXISTS friendships (
    id TEXT PRIMARY KEY,
    pair_key TEXT NOT NULL,
    user_low_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user_high_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    requester_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    addressee_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending',
    note TEXT,
    user_low_remark TEXT,
    user_high_remark TEXT,
    responded_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  "ALTER TABLE friendships ADD COLUMN IF NOT EXISTS user_low_remark TEXT",
  "ALTER TABLE friendships ADD COLUMN IF NOT EXISTS user_high_remark TEXT",
  "CREATE UNIQUE INDEX IF NOT EXISTS friendships_pair_key_unique_idx ON friendships (pair_key)",
  "CREATE INDEX IF NOT EXISTS friendships_low_status_idx ON friendships (user_low_id, status)",
  "CREATE INDEX IF NOT EXISTS friendships_high_status_idx ON friendships (user_high_id, status)",
  "CREATE INDEX IF NOT EXISTS friendships_addressee_status_idx ON friendships (addressee_user_id, status)",
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
    kind TEXT NOT NULL DEFAULT 'group',
    direct_pair_key TEXT,
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
  "ALTER TABLE rooms ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'group'",
  "ALTER TABLE rooms ADD COLUMN IF NOT EXISTS direct_pair_key TEXT",
  "CREATE UNIQUE INDEX IF NOT EXISTS rooms_invite_token_unique_idx ON rooms (invite_token)",
  "CREATE UNIQUE INDEX IF NOT EXISTS rooms_direct_pair_key_unique_idx ON rooms (direct_pair_key)",
  `CREATE TABLE IF NOT EXISTS room_members (
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    member_key TEXT NOT NULL,
    member_kind TEXT NOT NULL,
    user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
    agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'member',
    remark TEXT,
    last_read_seq INTEGER NOT NULL DEFAULT 0,
    joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (room_id, member_key)
  )`,
  "ALTER TABLE room_members ADD COLUMN IF NOT EXISTS remark TEXT",
  "CREATE INDEX IF NOT EXISTS room_members_member_key_idx ON room_members (member_key)",
  "CREATE INDEX IF NOT EXISTS room_members_agent_id_idx ON room_members (agent_id)",
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
  `CREATE TABLE IF NOT EXISTS message_attachments (
    room_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    bytes BYTEA NOT NULL,
    PRIMARY KEY (room_id, seq),
    CONSTRAINT message_attachments_message_fk
      FOREIGN KEY (room_id, seq) REFERENCES messages(room_id, seq) ON DELETE CASCADE
  )`,
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
    mandate_json JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  "ALTER TABLE proposals ADD COLUMN IF NOT EXISTS mandate_json JSONB",
  "CREATE INDEX IF NOT EXISTS proposals_room_origin_seq_idx ON proposals (room_id, origin_message_seq)",
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
  `CREATE TABLE IF NOT EXISTS admin_audit_logs (
    id TEXT PRIMARY KEY,
    actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    actor_email TEXT NOT NULL,
    actor_display_name TEXT NOT NULL,
    action TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id TEXT NOT NULL,
    summary TEXT NOT NULL,
    metadata_json JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  "CREATE INDEX IF NOT EXISTS admin_audit_logs_created_at_idx ON admin_audit_logs (created_at DESC)",
  "CREATE INDEX IF NOT EXISTS admin_audit_logs_target_idx ON admin_audit_logs (target_type, target_id)",
  "CREATE INDEX IF NOT EXISTS messages_created_at_idx ON messages (created_at DESC)",
  "CREATE INDEX IF NOT EXISTS user_sessions_user_id_idx ON user_sessions (user_id)",
  "CREATE INDEX IF NOT EXISTS user_sessions_expires_at_idx ON user_sessions (expires_at)",
  "CREATE INDEX IF NOT EXISTS rooms_created_at_idx ON rooms (created_at DESC)",
  `CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'git_repo',
    roots_json JSONB NOT NULL,
    host_mode TEXT NOT NULL DEFAULT 'local_machine',
    host_label TEXT NOT NULL,
    sandbox_mode TEXT NOT NULL DEFAULT 'worktree_pool',
    allow_room_collaborators BOOLEAN NOT NULL DEFAULT FALSE,
    prewarmed_worktrees INTEGER NOT NULL DEFAULT 3,
    hooks_json JSONB NOT NULL,
    context_json JSONB NOT NULL,
    default_topology TEXT NOT NULL DEFAULT 'verify_loop',
    default_worker_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
    default_verifier_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  "CREATE INDEX IF NOT EXISTS workspaces_owner_updated_idx ON workspaces (owner_user_id, updated_at DESC)",
  `CREATE TABLE IF NOT EXISTS workspace_room_bindings (
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    bound_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (room_id, owner_user_id)
  )`,
  "CREATE INDEX IF NOT EXISTS workspace_room_bindings_workspace_idx ON workspace_room_bindings (workspace_id)",
  `CREATE TABLE IF NOT EXISTS work_items (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    room_id TEXT REFERENCES rooms(id) ON DELETE SET NULL,
    anchor_message_seq INTEGER NOT NULL DEFAULT 0,
    title TEXT NOT NULL,
    brief TEXT NOT NULL,
    topology TEXT NOT NULL DEFAULT 'verify_loop',
    tier TEXT NOT NULL DEFAULT 'sandbox_branch_write',
    stage TEXT NOT NULL DEFAULT 'working',
    worktree_branch TEXT NOT NULL,
    coordinator_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
    primary_worker_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    verifier_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
    attention_json JSONB,
    review_json JSONB,
    trace_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    diff_files_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    agent_snapshots_json JSONB NOT NULL,
    op_key TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  "ALTER TABLE work_items ADD COLUMN IF NOT EXISTS op_key TEXT",
  "ALTER TABLE work_items ADD COLUMN IF NOT EXISTS trace_json JSONB NOT NULL DEFAULT '[]'::jsonb",
  "ALTER TABLE work_items ADD COLUMN IF NOT EXISTS diff_files_json JSONB NOT NULL DEFAULT '[]'::jsonb",
  "CREATE UNIQUE INDEX IF NOT EXISTS work_items_owner_op_key_unique_idx ON work_items (owner_user_id, op_key)",
  "CREATE INDEX IF NOT EXISTS work_items_workspace_updated_idx ON work_items (workspace_id, updated_at DESC)",
  "CREATE INDEX IF NOT EXISTS work_items_room_anchor_idx ON work_items (room_id, anchor_message_seq ASC)",
  "CREATE INDEX IF NOT EXISTS work_items_owner_stage_idx ON work_items (owner_user_id, stage)",
  `CREATE TABLE IF NOT EXISTS work_slices (
    id TEXT PRIMARY KEY,
    work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
    order_index INTEGER NOT NULL,
    title TEXT NOT NULL,
    lease_role TEXT NOT NULL DEFAULT 'write',
    assigned_agent_id TEXT NOT NULL,
    lease_owner_agent_id TEXT,
    lease_version INTEGER NOT NULL DEFAULT 0,
    lease_expires_at TIMESTAMPTZ,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    owned_paths_json JSONB NOT NULL,
    status TEXT NOT NULL DEFAULT 'waiting',
    live_summary TEXT NOT NULL DEFAULT '',
    diff_added INTEGER NOT NULL DEFAULT 0,
    diff_removed INTEGER NOT NULL DEFAULT 0,
    changed_files_json JSONB NOT NULL,
    worktree_branch TEXT,
    steer_notes_json JSONB NOT NULL,
    failure_code TEXT,
    provenance_json JSONB,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  "CREATE INDEX IF NOT EXISTS work_slices_item_order_idx ON work_slices (work_item_id, order_index ASC)",
  "CREATE INDEX IF NOT EXISTS work_slices_assigned_status_idx ON work_slices (assigned_agent_id, status, lease_expires_at)",
  "CREATE INDEX IF NOT EXISTS work_slices_active_lease_expiry_idx ON work_slices (lease_expires_at ASC) WHERE status IN ('running', 'verifying')",
  `CREATE TABLE IF NOT EXISTS work_review_evidence (
    slice_id TEXT PRIMARY KEY REFERENCES work_slices(id) ON DELETE CASCADE,
    lease_version INTEGER NOT NULL CHECK (lease_version > 0),
    patch TEXT NOT NULL CHECK (octet_length(patch) BETWEEN 1 AND 409600)
  )`,
];

/**
 * 启动期关系元组描述符（`RelationBuildTupleDesc`）完整性探针：
 * `CREATE TABLE IF NOT EXISTS` 在表名已存在时会直接跳过，无法发现 `pg_attribute` 目录索引缺列（`XX000`）；
 * 在冷启动期主动触发核心表的列级解析，避免隐藏目录损坏留到用户登录时才抛出 HTTP 500。
 */
const CORE_RELATION_PROBES: readonly string[] = [
  "SELECT id, email, password_hash, role, status, theme_preference FROM users LIMIT 0",
  "SELECT id, user_id, token_hash, expires_at FROM user_sessions LIMIT 0",
  "SELECT id, owner_user_id, token_hash, allow_external_dm FROM agents LIMIT 0",
  "SELECT room_id, member_key, remark FROM room_members LIMIT 0",
  "SELECT id, workspace_id, op_key, trace_json, diff_files_json FROM work_items LIMIT 0",
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
  for (const probe of CORE_RELATION_PROBES) {
    await db.execute(sql.raw(probe));
  }
}
