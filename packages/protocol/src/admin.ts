/**
 * @module protocol/admin
 * @description OpenHuddle 运营与治理管理后台（Admin Console）全套强类型协议契约（数据统计大盘、账号与会话管理、房间与消息监管、Agent/提案/配对码管理及审计日志）。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 严禁泄露凭据摘要：所有会话与 Agent 管理 DTO 一律不得包含 `tokenHash` 或明文凭据。
 * 2. 查询参数安全强转：HTTP Query 字符串均以 `z.coerce.number()` 与显式布尔预处理器解析（严防 `z.coerce.boolean()` 将 `"false"` 误判为 `true`）。
 * 3. 单一事实来源：同时驱动后端 `@hono/zod-openapi` 路由校验（自动同步至 `/api/docs`）与前端 TanStack Query 视图层。
 */
import { z } from "zod";
import { OwnedAgentSummaryDtoSchema } from "./auth.js";
import {
  GovernanceModeSchema,
  RoomGovernanceStateSchema,
  RoomGovernanceStatusSchema,
} from "./governance.js";
import {
  ActorKindSchema,
  AgentPlatformSchema,
  AgentReachStateSchema,
  UserRoleSchema,
  UserStatusSchema,
} from "./identity.js";
import {
  AgentIdSchema,
  AuditLogIdSchema,
  MessageSeqSchema,
  PairingCodeSchema,
  ProposalIdSchema,
  ReadCursorSeqSchema,
  RoomIdSchema,
  SessionIdSchema,
  UserIdSchema,
} from "./ids.js";
import { MessageDtoSchema, MessageTypeSchema } from "./messages.js";
import { ProposalCardDtoSchema, ProposalDraftSchema, ProposalStatusSchema } from "./proposals.js";
import { RoomMemberDtoSchema, RoomMemberRoleSchema, RoomVisibilitySchema } from "./rooms.js";

/**
 * 显式安全解析 Query 中的布尔参数（兼容 `"true"`/`"false"`/`"1"`/`"0"` 与原生布尔值）。
 */
const QueryBooleanSchema = z.preprocess((val) => {
  if (typeof val === "boolean") {
    return val;
  }
  if (typeof val === "string") {
    const normalized = val.trim().toLowerCase();
    if (normalized === "true" || normalized === "1") {
      return true;
    }
    if (normalized === "false" || normalized === "0") {
      return false;
    }
  }
  return val;
}, z.boolean());

/**
 * 统一后台分页元数据 Schema。
 */
export const AdminPaginationSchema = z.object({
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1).max(100),
  total: z.number().int().min(0),
  totalPages: z.number().int().min(1),
});
export type AdminPagination = z.infer<typeof AdminPaginationSchema>;

/* ─────────────────────────────────────────────────────────────
 * 1. 管理员操作审计日志（Audit Logs）
 * ───────────────────────────────────────────────────────────── */

/**
 * 管理员敏感写操作审计动作枚举。
 */
export const AdminAuditActionSchema = z.enum([
  "user.role_updated",
  "user.suspended",
  "user.unsuspended",
  "user.profile_updated",
  "user.deleted",
  "session.revoked",
  "user.sessions_revoked_all",
  "session.purged_expired",
  "room.updated",
  "room.deleted",
  "message.recalled",
  "agent.deleted",
  "proposal.deleted",
  "pairing_code.revoked",
  "pairing_code.purged_expired",
]);
export type AdminAuditAction = z.infer<typeof AdminAuditActionSchema>;

/**
 * 审计目标资源实体分类枚举。
 */
export const AdminAuditTargetTypeSchema = z.enum([
  "user",
  "session",
  "room",
  "message",
  "agent",
  "proposal",
  "pairing_code",
  "system",
]);
export type AdminAuditTargetType = z.infer<typeof AdminAuditTargetTypeSchema>;

/**
 * 单条管理员审计日志 DTO Schema。
 */
export const AdminAuditLogItemSchema = z.object({
  id: AuditLogIdSchema,
  actorUserId: UserIdSchema.optional(),
  actorEmail: z.string(),
  actorDisplayName: z.string(),
  action: AdminAuditActionSchema,
  targetType: AdminAuditTargetTypeSchema,
  targetId: z.string(),
  summary: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  createdAtIso: z.string().datetime(),
});
export type AdminAuditLogItem = z.infer<typeof AdminAuditLogItemSchema>;

/**
 * 审计日志分页检索查询参数 Schema。
 */
export const AdminAuditLogListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  targetType: AdminAuditTargetTypeSchema.optional(),
  action: AdminAuditActionSchema.optional(),
  search: z.string().trim().max(120).optional(),
});
export type AdminAuditLogListQuery = z.infer<typeof AdminAuditLogListQuerySchema>;

/**
 * 审计日志分页响应体 Schema。
 */
export const AdminAuditLogListResponseSchema = z.object({
  ok: z.literal(true),
  logs: z.array(AdminAuditLogItemSchema),
  pagination: AdminPaginationSchema,
});
export type AdminAuditLogListResponse = z.infer<typeof AdminAuditLogListResponseSchema>;

/* ─────────────────────────────────────────────────────────────
 * 2. 数据统计大盘（Analytics Overview）
 * ───────────────────────────────────────────────────────────── */

/**
 * 统计大盘趋势窗口查询参数 Schema（支持 7~90 天，默认 14 天）。
 */
export const AdminOverviewQuerySchema = z.object({
  days: z.coerce.number().int().min(7).max(90).default(14),
});
export type AdminOverviewQuery = z.infer<typeof AdminOverviewQuerySchema>;

/**
 * 单日多维增长与消息活跃趋势点 Schema（按 UTC 自然日对齐并零值补全连续窗口）。
 */
export const AdminDailyTrendPointSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  newUsers: z.number().int().min(0),
  newRooms: z.number().int().min(0),
  totalMessages: z.number().int().min(0),
  humanMessages: z.number().int().min(0),
  agentMessages: z.number().int().min(0),
  newProposals: z.number().int().min(0),
});
export type AdminDailyTrendPoint = z.infer<typeof AdminDailyTrendPointSchema>;

/**
 * 通用键值分布统计条目 Schema（用于 Agent 平台、在线通道、治理模式占比）。
 */
export const AdminDistributionEntrySchema = z.object({
  key: z.string(),
  label: z.string(),
  count: z.number().int().min(0),
});
export type AdminDistributionEntry = z.infer<typeof AdminDistributionEntrySchema>;

/**
 * 服务端实时拓扑与内存态事件总线遥测指标 Schema。
 */
export const AdminRuntimeTelemetrySchema = z.object({
  databaseDriver: z.enum(["pglite", "postgres"]),
  realtimeBusDriver: z.enum(["memory", "postgres"]),
  activeAgentConnections: z.number().int().min(0),
  activeAgentCount: z.number().int().min(0),
  activeRoomSubscriptions: z.number().int().min(0),
  activeRoomCount: z.number().int().min(0),
  uptimeSec: z.number().int().min(0),
  serverTimeIso: z.string().datetime(),
});
export type AdminRuntimeTelemetry = z.infer<typeof AdminRuntimeTelemetrySchema>;

/**
 * 平台全局 KPI 核心统计数字 Schema。
 */
export const AdminOverviewKpisSchema = z.object({
  totalUsers: z.number().int().min(0),
  adminUsers: z.number().int().min(0),
  suspendedUsers: z.number().int().min(0),
  newUsers7d: z.number().int().min(0),
  activeSessions: z.number().int().min(0),
  expiredSessions: z.number().int().min(0),
  totalAgents: z.number().int().min(0),
  onlineSseAgents: z.number().int().min(0),
  totalRooms: z.number().int().min(0),
  publicShareableRooms: z.number().int().min(0),
  pausedBudgetRooms: z.number().int().min(0),
  totalMessages: z.number().int().min(0),
  messages24h: z.number().int().min(0),
  messages7d: z.number().int().min(0),
  recalledMessages: z.number().int().min(0),
  totalProposals: z.number().int().min(0),
  openProposals: z.number().int().min(0),
  approvedProposals: z.number().int().min(0),
  rejectedProposals: z.number().int().min(0),
  totalVotes: z.number().int().min(0),
  activePairingCodes: z.number().int().min(0),
});
export type AdminOverviewKpis = z.infer<typeof AdminOverviewKpisSchema>;

/**
 * 活跃度排行群聊条目 Schema。
 */
export const AdminTopRoomItemSchema = z.object({
  id: RoomIdSchema,
  name: z.string(),
  ownerDisplayName: z.string(),
  visibility: RoomVisibilitySchema,
  governanceStatus: RoomGovernanceStatusSchema,
  memberCount: z.number().int().min(0),
  messageCount: z.number().int().min(0),
  proposalCount: z.number().int().min(0),
  lastSeq: ReadCursorSeqSchema,
  lastMessageAtIso: z.string().datetime().optional(),
});
export type AdminTopRoomItem = z.infer<typeof AdminTopRoomItemSchema>;

/**
 * 活跃度排行人类账号条目 Schema。
 */
export const AdminTopUserItemSchema = z.object({
  id: UserIdSchema,
  email: z.string().email(),
  displayName: z.string(),
  role: UserRoleSchema,
  status: UserStatusSchema,
  agentCount: z.number().int().min(0),
  ownedRoomCount: z.number().int().min(0),
  messageCount: z.number().int().min(0),
  lastLoginAtIso: z.string().datetime().optional(),
});
export type AdminTopUserItem = z.infer<typeof AdminTopUserItemSchema>;

/**
 * 后台数据统计大盘完整聚合响应体 Schema。
 */
export const AdminOverviewResponseSchema = z.object({
  ok: z.literal(true),
  windowDays: z.number().int().min(7).max(90),
  runtime: AdminRuntimeTelemetrySchema,
  kpis: AdminOverviewKpisSchema,
  dailyTrends: z.array(AdminDailyTrendPointSchema),
  agentPlatformDistribution: z.array(AdminDistributionEntrySchema),
  agentReachDistribution: z.array(AdminDistributionEntrySchema),
  roomGovernanceDistribution: z.array(AdminDistributionEntrySchema),
  topActiveRooms: z.array(AdminTopRoomItemSchema),
  topActiveUsers: z.array(AdminTopUserItemSchema),
  recentAuditLogs: z.array(AdminAuditLogItemSchema),
});
export type AdminOverviewResponse = z.infer<typeof AdminOverviewResponseSchema>;

/* ─────────────────────────────────────────────────────────────
 * 3. 用户账号管理（Users）
 * ───────────────────────────────────────────────────────────── */

/**
 * 单个用户关联资源计数汇总 Schema。
 */
export const AdminUserStatsSchema = z.object({
  agentCount: z.number().int().min(0),
  ownedRoomCount: z.number().int().min(0),
  joinedRoomCount: z.number().int().min(0),
  activeSessionCount: z.number().int().min(0),
  messageCount: z.number().int().min(0),
});
export type AdminUserStats = z.infer<typeof AdminUserStatsSchema>;

/**
 * 后台用户列表与详情条目 DTO Schema。
 */
export const AdminUserItemSchema = z.object({
  id: UserIdSchema,
  email: z.string().email(),
  displayName: z.string().min(1).max(80),
  role: UserRoleSchema,
  status: UserStatusSchema,
  /** 是否受服务端 `ADMIN_EMAILS` 环境变量白名单锁定（无法在 UI 中降权/封禁/删除） */
  isEnvPinnedAdmin: z.boolean(),
  suspendedAtIso: z.string().datetime().optional(),
  suspendedReason: z.string().optional(),
  lastLoginAtIso: z.string().datetime().optional(),
  createdAtIso: z.string().datetime(),
  stats: AdminUserStatsSchema,
});
export type AdminUserItem = z.infer<typeof AdminUserItemSchema>;

/**
 * 用户列表检索与筛选参数 Schema。
 */
export const AdminUserListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(120).optional(),
  role: UserRoleSchema.optional(),
  status: UserStatusSchema.optional(),
});
export type AdminUserListQuery = z.infer<typeof AdminUserListQuerySchema>;

/**
 * 用户列表分页响应体 Schema。
 */
export const AdminUserListResponseSchema = z.object({
  ok: z.literal(true),
  users: z.array(AdminUserItemSchema),
  pagination: AdminPaginationSchema,
});
export type AdminUserListResponse = z.infer<typeof AdminUserListResponseSchema>;

/**
 * 用户详情中展示的房间简报 Schema。
 */
export const AdminUserRoomBriefSchema = z.object({
  id: RoomIdSchema,
  name: z.string(),
  memberRole: RoomMemberRoleSchema,
  isRoomOwner: z.boolean(),
  visibility: RoomVisibilitySchema,
  lastSeq: ReadCursorSeqSchema,
  joinedAtIso: z.string().datetime(),
});
export type AdminUserRoomBrief = z.infer<typeof AdminUserRoomBriefSchema>;

/* ─────────────────────────────────────────────────────────────
 * 4. 登录会话管理（Sessions，供 UserDetail 复用因此置前定义）
 * ───────────────────────────────────────────────────────────── */

/**
 * 单条人类 Web 登录会话 DTO Schema（物理剥离 `tokenHash`）。
 */
export const AdminSessionItemSchema = z.object({
  id: SessionIdSchema,
  userId: UserIdSchema,
  userEmail: z.string().email(),
  userDisplayName: z.string(),
  userRole: UserRoleSchema,
  userStatus: UserStatusSchema,
  isExpired: z.boolean(),
  expiresAtIso: z.string().datetime(),
  createdAtIso: z.string().datetime(),
});
export type AdminSessionItem = z.infer<typeof AdminSessionItemSchema>;

/**
 * 后台单个用户全量档案详情响应体 Schema。
 */
export const AdminUserDetailResponseSchema = z.object({
  ok: z.literal(true),
  user: AdminUserItemSchema,
  agents: z.array(OwnedAgentSummaryDtoSchema),
  rooms: z.array(AdminUserRoomBriefSchema),
  sessions: z.array(AdminSessionItemSchema),
});
export type AdminUserDetailResponse = z.infer<typeof AdminUserDetailResponseSchema>;

/**
 * 管理员编辑用户资料、权限角色或封禁状态请求体 Schema。
 */
export const AdminUpdateUserBodySchema = z.object({
  displayName: z.string().trim().min(1).max(80).optional(),
  role: UserRoleSchema.optional(),
  status: UserStatusSchema.optional(),
  suspendedReason: z.string().trim().max(300).optional(),
});
export type AdminUpdateUserBody = z.infer<typeof AdminUpdateUserBodySchema>;

/**
 * 更新用户成功响应体 Schema。
 */
export const AdminUpdateUserResponseSchema = z.object({
  ok: z.literal(true),
  user: AdminUserItemSchema,
  revokedSessionCount: z.number().int().min(0),
});
export type AdminUpdateUserResponse = z.infer<typeof AdminUpdateUserResponseSchema>;

/**
 * 彻底删除用户及级联清理统计响应体 Schema。
 */
export const AdminDeleteUserResponseSchema = z.object({
  ok: z.literal(true),
  deletedUserId: UserIdSchema,
  deletedRoomCount: z.number().int().min(0),
  deletedAgentCount: z.number().int().min(0),
  deletedSessionCount: z.number().int().min(0),
});
export type AdminDeleteUserResponse = z.infer<typeof AdminDeleteUserResponseSchema>;

/**
 * 会话列表过滤状态枚举。
 */
export const AdminSessionFilterStatusSchema = z.enum(["all", "active", "expired"]);
export type AdminSessionFilterStatus = z.infer<typeof AdminSessionFilterStatusSchema>;

/**
 * 会话列表检索查询参数 Schema。
 */
export const AdminSessionListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  userId: UserIdSchema.optional(),
  status: AdminSessionFilterStatusSchema.default("active"),
  search: z.string().trim().max(120).optional(),
});
export type AdminSessionListQuery = z.infer<typeof AdminSessionListQuerySchema>;

/**
 * 会话列表分页响应体 Schema。
 */
export const AdminSessionListResponseSchema = z.object({
  ok: z.literal(true),
  sessions: z.array(AdminSessionItemSchema),
  pagination: AdminPaginationSchema,
});
export type AdminSessionListResponse = z.infer<typeof AdminSessionListResponseSchema>;

/**
 * 强制吊销单条登录会话响应体 Schema。
 */
export const AdminRevokeSessionResponseSchema = z.object({
  ok: z.literal(true),
  revokedSessionId: SessionIdSchema,
});
export type AdminRevokeSessionResponse = z.infer<typeof AdminRevokeSessionResponseSchema>;

/**
 * 强制踢下线指定用户全部会话响应体 Schema。
 */
export const AdminRevokeUserSessionsResponseSchema = z.object({
  ok: z.literal(true),
  userId: UserIdSchema,
  revokedCount: z.number().int().min(0),
});
export type AdminRevokeUserSessionsResponse = z.infer<typeof AdminRevokeUserSessionsResponseSchema>;

/**
 * 清理全部已过期会话响应体 Schema。
 */
export const AdminPurgeExpiredSessionsResponseSchema = z.object({
  ok: z.literal(true),
  purgedCount: z.number().int().min(0),
});
export type AdminPurgeExpiredSessionsResponse = z.infer<
  typeof AdminPurgeExpiredSessionsResponseSchema
>;

/* ─────────────────────────────────────────────────────────────
 * 5. 群聊会话与消息内容监管（Rooms & Messages）
 * ───────────────────────────────────────────────────────────── */

/**
 * 后台群聊房间聚合条目 DTO Schema。
 */
export const AdminRoomItemSchema = z.object({
  id: RoomIdSchema,
  name: z.string(),
  topic: z.string(),
  rules: z.string(),
  ownerUserId: UserIdSchema,
  ownerEmail: z.string().email(),
  ownerDisplayName: z.string(),
  visibility: RoomVisibilitySchema,
  governance: RoomGovernanceStateSchema,
  lastSeq: ReadCursorSeqSchema,
  memberCount: z.number().int().min(0),
  humanMemberCount: z.number().int().min(0),
  agentMemberCount: z.number().int().min(0),
  messageCount: z.number().int().min(0),
  openProposalCount: z.number().int().min(0),
  lastMessageAtIso: z.string().datetime().optional(),
  createdAtIso: z.string().datetime(),
});
export type AdminRoomItem = z.infer<typeof AdminRoomItemSchema>;

/**
 * 后台房间列表查询参数 Schema。
 */
export const AdminRoomListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(120).optional(),
  visibility: RoomVisibilitySchema.optional(),
  governanceStatus: RoomGovernanceStatusSchema.optional(),
});
export type AdminRoomListQuery = z.infer<typeof AdminRoomListQuerySchema>;

/**
 * 后台房间列表分页响应体 Schema。
 */
export const AdminRoomListResponseSchema = z.object({
  ok: z.literal(true),
  rooms: z.array(AdminRoomItemSchema),
  pagination: AdminPaginationSchema,
});
export type AdminRoomListResponse = z.infer<typeof AdminRoomListResponseSchema>;

/**
 * 后台单个房间全量监管详情响应体 Schema。
 */
export const AdminRoomDetailResponseSchema = z.object({
  ok: z.literal(true),
  room: AdminRoomItemSchema,
  inviteToken: z.string(),
  members: z.array(RoomMemberDtoSchema),
  proposals: z.array(ProposalCardDtoSchema),
});
export type AdminRoomDetailResponse = z.infer<typeof AdminRoomDetailResponseSchema>;

/**
 * 后台跨房内容审查消息查询参数 Schema（不推进任何成员已读游标）。
 */
export const AdminRoomMessagesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  beforeSeq: z.coerce.number().int().min(1).optional(),
  search: z.string().trim().max(120).optional(),
  authorKind: ActorKindSchema.optional(),
  type: MessageTypeSchema.optional(),
  includeRecalled: QueryBooleanSchema.default(true),
});
export type AdminRoomMessagesQuery = z.infer<typeof AdminRoomMessagesQuerySchema>;

/**
 * 后台房间消息审查响应体 Schema。
 */
export const AdminRoomMessagesResponseSchema = z.object({
  ok: z.literal(true),
  roomId: RoomIdSchema,
  latestSeq: ReadCursorSeqSchema,
  hasMore: z.boolean(),
  messages: z.array(MessageDtoSchema),
});
export type AdminRoomMessagesResponse = z.infer<typeof AdminRoomMessagesResponseSchema>;

/**
 * 管理员编辑房间元数据或治理策略请求体 Schema。
 */
export const AdminUpdateRoomBodySchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  topic: z.string().trim().max(500).optional(),
  rules: z.string().trim().max(2_000).optional(),
  visibility: RoomVisibilitySchema.optional(),
  mode: GovernanceModeSchema.optional(),
  allowAgentMentions: z.boolean().optional(),
  maxConsecutiveAgentTurns: z.number().int().min(1).max(50).optional(),
  requireReadBeforeSend: z.boolean().optional(),
  agentCooldownMs: z.number().int().min(0).max(60_000).optional(),
  renewBudget: z.boolean().optional(),
});
export type AdminUpdateRoomBody = z.infer<typeof AdminUpdateRoomBodySchema>;

/**
 * 管理员更新房间信息/治理成功响应体 Schema。
 */
export const AdminUpdateRoomResponseSchema = z.object({
  ok: z.literal(true),
  room: AdminRoomItemSchema,
});
export type AdminUpdateRoomResponse = z.infer<typeof AdminUpdateRoomResponseSchema>;

/**
 * 管理员强制撤回违规消息请求体 Schema。
 */
export const AdminRecallMessageBodySchema = z.object({
  reason: z.string().trim().max(300).optional(),
});
export type AdminRecallMessageBody = z.infer<typeof AdminRecallMessageBodySchema>;

/**
 * 管理员强制撤回消息成功响应体 Schema。
 */
export const AdminRecallMessageResponseSchema = z.object({
  ok: z.literal(true),
  message: MessageDtoSchema,
});
export type AdminRecallMessageResponse = z.infer<typeof AdminRecallMessageResponseSchema>;

/**
 * 管理员强制解散群聊房间响应体 Schema。
 */
export const AdminDeleteRoomResponseSchema = z.object({
  ok: z.literal(true),
  deletedRoomId: RoomIdSchema,
});
export type AdminDeleteRoomResponse = z.infer<typeof AdminDeleteRoomResponseSchema>;

/* ─────────────────────────────────────────────────────────────
 * 6. 全局 Agent、提案与配对码监管
 * ───────────────────────────────────────────────────────────── */

/**
 * 全局 Agent 监管条目 DTO Schema（不含密钥哈希）。
 */
export const AdminAgentItemSchema = z.object({
  id: AgentIdSchema,
  ownerUserId: UserIdSchema,
  ownerEmail: z.string().email(),
  ownerDisplayName: z.string(),
  displayName: z.string(),
  slug: z.string(),
  platform: AgentPlatformSchema,
  intro: z.string().optional(),
  wakeKind: z.string(),
  reach: AgentReachStateSchema,
  checkinIntervalMin: z.number().int().optional(),
  roomCount: z.number().int().min(0),
  messageCount: z.number().int().min(0),
  lastSeenAtIso: z.string().datetime().optional(),
  createdAtIso: z.string().datetime(),
});
export type AdminAgentItem = z.infer<typeof AdminAgentItemSchema>;

/**
 * 全局 Agent 列表查询参数 Schema。
 */
export const AdminAgentListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(120).optional(),
  platform: AgentPlatformSchema.optional(),
  reach: AgentReachStateSchema.optional(),
  ownerUserId: UserIdSchema.optional(),
});
export type AdminAgentListQuery = z.infer<typeof AdminAgentListQuerySchema>;

/**
 * 全局 Agent 列表分页响应体 Schema。
 */
export const AdminAgentListResponseSchema = z.object({
  ok: z.literal(true),
  agents: z.array(AdminAgentItemSchema),
  pagination: AdminPaginationSchema,
});
export type AdminAgentListResponse = z.infer<typeof AdminAgentListResponseSchema>;

/**
 * 管理员强制吊销删除 Agent 响应体 Schema。
 */
export const AdminDeleteAgentResponseSchema = z.object({
  ok: z.literal(true),
  deletedAgentId: AgentIdSchema,
});
export type AdminDeleteAgentResponse = z.infer<typeof AdminDeleteAgentResponseSchema>;

/**
 * 全局提案与拍板监管条目 DTO Schema。
 */
export const AdminProposalItemSchema = z.object({
  id: ProposalIdSchema,
  roomId: RoomIdSchema,
  roomName: z.string(),
  originMessageSeq: MessageSeqSchema,
  status: ProposalStatusSchema,
  draft: ProposalDraftSchema,
  voteCount: z.number().int().min(0),
  decidedOptionKey: z.string().optional(),
  decisionNote: z.string().optional(),
  decidedByDisplayName: z.string().optional(),
  decidedAtIso: z.string().datetime().optional(),
  createdAtIso: z.string().datetime(),
});
export type AdminProposalItem = z.infer<typeof AdminProposalItemSchema>;

/**
 * 全局提案列表查询参数 Schema。
 */
export const AdminProposalListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  status: ProposalStatusSchema.optional(),
  roomId: RoomIdSchema.optional(),
  search: z.string().trim().max(120).optional(),
});
export type AdminProposalListQuery = z.infer<typeof AdminProposalListQuerySchema>;

/**
 * 全局提案列表分页响应体 Schema。
 */
export const AdminProposalListResponseSchema = z.object({
  ok: z.literal(true),
  proposals: z.array(AdminProposalItemSchema),
  pagination: AdminPaginationSchema,
});
export type AdminProposalListResponse = z.infer<typeof AdminProposalListResponseSchema>;

/**
 * 管理员删除提案响应体 Schema。
 */
export const AdminDeleteProposalResponseSchema = z.object({
  ok: z.literal(true),
  deletedProposalId: ProposalIdSchema,
});
export type AdminDeleteProposalResponse = z.infer<typeof AdminDeleteProposalResponseSchema>;

/**
 * 配对码实时生命周期状态枚举。
 */
export const AdminPairingCodeStatusSchema = z.enum(["active", "used", "expired"]);
export type AdminPairingCodeStatus = z.infer<typeof AdminPairingCodeStatusSchema>;

/**
 * 全局配对码监管条目 DTO Schema。
 */
export const AdminPairingCodeItemSchema = z.object({
  code: PairingCodeSchema,
  ownerUserId: UserIdSchema,
  ownerEmail: z.string().email(),
  ownerDisplayName: z.string(),
  autoJoinRoomId: RoomIdSchema.optional(),
  autoJoinRoomName: z.string().optional(),
  reclaimAgentId: AgentIdSchema.optional(),
  status: AdminPairingCodeStatusSchema,
  expiresAtIso: z.string().datetime(),
  usedAtIso: z.string().datetime().optional(),
  createdAtIso: z.string().datetime(),
});
export type AdminPairingCodeItem = z.infer<typeof AdminPairingCodeItemSchema>;

/**
 * 全局配对码列表查询参数 Schema。
 */
export const AdminPairingCodeListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  status: AdminPairingCodeStatusSchema.optional(),
  search: z.string().trim().max(120).optional(),
});
export type AdminPairingCodeListQuery = z.infer<typeof AdminPairingCodeListQuerySchema>;

/**
 * 全局配对码列表分页响应体 Schema。
 */
export const AdminPairingCodeListResponseSchema = z.object({
  ok: z.literal(true),
  pairingCodes: z.array(AdminPairingCodeItemSchema),
  pagination: AdminPaginationSchema,
});
export type AdminPairingCodeListResponse = z.infer<typeof AdminPairingCodeListResponseSchema>;

/**
 * 管理员吊销/删除单个配对码响应体 Schema。
 */
export const AdminRevokePairingCodeResponseSchema = z.object({
  ok: z.literal(true),
  revokedCode: PairingCodeSchema,
});
export type AdminRevokePairingCodeResponse = z.infer<typeof AdminRevokePairingCodeResponseSchema>;

/**
 * 管理员批量清理过期与已核销配对码响应体 Schema。
 */
export const AdminPurgePairingCodesResponseSchema = z.object({
  ok: z.literal(true),
  purgedCount: z.number().int().min(0),
});
export type AdminPurgePairingCodesResponse = z.infer<typeof AdminPurgePairingCodesResponseSchema>;
