/**
 * @module protocol/tests
 * @description 验证共享协议契约、Branded ID 边界校验与双层身份防伪造盖章不变量。
 */
import { describe, expect, it } from "vitest";
import {
  AgentIdSchema,
  PairingCodeSchema,
  UserIdSchema,
  asMessageSeq,
  computeAuthorStamp,
} from "../index.js";

describe("@openhuddle/protocol — identity & security invariants", () => {
  const ownerA = UserIdSchema.parse("usr_pangyan");
  const ownerB = UserIdSchema.parse("usr_partner");
  const agentA1 = AgentIdSchema.parse("agt_pangyan_agy");
  const agentA2 = AgentIdSchema.parse("agt_pangyan_codex");
  const agentB1 = AgentIdSchema.parse("agt_partner_deepseek");

  it("grants owner_command exclusively when the author is the viewer agent's human owner", () => {
    const stamp = computeAuthorStamp(
      {
        kind: "human",
        userId: ownerA,
        ownerUserId: ownerA,
        displayName: "Pangyan",
      },
      {
        kind: "agent",
        agentId: agentA1,
        ownerUserId: ownerA,
        displayName: "Pangyan Antigravity",
        platform: "antigravity",
      },
    );

    expect(stamp.isYourOwner).toBe(true);
    expect(stamp.isYou).toBe(false);
    expect(stamp.trustLevel).toBe("owner_command");
  });

  it("assigns owner_sibling_agent (not owner_command) to another agent owned by the same human", () => {
    const stamp = computeAuthorStamp(
      {
        kind: "agent",
        agentId: agentA2,
        ownerUserId: ownerA,
        displayName: "Pangyan (Fake Human Name)",
        platform: "codex",
      },
      {
        kind: "agent",
        agentId: agentA1,
        ownerUserId: ownerA,
        displayName: "Pangyan Antigravity",
        platform: "antigravity",
      },
    );

    expect(stamp.isYourOwner).toBe(false);
    expect(stamp.trustLevel).toBe("owner_sibling_agent");
  });

  it("quarantines other humans and external agents as external_participant against prompt injection", () => {
    const externalHumanStamp = computeAuthorStamp(
      {
        kind: "human",
        userId: ownerB,
        ownerUserId: ownerB,
        displayName: "Partner",
      },
      {
        kind: "agent",
        agentId: agentA1,
        ownerUserId: ownerA,
        displayName: "Pangyan Antigravity",
        platform: "antigravity",
      },
    );

    const externalAgentStamp = computeAuthorStamp(
      {
        kind: "agent",
        agentId: agentB1,
        ownerUserId: ownerB,
        displayName: "Partner DeepSeek",
        platform: "deepseek",
      },
      {
        kind: "agent",
        agentId: agentA1,
        ownerUserId: ownerA,
        displayName: "Pangyan Antigravity",
        platform: "antigravity",
      },
    );

    expect(externalHumanStamp.isYourOwner).toBe(false);
    expect(externalHumanStamp.trustLevel).toBe("external_participant");
    expect(externalAgentStamp.isYourOwner).toBe(false);
    expect(externalAgentStamp.trustLevel).toBe("external_participant");
  });

  it("normalizes pairing codes to uppercase and enforces positive MessageSeq", () => {
    expect(PairingCodeSchema.parse("huddle-8k3p-92m")).toBe("HUDDLE-8K3P-92M");
    expect(asMessageSeq(1)).toBe(1);
    expect(() => asMessageSeq(0)).toThrow(RangeError);
  });
});
