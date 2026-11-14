/**
 * @module protocol/governance
 * @description 房间群聊治理规则（Turn Budget 轮次锁、Agent 互 @ 熔断、圆桌模式与乐观并发锁）的数据契约。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 默认安全预算：新建房间默认开启 `maxConsecutiveAgentTurns = 6` 与 `requireReadBeforeSend = true`，从源头防止多 Agent 无限互 `@` 消耗 Token。
 * 2. 配置与运行时状态分离：`RoomGovernanceConfig` 为人类可热更新的策略项，`RoomGovernanceState` 包含当前连续发言计数与冷却快照。
 */
import { z } from "zod";
import { AgentIdSchema } from "./ids.js";

/** 默认连续 Agent 自动发言轮次预算上限 */
export const DEFAULT_MAX_CONSECUTIVE_AGENT_TURNS = 6;

/** 默认单个 Agent 在同一房间的发言冷却间隔（毫秒） */
export const DEFAULT_AGENT_COOLDOWN_MS = 3_000;

/**
 * 房间讨论组织模式。
 * - `free`：自由讨论（受预算与冷却约束）。
 * - `round_table`：圆桌轮流表态（房间内受邀 Agent 在一轮内未全部发言或弃权前，已发言 Agent 不得抢第二轮）。
 * - `proposal`：提案收敛模式（聚焦结构化投票与人类拍板）。
 */
export const GovernanceModeSchema = z.enum(["free", "round_table", "proposal"]);
export type GovernanceMode = z.infer<typeof GovernanceModeSchema>;

/**
 * 房间治理运行状态。
 * - `active`：允许合规发言并正常派发自动唤醒。
 * - `paused_budget`：连续 Agent 发言已触达预算上限，自动挂起唤醒链，等待人类插话重置或手动续期。
 */
export const RoomGovernanceStatusSchema = z.enum(["active", "paused_budget"]);
export type RoomGovernanceStatus = z.infer<typeof RoomGovernanceStatusSchema>;

/**
 * 房间可由人类热更新的治理策略配置 Schema。
 */
export const RoomGovernanceConfigSchema = z.object({
  mode: GovernanceModeSchema.default("free"),
  allowAgentMentions: z.boolean().default(true),
  maxConsecutiveAgentTurns: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(DEFAULT_MAX_CONSECUTIVE_AGENT_TURNS),
  requireReadBeforeSend: z.boolean().default(true),
  agentCooldownMs: z.number().int().min(0).max(60_000).default(DEFAULT_AGENT_COOLDOWN_MS),
});
export type RoomGovernanceConfig = z.infer<typeof RoomGovernanceConfigSchema>;

/**
 * 房间完整治理快照（策略配置 + 运行时状态机计数器）。
 */
export const RoomGovernanceStateSchema = z.object({
  config: RoomGovernanceConfigSchema,
  status: RoomGovernanceStatusSchema,
  consecutiveAgentTurns: z.number().int().min(0),
  roundTableSpokenAgentIds: z.array(AgentIdSchema),
  lastSpokenAtByAgentMs: z.record(z.string(), z.number().int().nonnegative()),
});
export type RoomGovernanceState = z.infer<typeof RoomGovernanceStateSchema>;

/**
 * 创建新房间的初始默认治理状态快照。
 *
 * @param overrides - 可选的局部治理策略覆盖项
 * @returns 初始化为 `active` 且计数清零的治理快照
 */
export function createDefaultGovernanceState(
  overrides?: Partial<RoomGovernanceConfig>,
): RoomGovernanceState {
  const config = RoomGovernanceConfigSchema.parse(overrides ?? {});
  return {
    config,
    status: "active",
    consecutiveAgentTurns: 0,
    roundTableSpokenAgentIds: [],
    lastSpokenAtByAgentMs: {},
  };
}

/**
 * 主人私有唤醒策略（ADR-0002 §3.1 双层 Policy 的主人层）：
 * 每主人对自己的 Agent 声明静音时段与每日唤醒预算；服务端唤醒分发器与 Agent 本地 harness 双重执行。
 */
export const AgentWakePolicySchema = z.object({
  /** 静音时段（本地 HH:mm）；窗口内服务端不下发自动唤醒 */
  quietHours: z
    .object({
      startLocal: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
      endLocal: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    })
    .optional(),
  /** 每房每日自动唤醒预算上限（0 表示仅人工 @ 直达） */
  dailyWakeBudget: z.number().int().min(0).max(10_000).optional(),
});
export type AgentWakePolicy = z.infer<typeof AgentWakePolicySchema>;
