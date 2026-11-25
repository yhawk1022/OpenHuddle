/**
 * @module web/features/huddle-room/workbench-task-detail
 * @description 个人工作台右侧详情、实时执行追踪流（Live Trace）与 Unified Diff 代码审阅面板。
 */
import type { OwnedAgentSummaryDto, RoomId, WorkTraceEntry } from "@openhuddle/protocol";
import {
  ArrowUp,
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  FileCode2,
  GitBranch,
  MessageSquarePlus,
  RotateCcw,
  SlidersHorizontal,
  Square,
  Terminal,
} from "lucide-react";
import {
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  AnimatePresence,
  AppButton,
  type AppDropdownEntry,
  AppDropdownMenu,
  AppInput,
  AppPopover,
  INSTANT_TRANSITION,
  IconButton,
  NATIVE_PILL_SPRING,
  NATIVE_VIEW_SWAP,
  type SegmentedTabItem,
  SegmentedTabs,
  cn,
  motion,
  toast,
  usePrefersReducedMotion,
} from "../../../components/primitives/index.js";
import { PlatformAvatar } from "../../../components/ui/identity-badges.js";
import { HighlightedTokenLine } from "../../../components/ui/syntax-code.js";
import { inferSyntaxLanguageFromPath, tokenizeCodeLines } from "../../../lib/syntax-highlight.js";
import { isCoarsePointerDevice, isImeComposing } from "../../../lib/viewport-sync.js";
import { isLoopbackOrigin } from "../../auth-pairing/connect-instructions.js";
import {
  type AgentWorkspace,
  type SoloDiffFile,
  type SoloWorkTaskView,
  isSoloRunningStage,
} from "../work/solo-workbench-store.js";
import {
  answerWorkAttentionOnServer,
  controlWorkTaskOnServer,
  decideWorkReviewOnServer,
  steerWorkTaskOnServer,
} from "../work/work-server-sync.js";
import { getSliceProgressSummary } from "../work/work-trace-summary.js";
import type { WorkSliceNode } from "../work/work-types.js";
import {
  WorkStageGlyph,
  copyTextWithFeedback,
  formatElapsedCompact,
  getClaimListenerHint,
  getSliceWaitLabel,
  stripAgentOwnerPrefix,
} from "../work/work-utils.js";
import { WorkbenchTraceEvents } from "./workbench-trace-events.js";

type DetailSectionTab = "changes" | "steps";

function WorkbenchTraceScrollArea({
  followLiveTrace,
  children,
}: {
  readonly followLiveTrace: boolean;
  readonly children: ReactNode;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const container = scrollRef.current;
    const content = contentRef.current;
    if (!followLiveTrace || !container || !content) return;

    let atBottom = true;
    const rememberPosition = () => {
      atBottom = container.scrollHeight - container.scrollTop - container.clientHeight <= 4;
    };
    const followLatest = () => {
      if (atBottom && !container.querySelector("details[open]")) {
        container.scrollTop = container.scrollHeight;
      }
    };

    followLatest();
    container.addEventListener("scroll", rememberPosition, { passive: true });
    let observer: ResizeObserver | MutationObserver;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(followLatest);
      observer.observe(container);
      observer.observe(content);
    } else {
      // The viewport synchronizer writes the current keyboard and viewport size to <html>.
      observer = new MutationObserver(followLatest);
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["style", "data-keyboard-open"],
      });
      observer.observe(content, { childList: true, subtree: true, characterData: true });
    }
    return () => {
      container.removeEventListener("scroll", rememberPosition);
      observer.disconnect();
    };
  }, [followLiveTrace]);

  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-3.5 @[640px]:px-5">
      <div ref={contentRef}>{children}</div>
    </div>
  );
}

function sanitizeWorktreeSegment(raw: string): string {
  const cleaned = raw
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned.length > 0 ? cleaned.slice(0, 72) : "default";
}

function resolveLocalRunnerPath(ws: AgentWorkspace, branch: string): string {
  if (ws.sandboxMode !== "worktree_pool" || !branch.includes("/")) {
    return ws.localPath;
  }
  return `~/.openhuddle/worktrees/${sanitizeWorktreeSegment(ws.id)}/${sanitizeWorktreeSegment(branch)}`;
}

// Worktree paths are opened on the executing device. Quote for PowerShell on Windows and POSIX shells elsewhere.
export function quoteWorkbenchPath(path: string): string {
  if (/^(?:[A-Za-z]:[\\/]|\\\\)/.test(path)) return `'${path.replaceAll("'", "''")}'`;
  const homeRelative = path.startsWith("~/");
  const literal = homeRelative ? path.slice(1) : path;
  return `${homeRelative ? '"$HOME"' : ""}'${literal.replaceAll("'", `'"'"'`)}'`;
}

function getSliceStatusBadge(
  slice: WorkSliceNode,
  stage: SoloWorkTaskView["stage"],
): {
  readonly label: string;
  readonly className: string;
  readonly pulsing: boolean;
} {
  switch (slice.status) {
    case "running":
      return {
        label: "执行中",
        className: "text-[#15803D] dark:text-[#4ADE80]",
        pulsing: true,
      };
    case "verifying":
      return {
        label: "复核中",
        className: "text-[#2563EB] dark:text-[#60A5FA]",
        pulsing: true,
      };
    case "waiting":
      return {
        label: getSliceWaitLabel(stage, slice.leaseRole),
        className: "text-[#B45309] dark:text-[#FBBF24]",
        pulsing: false,
      };
    case "ready":
      return {
        label: "已完成",
        className: "text-[#687082] dark:text-[#8E8E96]",
        pulsing: false,
      };
    case "blocked":
      return {
        label: "已停止",
        className: "text-[#B91C1C] dark:text-[#F87171]",
        pulsing: false,
      };
  }
}

/** `WorkbenchTaskDetailPane` 组件属性 */
export interface WorkbenchTaskDetailPaneProps {
  readonly task: SoloWorkTaskView;
  readonly ownedAgents: ReadonlyArray<OwnedAgentSummaryDto>;
  readonly workspace?: AgentWorkspace | undefined;
  readonly ownerDisplayName: string;
  readonly isEscalating: boolean;
  readonly onEscalate: () => void;
  readonly onOpenEscalatedRoom: (roomId: RoomId) => void;
  readonly onConfigureWorkspace: (ws: AgentWorkspace) => void;
}

/**
 * 任务详情、实时动态追踪流与 Unified Diff 审阅视图。
 */
export function WorkbenchTaskDetailPane(props: WorkbenchTaskDetailPaneProps) {
  const { task } = props;
  const isLocalWorkspace =
    props.workspace?.host.mode === "local_machine" &&
    typeof window !== "undefined" &&
    isLoopbackOrigin(window.location.origin);
  const isRunning = isSoloRunningStage(task.stage);
  const hasDiff = task.diffFiles.length > 0;
  const reducedMotion = usePrefersReducedMotion();

  const [sectionTab, setSectionTab] = useState<DetailSectionTab>(() =>
    hasDiff && !isRunning ? "changes" : "steps",
  );
  const overviewId = useId();
  const [codeDetailsOpen, setCodeDetailsOpen] = useState(false);
  const [selectedFileIndex, setSelectedFileIndex] = useState<number>(0);
  const [steerNote, setSteerNote] = useState<string>("");
  const [sendingSteer, setSendingSteer] = useState(false);
  const [reworkOpen, setReworkOpen] = useState<boolean>(false);
  const [reworkText, setReworkText] = useState<string>("");

  const prevTaskIdRef = useRef<string>(task.id);
  const prevStageRef = useRef<SoloWorkTaskView["stage"]>(task.stage);

  // 切换任务时：运行中任务优先聚焦「执行追踪」，已完成且带 Diff 的任务直接聚焦「代码变更」；
  // 同一任务刚由运行态转入待审阅且产出真实 Diff 时，自动切至「代码变更」供签收检视。
  useEffect(() => {
    if (prevTaskIdRef.current !== task.id) {
      prevTaskIdRef.current = task.id;
      prevStageRef.current = task.stage;
      setCodeDetailsOpen(false);
      setSelectedFileIndex(0);
      setSectionTab(hasDiff && !isRunning ? "changes" : "steps");
      return;
    }

    const wasRunning = isSoloRunningStage(prevStageRef.current);
    prevStageRef.current = task.stage;
    if (wasRunning && task.stage === "awaiting_review" && hasDiff) {
      setSectionTab("changes");
    }
  }, [hasDiff, isRunning, task.id, task.stage]);

  const traceEntries: ReadonlyArray<WorkTraceEntry> = task.trace ?? [];

  const activeDiffFile: SoloDiffFile | undefined =
    task.diffFiles[selectedFileIndex] ?? task.diffFiles[0];

  const diffLanguage = useMemo(
    () =>
      activeDiffFile !== undefined ? inferSyntaxLanguageFromPath(activeDiffFile.path) : "plain",
    [activeDiffFile],
  );

  // 跨行维持块注释与模板字符串状态；hunk 行不计入源码跨行状态，单独着色 @@ 后的函数签名提示
  const tokenizedDiffRows = useMemo(() => {
    if (activeDiffFile === undefined) {
      return [];
    }
    const codePayloadLines = activeDiffFile.lines.map((line) =>
      line.kind === "hunk" ? "" : line.content,
    );
    const bodyTokens = tokenizeCodeLines(codePayloadLines, diffLanguage);
    return activeDiffFile.lines.map((line, idx) => {
      if (line.kind !== "hunk") {
        return {
          hunkHeaderPrefix: "",
          tokens: bodyTokens[idx] ?? [],
        };
      }
      const hunkMatch = /^(@@[^@]+@@\s*)(.*)$/.exec(line.content);
      if (!hunkMatch) {
        return { hunkHeaderPrefix: line.content, tokens: [] };
      }
      const prefix = hunkMatch[1] ?? line.content;
      const trailingSig = hunkMatch[2] ?? "";
      const sigTokens =
        trailingSig.length > 0 ? (tokenizeCodeLines([trailingSig], diffLanguage)[0] ?? []) : [];
      return {
        hunkHeaderPrefix: prefix,
        tokens: sigTokens,
      };
    });
  }, [activeDiffFile, diffLanguage]);

  const detailTabs: ReadonlyArray<SegmentedTabItem<DetailSectionTab>> = useMemo(
    () => [
      {
        value: "steps",
        label: "执行追踪",
        badge: traceEntries.length > 0 ? String(traceEntries.length) : String(task.slices.length),
      },
      {
        value: "changes",
        label: "代码变更",
        ...(task.diffFiles.length > 0 ? { badge: String(task.diffFiles.length) } : {}),
      },
    ],
    [task.diffFiles.length, task.slices.length, traceEntries.length],
  );

  const workerShort = stripAgentOwnerPrefix(task.primaryWorker.displayName, props.ownerDisplayName);
  const verifierShort =
    task.verifier !== undefined
      ? stripAgentOwnerPrefix(task.verifier.displayName, props.ownerDisplayName)
      : null;

  const executionDirectories = task.slices.filter(
    (slice) => slice.provenance?.workingDirectory && slice.provenance.leaseRole !== "verify",
  );
  const executionSlice =
    executionDirectories.find((slice) => slice.worker.agentId === task.primaryWorker.agentId) ??
    executionDirectories[0];
  const displayedBranch = executionSlice?.worktreeBranch ?? task.worktreeBranch;
  const resolvedLocalPath =
    executionSlice?.provenance?.workingDirectory ??
    (isLocalWorkspace && props.workspace
      ? resolveLocalRunnerPath(props.workspace, displayedBranch)
      : undefined);
  // 原地目录与只读围栏直接作用于所选目录，不存在独立分支；仅隔离工作树模式展示分支名
  const showsWorktreeBranch =
    props.workspace === undefined || props.workspace.sandboxMode === "worktree_pool";

  const openLocalMenuItems: ReadonlyArray<AppDropdownEntry> = useMemo(
    () => [
      ...(resolvedLocalPath
        ? [
            {
              id: "open-cursor",
              label: "在 Cursor 中打开",
              icon: <ExternalLink className="h-3.5 w-3.5" />,
              onSelect: () =>
                copyTextWithFeedback(
                  `cursor ${quoteWorkbenchPath(resolvedLocalPath)}`,
                  "已复制 Cursor 打开命令",
                ),
            },
            {
              id: "open-vscode",
              label: "在 VS Code 中打开",
              icon: <ExternalLink className="h-3.5 w-3.5" />,
              onSelect: () =>
                copyTextWithFeedback(
                  `code ${quoteWorkbenchPath(resolvedLocalPath)}`,
                  "已复制 VS Code 打开命令",
                ),
            },
            {
              id: "copy-cd",
              label: /^(?:[A-Za-z]:[\\/]|\\\\)/.test(resolvedLocalPath)
                ? "复制 PowerShell 进入命令"
                : "复制终端进入命令 (cd)",
              icon: <Terminal className="h-3.5 w-3.5" />,
              onSelect: () =>
                copyTextWithFeedback(
                  `cd ${quoteWorkbenchPath(resolvedLocalPath)}`,
                  "已复制终端进入命令",
                ),
            },
            {
              id: "copy-path",
              label: "复制本地目录路径",
              icon: <Copy className="h-3.5 w-3.5" />,
              onSelect: () => copyTextWithFeedback(resolvedLocalPath, "已复制本地目录路径"),
            },
          ]
        : []),
      ...(props.workspace !== undefined
        ? [
            {
              id: "open-ws-settings",
              label: "工作区环境与门禁设置…",
              icon: <SlidersHorizontal className="h-3.5 w-3.5" />,
              onSelect: () => {
                if (props.workspace !== undefined) {
                  props.onConfigureWorkspace(props.workspace);
                }
              },
            } satisfies AppDropdownEntry,
          ]
        : []),
    ],
    [props.onConfigureWorkspace, props.workspace, resolvedLocalPath],
  );

  const handleSendSteer = (): void => {
    const clean = steerNote.trim();
    const targetSlice =
      task.slices.find((s) => s.status === "running" || s.status === "verifying") ?? task.slices[0];
    if (sendingSteer || clean.length === 0 || targetSlice === undefined) {
      return;
    }
    setSendingSteer(true);
    void steerWorkTaskOnServer(task.id, targetSlice.sliceId, clean)
      .then(() => {
        setSteerNote((draft) => (draft === steerNote ? "" : draft));
        toast.success("已向执行器发送补充说明");
      })
      .catch((err: unknown) => {
        toast.error(err instanceof Error ? err.message : "发送补充说明失败");
      })
      .finally(() => setSendingSteer(false));
  };

  return (
    <div className="oh-workbench-task-pane @container flex min-h-0 flex-1 flex-col overflow-hidden">
      <div
        data-code-view={(sectionTab === "changes" && hasDiff) || undefined}
        data-collapsed={!codeDetailsOpen || undefined}
        className="oh-workbench-task-summary shrink-0 border-b border-black/[0.06] px-4 py-3.5 @[640px]:px-5 @[640px]:py-4 dark:border-white/[0.07]"
      >
        <div id={overviewId} className="oh-workbench-task-overview">
          <div className="flex flex-col gap-2.5 @[640px]:flex-row @[640px]:items-start @[640px]:justify-between @[640px]:gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-start gap-2">
                <span className="mt-0.5 shrink-0">
                  <WorkStageGlyph stage={task.stage} size="md" />
                </span>
                <h2 className="min-w-0 flex-1 break-words text-[15.5px] @[640px]:text-[16px] font-semibold leading-snug tracking-[-0.015em] text-[#111318] dark:text-[#F2F2F4]">
                  {task.title}
                </h2>
              </div>

              <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 pl-0 @[640px]:pl-6 text-[12px] text-[#687082] dark:text-[#8E8E96]">
                <span className="shrink-0 whitespace-nowrap font-medium text-[#3B414E] dark:text-[#C4C4CA]">
                  {task.repoName}
                </span>
                {showsWorktreeBranch ? (
                  <button
                    type="button"
                    onClick={() => copyTextWithFeedback(displayedBranch, "已复制分支名")}
                    className="inline-flex max-w-[180px] min-w-0 shrink-0 cursor-pointer items-center gap-1 font-mono text-[11.5px] text-[#4B5565] transition hover:text-[#111318] dark:text-[#A1A1AA] dark:hover:text-white"
                  >
                    <GitBranch className="h-3 w-3 shrink-0" />
                    <span className="truncate">{displayedBranch}</span>
                    <Copy className="h-2.5 w-2.5 shrink-0 opacity-60" />
                  </button>
                ) : null}
                {openLocalMenuItems.length > 0 ? (
                  <AppDropdownMenu
                    align="start"
                    items={openLocalMenuItems}
                    trigger={
                      <button
                        type="button"
                        title={resolvedLocalPath}
                        className="inline-flex shrink-0 cursor-pointer items-center gap-0.5 whitespace-nowrap text-[12px] text-[#4B5565] transition hover:text-[#111318] dark:text-[#A1A1AA] dark:hover:text-white"
                      >
                        <span>{resolvedLocalPath ? "打开执行目录" : "工作区设置"}</span>
                        <ChevronDown className="h-3 w-3 shrink-0 opacity-70" />
                      </button>
                    }
                  />
                ) : null}
                <span className="shrink-0 whitespace-nowrap">
                  {workerShort} 执行
                  {verifierShort !== null ? ` · ${verifierShort} 复核` : ""}
                </span>
              </div>
            </div>

            <div className="flex shrink-0 flex-wrap items-center gap-1.5">
              {task.escalatedRoomId !== undefined ? (
                <AppButton
                  size="xs"
                  variant="secondary"
                  trailingIcon={<ArrowUpRight className="h-3 w-3" />}
                  className="shrink-0 whitespace-nowrap"
                  onClick={() => {
                    if (task.escalatedRoomId !== undefined) {
                      props.onOpenEscalatedRoom(task.escalatedRoomId);
                    }
                  }}
                >
                  进入群聊
                </AppButton>
              ) : (
                <AppButton
                  size="xs"
                  variant="secondary"
                  disabled={props.isEscalating}
                  leadingIcon={<MessageSquarePlus className="h-3.5 w-3.5" />}
                  className="shrink-0 whitespace-nowrap"
                  onClick={props.onEscalate}
                >
                  {props.isEscalating ? "创建中…" : "拉群讨论"}
                </AppButton>
              )}

              {isRunning ? (
                <AppButton
                  size="xs"
                  variant="secondary"
                  leadingIcon={<Square className="h-2.5 w-2.5 fill-current" />}
                  className="shrink-0 whitespace-nowrap"
                  onClick={() => {
                    void controlWorkTaskOnServer(task.id, "stop")
                      .then(() => toast.info("已停止任务"))
                      .catch((err: unknown) =>
                        toast.error(err instanceof Error ? err.message : "停止任务失败"),
                      );
                  }}
                >
                  停止
                </AppButton>
              ) : null}

              {task.stage === "cancelled" || task.stage === "blocked" ? (
                <AppButton
                  size="xs"
                  variant="secondary"
                  leadingIcon={<RotateCcw className="h-3 w-3" />}
                  className="shrink-0 whitespace-nowrap"
                  onClick={() => {
                    void controlWorkTaskOnServer(task.id, "retry")
                      .then(() => toast.success("已重新加入执行队列"))
                      .catch((err: unknown) =>
                        toast.error(err instanceof Error ? err.message : "重试任务失败"),
                      );
                  }}
                >
                  重新运行
                </AppButton>
              ) : null}

              {task.stage === "awaiting_review" ? (
                <>
                  <AppPopover
                    open={reworkOpen}
                    onOpenChange={setReworkOpen}
                    side="bottom"
                    align="end"
                    className="w-72 space-y-2.5 p-3"
                    trigger={
                      <AppButton
                        size="xs"
                        variant="secondary"
                        className="shrink-0 whitespace-nowrap"
                      >
                        退回修改
                      </AppButton>
                    }
                  >
                    <p className="text-[12px] font-semibold text-[#111318] dark:text-[#F2F2F4]">
                      填写修改说明
                    </p>
                    <AppInput
                      size="sm"
                      value={reworkText}
                      onChange={(e) => setReworkText(e.target.value)}
                      placeholder="说明需要调整的地方…"
                    />
                    <div className="flex justify-end gap-1.5">
                      <AppButton size="sm" variant="ghost" onClick={() => setReworkOpen(false)}>
                        取消
                      </AppButton>
                      <AppButton
                        size="sm"
                        variant="primary"
                        onClick={() => {
                          const note = reworkText;
                          setReworkText("");
                          setReworkOpen(false);
                          void decideWorkReviewOnServer(task.id, "request_changes", note)
                            .then(() => toast.info("已退回继续修改"))
                            .catch((err: unknown) =>
                              toast.error(err instanceof Error ? err.message : "退回修改失败"),
                            );
                        }}
                      >
                        退回
                      </AppButton>
                    </div>
                  </AppPopover>

                  <AppButton
                    size="xs"
                    variant="primary"
                    leadingIcon={<Check className="h-3.5 w-3.5" />}
                    className="shrink-0 whitespace-nowrap"
                    onClick={() => {
                      void decideWorkReviewOnServer(task.id, "approve")
                        .then(() => toast.success("已签收变更"))
                        .catch((err: unknown) =>
                          toast.error(err instanceof Error ? err.message : "签收失败"),
                        );
                    }}
                  >
                    签收
                  </AppButton>
                </>
              ) : null}
            </div>
          </div>

          <p className="mt-2.5 pl-0 @[640px]:pl-6 text-[13px] leading-relaxed text-[#3B414E] dark:text-[#C4C4CA]">
            {task.brief}
          </p>

          {task.attention !== undefined && task.stage === "awaiting_answer" ? (
            <div className="mt-3.5 ml-0 @[640px]:ml-6 overflow-hidden rounded-xl border border-black/[0.08] bg-white dark:border-white/[0.1] dark:bg-[#1E1E22]">
              <div className="border-b border-black/[0.05] px-3.5 py-2.5 dark:border-white/[0.07]">
                <p className="text-[12.5px] font-medium text-[#111318] dark:text-[#F2F2F4]">
                  {stripAgentOwnerPrefix(
                    task.attention.askedBy.displayName,
                    props.ownerDisplayName,
                  )}{" "}
                  请你确认：{task.attention.question}
                </p>
              </div>
              <div className="divide-y divide-black/[0.05] dark:divide-white/[0.06]">
                {task.attention.options.map((opt) => (
                  <button
                    key={opt}
                    type="button"
                    onClick={() => {
                      void answerWorkAttentionOnServer(task.id, opt)
                        .then(() => toast.success("已确认并继续执行"))
                        .catch((err: unknown) =>
                          toast.error(err instanceof Error ? err.message : "提交确认失败"),
                        );
                    }}
                    className="flex w-full cursor-pointer items-center justify-between gap-3 px-3.5 py-2.5 text-left text-[12.5px] text-[#181B22] transition hover:bg-black/[0.03] dark:text-[#ECECEF] dark:hover:bg-white/[0.04]"
                  >
                    <span className="whitespace-normal break-words">{opt}</span>
                    <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[#94A3B8]" />
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </div>

        <div className="oh-workbench-section-tabs mt-3.5 flex flex-wrap items-center justify-between gap-2 pl-0 @[640px]:pl-6">
          <SegmentedTabs
            size="xs"
            items={detailTabs}
            value={sectionTab}
            onValueChange={(tab) => {
              setCodeDetailsOpen(false);
              setSectionTab(tab);
            }}
          />

          {sectionTab === "changes" && hasDiff ? (
            <button
              type="button"
              aria-expanded={codeDetailsOpen}
              aria-controls={overviewId}
              onClick={() => setCodeDetailsOpen((open) => !open)}
              className="oh-workbench-details-toggle hidden min-h-11 cursor-pointer items-center gap-1 rounded-lg px-2 text-xs font-medium text-[#4B5565] dark:text-[#C4C4CA]"
            >
              {task.stage === "awaiting_answer"
                ? "待确认事项"
                : task.stage === "awaiting_review"
                  ? "待审阅任务"
                  : "任务详情"}
              <ChevronDown
                aria-hidden="true"
                className={cn("size-3.5", codeDetailsOpen && "rotate-180")}
              />
            </button>
          ) : null}

          {task.review?.testCommand ? (
            <span className="oh-workbench-task-status text-[12px] text-[#687082] dark:text-[#8E8E96]">
              测试命令 <code className="font-mono text-[11.5px]">{task.review.testCommand}</code>{" "}
              {task.review.testPassed ? "已通过" : "未通过"}
            </span>
          ) : isRunning ? (
            <span className="oh-workbench-task-status inline-flex items-center gap-1.5 text-[11.5px] font-medium text-[#15803D] dark:text-[#4ADE80]">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
              <span>实时追踪已连接</span>
            </span>
          ) : null}
        </div>
      </div>

      <AnimatePresence mode="wait" initial={false}>
        {sectionTab === "changes" ? (
          activeDiffFile !== undefined ? (
            <motion.div
              key="wb-detail-changes"
              initial={reducedMotion ? false : { opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={reducedMotion ? INSTANT_TRANSITION : NATIVE_VIEW_SWAP}
              className="flex min-h-0 flex-1 flex-col overflow-hidden bg-white dark:bg-[#141417]"
            >
              <div
                data-vaul-no-drag=""
                className="no-scrollbar flex shrink-0 items-center gap-1 overflow-x-auto overscroll-x-contain border-b border-black/[0.06] bg-[#F4F5F7] px-3.5 py-1.5 dark:border-white/[0.07] dark:bg-[#18181B]"
              >
                {task.diffFiles.map((file, idx) => {
                  const active = idx === selectedFileIndex;
                  const shortName = file.path.split("/").pop() ?? file.path;
                  return (
                    <button
                      key={file.path}
                      type="button"
                      onClick={() => setSelectedFileIndex(idx)}
                      title={file.path}
                      className={cn(
                        "im-press relative z-0 inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg px-2.5 py-1 font-mono text-[11.5px]",
                        active
                          ? "font-medium text-[#111318] dark:text-[#F4F4F6]"
                          : "text-[#687082] hover:text-[#111318] dark:text-[#9B9BA3] dark:hover:text-[#ECECEF]",
                      )}
                    >
                      {active ? (
                        <motion.span
                          layoutId={`oh-wb-diff-file-${task.id}`}
                          aria-hidden="true"
                          transition={reducedMotion ? INSTANT_TRANSITION : NATIVE_PILL_SPRING}
                          className="pointer-events-none absolute inset-0 -z-10 rounded-lg bg-white shadow-2xs ring-1 ring-black/[0.06] will-change-transform dark:bg-[#242429] dark:ring-white/[0.1]"
                        />
                      ) : null}
                      <FileCode2 className="h-3.5 w-3.5 shrink-0 opacity-75" />
                      <span>{shortName}</span>
                      <span className="text-[10.5px] text-[#15803D] dark:text-[#4ADE80]">
                        +{file.additions}
                      </span>
                      <span className="text-[10.5px] text-[#B91C1C] dark:text-[#F87171]">
                        -{file.deletions}
                      </span>
                    </button>
                  );
                })}
              </div>

              <AnimatePresence mode="wait" initial={false}>
                <motion.section
                  key={`diff-card-${activeDiffFile.path}`}
                  initial={reducedMotion ? false : { opacity: 0, y: 5 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={reducedMotion ? { opacity: 0 } : { opacity: 0, y: -4 }}
                  transition={reducedMotion ? INSTANT_TRANSITION : NATIVE_VIEW_SWAP}
                  aria-label={`代码变更：${activeDiffFile.path}`}
                  tabIndex={0}
                  className="oh-workbench-diff-lines min-h-0 flex-1 touch-pan-y touch-pinch-zoom overflow-y-auto overscroll-y-contain"
                >
                  {task.review?.verifierNote ? (
                    <details className="group border-b border-black/[0.045] dark:border-white/[0.055]">
                      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-4 text-xs text-[#4B5565] dark:text-[#A1A1AA] [&::-webkit-details-marker]:hidden">
                        <span className="min-w-0 truncate font-mono text-[11px]">
                          {activeDiffFile.path}
                        </span>
                        <span className="inline-flex shrink-0 items-center gap-1">
                          复核说明
                          <ChevronDown
                            aria-hidden="true"
                            className="size-3.5 group-open:rotate-180"
                          />
                        </span>
                      </summary>
                      <p className="px-4 pb-3 text-[13px] leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere] text-[#4B5565] dark:text-[#C4C4CA]">
                        {task.review.verifierNote}
                      </p>
                    </details>
                  ) : (
                    <div className="truncate border-b border-black/[0.045] px-4 py-1 font-mono text-[11px] text-[#687082] dark:border-white/[0.055] dark:text-[#8E8E96]">
                      {activeDiffFile.path}
                    </div>
                  )}

                  <div className="py-1.5 font-mono text-[12px] leading-[1.65]">
                    {activeDiffFile.lines.map((line, idx) => {
                      const rowSyntax = tokenizedDiffRows[idx];
                      const lineKey = `${line.kind}-${String(line.oldLine ?? "x")}-${String(line.newLine ?? "x")}-${String(idx)}`;
                      if (line.kind === "hunk") {
                        return (
                          <div
                            key={lineKey}
                            className="bg-black/[0.03] px-4 py-1 text-[11px] dark:bg-white/[0.04]"
                          >
                            <span className="text-[#4F46E5] dark:text-[#818CF8]">
                              {rowSyntax?.hunkHeaderPrefix ?? line.content}
                            </span>
                            {rowSyntax && rowSyntax.tokens.length > 0 ? (
                              <HighlightedTokenLine tokens={rowSyntax.tokens} />
                            ) : null}
                          </div>
                        );
                      }
                      const isAdd = line.kind === "add";
                      const isDel = line.kind === "del";
                      const tokens = rowSyntax?.tokens ?? [];
                      return (
                        <div
                          key={lineKey}
                          className={cn(
                            "flex items-baseline px-2",
                            isAdd && "bg-[#DCFCE7]/50 dark:bg-[#132C1F]/75",
                            isDel && "bg-[#FEE2E2]/55 dark:bg-[#31171B]/75",
                          )}
                        >
                          <span
                            className={cn(
                              "w-9 shrink-0 select-none pr-2 text-right text-[10.5px]",
                              isAdd
                                ? "text-[#15803D]/75 dark:text-[#4ADE80]/70"
                                : isDel
                                  ? "text-[#B91C1C]/75 dark:text-[#F87171]/70"
                                  : "text-[#94A3B8] dark:text-[#52525B]",
                            )}
                          >
                            {line.oldLine ?? ""}
                          </span>
                          <span
                            className={cn(
                              "w-9 shrink-0 select-none pr-2 text-right text-[10.5px]",
                              isAdd
                                ? "text-[#15803D]/75 dark:text-[#4ADE80]/70"
                                : isDel
                                  ? "text-[#B91C1C]/75 dark:text-[#F87171]/70"
                                  : "text-[#94A3B8] dark:text-[#52525B]",
                            )}
                          >
                            {line.newLine ?? ""}
                          </span>
                          <span
                            className={cn(
                              "w-4 shrink-0 select-none font-semibold",
                              isAdd
                                ? "text-[#15803D] dark:text-[#4ADE80]"
                                : isDel
                                  ? "text-[#B91C1C] dark:text-[#F87171]"
                                  : "text-transparent",
                            )}
                          >
                            {isAdd ? "+" : isDel ? "-" : "·"}
                          </span>
                          <pre className="min-w-0 flex-1 whitespace-pre-wrap break-all font-mono">
                            {tokens.length > 0 ? (
                              <HighlightedTokenLine tokens={tokens} />
                            ) : (
                              "\u00A0"
                            )}
                          </pre>
                        </div>
                      );
                    })}
                  </div>
                </motion.section>
              </AnimatePresence>
            </motion.div>
          ) : (
            <motion.div
              key="wb-detail-empty"
              initial={reducedMotion ? false : { opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={reducedMotion ? INSTANT_TRANSITION : NATIVE_VIEW_SWAP}
              className="flex flex-1 flex-col items-center justify-center p-8 text-center"
            >
              <p className="text-[13px] font-medium text-[#3B414E] dark:text-[#C4C4CA]">
                {isRunning
                  ? "任务正在本机沙盒中执行，完成后将自动生成代码 Diff"
                  : "本次任务未产生文件改动"}
              </p>
              <button
                type="button"
                onClick={() => setSectionTab("steps")}
                className="mt-2 cursor-pointer text-[12px] text-[#2563EB] hover:underline dark:text-[#60A5FA]"
              >
                切回实时执行追踪
              </button>
            </motion.div>
          )
        ) : (
          <motion.div
            key="wb-detail-steps"
            initial={reducedMotion ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={reducedMotion ? INSTANT_TRANSITION : NATIVE_VIEW_SWAP}
            className="flex min-h-0 flex-1 flex-col overflow-hidden"
          >
            <WorkbenchTraceScrollArea
              key={task.id}
              followLiveTrace={isRunning && traceEntries.length > 0}
            >
              {/* 1. 分片执行管线卡片 */}
              <div className="divide-y divide-black/[0.05] overflow-hidden rounded-[14px] border border-black/[0.06] bg-white/75 dark:divide-white/[0.06] dark:border-white/[0.075] dark:bg-white/[0.03]">
                {task.slices.map((slice) => {
                  const progress = getSliceProgressSummary(slice, task.stage);
                  const statusMeta = getSliceStatusBadge(slice, task.stage);
                  const waitingForClaim =
                    slice.leaseRole !== undefined &&
                    slice.status === "waiting" &&
                    ((task.stage === "working" && slice.leaseRole !== "verify") ||
                      (task.stage === "verifying" && slice.leaseRole === "verify"));
                  const listenerHint =
                    waitingForClaim && !isLocalWorkspace
                      ? getClaimListenerHint(
                          props.ownedAgents.find((agent) => agent.id === slice.worker.agentId),
                        )
                      : undefined;
                  return (
                    <div key={slice.sliceId} className="px-3.5 py-3">
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex min-w-0 items-center gap-2.5">
                          <PlatformAvatar
                            kind="agent"
                            displayName={slice.worker.displayName}
                            platform={slice.worker.platform}
                            size="sm"
                          />
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <p className="truncate text-[13px] font-medium text-[#111318] dark:text-[#F2F2F4]">
                                {slice.title}
                              </p>
                              <span
                                className={cn(
                                  "inline-flex shrink-0 items-center gap-1 text-[11px] font-medium",
                                  statusMeta.className,
                                )}
                              >
                                {statusMeta.pulsing ? (
                                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
                                ) : null}
                                <span>{statusMeta.label}</span>
                              </span>
                            </div>
                            <p className="mt-0.5 break-words text-[12px] text-[#687082] dark:text-[#8E8E96]">
                              {waitingForClaim
                                ? null
                                : `${stripAgentOwnerPrefix(slice.worker.displayName, props.ownerDisplayName)} · `}
                              {progress}
                            </p>
                            {listenerHint ? (
                              <p className="mt-1 text-[12px] text-[#687082] dark:text-[#8E8E96]">
                                {listenerHint.message}
                                {listenerHint.showInstallGuide ? (
                                  <a
                                    className="ml-1 underline"
                                    href="/install.md"
                                    target="_blank"
                                    rel="noreferrer"
                                  >
                                    安装指引
                                  </a>
                                ) : null}
                              </p>
                            ) : null}
                          </div>
                        </div>

                        <div className="flex shrink-0 items-center gap-2">
                          {(slice.diffAdded ?? 0) > 0 || (slice.diffRemoved ?? 0) > 0 ? (
                            <span className="font-mono text-[11px] tabular-nums">
                              <span className="text-[#15803D] dark:text-[#4ADE80]">
                                +{slice.diffAdded ?? 0}
                              </span>{" "}
                              <span className="text-[#B91C1C] dark:text-[#F87171]">
                                -{slice.diffRemoved ?? 0}
                              </span>
                            </span>
                          ) : null}
                          <span className="font-mono text-[11.5px] tabular-nums text-[#687082] dark:text-[#8E8E96]">
                            {formatElapsedCompact(slice.elapsedSec)}
                          </span>
                        </div>
                      </div>

                      {slice.ownedPaths.length > 0 ||
                      slice.provenance ||
                      slice.steerNotes.length > 0 ||
                      (slice.liveSummary && slice.liveSummary !== progress) ? (
                        <details className="mt-1 pl-10 text-[12px] text-[#687082] dark:text-[#A1A1AA]">
                          <summary className="cursor-pointer py-1">
                            查看详情
                            {slice.steerNotes.length > 0
                              ? ` · ${slice.steerNotes.length} 条补充说明`
                              : ""}
                          </summary>
                          {slice.ownedPaths.length > 0 ? (
                            <p className="mt-1.5 font-mono text-[11px] text-[#8E96A6] dark:text-[#71717A]">
                              范围：{slice.ownedPaths.join(", ")}
                            </p>
                          ) : null}

                          {slice.provenance !== undefined ? (
                            <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[11px] text-[#687082] dark:text-[#8E8E96]">
                              <span>环境：{slice.provenance.agentEnvironment}</span>
                              <button
                                type="button"
                                onClick={() =>
                                  copyTextWithFeedback(
                                    slice.provenance?.sessionJsonlPath ?? "",
                                    "已复制仓外会话记录路径",
                                  )
                                }
                                className="inline-flex cursor-pointer items-center gap-1 font-mono text-[10.5px] text-[#4B5565] transition hover:text-[#111318] dark:text-[#A1A1AA] dark:hover:text-white"
                              >
                                <span>复制会话日志路径 (.jsonl)</span>
                                <Copy className="h-2.5 w-2.5 opacity-60" />
                              </button>
                            </div>
                          ) : null}
                          {slice.liveSummary && slice.liveSummary !== progress ? (
                            <p className="whitespace-pre-wrap break-words">{slice.liveSummary}</p>
                          ) : null}
                          {slice.steerNotes.map((note, idx) => (
                            <p
                              key={`${slice.sliceId}-n-${String(idx)}`}
                              className="mt-1 whitespace-pre-wrap break-words"
                            >
                              补充说明：{note}
                            </p>
                          ))}
                        </details>
                      ) : null}
                    </div>
                  );
                })}
              </div>

              {/* 2. 实时动态过程日志流（Live Execution Trace Stream） */}
              <div className="mt-4">
                <div className="mb-2 flex items-center justify-between px-0.5">
                  <span className="inline-flex items-center gap-1.5 text-[11.5px] font-medium text-[#4B5565] dark:text-[#A1A1AA]">
                    <Terminal className="h-3.5 w-3.5 text-[#687082] dark:text-[#8E8E96]" />
                    <span>实时过程追踪</span>
                  </span>
                  {traceEntries.length > 0 ? (
                    <span className="font-mono text-[11px] tabular-nums text-[#8E96A6] dark:text-[#71717A]">
                      {traceEntries.length} 条记录
                    </span>
                  ) : null}
                </div>

                {traceEntries.length > 0 ? (
                  <WorkbenchTraceEvents
                    entries={traceEntries}
                    ownerDisplayName={props.ownerDisplayName}
                  />
                ) : (
                  <div className="rounded-[14px] border border-black/[0.06] bg-white/60 px-4 py-6 text-center text-[12px] text-[#8E96A6] dark:border-white/[0.075] dark:bg-white/[0.02] dark:text-[#71717A]">
                    {isRunning ? "正在等待本机执行器认领分片并回传实时过程…" : "暂无过程追踪记录"}
                  </div>
                )}
              </div>
            </WorkbenchTraceScrollArea>
          </motion.div>
        )}
      </AnimatePresence>

      {isRunning && sectionTab === "steps" ? (
        <div className="oh-workbench-steer shrink-0 px-4 py-2 sm:px-5">
          <form
            className="oh-workbench-note"
            onSubmit={(event) => {
              event.preventDefault();
              handleSendSteer();
            }}
          >
            <textarea
              aria-label="补充说明"
              className="oh-workbench-note-text app-no-drag"
              rows={1}
              maxLength={1000}
              enterKeyHint="enter"
              placeholder="补充说明给正在执行的 Agent…"
              value={steerNote}
              onChange={(event) => setSteerNote(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter" || event.shiftKey || isImeComposing(event)) return;
                if (isCoarsePointerDevice() && !event.metaKey && !event.ctrlKey) return;
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }}
            />
            <IconButton
              type="submit"
              className="oh-workbench-note-submit"
              label="发送补充说明"
              size="sm"
              variant="secondary"
              disabled={!steerNote.trim() || task.slices.length === 0}
              isLoading={sendingSteer}
            >
              <ArrowUp aria-hidden="true" className="size-4" />
            </IconButton>
          </form>
        </div>
      ) : null}
    </div>
  );
}
