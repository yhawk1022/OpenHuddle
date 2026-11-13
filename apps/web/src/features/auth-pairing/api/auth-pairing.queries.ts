/**
 * @module web/features/auth-pairing/api
 * @description 人类 OTP 登录认证、双层身份自省（`/api/v1/me`）与个人 Agent 配对码签发的 TanStack Query 契约层。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 登录态单点收敛：`currentMeQueryOptions` 设置 `retry: false`，确保未登录或令牌失效时零延迟切换至 OTP 登录视图。
 * 2. 登录即预热：`verifyEmailOtp` 成功后同步写入本地备份 `sessionToken` 并立即水合 `["me"]` 缓存，消除二次往返白屏。
 */
import type {
  ConnectLocalAgentBody,
  RoomDetailDto,
  RoomId,
  RoomSummaryDto,
  RoomVisibility,
} from "@openhuddle/protocol";
import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  type CreatePairingCodeInput,
  connectLocalAgent,
  createPairingCode,
  fetchCurrentMe,
  fetchLocalAgentsStatus,
  logoutSession,
  requestEmailOtp,
  updateRoomGovernance,
  verifyEmailOtp,
} from "../../../lib/api-client.js";
import { huddleQueryKeys } from "../../../lib/query-keys.js";
import { setStoredSessionToken } from "../../../lib/session-store.js";

/**
 * 构造当前人类身份与名下个人 Agent 列表的 `queryOptions`。
 *
 * @returns 标准化的 `/api/v1/me` 查询配置
 */
export function currentMeQueryOptions() {
  return queryOptions({
    queryKey: huddleQueryKeys.me(),
    queryFn: () => fetchCurrentMe(),
    retry: false,
    staleTime: 15_000,
    refetchInterval: 15_000,
  });
}

/**
 * 请求邮箱 6 位一次性登录验证码的 Mutation Hook。
 *
 * @returns TanStack `useMutation` 实例
 */
export function useRequestOtpMutation() {
  return useMutation({
    mutationFn: requestEmailOtp,
  });
}

/**
 * 校验 6 位验证码并完成人类会话登录的 Mutation Hook。
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
    staleTime: 30_000,
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
