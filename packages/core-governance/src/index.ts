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

export { scrubReviewPatch, scrubWorkProvenance, scrubWorkText } from "./secret-redact.js";

export {
  WORK_AGENT_STOP_INSTRUCTION,
  WorkAgentAttention,
  checkAgentWorkOutput,
  parseWorkVerdict,
  type AgentAttention,
  type ParsedWorkVerdict,
} from "./work-agent-attention.js";

export {
  DEFAULT_SLICE_LEASE_TTL_MS,
  detectOwnedPathConflicts,
  evaluateHumanReviewDecision,
  evaluateRaiseSliceAttention,
  evaluateSliceClaim,
  evaluateSliceCompletion,
  evaluateSliceHeartbeat,
  evaluateWorkspaceExecutionAccess,
  MAX_SLICE_ATTEMPTS,
  normalizeOwnedPathPrefix,
  recentWorkSteerNotes,
  type OrchestrationItemState,
  type OrchestrationReviewState,
  type OrchestrationSliceState,
  type OwnedPathConflict,
  type SlicePathCheckInput,
  type WorkDomainRejection,
  type WorkspaceExecutionAccessInput,
} from "./work-orchestration.js";
