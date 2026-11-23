/**
 * @module web/tests/sse-cache-merge
 * @description 验证前端 SSE 实时缓存合并纯函数的 `opKey` 乐观气泡去重、乱序 `seq` 排序与消息撤回覆盖不变量。
 */
import {
  type MessageDto,
  type OperationKey,
  type RoomId,
  type RoomSummaryDto,
  type UserId,
  asMessageSeq,
  asReadCursorSeq,
  createDefaultGovernanceState,
} from "@openhuddle/protocol";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { roomMessagesQueryOptions } from "../features/huddle-room/api/huddle-room.queries.js";
import { type RoomMessagesCacheData, huddleQueryKeys } from "../lib/query-keys.js";
import { mergeConfirmedMessageIntoCache, removeRoomFromSummaryListCache } from "../lib/sse-sync.js";

const ROOM_ID = "rom_test_web_01" as RoomId;
const USER_ID = "usr_owner_01" as UserId;

afterEach(() => vi.unstubAllGlobals());

function makeMessage(seq: number, content: string, isYou = true): MessageDto {
  return {
    roomId: ROOM_ID,
    seq: asMessageSeq(seq),
    type: "text",
    author: {
      kind: "human",
      userId: USER_ID,
      ownerUserId: USER_ID,
      displayName: "Pang",
      isYou,
      isYourOwner: isYou,
      trustLevel: isYou ? "owner_command" : "external_participant",
    },
    content,
    mentions: [],
    createdAtIso: "2026-11-12T10:00:00.000Z",
  };
}

function historyPage(latestSeq: number, messages: readonly MessageDto[]): Response {
  return Response.json({
    ok: true,
    latestSeq,
    messages,
    governance: createDefaultGovernanceState(),
  });
}

describe("房间历史补拉", () => {
  it("初次加载第 101 条以后的消息，常规补拉从最后一页继续", async () => {
    const client = new QueryClient();
    const options = roomMessagesQueryOptions(ROOM_ID);
    const messages = Array.from({ length: 107 }, (_, index) => makeMessage(index + 1, "history"));
    const fetch = vi.fn<typeof globalThis.fetch>();
    fetch.mockResolvedValueOnce(historyPage(107, messages.slice(0, 100)));
    fetch.mockResolvedValueOnce(historyPage(107, messages.slice(100)));
    fetch.mockResolvedValueOnce(historyPage(108, [makeMessage(108, "new message")]));
    vi.stubGlobal("fetch", fetch);

    await client.fetchQuery(options);
    expect(client.getQueryData(options.queryKey)?.messages).toHaveLength(107);
    await client.fetchQuery(options);

    const cursors = fetch.mock.calls.map(([url]) =>
      new URL(String(url), "http://localhost").searchParams.get("afterSeq"),
    );
    expect(cursors).toEqual(["0", "100", "107"]);
    expect(client.getQueryData(options.queryKey)?.messages.map((message) => message.seq)).toEqual(
      Array.from({ length: 108 }, (_, index) => index + 1),
    );
  });

  it("重连补拉期间保留实时新增、撤回和待发送消息", async () => {
    const client = new QueryClient();
    const options = roomMessagesQueryOptions(ROOM_ID);
    const key = huddleQueryKeys.roomMessages(ROOM_ID);
    const first = makeMessage(1, "first", false);
    const second = makeMessage(2, "missed during disconnect", false);
    const third = makeMessage(3, "arrived over SSE", false);
    const pending = {
      ...makeMessage(4, "pending"),
      _opKey: "op_still_pending" as OperationKey,
      _optimisticPending: true as const,
    };
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(historyPage(1, [first]));
    let completeRequest: (response: Response) => void = () => {
      throw new Error("History request did not start");
    };
    fetch.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          completeRequest = resolve;
        }),
    );
    fetch.mockResolvedValueOnce(historyPage(3, [third]));
    vi.stubGlobal("fetch", fetch);
    await client.fetchQuery(options);

    await client.invalidateQueries({ queryKey: key, refetchType: "none" });
    const refresh = client.fetchQuery(options);
    const recalled = { ...first, recalledAtIso: "2026-11-12T10:01:00.000Z" };
    client.setQueryData<RoomMessagesCacheData>(key, (cached) => {
      if (!cached) {
        throw new Error("Expected hydrated cache");
      }
      const updated = mergeConfirmedMessageIntoCache(
        mergeConfirmedMessageIntoCache(cached, recalled),
        third,
      );
      return { ...updated, messages: [...updated.messages, pending] };
    });
    completeRequest(historyPage(2, [first, second]));
    await refresh;

    expect(client.getQueryData(options.queryKey)).toMatchObject({
      latestSeq: 3,
      historyThroughSeq: 2,
      messages: [recalled, second, third, pending],
    });
    expect(String(fetch.mock.calls[1]?.[0])).toContain("afterSeq=0");
    await client.fetchQuery(options);
    expect(String(fetch.mock.calls[2]?.[0])).toContain("afterSeq=2");
    expect(client.getQueryData(options.queryKey)?.messages).toEqual([
      recalled,
      second,
      third,
      pending,
    ]);
  });
});

describe("@openhuddle/web — SSE & optimistic QueryClient cache merge invariants", () => {
  it("deduplicates optimistic bubble when SSE frame arrives before HTTP response and preserves monotonic seq order", () => {
    const opKey = "op_client_123" as OperationKey;
    const initialCache: RoomMessagesCacheData = {
      ok: true,
      latestSeq: 1,
      governance: createDefaultGovernanceState(),
      messages: [
        makeMessage(1, "First message"),
        {
          ...makeMessage(2, "Optimistic human command"),
          _opKey: opKey,
          _optimisticPending: true,
        },
      ],
    };

    // 场景 A：SSE 广播帧先于 HTTP POST 响应抵达（不含客户端私有 _opKey，但服务器分配了真实 seq=3）
    const sseIncoming = makeMessage(3, "Optimistic human command", true);
    const afterSse = mergeConfirmedMessageIntoCache(initialCache, sseIncoming);
    expect(afterSse.messages).toHaveLength(2);
    expect(afterSse.messages[1]?.seq).toBe(3);
    expect(afterSse.messages[1]?._optimisticPending).toBeUndefined();

    // 场景 B：紧接着 seq=2 的他方消息乱序抵达，以及 HTTP POST 201 响应再次携带 seq=3 + matchedOpKey 抵达
    const outOfOrderMsg2 = makeMessage(2, "Concurrent agent note", false);
    const afterOutOfOrder = mergeConfirmedMessageIntoCache(afterSse, outOfOrderMsg2);
    const afterHttpConfirm = mergeConfirmedMessageIntoCache(afterOutOfOrder, sseIncoming, {
      matchedOpKey: opKey,
    });

    expect(afterHttpConfirm.latestSeq).toBe(3);
    expect(afterHttpConfirm.messages.map((m) => m.seq)).toEqual([1, 2, 3]);
  });

  it("removes a deleted room immutably from the room summary cache and stays idempotent", () => {
    const otherRoomId = "rom_test_web_02" as RoomId;
    const makeRoomSummary = (id: RoomId, name: string): RoomSummaryDto => ({
      id,
      kind: "group",
      ownerUserId: USER_ID,
      name,
      topic: "Topic",
      visibility: "invite_only",
      lastSeq: asReadCursorSeq(2),
      yourLastReadSeq: asReadCursorSeq(1),
      governance: createDefaultGovernanceState(),
      createdAtIso: "2026-11-20T08:00:00.000Z",
    });

    const initialRooms = {
      ok: true as const,
      rooms: [makeRoomSummary(ROOM_ID, "Room 1"), makeRoomSummary(otherRoomId, "Room 2")],
    };

    const afterDelete = removeRoomFromSummaryListCache(initialRooms, ROOM_ID);
    expect(afterDelete.rooms.map((r) => r.id)).toEqual([otherRoomId]);
    // 不可变校验：原缓存数组不受影响
    expect(initialRooms.rooms).toHaveLength(2);

    // 幂等性校验：重复移除同一不存在的 roomId 不会报错或误删其他房间
    const afterRepeat = removeRoomFromSummaryListCache(afterDelete, ROOM_ID);
    expect(afterRepeat.rooms.map((r) => r.id)).toEqual([otherRoomId]);
  });

  it("correlates captionless media sends by operation key rather than matching empty captions", () => {
    const opKey = "op_media_pending" as OperationKey;
    const attachment = { mimeType: "image/png", byteLength: 17 } as const;
    const optimistic = {
      ...makeMessage(1, ""),
      attachment,
      _opKey: opKey,
      _optimisticPending: true,
    };
    const otherDevice = { ...makeMessage(1, ""), attachment };
    const cache: RoomMessagesCacheData = {
      ok: true,
      messages: [optimistic],
      latestSeq: 0,
      governance: createDefaultGovernanceState(),
    };

    const afterSse = mergeConfirmedMessageIntoCache(cache, otherDevice);
    expect(afterSse.messages).toEqual([otherDevice, optimistic]);

    const confirmed = { ...makeMessage(2, ""), attachment };
    const afterHttp = mergeConfirmedMessageIntoCache(afterSse, confirmed, { matchedOpKey: opKey });
    expect(afterHttp.messages).toEqual([otherDevice, confirmed]);
  });
});
