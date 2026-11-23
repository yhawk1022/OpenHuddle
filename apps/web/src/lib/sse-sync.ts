/**
 * @module web/lib/sse-sync
 * @description 全局单一 SSE 实时事件流引擎（将 `/api/v1/events` 增量帧幂等合并或失效至 `TanStack Query` 缓存）。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. SSE 仅作传输通道（Transport Only）：绝不在组件树外维护平行的消息/治理副本库，唯一状态真相源始终是 `QueryClient`。
 * 2. 严格按 `seq` 幂等去重与排序：当人类发送消息的 HTTP 201 响应与 SSE `message.created` 帧乱序并发到达时，通过 `seq` 唯一性与乐观 `_opKey` 对账消除重复气泡。
 * 3. 收到握手或页面恢复可见时补齐未读、好友请求和当前可见会话，避免意外读取后台会话。
 */
import {
  type MessageDto,
  type OperationKey,
  type ProposalCardDto,
  type RoomDetailDto,
  type RoomGovernanceState,
  type RoomId,
  type RoomSummaryDto,
  SseEventSchema,
  asReadCursorSeq,
  assertNever,
} from "@openhuddle/protocol";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  type OptimisticMessageItem,
  type RoomMessagesCacheData,
  huddleQueryKeys,
} from "./query-keys.js";

/** SSE 实时连接指示灯状态枚举 */
export type SseConnectionStatus = "offline" | "connecting" | "live" | "reconnecting";

/** `useRealtimeSseSync` 返回给顶层状态栏的实时连接遥测快照 */
export interface RealtimeSseTelemetry {
  readonly status: SseConnectionStatus;
  readonly connectionId: string | null;
  readonly lastHeartbeatIso: string | null;
}

/**
 * 将一条服务端权威确认的 `MessageDto` 幂等合并进 `RoomMessagesCacheData`。
 *
 * @remarks
 * 并发防重核心算法：
 * - 若收到消息带有 `matchedOpKey`，优先精准剔除对应的客户端乐观占位气泡；
 * - 若 SSE 帧早于 HTTP `POST /messages` 响应抵达，则按同作者、同正文匹配纯文本待确认气泡。媒体消息等待 HTTP 回执以幂等键确认，避免误匹配同一用户在不同端发送的无正文附件；
 * - 按 `seq` 严格升序去重排列，保证任何乱序推送下消息流单调连续。
 *
 * @param prev - 当前缓存快照
 * @param incoming - 服务端确认的单条消息 DTO
 * @param options - 可选匹配的客户端乐观幂等键或顺带更新的治理快照
 * @returns 不可变更新后的新缓存对象
 */
export function mergeConfirmedMessageIntoCache(
  prev: RoomMessagesCacheData,
  incoming: MessageDto,
  options?: {
    readonly matchedOpKey?: OperationKey;
    readonly nextGovernance?: RoomGovernanceState;
  },
): RoomMessagesCacheData {
  const nextList: OptimisticMessageItem[] = [];
  let replacedOptimisticByHeuristic = false;
  let foundExistingSeq = false;

  for (const item of prev.messages) {
    // 1. 若通过 HTTP 响应携带的 matchedOpKey 精确命中乐观气泡，则跳过旧占位，由权威消息接替
    if (
      options?.matchedOpKey !== undefined &&
      item._optimisticPending === true &&
      item._opKey === options.matchedOpKey
    ) {
      continue;
    }

    // 2. 若 SSE 广播比 HTTP 响应先到 5ms，启发式消解最早一条同作者同内容的待确认乐观气泡
    if (
      options?.matchedOpKey === undefined &&
      !replacedOptimisticByHeuristic &&
      item._optimisticPending === true &&
      incoming.author.isYou &&
      incoming.attachment === undefined &&
      item.attachment === undefined &&
      item.content.trim() === incoming.content.trim()
    ) {
      replacedOptimisticByHeuristic = true;
      continue;
    }

    // 3. 同一 seq 幂等覆盖（例如撤回消息更新 recalledAtIso 或 HTTP/SSE 双重送达）
    if (item._optimisticPending !== true && item.seq === incoming.seq) {
      nextList.push(incoming);
      foundExistingSeq = true;
      continue;
    }

    nextList.push(item);
  }

  if (!foundExistingSeq) {
    nextList.push(incoming);
  }

  // 正式消息按 seq 严格单调升序排列，尚未获得真实 seq 的乐观发送中气泡排在尾部
  nextList.sort((a, b) => {
    const aPending = a._optimisticPending === true;
    const bPending = b._optimisticPending === true;
    if (aPending !== bPending) {
      return aPending ? 1 : -1;
    }
    return a.seq - b.seq;
  });

  return {
    ok: true,
    messages: nextList,
    latestSeq: Math.max(prev.latestSeq, incoming.seq),
    governance: options?.nextGovernance ?? prev.governance,
  };
}

/**
 * 将更新后的 `ProposalCardDto` 幂等合并进提案列表缓存。
 *
 * @param prev - 原提案缓存对象
 * @param incoming - 新增或状态演进后的提案卡片 DTO
 * @returns 不可变更新后的提案列表缓存
 */
export function mergeProposalIntoCache(
  prev: { readonly ok: true; readonly proposals: ReadonlyArray<ProposalCardDto> },
  incoming: ProposalCardDto,
): { readonly ok: true; readonly proposals: ReadonlyArray<ProposalCardDto> } {
  let replaced = false;
  const updated = prev.proposals.map((item) => {
    if (item.id === incoming.id) {
      replaced = true;
      return incoming;
    }
    return item;
  });

  return {
    ok: true,
    proposals: replaced ? updated : [incoming, ...updated],
  };
}

/**
 * 不可变移除已删除房间在左侧房间概览列表缓存中的条目（供本地删除与 SSE `room.deleted` 共享）。
 *
 * @param prev - 原房间概览列表缓存对象
 * @param roomId - 已被永久删除的房间品牌 ID
 * @returns 剔除目标房间后的不可变列表缓存
 */
export function removeRoomFromSummaryListCache(
  prev: { readonly ok: true; readonly rooms: ReadonlyArray<RoomSummaryDto> },
  roomId: RoomId,
): { readonly ok: true; readonly rooms: ReadonlyArray<RoomSummaryDto> } {
  return {
    ok: true,
    rooms: prev.rooms.filter((room) => room.id !== roomId),
  };
}

/**
 * 在收到 `DELETE /api/v1/rooms/:roomId` 成功回执或 SSE `room.deleted` 广播时，原子清理目标房间的全部 Query 缓存与飞行中轮询。
 *
 * @remarks
 * 必须先取消正在飞行的查询并移除 `roomDetail`（含 15s 轮询）、`roomMessages`、`roomProposals` 缓存，防止已删除房间继续发起后台请求触发 `404` 报错闪烁。
 *
 * @param queryClient - 全局 `QueryClient` 实例
 * @param roomId - 已被删除的房间品牌 ID
 */
export function evictDeletedRoomFromQueryClient(queryClient: QueryClient, roomId: RoomId): void {
  const detailKey = huddleQueryKeys.roomDetail(roomId);
  const messagesKey = huddleQueryKeys.roomMessages(roomId);
  const proposalsKey = huddleQueryKeys.roomProposals(roomId);

  void queryClient.cancelQueries({ queryKey: detailKey });
  void queryClient.cancelQueries({ queryKey: messagesKey });
  void queryClient.cancelQueries({ queryKey: proposalsKey });

  queryClient.setQueryData<{
    readonly ok: true;
    readonly rooms: ReadonlyArray<RoomSummaryDto>;
  }>(huddleQueryKeys.rooms(), (prev) =>
    prev ? removeRoomFromSummaryListCache(prev, roomId) : undefined,
  );

  queryClient.removeQueries({ queryKey: detailKey, exact: true });
  queryClient.removeQueries({ queryKey: messagesKey, exact: true });
  queryClient.removeQueries({ queryKey: proposalsKey, exact: true });
}

/**
 * 建立并维护全局唯一的 `/api/v1/events` SSE 实时同步通道，驱动 `QueryClient` 增量补丁与失效。
 *
 * @param enabled - 是否已通过认证允许建立 SSE 连接
 * @param sessionToken - 本地备份的人类会话令牌（附加在 `?token=` 兼容跨代理 SSE 鉴权）
 * @param activeRoomId - 当前布局上实际显示的房间 ID，移动端停在列表时为空
 * @param joinedRoomsSignature - 已加入房间集合的排序签名（仅在新建群或新入群导致成员资格集合变化时自动重握手订阅新房间，切换已有群不触发重连）
 * @returns 供工作台状态栏展示的连接遥测状态
 */
export function useRealtimeSseSync(
  enabled: boolean,
  sessionToken: string | null,
  activeRoomId?: RoomId | null,
  joinedRoomsSignature = "",
): RealtimeSseTelemetry {
  const queryClient = useQueryClient();
  const [telemetry, setTelemetry] = useState<RealtimeSseTelemetry>({
    status: enabled ? "connecting" : "offline",
    connectionId: null,
    lastHeartbeatIso: null,
  });

  // 使用 ref 持有最新 activeRoomId，避免切换房间时无谓销毁重建全局单条 EventSource 长连接
  const activeRoomIdRef = useRef<RoomId | null | undefined>(activeRoomId);
  activeRoomIdRef.current = activeRoomId;
  // biome-ignore lint/correctness/useExhaustiveDependencies: 房间成员资格变化时必须重新订阅，退群后关闭旧房间订阅。
  useEffect(() => {
    if (!enabled || typeof window === "undefined" || typeof EventSource === "undefined") {
      setTelemetry({
        status: "offline",
        connectionId: null,
        lastHeartbeatIso: null,
      });
      return;
    }

    const endpoint =
      sessionToken !== null && sessionToken.length > 0
        ? `/api/v1/events?token=${encodeURIComponent(sessionToken)}`
        : "/api/v1/events";

    setTelemetry((prev) => ({
      ...prev,
      status: prev.connectionId !== null ? "reconnecting" : "connecting",
    }));

    const source = new EventSource(endpoint, { withCredentials: true });

    const refreshNotifications = (): void => {
      void queryClient.invalidateQueries({ queryKey: huddleQueryKeys.rooms(), exact: true });
      void queryClient.invalidateQueries({ queryKey: huddleQueryKeys.friends(), exact: true });

      const currentRoom = activeRoomIdRef.current;
      if (currentRoom && document.visibilityState === "visible") {
        void queryClient.invalidateQueries({ queryKey: huddleQueryKeys.roomMessages(currentRoom) });
        void queryClient.invalidateQueries({
          queryKey: huddleQueryKeys.roomProposals(currentRoom),
        });
        void queryClient.invalidateQueries({
          queryKey: huddleQueryKeys.roomDetail(currentRoom),
          exact: true,
        });
      }
    };

    const onVisibilityChange = (): void => {
      if (document.visibilityState === "visible") {
        refreshNotifications();
      }
    };

    const handleRawPayload = (rawData: unknown): void => {
      if (typeof rawData !== "string" || rawData.trim().length === 0) {
        return;
      }
      let jsonPayload: unknown;
      try {
        jsonPayload = JSON.parse(rawData);
      } catch {
        return;
      }

      const parsed = SseEventSchema.safeParse(jsonPayload);
      if (!parsed.success) {
        return;
      }

      const event = parsed.data;
      switch (event.type) {
        case "connected": {
          setTelemetry({
            status: "live",
            connectionId: event.connectionId,
            lastHeartbeatIso: event.serverTimeIso,
          });
          refreshNotifications();
          return;
        }

        case "heartbeat": {
          setTelemetry((prev) => ({
            ...prev,
            status: "live",
            lastHeartbeatIso: event.serverTimeIso,
          }));
          return;
        }

        case "wake": {
          // 收到轻量唤醒帧时刷新左侧房间列表未读计数徽章
          void queryClient.invalidateQueries({ queryKey: huddleQueryKeys.rooms(), exact: true });
          return;
        }

        case "message.created": {
          const isViewingRoom =
            activeRoomIdRef.current === event.roomId && document.visibilityState === "visible";
          const nextCursor = asReadCursorSeq(event.message.seq);
          const roomSummary = queryClient
            .getQueryData<{ readonly rooms: ReadonlyArray<RoomSummaryDto> }>(
              huddleQueryKeys.rooms(),
            )
            ?.rooms.find((room) => room.id === event.roomId);
          if (
            !isViewingRoom &&
            !event.message.author.isYou &&
            event.message.seq > (roomSummary?.lastSeq ?? 0)
          ) {
            toast.info(roomSummary ? `${roomSummary.name} 有新消息` : "收到新消息", {
              id: `room-notice-${event.roomId}`,
              description: event.message.author.displayName,
            });
          }

          // 1. 对目标房间消息流缓存做按 seq 幂等合并；若缓存尚未水合则保持未加载状态等待打开时拉取
          queryClient.setQueryData<RoomMessagesCacheData>(
            huddleQueryKeys.roomMessages(event.roomId),
            (prev) => {
              if (!prev) {
                return undefined;
              }
              return mergeConfirmedMessageIntoCache(prev, event.message);
            },
          );

          // 2. 同步更新左侧房间概览列表中的 lastSeq（若用户正停留在当前房间则同步推进已读游标避免假未读跳动）
          queryClient.setQueryData<{
            readonly ok: true;
            readonly rooms: ReadonlyArray<RoomSummaryDto>;
          }>(huddleQueryKeys.rooms(), (prev) => {
            if (!prev) {
              return undefined;
            }
            return {
              ok: true,
              rooms: prev.rooms.map((room) => {
                if (room.id !== event.roomId) {
                  return room;
                }
                const nextLastSeq = event.message.seq > room.lastSeq ? nextCursor : room.lastSeq;
                return {
                  ...room,
                  lastSeq: nextLastSeq,
                  yourLastReadSeq:
                    isViewingRoom || event.message.author.isYou
                      ? asReadCursorSeq(Math.max(room.yourLastReadSeq, nextCursor))
                      : room.yourLastReadSeq,
                };
              }),
            };
          });

          // 3. 同步更新房间详情缓存的 lastSeq
          queryClient.setQueryData<{ readonly ok: true; readonly room: RoomDetailDto }>(
            huddleQueryKeys.roomDetail(event.roomId),
            (prev) => {
              if (!prev) {
                return undefined;
              }
              const nextLastSeq =
                event.message.seq > prev.room.lastSeq ? nextCursor : prev.room.lastSeq;
              return {
                ok: true,
                room: {
                  ...prev.room,
                  lastSeq: nextLastSeq,
                },
              };
            },
          );

          // 4. 若发言者是此前未在成员缓存或显示为离线的 Agent，立即刷新房间详情与个人 Agent 在线灯
          if (event.message.author.kind === "agent" && event.message.author.agentId !== undefined) {
            const cachedDetail = queryClient.getQueryData<{
              readonly ok: true;
              readonly room: RoomDetailDto;
            }>(huddleQueryKeys.roomDetail(event.roomId));
            const matchingMember = cachedDetail?.room.members.find(
              (m) => m.agentId === event.message.author.agentId,
            );
            if (matchingMember === undefined || matchingMember.reach === "offline") {
              void queryClient.invalidateQueries({
                queryKey: huddleQueryKeys.roomDetail(event.roomId),
                exact: true,
              });
              void queryClient.invalidateQueries({
                queryKey: huddleQueryKeys.me(),
              });
            }
          }

          // 5. 若新消息为结构化提案、投票或拍板记录，同步触发提案面板刷新保持时间线与右侧卡片一致
          if (
            event.message.type === "proposal" ||
            event.message.type === "vote" ||
            event.message.type === "decision"
          ) {
            void queryClient.invalidateQueries({
              queryKey: huddleQueryKeys.roomProposals(event.roomId),
            });
          }
          return;
        }

        case "governance.updated": {
          // 1. 补丁更新房间消息流附带的治理状态（驱动顶部 Turn Budget 进度条与挂起横幅即时响应）
          queryClient.setQueryData<RoomMessagesCacheData>(
            huddleQueryKeys.roomMessages(event.roomId),
            (prev) => (prev ? { ...prev, governance: event.governance } : undefined),
          );

          // 2. 补丁更新房间详情中的治理状态
          queryClient.setQueryData<{ readonly ok: true; readonly room: RoomDetailDto }>(
            huddleQueryKeys.roomDetail(event.roomId),
            (prev) =>
              prev
                ? {
                    ok: true,
                    room: {
                      ...prev.room,
                      governance: event.governance,
                    },
                  }
                : undefined,
          );

          // 3. 补丁更新左侧房间概览列表中的治理状态（实时点亮或熄灭 paused_budget 琥珀色徽标）
          queryClient.setQueryData<{
            readonly ok: true;
            readonly rooms: ReadonlyArray<RoomSummaryDto>;
          }>(huddleQueryKeys.rooms(), (prev) =>
            prev
              ? {
                  ok: true,
                  rooms: prev.rooms.map((room) =>
                    room.id === event.roomId ? { ...room, governance: event.governance } : room,
                  ),
                }
              : undefined,
          );
          return;
        }

        case "proposal.updated": {
          const existing = queryClient.getQueryData<{
            readonly ok: true;
            readonly proposals: ReadonlyArray<ProposalCardDto>;
          }>(huddleQueryKeys.roomProposals(event.roomId));

          if (existing) {
            queryClient.setQueryData(
              huddleQueryKeys.roomProposals(event.roomId),
              mergeProposalIntoCache(existing, event.proposal),
            );
          } else {
            void queryClient.invalidateQueries({
              queryKey: huddleQueryKeys.roomProposals(event.roomId),
            });
          }
          return;
        }

        case "room.deleted": {
          evictDeletedRoomFromQueryClient(queryClient, event.roomId);
          void queryClient.invalidateQueries({ queryKey: huddleQueryKeys.friends() });
          return;
        }

        case "room.upserted": {
          // 收到新建 1v1 单聊或被好友拉入新群通知时，立即刷新会话列表、房间详情与通讯录私聊关联
          void queryClient.invalidateQueries({ queryKey: huddleQueryKeys.rooms(), exact: true });
          void queryClient.invalidateQueries({
            queryKey: huddleQueryKeys.roomDetail(event.roomId),
            exact: true,
          });
          void queryClient.invalidateQueries({ queryKey: huddleQueryKeys.friends() });
          return;
        }

        case "friendship.updated": {
          // 收到新好友申请、对方同意申请或解除好友事件时，即时刷新通讯录与待办红点
          void queryClient.invalidateQueries({ queryKey: huddleQueryKeys.friends() });
          return;
        }

        default:
          assertNever(event);
      }
    };

    const onMessage = (ev: MessageEvent<unknown>): void => {
      handleRawPayload(ev.data);
    };

    // 同时兼容服务端使用默认未命名 `data:` 帧或具名 `event: <type>` 帧下推 SSE 事件
    const namedEventTypes = [
      "connected",
      "heartbeat",
      "wake",
      "message.created",
      "governance.updated",
      "proposal.updated",
      "room.deleted",
      "room.upserted",
      "friendship.updated",
    ] as const;

    source.addEventListener("message", onMessage);
    for (const eventName of namedEventTypes) {
      source.addEventListener(eventName, onMessage as EventListener);
    }

    source.onerror = () => {
      setTelemetry((prev) => ({
        ...prev,
        status: "reconnecting",
      }));
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      source.removeEventListener("message", onMessage);
      for (const eventName of namedEventTypes) {
        source.removeEventListener(eventName, onMessage as EventListener);
      }
      source.close();
    };
  }, [enabled, sessionToken, queryClient, joinedRoomsSignature]);

  return telemetry;
}
