/**
 * @module web/features/huddle-room/api
 * @description 房间列表、消息时间线（含 `opKey` 乐观更新回滚）、裁判治理热更新与结构化提案拍板的 TanStack Query 契约层。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 零 `useEffect` 拉取：所有服务端读取全部封装为标准化 `queryOptions()`，与 `sse-sync.ts` 共享同一键空间。
 * 2. 乐观消息发送不丢字：人类点击发送立即以 `OperationKey` 插入乐观气泡，若网络或治理拦截报错则精准回滚缓存并由输入框保留草稿；成功后与 SSE 流幂等合流。
 */
import {
  type AttentionPayload,
  type CastProposalVoteBody,
  type DecideProposalBody,
  type HumanUserDto,
  type JoinRoomBody,
  type MessageMention,
  type MessageSeq,
  type OperationKey,
  type ProposalCardDto,
  type ProposalDraft,
  type ProposalId,
  type RoomDetailDto,
  type RoomId,
  type RoomSummaryDto,
  type UpdateGovernanceBody,
  asMessageSeq,
  asReadCursorSeq,
} from "@openhuddle/protocol";
import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  type CreateRoomInput,
  type SynthesizeProposalInput,
  castProposalVote,
  createHuddleRoom,
  createRoomProposal,
  decideProposal,
  fetchJoinedRooms,
  fetchRoomDetail,
  fetchRoomMessages,
  fetchRoomProposals,
  fetchSystemHealth,
  joinRoomByInvite,
  recallRoomMessage,
  sendRoomMessage,
  synthesizeRoomProposal,
  updateRoomGovernance,
} from "../../../lib/api-client.js";
import {
  type OptimisticMessageItem,
  type RoomMessagesCacheData,
  huddleQueryKeys,
} from "../../../lib/query-keys.js";
import { mergeConfirmedMessageIntoCache, mergeProposalIntoCache } from "../../../lib/sse-sync.js";

/**
 * 构造系统健康探针的标准化 `queryOptions`。
 *
 * @returns `/api/v1/health` 查询配置
 */
export function systemHealthQueryOptions() {
  return queryOptions({
    queryKey: huddleQueryKeys.health(),
    queryFn: () => fetchSystemHealth(),
    staleTime: 60_000,
  });
}

/**
 * 构造当前用户已加入房间概览列表的 `queryOptions`。
 *
 * @returns `/api/v1/rooms` 查询配置
 */
export function joinedRoomsQueryOptions() {
  return queryOptions({
    queryKey: huddleQueryKeys.rooms(),
    queryFn: () => fetchJoinedRooms(),
  });
}

/**
 * 构造指定房间完整详情（含群成员实时 `reach` 状态）的 `queryOptions`。
 *
 * @param roomId - 目标房间品牌 ID
 * @returns `/api/v1/rooms/:roomId` 查询配置
 */
export function roomDetailQueryOptions(roomId: RoomId) {
  return queryOptions({
    queryKey: huddleQueryKeys.roomDetail(roomId),
    queryFn: () => fetchRoomDetail(roomId),
    refetchInterval: 15_000,
  });
}

/**
 * 构造指定房间消息流与治理状态快照的 `queryOptions`。
 *
 * @param roomId - 目标房间品牌 ID
 * @returns `/api/v1/rooms/:roomId/messages` 查询配置
 */
export function roomMessagesQueryOptions(roomId: RoomId) {
  return queryOptions({
    queryKey: huddleQueryKeys.roomMessages(roomId),
    queryFn: async (): Promise<RoomMessagesCacheData> => {
      const response = await fetchRoomMessages(roomId, { afterSeq: 0, limit: 100 });
      return {
        ok: true,
        messages: response.messages,
        latestSeq: response.latestSeq,
        governance: response.governance,
      };
    },
  });
}

/**
 * 构造指定房间全部结构化提案与决策卡片列表的 `queryOptions`。
 *
 * @param roomId - 目标房间品牌 ID
 * @returns `/api/v1/rooms/:roomId/proposals` 查询配置
 */
export function roomProposalsQueryOptions(roomId: RoomId) {
  return queryOptions({
    queryKey: huddleQueryKeys.roomProposals(roomId),
    queryFn: () => fetchRoomProposals(roomId),
  });
}

/**
 * 创建新 Huddle 房间并自动刷新房间列表缓存的 Mutation Hook。
 *
 * @returns 创建房间 `useMutation` 实例
 */
export function useCreateRoomMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateRoomInput) => createHuddleRoom(input),
    onSuccess: (res) => {
      queryClient.setQueryData(huddleQueryKeys.roomDetail(res.room.id), res);
      void queryClient.invalidateQueries({ queryKey: huddleQueryKeys.rooms() });
    },
  });
}

/**
 * 凭邀请令牌加入房间并刷新列表缓存的 Mutation Hook。
 *
 * @returns 入群 `useMutation` 实例
 */
export function useJoinRoomMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: JoinRoomBody) => joinRoomByInvite(input),
    onSuccess: (res) => {
      queryClient.setQueryData(huddleQueryKeys.roomDetail(res.room.id), res);
      void queryClient.invalidateQueries({ queryKey: huddleQueryKeys.rooms() });
    },
  });
}

/**
 * 人类裁判热更新房间治理配置（切换讨论模式、互 @ 熔断、调整预算上限或续期挂起态）的 Mutation Hook。
 *
 * @param roomId - 当前房间品牌 ID
 * @returns 同步更新详情、消息治理栏与左侧列表的 `useMutation` 实例
 */
export function useUpdateGovernanceMutation(roomId: RoomId) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch: UpdateGovernanceBody) => updateRoomGovernance(roomId, patch),
    onSuccess: (res) => {
      queryClient.setQueryData<{ readonly ok: true; readonly room: RoomDetailDto }>(
        huddleQueryKeys.roomDetail(roomId),
        res,
      );
      queryClient.setQueryData<RoomMessagesCacheData>(
        huddleQueryKeys.roomMessages(roomId),
        (prev) => (prev ? { ...prev, governance: res.room.governance } : undefined),
      );
      queryClient.setQueryData<{
        readonly ok: true;
        readonly rooms: ReadonlyArray<RoomSummaryDto>;
      }>(huddleQueryKeys.rooms(), (prev) =>
        prev
          ? {
              ok: true,
              rooms: prev.rooms.map((r) =>
                r.id === roomId
                  ? {
                      ...r,
                      visibility: res.room.visibility,
                      governance: res.room.governance,
                    }
                  : r,
              ),
            }
          : undefined,
      );
    },
  });
}

/** 客户端提交发送消息的 Mutation 变量 */
export interface SendOptimisticMessageVariables {
  readonly content: string;
  readonly opKey: OperationKey;
  readonly replyToSeq?: MessageSeq;
  readonly mentions: ReadonlyArray<MessageMention>;
  /** ADR-0002：携带时以 attention 消息发送（结构化等人类作答） */
  readonly attention?: AttentionPayload;
}

/**
 * 带 `opKey` 乐观插入与失败自动回滚的房间消息发送 Mutation Hook。
 *
 * @param roomId - 当前房间品牌 ID
 * @param currentUser - 当前已认证的人类用户 DTO（用于构造本地乐观气泡头部）
 * @returns 消息发送 `useMutation` 实例
 */
export function useSendMessageMutation(roomId: RoomId, currentUser: HumanUserDto) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: SendOptimisticMessageVariables) =>
      sendRoomMessage(roomId, {
        content: vars.content,
        opKey: vars.opKey,
        mentions: vars.mentions,
        ...(vars.replyToSeq !== undefined ? { replyToSeq: vars.replyToSeq } : {}),
        ...(vars.attention !== undefined ? { attention: vars.attention } : {}),
        ignoreUnread: true,
      }),
    onMutate: async (vars) => {
      // 取消正在飞行中的旧查询，防止过期响应覆盖刚插入的乐观消息气泡
      await queryClient.cancelQueries({ queryKey: huddleQueryKeys.roomMessages(roomId) });
      const previousCache = queryClient.getQueryData<RoomMessagesCacheData>(
        huddleQueryKeys.roomMessages(roomId),
      );

      if (previousCache) {
        const provisionalSeq = asMessageSeq(Math.max(1, previousCache.latestSeq + 1));
        const optimisticBubble: OptimisticMessageItem = {
          roomId,
          seq: provisionalSeq,
          type: vars.attention !== undefined ? "attention" : "text",
          ...(vars.attention !== undefined ? { attention: vars.attention } : {}),
          author: {
            kind: "human",
            userId: currentUser.id,
            ownerUserId: currentUser.id,
            displayName: currentUser.displayName,
            isYou: true,
            isYourOwner: true,
            trustLevel: "owner_command",
          },
          content: vars.content,
          ...(vars.replyToSeq !== undefined ? { replyToSeq: vars.replyToSeq } : {}),
          mentions: [...vars.mentions],
          createdAtIso: new Date().toISOString(),
          _opKey: vars.opKey,
          _optimisticPending: true,
        };

        queryClient.setQueryData<RoomMessagesCacheData>(huddleQueryKeys.roomMessages(roomId), {
          ...previousCache,
          messages: [...previousCache.messages, optimisticBubble],
        });
      }

      return { previousCache };
    },
    onError: (_err, _vars, context) => {
      // 发送失败时严格回滚乐观气泡，输入框组件保持未清空草稿避免丢字
      if (context?.previousCache) {
        queryClient.setQueryData(huddleQueryKeys.roomMessages(roomId), context.previousCache);
      }
    },
    onSuccess: (data, vars) => {
      // 以 matchedOpKey 将乐观气泡原地转正为权威 seq 消息，并同步最新治理预算状态
      queryClient.setQueryData<RoomMessagesCacheData>(
        huddleQueryKeys.roomMessages(roomId),
        (prev) => {
          if (!prev) {
            return {
              ok: true,
              messages: [data.message],
              latestSeq: data.message.seq,
              governance: data.governance,
            };
          }
          return mergeConfirmedMessageIntoCache(prev, data.message, {
            matchedOpKey: vars.opKey,
            nextGovernance: data.governance,
          });
        },
      );

      const confirmedCursor = asReadCursorSeq(data.message.seq);
      queryClient.setQueryData<{
        readonly ok: true;
        readonly rooms: ReadonlyArray<RoomSummaryDto>;
      }>(huddleQueryKeys.rooms(), (prev) =>
        prev
          ? {
              ok: true,
              rooms: prev.rooms.map((r) =>
                r.id === roomId
                  ? {
                      ...r,
                      lastSeq: confirmedCursor,
                      yourLastReadSeq: confirmedCursor,
                      governance: data.governance,
                    }
                  : r,
              ),
            }
          : undefined,
      );
    },
  });
}

/**
 * 2 分钟窗口内撤回本人消息的 Mutation Hook。
 *
 * @param roomId - 当前房间品牌 ID
 * @returns 消息撤回 `useMutation` 实例
 */
export function useRecallMessageMutation(roomId: RoomId) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (seq: MessageSeq) => recallRoomMessage(roomId, seq),
    onSuccess: (res) => {
      queryClient.setQueryData<RoomMessagesCacheData>(
        huddleQueryKeys.roomMessages(roomId),
        (prev) => (prev ? mergeConfirmedMessageIntoCache(prev, res.message) : undefined),
      );
    },
  });
}

/**
 * 手动提交结构化多方案提案卡片的 Mutation Hook。
 *
 * @param roomId - 当前房间品牌 ID
 * @returns 创建提案 `useMutation` 实例
 */
export function useCreateProposalMutation(roomId: RoomId) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (draft: ProposalDraft) => createRoomProposal(roomId, draft),
    onSuccess: (res) => {
      queryClient.setQueryData<{
        readonly ok: true;
        readonly proposals: ReadonlyArray<ProposalCardDto>;
      }>(huddleQueryKeys.roomProposals(roomId), (prev) =>
        prev ? mergeProposalIntoCache(prev, res.proposal) : { ok: true, proposals: [res.proposal] },
      );
      void queryClient.invalidateQueries({ queryKey: huddleQueryKeys.roomMessages(roomId) });
    },
  });
}

/**
 * 调用服务端 AI 主持人一键从群聊上下文自动提炼提案卡的 Mutation Hook。
 *
 * @param roomId - 当前房间品牌 ID
 * @returns AI 提炼提案 `useMutation` 实例
 */
export function useSynthesizeProposalMutation(roomId: RoomId) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: SynthesizeProposalInput) => synthesizeRoomProposal(roomId, input),
    onSuccess: (res) => {
      queryClient.setQueryData<{
        readonly ok: true;
        readonly proposals: ReadonlyArray<ProposalCardDto>;
      }>(huddleQueryKeys.roomProposals(roomId), (prev) =>
        prev ? mergeProposalIntoCache(prev, res.proposal) : { ok: true, proposals: [res.proposal] },
      );
      void queryClient.invalidateQueries({ queryKey: huddleQueryKeys.roomMessages(roomId) });
    },
  });
}

/**
 * 对开放提案提交结构化投票评注的 Mutation Hook。
 *
 * @param roomId - 当前房间品牌 ID
 * @returns 投票表态 `useMutation` 实例
 */
export function useCastProposalVoteMutation(roomId: RoomId) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: {
      readonly proposalId: ProposalId;
      readonly body: CastProposalVoteBody;
    }) => castProposalVote(params.proposalId, params.body),
    onSuccess: (res) => {
      queryClient.setQueryData<{
        readonly ok: true;
        readonly proposals: ReadonlyArray<ProposalCardDto>;
      }>(huddleQueryKeys.roomProposals(roomId), (prev) =>
        prev ? mergeProposalIntoCache(prev, res.proposal) : { ok: true, proposals: [res.proposal] },
      );
      void queryClient.invalidateQueries({ queryKey: huddleQueryKeys.roomMessages(roomId) });
    },
  });
}

/**
 * 人类裁判对提案执行最终采纳（`approved`）或驳回（`rejected`）拍板的 Mutation Hook。
 *
 * @param roomId - 当前房间品牌 ID
 * @returns 人类拍板 `useMutation` 实例
 */
export function useDecideProposalMutation(roomId: RoomId) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: { readonly proposalId: ProposalId; readonly body: DecideProposalBody }) =>
      decideProposal(params.proposalId, params.body),
    onSuccess: (res) => {
      queryClient.setQueryData<{
        readonly ok: true;
        readonly proposals: ReadonlyArray<ProposalCardDto>;
      }>(huddleQueryKeys.roomProposals(roomId), (prev) =>
        prev ? mergeProposalIntoCache(prev, res.proposal) : { ok: true, proposals: [res.proposal] },
      );
      void queryClient.invalidateQueries({ queryKey: huddleQueryKeys.roomMessages(roomId) });
    },
  });
}
