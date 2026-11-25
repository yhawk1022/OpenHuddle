/**
 * @module web/__tests__/multi-agent-work
 * @description 验证多 Agent 调度状态仓的 Owner-First 权限硬降级、蜂群分片、运行中实时纠偏（Steer）、单问停顿恢复与守护 CLI 参数拼接。
 */
import type {
  AgentId,
  OwnedAgentSummaryDto,
  ReadCursorSeq,
  RoomId,
  RoomMemberDto,
  UserId,
} from "@openhuddle/protocol";
import { WorkItemDtoSchema } from "@openhuddle/protocol";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import { AppTooltipProvider } from "../components/primitives/index.js";
import { MarkdownContent } from "../components/ui/markdown-content.js";
import {
  WorkbenchTaskDetailPane,
  quoteWorkbenchPath,
} from "../features/huddle-room/components/workbench-task-detail.js";
import {
  answerRoomWorkAttention,
  bindRoomWorkItemToSoloTask,
  clearRoomWorkItems,
  decideRoomWorkReview,
  dispatchRoomWorkItem,
  loadRoomWorkShowcase,
  resetAllRoomWorkBuckets,
  steerRoomWorkSlice,
  stopRoomWorkItem,
} from "../features/huddle-room/work/room-work-store.js";
import {
  answerSoloWorkAttention,
  bindRoomToWorkspace,
  clearSoloWorkbenchTasks,
  computeSoloWorkbenchCounts,
  decideSoloWorkReview,
  deleteAgentWorkspace,
  dispatchSoloWorkTask,
  getRoomBoundWorkspace,
  getSoloWorkTaskById,
  markSoloTaskEscalated,
  resetSoloWorkbenchMemory,
  resetSoloWorkbenchShowcase,
  upsertAgentWorkspace,
} from "../features/huddle-room/work/solo-workbench-store.js";
import {
  pickWorkbenchAgent,
  toSoloWorkTaskView,
} from "../features/huddle-room/work/work-server-sync.js";
import {
  getClaimListenerHint,
  parsePromptTopologyDirective,
  stripAgentOwnerPrefix,
} from "../features/huddle-room/work/work-utils.js";
import {
  formatDaemonCapabilityCliFlags,
  getExecutionTierMeta,
} from "../lib/agent-capability-prefs.js";
import { createExternalStore } from "../lib/external-store.js";
import {
  detectSyntaxLanguageFromCode,
  formatCodeFenceLanguageLabel,
  inferSyntaxLanguageFromPath,
  normalizeSyntaxLanguage,
  resolveCodeBlockSyntaxLanguage,
  tokenizeCodeBlock,
  tokenizeCodeLines,
} from "../lib/syntax-highlight.js";

const ROOM_ID = "rom_test_work_ui" as RoomId;
const ME_ID = "usr_owner_me" as UserId;
const OTHER_USER_ID = "usr_external_bob" as UserId;
const MY_CODEX_ID = "agt_my_codex" as AgentId;
const MY_AGY_ID = "agt_my_agy" as AgentId;
const EXTERNAL_CLAUDE_ID = "agt_bob_claude" as AgentId;

const SAMPLE_MEMBERS: ReadonlyArray<RoomMemberDto> = [
  {
    memberKind: "human",
    userId: ME_ID,
    ownerUserId: ME_ID,
    ownerDisplayName: "庞彦",
    displayName: "庞彦",
    role: "owner",
    lastReadSeq: 10 as ReadCursorSeq,
    joinedAtIso: "2026-11-24T00:00:00.000Z",
  },
  {
    memberKind: "agent",
    agentId: MY_AGY_ID,
    ownerUserId: ME_ID,
    ownerDisplayName: "庞彦",
    displayName: "庞彦-Antigravity",
    slug: "pangyan-agy",
    role: "member",
    platform: "antigravity",
    reach: "online_sse",
    lastReadSeq: 10 as ReadCursorSeq,
    joinedAtIso: "2026-11-24T00:00:00.000Z",
  },
  {
    memberKind: "agent",
    agentId: MY_CODEX_ID,
    ownerUserId: ME_ID,
    ownerDisplayName: "庞彦",
    displayName: "庞彦-Codex",
    slug: "pangyan-codex",
    role: "member",
    platform: "codex",
    reach: "online_sse",
    lastReadSeq: 10 as ReadCursorSeq,
    joinedAtIso: "2026-11-24T00:00:00.000Z",
  },
  {
    memberKind: "agent",
    agentId: EXTERNAL_CLAUDE_ID,
    ownerUserId: OTHER_USER_ID,
    ownerDisplayName: "Bob",
    displayName: "Bob-Claude",
    slug: "bob-claude",
    role: "member",
    platform: "claude_code",
    reach: "online_sse",
    lastReadSeq: 10 as ReadCursorSeq,
    joinedAtIso: "2026-11-24T00:00:00.000Z",
  },
];

beforeEach(() => {
  clearRoomWorkItems(ROOM_ID);
});

describe("agent capability daemon CLI flags", () => {
  it("formats Tier 2 worktree + warm session + native Orchestrator flags for Antigravity", () => {
    const flags = formatDaemonCapabilityCliFlags(
      {
        tier: "worktree_write",
        workspacePath: "/Users/dev/projects/OpenHuddle",
        warmSessionEnabled: true,
        nativeOrchestratorEnabled: true,
      },
      "antigravity",
    );
    expect(flags).toContain('--workspace "/Users/dev/projects/OpenHuddle"');
    expect(flags).toContain("--allow-worktree");
    expect(flags).toContain("--warm-session 15m");
    expect(flags).toContain('--model "Orchestrator (Carbon)"');
  });

  it("omits workspace path and native Orchestrator when chat_only on Codex", () => {
    const flags = formatDaemonCapabilityCliFlags(
      {
        tier: "chat_only",
        workspacePath: "/Users/dev/projects/OpenHuddle",
        warmSessionEnabled: false,
        nativeOrchestratorEnabled: true,
      },
      "codex",
    );
    expect(flags).toBe("");
    expect(getExecutionTierMeta("chat_only").shortLabel).toBe("仅讨论");
  });
});

describe("room multi-agent work orchestration store", () => {
  it("enforces Owner-First tier downgrade when dispatching to an external owner's agent", () => {
    const externalWork = dispatchRoomWorkItem({
      roomId: ROOM_ID,
      anchorSeq: 12,
      content: "尝试让外部 Agent 改写仓库代码",
      members: SAMPLE_MEMBERS,
      currentUserId: ME_ID,
      payload: {
        topology: "direct",
        tier: "worktree_write",
        executorAgentId: EXTERNAL_CLAUDE_ID,
      },
    });
    expect(externalWork.primaryWorker.isOwnedByViewer).toBe(false);
    expect(externalWork.tier).toBe("chat_only");

    const ownWork = dispatchRoomWorkItem({
      roomId: ROOM_ID,
      anchorSeq: 13,
      content: "让本人 Codex 在隔离 Worktree 中补齐单测",
      members: SAMPLE_MEMBERS,
      currentUserId: ME_ID,
      payload: {
        topology: "verify_loop",
        tier: "worktree_write",
        executorAgentId: MY_CODEX_ID,
        verifierAgentId: MY_AGY_ID,
      },
    });
    expect(ownWork.primaryWorker.isOwnedByViewer).toBe(true);
    expect(ownWork.tier).toBe("worktree_write");
    expect(ownWork.verifier?.agentId).toBe(MY_AGY_ID);
  });

  it("supports Swarm fan-out, mid-run steering, attention answer, review decision, and stop", () => {
    const swarm = dispatchRoomWorkItem({
      roomId: ROOM_ID,
      anchorSeq: 20,
      content: "/swarm 拆分协议与治理状态机并行改造",
      members: SAMPLE_MEMBERS,
      currentUserId: ME_ID,
      payload: {
        topology: "swarm",
        tier: "worktree_write",
        coordinatorAgentId: MY_AGY_ID,
        executorAgentId: MY_CODEX_ID,
      },
    });
    expect(swarm.slices.length).toBe(2);
    expect(swarm.slices[0]?.ownedPaths).not.toEqual(swarm.slices[1]?.ownedPaths);

    steerRoomWorkSlice(ROOM_ID, swarm.id, "不要改动对外导出的错误码枚举名称");
    stopRoomWorkItem(ROOM_ID, swarm.id);

    loadRoomWorkShowcase({
      roomId: ROOM_ID,
      preset: "needs_you",
      latestSeq: 22,
      members: SAMPLE_MEMBERS,
      currentUserId: ME_ID,
    });
    answerRoomWorkAttention(
      ROOM_ID,
      "wrk_showcase_attn",
      "仅自动还原越界文件并保留合规改动（推荐）",
    );
    decideRoomWorkReview(ROOM_ID, "wrk_showcase_review", "approve");
  });
});

describe("solo workbench store & unified diff lifecycle", () => {
  const OWNED_AGENTS = [
    {
      id: MY_AGY_ID,
      ownerUserId: ME_ID,
      displayName: "庞彦-Antigravity",
      slug: "pangyan-agy",
      platform: "antigravity",
      reach: "online_sse",
      allowExternalDm: false,
      createdAtIso: "2026-11-24T00:00:00.000Z",
    },
    {
      id: MY_CODEX_ID,
      ownerUserId: ME_ID,
      displayName: "庞彦-Codex",
      slug: "pangyan-codex",
      platform: "codex",
      reach: "online_sse",
      allowExternalDm: false,
      createdAtIso: "2026-11-24T00:00:00.000Z",
    },
  ] as const satisfies ReadonlyArray<OwnedAgentSummaryDto>;

  beforeEach(() => {
    clearSoloWorkbenchTasks();
  });

  it("prefers a work listener for automatic assignments and preserves explicit choices", () => {
    const candidate = (
      id: AgentId,
      reach: OwnedAgentSummaryDto["reach"],
      work?: boolean,
    ): OwnedAgentSummaryDto => ({
      ...OWNED_AGENTS[0],
      id,
      reach,
      ...(work !== undefined ? { workspaceListenerConnected: work } : {}),
    });
    const connected = candidate(MY_CODEX_ID, "online_sse", true);
    const chatOnly = candidate(MY_AGY_ID, "online_sse", false);
    const offline = candidate(EXTERNAL_CLAUDE_ID, "offline");
    expect(pickWorkbenchAgent([offline, chatOnly, connected], undefined, chatOnly.id)).toBe(
      connected,
    );
    expect(pickWorkbenchAgent([offline, chatOnly, connected], offline.id)).toBe(offline);
    expect(pickWorkbenchAgent([offline, chatOnly], undefined, offline.id)).toBe(chatOnly);
    expect(() => pickWorkbenchAgent([connected], offline.id)).toThrow("重新选择");
  });

  it("distinguishes a declared work listener from an on-demand connection across identities", () => {
    for (const platform of ["codex", "deepseek", "claude_code", "gemini", "antigravity"] as const) {
      expect(
        getClaimListenerHint({ platform, reach: "online_sse", workspaceListenerConnected: false })
          ?.message,
      ).toContain("更新 OpenHuddle CLI");
    }
    for (const platform of ["custom", "cursor", "openclaw", "chatgpt", "hosted"] as const) {
      expect(
        getClaimListenerHint({ platform, reach: "online_sse", workspaceListenerConnected: true }),
      ).toBeUndefined();
      expect(
        getClaimListenerHint({ platform, reach: "polling", workspaceListenerConnected: false })
          ?.message,
      ).toContain("OpenHuddle MCP");
    }
  });

  it("shows which agent can claim each stage of an existing roomless work item", () => {
    const primaryWorker = {
      agentId: MY_CODEX_ID,
      displayName: "Codex",
      platform: "codex",
      ownerUserId: ME_ID,
      ownerDisplayName: "庞彦",
      isOwnedByViewer: true,
    };
    const verifier = {
      ...primaryWorker,
      agentId: MY_AGY_ID,
      displayName: "DeepSeek",
      platform: "deepseek",
    };
    const common = {
      workItemId: "wrk_test_no_room",
      status: "waiting",
      attemptCount: 0,
      leaseVersion: 0,
      ownedPaths: ["**"],
      diffAdded: 0,
      diffRemoved: 0,
      changedFiles: [],
      steerNotes: [],
    };
    const item = WorkItemDtoSchema.parse({
      id: common.workItemId,
      workspaceId: "wsp_test",
      workspaceName: "示例项目",
      ownerUserId: ME_ID,
      anchorMessageSeq: 0,
      title: "修改文档",
      brief: "修改文档",
      topology: "verify_loop",
      tier: "worktree_write",
      stage: "working",
      worktreeBranch: "oh/task-example",
      primaryWorker,
      verifier,
      slices: [
        {
          ...common,
          sliceId: "slc_write",
          orderIndex: 0,
          title: "执行",
          leaseRole: "write",
          assignedAgent: primaryWorker,
          liveSummary: "Queued for worker claim.",
        },
        {
          ...common,
          sliceId: "slc_verify",
          orderIndex: 1,
          title: "复核",
          leaseRole: "verify",
          assignedAgent: verifier,
          liveSummary: "Waiting for execution slices to complete.",
        },
      ],
      version: 1,
      createdAtIso: "2026-11-24T00:00:00.000Z",
      updatedAtIso: "2026-11-24T00:00:00.000Z",
    });
    const view = toSoloWorkTaskView(item, Date.parse(item.createdAtIso));
    const renderDetail = (task: typeof view) =>
      renderToStaticMarkup(
        createElement(
          AppTooltipProvider,
          null,
          createElement(WorkbenchTaskDetailPane, {
            task,
            ownedAgents: OWNED_AGENTS.map((agent) => ({
              ...agent,
              workspaceListenerConnected: false,
            })),
            ownerDisplayName: "庞彦",
            isEscalating: false,
            onEscalate() {},
            onOpenEscalatedRoom() {},
            onConfigureWorkspace() {},
          }),
        ),
      );
    const html = renderDetail(view);
    expect(html).toContain("等待 Codex 认领执行分片");
    expect(html).toContain("所有执行分片完成后开始复核");
    expect(html).toContain("工单监听尚未连接");
    expect(html.match(/href="\/install.md"/g)).toHaveLength(1);
    expect(html).not.toContain("打开执行目录");
    const reported = {
      agentEnvironment: "CLI",
      sessionJsonlPath: "sessions/test.jsonl",
      rollingMemoryPath: "memory.md",
      gitNotesAttached: false,
    };
    const worktree = "/worktrees/hash-51b8c2";
    const completed = {
      ...view,
      slices: view.slices
        .map((slice) => ({
          ...slice,
          provenance: {
            ...reported,
            leaseRole: slice.leaseRole ?? "write",
            workingDirectory: slice.leaseRole === "verify" ? "/tmp/review" : worktree,
          },
        }))
        .reverse(),
    };
    expect(renderDetail(completed)).toContain(`title="${worktree}"`);
    expect(
      toSoloWorkTaskView({ ...item, stage: "verifying" }, Date.parse(item.updatedAtIso)).slices[1]
        ?.liveSummary,
    ).toBe("等待 DeepSeek 认领复核分片");
  });

  it("quotes the execution directory for the shell on the reporting device", () => {
    expect(quoteWorkbenchPath("~/folder with spaces")).toBe(`"$HOME"'/folder with spaces'`);
    expect(quoteWorkbenchPath("/projects/O'Brien")).toBe(`'/projects/O'"'"'Brien'`);
    expect(quoteWorkbenchPath("C:\\projects\\O'Brien")).toBe("'C:\\projects\\O''Brien'");
  });

  it("seeds 3-column showcase tasks with unified diffs and transitions through attention, review, and escalation", () => {
    resetSoloWorkbenchShowcase(OWNED_AGENTS, "庞彦");

    const dispatched = dispatchSoloWorkTask({
      rawPrompt: "/swarm 并行验证单人工作台分片与 Huddle 会诊升级",
      topology: "direct",
      repoId: "repo_openhuddle",
      ownedAgents: OWNED_AGENTS,
      ownerDisplayName: "庞彦",
    });
    expect(dispatched.topology).toBe("swarm");
    expect(dispatched.slices.length).toBe(2);
    expect(dispatched.warmHitMs).toBeGreaterThanOrEqual(80);

    // 拍板回答单问停顿并验证计数变化
    answerSoloWorkAttention("solo_wrk_attn_02", "自动打 git stash 快照归档后回收目录（推荐）");
    // 先打回微调再批准签收，并标记一键拉群会诊 RoomId
    decideSoloWorkReview("solo_wrk_review_01", "request_changes", "补充重连抖动边界断言");
    decideSoloWorkReview("solo_wrk_review_01", "approve");
    markSoloTaskEscalated(dispatched.id, ROOM_ID);

    const countsAfter = computeSoloWorkbenchCounts([dispatched]);
    expect(countsAfter.running).toBe(1);
  });

  it("supports multi-root, plain folder, and read-only workspaces plus room-to-workspace bindings", () => {
    resetSoloWorkbenchShowcase(OWNED_AGENTS, "庞彦");

    // 1. 创建多目录组合（Multi-root）工作区
    const multiWs = upsertAgentWorkspace({
      name: "前后端全栈工作区",
      kind: "multi_root",
      roots: [
        { localPath: "~/Developer/fullstack-api", defaultBranch: "main" },
        { localPath: "~/Developer/fullstack-web", defaultBranch: "main" },
      ],
      sandboxMode: "worktree_pool",
      setupCommand: "pnpm install",
      verifyCommand: "pnpm verify",
      defaultTopology: "swarm",
    });
    expect(multiWs.kind).toBe("multi_root");
    expect(multiWs.roots.length).toBe(2);
    expect(multiWs.prewarmedWorktrees).toBeGreaterThan(0);

    // 2. 创建普通文件夹工作区时，自动将 worktree_pool 收敛为 in_place
    const folderWs = upsertAgentWorkspace({
      name: "架构设计文库",
      kind: "folder",
      roots: [{ localPath: "~/Documents/ArchDocs" }],
      sandboxMode: "worktree_pool",
    });
    expect(folderWs.kind).toBe("folder");
    expect(folderWs.sandboxMode).toBe("in_place");
    expect(folderWs.prewarmedWorktrees).toBe(0);

    // 3. 只读围栏工作区派发任务自动降级为 workspace_read
    const readOnlyWs = upsertAgentWorkspace({
      name: "线上只读审计仓",
      kind: "git_repo",
      roots: [{ localPath: "~/Developer/prod-mirror", defaultBranch: "release" }],
      sandboxMode: "read_only",
    });
    const readTask = dispatchSoloWorkTask({
      rawPrompt: "排查鉴权中间件的超时重试配置",
      topology: "direct",
      repoId: readOnlyWs.id,
      ownedAgents: OWNED_AGENTS,
      ownerDisplayName: "庞彦",
    });
    expect(readTask.tier).toBe("workspace_read");
    expect(readTask.worktreeBranch).toBe("只读围栏");

    // 4. 群聊绑定工作区并在移除工作区时自动解绑清理
    bindRoomToWorkspace(ROOM_ID, multiWs.id);
    expect(getRoomBoundWorkspace(ROOM_ID)?.id).toBe(multiWs.id);

    deleteAgentWorkspace(multiWs.id);
    expect(getRoomBoundWorkspace(ROOM_ID)).toBeNull();
  });

  it("maintains zero split-brain bidirectional sync between Huddle Room work items and Solo Workbench tasks", () => {
    clearRoomWorkItems(ROOM_ID);
    resetSoloWorkbenchShowcase(OWNED_AGENTS, "庞彦");

    const roomItem = dispatchRoomWorkItem({
      roomId: ROOM_ID,
      anchorSeq: 30,
      content: "在共享沙箱验证跨环境写审交棒与双向状态同步",
      members: SAMPLE_MEMBERS,
      currentUserId: ME_ID,
      payload: {
        topology: "verify_loop",
        tier: "worktree_write",
        executorAgentId: MY_CODEX_ID,
        verifierAgentId: MY_AGY_ID,
      },
    });

    const soloItem = dispatchSoloWorkTask({
      rawPrompt: "在共享沙箱验证跨环境写审交棒与双向状态同步",
      topology: "verify_loop",
      repoId: "ws_multi_sdk",
      ownedAgents: OWNED_AGENTS,
      ownerDisplayName: "庞彦",
      linkedRoomId: ROOM_ID,
      linkedRoomWorkId: roomItem.id,
    });
    bindRoomWorkItemToSoloTask(ROOM_ID, roomItem.id, soloItem.id);
    expect(soloItem.slices[0]?.provenance?.sessionJsonlPath).toContain("~/.openhuddle/agents/");

    // 1. 在群聊中点击中止 -> 工作台对应任务实时同步为 cancelled
    stopRoomWorkItem(ROOM_ID, roomItem.id);
    expect(getSoloWorkTaskById(soloItem.id)?.stage).toBe("cancelled");

    // 2. 在群聊中点击签收 -> 工作台对应任务实时同步为 done（彻底消除双仓脑裂）
    decideRoomWorkReview(ROOM_ID, roomItem.id, "approve");
    expect(getSoloWorkTaskById(soloItem.id)?.stage).toBe("done");
  });
});

describe("stateful lexical syntax highlighter", () => {
  it("normalizes markdown language tags and infers syntax languages from file paths", () => {
    expect(normalizeSyntaxLanguage("TypeScript")).toBe("ts");
    expect(normalizeSyntaxLanguage("html")).toBe("html");
    expect(normalizeSyntaxLanguage('html title="snake.html"')).toBe("html");
    expect(normalizeSyntaxLanguage("ts:apps/web/src/main.tsx")).toBe("ts");
    expect(normalizeSyntaxLanguage("c++")).toBe("ts");
    expect(normalizeSyntaxLanguage("c#")).toBe("ts");
    expect(normalizeSyntaxLanguage("yaml")).toBe("yaml");
    expect(normalizeSyntaxLanguage("md")).toBe("markdown");
    expect(normalizeSyntaxLanguage("bash")).toBe("shell");
    expect(normalizeSyntaxLanguage("postgresql")).toBe("sql");
    expect(inferSyntaxLanguageFromPath("apps/web/src/styles/app.css")).toBe("css");
    expect(inferSyntaxLanguageFromPath("apps/web/index.html")).toBe("html");
    expect(inferSyntaxLanguageFromPath("docker-compose.yml")).toBe("yaml");
    expect(inferSyntaxLanguageFromPath("packages/protocol/src/index.ts")).toBe("ts");
    expect(inferSyntaxLanguageFromPath("package.json")).toBe("json");
  });

  it("tokenizes single-file HTML with embedded <style> and <script> blocks and JSX tags losslessly", () => {
    const htmlSnake = [
      "<!DOCTYPE html>",
      "<!-- 单文件贪吃蛇 -->",
      "<style>.board { background: #111113; width: 400px; }</style>",
      '<canvas id="game" width="400" height="400" style="background:#111"></canvas>',
      "<script>",
      "const canvas = document.getElementById('game');",
      "const ctx = canvas.getContext('2d');",
      "const GRID = 20, COUNT = canvas.width / GRID;",
      "function spawnFood() { return { x: 10, y: 10 }; }",
      "</script>",
    ].join("\n");

    const lines = tokenizeCodeBlock(htmlSnake, "html");
    expect(lines[0]?.some((t) => t.kind === "doc_tag" && t.text === "<!DOCTYPE")).toBe(true);
    expect(lines[0]?.some((t) => t.kind === "type" && t.text === "html")).toBe(true);
    expect(lines[1]?.[0]?.kind).toBe("comment");
    // <style> 同行切换 CSS 着色并闭合切回 HTML
    expect(lines[2]?.some((t) => t.kind === "keyword" && t.text === "style")).toBe(true);
    expect(lines[2]?.some((t) => t.kind === "type" && t.text === ".board")).toBe(true);
    expect(lines[2]?.some((t) => t.kind === "property" && t.text === "background")).toBe(true);
    expect(lines[2]?.some((t) => t.kind === "number" && t.text === "#111113")).toBe(true);
    // <canvas> 标签与属性着色
    expect(lines[3]?.some((t) => t.kind === "keyword" && t.text === "canvas")).toBe(true);
    expect(lines[3]?.some((t) => t.kind === "property" && t.text === "id")).toBe(true);
    expect(lines[3]?.some((t) => t.kind === "string" && t.text === '"game"')).toBe(true);
    // <script> 跨行切换 JS/TS 着色
    expect(lines[5]?.some((t) => t.kind === "keyword" && t.text === "const")).toBe(true);
    expect(lines[5]?.some((t) => t.kind === "function" && t.text === "getElementById")).toBe(true);
    expect(lines[5]?.some((t) => t.kind === "string" && t.text === "'game'")).toBe(true);
    expect(lines[7]?.some((t) => t.kind === "property" && t.text === "width")).toBe(true);
    expect(lines[8]?.some((t) => t.kind === "function" && t.text === "spawnFood")).toBe(true);
    expect(lines[9]?.some((t) => t.kind === "keyword" && t.text === "script")).toBe(true);

    const reconstructed = lines.map((l) => l.map((t) => t.text).join("")).join("\n");
    expect(reconstructed).toBe(htmlSnake);

    // JSX / TSX 标签与属性着色
    const tsxLines = tokenizeCodeBlock(
      'export const View = () => <SnakeBoard score={42} className="dark" />;',
      "ts",
    );
    expect(tsxLines[0]?.some((t) => t.kind === "type" && t.text === "SnakeBoard")).toBe(true);
    expect(tsxLines[0]?.some((t) => t.kind === "property" && t.text === "score")).toBe(true);
    expect(tsxLines[0]?.some((t) => t.kind === "number" && t.text === "42")).toBe(true);
    expect(tsxLines[0]?.some((t) => t.kind === "property" && t.text === "className")).toBe(true);
  });

  it("auto-detects unlabeled code blocks, honors explicit plain text, and renders highlighted spans in MarkdownContent", () => {
    expect(detectSyntaxLanguageFromCode("<!DOCTYPE html>\n<canvas id='c'></canvas>")).toBe("html");
    expect(detectSyntaxLanguageFromCode("const x = () => 42;")).toBe("ts");
    expect(resolveCodeBlockSyntaxLanguage("text", "const x = 1;")).toBe("plain");
    expect(resolveCodeBlockSyntaxLanguage("", "<!DOCTYPE html>\n<script>let x = 1;</script>")).toBe(
      "html",
    );
    expect(formatCodeFenceLanguageLabel("", "html")).toBe("html");
    expect(formatCodeFenceLanguageLabel("", "plain")).toBe("code");

    const markdownMessage = [
      "我先交作业，写了一个**`Canvas` 版 JS 贪吃蛇**：",
      "",
      "````html",
      "<!DOCTYPE html>",
      '<canvas id="game" width="400"></canvas>',
      "<script>",
      "const canvas = document.getElementById('game');",
      "</script>",
      "````",
    ].join("\n");

    const htmlOutput = renderToStaticMarkup(
      createElement(
        AppTooltipProvider,
        null,
        createElement(MarkdownContent, { content: markdownMessage }),
      ),
    );
    // 验证加粗内部嵌套行内代码 `Canvas` 也被解析为 <code>，且代码块内生成多色高亮类名
    expect(htmlOutput).toContain("<code");
    expect(htmlOutput).toContain(">Canvas</code>");
    expect(htmlOutput).toContain("dark:text-[#F087BD]");
    expect(htmlOutput).toContain("dark:text-[#82AAFF]");
    expect(htmlOutput).toContain("dark:text-[#FFA67A]");
    expect(htmlOutput).toContain("dark:text-[#7EE787]");
  });

  it("tokenizes TypeScript keywords, types, functions, numbers, and preserves multi-line state losslessly", () => {
    const sampleTs = [
      "/**",
      " * @param attempt - 重连次数",
      " */",
      "export function computeReconnectDelayMs(attempt: number): ReadonlyArray<string> {",
      "  const cappedMs = Math.min(12_000, attempt * 500); // 上限 12s",
      "  const tpl = `line1",
      "line2`;",
      '  return ["ok", tpl, String(cappedMs)];',
      "}",
    ].join("\n");

    const lines = tokenizeCodeBlock(sampleTs, "ts");
    expect(lines.length).toBe(9);

    // 第 2 行仍在多行注释中，且识别出 `@param` 文档标签
    expect(lines[1]?.some((t) => t.kind === "doc_tag" && t.text === "@param")).toBe(true);
    expect(lines[1]?.some((t) => t.kind === "comment")).toBe(true);

    // 第 4 行识别关键字、函数名、内置类型
    expect(lines[3]?.some((t) => t.kind === "keyword" && t.text === "export")).toBe(true);
    expect(lines[3]?.some((t) => t.kind === "keyword" && t.text === "function")).toBe(true);
    expect(
      lines[3]?.some((t) => t.kind === "function" && t.text === "computeReconnectDelayMs"),
    ).toBe(true);
    expect(lines[3]?.some((t) => t.kind === "type" && t.text === "ReadonlyArray")).toBe(true);

    // 第 5 行识别带下划线数值与尾随单行注释
    expect(lines[4]?.some((t) => t.kind === "number" && t.text === "12_000")).toBe(true);
    expect(lines[4]?.some((t) => t.kind === "comment" && t.text.includes("上限 12s"))).toBe(true);

    // 第 6-7 行跨行模板字符串延续状态
    expect(lines[5]?.some((t) => t.kind === "string" && t.text === "`line1")).toBe(true);
    expect(lines[6]?.[0]).toEqual({ kind: "string", text: "line2`" });

    // 100% 无损还原原始源码字符序列
    const reconstructed = lines.map((line) => line.map((tok) => tok.text).join("")).join("\n");
    expect(reconstructed).toBe(sampleTs);
  });

  it("distinguishes CSS custom properties, class selectors, hex colors, and JSON property keys", () => {
    const cssLines = tokenizeCodeLines(
      [".dark {", "  --oh-code-well: #141417;", "  padding: 12px;", "}"],
      "css",
    );
    expect(cssLines[0]?.some((t) => t.kind === "type" && t.text === ".dark")).toBe(true);
    expect(cssLines[1]?.some((t) => t.kind === "property" && t.text === "--oh-code-well")).toBe(
      true,
    );
    expect(cssLines[1]?.some((t) => t.kind === "number" && t.text === "#141417")).toBe(true);

    const jsonLines = tokenizeCodeLines(
      ['{ "server": "http://localhost:3000", "retry": 3 }'],
      "json",
    );
    expect(jsonLines[0]?.some((t) => t.kind === "property" && t.text === '"server"')).toBe(true);
    expect(
      jsonLines[0]?.some((t) => t.kind === "string" && t.text === '"http://localhost:3000"'),
    ).toBe(true);
    expect(jsonLines[0]?.some((t) => t.kind === "number" && t.text === "3")).toBe(true);
  });

  it("fast-paths adversarial 20k-char minified single lines in O(1) without losing a single character", () => {
    const minifiedLine = `export const BUNDLE = "${"a1b2c3d4".repeat(2_500)}";`;
    const startMs = performance.now();
    const tokenized = tokenizeCodeBlock(minifiedLine, "ts");
    const elapsedMs = performance.now() - startMs;

    expect(elapsedMs).toBeLessThan(25);
    const reconstructed = tokenized.map((line) => line.map((t) => t.text).join("")).join("\n");
    expect(reconstructed).toBe(minifiedLine);
  });

  it("isolates scanner state across >1200-char lines and defaults unknown file extensions to plain", () => {
    expect(inferSyntaxLanguageFromPath("docs/ARCHITECTURE.md")).toBe("plain");

    // 第 1 行超长且前 240 字符内打开了 `/*` 而在尾部闭合，不应把第 2 行污染为注释态
    const longLineWithComment = `const a = 1; /* ${"x".repeat(1_300)} */`;
    const nextNormalLine = "export function healthyLine() { return 42; }";
    const result = tokenizeCodeLines([longLineWithComment, nextNormalLine], "ts");
    expect(result[1]?.some((t) => t.kind === "keyword" && t.text === "export")).toBe(true);
    expect(result[1]?.some((t) => t.kind === "function" && t.text === "healthyLine")).toBe(true);
  });
});

describe("shared external-store, work-utils, and workspace edit/logout invariants", () => {
  it("short-circuits identical snapshots in createExternalStore and parses directives & owner prefixes", () => {
    const store = createExternalStore({ count: 1 });
    let notifications = 0;
    const unsub = store.subscribe(() => {
      notifications += 1;
    });
    const prev = store.getSnapshot();
    store.setSnapshot(prev);
    expect(notifications).toBe(0);
    expect(store.getServerSnapshot()).toBe(prev);

    store.setSnapshot({ count: 2 });
    expect(notifications).toBe(1);
    expect(store.getSnapshot().count).toBe(2);
    unsub();

    expect(parsePromptTopologyDirective("/swarm 拆分前后端模块", "direct")).toEqual({
      topology: "swarm",
      body: "拆分前后端模块",
    });
    expect(stripAgentOwnerPrefix("庞彦-OpenAICodex", "庞彦")).toBe("OpenAICodex");
  });

  it("preserves remoteSlug and defaultVerifierId when editing a workspace and isolates memory on logout", () => {
    const edited = upsertAgentWorkspace({
      id: "repo_openhuddle",
      name: "OpenHuddle Core",
      kind: "git_repo",
      roots: [{ localPath: "~/Developer/OpenHuddle", defaultBranch: "master" }],
      sandboxMode: "worktree_pool",
      defaultVerifierId: MY_AGY_ID,
    });
    expect(edited.roots[0]?.remoteSlug).toBe("github.com/openhuddle/openhuddle");
    expect(edited.defaultVerifierId).toBe(MY_AGY_ID);

    const reEdited = upsertAgentWorkspace({
      id: "repo_openhuddle",
      name: "OpenHuddle",
      kind: "git_repo",
      roots: [{ localPath: "~/Developer/OpenHuddle", defaultBranch: "master" }],
      sandboxMode: "worktree_pool",
    });
    expect(reEdited.defaultVerifierId).toBe(MY_AGY_ID);

    resetSoloWorkbenchMemory();
    resetAllRoomWorkBuckets();
    expect(getRoomBoundWorkspace(ROOM_ID)).toBeNull();
  });
});
