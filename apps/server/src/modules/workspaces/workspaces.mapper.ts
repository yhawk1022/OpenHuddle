/**
 * @module server/modules/workspaces/mapper
 * @description 工作区与协作工单数据库记录水合、跨主人隐私脱敏（ADR-0010）及多视角 DTO 序列化器。
 *
 * 关键不变量：
 * 1. 本机路径脱敏：当查看者所属人类主人不等于 `workspace.ownerUserId` 时，`serializeWorkspaceForViewer` 强制剥离所有 `roots[*].localPath`，仅暴露仓库名、分支与脱敏远端标识。
 * 2. 历史快照兜底：参与工单的 Agent 若后续被解绑删除，优先从 `agentSnapshots` 还原展示名与平台标识，保证审计时间线永不破损。
 */
import type {
  OrchestrationItemState,
  OrchestrationReviewState,
  OrchestrationSliceState,
} from "@openhuddle/core-governance";
import {
  type AgentExecutionTier,
  AgentExecutionTierSchema,
  type AgentId,
  type AgentPlatform,
  AgentPlatformSchema,
  type AuthenticatedCaller,
  type RoomId,
  type UserId,
  type WorkAgentRefDto,
  type WorkAttentionPromptDto,
  type WorkDiffFileDto,
  WorkDiffFileDtoSchema,
  type WorkItemDto,
  type WorkItemId,
  type WorkReviewSummaryDto,
  type WorkSliceDto,
  type WorkSliceId,
  WorkSliceProvenanceSchema,
  WorkSliceRoleSchema,
  WorkSliceStatusSchema,
  type WorkStage,
  WorkStageSchema,
  type WorkTopology,
  WorkTopologySchema,
  type WorkTraceEntry,
  WorkTraceEntrySchema,
  WorkspaceContextAssetsSchema,
  type WorkspaceDto,
  type WorkspaceHostMode,
  WorkspaceHostModeSchema,
  type WorkspaceId,
  WorkspaceKindSchema,
  WorkspaceLifecycleHooksSchema,
  WorkspaceRootEntrySchema,
  type WorkspaceSandboxMode,
  WorkspaceSandboxModeSchema,
} from "@openhuddle/protocol";

/** 持久化在 `work_items.agent_snapshots_json` 内的 Agent 身份快照 */
export interface StoredAgentSnapshot {
  readonly agentId: AgentId;
  readonly displayName: string;
  readonly platform: AgentPlatform;
  readonly ownerUserId: UserId;
  readonly ownerDisplayName: string;
}

/** 持久化在 `work_items.attention_json` 内的单问澄清状态 */
export interface StoredAttentionRecord {
  readonly sliceId: WorkSliceId;
  readonly question: string;
  readonly askedByAgentId: AgentId;
  readonly options: readonly string[];
  readonly answeredChoice?: string | undefined;
  readonly askedAtMs: number;
  readonly answeredAtMs?: number | undefined;
}

/** 仓储层水合后的工作区内部记录 */
export interface HydratedWorkspaceRecord {
  readonly id: WorkspaceId;
  readonly ownerUserId: UserId;
  readonly ownerDisplayName: string;
  readonly name: string;
  readonly kind: ReturnType<typeof WorkspaceKindSchema.parse>;
  readonly roots: readonly ReturnType<typeof WorkspaceRootEntrySchema.parse>[];
  readonly hostMode: WorkspaceHostMode;
  readonly hostLabel: string;
  readonly sandboxMode: WorkspaceSandboxMode;
  readonly allowRoomCollaborators: boolean;
  readonly prewarmedWorktrees: number;
  readonly hooks: ReturnType<typeof WorkspaceLifecycleHooksSchema.parse>;
  readonly context: ReturnType<typeof WorkspaceContextAssetsSchema.parse>;
  readonly defaultTopology: WorkTopology;
  readonly defaultWorkerAgentId?: AgentId | undefined;
  readonly defaultVerifierAgentId?: AgentId | undefined;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** 仓储层水合后的协作工单内部完整记录 */
export interface HydratedWorkItemRecord {
  readonly id: WorkItemId;
  readonly workspaceId: WorkspaceId;
  readonly workspaceName: string;
  readonly workspaceOwnerUserId: UserId;
  readonly workspaceHostMode: WorkspaceHostMode;
  readonly workspaceSandboxMode: WorkspaceSandboxMode;
  readonly workspaceAllowRoomCollaborators: boolean;
  readonly workspaceVerifyCommand?: string | undefined;
  readonly ownerUserId: UserId;
  readonly roomId?: RoomId | undefined;
  readonly anchorMessageSeq: number;
  readonly title: string;
  readonly brief: string;
  readonly topology: WorkTopology;
  readonly tier: AgentExecutionTier;
  readonly stage: WorkStage;
  readonly worktreeBranch: string;
  readonly coordinatorAgentId?: AgentId | undefined;
  readonly primaryWorkerAgentId: AgentId;
  readonly verifierAgentId?: AgentId | undefined;
  readonly slices: readonly OrchestrationSliceState[];
  readonly attention?: StoredAttentionRecord | undefined;
  readonly review?: OrchestrationReviewState | undefined;
  readonly trace: readonly WorkTraceEntry[];
  readonly diffFiles: readonly WorkDiffFileDto[];
  readonly agentSnapshots: Readonly<Record<string, StoredAgentSnapshot>>;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export function parseJsonValue(raw: unknown): unknown {
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return undefined;
    }
  }
  return raw;
}

export function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

export function getViewerOwnerUserId(viewer: Readonly<AuthenticatedCaller>): UserId {
  return viewer.kind === "human" ? viewer.userId : viewer.ownerUserId;
}

function resolveAgentRefForViewer(
  agentId: AgentId,
  snapshots: Readonly<Record<string, StoredAgentSnapshot>>,
  viewerOwnerUserId: UserId,
): WorkAgentRefDto {
  const snap = snapshots[agentId];
  if (snap) {
    return {
      agentId: snap.agentId,
      displayName: snap.displayName,
      platform: snap.platform,
      ownerUserId: snap.ownerUserId,
      ownerDisplayName: snap.ownerDisplayName,
      isOwnedByViewer: snap.ownerUserId === viewerOwnerUserId,
    };
  }
  return {
    agentId,
    displayName: "Retired Agent",
    platform: "custom",
    ownerUserId: viewerOwnerUserId,
    ownerDisplayName: "Owner",
    isOwnedByViewer: false,
  };
}

/**
 * 按当前查看者身份序列化五维工作区 DTO；非主人视角自动剥离 `localPath`。
 */
export function serializeWorkspaceForViewer(
  record: Readonly<HydratedWorkspaceRecord>,
  viewer: Readonly<AuthenticatedCaller>,
  hostOnline: boolean,
): WorkspaceDto {
  const viewerOwnerId = getViewerOwnerUserId(viewer);
  const isOwnedByViewer = viewerOwnerId === record.ownerUserId;

  const roots = record.roots.map((root) => {
    if (isOwnedByViewer) {
      return root;
    }
    const { localPath: _redactedLocalPath, ...publicRoot } = root;
    return publicRoot;
  });

  return {
    id: record.id,
    ownerUserId: record.ownerUserId,
    ownerDisplayName: record.ownerDisplayName,
    isOwnedByViewer,
    name: record.name,
    kind: record.kind,
    roots,
    hostMode: record.hostMode,
    hostLabel: record.hostLabel,
    hostOnline,
    sandboxMode: record.sandboxMode,
    allowRoomCollaborators: record.allowRoomCollaborators,
    prewarmedWorktrees: record.prewarmedWorktrees,
    hooks: record.hooks,
    context: record.context,
    defaultTopology: record.defaultTopology,
    ...(record.defaultWorkerAgentId !== undefined
      ? { defaultWorkerAgentId: record.defaultWorkerAgentId }
      : {}),
    ...(record.defaultVerifierAgentId !== undefined
      ? { defaultVerifierAgentId: record.defaultVerifierAgentId }
      : {}),
    createdAtIso: record.createdAt.toISOString(),
    updatedAtIso: record.updatedAt.toISOString(),
  };
}

/**
 * 提取供 `@openhuddle/core-governance` 纯函数编排核计算的最小聚合状态。
 */
export function toOrchestrationItemState(
  record: Readonly<HydratedWorkItemRecord>,
): OrchestrationItemState {
  return {
    topology: record.topology,
    stage: record.stage,
    worktreeBranch: record.worktreeBranch,
    ...(record.workspaceVerifyCommand !== undefined
      ? { defaultVerifyCommand: record.workspaceVerifyCommand }
      : {}),
    slices: record.slices,
    ...(record.review !== undefined ? { review: record.review } : {}),
  };
}

/**
 * 按当前查看者身份序列化协作工单完整 DTO。
 */
export function serializeWorkItemForViewer(
  record: Readonly<HydratedWorkItemRecord>,
  viewer: Readonly<AuthenticatedCaller>,
): WorkItemDto {
  const viewerOwnerId = getViewerOwnerUserId(viewer);
  const resolveRef = (id: AgentId): WorkAgentRefDto =>
    resolveAgentRefForViewer(id, record.agentSnapshots, viewerOwnerId);

  const slices: WorkSliceDto[] = record.slices.map((s) => ({
    sliceId: s.sliceId,
    workItemId: record.id,
    orderIndex: s.orderIndex,
    title: s.title,
    leaseRole: s.leaseRole,
    assignedAgent: resolveRef(s.assignedAgentId),
    ...(s.leaseOwnerAgentId !== undefined ? { leaseOwnerAgentId: s.leaseOwnerAgentId } : {}),
    leaseVersion: s.leaseVersion,
    ...(s.leaseExpiresAtMs !== undefined
      ? { leaseExpiresAtIso: new Date(s.leaseExpiresAtMs).toISOString() }
      : {}),
    attemptCount: s.attemptCount,
    ownedPaths: [...s.ownedPaths],
    status: s.status,
    liveSummary: s.liveSummary,
    diffAdded: s.diffAdded,
    diffRemoved: s.diffRemoved,
    changedFiles: [...s.changedFiles],
    ...(s.worktreeBranch !== undefined ? { worktreeBranch: s.worktreeBranch } : {}),
    steerNotes: [...s.steerNotes],
    ...(s.failureCode !== undefined ? { failureCode: s.failureCode } : {}),
    ...(s.provenance !== undefined
      ? {
          provenance: {
            ...s.provenance,
            workingDirectory:
              record.agentSnapshots[s.assignedAgentId]?.ownerUserId === viewerOwnerId
                ? s.provenance.workingDirectory
                : undefined,
          },
        }
      : {}),
    ...(s.startedAtMs !== undefined ? { startedAtIso: new Date(s.startedAtMs).toISOString() } : {}),
    ...(s.completedAtMs !== undefined
      ? { completedAtIso: new Date(s.completedAtMs).toISOString() }
      : {}),
  }));

  const attention: WorkAttentionPromptDto | undefined =
    record.attention !== undefined
      ? {
          sliceId: record.attention.sliceId,
          question: record.attention.question,
          askedBy: resolveRef(record.attention.askedByAgentId),
          options: [...record.attention.options],
          ...(record.attention.answeredChoice !== undefined
            ? { answeredChoice: record.attention.answeredChoice }
            : {}),
          askedAtIso: new Date(record.attention.askedAtMs).toISOString(),
          ...(record.attention.answeredAtMs !== undefined
            ? { answeredAtIso: new Date(record.attention.answeredAtMs).toISOString() }
            : {}),
        }
      : undefined;

  const review: WorkReviewSummaryDto | undefined =
    record.review !== undefined
      ? {
          filesChanged: record.review.filesChanged,
          additions: record.review.additions,
          deletions: record.review.deletions,
          changedFiles: [...record.review.changedFiles],
          ...(record.review.testCommand !== undefined
            ? {
                testCommand: record.review.testCommand,
                testPassed: record.review.testPassed ?? false,
              }
            : {}),
          ...(record.review.worktreeBranch !== undefined
            ? { worktreeBranch: record.review.worktreeBranch }
            : {}),
          ...(record.review.verifierNote !== undefined
            ? { verifierNote: record.review.verifierNote }
            : {}),
          verifyLoopsUsed: record.review.verifyLoopsUsed,
          ...(record.review.reviewedByUserId !== undefined
            ? { reviewedByUserId: record.review.reviewedByUserId }
            : {}),
          ...(record.review.reviewDecisionNote !== undefined
            ? { reviewDecisionNote: record.review.reviewDecisionNote }
            : {}),
          ...(record.review.reviewedAtMs !== undefined
            ? { reviewedAtIso: new Date(record.review.reviewedAtMs).toISOString() }
            : {}),
        }
      : undefined;

  return {
    id: record.id,
    workspaceId: record.workspaceId,
    workspaceName: record.workspaceName,
    ownerUserId: record.ownerUserId,
    ...(record.roomId !== undefined ? { roomId: record.roomId } : {}),
    anchorMessageSeq: record.anchorMessageSeq,
    title: record.title,
    brief: record.brief,
    topology: record.topology,
    tier: record.tier,
    stage: record.stage,
    worktreeBranch: record.worktreeBranch,
    ...(record.coordinatorAgentId !== undefined
      ? { coordinator: resolveRef(record.coordinatorAgentId) }
      : {}),
    primaryWorker: resolveRef(record.primaryWorkerAgentId),
    ...(record.verifierAgentId !== undefined
      ? { verifier: resolveRef(record.verifierAgentId) }
      : {}),
    slices,
    ...(attention !== undefined ? { attention } : {}),
    ...(review !== undefined ? { review } : {}),
    trace: [...record.trace],
    diffFiles: record.diffFiles.map((file) => ({
      ...file,
      lines: [...file.lines],
    })),
    version: record.version,
    createdAtIso: record.createdAt.toISOString(),
    updatedAtIso: record.updatedAt.toISOString(),
  };
}

/**
 * 解析数据库中的 `work_slices` 原始行。
 */
export function parseRawSliceRow(row: {
  readonly id: string;
  readonly orderIndex: number;
  readonly title: string;
  readonly leaseRole: string;
  readonly assignedAgentId: string;
  readonly leaseOwnerAgentId: string | null;
  readonly leaseVersion: number;
  readonly leaseExpiresAt: Date | string | null;
  readonly attemptCount: number;
  readonly ownedPathsJson: unknown;
  readonly status: string;
  readonly liveSummary: string;
  readonly diffAdded: number;
  readonly diffRemoved: number;
  readonly changedFilesJson: unknown;
  readonly worktreeBranch: string | null;
  readonly steerNotesJson: unknown;
  readonly failureCode: string | null;
  readonly provenanceJson: unknown;
  readonly startedAt: Date | string | null;
  readonly completedAt: Date | string | null;
}): OrchestrationSliceState {
  const rawPaths = parseJsonValue(row.ownedPathsJson);
  const rawFiles = parseJsonValue(row.changedFilesJson);
  const rawSteer = parseJsonValue(row.steerNotesJson);
  const provParsed = WorkSliceProvenanceSchema.safeParse(parseJsonValue(row.provenanceJson));

  return {
    sliceId: row.id as WorkSliceId,
    orderIndex: Number(row.orderIndex),
    title: row.title,
    leaseRole: WorkSliceRoleSchema.parse(row.leaseRole),
    assignedAgentId: row.assignedAgentId as AgentId,
    ...(row.leaseOwnerAgentId !== null
      ? { leaseOwnerAgentId: row.leaseOwnerAgentId as AgentId }
      : {}),
    leaseVersion: Number(row.leaseVersion),
    ...(row.leaseExpiresAt !== null
      ? { leaseExpiresAtMs: toDate(row.leaseExpiresAt).getTime() }
      : {}),
    attemptCount: Number(row.attemptCount),
    ownedPaths: Array.isArray(rawPaths)
      ? rawPaths.filter((v): v is string => typeof v === "string")
      : [],
    status: WorkSliceStatusSchema.parse(row.status),
    liveSummary: row.liveSummary,
    diffAdded: Number(row.diffAdded),
    diffRemoved: Number(row.diffRemoved),
    changedFiles: Array.isArray(rawFiles)
      ? rawFiles.filter((v): v is string => typeof v === "string")
      : [],
    ...(row.worktreeBranch !== null ? { worktreeBranch: row.worktreeBranch } : {}),
    steerNotes: Array.isArray(rawSteer)
      ? rawSteer.filter((v): v is string => typeof v === "string")
      : [],
    ...(row.failureCode !== null ? { failureCode: row.failureCode } : {}),
    ...(provParsed.success ? { provenance: provParsed.data } : {}),
    ...(row.startedAt !== null ? { startedAtMs: toDate(row.startedAt).getTime() } : {}),
    ...(row.completedAt !== null ? { completedAtMs: toDate(row.completedAt).getTime() } : {}),
  };
}

/**
 * 解析数据库中的 `workspaces` 原始联表行。
 */
export function parseRawWorkspaceRow(row: {
  readonly id: string;
  readonly ownerUserId: string;
  readonly ownerDisplayName: string | null;
  readonly name: string;
  readonly kind: string;
  readonly rootsJson: unknown;
  readonly hostMode: string;
  readonly hostLabel: string;
  readonly sandboxMode: string;
  readonly allowRoomCollaborators: boolean;
  readonly prewarmedWorktrees: number;
  readonly hooksJson: unknown;
  readonly contextJson: unknown;
  readonly defaultTopology: string;
  readonly defaultWorkerAgentId: string | null;
  readonly defaultVerifierAgentId: string | null;
  readonly createdAt: Date | string;
  readonly updatedAt: Date | string;
}): HydratedWorkspaceRecord {
  const rawRoots = parseJsonValue(row.rootsJson);
  const roots = Array.isArray(rawRoots)
    ? rawRoots
        .map((item) => WorkspaceRootEntrySchema.safeParse(item))
        .filter((r) => r.success)
        .map((r) => r.data)
    : [];

  const hooksParsed = WorkspaceLifecycleHooksSchema.safeParse(parseJsonValue(row.hooksJson));
  const contextParsed = WorkspaceContextAssetsSchema.safeParse(parseJsonValue(row.contextJson));

  return {
    id: row.id as WorkspaceId,
    ownerUserId: row.ownerUserId as UserId,
    ownerDisplayName: row.ownerDisplayName ?? "Owner",
    name: row.name,
    kind: WorkspaceKindSchema.parse(row.kind),
    roots,
    hostMode: WorkspaceHostModeSchema.parse(row.hostMode),
    hostLabel: row.hostLabel,
    sandboxMode: WorkspaceSandboxModeSchema.parse(row.sandboxMode),
    allowRoomCollaborators: Boolean(row.allowRoomCollaborators),
    prewarmedWorktrees: Number(row.prewarmedWorktrees),
    hooks: hooksParsed.success ? hooksParsed.data : {},
    context: contextParsed.success
      ? contextParsed.data
      : { ruleFiles: [], skillCount: 0, sharedMemoryActive: false },
    defaultTopology: WorkTopologySchema.parse(row.defaultTopology),
    ...(row.defaultWorkerAgentId !== null
      ? { defaultWorkerAgentId: row.defaultWorkerAgentId as AgentId }
      : {}),
    ...(row.defaultVerifierAgentId !== null
      ? { defaultVerifierAgentId: row.defaultVerifierAgentId as AgentId }
      : {}),
    createdAt: toDate(row.createdAt),
    updatedAt: toDate(row.updatedAt),
  };
}

export function parseStoredAttention(raw: unknown): StoredAttentionRecord | undefined {
  const obj = parseJsonValue(raw);
  if (typeof obj !== "object" || obj === null) {
    return undefined;
  }
  const rec = obj as Record<string, unknown>;
  if (
    typeof rec.sliceId !== "string" ||
    typeof rec.question !== "string" ||
    typeof rec.askedByAgentId !== "string" ||
    !Array.isArray(rec.options) ||
    typeof rec.askedAtMs !== "number"
  ) {
    return undefined;
  }
  return {
    sliceId: rec.sliceId as WorkSliceId,
    question: rec.question,
    askedByAgentId: rec.askedByAgentId as AgentId,
    options: rec.options.filter((v): v is string => typeof v === "string"),
    ...(typeof rec.answeredChoice === "string" ? { answeredChoice: rec.answeredChoice } : {}),
    askedAtMs: rec.askedAtMs,
    ...(typeof rec.answeredAtMs === "number" ? { answeredAtMs: rec.answeredAtMs } : {}),
  };
}

export function parseStoredReview(raw: unknown): OrchestrationReviewState | undefined {
  const obj = parseJsonValue(raw);
  if (typeof obj !== "object" || obj === null) {
    return undefined;
  }
  const rec = obj as Record<string, unknown>;
  if (typeof rec.filesChanged !== "number") {
    return undefined;
  }
  const changedFiles = Array.isArray(rec.changedFiles)
    ? rec.changedFiles.filter((v): v is string => typeof v === "string")
    : [];
  return {
    filesChanged: rec.filesChanged,
    additions: typeof rec.additions === "number" ? rec.additions : 0,
    deletions: typeof rec.deletions === "number" ? rec.deletions : 0,
    changedFiles,
    ...(typeof rec.testCommand === "string"
      ? { testCommand: rec.testCommand, testPassed: rec.testPassed === true }
      : {}),
    ...(typeof rec.worktreeBranch === "string" ? { worktreeBranch: rec.worktreeBranch } : {}),
    ...(typeof rec.verifierNote === "string" ? { verifierNote: rec.verifierNote } : {}),
    verifyLoopsUsed: typeof rec.verifyLoopsUsed === "number" ? rec.verifyLoopsUsed : 0,
    ...(typeof rec.reviewedByUserId === "string"
      ? { reviewedByUserId: rec.reviewedByUserId as UserId }
      : {}),
    ...(typeof rec.reviewDecisionNote === "string"
      ? { reviewDecisionNote: rec.reviewDecisionNote }
      : {}),
    ...(typeof rec.reviewedAtMs === "number" ? { reviewedAtMs: rec.reviewedAtMs } : {}),
  };
}

export function parseStoredAgentSnapshots(raw: unknown): Record<string, StoredAgentSnapshot> {
  const obj = parseJsonValue(raw);
  const out: Record<string, StoredAgentSnapshot> = {};
  if (typeof obj !== "object" || obj === null) {
    return out;
  }
  for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
    if (typeof val !== "object" || val === null) continue;
    const item = val as Record<string, unknown>;
    const platformParsed = AgentPlatformSchema.safeParse(item.platform);
    if (
      typeof item.agentId === "string" &&
      typeof item.displayName === "string" &&
      typeof item.ownerUserId === "string" &&
      platformParsed.success
    ) {
      out[key] = {
        agentId: item.agentId as AgentId,
        displayName: item.displayName,
        platform: platformParsed.data,
        ownerUserId: item.ownerUserId as UserId,
        ownerDisplayName:
          typeof item.ownerDisplayName === "string" ? item.ownerDisplayName : "Owner",
      };
    }
  }
  return out;
}

export function parseWorkItemMetaFields(row: {
  readonly topology: string;
  readonly tier: string;
  readonly stage: string;
}): {
  readonly topology: WorkTopology;
  readonly tier: AgentExecutionTier;
  readonly stage: WorkStage;
} {
  return {
    topology: WorkTopologySchema.parse(row.topology),
    tier: AgentExecutionTierSchema.parse(row.tier),
    stage: WorkStageSchema.parse(row.stage),
  };
}

export function parseStoredTraceEntries(raw: unknown): readonly WorkTraceEntry[] {
  const arr = parseJsonValue(raw);
  if (!Array.isArray(arr)) {
    return [];
  }
  const out: WorkTraceEntry[] = [];
  for (const item of arr) {
    const parsed = WorkTraceEntrySchema.safeParse(item);
    if (parsed.success) {
      out.push(parsed.data);
    }
  }
  return out;
}

export function parseStoredDiffFiles(raw: unknown): readonly WorkDiffFileDto[] {
  const arr = parseJsonValue(raw);
  if (!Array.isArray(arr)) {
    return [];
  }
  const out: WorkDiffFileDto[] = [];
  for (const item of arr) {
    const parsed = WorkDiffFileDtoSchema.safeParse(item);
    if (parsed.success) {
      out.push(parsed.data);
    }
  }
  return out;
}
