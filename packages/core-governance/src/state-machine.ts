/**
 * @module core-governance/state-machine
 * @description 零外部 I/O 依赖的群聊治理纯函数状态机（Functional Core）。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 纯净确定性：本模块禁止引入数据库、网络或 `Date.now()`，所有时间戳通过参数 `nowMs` 显式注入，给定相同输入必产出完全一致的状态与唤醒决策。
 * 2. 人类最高裁决权（Human Override）：任何人类成员的发言永远不受 `paused_budget`、冷却锁或圆桌顺序拦截，且人类一发言立即重置连续 Agent 轮次计数并恢复 `active`。
 * 3. 防互 `@` 死循环硬熔断：当连续 Agent 发言达到 `maxConsecutiveAgentTurns` 或 `allowAgentMentions === false` 时，必须清零自动派发的 Agent 唤醒名单，从源头斩断链式唤醒风暴。
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
 * 在消息写入数据库前，纯函数校验当前调用者是否满足房间治理策略与乐观并发读锁。
 *
 * @remarks
 * 校验优先级顺序：
 * 1. 人类豁免直接放行；
 * 2. 预算挂起锁（`paused_budget`）；
 * 3. 乐观并发未读锁（`requireReadBeforeSend` -> `409 CONFLICT_UNREAD_MESSAGES`）；
 * 4. 单 Agent 发言冷却窗口（`agentCooldownMs`）；
 * 5. 圆桌轮流表态约束（`round_table`）。
 *
 * @param state - 当前房间治理状态快照
 * @param context - 本次发送请求的调用者、游标与时间上下文
 * @returns 放行或携带明确协议错误码的拦截决策
 */
export function evaluatePreSendPolicy(
  state: Readonly<RoomGovernanceState>,
  context: Readonly<PreSendPolicyContext>,
): PreSendPolicyDecision {
  // 不变量：人类始终拥有插话引导与打破僵局的最高权限，不受任何自动化节流拦截
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

  // 乐观并发防抢话锁：强制 Agent 在发言前读完房间最新消息，防止多个被同时唤醒的 Agent 重复回答同一问题
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

  // 冷却限流：防止异常本地脚本在毫秒内高频连发刷屏
  const lastSpokenAt = state.lastSpokenAtByAgentMs[agentId];
  if (lastSpokenAt !== undefined && state.config.agentCooldownMs > 0) {
    const elapsedMs = context.nowMs - lastSpokenAt;
    if (elapsedMs < state.config.agentCooldownMs) {
      return {
        allowed: false,
        errorCode: "GOVERNANCE_COOLDOWN_ACTIVE",
        reason: `Agent cooldown active; wait ${state.config.agentCooldownMs - elapsedMs}ms before sending again.`,
        retryAfterMs: state.config.agentCooldownMs - elapsedMs,
      };
    }
  }

  // 圆桌模式：在房间内所有在席 Agent 完成本轮首次发言前，已发言 Agent 不得抢占第二轮
  if (state.config.mode === "round_table" && context.activeRoomAgentIds.length > 1) {
    const alreadySpokeInRound = state.roundTableSpokenAgentIds.includes(agentId);
    const remainingAgents = context.activeRoomAgentIds.filter(
      (id) => !state.roundTableSpokenAgentIds.includes(id),
    );
    if (alreadySpokeInRound && remainingAgents.length > 0) {
      return {
        allowed: false,
        errorCode: "GOVERNANCE_ROUND_TABLE_WAIT",
        reason: `Round-table mode active; waiting for ${remainingAgents.length} other agent(s) to finish their turn first.`,
      };
    }
  }

  return { allowed: true };
}

/**
 * 在消息确认写入后推进房间治理状态机，并过滤允许派发实时 `wake` 事件的目标 Agent 列表。
 *
 * @param state - 写入前的房间治理状态快照（只读，内部不会就地修改）
 * @param turn - 本次写入消息的发送者、候选唤醒列表与显式时间戳
 * @returns 不可变的新治理状态快照及最终获准唤醒的去重 Agent ID 数组
 */
export function applyCommittedMessageTurn(
  state: Readonly<RoomGovernanceState>,
  turn: Readonly<CommittedMessageTurn>,
): PostTurnTransitionResult {
  // 去重并排除发送者自身（任何情况下绝不自己唤醒自己，防止单 Agent 自激死循环）
  const deduplicatedTargets = Array.from(new Set(turn.candidateWakeAgentIds)).filter(
    (targetId) => !(turn.sender.kind === "agent" && turn.sender.agentId === targetId),
  );

  // 人类发言：自动清零连续 Agent 计数、解除预算挂起态、开启新一轮圆桌并正常派发所有目标唤醒
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

  // Agent 发言：累加连续轮次并更新冷却时间戳与圆桌进度
  const senderId = turn.sender.agentId;
  const nextConsecutiveTurns = state.consecutiveAgentTurns + 1;
  const budgetJustExhausted = nextConsecutiveTurns >= state.config.maxConsecutiveAgentTurns;
  const nextStatus = budgetJustExhausted ? "paused_budget" : state.status;

  // 计算圆桌进度：若所有在席 Agent 均已表态完毕，则自动清空本轮记录以开启下一轮交叉评议
  const updatedRoundSpoken = state.roundTableSpokenAgentIds.includes(senderId)
    ? [...state.roundTableSpokenAgentIds]
    : [...state.roundTableSpokenAgentIds, senderId];

  const allActiveAgentsHaveSpoken =
    turn.activeRoomAgentIds.length > 0 &&
    turn.activeRoomAgentIds.every((id) => updatedRoundSpoken.includes(id));

  const nextRoundTableSpoken = allActiveAgentsHaveSpoken ? [] : updatedRoundSpoken;

  // 熔断判定：若关闭了 Agent 互 @ 唤醒，或本条消息正好耗尽了连续发言预算，则阻断所有后续自动唤醒
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
 * 人类在裁判控制台点击「继续讨论（重置轮次预算）」时的纯函数状态转换。
 *
 * @param state - 当前房间治理状态快照
 * @returns 恢复为 `active` 且连续 Agent 发言计数归零的新状态快照
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
