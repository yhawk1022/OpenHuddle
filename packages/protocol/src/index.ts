/**
 * @module protocol
 * @description `@openhuddle/protocol` 统一公共导出入口。
 *
 * 架构职责与关键不变量：
 * 作为全栈四端（Server / Web / CLI / MCP）与纯函数领域核的唯一契约包，仅暴露具名导出（Named Exports）。
 */
export {
  HumanUserDtoSchema,
  MeResponseSchema,
  OwnedAgentSummaryDtoSchema,
  RequestOtpBodySchema,
  RequestOtpResponseSchema,
  UpdateMeBodySchema,
  VerifyOtpBodySchema,
  VerifyOtpResponseSchema,
  type HumanUserDto,
  type MeResponse,
  type OwnedAgentSummaryDto,
  type RequestOtpBody,
  type RequestOtpResponse,
  type UpdateMeBody,
  type VerifyOtpBody,
  type VerifyOtpResponse,
} from "./auth.js";

export {
  ApiErrorEnvelopeSchema,
  assertNever,
  ErrorCodeSchema,
  type ApiErrorEnvelope,
  type ErrorCode,
} from "./errors.js";

export {
  InboxResponseSchema,
  InboxRoomSummarySchema,
  SseEventSchema,
  WakeReasonSchema,
  type InboxResponse,
  type InboxRoomSummary,
  type SseEvent,
  type WakeReason,
} from "./events.js";

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
  CastProposalVoteBodySchema,
  DecideProposalBodySchema,
  ProposalCardDtoSchema,
  ProposalDraftSchema,
  ProposalOptionSchema,
  ProposalStatusSchema,
  ProposalVoteDtoSchema,
  ProposalVoteStanceSchema,
  SynthesizeProposalBodySchema,
  type CastProposalVoteBody,
  type DecideProposalBody,
  type ProposalCardDto,
  type ProposalDraft,
  type ProposalOption,
  type ProposalStatus,
  type ProposalVoteDto,
  type ProposalVoteStance,
  type SynthesizeProposalBody,
} from "./proposals.js";

export {
  ConnectLocalAgentBodySchema,
  ConnectLocalAgentResponseSchema,
  CreatePairingCodeBodySchema,
  CreatePairingCodeResponseSchema,
  CreateRoomBodySchema,
  DeleteOwnedAgentResponseSchema,
  JoinRoomBodySchema,
  LocalAgentCliEntrySchema,
  LocalAgentsStatusResponseSchema,
  LocalCliPresetPlatformSchema,
  PairAgentRequestSchema,
  PairAgentResponseSchema,
  RoomDetailDtoSchema,
  RoomMemberDtoSchema,
  RoomMemberRoleSchema,
  RoomSummaryDtoSchema,
  RoomVisibilitySchema,
  UpdateGovernanceBodySchema,
  type ConnectLocalAgentBody,
  type ConnectLocalAgentResponse,
  type CreatePairingCodeBody,
  type CreatePairingCodeResponse,
  type CreateRoomBody,
  type DeleteOwnedAgentResponse,
  type JoinRoomBody,
  type LocalAgentCliEntry,
  type LocalAgentsStatusResponse,
  type LocalCliPresetPlatform,
  type PairAgentRequest,
  type PairAgentResponse,
  type RoomDetailDto,
  type RoomMemberDto,
  type RoomMemberRole,
  type RoomSummaryDto,
  type RoomVisibility,
  type UpdateGovernanceBody,
} from "./rooms.js";
