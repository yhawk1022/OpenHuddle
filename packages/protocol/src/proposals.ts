/**
 * @module protocol/proposals
 * @description 结构化提案卡片（Proposal Card）、多 Agent 分歧表态与人类一锤定音（Decision）契约。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 同构复用于 AI 结构化生成：`ProposalDraftSchema` 直接供 `Vercel AI SDK` 的 `generateObject` 使用，确保主持人模型提炼出的提案 100% 符合前端渲染契约。
 * 2. 人类最终拍板权：仅具备房间决策权的人类可将提案状态变更为 `approved` 或 `rejected`。
 */
import { z } from "zod";
import { AuthorStampSchema } from "./identity.js";
import { MessageSeqSchema, ProposalIdSchema, RoomIdSchema } from "./ids.js";

/**
 * 提案备选方案条目 Schema。
 */
export const ProposalOptionSchema = z.object({
  optionKey: z.string().trim().min(1).max(32),
  label: z.string().trim().min(1).max(120),
  summary: z.string().trim().min(1).max(1_000),
  pros: z.array(z.string().trim().min(1).max(300)).max(8),
  cons: z.array(z.string().trim().min(1).max(300)).max(8),
  risks: z.array(z.string().trim().min(1).max(300)).max(8),
});
export type ProposalOption = z.infer<typeof ProposalOptionSchema>;

/**
 * 提交提案或由 AI 主持人自动提炼提案时的草稿结构 Schema。
 */
export const ProposalDraftSchema = z.object({
  title: z.string().trim().min(2).max(160),
  contextSummary: z.string().trim().min(2).max(2_000),
  recommendedOptionKey: z.string().trim().min(1).max(32).optional(),
  options: z.array(ProposalOptionSchema).min(1).max(6),
});
export type ProposalDraft = z.infer<typeof ProposalDraftSchema>;

/**
 * Agent 对提案的结构化表态立场枚举。
 * - `endorse`：赞成支持
 * - `challenge`：指出盲点或质疑反对
 * - `abstain`：中立弃权
 */
export const ProposalVoteStanceSchema = z.enum(["endorse", "challenge", "abstain"]);
export type ProposalVoteStance = z.infer<typeof ProposalVoteStanceSchema>;

/**
 * 单条结构化投票视图 Schema。
 */
export const ProposalVoteDtoSchema = z.object({
  voter: AuthorStampSchema,
  stance: ProposalVoteStanceSchema,
  preferredOptionKey: z.string().trim().min(1).max(32).optional(),
  rationale: z.string().trim().min(1).max(600),
  createdAtIso: z.string().datetime(),
});
export type ProposalVoteDto = z.infer<typeof ProposalVoteDtoSchema>;

/**
 * 提案生命周期状态枚举。
 */
export const ProposalStatusSchema = z.enum(["open", "approved", "rejected", "superseded"]);
export type ProposalStatus = z.infer<typeof ProposalStatusSchema>;

/**
 * 完整提案与决策卡片 DTO Schema。
 */
export const ProposalCardDtoSchema = z.object({
  id: ProposalIdSchema,
  roomId: RoomIdSchema,
  originMessageSeq: MessageSeqSchema,
  status: ProposalStatusSchema,
  draft: ProposalDraftSchema,
  votes: z.array(ProposalVoteDtoSchema),
  decidedOptionKey: z.string().trim().min(1).max(32).optional(),
  decisionNote: z.string().trim().max(1_000).optional(),
  decidedBy: AuthorStampSchema.optional(),
  decidedAtIso: z.string().datetime().optional(),
  createdAtIso: z.string().datetime(),
});
export type ProposalCardDto = z.infer<typeof ProposalCardDtoSchema>;
