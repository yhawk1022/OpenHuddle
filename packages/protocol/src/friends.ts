/**
 * @module protocol/friends
 * @description 站内用户检索、好友申请制状态机（申请 / 同意 / 拒绝 / 解除）与跨主人开放私聊 Agent 发现契约（ADR-0005）。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 隐私最小暴露：公开用户检索与好友名片仅返回脱敏 `PublicUserProfileDto`（`userId`, `displayName`, `email`），严禁包含密码哈希或会话信息。
 * 2. 好友附言零指令权：`SendFriendRequestBody.note` 仅供人类接收方核对身份，永不进入任何 Agent 上下文或触发执行授权。
 * 3. 好友备注仅对设置备注的人类用户可见，随其通讯录联系人返回。
 */
import { z } from "zod";
import { AgentPlatformSchema, AgentReachStateSchema } from "./identity.js";
import { AgentIdSchema, FriendshipIdSchema, RoomIdSchema, UserIdSchema } from "./ids.js";

/**
 * 当前登录用户与目标人类用户之间的社交关系状态枚举。
 */
export const UserRelationshipStatusSchema = z.enum([
  "self",
  "friends",
  "incoming_pending",
  "outgoing_pending",
  "none",
]);
export type UserRelationshipStatus = z.infer<typeof UserRelationshipStatusSchema>;

/**
 * 面向站内通讯录与搜索展示的人类公开名片 DTO Schema。
 */
export const PublicUserProfileDtoSchema = z.object({
  userId: UserIdSchema,
  displayName: z.string().min(1).max(80),
  email: z.string().email(),
});
export type PublicUserProfileDto = z.infer<typeof PublicUserProfileDtoSchema>;

/**
 * 由其他人类主人显式开启 `allowExternalDm: true` 的可私聊个人 Agent 概览 DTO Schema。
 */
export const SharedExternalAgentDtoSchema = z.object({
  id: AgentIdSchema,
  ownerUserId: UserIdSchema,
  ownerDisplayName: z.string().min(1).max(80),
  displayName: z.string().min(1).max(80),
  slug: z.string().min(1).max(80),
  platform: AgentPlatformSchema,
  intro: z.string().max(280).optional(),
  reach: AgentReachStateSchema,
  allowExternalDm: z.literal(true),
});
export type SharedExternalAgentDto = z.infer<typeof SharedExternalAgentDtoSchema>;

/** 好友私有备注的单行文本长度上限，与 Web 输入框共享。 */
export const MAX_FRIEND_REMARK_LENGTH = 80;

const FriendRemarkSchema = z
  .string()
  .trim()
  .max(MAX_FRIEND_REMARK_LENGTH)
  .refine(
    (value) => !value.includes("\0") && !/[\r\n\u2028\u2029]/u.test(value),
    "Friend remark must be single-line text",
  );

/**
 * 已建立好友关系的人类联系人条目 DTO Schema，包含调用者设置的可选私有备注。
 */
export const FriendContactDtoSchema = z.object({
  friendshipId: FriendshipIdSchema,
  user: PublicUserProfileDtoSchema,
  remark: FriendRemarkSchema.optional(),
  friendsSinceIso: z.string().datetime(),
  directRoomId: RoomIdSchema.optional(),
  sharedAgents: z.array(SharedExternalAgentDtoSchema),
});
export type FriendContactDto = z.infer<typeof FriendContactDtoSchema>;

/**
 * 待处理的好友申请条目 DTO Schema（区分收到的申请 `incoming` 与发出的申请 `outgoing`）。
 */
export const FriendRequestDtoSchema = z.object({
  friendshipId: FriendshipIdSchema,
  direction: z.enum(["incoming", "outgoing"]),
  peer: PublicUserProfileDtoSchema,
  note: z.string().max(240).optional(),
  createdAtIso: z.string().datetime(),
});
export type FriendRequestDto = z.infer<typeof FriendRequestDtoSchema>;

/**
 * `GET /api/v1/friends` 通讯录全量视图响应体 Schema（含好友列表、收发待审申请与全站开放私聊的外部 Agent）。
 */
export const FriendsOverviewResponseSchema = z.object({
  ok: z.literal(true),
  friends: z.array(FriendContactDtoSchema),
  incomingRequests: z.array(FriendRequestDtoSchema),
  outgoingRequests: z.array(FriendRequestDtoSchema),
  discoverableAgents: z.array(SharedExternalAgentDtoSchema),
});
export type FriendsOverviewResponse = z.infer<typeof FriendsOverviewResponseSchema>;

/**
 * `GET /api/v1/users/search` 站内用户搜索查询参数 Schema。
 */
export const DirectoryUserSearchQuerySchema = z.object({
  q: z.string().trim().min(1).max(120),
});
export type DirectoryUserSearchQuery = z.infer<typeof DirectoryUserSearchQuerySchema>;

/**
 * 站内用户搜索单条命中结果 DTO Schema。
 */
export const DirectoryUserSearchItemDtoSchema = z.object({
  user: PublicUserProfileDtoSchema,
  relationship: UserRelationshipStatusSchema,
  friendshipId: FriendshipIdSchema.optional(),
  sharedAgentCount: z.number().int().min(0),
});
export type DirectoryUserSearchItemDto = z.infer<typeof DirectoryUserSearchItemDtoSchema>;

/**
 * 站内用户搜索响应体 Schema。
 */
export const DirectoryUserSearchResponseSchema = z.object({
  ok: z.literal(true),
  users: z.array(DirectoryUserSearchItemDtoSchema),
});
export type DirectoryUserSearchResponse = z.infer<typeof DirectoryUserSearchResponseSchema>;

/**
 * 发起好友申请请求体 Schema（支持按 `targetUserId` 或精确 `email` 指定目标用户）。
 */
export const SendFriendRequestBodySchema = z
  .object({
    targetUserId: UserIdSchema.optional(),
    email: z.string().trim().toLowerCase().email().optional(),
    note: z.string().trim().max(240).optional(),
  })
  .refine(
    (val) => val.targetUserId !== undefined || val.email !== undefined,
    "Either targetUserId or email must be provided",
  );
export type SendFriendRequestBody = z.infer<typeof SendFriendRequestBodySchema>;

/**
 * 发起好友申请成功响应体 Schema（当对方此前已向你发起申请时，`autoAccepted: true` 直接成为好友）。
 */
export const SendFriendRequestResponseSchema = z.object({
  ok: z.literal(true),
  status: z.enum(["pending", "accepted"]),
  friendshipId: FriendshipIdSchema,
  autoAccepted: z.boolean(),
});
export type SendFriendRequestResponse = z.infer<typeof SendFriendRequestResponseSchema>;

/**
 * 同意好友申请成功响应体 Schema。
 */
export const AcceptFriendRequestResponseSchema = z.object({
  ok: z.literal(true),
  friend: FriendContactDtoSchema,
});
export type AcceptFriendRequestResponse = z.infer<typeof AcceptFriendRequestResponseSchema>;

/** 更新私有好友备注的请求体。去除首尾空白后为空时清除备注。 */
export const UpdateFriendRemarkBodySchema = z.object({
  remark: FriendRemarkSchema,
});

/** 更新私有好友备注的请求体类型。 */
export type UpdateFriendRemarkBody = z.infer<typeof UpdateFriendRemarkBodySchema>;

/** 更新确认及规范化后的备注，`null` 表示备注已清除。 */
export const UpdateFriendRemarkResponseSchema = z.object({
  ok: z.literal(true),
  remark: FriendRemarkSchema.nullable(),
});

/** 更新私有好友备注的响应体类型。 */
export type UpdateFriendRemarkResponse = z.infer<typeof UpdateFriendRemarkResponseSchema>;

/**
 * 拒绝/撤回好友申请或解除好友关系成功响应体 Schema。
 */
export const RemoveFriendshipResponseSchema = z.object({
  ok: z.literal(true),
});
export type RemoveFriendshipResponse = z.infer<typeof RemoveFriendshipResponseSchema>;
