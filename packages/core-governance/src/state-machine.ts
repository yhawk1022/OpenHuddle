/**
 * @module core-governance/state-machine
 * @description 群聊治理纯函数状态机（Functional Core）。
 *
 * 关键不变量：
 * 1. 确定性零 I/O：严禁读取数据库、网络或 `Date.now()`，时间戳一律通过 `nowMs` 显式注入。
 * 2. 人类优先裁决：人类发言不受 `paused_budget`、冷却窗口或圆桌顺序拦截，且发言后立即清零连续 Agent 计数并恢复 `active`。
 * 3. 唤醒风暴熔断：连续 Agent 发言触及 `maxConsecutiveAgentTurns` 或关闭 `allowAgentMentions` 时，立即清空自动派发的 `wake` 名单。
 * 4. 在席成员收敛：候选唤醒目标与圆桌进度仅保留仍在当前房间内的 `activeRoomAgentIds`，防止已退群 Agent 残留幽灵状态。
 */
import type {
  AgentId,
  AuthenticatedCaller,
  ErrorCode,
  ReadCursorSeq,
  RoomGovernanceState,
} from "@openhuddle/protocol";

/**
 * 发言前治理策略校验所需的只读上下文。
 */
export interface PreSendPolicyContext {
  readonly caller: AuthenticatedCaller;
  readonly roomLastSeq: ReadCursorSeq;
  readonly callerLastReadSeq?: ReadCursorSeq;
  readonly ignoreUnread: boolean;
  readonly activeRoomAgentIds: readonly AgentId[];
  readonly nowMs: number;
}

/**
 * 发言前治理策略裁决结果（可辨识联合类型）。
 */
export type PreSendPolicyDecision =
  | {
      readonly allowed: true;
    }
  | {
      readonly allowed: false;
      readonly errorCode: Extract<
        ErrorCode,
        | "GOVERNANCE_BUDGET_PAUSED"
        | "CONFLICT_UNREAD_MESSAGES"
        | "GOVERNANCE_COOLDOWN_ACTIVE"
        | "GOVERNANCE_ROUND_TABLE_WAIT"
      >;
      readonly reason: string;
      readonly retryAfterMs?: number;
    };

/**
 * 消息成功写入事务后，用于推进治理状态机并筛选唤醒名单的输入事件。
 */
export interface CommittedMessageTurn {
  readonly sender: AuthenticatedCaller;
  readonly candidateWakeAgentIds: readonly AgentId[];
  readonly activeRoomAgentIds: readonly AgentId[];
  readonly nowMs: number;
}

/**
 * 消息落库后的治理状态演进与最终获准唤醒目标集合。
 */
export interface PostTurnTransitionResult {
  readonly nextState: RoomGovernanceState;
  readonly permittedWakeAgentIds: readonly AgentId[];
  readonly budgetJustExhausted: boolean;
}

/**
 * 在消息写入数据库前，校验调用者是否满足房间治理策略与乐观并发读锁。
 *
 * @remarks
 * 优先级固定为：人类豁免 -> 预算挂起锁 -> 乐观未读锁（`409`） -> 单 Agent 冷却窗口 -> 圆桌轮流约束。
 *
 * @param state - 当前房间治理状态快照
 * @param context - 调用者身份、游标与显式时间戳
 * @returns 放行或携带协议错误码的拦截决策
 */
export function evaluatePreSendPolicy(
  state: Readonly<RoomGovernanceState>,
  context: Readonly<PreSendPolicyContext>,
): PreSendPolicyDecision {
  // 人类拥有最高插话与破局权，不受自动化节流限制
  if (context.caller.kind === "human") {
    return { allowed: true };
  }

  const agentId = context.caller.agentId;

  if (state.status === "paused_budget") {
    return {
      allowed: false,
      errorCode: "GOVERNANCE_BUDGET_PAUSED",
      reason: `Room has reached maxConsecutiveAgentTurns (${state.config.maxConsecutiveAgentTurns}); awaiting human guidance or budget renewal.`,
    };
  }

  // 乐观并发读锁：要求 Agent 先读完最新消息再发言，避免多 Agent 被同时唤醒后重复抢答
  if (state.config.requireReadBeforeSend && !context.ignoreUnread) {
    const readSeq = context.callerLastReadSeq ?? (0 as ReadCursorSeq);
    if (readSeq < context.roomLastSeq) {
      return {
        allowed: false,
        errorCode: "CONFLICT_UNREAD_MESSAGES",
        reason: `Unread messages detected (lastReadSeq=${readSeq}, roomLastSeq=${context.roomLastSeq}). Read missed messages before sending.`,
      };
    }
  }

  // 单 Agent 冷却窗口：抑制异常守护脚本在毫秒级高频连发
  const lastSpokenAt = state.lastSpokenAtByAgentMs[agentId];
  if (lastSpokenAt !== undefined && state.config.agentCooldownMs > 0) {
    const elapsedMs = context.nowMs - lastSpokenAt;
    if (elapsedMs < state.config.agentCooldownMs) {
      const waitMs = state.config.agentCooldownMs - elapsedMs;
      return {
        allowed: false,
        errorCode: "GOVERNANCE_COOLDOWN_ACTIVE",
        reason: `Agent cooldown active; wait ${waitMs}ms before sending again.`,
        retryAfterMs: waitMs,
      };
    }
  }

  // 圆桌模式：在所有在席 Agent 完成本轮首次表态前，已表态 Agent 不得提前进入下一轮
  if (state.config.mode === "round_table" && context.activeRoomAgentIds.length > 1) {
    const spokenSet = new Set<AgentId>(state.roundTableSpokenAgentIds);
    if (spokenSet.has(agentId)) {
      let remainingCount = 0;
      for (const activeId of context.activeRoomAgentIds) {
        if (!spokenSet.has(activeId)) {
          remainingCount += 1;
        }
      }
      if (remainingCount > 0) {
        return {
          allowed: false,
          errorCode: "GOVERNANCE_ROUND_TABLE_WAIT",
          reason: `Round-table mode active; waiting for ${remainingCount} other agent(s) to finish their turn first.`,
        };
      }
    }
  }

  return { allowed: true };
}

/**
 * 消息写入后推进房间治理状态机，并收敛最终允许派发 `wake` 事件的目标 Agent 列表。
 *
 * @param state - 写入前的房间治理状态快照（只读）
 * @param turn - 发送者、候选唤醒列表、在席 Agent 列表与当前时间戳
 * @returns 新治理状态快照及去重后的获准唤醒 Agent ID 列表
 */
export function applyCommittedMessageTurn(
  state: Readonly<RoomGovernanceState>,
  turn: Readonly<CommittedMessageTurn>,
): PostTurnTransitionResult {
  const activeSet = new Set<AgentId>(turn.activeRoomAgentIds);
  const seenWakeTargets = new Set<AgentId>();
  const deduplicatedTargets: AgentId[] = [];

  // 仅保留当前仍在席的 Agent，且排除发送者自身以防单 Agent 自激死循环
  for (const targetId of turn.candidateWakeAgentIds) {
    if (!activeSet.has(targetId) || seenWakeTargets.has(targetId)) {
      continue;
    }
    if (turn.sender.kind === "agent" && turn.sender.agentId === targetId) {
      continue;
    }
    seenWakeTargets.add(targetId);
    deduplicatedTargets.push(targetId);
  }

  // 人类发言：重置连续 Agent 轮次、解除预算挂起态并开启新一轮圆桌
  if (turn.sender.kind === "human") {
    return {
      nextState: {
        config: state.config,
        status: "active",
        consecutiveAgentTurns: 0,
        roundTableSpokenAgentIds: [],
        lastSpokenAtByAgentMs: { ...state.lastSpokenAtByAgentMs },
      },
      permittedWakeAgentIds: deduplicatedTargets,
      budgetJustExhausted: false,
    };
  }

  const senderId = turn.sender.agentId;
  const nextConsecutiveTurns = state.consecutiveAgentTurns + 1;
  const budgetJustExhausted = nextConsecutiveTurns >= state.config.maxConsecutiveAgentTurns;
  const nextStatus = budgetJustExhausted ? "paused_budget" : state.status;

  // 同步剔除中途已移出房间的旧 Agent ID；若全体在席 Agent 均已发言则清空本轮记录开启下一轮
  const updatedRoundSet = new Set<AgentId>();
  for (const id of state.roundTableSpokenAgentIds) {
    if (activeSet.has(id)) {
      updatedRoundSet.add(id);
    }
  }
  if (activeSet.has(senderId)) {
    updatedRoundSet.add(senderId);
  }

  const allActiveAgentsHaveSpoken =
    turn.activeRoomAgentIds.length > 0 &&
    turn.activeRoomAgentIds.every((id) => updatedRoundSet.has(id));

  const nextRoundTableSpoken = allActiveAgentsHaveSpoken ? [] : Array.from(updatedRoundSet);
  const canAgentTriggerWake = state.config.allowAgentMentions && !budgetJustExhausted;

  return {
    nextState: {
      config: state.config,
      status: nextStatus,
      consecutiveAgentTurns: nextConsecutiveTurns,
      roundTableSpokenAgentIds: nextRoundTableSpoken,
      lastSpokenAtByAgentMs: {
        ...state.lastSpokenAtByAgentMs,
        [senderId]: turn.nowMs,
      },
    },
    permittedWakeAgentIds: canAgentTriggerWake ? deduplicatedTargets : [],
    budgetJustExhausted,
  };
}

/**
 * 人类在控制台重置连续发言预算时的状态转换。
 *
 * @param state - 当前房间治理状态快照
 * @returns 恢复为 `active` 且连续 Agent 计数归零的新快照
 */
export function renewTurnBudget(state: Readonly<RoomGovernanceState>): RoomGovernanceState {
  return {
    config: state.config,
    status: "active",
    consecutiveAgentTurns: 0,
    roundTableSpokenAgentIds: [...state.roundTableSpokenAgentIds],
    lastSpokenAtByAgentMs: { ...state.lastSpokenAtByAgentMs },
  };
}
