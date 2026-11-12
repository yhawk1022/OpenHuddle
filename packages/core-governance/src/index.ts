/**
 * @module core-governance
 * @description `@openhuddle/core-governance` 统一公共导出入口。
 */
export {
  applyCommittedMessageTurn,
  evaluatePreSendPolicy,
  renewTurnBudget,
  type CommittedMessageTurn,
  type PostTurnTransitionResult,
  type PreSendPolicyContext,
  type PreSendPolicyDecision,
} from "./state-machine.js";
