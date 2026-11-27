/**
 * @module web/features/huddle-room/work/work-server-sync
 * @description 前端工作台与群聊工单存储同 `/api/v1/workspaces`、`/api/v1/work-items` 及 SSE 实时流的桥接同步与动作编排器。
 *
 * 性能与一致性不变量：
 * 1. 按域分流拉取：`workspace.updated` 仅刷新工作区元数据，`work.updated` 仅刷新工单状态，`work.trace` 直接在内存追加实时追踪流，消除高频流式输出引发的冗余 HTTP 往返。
 * 2. 尾部防抖合并与乱序屏障：高频 `work.updated` 按 180ms 窗口合并为单次请求，并以单调递增 `requestSeq` 丢弃晚到的旧快照，防止网络乱序回退界面状态。
 */
import type {
  AgentId,
  CreateWorkSliceSpec,
  OperationKey,
  OwnedAgentSummaryDto,
  RoomId,
  RoomWorkspaceBindingDto,
  WorkAgentRefDto,
  WorkItemDto,
  WorkItemId,
  WorkSliceId,
  WorkspaceDto,
  WorkspaceId,
} from "@openhuddle/protocol";
import { useEffect, useRef } from "react";
import type { AgentExecutionTier } from "../../../lib/agent-capability-prefs.js";
import {
  answerWorkAttentionApi,
  bindRoomWorkspaceApi,
  controlWorkItemApi,
  createWorkItemApi,
  createWorkspaceApi,
  decideWorkReviewApi,
  deleteWorkspaceApi,
  fetchOwnedWorkspaces,
  fetchWorkItems,
  steerWorkItemApi,
  updateWorkspaceApi,
} from "../../../lib/api-client.js";
import { subscribeWorkRealtimeSignals } from "../../../lib/sse-sync.js";
import { getWorkbenchTranslator } from "../i18n/workbench.js";
import {
  answerRoomWorkAttention,
  decideRoomWorkReview,
  hydrateServerRoomWorkItems,
  retryRoomWorkItem,
  steerRoomWorkSlice,
  stopRoomWorkItem,
} from "./room-work-store.js";
import {
  type AgentWorkspace,
  type SoloWorkTaskView,
  type UpsertAgentWorkspaceInput,
  answerSoloWorkAttention,
  appendRealtimeWorkTraceInStore,
  bindRoomToWorkspace,
  decideSoloWorkReview,
  deleteAgentWorkspace,
  hydrateServerWorkspacesAndTasks,
  removeServerWorkspaceFromStore,
  retrySoloWorkTask,
  steerSoloWorkSlice,
  stopSoloWorkTask,
  upsertAgentWorkspace,
  upsertServerWorkItemInStore,
  upsertServerWorkspaceInStore,
} from "./solo-workbench-store.js";
import type { RoomWorkItemView, WorkAgentRef, WorkSliceNode, WorkTopology } from "./work-types.js";
import {
  normalizeWorkspaceRoots,
  parsePromptTopologyDirective,
  resolveEffectiveDispatchTopology,
  workspaceSupportsSwarm,
} from "./work-utils.js";

function toWebExecutionTier(tier: WorkItemDto["tier"]): AgentExecutionTier {
  if (tier === "chat_only" || tier === "workspace_read") {
    return tier;
  }
  return "worktree_write";
}

function toWorkAgentRef(dto: Readonly<WorkAgentRefDto>): WorkAgentRef {
  return {
    agentId: dto.agentId,
    displayName: dto.displayName,
    platform: dto.platform,
    isOwnedByViewer: dto.isOwnedByViewer,
    ownerDisplayName: dto.ownerDisplayName,
  };
}

export function toAgentWorkspaceView(dto: Readonly<WorkspaceDto>): AgentWorkspace {
  const roots = dto.roots.map((r) => ({
    id: r.id,
    name: r.name,
    localPath: r.localPath ?? r.remoteSlug ?? `(${dto.name})`,
    isGitRepo: r.isGitRepo,
    ...(r.defaultBranch !== undefined ? { defaultBranch: r.defaultBranch } : {}),
    ...(r.remoteSlug !== undefined ? { remoteSlug: r.remoteSlug } : {}),
  }));
  const primary = roots[0];

  return {
    id: dto.id,
    name: dto.name,
    kind: dto.kind,
    roots,
    localPath: primary?.localPath ?? `(${dto.name})`,
    defaultBranch: dto.kind === "folder" ? "—" : (primary?.defaultBranch ?? "main"),
    host: {
      mode: dto.hostMode,
      hostLabel: dto.hostLabel,
      online: dto.hostOnline,
    },
    sandboxMode: dto.sandboxMode,
    prewarmedWorktrees: dto.prewarmedWorktrees,
    hooks: {
      ...(dto.hooks.setupCommand !== undefined ? { setupCommand: dto.hooks.setupCommand } : {}),
      ...(dto.hooks.verifyCommand !== undefined ? { verifyCommand: dto.hooks.verifyCommand } : {}),
      ...(dto.hooks.copyEnvGlobs !== undefined ? { copyEnvGlobs: dto.hooks.copyEnvGlobs } : {}),
    },
    context: {
      ruleFiles: dto.context.ruleFiles,
      skillCount: dto.context.skillCount,
      sharedMemoryActive: dto.context.sharedMemoryActive,
    },
    defaultTopology: dto.defaultTopology,
    ...(dto.defaultWorkerAgentId !== undefined
      ? { defaultWorkerId: dto.defaultWorkerAgentId }
      : {}),
    ...(dto.defaultVerifierAgentId !== undefined
      ? { defaultVerifierId: dto.defaultVerifierAgentId }
      : {}),
  };
}

const genericQueueSummaries = new Set([
  "",
  "Queued for worker claim.",
  "Waiting for execution slices to complete.",
  "Ready for independent verification.",
]);

function mapSlices(item: Readonly<WorkItemDto>, nowMs: number): ReadonlyArray<WorkSliceNode> {
  const { t } = getWorkbenchTranslator();
  return item.slices.map((s) => {
    const startMs = s.startedAtIso ? Date.parse(s.startedAtIso) : Date.parse(item.createdAtIso);
    const endMs = s.completedAtIso ? Date.parse(s.completedAtIso) : nowMs;
    const elapsedSec = Math.max(0, Math.round((endMs - startMs) / 1_000));

    return {
      sliceId: s.sliceId,
      title: s.title,
      worker: toWorkAgentRef(s.assignedAgent),
      leaseRole: s.leaseRole,
      ...(s.worktreeBranch !== undefined ? { worktreeBranch: s.worktreeBranch } : {}),
      ownedPaths: s.ownedPaths,
      status: s.status,
      liveSummary:
        s.status === "waiting" &&
        genericQueueSummaries.has(s.liveSummary) &&
        (item.stage === "working" || item.stage === "verifying")
          ? s.leaseRole === "verify" && item.stage === "working"
            ? t("slice.waitingVerifyAfterExec")
            : s.leaseRole === "verify"
              ? t("slice.waitingClaimVerify", { agent: s.assignedAgent.displayName })
              : t("slice.waitingClaimExec", { agent: s.assignedAgent.displayName })
          : s.liveSummary,
      elapsedSec,
      ...(s.diffAdded > 0 ? { diffAdded: s.diffAdded } : {}),
      ...(s.diffRemoved > 0 ? { diffRemoved: s.diffRemoved } : {}),
      steerNotes: s.steerNotes,
      ...(s.failureCode !== undefined ? { failureCode: s.failureCode } : {}),
      ...(s.provenance !== undefined ? { provenance: s.provenance } : {}),
    };
  });
}

export function toSoloWorkTaskView(item: Readonly<WorkItemDto>, nowMs: number): SoloWorkTaskView {
  return {
    id: item.id,
    title: item.title,
    brief: item.brief,
    repoId: item.workspaceId,
    repoName: item.workspaceName,
    worktreeBranch: item.worktreeBranch,
    topology: item.topology,
    tier: toWebExecutionTier(item.tier),
    stage: item.stage,
    warmHitMs: 95,
    ...(item.coordinator !== undefined ? { coordinator: toWorkAgentRef(item.coordinator) } : {}),
    primaryWorker: toWorkAgentRef(item.primaryWorker),
    ...(item.verifier !== undefined ? { verifier: toWorkAgentRef(item.verifier) } : {}),
    slices: mapSlices(item, nowMs),
    ...(item.attention !== undefined
      ? {
          attention: {
            question: item.attention.question,
            askedBy: toWorkAgentRef(item.attention.askedBy),
            options: item.attention.options,
            ...(item.attention.answeredChoice !== undefined
              ? { answeredChoice: item.attention.answeredChoice }
              : {}),
          },
        }
      : {}),
    ...(item.review !== undefined
      ? {
          review: {
            filesChanged: item.review.filesChanged,
            additions: item.review.additions,
            deletions: item.review.deletions,
            changedFiles: item.review.changedFiles,
            ...(item.review.testCommand !== undefined
              ? { testCommand: item.review.testCommand, testPassed: item.review.testPassed }
              : {}),
            ...(item.review.worktreeBranch !== undefined
              ? { worktreeBranch: item.review.worktreeBranch }
              : {}),
            ...(item.review.verifierNote !== undefined
              ? { verifierNote: item.review.verifierNote }
              : {}),
            verifyLoopsUsed: item.review.verifyLoopsUsed,
          },
        }
      : {}),
    trace: item.trace,
    diffFiles: item.diffFiles.map((file) => ({
      path: file.path,
      additions: file.additions,
      deletions: file.deletions,
      lines: file.lines.map((line) => ({
        kind: line.kind,
        ...(line.oldLine !== undefined ? { oldLine: line.oldLine } : {}),
        ...(line.newLine !== undefined ? { newLine: line.newLine } : {}),
        content: line.content,
      })),
    })),
    ...(item.roomId !== undefined
      ? { escalatedRoomId: item.roomId, linkedRoomWorkId: item.id }
      : {}),
    createdAtIso: item.createdAtIso,
    updatedAtIso: item.updatedAtIso,
  };
}

export function toRoomWorkItemView(
  item: Readonly<WorkItemDto>,
  roomId: RoomId,
  nowMs: number,
): RoomWorkItemView {
  return {
    id: item.id,
    roomId,
    anchorSeq: item.anchorMessageSeq,
    title: item.title,
    brief: item.brief,
    topology: item.topology,
    tier: toWebExecutionTier(item.tier),
    stage: item.stage,
    ...(item.coordinator !== undefined ? { coordinator: toWorkAgentRef(item.coordinator) } : {}),
    primaryWorker: toWorkAgentRef(item.primaryWorker),
    ...(item.verifier !== undefined ? { verifier: toWorkAgentRef(item.verifier) } : {}),
    slices: mapSlices(item, nowMs),
    ...(item.attention !== undefined
      ? {
          attention: {
            question: item.attention.question,
            askedBy: toWorkAgentRef(item.attention.askedBy),
            options: item.attention.options,
            ...(item.attention.answeredChoice !== undefined
              ? { answeredChoice: item.attention.answeredChoice }
              : {}),
          },
        }
      : {}),
    ...(item.review !== undefined
      ? {
          review: {
            filesChanged: item.review.filesChanged,
            additions: item.review.additions,
            deletions: item.review.deletions,
            changedFiles: item.review.changedFiles,
            ...(item.review.testCommand !== undefined
              ? { testCommand: item.review.testCommand, testPassed: item.review.testPassed }
              : {}),
            ...(item.review.worktreeBranch !== undefined
              ? { worktreeBranch: item.review.worktreeBranch }
              : {}),
            ...(item.review.verifierNote !== undefined
              ? { verifierNote: item.review.verifierNote }
              : {}),
            verifyLoopsUsed: item.review.verifyLoopsUsed,
          },
        }
      : {}),
    linkedSoloTaskId: item.id,
    createdAtIso: item.createdAtIso,
    updatedAtIso: item.updatedAtIso,
  };
}

function bindingsListToRecord(
  bindings: ReadonlyArray<RoomWorkspaceBindingDto>,
): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const b of bindings) {
    out[b.roomId] = b.workspaceId;
  }
  return out;
}

/**
 * 调用后端创建或更新受控工作区，并立即写回前端工作台存储。
 */
export async function saveWorkspaceOnServer(
  input: UpsertAgentWorkspaceInput,
): Promise<AgentWorkspace> {
  const { t } = getWorkbenchTranslator();
  const cleanName = input.name.trim() || t("workspace.unnamed");
  const isFolder = input.kind === "folder";
  const effectiveSandbox =
    isFolder && input.sandboxMode === "worktree_pool" ? "in_place" : input.sandboxMode;
  const { roots, kind } = normalizeWorkspaceRoots(input);
  const normalizedRoots = roots.map((root) => ({ ...root, isGitRepo: !isFolder }));

  const hooksPayload = {
    ...(input.setupCommand?.trim() ? { setupCommand: input.setupCommand.trim() } : {}),
    ...(input.verifyCommand?.trim() ? { verifyCommand: input.verifyCommand.trim() } : {}),
  };

  if (input.id?.startsWith("wsp_")) {
    const res = await updateWorkspaceApi(input.id as WorkspaceId, {
      name: cleanName,
      kind,
      roots: normalizedRoots,
      ...(input.hostMode !== undefined ? { hostMode: input.hostMode } : {}),
      ...(input.hostLabel?.trim() ? { hostLabel: input.hostLabel.trim() } : {}),
      sandboxMode: effectiveSandbox,
      hooks: hooksPayload,
      ...(input.defaultTopology !== undefined ? { defaultTopology: input.defaultTopology } : {}),
      defaultWorkerAgentId: input.defaultWorkerId ?? null,
      ...(input.defaultVerifierId !== undefined
        ? { defaultVerifierAgentId: input.defaultVerifierId }
        : {}),
    });
    const view = toAgentWorkspaceView(res.workspace);
    upsertServerWorkspaceInStore(view);
    return view;
  }

  if (input.id !== undefined && !input.id.startsWith("wsp_")) {
    return upsertAgentWorkspace(input);
  }

  const res = await createWorkspaceApi({
    name: cleanName,
    kind,
    roots: normalizedRoots,
    hostMode: input.hostMode ?? "local_machine",
    ...(input.hostLabel?.trim() ? { hostLabel: input.hostLabel.trim() } : {}),
    sandboxMode: effectiveSandbox,
    allowRoomCollaborators: input.hostMode === "shared_container",
    hooks: hooksPayload,
    defaultTopology: input.defaultTopology ?? (isFolder ? "direct" : "verify_loop"),
    ...(input.defaultWorkerId !== undefined ? { defaultWorkerAgentId: input.defaultWorkerId } : {}),
    ...(input.defaultVerifierId !== undefined
      ? { defaultVerifierAgentId: input.defaultVerifierId }
      : {}),
  });
  const view = toAgentWorkspaceView(res.workspace);
  upsertServerWorkspaceInStore(view);
  return view;
}

/**
 * 调用后端删除指定工作区并清理前端引用。
 */
export async function deleteWorkspaceOnServer(workspaceId: string): Promise<void> {
  if (!workspaceId.startsWith("wsp_")) {
    deleteAgentWorkspace(workspaceId);
    return;
  }
  await deleteWorkspaceApi(workspaceId as WorkspaceId);
  removeServerWorkspaceFromStore(workspaceId);
}

/**
 * 调用后端绑定或解除房间默认工作区。
 */
export async function bindRoomWorkspaceOnServer(
  roomId: RoomId,
  workspaceId: string | null,
): Promise<void> {
  bindRoomToWorkspace(roomId, workspaceId);
  if (workspaceId !== null && !workspaceId.startsWith("wsp_")) {
    return;
  }
  await bindRoomWorkspaceApi(roomId, {
    workspaceId: workspaceId !== null ? (workspaceId as WorkspaceId) : null,
  });
}

export function buildSwarmDisjointSlices(params: {
  readonly workspace: AgentWorkspace;
  readonly title: string;
  readonly workerAId: AgentId;
  readonly workerBId: AgentId;
  readonly leaseRole: "write" | "read";
}): readonly CreateWorkSliceSpec[] {
  if (!workspaceSupportsSwarm(params.workspace)) {
    return [];
  }
  const { t } = getWorkbenchTranslator();
  const workers = [params.workerAId, params.workerBId] as const;
  return params.workspace.roots.map((root, index) => {
    const rootName = root.name.trim();
    const assignedAgentId = workers[index % workers.length] ?? params.workerAId;
    return {
      title: t("slice.swarmTitle", {
        letter: String.fromCharCode(65 + (index % 26)),
        rootName,
        taskTitle: params.title.slice(0, 24),
      }),
      assignedAgentId,
      leaseRole: params.leaseRole,
      ownedPaths: [`${rootName}/**`],
    };
  });
}

/** 有实时监听连接的设备在自动分配时优先，同类候选保留配置和原有顺序。 */
export function pickWorkbenchAgent(
  candidates: ReadonlyArray<OwnedAgentSummaryDto>,
  preferredId?: AgentId,
  defaultId?: AgentId,
): OwnedAgentSummaryDto | undefined {
  if (preferredId !== undefined) {
    const preferred = candidates.find((agent) => agent.id === preferredId);
    if (!preferred) {
      throw new Error(getWorkbenchTranslator().t("error.selectedAgentUnavailable"));
    }
    return preferred;
  }
  const configured = candidates.find((agent) => agent.id === defaultId);
  if (configured?.workspaceListenerConnected) return configured;
  const workListener = candidates.find((agent) => agent.workspaceListenerConnected);
  if (workListener) return workListener;
  if (configured?.reach === "online_sse") return configured;
  const listening = candidates.find((agent) => agent.reach === "online_sse");
  if (listening) return listening;
  if (configured && configured.reach !== "offline") return configured;
  return candidates.find((agent) => agent.reach !== "offline") ?? configured ?? candidates[0];
}

/**
 * 在真实后端工作区上创建并派发多 Agent 协作任务（立即唤醒本机执行器或远端已连入 Agent）。
 */
export async function dispatchWorkbenchTaskOnServer(input: {
  readonly rawPrompt: string;
  readonly topology: WorkTopology;
  readonly workspace: AgentWorkspace | undefined;
  readonly ownedAgents: ReadonlyArray<OwnedAgentSummaryDto>;
  readonly preferredWorkerId?: AgentId | undefined;
  readonly preferredVerifierId?: AgentId | undefined;
  readonly roomId?: RoomId | undefined;
}): Promise<SoloWorkTaskView> {
  const { t } = getWorkbenchTranslator();
  if (!input.workspace || !input.workspace.id.startsWith("wsp_")) {
    throw new Error(t("error.workspaceRequired"));
  }
  if (input.ownedAgents.length === 0) {
    throw new Error(t("error.agentRequired"));
  }

  const { topology: parsedTopology, body } = parsePromptTopologyDirective(
    input.rawPrompt,
    input.topology,
  );
  const effectiveTopology = resolveEffectiveDispatchTopology({
    requested: parsedTopology,
    workspace: input.workspace,
    agentCount: input.ownedAgents.length,
  });
  const cleanBrief = body.trim() || input.rawPrompt.trim();
  const firstLine = cleanBrief.split(/\r?\n/)[0]?.trim() ?? t("task.defaultWorkspaceTitle");
  const title = firstLine.length > 64 ? `${firstLine.slice(0, 64)}…` : firstLine;

  const primaryWorkerId = pickWorkbenchAgent(
    input.ownedAgents,
    input.preferredWorkerId,
    input.workspace.defaultWorkerId,
  )?.id;
  if (!primaryWorkerId) {
    throw new Error(t("error.noAvailableWorker"));
  }

  const peers = input.ownedAgents.filter((agent) => agent.id !== primaryWorkerId);
  const distinctPeerAgent = pickWorkbenchAgent(peers);
  const verifierAgentId =
    effectiveTopology === "direct"
      ? undefined
      : input.preferredVerifierId !== undefined
        ? pickWorkbenchAgent(input.ownedAgents, input.preferredVerifierId)?.id
        : (input.ownedAgents.find((agent) => agent.id === input.workspace?.defaultVerifierId)?.id ??
          distinctPeerAgent?.id ??
          primaryWorkerId);

  const isReadOnly = input.workspace.sandboxMode === "read_only";
  const tier = isReadOnly ? ("workspace_read" as const) : ("worktree_write" as const);
  const leaseRole = isReadOnly ? ("read" as const) : ("write" as const);

  const slices =
    effectiveTopology === "swarm"
      ? buildSwarmDisjointSlices({
          workspace: input.workspace,
          title,
          workerAId: primaryWorkerId,
          workerBId: distinctPeerAgent?.id ?? primaryWorkerId,
          leaseRole,
        })
      : undefined;

  const opKey =
    `op_wb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}` as OperationKey;

  const res = await createWorkItemApi({
    workspaceId: input.workspace.id as WorkspaceId,
    ...(input.roomId !== undefined ? { roomId: input.roomId } : {}),
    title,
    brief: cleanBrief,
    topology: effectiveTopology,
    tier,
    ...(effectiveTopology === "swarm" ? { coordinatorAgentId: primaryWorkerId } : {}),
    primaryWorkerAgentId: primaryWorkerId,
    ...(verifierAgentId !== undefined ? { verifierAgentId } : {}),
    ...(slices !== undefined && slices.length > 0 ? { slices: [...slices] } : {}),
    opKey,
  });

  const view = toSoloWorkTaskView(res.item, Date.now());
  upsertServerWorkItemInStore(view);
  return view;
}

/**
 * 向运行中的真实工单或本地演示工单发送补充说明（Steer）。
 */
export async function steerWorkTaskOnServer(
  taskId: string,
  sliceId: string | undefined,
  note: string,
  roomId?: RoomId | undefined,
): Promise<void> {
  const clean = note.trim();
  if (clean.length === 0) {
    return;
  }
  if (!taskId.startsWith("wrk_")) {
    if (roomId !== undefined) {
      steerRoomWorkSlice(roomId, taskId, clean, sliceId);
    } else {
      steerSoloWorkSlice(taskId, sliceId ?? "", clean);
    }
    return;
  }
  const res = await steerWorkItemApi(taskId as WorkItemId, {
    ...(sliceId?.startsWith("slc_") ? { sliceId: sliceId as WorkSliceId } : {}),
    note: clean,
  });
  upsertServerWorkItemInStore(toSoloWorkTaskView(res.item, Date.now()));
}

/**
 * 回答 Agent 发起的单问澄清并恢复运行。
 */
export async function answerWorkAttentionOnServer(
  taskId: string,
  choice: string,
  roomId?: RoomId | undefined,
): Promise<void> {
  const clean = choice.trim();
  if (clean.length === 0) {
    return;
  }
  if (!taskId.startsWith("wrk_")) {
    if (roomId !== undefined) {
      answerRoomWorkAttention(roomId, taskId, clean);
    } else {
      answerSoloWorkAttention(taskId, clean);
    }
    return;
  }
  const res = await answerWorkAttentionApi(taskId as WorkItemId, { choice: clean });
  upsertServerWorkItemInStore(toSoloWorkTaskView(res.item, Date.now()));
}

/**
 * 对待审阅工单执行人工签收或退回修改。
 */
export async function decideWorkReviewOnServer(
  taskId: string,
  decision: "approve" | "request_changes",
  note?: string | undefined,
  roomId?: RoomId | undefined,
): Promise<void> {
  if (!taskId.startsWith("wrk_")) {
    if (roomId !== undefined) {
      decideRoomWorkReview(roomId, taskId, decision === "approve" ? "approve" : "rework", note);
    } else {
      decideSoloWorkReview(taskId, decision, note);
    }
    return;
  }
  const res = await decideWorkReviewApi(taskId as WorkItemId, {
    decision,
    ...(note?.trim() ? { note: note.trim() } : {}),
  });
  upsertServerWorkItemInStore(toSoloWorkTaskView(res.item, Date.now()));
}

/**
 * 执行工单运行控制：停止（`stop`）、重试（`retry`）或升级关联至群聊（`escalate_room`）。
 */
export async function controlWorkTaskOnServer(
  taskId: string,
  action: "stop" | "retry" | "escalate_room",
  options?: {
    readonly targetRoomId?: RoomId | undefined;
    readonly roomId?: RoomId | undefined;
  },
): Promise<SoloWorkTaskView | undefined> {
  if (!taskId.startsWith("wrk_")) {
    if (action === "stop") {
      if (options?.roomId !== undefined) {
        stopRoomWorkItem(options.roomId, taskId);
      } else {
        stopSoloWorkTask(taskId);
      }
    } else if (action === "retry") {
      if (options?.roomId !== undefined) {
        retryRoomWorkItem(options.roomId, taskId);
      } else {
        retrySoloWorkTask(taskId);
      }
    }
    return undefined;
  }

  const res = await controlWorkItemApi(taskId as WorkItemId, {
    action,
    ...(options?.targetRoomId !== undefined ? { targetRoomId: options.targetRoomId } : {}),
  });
  const view = toSoloWorkTaskView(res.item, Date.now());
  upsertServerWorkItemInStore(view);
  return view;
}

/**
 * 挂载全局工作区与多 Agent 协作工单的服务端初始水合与按域防抖实时同步。
 */
export function useWorkspaceServerSync(enabled: boolean, activeRoomId: RoomId | null): void {
  const activeRoomRef = useRef<RoomId | null>(activeRoomId);
  activeRoomRef.current = activeRoomId;

  useEffect(() => {
    if (!enabled || typeof window === "undefined") {
      return;
    }

    let cancelled = false;
    let wsDebounceTimer: ReturnType<typeof setTimeout> | null = null;
    let workDebounceTimer: ReturnType<typeof setTimeout> | null = null;
    let latestWorkSeq = 0;
    let cachedWorkspaces: ReadonlyArray<AgentWorkspace> = [];
    let cachedBindings: Readonly<Record<string, string>> = {};
    let cachedSoloTasks: ReadonlyArray<SoloWorkTaskView> = [];

    const flushCombinedStore = (): void => {
      hydrateServerWorkspacesAndTasks({
        workspaces: cachedWorkspaces,
        roomBindings: cachedBindings,
        tasks: cachedSoloTasks,
      });
    };

    const pullWorkspacesOnly = async (): Promise<void> => {
      try {
        const wsRes = await fetchOwnedWorkspaces();
        if (cancelled) return;
        cachedWorkspaces = wsRes.workspaces.map(toAgentWorkspaceView);
        cachedBindings = bindingsListToRecord(wsRes.roomBindings);
        flushCombinedStore();
      } catch {
        // 离线或瞬态错误保留现有快照
      }
    };

    const pullWorkItemsOnly = async (): Promise<void> => {
      const seq = ++latestWorkSeq;
      try {
        const workRes = await fetchWorkItems();
        if (cancelled || seq !== latestWorkSeq) {
          return;
        }
        const nowMs = Date.now();
        cachedSoloTasks = workRes.items.map((item) => toSoloWorkTaskView(item, nowMs));
        flushCombinedStore();

        const groupedByRoom = new Map<RoomId, RoomWorkItemView[]>();
        for (const item of workRes.items) {
          if (item.roomId === undefined) continue;
          const view = toRoomWorkItemView(item, item.roomId, nowMs);
          const list = groupedByRoom.get(item.roomId);
          if (list) {
            list.push(view);
          } else {
            groupedByRoom.set(item.roomId, [view]);
          }
        }
        for (const [rmId, items] of groupedByRoom.entries()) {
          hydrateServerRoomWorkItems(rmId, items);
        }
        const currentRoom = activeRoomRef.current;
        if (currentRoom && !groupedByRoom.has(currentRoom)) {
          hydrateServerRoomWorkItems(currentRoom, []);
        }
      } catch {
        // 瞬态网络错误等待下一帧 SSE 自愈
      }
    };

    void Promise.all([pullWorkspacesOnly(), pullWorkItemsOnly()]);

    const unsub = subscribeWorkRealtimeSignals((signal) => {
      if (signal.type === "work.trace") {
        appendRealtimeWorkTraceInStore({
          workItemId: signal.workItemId,
          entry: signal.entry,
          sliceId: signal.sliceId,
          liveSummary: signal.liveSummary,
          diffAdded: signal.diffAdded,
          diffRemoved: signal.diffRemoved,
        });
        return;
      }

      if (signal.type === "workspace.updated") {
        if (wsDebounceTimer === null) {
          wsDebounceTimer = setTimeout(() => {
            wsDebounceTimer = null;
            void pullWorkspacesOnly();
          }, 150);
        }
        return;
      }

      if (workDebounceTimer === null) {
        workDebounceTimer = setTimeout(() => {
          workDebounceTimer = null;
          void pullWorkItemsOnly();
        }, 180);
      }
    });

    return () => {
      cancelled = true;
      if (wsDebounceTimer !== null) clearTimeout(wsDebounceTimer);
      if (workDebounceTimer !== null) clearTimeout(workDebounceTimer);
      unsub();
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled || !activeRoomId || typeof window === "undefined") {
      return;
    }
    let cancelled = false;
    void fetchWorkItems({ roomId: activeRoomId })
      .then((res) => {
        if (cancelled) return;
        const nowMs = Date.now();
        hydrateServerRoomWorkItems(
          activeRoomId,
          res.items.map((item) => toRoomWorkItemView(item, activeRoomId, nowMs)),
        );
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [enabled, activeRoomId]);
}
