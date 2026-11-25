/**
 * @module web/features/huddle-room/work/solo-workbench-fixtures
 * @description 个人工作台默认预置工作区、示例多文件 Unified Diff 与演示工单构造器（与状态流转逻辑解耦）。
 */
import type { AgentId, AgentPlatform, OwnedAgentSummaryDto } from "@openhuddle/protocol";
import type { AgentWorkspace, SoloDiffFile, SoloWorkTaskView } from "./solo-workbench-store.js";
import type { WorkAgentRef, WorkSliceProvenance } from "./work-types.js";

/** 默认预置的三类典型工作区（单代码仓、多目录组合、普通文档文件夹） */
export const DEFAULT_WORKSPACES: ReadonlyArray<AgentWorkspace> = [
  {
    id: "repo_openhuddle",
    name: "OpenHuddle",
    kind: "git_repo",
    roots: [
      {
        id: "root_openhuddle_main",
        name: "OpenHuddle",
        localPath: "~/Developer/OpenHuddle",
        isGitRepo: true,
        defaultBranch: "master",
        remoteSlug: "github.com/openhuddle/openhuddle",
      },
    ],
    localPath: "~/Developer/OpenHuddle",
    defaultBranch: "master",
    host: {
      mode: "local_machine",
      hostLabel: "本机 Mac",
      online: true,
    },
    sandboxMode: "worktree_pool",
    prewarmedWorktrees: 3,
    hooks: {
      setupCommand: "pnpm install --prefer-offline",
      verifyCommand: "pnpm verify",
      copyEnvGlobs: [".env.local"],
    },
    context: {
      ruleFiles: ["AGENTS.md"],
      skillCount: 2,
      sharedMemoryActive: true,
    },
    defaultTopology: "verify_loop",
  },
  {
    id: "ws_multi_sdk",
    name: "跨端底座联调",
    kind: "multi_root",
    roots: [
      {
        id: "root_daemon_kit",
        name: "agent-daemon-kit",
        localPath: "~/Developer/agent-daemon-kit",
        isGitRepo: true,
        defaultBranch: "main",
        remoteSlug: "github.com/openhuddle/agent-daemon-kit",
      },
      {
        id: "root_desktop_shell",
        name: "openhuddle-desktop",
        localPath: "~/Developer/openhuddle-desktop",
        isGitRepo: true,
        defaultBranch: "main",
        remoteSlug: "github.com/openhuddle/openhuddle-desktop",
      },
    ],
    localPath: "~/Developer/agent-daemon-kit",
    defaultBranch: "main",
    host: {
      mode: "personal_remote",
      hostLabel: "远程主力沙箱",
      online: true,
    },
    sandboxMode: "worktree_pool",
    prewarmedWorktrees: 2,
    hooks: {
      setupCommand: "pnpm install && cargo fetch",
      verifyCommand: "pnpm test && cargo check",
      copyEnvGlobs: [".env.development"],
    },
    context: {
      ruleFiles: ["AGENTS.md", "CLAUDE.md"],
      skillCount: 1,
      sharedMemoryActive: true,
    },
    defaultTopology: "swarm",
  },
  {
    id: "ws_product_docs",
    name: "产品与架构文档",
    kind: "folder",
    roots: [
      {
        id: "root_specs_folder",
        name: "OpenHuddle-Specs",
        localPath: "~/Documents/OpenHuddle-Specs",
        isGitRepo: false,
      },
    ],
    localPath: "~/Documents/OpenHuddle-Specs",
    defaultBranch: "—",
    host: {
      mode: "local_machine",
      hostLabel: "本机 Mac",
      online: true,
    },
    sandboxMode: "in_place",
    prewarmedWorktrees: 0,
    hooks: {},
    context: {
      ruleFiles: ["CLAUDE.md"],
      skillCount: 0,
      sharedMemoryActive: false,
    },
    defaultTopology: "direct",
  },
];

/**
 * 将已接入的个人 Agent 转换为工单执行引用；缺省回退至演示占位身份。
 */
export function toOwnedWorkAgentRef(
  agent: OwnedAgentSummaryDto | undefined,
  ownerDisplayName: string,
  fallback: {
    readonly id: string;
    readonly name: string;
    readonly platform: AgentPlatform;
  },
): WorkAgentRef {
  if (agent !== undefined) {
    return {
      agentId: agent.id,
      displayName: agent.displayName,
      platform: agent.platform,
      isOwnedByViewer: true,
      ownerDisplayName,
    };
  }
  return {
    agentId: fallback.id as AgentId,
    displayName: fallback.name,
    platform: fallback.platform,
    isOwnedByViewer: true,
    ownerDisplayName,
  };
}

/**
 * 从当前用户名下的 Agent 列表中挑选统筹、双路执行与复核角色。
 */
export function resolveSoloFleet(
  ownedAgents: ReadonlyArray<OwnedAgentSummaryDto>,
  ownerDisplayName: string,
): {
  readonly coordinator: WorkAgentRef;
  readonly workerA: WorkAgentRef;
  readonly workerB: WorkAgentRef;
  readonly verifier: WorkAgentRef;
} {
  const agy = ownedAgents.find((a) => a.platform === "antigravity") ?? ownedAgents[0];
  const codex =
    ownedAgents.find((a) => a.platform === "codex" && a.id !== agy?.id) ??
    ownedAgents.find((a) => a.id !== agy?.id);
  const claude =
    ownedAgents.find(
      (a) => a.platform === "claude_code" && a.id !== agy?.id && a.id !== codex?.id,
    ) ?? ownedAgents.find((a) => a.id !== agy?.id && a.id !== codex?.id);
  const deepseek =
    ownedAgents.find(
      (a) =>
        a.platform === "deepseek" && a.id !== agy?.id && a.id !== codex?.id && a.id !== claude?.id,
    ) ?? ownedAgents.find((a) => a.id !== agy?.id && a.id !== codex?.id && a.id !== claude?.id);

  return {
    coordinator: toOwnedWorkAgentRef(agy, ownerDisplayName, {
      id: "agt_solo_agy",
      name: "Antigravity",
      platform: "antigravity",
    }),
    workerA: toOwnedWorkAgentRef(codex, ownerDisplayName, {
      id: "agt_solo_codex",
      name: "OpenAI-Codex",
      platform: "codex",
    }),
    workerB: toOwnedWorkAgentRef(claude, ownerDisplayName, {
      id: "agt_solo_claude",
      name: "Claude-Code",
      platform: "claude_code",
    }),
    verifier: toOwnedWorkAgentRef(deepseek ?? claude, ownerDisplayName, {
      id: "agt_solo_verifier",
      name: "Claude-Verifier",
      platform: "claude_code",
    }),
  };
}

/**
 * 生成分片仓外执行记录（Out-of-Repo Provenance）路径元数据。
 */
export function buildSliceProvenance(params: {
  readonly agent: WorkAgentRef;
  readonly workspaceId: string;
  readonly taskId: string;
  readonly leaseRole: "write" | "verify" | "read";
  readonly gitNotesAttached: boolean;
  readonly agentEnvironment?: string | undefined;
}): WorkSliceProvenance {
  const slug =
    params.agent.displayName
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || params.agent.platform;
  const envLabel =
    params.agentEnvironment ??
    (params.agent.platform === "codex"
      ? "云开发机 CLI"
      : params.agent.platform === "claude_code"
        ? "本机 Mac 守护"
        : "本机 IDE 宿主");
  return {
    agentEnvironment: envLabel,
    leaseRole: params.leaseRole,
    sessionJsonlPath: `~/.openhuddle/agents/${slug}/sessions/${params.workspaceId}/${params.taskId}.jsonl`,
    rollingMemoryPath: `~/.openhuddle/agents/${slug}/memory/${params.workspaceId}/MEMORY.md`,
    gitNotesAttached: params.gitNotesAttached,
  };
}

const SAMPLE_SSE_DIFF_FILES: ReadonlyArray<SoloDiffFile> = [
  {
    path: "apps/web/src/lib/sse-sync.ts",
    additions: 24,
    deletions: 7,
    lines: [
      {
        kind: "hunk",
        content:
          "@@ -82,11 +82,21 @@ export function computeReconnectDelayMs(attempt: number): number {",
      },
      {
        kind: "context",
        oldLine: 82,
        newLine: 82,
        content: "  const clampedAttempt = Math.min(Math.max(0, attempt), 6);",
      },
      {
        kind: "del",
        oldLine: 83,
        content: "  return Math.min(15_000, 1_000 * 2 ** clampedAttempt);",
      },
      {
        kind: "add",
        newLine: 83,
        content: "  const baseDelayMs = Math.min(12_000, 600 * 2 ** clampedAttempt);",
      },
      {
        kind: "add",
        newLine: 84,
        content: "  // 引入 ±20% 去同步抖动，防止单机多标签页唤醒时瞬间并发风暴",
      },
      { kind: "add", newLine: 85, content: "  const jitterFactor = 0.8 + (attempt % 5) * 0.1;" },
      { kind: "add", newLine: 86, content: "  return Math.round(baseDelayMs * jitterFactor);" },
      { kind: "context", oldLine: 84, newLine: 87, content: "}" },
      {
        kind: "hunk",
        content: "@@ -148,8 +158,15 @@ export function mergeConfirmedMessageIntoCache(",
      },
      {
        kind: "context",
        oldLine: 148,
        newLine: 158,
        content: "  if (incoming.seq <= prev.latestSeq && alreadyConfirmed) {",
      },
      { kind: "del", oldLine: 149, content: "    return prev;" },
      {
        kind: "add",
        newLine: 159,
        content: "    // 断线补拉与 SSE 实时帧交错到达时只保留单调最高 latestSeq",
      },
      {
        kind: "add",
        newLine: 160,
        content: "    return { ...prev, latestSeq: Math.max(prev.latestSeq, incoming.seq) };",
      },
      { kind: "context", oldLine: 150, newLine: 161, content: "  }" },
    ],
  },
  {
    path: "apps/web/src/features/huddle-room/api/huddle-room.queries.ts",
    additions: 14,
    deletions: 5,
    lines: [
      { kind: "hunk", content: "@@ -122,9 +122,14 @@ function reconcileJoinedRoomSequences(" },
      {
        kind: "context",
        oldLine: 122,
        newLine: 122,
        content: "  const cachedById = new Map(cached.rooms.map((room) => [room.id, room]));",
      },
      { kind: "del", oldLine: 123, content: "  const rooms = incoming.rooms.map((room) => room);" },
      { kind: "add", newLine: 123, content: "  const rooms = incoming.rooms.map((room) => {" },
      { kind: "add", newLine: 124, content: "    const prev = cachedById.get(room.id);" },
      { kind: "add", newLine: 125, content: "    if (prev === undefined) return room;" },
      { kind: "add", newLine: 126, content: "    return {" },
      { kind: "add", newLine: 127, content: "      ...room," },
      {
        kind: "add",
        newLine: 128,
        content: "      lastSeq: Math.max(prev.lastSeq, room.lastSeq),",
      },
      {
        kind: "add",
        newLine: 129,
        content: "      yourLastReadSeq: Math.max(prev.yourLastReadSeq, room.yourLastReadSeq),",
      },
      { kind: "add", newLine: 130, content: "    };" },
      { kind: "add", newLine: 131, content: "  });" },
    ],
  },
  {
    path: "apps/web/src/__tests__/sse-sync.test.ts",
    additions: 10,
    deletions: 2,
    lines: [
      {
        kind: "hunk",
        content: "@@ -41,5 +41,13 @@ describe('SSE reconnect & monotonic cursor', () => {",
      },
      {
        kind: "context",
        oldLine: 41,
        newLine: 41,
        content: "  it('never regresses yourLastReadSeq when stale refetch resolves late', () => {",
      },
      { kind: "add", newLine: 42, content: "    const delay0 = computeReconnectDelayMs(0);" },
      { kind: "add", newLine: 43, content: "    const delay3 = computeReconnectDelayMs(3);" },
      { kind: "add", newLine: 44, content: "    expect(delay0).toBeGreaterThanOrEqual(480);" },
      { kind: "add", newLine: 45, content: "    expect(delay3).toBeLessThanOrEqual(12_000);" },
      { kind: "context", oldLine: 42, newLine: 46, content: "  });" },
    ],
  },
];

const SAMPLE_DARK_CONTRAST_DIFF_FILES: ReadonlyArray<SoloDiffFile> = [
  {
    path: "apps/web/src/styles.css",
    additions: 19,
    deletions: 11,
    lines: [
      { kind: "hunk", content: "@@ -214,8 +214,12 @@ .dark {" },
      { kind: "del", oldLine: 214, content: "  --oh-code-well: #0f172a;" },
      {
        kind: "add",
        newLine: 214,
        content: "  /* 中性烟熏石墨底色，移除冷蓝偏色 */",
      },
      { kind: "add", newLine: 215, content: "  --oh-code-well: #141417;" },
      { kind: "add", newLine: 216, content: "  --oh-bubble-peer: #1e1e22;" },
      { kind: "context", oldLine: 216, newLine: 217, content: "}" },
    ],
  },
  {
    path: "apps/web/src/components/ui/message-bubble.tsx",
    additions: 12,
    deletions: 8,
    lines: [
      {
        kind: "hunk",
        content: "@@ -312,7 +312,9 @@ export function MessageBubble(props: MessageBubbleProps) {",
      },
      { kind: "del", oldLine: 312, content: "  const codeBg = 'bg-slate-900 text-slate-100';" },
      {
        kind: "add",
        newLine: 312,
        content:
          "  const codeBg = 'bg-[#F4F5F8] text-[#181B22] dark:bg-[#141417] dark:text-[#ECECEF]';",
      },
      {
        kind: "context",
        oldLine: 313,
        newLine: 313,
        content: "  return <pre className={codeBg}>{props.code}</pre>;",
      },
    ],
  },
];

/**
 * 为用户在工作台新建的演示任务生成结构化示例 Diff。
 */
export function buildGeneratedDiffForPrompt(
  title: string,
  branchSlug: string,
): ReadonlyArray<SoloDiffFile> {
  const safeSlug = branchSlug.replace(/[^a-z0-9-_]/gi, "-").toLowerCase();
  return [
    {
      path: `packages/core-governance/src/${safeSlug}.ts`,
      additions: 28,
      deletions: 4,
      lines: [
        { kind: "hunk", content: "@@ -1,6 +1,22 @@" },
        { kind: "add", newLine: 1, content: "/**" },
        { kind: "add", newLine: 2, content: ` * @description 工单实现：${title}` },
        {
          kind: "add",
          newLine: 3,
          content: " * 纯函数边界：所有时间戳由调用方显式注入。",
        },
        { kind: "add", newLine: 4, content: " */" },
        { kind: "add", newLine: 5, content: "export interface ExecutionLeaseDecision {" },
        { kind: "add", newLine: 6, content: "  readonly allowed: boolean;" },
        { kind: "add", newLine: 7, content: "  readonly warmSessionReused: boolean;" },
        { kind: "add", newLine: 8, content: "}" },
        { kind: "add", newLine: 9, content: "" },
        {
          kind: "add",
          newLine: 10,
          content:
            "export function evaluateLeaseWindow(nowMs: number, expiresAtMs: number): ExecutionLeaseDecision {",
        },
        {
          kind: "add",
          newLine: 11,
          content: "  return { allowed: nowMs < expiresAtMs, warmSessionReused: true };",
        },
        { kind: "add", newLine: 12, content: "}" },
      ],
    },
    {
      path: `packages/core-governance/src/__tests__/${safeSlug}.test.ts`,
      additions: 14,
      deletions: 0,
      lines: [
        { kind: "hunk", content: "@@ -0,0 +1,14 @@" },
        { kind: "add", newLine: 1, content: "import { describe, expect, it } from 'vitest';" },
        {
          kind: "add",
          newLine: 2,
          content: `import { evaluateLeaseWindow } from '../${safeSlug}.js';`,
        },
        { kind: "add", newLine: 3, content: "" },
        { kind: "add", newLine: 4, content: "describe('evaluateLeaseWindow', () => {" },
        {
          kind: "add",
          newLine: 5,
          content: "  it('grants execution within active lease window', () => {",
        },
        {
          kind: "add",
          newLine: 6,
          content:
            "    expect(evaluateLeaseWindow(1_000, 5_000)).toEqual({ allowed: true, warmSessionReused: true });",
        },
        { kind: "add", newLine: 7, content: "  });" },
        { kind: "add", newLine: 8, content: "});" },
      ],
    },
  ];
}

/**
 * 构造个人工作台四类典型状态（待审阅、待确认、并行运行中、已签收）的示例工单。
 */
export function buildDefaultSoloTasks(
  ownedAgents: ReadonlyArray<OwnedAgentSummaryDto>,
  ownerDisplayName: string,
): ReadonlyArray<SoloWorkTaskView> {
  const fleet = resolveSoloFleet(ownedAgents, ownerDisplayName);
  const nowMs = Date.now();
  const iso = (offsetSec: number): string => new Date(nowMs + offsetSec * 1_000).toISOString();

  return [
    {
      id: "solo_wrk_review_01",
      title: "重构 RealtimeBus 重连指数退避与补拉幂等窗口",
      brief:
        "修复笔记本合盖唤醒后多标签页同时重连导致的瞬间请求抖动，并确保断网补拉与 SSE 实时帧交错时不回退未读游标。",
      repoId: "repo_openhuddle",
      repoName: "OpenHuddle",
      worktreeBranch: "huddle/solo-sse-backoff",
      topology: "verify_loop",
      tier: "worktree_write",
      stage: "awaiting_review",
      warmHitMs: 118,
      primaryWorker: fleet.workerA,
      verifier: fleet.verifier,
      slices: [
        {
          sliceId: "slc_sse_impl",
          title: "实现带去同步抖动的重连退避与游标单调合并",
          worker: fleet.workerA,
          ownedPaths: ["apps/web/src/lib/sse-sync.ts", "apps/web/src/features/huddle-room/api/"],
          status: "ready",
          liveSummary: "已完成代码修改与单测覆盖，移交独立审查",
          elapsedSec: 34,
          diffAdded: 48,
          diffRemoved: 14,
          steerNotes: [],
          provenance: buildSliceProvenance({
            agent: fleet.workerA,
            workspaceId: "repo_openhuddle",
            taskId: "solo_wrk_review_01",
            leaseRole: "write",
            gitNotesAttached: true,
          }),
        },
        {
          sliceId: "slc_sse_verify",
          title: "独立复核并发竞态与单测边界",
          worker: fleet.verifier,
          ownedPaths: ["apps/web/src/__tests__/sse-sync.test.ts"],
          status: "ready",
          liveSummary: "pnpm --filter @openhuddle/web test 全部通过",
          elapsedSec: 15,
          steerNotes: [],
          provenance: buildSliceProvenance({
            agent: fleet.verifier,
            workspaceId: "repo_openhuddle",
            taskId: "solo_wrk_review_01",
            leaseRole: "verify",
            gitNotesAttached: true,
          }),
        },
      ],
      review: {
        filesChanged: 3,
        additions: 48,
        deletions: 14,
        changedFiles: SAMPLE_SSE_DIFF_FILES.map((f) => f.path),
        testCommand: "pnpm --filter @openhuddle/web test",
        testPassed: true,
        worktreeBranch: "huddle/solo-sse-backoff",
        verifierNote:
          "已复核断网恢复竞态：当旧 refetch 晚于 SSE 帧返回时，reconcileJoinedRoomSequences 单调锁确保未读数不回退。",
        verifyLoopsUsed: 1,
      },
      diffFiles: SAMPLE_SSE_DIFF_FILES,
      createdAtIso: iso(-420),
      updatedAtIso: iso(-35),
    },
    {
      id: "solo_wrk_attn_02",
      title: "为本地守护器补充孤儿 git worktree 自动回收策略",
      brief:
        "扫描 ~/.openhuddle/worktrees 下超过租约有效期的残留工作树池目录，防止高频并发派活长期占用磁盘。",
      repoId: "ws_multi_sdk",
      repoName: "跨端底座联调",
      worktreeBranch: "huddle/solo-worktree-gc",
      topology: "direct",
      tier: "worktree_write",
      stage: "awaiting_answer",
      warmHitMs: 92,
      primaryWorker: fleet.coordinator,
      slices: [
        {
          sliceId: "slc_wt_gc",
          title: "实现 openhuddle.mjs 工作树池空闲巡检与回收器",
          worker: fleet.coordinator,
          ownedPaths: ["packages/cli/src/worktree-pool.ts"],
          status: "waiting",
          liveSummary: "发现边界策略分歧，等待主人确认后继续",
          elapsedSec: 19,
          steerNotes: [],
          provenance: buildSliceProvenance({
            agent: fleet.coordinator,
            workspaceId: "ws_multi_sdk",
            taskId: "solo_wrk_attn_02",
            leaseRole: "write",
            gitNotesAttached: false,
            agentEnvironment: "远程主力沙箱 (共享租约)",
          }),
        },
      ],
      attention: {
        question: "检测到残留 worktree 内含未提交草稿改动时，默认采取哪种回收策略？",
        askedBy: fleet.coordinator,
        options: [
          "自动打 git stash 快照归档后回收目录（推荐）",
          "保留目录 24 小时并在工作台置顶提醒",
          "仅清理 clean 目录，脏目录永不自动触碰",
        ],
      },
      diffFiles: [],
      createdAtIso: iso(-190),
      updatedAtIso: iso(-18),
    },
    {
      id: "solo_wrk_swarm_03",
      title: "并行打通工单持久租约契约、PGlite 锁表与 CLI 温热池",
      brief:
        "按互不重叠目录边界切分两路 Worker 并发编码，完成后交由独立审查员跑通全量类型与并发集成测试。",
      repoId: "repo_openhuddle",
      repoName: "OpenHuddle",
      worktreeBranch: "huddle/solo-swarm-lease",
      topology: "swarm",
      tier: "worktree_write",
      stage: "working",
      warmHitMs: 145,
      coordinator: fleet.coordinator,
      primaryWorker: fleet.workerA,
      verifier: fleet.verifier,
      slices: [
        {
          sliceId: "slc_swarm_protocol",
          title: "契约与 PGlite 乐观租约状态机落表",
          worker: fleet.workerA,
          ownedPaths: ["packages/protocol/src/work.ts", "packages/db/src/schema/"],
          status: "ready",
          liveSummary: "已完成 Zod 契约与 Drizzle 索引定义（+86 -4）",
          elapsedSec: 41,
          diffAdded: 86,
          diffRemoved: 4,
          steerNotes: [],
        },
        {
          sliceId: "slc_swarm_daemon",
          title: "CLI 15m 温热会话复用池与 Steer 信号帧监听",
          worker: fleet.workerB,
          ownedPaths: ["packages/cli/src/warm-runner.ts"],
          status: "running",
          liveSummary: "正在编写温热子进程空闲 TTL 自动续期单测…",
          elapsedSec: 27,
          diffAdded: 62,
          diffRemoved: 9,
          steerNotes: [],
        },
      ],
      diffFiles: [],
      createdAtIso: iso(-95),
      updatedAtIso: iso(-2),
    },
    {
      id: "solo_wrk_done_04",
      title: "收口暗色模式 Neutral Smoked Graphite 气泡与代码块对比度",
      brief: "统一夜间模式气泡、输入框与 Diff 代码槽为中性烟熏石墨色阶，消除冷蓝偏色。",
      repoId: "repo_openhuddle",
      repoName: "OpenHuddle",
      worktreeBranch: "huddle/solo-dark-graphite",
      topology: "verify_loop",
      tier: "worktree_write",
      stage: "done",
      warmHitMs: 104,
      primaryWorker: fleet.workerB,
      verifier: fleet.verifier,
      slices: [
        {
          sliceId: "slc_dark_css",
          title: "校准 styles.css 与气泡代码块双主题色阶",
          worker: fleet.workerB,
          ownedPaths: ["apps/web/src/styles.css", "apps/web/src/components/ui/"],
          status: "ready",
          liveSummary: "已由主人签收归档",
          elapsedSec: 29,
          diffAdded: 31,
          diffRemoved: 19,
          steerNotes: [],
        },
      ],
      review: {
        filesChanged: 2,
        additions: 31,
        deletions: 19,
        changedFiles: SAMPLE_DARK_CONTRAST_DIFF_FILES.map((f) => f.path),
        testCommand: "pnpm verify",
        testPassed: true,
        worktreeBranch: "huddle/solo-dark-graphite",
        verifierNote: "日夜双主题对比度均满足 WCAG AA，无嵌套 backdrop-filter。",
        verifyLoopsUsed: 1,
      },
      diffFiles: SAMPLE_DARK_CONTRAST_DIFF_FILES,
      createdAtIso: iso(-1_800),
      updatedAtIso: iso(-920),
    },
  ];
}
