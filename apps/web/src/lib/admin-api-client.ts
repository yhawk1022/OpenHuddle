/**
 * @module web/lib/admin-api-client
 * @description OpenHuddle 运营与治理管理后台同源 `/api/v1/admin/*` 强类型 HTTP 客户端。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 复用统一鉴权底座：全部请求经 `requestApiJson` 发送，自动携带 `oh_session` Cookie、备份 Bearer 令牌及超时保护。
 * 2. 参数安全序列化：通过 `buildQueryString` 跳过 `undefined` 与空字符串过滤项，防止将 `"undefined"` 拼入查询参数。
 */
import type {
  AdminAgentListQuery,
  AdminAgentListResponse,
  AdminAuditLogListQuery,
  AdminAuditLogListResponse,
  AdminDeleteAgentResponse,
  AdminDeleteProposalResponse,
  AdminDeleteRoomResponse,
  AdminDeleteUserResponse,
  AdminOverviewResponse,
  AdminPairingCodeListQuery,
  AdminPairingCodeListResponse,
  AdminProposalListQuery,
  AdminProposalListResponse,
  AdminPurgeExpiredSessionsResponse,
  AdminPurgePairingCodesResponse,
  AdminRecallMessageBody,
  AdminRecallMessageResponse,
  AdminRevokePairingCodeResponse,
  AdminRevokeSessionResponse,
  AdminRevokeUserSessionsResponse,
  AdminRoomDetailResponse,
  AdminRoomListQuery,
  AdminRoomListResponse,
  AdminRoomMessagesQuery,
  AdminRoomMessagesResponse,
  AdminSessionListQuery,
  AdminSessionListResponse,
  AdminUpdateRoomBody,
  AdminUpdateRoomResponse,
  AdminUpdateUserBody,
  AdminUpdateUserResponse,
  AdminUserDetailResponse,
  AdminUserListQuery,
  AdminUserListResponse,
  AgentId,
  MessageSeq,
  PairingCode,
  ProposalId,
  RoomId,
  SessionId,
  UserId,
} from "@openhuddle/protocol";
import { requestApiJson } from "./api-client.js";

function buildQueryString(
  params: Readonly<Record<string, string | number | boolean | undefined>>,
): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) {
      continue;
    }
    if (typeof value === "string" && value.trim().length === 0) {
      continue;
    }
    search.set(key, String(value));
  }
  const encoded = search.toString();
  return encoded.length > 0 ? `?${encoded}` : "";
}

/**
 * 获取管理后台统计大盘全量指标、趋势图与运行态遥测。
 */
export async function fetchAdminOverview(days: number): Promise<AdminOverviewResponse> {
  return requestApiJson<AdminOverviewResponse>(
    `/api/v1/admin/overview${buildQueryString({ days })}`,
  );
}

/**
 * 分页查询全平台用户账号列表。
 */
export async function fetchAdminUsers(
  query: Partial<AdminUserListQuery>,
): Promise<AdminUserListResponse> {
  return requestApiJson<AdminUserListResponse>(
    `/api/v1/admin/users${buildQueryString({
      page: query.page,
      pageSize: query.pageSize,
      search: query.search,
      role: query.role,
      status: query.status,
    })}`,
  );
}

/**
 * 查询指定用户详情（含关联 Agent、群聊与登录会话）。
 */
export async function fetchAdminUserDetail(userId: UserId): Promise<AdminUserDetailResponse> {
  return requestApiJson<AdminUserDetailResponse>(
    `/api/v1/admin/users/${encodeURIComponent(userId)}`,
  );
}

/**
 * 修改用户展示昵称、权限角色或封禁状态。
 */
export async function updateAdminUser(
  userId: UserId,
  body: Readonly<AdminUpdateUserBody>,
): Promise<AdminUpdateUserResponse> {
  return requestApiJson<AdminUpdateUserResponse>(
    `/api/v1/admin/users/${encodeURIComponent(userId)}`,
    {
      method: "PATCH",
      body,
    },
  );
}

/**
 * 彻底注销删除指定用户账号及名下关联资源。
 */
export async function deleteAdminUser(userId: UserId): Promise<AdminDeleteUserResponse> {
  return requestApiJson<AdminDeleteUserResponse>(
    `/api/v1/admin/users/${encodeURIComponent(userId)}`,
    {
      method: "DELETE",
    },
  );
}

/**
 * 强制踢下线指定用户的全部登录会话。
 */
export async function revokeAllUserSessions(
  userId: UserId,
): Promise<AdminRevokeUserSessionsResponse> {
  return requestApiJson<AdminRevokeUserSessionsResponse>(
    `/api/v1/admin/users/${encodeURIComponent(userId)}/sessions/revoke-all`,
    {
      method: "POST",
    },
  );
}

/**
 * 分页检索全平台登录会话列表。
 */
export async function fetchAdminSessions(
  query: Partial<AdminSessionListQuery>,
): Promise<AdminSessionListResponse> {
  return requestApiJson<AdminSessionListResponse>(
    `/api/v1/admin/sessions${buildQueryString({
      page: query.page,
      pageSize: query.pageSize,
      userId: query.userId,
      status: query.status,
      search: query.search,
    })}`,
  );
}

/**
 * 强制吊销单条指定登录会话。
 */
export async function revokeAdminSession(
  sessionId: SessionId,
): Promise<AdminRevokeSessionResponse> {
  return requestApiJson<AdminRevokeSessionResponse>(
    `/api/v1/admin/sessions/${encodeURIComponent(sessionId)}`,
    {
      method: "DELETE",
    },
  );
}

/**
 * 一键清理全部已过期登录会话。
 */
export async function purgeExpiredSessions(): Promise<AdminPurgeExpiredSessionsResponse> {
  return requestApiJson<AdminPurgeExpiredSessionsResponse>("/api/v1/admin/sessions/purge-expired", {
    method: "POST",
  });
}

/**
 * 分页查询全平台群聊房间列表。
 */
export async function fetchAdminRooms(
  query: Partial<AdminRoomListQuery>,
): Promise<AdminRoomListResponse> {
  return requestApiJson<AdminRoomListResponse>(
    `/api/v1/admin/rooms${buildQueryString({
      page: query.page,
      pageSize: query.pageSize,
      search: query.search,
      visibility: query.visibility,
      governanceStatus: query.governanceStatus,
    })}`,
  );
}

/**
 * 查询任意群聊房间监管详情（含实时成员与提案）。
 */
export async function fetchAdminRoomDetail(roomId: RoomId): Promise<AdminRoomDetailResponse> {
  return requestApiJson<AdminRoomDetailResponse>(
    `/api/v1/admin/rooms/${encodeURIComponent(roomId)}`,
  );
}

/**
 * 管理员只读审查房间历史消息流。
 */
export async function fetchAdminRoomMessages(
  roomId: RoomId,
  query: Partial<AdminRoomMessagesQuery>,
): Promise<AdminRoomMessagesResponse> {
  return requestApiJson<AdminRoomMessagesResponse>(
    `/api/v1/admin/rooms/${encodeURIComponent(roomId)}/messages${buildQueryString({
      limit: query.limit,
      beforeSeq: query.beforeSeq,
      search: query.search,
      authorKind: query.authorKind,
      type: query.type,
      includeRecalled: query.includeRecalled,
    })}`,
  );
}

/**
 * 管理员热更新群聊房间元数据、可见性及治理规则。
 */
export async function updateAdminRoom(
  roomId: RoomId,
  body: Readonly<AdminUpdateRoomBody>,
): Promise<AdminUpdateRoomResponse> {
  return requestApiJson<AdminUpdateRoomResponse>(
    `/api/v1/admin/rooms/${encodeURIComponent(roomId)}`,
    {
      method: "PATCH",
      body,
    },
  );
}

/**
 * 管理员强制撤回群聊中的指定消息。
 */
export async function recallAdminRoomMessage(
  roomId: RoomId,
  seq: MessageSeq,
  body: Readonly<AdminRecallMessageBody> = {},
): Promise<AdminRecallMessageResponse> {
  return requestApiJson<AdminRecallMessageResponse>(
    `/api/v1/admin/rooms/${encodeURIComponent(roomId)}/messages/${encodeURIComponent(String(seq))}/recall`,
    {
      method: "POST",
      body,
    },
  );
}

/**
 * 管理员强制解散群聊房间。
 */
export async function deleteAdminRoom(roomId: RoomId): Promise<AdminDeleteRoomResponse> {
  return requestApiJson<AdminDeleteRoomResponse>(
    `/api/v1/admin/rooms/${encodeURIComponent(roomId)}`,
    {
      method: "DELETE",
    },
  );
}

/**
 * 分页查询全平台已绑定 Agent。
 */
export async function fetchAdminAgents(
  query: Partial<AdminAgentListQuery>,
): Promise<AdminAgentListResponse> {
  return requestApiJson<AdminAgentListResponse>(
    `/api/v1/admin/agents${buildQueryString({
      page: query.page,
      pageSize: query.pageSize,
      search: query.search,
      platform: query.platform,
      reach: query.reach,
      ownerUserId: query.ownerUserId,
    })}`,
  );
}

/**
 * 管理员强制吊销并删除指定 Agent。
 */
export async function deleteAdminAgent(agentId: AgentId): Promise<AdminDeleteAgentResponse> {
  return requestApiJson<AdminDeleteAgentResponse>(
    `/api/v1/admin/agents/${encodeURIComponent(agentId)}`,
    {
      method: "DELETE",
    },
  );
}

/**
 * 分页查询全平台提案与拍板记录。
 */
export async function fetchAdminProposals(
  query: Partial<AdminProposalListQuery>,
): Promise<AdminProposalListResponse> {
  return requestApiJson<AdminProposalListResponse>(
    `/api/v1/admin/proposals${buildQueryString({
      page: query.page,
      pageSize: query.pageSize,
      status: query.status,
      roomId: query.roomId,
      search: query.search,
    })}`,
  );
}

/**
 * 管理员物理删除指定提案记录。
 */
export async function deleteAdminProposal(
  proposalId: ProposalId,
): Promise<AdminDeleteProposalResponse> {
  return requestApiJson<AdminDeleteProposalResponse>(
    `/api/v1/admin/proposals/${encodeURIComponent(proposalId)}`,
    {
      method: "DELETE",
    },
  );
}

/**
 * 分页查询全平台配对码列表。
 */
export async function fetchAdminPairingCodes(
  query: Partial<AdminPairingCodeListQuery>,
): Promise<AdminPairingCodeListResponse> {
  return requestApiJson<AdminPairingCodeListResponse>(
    `/api/v1/admin/pairing-codes${buildQueryString({
      page: query.page,
      pageSize: query.pageSize,
      status: query.status,
      search: query.search,
    })}`,
  );
}

/**
 * 管理员吊销删除单个配对码。
 */
export async function revokeAdminPairingCode(
  code: PairingCode,
): Promise<AdminRevokePairingCodeResponse> {
  return requestApiJson<AdminRevokePairingCodeResponse>(
    `/api/v1/admin/pairing-codes/${encodeURIComponent(code)}`,
    {
      method: "DELETE",
    },
  );
}

/**
 * 一键清理全部已核销或过期配对码。
 */
export async function purgeAdminPairingCodes(): Promise<AdminPurgePairingCodesResponse> {
  return requestApiJson<AdminPurgePairingCodesResponse>(
    "/api/v1/admin/pairing-codes/purge-expired",
    {
      method: "POST",
    },
  );
}

/**
 * 分页查询管理员操作审计日志。
 */
export async function fetchAdminAuditLogs(
  query: Partial<AdminAuditLogListQuery>,
): Promise<AdminAuditLogListResponse> {
  return requestApiJson<AdminAuditLogListResponse>(
    `/api/v1/admin/audit-logs${buildQueryString({
      page: query.page,
      pageSize: query.pageSize,
      targetType: query.targetType,
      action: query.action,
      search: query.search,
    })}`,
  );
}
