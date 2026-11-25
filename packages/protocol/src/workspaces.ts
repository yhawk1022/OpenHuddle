/**
 * @module protocol/workspaces
 * @description 五维工作区（Workspace）、持久任务租约（Durable Lease）与多 Agent 协作分片编排契约。
 *
 * 关键不变量：
 * 1. 本机路径零跨域泄漏（ADR-0010）：`WorkspaceRootEntry.localPath` 仅对工作区主人本人可见；面向房间内外部成员序列化时服务端必须剥离该字段。
 * 2. 单調版本防护令牌（ADR-0009）：每次认领或超时接管分片都会递增 `leaseVersion`，心跳续租与交付提交必须携带匹配版本号，阻断双写脑裂。
 * 3. 人类终审门禁（ADR-0002）：Agent 分片完成后工单最多推进至 `awaiting_review`，唯有授权人类可签收进入 `done`。
 */
import { z } from "zod";
import { AgentPlatformSchema } from "./identity.js";
import {
  AgentIdSchema,
  OperationKeySchema,
  RoomIdSchema,
  UserIdSchema,
  WorkItemIdSchema,
  WorkSliceIdSchema,
  WorkspaceIdSchema,
} from "./ids.js";
import { PutReviewEvidenceBodySchema } from "./review-evidence.js";

/** 工作区目录组织形态 */
export const WorkspaceKindSchema = z.enum(["git_repo", "multi_root", "folder"]);
export type WorkspaceKind = z.infer<typeof WorkspaceKindSchema>;

/** 工作区执行宿主模式（ADR-0010 §3.1） */
export const WorkspaceHostModeSchema = z.enum([
  "local_machine",
  "personal_remote",
  "shared_container",
]);
export type WorkspaceHostMode = z.infer<typeof WorkspaceHostModeSchema>;

/** 工作区代码隔离策略 */
export const WorkspaceSandboxModeSchema = z.enum(["worktree_pool", "in_place", "read_only"]);
export type WorkspaceSandboxMode = z.infer<typeof WorkspaceSandboxModeSchema>;

/** 多 Agent 任务编排拓扑（单兵直执 / 主从核验环 / 蜂群并发分片） */
export const WorkTopologySchema = z.enum(["direct", "verify_loop", "swarm"]);
export type WorkTopology = z.infer<typeof WorkTopologySchema>;

/** Agent 执行能力授权档位（ADR-0009 §3.2） */
export const AgentExecutionTierSchema = z.enum([
  "chat_only",
  "workspace_read",
  "worktree_write",
  "sandbox_branch_write",
  "full_owner_delegate",
]);
export type AgentExecutionTier = z.infer<typeof AgentExecutionTierSchema>;

/** 工单全局生命周期阶段 */
export const WorkStageSchema = z.enum([
  "working",
  "verifying",
  "awaiting_answer",
  "awaiting_review",
  "blocked",
  "done",
  "cancelled",
]);
export type WorkStage = z.infer<typeof WorkStageSchema>;

/** 分片持有的沙箱租约角色 */
export const WorkSliceRoleSchema = z.enum(["write", "verify", "read"]);
export type WorkSliceRole = z.infer<typeof WorkSliceRoleSchema>;

/** 单个分片的执行状态 */
export const WorkSliceStatusSchema = z.enum([
  "waiting",
  "running",
  "verifying",
  "ready",
  "blocked",
]);
export type WorkSliceStatus = z.infer<typeof WorkSliceStatusSchema>;

/** 工作区挂载的单个代码根元数据 */
export const WorkspaceRootEntrySchema = z.object({
  id: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(120),
  /** 仅对 `isOwnedByViewer === true` 的主人回传；跨人视图自动剥离 */
  localPath: z.string().trim().min(1).max(512).optional(),
  isGitRepo: z.boolean(),
  defaultBranch: z.string().trim().min(1).max(120).optional(),
  remoteSlug: z.string().trim().min(1).max(200).optional(),
});
export type WorkspaceRootEntry = z.infer<typeof WorkspaceRootEntrySchema>;

/** 工作区沙箱生命周期钩子 */
export const WorkspaceLifecycleHooksSchema = z.object({
  setupCommand: z.string().trim().min(1).max(500).optional(),
  verifyCommand: z.string().trim().min(1).max(500).optional(),
  copyEnvGlobs: z.array(z.string().trim().min(1).max(120)).max(20).optional(),
});
export type WorkspaceLifecycleHooks = z.infer<typeof WorkspaceLifecycleHooksSchema>;

/** 工作区规则与技能上下文摘要 */
export const WorkspaceContextAssetsSchema = z.object({
  ruleFiles: z.array(z.string().trim().min(1).max(200)).max(32),
  skillCount: z.number().int().min(0).max(500),
  sharedMemoryActive: z.boolean(),
});
export type WorkspaceContextAssets = z.infer<typeof WorkspaceContextAssetsSchema>;

/** 按查看者视角脱敏后的五维工作区 DTO */
export const WorkspaceDtoSchema = z.object({
  id: WorkspaceIdSchema,
  ownerUserId: UserIdSchema,
  ownerDisplayName: z.string(),
  isOwnedByViewer: z.boolean(),
  name: z.string().min(1).max(120),
  kind: WorkspaceKindSchema,
  roots: z.array(WorkspaceRootEntrySchema).min(1).max(16),
  hostMode: WorkspaceHostModeSchema,
  hostLabel: z.string().min(1).max(120),
  hostOnline: z.boolean(),
  sandboxMode: WorkspaceSandboxModeSchema,
  /** 仅在 `hostMode === "shared_container"` 时生效：允许同群其他主人的 Agent 申请单写者或核验租约 */
  allowRoomCollaborators: z.boolean(),
  prewarmedWorktrees: z.number().int().min(0).max(16),
  hooks: WorkspaceLifecycleHooksSchema,
  context: WorkspaceContextAssetsSchema,
  defaultTopology: WorkTopologySchema,
  defaultWorkerAgentId: AgentIdSchema.optional(),
  defaultVerifierAgentId: AgentIdSchema.optional(),
  createdAtIso: z.string().datetime(),
  updatedAtIso: z.string().datetime(),
});
export type WorkspaceDto = z.infer<typeof WorkspaceDtoSchema>;

/** 房间与成员工作区的绑定关系 DTO */
export const RoomWorkspaceBindingDtoSchema = z.object({
  roomId: RoomIdSchema,
  ownerUserId: UserIdSchema,
  workspaceId: WorkspaceIdSchema,
  boundAtIso: z.string().datetime(),
});
export type RoomWorkspaceBindingDto = z.infer<typeof RoomWorkspaceBindingDtoSchema>;

/** 创建工作区时的单个目录根入参 */
export const WorkspaceRootInputSchema = z.object({
  id: z.string().trim().min(1).max(64).optional(),
  name: z.string().trim().min(1).max(120).optional(),
  localPath: z.string().trim().min(1).max(512),
  isGitRepo: z.boolean().default(true),
  defaultBranch: z.string().trim().min(1).max(120).optional(),
  remoteSlug: z.string().trim().min(1).max(200).optional(),
});
export type WorkspaceRootInput = z.infer<typeof WorkspaceRootInputSchema>;

/** `POST /api/v1/workspaces` 请求体 */
export const CreateWorkspaceBodySchema = z.object({
  name: z.string().trim().min(1).max(120),
  kind: WorkspaceKindSchema.default("git_repo"),
  roots: z.array(WorkspaceRootInputSchema).min(1).max(16),
  hostMode: WorkspaceHostModeSchema.default("local_machine"),
  hostLabel: z.string().trim().min(1).max(120).optional(),
  sandboxMode: WorkspaceSandboxModeSchema.default("worktree_pool"),
  allowRoomCollaborators: z.boolean().default(false),
  prewarmedWorktrees: z.number().int().min(0).max(16).optional(),
  hooks: WorkspaceLifecycleHooksSchema.optional(),
  context: WorkspaceContextAssetsSchema.optional(),
  defaultTopology: WorkTopologySchema.default("verify_loop"),
  defaultWorkerAgentId: AgentIdSchema.optional(),
  defaultVerifierAgentId: AgentIdSchema.optional(),
});
export type CreateWorkspaceBody = z.infer<typeof CreateWorkspaceBodySchema>;

/** `PATCH /api/v1/workspaces/:workspaceId` 请求体 */
export const UpdateWorkspaceBodySchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  kind: WorkspaceKindSchema.optional(),
  roots: z.array(WorkspaceRootInputSchema).min(1).max(16).optional(),
  hostMode: WorkspaceHostModeSchema.optional(),
  hostLabel: z.string().trim().min(1).max(120).optional(),
  sandboxMode: WorkspaceSandboxModeSchema.optional(),
  allowRoomCollaborators: z.boolean().optional(),
  prewarmedWorktrees: z.number().int().min(0).max(16).optional(),
  hooks: WorkspaceLifecycleHooksSchema.optional(),
  context: WorkspaceContextAssetsSchema.optional(),
  defaultTopology: WorkTopologySchema.optional(),
  defaultWorkerAgentId: AgentIdSchema.nullable().optional(),
  defaultVerifierAgentId: AgentIdSchema.nullable().optional(),
});
export type UpdateWorkspaceBody = z.infer<typeof UpdateWorkspaceBodySchema>;

/** `PUT /api/v1/rooms/:roomId/workspace-binding` 请求体 */
export const BindRoomWorkspaceBodySchema = z.object({
  workspaceId: WorkspaceIdSchema.nullable(),
});
export type BindRoomWorkspaceBody = z.infer<typeof BindRoomWorkspaceBodySchema>;

/** 参与工单的 Agent 身份快照 */
export const WorkAgentRefDtoSchema = z.object({
  agentId: AgentIdSchema,
  displayName: z.string(),
  platform: AgentPlatformSchema,
  ownerUserId: UserIdSchema,
  ownerDisplayName: z.string(),
  isOwnedByViewer: z.boolean(),
});
export type WorkAgentRefDto = z.infer<typeof WorkAgentRefDtoSchema>;

/** 分片在各自宿主环境生成的三层仓外溯源回执（ADR-0010 §3.2） */
export const WorkSliceProvenanceSchema = z.object({
  agentEnvironment: z.string().trim().min(1).max(120),
  leaseRole: WorkSliceRoleSchema,
  sessionJsonlPath: z.string().trim().min(1).max(512),
  rollingMemoryPath: z.string().trim().min(1).max(512),
  workingDirectory: z.string().trim().min(1).max(1024).optional(),
  gitNotesAttached: z.boolean(),
});
export type WorkSliceProvenance = z.infer<typeof WorkSliceProvenanceSchema>;

/** 实时动态执行追踪事件分类 */
export const WorkTraceKindSchema = z.enum([
  "lease",
  "sandbox",
  "command",
  "output",
  "diff",
  "handoff",
  "steer",
  "review",
  "error",
]);
export type WorkTraceKind = z.infer<typeof WorkTraceKindSchema>;

/** 单条实时执行追踪事件（驱动前端工作台动态过程流） */
export const WorkTraceEntrySchema = z.object({
  id: z.string().trim().min(1).max(64),
  sliceId: WorkSliceIdSchema.optional(),
  actorName: z.string().trim().min(1).max(120),
  kind: WorkTraceKindSchema,
  message: z.string().trim().min(1).max(1_000),
  detail: z.string().max(4_000).optional(),
  timestampIso: z.string().datetime(),
});
export type WorkTraceEntry = z.infer<typeof WorkTraceEntrySchema>;

/** 真实 Git Unified Diff 单行结构 */
export const WorkDiffLineDtoSchema = z.object({
  kind: z.enum(["hunk", "context", "add", "del"]),
  oldLine: z.number().int().positive().optional(),
  newLine: z.number().int().positive().optional(),
  content: z.string().max(4_000),
});
export type WorkDiffLineDto = z.infer<typeof WorkDiffLineDtoSchema>;

/** 真实单个变更文件的 Unified Diff 快照 */
export const WorkDiffFileDtoSchema = z.object({
  path: z.string().trim().min(1).max(260),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  lines: z.array(WorkDiffLineDtoSchema).max(600),
});
export type WorkDiffFileDto = z.infer<typeof WorkDiffFileDtoSchema>;

/** 工单分片（Swarm Slice / Verify Node）完整状态与租约元数据 */
export const WorkSliceDtoSchema = z.object({
  sliceId: WorkSliceIdSchema,
  workItemId: WorkItemIdSchema,
  orderIndex: z.number().int().nonnegative(),
  title: z.string().min(1).max(200),
  leaseRole: WorkSliceRoleSchema,
  assignedAgent: WorkAgentRefDtoSchema,
  leaseOwnerAgentId: AgentIdSchema.optional(),
  /** 单调递增的租约防护版本号（0 表示尚未被认领） */
  leaseVersion: z.number().int().nonnegative(),
  leaseExpiresAtIso: z.string().datetime().optional(),
  attemptCount: z.number().int().nonnegative(),
  ownedPaths: z.array(z.string().min(1).max(260)).max(32),
  status: WorkSliceStatusSchema,
  liveSummary: z.string().max(1_000),
  diffAdded: z.number().int().nonnegative(),
  diffRemoved: z.number().int().nonnegative(),
  changedFiles: z.array(z.string().min(1).max(260)).max(200),
  worktreeBranch: z.string().max(160).optional(),
  steerNotes: z.array(z.string().max(1_000)).max(50),
  failureCode: z.string().max(80).optional(),
  provenance: WorkSliceProvenanceSchema.optional(),
  startedAtIso: z.string().datetime().optional(),
  completedAtIso: z.string().datetime().optional(),
});
export type WorkSliceDto = z.infer<typeof WorkSliceDtoSchema>;

/** Worker 向人类主人发起的结构化单问澄清载荷 */
export const WorkAttentionPromptDtoSchema = z.object({
  sliceId: WorkSliceIdSchema,
  question: z.string().min(1).max(600),
  askedBy: WorkAgentRefDtoSchema,
  options: z.array(z.string().min(1).max(120)).min(2).max(5),
  answeredChoice: z.string().min(1).max(240).optional(),
  askedAtIso: z.string().datetime(),
  answeredAtIso: z.string().datetime().optional(),
});
export type WorkAttentionPromptDto = z.infer<typeof WorkAttentionPromptDtoSchema>;

/** 工单聚合交付摘要与独立核验回执 */
export const WorkReviewSummaryDtoSchema = z.object({
  filesChanged: z.number().int().nonnegative(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  changedFiles: z.array(z.string().min(1).max(260)).max(200),
  /** 仅当校验命令真实执行过才出现；未配置或未运行时缺省，杜绝伪造“已通过” */
  testCommand: z.string().max(400).optional(),
  testPassed: z.boolean().optional(),
  worktreeBranch: z.string().max(160).optional(),
  verifierNote: z.string().max(2_000).optional(),
  verifyLoopsUsed: z.number().int().nonnegative(),
  reviewedByUserId: UserIdSchema.optional(),
  reviewDecisionNote: z.string().max(1_000).optional(),
  reviewedAtIso: z.string().datetime().optional(),
});
export type WorkReviewSummaryDto = z.infer<typeof WorkReviewSummaryDtoSchema>;

/** 完整多 Agent 协作工单 DTO */
export const WorkItemDtoSchema = z.object({
  id: WorkItemIdSchema,
  workspaceId: WorkspaceIdSchema,
  workspaceName: z.string(),
  ownerUserId: UserIdSchema,
  roomId: RoomIdSchema.optional(),
  anchorMessageSeq: z.number().int().nonnegative(),
  title: z.string().min(1).max(200),
  brief: z.string().min(1).max(8_000),
  topology: WorkTopologySchema,
  tier: AgentExecutionTierSchema,
  stage: WorkStageSchema,
  worktreeBranch: z.string().max(160),
  coordinator: WorkAgentRefDtoSchema.optional(),
  primaryWorker: WorkAgentRefDtoSchema,
  verifier: WorkAgentRefDtoSchema.optional(),
  slices: z.array(WorkSliceDtoSchema),
  attention: WorkAttentionPromptDtoSchema.optional(),
  review: WorkReviewSummaryDtoSchema.optional(),
  trace: z.array(WorkTraceEntrySchema).max(200).default([]),
  diffFiles: z.array(WorkDiffFileDtoSchema).max(50).default([]),
  version: z.number().int().positive(),
  createdAtIso: z.string().datetime(),
  updatedAtIso: z.string().datetime(),
});
export type WorkItemDto = z.infer<typeof WorkItemDtoSchema>;

/** 创建工单时的显式分片定义入参 */
export const CreateWorkSliceSpecSchema = z.object({
  title: z.string().trim().min(1).max(200),
  assignedAgentId: AgentIdSchema,
  leaseRole: WorkSliceRoleSchema.default("write"),
  ownedPaths: z.array(z.string().trim().min(1).max(260)).max(32).default([]),
});
export type CreateWorkSliceSpec = z.infer<typeof CreateWorkSliceSpecSchema>;

/** `POST /api/v1/work-items` 请求体 */
export const CreateWorkItemBodySchema = z.object({
  workspaceId: WorkspaceIdSchema,
  roomId: RoomIdSchema.optional(),
  title: z.string().trim().min(1).max(200).optional(),
  brief: z.string().trim().min(1).max(8_000),
  topology: WorkTopologySchema.default("verify_loop"),
  tier: AgentExecutionTierSchema.default("sandbox_branch_write"),
  coordinatorAgentId: AgentIdSchema.optional(),
  primaryWorkerAgentId: AgentIdSchema,
  verifierAgentId: AgentIdSchema.optional(),
  worktreeBranch: z.string().trim().min(1).max(160).optional(),
  slices: z.array(CreateWorkSliceSpecSchema).min(1).max(12).optional(),
  /** 客户端幂等去重键：网络超时重试携带相同 `opKey` 时返回已创建工单，不重复建单或刷屏 */
  opKey: OperationKeySchema.optional(),
});
export type CreateWorkItemBody = z.infer<typeof CreateWorkItemBodySchema>;

/** `GET /api/v1/work-items` 查询参数 */
export const ListWorkItemsQuerySchema = z.object({
  workspaceId: WorkspaceIdSchema.optional(),
  roomId: RoomIdSchema.optional(),
  stage: WorkStageSchema.optional(),
  /** 为 `true` 时仅返回当前调用 Agent 可立即认领或超时接管的分片所属工单 */
  claimableOnly: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
  /** 单页返回条数上限（1..100，默认 50） */
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type ListWorkItemsQuery = z.infer<typeof ListWorkItemsQuerySchema>;

/** `POST /api/v1/work-items/:workItemId/slices/:sliceId/claim` 请求体 */
export const ClaimWorkSliceBodySchema = z.object({
  /** Listeners claim the observed generation once, even when two devices share an Agent. */
  expectedLeaseVersion: z.number().int().nonnegative().optional(),
  leaseTtlMs: z.number().int().min(15_000).max(600_000).default(120_000),
  agentEnvironment: z.string().trim().min(1).max(120).optional(),
});
export type ClaimWorkSliceBody = z.infer<typeof ClaimWorkSliceBodySchema>;

/** `POST /api/v1/work-items/:workItemId/slices/:sliceId/heartbeat` 请求体 */
export const HeartbeatWorkSliceBodySchema = z.object({
  leaseVersion: z.number().int().positive(),
  leaseTtlMs: z.number().int().min(15_000).max(600_000).default(120_000),
  liveSummary: z.string().trim().max(1_000).optional(),
  diffAdded: z.number().int().nonnegative().optional(),
  diffRemoved: z.number().int().nonnegative().optional(),
  traceEntries: z.array(WorkTraceEntrySchema).max(20).optional(),
});
export type HeartbeatWorkSliceBody = z.infer<typeof HeartbeatWorkSliceBodySchema>;

/** `POST /api/v1/work-items/:workItemId/slices/:sliceId/attention` 请求体 */
export const RaiseWorkAttentionBodySchema = z.object({
  leaseVersion: z.number().int().positive(),
  question: z.string().trim().min(1).max(600),
  options: z.array(z.string().trim().min(1).max(120)).min(2).max(5),
});
export type RaiseWorkAttentionBody = z.infer<typeof RaiseWorkAttentionBodySchema>;

/** 独立核验分片结论枚举 */
export const WorkVerifyVerdictSchema = z.enum(["passed", "changes_requested"]);
export type WorkVerifyVerdict = z.infer<typeof WorkVerifyVerdictSchema>;

/** `POST /api/v1/work-items/:workItemId/slices/:sliceId/complete` 请求体 */
export const CompleteWorkSliceBodySchema = z.object({
  leaseVersion: z.number().int().positive(),
  summary: z.string().trim().min(1).max(1_000),
  changedFiles: z.array(z.string().trim().min(1).max(260)).max(200).default([]),
  diffAdded: z.number().int().nonnegative().default(0),
  diffRemoved: z.number().int().nonnegative().default(0),
  worktreeBranch: z.string().trim().min(1).max(160).optional(),
  testCommand: z.string().trim().min(1).max(400).optional(),
  testPassed: z.boolean().optional(),
  /** 当完成 `leaseRole === "verify"` 分片时必填核验结论（缺省视为 `"passed"`） */
  verdict: WorkVerifyVerdictSchema.optional(),
  provenance: WorkSliceProvenanceSchema.optional(),
  diffFiles: z.array(WorkDiffFileDtoSchema).max(50).optional(),
  traceEntries: z.array(WorkTraceEntrySchema).max(30).optional(),
});
export type CompleteWorkSliceBody = z.infer<typeof CompleteWorkSliceBodySchema>;

/** Shared input contracts for both MCP transports. REST bodies retain their existing fencing and bounds. */
const workSliceTarget = { workItemId: WorkItemIdSchema, sliceId: WorkSliceIdSchema };
export const WorkMcpTools = {
  openhuddle_list_workspaces: {
    description: "List workspaces owned by your human owner or bound to the given room.",
    input: z.object({ roomId: RoomIdSchema.optional() }),
  },
  openhuddle_list_work: {
    description:
      "List work items and slices. Set claimableOnly=true to discover your available work, including tasks without a room.",
    input: z.object({
      roomId: RoomIdSchema.optional(),
      workspaceId: WorkspaceIdSchema.optional(),
      stage: WorkStageSchema.optional(),
      claimableOnly: z.boolean().optional(),
    }),
  },
  openhuddle_claim_work_slice: {
    description:
      "Claim a slice and retain the returned leaseVersion for progress updates and completion.",
    input: ClaimWorkSliceBodySchema.extend(workSliceTarget),
  },
  openhuddle_update_work_slice: {
    description:
      "Renew a lease and report progress. When blocked or unable to make further progress, pause with action=raise_attention, a question and 2–5 options for the owner.",
    input: HeartbeatWorkSliceBodySchema.extend({
      ...workSliceTarget,
      action: z.enum(["heartbeat", "raise_attention"]).default("heartbeat"),
      question: RaiseWorkAttentionBodySchema.shape.question.optional(),
      options: RaiseWorkAttentionBodySchema.shape.options.optional(),
    }),
  },
  openhuddle_complete_work_slice: {
    description:
      "Submit execution results and diffs, or complete verification with a passed or changes_requested verdict.",
    input: CompleteWorkSliceBodySchema.extend(workSliceTarget),
  },
  openhuddle_put_review_evidence: {
    description:
      "Attach the assigned writer's full unified diff (up to 400 KiB) with its current leaseVersion. Use this before completion if the regular diff preview is incomplete.",
    input: PutReviewEvidenceBodySchema.extend(workSliceTarget),
  },
  openhuddle_get_review_evidence: {
    description:
      "Read a writer slice's complete patch and leaseVersion as an authorized reviewer when the work item preview is incomplete.",
    input: z.object(workSliceTarget),
  },
} as const;
export type ListWorkMcpQuery = z.infer<typeof WorkMcpTools.openhuddle_list_work.input>;

/** `POST /api/v1/work-items/:workItemId/steer` 请求体 */
export const SteerWorkItemBodySchema = z.object({
  sliceId: WorkSliceIdSchema.optional(),
  note: z.string().trim().min(1).max(1_000),
});
export type SteerWorkItemBody = z.infer<typeof SteerWorkItemBodySchema>;

/** `POST /api/v1/work-items/:workItemId/attention/answer` 请求体 */
export const AnswerWorkAttentionBodySchema = z.object({
  choice: z.string().trim().min(1).max(240),
});
export type AnswerWorkAttentionBody = z.infer<typeof AnswerWorkAttentionBodySchema>;

/** `POST /api/v1/work-items/:workItemId/review` 请求体 */
export const DecideWorkReviewBodySchema = z.object({
  decision: z.enum(["approve", "request_changes"]),
  note: z.string().trim().max(1_000).optional(),
});
export type DecideWorkReviewBody = z.infer<typeof DecideWorkReviewBodySchema>;

/** `POST /api/v1/work-items/:workItemId/control` 请求体 */
export const ControlWorkItemBodySchema = z.object({
  action: z.enum(["stop", "retry", "escalate_room"]),
  targetRoomId: RoomIdSchema.optional(),
});
export type ControlWorkItemBody = z.infer<typeof ControlWorkItemBodySchema>;

/** 工作区列表响应体 */
export const ListWorkspacesResponseSchema = z.object({
  ok: z.literal(true),
  workspaces: z.array(WorkspaceDtoSchema),
  roomBindings: z.array(RoomWorkspaceBindingDtoSchema),
});
export type ListWorkspacesResponse = z.infer<typeof ListWorkspacesResponseSchema>;

/** 单个工作区响应体 */
export const SingleWorkspaceResponseSchema = z.object({
  ok: z.literal(true),
  workspace: WorkspaceDtoSchema,
});
export type SingleWorkspaceResponse = z.infer<typeof SingleWorkspaceResponseSchema>;

/** 删除工作区响应体 */
export const DeleteWorkspaceResponseSchema = z.object({
  ok: z.literal(true),
  deletedWorkspaceId: WorkspaceIdSchema,
});
export type DeleteWorkspaceResponse = z.infer<typeof DeleteWorkspaceResponseSchema>;

/** 房间工作区绑定更新响应体 */
export const BindRoomWorkspaceResponseSchema = z.object({
  ok: z.literal(true),
  roomId: RoomIdSchema,
  binding: RoomWorkspaceBindingDtoSchema.nullable(),
});
export type BindRoomWorkspaceResponse = z.infer<typeof BindRoomWorkspaceResponseSchema>;

/** 房间内已绑定工作区列表响应体（对非主人自动剥离本机路径） */
export const RoomWorkspacesResponseSchema = z.object({
  ok: z.literal(true),
  workspaces: z.array(WorkspaceDtoSchema),
  bindings: z.array(RoomWorkspaceBindingDtoSchema),
});
export type RoomWorkspacesResponse = z.infer<typeof RoomWorkspacesResponseSchema>;

/** 工单列表响应体 */
export const ListWorkItemsResponseSchema = z.object({
  ok: z.literal(true),
  items: z.array(WorkItemDtoSchema),
});
export type ListWorkItemsResponse = z.infer<typeof ListWorkItemsResponseSchema>;

/** 单个工单响应体 */
export const SingleWorkItemResponseSchema = z.object({
  ok: z.literal(true),
  item: WorkItemDtoSchema,
});
export type SingleWorkItemResponse = z.infer<typeof SingleWorkItemResponseSchema>;

/** 分片认领成功响应体 */
export const ClaimWorkSliceResponseSchema = z.object({
  ok: z.literal(true),
  item: WorkItemDtoSchema,
  claimedSlice: WorkSliceDtoSchema,
});
export type ClaimWorkSliceResponse = z.infer<typeof ClaimWorkSliceResponseSchema>;
