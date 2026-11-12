/**
 * @module protocol
 * @description `@openhuddle/protocol` 统一公共导出入口。
 *
 * 架构职责与关键不变量：
 * 作为全栈四端（Server / Web / CLI / MCP）与纯函数领域核的唯一契约包，仅暴露具名导出（Named Exports）。
 */
export {
  AgentIdSchema,
  asMessageSeq,
  asReadCursorSeq,
  MessageSeqSchema,
  OperationKeySchema,
  PairingCodeSchema,
  ProposalIdSchema,
  ReadCursorSeqSchema,
  RoomIdSchema,
  UserIdSchema,
  type AgentId,
  type Brand,
  type MessageSeq,
  type OperationKey,
  type PairingCode,
  type ProposalId,
  type ReadCursorSeq,
  type RoomId,
  type UserId,
} from "./ids.js";

export {
  ApiErrorEnvelopeSchema,
  assertNever,
  ErrorCodeSchema,
  type ApiErrorEnvelope,
  type ErrorCode,
} from "./errors.js";

export {
  ActorKindSchema,
  AgentPlatformSchema,
  AgentReachStateSchema,
  AuthorStampSchema,
  computeAuthorStamp,
  TrustLevelSchema,
  type ActorKind,
  type AgentPlatform,
  type AgentReachState,
  type AuthenticatedCaller,
  type AuthorStamp,
  type RawAuthorIdentity,
  type TrustLevel,
} from "./identity.js";

export {
  createDefaultGovernanceState,
  DEFAULT_AGENT_COOLDOWN_MS,
  DEFAULT_MAX_CONSECUTIVE_AGENT_TURNS,
  GovernanceModeSchema,
  RoomGovernanceConfigSchema,
  RoomGovernanceStateSchema,
  RoomGovernanceStatusSchema,
  type GovernanceMode,
  type RoomGovernanceConfig,
  type RoomGovernanceState,
  type RoomGovernanceStatus,
} from "./governance.js";

export {
  MessageDtoSchema,
  MessageMentionSchema,
  MessageTypeSchema,
  SendMessageRequestSchema,
  UnreadConflictDetailsSchema,
  type MessageDto,
  type MessageMention,
  type MessageType,
  type SendMessageRequest,
  type UnreadConflictDetails,
} from "./messages.js";

export {
  ProposalCardDtoSchema,
  ProposalDraftSchema,
  ProposalOptionSchema,
  ProposalStatusSchema,
  ProposalVoteDtoSchema,
  ProposalVoteStanceSchema,
  type ProposalCardDto,
  type ProposalDraft,
  type ProposalOption,
  type ProposalStatus,
  type ProposalVoteDto,
  type ProposalVoteStance,
} from "./proposals.js";

export {
  PairAgentRequestSchema,
  RoomMemberDtoSchema,
  RoomMemberRoleSchema,
  RoomSummaryDtoSchema,
  RoomVisibilitySchema,
  type PairAgentRequest,
  type RoomMemberDto,
  type RoomMemberRole,
  type RoomSummaryDto,
  type RoomVisibility,
} from "./rooms.js";

export {
  SseEventSchema,
  WakeReasonSchema,
  type SseEvent,
  type WakeReason,
} from "./events.js";
