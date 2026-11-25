/**
 * @module web/features/huddle-room/work/types
 * @description 多 Agent 调度、蜂群并行分片（Swarm Slices）、主从交叉审查（Verify Loop）与持久执行记录（WorkRun）视图类型契约。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 四层正交模型对齐：
 *    - 外层注意力分类：显式区分需人类介入态（`awaiting_answer` / `awaiting_review` / `blocked`）与后台静默执行态（`working` / `verifying`）；
 *    - 内层一纵一横编排拓扑：`direct`（1 跳直执）、`verify_loop`（纵向执行+异构审查）、`swarm`（横向独占路径分片并发+合流核验）。
 * 2. 零 `any` 与可辨识联合：时间线里程碑卡片全部以 `cardKind` 作为判别式，配合 `assertNever` 穷尽检查。
 */
import type {
  AgentId,
  AgentPlatform,
  RoomId,
  WorkSliceProvenance,
  WorkSliceRole,
} from "@openhuddle/protocol";
import type { AgentExecutionTier } from "../../../lib/agent-capability-prefs.js";

export type { WorkSliceProvenance } from "@openhuddle/protocol";

/**
 * 多 Agent 房间任务编排拓扑（同一平面上的三种执行阵型）。
 * - `direct`：单兵直执（1 跳最快，适合明确单一改动或已开启原生 Orchestrator 的单兵）
 * - `verify_loop`：纵向主从交叉审查（执行 Agent 落地 → 异构 `@verifier` 独立挑刺核验）
 * - `swarm`：横向共享看板蜂群（统筹 Agent 拆互不重叠 `ownedPaths` 分片 → 多 Agent 真并发 → `@verifier` 合流）
 */
export type WorkTopology = "direct" | "verify_loop" | "swarm";

/**
 * 工单生命周期阶段（前 3 项属于 SuperAgent「Needs You」需人类介入态）。
 */
export type WorkStage =
  | "awaiting_answer"
  | "awaiting_review"
  | "blocked"
  | "working"
  | "verifying"
  | "done"
  | "cancelled";

/**
 * SuperAgent 房间主动接单门禁档位。
 * - `off`：仅显式 `[⚡派活]` 或 `/task` `/swarm` 建单（默认零打扰）
 * - `observe`：演练观察模式——后台记录「本会派给谁（Would Dispatch）」而不实际打扰群聊
 * - `auto`：命中明确行动意图时由统筹 Agent 自动建单分派
 */
export type SuperAgentIntakeMode = "off" | "observe" | "auto";

/**
 * 参与工单的单个 Agent 精简快照（保留平台与归属标记，确保成员变动后历史卡片仍可稳定渲染）。
 */
export interface WorkAgentRef {
  readonly agentId: AgentId;
  readonly displayName: string;
  readonly platform: AgentPlatform;
  readonly isOwnedByViewer: boolean;
  readonly ownerDisplayName: string;
}

/**
 * 蜂群或单工单下的单个并行执行分片（Swarm Slice / Worker Run Node）。
 */
export interface WorkSliceNode {
  readonly sliceId: string;
  readonly title: string;
  readonly worker: WorkAgentRef;
  readonly leaseRole?: WorkSliceRole;
  readonly worktreeBranch?: string;
  /** 独占文件或目录前缀（防并行 Worktree 写冲突） */
  readonly ownedPaths: ReadonlyArray<string>;
  readonly status: "waiting" | "running" | "verifying" | "ready" | "blocked";
  /** 实时瞬态进度单行摘要（走 SSE 内存流，不刷屏主聊天室） */
  readonly liveSummary: string;
  readonly elapsedSec: number;
  readonly diffAdded?: number | undefined;
  readonly diffRemoved?: number | undefined;
  /** 人类通过 `[纠偏 Steer]` 实时注入当前回合的补充指令记录 */
  readonly steerNotes: ReadonlyArray<string>;
  readonly failureCode?: string | undefined;
  /** 该分片在 Agent 自身宿主环境的仓外工作记录与代码溯源回执 */
  readonly provenance?: WorkSliceProvenance | undefined;
}

/**
 * 受托 Worker 向自己主人发起的单问停顿载荷（Owner-Scoped Worker Attention，每单最多 1 条未决）。
 */
export interface WorkAttentionPrompt {
  readonly question: string;
  readonly askedBy: WorkAgentRef;
  readonly options: ReadonlyArray<string>;
  readonly answeredChoice?: string | undefined;
}

/**
 * 交付待签收摘要（Diff 统计、实跑验证命令结果与 `@verifier` 独立核验结论）。
 */
export interface WorkReviewSummary {
  readonly filesChanged: number;
  readonly additions: number;
  readonly deletions: number;
  readonly changedFiles: ReadonlyArray<string>;
  /** 仅当校验命令真实执行过才有值 */
  readonly testCommand?: string | undefined;
  readonly testPassed?: boolean | undefined;
  readonly worktreeBranch?: string | undefined;
  readonly verifierNote?: string | undefined;
  readonly verifyLoopsUsed: number;
}

/**
 * 完整房间工单视图模型（同时驱动右侧 `356px` 任务面板、顶栏灵动胶囊与时间线里程碑卡）。
 */
export interface RoomWorkItemView {
  readonly id: string;
  readonly roomId: RoomId;
  /** 锚定在聊天时间线哪一条 `seq` 消息之后渲染里程碑卡片（`0` 表示置于时间线末尾） */
  readonly anchorSeq: number;
  readonly title: string;
  readonly brief: string;
  readonly topology: WorkTopology;
  readonly tier: AgentExecutionTier;
  readonly stage: WorkStage;
  readonly coordinator?: WorkAgentRef | undefined;
  readonly primaryWorker: WorkAgentRef;
  readonly verifier?: WorkAgentRef | undefined;
  readonly slices: ReadonlyArray<WorkSliceNode>;
  readonly attention?: WorkAttentionPrompt | undefined;
  readonly review?: WorkReviewSummary | undefined;
  /** 若与单人工作台工单双向绑定，记录对应 `SoloWorkTaskView.id` 以保持跨视图零脑裂同步 */
  readonly linkedSoloTaskId?: string | undefined;
  readonly createdAtIso: string;
  readonly updatedAtIso: string;
}

/**
 * `Observe` 演练模式下静默记录的「模拟分诊建议」（不触发真实执行、不污染主聊天区）。
 */
export interface ObserveDryRunEntry {
  readonly id: string;
  readonly triggerSnippet: string;
  readonly suggestedTopology: WorkTopology;
  readonly suggestedAssigneeName: string;
  readonly reason: string;
  readonly recordedAtIso: string;
}

/**
 * 房间级默认编排角色配置（在顶栏治理浮层或任务面板设定后，自动预填底部 `[⚡派活]` 胶囊）。
 */
export interface RoomOrchestrationDefaults {
  readonly coordinatorAgentId?: AgentId | undefined;
  readonly verifierAgentId?: AgentId | undefined;
  readonly intakeMode: SuperAgentIntakeMode;
}

/**
 * 底部 `MessageComposer` 提交派活工单时的结构化参数。
 */
export interface DispatchWorkPayload {
  readonly topology: WorkTopology;
  readonly tier: AgentExecutionTier;
  readonly coordinatorAgentId?: AgentId | undefined;
  readonly executorAgentId?: AgentId | undefined;
  readonly verifierAgentId?: AgentId | undefined;
  readonly linkedSoloTaskId?: string | undefined;
}

/**
 * 快速预览预设场景枚举（方便一键检视不同运行阶段在日光/暗夜双主题下的视觉表现）。
 */
export type WorkShowcasePreset = "swarm_live" | "needs_you" | "verify_loop";
