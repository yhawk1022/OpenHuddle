/**
 * @module web/features/huddle-room/work/room-work-store
 * @description 按 `RoomId` 隔离的群内多 Agent 工单前端状态存储与脉冲模拟引擎。
 *
 * 关键不变量：
 * 1. 新打开的会话默认 `items = []`，不在聊天消息流注入未请求的卡片。
 * 2. 引用计数与活跃门控定时器：仅当存在已挂载订阅者且至少一个房间有 `working | verifying` 工单时才运行秒级计时器，空闲时零轮询开销。
 */
import type { AgentId, AgentPlatform, RoomId, RoomMemberDto, UserId } from "@openhuddle/protocol";
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { getWorkbenchTranslator } from "../i18n/workbench.js";
import type {
  DispatchWorkPayload,
  ObserveDryRunEntry,
  RoomOrchestrationDefaults,
  RoomWorkItemView,
  SuperAgentIntakeMode,
  WorkAgentRef,
  WorkShowcasePreset,
  WorkSliceNode,
  WorkStage,
} from "./work-types.js";

interface RoomWorkBucket {
  readonly defaults: RoomOrchestrationDefaults;
  readonly items: ReadonlyArray<RoomWorkItemView>;
  readonly observeLogs: ReadonlyArray<ObserveDryRunEntry>;
}

const EMPTY_BUCKET: RoomWorkBucket = {
  defaults: {
    intakeMode: "off",
  },
  items: [],
  observeLogs: [],
};

const bucketsByRoom = new Map<RoomId, RoomWorkBucket>();
const storeListeners = new Set<() => void>();

/**
 * 房间工单状态变更向单人工作台同步的镜像事件载荷（消除群聊与工作台双状态仓脑裂）。
 */
export type RoomWorkMirrorEvent =
  | { readonly type: "steer"; readonly soloTaskId: string; readonly note: string }
  | { readonly type: "stop"; readonly soloTaskId: string }
  | { readonly type: "retry"; readonly soloTaskId: string }
  | { readonly type: "answer"; readonly soloTaskId: string; readonly choice: string }
  | {
      readonly type: "review";
      readonly soloTaskId: string;
      readonly decision: "approve" | "rework";
      readonly note?: string | undefined;
    };

let mirrorSyncHandler: ((event: RoomWorkMirrorEvent) => void) | null = null;
let suppressMirrorOutbound = false;

/**
 * 注册房间工单到单人工作台的单向镜像回调（由 `solo-workbench-store` 初始化时挂载）。
 */
export function registerRoomWorkMirrorHandler(handler: (event: RoomWorkMirrorEvent) => void): void {
  mirrorSyncHandler = handler;
}

function notifyMirror(event: RoomWorkMirrorEvent): void {
  if (suppressMirrorOutbound || mirrorSyncHandler === null) {
    return;
  }
  suppressMirrorOutbound = true;
  try {
    mirrorSyncHandler(event);
  } finally {
    suppressMirrorOutbound = false;
  }
}

/**
 * 在屏蔽反向回声的前提下执行来自工作台的镜像同步动作，防止循环触发。
 */
export function runWithSuppressedRoomMirror(fn: () => void): void {
  const prev = suppressMirrorOutbound;
  suppressMirrorOutbound = true;
  try {
    fn();
  } finally {
    suppressMirrorOutbound = prev;
  }
}

/**
 * 将已创建的房间工单绑定至对应的单人工作台任务 ID。
 */
export function bindRoomWorkItemToSoloTask(
  roomId: RoomId,
  workItemId: string,
  soloTaskId: string,
): void {
  const bucket = getRoomBucket(roomId);
  setRoomBucket(roomId, {
    ...bucket,
    items: bucket.items.map((item) =>
      item.id === workItemId ? { ...item, linkedSoloTaskId: soloTaskId } : item,
    ),
  });
}

function emitChange(): void {
  for (const listener of storeListeners) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  storeListeners.add(listener);
  return () => {
    storeListeners.delete(listener);
  };
}

function getRoomBucket(roomId: RoomId): RoomWorkBucket {
  return bucketsByRoom.get(roomId) ?? EMPTY_BUCKET;
}

/**
 * 读取指定房间当前内存中的协作工单列表快照。
 */
export function getRoomWorkItems(roomId: RoomId): ReadonlyArray<RoomWorkItemView> {
  return getRoomBucket(roomId).items;
}

function setRoomBucket(roomId: RoomId, next: RoomWorkBucket): void {
  bucketsByRoom.set(roomId, next);
  syncRoomTicker();
  emitChange();
}

/**
 * 将服务端权威的房间协作工单列表（`wrk_*`）幂等合并入指定房间状态桶，保留本地演练条目。
 */
export function hydrateServerRoomWorkItems(
  roomId: RoomId,
  serverItems: ReadonlyArray<RoomWorkItemView>,
): void {
  const bucket = getRoomBucket(roomId);
  const serverIds = new Set(serverItems.map((item) => item.id));
  const localItems = bucket.items.filter(
    (item) => !item.id.startsWith("wrk_") && !serverIds.has(item.id),
  );
  setRoomBucket(roomId, {
    ...bucket,
    items: [...serverItems, ...localItems],
  });
}

/**
 * 登出账号时清空所有房间内存工单桶。
 */
export function resetAllRoomWorkBuckets(): void {
  if (bucketsByRoom.size === 0) {
    return;
  }
  bucketsByRoom.clear();
  syncRoomTicker();
  emitChange();
}

function toWorkAgentRef(
  member: RoomMemberDto | undefined,
  currentUserId: UserId,
  fallback: {
    readonly id: string;
    readonly name: string;
    readonly platform: AgentPlatform;
  },
): WorkAgentRef {
  if (member !== undefined && member.memberKind === "agent" && member.agentId !== undefined) {
    return {
      agentId: member.agentId,
      displayName: member.displayName,
      platform: member.platform ?? "custom",
      isOwnedByViewer: member.ownerUserId === currentUserId,
      ownerDisplayName: member.ownerDisplayName,
    };
  }
  return {
    agentId: fallback.id as AgentId,
    displayName: fallback.name,
    platform: fallback.platform,
    isOwnedByViewer: true,
    ownerDisplayName: getWorkbenchTranslator().t("owner.you"),
  };
}

function resolveShowcaseRoster(
  members: ReadonlyArray<RoomMemberDto>,
  currentUserId: UserId,
): {
  readonly coordinator: WorkAgentRef;
  readonly workerA: WorkAgentRef;
  readonly workerB: WorkAgentRef;
  readonly verifier: WorkAgentRef;
} {
  const agents = members.filter((m) => m.memberKind === "agent" && m.agentId !== undefined);
  // 优先挑选中不同平台角色以直观呈现 OpenHuddle 独有的「跨厂商异构蜂群与交叉审查」
  const agy = agents.find((a) => a.platform === "antigravity") ?? agents[0];
  const codex =
    agents.find((a) => a.platform === "codex" && a.agentId !== agy?.agentId) ??
    agents.find((a) => a.agentId !== agy?.agentId) ??
    agents[1];
  const claude =
    agents.find(
      (a) =>
        a.platform === "claude_code" && a.agentId !== agy?.agentId && a.agentId !== codex?.agentId,
    ) ??
    agents.find((a) => a.agentId !== agy?.agentId && a.agentId !== codex?.agentId) ??
    agents[2];

  const coordinator = toWorkAgentRef(agy, currentUserId, {
    id: "agt_demo_agy",
    name: "Antigravity",
    platform: "antigravity",
  });
  const workerA = toWorkAgentRef(codex, currentUserId, {
    id: "agt_demo_codex",
    name: "OpenAI-Codex",
    platform: "codex",
  });
  const workerB = toWorkAgentRef(claude, currentUserId, {
    id: "agt_demo_claude",
    name: "Claude-Code",
    platform: "claude_code",
  });
  const verifier =
    agents.length >= 3
      ? coordinator
      : toWorkAgentRef(claude ?? agy, currentUserId, {
          id: "agt_demo_verifier",
          name: "Claude-Verifier",
          platform: "claude_code",
        });

  return { coordinator, workerA, workerB, verifier };
}

function summarizeTitle(rawPrompt: string): string {
  const { t } = getWorkbenchTranslator();
  const firstLine = rawPrompt.split(/\r?\n/)[0]?.trim() ?? t("task.defaultRunTitle");
  const cleaned = firstLine.replace(/^\/(?:task|verify|swarm)\s+/i, "").trim();
  if (cleaned.length <= 46) {
    return cleaned || t("task.defaultCollabTitle");
  }
  return `${cleaned.slice(0, 45).trim()}…`;
}

/**
 * 更新房间默认统筹/验证角色或 SuperAgent 主动门禁档位。
 *
 * @param roomId - 房间 ID
 * @param patch - 局部默认配置更新
 */
export function updateRoomOrchestrationDefaults(
  roomId: RoomId,
  patch: Partial<RoomOrchestrationDefaults>,
): void {
  const { t } = getWorkbenchTranslator();
  const bucket = getRoomBucket(roomId);
  const nextDefaults: RoomOrchestrationDefaults = {
    ...bucket.defaults,
    ...patch,
  };
  const nextObserveLogs: ReadonlyArray<ObserveDryRunEntry> =
    patch.intakeMode === "observe" && bucket.observeLogs.length === 0
      ? [
          {
            id: `obs-${Date.now().toString(36)}`,
            triggerSnippet: t("roomWork.observe.triggerSnippet"),
            suggestedTopology: "verify_loop",
            suggestedAssigneeName: t("roomWork.observe.assignee"),
            reason: t("roomWork.observe.reason"),
            recordedAtIso: new Date().toISOString(),
          },
        ]
      : bucket.observeLogs;

  setRoomBucket(roomId, {
    ...bucket,
    defaults: nextDefaults,
    observeLogs: nextObserveLogs,
  });
}

/**
 * 从底部输入舱、提案卡或消息右键菜单发起一张真实可交互的多 Agent 工单。
 *
 * @param params - 房间上下文、锚点序号、用户任务描述与选定的编排拓扑
 * @returns 新建的工单视图对象
 */
export function dispatchRoomWorkItem(params: {
  readonly roomId: RoomId;
  readonly anchorSeq: number;
  readonly content: string;
  readonly members: ReadonlyArray<RoomMemberDto>;
  readonly currentUserId: UserId;
  readonly payload: DispatchWorkPayload;
}): RoomWorkItemView {
  const roster = resolveShowcaseRoster(params.members, params.currentUserId);
  const findMember = (id: AgentId | undefined): RoomMemberDto | undefined =>
    id !== undefined
      ? params.members.find((m) => m.memberKind === "agent" && m.agentId === id)
      : undefined;

  const coordinator =
    params.payload.topology === "swarm"
      ? toWorkAgentRef(findMember(params.payload.coordinatorAgentId), params.currentUserId, {
          id: roster.coordinator.agentId,
          name: roster.coordinator.displayName,
          platform: roster.coordinator.platform,
        })
      : undefined;

  const primaryWorker = toWorkAgentRef(
    findMember(params.payload.executorAgentId),
    params.currentUserId,
    {
      id: roster.workerA.agentId,
      name: roster.workerA.displayName,
      platform: roster.workerA.platform,
    },
  );

  const verifier =
    params.payload.topology !== "direct"
      ? toWorkAgentRef(findMember(params.payload.verifierAgentId), params.currentUserId, {
          id: roster.verifier.agentId,
          name: roster.verifier.displayName,
          platform: roster.verifier.platform,
        })
      : undefined;

  // Owner-First 硬边界：若选中的执行者不属于当前登录主人，强制降级为 chat_only
  const effectiveTier = primaryWorker.isOwnedByViewer ? params.payload.tier : "chat_only";
  const nowIso = new Date().toISOString();
  const id = `wrk_${Date.now().toString(36)}`;
  const title = summarizeTitle(params.content);

  const { t } = getWorkbenchTranslator();
  const slices: ReadonlyArray<WorkSliceNode> =
    params.payload.topology === "swarm"
      ? [
          {
            sliceId: `${id}-s1`,
            title: t("roomWork.swarmSlice1Title"),
            worker: primaryWorker,
            ownedPaths: ["packages/core-governance/**", "packages/protocol/**"],
            status: "running",
            liveSummary:
              effectiveTier === "worktree_write"
                ? t("roomWork.swarmSlice1LiveWrite")
                : t("roomWork.swarmSlice1LiveRead"),
            elapsedSec: 2,
            steerNotes: [],
          },
          {
            sliceId: `${id}-s2`,
            title: t("roomWork.swarmSlice2Title"),
            worker:
              roster.workerB.agentId === primaryWorker.agentId
                ? roster.coordinator
                : roster.workerB,
            ownedPaths: ["apps/server/src/modules/**"],
            status: "running",
            liveSummary: t("roomWork.swarmSlice2Live"),
            elapsedSec: 1,
            steerNotes: [],
          },
        ]
      : [
          {
            sliceId: `${id}-s1`,
            title,
            worker: primaryWorker,
            ownedPaths:
              effectiveTier === "worktree_write"
                ? ["apps/server/**", "packages/**"]
                : [t("roomWork.readOnlyContext")],
            status: "running",
            liveSummary:
              effectiveTier === "worktree_write"
                ? t("roomWork.singleLiveWrite")
                : t("roomWork.singleLiveRead"),
            elapsedSec: 1,
            steerNotes: [],
          },
        ];

  const created: RoomWorkItemView = {
    id,
    roomId: params.roomId,
    anchorSeq: params.anchorSeq,
    title,
    brief: params.content.trim(),
    topology: params.payload.topology,
    tier: effectiveTier,
    stage: "working",
    ...(coordinator !== undefined ? { coordinator } : {}),
    primaryWorker,
    ...(verifier !== undefined ? { verifier } : {}),
    slices,
    ...(params.payload.linkedSoloTaskId !== undefined
      ? { linkedSoloTaskId: params.payload.linkedSoloTaskId }
      : {}),
    createdAtIso: nowIso,
    updatedAtIso: nowIso,
  };

  const bucket = getRoomBucket(params.roomId);
  setRoomBucket(params.roomId, {
    ...bucket,
    items: [created, ...bucket.items],
  });
  return created;
}

/**
 * 向正在执行的工单分片实时注入人类纠偏指令（Mid-Run Steering）。
 *
 * @param roomId - 房间 ID
 * @param workItemId - 工单 ID
 * @param sliceId - 目标分片 ID（缺省作用于首个活跃分片）
 * @param note - 纠偏说明文本
 */
export function steerRoomWorkSlice(
  roomId: RoomId,
  workItemId: string,
  note: string,
  sliceId?: string | undefined,
): void {
  const clean = note.trim();
  if (clean.length === 0) {
    return;
  }
  const { t } = getWorkbenchTranslator();
  const bucket = getRoomBucket(roomId);
  const matched = bucket.items.find((i) => i.id === workItemId);
  const nowIso = new Date().toISOString();
  const snippet = `${clean.slice(0, 28)}${clean.length > 28 ? "…" : ""}`;
  setRoomBucket(roomId, {
    ...bucket,
    items: bucket.items.map((item) => {
      if (item.id !== workItemId) {
        return item;
      }
      const targetSliceId =
        sliceId ??
        item.slices.find((s) => s.status === "running" || s.status === "verifying")?.sliceId ??
        item.slices[0]?.sliceId;
      return {
        ...item,
        updatedAtIso: nowIso,
        slices: item.slices.map((s) =>
          s.sliceId === targetSliceId
            ? {
                ...s,
                steerNotes: [...s.steerNotes, clean],
                liveSummary: t("roomWork.steered", { snippet }),
              }
            : s,
        ),
      };
    }),
  });
  if (matched?.linkedSoloTaskId !== undefined) {
    notifyMirror({ type: "steer", soloTaskId: matched.linkedSoloTaskId, note: clean });
  }
}

/**
 * 人工中止正在运行的工单（立即释放运行槽位，转为 `cancelled`）。
 */
export function stopRoomWorkItem(roomId: RoomId, workItemId: string): void {
  const { t } = getWorkbenchTranslator();
  const bucket = getRoomBucket(roomId);
  const matched = bucket.items.find((i) => i.id === workItemId);
  const nowIso = new Date().toISOString();
  setRoomBucket(roomId, {
    ...bucket,
    items: bucket.items.map((item) => {
      if (item.id !== workItemId) {
        return item;
      }
      const { attention: _pendingAttention, ...itemWithoutAttention } = item;
      const hasPendingAttention =
        item.attention !== undefined && item.attention.answeredChoice === undefined;
      return {
        ...(hasPendingAttention ? itemWithoutAttention : item),
        stage: "cancelled" as WorkStage,
        updatedAtIso: nowIso,
        slices: item.slices.map((s) =>
          s.status === "running" || s.status === "waiting" || s.status === "verifying"
            ? { ...s, status: "blocked", liveSummary: t("roomWork.stoppedByOwner") }
            : s,
        ),
      };
    }),
  });
  if (matched?.linkedSoloTaskId !== undefined) {
    notifyMirror({ type: "stop", soloTaskId: matched.linkedSoloTaskId });
  }
}

/**
 * 回答受托 Worker 的单问 `Attention` 卡片，立即恢复该工单继续执行。
 */
export function answerRoomWorkAttention(roomId: RoomId, workItemId: string, choice: string): void {
  const { t } = getWorkbenchTranslator();
  const bucket = getRoomBucket(roomId);
  const matched = bucket.items.find((i) => i.id === workItemId);
  const nowIso = new Date().toISOString();
  setRoomBucket(roomId, {
    ...bucket,
    items: bucket.items.map((item) => {
      if (item.id !== workItemId || item.attention === undefined) {
        return item;
      }
      return {
        ...item,
        stage: "working",
        updatedAtIso: nowIso,
        attention: {
          ...item.attention,
          answeredChoice: choice,
        },
        slices: item.slices.map((s, idx) =>
          idx === 0
            ? {
                ...s,
                status: "running",
                liveSummary: t("roomWork.resumedWithChoice", { choice }),
              }
            : s,
        ),
      };
    }),
  });
  if (matched?.linkedSoloTaskId !== undefined) {
    notifyMirror({ type: "answer", soloTaskId: matched.linkedSoloTaskId, choice });
  }
}

/**
 * 人类主人一键签收或要求微调处于 `awaiting_review` 的交付工单。
 */
export function decideRoomWorkReview(
  roomId: RoomId,
  workItemId: string,
  decision: "approve" | "rework",
  reworkNote?: string | undefined,
): void {
  const { t } = getWorkbenchTranslator();
  const bucket = getRoomBucket(roomId);
  const matched = bucket.items.find((i) => i.id === workItemId);
  const nowIso = new Date().toISOString();
  setRoomBucket(roomId, {
    ...bucket,
    items: bucket.items.map((item) => {
      if (item.id !== workItemId) {
        return item;
      }
      if (decision === "approve") {
        return {
          ...item,
          stage: "done",
          updatedAtIso: nowIso,
          slices: item.slices.map((s) => ({
            ...s,
            status: "ready",
            liveSummary: t("roomWork.approvedByOwner"),
          })),
        };
      }
      const note = reworkNote?.trim() || t("roomWork.defaultReworkNote");
      return {
        ...item,
        stage: "working",
        updatedAtIso: nowIso,
        slices: item.slices.map((s, idx) =>
          idx === 0
            ? {
                ...s,
                status: "running",
                elapsedSec: 1,
                steerNotes: [...s.steerNotes, note],
                liveSummary: t("roomWork.reworking", { snippet: note.slice(0, 26) }),
              }
            : s,
        ),
      };
    }),
  });
  if (matched?.linkedSoloTaskId !== undefined) {
    notifyMirror({
      type: "review",
      soloTaskId: matched.linkedSoloTaskId,
      decision,
      ...(reworkNote !== undefined ? { note: reworkNote } : {}),
    });
  }
}

/**
 * 重试受阻或已中止的工单（保留原上下文与 Worktree 目录连续性）。
 */
export function retryRoomWorkItem(roomId: RoomId, workItemId: string): void {
  const { t } = getWorkbenchTranslator();
  const bucket = getRoomBucket(roomId);
  const matched = bucket.items.find((i) => i.id === workItemId);
  const nowIso = new Date().toISOString();
  setRoomBucket(roomId, {
    ...bucket,
    items: bucket.items.map((item) =>
      item.id === workItemId
        ? {
            ...item,
            stage: "working",
            updatedAtIso: nowIso,
            slices: item.slices.map((s) => ({
              ...s,
              status: "running",
              elapsedSec: 1,
              failureCode: undefined,
              liveSummary: t("roomWork.retriedWorktree"),
            })),
          }
        : item,
    ),
  });
  if (matched?.linkedSoloTaskId !== undefined) {
    notifyMirror({ type: "retry", soloTaskId: matched.linkedSoloTaskId });
  }
}

/**
 * 清空当前房间的演示/临时工单，恢复零打扰静默初始态。
 */
export function clearRoomWorkItems(roomId: RoomId): void {
  const bucket = getRoomBucket(roomId);
  setRoomBucket(roomId, {
    ...bucket,
    items: [],
  });
}

/**
 * 一键载入典型多状态样式预览数据（自动绑定当前房间的真实 Agent 头像与昵称），
 * 方便直接对比「蜂群并行运行中」「Needs You 待签收+单问停顿」「纵向主从交叉审查」在日光与暗夜主题下的表现。
 */
export function loadRoomWorkShowcase(params: {
  readonly roomId: RoomId;
  readonly preset: WorkShowcasePreset;
  readonly latestSeq: number;
  readonly members: ReadonlyArray<RoomMemberDto>;
  readonly currentUserId: UserId;
}): void {
  const { t } = getWorkbenchTranslator();
  const { coordinator, workerA, workerB, verifier } = resolveShowcaseRoster(
    params.members,
    params.currentUserId,
  );
  const nowIso = new Date().toISOString();
  const anchorA = Math.max(0, params.latestSeq - 1);
  const anchorB = params.latestSeq;

  const swarmLiveItem: RoomWorkItemView = {
    id: "wrk_showcase_swarm",
    roomId: params.roomId,
    anchorSeq: anchorB,
    title: t("roomWork.showcase.swarmTitle"),
    brief: t("roomWork.showcase.swarmBrief"),
    topology: "swarm",
    tier: "worktree_write",
    stage: "working",
    coordinator,
    primaryWorker: workerA,
    verifier,
    slices: [
      {
        sliceId: "sl_1",
        title: t("roomWork.showcase.swarmSlice1Title"),
        worker: workerA,
        ownedPaths: ["packages/core-governance/**"],
        status: "running",
        liveSummary: t("roomWork.showcase.swarmSlice1Live"),
        elapsedSec: 16,
        diffAdded: 142,
        diffRemoved: 18,
        steerNotes: [],
      },
      {
        sliceId: "sl_2",
        title: t("roomWork.showcase.swarmSlice2Title"),
        worker: workerB,
        ownedPaths: ["packages/db/**", "apps/server/src/modules/work/**"],
        status: "ready",
        liveSummary: t("roomWork.showcase.swarmSlice2Live"),
        elapsedSec: 23,
        diffAdded: 186,
        diffRemoved: 22,
        steerNotes: [],
      },
    ],
    createdAtIso: nowIso,
    updatedAtIso: nowIso,
  };

  const reviewReadyItem: RoomWorkItemView = {
    id: "wrk_showcase_review",
    roomId: params.roomId,
    anchorSeq: anchorA,
    title: t("roomWork.showcase.reviewTitle"),
    brief: t("roomWork.showcase.reviewBrief"),
    topology: "verify_loop",
    tier: "worktree_write",
    stage: "awaiting_review",
    primaryWorker: workerA,
    verifier,
    slices: [
      {
        sliceId: "sl_rev_1",
        title: t("roomWork.showcase.reviewSliceTitle"),
        worker: workerA,
        ownedPaths: ["packages/cli/src/sse-listener.ts"],
        status: "ready",
        liveSummary: t("roomWork.showcase.reviewSliceLive"),
        elapsedSec: 29,
        diffAdded: 94,
        diffRemoved: 27,
        steerNotes: [],
      },
    ],
    review: {
      filesChanged: 2,
      additions: 94,
      deletions: 27,
      changedFiles: [
        "packages/cli/src/sse-listener.ts",
        "packages/cli/src/__tests__/listener-identity.test.ts",
      ],
      testCommand: "pnpm --filter @openhuddle/cli test",
      testPassed: true,
      worktreeBranch: "huddle/wrk-sse-coalesce",
      verifierNote: t("roomWork.showcase.reviewVerifierNote", { verifier: verifier.displayName }),
      verifyLoopsUsed: 1,
    },
    createdAtIso: nowIso,
    updatedAtIso: nowIso,
  };

  const attentionItem: RoomWorkItemView = {
    id: "wrk_showcase_attn",
    roomId: params.roomId,
    anchorSeq: anchorB,
    title: t("roomWork.showcase.attnTitle"),
    brief: t("roomWork.showcase.attnBrief"),
    topology: "direct",
    tier: "worktree_write",
    stage: "awaiting_answer",
    primaryWorker: workerB,
    slices: [
      {
        sliceId: "sl_attn_1",
        title: t("roomWork.showcase.attnSliceTitle"),
        worker: workerB,
        ownedPaths: ["packages/cli/src/worktree-pool.ts"],
        status: "waiting",
        liveSummary: t("roomWork.showcase.attnSliceLive"),
        elapsedSec: 8,
        steerNotes: [],
      },
    ],
    attention: {
      question: t("roomWork.showcase.attnQuestion"),
      askedBy: workerB,
      options: [
        t("roomWork.showcase.attnOpt1"),
        t("roomWork.showcase.attnOpt2"),
        t("roomWork.showcase.attnOpt3"),
      ],
    },
    createdAtIso: nowIso,
    updatedAtIso: nowIso,
  };

  const items: ReadonlyArray<RoomWorkItemView> =
    params.preset === "swarm_live"
      ? [swarmLiveItem, reviewReadyItem]
      : params.preset === "needs_you"
        ? [attentionItem, reviewReadyItem]
        : [
            {
              ...reviewReadyItem,
              id: "wrk_showcase_verifying",
              stage: "verifying",
              slices: reviewReadyItem.slices.map((s) => ({
                ...s,
                status: "verifying",
                liveSummary: t("roomWork.showcase.verifyingLive", {
                  verifier: verifier.displayName,
                }),
              })),
            },
          ];

  const bucket = getRoomBucket(params.roomId);
  setRoomBucket(params.roomId, {
    ...bucket,
    defaults: {
      coordinatorAgentId: coordinator.agentId,
      verifierAgentId: verifier.agentId,
      intakeMode: bucket.defaults.intakeMode,
    },
    items,
  });
}

function advanceRunningTimers(): void {
  const { t } = getWorkbenchTranslator();
  let mutated = false;
  const nowIso = new Date().toISOString();

  for (const [roomId, bucket] of bucketsByRoom.entries()) {
    const hasActive = bucket.items.some(
      (item) => item.stage === "working" || item.stage === "verifying",
    );
    if (!hasActive) {
      continue;
    }
    mutated = true;
    const nextItems = bucket.items.map((item): RoomWorkItemView => {
      if (item.stage !== "working" && item.stage !== "verifying") {
        return item;
      }
      const nextSlices = item.slices.map((slice): WorkSliceNode => {
        if (slice.status !== "running" && slice.status !== "verifying") {
          return slice;
        }
        const nextSec = slice.elapsedSec + 1;
        // 用户真实从输入框新建的工单（非固定 showcase）在跑满约 12s 后平滑推进到 @verifier 核验 → 待签收，完整呈现零中转快路径！
        const isLiveUserItem = !item.id.startsWith("wrk_showcase_");
        if (isLiveUserItem && slice.status === "running" && nextSec >= 9) {
          return {
            ...slice,
            elapsedSec: nextSec,
            status: item.verifier !== undefined ? "verifying" : "ready",
            diffAdded: slice.diffAdded ?? 64,
            diffRemoved: slice.diffRemoved ?? 11,
            liveSummary:
              item.verifier !== undefined
                ? t("roomWork.timer.pushedVerify", { verifier: item.verifier.displayName })
                : t("roomWork.timer.pushedReview"),
          };
        }
        if (isLiveUserItem && slice.status === "verifying" && nextSec >= 14) {
          return {
            ...slice,
            elapsedSec: nextSec,
            status: "ready",
            liveSummary: t("roomWork.timer.verifiedOk", {
              verifier: item.verifier?.displayName ?? "Verifier",
            }),
          };
        }
        return {
          ...slice,
          elapsedSec: nextSec,
        };
      });

      const allReady = nextSlices.every((s) => s.status === "ready");
      const anyVerifying = nextSlices.some((s) => s.status === "verifying");
      const nextStage: WorkStage = allReady
        ? "awaiting_review"
        : anyVerifying
          ? "verifying"
          : item.stage;

      return {
        ...item,
        stage: nextStage,
        updatedAtIso: nowIso,
        slices: nextSlices,
        ...(allReady && item.review === undefined
          ? {
              review: {
                filesChanged: item.topology === "swarm" ? 4 : 2,
                additions: nextSlices.reduce((acc, s) => acc + (s.diffAdded ?? 48), 0),
                deletions: nextSlices.reduce((acc, s) => acc + (s.diffRemoved ?? 9), 0),
                changedFiles: nextSlices.flatMap((s) =>
                  s.ownedPaths.map((p) => p.replace(/\/\*\*$/, "/index.ts")),
                ),
                testCommand: "pnpm verify",
                testPassed: true,
                ...(item.tier === "worktree_write" ? { worktreeBranch: `huddle/${item.id}` } : {}),
                ...(item.verifier !== undefined
                  ? {
                      verifierNote: t("roomWork.timer.verifierNote", {
                        verifier: item.verifier.displayName,
                      }),
                    }
                  : {}),
                verifyLoopsUsed: item.verifier !== undefined ? 1 : 0,
              },
            }
          : {}),
      };
    });

    bucketsByRoom.set(roomId, {
      ...bucket,
      items: nextItems,
    });
  }

  if (mutated) {
    syncRoomTicker();
    emitChange();
  } else {
    syncRoomTicker();
  }
}

let activeTickerSubscribers = 0;
let tickerHandle: number | null = null;

function hasAnyRunningRoomItems(): boolean {
  for (const bucket of bucketsByRoom.values()) {
    if (bucket.items.some((item) => item.stage === "working" || item.stage === "verifying")) {
      return true;
    }
  }
  return false;
}

function syncRoomTicker(): void {
  if (typeof window === "undefined") {
    return;
  }
  const shouldRun = activeTickerSubscribers > 0 && hasAnyRunningRoomItems();
  if (shouldRun && tickerHandle === null) {
    tickerHandle = window.setInterval(advanceRunningTimers, 1_000);
  } else if (!shouldRun && tickerHandle !== null) {
    window.clearInterval(tickerHandle);
    tickerHandle = null;
  }
}

function ensureTickerRunning(): () => void {
  activeTickerSubscribers += 1;
  syncRoomTicker();
  return () => {
    activeTickerSubscribers = Math.max(0, activeTickerSubscribers - 1);
    syncRoomTicker();
  };
}

/**
 * 订阅指定房间的多 Agent 工单状态、活跃运行统计与「待你确认（Needs You）」计数。
 *
 * @param roomId - 当前激活的房间 ID
 * @returns 房间工单快照与派生聚合计数
 */
export function useRoomWorkState(roomId: RoomId): {
  readonly defaults: RoomOrchestrationDefaults;
  readonly items: ReadonlyArray<RoomWorkItemView>;
  readonly observeLogs: ReadonlyArray<ObserveDryRunEntry>;
  readonly activeRunningItems: ReadonlyArray<RoomWorkItemView>;
  readonly needsHumanItems: ReadonlyArray<RoomWorkItemView>;
  readonly setIntakeMode: (mode: SuperAgentIntakeMode) => void;
  readonly setTopologyDefaults: (patch: Partial<RoomOrchestrationDefaults>) => void;
} {
  const bucket = useSyncExternalStore(
    subscribe,
    () => getRoomBucket(roomId),
    () => EMPTY_BUCKET,
  );

  useEffect(() => ensureTickerRunning(), []);

  const activeRunningItems = bucket.items.filter(
    (item) => item.stage === "working" || item.stage === "verifying",
  );
  const needsHumanItems = bucket.items.filter(
    (item) =>
      item.stage === "awaiting_answer" ||
      item.stage === "awaiting_review" ||
      item.stage === "blocked",
  );

  const setIntakeMode = useCallback(
    (intakeMode: SuperAgentIntakeMode) => {
      updateRoomOrchestrationDefaults(roomId, { intakeMode });
    },
    [roomId],
  );

  const setTopologyDefaults = useCallback(
    (patch: Partial<RoomOrchestrationDefaults>) => {
      updateRoomOrchestrationDefaults(roomId, patch);
    },
    [roomId],
  );

  return {
    defaults: bucket.defaults,
    items: bucket.items,
    observeLogs: bucket.observeLogs,
    activeRunningItems,
    needsHumanItems,
    setIntakeMode,
    setTopologyDefaults,
  };
}
