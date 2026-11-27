/**
 * @module web/features/admin-console/api
 * @description 运营与治理管理后台的 TanStack Query v5 查询工厂与变更操作（Mutations）契约层。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 统一缓存键管理：所有 `queryOptions` 与 `invalidateQueries` 一律引用 `adminQueryKeys`，保证列表、详情抽屉与统计大盘变更后秒级联动刷新。
 * 2. 统一反馈兜底：所有敏感写操作成功或失败均通过 `sonner` `toast` 给出明确双语反馈。
 */
import type {
  AdminAgentListQuery,
  AdminAuditLogListQuery,
  AdminPairingCodeListQuery,
  AdminProposalListQuery,
  AdminRecallMessageBody,
  AdminRoomListQuery,
  AdminRoomMessagesQuery,
  AdminSessionListQuery,
  AdminUpdateRoomBody,
  AdminUpdateUserBody,
  AdminUserListQuery,
  AgentId,
  MessageSeq,
  PairingCode,
  ProposalId,
  RoomId,
  SessionId,
  UserId,
} from "@openhuddle/protocol";
import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "../../../components/primitives/index.js";
import {
  deleteAdminAgent,
  deleteAdminProposal,
  deleteAdminRoom,
  deleteAdminUser,
  fetchAdminAgents,
  fetchAdminAuditLogs,
  fetchAdminOverview,
  fetchAdminPairingCodes,
  fetchAdminProposals,
  fetchAdminRoomDetail,
  fetchAdminRoomMessages,
  fetchAdminRooms,
  fetchAdminSessions,
  fetchAdminUserDetail,
  fetchAdminUsers,
  purgeAdminPairingCodes,
  purgeExpiredSessions,
  recallAdminRoomMessage,
  revokeAdminPairingCode,
  revokeAdminSession,
  revokeAllUserSessions,
  updateAdminRoom,
  updateAdminUser,
} from "../../../lib/admin-api-client.js";
import { formatNumber } from "../../../lib/i18n/index.js";
import { adminQueryKeys, huddleQueryKeys } from "../../../lib/query-keys.js";
import { getAdminI18n, resolveAdminErrorMessage } from "../i18n/index.js";

/**
 * 统计大盘 `queryOptions`（按时间窗口天数缓存，30s 刷新基线）。
 */
export function adminOverviewQueryOptions(days: number) {
  return queryOptions({
    queryKey: adminQueryKeys.overview(days),
    queryFn: () => fetchAdminOverview(days),
    staleTime: 20_000,
  });
}

/**
 * 用户账号列表分页 `queryOptions`。
 */
export function adminUsersQueryOptions(query: Partial<AdminUserListQuery>) {
  return queryOptions({
    queryKey: adminQueryKeys.users(query),
    queryFn: () => fetchAdminUsers(query),
    staleTime: 10_000,
  });
}

/**
 * 单个用户全量档案详情 `queryOptions`。
 */
export function adminUserDetailQueryOptions(userId: UserId) {
  return queryOptions({
    queryKey: adminQueryKeys.userDetail(userId),
    queryFn: () => fetchAdminUserDetail(userId),
    staleTime: 10_000,
  });
}

/**
 * 登录会话列表分页 `queryOptions`。
 */
export function adminSessionsQueryOptions(query: Partial<AdminSessionListQuery>) {
  return queryOptions({
    queryKey: adminQueryKeys.sessions(query),
    queryFn: () => fetchAdminSessions(query),
    staleTime: 10_000,
  });
}

/**
 * 群聊房间列表分页 `queryOptions`。
 */
export function adminRoomsQueryOptions(query: Partial<AdminRoomListQuery>) {
  return queryOptions({
    queryKey: adminQueryKeys.rooms(query),
    queryFn: () => fetchAdminRooms(query),
    staleTime: 10_000,
  });
}

/**
 * 单个群聊房间监管详情 `queryOptions`。
 */
export function adminRoomDetailQueryOptions(roomId: RoomId) {
  return queryOptions({
    queryKey: adminQueryKeys.roomDetail(roomId),
    queryFn: () => fetchAdminRoomDetail(roomId),
    staleTime: 10_000,
  });
}

/**
 * 单个群聊房间只读消息审查 `queryOptions`。
 */
export function adminRoomMessagesQueryOptions(
  roomId: RoomId,
  query: Partial<AdminRoomMessagesQuery>,
) {
  return queryOptions({
    queryKey: adminQueryKeys.roomMessages(roomId, query),
    queryFn: () => fetchAdminRoomMessages(roomId, query),
    staleTime: 5_000,
  });
}

/**
 * 全局 Agent 列表分页 `queryOptions`。
 */
export function adminAgentsQueryOptions(query: Partial<AdminAgentListQuery>) {
  return queryOptions({
    queryKey: adminQueryKeys.agents(query),
    queryFn: () => fetchAdminAgents(query),
    staleTime: 10_000,
  });
}

/**
 * 全局提案列表分页 `queryOptions`。
 */
export function adminProposalsQueryOptions(query: Partial<AdminProposalListQuery>) {
  return queryOptions({
    queryKey: adminQueryKeys.proposals(query),
    queryFn: () => fetchAdminProposals(query),
    staleTime: 10_000,
  });
}

/**
 * 全局配对码列表分页 `queryOptions`。
 */
export function adminPairingCodesQueryOptions(query: Partial<AdminPairingCodeListQuery>) {
  return queryOptions({
    queryKey: adminQueryKeys.pairingCodes(query),
    queryFn: () => fetchAdminPairingCodes(query),
    staleTime: 10_000,
  });
}

/**
 * 管理员审计日志分页 `queryOptions`。
 */
export function adminAuditLogsQueryOptions(query: Partial<AdminAuditLogListQuery>) {
  return queryOptions({
    queryKey: adminQueryKeys.auditLogs(query),
    queryFn: () => fetchAdminAuditLogs(query),
    staleTime: 10_000,
  });
}

/**
 * 更新用户资料、权限角色或封禁状态 Mutation Hook。
 */
export function useAdminUpdateUserMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: {
      readonly userId: UserId;
      readonly body: Readonly<AdminUpdateUserBody>;
    }) => updateAdminUser(params.userId, params.body),
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: adminQueryKeys.all() });
      void queryClient.invalidateQueries({ queryKey: huddleQueryKeys.me() });
      const { t, tp } = getAdminI18n();
      const msg =
        res.revokedSessionCount > 0
          ? tp("mutation.user.updatedAndRevoked", res.revokedSessionCount, {
              name: res.user.displayName,
            })
          : t("mutation.user.updated", { name: res.user.displayName });
      toast.success(msg);
    },
    onError: (err) => {
      const { locale, t } = getAdminI18n();
      toast.error(resolveAdminErrorMessage(err, t("mutation.user.updateFailed"), locale));
    },
  });
}

/**
 * 彻底删除用户账号 Mutation Hook。
 */
export function useAdminDeleteUserMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (userId: UserId) => deleteAdminUser(userId),
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: adminQueryKeys.all() });
      void queryClient.invalidateQueries({ queryKey: huddleQueryKeys.rooms() });
      const { locale, t } = getAdminI18n();
      toast.success(t("mutation.user.deleted"), {
        description: t("mutation.user.deletedDetail", {
          rooms: formatNumber(res.deletedRoomCount, undefined, locale),
          agents: formatNumber(res.deletedAgentCount, undefined, locale),
          sessions: formatNumber(res.deletedSessionCount, undefined, locale),
        }),
      });
    },
    onError: (err) => {
      const { locale, t } = getAdminI18n();
      toast.error(resolveAdminErrorMessage(err, t("mutation.user.deleteFailed"), locale));
    },
  });
}

/**
 * 强制踢下线指定用户全部会话 Mutation Hook。
 */
export function useAdminRevokeUserSessionsMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (userId: UserId) => revokeAllUserSessions(userId),
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: adminQueryKeys.all() });
      const { tp } = getAdminI18n();
      toast.success(tp("mutation.user.revokedSessions", res.revokedCount));
    },
    onError: (err) => {
      const { locale, t } = getAdminI18n();
      toast.error(resolveAdminErrorMessage(err, t("mutation.user.revokeSessionsFailed"), locale));
    },
  });
}

/**
 * 吊销单条登录会话 Mutation Hook。
 */
export function useAdminRevokeSessionMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (sessionId: SessionId) => revokeAdminSession(sessionId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: adminQueryKeys.all() });
      const { t } = getAdminI18n();
      toast.success(t("mutation.session.revoked"));
    },
    onError: (err) => {
      const { locale, t } = getAdminI18n();
      toast.error(resolveAdminErrorMessage(err, t("mutation.session.revokeFailed"), locale));
    },
  });
}

/**
 * 一键清理已过期登录会话 Mutation Hook。
 */
export function useAdminPurgeExpiredSessionsMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => purgeExpiredSessions(),
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: adminQueryKeys.all() });
      const { tp } = getAdminI18n();
      toast.success(tp("mutation.session.purgedExpired", res.purgedCount));
    },
    onError: (err) => {
      const { locale, t } = getAdminI18n();
      toast.error(resolveAdminErrorMessage(err, t("mutation.session.purgeFailed"), locale));
    },
  });
}

/**
 * 管理员热更新房间配置与治理策略 Mutation Hook。
 */
export function useAdminUpdateRoomMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: {
      readonly roomId: RoomId;
      readonly body: Readonly<AdminUpdateRoomBody>;
    }) => updateAdminRoom(params.roomId, params.body),
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: adminQueryKeys.all() });
      void queryClient.invalidateQueries({ queryKey: huddleQueryKeys.rooms() });
      void queryClient.invalidateQueries({ queryKey: huddleQueryKeys.roomDetail(res.room.id) });
      const { t } = getAdminI18n();
      toast.success(t("mutation.room.updated", { name: res.room.name }));
    },
    onError: (err) => {
      const { locale, t } = getAdminI18n();
      toast.error(resolveAdminErrorMessage(err, t("mutation.room.updateFailed"), locale));
    },
  });
}

/**
 * 管理员强制撤回群内指定消息 Mutation Hook。
 */
export function useAdminRecallMessageMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: {
      readonly roomId: RoomId;
      readonly seq: MessageSeq;
      readonly body?: Readonly<AdminRecallMessageBody>;
    }) => recallAdminRoomMessage(params.roomId, params.seq, params.body),
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: adminQueryKeys.all() });
      void queryClient.invalidateQueries({
        queryKey: huddleQueryKeys.roomMessages(res.message.roomId),
      });
      const { t } = getAdminI18n();
      toast.success(t("mutation.message.recalled", { seq: res.message.seq }));
    },
    onError: (err) => {
      const { locale, t } = getAdminI18n();
      toast.error(resolveAdminErrorMessage(err, t("mutation.message.recallFailed"), locale));
    },
  });
}

/**
 * 管理员强制解散群聊房间 Mutation Hook。
 */
export function useAdminDeleteRoomMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (roomId: RoomId) => deleteAdminRoom(roomId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: adminQueryKeys.all() });
      void queryClient.invalidateQueries({ queryKey: huddleQueryKeys.rooms() });
      const { t } = getAdminI18n();
      toast.success(t("mutation.room.deleted"));
    },
    onError: (err) => {
      const { locale, t } = getAdminI18n();
      toast.error(resolveAdminErrorMessage(err, t("mutation.room.deleteFailed"), locale));
    },
  });
}

/**
 * 管理员强制吊销并删除 Agent Mutation Hook。
 */
export function useAdminDeleteAgentMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (agentId: AgentId) => deleteAdminAgent(agentId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: adminQueryKeys.all() });
      void queryClient.invalidateQueries({ queryKey: huddleQueryKeys.me() });
      const { t } = getAdminI18n();
      toast.success(t("mutation.agent.deleted"));
    },
    onError: (err) => {
      const { locale, t } = getAdminI18n();
      toast.error(resolveAdminErrorMessage(err, t("mutation.agent.deleteFailed"), locale));
    },
  });
}

/**
 * 管理员删除指定提案 Mutation Hook。
 */
export function useAdminDeleteProposalMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (proposalId: ProposalId) => deleteAdminProposal(proposalId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: adminQueryKeys.all() });
      const { t } = getAdminI18n();
      toast.success(t("mutation.proposal.deleted"));
    },
    onError: (err) => {
      const { locale, t } = getAdminI18n();
      toast.error(resolveAdminErrorMessage(err, t("mutation.proposal.deleteFailed"), locale));
    },
  });
}

/**
 * 管理员吊销单个配对码 Mutation Hook。
 */
export function useAdminRevokePairingCodeMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (code: PairingCode) => revokeAdminPairingCode(code),
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: adminQueryKeys.all() });
      const { t } = getAdminI18n();
      toast.success(t("mutation.pairingCode.revoked", { code: res.revokedCode }));
    },
    onError: (err) => {
      const { locale, t } = getAdminI18n();
      toast.error(resolveAdminErrorMessage(err, t("mutation.pairingCode.revokeFailed"), locale));
    },
  });
}

/**
 * 管理员一键清理已消费与过期配对码 Mutation Hook。
 */
export function useAdminPurgePairingCodesMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => purgeAdminPairingCodes(),
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: adminQueryKeys.all() });
      const { tp } = getAdminI18n();
      toast.success(tp("mutation.pairingCode.purged", res.purgedCount));
    },
    onError: (err) => {
      const { locale, t } = getAdminI18n();
      toast.error(resolveAdminErrorMessage(err, t("mutation.pairingCode.purgeFailed"), locale));
    },
  });
}
