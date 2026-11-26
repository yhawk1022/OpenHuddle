import {
  AgentIdSchema,
  type AuthenticatedCaller,
  type MessageDto,
  RoomIdSchema,
  UserIdSchema,
  asMessageSeq,
  computeAuthorStamp,
} from "@openhuddle/protocol";
import { describe, expect, it, vi } from "vitest";
import { resolveWakeRetrySource } from "../wake-retry-source.js";

const roomId = RoomIdSchema.parse("rom_chat");
const ownerId = UserIdSchema.parse("usr_owner");
const self = {
  id: AgentIdSchema.parse("agt_artist"),
  displayName: "绘图助手",
  slug: "artist",
};
const sibling = {
  id: AgentIdSchema.parse("agt_writer"),
  displayName: "写作助手",
  slug: "writer",
};
const viewer: AuthenticatedCaller = {
  kind: "agent",
  agentId: self.id,
  displayName: self.displayName,
  platform: "codex",
  ownerUserId: ownerId,
};
const owner = computeAuthorStamp(
  {
    kind: "human",
    userId: ownerId,
    ownerUserId: ownerId,
    displayName: "主人",
  },
  viewer,
);
const outsiderId = UserIdSchema.parse("usr_guest");
const outsider = computeAuthorStamp(
  {
    kind: "human",
    userId: outsiderId,
    ownerUserId: outsiderId,
    displayName: "朋友",
  },
  viewer,
);
const timestamp = "2026-11-26T08:00:00.000Z";

function mention(agent: typeof self) {
  return { kind: "agent" as const, agentId: agent.id, displayName: agent.displayName };
}

function message(seq: number, content: string, overrides: Partial<MessageDto> = {}): MessageDto {
  return {
    roomId,
    seq: asMessageSeq(seq),
    type: "text",
    author: owner,
    content,
    mentions: [mention(self)],
    createdAtIso: timestamp,
    ...overrides,
  };
}

function response(seq: number, replyToSeq: number, agent = self): MessageDto {
  return message(seq, "处理超时，请重试。", {
    author: computeAuthorStamp(
      {
        kind: "agent",
        agentId: agent.id,
        ownerUserId: ownerId,
        displayName: agent.displayName,
      },
      viewer,
    ),
    mentions: [],
    replyToSeq: asMessageSeq(replyToSeq),
  });
}

const original = message(1, "@绘图助手 把照片调亮", {
  attachment: { mimeType: "image/png", byteLength: 240 },
});
const failure = response(2, 1);

describe("resolveWakeRetrySource", () => {
  it("restores the owner's image request when they mention this agent and retry", async () => {
    const retry = message(3, "@绘图助手 重试");
    expect(await resolveWakeRetrySource(retry, [original, failure, retry], self)).toEqual(original);
  });

  it("follows replies to previous retries back to the original request", async () => {
    const firstRetry = message(3, "@绘图助手 重试", { replyToSeq: failure.seq });
    const secondFailure = response(4, 3);
    const secondRetry = message(5, "@绘图助手 重试", { replyToSeq: secondFailure.seq });
    expect(
      await resolveWakeRetrySource(
        secondRetry,
        [original, failure, firstRetry, secondFailure, secondRetry],
        self,
      ),
    ).toEqual(original);
  });

  it("honors an explicit reply even when another owner request is newer", async () => {
    const newer = message(3, "@绘图助手 总结今天的对话");
    const retry = message(4, "@绘图助手 重试", { replyToSeq: original.seq });
    expect(await resolveWakeRetrySource(retry, [original, failure, newer], self)).toEqual(original);
  });

  it("loads the reply target when the original is outside the visible window", async () => {
    const retry = message(24, "@绘图助手 重试", { replyToSeq: failure.seq });
    const loadHistory = vi.fn(async () => [original, failure]);
    expect(await resolveWakeRetrySource(retry, [failure, retry], self, loadHistory)).toEqual(
      original,
    );
    expect(loadHistory).toHaveBeenCalled();
  });

  it("keeps a newer text task as the retry target without reviving a stale photo", async () => {
    const text = message(3, "@绘图助手 用两句话总结今天的讨论");
    const retry = message(5, "@绘图助手 重试");
    expect(
      await resolveWakeRetrySource(retry, [original, failure, text, response(4, 3)], self),
    ).toEqual(text);
  });

  it.each([
    ["a fresh instruction", message(3, "@绘图助手 帮我写一段活动介绍")],
    [
      "a same-name mention for another agent",
      message(3, "@绘图助手 重试", {
        mentions: [mention({ ...sibling, displayName: self.displayName })],
      }),
    ],
    ["an external retry", message(3, "@绘图助手 重试", { author: outsider })],
    ["a recalled retry", message(3, "@绘图助手 重试", { recalledAtIso: timestamp })],
    [
      "a retry addressed to a different agent",
      message(3, "@写作助手 重试", { mentions: [mention(sibling)] }),
    ],
  ] as const)("does not resolve %s", async (_label, trigger) => {
    expect(await resolveWakeRetrySource(trigger, [original, failure], self)).toBeUndefined();
  });

  it.each([
    ["external author", { ...original, author: outsider }],
    [
      "owner addressing a different agent",
      { ...original, content: "@写作助手 把照片调亮", mentions: [mention(sibling)] },
    ],
    ["recalled request", { ...original, recalledAtIso: timestamp }],
    ["request from a different room", { ...original, roomId: RoomIdSchema.parse("rom_other") }],
    ["a later request", { ...original, seq: asMessageSeq(12) }],
  ] as const)("rejects an explicitly referenced source with %s", async (_label, source) => {
    const retry = message(10, "@绘图助手 重试", { replyToSeq: source.seq });
    expect(await resolveWakeRetrySource(retry, [source], self)).toBeUndefined();
  });

  it("does not traverse another agent's reply history", async () => {
    const siblingReply = response(2, 1, sibling);
    const retry = message(3, "@绘图助手 重试", { replyToSeq: siblingReply.seq });
    expect(await resolveWakeRetrySource(retry, [original, siblingReply], self)).toBeUndefined();
  });
});
