/**
 * @module core-governance/work-orchestration
 * @description 多 Agent 工作区权限评估、独占路径代数、持久租约防护（Fenced Lease）与协作状态机纯函数核。
 *
 * 设计约束与关键不变量：
 * 1. 纯确定性（Zero-I/O）：所有时间推进均通过显式注入的 `nowMs` 计算，便于在微秒级单测中验证超时接管与防护令牌拒绝。
 * 2. 路径互斥（Disjoint Write Paths）：并发 `write` 分片若存在目录包含或通配重合，在建单阶段即拒绝，从根源消除共享工作树合并踩踏。
 * 3. 版本防护（Lease Fencing，ADR-0009）：每次认领或超时接管均使 `leaseVersion + 1`；旧执行器携带过期版本号回报心跳或结果时一律返回 `WORK_LEASE_EXPIRED`。
 * 4. 有界自愈与人工终审（ADR-0002）：失联租约最多尝试 `MAX_SLICE_ATTEMPTS` 次；返工若重复交付相同证据则暂停；终态 `done` 仅能由人类审批触发。
 */
import type {
  AgentExecutionTier,
  AgentId,
  ErrorCode,
  UserId,
  WorkSliceId,
  WorkSliceProvenance,
  WorkSliceRole,
  WorkSliceStatus,
  WorkStage,
  WorkTopology,
  WorkVerifyVerdict,
  WorkspaceHostMode,
  WorkspaceSandboxMode,
} from "@openhuddle/protocol";
import { scrubWorkProvenance, scrubWorkText } from "./secret-redact.js";

/** 默认分片租约有效期（2 分钟，执行器通过心跳续期） */
export const DEFAULT_SLICE_LEASE_TTL_MS = 120_000;

/** 单个分片允许的最大崩溃/超时重试次数 */
export const MAX_SLICE_ATTEMPTS = 3;

/** Recent rejected deliveries, retained to detect repeats and oscillation without limiting productive turns. */
const REWORK_EVIDENCE_HISTORY = 32;

/** Keep both persisted and legacy notes within the work-slice wire format. */
export function recentWorkSteerNotes(notes: readonly string[]): string[] {
  return notes.slice(-50).map((note) => note.slice(0, 1_000));
}

/** 编排核统一返回的业务拒绝结构 */
export interface WorkDomainRejection {
  readonly ok: false;
  readonly code: Extract<
    ErrorCode,
    | "FORBIDDEN_WORKSPACE_ACCESS"
    | "WORK_PATH_CONFLICT"
    | "WORK_LEASE_EXPIRED"
    | "WORK_INVALID_TRANSITION"
  >;
  readonly message: string;
}

/** 路径冲突检测输入项 */
export interface SlicePathCheckInput {
  readonly index: number;
  readonly title: string;
  readonly leaseRole: WorkSliceRole;
  readonly ownedPaths: readonly string[];
}

/** 两个并发写分片之间的路径冲突详情 */
export interface OwnedPathConflict {
  readonly firstSliceIndex: number;
  readonly secondSliceIndex: number;
  readonly firstPath: string;
  readonly secondPath: string;
  readonly reason: string;
}

/** 工作区执行权限评估上下文 */
export interface WorkspaceExecutionAccessInput {
  readonly workspaceOwnerUserId: UserId;
  readonly hostMode: WorkspaceHostMode;
  readonly sandboxMode: WorkspaceSandboxMode;
  readonly allowRoomCollaborators: boolean;
  readonly agentOwnerUserId: UserId;
  readonly isRoomMember: boolean;
  readonly requestedRole: WorkSliceRole;
  readonly requestedTier: AgentExecutionTier;
}

/** 状态机内部消费的分片快照 */
export interface OrchestrationSliceState {
  readonly sliceId: WorkSliceId;
  readonly orderIndex: number;
  readonly title: string;
  readonly leaseRole: WorkSliceRole;
  readonly assignedAgentId: AgentId;
  readonly leaseOwnerAgentId?: AgentId | undefined;
  readonly leaseVersion: number;
  readonly leaseExpiresAtMs?: number | undefined;
  readonly attemptCount: number;
  readonly ownedPaths: readonly string[];
  readonly status: WorkSliceStatus;
  readonly liveSummary: string;
  readonly diffAdded: number;
  readonly diffRemoved: number;
  readonly changedFiles: readonly string[];
  readonly worktreeBranch?: string | undefined;
  readonly steerNotes: readonly string[];
  readonly failureCode?: string | undefined;
  readonly provenance?: WorkSliceProvenance | undefined;
  readonly startedAtMs?: number | undefined;
  readonly completedAtMs?: number | undefined;
}

/** 状态机内部消费的交付评审快照 */
export interface OrchestrationReviewState {
  readonly filesChanged: number;
  readonly additions: number;
  readonly deletions: number;
  readonly changedFiles: readonly string[];
  /** 真实运行过的校验命令；缺省表示本次交付没有可佐证的自动化校验 */
  readonly testCommand?: string | undefined;
  /** 仅与 `testCommand` 成对出现 */
  readonly testPassed?: boolean | undefined;
  readonly worktreeBranch?: string | undefined;
  readonly verifierNote?: string | undefined;
  readonly verifyLoopsUsed: number;
  readonly rejectedEvidenceKeys?: readonly string[] | undefined;
  readonly lastReworkLeaseVersion?: number | undefined;
  readonly reviewedByUserId?: UserId | undefined;
  readonly reviewDecisionNote?: string | undefined;
  readonly reviewedAtMs?: number | undefined;
}

/** 状态机内部消费的工单聚合根快照 */
export interface OrchestrationItemState {
  readonly topology: WorkTopology;
  readonly stage: WorkStage;
  readonly worktreeBranch: string;
  readonly defaultVerifyCommand?: string | undefined;
  readonly slices: readonly OrchestrationSliceState[];
  readonly review?: OrchestrationReviewState | undefined;
}

/**
 * 将用户或统筹 Agent 声明的 `ownedPaths` 规整为仓库相对目录/文件前缀。
 * 返回 `""` 代表整仓根作用域；若包含 `..` 穿越或绝对盘符则返回 `null`。
 */
export function normalizeOwnedPathPrefix(rawPath: string): string | null {
  const trimmed = rawPath.trim().replace(/\\/g, "/");
  if (trimmed.length === 0 || trimmed.startsWith("/") || /^[A-Za-z]:/.test(trimmed)) {
    return null;
  }

  // 剥离前导 `./` 与尾部 glob 通配后缀（`/**`, `/*`, `/`）以便进行前缀包含运算
  let cleaned = trimmed.replace(/^(?:\.\/)+/, "");
  if (cleaned === "." || cleaned === "*" || cleaned === "**") {
    return "";
  }
  cleaned = cleaned
    .replace(/\/\*\*$/, "")
    .replace(/\/\*$/, "")
    .replace(/\/+$/, "");

  const segments = cleaned.split("/");
  for (const seg of segments) {
    if (seg === ".." || seg === "." || seg.includes("*")) {
      return seg.includes("*") ? cleaned.slice(0, cleaned.indexOf("*")).replace(/\/+$/, "") : null;
    }
  }
  return cleaned;
}

function pathsOverlap(prefixA: string, prefixB: string): boolean {
  if (prefixA === "" || prefixB === "") {
    return true;
  }
  if (prefixA === prefixB) {
    return true;
  }
  return prefixA.startsWith(`${prefixB}/`) || prefixB.startsWith(`${prefixA}/`);
}

/**
 * 检测并发 `write` 分片集合中是否存在目录包含、同路径或整仓通配冲突。
 */
export function detectOwnedPathConflicts(
  slices: readonly SlicePathCheckInput[],
): readonly OwnedPathConflict[] {
  const writeSlices = slices.filter((s) => s.leaseRole === "write");
  const conflicts: OwnedPathConflict[] = [];

  for (const slice of writeSlices) {
    for (const raw of slice.ownedPaths) {
      if (normalizeOwnedPathPrefix(raw) === null) {
        conflicts.push({
          firstSliceIndex: slice.index,
          secondSliceIndex: slice.index,
          firstPath: raw,
          secondPath: raw,
          reason: `Invalid or non-relative ownedPath "${raw}" in slice "${slice.title}".`,
        });
      }
    }
  }
  if (conflicts.length > 0 || writeSlices.length <= 1) {
    return conflicts;
  }

  for (let i = 0; i < writeSlices.length; i++) {
    const left = writeSlices[i];
    if (!left) continue;
    const leftPaths = left.ownedPaths.length > 0 ? left.ownedPaths : ["**"];

    for (let j = i + 1; j < writeSlices.length; j++) {
      const right = writeSlices[j];
      if (!right) continue;
      const rightPaths = right.ownedPaths.length > 0 ? right.ownedPaths : ["**"];

      let pairMatched = false;
      for (const lp of leftPaths) {
        if (pairMatched) break;
        const normL = normalizeOwnedPathPrefix(lp) ?? "";
        for (const rp of rightPaths) {
          const normR = normalizeOwnedPathPrefix(rp) ?? "";
          if (pathsOverlap(normL, normR)) {
            conflicts.push({
              firstSliceIndex: left.index,
              secondSliceIndex: right.index,
              firstPath: lp,
              secondPath: rp,
              reason: `Write slices "${left.title}" (${lp}) and "${right.title}" (${rp}) overlap.`,
            });
            pairMatched = true;
            break;
          }
        }
      }
    }
  }

  return conflicts;
}

/**
 * 评估目标 Agent 是否有权在给定工作区上持有指定角色的执行租约（Owner-First + 三态宿主边界）。
 */
export function evaluateWorkspaceExecutionAccess(
  input: Readonly<WorkspaceExecutionAccessInput>,
): { readonly ok: true } | WorkDomainRejection {
  if (input.requestedTier === "chat_only") {
    return {
      ok: false,
      code: "FORBIDDEN_WORKSPACE_ACCESS",
      message: "Agents restricted to chat_only tier cannot claim workspace execution slices.",
    };
  }

  if (input.sandboxMode === "read_only" && input.requestedRole === "write") {
    return {
      ok: false,
      code: "FORBIDDEN_WORKSPACE_ACCESS",
      message: "Workspace sandboxMode is read_only; write slices are forbidden.",
    };
  }

  // 工作区主人自己的 Agent 天然享有受托宿主访问权
  if (input.agentOwnerUserId === input.workspaceOwnerUserId) {
    return { ok: true };
  }

  // 跨主人隔离铁律（ADR-0010）：私人本机与个人云开发机严禁向外部主人的 Agent 发放任何执行租约
  if (input.hostMode === "local_machine" || input.hostMode === "personal_remote") {
    return {
      ok: false,
      code: "FORBIDDEN_WORKSPACE_ACCESS",
      message: `External agents cannot execute slices on a ${input.hostMode} workspace; only shared_container supports cross-owner execution.`,
    };
  }

  if (!input.allowRoomCollaborators || !input.isRoomMember) {
    return {
      ok: false,
      code: "FORBIDDEN_WORKSPACE_ACCESS",
      message:
        "Shared container workspace has not granted room collaborator access to external agents.",
    };
  }

  if (input.requestedTier === "full_owner_delegate") {
    return {
      ok: false,
      code: "FORBIDDEN_WORKSPACE_ACCESS",
      message: "External room agents cannot run with full_owner_delegate authority.",
    };
  }

  return { ok: true };
}

/**
 * 评估分片认领或超时接管请求，成功时生成携带递增 `leaseVersion` 的新分片状态。
 */
export function evaluateSliceClaim(params: {
  readonly itemStage: WorkStage;
  readonly slice: Readonly<OrchestrationSliceState>;
  readonly callerAgentId: AgentId;
  /** 同主人兄弟 Agent 或已获共享容器授权的同群协作 Agent 允许在原执行器租约超时后接管 */
  readonly canTakeOverExpiredPeerSlice: boolean;
  readonly leaseTtlMs?: number | undefined;
  readonly nowMs: number;
}):
  | {
      readonly ok: true;
      readonly nextSlice: OrchestrationSliceState;
      readonly wasExpiredTakeover: boolean;
      /** 当同一持有者在未过期租约窗口内因网络超时重发 `claim` 时，幂等续期并返回既有 `leaseVersion` */
      readonly idempotentReplay: boolean;
    }
  | WorkDomainRejection {
  const { itemStage, slice, callerAgentId, nowMs } = params;
  const ttlMs = params.leaseTtlMs ?? DEFAULT_SLICE_LEASE_TTL_MS;

  if (
    itemStage === "done" ||
    itemStage === "cancelled" ||
    itemStage === "awaiting_review" ||
    itemStage === "awaiting_answer"
  ) {
    return {
      ok: false,
      code: "WORK_INVALID_TRANSITION",
      message: `Cannot claim a slice while work item stage is "${itemStage}".`,
    };
  }

  if (slice.leaseRole === "verify" && itemStage !== "verifying") {
    return {
      ok: false,
      code: "WORK_INVALID_TRANSITION",
      message: "Verifier slice cannot be claimed until all execution slices have completed.",
    };
  }

  if (slice.leaseRole !== "verify" && itemStage === "verifying") {
    return {
      ok: false,
      code: "WORK_INVALID_TRANSITION",
      message: "Execution slices are locked while independent verification is in progress.",
    };
  }

  if (slice.status === "ready") {
    return {
      ok: false,
      code: "WORK_INVALID_TRANSITION",
      message: `Slice "${slice.title}" is already completed.`,
    };
  }

  const hasActiveUnexpiredLease =
    (slice.status === "running" || slice.status === "verifying") &&
    slice.leaseExpiresAtMs !== undefined &&
    slice.leaseExpiresAtMs > nowMs;

  if (hasActiveUnexpiredLease) {
    if (slice.leaseOwnerAgentId === callerAgentId) {
      return {
        ok: true,
        wasExpiredTakeover: false,
        idempotentReplay: true,
        nextSlice: {
          ...slice,
          leaseExpiresAtMs: nowMs + ttlMs,
        },
      };
    }
    return {
      ok: false,
      code: "WORK_LEASE_EXPIRED",
      message: `Slice "${slice.title}" already holds an active lease until ${new Date(slice.leaseExpiresAtMs).toISOString()}.`,
    };
  }

  const isExpiredActiveLease =
    (slice.status === "running" || slice.status === "verifying") &&
    slice.leaseExpiresAtMs !== undefined &&
    slice.leaseExpiresAtMs <= nowMs;

  if (callerAgentId !== slice.assignedAgentId) {
    if (!isExpiredActiveLease || !params.canTakeOverExpiredPeerSlice) {
      return {
        ok: false,
        code: "FORBIDDEN_WORKSPACE_ACCESS",
        message: `Slice "${slice.title}" is assigned to ${slice.assignedAgentId}; peer takeover is only allowed after lease expiry.`,
      };
    }
  }

  if (slice.attemptCount >= MAX_SLICE_ATTEMPTS) {
    return {
      ok: false,
      code: "WORK_INVALID_TRANSITION",
      message: `Slice "${slice.title}" exhausted maximum attempts (${MAX_SLICE_ATTEMPTS}).`,
    };
  }

  const nextStatus: WorkSliceStatus = slice.leaseRole === "verify" ? "verifying" : "running";
  const nextVersion = slice.leaseVersion + 1;

  return {
    ok: true,
    wasExpiredTakeover: isExpiredActiveLease,
    idempotentReplay: false,
    nextSlice: {
      ...slice,
      assignedAgentId: callerAgentId,
      leaseOwnerAgentId: callerAgentId,
      leaseVersion: nextVersion,
      leaseExpiresAtMs: nowMs + ttlMs,
      attemptCount: slice.attemptCount + 1,
      status: nextStatus,
      liveSummary: isExpiredActiveLease
        ? `Lease expired; taken over on attempt #${slice.attemptCount + 1}.`
        : "Claimed lease and preparing workspace.",
      ...(slice.startedAtMs === undefined ? { startedAtMs: nowMs } : {}),
    },
  };
}

function verifyActiveFencedLease(params: {
  readonly slice: Readonly<OrchestrationSliceState>;
  readonly callerAgentId: AgentId;
  readonly leaseVersion: number;
  readonly nowMs: number;
}): { readonly ok: true } | WorkDomainRejection {
  const { slice, callerAgentId, leaseVersion, nowMs } = params;
  if (
    slice.leaseOwnerAgentId !== callerAgentId ||
    slice.leaseVersion !== leaseVersion ||
    (slice.status !== "running" && slice.status !== "verifying")
  ) {
    return {
      ok: false,
      code: "WORK_LEASE_EXPIRED",
      message: `Stale or unowned lease token (expected version=${slice.leaseVersion}, received=${leaseVersion}).`,
    };
  }

  if (slice.leaseExpiresAtMs !== undefined && slice.leaseExpiresAtMs <= nowMs) {
    return {
      ok: false,
      code: "WORK_LEASE_EXPIRED",
      message: "Slice lease expired before operation committed; re-claim required.",
    };
  }

  return { ok: true };
}

/**
 * 校验防护版本号并续期分片租约、刷新瞬态进度摘要。
 */
export function evaluateSliceHeartbeat(params: {
  readonly slice: Readonly<OrchestrationSliceState>;
  readonly callerAgentId: AgentId;
  readonly leaseVersion: number;
  readonly leaseTtlMs?: number | undefined;
  readonly liveSummary?: string | undefined;
  readonly diffAdded?: number | undefined;
  readonly diffRemoved?: number | undefined;
  readonly nowMs: number;
}): { readonly ok: true; readonly nextSlice: OrchestrationSliceState } | WorkDomainRejection {
  const fence = verifyActiveFencedLease(params);
  if (!fence.ok) {
    return fence;
  }

  const ttlMs = params.leaseTtlMs ?? DEFAULT_SLICE_LEASE_TTL_MS;
  return {
    ok: true,
    nextSlice: {
      ...params.slice,
      leaseExpiresAtMs: params.nowMs + ttlMs,
      ...(params.liveSummary !== undefined
        ? { liveSummary: scrubWorkText(params.liveSummary) }
        : {}),
      ...(params.diffAdded !== undefined ? { diffAdded: params.diffAdded } : {}),
      ...(params.diffRemoved !== undefined ? { diffRemoved: params.diffRemoved } : {}),
    },
  };
}

/**
 * Worker 主动挂起当前分片并发起单问澄清（释放租约超时计时，将工单切入 `awaiting_answer`）。
 */
export function evaluateRaiseSliceAttention(params: {
  readonly itemStage: WorkStage;
  readonly slice: Readonly<OrchestrationSliceState>;
  readonly callerAgentId: AgentId;
  readonly leaseVersion: number;
  readonly question: string;
  readonly nowMs: number;
}):
  | {
      readonly ok: true;
      readonly nextStage: WorkStage;
      readonly nextSlice: OrchestrationSliceState;
      readonly scrubbedQuestion: string;
    }
  | WorkDomainRejection {
  if (params.itemStage !== "working" && params.itemStage !== "verifying") {
    return {
      ok: false,
      code: "WORK_INVALID_TRANSITION",
      message: `Cannot raise attention while work item stage is "${params.itemStage}".`,
    };
  }

  const fence = verifyActiveFencedLease(params);
  if (!fence.ok) {
    return fence;
  }

  const scrubbedQuestion = scrubWorkText(params.question);
  const { leaseExpiresAtMs: _clearedExpiry, ...restSlice } = params.slice;

  return {
    ok: true,
    nextStage: "awaiting_answer",
    scrubbedQuestion,
    nextSlice: {
      ...restSlice,
      status: "waiting",
      liveSummary: `Waiting for human clarification: ${scrubbedQuestion}`,
    },
  };
}

function aggregateReviewSummary(
  item: Readonly<OrchestrationItemState>,
  slices: readonly OrchestrationSliceState[],
  overrides?: {
    readonly testCommand?: string | undefined;
    readonly testPassed?: boolean | undefined;
    readonly verifierNote?: string | undefined;
    readonly verifyLoopsUsed?: number | undefined;
  },
): OrchestrationReviewState {
  const execSlices = slices.filter((s) => s.leaseRole !== "verify");
  const seenFiles = new Set<string>();
  const changedFiles: string[] = [];
  let additions = 0;
  let deletions = 0;
  let branch: string | undefined;

  for (const s of execSlices) {
    additions += s.diffAdded;
    deletions += s.diffRemoved;
    if (!branch && s.worktreeBranch) {
      branch = s.worktreeBranch;
    }
    for (const file of s.changedFiles) {
      if (!seenFiles.has(file)) {
        seenFiles.add(file);
        changedFiles.push(file);
      }
    }
  }

  const prev = item.review;
  const effectiveBranch = branch ?? prev?.worktreeBranch ?? item.worktreeBranch;
  const effectiveVerifierNote = overrides?.verifierNote ?? prev?.verifierNote;
  // 校验结论只承接真实上报的命令结果：工作区“配置了”校验命令不等于“跑过且通过”
  const effectiveTestCommand = overrides?.testCommand ?? prev?.testCommand;
  const effectiveTestPassed = overrides?.testPassed ?? prev?.testPassed;

  return {
    rejectedEvidenceKeys: prev?.rejectedEvidenceKeys,
    lastReworkLeaseVersion: prev?.lastReworkLeaseVersion,
    filesChanged: changedFiles.length,
    additions,
    deletions,
    changedFiles,
    ...(effectiveTestCommand !== undefined
      ? { testCommand: effectiveTestCommand, testPassed: effectiveTestPassed ?? false }
      : {}),
    ...(effectiveBranch ? { worktreeBranch: effectiveBranch } : {}),
    ...(effectiveVerifierNote !== undefined ? { verifierNote: effectiveVerifierNote } : {}),
    verifyLoopsUsed: overrides?.verifyLoopsUsed ?? prev?.verifyLoopsUsed ?? 0,
  };
}

/**
 * 合并执行分片，处理独立复核和返工交接，在交付证据反复时暂停。
 */
export function evaluateSliceCompletion(params: {
  readonly item: Readonly<OrchestrationItemState>;
  readonly targetSliceId: WorkSliceId;
  readonly callerAgentId: AgentId;
  readonly leaseVersion: number;
  readonly summary: string;
  readonly changedFiles: readonly string[];
  readonly diffAdded: number;
  readonly diffRemoved: number;
  readonly worktreeBranch?: string | undefined;
  readonly testCommand?: string | undefined;
  readonly testPassed?: boolean | undefined;
  readonly verdict?: WorkVerifyVerdict | undefined;
  /** Server-derived fingerprint of the delivery reviewed under this lease. */
  readonly reworkEvidenceKey?: string | undefined;
  readonly provenance?: WorkSliceProvenance | undefined;
  readonly nowMs: number;
}):
  | {
      readonly ok: true;
      readonly nextStage: WorkStage;
      readonly nextSlices: readonly OrchestrationSliceState[];
      readonly nextReview?: OrchestrationReviewState | undefined;
      /** 事务提交后需要立即发送 `wake` 信号的下一棒 Agent 列表 */
      readonly wakeAgentIds: readonly AgentId[];
      /** 为 `true` 表示同一持有者以相同 `leaseVersion` 重试已完成分片，直接幂等返回而不重复唤醒下游 */
      readonly idempotentReplay?: boolean | undefined;
    }
  | WorkDomainRejection {
  const { item, targetSliceId, nowMs } = params;
  const target = item.slices.find((s) => s.sliceId === targetSliceId);
  if (!target) {
    return {
      ok: false,
      code: "WORK_INVALID_TRANSITION",
      message: `Slice "${targetSliceId}" does not belong to this work item.`,
    };
  }

  // 幂等重放保护（ADR-0009 §3.3）：若分片已由当前 Agent 在相同 leaseVersion 下提交完成，网络超时重试直接成功返回
  if (
    target.leaseVersion === params.leaseVersion &&
    ((target.status === "ready" && target.leaseOwnerAgentId === params.callerAgentId) ||
      (target.leaseRole === "verify" &&
        target.assignedAgentId === params.callerAgentId &&
        item.review?.lastReworkLeaseVersion === params.leaseVersion))
  ) {
    return {
      ok: true,
      idempotentReplay: true,
      nextStage: item.stage,
      nextSlices: item.slices,
      ...(item.review !== undefined ? { nextReview: item.review } : {}),
      wakeAgentIds: [],
    };
  }

  const fence = verifyActiveFencedLease({
    slice: target,
    callerAgentId: params.callerAgentId,
    leaseVersion: params.leaseVersion,
    nowMs,
  });
  if (!fence.ok) {
    return fence;
  }

  const scrubbedSummary = scrubWorkText(params.summary);
  const scrubbedFiles = params.changedFiles.map((f) => scrubWorkText(f));
  const scrubbedProvenance =
    params.provenance !== undefined ? scrubWorkProvenance(params.provenance) : target.provenance;
  const { leaseExpiresAtMs: _expiredRemoved, ...restTarget } = target;

  const completedSlice: OrchestrationSliceState = {
    ...restTarget,
    status: "ready",
    liveSummary: scrubbedSummary,
    diffAdded: params.diffAdded,
    diffRemoved: params.diffRemoved,
    changedFiles: scrubbedFiles,
    ...(params.worktreeBranch !== undefined
      ? { worktreeBranch: scrubWorkText(params.worktreeBranch) }
      : {}),
    ...(scrubbedProvenance !== undefined ? { provenance: scrubbedProvenance } : {}),
    completedAtMs: nowMs,
  };

  // 分支 A：执行分片（write / read）完工 —— 检查蜂群屏障是否全部到齐
  if (target.leaseRole !== "verify") {
    const updatedSlices = item.slices.map((s) =>
      s.sliceId === targetSliceId ? completedSlice : s,
    );
    const execSlices = updatedSlices.filter((s) => s.leaseRole !== "verify");
    const allExecDone = execSlices.every((s) => s.status === "ready");

    if (!allExecDone) {
      return {
        ok: true,
        nextStage: item.stage,
        nextSlices: updatedSlices,
        ...(item.review !== undefined ? { nextReview: item.review } : {}),
        wakeAgentIds: [],
      };
    }

    const verifySlice = updatedSlices.find((s) => s.leaseRole === "verify");
    const nextReview = aggregateReviewSummary(item, updatedSlices, {
      ...(params.testCommand !== undefined
        ? { testCommand: scrubWorkText(params.testCommand) }
        : {}),
      ...(params.testPassed !== undefined ? { testPassed: params.testPassed } : {}),
    });

    if (verifySlice !== undefined) {
      // 所有执行分片已合流：解锁独立核验分片并定向唤醒 Verifier Agent
      const unlockedSlices = updatedSlices.map((s) => {
        if (s.sliceId !== verifySlice.sliceId) {
          return s;
        }
        const {
          leaseOwnerAgentId: _owner,
          leaseExpiresAtMs: _exp,
          completedAtMs: _doneAt,
          ...restVerify
        } = s;
        return {
          ...restVerify,
          status: "waiting" as const,
          attemptCount: 0,
          liveSummary: "Ready for independent verification.",
        };
      });

      return {
        ok: true,
        nextStage: "verifying",
        nextSlices: unlockedSlices,
        nextReview,
        wakeAgentIds: [verifySlice.assignedAgentId],
      };
    }

    return {
      ok: true,
      nextStage: "awaiting_review",
      nextSlices: updatedSlices,
      nextReview,
      wakeAgentIds: [],
    };
  }

  // 分支 B：独立核验分片（verify）提交审查结论
  const verdict: WorkVerifyVerdict =
    params.verdict ?? (params.testPassed === false ? "changes_requested" : "passed");
  const nextLoopsUsed = (item.review?.verifyLoopsUsed ?? 0) + 1;
  const nextReview = aggregateReviewSummary(
    item,
    item.slices.map((s) => (s.sliceId === targetSliceId ? completedSlice : s)),
    {
      ...(params.testCommand !== undefined
        ? { testCommand: scrubWorkText(params.testCommand) }
        : {}),
      testPassed: verdict === "passed" && params.testPassed !== false,
      verifierNote: scrubbedSummary,
      verifyLoopsUsed: nextLoopsUsed,
    },
  );

  if (verdict === "passed") {
    return {
      ok: true,
      nextStage: "awaiting_review",
      nextSlices: item.slices.map((s) => (s.sliceId === targetSliceId ? completedSlice : s)),
      nextReview,
      wakeAgentIds: [],
    };
  }

  const evidenceKey = params.reworkEvidenceKey;
  if (!evidenceKey) {
    return {
      ok: false,
      code: "WORK_INVALID_TRANSITION",
      message: "Missing delivery fingerprint for rework.",
    };
  }
  const previousKeys = item.review?.rejectedEvidenceKeys ?? [];
  const reworkReview = {
    ...nextReview,
    rejectedEvidenceKeys: [...previousKeys, evidenceKey].slice(-REWORK_EVIDENCE_HISTORY),
    lastReworkLeaseVersion: params.leaseVersion,
  };
  if (previousKeys.includes(evidenceKey)) {
    const blockedSlices = item.slices.map((s) =>
      s.sliceId === targetSliceId
        ? {
            ...completedSlice,
            status: "blocked" as const,
            failureCode: "REPEATED_REVIEW_EVIDENCE",
            liveSummary:
              "本轮交付与先前退回的工作及验证结果相同，已暂停返工，等待补充证据或调整任务。",
          }
        : s,
    );
    return {
      ok: true,
      nextStage: "blocked",
      nextSlices: blockedSlices,
      nextReview: reworkReview,
      wakeAgentIds: [],
    };
  }

  // 自动返工交接（verify -> write）：重开所有写分片，注入核验反馈并保留单调递增的 leaseVersion 基数
  const wakeSet = new Set<AgentId>();
  const hasWriter = item.slices.some((s) => s.leaseRole === "write");
  const reopenedSlices = item.slices.map((s) => {
    if (s.sliceId === targetSliceId) {
      const {
        leaseOwnerAgentId: _vOwner,
        leaseExpiresAtMs: _vExp,
        completedAtMs: _vDone,
        ...restV
      } = completedSlice;
      return {
        ...restV,
        status: "waiting" as const,
        attemptCount: 0,
        liveSummary: `Requested rework (#${nextLoopsUsed}): ${scrubbedSummary}`.slice(0, 1000),
      };
    }
    if (s.leaseRole === "write" || (!hasWriter && s.leaseRole === "read")) {
      wakeSet.add(s.assignedAgentId);
      const {
        leaseOwnerAgentId: _wOwner,
        leaseExpiresAtMs: _wExp,
        completedAtMs: _wDone,
        ...restW
      } = s;
      return {
        ...restW,
        status: "waiting" as const,
        attemptCount: 0,
        liveSummary: `Reopened after verifier review (#${nextLoopsUsed}).`,
        steerNotes: recentWorkSteerNotes([
          ...s.steerNotes,
          `[Verifier #${nextLoopsUsed}] ${scrubbedSummary}`,
        ]),
      };
    }
    return s;
  });

  return {
    ok: true,
    nextStage: "working",
    nextSlices: reopenedSlices,
    nextReview: reworkReview,
    wakeAgentIds: [...wakeSet],
  };
}

/**
 * 评估人类主人对工单交付物的最终审批或打回重做决策（ADR-0002）。
 */
export function evaluateHumanReviewDecision(params: {
  readonly item: Readonly<OrchestrationItemState>;
  readonly reviewerUserId: UserId;
  readonly decision: "approve" | "request_changes";
  readonly note?: string | undefined;
  readonly nowMs: number;
}):
  | {
      readonly ok: true;
      readonly nextStage: WorkStage;
      readonly nextSlices: readonly OrchestrationSliceState[];
      readonly nextReview: OrchestrationReviewState;
      readonly wakeAgentIds: readonly AgentId[];
    }
  | WorkDomainRejection {
  const { item, reviewerUserId, decision, nowMs } = params;
  if (
    item.stage !== "awaiting_review" &&
    !(decision === "request_changes" && item.stage === "blocked")
  ) {
    return {
      ok: false,
      code: "WORK_INVALID_TRANSITION",
      message: `Cannot review work item while stage is "${item.stage}".`,
    };
  }

  const scrubbedNote = params.note !== undefined ? scrubWorkText(params.note) : undefined;
  const baseReview = item.review ?? aggregateReviewSummary(item, item.slices);
  const nextReview: OrchestrationReviewState = {
    ...baseReview,
    ...(decision === "request_changes"
      ? { rejectedEvidenceKeys: [], lastReworkLeaseVersion: undefined }
      : {}),
    reviewedByUserId: reviewerUserId,
    ...(scrubbedNote !== undefined ? { reviewDecisionNote: scrubbedNote } : {}),
    reviewedAtMs: nowMs,
  };

  if (decision === "approve") {
    return {
      ok: true,
      nextStage: "done",
      nextSlices: item.slices,
      nextReview,
      wakeAgentIds: [],
    };
  }

  const feedbackText =
    scrubbedNote && scrubbedNote.length > 0 ? scrubbedNote : "Human requested changes.";
  const wakeSet = new Set<AgentId>();
  const hasWriter = item.slices.some((s) => s.leaseRole === "write");
  const reopenedSlices = item.slices.map((s) => {
    if (s.leaseRole === "write" || (!hasWriter && s.leaseRole === "read")) {
      wakeSet.add(s.assignedAgentId);
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
        liveSummary: "Reopened by human review.",
        steerNotes: recentWorkSteerNotes([...s.steerNotes, `[Owner Review] ${feedbackText}`]),
      };
    }
    if (s.leaseRole === "verify") {
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
        liveSummary: "Waiting for updated implementation.",
      };
    }
    return s;
  });

  return {
    ok: true,
    nextStage: "working",
    nextSlices: reopenedSlices,
    nextReview,
    wakeAgentIds: [...wakeSet],
  };
}
