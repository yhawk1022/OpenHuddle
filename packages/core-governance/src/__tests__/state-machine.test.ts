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

describe("@openhuddle/core-governance — ADR-0002 联邦铁律不变量（Agent 消息无授权语义）", () => {
  const ownerId = UserIdSchema.parse("usr_owner2");
  const agentA = AgentIdSchema.parse("agt_gamma");
  const agentB = AgentIdSchema.parse("agt_delta");

  const humanCaller: AuthenticatedCaller = {
    kind: "human",
    userId: ownerId,
    displayName: "Owner",
  };

  const callerA: AuthenticatedCaller = {
    kind: "agent",
    agentId: agentA,
    ownerUserId: ownerId,
    displayName: "Gamma Agent",
    platform: "claude_code",
  };

  const callerB: AuthenticatedCaller = {
    kind: "agent",
    agentId: agentB,
    ownerUserId: ownerId,
    displayName: "Delta Agent",
    platform: "codex",
  };

  it("铁律1：Agent 发言永不重置连续轮次计数，也永不解除 paused_budget", () => {
    const state = createDefaultGovernanceState({ maxConsecutiveAgentTurns: 3 });
    let current = state;
    for (let i = 0; i < 3; i += 1) {
      const t = applyCommittedMessageTurn(current, {
        sender: callerA,
        candidateWakeAgentIds: [agentB],
        activeRoomAgentIds: [agentA, agentB],
        nowMs: 1_000 * i,
      });
      current = t.nextState;
    }
    expect(current.status).toBe("paused_budget");
    expect(current.consecutiveAgentTurns).toBe(3);

    // 另一个 Agent 发言：状态保持 paused、计数只增不减
    const afterAgentB = applyCommittedMessageTurn(current, {
      sender: callerB,
      candidateWakeAgentIds: [agentA],
      activeRoomAgentIds: [agentA, agentB],
      nowMs: 9_999,
    });
    expect(afterAgentB.nextState.status).toBe("paused_budget");
    expect(afterAgentB.nextState.consecutiveAgentTurns).toBe(4);
    expect(afterAgentB.permittedWakeAgentIds).toEqual([]);

    // 只有人类发言才重置并回到 active
    const afterHuman = applyCommittedMessageTurn(current, {
      sender: humanCaller,
      candidateWakeAgentIds: [agentA],
      activeRoomAgentIds: [agentA, agentB],
      nowMs: 10_000,
    });
    expect(afterHuman.nextState.status).toBe("active");
    expect(afterHuman.nextState.consecutiveAgentTurns).toBe(0);
  });

  it("铁律2：预算耗尽瞬间的 Agent 消息必须清零全部自动唤醒名单", () => {
    const state = createDefaultGovernanceState({ maxConsecutiveAgentTurns: 1 });
    const t = applyCommittedMessageTurn(state, {
      sender: callerA,
      candidateWakeAgentIds: [agentB],
      activeRoomAgentIds: [agentA, agentB],
      nowMs: 1,
    });
    expect(t.budgetJustExhausted).toBe(true);
    expect(t.permittedWakeAgentIds).toEqual([]);
  });

  it("铁律3：挂起预算态下 Agent 发言被 GOVERNANCE_BUDGET_PAUSED 拦截，人类永远豁免", () => {
    const pausedState = {
      ...createDefaultGovernanceState({}),
      status: "paused_budget" as const,
    };
    const agentDecision = evaluatePreSendPolicy(pausedState, {
      caller: callerA,
      roomLastSeq: asReadCursorSeq(10),
      ignoreUnread: true,
      activeRoomAgentIds: [agentA],
      nowMs: 1,
    });
    expect(agentDecision.allowed).toBe(false);

    const humanDecision = evaluatePreSendPolicy(pausedState, {
      caller: humanCaller,
      roomLastSeq: asReadCursorSeq(10),
      ignoreUnread: true,
      activeRoomAgentIds: [agentA],
      nowMs: 1,
    });
    expect(humanDecision.allowed).toBe(true);
  });
});
