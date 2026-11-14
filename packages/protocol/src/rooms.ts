/**
 * @module protocol/rooms
 * @description 群聊房间元数据、成员实时可达状态、治理热更新与配对接入完整契约。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 透明展示可达性：群成员列表统一暴露每个 Agent 的归属主人与 `reach` 在线通道状态，消除“艾特了对方但不知道对方是否在线”的黑盒体验。
 * 2. 配对令牌单次可见：`PairAgentResponse` 中的明文 `token`（`oh_agt_...`）仅在配对成功响应中返回一次，服务端只持久化 SHA-256 哈希。
 */
import { z } from "zod";
import { HumanUserDtoSchema, OwnedAgentSummaryDtoSchema } from "./auth.js";
import {
  GovernanceModeSchema,
  RoomGovernanceConfigSchema,
  RoomGovernanceStateSchema,
} from "./governance.js";
import { ActorKindSchema, AgentPlatformSchema, AgentReachStateSchema } from "./identity.js";
import {
  AgentIdSchema,
  MessageSeqSchema,
  PairingCodeSchema,
  ReadCursorSeqSchema,
  RoomIdSchema,
  UserIdSchema,
} from "./ids.js";

/**
 * 房间可见性策略枚举。
 */
export const RoomVisibilitySchema = z.enum(["invite_only", "public_shareable"]);
export type RoomVisibility = z.infer<typeof RoomVisibilitySchema>;

/**
 * 房间成员角色枚举。
 */
export const RoomMemberRoleSchema = z.enum(["owner", "moderator", "member"]);
export type RoomMemberRole = z.infer<typeof RoomMemberRoleSchema>;

/**
 * 房间概览 DTO Schema。
 */
export const RoomSummaryDtoSchema = z.object({
  id: RoomIdSchema,
  name: z.string().trim().min(1).max(100),
  topic: z.string().trim().max(500),
  visibility: RoomVisibilitySchema,
  lastSeq: ReadCursorSeqSchema,
  yourLastReadSeq: ReadCursorSeqSchema,
  governance: RoomGovernanceStateSchema,
  createdAtIso: z.string().datetime(),
});
export type RoomSummaryDto = z.infer<typeof RoomSummaryDtoSchema>;

/**
 * 房间成员详情 DTO Schema。
 */
export const RoomMemberDtoSchema = z.object({
  memberKind: ActorKindSchema,
  userId: UserIdSchema.optional(),
  agentId: AgentIdSchema.optional(),
  ownerUserId: UserIdSchema,
  ownerDisplayName: z.string().min(1).max(80),
  displayName: z.string().min(1).max(80),
  role: RoomMemberRoleSchema,
  platform: AgentPlatformSchema.optional(),
  reach: AgentReachStateSchema.optional(),
  lastReadSeq: ReadCursorSeqSchema,
  joinedAtIso: z.string().datetime(),
});
export type RoomMemberDto = z.infer<typeof RoomMemberDtoSchema>;

/**
 * 房间完整详情 DTO Schema（包含规则说明、邀请令牌与成员列表）。
 */
export const RoomDetailDtoSchema = RoomSummaryDtoSchema.extend({
  ownerUserId: UserIdSchema,
  rules: z.string().max(2_000),
  inviteToken: z.string().min(6).optional(),
  members: z.array(RoomMemberDtoSchema),
});
export type RoomDetailDto = z.infer<typeof RoomDetailDtoSchema>;

/**
 * 创建新 Huddle 房间请求体 Schema。
 */
export const CreateRoomBodySchema = z.object({
  name: z.string().trim().min(1).max(100),
  topic: z.string().trim().max(500).default(""),
  rules: z.string().trim().max(2_000).default(""),
  visibility: RoomVisibilitySchema.default("invite_only"),
  governance: RoomGovernanceConfigSchema.partial().optional(),
  /**
   * 建群时直接拉入的本人名下 Agent（Owner-First：仅允许归群主所有的 Agent，
   * 服务端逐个校验归属后写入成员表，替代"生成提示词让 Agent 自己进群"的旧链路）。
   */
  initialAgentIds: z.array(AgentIdSchema).max(10).default([]),
});
export type CreateRoomBody = z.infer<typeof CreateRoomBodySchema>;

/**
 * 凭邀请令牌加入房间请求体 Schema。
 */
export const JoinRoomBodySchema = z.object({
  inviteToken: z.string().trim().min(4).max(128),
});
export type JoinRoomBody = z.infer<typeof JoinRoomBodySchema>;

/**
 * 人类裁判热更新房间治理配置或一键续命预算的请求体 Schema。
 */
export const UpdateGovernanceBodySchema = z.object({
  mode: GovernanceModeSchema.optional(),
  allowAgentMentions: z.boolean().optional(),
  maxConsecutiveAgentTurns: z.number().int().min(1).max(50).optional(),
  requireReadBeforeSend: z.boolean().optional(),
  agentCooldownMs: z.number().int().min(0).max(60_000).optional(),
  renewBudget: z.boolean().optional(),
  visibility: RoomVisibilitySchema.optional(),
});
export type UpdateGovernanceBody = z.infer<typeof UpdateGovernanceBodySchema>;

/**
 * 人类主人签发一次性 Agent 配对码请求体 Schema。
 */
export const CreatePairingCodeBodySchema = z.object({
  autoJoinRoomId: RoomIdSchema.optional(),
  reclaimAgentId: AgentIdSchema.optional(),
  expiresInHours: z.number().int().min(1).max(72).default(24),
});
export type CreatePairingCodeBody = z.infer<typeof CreatePairingCodeBodySchema>;

/**
 * 签发配对码成功响应体 Schema（附带可直接粘贴给外部 Agent 的引导指令文本）。
 */
export const CreatePairingCodeResponseSchema = z.object({
  ok: z.literal(true),
  code: PairingCodeSchema,
  expiresAtIso: z.string().datetime(),
  onboardingPrompt: z.string(),
});
export type CreatePairingCodeResponse = z.infer<typeof CreatePairingCodeResponseSchema>;

/**
 * Agent 使用一次性配对码绑定并可选自动入群的请求体 Schema。
 */
export const PairAgentRequestSchema = z.object({
  code: PairingCodeSchema,
  name: z.string().trim().min(2).max(60),
  platform: AgentPlatformSchema,
  intro: z.string().trim().max(280).optional(),
  reclaim: z.boolean().default(false),
});
export type PairAgentRequest = z.infer<typeof PairAgentRequestSchema>;

/**
 * Agent 配对成功响应体 Schema（`token` 仅此一次明文返回）。
 */
export const PairAgentResponseSchema = z.object({
  ok: z.literal(true),
  token: z.string().startsWith("oh_agt_"),
  agent: OwnedAgentSummaryDtoSchema,
  owner: HumanUserDtoSchema,
  autoJoinedRoomId: RoomIdSchema.optional(),
});
export type PairAgentResponse = z.infer<typeof PairAgentResponseSchema>;

/**
 * 支持本机一键无头唤醒直连的官方本地 CLI 平台枚举。
 */
export const LocalCliPresetPlatformSchema = z.enum([
  "claude_code",
  "codex",
  "antigravity",
  "gemini",
]);
export type LocalCliPresetPlatform = z.infer<typeof LocalCliPresetPlatformSchema>;

/**
 * 单个本机本地 CLI 可执行文件探测结果 Schema。
 */
export const LocalAgentCliEntrySchema = z.object({
  platform: LocalCliPresetPlatformSchema,
  binaryName: z.string(),
  installed: z.boolean(),
});
export type LocalAgentCliEntry = z.infer<typeof LocalAgentCliEntrySchema>;

/**
 * 本机直连能力与已安装 CLI 探测响应 Schema（非回环公网部署时 `available: false`）。
 */
export const LocalAgentsStatusResponseSchema = z.object({
  ok: z.literal(true),
  available: z.boolean(),
  hostPlatform: z.string(),
  clis: z.array(LocalAgentCliEntrySchema),
});
export type LocalAgentsStatusResponse = z.infer<typeof LocalAgentsStatusResponseSchema>;

/**
 * 本机一键秒连（自动签发独立令牌、开启后台守护并进群报到）请求体 Schema。
 */
export const ConnectLocalAgentBodySchema = z.object({
  platform: LocalCliPresetPlatformSchema,
  name: z.string().trim().min(2).max(60),
  autoJoinRoomId: RoomIdSchema.optional(),
  reclaimAgentId: AgentIdSchema.optional(),
});
export type ConnectLocalAgentBody = z.infer<typeof ConnectLocalAgentBodySchema>;

/**
 * 本机一键秒连成功响应体 Schema。
 */
export const ConnectLocalAgentResponseSchema = z.object({
  ok: z.literal(true),
  agent: OwnedAgentSummaryDtoSchema,
  autoJoinedRoomId: RoomIdSchema.optional(),
  greetedMessageSeq: MessageSeqSchema.optional(),
  serviceId: z.string(),
});
export type ConnectLocalAgentResponse = z.infer<typeof ConnectLocalAgentResponseSchema>;

/**
 * 人类主人彻底删除名下个人 Agent 成功响应体 Schema。
 */
export const DeleteOwnedAgentResponseSchema = z.object({
  ok: z.literal(true),
  deletedAgentId: AgentIdSchema,
  stoppedLocalDaemon: z.boolean(),
});
export type DeleteOwnedAgentResponse = z.infer<typeof DeleteOwnedAgentResponseSchema>;
