/**
 * @module server/modules/workspaces/service
 * @description 五维工作区生命周期、持久租约分片调度与多 Agent 协作编排领域服务。
 *
 * 核心流程与安全不变量：
 * 1. Owner-First 宿主边界（ADR-0010）：私人本机与个人云开发机工作区严禁跨主人派发或认领执行租约；唯有开启 `allowRoomCollaborators` 的 `shared_container` 允许同群外部 Agent 在单写者租约下协作。
 * 2. 死锁免疫锁顺序：同时写房间消息流与工单状态时，严格遵循 `rooms FOR UPDATE -> work_items FOR UPDATE`。
 * 3. 事务后实时投递（Post-Commit Only）：所有 `work.updated`、`workspace.updated`、`message.created` 与下一棒 Agent `wake` 信号一律在数据库事务提交后异步扇出。
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  DEFAULT_SLICE_LEASE_TTL_MS,
  MAX_SLICE_ATTEMPTS,
  type OrchestrationSliceState,
  type WorkDomainRejection,
  detectOwnedPathConflicts,
  evaluateHumanReviewDecision,
  evaluateRaiseSliceAttention,
  evaluateSliceClaim,
  evaluateSliceCompletion,
  evaluateWorkspaceExecutionAccess,
  scrubReviewPatch,
  scrubWorkText,
} from "@openhuddle/core-governance";
import { parseUnifiedGitDiff } from "@openhuddle/core-governance/workspace-diff";
import {
  type AgentId,
  type AnswerWorkAttentionBody,
  type AuthenticatedCaller,
  type BindRoomWorkspaceBody,
  type BindRoomWorkspaceResponse,
  type ClaimWorkSliceBody,
  type ClaimWorkSliceResponse,
  type CompleteWorkSliceBody,
  type ControlWorkItemBody,
  type CreateWorkItemBody,
  type CreateWorkSliceSpec,
  type CreateWorkspaceBody,
  type DecideWorkReviewBody,
  type HeartbeatWorkSliceBody,
  type ListWorkItemsQuery,
  type ListWorkspacesResponse,
  MAX_REVIEW_EVIDENCE_BYTES,
  type PutReviewEvidenceBody,
  type RaiseWorkAttentionBody,
  type ReviewEvidenceResponse,
  type RoomId,
  type RoomWorkspacesResponse,
  type SseEvent,
  type SteerWorkItemBody,
  type UpdateWorkspaceBody,
  type UserId,
  type WorkDiffFileDto,
  type WorkItemDto,
  type WorkItemId,
  type WorkSliceId,
  type WorkTraceEntry,
  type WorkTraceKind,
  type WorkspaceContextAssets,
  type WorkspaceDto,
  type WorkspaceHostMode,
  type WorkspaceId,
  type WorkspaceLifecycleHooks,
  type WorkspaceRootEntry,
  type WorkspaceRootInput,
  asMessageSeq,
} from "@openhuddle/protocol";
import type { Logger } from "pino";
import { assertHumanCaller } from "../../infra/auth-middleware.js";
import {
  generateWorkItemId,
  generateWorkSliceId,
  generateWorkspaceId,
} from "../../infra/crypto.js";
import { AppError } from "../../infra/errors.js";
import { PUBLIC_NEUTRAL_VIEWER, toActorMemberKey } from "../../infra/identity-stamp.js";
import type { RealtimeBus } from "../../infra/realtime-bus.js";
import {
  type HydratedRawMessageRecord,
  stampRawMessageForViewer,
} from "../messages/messages.repo.js";
import { inspectAndPrepareLocalWorkspace } from "./workspace-fs-guard.js";
import {
  type HydratedWorkItemRecord,
  type HydratedWorkspaceRecord,
  type StoredAgentSnapshot,
  type StoredAttentionRecord,
  getViewerOwnerUserId,
  serializeWorkItemForViewer,
  serializeWorkspaceForViewer,
  toOrchestrationItemState,
} from "./workspaces.mapper.js";
import type { WorkspacesRepository } from "./workspaces.repo.js";

export interface WorkspacesServiceDeps {
  readonly repo: WorkspacesRepository;
  readonly realtimeBus: RealtimeBus;
  readonly logger?: Logger | undefined;
  readonly nowFn?: () => number;
  readonly defaultLocalWorkspaceRoot?: string | undefined;
  readonly isLoopbackHost?: boolean | undefined;
  readonly localHomeDir?: string | undefined;
}

export type WorkItemPostCommitListener = (item: Readonly<HydratedWorkItemRecord>) => void;

export interface LeaseSweepSummary {
  readonly scannedCount: number;
  readonly reclaimedCount: number;
  readonly blockedCount: number;
}

function isUniqueConstraintError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) {
    return false;
  }
  const code = (err as { readonly code?: unknown }).code;
  if (code === "23505") {
    return true;
  }
  const cause = (err as { readonly cause?: unknown }).cause;
  return (
    typeof cause === "object" &&
    cause !== null &&
    (cause as { readonly code?: unknown }).code === "23505"
  );
}

const DEFAULT_CONTEXT_ASSETS: WorkspaceContextAssets = Object.freeze({
  ruleFiles: ["CLAUDE.md"],
  skillCount: 0,
  sharedMemoryActive: true,
});

function toAppError(rejection: Readonly<WorkDomainRejection>): AppError {
  const statusCode = rejection.code === "FORBIDDEN_WORKSPACE_ACCESS" ? 403 : 409;
  return new AppError({
    code: rejection.code,
    statusCode,
    message: rejection.message,
  });
}

function defaultHostLabel(mode: WorkspaceHostMode): string {
  switch (mode) {
    case "local_machine":
      return "Local Machine";
    case "personal_remote":
      return "Personal Devbox";
    case "shared_container":
      return "Shared Sandbox Container";
  }
}

function normalizeRootInputs(roots: readonly WorkspaceRootInput[]): readonly WorkspaceRootEntry[] {
  return roots.map((root, idx) => {
    const cleanedPath = scrubWorkText(root.localPath.trim());
    const baseName =
      root.name?.trim() ||
      path.posix.basename(cleanedPath.replace(/\\/g, "/")) ||
      `root-${idx + 1}`;
    return {
      id: root.id?.trim() || `root_${idx + 1}`,
      name: baseName.slice(0, 120),
      localPath: cleanedPath,
      isGitRepo: root.isGitRepo,
      ...(root.defaultBranch !== undefined ? { defaultBranch: root.defaultBranch } : {}),
      ...(root.remoteSlug !== undefined ? { remoteSlug: scrubWorkText(root.remoteSlug) } : {}),
    };
  });
}

function deriveWorkTitle(explicitTitle: string | undefined, brief: string): string {
  if (explicitTitle && explicitTitle.trim().length > 0) {
    return scrubWorkText(explicitTitle.trim()).slice(0, 200);
  }
  const firstLine = brief.split(/\r?\n/)[0]?.trim() ?? "Collaborative task";
  const clipped = firstLine.length > 88 ? `${firstLine.slice(0, 88)}…` : firstLine;
  return scrubWorkText(clipped);
}

function deriveWorktreeBranch(
  explicitBranch: string | undefined,
  title: string,
  id: string,
): string {
  if (explicitBranch && explicitBranch.trim().length > 0) {
    return scrubWorkText(explicitBranch.trim()).slice(0, 160);
  }
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return `oh/${slug || "task"}-${id.slice(-6)}`;
}

function sanitizeHooks(hooks: WorkspaceLifecycleHooks | undefined): WorkspaceLifecycleHooks {
  if (!hooks) {
    return {};
  }
  return {
    ...(hooks.setupCommand !== undefined
      ? { setupCommand: scrubWorkText(hooks.setupCommand) }
      : {}),
    ...(hooks.verifyCommand !== undefined
      ? { verifyCommand: scrubWorkText(hooks.verifyCommand) }
      : {}),
    ...(hooks.copyEnvGlobs !== undefined ? { copyEnvGlobs: [...hooks.copyEnvGlobs] } : {}),
  };
}

function buildTraceEntry(params: {
  readonly nowMs: number;
  readonly actorName: string;
  readonly kind: WorkTraceKind;
  readonly message: string;
  readonly detail?: string | undefined;
  readonly sliceId?: WorkSliceId | undefined;
}): WorkTraceEntry {
  const cleanDetail = params.detail !== undefined ? scrubWorkText(params.detail.trim()) : "";
  return {
    id: `trc_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
    timestampIso: new Date(params.nowMs).toISOString(),
    actorName: scrubWorkText(params.actorName.trim()).slice(0, 80) || "System",
    kind: params.kind,
    message: scrubWorkText(params.message.trim()).slice(0, 600) || "Updated",
    ...(cleanDetail.length > 0 ? { detail: cleanDetail.slice(0, 4_000) } : {}),
    ...(params.sliceId !== undefined ? { sliceId: params.sliceId } : {}),
  };
}

function mergeDiffFilesByPath(
  existing: readonly WorkDiffFileDto[],
  incoming: readonly WorkDiffFileDto[],
): readonly WorkDiffFileDto[] {
  if (incoming.length === 0 && existing.length === 0) {
    return [];
  }
  const byPath = new Map<string, WorkDiffFileDto>();
  for (const file of existing) {
    byPath.set(file.path, file);
  }
  for (const file of incoming) {
    byPath.set(file.path, file);
  }
  return [...byPath.values()].slice(0, 48);
}

function inspectLocalDirectoryDefaults(rootDir: string): {
  readonly name: string;
  readonly isGitRepo: boolean;
  readonly defaultBranch?: string | undefined;
  readonly ruleFiles: readonly string[];
  readonly verifyCommand?: string | undefined;
} {
  const resolved = path.resolve(rootDir);
  const name = path.basename(resolved) || "workspace";
  const gitHeadPath = path.join(resolved, ".git", "HEAD");
  const isGitRepo = existsSync(path.join(resolved, ".git"));
  let defaultBranch: string | undefined;
  if (isGitRepo && existsSync(gitHeadPath)) {
    try {
      const headRaw = readFileSync(gitHeadPath, "utf8").trim();
      const refPrefix = "ref: refs/heads/";
      defaultBranch = headRaw.startsWith(refPrefix) ? headRaw.slice(refPrefix.length) : "main";
    } catch {
      defaultBranch = "main";
    }
  }

  const candidateRules = ["CLAUDE.md", "AGENTS.md", ".cursorrules"];
  const ruleFiles = candidateRules.filter((file) => existsSync(path.join(resolved, file)));

  let verifyCommand: string | undefined;
  const pkgJsonPath = path.join(resolved, "package.json");
  if (existsSync(pkgJsonPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as {
        readonly scripts?: Readonly<Record<string, unknown>>;
      };
      const runner = existsSync(path.join(resolved, "pnpm-lock.yaml"))
        ? "pnpm"
        : existsSync(path.join(resolved, "yarn.lock"))
          ? "yarn"
          : "npm run";
      if (typeof pkg.scripts?.typecheck === "string") {
        verifyCommand = `${runner} typecheck`;
      } else if (typeof pkg.scripts?.test === "string") {
        verifyCommand = runner === "npm run" ? "npm test" : `${runner} test`;
      }
    } catch {
      // 忽略损坏的 package.json
    }
  }

  return {
    name,
    isGitRepo,
    ...(defaultBranch !== undefined ? { defaultBranch } : {}),
    ruleFiles,
    ...(verifyCommand !== undefined ? { verifyCommand } : {}),
  };
}

/**
 * 工作区与多 Agent 协作任务核心编排服务。
 */
export class WorkspacesService {
  private readonly repo: WorkspacesRepository;
  private readonly realtimeBus: RealtimeBus;
  private readonly logger?: Logger | undefined;
  private readonly nowFn: () => number;
  private readonly defaultLocalWorkspaceRoot?: string | undefined;
  private readonly isLoopbackHost: boolean;
  private readonly localHomeDir?: string | undefined;
  private readonly postCommitListeners = new Set<WorkItemPostCommitListener>();
  private readonly autoSeededOwners = new Set<UserId>();
  private readonly autoSeedInFlight = new Map<UserId, Promise<void>>();

  public constructor(deps: Readonly<WorkspacesServiceDeps>) {
    this.repo = deps.repo;
    this.realtimeBus = deps.realtimeBus;
    this.logger = deps.logger;
    this.nowFn = deps.nowFn ?? (() => Date.now());
    this.defaultLocalWorkspaceRoot = deps.defaultLocalWorkspaceRoot;
    this.isLoopbackHost = deps.isLoopbackHost ?? false;
    this.localHomeDir = deps.localHomeDir;
  }

  /**
   * 订阅工单事务提交后的状态快照（供本机执行引擎零轮询即时响应派单、交接与取消信号）。
   */
  public onWorkItemUpdated(listener: WorkItemPostCommitListener): () => void {
    this.postCommitListeners.add(listener);
    return () => {
      this.postCommitListeners.delete(listener);
    };
  }

  /**
   * 列出当前人类用户（或 Agent 所属主人）名下的全部五维工作区与房间挂载关系。
   * 在本机回环模式下，若人类主人首次进入工作台尚无任何工作区，自动探测并持久化当前本地仓库。
   */
  public async listWorkspaces(
    caller: Readonly<AuthenticatedCaller>,
  ): Promise<ListWorkspacesResponse> {
    const ownerUserId = getViewerOwnerUserId(caller);
    let records = await this.repo.listWorkspacesByOwner(ownerUserId);

    if (
      caller.kind === "human" &&
      records.length === 0 &&
      this.defaultLocalWorkspaceRoot !== undefined &&
      !this.autoSeededOwners.has(ownerUserId) &&
      existsSync(this.defaultLocalWorkspaceRoot)
    ) {
      await this.ensureDefaultLocalWorkspace(ownerUserId, this.defaultLocalWorkspaceRoot);
      records = await this.repo.listWorkspacesByOwner(ownerUserId);
    } else if (records.length > 0) {
      this.autoSeededOwners.add(ownerUserId);
    }

    const [roomBindings, ownerAgentIds] = await Promise.all([
      this.repo.listRoomBindingsByOwner(ownerUserId),
      this.repo.listAgentIdsByOwner(ownerUserId),
    ]);

    return {
      ok: true,
      workspaces: records.map((ws) =>
        serializeWorkspaceForViewer(ws, caller, this.resolveWorkspaceOnline(ws, ownerAgentIds)),
      ),
      roomBindings: [...roomBindings],
    };
  }

  /**
   * 创建新的五维受控工作区（仅限人类主人执行）。
   */
  public async createWorkspace(
    caller: Readonly<AuthenticatedCaller>,
    body: Readonly<CreateWorkspaceBody>,
  ): Promise<WorkspaceDto> {
    const human = assertHumanCaller(caller);
    await this.assertOwnedAgentIds(human.userId, [
      body.defaultWorkerAgentId,
      body.defaultVerifierAgentId,
    ]);

    const id = generateWorkspaceId();
    const effectiveSandbox =
      body.kind === "folder" && body.sandboxMode === "worktree_pool"
        ? ("in_place" as const)
        : body.sandboxMode;
    const baseRoots = normalizeRootInputs(body.roots);
    const sanitizedHooks = sanitizeHooks(body.hooks);

    const prepared =
      this.isLoopbackHost && body.hostMode === "local_machine"
        ? inspectAndPrepareLocalWorkspace({
            roots: baseRoots,
            kind: body.kind,
            sandboxMode: effectiveSandbox,
            explicitHooks: sanitizedHooks,
            explicitContext: body.context,
            homeDir: this.localHomeDir,
          })
        : {
            roots: baseRoots,
            hooks: sanitizedHooks,
            context: body.context ?? DEFAULT_CONTEXT_ASSETS,
          };

    const prewarmedWorktrees =
      body.prewarmedWorktrees ?? (effectiveSandbox === "worktree_pool" ? 3 : 0);

    await this.repo.insertWorkspace({
      id,
      ownerUserId: human.userId,
      name: scrubWorkText(body.name.trim()),
      kind: body.kind,
      roots: prepared.roots,
      hostMode: body.hostMode,
      hostLabel: body.hostLabel ? scrubWorkText(body.hostLabel) : defaultHostLabel(body.hostMode),
      sandboxMode: effectiveSandbox,
      allowRoomCollaborators: body.hostMode === "shared_container" && body.allowRoomCollaborators,
      prewarmedWorktrees,
      hooks: prepared.hooks,
      context: prepared.context,
      defaultTopology: body.defaultTopology,
      ...(body.defaultWorkerAgentId !== undefined
        ? { defaultWorkerAgentId: body.defaultWorkerAgentId }
        : {}),
      ...(body.defaultVerifierAgentId !== undefined
        ? { defaultVerifierAgentId: body.defaultVerifierAgentId }
        : {}),
    });

    const created = await this.mustFindWorkspace(id);
    this.autoSeededOwners.add(human.userId);
    const ownerAgentIds = await this.repo.listAgentIdsByOwner(human.userId);

    await this.realtimeBus.publishToUser(human.userId, {
      type: "workspace.updated",
      workspaceId: id,
    });

    return serializeWorkspaceForViewer(
      created,
      caller,
      this.resolveWorkspaceOnline(created, ownerAgentIds),
    );
  }

  /**
   * 更新指定工作区的隔离策略、钩子或默认编排角色（仅限工作区主人）。
   */
  public async updateWorkspace(
    caller: Readonly<AuthenticatedCaller>,
    workspaceId: WorkspaceId,
    body: Readonly<UpdateWorkspaceBody>,
  ): Promise<WorkspaceDto> {
    const human = assertHumanCaller(caller);
    const existing = await this.mustFindWorkspace(workspaceId);
    if (existing.ownerUserId !== human.userId) {
      throw new AppError({
        code: "FORBIDDEN_NOT_OWNER",
        statusCode: 403,
        message: "Only the workspace owner may modify this workspace.",
      });
    }

    await this.assertOwnedAgentIds(human.userId, [
      body.defaultWorkerAgentId ?? undefined,
      body.defaultVerifierAgentId ?? undefined,
    ]);

    const effectiveKind = body.kind ?? existing.kind;
    const effectiveHostMode = body.hostMode ?? existing.hostMode;
    const rawSandbox = body.sandboxMode ?? existing.sandboxMode;
    const effectiveSandbox =
      effectiveKind === "folder" && rawSandbox === "worktree_pool"
        ? ("in_place" as const)
        : rawSandbox;
    const effectiveAllowCollaborators =
      effectiveHostMode === "shared_container"
        ? (body.allowRoomCollaborators ?? existing.allowRoomCollaborators)
        : false;

    const candidateRoots =
      body.roots !== undefined ? normalizeRootInputs(body.roots) : existing.roots;
    const preparedLocal =
      this.isLoopbackHost &&
      effectiveHostMode === "local_machine" &&
      (body.roots !== undefined || body.kind !== undefined || body.sandboxMode !== undefined)
        ? inspectAndPrepareLocalWorkspace({
            roots: candidateRoots,
            kind: effectiveKind,
            sandboxMode: effectiveSandbox,
            explicitHooks: body.hooks !== undefined ? sanitizeHooks(body.hooks) : existing.hooks,
            explicitContext: body.context,
            homeDir: this.localHomeDir,
          })
        : undefined;

    await this.repo.updateWorkspaceRow(workspaceId, {
      ...(body.name !== undefined ? { name: scrubWorkText(body.name.trim()) } : {}),
      ...(body.kind !== undefined ? { kind: effectiveKind } : {}),
      ...(preparedLocal !== undefined
        ? { roots: preparedLocal.roots }
        : body.roots !== undefined
          ? { roots: candidateRoots }
          : {}),
      ...(body.hostMode !== undefined ? { hostMode: body.hostMode } : {}),
      ...(body.hostLabel !== undefined ? { hostLabel: scrubWorkText(body.hostLabel) } : {}),
      sandboxMode: effectiveSandbox,
      allowRoomCollaborators: effectiveAllowCollaborators,
      ...(body.prewarmedWorktrees !== undefined
        ? { prewarmedWorktrees: body.prewarmedWorktrees }
        : {}),
      ...(preparedLocal !== undefined
        ? { hooks: preparedLocal.hooks }
        : body.hooks !== undefined
          ? { hooks: sanitizeHooks(body.hooks) }
          : {}),
      ...(preparedLocal !== undefined
        ? { context: preparedLocal.context }
        : body.context !== undefined
          ? { context: body.context }
          : {}),
      ...(body.defaultTopology !== undefined ? { defaultTopology: body.defaultTopology } : {}),
      ...(body.defaultWorkerAgentId !== undefined
        ? { defaultWorkerAgentId: body.defaultWorkerAgentId }
        : {}),
      ...(body.defaultVerifierAgentId !== undefined
        ? { defaultVerifierAgentId: body.defaultVerifierAgentId }
        : {}),
    });

    const updated = await this.mustFindWorkspace(workspaceId);
    const [boundRooms, ownerAgentIds] = await Promise.all([
      this.repo.listBoundRoomIdsForWorkspace(workspaceId),
      this.repo.listAgentIdsByOwner(human.userId),
    ]);

    await this.publishWorkspaceUpdated(workspaceId, human.userId, boundRooms);
    return serializeWorkspaceForViewer(
      updated,
      caller,
      this.resolveWorkspaceOnline(updated, ownerAgentIds),
    );
  }

  /**
   * 删除受控工作区及其关联的房间挂载关系（仅限工作区主人）。
   */
  public async deleteWorkspace(
    caller: Readonly<AuthenticatedCaller>,
    workspaceId: WorkspaceId,
  ): Promise<WorkspaceId> {
    const human = assertHumanCaller(caller);
    const existing = await this.mustFindWorkspace(workspaceId);
    if (existing.ownerUserId !== human.userId) {
      throw new AppError({
        code: "FORBIDDEN_NOT_OWNER",
        statusCode: 403,
        message: "Only the workspace owner may delete this workspace.",
      });
    }

    const boundRooms = await this.repo.listBoundRoomIdsForWorkspace(workspaceId);
    await this.repo.deleteWorkspaceRow(workspaceId);
    await this.publishWorkspaceUpdated(workspaceId, human.userId, boundRooms);
    return workspaceId;
  }

  /**
   * 绑定或解绑人类成员在目标房间中的默认工作区。
   */
  public async bindRoomWorkspace(
    caller: Readonly<AuthenticatedCaller>,
    roomId: RoomId,
    body: Readonly<BindRoomWorkspaceBody>,
  ): Promise<BindRoomWorkspaceResponse> {
    const human = assertHumanCaller(caller);
    await this.assertRoomMemberAccess(roomId, caller);

    if (body.workspaceId === null) {
      const prev = (await this.repo.listRoomBindingsByOwner(human.userId)).find(
        (b) => b.roomId === roomId,
      );
      await this.repo.deleteRoomWorkspaceBinding(roomId, human.userId);
      if (prev) {
        await this.publishWorkspaceUpdated(prev.workspaceId, human.userId, [roomId]);
      }
      return { ok: true, roomId, binding: null };
    }

    const ws = await this.mustFindWorkspace(body.workspaceId);
    if (ws.ownerUserId !== human.userId) {
      throw new AppError({
        code: "FORBIDDEN_NOT_OWNER",
        statusCode: 403,
        message: "You can only bind a workspace that you own.",
      });
    }

    const binding = await this.repo.upsertRoomWorkspaceBinding({
      roomId,
      ownerUserId: human.userId,
      workspaceId: ws.id,
    });
    await this.publishWorkspaceUpdated(ws.id, human.userId, [roomId]);
    return { ok: true, roomId, binding };
  }

  /**
   * 列出目标房间内已挂载的所有工作区（跨主人视角自动剥离 `localPath`）。
   */
  public async listRoomWorkspaces(
    caller: Readonly<AuthenticatedCaller>,
    roomId: RoomId,
  ): Promise<RoomWorkspacesResponse> {
    await this.assertRoomMemberAccess(roomId, caller);
    const { workspaces, bindings } = await this.repo.listBoundWorkspacesForRoom(roomId);

    const ownerAgents = new Map<UserId, readonly AgentId[]>();
    const dtos: WorkspaceDto[] = [];
    for (const ws of workspaces) {
      let agentIds = ownerAgents.get(ws.ownerUserId);
      if (agentIds === undefined) {
        agentIds = await this.repo.listAgentIdsByOwner(ws.ownerUserId);
        ownerAgents.set(ws.ownerUserId, agentIds);
      }
      dtos.push(serializeWorkspaceForViewer(ws, caller, this.resolveWorkspaceOnline(ws, agentIds)));
    }

    return {
      ok: true,
      workspaces: dtos,
      bindings: [...bindings],
    };
  }

  /**
   * 查询调用者可见的多 Agent 协作工单列表；支持 Agent 以 `claimableOnly=true` 拉取立即可认领的任务队列。
   */
  public async listWorkItems(
    caller: Readonly<AuthenticatedCaller>,
    query: Readonly<ListWorkItemsQuery>,
  ): Promise<readonly WorkItemDto[]> {
    if (query.claimableOnly === true && caller.kind !== "agent") {
      return [];
    }

    const filterOpts = {
      stage: query.stage,
      claimableBy:
        query.claimableOnly && caller.kind === "agent"
          ? { agentId: caller.agentId, ownerUserId: caller.ownerUserId, nowMs: this.nowFn() }
          : undefined,
      limit: query.limit,
    };

    let records: readonly HydratedWorkItemRecord[];

    if (query.roomId !== undefined) {
      await this.assertRoomMemberAccess(query.roomId, caller);
      records = await this.repo.listHydratedWorkItemsByRoom(query.roomId, filterOpts);
    } else if (query.workspaceId !== undefined) {
      const ws = await this.mustFindWorkspace(query.workspaceId);
      await this.assertWorkspaceReadAccess(ws, caller);
      records = await this.repo.listHydratedWorkItemsByWorkspace(query.workspaceId, filterOpts);
    } else {
      records = await this.repo.listHydratedWorkItemsVisibleToOwnerAndRooms({
        ownerUserId: getViewerOwnerUserId(caller),
        joinedRoomIds: await this.repo.listJoinedRoomIds(toActorMemberKey(caller)),
        ...filterOpts,
      });
    }

    return records.map((rec) => serializeWorkItemForViewer(rec, caller));
  }

  /**
   * 获取单个工单完整状态快照。
   */
  public async getWorkItem(
    caller: Readonly<AuthenticatedCaller>,
    workItemId: WorkItemId,
  ): Promise<WorkItemDto> {
    const item = await this.mustFindWorkItem(workItemId);
    await this.assertWorkItemReadAccess(item, caller);
    return serializeWorkItemForViewer(item, caller);
  }

  public async getReviewEvidence(
    caller: Readonly<AuthenticatedCaller>,
    workItemId: WorkItemId,
    sliceId: WorkSliceId,
  ): Promise<ReviewEvidenceResponse> {
    return this.repo.runInTransaction(async (txRepo) => {
      const item = await this.lockAndLoadWorkItem(txRepo, workItemId);
      if (caller.kind !== "human" || caller.userId !== item.workspaceOwnerUserId) {
        const reviewer =
          caller.kind === "agent" &&
          item.slices.find(
            (s) =>
              s.leaseRole === "verify" &&
              (s.assignedAgentId === caller.agentId || s.leaseOwnerAgentId === caller.agentId),
          );
        if (!reviewer || caller.kind !== "agent") {
          throw new AppError({
            code: "FORBIDDEN_WORKSPACE_ACCESS",
            statusCode: 403,
            message: "Only the workspace owner and authorized reviewers can read the full patch.",
          });
        }
        await this.assertEvidenceAgentAccess(txRepo, item, caller, "verify");
      }
      const slice = this.mustFindSlice(item, sliceId);
      const current =
        slice.status === "ready" ||
        (slice.status === "running" && (slice.leaseExpiresAtMs ?? 0) > this.nowFn());
      const patch = current
        ? await txRepo.findReviewEvidence(sliceId, slice.leaseVersion)
        : undefined;
      if (patch === undefined)
        throw new AppError({
          code: "NOT_FOUND",
          statusCode: 404,
          message: "No current review evidence for this slice.",
        });
      return { ok: true, leaseVersion: slice.leaseVersion, patch };
    });
  }

  public async putReviewEvidence(
    caller: Readonly<AuthenticatedCaller>,
    workItemId: WorkItemId,
    sliceId: WorkSliceId,
    body: PutReviewEvidenceBody,
  ): Promise<ReviewEvidenceResponse> {
    const agent = this.assertAgentCaller(caller);
    const patch = scrubReviewPatch(body.patch);
    if (
      !patch.length ||
      Buffer.byteLength(patch) > MAX_REVIEW_EVIDENCE_BYTES ||
      patch.includes("\0")
    ) {
      throw new AppError({
        code: "VALIDATION_ERROR",
        statusCode: 400,
        message: "Review patch exceeds the text payload limit.",
      });
    }
    if (!/^diff --git [^\n]+|^--- [^\n]+\n\+\+\+ [^\n]+/m.test(patch)) {
      throw new AppError({
        code: "VALIDATION_ERROR",
        statusCode: 400,
        message: "Review evidence must be a unified diff.",
      });
    }
    const resumed = await this.repo.runInTransaction(async (txRepo) => {
      const item = await this.lockAndLoadWorkItem(txRepo, workItemId);
      const slice = this.mustFindSlice(item, sliceId);
      if (slice.leaseRole !== "write" || slice.assignedAgentId !== agent.agentId) {
        throw new AppError({
          code: "FORBIDDEN_WORKSPACE_ACCESS",
          statusCode: 403,
          message: "Only the assigned writer may submit review evidence.",
        });
      }
      await this.assertEvidenceAgentAccess(txRepo, item, agent, "write");
      const active = slice.status === "running" && (slice.leaseExpiresAtMs ?? 0) > this.nowFn();
      if (
        slice.leaseVersion !== body.leaseVersion ||
        slice.leaseOwnerAgentId !== agent.agentId ||
        (!active && slice.status !== "ready")
      ) {
        throw new AppError({
          code: "WORK_LEASE_EXPIRED",
          statusCode: 409,
          message: "Evidence requires the current running or completed write lease.",
        });
      }
      const stored = await txRepo.findReviewEvidence(sliceId, body.leaseVersion);
      if (stored === patch) return;
      if (stored !== undefined)
        throw new AppError({
          code: "WORK_INVALID_TRANSITION",
          statusCode: 409,
          message: "A different patch already exists for this lease.",
        });

      await txRepo.storeReviewEvidence(sliceId, body.leaseVersion, patch);

      const attention = item.attention;
      if (
        item.stage !== "awaiting_answer" ||
        !attention ||
        attention.answeredAtMs !== undefined ||
        slice.status !== "ready"
      )
        return;
      const missingFile = slice.changedFiles.find(
        (file) =>
          attention.question ===
          `设备执行失败：文件 ${file} 的变更证据不完整，请在有完整工作树的设备上复核。`,
      );
      if (!missingFile) return;
      if (!parseUnifiedGitDiff(patch, 200, 0).some((file) => file.path === missingFile)) {
        throw new AppError({
          code: "VALIDATION_ERROR",
          statusCode: 400,
          message: "Patch does not contain the missing review file.",
        });
      }
      const verifier = item.slices.find(
        (s) =>
          s.sliceId === attention.sliceId &&
          s.leaseRole === "verify" &&
          s.status === "waiting" &&
          s.leaseOwnerAgentId === attention.askedByAgentId,
      );
      if (!verifier || item.slices.some((s) => s.leaseRole !== "verify" && s.status !== "ready"))
        return;
      const trace = buildTraceEntry({
        nowMs: this.nowFn(),
        actorName: agent.displayName,
        kind: "handoff",
        sliceId: verifier.sliceId,
        message: "已收到完整变更补丁，恢复独立复核。",
        ...(verifier.attemptCount >= MAX_SLICE_ATTEMPTS
          ? {
              detail: `此前已尝试 ${verifier.attemptCount} 次（租约 v${verifier.leaseVersion}）。本次补件开放一次复核领取机会。`,
            }
          : {}),
      });
      await txRepo.persistWorkItemState({
        workItemId,
        nextStage: "verifying",
        nextSlices: item.slices.map((s) =>
          s.sliceId === verifier.sliceId
            ? {
                ...s,
                attemptCount: Math.min(s.attemptCount, MAX_SLICE_ATTEMPTS - 1),
                leaseOwnerAgentId: undefined,
                leaseExpiresAtMs: undefined,
                liveSummary: "Ready for independent verification.",
              }
            : s,
        ),
        nextAttention: null,
        nextReview: item.review ?? null,
        nextTrace: [...item.trace, trace],
        dirtySliceIds: new Set([verifier.sliceId]),
      });
      return {
        item: await this.mustReloadWorkItem(txRepo, workItemId),
        verifier: verifier.assignedAgentId,
        trace,
      };
    });
    if (resumed) {
      await this.publishTraceEvents(resumed.item, [resumed.trace]);
      await this.fanOutPostCommitSignals({
        item: resumed.item,
        wakeAgentIds: [resumed.verifier],
        actorCaller: caller,
      });
    }
    return { ok: true, leaseVersion: body.leaseVersion, patch };
  }

  private async assertEvidenceAgentAccess(
    txRepo: WorkspacesRepository,
    item: HydratedWorkItemRecord,
    agent: Extract<AuthenticatedCaller, { kind: "agent" }>,
    role: "write" | "verify",
  ): Promise<void> {
    const isRoomMember =
      !item.roomId || (await txRepo.isMemberInRoom(item.roomId, toActorMemberKey(agent)));
    if (!isRoomMember)
      throw new AppError({
        code: "FORBIDDEN_NOT_ROOM_MEMBER",
        statusCode: 403,
        message: "Agent is no longer a member of this work item's room.",
      });
    const access = evaluateWorkspaceExecutionAccess({
      workspaceOwnerUserId: item.workspaceOwnerUserId,
      hostMode: item.workspaceHostMode,
      sandboxMode: item.workspaceSandboxMode,
      allowRoomCollaborators: item.workspaceAllowRoomCollaborators,
      agentOwnerUserId: agent.ownerUserId,
      isRoomMember,
      requestedRole: role,
      requestedTier: item.tier,
    });
    if (!access.ok) throw toAppError(access);
  }

  /**
   * 创建单人或群聊关联的多 Agent 协作工单（自动完成独占路径冲突检测、宿主权限校验、里程碑锚定与首轮唤醒）。
   */
  public async createWorkItem(
    caller: Readonly<AuthenticatedCaller>,
    body: Readonly<CreateWorkItemBody>,
  ): Promise<WorkItemDto> {
    const workspace = await this.mustFindWorkspace(body.workspaceId);
    const callerMemberKey = toActorMemberKey(caller);

    if (body.roomId !== undefined) {
      await this.assertRoomMemberAccess(body.roomId, caller);
    }

    // 建单权限校验：人类主人、主人名下具备非纯聊档位的统筹 Agent、或共享容器房间内的协作人类成员
    if (caller.kind === "human") {
      const isOwner = caller.userId === workspace.ownerUserId;
      const isSharedRoomCollaborator =
        body.roomId !== undefined &&
        workspace.hostMode === "shared_container" &&
        workspace.allowRoomCollaborators;
      if (!isOwner && !isSharedRoomCollaborator) {
        throw new AppError({
          code: "FORBIDDEN_WORKSPACE_ACCESS",
          statusCode: 403,
          message: "You do not have permission to dispatch work on this workspace.",
        });
      }
    } else {
      if (caller.ownerUserId !== workspace.ownerUserId || body.tier === "chat_only") {
        throw new AppError({
          code: "FORBIDDEN_WORKSPACE_ACCESS",
          statusCode: 403,
          message: "Only an owner-authorized coordinator agent may dispatch workspace tasks.",
        });
      }
    }

    const effectiveVerifierId =
      body.verifierAgentId ??
      (body.topology === "verify_loop" ? workspace.defaultVerifierAgentId : undefined);

    if (body.topology === "verify_loop" && effectiveVerifierId === undefined) {
      throw new AppError({
        code: "VALIDATION_ERROR",
        statusCode: 400,
        message: "verify_loop topology requires a verifierAgentId.",
      });
    }

    const rawSpecs = this.buildSliceSpecs(body, effectiveVerifierId);
    const conflicts = detectOwnedPathConflicts(
      rawSpecs.map((spec, index) => ({
        index,
        title: spec.title,
        leaseRole: spec.leaseRole,
        ownedPaths: spec.ownedPaths,
      })),
    );
    if (conflicts.length > 0) {
      throw new AppError({
        code: "WORK_PATH_CONFLICT",
        statusCode: 409,
        message: conflicts[0]?.reason ?? "Concurrent write slices have overlapping ownedPaths.",
        details: { conflicts },
      });
    }

    const allAgentIds: AgentId[] = [
      body.primaryWorkerAgentId,
      ...(body.coordinatorAgentId !== undefined ? [body.coordinatorAgentId] : []),
      ...(effectiveVerifierId !== undefined ? [effectiveVerifierId] : []),
      ...rawSpecs.map((s) => s.assignedAgentId),
    ];
    const agentSnapshotsMap = await this.repo.findAgentSnapshotsByIds(allAgentIds);

    for (const reqId of new Set(allAgentIds)) {
      if (!agentSnapshotsMap.has(reqId)) {
        throw new AppError({
          code: "NOT_FOUND",
          statusCode: 404,
          message: `Referenced agent "${reqId}" does not exist.`,
        });
      }
    }

    const roomPresentAgents =
      body.roomId !== undefined
        ? await this.repo.listPresentAgentIdsInRoom(body.roomId, allAgentIds)
        : undefined;

    for (const spec of rawSpecs) {
      const snap = agentSnapshotsMap.get(spec.assignedAgentId);
      if (!snap) continue;
      const isRoomMember =
        roomPresentAgents === undefined ? true : roomPresentAgents.has(spec.assignedAgentId);

      if (body.roomId !== undefined && !isRoomMember) {
        throw new AppError({
          code: "VALIDATION_ERROR",
          statusCode: 400,
          message: `Assigned agent "${snap.displayName}" (${spec.assignedAgentId}) is not a member of room ${body.roomId}.`,
        });
      }

      const access = evaluateWorkspaceExecutionAccess({
        workspaceOwnerUserId: workspace.ownerUserId,
        hostMode: workspace.hostMode,
        sandboxMode: workspace.sandboxMode,
        allowRoomCollaborators: workspace.allowRoomCollaborators,
        agentOwnerUserId: snap.ownerUserId,
        isRoomMember,
        requestedRole: spec.leaseRole,
        requestedTier: body.tier,
      });
      if (!access.ok) {
        throw toAppError(access);
      }
    }

    const workItemId = generateWorkItemId();
    const scrubbedBrief = scrubWorkText(body.brief);
    const title = deriveWorkTitle(body.title, scrubbedBrief);
    const worktreeBranch = deriveWorktreeBranch(body.worktreeBranch, title, workItemId);

    const initialSlices: OrchestrationSliceState[] = rawSpecs.map((spec, idx) => ({
      sliceId: generateWorkSliceId(),
      orderIndex: idx,
      title: scrubWorkText(spec.title),
      leaseRole: spec.leaseRole,
      assignedAgentId: spec.assignedAgentId,
      leaseVersion: 0,
      attemptCount: 0,
      ownedPaths: spec.ownedPaths.length > 0 ? spec.ownedPaths : ["**"],
      status: "waiting",
      liveSummary:
        spec.leaseRole === "verify"
          ? "Waiting for execution slices to complete."
          : "Queued for worker claim.",
      diffAdded: 0,
      diffRemoved: 0,
      changedFiles: [],
      steerNotes: [],
    }));

    const agentSnapshotsObj: Record<string, StoredAgentSnapshot> = {};
    for (const [id, snap] of agentSnapshotsMap.entries()) {
      agentSnapshotsObj[id] = snap;
    }

    const itemOwnerUserId = caller.kind === "human" ? caller.userId : caller.ownerUserId;

    // 建单幂等快路径：若客户端携带 opKey 重试且工单已落盘，直接返回既有快照
    if (body.opKey !== undefined) {
      const existingByOpKey = await this.repo.findHydratedWorkItemByOwnerOpKey(
        itemOwnerUserId,
        body.opKey,
      );
      if (existingByOpKey) {
        return serializeWorkItemForViewer(existingByOpKey, caller);
      }
    }

    let txResult: {
      readonly hydrated: HydratedWorkItemRecord;
      readonly anchorMessage: HydratedRawMessageRecord | undefined;
    };
    try {
      txResult = await this.repo.runInTransaction(async (txRepo) => {
        let anchorMessage: HydratedRawMessageRecord | undefined;
        let anchorSeq = 0;

        if (body.roomId !== undefined) {
          // 全局锁顺序第 1 级：先锁 rooms 分配消息序号，再写 work_items
          const lockedRoom = await txRepo.lockRoomBasicForUpdate(body.roomId);
          if (!lockedRoom) {
            throw new AppError({
              code: "NOT_FOUND",
              statusCode: 404,
              message: `Room ${body.roomId} not found.`,
            });
          }
          const nextSeq = asMessageSeq(lockedRoom.lastSeq + 1);
          anchorSeq = nextSeq;
          anchorMessage = await txRepo.appendRoomMilestoneUnderLock({
            roomId: body.roomId,
            nextSeq,
            memberKey: callerMemberKey,
            caller,
            type: "text",
            content: `⚡ **[Work Dispatched]** ${title} (\`${body.topology}\` · workspace \`${workspace.name}\`)`,
            payloadJson: {
              workItemId,
              workspaceId: workspace.id,
              topology: body.topology,
            },
          });
        }

        const dispatchTrace = buildTraceEntry({
          nowMs: this.nowFn(),
          actorName: caller.displayName,
          kind: "handoff",
          message: `已创建任务并进入执行队列（${body.topology} · ${initialSlices.length} 个分片）`,
        });

        await txRepo.insertWorkItemWithSlices({
          id: workItemId,
          workspaceId: workspace.id,
          ownerUserId: itemOwnerUserId,
          roomId: body.roomId,
          anchorMessageSeq: anchorSeq,
          title,
          brief: scrubbedBrief,
          topology: body.topology,
          tier: body.tier,
          stage: "working",
          worktreeBranch,
          coordinatorAgentId: body.coordinatorAgentId,
          primaryWorkerAgentId: body.primaryWorkerAgentId,
          verifierAgentId: effectiveVerifierId,
          opKey: body.opKey,
          agentSnapshots: agentSnapshotsObj,
          slices: initialSlices,
          initialTrace: [dispatchTrace],
        });

        const hydrated = await txRepo.findHydratedWorkItemById(workItemId);
        if (!hydrated) {
          throw new Error(`Failed to hydrate newly created work item ${workItemId}.`);
        }
        return { hydrated, anchorMessage };
      });
    } catch (err) {
      if (body.opKey !== undefined && isUniqueConstraintError(err)) {
        const racedExisting = await this.repo.findHydratedWorkItemByOwnerOpKey(
          itemOwnerUserId,
          body.opKey,
        );
        if (racedExisting) {
          return serializeWorkItemForViewer(racedExisting, caller);
        }
      }
      throw err;
    }

    const initialWakeAgents = [
      ...new Set(
        initialSlices.filter((s) => s.leaseRole !== "verify").map((s) => s.assignedAgentId),
      ),
    ];

    await this.fanOutPostCommitSignals({
      item: txResult.hydrated,
      roomMilestoneMessage: txResult.anchorMessage,
      wakeAgentIds: initialWakeAgents,
      actorCaller: caller,
    });

    return serializeWorkItemForViewer(txResult.hydrated, caller);
  }

  /**
   * Agent 认领待执行分片或接管已超时的僵尸租约（返回递增后的 `leaseVersion` 防护版本号）。
   */
  public async claimSlice(
    caller: Readonly<AuthenticatedCaller>,
    workItemId: WorkItemId,
    sliceId: WorkSliceId,
    body: Readonly<ClaimWorkSliceBody>,
  ): Promise<ClaimWorkSliceResponse> {
    const agentCaller = this.assertAgentCaller(caller);
    const nowMs = this.nowFn();

    const updated = await this.repo.runInTransaction(async (txRepo) => {
      const locked = await txRepo.lockWorkItemForUpdate(workItemId);
      if (!locked) {
        throw new AppError({
          code: "NOT_FOUND",
          statusCode: 404,
          message: `Work item ${workItemId} not found.`,
        });
      }

      const item = await txRepo.findHydratedWorkItemById(workItemId);
      if (!item) {
        throw new AppError({
          code: "NOT_FOUND",
          statusCode: 404,
          message: `Work item ${workItemId} not found.`,
        });
      }

      const targetSlice = item.slices.find((s) => s.sliceId === sliceId);
      if (!targetSlice) {
        throw new AppError({
          code: "NOT_FOUND",
          statusCode: 404,
          message: `Slice ${sliceId} not found in work item ${workItemId}.`,
        });
      }

      const isRoomMember =
        item.roomId === undefined
          ? true
          : await txRepo.isMemberInRoom(item.roomId, toActorMemberKey(agentCaller));

      if (item.roomId !== undefined && !isRoomMember) {
        throw new AppError({
          code: "FORBIDDEN_NOT_ROOM_MEMBER",
          statusCode: 403,
          message: "Agent must be a member of the room to claim its work slices.",
        });
      }

      const access = evaluateWorkspaceExecutionAccess({
        workspaceOwnerUserId: item.workspaceOwnerUserId,
        hostMode: item.workspaceHostMode,
        sandboxMode: item.workspaceSandboxMode,
        allowRoomCollaborators: item.workspaceAllowRoomCollaborators,
        agentOwnerUserId: agentCaller.ownerUserId,
        isRoomMember,
        requestedRole: targetSlice.leaseRole,
        requestedTier: item.tier,
      });
      if (!access.ok) {
        throw toAppError(access);
      }

      const canTakeOverPeer =
        agentCaller.ownerUserId === item.workspaceOwnerUserId ||
        (item.workspaceHostMode === "shared_container" &&
          item.workspaceAllowRoomCollaborators &&
          isRoomMember);

      const claimDecision = evaluateSliceClaim({
        itemStage: item.stage,
        slice: targetSlice,
        callerAgentId: agentCaller.agentId,
        canTakeOverExpiredPeerSlice: canTakeOverPeer,
        leaseTtlMs: body.leaseTtlMs,
        nowMs,
      });
      if (!claimDecision.ok) {
        throw toAppError(claimDecision);
      }

      if (
        body.expectedLeaseVersion !== undefined &&
        (body.expectedLeaseVersion !== targetSlice.leaseVersion || claimDecision.idempotentReplay)
      ) {
        throw new AppError({
          code: "WORK_LEASE_EXPIRED",
          statusCode: 409,
          message: "Another listener has already claimed this slice generation.",
        });
      }

      const nextSlice: OrchestrationSliceState =
        body.agentEnvironment !== undefined
          ? {
              ...claimDecision.nextSlice,
              liveSummary: `${claimDecision.nextSlice.liveSummary} [${scrubWorkText(body.agentEnvironment)}]`,
            }
          : claimDecision.nextSlice;

      const nextSnapshots = { ...item.agentSnapshots };
      if (!nextSnapshots[agentCaller.agentId]) {
        const freshMap = await txRepo.findAgentSnapshotsByIds([agentCaller.agentId]);
        const fresh = freshMap.get(agentCaller.agentId);
        if (fresh) {
          nextSnapshots[agentCaller.agentId] = fresh;
        }
      }

      const nextSlices = item.slices.map((s) => (s.sliceId === sliceId ? nextSlice : s));
      const claimTrace = claimDecision.idempotentReplay
        ? undefined
        : buildTraceEntry({
            nowMs,
            actorName: agentCaller.displayName,
            kind: "lease",
            message: `已认领分片「${targetSlice.title}」（租约 v${String(nextSlice.leaseVersion)}）`,
            ...(body.agentEnvironment !== undefined ? { detail: body.agentEnvironment } : {}),
            sliceId,
          });

      await txRepo.persistWorkItemState({
        workItemId,
        nextStage: item.stage,
        nextSlices,
        nextAttention: item.attention ?? null,
        nextReview: item.review ?? null,
        ...(claimTrace !== undefined ? { nextTrace: [...item.trace, claimTrace] } : {}),
        nextAgentSnapshots: nextSnapshots,
        dirtySliceIds: new Set([sliceId]),
      });

      const refreshed = await txRepo.findHydratedWorkItemById(workItemId);
      if (!refreshed) {
        throw new Error(`Failed to reload work item ${workItemId} after slice claim.`);
      }
      return { refreshed, idempotentReplay: claimDecision.idempotentReplay, claimTrace };
    });

    if (updated.claimTrace !== undefined) {
      await this.publishTraceEvents(updated.refreshed, [updated.claimTrace]);
    }

    await this.fanOutPostCommitSignals({
      item: updated.refreshed,
      wakeAgentIds: [],
      actorCaller: caller,
      notifyParticipantAgents: !updated.idempotentReplay,
    });

    const dto = serializeWorkItemForViewer(updated.refreshed, caller);
    const claimedSlice = dto.slices.find((s) => s.sliceId === sliceId);
    if (!claimedSlice) {
      throw new Error(`Claimed slice ${sliceId} missing from serialized DTO.`);
    }
    return { ok: true, item: dto, claimedSlice };
  }

  /**
   * 持有有效防护版本号的 Agent 续期租约并上报瞬态进度摘要（单行 CAS 免跨片锁竞争）。
   */
  public async heartbeatSlice(
    caller: Readonly<AuthenticatedCaller>,
    workItemId: WorkItemId,
    sliceId: WorkSliceId,
    body: Readonly<HeartbeatWorkSliceBody>,
  ): Promise<WorkItemDto> {
    const agentCaller = this.assertAgentCaller(caller);
    const nowMs = this.nowFn();
    const ttlMs = body.leaseTtlMs ?? DEFAULT_SLICE_LEASE_TTL_MS;
    const scrubbedSummary =
      body.liveSummary !== undefined ? scrubWorkText(body.liveSummary) : undefined;
    const heartbeatTraceEntries = (body.traceEntries ?? []).map((entry) =>
      buildTraceEntry({
        nowMs,
        actorName: agentCaller.displayName,
        kind: entry.kind,
        message: entry.message,
        detail: entry.detail,
        sliceId,
      }),
    );

    const renewed = await this.repo.renewSliceHeartbeatCas({
      workItemId,
      sliceId,
      callerAgentId: agentCaller.agentId,
      leaseVersion: body.leaseVersion,
      nowMs,
      nextExpiresAtMs: nowMs + ttlMs,
      liveSummary: scrubbedSummary,
      diffAdded: body.diffAdded,
      diffRemoved: body.diffRemoved,
      ...(heartbeatTraceEntries.length > 0 ? { traceEntries: heartbeatTraceEntries } : {}),
    });

    if (!renewed) {
      const existing = await this.repo.findHydratedWorkItemById(workItemId);
      if (!existing) {
        throw new AppError({
          code: "NOT_FOUND",
          statusCode: 404,
          message: `Work item ${workItemId} not found.`,
        });
      }
      this.mustFindSlice(existing, sliceId);
      throw new AppError({
        code: "WORK_LEASE_EXPIRED",
        statusCode: 409,
        message: "Stale leaseVersion or expired slice lease; re-claim required.",
      });
    }

    const updated = await this.mustFindWorkItem(workItemId);
    if (heartbeatTraceEntries.length > 0) {
      await this.publishTraceEvents(updated, heartbeatTraceEntries, {
        sliceId,
        liveSummary: scrubbedSummary,
        diffAdded: body.diffAdded,
        diffRemoved: body.diffRemoved,
      });
    }
    await this.fanOutPostCommitSignals({
      item: updated,
      wakeAgentIds: [],
      actorCaller: caller,
      // 瞬态心跳仅刷新人类 UI 与房间视图，避免对蜂群内所有兄弟 Agent 产生 N 倍 pg_notify 写放大
      notifyParticipantAgents: false,
    });
    return serializeWorkItemForViewer(updated, caller);
  }

  /**
   * 实时追加一条执行追踪事件（命令启动、标准输出摘要、沙盒准备、代码变更增量），并立即通过 `work.trace` SSE 推送给前端。
   */
  public async appendLiveTrace(params: {
    readonly workItemId: WorkItemId;
    readonly sliceId?: WorkSliceId | undefined;
    readonly actorName: string;
    readonly kind: WorkTraceKind;
    readonly message: string;
    readonly detail?: string | undefined;
    readonly liveSummary?: string | undefined;
    readonly diffAdded?: number | undefined;
    readonly diffRemoved?: number | undefined;
  }): Promise<WorkTraceEntry | undefined> {
    const nowMs = this.nowFn();
    const entry = buildTraceEntry({
      nowMs,
      actorName: params.actorName,
      kind: params.kind,
      message: params.message,
      detail: params.detail,
      sliceId: params.sliceId,
    });
    const scrubbedLiveSummary =
      params.liveSummary !== undefined ? scrubWorkText(params.liveSummary) : undefined;

    const targetMeta = await this.repo.appendWorkItemTraceEntries({
      workItemId: params.workItemId,
      entries: [entry],
      sliceId: params.sliceId,
      liveSummary: scrubbedLiveSummary,
      diffAdded: params.diffAdded,
      diffRemoved: params.diffRemoved,
      nowIso: entry.timestampIso,
    });
    if (!targetMeta) {
      return undefined;
    }

    const traceEvent: SseEvent = {
      type: "work.trace",
      workItemId: params.workItemId,
      workspaceId: targetMeta.workspaceId,
      ...(targetMeta.roomId !== undefined ? { roomId: targetMeta.roomId } : {}),
      ...(params.sliceId !== undefined ? { sliceId: params.sliceId } : {}),
      ...(scrubbedLiveSummary !== undefined ? { liveSummary: scrubbedLiveSummary } : {}),
      ...(params.diffAdded !== undefined ? { diffAdded: params.diffAdded } : {}),
      ...(params.diffRemoved !== undefined ? { diffRemoved: params.diffRemoved } : {}),
      entry,
    };

    const tasks: Array<Promise<void>> = [
      this.realtimeBus.publishToUser(targetMeta.ownerUserId, traceEvent),
    ];
    if (targetMeta.workspaceOwnerUserId !== targetMeta.ownerUserId) {
      tasks.push(this.realtimeBus.publishToUser(targetMeta.workspaceOwnerUserId, traceEvent));
    }
    if (targetMeta.roomId !== undefined) {
      tasks.push(this.realtimeBus.publishToRoom(targetMeta.roomId, traceEvent));
    }
    await this.settleRealtimePublishes(tasks, "work.trace");
    return entry;
  }

  /**
   * Agent 主动暂停分片并向人类主人发起单问澄清（释放租约过期倒计时，等待人类回答后自动唤醒）。
   */
  public async raiseAttention(
    caller: Readonly<AuthenticatedCaller>,
    workItemId: WorkItemId,
    sliceId: WorkSliceId,
    body: Readonly<RaiseWorkAttentionBody>,
  ): Promise<WorkItemDto> {
    const agentCaller = this.assertAgentCaller(caller);
    const nowMs = this.nowFn();

    const updated = await this.repo.runInTransaction(async (txRepo) => {
      const item = await this.lockAndLoadWorkItem(txRepo, workItemId);
      const targetSlice = this.mustFindSlice(item, sliceId);

      const decision = evaluateRaiseSliceAttention({
        itemStage: item.stage,
        slice: targetSlice,
        callerAgentId: agentCaller.agentId,
        leaseVersion: body.leaseVersion,
        question: body.question,
        nowMs,
      });
      if (!decision.ok) {
        throw toAppError(decision);
      }

      const nextAttention: StoredAttentionRecord = {
        sliceId,
        question: decision.scrubbedQuestion,
        askedByAgentId: agentCaller.agentId,
        options: body.options.map((opt) => scrubWorkText(opt)),
        askedAtMs: nowMs,
      };
      const nextSlices = item.slices.map((s) => (s.sliceId === sliceId ? decision.nextSlice : s));
      const attentionTrace = buildTraceEntry({
        nowMs,
        actorName: agentCaller.displayName,
        kind: "handoff",
        message: `暂停等待人工确认：${decision.scrubbedQuestion}`,
        sliceId,
      });

      await txRepo.persistWorkItemState({
        workItemId,
        nextStage: decision.nextStage,
        nextSlices,
        nextAttention,
        nextReview: item.review ?? null,
        nextTrace: [...item.trace, attentionTrace],
        dirtySliceIds: new Set([sliceId]),
      });

      const reloaded = await this.mustReloadWorkItem(txRepo, workItemId);
      return { reloaded, attentionTrace };
    });

    await this.publishTraceEvents(updated.reloaded, [updated.attentionTrace]);
    await this.fanOutPostCommitSignals({
      item: updated.reloaded,
      wakeAgentIds: [],
      actorCaller: caller,
    });
    return serializeWorkItemForViewer(updated.reloaded, caller);
  }

  /**
   * Agent 提交分片完成回执或核验结论（支持网络超时幂等重试，自动驱动蜂群合流与 `write -> verify` 唤醒交接）。
   */
  public async completeSlice(
    caller: Readonly<AuthenticatedCaller>,
    workItemId: WorkItemId,
    sliceId: WorkSliceId,
    body: Readonly<CompleteWorkSliceBody>,
  ): Promise<WorkItemDto> {
    const agentCaller = this.assertAgentCaller(caller);
    const nowMs = this.nowFn();

    const txOutcome = await this.repo.runInTransaction(async (txRepo) => {
      const item = await this.lockAndLoadWorkItem(txRepo, workItemId);
      const targetSlice = this.mustFindSlice(item, sliceId);

      const completion = evaluateSliceCompletion({
        item: toOrchestrationItemState(item),
        targetSliceId: sliceId,
        callerAgentId: agentCaller.agentId,
        leaseVersion: body.leaseVersion,
        summary: body.summary,
        changedFiles: body.changedFiles,
        diffAdded: body.diffAdded,
        diffRemoved: body.diffRemoved,
        worktreeBranch: body.worktreeBranch,
        testCommand: body.testCommand,
        testPassed: body.testPassed,
        verdict: body.verdict,
        provenance: body.provenance,
        nowMs,
      });
      if (!completion.ok) {
        throw toAppError(completion);
      }

      if (completion.idempotentReplay === true) {
        return {
          item,
          wakeAgentIds: [] as readonly AgentId[],
          traceEntries: [] as readonly WorkTraceEntry[],
          idempotentReplay: true,
        };
      }

      const extraTrace = (body.traceEntries ?? []).map((entry) =>
        buildTraceEntry({
          nowMs,
          actorName: agentCaller.displayName,
          kind: entry.kind,
          message: entry.message,
          detail: entry.detail,
          sliceId,
        }),
      );
      const completionTrace = buildTraceEntry({
        nowMs,
        actorName: agentCaller.displayName,
        kind: targetSlice.leaseRole === "verify" ? "review" : "handoff",
        message:
          targetSlice.leaseRole === "verify"
            ? body.verdict === "changes_requested"
              ? `复核未通过，打回修复：${body.summary}`
              : `复核通过，等待人工签收：${body.summary}`
            : `已完成分片「${targetSlice.title}」：${body.summary}`,
        sliceId,
      });
      const addedTraces = [...extraTrace, completionTrace];
      const nextDiffFiles =
        body.diffFiles !== undefined
          ? mergeDiffFilesByPath(item.diffFiles, body.diffFiles)
          : undefined;

      const singleSliceOnly =
        completion.nextStage === item.stage && completion.wakeAgentIds.length === 0;

      await txRepo.persistWorkItemState({
        workItemId,
        nextStage: completion.nextStage,
        nextSlices: completion.nextSlices,
        nextAttention:
          item.attention?.answeredChoice !== undefined ? null : (item.attention ?? null),
        nextReview: completion.nextReview ?? null,
        nextTrace: [...item.trace, ...addedTraces],
        ...(nextDiffFiles !== undefined ? { nextDiffFiles } : {}),
        ...(singleSliceOnly ? { dirtySliceIds: new Set([sliceId]) } : {}),
      });

      const reloaded = await this.mustReloadWorkItem(txRepo, workItemId);
      return {
        item: reloaded,
        wakeAgentIds: completion.wakeAgentIds,
        traceEntries: addedTraces,
        idempotentReplay: false,
      };
    });

    if (!txOutcome.idempotentReplay) {
      if (txOutcome.traceEntries.length > 0) {
        await this.publishTraceEvents(txOutcome.item, txOutcome.traceEntries, { sliceId });
      }
      await this.fanOutPostCommitSignals({
        item: txOutcome.item,
        wakeAgentIds: txOutcome.wakeAgentIds,
        actorCaller: caller,
      });
    }
    return serializeWorkItemForViewer(txOutcome.item, caller);
  }

  /**
   * 人类主人向正在执行或排队的分片实时注入补充指令（Steer），并唤醒对应执行 Agent。
   */
  public async steerWorkItem(
    caller: Readonly<AuthenticatedCaller>,
    workItemId: WorkItemId,
    body: Readonly<SteerWorkItemBody>,
  ): Promise<WorkItemDto> {
    const human = assertHumanCaller(caller);
    const scrubbedNote = scrubWorkText(body.note);

    const txOutcome = await this.repo.runInTransaction(async (txRepo) => {
      const item = await this.lockAndLoadWorkItem(txRepo, workItemId);
      await this.assertHumanControlAuthority(txRepo, item, human.userId);

      if (item.stage === "done" || item.stage === "cancelled") {
        throw new AppError({
          code: "WORK_INVALID_TRANSITION",
          statusCode: 409,
          message: `Cannot steer a ${item.stage} work item.`,
        });
      }

      const wakeSet = new Set<AgentId>();
      let matched = false;
      const nextSlices = item.slices.map((s) => {
        const shouldSteer =
          body.sliceId !== undefined ? s.sliceId === body.sliceId : s.leaseRole !== "verify";
        if (!shouldSteer) {
          return s;
        }
        matched = true;
        wakeSet.add(s.assignedAgentId);
        return {
          ...s,
          steerNotes: [...s.steerNotes, scrubbedNote],
        };
      });

      if (!matched) {
        throw new AppError({
          code: "NOT_FOUND",
          statusCode: 404,
          message: "Target slice for steering was not found.",
        });
      }

      const steerTrace = buildTraceEntry({
        nowMs: this.nowFn(),
        actorName: human.displayName,
        kind: "steer",
        message: `追加补充指令：${scrubbedNote}`,
        sliceId: body.sliceId,
      });

      await txRepo.persistWorkItemState({
        workItemId,
        nextStage: item.stage,
        nextSlices,
        nextAttention: item.attention ?? null,
        nextReview: item.review ?? null,
        nextTrace: [...item.trace, steerTrace],
      });

      const reloaded = await this.mustReloadWorkItem(txRepo, workItemId);
      return { item: reloaded, wakeAgentIds: [...wakeSet], steerTrace };
    });

    await this.publishTraceEvents(txOutcome.item, [txOutcome.steerTrace]);
    await this.fanOutPostCommitSignals({
      item: txOutcome.item,
      wakeAgentIds: txOutcome.wakeAgentIds,
      actorCaller: caller,
    });
    return serializeWorkItemForViewer(txOutcome.item, caller);
  }

  /**
   * 人类主人回答 Agent 的单问澄清，恢复工单执行态并定向唤醒提问 Agent。
   */
  public async answerAttention(
    caller: Readonly<AuthenticatedCaller>,
    workItemId: WorkItemId,
    body: Readonly<AnswerWorkAttentionBody>,
  ): Promise<WorkItemDto> {
    const human = assertHumanCaller(caller);
    const nowMs = this.nowFn();
    const scrubbedChoice = scrubWorkText(body.choice);

    const txOutcome = await this.repo.runInTransaction(async (txRepo) => {
      const item = await this.lockAndLoadWorkItem(txRepo, workItemId);
      await this.assertHumanControlAuthority(txRepo, item, human.userId);

      if (item.stage !== "awaiting_answer" || item.attention === undefined) {
        throw new AppError({
          code: "WORK_INVALID_TRANSITION",
          statusCode: 409,
          message: "Work item does not have a pending attention prompt.",
        });
      }

      const attention = item.attention;
      const pausedSlice = item.slices.find((s) => s.sliceId === attention.sliceId);
      const resumedStage = pausedSlice?.leaseRole === "verify" ? "verifying" : "working";

      const nextAttention: StoredAttentionRecord = {
        ...attention,
        answeredChoice: scrubbedChoice,
        answeredAtMs: nowMs,
      };

      const nextSlices = item.slices.map((s) => {
        if (s.sliceId !== attention.sliceId) {
          return s;
        }
        const { leaseOwnerAgentId: _owner, leaseExpiresAtMs: _exp, ...rest } = s;
        return {
          ...rest,
          status: "waiting" as const,
          liveSummary: `Human answered: ${scrubbedChoice}`,
          steerNotes: [
            ...s.steerNotes,
            `[Clarification] ${attention.question} -> ${scrubbedChoice}`,
          ],
        };
      });

      const answerTrace = buildTraceEntry({
        nowMs,
        actorName: human.displayName,
        kind: "steer",
        message: `已回复澄清问题「${attention.question}」：${scrubbedChoice}`,
        sliceId: attention.sliceId,
      });

      await txRepo.persistWorkItemState({
        workItemId,
        nextStage: resumedStage,
        nextSlices,
        nextAttention,
        nextReview: item.review ?? null,
        nextTrace: [...item.trace, answerTrace],
      });

      const reloaded = await this.mustReloadWorkItem(txRepo, workItemId);
      return { item: reloaded, wakeAgentIds: [attention.askedByAgentId], answerTrace };
    });

    await this.publishTraceEvents(txOutcome.item, [txOutcome.answerTrace]);
    await this.fanOutPostCommitSignals({
      item: txOutcome.item,
      wakeAgentIds: txOutcome.wakeAgentIds,
      actorCaller: caller,
    });
    return serializeWorkItemForViewer(txOutcome.item, caller);
  }

  /**
   * 人类主人对处于 `awaiting_review`（或 `blocked`）的工单执行最终签收或打回重做（ADR-0002 刚性人类门禁）。
   */
  public async decideReview(
    caller: Readonly<AuthenticatedCaller>,
    workItemId: WorkItemId,
    body: Readonly<DecideWorkReviewBody>,
  ): Promise<WorkItemDto> {
    const human = assertHumanCaller(caller);
    const nowMs = this.nowFn();
    const preRead = await this.mustFindWorkItem(workItemId);

    const txOutcome = await this.repo.runInTransaction(async (txRepo) => {
      // 严守全局锁顺序：若工单绑定了房间且将写入签收里程碑，必须先锁 rooms 再锁 work_items
      const lockedRoom =
        preRead.roomId !== undefined && body.decision === "approve"
          ? await txRepo.lockRoomBasicForUpdate(preRead.roomId)
          : undefined;

      const item = await this.lockAndLoadWorkItem(txRepo, workItemId);
      await this.assertHumanControlAuthority(txRepo, item, human.userId);

      const decision = evaluateHumanReviewDecision({
        item: toOrchestrationItemState(item),
        reviewerUserId: human.userId,
        decision: body.decision,
        note: body.note,
        nowMs,
      });
      if (!decision.ok) {
        throw toAppError(decision);
      }

      let milestoneMessage: HydratedRawMessageRecord | undefined;
      if (body.decision === "approve" && item.roomId !== undefined && lockedRoom !== undefined) {
        const nextSeq = asMessageSeq(lockedRoom.lastSeq + 1);
        milestoneMessage = await txRepo.appendRoomMilestoneUnderLock({
          roomId: item.roomId,
          nextSeq,
          memberKey: toActorMemberKey(caller),
          caller,
          type: "decision",
          content: `✅ **[Work Approved]** ${item.title} (${decision.nextReview.filesChanged} files, +${decision.nextReview.additions}/-${decision.nextReview.deletions})`,
          payloadJson: {
            workItemId: item.id,
            decision: "approved",
            worktreeBranch: decision.nextReview.worktreeBranch ?? item.worktreeBranch,
          },
        });
      }

      const reviewTrace = buildTraceEntry({
        nowMs,
        actorName: human.displayName,
        kind: "review",
        message:
          body.decision === "approve"
            ? "人工审核已签收通过"
            : `人工退回修改${body.note ? `：${scrubWorkText(body.note)}` : ""}`,
      });

      await txRepo.persistWorkItemState({
        workItemId,
        nextStage: decision.nextStage,
        nextSlices: decision.nextSlices,
        nextAttention: null,
        nextReview: decision.nextReview,
        nextTrace: [...item.trace, reviewTrace],
      });

      const reloaded = await this.mustReloadWorkItem(txRepo, workItemId);
      return {
        item: reloaded,
        milestoneMessage,
        wakeAgentIds: decision.wakeAgentIds,
        reviewTrace,
      };
    });

    await this.publishTraceEvents(txOutcome.item, [txOutcome.reviewTrace]);
    await this.fanOutPostCommitSignals({
      item: txOutcome.item,
      roomMilestoneMessage: txOutcome.milestoneMessage,
      wakeAgentIds: txOutcome.wakeAgentIds,
      actorCaller: caller,
    });
    return serializeWorkItemForViewer(txOutcome.item, caller);
  }

  /**
   * 人类主人执行工单级运行控制：急停取消（`stop`）、重置重试（`retry`）或将个人工单升级挂载到群聊房间（`escalate_room`）。
   */
  public async controlWorkItem(
    caller: Readonly<AuthenticatedCaller>,
    workItemId: WorkItemId,
    body: Readonly<ControlWorkItemBody>,
  ): Promise<WorkItemDto> {
    const human = assertHumanCaller(caller);

    if (body.action === "escalate_room" && body.targetRoomId === undefined) {
      throw new AppError({
        code: "VALIDATION_ERROR",
        statusCode: 400,
        message: "escalate_room requires targetRoomId.",
      });
    }

    if (body.action === "escalate_room" && body.targetRoomId !== undefined) {
      await this.assertRoomMemberAccess(body.targetRoomId, caller);
    }

    const txOutcome = await this.repo.runInTransaction(async (txRepo) => {
      const lockedRoom =
        body.action === "escalate_room" && body.targetRoomId !== undefined
          ? await txRepo.lockRoomBasicForUpdate(body.targetRoomId)
          : undefined;

      const item = await this.lockAndLoadWorkItem(txRepo, workItemId);
      await this.assertHumanControlAuthority(txRepo, item, human.userId);

      if (body.action === "stop") {
        const stoppedSlices = item.slices.map((s) => {
          if (s.status === "ready") return s;
          const { leaseOwnerAgentId: _owner, leaseExpiresAtMs: _exp, ...rest } = s;
          return {
            ...rest,
            status: "blocked" as const,
            failureCode: "STOPPED_BY_OWNER",
            liveSummary: "Stopped by human owner.",
          };
        });

        const stopTrace = buildTraceEntry({
          nowMs: this.nowFn(),
          actorName: human.displayName,
          kind: "steer",
          message: "人工手动停止了任务执行",
        });

        await txRepo.persistWorkItemState({
          workItemId,
          nextStage: "cancelled",
          nextSlices: stoppedSlices,
          nextAttention: null,
          nextReview: item.review ?? null,
          nextTrace: [...item.trace, stopTrace],
        });
        const reloaded = await this.mustReloadWorkItem(txRepo, workItemId);
        return {
          item: reloaded,
          wakeAgentIds: [] as readonly AgentId[],
          milestoneMessage: undefined,
          controlTrace: stopTrace,
        };
      }

      if (body.action === "retry") {
        const wakeSet = new Set<AgentId>();
        const retriedSlices = item.slices.map((s) => {
          if (s.status === "ready" && item.stage !== "cancelled") {
            return s;
          }
          if (s.leaseRole !== "verify") {
            wakeSet.add(s.assignedAgentId);
          }
          const {
            leaseOwnerAgentId: _owner,
            leaseExpiresAtMs: _exp,
            completedAtMs: _done,
            failureCode: _fail,
            ...rest
          } = s;
          return {
            ...rest,
            status: "waiting" as const,
            attemptCount: 0,
            liveSummary: "Reset for retry by human owner.",
          };
        });
        const retryTrace = buildTraceEntry({
          nowMs: this.nowFn(),
          actorName: human.displayName,
          kind: "handoff",
          message: "已重置失败/取消状态并重新加入执行队列",
        });

        await txRepo.persistWorkItemState({
          workItemId,
          nextStage: "working",
          nextSlices: retriedSlices,
          nextAttention: null,
          nextReview: item.review ?? null,
          nextTrace: [...item.trace, retryTrace],
        });
        const reloaded = await this.mustReloadWorkItem(txRepo, workItemId);
        return {
          item: reloaded,
          wakeAgentIds: [...wakeSet],
          milestoneMessage: undefined,
          controlTrace: retryTrace,
        };
      }

      // escalate_room：将工单锚定至目标房间并写入一条时间线锚点消息
      if (!lockedRoom || body.targetRoomId === undefined) {
        throw new AppError({
          code: "NOT_FOUND",
          statusCode: 404,
          message: "Target room for escalation was not found.",
        });
      }
      const nextSeq = asMessageSeq(lockedRoom.lastSeq + 1);
      const milestoneMessage = await txRepo.appendRoomMilestoneUnderLock({
        roomId: body.targetRoomId,
        nextSeq,
        memberKey: toActorMemberKey(caller),
        caller,
        type: "text",
        content: `↗ **[Work Escalated to Room]** ${item.title} (\`${item.stage}\`)`,
        payloadJson: {
          workItemId: item.id,
          workspaceId: item.workspaceId,
        },
      });
      const escalateTrace = buildTraceEntry({
        nowMs: this.nowFn(),
        actorName: human.displayName,
        kind: "handoff",
        message: "已将任务关联同步至群聊协同",
      });

      await txRepo.persistWorkItemState({
        workItemId,
        nextStage: item.stage,
        nextSlices: item.slices,
        nextAttention: item.attention ?? null,
        nextReview: item.review ?? null,
        nextTrace: [...item.trace, escalateTrace],
        roomAttachment: { roomId: body.targetRoomId, anchorSeq: nextSeq },
      });

      const reloaded = await this.mustReloadWorkItem(txRepo, workItemId);
      return {
        item: reloaded,
        wakeAgentIds: [] as readonly AgentId[],
        milestoneMessage,
        controlTrace: escalateTrace,
      };
    });

    await this.publishTraceEvents(txOutcome.item, [txOutcome.controlTrace]);
    await this.fanOutPostCommitSignals({
      item: txOutcome.item,
      roomMilestoneMessage: txOutcome.milestoneMessage,
      wakeAgentIds: txOutcome.wakeAgentIds,
      actorCaller: caller,
    });
    return serializeWorkItemForViewer(txOutcome.item, caller);
  }

  /**
   * 扫描并自愈回收已超时的活跃分片租约（`FOR UPDATE SKIP LOCKED` 多实例并发安全）：
   * - 未达最大尝试次数时退回 `waiting` 并唤醒接替执行器；
   * - 达到 `MAX_SLICE_ATTEMPTS` 上限时标记为 `blocked` 并告警人类主人介入。
   */
  public async sweepExpiredLeases(batchLimit = 32): Promise<LeaseSweepSummary> {
    const nowMs = this.nowFn();

    const txResult = await this.repo.runInTransaction(async (txRepo) => {
      const candidates = await txRepo.lockExpiredActiveSlicesSkipLocked(nowMs, batchLimit);
      if (candidates.length === 0) {
        return {
          scannedCount: 0,
          reclaimedCount: 0,
          blockedCount: 0,
          affected: [] as Array<{
            readonly item: HydratedWorkItemRecord;
            readonly wakeAgentIds: readonly AgentId[];
          }>,
        };
      }

      // 按 workItemId 字典序分组加锁，杜绝两个并发巡检批次按相反顺序锁定同一对工单引发死锁
      const sliceIdsByItem = new Map<WorkItemId, Set<WorkSliceId>>();
      for (const c of candidates) {
        let bucket = sliceIdsByItem.get(c.workItemId);
        if (!bucket) {
          bucket = new Set();
          sliceIdsByItem.set(c.workItemId, bucket);
        }
        bucket.add(c.sliceId);
      }

      const sortedItemIds = [...sliceIdsByItem.keys()].sort();
      let reclaimedCount = 0;
      let blockedCount = 0;
      const affected: Array<{
        readonly item: HydratedWorkItemRecord;
        readonly wakeAgentIds: readonly AgentId[];
      }> = [];

      for (const itemId of sortedItemIds) {
        const locked = await txRepo.lockWorkItemForUpdate(itemId);
        if (!locked) continue;
        const item = await txRepo.findHydratedWorkItemById(itemId);
        if (!item || (item.stage !== "working" && item.stage !== "verifying")) {
          continue;
        }

        const dirtySet = new Set<WorkSliceId>();
        const wakeSet = new Set<AgentId>();
        let hasExhaustedSlice = false;

        const nextSlices = item.slices.map((s) => {
          const isExpired =
            (s.status === "running" || s.status === "verifying") &&
            s.leaseExpiresAtMs !== undefined &&
            s.leaseExpiresAtMs <= nowMs;
          if (!isExpired) {
            return s;
          }

          dirtySet.add(s.sliceId);
          const { leaseOwnerAgentId: _owner, leaseExpiresAtMs: _exp, ...rest } = s;

          if (s.attemptCount >= MAX_SLICE_ATTEMPTS) {
            blockedCount += 1;
            hasExhaustedSlice = true;
            return {
              ...rest,
              status: "blocked" as const,
              failureCode: "LEASE_EXPIRED_MAX_ATTEMPTS",
              liveSummary: `Lease expired after ${s.attemptCount} attempts; awaiting human intervention.`,
            };
          }

          reclaimedCount += 1;
          wakeSet.add(s.assignedAgentId);
          return {
            ...rest,
            status: "waiting" as const,
            liveSummary: `Lease expired on attempt #${s.attemptCount}; returned to queue for recovery.`,
          };
        });

        if (dirtySet.size === 0) {
          continue;
        }

        const nextStage = hasExhaustedSlice ? "blocked" : item.stage;
        await txRepo.persistWorkItemState({
          workItemId: itemId,
          nextStage,
          nextSlices,
          nextAttention: item.attention ?? null,
          nextReview: item.review ?? null,
          dirtySliceIds: dirtySet,
        });

        const reloaded = await this.mustReloadWorkItem(txRepo, itemId);
        if (!hasExhaustedSlice && reloaded.roomId !== undefined) {
          const ownerSiblingIds = await txRepo.listAgentIdsByOwner(reloaded.workspaceOwnerUserId);
          const roomPresent = await txRepo.listPresentAgentIdsInRoom(
            reloaded.roomId,
            ownerSiblingIds,
          );
          for (const sibId of roomPresent) {
            wakeSet.add(sibId);
          }
        }
        affected.push({ item: reloaded, wakeAgentIds: [...wakeSet] });
      }

      return {
        scannedCount: candidates.length,
        reclaimedCount,
        blockedCount,
        affected,
      };
    });

    for (const entry of txResult.affected) {
      await this.fanOutPostCommitSignals({
        item: entry.item,
        wakeAgentIds: entry.wakeAgentIds,
        actorCaller: PUBLIC_NEUTRAL_VIEWER,
      });
    }

    return {
      scannedCount: txResult.scannedCount,
      reclaimedCount: txResult.reclaimedCount,
      blockedCount: txResult.blockedCount,
    };
  }

  private buildSliceSpecs(
    body: Readonly<CreateWorkItemBody>,
    effectiveVerifierId: AgentId | undefined,
  ): readonly CreateWorkSliceSpec[] {
    if (body.slices !== undefined && body.slices.length > 0) {
      const writeCount = body.slices.filter((s) => s.leaseRole === "write").length;
      if (body.topology === "swarm" && writeCount < 2) {
        throw new AppError({
          code: "VALIDATION_ERROR",
          statusCode: 400,
          message: "swarm topology requires at least 2 write slices with disjoint ownedPaths.",
        });
      }

      const hasVerifySlice = body.slices.some((s) => s.leaseRole === "verify");
      if (!hasVerifySlice && effectiveVerifierId !== undefined) {
        return [
          ...body.slices,
          {
            title: "Independent verification",
            assignedAgentId: effectiveVerifierId,
            leaseRole: "verify",
            ownedPaths: ["**"],
          },
        ];
      }
      return body.slices;
    }

    if (body.topology === "swarm") {
      throw new AppError({
        code: "VALIDATION_ERROR",
        statusCode: 400,
        message: "swarm topology requires explicit slices with disjoint ownedPaths.",
      });
    }

    const baseRole = body.tier === "workspace_read" ? ("read" as const) : ("write" as const);
    const primarySlice: CreateWorkSliceSpec = {
      title: deriveWorkTitle(body.title, body.brief),
      assignedAgentId: body.primaryWorkerAgentId,
      leaseRole: baseRole,
      ownedPaths: ["**"],
    };

    if (effectiveVerifierId !== undefined) {
      return [
        primarySlice,
        {
          title: "Independent verification",
          assignedAgentId: effectiveVerifierId,
          leaseRole: "verify",
          ownedPaths: ["**"],
        },
      ];
    }

    return [primarySlice];
  }

  private assertAgentCaller(
    caller: Readonly<AuthenticatedCaller>,
  ): Extract<AuthenticatedCaller, { readonly kind: "agent" }> {
    if (caller.kind !== "agent") {
      throw new AppError({
        code: "FORBIDDEN_WORKSPACE_ACCESS",
        statusCode: 403,
        message: "Slice lease operations must be authenticated with an agent token (oh_agt_*).",
      });
    }
    return caller;
  }

  private async assertOwnedAgentIds(
    ownerUserId: UserId,
    candidateIds: readonly (AgentId | undefined)[],
  ): Promise<void> {
    const ids = candidateIds.filter((id): id is AgentId => id !== undefined);
    if (ids.length === 0) {
      return;
    }
    const found = await this.repo.findAgentSnapshotsByIds(ids);
    for (const id of ids) {
      const snap = found.get(id);
      if (!snap) {
        throw new AppError({
          code: "NOT_FOUND",
          statusCode: 404,
          message: `Agent "${id}" not found.`,
        });
      }
      if (snap.ownerUserId !== ownerUserId) {
        throw new AppError({
          code: "FORBIDDEN_NOT_OWNER",
          statusCode: 403,
          message: `Agent "${snap.displayName}" does not belong to you.`,
        });
      }
    }
  }

  private resolveWorkspaceOnline(
    workspace: HydratedWorkspaceRecord,
    ownerAgentIds: readonly AgentId[],
  ): boolean {
    if (workspace.hostMode === "local_machine") {
      if (this.isLoopbackHost) return true;
      const candidates = workspace.defaultWorkerAgentId
        ? [workspace.defaultWorkerAgentId]
        : ownerAgentIds;
      return candidates.some((id) => this.realtimeBus.hasWorkspaceListener(id) === true);
    }
    return (
      workspace.hostMode === "shared_container" ||
      ownerAgentIds.some((id) => this.realtimeBus.getActiveAgentConnectionCount(id) > 0)
    );
  }

  private async ensureDefaultLocalWorkspace(ownerUserId: UserId, rootDir: string): Promise<void> {
    const existingLock = this.autoSeedInFlight.get(ownerUserId);
    if (existingLock !== undefined) {
      await existingLock;
      return;
    }

    const task = (async () => {
      try {
        const current = await this.repo.listWorkspacesByOwner(ownerUserId);
        if (current.length > 0) {
          this.autoSeededOwners.add(ownerUserId);
          return;
        }

        const resolvedRoot = path.resolve(rootDir);
        const inspected = inspectLocalDirectoryDefaults(resolvedRoot);
        const ownerAgents = await this.repo.listAgentIdsByOwner(ownerUserId);
        const defaultWorkerAgentId = ownerAgents[0];
        const defaultVerifierAgentId = ownerAgents[1];

        await this.repo.insertWorkspace({
          id: generateWorkspaceId(),
          ownerUserId,
          name: inspected.name,
          kind: inspected.isGitRepo ? "git_repo" : "folder",
          roots: [
            {
              id: "root_1",
              name: inspected.name,
              localPath: resolvedRoot,
              isGitRepo: inspected.isGitRepo,
              ...(inspected.defaultBranch !== undefined
                ? { defaultBranch: inspected.defaultBranch }
                : {}),
            },
          ],
          hostMode: "local_machine",
          hostLabel: "本机",
          sandboxMode: inspected.isGitRepo ? "worktree_pool" : "in_place",
          allowRoomCollaborators: false,
          prewarmedWorktrees: inspected.isGitRepo ? 2 : 0,
          hooks: {
            ...(inspected.verifyCommand !== undefined
              ? { verifyCommand: inspected.verifyCommand }
              : {}),
            copyEnvGlobs: [".env.local", ".env.development"],
          },
          context: {
            ruleFiles: inspected.ruleFiles.length > 0 ? [...inspected.ruleFiles] : ["CLAUDE.md"],
            skillCount: 0,
            sharedMemoryActive: true,
          },
          defaultTopology: defaultVerifierAgentId !== undefined ? "verify_loop" : "direct",
          ...(defaultWorkerAgentId !== undefined ? { defaultWorkerAgentId } : {}),
          ...(defaultVerifierAgentId !== undefined ? { defaultVerifierAgentId } : {}),
        });
        this.autoSeededOwners.add(ownerUserId);
      } catch (err) {
        this.logger?.warn({ err, ownerUserId }, "Failed to auto-seed default local workspace");
      } finally {
        this.autoSeedInFlight.delete(ownerUserId);
      }
    })();

    this.autoSeedInFlight.set(ownerUserId, task);
    await task;
  }

  private async publishTraceEvents(
    item: Readonly<HydratedWorkItemRecord>,
    entries: readonly WorkTraceEntry[],
    meta?: {
      readonly sliceId?: WorkSliceId | undefined;
      readonly liveSummary?: string | undefined;
      readonly diffAdded?: number | undefined;
      readonly diffRemoved?: number | undefined;
    },
  ): Promise<void> {
    if (entries.length === 0) {
      return;
    }
    const tasks: Array<Promise<void>> = [];
    for (const entry of entries) {
      const event: SseEvent = {
        type: "work.trace",
        workItemId: item.id,
        workspaceId: item.workspaceId,
        ...(item.roomId !== undefined ? { roomId: item.roomId } : {}),
        ...(meta?.sliceId !== undefined
          ? { sliceId: meta.sliceId }
          : entry.sliceId !== undefined
            ? { sliceId: entry.sliceId }
            : {}),
        ...(meta?.liveSummary !== undefined ? { liveSummary: meta.liveSummary } : {}),
        ...(meta?.diffAdded !== undefined ? { diffAdded: meta.diffAdded } : {}),
        ...(meta?.diffRemoved !== undefined ? { diffRemoved: meta.diffRemoved } : {}),
        entry,
      };
      tasks.push(this.realtimeBus.publishToUser(item.ownerUserId, event));
      if (item.workspaceOwnerUserId !== item.ownerUserId) {
        tasks.push(this.realtimeBus.publishToUser(item.workspaceOwnerUserId, event));
      }
      if (item.roomId !== undefined) {
        tasks.push(this.realtimeBus.publishToRoom(item.roomId, event));
      }
    }
    await this.settleRealtimePublishes(tasks, "work.trace");
  }

  private async mustFindWorkspace(workspaceId: WorkspaceId): Promise<HydratedWorkspaceRecord> {
    const ws = await this.repo.findWorkspaceById(workspaceId);
    if (!ws) {
      throw new AppError({
        code: "NOT_FOUND",
        statusCode: 404,
        message: `Workspace ${workspaceId} not found.`,
      });
    }
    return ws;
  }

  private async mustFindWorkItem(workItemId: WorkItemId): Promise<HydratedWorkItemRecord> {
    const item = await this.repo.findHydratedWorkItemById(workItemId);
    if (!item) {
      throw new AppError({
        code: "NOT_FOUND",
        statusCode: 404,
        message: `Work item ${workItemId} not found.`,
      });
    }
    return item;
  }

  private async lockAndLoadWorkItem(
    txRepo: WorkspacesRepository,
    workItemId: WorkItemId,
  ): Promise<HydratedWorkItemRecord> {
    const locked = await txRepo.lockWorkItemForUpdate(workItemId);
    if (!locked) {
      throw new AppError({
        code: "NOT_FOUND",
        statusCode: 404,
        message: `Work item ${workItemId} not found.`,
      });
    }
    return this.mustReloadWorkItem(txRepo, workItemId);
  }

  private async mustReloadWorkItem(
    txRepo: WorkspacesRepository,
    workItemId: WorkItemId,
  ): Promise<HydratedWorkItemRecord> {
    const item = await txRepo.findHydratedWorkItemById(workItemId);
    if (!item) {
      throw new Error(`Work item ${workItemId} disappeared inside transaction.`);
    }
    return item;
  }

  private mustFindSlice(
    item: Readonly<HydratedWorkItemRecord>,
    sliceId: WorkSliceId,
  ): OrchestrationSliceState {
    const slice = item.slices.find((s) => s.sliceId === sliceId);
    if (!slice) {
      throw new AppError({
        code: "NOT_FOUND",
        statusCode: 404,
        message: `Slice ${sliceId} not found in work item ${item.id}.`,
      });
    }
    return slice;
  }

  private async assertRoomMemberAccess(
    roomId: RoomId,
    caller: Readonly<AuthenticatedCaller>,
  ): Promise<void> {
    const room = await this.repo.findRoomBasic(roomId);
    if (!room) {
      throw new AppError({
        code: "NOT_FOUND",
        statusCode: 404,
        message: `Room ${roomId} not found.`,
      });
    }
    const isMember = await this.repo.isMemberInRoom(roomId, toActorMemberKey(caller));
    if (!isMember) {
      throw new AppError({
        code: "FORBIDDEN_NOT_ROOM_MEMBER",
        statusCode: 403,
        message: "Caller is not a member of this room.",
      });
    }
  }

  private async assertWorkspaceReadAccess(
    ws: Readonly<HydratedWorkspaceRecord>,
    caller: Readonly<AuthenticatedCaller>,
  ): Promise<void> {
    if (getViewerOwnerUserId(caller) === ws.ownerUserId) {
      return;
    }
    const boundRooms = await this.repo.listBoundRoomIdsForWorkspace(ws.id);
    if (boundRooms.length > 0) {
      const joined = new Set(await this.repo.listJoinedRoomIds(toActorMemberKey(caller)));
      if (boundRooms.some((roomId) => joined.has(roomId))) {
        return;
      }
    }
    throw new AppError({
      code: "FORBIDDEN_WORKSPACE_ACCESS",
      statusCode: 403,
      message: "You do not have access to this workspace.",
    });
  }

  private async assertWorkItemReadAccess(
    item: Readonly<HydratedWorkItemRecord>,
    caller: Readonly<AuthenticatedCaller>,
  ): Promise<void> {
    const viewerOwnerId = getViewerOwnerUserId(caller);
    if (viewerOwnerId === item.ownerUserId || viewerOwnerId === item.workspaceOwnerUserId) {
      return;
    }
    if (item.roomId !== undefined) {
      const isMember = await this.repo.isMemberInRoom(item.roomId, toActorMemberKey(caller));
      if (isMember) {
        return;
      }
    }
    throw new AppError({
      code: "FORBIDDEN_WORKSPACE_ACCESS",
      statusCode: 403,
      message: "You do not have access to this work item.",
    });
  }

  private async assertHumanControlAuthority(
    txRepo: WorkspacesRepository,
    item: Readonly<HydratedWorkItemRecord>,
    humanUserId: UserId,
  ): Promise<void> {
    if (humanUserId === item.ownerUserId || humanUserId === item.workspaceOwnerUserId) {
      return;
    }
    if (item.roomId !== undefined) {
      const room = await txRepo.findRoomBasic(item.roomId);
      if (room?.ownerUserId === humanUserId) {
        return;
      }
    }
    throw new AppError({
      code: "FORBIDDEN_NOT_OWNER",
      statusCode: 403,
      message: "Only the task owner, workspace owner, or room owner may perform this action.",
    });
  }

  private async publishWorkspaceUpdated(
    workspaceId: WorkspaceId,
    ownerUserId: UserId,
    roomIds: readonly RoomId[],
  ): Promise<void> {
    const tasks: Array<Promise<void>> = [
      this.realtimeBus.publishToUser(ownerUserId, {
        type: "workspace.updated",
        workspaceId,
      }),
      ...roomIds.map((roomId) =>
        this.realtimeBus.publishToRoom(roomId, {
          type: "workspace.updated",
          workspaceId,
          roomId,
        }),
      ),
    ];
    await this.settleRealtimePublishes(tasks, "workspace.updated");
  }

  /**
   * 事务提交后的统一并行实时事件广播与下一棒 Agent 定向唤醒器。
   * 采用 `Promise.allSettled` 隔离通知故障，确保已提交事务绝不因事件总线瞬态异常向调用方误报 500。
   */
  private async fanOutPostCommitSignals(params: {
    readonly item: Readonly<HydratedWorkItemRecord>;
    readonly roomMilestoneMessage?: HydratedRawMessageRecord | undefined;
    readonly wakeAgentIds: readonly AgentId[];
    readonly actorCaller: Readonly<AuthenticatedCaller>;
    readonly notifyParticipantAgents?: boolean | undefined;
  }): Promise<void> {
    const { item, roomMilestoneMessage, wakeAgentIds, actorCaller } = params;
    const tasks: Array<Promise<void>> = [];

    if (roomMilestoneMessage !== undefined && item.roomId !== undefined) {
      const neutralMessage = stampRawMessageForViewer(roomMilestoneMessage, PUBLIC_NEUTRAL_VIEWER);
      tasks.push(
        this.realtimeBus.publishToRoom(item.roomId, {
          type: "message.created",
          roomId: item.roomId,
          message: neutralMessage,
        }),
      );
    }

    const workEvent: SseEvent = {
      type: "work.updated",
      workItemId: item.id,
      workspaceId: item.workspaceId,
      ...(item.roomId !== undefined ? { roomId: item.roomId } : {}),
      stage: item.stage,
      version: item.version,
    };

    tasks.push(this.realtimeBus.publishToUser(item.ownerUserId, workEvent));
    if (item.workspaceOwnerUserId !== item.ownerUserId) {
      tasks.push(this.realtimeBus.publishToUser(item.workspaceOwnerUserId, workEvent));
    }
    if (item.roomId !== undefined) {
      tasks.push(this.realtimeBus.publishToRoom(item.roomId, workEvent));
    }

    if (params.notifyParticipantAgents !== false) {
      const participantAgentIds = new Set<AgentId>(item.slices.map((s) => s.assignedAgentId));
      for (const agentId of participantAgentIds) {
        tasks.push(this.realtimeBus.publishToAgent(agentId, workEvent));
      }
    }

    if (wakeAgentIds.length > 0 && item.roomId !== undefined) {
      const roomId = item.roomId;
      const roomBasic = await this.repo.findRoomBasic(roomId).catch(() => undefined);
      const latestRoomSeq =
        roomBasic && roomBasic.lastSeq >= 1 ? asMessageSeq(roomBasic.lastSeq) : undefined;

      if (latestRoomSeq !== undefined) {
        for (const targetAgentId of new Set(wakeAgentIds)) {
          const snap = item.agentSnapshots[targetAgentId];
          const isDirectOwnerCommand =
            actorCaller.kind === "human" && snap?.ownerUserId === actorCaller.userId;
          tasks.push(
            this.realtimeBus.publishToAgent(targetAgentId, {
              type: "wake",
              roomId,
              latestSeq: latestRoomSeq,
              reason: isDirectOwnerCommand ? "owner_command" : "direct_mention",
            }),
          );
        }
      }
    }

    await this.settleRealtimePublishes(tasks, "work.updated");

    for (const listener of this.postCommitListeners) {
      try {
        listener(item);
      } catch (err) {
        this.logger?.warn({ err, workItemId: item.id }, "Work item post-commit listener threw");
      }
    }
  }

  private async settleRealtimePublishes(
    tasks: ReadonlyArray<Promise<void>>,
    contextTag: string,
  ): Promise<void> {
    if (tasks.length === 0) {
      return;
    }
    const results = await Promise.allSettled(tasks);
    for (const res of results) {
      if (res.status === "rejected") {
        this.logger?.warn(
          { err: res.reason, contextTag },
          "Post-commit realtime signal delivery failed",
        );
      }
    }
  }
}
