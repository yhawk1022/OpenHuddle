/**
 * @module web/tests/sse-cache-merge
 * @description 验证前端 SSE 实时缓存合并纯函数的 `opKey` 乐观气泡去重、乱序 `seq` 排序与消息撤回覆盖不变量。
 */
import {
  type MessageDto,
  type OperationKey,
  type RoomId,
  type UserId,
  asMessageSeq,
  createDefaultGovernanceState,
} from "@openhuddle/protocol";
import { describe, expect, it } from "vitest";
import type { RoomMessagesCacheData } from "../lib/query-keys.js";
import { mergeConfirmedMessageIntoCache } from "../lib/sse-sync.js";

const ROOM_ID = "rom_test_web_01" as RoomId;
const USER_ID = "usr_owner_01" as UserId;

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
});
