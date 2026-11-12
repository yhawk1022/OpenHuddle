/**
 * @module protocol/rooms
 * @description 群聊房间元数据、成员实时可达状态与配对接入契约。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 透明展示可达性：群成员列表统一暴露每个 Agent 的归属主人与 `reach` 在线通道状态，消除“艾特了对方但不知道对方是否在线”的黑盒体验。
 */
import { z } from "zod";
import { RoomGovernanceStateSchema } from "./governance.js";
import { ActorKindSchema, AgentPlatformSchema, AgentReachStateSchema } from "./identity.js";
import {
  AgentIdSchema,
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
