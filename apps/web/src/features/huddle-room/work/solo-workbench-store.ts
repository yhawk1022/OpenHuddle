/**
 * @module web/features/huddle-room/work/solo-workbench-store
 * @description 个人工作台状态存储与本地模拟执行状态机。
 *
 * 关键不变量：
 * 1. 管理 `AgentWorkspace` 配置持久化、单人并发任务生命周期，以及与群聊工单（`RoomWorkItem`）的双向无回声映射。
 * 2. 全局单一定时器：秒级进度推进在模块层按活跃任务存在性自动启停，避免多组件挂载导致双倍速计时或空闲轮询。
 * 3. 粒度化订阅：分离 `useSoloWorkbenchCounts` 与 `useWorkspaceDirectory`，避免顶层会话壳或群抽屉因任务读秒每秒重渲染。
 */
import type { AgentId, OwnedAgentSummaryDto, RoomId, WorkTraceEntry } from "@openhuddle/protocol";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { AgentExecutionTier } from "../../../lib/agent-capability-prefs.js";
import {
  answerRoomWorkAttention,
  decideRoomWorkReview,
  registerRoomWorkMirrorHandler,
  retryRoomWorkItem,
  runWithSuppressedRoomMirror,
  steerRoomWorkSlice,
  stopRoomWorkItem,
} from "./room-work-store.js";
import {
  DEFAULT_WORKSPACES,
  buildDefaultSoloTasks,
  buildGeneratedDiffForPrompt,
  buildSliceProvenance,
  resolveSoloFleet,
  toOwnedWorkAgentRef,
} from "./solo-workbench-fixtures.js";
import type {
  WorkAgentRef,
  WorkAttentionPrompt,
  WorkReviewSummary,
  WorkSliceNode,
  WorkStage,
  WorkTopology,
} from "./work-types.js";
import { normalizeWorkspaceRoots, parsePromptTopologyDirective } from "./work-utils.js";

/**
 * 个人工作台侧栏状态筛选器。
 */
export type WorkbenchAttentionFilter = "board" | "needs_you" | "running" | "done";

/**
 * 单行 Unified Diff 渲染结构。
 */
export interface UnifiedDiffLine {
  readonly kind: "hunk" | "context" | "add" | "del";
  readonly oldLine?: number | undefined;
  readonly newLine?: number | undefined;
  readonly content: string;
}

/**
 * 单个变更文件的结构化 Diff 快照。
 */
export interface SoloDiffFile {
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
  readonly lines: ReadonlyArray<UnifiedDiffLine>;
}

/**
 * 工作区目录形态分类。
 */
export type WorkspaceKind = "git_repo" | "multi_root" | "folder";

/**
 * 工作区文件与命令隔离策略。
 */
export type WorkspaceSandboxMode = "worktree_pool" | "in_place" | "read_only";

/**
 * 工作区挂载的单个受控目录根。
 */
export interface WorkspaceRootEntry {
  readonly id: string;
  readonly name: string;
  readonly localPath: string;
  readonly isGitRepo: boolean;
  readonly defaultBranch?: string | undefined;
  /** 脱敏远端仓库标识，绝不填充本机绝对路径 */
  readonly remoteSlug?: string | undefined;
}

/**
 * 工作区执行宿主模式（对齐 ADR-0010 §3.1）。
 */
export type WorkspaceHostMode = "local_machine" | "personal_remote" | "shared_container";

/**
 * 工作区宿主标识与在线状态。
 */
export interface WorkspaceHostStatus {
  readonly mode: WorkspaceHostMode;
  readonly hostLabel: string;
  readonly online: boolean;
}

/**
 * 工作区自动识别的规则与技能上下文摘要。
 */
export interface WorkspaceContextAssets {
  readonly ruleFiles: ReadonlyArray<string>;
  readonly skillCount: number;
  readonly sharedMemoryActive: boolean;
}

/**
 * 工作区环境初始化与校验钩子。
 */
export interface WorkspaceLifecycleHooks {
  readonly setupCommand?: string | undefined;
  readonly verifyCommand?: string | undefined;
  readonly copyEnvGlobs?: ReadonlyArray<string> | undefined;
}

/**
 * 工作区（`AgentWorkspace`）实体模型：聚合目录根、宿主环境、隔离策略、生命周期钩子与默认协作编排。
 */
export interface AgentWorkspace {
  readonly id: string;
  readonly name: string;
  readonly kind: WorkspaceKind;
  readonly roots: ReadonlyArray<WorkspaceRootEntry>;
  readonly localPath: string;
  readonly defaultBranch: string;
  readonly host: WorkspaceHostStatus;
  readonly sandboxMode: WorkspaceSandboxMode;
  readonly prewarmedWorktrees: number;
  readonly hooks: WorkspaceLifecycleHooks;
  readonly context: WorkspaceContextAssets;
  readonly defaultTopology: WorkTopology;
  readonly defaultWorkerId?: AgentId | undefined;
  readonly defaultVerifierId?: AgentId | undefined;
}

/** 向后兼容工作区目标别名 */
export type SoloRepoTarget = AgentWorkspace;

/**
 * 新建或更新工作区配置入参。
 */
export interface UpsertAgentWorkspaceInput {
  readonly id?: string | undefined;
  readonly name: string;
  readonly kind: WorkspaceKind;
  readonly roots: ReadonlyArray<{
    readonly name?: string | undefined;
    readonly localPath: string;
    readonly defaultBranch?: string | undefined;
  }>;
  readonly hostMode?: WorkspaceHostMode | undefined;
  readonly hostLabel?: string | undefined;
  readonly sandboxMode: WorkspaceSandboxMode;
  readonly setupCommand?: string | undefined;
  readonly verifyCommand?: string | undefined;
  readonly defaultTopology?: WorkTopology | undefined;
  readonly defaultWorkerId?: AgentId | undefined;
  readonly defaultVerifierId?: AgentId | undefined;
}

/**
 * 个人工作台单条任务视图模型。
 */
export interface SoloWorkTaskView {
  readonly id: string;
  readonly title: string;
  readonly brief: string;
  readonly repoId: string;
  readonly repoName: string;
  readonly worktreeBranch: string;
  readonly topology: WorkTopology;
  readonly tier: AgentExecutionTier;
  readonly stage: WorkStage;
  readonly warmHitMs: number;
  readonly coordinator?: WorkAgentRef | undefined;
  readonly primaryWorker: WorkAgentRef;
  readonly verifier?: WorkAgentRef | undefined;
  readonly slices: ReadonlyArray<WorkSliceNode>;
  readonly attention?: WorkAttentionPrompt | undefined;
  readonly review?: WorkReviewSummary | undefined;
  readonly trace?: ReadonlyArray<WorkTraceEntry> | undefined;
  readonly diffFiles: ReadonlyArray<SoloDiffFile>;
  readonly escalatedRoomId?: RoomId | undefined;
  readonly linkedRoomWorkId?: string | undefined;
  readonly createdAtIso: string;
  readonly updatedAtIso: string;
}

/**
 * 工作台新建任务输入载荷。
 */
export interface DispatchSoloTaskInput {
  readonly rawPrompt: string;
  readonly topology: WorkTopology;
  readonly repoId: string;
  readonly ownedAgents: ReadonlyArray<OwnedAgentSummaryDto>;
  readonly ownerDisplayName: string;
  readonly preferredWorkerId?: AgentId | undefined;
  readonly preferredVerifierId?: AgentId | undefined;
  readonly linkedRoomId?: RoomId | undefined;
  readonly linkedRoomWorkId?: string | undefined;
}

/**
 * 工作台按状态分桶的任务汇总计数。
 */
export interface SoloWorkbenchCounts {
  readonly total: number;
  readonly needsYou: number;
  readonly running: number;
  readonly done: number;
}

interface SoloWorkbenchSnapshot {
  readonly initialized: boolean;
  readonly boundWithOwnedAgents: boolean;
  readonly repos: ReadonlyArray<AgentWorkspace>;
  readonly tasks: ReadonlyArray<SoloWorkTaskView>;
  readonly roomBindings: Readonly<Record<string, string>>;
}

interface WorkspaceDirectorySnapshot {
  readonly workspaces: ReadonlyArray<AgentWorkspace>;
  readonly roomBindings: Readonly<Record<string, string>>;
}

const WORKSPACE_STORAGE_KEY = "openhuddle:workspaces:v2";

function isRecord(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null;
}

function parsePersistedWorkspace(raw: unknown): AgentWorkspace | null {
  if (!isRecord(raw) || typeof raw.id !== "string" || typeof raw.name !== "string") {
    return null;
  }
  const kind: WorkspaceKind =
    raw.kind === "multi_root" || raw.kind === "folder" ? raw.kind : "git_repo";
  const sandboxMode: WorkspaceSandboxMode =
    raw.sandboxMode === "in_place" || raw.sandboxMode === "read_only"
      ? raw.sandboxMode
      : "worktree_pool";
  const defaultTopology: WorkTopology =
    raw.defaultTopology === "direct" || raw.defaultTopology === "swarm"
      ? raw.defaultTopology
      : "verify_loop";

  const rawRoots = Array.isArray(raw.roots) ? raw.roots : [];
  const roots: WorkspaceRootEntry[] = [];
  for (const item of rawRoots) {
    if (isRecord(item) && typeof item.localPath === "string") {
      roots.push({
        id: typeof item.id === "string" ? item.id : `root_${String(roots.length)}`,
        name: typeof item.name === "string" ? item.name : raw.name,
        localPath: item.localPath,
        isGitRepo: typeof item.isGitRepo === "boolean" ? item.isGitRepo : kind !== "folder",
        ...(typeof item.defaultBranch === "string" ? { defaultBranch: item.defaultBranch } : {}),
        ...(typeof item.remoteSlug === "string" ? { remoteSlug: item.remoteSlug } : {}),
      });
    }
  }
  if (roots.length === 0) {
    return null;
  }

  const hostRec = isRecord(raw.host) ? raw.host : {};
  const hostMode: WorkspaceHostMode =
    hostRec.mode === "personal_remote" || hostRec.mode === "shared_container"
      ? hostRec.mode
      : "local_machine";
  const hooksRec = isRecord(raw.hooks) ? raw.hooks : {};
  const ctxRec = isRecord(raw.context) ? raw.context : {};

  return {
    id: raw.id,
    name: raw.name,
    kind,
    roots,
    localPath: typeof raw.localPath === "string" ? raw.localPath : (roots[0]?.localPath ?? ""),
    defaultBranch: typeof raw.defaultBranch === "string" ? raw.defaultBranch : "main",
    host: {
      mode: hostMode,
      hostLabel: typeof hostRec.hostLabel === "string" ? hostRec.hostLabel : "本机 Mac",
      online: typeof hostRec.online === "boolean" ? hostRec.online : true,
    },
    sandboxMode,
    prewarmedWorktrees: typeof raw.prewarmedWorktrees === "number" ? raw.prewarmedWorktrees : 0,
    hooks: {
      ...(typeof hooksRec.setupCommand === "string" ? { setupCommand: hooksRec.setupCommand } : {}),
      ...(typeof hooksRec.verifyCommand === "string"
        ? { verifyCommand: hooksRec.verifyCommand }
        : {}),
      ...(Array.isArray(hooksRec.copyEnvGlobs)
        ? {
            copyEnvGlobs: hooksRec.copyEnvGlobs.filter((g): g is string => typeof g === "string"),
          }
        : {}),
    },
    context: {
      ruleFiles: Array.isArray(ctxRec.ruleFiles)
        ? ctxRec.ruleFiles.filter((f): f is string => typeof f === "string")
        : [],
      skillCount: typeof ctxRec.skillCount === "number" ? ctxRec.skillCount : 0,
      sharedMemoryActive:
        typeof ctxRec.sharedMemoryActive === "boolean" ? ctxRec.sharedMemoryActive : false,
    },
    defaultTopology,
    ...(typeof raw.defaultWorkerId === "string"
      ? { defaultWorkerId: raw.defaultWorkerId as AgentId }
      : {}),
    ...(typeof raw.defaultVerifierId === "string"
      ? { defaultVerifierId: raw.defaultVerifierId as AgentId }
      : {}),
  };
}

function loadPersistedWorkspaces(): {
  readonly repos: ReadonlyArray<AgentWorkspace>;
  readonly roomBindings: Readonly<Record<string, string>>;
} {
  if (typeof window === "undefined") {
    return { repos: [], roomBindings: {} };
  }
  try {
    const raw = window.localStorage.getItem(WORKSPACE_STORAGE_KEY);
    if (!raw) {
      return { repos: [], roomBindings: {} };
    }
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) {
      return { repos: [], roomBindings: {} };
    }
    const repos = Array.isArray(parsed.repos)
      ? parsed.repos
          .map(parsePersistedWorkspace)
          .filter((ws): ws is AgentWorkspace => Boolean(ws?.id.startsWith("wsp_")))
      : [];

    const roomBindings: Record<string, string> = {};
    if (isRecord(parsed.roomBindings)) {
      for (const [roomId, wsId] of Object.entries(parsed.roomBindings)) {
        if (typeof wsId === "string" && wsId.startsWith("wsp_")) {
          roomBindings[roomId] = wsId;
        }
      }
    }
    return { repos, roomBindings };
  } catch {
    return { repos: [], roomBindings: {} };
  }
}

function persistWorkspacesToStorage(
  repos: ReadonlyArray<AgentWorkspace>,
  roomBindings: Readonly<Record<string, string>>,
): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify({ repos, roomBindings }));
  } catch {
    // 隐私模式配额受限时保持内存态可用
  }
}

/**
 * 判断工单阶段是否属于需主人确认或签收的队列。
 */
export function isSoloNeedsYouStage(stage: WorkStage): boolean {
  return stage === "awaiting_answer" || stage === "awaiting_review" || stage === "blocked";
}

/**
 * 判断工单阶段是否正在执行或独立复核中。
 */
export function isSoloRunningStage(stage: WorkStage): boolean {
  return stage === "working" || stage === "verifying";
}

/**
 * 计算个人工作台各状态分桶的任务数量。
 */
export function computeSoloWorkbenchCounts(
  tasks: ReadonlyArray<SoloWorkTaskView>,
): SoloWorkbenchCounts {
  let needsYou = 0;
  let running = 0;
  let done = 0;
  for (const task of tasks) {
    if (isSoloNeedsYouStage(task.stage)) {
      needsYou += 1;
    } else if (isSoloRunningStage(task.stage)) {
      running += 1;
    } else if (task.stage === "done") {
      done += 1;
    }
  }
  return {
    total: tasks.length,
    needsYou,
    running,
    done,
  };
}

const initialPersisted = loadPersistedWorkspaces();

let stateSnapshot: SoloWorkbenchSnapshot = {
  initialized: false,
  boundWithOwnedAgents: false,
  repos: initialPersisted.repos,
  tasks: [],
  roomBindings: initialPersisted.roomBindings,
};

let cachedDirectorySnapshot: WorkspaceDirectorySnapshot = {
  workspaces: stateSnapshot.repos,
  roomBindings: stateSnapshot.roomBindings,
};

let cachedCountsSnapshot: SoloWorkbenchCounts = computeSoloWorkbenchCounts(stateSnapshot.tasks);

const listeners = new Set<() => void>();
let soloTickerHandle: number | null = null;
let soloSubscriberCount = 0;

function syncSoloTicker(): void {
  if (typeof window === "undefined") {
    return;
  }
  const shouldRun =
    soloSubscriberCount > 0 && stateSnapshot.tasks.some((t) => isSoloRunningStage(t.stage));
  if (shouldRun && soloTickerHandle === null) {
    soloTickerHandle = window.setInterval(tickSoloRunningTasks, 1_000);
  } else if (!shouldRun && soloTickerHandle !== null) {
    window.clearInterval(soloTickerHandle);
    soloTickerHandle = null;
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): SoloWorkbenchSnapshot {
  return stateSnapshot;
}

function getDirectorySnapshot(): WorkspaceDirectorySnapshot {
  return cachedDirectorySnapshot;
}

function getCountsSnapshot(): SoloWorkbenchCounts {
  return cachedCountsSnapshot;
}

function setSnapshot(next: SoloWorkbenchSnapshot): void {
  const persistChanged =
    next.repos !== stateSnapshot.repos || next.roomBindings !== stateSnapshot.roomBindings;
  stateSnapshot = next;

  if (persistChanged) {
    cachedDirectorySnapshot = {
      workspaces: next.repos,
      roomBindings: next.roomBindings,
    };
    persistWorkspacesToStorage(next.repos, next.roomBindings);
  }

  const nextCounts = computeSoloWorkbenchCounts(next.tasks);
  if (
    nextCounts.total !== cachedCountsSnapshot.total ||
    nextCounts.needsYou !== cachedCountsSnapshot.needsYou ||
    nextCounts.running !== cachedCountsSnapshot.running ||
    nextCounts.done !== cachedCountsSnapshot.done
  ) {
    cachedCountsSnapshot = nextCounts;
  }

  syncSoloTicker();
  for (const listener of listeners) {
    listener();
  }
}

/**
 * 标记工作台存储已进入就绪态（不再注入前端假示例任务；真实任务与工作区由 `useWorkspaceServerSync` 从服务端加载）。
 */
export function ensureSoloWorkbenchInitialized(
  ownedAgents: ReadonlyArray<OwnedAgentSummaryDto>,
  _ownerDisplayName: string,
): void {
  const hasRealAgents = ownedAgents.length > 0;
  if (stateSnapshot.initialized && stateSnapshot.boundWithOwnedAgents === hasRealAgents) {
    return;
  }
  setSnapshot({
    ...stateSnapshot,
    initialized: true,
    boundWithOwnedAgents: hasRealAgents,
  });
}

/**
 * 重置工作台默认工作区与四条典型状态示例任务。
 */
export function resetSoloWorkbenchShowcase(
  ownedAgents: ReadonlyArray<OwnedAgentSummaryDto>,
  ownerDisplayName: string,
): void {
  setSnapshot({
    initialized: true,
    boundWithOwnedAgents: ownedAgents.length > 0,
    repos: DEFAULT_WORKSPACES,
    tasks: buildDefaultSoloTasks(ownedAgents, ownerDisplayName),
    roomBindings: stateSnapshot.roomBindings,
  });
}

/**
 * 清空工作台任务列表（保持 initialized 为 true，不自动回填示例任务）。
 */
export function clearSoloWorkbenchTasks(): void {
  setSnapshot({
    ...stateSnapshot,
    initialized: true,
    tasks: [],
  });
}

/**
 * 登出账号时重置内存任务状态，避免同标签页切换账号残留前序用户的内存工单。
 */
export function resetSoloWorkbenchMemory(): void {
  setSnapshot({
    initialized: false,
    boundWithOwnedAgents: false,
    repos: [],
    tasks: [],
    roomBindings: {},
  });
}

/**
 * 创建或更新工作区配置（编辑时完整保留既有目录的 `remoteSlug` 与未覆盖的复核人配置）。
 */
export function upsertAgentWorkspace(input: UpsertAgentWorkspaceInput): AgentWorkspace {
  const cleanName = input.name.trim() || "未命名工作区";
  const isFolderKind = input.kind === "folder";
  const existing =
    input.id !== undefined ? stateSnapshot.repos.find((w) => w.id === input.id) : undefined;

  const { roots, kind } = normalizeWorkspaceRoots(input);
  const normalizedRoots: ReadonlyArray<WorkspaceRootEntry> = roots.map((raw, index) => {
    const cleanPath = raw.localPath;
    const priorRoot = existing?.roots.find((r) => r.localPath === cleanPath);
    const inferredName =
      input.roots.find((r) => r.localPath.trim() === cleanPath)?.name?.trim() ||
      priorRoot?.name ||
      raw.name;
    const branch = isFolderKind ? undefined : raw.defaultBranch?.trim() || "main";
    return {
      id:
        priorRoot?.id ??
        `root_${String(index)}_${inferredName.toLowerCase().replace(/[^a-z0-9_-]/g, "_")}`,
      name: inferredName,
      localPath: cleanPath,
      isGitRepo: !isFolderKind,
      ...(branch !== undefined ? { defaultBranch: branch } : {}),
      ...(priorRoot?.remoteSlug !== undefined ? { remoteSlug: priorRoot.remoteSlug } : {}),
    };
  });

  const primaryRoot = normalizedRoots[0];
  const effectiveSandbox: WorkspaceSandboxMode =
    isFolderKind && input.sandboxMode === "worktree_pool" ? "in_place" : input.sandboxMode;
  const setupCmd = input.setupCommand?.trim();
  const verifyCmd = input.verifyCommand?.trim();
  const resolvedVerifierId = input.defaultVerifierId ?? existing?.defaultVerifierId;

  const workspace: AgentWorkspace = {
    id: existing?.id ?? `ws_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`,
    name: cleanName,
    kind,
    roots: normalizedRoots,
    localPath: primaryRoot?.localPath ?? "",
    defaultBranch: isFolderKind ? "—" : (primaryRoot?.defaultBranch ?? "main"),
    host: {
      mode: input.hostMode ?? existing?.host.mode ?? "local_machine",
      hostLabel:
        input.hostLabel?.trim() ||
        (input.hostMode === "personal_remote"
          ? "远程主力沙箱"
          : input.hostMode === "shared_container"
            ? "隔离容器沙箱"
            : (existing?.host.hostLabel ?? "本机 Mac")),
      online: existing?.host.online ?? true,
    },
    sandboxMode: effectiveSandbox,
    prewarmedWorktrees:
      effectiveSandbox === "worktree_pool" ? (existing?.prewarmedWorktrees ?? 2) : 0,
    hooks: {
      ...(setupCmd ? { setupCommand: setupCmd } : {}),
      ...(verifyCmd ? { verifyCommand: verifyCmd } : {}),
      ...(existing?.hooks.copyEnvGlobs !== undefined
        ? { copyEnvGlobs: existing.hooks.copyEnvGlobs }
        : {}),
    },
    context: existing?.context ?? {
      ruleFiles: isFolderKind ? [] : ["AGENTS.md"],
      skillCount: 0,
      sharedMemoryActive: !isFolderKind,
    },
    defaultTopology:
      input.defaultTopology ??
      existing?.defaultTopology ??
      (isFolderKind ? "direct" : "verify_loop"),
    ...(input.defaultWorkerId !== undefined ? { defaultWorkerId: input.defaultWorkerId } : {}),
    ...(resolvedVerifierId !== undefined ? { defaultVerifierId: resolvedVerifierId } : {}),
  };

  const nextRepos =
    existing !== undefined
      ? stateSnapshot.repos.map((w) => (w.id === workspace.id ? workspace : w))
      : [...stateSnapshot.repos, workspace];

  const nextTasks =
    existing !== undefined && existing.name !== workspace.name
      ? stateSnapshot.tasks.map((t) =>
          t.repoId === workspace.id ? { ...t, repoName: workspace.name } : t,
        )
      : stateSnapshot.tasks;

  setSnapshot({
    ...stateSnapshot,
    initialized: true,
    repos: nextRepos,
    tasks: nextTasks,
  });

  return workspace;
}

/**
 * 删除指定工作区（至少保留 1 个工作区，并同步清理关联的群聊挂载项）。
 */
export function deleteAgentWorkspace(workspaceId: string): void {
  if (stateSnapshot.repos.length <= 1) {
    return;
  }
  const nextRepos = stateSnapshot.repos.filter((w) => w.id !== workspaceId);
  if (nextRepos.length === stateSnapshot.repos.length) {
    return;
  }
  const nextBindings: Record<string, string> = {};
  for (const [roomId, boundId] of Object.entries(stateSnapshot.roomBindings)) {
    if (boundId !== workspaceId) {
      nextBindings[roomId] = boundId;
    }
  }
  setSnapshot({
    ...stateSnapshot,
    repos: nextRepos,
    roomBindings: nextBindings,
  });
}

/**
 * 快捷添加单代码仓工作区（向后兼容入口）。
 */
export function addSoloRepository(input: {
  readonly name: string;
  readonly localPath: string;
  readonly defaultBranch?: string | undefined;
}): SoloRepoTarget {
  return upsertAgentWorkspace({
    name: input.name,
    kind: "git_repo",
    roots: [
      {
        localPath: input.localPath,
        ...(input.defaultBranch !== undefined ? { defaultBranch: input.defaultBranch } : {}),
      },
    ],
    sandboxMode: "worktree_pool",
    verifyCommand: "pnpm verify",
  });
}

/**
 * 绑定或解绑群聊房间至本机工作区（严格遵守 Owner-First 边界：外部成员 Agent 始终限为 `chat_only`）。
 */
export function bindRoomToWorkspace(roomId: RoomId, workspaceId: string | null): void {
  const nextBindings: Record<string, string> = { ...stateSnapshot.roomBindings };
  if (workspaceId === null || workspaceId.trim().length === 0) {
    delete nextBindings[roomId];
  } else {
    nextBindings[roomId] = workspaceId;
  }
  setSnapshot({
    ...stateSnapshot,
    roomBindings: nextBindings,
  });
}

/**
 * 查询指定群聊当前关联的本机工作区。
 */
export function getRoomBoundWorkspace(roomId: RoomId): AgentWorkspace | null {
  const boundId = stateSnapshot.roomBindings[roomId];
  if (!boundId) {
    return null;
  }
  return stateSnapshot.repos.find((w) => w.id === boundId) ?? null;
}

/**
 * 按 ID 读取工作台任务快照。
 */
export function getSoloWorkTaskById(taskId: string): SoloWorkTaskView | undefined {
  return stateSnapshot.tasks.find((t) => t.id === taskId);
}

/**
 * 新建并派发一条个人工作台任务。
 */
export function dispatchSoloWorkTask(input: DispatchSoloTaskInput): SoloWorkTaskView {
  const repo = stateSnapshot.repos.find((r) => r.id === input.repoId) ?? stateSnapshot.repos[0];
  const { topology: effectiveTopology, body } = parsePromptTopologyDirective(
    input.rawPrompt,
    input.topology,
  );

  const firstLine = body.split("\n")[0]?.trim() ?? "新派发任务";
  const title = firstLine.length > 52 ? `${firstLine.slice(0, 52)}…` : firstLine;
  const fleet = resolveSoloFleet(input.ownedAgents, input.ownerDisplayName);
  const candidateWorkerId = input.preferredWorkerId ?? repo?.defaultWorkerId;
  const candidateVerifierId = input.preferredVerifierId ?? repo?.defaultVerifierId;
  const preferredWorker = candidateWorkerId
    ? input.ownedAgents.find((a) => a.id === candidateWorkerId)
    : undefined;
  const preferredVerifier = candidateVerifierId
    ? input.ownedAgents.find((a) => a.id === candidateVerifierId)
    : undefined;

  const primaryWorker =
    preferredWorker !== undefined
      ? toOwnedWorkAgentRef(preferredWorker, input.ownerDisplayName, {
          id: preferredWorker.id,
          name: preferredWorker.displayName,
          platform: preferredWorker.platform,
        })
      : fleet.workerA;

  const verifier =
    effectiveTopology === "direct"
      ? undefined
      : preferredVerifier !== undefined
        ? toOwnedWorkAgentRef(preferredVerifier, input.ownerDisplayName, {
            id: preferredVerifier.id,
            name: preferredVerifier.displayName,
            platform: preferredVerifier.platform,
          })
        : fleet.verifier;

  const repoId = repo?.id ?? "repo_openhuddle";
  const repoName = repo?.name ?? "OpenHuddle";
  const sandboxMode = repo?.sandboxMode ?? "worktree_pool";
  const shortHash = Math.random().toString(36).slice(2, 6);
  const worktreeBranch =
    sandboxMode === "worktree_pool"
      ? `huddle/solo-${effectiveTopology === "swarm" ? "swarm" : "task"}-${shortHash}`
      : sandboxMode === "read_only"
        ? "只读围栏"
        : repo?.kind === "folder"
          ? "原地文件夹"
          : `${repo?.defaultBranch ?? "main"} (原地)`;
  const effectiveTier: AgentExecutionTier =
    sandboxMode === "read_only" ? "workspace_read" : "worktree_write";
  const nowIso = new Date().toISOString();

  const rootScopeLabels =
    repo !== undefined && repo.roots.length > 1
      ? repo.roots.map((r) => `${r.name}/`)
      : ["apps/", "packages/"];

  const taskId = `solo_wrk_${Date.now().toString(36)}_${shortHash}`;
  const isGitSandbox = repo?.kind !== "folder" && sandboxMode !== "read_only";
  const primaryLeaseRole: "write" | "verify" | "read" =
    sandboxMode === "read_only" ? "read" : "write";

  const slices: ReadonlyArray<WorkSliceNode> =
    effectiveTopology === "swarm"
      ? [
          {
            sliceId: `slc_${shortHash}_1`,
            title: `分片 A：${repo?.roots[0]?.name ?? "核心模块"}实现（${title.slice(0, 16)}）`,
            worker: primaryWorker,
            ownedPaths: [rootScopeLabels[0] ?? "packages/protocol/"],
            status: "running",
            liveSummary:
              sandboxMode === "worktree_pool"
                ? "正在隔离 Worktree 分支内并行修改…"
                : "正在工作区受控目录内执行…",
            elapsedSec: 1,
            steerNotes: [],
            provenance: buildSliceProvenance({
              agent: primaryWorker,
              workspaceId: repoId,
              taskId,
              leaseRole: primaryLeaseRole,
              gitNotesAttached: isGitSandbox,
            }),
          },
          {
            sliceId: `slc_${shortHash}_2`,
            title: `分片 B：${repo?.roots[1]?.name ?? "前端交互与回归单测"}联动覆盖`,
            worker: fleet.workerB,
            ownedPaths: [rootScopeLabels[1] ?? "apps/web/src/"],
            status: "running",
            liveSummary: "已加载工作区共享记忆与 AGENTS.md 规范，同步推进中…",
            elapsedSec: 1,
            steerNotes: [],
            provenance: buildSliceProvenance({
              agent: fleet.workerB,
              workspaceId: repoId,
              taskId,
              leaseRole: primaryLeaseRole,
              gitNotesAttached: isGitSandbox,
            }),
          },
        ]
      : [
          {
            sliceId: `slc_${shortHash}_main`,
            title,
            worker: primaryWorker,
            ownedPaths: rootScopeLabels,
            status: "running",
            liveSummary:
              sandboxMode === "read_only"
                ? "正在只读工作区围栏内检索代码与定位问题…"
                : sandboxMode === "worktree_pool"
                  ? "正在隔离 Worktree 分支内执行改动…"
                  : "已获取工作区单写互斥锁，正在原目录内执行…",
            elapsedSec: 1,
            steerNotes: [],
            provenance: buildSliceProvenance({
              agent: primaryWorker,
              workspaceId: repoId,
              taskId,
              leaseRole: primaryLeaseRole,
              gitNotesAttached: isGitSandbox,
            }),
          },
        ];

  const created: SoloWorkTaskView = {
    id: taskId,
    title,
    brief: body,
    repoId,
    repoName,
    worktreeBranch,
    topology: effectiveTopology,
    tier: effectiveTier,
    stage: "working",
    warmHitMs: 88 + Math.floor(Math.random() * 65),
    ...(effectiveTopology === "swarm" ? { coordinator: fleet.coordinator } : {}),
    primaryWorker,
    ...(verifier !== undefined ? { verifier } : {}),
    slices,
    diffFiles: [],
    ...(input.linkedRoomId !== undefined ? { escalatedRoomId: input.linkedRoomId } : {}),
    ...(input.linkedRoomWorkId !== undefined ? { linkedRoomWorkId: input.linkedRoomWorkId } : {}),
    createdAtIso: nowIso,
    updatedAtIso: nowIso,
  };

  setSnapshot({
    ...stateSnapshot,
    initialized: true,
    tasks: [created, ...stateSnapshot.tasks],
  });
  return created;
}

let suppressOutboundToRoom = false;

function mirrorToLinkedRoomWork(
  task: SoloWorkTaskView | undefined,
  action: (roomId: RoomId, roomWorkId: string) => void,
): void {
  if (
    suppressOutboundToRoom ||
    task === undefined ||
    task.escalatedRoomId === undefined ||
    task.linkedRoomWorkId === undefined
  ) {
    return;
  }
  const roomId = task.escalatedRoomId;
  const roomWorkId = task.linkedRoomWorkId;
  runWithSuppressedRoomMirror(() => {
    action(roomId, roomWorkId);
  });
}

/**
 * 回答受托 Agent 的单问澄清并恢复运行（若已关联群聊工单则同步更新）。
 */
export function answerSoloWorkAttention(taskId: string, choice: string): void {
  const trimmed = choice.trim();
  if (trimmed.length === 0) {
    return;
  }
  const targetTask = stateSnapshot.tasks.find((t) => t.id === taskId);
  const nowIso = new Date().toISOString();
  setSnapshot({
    ...stateSnapshot,
    tasks: stateSnapshot.tasks.map((task) => {
      if (task.id !== taskId || task.attention === undefined) {
        return task;
      }
      return {
        ...task,
        stage: "working",
        attention: {
          ...task.attention,
          answeredChoice: trimmed,
        },
        slices: task.slices.map((s) =>
          s.status === "waiting"
            ? {
                ...s,
                status: "running",
                liveSummary: `已按确认项「${trimmed}」继续执行…`,
              }
            : s,
        ),
        updatedAtIso: nowIso,
      };
    }),
  });
  mirrorToLinkedRoomWork(targetTask, (roomId, roomWorkId) => {
    answerRoomWorkAttention(roomId, roomWorkId, trimmed);
  });
}

/**
 * 向运行中的分片注入补充说明（不中断现有上下文，同步更新关联群聊工单）。
 */
export function steerSoloWorkSlice(taskId: string, sliceId: string, note: string): void {
  const trimmed = note.trim();
  if (trimmed.length === 0) {
    return;
  }
  const targetTask = stateSnapshot.tasks.find((t) => t.id === taskId);
  const nowIso = new Date().toISOString();
  setSnapshot({
    ...stateSnapshot,
    tasks: stateSnapshot.tasks.map((task) => {
      if (task.id !== taskId) {
        return task;
      }
      const fallbackSliceId =
        sliceId ||
        task.slices.find((s) => s.status === "running" || s.status === "verifying")?.sliceId ||
        task.slices[0]?.sliceId;
      return {
        ...task,
        slices: task.slices.map((slice) =>
          slice.sliceId === fallbackSliceId
            ? {
                ...slice,
                steerNotes: [...slice.steerNotes, trimmed],
                liveSummary: `已补充说明：「${trimmed}」`,
              }
            : slice,
        ),
        updatedAtIso: nowIso,
      };
    }),
  });
  mirrorToLinkedRoomWork(targetTask, (roomId, roomWorkId) => {
    steerRoomWorkSlice(roomId, roomWorkId, trimmed);
  });
}

/**
 * 停止指定运行中任务并释放执行槽位（同步更新关联群聊工单）。
 */
export function stopSoloWorkTask(taskId: string): void {
  const targetTask = stateSnapshot.tasks.find((t) => t.id === taskId);
  const nowIso = new Date().toISOString();
  setSnapshot({
    ...stateSnapshot,
    tasks: stateSnapshot.tasks.map((task) => {
      if (task.id !== taskId) {
        return task;
      }
      const { attention: _pendingAttention, ...taskWithoutAttention } = task;
      const hasPendingAttention =
        task.attention !== undefined && task.attention.answeredChoice === undefined;
      return {
        ...(hasPendingAttention ? taskWithoutAttention : task),
        stage: "cancelled",
        slices: task.slices.map((s) =>
          s.status === "running" || s.status === "verifying" || s.status === "waiting"
            ? { ...s, status: "blocked", liveSummary: "已手动停止并保留当前分支草稿" }
            : s,
        ),
        updatedAtIso: nowIso,
      };
    }),
  });
  mirrorToLinkedRoomWork(targetTask, (roomId, roomWorkId) => {
    stopRoomWorkItem(roomId, roomWorkId);
  });
}

/**
 * 重新唤醒已停止或受阻的任务（同步更新关联群聊工单）。
 */
export function retrySoloWorkTask(taskId: string): void {
  const targetTask = stateSnapshot.tasks.find((t) => t.id === taskId);
  const nowIso = new Date().toISOString();
  setSnapshot({
    ...stateSnapshot,
    tasks: stateSnapshot.tasks.map((task) =>
      task.id === taskId
        ? {
            ...task,
            stage: "working",
            slices: task.slices.map((s) => ({
              ...s,
              status: "running",
              elapsedSec: 1,
              liveSummary: "已在原分支重新唤醒执行…",
            })),
            updatedAtIso: nowIso,
          }
        : task,
    ),
  });
  mirrorToLinkedRoomWork(targetTask, (roomId, roomWorkId) => {
    retryRoomWorkItem(roomId, roomWorkId);
  });
}

/**
 * 签收或退回处于待审阅态的任务（同步更新关联群聊工单）。
 */
export function decideSoloWorkReview(
  taskId: string,
  decision: "approve" | "request_changes",
  feedback?: string,
): void {
  const targetTask = stateSnapshot.tasks.find((t) => t.id === taskId);
  const nowIso = new Date().toISOString();
  setSnapshot({
    ...stateSnapshot,
    tasks: stateSnapshot.tasks.map((task) => {
      if (task.id !== taskId) {
        return task;
      }
      if (decision === "approve") {
        return {
          ...task,
          stage: "done",
          updatedAtIso: nowIso,
        };
      }
      const note = feedback?.trim() || "请补充边界测试后再次提交审阅";
      return {
        ...task,
        stage: "working",
        slices: task.slices.map((s, idx) =>
          idx === 0
            ? {
                ...s,
                status: "running",
                elapsedSec: 1,
                steerNotes: [...s.steerNotes, note],
                liveSummary: `按审阅意见调整中：「${note}」`,
              }
            : s,
        ),
        updatedAtIso: nowIso,
      };
    }),
  });
  mirrorToLinkedRoomWork(targetTask, (roomId, roomWorkId) => {
    decideRoomWorkReview(
      roomId,
      roomWorkId,
      decision === "approve" ? "approve" : "rework",
      feedback,
    );
  });
}

/**
 * 标记工作台任务已绑定至指定群聊房间与房间工单 ID。
 */
export function markSoloTaskEscalated(
  taskId: string,
  roomId: RoomId,
  linkedRoomWorkId?: string | undefined,
): void {
  const nowIso = new Date().toISOString();
  setSnapshot({
    ...stateSnapshot,
    tasks: stateSnapshot.tasks.map((task) =>
      task.id === taskId
        ? {
            ...task,
            escalatedRoomId: roomId,
            ...(linkedRoomWorkId !== undefined ? { linkedRoomWorkId } : {}),
            updatedAtIso: nowIso,
          }
        : task,
    ),
  });
}

// 接收来自群聊工单的状态同步回调；外层加锁抑制回声广播
registerRoomWorkMirrorHandler((event) => {
  suppressOutboundToRoom = true;
  try {
    switch (event.type) {
      case "steer":
        steerSoloWorkSlice(event.soloTaskId, "", event.note);
        break;
      case "stop":
        stopSoloWorkTask(event.soloTaskId);
        break;
      case "retry":
        retrySoloWorkTask(event.soloTaskId);
        break;
      case "answer":
        answerSoloWorkAttention(event.soloTaskId, event.choice);
        break;
      case "review":
        decideSoloWorkReview(
          event.soloTaskId,
          event.decision === "approve" ? "approve" : "request_changes",
          event.note,
        );
        break;
    }
  } finally {
    suppressOutboundToRoom = false;
  }
});

function tickSoloRunningTasks(): void {
  const hasActive = stateSnapshot.tasks.some((t) => isSoloRunningStage(t.stage));
  if (!hasActive) {
    syncSoloTicker();
    return;
  }

  const nowIso = new Date().toISOString();
  const nextTasks = stateSnapshot.tasks.map((task): SoloWorkTaskView => {
    // 真实服务端工单（wrk_*）仅在本地平滑递增已耗时读秒，绝不伪造自动完成或假代码 Diff
    if (task.id.startsWith("wrk_")) {
      if (!isSoloRunningStage(task.stage)) {
        return task;
      }
      return {
        ...task,
        slices: task.slices.map((slice) =>
          slice.status === "running" || slice.status === "verifying"
            ? { ...slice, elapsedSec: slice.elapsedSec + 1 }
            : slice,
        ),
      };
    }

    if (task.stage === "working") {
      // 若关联了群聊工单，编码周期与群聊 9s/14s 节拍对齐，消除跨视图阶段滞后
      const completeThresholdSec = task.linkedRoomWorkId !== undefined ? 9 : 36;
      const nextSlices = task.slices.map((slice): WorkSliceNode => {
        if (slice.status !== "running") {
          return slice;
        }
        const nextSec = slice.elapsedSec + 1;
        if (nextSec >= completeThresholdSec) {
          return {
            ...slice,
            elapsedSec: nextSec,
            status: "ready",
            diffAdded: slice.diffAdded ?? 42,
            diffRemoved: slice.diffRemoved ?? 6,
            liveSummary: "已完成编码与本地自测，生成分支 Diff",
          };
        }
        return {
          ...slice,
          elapsedSec: nextSec,
        };
      });

      const allReady = nextSlices.every((s) => s.status === "ready");
      if (!allReady) {
        return {
          ...task,
          slices: nextSlices,
          updatedAtIso: nowIso,
        };
      }

      const generatedDiffs =
        task.diffFiles.length > 0
          ? task.diffFiles
          : buildGeneratedDiffForPrompt(task.title, task.id.slice(-6));
      const totalAdded = generatedDiffs.reduce((sum, f) => sum + f.additions, 0);
      const totalDeleted = generatedDiffs.reduce((sum, f) => sum + f.deletions, 0);

      const boundWorkspace = stateSnapshot.repos.find((w) => w.id === task.repoId);
      const effectiveVerifyCmd =
        boundWorkspace?.hooks.verifyCommand ||
        (boundWorkspace?.kind === "folder" ? "ls -la" : "pnpm verify");

      if (task.verifier !== undefined) {
        // 按累计复核轮次追加唯一 sliceId，避免多次「退回修改」后产生重复 React key
        const verifyRound =
          nextSlices.filter((s) => s.sliceId.startsWith("slc_verify_")).length + 1;
        return {
          ...task,
          stage: "verifying",
          slices: [
            ...nextSlices,
            {
              sliceId: `slc_verify_${task.id.slice(-4)}_r${String(verifyRound)}`,
              title: `独立复核：执行 ${effectiveVerifyCmd} 与边界检查`,
              worker: task.verifier,
              ownedPaths: generatedDiffs.map((f) => f.path),
              status: "verifying",
              elapsedSec: 1,
              liveSummary: `正在独立运行门禁命令（${effectiveVerifyCmd}）…`,
              steerNotes: [],
            },
          ],
          diffFiles: generatedDiffs,
          review: {
            filesChanged: generatedDiffs.length,
            additions: totalAdded,
            deletions: totalDeleted,
            changedFiles: generatedDiffs.map((f) => f.path),
            testCommand: effectiveVerifyCmd,
            testPassed: true,
            worktreeBranch: task.worktreeBranch,
            verifierNote: `独立复核通过（第 ${String(verifyRound)} 轮）：类型检查与单测均通过。`,
            verifyLoopsUsed: verifyRound,
          },
          updatedAtIso: nowIso,
        };
      }

      return {
        ...task,
        stage: "awaiting_review",
        slices: nextSlices,
        diffFiles: generatedDiffs,
        review: {
          filesChanged: generatedDiffs.length,
          additions: totalAdded,
          deletions: totalDeleted,
          changedFiles: generatedDiffs.map((f) => f.path),
          testCommand: effectiveVerifyCmd,
          testPassed: true,
          worktreeBranch: task.worktreeBranch,
          verifyLoopsUsed: 0,
        },
        updatedAtIso: nowIso,
      };
    }

    if (task.stage === "verifying") {
      const nextSlices = task.slices.map((slice): WorkSliceNode => {
        if (slice.status !== "verifying") {
          return slice;
        }
        const nextSec = slice.elapsedSec + 1;
        if (nextSec >= 5) {
          return {
            ...slice,
            elapsedSec: nextSec,
            status: "ready",
            liveSummary: "复核通过，等待人工签收",
          };
        }
        return {
          ...slice,
          elapsedSec: nextSec,
        };
      });
      const doneVerifying = nextSlices.every((s) => s.status === "ready");
      return {
        ...task,
        stage: doneVerifying ? "awaiting_review" : "verifying",
        slices: nextSlices,
        updatedAtIso: nowIso,
      };
    }

    return task;
  });

  setSnapshot({
    ...stateSnapshot,
    tasks: nextTasks,
  });
}

/**
 * 将服务端持久化的工作区目录、房间挂载映射与真实工单幂等合并至前端工作台快照。
 */
export function hydrateServerWorkspacesAndTasks(params: {
  readonly workspaces: ReadonlyArray<AgentWorkspace>;
  readonly roomBindings: Readonly<Record<string, string>>;
  readonly tasks: ReadonlyArray<SoloWorkTaskView>;
}): void {
  const existingTaskMap = new Map(stateSnapshot.tasks.map((t) => [t.id, t]));

  const hydratedServerTasks = params.tasks.map((incoming) => {
    const prior = existingTaskMap.get(incoming.id);
    if (!prior?.trace || prior.trace.length === 0) {
      return incoming;
    }
    const incomingIds = new Set((incoming.trace ?? []).map((e) => e.id));
    const unsyncedTail = prior.trace.filter((e) => !incomingIds.has(e.id));
    if (unsyncedTail.length === 0) {
      return incoming;
    }
    return {
      ...incoming,
      trace: [...(incoming.trace ?? []), ...unsyncedTail].slice(-160),
    };
  });

  const serverIds = new Set(params.tasks.map((t) => t.id));
  const preservedLocalTasks = stateSnapshot.tasks.filter(
    (t) => !t.id.startsWith("wrk_") && !serverIds.has(t.id),
  );

  setSnapshot({
    ...stateSnapshot,
    initialized: true,
    repos: params.workspaces,
    tasks: [...hydratedServerTasks, ...preservedLocalTasks],
    roomBindings: params.roomBindings,
  });
}

/**
 * 原地插入或覆盖单个服务端权威工作区。
 */
export function upsertServerWorkspaceInStore(workspace: AgentWorkspace): void {
  const exists = stateSnapshot.repos.some((w) => w.id === workspace.id);
  const nextRepos = exists
    ? stateSnapshot.repos.map((w) => (w.id === workspace.id ? workspace : w))
    : [workspace, ...stateSnapshot.repos];
  const nextTasks = stateSnapshot.tasks.map((t) =>
    t.repoId === workspace.id ? { ...t, repoName: workspace.name } : t,
  );
  setSnapshot({
    ...stateSnapshot,
    initialized: true,
    repos: nextRepos,
    tasks: nextTasks,
  });
}

/**
 * 从本地存储移除已删除的服务端工作区并解绑房间引用。
 */
export function removeServerWorkspaceFromStore(workspaceId: string): void {
  const nextRepos = stateSnapshot.repos.filter((w) => w.id !== workspaceId);
  const nextBindings: Record<string, string> = {};
  for (const [rmId, wsId] of Object.entries(stateSnapshot.roomBindings)) {
    if (wsId !== workspaceId) {
      nextBindings[rmId] = wsId;
    }
  }
  setSnapshot({
    ...stateSnapshot,
    repos: nextRepos,
    roomBindings: nextBindings,
  });
}

/**
 * 原地插入或覆盖单条服务端权威工单快照。
 */
export function upsertServerWorkItemInStore(task: SoloWorkTaskView): void {
  const existing = stateSnapshot.tasks.find((t) => t.id === task.id);
  const mergedTask: SoloWorkTaskView =
    existing?.trace && existing.trace.length > (task.trace?.length ?? 0)
      ? {
          ...task,
          trace: [
            ...(task.trace ?? []),
            ...existing.trace.filter((e) => !(task.trace ?? []).some((te) => te.id === e.id)),
          ].slice(-160),
        }
      : task;

  const nextTasks = existing
    ? stateSnapshot.tasks.map((t) => (t.id === task.id ? mergedTask : t))
    : [mergedTask, ...stateSnapshot.tasks];

  setSnapshot({
    ...stateSnapshot,
    initialized: true,
    tasks: nextTasks,
  });
}

/**
 * 接收 SSE `work.trace` 增量帧，毫秒级向目标工单追加实时追踪日志与分片状态摘要。
 */
export function appendRealtimeWorkTraceInStore(params: {
  readonly workItemId: string;
  readonly entry: WorkTraceEntry;
  readonly sliceId?: string | undefined;
  readonly liveSummary?: string | undefined;
  readonly diffAdded?: number | undefined;
  readonly diffRemoved?: number | undefined;
}): void {
  const target = stateSnapshot.tasks.find((t) => t.id === params.workItemId);
  if (!target) {
    return;
  }
  const currentTrace = target.trace ?? [];
  const nextTrace = currentTrace.some((e) => e.id === params.entry.id)
    ? currentTrace
    : [...currentTrace, params.entry].slice(-160);

  const nextSlices =
    params.sliceId !== undefined
      ? target.slices.map((slice) =>
          slice.sliceId === params.sliceId
            ? {
                ...slice,
                ...(params.liveSummary !== undefined ? { liveSummary: params.liveSummary } : {}),
                ...(params.diffAdded !== undefined && params.diffAdded > 0
                  ? { diffAdded: params.diffAdded }
                  : {}),
                ...(params.diffRemoved !== undefined && params.diffRemoved > 0
                  ? { diffRemoved: params.diffRemoved }
                  : {}),
              }
            : slice,
        )
      : target.slices;

  setSnapshot({
    ...stateSnapshot,
    tasks: stateSnapshot.tasks.map((t) =>
      t.id === params.workItemId
        ? {
            ...t,
            trace: nextTrace,
            slices: nextSlices,
            updatedAtIso: params.entry.timestampIso,
          }
        : t,
    ),
  });
}

/**
 * 轻量订阅工作区目录与群聊关联映射（不触发示例任务初始化，也不注册任务读秒定时器）。
 */
export function useWorkspaceDirectory(): WorkspaceDirectorySnapshot {
  return useSyncExternalStore(subscribe, getDirectorySnapshot, getDirectorySnapshot);
}

/**
 * 轻量订阅工作台任务汇总计数（仅当桶计数变化时触发重渲染，避免顶层导轨随秒级读秒每秒刷新）。
 */
export function useSoloWorkbenchCounts(): SoloWorkbenchCounts {
  return useSyncExternalStore(subscribe, getCountsSnapshot, getCountsSnapshot);
}

/**
 * 订阅完整个人工作台状态并按需挂载全局单一定时器。
 */
export function useSoloWorkbenchState(
  ownedAgents: ReadonlyArray<OwnedAgentSummaryDto>,
  ownerDisplayName: string,
): {
  readonly workspaces: ReadonlyArray<AgentWorkspace>;
  readonly repos: ReadonlyArray<SoloRepoTarget>;
  readonly tasks: ReadonlyArray<SoloWorkTaskView>;
  readonly roomBindings: Readonly<Record<string, string>>;
  readonly counts: SoloWorkbenchCounts;
} {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    ensureSoloWorkbenchInitialized(ownedAgents, ownerDisplayName);
  }, [ownedAgents, ownerDisplayName]);

  useEffect(() => {
    soloSubscriberCount += 1;
    syncSoloTicker();
    return () => {
      soloSubscriberCount = Math.max(0, soloSubscriberCount - 1);
      syncSoloTicker();
    };
  }, []);

  const counts = useMemo(() => computeSoloWorkbenchCounts(snap.tasks), [snap.tasks]);

  return {
    workspaces: snap.repos,
    repos: snap.repos,
    tasks: snap.tasks,
    roomBindings: snap.roomBindings,
    counts,
  };
}
