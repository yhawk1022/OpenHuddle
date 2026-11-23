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
 * 消息内容语义分类枚举。`attention` 为 ADR-0002 新增：结构化"等待特定人类作答"的问题消息。
 */
export const MessageTypeSchema = z.enum([
  "text",
  "proposal",
  "vote",
  "decision",
  "system",
  "attention",
]);
export type MessageType = z.infer<typeof MessageTypeSchema>;

/**
 * 收件人 Attention 载荷（ADR-0002 §3.3）：结构化等人，明确"在等哪个人类、等什么、到何时"。
 *
 * @remarks
 * 联邦铁律：仅人类成员（及未来无投票权的 AI 主持人）可创建 Attention；Agent 消息永不携带本载荷，
 * "等人"状态是结构化字段而非从自由文本推断。
 */
export const AttentionPayloadSchema = z.object({
  question: z.string().trim().min(1).max(500),
  options: z.array(z.string().trim().min(1).max(120)).max(6).default([]),
  addresseeUserIds: z.array(UserIdSchema).min(1).max(10),
  expiresAtIso: z.string().datetime(),
});
export type AttentionPayload = z.infer<typeof AttentionPayloadSchema>;

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

/** 单条消息附件解码后的字节上限。 */
export const MAX_MESSAGE_ATTACHMENT_BYTES = 8 * 1024 * 1024;

/** 字节上限对应的标准 Base64 字符数，包含补位。 */
export const MAX_MESSAGE_ATTACHMENT_BASE64_LENGTH = Math.ceil(MAX_MESSAGE_ATTACHMENT_BYTES / 3) * 4;

/** 可用于内联展示的图片、音频类型，以及仅供下载的通用文件类型。 */
export const MessageAttachmentMimeTypeSchema = z.enum([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "audio/webm",
  "audio/ogg",
  "audio/mp4",
  "audio/mpeg",
  "audio/wav",
  "application/octet-stream",
]);

/** 房间附件使用的媒体类型。 */
export type MessageAttachmentMimeType = z.infer<typeof MessageAttachmentMimeTypeSchema>;

/** 图片作为表情发送时，用于草稿、消息预览和无障碍描述的简短名称。 */
export const MessageStickerNameSchema = z.string().trim().min(1).max(80);

/** 普通附件的显示文件名，排除路径分隔符、控制字符及无效 Unicode。 */
export const MessageAttachmentFileNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine(
    (name) =>
      name !== "." && name !== ".." && !/[/\\\p{Cc}\p{Cs}\u202a-\u202e\u2066-\u2069]/u.test(name),
    "Expected a plain filename",
  );

/** 消息列表中的附件元数据。二进制由独立的鉴权接口返回。 */
export const MessageAttachmentSchema = z.object({
  mimeType: MessageAttachmentMimeTypeSchema,
  byteLength: z.number().int().min(1).max(MAX_MESSAGE_ATTACHMENT_BYTES),
  stickerName: MessageStickerNameSchema.optional(),
  fileName: MessageAttachmentFileNameSchema.optional(),
});

/** 房间消息中可用于展示和读取附件的元数据。 */
export type MessageAttachment = z.infer<typeof MessageAttachmentSchema>;

/** 发送附件的请求载荷。服务端还需核验解码字节数及文件格式。 */
export const MessageAttachmentUploadSchema = z
  .object({
    mimeType: MessageAttachmentMimeTypeSchema,
    stickerName: MessageStickerNameSchema.optional(),
    fileName: MessageAttachmentFileNameSchema.optional(),
    data: z
      .string()
      .min(4)
      .max(MAX_MESSAGE_ATTACHMENT_BASE64_LENGTH)
      .regex(/^[A-Za-z0-9+/]+={0,2}$(?![\s\S])/, "Expected standard Base64 data")
      .refine((data) => data.length % 4 === 0, "Expected padded Base64 data"),
  })
  .refine(
    ({ mimeType, stickerName }) => stickerName === undefined || mimeType.startsWith("image/"),
    {
      path: ["stickerName"],
      message: "Only image attachments can be sent as stickers",
    },
  )
  .refine(
    ({ mimeType, fileName }) =>
      (mimeType === "application/octet-stream") === (fileName !== undefined),
    { path: ["fileName"], message: "File attachments require a filename" },
  );

/** 随消息提交的 Base64 编码附件。 */
export type MessageAttachmentUpload = z.infer<typeof MessageAttachmentUploadSchema>;

/**
 * 对外返回的单条消息标准 DTO Schema。
 */
export const MessageDtoSchema = z.object({
  roomId: RoomIdSchema,
  seq: MessageSeqSchema,
  type: MessageTypeSchema,
  author: AuthorStampSchema,
  content: z.string().max(16_000),
  attachment: MessageAttachmentSchema.optional(),
  replyToSeq: MessageSeqSchema.optional(),
  mentions: z.array(MessageMentionSchema),
  /** 仅 `type === "attention"` 时出现的结构化等人载荷（ADR-0002） */
  attention: AttentionPayloadSchema.optional(),
  recalledAtIso: z.string().datetime().optional(),
  createdAtIso: z.string().datetime(),
});
export type MessageDto = z.infer<typeof MessageDtoSchema>;

/**
 * 发送房间消息请求体 Schema。
 */
export const SendMessageRequestSchema = z
  .object({
    content: z.string().trim().max(16_000),
    attachment: MessageAttachmentUploadSchema.optional(),
    replyToSeq: MessageSeqSchema.optional(),
    mentions: z.array(MessageMentionSchema).max(20).default([]),
    /** ADR-0002：人类专属的结构化等人问题；Agent 携带此字段将被服务端拒绝 */
    attention: AttentionPayloadSchema.optional(),
    opKey: OperationKeySchema.optional(),
    lastReadSeq: ReadCursorSeqSchema.optional(),
    ignoreUnread: z.boolean().default(false),
  })
  .refine((message) => message.content.length > 0 || message.attachment !== undefined, {
    path: ["content"],
    message: "Expected message text or an attachment",
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
