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
  type SupportedLocale,
  assertNever,
} from "@openhuddle/protocol";
import {
  ArrowLeft,
  ChevronRight,
  Folder,
  FolderGit2,
  Folders,
  Languages,
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
import { getReachVisualMeta } from "../../../lib/format.js";
import { navigateBackOr, navigateTo, useBrowserLocation } from "../../../lib/session-store.js";
import { isImeComposing } from "../../../lib/viewport-sync.js";
import { getWorkbenchTranslator, useWorkbenchI18n } from "../i18n/workbench.js";
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
import {
  WorkStageGlyph,
  getWorkTopologyLabel,
  resolveEffectiveDispatchTopology,
  stripAgentOwnerPrefix,
  workspaceSupportsSwarm,
} from "../work/work-utils.js";
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
  readonly onOpenAccountSecurity?: (() => void) | undefined;
}

function formatTaskSecondaryLine(task: SoloWorkTaskView, locale: SupportedLocale): string {
  const { t, tp } = getWorkbenchTranslator(locale);
  switch (task.stage) {
    case "awaiting_answer":
      return t("workbench.secondary.awaitingAnswer", { repo: task.repoName });
    case "awaiting_review":
      return task.review !== undefined
        ? tp("secondary.filesChanged", task.review.filesChanged, { repo: task.repoName })
        : t("workbench.secondary.awaitingReviewFallback", { repo: task.repoName });
    case "blocked":
      return t("workbench.secondary.blocked", { repo: task.repoName });
    case "working": {
      const runningSlice = task.slices.find((s) => s.status === "running") ?? task.slices[0];
      return runningSlice !== undefined
        ? `${task.repoName} · ${runningSlice.liveSummary}`
        : t("workbench.secondary.workingFallback", { repo: task.repoName });
    }
    case "verifying":
      return `${task.repoName} · ${task.slices.find((s) => s.leaseRole === "verify")?.liveSummary ?? t("workbench.secondary.verifyingFallback")}`;
    case "done":
      return t("workbench.secondary.done", { repo: task.repoName });
    case "cancelled":
      return t("workbench.secondary.cancelled", { repo: task.repoName });
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

function formatSandboxSummary(ws: AgentWorkspace, locale: SupportedLocale): string {
  const { t } = getWorkbenchTranslator(locale);
  switch (ws.sandboxMode) {
    case "worktree_pool":
      return ws.prewarmedWorktrees > 0
        ? t("sandbox.worktreePoolReady", { count: ws.prewarmedWorktrees })
        : t("sandbox.worktreePool");
    case "in_place":
      return t("sandbox.inPlaceExclusive");
    case "read_only":
      return t("sandbox.readOnly");
    default:
      return assertNever(ws.sandboxMode);
  }
}

function resolveWorkbenchTitle(
  selectedWorkspace: AgentWorkspace | undefined,
  filter: WorkbenchAttentionFilter,
  locale: SupportedLocale,
): string {
  if (selectedWorkspace !== undefined) {
    return selectedWorkspace.name;
  }
  const { t } = getWorkbenchTranslator(locale);
  switch (filter) {
    case "board":
      return t("filter.allTasks");
    case "needs_you":
      return t("filter.needsYou");
    case "running":
      return t("filter.running");
    case "done":
      return t("filter.done");
    default:
      return assertNever(filter);
  }
}

/**
 * 个人工作台主视图组件。
 */
export function SoloWorkbench(props: SoloWorkbenchProps) {
  const { locale, t } = useWorkbenchI18n();
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
  const promptInputRef = useRef<HTMLInputElement | null>(null);
  const focusPromptTimerRef = useRef<number | null>(null);
  const initialWorkspace =
    props.repos.find((repo) => repo.id === props.initialWorkspaceId) ?? props.repos[0];
  const [dispatchRepoId, setDispatchRepoId] = useState<string>(
    () => props.initialWorkspaceId ?? initialWorkspace?.id ?? "",
  );
  const [dispatchTopology, setDispatchTopology] = useState<WorkTopology>(
    () => initialWorkspace?.defaultTopology ?? "verify_loop",
  );
  const [preferredWorkerId, setPreferredWorkerId] = useState<AgentId | "auto">(
    () => initialWorkspace?.defaultWorkerId ?? "auto",
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
    return () => {
      if (focusPromptTimerRef.current !== null && typeof window !== "undefined") {
        window.clearTimeout(focusPromptTimerRef.current);
      }
    };
  }, []);

  const focusPromptInput = useCallback((): void => {
    const focusNow = (): void => {
      const el = promptInputRef.current;
      if (!el) {
        return;
      }
      el.focus();
      const len = el.value.length;
      el.setSelectionRange(len, len);
    };
    if (typeof window === "undefined") {
      return;
    }
    window.requestAnimationFrame(focusNow);
    if (focusPromptTimerRef.current !== null) {
      window.clearTimeout(focusPromptTimerRef.current);
    }
    focusPromptTimerRef.current = window.setTimeout(() => {
      focusPromptTimerRef.current = null;
      focusNow();
    }, 180);
  }, []);

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
  const activeRepoSupportsSwarm =
    activeRepo === undefined ? false : workspaceSupportsSwarm(activeRepo);
  const topologyOptions = useMemo<ReadonlyArray<AppSelectOption<WorkTopology>>>(
    () => [
      {
        value: "direct",
        label: t("topology.direct.label"),
        description: t("topology.direct.description"),
      },
      {
        value: "verify_loop",
        label: t("topology.verifyLoop.label"),
        description: t("topology.verifyLoop.description"),
      },
      {
        value: "swarm",
        label: t("topology.swarm.label"),
        description: activeRepoSupportsSwarm
          ? t("topology.swarm.description")
          : t("topology.swarm.disabledReason"),
        ...(!activeRepoSupportsSwarm ? { disabled: true } : {}),
      },
    ],
    [activeRepoSupportsSwarm, t],
  );
  const effectiveDispatchTopology = resolveEffectiveDispatchTopology({
    requested: dispatchTopology,
    workspace: activeRepo,
    agentCount: props.ownedAgents.length,
  });

  const repoSelectOptions: ReadonlyArray<AppSelectOption<string>> = useMemo(
    () => props.repos.map((r) => ({ value: r.id, label: r.name })),
    [props.repos],
  );

  const mobileWorkspaceFilterOptions: ReadonlyArray<AppSelectOption<string>> = useMemo(
    () => [
      { value: "all", label: t("filter.allWorkspaces") },
      ...props.repos.map((r) => ({ value: r.id, label: r.name })),
    ],
    [props.repos, t],
  );

  const workerSelectOptions: ReadonlyArray<AppSelectOption<string>> = useMemo(
    () => [
      { value: "auto", label: t("assign.auto") },
      ...props.ownedAgents.map((a) => ({
        value: a.id,
        label: `${stripAgentOwnerPrefix(a.displayName, props.currentUser.displayName)} · ${a.workspaceListenerConnected ? t("workbench.workerListenerConnected") : getReachVisualMeta(a.reach, locale).shortLabel}`,
      })),
    ],
    [locale, props.currentUser.displayName, props.ownedAgents, t],
  );

  const compactFilterTabs: ReadonlyArray<SegmentedTabItem<WorkbenchAttentionFilter>> = useMemo(
    () => [
      { value: "board", label: t("filter.all") },
      {
        value: "needs_you",
        label: t("filter.needsYou"),
        ...(props.counts.needsYou > 0 ? { badge: String(props.counts.needsYou) } : {}),
      },
      {
        value: "running",
        label: t("filter.running"),
        ...(props.counts.running > 0 ? { badge: String(props.counts.running) } : {}),
      },
      { value: "done", label: t("filter.done") },
    ],
    [props.counts.needsYou, props.counts.running, t],
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
        label: t("workbench.menu.newWorkspace"),
        icon: <Plus className="h-3.5 w-3.5" />,
        onSelect: () => setWorkspaceModalState("create"),
      },
      ...(activeRepo !== undefined
        ? [
            {
              id: "wb-edit-workspace",
              label: t("workbench.menu.editWorkspace", {
                name: (selectedWorkspace ?? activeRepo).name,
              }),
              icon: <SlidersHorizontal className="h-3.5 w-3.5" />,
              onSelect: () => setWorkspaceModalState(selectedWorkspace ?? activeRepo),
            } satisfies AppDropdownEntry,
          ]
        : []),
      {
        id: "wb-connect-agent",
        label: t("workbench.menu.connectAgent"),
        icon: <Plus className="h-3.5 w-3.5" />,
        onSelect: props.onOpenConnectAgent,
      },
      ...(props.onOpenAccountSecurity !== undefined
        ? [
            {
              id: "wb-account-security",
              label: t("workbench.menu.accountSecurity"),
              icon: <Languages className="h-3.5 w-3.5" />,
              onSelect: props.onOpenAccountSecurity,
            } satisfies AppDropdownEntry,
          ]
        : []),
    ],
    [activeRepo, props.onOpenAccountSecurity, props.onOpenConnectAgent, selectedWorkspace, t],
  );

  const handleDispatchSubmit = async (): Promise<void> => {
    const trimmed = promptText.trim();
    if (trimmed.length === 0 || isDispatching) {
      return;
    }
    if (activeRepo === undefined) {
      toast.info(t("workbench.toast.needWorkspace"));
      setWorkspaceModalState("create");
      return;
    }
    if (props.ownedAgents.length === 0) {
      toast.info(t("workbench.toast.needAgent"));
      props.onOpenConnectAgent();
      return;
    }

    setIsDispatching(true);
    try {
      const created = await dispatchWorkbenchTaskOnServer({
        rawPrompt: trimmed,
        topology: effectiveDispatchTopology,
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
      toast.success(t("workbench.toast.dispatched"), {
        description: `${created.repoName} · ${getWorkTopologyLabel(created.topology, locale)}`,
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("workbench.toast.dispatchFailed"));
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

  const viewTitle = resolveWorkbenchTitle(selectedWorkspace, attentionFilter, locale);

  return (
    <div className="flex h-full min-w-0 flex-1 gap-2.5 overflow-hidden">
      <aside
        aria-label={t("workbench.sidebarAriaLabel")}
        className="relative liquid-glass-panel hidden h-full w-[216px] shrink-0 select-none flex-col overflow-hidden lg:flex lg:rounded-[22px]"
      >
        <div
          data-tauri-drag-region=""
          className="app-drag-region flex h-[52px] shrink-0 items-center justify-between px-4"
        >
          <h2 className="text-[15px] font-semibold tracking-[-0.015em] text-[#111318] dark:text-[#F2F2F4]">
            {t("workbench.title")}
          </h2>
          <div className="app-no-drag">
            <AppDropdownMenu
              align="end"
              items={moreMenuEntries}
              trigger={
                <IconButton size="sm" variant="ghost" label={t("workbench.optionsAriaLabel")}>
                  <MoreHorizontal className="h-4 w-4" />
                </IconButton>
              }
            />
          </div>
        </div>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-2.5 pt-1 pb-3">
          <nav aria-label={t("workbench.statusNavAriaLabel")} className="space-y-0.5">
            {(
              [
                {
                  id: "board",
                  label: t("filter.all"),
                  count: props.counts.total,
                  highlight: false,
                },
                {
                  id: "needs_you",
                  label: t("filter.needsYou"),
                  count: props.counts.needsYou,
                  highlight: props.counts.needsYou > 0,
                },
                {
                  id: "running",
                  label: t("filter.running"),
                  count: props.counts.running,
                  highlight: false,
                },
                { id: "done", label: t("filter.done"), count: props.counts.done, highlight: false },
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

          <section aria-label={t("workbench.workspacesSection")}>
            <div className="mb-1 flex items-center justify-between px-2.5">
              <span className="text-[11px] font-medium text-[#687082] dark:text-[#8E8E96]">
                {t("workbench.workspacesSection")}
              </span>
              <button
                type="button"
                aria-label={t("workbench.newWorkspaceAriaLabel")}
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

          <section aria-label={t("workbench.agentsSectionAriaLabel")}>
            <div className="mb-1 flex items-center justify-between px-2.5">
              <span className="text-[11px] font-medium text-[#687082] dark:text-[#8E8E96]">
                {t("workbench.agentsHeading")}
              </span>
              <button
                type="button"
                aria-label={t("workbench.connectNewAgentAriaLabel")}
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
                        title={isBusy ? t("workbench.agentBusy") : t("workbench.agentIdle")}
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
                <span className="truncate">{t("workbench.connectLocalAgentEllipsis")}</span>
              </button>
            )}
          </section>
        </div>
      </aside>

      <main className="relative flex h-full min-w-0 flex-1 flex-col overflow-hidden bg-sidebar-surface pt-[env(safe-area-inset-top,0px)] md:oh-stage-frame md:rounded-[22px] md:pt-0">
        <header
          data-tauri-drag-region=""
          className="oh-mobile-header app-drag-region flex h-[56px] min-w-0 shrink-0 items-center justify-between gap-2 px-3.5 md:h-[52px] md:border-b md:border-black/[0.06] md:px-4 md:dark:border-white/[0.07]"
        >
          <div className="flex min-w-0 items-center gap-2">
            {compactDetailOpen && resolvedSelectedTask !== null ? (
              <button
                type="button"
                onClick={closeCompactDetail}
                aria-label={t("workbench.backToAriaLabel", { title: viewTitle })}
                className="app-no-drag -ml-1.5 inline-flex h-8 shrink-0 cursor-pointer items-center gap-1 whitespace-nowrap rounded-full px-2.5 text-[14px] font-medium text-[#3B414E] transition hover:bg-black/[0.05] hover:text-[#111318] xl:hidden dark:text-[#C4C4CA] dark:hover:bg-white/[0.07] dark:hover:text-white"
              >
                <ArrowLeft className="h-4 w-4 shrink-0" />
                <span className="oh-workbench-back-label max-w-[11rem] truncate">{viewTitle}</span>
                <span className="oh-workbench-editing-title hidden max-w-[50vw] truncate">
                  {resolvedSelectedTask.title}
                </span>
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
                  ariaLabel={t("workbench.filterByWorkspaceAriaLabel")}
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
                <span>{t("workbench.workspaceSettings")}</span>
              </button>
            ) : null}

            <div className="flex items-center gap-1 lg:hidden">
              <AppDropdownMenu
                align="end"
                items={moreMenuEntries}
                trigger={
                  <IconButton size="md" variant="ghost" label={t("workbench.moreActionsAriaLabel")}>
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
              <legend className="sr-only">{t("workbench.filterByStatusLegend")}</legend>
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
                          {formatSandboxSummary(selectedWorkspace, locale)}
                          {selectedWorkspace.context.ruleFiles.length > 0
                            ? ` · ${selectedWorkspace.context.ruleFiles.join(", ")}`
                            : ""}
                          {selectedWorkspace.context.sharedMemoryActive
                            ? ` · ${t("workbench.sharedMemory")}`
                            : ""}
                        </span>
                      </div>

                      <button
                        type="button"
                        onClick={() => setWorkspaceModalState(selectedWorkspace)}
                        className="shrink-0 cursor-pointer rounded-md px-1.5 py-0.5 text-[11.5px] text-[#4B5565] transition hover:bg-black/[0.05] hover:text-[#111318] lg:hidden dark:text-[#A1A1AA] dark:hover:bg-white/[0.07] dark:hover:text-white"
                      >
                        {t("workbench.settingsShort")}
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
                      ref={promptInputRef}
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
                          ? t("workbench.promptPlaceholderInWorkspace", {
                              name: selectedWorkspace.name,
                            })
                          : t("workbench.promptPlaceholderDefault")
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
                        {isDispatching ? t("workbench.dispatching") : t("workbench.dispatch")}
                      </AppButton>
                    ) : null}
                  </div>

                  {props.repos.length === 0 ? (
                    <div className="mt-2 flex min-w-0 flex-wrap items-center justify-between gap-2 pl-6 text-[11.5px] text-[#687082] dark:text-[#8E8E96]">
                      <span className="min-w-0">{t("workbench.firstWorkspaceHint")}</span>
                      <button
                        type="button"
                        onClick={() => setWorkspaceModalState("create")}
                        className="relative shrink-0 cursor-pointer rounded-md px-2 py-0.5 text-[11.5px] font-medium text-[#2563EB] transition hover:bg-black/[0.05] [@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:-inset-x-1 [@media(pointer:coarse)]:after:-inset-y-2 dark:text-[#60A5FA] dark:hover:bg-white/[0.07]"
                      >
                        {t("workbench.newWorkspace")}
                      </button>
                    </div>
                  ) : null}

                  <div className="mt-2 flex min-w-0 flex-wrap items-center gap-1.5 pl-6">
                    {activeRepo !== undefined ? (
                      <AppSelect
                        size="sm"
                        ariaLabel={t("workbench.selectWorkspaceAriaLabel")}
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
                      ariaLabel={t("workbench.selectTopologyAriaLabel")}
                      value={effectiveDispatchTopology}
                      onValueChange={setDispatchTopology}
                      options={topologyOptions}
                      className="h-7 w-auto max-w-[124px] shrink-0 rounded-full px-2.5 text-[12px]"
                    />

                    {props.ownedAgents.length > 0 ? (
                      <AppSelect
                        size="sm"
                        ariaLabel={t("workbench.selectAgentAriaLabel")}
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

                <div className="oh-mobile-nav-list min-h-0 flex-1 overflow-y-auto">
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
                            ? t("workbench.emptyInWorkspace", { name: selectedWorkspace.name })
                            : t("workbench.emptyDefault")}
                        </p>
                        <p className="mt-1 text-[12px] text-[#8E96A6] dark:text-[#71717A]">
                          {props.ownedAgents.length === 0
                            ? t("workbench.emptyHintNoAgents")
                            : t("workbench.emptyHintWithAgents")}
                        </p>
                        <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
                          {props.ownedAgents.length === 0 ? (
                            <button
                              type="button"
                              onClick={props.onOpenConnectAgent}
                              className="cursor-pointer rounded-lg px-2.5 py-1 text-[12px] font-medium text-[#2563EB] transition hover:bg-black/[0.05] dark:text-[#60A5FA] dark:hover:bg-white/[0.07]"
                            >
                              {t("workbench.connectLocalAgent")}
                            </button>
                          ) : null}
                          {selectedWorkspace !== undefined ? (
                            <button
                              type="button"
                              onClick={() => setWorkspaceModalState(selectedWorkspace)}
                              className="cursor-pointer rounded-lg px-2.5 py-1 text-[12px] font-medium text-[#3B414E] transition hover:bg-black/[0.05] dark:text-[#A1A1AA] dark:hover:bg-white/[0.07]"
                            >
                              {t("workbench.viewWorkspaceConfig")}
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={() => setWorkspaceModalState("create")}
                              className="cursor-pointer rounded-lg px-2.5 py-1 text-[12px] font-medium text-[#3B414E] transition hover:bg-black/[0.05] dark:text-[#A1A1AA] dark:hover:bg-white/[0.07]"
                            >
                              {t("workbench.newWorkspace")}
                            </button>
                          )}
                        </div>
                      </div>
                    ) : (
                      <div className="pb-4">
                        {needsYouTasks.length > 0 ? (
                          <TaskListGroup
                            heading={t("filter.needsYou")}
                            tasks={needsYouTasks}
                            selectedId={resolvedSelectedTask?.id ?? null}
                            onSelect={handleSelectTaskRow}
                          />
                        ) : null}

                        {runningTasks.length > 0 ? (
                          <TaskListGroup
                            heading={t("filter.running")}
                            tasks={runningTasks}
                            selectedId={resolvedSelectedTask?.id ?? null}
                            onSelect={handleSelectTaskRow}
                          />
                        ) : null}

                        {settledTasks.length > 0 ? (
                          <TaskListGroup
                            heading={t("filter.done")}
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
                      ownedAgents={props.ownedAgents}
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
                    {t("workbench.selectTaskPrompt")}
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
              const wasCreating = workspaceModalState === "create";
              setSelectedRepoFilter(saved.id);
              applyWorkspaceDefaults(saved);
              setWorkspaceModalState(null);
              if (wasCreating) {
                focusPromptInput();
              }
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
  const { locale, t } = useWorkbenchI18n();
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
                  {formatTaskSecondaryLine(task, locale)}
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
                        <span>{t("slice.status.running")}</span>
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
