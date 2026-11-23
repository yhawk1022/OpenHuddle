/**
 * @module web/tests/room-notifications
 * @description 覆盖会话通知在已读、重连补拉与乱序缓存写入时的回归场景。
 */
import {
  type RoomId,
  type RoomSummaryDto,
  type UserId,
  asReadCursorSeq,
  createDefaultGovernanceState,
} from "@openhuddle/protocol";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { joinedRoomsQueryOptions } from "../features/huddle-room/api/huddle-room.queries.js";
import { reconcileRoomNotifications } from "../features/huddle-room/room-notifications.js";

const ROOM_ID = "rom_notification_1" as RoomId;
const OTHER_ROOM_ID = "rom_notification_2" as RoomId;

function room(lastSeq: number, readSeq: number, id = ROOM_ID): RoomSummaryDto {
  return {
    id,
    kind: "group",
    ownerUserId: "usr_owner_1" as UserId,
    name: "日常讨论",
    topic: "",
    visibility: "invite_only",
    lastSeq: asReadCursorSeq(lastSeq),
    yourLastReadSeq: asReadCursorSeq(readSeq),
    governance: createDefaultGovernanceState(),
    createdAtIso: "2026-11-23T10:00:00.000Z",
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("会话消息气泡", () => {
  it("首屏不弹历史未读，同一未读只提示一次，读完才撤下并继续提示更新的消息", () => {
    const initial = reconcileRoomNotifications(null, [room(4, 2)], null);
    expect(initial.changes).toEqual([]);

    const incoming = reconcileRoomNotifications(initial.state, [room(5, 2)], null);
    expect(incoming.changes).toEqual([{ type: "show", roomId: ROOM_ID, roomName: "日常讨论" }]);
    expect(reconcileRoomNotifications(incoming.state, [room(5, 2)], null).changes).toEqual([]);
    expect(reconcileRoomNotifications(incoming.state, [room(5, 4)], ROOM_ID).changes).toEqual([]);

    const read = reconcileRoomNotifications(incoming.state, [room(5, 5)], ROOM_ID);
    expect(read.changes).toEqual([{ type: "dismiss", roomId: ROOM_ID }]);
    const stale = reconcileRoomNotifications(read.state, [room(4, 2)], null);
    expect(reconcileRoomNotifications(stale.state, [room(5, 2)], null).changes).toEqual([]);
    expect(reconcileRoomNotifications(stale.state, [room(6, 5)], null).changes).toEqual([
      { type: "show", roomId: ROOM_ID, roomName: "日常讨论" },
    ]);
  });

  it("正在查看的会话不弹提醒，退出会话后不会补弹此前看到的消息", () => {
    const initial = reconcileRoomNotifications(null, [room(4, 4)], null);
    const visible = reconcileRoomNotifications(initial.state, [room(5, 4)], ROOM_ID);
    expect(visible.changes).toEqual([]);
    expect(reconcileRoomNotifications(visible.state, [room(5, 4)], null).changes).toEqual([]);
  });

  it("移出会话列表时撤下对应气泡", () => {
    const initial = reconcileRoomNotifications(null, [room(4, 4)], null);
    const incoming = reconcileRoomNotifications(initial.state, [room(5, 4)], null);

    expect(reconcileRoomNotifications(incoming.state, [], null).changes).toEqual([
      { type: "dismiss", roomId: ROOM_ID },
    ]);
  });
});

describe("会话列表游标", () => {
  it("较早发出的列表请求返回时保留新的实时序号和已读进度，并应用成员列表变化", async () => {
    const client = new QueryClient();
    const options = joinedRoomsQueryOptions();
    const fetch = vi.fn<typeof globalThis.fetch>();
    fetch.mockResolvedValueOnce(
      Response.json({ ok: true, rooms: [room(3, 2), room(1, 0, OTHER_ROOM_ID)] }),
    );
    let respond: (response: Response) => void = () => {
      throw new Error("Room list request did not start");
    };
    fetch.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          respond = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetch);
    await client.fetchQuery(options);

    const refresh = client.fetchQuery(options);
    client.setQueryData(options.queryKey, {
      ok: true,
      rooms: [room(6, 5), room(1, 0, OTHER_ROOM_ID)],
    });
    const stale = { ...room(4, 3), name: "新会话名称" };
    respond(Response.json({ ok: true, rooms: [stale] }));
    await refresh;

    expect(client.getQueryData(options.queryKey)?.rooms).toEqual([
      { ...room(6, 5), name: stale.name },
    ]);
  });
});
