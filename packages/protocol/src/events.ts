/**
 * @module protocol/events
 * @description 实时事件流（SSE `/api/v1/events`）可辨识联合契约与轻量安全唤醒（Wake）载荷定义。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. Wake 帧零敏感信息原则：下推给本地常驻守护进程（Listener）的 `wake` 事件仅携带 `roomId`、`latestSeq` 与唤醒原因，绝不包含正文或密钥，安全穿透任意网络环境。
 * 2. 单一判别式：所有 SSE 事件统一以 `type` 字面量构建可辨识联合类型，供 Web `QueryClient` 同步器与 CLI 守护器做穷尽匹配。
 */
import { z } from "zod";
import { RoomGovernanceStateSchema } from "./governance.js";
import { MessageSeqSchema, RoomIdSchema } from "./ids.js";
import { MessageDtoSchema } from "./messages.js";
import { ProposalCardDtoSchema } from "./proposals.js";

/**
 * 触发本地 Agent 唤醒的原因分类。
 */
export const WakeReasonSchema = z.enum([
  "owner_command",
  "direct_mention",
  "reply_to_you",
  "round_table_turn",
  "proposal_vote_requested",
]);
export type WakeReason = z.infer<typeof WakeReasonSchema>;

/**
 * 服务端通过 SSE 向 Web 客户端及 Agent 守护进程推送的实时事件可辨识联合 Schema。
 */
export const SseEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("connected"),
    serverTimeIso: z.string().datetime(),
    connectionId: z.string(),
  }),
  z.object({
    type: z.literal("heartbeat"),
    serverTimeIso: z.string().datetime(),
  }),
  z.object({
    type: z.literal("wake"),
    roomId: RoomIdSchema,
    latestSeq: MessageSeqSchema,
    reason: WakeReasonSchema,
  }),
  z.object({
    type: z.literal("message.created"),
    roomId: RoomIdSchema,
    message: MessageDtoSchema,
  }),
  z.object({
    type: z.literal("governance.updated"),
    roomId: RoomIdSchema,
    governance: RoomGovernanceStateSchema,
  }),
  z.object({
    type: z.literal("proposal.updated"),
    roomId: RoomIdSchema,
    proposal: ProposalCardDtoSchema,
  }),
]);
export type SseEvent = z.infer<typeof SseEventSchema>;
