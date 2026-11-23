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
 * 会话房间模态分类枚举（ADR-0005）。
 * - `group`：多方群聊协作与决策房间（Huddle）
 * - `direct_agent`：人类与单个 Agent 的 1v1 单聊会话（本人 Agent 或已开启 `allowExternalDm` 的外部 Agent）
 * - `direct_human`：两名已建立好友关系的人类用户之间的 1v1 私聊会话
 */
export const RoomKindSchema = z.enum(["group", "direct_agent", "direct_human"]);
export type RoomKind = z.infer<typeof RoomKindSchema>;

/**
 * 1v1 单聊会话针对当前查看者视角动态解析的对端身份信息 Schema（ADR-0005）。
 */
export const DirectChatPeerDtoSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("human"),
    userId: UserIdSchema,
    displayName: z.string().min(1).max(80),
    email: z.string().email().optional(),
  }),
  z.object({
    kind: z.literal("agent"),
    agentId: AgentIdSchema,
    displayName: z.string().min(1).max(80),
    slug: z.string().min(1).max(80),
    platform: AgentPlatformSchema,
    intro: z.string().max(280).optional(),
    reach: AgentReachStateSchema,
    ownerUserId: UserIdSchema,
    ownerDisplayName: z.string().min(1).max(80),
    allowExternalDm: z.boolean(),
  }),
]);
export type DirectChatPeerDto = z.infer<typeof DirectChatPeerDtoSchema>;

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
  kind: RoomKindSchema.default("group"),
  ownerUserId: UserIdSchema,
  name: z.string().trim().min(1).max(100),
  topic: z.string().trim().max(500),
  visibility: RoomVisibilitySchema,
  lastSeq: ReadCursorSeqSchema,
  yourLastReadSeq: ReadCursorSeqSchema,
  governance: RoomGovernanceStateSchema,
  peer: DirectChatPeerDtoSchema.optional(),
  createdAtIso: z.string().datetime(),
});
export type RoomSummaryDto = z.infer<typeof RoomSummaryDtoSchema>;

/** 群备注为单行文本。清空备注时使用空字符串，读接口省略未设置的备注。 */
const RoomMemberRemarkSchema = z
  .string()
  .trim()
  .max(80)
  .refine(
    (value) => !value.includes("\0") && !/[\r\n\u2028\u2029]/u.test(value),
    "Room remark must be single-line text",
  );

/**
 * 房间成员详情 DTO Schema。
 * @remarks `remark` 是群内显示名，`displayName` 是账号昵称。
 */
export const RoomMemberDtoSchema = z.object({
  memberKind: ActorKindSchema,
  userId: UserIdSchema.optional(),
  agentId: AgentIdSchema.optional(),
  ownerUserId: UserIdSchema,
  ownerDisplayName: z.string().min(1).max(80),
  displayName: z.string().min(1).max(80),
  remark: RoomMemberRemarkSchema.optional(),
  slug: z.string().min(1).max(80).optional(),
  intro: z.string().max(280).optional(),
  allowExternalDm: z.boolean().optional(),
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
  /**
   * 建群时直接拉入的已添加人类好友列表（ADR-0005：服务端逐个校验双方 `accepted` 好友关系）。
   */
  initialUserIds: z.array(UserIdSchema).max(50).default([]),
});
export type CreateRoomBody = z.infer<typeof CreateRoomBodySchema>;

/**
 * 向现有群聊房间直接拉入好友或本人名下 Agent 的请求体 Schema（ADR-0005）。
 */
export const AddRoomMembersBodySchema = z
  .object({
    userIds: z.array(UserIdSchema).max(50).default([]),
    agentIds: z.array(AgentIdSchema).max(20).default([]),
  })
  .refine(
    (val) => val.userIds.length > 0 || val.agentIds.length > 0,
    "At least one userId or agentId must be provided",
  );
export type AddRoomMembersBody = z.infer<typeof AddRoomMembersBodySchema>;

/** 修改本人群备注的请求。空白字符串清除备注，成员身份由会话确定。 */
export const UpdateOwnRoomRemarkBodySchema = z.object({ remark: RoomMemberRemarkSchema }).strict();
/** 修改本人群备注的请求类型。 */
export type UpdateOwnRoomRemarkBody = z.infer<typeof UpdateOwnRoomRemarkBodySchema>;

/** 已保存的群备注，清除时返回 `null`。 */
export const UpdateOwnRoomRemarkResponseSchema = z.object({
  ok: z.literal(true),
  remark: RoomMemberRemarkSchema.nullable(),
});
/** 修改本人群备注的成功响应类型。 */
export type UpdateOwnRoomRemarkResponse = z.infer<typeof UpdateOwnRoomRemarkResponseSchema>;

/**
 * 打开或幂等复用与指定 Agent 的 1v1 单聊会话请求体 Schema（ADR-0005）。
 */
export const OpenDirectAgentRoomBodySchema = z.object({
  agentId: AgentIdSchema,
});
export type OpenDirectAgentRoomBody = z.infer<typeof OpenDirectAgentRoomBodySchema>;

/**
 * 打开或幂等复用与指定人类好友的 1v1 私聊会话请求体 Schema（ADR-0005）。
 */
export const OpenDirectHumanRoomBodySchema = z.object({
  targetUserId: UserIdSchema,
});
export type OpenDirectHumanRoomBody = z.infer<typeof OpenDirectHumanRoomBodySchema>;

/**
 * 打开或复用 1v1 单聊会话成功响应体 Schema（`created` 标识本次是否为首次创建）。
 */
export const OpenDirectRoomResponseSchema = z.object({
  ok: z.literal(true),
  created: z.boolean(),
  room: RoomDetailDtoSchema,
});
export type OpenDirectRoomResponse = z.infer<typeof OpenDirectRoomResponseSchema>;

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

/** 已登录主人签发接入链接时可授权加入一个群聊或恢复指定身份。 */
export const CreateAgentConnectionBodySchema = CreatePairingCodeBodySchema.omit({
  expiresInHours: true,
});
/** 接入链接的授权范围，服务端验证归属与群成员资格。 */
export type CreateAgentConnectionBody = z.infer<typeof CreateAgentConnectionBodySchema>;

/** 一次性接入链接仅在签发响应中明文返回，授权位于 URL 片段。 */
export const CreateAgentConnectionResponseSchema = z.object({
  ok: z.literal(true),
  connectUrl: z.string().url(),
  expiresAtIso: z.string().datetime(),
});
/** 签发给个人 Agent 的接入链接及过期时间。 */
export type CreateAgentConnectionResponse = z.infer<typeof CreateAgentConnectionResponseSchema>;

/** CLI 从链接片段取得授权，恢复身份及入群范围以服务端签发记录为准。 */
export const RedeemAgentConnectionBodySchema = PairAgentRequestSchema.omit({
  code: true,
  reclaim: true,
}).extend({
  connectionToken: z.string().regex(/^oh_connect_[nr][ag]_[A-Za-z0-9_-]{43}$/),
});
/** 接入授权及 Agent 的基本资料。 */
export type RedeemAgentConnectionBody = z.infer<typeof RedeemAgentConnectionBodySchema>;

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
 * 人类主人更新名下指定 Agent 资料或外部私聊权限请求体 Schema（ADR-0005）。
 */
export const UpdateOwnedAgentBodySchema = z.object({
  displayName: z.string().trim().min(2).max(60).optional(),
  intro: z.string().trim().max(280).optional(),
  allowExternalDm: z.boolean().optional(),
});
export type UpdateOwnedAgentBody = z.infer<typeof UpdateOwnedAgentBodySchema>;

/**
 * 人类主人更新名下指定 Agent 成功响应体 Schema。
 */
export const UpdateOwnedAgentResponseSchema = z.object({
  ok: z.literal(true),
  agent: OwnedAgentSummaryDtoSchema,
});
export type UpdateOwnedAgentResponse = z.infer<typeof UpdateOwnedAgentResponseSchema>;

/**
 * 人类主人彻底删除名下个人 Agent 成功响应体 Schema。
 */
export const DeleteOwnedAgentResponseSchema = z.object({
  ok: z.literal(true),
  deletedAgentId: AgentIdSchema,
  stoppedLocalDaemon: z.boolean(),
});
export type DeleteOwnedAgentResponse = z.infer<typeof DeleteOwnedAgentResponseSchema>;

/**
 * 人类群主彻底删除群聊房间成功响应体 Schema。
 */
export const DeleteRoomResponseSchema = z.object({
  ok: z.literal(true),
  deletedRoomId: RoomIdSchema,
});
export type DeleteRoomResponse = z.infer<typeof DeleteRoomResponseSchema>;
