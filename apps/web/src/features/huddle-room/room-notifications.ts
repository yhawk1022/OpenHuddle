/**
 * @module web/features/huddle-room/room-notifications
 * @description 根据会话列表的消息与已读序号计算通知气泡变化。每个房间只提示一次已观察的序号。
 */
import {
  type ReadCursorSeq,
  type RoomId,
  type RoomSummaryDto,
  asReadCursorSeq,
} from "@openhuddle/protocol";

interface RoomNotificationCursor {
  readonly observedSeq: ReadCursorSeq;
  readonly notifiedSeq: ReadCursorSeq | undefined;
}

/** 工作台已观察的会话序号与最近提示的消息序号。 */
export type RoomNotificationState = ReadonlyMap<RoomId, RoomNotificationCursor>;

type RoomNotificationChange =
  | { readonly type: "show"; readonly roomId: RoomId; readonly roomName: string }
  | { readonly type: "dismiss"; readonly roomId: RoomId };

/**
 * 对比会话快照，判断哪些气泡需要弹出或撤下。
 *
 * @param previous - 上次处理的状态，首次加载时为 `null`
 * @param rooms - 当前会话列表快照
 * @param viewingRoomId - 前台正在查看的会话，页面隐藏时为空
 * @returns 下次对比的状态和待执行的气泡操作
 */
export function reconcileRoomNotifications(
  previous: RoomNotificationState | null,
  rooms: ReadonlyArray<RoomSummaryDto>,
  viewingRoomId: RoomId | null,
): {
  readonly state: RoomNotificationState;
  readonly changes: ReadonlyArray<RoomNotificationChange>;
} {
  const state = new Map<RoomId, RoomNotificationCursor>();
  const changes: RoomNotificationChange[] = [];
  for (const room of rooms) {
    const prior = previous?.get(room.id);
    const seenThrough = Math.max(prior?.observedSeq ?? 0, room.yourLastReadSeq);
    let notifiedSeq = prior?.notifiedSeq;

    // 首次加载的历史未读由侧栏红点呈现。SSE 和补拉到达顺序不同，也只提示推进的未读序号。
    if (previous !== null && room.id !== viewingRoomId && room.lastSeq > seenThrough) {
      changes.push({ type: "show", roomId: room.id, roomName: room.name });
      notifiedSeq = room.lastSeq;
    } else if (notifiedSeq !== undefined && room.yourLastReadSeq >= notifiedSeq) {
      // 已读达到气泡对应的序号即可撤下，即使随后到达的消息仍未读。
      changes.push({ type: "dismiss", roomId: room.id });
      notifiedSeq = undefined;
    }

    state.set(room.id, {
      observedSeq: asReadCursorSeq(Math.max(seenThrough, room.lastSeq)),
      notifiedSeq,
    });
  }

  for (const [roomId, cursor] of previous ?? []) {
    if (cursor.notifiedSeq !== undefined && !state.has(roomId)) {
      changes.push({ type: "dismiss", roomId });
    }
  }

  return { state, changes };
}
