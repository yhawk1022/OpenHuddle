/**
 * @module protocol/proposals
 * @description 结构化提案卡片（Proposal Card）、多 Agent 分歧表态、人类拍板与 AI 自动提炼契约。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 同构复用于 AI 结构化生成：`ProposalDraftSchema` 直接供 `Vercel AI SDK` 的 `generateObject` 使用，确保主持人模型提炼出的提案 100% 符合前端渲染契约。
 * 2. 人类最终拍板权：仅具备房间决策权的人类可将提案状态变更为 `approved` 或 `rejected`。
 */
import { z } from "zod";
import { AuthorStampSchema } from "./identity.js";
import { MessageSeqSchema, ProposalIdSchema, RoomIdSchema, UserIdSchema } from "./ids.js";

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
 */
export const ProposalVoteStanceSchema = z.enum(["endorse", "challenge", "abstain"]);
export type ProposalVoteStance = z.infer<typeof ProposalVoteStanceSchema>;

/**
 * 提交提案表态投票的请求体 Schema。
 */
export const CastProposalVoteBodySchema = z.object({
  stance: ProposalVoteStanceSchema,
  preferredOptionKey: z.string().trim().min(1).max(32).optional(),
  rationale: z.string().trim().min(1).max(600),
});
export type CastProposalVoteBody = z.infer<typeof CastProposalVoteBodySchema>;

/**
 * 决策授权强度枚举（ADR-0002 Mandate 作用域）：`suggest` 仅参考、`act` 可执行、`act_with_review` 执行后需人复盘。
 */
export const MandateStrengthSchema = z.enum(["suggest", "act", "act_with_review"]);
export type MandateStrength = z.infer<typeof MandateStrengthSchema>;

/**
 * 决策授权语义（ADR-0002）：记录"谁、凭哪版治理配置、批了什么范围、对谁有效"。
 *
 * @remarks
 * 联邦铁律：授权力仅及于 `approverUserIds` 名下 Agent；非批准者名下 Agent 收到该 Decision 时
 * 按外部参考信息对待，不产生执行义务。`approverUserIds` 由服务端以实际拍板者身份盖章，客户端声明无效。
 */
export const DecisionMandateSchema = z.object({
  scope: z.string().trim().min(1).max(1_000),
  strength: MandateStrengthSchema,
  policyVersion: z.number().int().min(1),
  approverUserIds: z.array(UserIdSchema).min(1).max(20),
});
export type DecisionMandate = z.infer<typeof DecisionMandateSchema>;

/**
 * 人类决策拍板提案的请求体 Schema。
 */
export const DecideProposalBodySchema = z.object({
  decision: z.enum(["approved", "rejected"]),
  decidedOptionKey: z.string().trim().min(1).max(32).optional(),
  decisionNote: z.string().trim().max(1_000).optional(),
  /** 拍板时声明的授权语义（可选；`approverUserIds` 由服务端强制改写为实际拍板者） */
  mandate: z
    .object({
      scope: z.string().trim().min(1).max(1_000),
      strength: MandateStrengthSchema,
      policyVersion: z.number().int().min(1),
    })
    .optional(),
});
export type DecideProposalBody = z.infer<typeof DecideProposalBodySchema>;

/**
 * 请求由服务端 AI 主持人从最近房间讨论自动提炼结构化提案卡片的请求体 Schema。
 */
export const SynthesizeProposalBodySchema = z.object({
  messageWindowLimit: z.number().int().min(3).max(100).default(30),
  apiKey: z.string().trim().min(8).optional(),
  baseUrl: z.string().url().optional(),
  model: z.string().trim().min(1).max(120).optional(),
});
export type SynthesizeProposalBody = z.infer<typeof SynthesizeProposalBodySchema>;

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
  /** ADR-0002：批准后携带的授权语义（仅 approved 决策出现；`approverUserIds` 为服务端盖章的实际拍板者） */
  mandate: DecisionMandateSchema.optional(),
  createdAtIso: z.string().datetime(),
});
export type ProposalCardDto = z.infer<typeof ProposalCardDtoSchema>;
