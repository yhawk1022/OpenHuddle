/**
 * @module web/features/huddle-room/solo-workbench
 * @description 个人 Agent 工作台主视图。
 *
 * 布局结构与缩放适配：
 * 1. `>= xl` 桌面宽屏采用三栏布局：左侧状态/工作区导航栏（`216px`）+ 中间任务列表（`392px`）+ 右侧代码审阅面板（`WorkbenchTaskDetailPane`）。
 * 2. `< xl` 高倍率缩放（125%/150%/175%）与移动端自动收敛为单列任务流，点击条目后推入详情视图，避免多栏水平挤压。
 */
import {
  type AgentId,
  type HumanUserDto,
  type OwnedAgentSummaryDto,
  type RoomId,
  assertNever,
} from "@openhuddle/protocol";
import {
  ArrowLeft,
  ChevronRight,
  Folder,
  FolderGit2,
  Folders,
  MoreHorizontal,
  Plus,
  SlidersHorizontal,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  AnimatePresence,
  AppButton,
  type AppDropdownEntry,
  AppDropdownMenu,
  AppSelect,
  type AppSelectOption,
  AppTooltip,
  INSTANT_TRANSITION,
  IconButton,
  NATIVE_PILL_SPRING,
  NATIVE_VIEW_SWAP,
  type SegmentedTabItem,
  cn,
  motion,
  toast,
  usePrefersReducedMotion,
} from "../../../components/primitives/index.js";
import { PlatformAvatar } from "../../../components/ui/identity-badges.js";
import { navigateBackOr, navigateTo, useBrowserLocation } from "../../../lib/session-store.js";
import { isImeComposing } from "../../../lib/viewport-sync.js";
import {
  type AgentWorkspace,
  type SoloRepoTarget,
  type SoloWorkTaskView,
  type SoloWorkbenchCounts,
  type WorkbenchAttentionFilter,
  type WorkspaceKind,
  isSoloNeedsYouStage,
  isSoloRunningStage,
} from "../work/solo-workbench-store.js";
import { dispatchWorkbenchTaskOnServer } from "../work/work-server-sync.js";
import type { WorkTopology } from "../work/work-types.js";
import { WorkStageGlyph, getWorkTopologyLabel, stripAgentOwnerPrefix } from "../work/work-utils.js";
import { WorkbenchTaskDetailPane } from "./workbench-task-detail.js";
import { WorkspaceConfigModal } from "./workspace-config-modal.js";

const WIDE_WORKBENCH_QUERY = "(min-width: 1280px)";

function subscribeWideWorkbench(onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return () => {};
  }
  const mq = window.matchMedia(WIDE_WORKBENCH_QUERY);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

function getWideWorkbenchSnapshot(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return true;
  }
  return window.matchMedia(WIDE_WORKBENCH_QUERY).matches;
}

/** `SoloWorkbench` 顶层属性 */
export interface SoloWorkbenchProps {
  readonly currentUser: HumanUserDto;
  readonly ownedAgents: ReadonlyArray<OwnedAgentSummaryDto>;
  readonly repos: ReadonlyArray<SoloRepoTarget>;
  readonly tasks: ReadonlyArray<SoloWorkTaskView>;
  readonly counts: SoloWorkbenchCounts;
  readonly initialWorkspaceId?: string | null | undefined;
  readonly escalatingTaskId: string | null;
  readonly onEscalateToHuddle: (task: SoloWorkTaskView) => void;
  readonly onOpenEscalatedRoom: (roomId: RoomId) => void;
  readonly onSwitchToChats: () => void;
  readonly onOpenConnectAgent: () => void;
  readonly onInspectOwnedAgent: (agent: OwnedAgentSummaryDto) => void;
}

const TOPOLOGY_OPTIONS: ReadonlyArray<AppSelectOption<WorkTopology>> = [
  { value: "direct", label: "单人执行", description: "单个 Agent 直接完成改动" },
  { value: "verify_loop", label: "双人复核", description: "完成后由另一 Agent 独立检查" },
  { value: "swarm", label: "多路并行", description: "按目录拆分并行处理后汇总" },
];

function formatTaskSecondaryLine(task: SoloWorkTaskView): string {
  switch (task.stage) {
    case "awaiting_answer":
      return `${task.repoName} · 等待确认 1 个问题`;
    case "awaiting_review":
      return task.review !== undefined
        ? `${task.repoName} · ${String(task.review.filesChanged)} 个文件变更`
        : `${task.repoName} · 待审阅变更`;
    case "blocked":
      return `${task.repoName} · 执行暂停`;
    case "working": {
      const runningSlice = task.slices.find((s) => s.status === "running") ?? task.slices[0];
      return runningSlice !== undefined
        ? `${task.repoName} · ${runningSlice.liveSummary}`
        : `${task.repoName} · 正在处理`;
    }
    case "verifying":
      return `${task.repoName} · 正在复核代码与测试`;
    case "done":
      return `${task.repoName} · 已签收`;
    case "cancelled":
      return `${task.repoName} · 已停止`;
    default:
      return assertNever(task.stage);
  }
}

function renderWorkspaceKindGlyph(kind: WorkspaceKind) {
  switch (kind) {
    case "git_repo":
      return <FolderGit2 className="h-3.5 w-3.5 shrink-0 text-[#687082] dark:text-[#8E8E96]" />;
    case "multi_root":
      return <Folders className="h-3.5 w-3.5 shrink-0 text-[#687082] dark:text-[#8E8E96]" />;
    case "folder":
      return <Folder className="h-3.5 w-3.5 shrink-0 text-[#687082] dark:text-[#8E8E96]" />;
    default:
      return assertNever(kind);
  }
}

function formatSandboxSummary(ws: AgentWorkspace): string {
  switch (ws.sandboxMode) {
    case "worktree_pool":
      return ws.prewarmedWorktrees > 0
        ? `Worktree 隔离 (${String(ws.prewarmedWorktrees)} 就绪)`
        : "Worktree 隔离";
    case "in_place":
      return "原地目录 (单写互斥)";
    case "read_only":
      return "只读围栏";
    default:
      return assertNever(ws.sandboxMode);
  }
}

function resolveWorkbenchTitle(
  selectedWorkspace: AgentWorkspace | undefined,
  filter: WorkbenchAttentionFilter,
): string {
  if (selectedWorkspace !== undefined) {
    return selectedWorkspace.name;
  }
  switch (filter) {
    case "board":
      return "全部任务";
    case "needs_you":
      return "待确认";
    case "running":
      return "进行中";
    case "done":
      return "已完成";
    default:
      return assertNever(filter);
  }
}

/**
 * 个人工作台主视图组件。
 */
export function SoloWorkbench(props: SoloWorkbenchProps) {
  const isWideWorkbench = useSyncExternalStore(
    useCallback((cb) => subscribeWideWorkbench(cb), []),
    getWideWorkbenchSnapshot,
    () => true,
  );
  const [attentionFilter, setAttentionFilter] = useState<WorkbenchAttentionFilter>("board");
  const [selectedRepoFilter, setSelectedRepoFilter] = useState<string>(() =>
    props.initialWorkspaceId && props.repos.some((r) => r.id === props.initialWorkspaceId)
      ? props.initialWorkspaceId
      : "all",
  );
  const location = useBrowserLocation();
  const urlTaskId = useMemo(
    () => new URLSearchParams(location.search).get("task"),
    [location.search],
  );
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(() => urlTaskId);
  const [localCompactDetailOpen, setLocalCompactDetailOpen] = useState<boolean>(false);
  const compactDetailOpen = urlTaskId !== null || localCompactDetailOpen;

  const closeCompactDetail = useCallback((): void => {
    setLocalCompactDetailOpen(false);
    if (urlTaskId !== null) {
      const params = new URLSearchParams(location.search);
      params.delete("task");
      params.set("view", "workbench");
      navigateBackOr(`/?${params.toString()}`);
    }
  }, [location.search, urlTaskId]);

  const [promptText, setPromptText] = useState<string>("");
  const [isDispatching, setIsDispatching] = useState<boolean>(false);
  const [dispatchRepoId, setDispatchRepoId] = useState<string>(
    () => props.initialWorkspaceId ?? props.repos[0]?.id ?? "",
  );
  const [dispatchTopology, setDispatchTopology] = useState<WorkTopology>(
    () => props.repos[0]?.defaultTopology ?? "verify_loop",
  );
  const [preferredWorkerId, setPreferredWorkerId] = useState<AgentId | "auto">(
    () => props.repos[0]?.defaultWorkerId ?? "auto",
  );

  const [workspaceModalState, setWorkspaceModalState] = useState<AgentWorkspace | "create" | null>(
    null,
  );
  const lastWorkspaceModalRef = useRef<AgentWorkspace | "create">("create");
  if (workspaceModalState !== null) {
    lastWorkspaceModalRef.current = workspaceModalState;
  }
  const reducedMotion = usePrefersReducedMotion();

  useEffect(() => {
    if (props.initialWorkspaceId && props.repos.some((r) => r.id === props.initialWorkspaceId)) {
      setSelectedRepoFilter(props.initialWorkspaceId);
      setDispatchRepoId(props.initialWorkspaceId);
    }
  }, [props.initialWorkspaceId, props.repos]);

  const selectedWorkspace = useMemo(
    () =>
      selectedRepoFilter !== "all"
        ? props.repos.find((r) => r.id === selectedRepoFilter)
        : undefined,
    [props.repos, selectedRepoFilter],
  );

  useEffect(() => {
    if (selectedRepoFilter !== "all" && selectedWorkspace === undefined) {
      setSelectedRepoFilter("all");
    }
  }, [selectedRepoFilter, selectedWorkspace]);

  const workspaceActiveCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const task of props.tasks) {
      if (isSoloNeedsYouStage(task.stage) || isSoloRunningStage(task.stage)) {
        map.set(task.repoId, (map.get(task.repoId) ?? 0) + 1);
      }
    }
    return map;
  }, [props.tasks]);

  const filteredTasks = useMemo(() => {
    return props.tasks.filter((task) => {
      if (selectedRepoFilter !== "all" && task.repoId !== selectedRepoFilter) {
        return false;
      }
      if (attentionFilter === "needs_you") {
        return isSoloNeedsYouStage(task.stage);
      }
      if (attentionFilter === "running") {
        return isSoloRunningStage(task.stage);
      }
      if (attentionFilter === "done") {
        return task.stage === "done" || task.stage === "cancelled";
      }
      return true;
    });
  }, [attentionFilter, props.tasks, selectedRepoFilter]);

  const needsYouTasks = useMemo(
    () => filteredTasks.filter((t) => isSoloNeedsYouStage(t.stage)),
    [filteredTasks],
  );
  const runningTasks = useMemo(
    () => filteredTasks.filter((t) => isSoloRunningStage(t.stage)),
    [filteredTasks],
  );
  const settledTasks = useMemo(
    () => filteredTasks.filter((t) => t.stage === "done" || t.stage === "cancelled"),
    [filteredTasks],
  );

  // 宽屏默认选中第一条可见任务，保持右栏直接展示变更详情；移动端 URL 带 ?task= 时优先展示指定任务
  const resolvedSelectedTask = useMemo(() => {
    const candidateId = urlTaskId ?? selectedTaskId;
    if (candidateId !== null) {
      const explicit = filteredTasks.find((t) => t.id === candidateId);
      if (explicit !== undefined) {
        return explicit;
      }
    }
    return needsYouTasks[0] ?? runningTasks[0] ?? settledTasks[0] ?? null;
  }, [filteredTasks, needsYouTasks, runningTasks, selectedTaskId, settledTasks, urlTaskId]);

  const resolvedTaskWorkspace = useMemo(
    () =>
      resolvedSelectedTask !== null
        ? props.repos.find((r) => r.id === resolvedSelectedTask.repoId)
        : undefined,
    [props.repos, resolvedSelectedTask],
  );

  useEffect(() => {
    if (localCompactDetailOpen && resolvedSelectedTask === null) {
      setLocalCompactDetailOpen(false);
    }
  }, [localCompactDetailOpen, resolvedSelectedTask]);

  // 原生桌面客户端任务流键盘操作（Linear / Things 3 标准）：
  // - J / K 或 Alt+↓ / Alt+↑：在当前任务列表中平滑上下移动选中项
  // - Escape：在紧凑窄屏详情页返回任务列表
  useEffect(() => {
    const handleWorkbenchKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.isComposing) {
        return;
      }
      const hasTopOverlay =
        document.querySelector('[role="dialog"], [data-radix-popper-content-wrapper]') !== null;
      if (hasTopOverlay) {
        return;
      }

      if (event.key === "Escape" && compactDetailOpen) {
        event.preventDefault();
        closeCompactDetail();
        return;
      }

      const active = document.activeElement as HTMLElement | null;
      const isEditable =
        active !== null &&
        (active.tagName === "INPUT" ||
          active.tagName === "TEXTAREA" ||
          active.tagName === "SELECT" ||
          active.isContentEditable);

      const isAltArrow =
        event.altKey &&
        !event.metaKey &&
        !event.ctrlKey &&
        (event.key === "ArrowDown" || event.key === "ArrowUp");
      const isVimNav =
        !isEditable &&
        !event.altKey &&
        !event.metaKey &&
        !event.ctrlKey &&
        (event.key === "j" || event.key === "k");

      if ((isAltArrow || isVimNav) && filteredTasks.length > 0) {
        event.preventDefault();
        const currentId = resolvedSelectedTask?.id ?? null;
        const curIdx = currentId !== null ? filteredTasks.findIndex((t) => t.id === currentId) : -1;
        const delta = event.key === "ArrowDown" || event.key === "j" ? 1 : -1;
        const nextIdx =
          curIdx < 0 ? 0 : (curIdx + delta + filteredTasks.length) % filteredTasks.length;
        const nextTask = filteredTasks[nextIdx];
        if (nextTask !== undefined) {
          setSelectedTaskId(nextTask.id);
        }
      }
    };

    window.addEventListener("keydown", handleWorkbenchKeyDown);
    return () => window.removeEventListener("keydown", handleWorkbenchKeyDown);
  }, [closeCompactDetail, compactDetailOpen, filteredTasks, resolvedSelectedTask]);

  const busyAgentIds = useMemo(() => {
    const ids = new Set<string>();
    for (const task of props.tasks) {
      if (!isSoloRunningStage(task.stage)) {
        continue;
      }
      for (const slice of task.slices) {
        if (slice.status === "running" || slice.status === "verifying") {
          ids.add(slice.worker.agentId);
        }
      }
    }
    return ids;
  }, [props.tasks]);

  const activeRepo = props.repos.find((r) => r.id === dispatchRepoId) ?? props.repos[0];

  const repoSelectOptions: ReadonlyArray<AppSelectOption<string>> = useMemo(
    () => props.repos.map((r) => ({ value: r.id, label: r.name })),
    [props.repos],
  );

  const mobileWorkspaceFilterOptions: ReadonlyArray<AppSelectOption<string>> = useMemo(
    () => [
      { value: "all", label: "全部工作区" },
      ...props.repos.map((r) => ({ value: r.id, label: r.name })),
    ],
    [props.repos],
  );

  const workerSelectOptions: ReadonlyArray<AppSelectOption<string>> = useMemo(
    () => [
      { value: "auto", label: "自动分配" },
      ...props.ownedAgents.map((a) => ({
        value: a.id,
        label: stripAgentOwnerPrefix(a.displayName, props.currentUser.displayName),
      })),
    ],
    [props.currentUser.displayName, props.ownedAgents],
  );

  const compactFilterTabs: ReadonlyArray<SegmentedTabItem<WorkbenchAttentionFilter>> = useMemo(
    () => [
      { value: "board", label: "全部" },
      {
        value: "needs_you",
        label: "待确认",
        ...(props.counts.needsYou > 0 ? { badge: String(props.counts.needsYou) } : {}),
      },
      {
        value: "running",
        label: "进行中",
        ...(props.counts.running > 0 ? { badge: String(props.counts.running) } : {}),
      },
      { value: "done", label: "已完成" },
    ],
    [props.counts.needsYou, props.counts.running],
  );

  const applyWorkspaceDefaults = useCallback((ws: AgentWorkspace): void => {
    setDispatchRepoId(ws.id);
    setDispatchTopology(ws.defaultTopology);
    setPreferredWorkerId(ws.defaultWorkerId ?? "auto");
  }, []);

  useEffect(() => {
    if (props.repos.length > 0 && !props.repos.some((r) => r.id === dispatchRepoId)) {
      const firstWs = props.repos[0];
      if (firstWs !== undefined) {
        applyWorkspaceDefaults(firstWs);
      }
    }
  }, [applyWorkspaceDefaults, dispatchRepoId, props.repos]);

  const moreMenuEntries: ReadonlyArray<AppDropdownEntry> = useMemo(
    () => [
      {
        id: "wb-new-workspace",
        label: "新建工作区…",
        icon: <Plus className="h-3.5 w-3.5" />,
        onSelect: () => setWorkspaceModalState("create"),
      },
      ...(activeRepo !== undefined
        ? [
            {
              id: "wb-edit-workspace",
              label: `工作区设置（${(selectedWorkspace ?? activeRepo).name}）…`,
              icon: <SlidersHorizontal className="h-3.5 w-3.5" />,
              onSelect: () => setWorkspaceModalState(selectedWorkspace ?? activeRepo),
            } satisfies AppDropdownEntry,
          ]
        : []),
      {
        id: "wb-connect-agent",
        label: "接入本机 Agent…",
        icon: <Plus className="h-3.5 w-3.5" />,
        onSelect: props.onOpenConnectAgent,
      },
    ],
    [activeRepo, props.onOpenConnectAgent, selectedWorkspace],
  );

  const handleDispatchSubmit = async (): Promise<void> => {
    const trimmed = promptText.trim();
    if (trimmed.length === 0 || isDispatching) {
      return;
    }
    if (activeRepo === undefined) {
      toast.info("请先新建并配置一个本地工作区");
      setWorkspaceModalState("create");
      return;
    }
    if (props.ownedAgents.length === 0) {
      toast.info("请先接入至少 1 个本机 Agent 后再交办任务");
      props.onOpenConnectAgent();
      return;
    }

    setIsDispatching(true);
    try {
      const created = await dispatchWorkbenchTaskOnServer({
        rawPrompt: trimmed,
        topology: dispatchTopology,
        workspace: activeRepo,
        ownedAgents: props.ownedAgents,
        ...(preferredWorkerId !== "auto" ? { preferredWorkerId } : {}),
      });
      setPromptText("");
      setSelectedTaskId(created.id);
      if (selectedRepoFilter !== "all" && selectedRepoFilter !== created.repoId) {
        setSelectedRepoFilter(created.repoId);
      }
      if (attentionFilter === "needs_you" || attentionFilter === "done") {
        setAttentionFilter("board");
      }
      toast.success("已新建并交办任务", {
        description: `${created.repoName} · ${getWorkTopologyLabel(created.topology)}`,
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "派发任务失败，请稍后重试");
    } finally {
      setIsDispatching(false);
    }
  };

  const handleSelectTaskRow = (task: SoloWorkTaskView): void => {
    setSelectedTaskId(task.id);
    if (
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(max-width: 1279px)").matches
    ) {
      const params = new URLSearchParams(location.search);
      params.set("view", "workbench");
      params.set("task", task.id);
      navigateTo(`/?${params.toString()}`);
    } else {
      setLocalCompactDetailOpen(true);
    }
  };

  const viewTitle = resolveWorkbenchTitle(selectedWorkspace, attentionFilter);

  return (
    <div className="flex h-full min-w-0 flex-1 gap-2.5 overflow-hidden">
      <aside
        aria-label="工作台侧栏"
        className="relative liquid-glass-panel hidden h-full w-[216px] shrink-0 select-none flex-col overflow-hidden lg:flex lg:rounded-[22px]"
      >
        <div
          data-tauri-drag-region=""
          className="app-drag-region flex h-[52px] shrink-0 items-center justify-between px-4"
        >
          <h2 className="text-[15px] font-semibold tracking-[-0.015em] text-[#111318] dark:text-[#F2F2F4]">
            工作台
          </h2>
          <div className="app-no-drag">
            <AppDropdownMenu
              align="end"
              items={moreMenuEntries}
              trigger={
                <IconButton size="sm" variant="ghost" label="工作台选项">
                  <MoreHorizontal className="h-4 w-4" />
                </IconButton>
              }
            />
          </div>
        </div>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-2.5 pt-1 pb-3">
          <nav aria-label="任务状态" className="space-y-0.5">
            {(
              [
                { id: "board", label: "全部", count: props.counts.total, highlight: false },
                {
                  id: "needs_you",
                  label: "待确认",
                  count: props.counts.needsYou,
                  highlight: props.counts.needsYou > 0,
                },
                { id: "running", label: "进行中", count: props.counts.running, highlight: false },
                { id: "done", label: "已完成", count: props.counts.done, highlight: false },
              ] as const
            ).map((item) => {
              const active = attentionFilter === item.id && selectedRepoFilter === "all";
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    setAttentionFilter(item.id);
                    setSelectedRepoFilter("all");
                    closeCompactDetail();
                  }}
                  className={cn(
                    "im-press relative z-0 flex h-8 w-full cursor-pointer items-center justify-between rounded-[9px] px-2.5 text-left text-[13px]",
                    active
                      ? "font-medium text-[#111318] dark:text-[#F4F4F6]"
                      : "text-[#3B414E] hover:bg-black/[0.035] dark:text-[#A1A1AA] dark:hover:bg-white/[0.04]",
                  )}
                >
                  {active ? (
                    <motion.span
                      layoutId="oh-wb-source-list-pill"
                      aria-hidden="true"
                      transition={reducedMotion ? INSTANT_TRANSITION : NATIVE_PILL_SPRING}
                      className="pointer-events-none absolute inset-0 -z-10 rounded-[9px] bg-black/[0.068] will-change-transform dark:bg-white/[0.095]"
                    />
                  ) : null}
                  <span className="truncate">{item.label}</span>
                  {item.count > 0 ? (
                    <span
                      className={cn(
                        "ml-2 text-[12px] tabular-nums",
                        item.highlight
                          ? "font-semibold text-[#B45309] dark:text-[#FBBF24]"
                          : "text-[#687082] dark:text-[#71717A]",
                      )}
                    >
                      {item.count}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </nav>

          <section aria-label="工作区">
            <div className="mb-1 flex items-center justify-between px-2.5">
              <span className="text-[11px] font-medium text-[#687082] dark:text-[#8E8E96]">
                工作区
              </span>
              <button
                type="button"
                aria-label="新建工作区"
                onClick={() => setWorkspaceModalState("create")}
                className="inline-flex h-5 w-5 cursor-pointer items-center justify-center rounded-md text-[#687082] transition hover:bg-black/[0.05] hover:text-[#111318] dark:text-[#8E8E96] dark:hover:bg-white/[0.08] dark:hover:text-white"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            </div>

            <div className="space-y-0.5">
              {props.repos.map((ws) => {
                const active = selectedRepoFilter === ws.id;
                const activeCount = workspaceActiveCounts.get(ws.id) ?? 0;
                const tooltipSummary = `${ws.host.hostLabel} · ${ws.roots.map((r) => r.localPath).join(" + ")}`;
                return (
                  <AppTooltip key={ws.id} side="right" content={tooltipSummary}>
                    <button
                      type="button"
                      onClick={() => {
                        if (active) {
                          setSelectedRepoFilter("all");
                        } else {
                          setSelectedRepoFilter(ws.id);
                          applyWorkspaceDefaults(ws);
                        }
                        closeCompactDetail();
                      }}
                      className={cn(
                        "im-press relative z-0 flex h-8 w-full cursor-pointer items-center justify-between gap-2 rounded-[9px] px-2.5 text-left text-[13px]",
                        active
                          ? "font-medium text-[#111318] dark:text-[#F4F4F6]"
                          : "text-[#3B414E] hover:bg-black/[0.035] dark:text-[#A1A1AA] dark:hover:bg-white/[0.04]",
                      )}
                    >
                      {active ? (
                        <motion.span
                          layoutId="oh-wb-source-list-pill"
                          aria-hidden="true"
                          transition={reducedMotion ? INSTANT_TRANSITION : NATIVE_PILL_SPRING}
                          className="pointer-events-none absolute inset-0 -z-10 rounded-[9px] bg-black/[0.068] will-change-transform dark:bg-white/[0.095]"
                        />
                      ) : null}
                      <span className="flex min-w-0 items-center gap-2">
                        {renderWorkspaceKindGlyph(ws.kind)}
                        <span className="truncate">{ws.name}</span>
                      </span>
                      {activeCount > 0 ? (
                        <span className="shrink-0 text-[11.5px] tabular-nums text-[#687082] dark:text-[#71717A]">
                          {activeCount}
                        </span>
                      ) : null}
                    </button>
                  </AppTooltip>
                );
              })}
            </div>
          </section>

          <section aria-label="我的 Agent">
            <div className="mb-1 flex items-center justify-between px-2.5">
              <span className="text-[11px] font-medium text-[#687082] dark:text-[#8E8E96]">
                Agent
              </span>
              <button
                type="button"
                aria-label="接入新的 Agent"
                onClick={props.onOpenConnectAgent}
                className="inline-flex h-5 w-5 cursor-pointer items-center justify-center rounded-md text-[#687082] transition hover:bg-black/[0.05] hover:text-[#111318] dark:text-[#8E8E96] dark:hover:bg-white/[0.08] dark:hover:text-white"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            </div>

            {props.ownedAgents.length > 0 ? (
              <div className="space-y-0.5">
                {props.ownedAgents.map((agent) => {
                  const isBusy = busyAgentIds.has(agent.id);
                  const shortName = stripAgentOwnerPrefix(
                    agent.displayName,
                    props.currentUser.displayName,
                  );
                  return (
                    <button
                      key={agent.id}
                      type="button"
                      onClick={() => props.onInspectOwnedAgent(agent)}
                      className="flex h-8 w-full cursor-pointer items-center justify-between gap-2 rounded-[9px] px-2.5 text-left text-[13px] text-[#3B414E] transition-colors hover:bg-black/[0.035] dark:text-[#A1A1AA] dark:hover:bg-white/[0.04]"
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <PlatformAvatar
                          kind="agent"
                          displayName={agent.displayName}
                          platform={agent.platform}
                          size="sm"
                          className="[&>div]:h-5 [&>div]:w-5 [&>div]:text-[10px]"
                        />
                        <span className="truncate">{shortName}</span>
                      </span>
                      <span
                        title={isBusy ? "执行中" : "空闲"}
                        className={cn(
                          "h-1.5 w-1.5 shrink-0 rounded-full",
                          isBusy
                            ? "bg-[#16A34A] dark:bg-[#4ADE80]"
                            : "bg-black/15 dark:bg-white/20",
                        )}
                      />
                    </button>
                  );
                })}
              </div>
            ) : (
              <button
                type="button"
                onClick={props.onOpenConnectAgent}
                className="flex h-8 w-full cursor-pointer items-center gap-2 rounded-[9px] px-2.5 text-left text-[12.5px] text-[#687082] transition hover:bg-black/[0.035] hover:text-[#111318] dark:text-[#8E8E96] dark:hover:bg-white/[0.04] dark:hover:text-white"
              >
                <Plus className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">接入本机 Agent…</span>
              </button>
            )}
          </section>
        </div>
      </aside>

      <main className="relative flex h-full min-w-0 flex-1 flex-col overflow-hidden bg-sidebar-surface pt-[env(safe-area-inset-top,0px)] md:oh-stage-frame md:rounded-[22px] md:pt-0">
        <header
          data-tauri-drag-region=""
          className="app-drag-region flex h-[56px] min-w-0 shrink-0 items-center justify-between gap-2 px-3.5 md:h-[52px] md:border-b md:border-black/[0.06] md:px-4 md:dark:border-white/[0.07]"
        >
          <div className="flex min-w-0 items-center gap-2">
            {compactDetailOpen && resolvedSelectedTask !== null ? (
              <button
                type="button"
                onClick={closeCompactDetail}
                className="app-no-drag -ml-1.5 inline-flex h-8 shrink-0 cursor-pointer items-center gap-1 whitespace-nowrap rounded-full px-2.5 text-[14px] font-medium text-[#3B414E] transition hover:bg-black/[0.05] hover:text-[#111318] xl:hidden dark:text-[#C4C4CA] dark:hover:bg-white/[0.07] dark:hover:text-white"
              >
                <ArrowLeft className="h-4 w-4 shrink-0" />
                <span className="max-w-[11rem] truncate">{viewTitle}</span>
              </button>
            ) : null}

            <h1
              className={cn(
                "truncate text-[15.5px] font-semibold tracking-[-0.015em] text-[#111318] md:text-[14.5px] dark:text-[#F2F2F4]",
                compactDetailOpen && resolvedSelectedTask !== null ? "hidden xl:block" : "block",
              )}
            >
              {viewTitle}
            </h1>
          </div>

          <div className="app-no-drag flex shrink-0 items-center gap-1.5">
            {!compactDetailOpen ? (
              <div className="lg:hidden">
                <AppSelect
                  size="sm"
                  align="end"
                  ariaLabel="按工作区筛选任务"
                  value={selectedRepoFilter}
                  onValueChange={(nextWsId) => {
                    setSelectedRepoFilter(nextWsId);
                    if (nextWsId !== "all") {
                      const ws = props.repos.find((r) => r.id === nextWsId);
                      if (ws !== undefined) {
                        applyWorkspaceDefaults(ws);
                      }
                    }
                  }}
                  options={mobileWorkspaceFilterOptions}
                  className="h-8 w-auto max-w-[9.25rem] shrink-0 rounded-full px-3 text-[12.5px]"
                />
              </div>
            ) : null}

            {selectedWorkspace !== undefined ? (
              <button
                type="button"
                onClick={() => setWorkspaceModalState(selectedWorkspace)}
                className="hidden shrink-0 cursor-pointer items-center gap-1 rounded-lg px-2 py-1 text-[12px] text-[#4B5565] transition hover:bg-black/[0.05] hover:text-[#111318] lg:inline-flex dark:text-[#A1A1AA] dark:hover:bg-white/[0.07] dark:hover:text-white"
              >
                <SlidersHorizontal className="h-3.5 w-3.5" />
                <span>工作区设置</span>
              </button>
            ) : null}

            <div className="flex items-center gap-1 lg:hidden">
              <AppDropdownMenu
                align="end"
                items={moreMenuEntries}
                trigger={
                  <IconButton size="md" variant="ghost" label="更多操作">
                    <MoreHorizontal className="h-4 w-4" />
                  </IconButton>
                }
              />
            </div>
          </div>
        </header>

        {/* 窄屏（< lg）统一胶囊状态筛选栏：与「聊天」二级分类胶囊保持 100% 同款尺寸与视觉语言，左对齐防截断 */}
        {!compactDetailOpen ? (
          <div className="no-scrollbar shrink-0 overflow-x-auto overscroll-x-contain px-3.5 pb-2.5 lg:hidden">
            <fieldset className="flex min-w-0 items-center gap-1.5">
              <legend className="sr-only">按任务状态筛选</legend>
              {compactFilterTabs.map((item) => {
                const selected = attentionFilter === item.value;
                return (
                  <button
                    key={item.value}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => setAttentionFilter(item.value)}
                    className={cn(
                      "im-press relative z-0 inline-flex h-8 shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-full px-3.5 text-[13px] font-medium",
                      selected
                        ? "font-semibold text-white dark:text-[#111318]"
                        : "bg-black/[0.04] text-[#5A6274] hover:bg-black/[0.07] hover:text-[#111318] dark:bg-white/[0.055] dark:text-[#9898A2] dark:hover:bg-white/[0.09] dark:hover:text-[#F2F2F4]",
                    )}
                  >
                    {selected ? (
                      <motion.span
                        layoutId="oh-workbench-mobile-status-filter"
                        aria-hidden="true"
                        transition={reducedMotion ? INSTANT_TRANSITION : NATIVE_PILL_SPRING}
                        className="pointer-events-none absolute inset-0 -z-10 rounded-full bg-[#181B22] will-change-transform dark:bg-[#EAEEF6]"
                      />
                    ) : null}
                    <span className="relative z-10">{item.label}</span>
                    {item.badge !== undefined ? (
                      <span
                        className={cn(
                          "relative z-10 inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 font-mono text-[10.5px] leading-none font-semibold tabular-nums",
                          selected
                            ? "bg-white/20 text-white dark:bg-black/12 dark:text-[#111318]"
                            : "bg-black/[0.06] text-[#5A6274] dark:bg-white/[0.10] dark:text-[#B4B4BC]",
                        )}
                      >
                        {item.badge}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </fieldset>
          </div>
        ) : null}

        <div
          className={cn(
            "min-h-0 flex-1 overflow-hidden",
            isWideWorkbench
              ? "flex"
              : "relative grid grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)] [&>*]:col-start-1 [&>*]:row-start-1",
          )}
        >
          <AnimatePresence initial={false}>
            {isWideWorkbench || !(compactDetailOpen && resolvedSelectedTask !== null) ? (
              <motion.div
                key="wb-list-pane"
                initial={isWideWorkbench || reducedMotion ? false : { opacity: 0, x: "-14%" }}
                animate={{ opacity: 1, x: 0 }}
                exit={
                  isWideWorkbench || reducedMotion
                    ? { opacity: 0 }
                    : { opacity: 0, x: "-14%", pointerEvents: "none" }
                }
                transition={
                  reducedMotion
                    ? INSTANT_TRANSITION
                    : { type: "spring", stiffness: 440, damping: 38, mass: 0.85 }
                }
                className={cn(
                  "flex min-h-0 min-w-0 flex-col overflow-hidden",
                  isWideWorkbench
                    ? "w-[392px] flex-none shrink-0 border-r border-black/[0.06] dark:border-white/[0.07]"
                    : "col-start-1 row-start-1 h-full w-full will-change-[transform,opacity]",
                )}
              >
                {selectedWorkspace !== undefined ? (
                  <div className="shrink-0 border-b border-black/[0.06] bg-[#F4F5F7]/65 px-3.5 py-2 dark:border-white/[0.07] dark:bg-white/[0.025]">
                    <div className="flex min-w-0 items-center justify-between gap-2">
                      <div className="flex min-w-0 items-center gap-1.5 text-[11.5px] text-[#4B5565] dark:text-[#A1A1AA]">
                        <span
                          className={cn(
                            "h-1.5 w-1.5 shrink-0 rounded-full",
                            selectedWorkspace.host.online
                              ? "bg-[#16A34A] dark:bg-[#4ADE80]"
                              : "bg-[#94A3B8]",
                          )}
                        />
                        <span className="truncate">
                          {selectedWorkspace.host.hostLabel} ·{" "}
                          {formatSandboxSummary(selectedWorkspace)}
                          {selectedWorkspace.context.ruleFiles.length > 0
                            ? ` · ${selectedWorkspace.context.ruleFiles.join(", ")}`
                            : ""}
                          {selectedWorkspace.context.sharedMemoryActive ? " · 共享记忆" : ""}
                        </span>
                      </div>

                      <button
                        type="button"
                        onClick={() => setWorkspaceModalState(selectedWorkspace)}
                        className="shrink-0 cursor-pointer rounded-md px-1.5 py-0.5 text-[11.5px] text-[#4B5565] transition hover:bg-black/[0.05] hover:text-[#111318] lg:hidden dark:text-[#A1A1AA] dark:hover:bg-white/[0.07] dark:hover:text-white"
                      >
                        设置
                      </button>
                    </div>

                    <p className="mt-0.5 truncate font-mono text-[11px] text-[#687082] dark:text-[#8E8E96]">
                      {selectedWorkspace.roots
                        .map((r) =>
                          r.isGitRepo && r.defaultBranch
                            ? `${r.localPath} (${r.defaultBranch})`
                            : r.localPath,
                        )
                        .join(" + ")}
                    </p>
                  </div>
                ) : null}

                <div className="mx-3 mb-2.5 shrink-0 rounded-2xl border border-black/[0.06] bg-im-surface/80 px-3.5 py-2.5 lg:mx-0 lg:mb-0 lg:rounded-none lg:border-x-0 lg:border-t-0 lg:bg-white/40 dark:border-white/[0.07] dark:bg-white/[0.04] lg:dark:bg-white/[0.015]">
                  <div className="flex min-w-0 items-center gap-2">
                    <Plus className="h-4 w-4 shrink-0 text-[#8E96A6] dark:text-[#71717A]" />
                    <input
                      type="text"
                      enterKeyHint="send"
                      value={promptText}
                      onChange={(e) => setPromptText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !isImeComposing(e)) {
                          e.preventDefault();
                          void handleDispatchSubmit();
                        }
                      }}
                      disabled={isDispatching}
                      placeholder={
                        selectedWorkspace !== undefined
                          ? `在「${selectedWorkspace.name}」新建任务，回车交办…`
                          : "新建任务，回车交办…"
                      }
                      className="min-w-0 flex-1 bg-transparent py-0.5 text-[16px] text-[#111318] placeholder:text-[14px] placeholder:text-[#8E96A6] focus:outline-none disabled:opacity-60 md:text-[13.5px] md:placeholder:text-[13.5px] dark:text-[#F2F2F4] dark:placeholder:text-[#71717A]"
                    />
                    {promptText.trim().length > 0 ? (
                      <AppButton
                        size="xs"
                        variant="primary"
                        disabled={isDispatching}
                        className="shrink-0"
                        onClick={() => void handleDispatchSubmit()}
                      >
                        {isDispatching ? "交办中…" : "交办"}
                      </AppButton>
                    ) : null}
                  </div>

                  <div className="mt-2 flex min-w-0 flex-wrap items-center gap-1.5 pl-6">
                    {activeRepo !== undefined ? (
                      <AppSelect
                        size="sm"
                        ariaLabel="选择工作区"
                        value={activeRepo.id}
                        onValueChange={(nextWsId) => {
                          const nextWs = props.repos.find((r) => r.id === nextWsId);
                          if (nextWs !== undefined) {
                            applyWorkspaceDefaults(nextWs);
                          } else {
                            setDispatchRepoId(nextWsId);
                          }
                        }}
                        options={repoSelectOptions}
                        className="h-7 w-auto max-w-[144px] shrink-0 rounded-full px-2.5 text-[12px]"
                      />
                    ) : null}

                    <AppSelect
                      size="sm"
                      ariaLabel="选择协作方式"
                      value={dispatchTopology}
                      onValueChange={setDispatchTopology}
                      options={TOPOLOGY_OPTIONS}
                      className="h-7 w-auto max-w-[124px] shrink-0 rounded-full px-2.5 text-[12px]"
                    />

                    {props.ownedAgents.length > 0 ? (
                      <AppSelect
                        size="sm"
                        ariaLabel="选择执行 Agent"
                        value={preferredWorkerId}
                        onValueChange={(val) =>
                          setPreferredWorkerId(val === "auto" ? "auto" : (val as AgentId))
                        }
                        options={workerSelectOptions}
                        className="h-7 w-auto max-w-[136px] shrink-0 rounded-full px-2.5 text-[12px]"
                      />
                    ) : null}
                  </div>
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto">
                  <motion.div
                    key={`${selectedRepoFilter}:${attentionFilter}`}
                    initial={reducedMotion ? false : { opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={reducedMotion ? INSTANT_TRANSITION : NATIVE_VIEW_SWAP}
                    className="min-h-full"
                  >
                    {filteredTasks.length === 0 ? (
                      <div className="flex h-full min-h-[240px] flex-col items-center justify-center px-6 text-center">
                        <p className="text-[13.5px] font-medium text-[#3B414E] dark:text-[#C4C4CA]">
                          {selectedWorkspace !== undefined
                            ? `「${selectedWorkspace.name}」暂无任务`
                            : "暂无任务"}
                        </p>
                        <p className="mt-1 text-[12px] text-[#8E96A6] dark:text-[#71717A]">
                          {props.ownedAgents.length === 0
                            ? "接入本机 CLI Agent 后，在上方输入任务描述即可真实执行并追踪过程"
                            : "在上方输入任务描述并按回车即可在本机工作区真实执行"}
                        </p>
                        <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
                          {props.ownedAgents.length === 0 ? (
                            <button
                              type="button"
                              onClick={props.onOpenConnectAgent}
                              className="cursor-pointer rounded-lg px-2.5 py-1 text-[12px] font-medium text-[#2563EB] transition hover:bg-black/[0.05] dark:text-[#60A5FA] dark:hover:bg-white/[0.07]"
                            >
                              接入本机 Agent
                            </button>
                          ) : null}
                          {selectedWorkspace !== undefined ? (
                            <button
                              type="button"
                              onClick={() => setWorkspaceModalState(selectedWorkspace)}
                              className="cursor-pointer rounded-lg px-2.5 py-1 text-[12px] font-medium text-[#3B414E] transition hover:bg-black/[0.05] dark:text-[#A1A1AA] dark:hover:bg-white/[0.07]"
                            >
                              查看工作区配置
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={() => setWorkspaceModalState("create")}
                              className="cursor-pointer rounded-lg px-2.5 py-1 text-[12px] font-medium text-[#3B414E] transition hover:bg-black/[0.05] dark:text-[#A1A1AA] dark:hover:bg-white/[0.07]"
                            >
                              新建工作区
                            </button>
                          )}
                        </div>
                      </div>
                    ) : (
                      <div className="pb-24 md:pb-4">
                        {needsYouTasks.length > 0 ? (
                          <TaskListGroup
                            heading="待确认"
                            tasks={needsYouTasks}
                            selectedId={resolvedSelectedTask?.id ?? null}
                            onSelect={handleSelectTaskRow}
                          />
                        ) : null}

                        {runningTasks.length > 0 ? (
                          <TaskListGroup
                            heading="进行中"
                            tasks={runningTasks}
                            selectedId={resolvedSelectedTask?.id ?? null}
                            onSelect={handleSelectTaskRow}
                          />
                        ) : null}

                        {settledTasks.length > 0 ? (
                          <TaskListGroup
                            heading="已完成"
                            tasks={settledTasks}
                            selectedId={resolvedSelectedTask?.id ?? null}
                            onSelect={handleSelectTaskRow}
                          />
                        ) : null}
                      </div>
                    )}
                  </motion.div>
                </div>
              </motion.div>
            ) : null}

            {isWideWorkbench || (compactDetailOpen && resolvedSelectedTask !== null) ? (
              <motion.div
                key="wb-detail-pane"
                initial={isWideWorkbench || reducedMotion ? false : { opacity: 0, x: "22%" }}
                animate={{ opacity: 1, x: 0 }}
                exit={
                  isWideWorkbench || reducedMotion
                    ? { opacity: 0 }
                    : { opacity: 0, x: "22%", pointerEvents: "none" }
                }
                transition={
                  reducedMotion
                    ? INSTANT_TRANSITION
                    : { type: "spring", stiffness: 440, damping: 38, mass: 0.85 }
                }
                className={cn(
                  "flex min-h-0 min-w-0 flex-col overflow-hidden bg-white/50 dark:bg-[#161619]/80",
                  isWideWorkbench
                    ? "flex-1"
                    : "col-start-1 row-start-1 h-full w-full will-change-[transform,opacity]",
                )}
              >
                {resolvedSelectedTask !== null ? (
                  <motion.div
                    key={resolvedSelectedTask.id}
                    initial={reducedMotion ? false : { opacity: 0, y: 3 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={reducedMotion ? INSTANT_TRANSITION : NATIVE_VIEW_SWAP}
                    className="flex min-h-0 flex-1 flex-col overflow-hidden"
                  >
                    <WorkbenchTaskDetailPane
                      task={resolvedSelectedTask}
                      workspace={resolvedTaskWorkspace}
                      ownerDisplayName={props.currentUser.displayName}
                      isEscalating={props.escalatingTaskId === resolvedSelectedTask.id}
                      onEscalate={() => props.onEscalateToHuddle(resolvedSelectedTask)}
                      onOpenEscalatedRoom={props.onOpenEscalatedRoom}
                      onConfigureWorkspace={(ws) => setWorkspaceModalState(ws)}
                    />
                  </motion.div>
                ) : (
                  <div className="flex flex-1 items-center justify-center p-8 text-center text-[13px] text-[#8E96A6] dark:text-[#71717A]">
                    选择左侧任务查看变更与执行详情
                  </div>
                )}
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>
      </main>

      {(() => {
        const modalTarget = workspaceModalState ?? lastWorkspaceModalRef.current;
        return (
          <WorkspaceConfigModal
            key={modalTarget === "create" ? "create-ws" : modalTarget.id}
            open={workspaceModalState !== null}
            initialWorkspace={modalTarget === "create" ? null : modalTarget}
            canDelete={modalTarget !== "create" && props.repos.length > 1}
            ownedAgents={props.ownedAgents}
            ownerDisplayName={props.currentUser.displayName}
            onClose={() => setWorkspaceModalState(null)}
            onSaved={(saved) => {
              setSelectedRepoFilter(saved.id);
              applyWorkspaceDefaults(saved);
              setWorkspaceModalState(null);
            }}
            onDeleted={() => {
              setSelectedRepoFilter("all");
              setWorkspaceModalState(null);
            }}
          />
        );
      })()}
    </div>
  );
}

interface TaskListGroupProps {
  readonly heading: string;
  readonly tasks: ReadonlyArray<SoloWorkTaskView>;
  readonly selectedId: string | null;
  readonly onSelect: (task: SoloWorkTaskView) => void;
}

function TaskListGroup(props: TaskListGroupProps) {
  return (
    <section>
      <div className="sticky top-0 z-10 flex items-center justify-between border-b border-black/[0.045] bg-[#ECEEF0]/92 px-4 py-1.5 text-[11.5px] font-medium text-[#687082] dark:border-white/[0.055] dark:bg-[#19191D]/95 dark:text-[#8E8E96]">
        <span>{props.heading}</span>
        <span className="tabular-nums">{props.tasks.length}</span>
      </div>

      <div className="divide-y divide-black/[0.045] dark:divide-white/[0.055]">
        {props.tasks.map((task) => {
          const selected = props.selectedId === task.id;
          return (
            <button
              key={task.id}
              type="button"
              onClick={() => props.onSelect(task)}
              className={cn(
                "flex w-full cursor-pointer items-start gap-2.5 px-4 py-3 text-left transition-colors active:bg-black/[0.04] dark:active:bg-white/[0.05]",
                selected
                  ? "xl:bg-white xl:shadow-[inset_2.5px_0_0_#181B22] dark:xl:bg-white/[0.065] dark:xl:shadow-[inset_2.5px_0_0_#F2F2F4]"
                  : "hover:bg-white/55 dark:hover:bg-white/[0.03]",
              )}
            >
              <span className="mt-0.5 shrink-0">
                <WorkStageGlyph stage={task.stage} size="md" />
              </span>

              <div className="min-w-0 flex-1">
                <p
                  className={cn(
                    "break-words text-[13.5px] leading-snug",
                    task.stage === "done" || task.stage === "cancelled"
                      ? "text-[#687082] dark:text-[#8E8E96]"
                      : "font-medium text-[#111318] dark:text-[#F2F2F4]",
                  )}
                >
                  {task.title}
                </p>
                <p className="mt-1 truncate text-[12px] text-[#687082] dark:text-[#8E8E96]">
                  {formatTaskSecondaryLine(task)}
                </p>
              </div>

              <div className="mt-0.5 flex shrink-0 items-center gap-2">
                {(() => {
                  const liveAdded =
                    task.review?.additions ??
                    task.slices.reduce((sum, s) => sum + (s.diffAdded ?? 0), 0);
                  const liveDeleted =
                    task.review?.deletions ??
                    task.slices.reduce((sum, s) => sum + (s.diffRemoved ?? 0), 0);
                  if (liveAdded > 0 || liveDeleted > 0) {
                    return (
                      <span className="font-mono text-[11px] tabular-nums">
                        <span className="text-[#15803D] dark:text-[#4ADE80]">+{liveAdded}</span>{" "}
                        <span className="text-[#B91C1C] dark:text-[#F87171]">-{liveDeleted}</span>
                      </span>
                    );
                  }
                  if (isSoloRunningStage(task.stage)) {
                    return (
                      <span className="inline-flex items-center gap-1 font-mono text-[10.5px] text-[#16A34A] dark:text-[#4ADE80]">
                        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
                        <span>执行中</span>
                      </span>
                    );
                  }
                  return null;
                })()}

                <PlatformAvatar
                  kind="agent"
                  displayName={task.primaryWorker.displayName}
                  platform={task.primaryWorker.platform}
                  size="sm"
                  className="[&>div]:h-5 [&>div]:w-5 [&>div]:text-[10px]"
                />

                <ChevronRight className="h-3.5 w-3.5 text-[#94A3B8] xl:hidden dark:text-[#52525B]" />
              </div>
            </button>
          );
        })}
      </div>
    </section>
  );
}
