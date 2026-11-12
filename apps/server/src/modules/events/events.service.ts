/**
 * @module server/modules/events/service
 * @description 实时事件流订阅（SSE `/api/v1/events`）与长轮询收件箱（`/api/v1/inbox`）核心编排服务。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 动态多视角重盖章：每条 SSE 连接在转发房间事件前统一调用 `reStampSseEventForViewer`，确保不同主人名下的客户端各自看到严格归属于自己的 `isYourOwner` 与 `trustLevel`。
 * 2. 零轮询阻塞唤醒：当 `totalUnreadMessages === 0` 且 `waitSec > 0` 时，直接复用 `RealtimeBus` 事件回调做即时唤醒并立即清理临时监听器，严禁轮询查库。
 */
import {
  type AuthenticatedCaller,
  type InboxResponse,
  type InboxRoomSummary,
  type SseEvent,
  computeAuthorStamp,
} from "@openhuddle/protocol";
import { reStampSseEventForViewer, toActorMemberKey } from "../../infra/identity-stamp.js";
import type { RealtimeBus, UnsubscribeFn } from "../../infra/realtime-bus.js";
import type { MessagesRepository } from "../messages/messages.repo.js";
import type { RoomsRepository } from "../rooms/rooms.repo.js";

/**
 * 构造 `EventsService` 所需的依赖。
 */
export interface EventsServiceDeps {
  readonly roomsRepo: RoomsRepository;
  readonly messagesRepo: MessagesRepository;
  readonly realtimeBus: RealtimeBus;
}

function isCallerMentioned(
  mentions: ReadonlyArray<{
    readonly kind: "human" | "agent";
    readonly userId?: string;
    readonly agentId?: string;
  }>,
  caller: Readonly<AuthenticatedCaller>,
): boolean {
  for (const mention of mentions) {
    if (caller.kind === "human" && mention.kind === "human" && mention.userId === caller.userId) {
      return true;
    }
    if (caller.kind === "agent" && mention.kind === "agent" && mention.agentId === caller.agentId) {
      return true;
    }
  }
  return false;
}

/**
 * SSE 实时订阅与收件箱长轮询编排服务。
 */
export class EventsService {
  private readonly roomsRepo: RoomsRepository;
  private readonly messagesRepo: MessagesRepository;
  private readonly realtimeBus: RealtimeBus;

  /**
   * @param deps - 房间仓储、消息仓储与实时事件总线
   */
  public constructor(deps: Readonly<EventsServiceDeps>) {
    this.roomsRepo = deps.roomsRepo;
    this.messagesRepo = deps.messagesRepo;
    this.realtimeBus = deps.realtimeBus;
  }

  /**
   * 为指定已认证连接挂载其全部已加入房间的广播监听（若为 Agent 同时挂载专属 `wake` 通道）。
   *
   * @param caller - 当前 SSE 连接的身份
   * @param onEvent - 接收重盖章后 `SseEvent` 的回调函数
   * @returns 幂等的取消全部订阅清理函数
   */
  public async subscribeCallerStream(
    caller: Readonly<AuthenticatedCaller>,
    onEvent: (event: SseEvent) => void,
  ): Promise<UnsubscribeFn> {
    const joinedRooms = await this.roomsRepo.listJoinedRooms(toActorMemberKey(caller));
    const unsubscribers: UnsubscribeFn[] = [];

    for (const room of joinedRooms) {
      const unsubRoom = this.realtimeBus.subscribeRoom(room.id, (rawEvent) => {
        onEvent(reStampSseEventForViewer(rawEvent, caller));
      });
      unsubscribers.push(unsubRoom);
    }

    if (caller.kind === "agent") {
      const unsubAgent = this.realtimeBus.subscribeAgent(caller.agentId, (agentEvent) => {
        onEvent(reStampSseEventForViewer(agentEvent, caller));
      });
      unsubscribers.push(unsubAgent);
    }

    let cleanedUp = false;
    return () => {
      if (cleanedUp) {
        return;
      }
      cleanedUp = true;
      for (const unsub of unsubscribers) {
        unsub();
      }
    };
  }

  /**
   * 查询调用者的收件箱未读汇总；若当前无未读消息且指定了 `waitSec > 0`，则挂起等待实时事件到达或超时后返回最新结果。
   *
   * @param caller - 当前已认证人类或 Agent
   * @param waitSec - 最长阻塞等待秒数（`0..25`）
   * @param abortSignal - 可选 HTTP 请求中断信号
   * @returns 符合 `InboxResponseSchema` 的收件箱快照
   */
  public async getInbox(
    caller: Readonly<AuthenticatedCaller>,
    waitSec: number,
    abortSignal?: AbortSignal,
  ): Promise<InboxResponse> {
    const initial = await this.computeInboxSnapshot(caller);
    if (initial.totalUnreadMessages > 0 || waitSec <= 0 || abortSignal?.aborted) {
      return initial;
    }

    await new Promise<void>((resolve) => {
      let settled = false;
      let unsubscribeStream: UnsubscribeFn | undefined;

      const finish = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeoutId);
        if (unsubscribeStream) {
          unsubscribeStream();
        }
        abortSignal?.removeEventListener("abort", finish);
        resolve();
      };

      const timeoutId = setTimeout(finish, Math.round(waitSec * 1_000));
      abortSignal?.addEventListener("abort", finish, { once: true });

      void this.subscribeCallerStream(caller, () => {
        finish();
      }).then((unsub) => {
        if (settled) {
          unsub();
        } else {
          unsubscribeStream = unsub;
        }
      });
    });

    return this.computeInboxSnapshot(caller);
  }

  private async computeInboxSnapshot(
    caller: Readonly<AuthenticatedCaller>,
  ): Promise<InboxResponse> {
    const joinedRooms = await this.roomsRepo.listJoinedRooms(toActorMemberKey(caller));
    const summaries: InboxRoomSummary[] = [];
    let totalUnreadMessages = 0;

    for (const room of joinedRooms) {
      const unreadCount = Math.max(0, room.lastSeq - room.yourLastReadSeq);
      totalUnreadMessages += unreadCount;

      let hasOwnerCommand = false;
      let hasDirectMention = false;

      if (unreadCount > 0) {
        const unreadMessages = await this.messagesRepo.listAfterSeq(
          room.id,
          room.yourLastReadSeq,
          200,
        );
        for (const msg of unreadMessages) {
          const stamp = computeAuthorStamp(msg.rawAuthor, caller);
          if (stamp.trustLevel === "owner_command" && !stamp.isYou) {
            hasOwnerCommand = true;
          }
          if (isCallerMentioned(msg.mentions, caller)) {
            hasDirectMention = true;
          }
          if (hasOwnerCommand && hasDirectMention) {
            break;
          }
        }
      }

      summaries.push({
        roomId: room.id,
        roomName: room.name,
        lastSeq: room.lastSeq,
        yourLastReadSeq: room.yourLastReadSeq,
        unreadCount,
        hasOwnerCommand,
        hasDirectMention,
        governanceStatus: room.governance.status,
      });
    }

    return {
      ok: true,
      totalUnreadMessages,
      rooms: summaries,
      serverTimeIso: new Date().toISOString(),
    };
  }
}
