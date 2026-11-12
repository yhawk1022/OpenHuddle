/**
 * @module protocol/messages
 * @description 房间消息读写契约、幂等发送入参及乐观并发防抢话冲突（409）载荷定义。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 顺序唯一性：每条消息以 `(roomId, seq)` 作为逻辑唯一坐标，`seq` 从 `1` 连续递增无空洞。
 * 2. 防盲发保护：Agent 发送消息默认必须携带当前已读到的 `lastReadSeq`，若落后于房间最新序号，服务端拒绝盲发并附带漏读增量。
 */
import { z } from "zod";
import { AuthorStampSchema } from "./identity.js";
import {
  AgentIdSchema,
  MessageSeqSchema,
  OperationKeySchema,
  ReadCursorSeqSchema,
  RoomIdSchema,
  UserIdSchema,
} from "./ids.js";

/**
 * 消息内容语义分类枚举。
 */
export const MessageTypeSchema = z.enum(["text", "proposal", "vote", "decision", "system"]);
export type MessageType = z.infer<typeof MessageTypeSchema>;

/**
 * 消息中显式 `@mention` 的目标引用 Schema。
 */
export const MessageMentionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("human"),
    userId: UserIdSchema,
    displayName: z.string().min(1).max(80),
  }),
  z.object({
    kind: z.literal("agent"),
    agentId: AgentIdSchema,
    displayName: z.string().min(1).max(80),
  }),
]);
export type MessageMention = z.infer<typeof MessageMentionSchema>;

/**
 * 对外返回的单条消息标准 DTO Schema。
 */
export const MessageDtoSchema = z.object({
  roomId: RoomIdSchema,
  seq: MessageSeqSchema,
  type: MessageTypeSchema,
  author: AuthorStampSchema,
  content: z.string().max(16_000),
  replyToSeq: MessageSeqSchema.optional(),
  mentions: z.array(MessageMentionSchema),
  recalledAtIso: z.string().datetime().optional(),
  createdAtIso: z.string().datetime(),
});
export type MessageDto = z.infer<typeof MessageDtoSchema>;

/**
 * 发送房间消息请求体 Schema。
 */
export const SendMessageRequestSchema = z.object({
  content: z.string().trim().min(1).max(16_000),
  replyToSeq: MessageSeqSchema.optional(),
  mentions: z.array(MessageMentionSchema).max(20).default([]),
  opKey: OperationKeySchema.optional(),
  lastReadSeq: ReadCursorSeqSchema.optional(),
  ignoreUnread: z.boolean().default(false),
});
export type SendMessageRequest = z.infer<typeof SendMessageRequestSchema>;

/**
 * 当命中 `409 CONFLICT_UNREAD_MESSAGES` 时返回给 Agent 的错失增量详情 Schema。
 */
export const UnreadConflictDetailsSchema = z.object({
  latestSeq: MessageSeqSchema,
  yourLastReadSeq: ReadCursorSeqSchema,
  missedMessages: z.array(MessageDtoSchema),
});
export type UnreadConflictDetails = z.infer<typeof UnreadConflictDetailsSchema>;
