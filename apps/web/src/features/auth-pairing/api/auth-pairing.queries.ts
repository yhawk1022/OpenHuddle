/**
 * @module web/features/auth-pairing/api
 * @description 人类邮箱+密码注册与登录、找回/修改密码、旧版 OTP 兼容、双层身份自省（`/api/v1/me`）与个人 Agent 配对码签发的 TanStack Query 契约层。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. `/me` 的 401 表示已确认未登录，缓存为 `null` 并暂停轮询。登录成功后由会话变更重新触发查询。
 * 2. 登录/注册/改密即水合：任意会话签发成功后均同步持久化备份 `sessionToken` 并失效刷新 `["me"]` 与 `["rooms"]` 缓存，消除二次往返白屏。
 */
import type {
  AgentId,
  ConnectLocalAgentBody,
  RoomDetailDto,
  RoomId,
  RoomSummaryDto,
  RoomVisibility,
  UpdateOwnedAgentBody,
} from "@openhuddle/protocol";
import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ApiClientError,
  type CreatePairingCodeInput,
  changePassword,
  confirmPasswordReset,
  connectLocalAgent,
  createPairingCode,
  deleteOwnedAgent,
  fetchAuthConfig,
  fetchCurrentMe,
  fetchLocalAgentsStatus,
  loginWithPassword,
  logoutSession,
  registerWithPassword,
  requestEmailOtp,
  requestPasswordResetCode,
  requestRegisterCode,
  updateCurrentMe,
  updateOwnedAgentSettings,
  updateRoomGovernance,
  verifyEmailOtp,
} from "../../../lib/api-client.js";
import { huddleQueryKeys } from "../../../lib/query-keys.js";
import { setStoredSessionToken } from "../../../lib/session-store.js";

/**
 * 构造认证与注册公开策略配置（`/api/v1/auth/config`）的 `queryOptions`。
 *
 * @returns 公开注册开关、邮箱域名白名单、邮件投递模式与冷却参数查询配置
 */
export function authConfigQueryOptions() {
  return queryOptions({
    queryKey: huddleQueryKeys.authConfig(),
    queryFn: () => fetchAuthConfig(),
    staleTime: 60_000,
    retry: 1,
  });
}

/**
 * 构造当前人类身份与名下个人 Agent 列表的 `queryOptions`。
 *
 * @returns 标准化的 `/api/v1/me` 查询配置
 */
export function currentMeQueryOptions() {
  return queryOptions({
    queryKey: huddleQueryKeys.me(),
    queryFn: async () => {
      try {
        return await fetchCurrentMe();
      } catch (error) {
        if (error instanceof ApiClientError && error.statusCode === 401) {
          return null;
        }
        throw error;
      }
    },
    retry: false,
    staleTime: 15_000,
    refetchInterval: (query) => (query.state.data === null ? false : 15_000),
  });
}

/**
 * 注册前请求发送 6 位邮箱激活验证码的 Mutation Hook。
 *
 * @returns TanStack `useMutation` 实例
 */
export function useRequestRegisterCodeMutation() {
  return useMutation({
    mutationFn: requestRegisterCode,
  });
}

/**
 * 校验 6 位邮箱激活码并完成新用户注册的 Mutation Hook。
 *
 * @returns 注册成功后自动持久化会话令牌并刷新全局身份与房间列表的 `useMutation` 实例
 */
export function useRegisterWithPasswordMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: registerWithPassword,
    onSuccess: (data) => {
      setStoredSessionToken(data.sessionToken);
      void queryClient.invalidateQueries({ queryKey: huddleQueryKeys.me() });
      void queryClient.invalidateQueries({ queryKey: huddleQueryKeys.rooms() });
    },
  });
}

/**
 * 邮箱 + 密码日常登录的 Mutation Hook。
 *
 * @returns 登录成功后自动持久化会话令牌并刷新全局身份与房间列表的 `useMutation` 实例
 */
export function useLoginWithPasswordMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: loginWithPassword,
    onSuccess: (data) => {
      setStoredSessionToken(data.sessionToken);
      void queryClient.invalidateQueries({ queryKey: huddleQueryKeys.me() });
      void queryClient.invalidateQueries({ queryKey: huddleQueryKeys.rooms() });
    },
  });
}

/**
 * 忘记密码时请求发送 6 位邮箱重置验证码的 Mutation Hook。
 *
 * @returns TanStack `useMutation` 实例
 */
export function useRequestPasswordResetCodeMutation() {
  return useMutation({
    mutationFn: requestPasswordResetCode,
  });
}

/**
 * 核验 6 位重置验证码并重设登录密码的 Mutation Hook。
 *
 * @returns 重置成功后自动持久化新会话令牌并刷新全局身份与房间列表的 `useMutation` 实例
 */
export function useConfirmPasswordResetMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: confirmPasswordReset,
    onSuccess: (data) => {
      setStoredSessionToken(data.sessionToken);
      void queryClient.invalidateQueries({ queryKey: huddleQueryKeys.me() });
      void queryClient.invalidateQueries({ queryKey: huddleQueryKeys.rooms() });
    },
  });
}

/**
 * 已登录用户修改登录密码（或补设初始密码）并轮换会话的 Mutation Hook。
 *
 * @returns 改密成功后自动持久化新会话令牌并刷新 `["me"]` 缓存的 `useMutation` 实例
 */
export function useChangePasswordMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: changePassword,
    onSuccess: (data) => {
      setStoredSessionToken(data.sessionToken);
      void queryClient.invalidateQueries({ queryKey: huddleQueryKeys.me() });
    },
  });
}

/**
 * 更新当前人类用户展示昵称的 Mutation Hook。
 *
 * @returns 更新成功后自动同步 `["me"]` 缓存的 `useMutation` 实例
 */
export function useUpdateMeMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: updateCurrentMe,
    onSuccess: (data) => {
      queryClient.setQueryData(huddleQueryKeys.me(), data);
    },
  });
}

/**
 * [兼容旧版 OTP 路由] 请求邮箱 6 位一次性登录验证码的 Mutation Hook。
 *
 * @returns TanStack `useMutation` 实例
 */
export function useRequestOtpMutation() {
  return useMutation({
    mutationFn: requestEmailOtp,
  });
}

/**
 * [兼容旧版 OTP 路由] 校验 6 位验证码并完成人类会话登录的 Mutation Hook。
 *
 * @returns 登录成功后自动持久化备份令牌并刷新全局身份与房间列表的 `useMutation` 实例
 */
export function useVerifyOtpMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: verifyEmailOtp,
    onSuccess: (data) => {
      setStoredSessionToken(data.sessionToken);
      void queryClient.invalidateQueries({ queryKey: huddleQueryKeys.me() });
      void queryClient.invalidateQueries({ queryKey: huddleQueryKeys.rooms() });
    },
  });
}

/**
 * 退出当前人类登录会话并清空敏感缓存的 Mutation Hook。
 *
 * @returns 注销成功后擦除本地令牌与 `QueryClient` 缓存的 `useMutation` 实例
 */
export function useLogoutMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: logoutSession,
    onSettled: () => {
      setStoredSessionToken(null);
      queryClient.clear();
    },
  });
}

/**
 * 签发一次性个人 Agent 配对码（支持自动入群或 `--reclaim` 恢复离线身份）的 Mutation Hook。
 *
 * @returns 签发配对码的 `useMutation` 实例
 */
export function useCreatePairingCodeMutation() {
  return useMutation({
    mutationFn: (input: CreatePairingCodeInput) => createPairingCode(input),
  });
}

/**
 * 探测同机部署下已安装的本机预设 Agent CLI 列表的 `queryOptions`。
 *
 * @returns 标准化的 `/api/v1/local-agents/status` 查询配置
 */
export function localAgentsStatusQueryOptions() {
  return queryOptions({
    queryKey: huddleQueryKeys.localAgentsStatus(),
    queryFn: () => fetchLocalAgentsStatus(),
    retry: false,
    staleTime: 0,
    refetchOnMount: "always",
  });
}

/**
 * 一键直连本机已安装的预设 Agent CLI 并自动刷新个人身份、房间列表与当前群消息时间线的 Mutation Hook。
 *
 * @returns 本机一键直连 `useMutation` 实例
 */
export function useConnectLocalAgentMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: Readonly<ConnectLocalAgentBody>) => connectLocalAgent(body),
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: huddleQueryKeys.me() });
      void queryClient.invalidateQueries({ queryKey: huddleQueryKeys.rooms() });
      if (res.autoJoinedRoomId !== undefined) {
        void queryClient.invalidateQueries({
          queryKey: huddleQueryKeys.roomDetail(res.autoJoinedRoomId),
        });
        void queryClient.invalidateQueries({
          queryKey: huddleQueryKeys.roomMessages(res.autoJoinedRoomId),
        });
      }
    },
  });
}

/**
 * 更新名下个人 Agent 设置（如开启/关闭「允许其他用户私聊」）并同步刷新身份与房间列表的 Mutation Hook。
 *
 * @returns 更新个人 Agent 设置的 `useMutation` 实例
 */
export function useUpdateOwnedAgentMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: {
      readonly agentId: AgentId;
      readonly body: Readonly<UpdateOwnedAgentBody>;
    }) => updateOwnedAgentSettings(params.agentId, params.body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: huddleQueryKeys.me() });
      void queryClient.invalidateQueries({ queryKey: huddleQueryKeys.rooms() });
    },
  });
}

/**
 * 彻底删除名下个人 Agent 并自动刷新个人身份、房间列表及房间成员名册的 Mutation Hook。
 *
 * @returns 删除个人 Agent 的 `useMutation` 实例
 */
export function useDeleteOwnedAgentMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (agentId: AgentId) => deleteOwnedAgent(agentId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: huddleQueryKeys.me() });
      void queryClient.invalidateQueries({ queryKey: huddleQueryKeys.rooms() });
    },
  });
}

/**
 * 在邀请与分享弹窗中一键切换房间公开只读分享可见性（`invite_only` <-> `public_shareable`）的 Mutation Hook。
 *
 * @returns 热更新房间可见性并同步更新详情与列表缓存的 `useMutation` 实例
 */
export function useRoomShareVisibilityMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: { readonly roomId: RoomId; readonly visibility: RoomVisibility }) =>
      updateRoomGovernance(params.roomId, { visibility: params.visibility }),
    onSuccess: (res) => {
      queryClient.setQueryData<{ readonly ok: true; readonly room: RoomDetailDto }>(
        huddleQueryKeys.roomDetail(res.room.id),
        res,
      );
      queryClient.setQueryData<{
        readonly ok: true;
        readonly rooms: ReadonlyArray<RoomSummaryDto>;
      }>(huddleQueryKeys.rooms(), (prev) =>
        prev
          ? {
              ok: true,
              rooms: prev.rooms.map((r) =>
                r.id === res.room.id ? { ...r, visibility: res.room.visibility } : r,
              ),
            }
          : undefined,
      );
    },
  });
}
