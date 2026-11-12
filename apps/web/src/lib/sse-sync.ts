/**
 * @module web/lib/sse-sync
 * @description 全局单一 SSE 实时事件流引擎（将 `/api/v1/events` 增量帧幂等合并或失效至 `TanStack Query` 缓存）。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. SSE 仅作传输通道（Transport Only）：绝不在组件树外维护平行的消息/治理副本库，唯一状态真相源始终是 `QueryClient`。
 * 2. 严格按 `seq` 幂等去重与排序：当人类发送消息的 HTTP 201 响应与 SSE `message.created` 帧乱序并发到达时，通过 `seq` 唯一性与乐观 `_opKey` 对账消除重复气泡。
 * 3. 断线重连自愈：每当 SSE 重新收到 `connected` 握手帧且此前经历过断线时，定向触发房间列表与当前激活房间的 `invalidateQueries` 补齐离线期间的增量缺口。
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
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
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
 * - 若 SSE 帧早于 HTTP `POST /messages` 响应抵达（此时 SSE 帧不含客户端私有 `_opKey`），则匹配最早一条同为 `author.isYou === true` 且正文一致的 `_optimisticPending` 气泡予以原地转正，杜绝瞬时双影；
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
 * 建立并维护全局唯一的 `/api/v1/events` SSE 实时同步通道，驱动 `QueryClient` 增量补丁与失效。
 *
 * @param enabled - 是否已通过认证允许建立 SSE 连接
 * @param sessionToken - 本地备份的人类会话令牌（附加在 `?token=` 兼容跨代理 SSE 鉴权）
 * @param activeRoomId - 当前用户正在浏览的房间 ID（用于同步推进已读游标与断线重连精准补拉）
 * @returns 供工作台状态栏展示的连接遥测状态
 */
export function useRealtimeSseSync(
  enabled: boolean,
  sessionToken: string | null,
  activeRoomId?: RoomId | null,
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

    let hadPriorConnection = false;
    const source = new EventSource(endpoint, { withCredentials: true });

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
          const isReconnect = hadPriorConnection;
          hadPriorConnection = true;
          setTelemetry({
            status: "live",
            connectionId: event.connectionId,
            lastHeartbeatIso: event.serverTimeIso,
          });
          // 断线重连恢复后主动失效房间列表与当前房间消息/提案，补齐断网窗口内错失的增量
          if (isReconnect) {
            void queryClient.invalidateQueries({ queryKey: huddleQueryKeys.rooms() });
            const currentRoom = activeRoomIdRef.current;
            if (currentRoom) {
              void queryClient.invalidateQueries({
                queryKey: huddleQueryKeys.roomMessages(currentRoom),
              });
              void queryClient.invalidateQueries({
                queryKey: huddleQueryKeys.roomProposals(currentRoom),
              });
              void queryClient.invalidateQueries({
                queryKey: huddleQueryKeys.roomDetail(currentRoom),
              });
            }
          }
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
          void queryClient.invalidateQueries({ queryKey: huddleQueryKeys.rooms() });
          return;
        }

        case "message.created": {
          const isViewingRoom = activeRoomIdRef.current === event.roomId;
          const nextCursor = asReadCursorSeq(event.message.seq);

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
                      ? nextLastSeq
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

          // 4. 若新消息为结构化提案、投票或拍板记录，同步触发提案面板刷新保持时间线与右侧卡片一致
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
    ] as const;

    source.addEventListener("message", onMessage);
    for (const eventName of namedEventTypes) {
      source.addEventListener(eventName, onMessage as EventListener);
    }

    source.onopen = () => {
      setTelemetry((prev) => ({
        ...prev,
        status: "live",
      }));
    };

    source.onerror = () => {
      hadPriorConnection = true;
      setTelemetry((prev) => ({
        ...prev,
        status: "reconnecting",
      }));
    };

    return () => {
      source.removeEventListener("message", onMessage);
      for (const eventName of namedEventTypes) {
        source.removeEventListener(eventName, onMessage as EventListener);
      }
      source.close();
    };
  }, [enabled, sessionToken, queryClient]);

  return telemetry;
}
