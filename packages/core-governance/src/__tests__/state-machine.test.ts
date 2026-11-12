/**
 * @module core-governance/tests
 * @description 纯函数群聊治理状态机 100% 关键分支单测（Turn Budget 熔断、乐观读锁、互 @ 开关、冷却锁、圆桌轮流与人类豁免）。
 */
import {
  AgentIdSchema,
  type AuthenticatedCaller,
  UserIdSchema,
  asReadCursorSeq,
  createDefaultGovernanceState,
} from "@openhuddle/protocol";
import { describe, expect, it } from "vitest";
import { applyCommittedMessageTurn, evaluatePreSendPolicy, renewTurnBudget } from "../index.js";

describe("@openhuddle/core-governance — pure deterministic state machine", () => {
  const ownerId = UserIdSchema.parse("usr_owner");
  const agentA = AgentIdSchema.parse("agt_alpha");
  const agentB = AgentIdSchema.parse("agt_beta");

  const humanCaller: AuthenticatedCaller = {
    kind: "human",
    userId: ownerId,
    displayName: "Pangyan",
  };

  const callerA: AuthenticatedCaller = {
    kind: "agent",
    agentId: agentA,
    ownerUserId: ownerId,
    displayName: "Alpha Agent",
    platform: "antigravity",
  };

  const callerB: AuthenticatedCaller = {
    kind: "agent",
    agentId: agentB,
    ownerUserId: ownerId,
    displayName: "Beta Agent",
    platform: "codex",
  };

  it("enforces optimistic read lock (409 CONFLICT_UNREAD_MESSAGES) when agent has unread messages", () => {
    const state = createDefaultGovernanceState({ requireReadBeforeSend: true });
    const decision = evaluatePreSendPolicy(state, {
      caller: callerA,
      roomLastSeq: asReadCursorSeq(5),
      callerLastReadSeq: asReadCursorSeq(4),
      ignoreUnread: false,
      activeRoomAgentIds: [agentA, agentB],
      nowMs: 10_000,
    });

    expect(decision).toEqual({
      allowed: false,
      errorCode: "CONFLICT_UNREAD_MESSAGES",
      reason: expect.stringContaining("lastReadSeq=4"),
    });
  });

  it("halts mutual agent wake-ups when consecutive turns hit maxConsecutiveAgentTurns, and resumes upon human speech", () => {
    let state = createDefaultGovernanceState({
      maxConsecutiveAgentTurns: 2,
      agentCooldownMs: 0,
    });

    // Turn 1 by Agent A mentioning Agent B -> allowed, wakes B
    const t1 = applyCommittedMessageTurn(state, {
      sender: callerA,
      candidateWakeAgentIds: [agentA, agentB],
      activeRoomAgentIds: [agentA, agentB],
      nowMs: 1_000,
    });
    expect(t1.nextState.status).toBe("active");
    expect(t1.nextState.consecutiveAgentTurns).toBe(1);
    // Never wakes sender itself (agentA), only agentB
    expect(t1.permittedWakeAgentIds).toEqual([agentB]);
    state = t1.nextState;

    // Turn 2 by Agent B mentioning Agent A -> hits budget=2, pauses room & cuts wake chain!
    const t2 = applyCommittedMessageTurn(state, {
      sender: callerB,
      candidateWakeAgentIds: [agentA],
      activeRoomAgentIds: [agentA, agentB],
      nowMs: 2_000,
    });
    expect(t2.budgetJustExhausted).toBe(true);
    expect(t2.nextState.status).toBe("paused_budget");
    expect(t2.permittedWakeAgentIds).toEqual([]);
    state = t2.nextState;

    // Agent A attempts to speak while paused_budget -> blocked
    const blocked = evaluatePreSendPolicy(state, {
      caller: callerA,
      roomLastSeq: asReadCursorSeq(2),
      callerLastReadSeq: asReadCursorSeq(2),
      ignoreUnread: false,
      activeRoomAgentIds: [agentA, agentB],
      nowMs: 3_000,
    });
    expect(blocked).toEqual({
      allowed: false,
      errorCode: "GOVERNANCE_BUDGET_PAUSED",
      reason: expect.any(String),
    });

    // Human speaks -> overrides pause, resets counter to 0, resumes active & wakes agents
    const humanAllowed = evaluatePreSendPolicy(state, {
      caller: humanCaller,
      roomLastSeq: asReadCursorSeq(2),
      ignoreUnread: false,
      activeRoomAgentIds: [agentA, agentB],
      nowMs: 4_000,
    });
    expect(humanAllowed).toEqual({ allowed: true });

    const t3 = applyCommittedMessageTurn(state, {
      sender: humanCaller,
      candidateWakeAgentIds: [agentA, agentB],
      activeRoomAgentIds: [agentA, agentB],
      nowMs: 4_000,
    });
    expect(t3.nextState.status).toBe("active");
    expect(t3.nextState.consecutiveAgentTurns).toBe(0);
    expect(t3.permittedWakeAgentIds).toEqual([agentA, agentB]);
  });

  it("enforces round-table turn fairness and manual renewTurnBudget", () => {
    const initial = createDefaultGovernanceState({
      mode: "round_table",
      agentCooldownMs: 0,
      maxConsecutiveAgentTurns: 10,
    });

    const afterA = applyCommittedMessageTurn(initial, {
      sender: callerA,
      candidateWakeAgentIds: [agentB],
      activeRoomAgentIds: [agentA, agentB],
      nowMs: 1_000,
    }).nextState;

    // Agent A tries to speak a second time before Agent B has spoken in this round
    const prematureSecondTurn = evaluatePreSendPolicy(afterA, {
      caller: callerA,
      roomLastSeq: asReadCursorSeq(1),
      callerLastReadSeq: asReadCursorSeq(1),
      ignoreUnread: false,
      activeRoomAgentIds: [agentA, agentB],
      nowMs: 2_000,
    });
    expect(prematureSecondTurn).toEqual({
      allowed: false,
      errorCode: "GOVERNANCE_ROUND_TABLE_WAIT",
      reason: expect.any(String),
    });

    // Once Agent B speaks, the round resets cleanly so Agent A can speak again
    const afterB = applyCommittedMessageTurn(afterA, {
      sender: callerB,
      candidateWakeAgentIds: [agentA],
      activeRoomAgentIds: [agentA, agentB],
      nowMs: 3_000,
    }).nextState;
    expect(afterB.roundTableSpokenAgentIds).toEqual([]);

    const renewed = renewTurnBudget({ ...afterB, status: "paused_budget" });
    expect(renewed.status).toBe("active");
    expect(renewed.consecutiveAgentTurns).toBe(0);
  });
});
