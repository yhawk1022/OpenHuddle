/**
 * @module web/features/huddle-room/work-timeline-cards
 * @description 聊天时间线内嵌任务卡片与底部运行状态条。
 *
 * 关键不变量：
 * 1. 时间线内嵌卡片禁用 `backdrop-blur`，与提案卡共用实感浅/深底色，避免长对话滚动重绘掉帧。
 * 2. 无活跃运行中工单时，`LiveRunFloatingBar` 返回 `null` 占零高度。
 */
import {
  Check,
  ChevronDown,
  ChevronRight,
  CornerDownLeft,
  GitBranch,
  Loader2,
  RotateCcw,
  Square,
} from "lucide-react";
import { useState } from "react";
import {
  AnimatePresence,
  AppButton,
  AppInput,
  cn,
  motion,
  toast,
} from "../../../components/primitives/index.js";
import { PlatformAvatar } from "../../../components/ui/identity-badges.js";
import type { RoomWorkItemView } from "../work/work-types.js";
import { WorkStageGlyph, formatWorkStageLabel, getWorkTopologyLabel } from "../work/work-utils.js";

export { getWorkTopologyLabel };

/** `LiveRunFloatingBar` 入参属性 */
export interface LiveRunFloatingBarProps {
  readonly activeItems: ReadonlyArray<RoomWorkItemView>;
  readonly onSteer: (workItemId: string, note: string) => void;
  readonly onStop: (workItemId: string) => void;
  readonly onOpenTasksInspector: (workItemId: string) => void;
}

/**
 * 底部输入舱上方的单行运行状态条（无活跃任务时占零高度）。
 */
export function LiveRunFloatingBar(props: LiveRunFloatingBarProps) {
  const lead = props.activeItems[0];
  const [steerOpenForId, setSteerOpenForId] = useState<string | null>(null);
  const [steerText, setSteerText] = useState<string>("");

  if (lead === undefined) {
    return null;
  }

  const isSteerOpen = steerOpenForId === lead.id;
  const activeSlices = lead.slices.filter(
    (s) => s.status === "running" || s.status === "verifying",
  );
  const readyCount = lead.slices.filter((s) => s.status === "ready").length;
  const primarySlice = activeSlices[0] ?? lead.slices[0];
  const isParallel = lead.topology === "swarm" && lead.slices.length > 1;
  const isVerifying = lead.stage === "verifying" || primarySlice?.status === "verifying";

  const submitSteer = (): void => {
    const trimmed = steerText.trim();
    if (trimmed.length === 0) {
      return;
    }
    props.onSteer(lead.id, trimmed);
    toast.success("已发送补充说明");
    setSteerText("");
    setSteerOpenForId(null);
  };

  return (
    <div className="pointer-events-auto mx-auto mb-2 w-full max-w-3xl px-4 sm:px-6">
      <motion.div
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 4 }}
        transition={{ duration: 0.16, ease: "easeOut" }}
        className="relative liquid-glass-pill overflow-hidden rounded-[16px] px-3 py-2 text-xs"
      >
        <div className="flex min-w-0 items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => props.onOpenTasksInspector(lead.id)}
            className="app-no-drag flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
          >
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-[#16A34A] dark:text-[#4ADE80]" />

            <span className="shrink-0 font-medium text-[#111318] dark:text-[#F2F2F4]">
              {isParallel
                ? `并行 ${String(readyCount)}/${String(lead.slices.length)}`
                : isVerifying && lead.verifier !== undefined
                  ? lead.verifier.displayName
                  : (primarySlice?.worker.displayName ?? lead.primaryWorker.displayName)}
            </span>

            <span className="min-w-0 flex-1 truncate text-[#545D6C] dark:text-[#A1A1AA]">
              {primarySlice?.liveSummary ?? "正在处理…"}
            </span>

            <span className="shrink-0 font-mono text-[11px] tabular-nums text-[#687082] dark:text-[#8E8E96]">
              {primarySlice?.elapsedSec ?? 1}s
            </span>
          </button>

          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={() => setSteerOpenForId((cur) => (cur === lead.id ? null : lead.id))}
              className={cn(
                "app-no-drag inline-flex h-6 cursor-pointer items-center rounded-md px-2 text-[11.5px] font-medium transition-colors",
                isSteerOpen
                  ? "bg-black/[0.08] text-[#111318] dark:bg-white/[0.14] dark:text-white"
                  : "text-[#4B5565] hover:bg-black/[0.05] hover:text-[#111318] dark:text-[#A1A1AA] dark:hover:bg-white/[0.08] dark:hover:text-white",
              )}
            >
              补充
            </button>

            <button
              type="button"
              title="停止任务"
              aria-label="停止任务"
              onClick={() => {
                props.onStop(lead.id);
                toast.info("已停止任务");
              }}
              className="app-no-drag inline-flex h-6 w-6 cursor-pointer items-center justify-center rounded-md text-[#687082] transition hover:bg-black/[0.06] hover:text-[#DC2626] dark:text-[#8E8E96] dark:hover:bg-white/[0.08] dark:hover:text-[#F87171]"
            >
              <Square className="h-2.5 w-2.5 fill-current" />
            </button>

            <button
              type="button"
              onClick={() => props.onOpenTasksInspector(lead.id)}
              aria-label="查看任务详情"
              className="app-no-drag inline-flex h-6 w-6 cursor-pointer items-center justify-center rounded-md text-[#687082] transition hover:text-[#111318] dark:text-[#8E8E96] dark:hover:text-[#F2F2F4]"
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        <AnimatePresence initial={false}>
          {isSteerOpen ? (
            <motion.form
              key="inline-steer-form"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.14, ease: "easeOut" }}
              onSubmit={(event) => {
                event.preventDefault();
                submitSteer();
              }}
              className="overflow-hidden"
            >
              <div className="mt-2 flex items-center gap-1.5 border-t border-black/[0.06] pt-2 dark:border-white/[0.08]">
                <AppInput
                  size="sm"
                  value={steerText}
                  onChange={(e) => setSteerText(e.target.value)}
                  placeholder="补充要求…"
                  className="flex-1 text-xs"
                />
                <AppButton
                  type="submit"
                  variant="primary"
                  size="xs"
                  disabled={steerText.trim().length === 0}
                  trailingIcon={<CornerDownLeft className="h-3 w-3" />}
                >
                  发送
                </AppButton>
              </div>
            </motion.form>
          ) : null}
        </AnimatePresence>
      </motion.div>
    </div>
  );
}

/** `WorkTimelineMilestoneCard` 入参属性 */
export interface WorkTimelineMilestoneCardProps {
  readonly item: RoomWorkItemView;
  readonly onOpenInInspector: (workItemId: string) => void;
  readonly onAnswerAttention: (workItemId: string, choice: string) => void;
  readonly onDecideReview: (
    workItemId: string,
    decision: "approve" | "rework",
    reworkNote?: string | undefined,
  ) => void;
  readonly onRetry: (workItemId: string) => void;
}

/**
 * 嵌入聊天时间线的原生质感任务卡片。
 */
export function WorkTimelineMilestoneCard(props: WorkTimelineMilestoneCardProps) {
  const { item } = props;
  const [filesExpanded, setFilesExpanded] = useState<boolean>(false);
  const [reworkOpen, setReworkOpen] = useState<boolean>(false);
  const [reworkDraft, setReworkDraft] = useState<string>("");

  return (
    <div className="my-2.5 pl-0 sm:pl-11">
      <article className="overflow-hidden rounded-[18px] bg-white/92 text-[#111318] shadow-[0_1px_4px_rgba(15,23,42,0.04)] ring-1 ring-black/[0.07] dark:bg-[#1E1E22]/95 dark:text-[#F2F2F4] dark:shadow-none dark:ring-white/[0.09]">
        {/* 头部：状态圆标 + 任务标题 + 查看详情 */}
        <header className="flex items-center justify-between gap-3 border-b border-black/[0.05] px-4 py-2.5 dark:border-white/[0.06]">
          <div className="flex min-w-0 items-center gap-2">
            <WorkStageGlyph stage={item.stage} />
            <h4 className="truncate text-[13.5px] font-semibold text-[#111318] dark:text-[#F2F2F4]">
              {item.title}
            </h4>
          </div>

          <button
            type="button"
            onClick={() => props.onOpenInInspector(item.id)}
            className="inline-flex shrink-0 cursor-pointer items-center gap-1 text-[12px] text-[#687082] transition hover:text-[#111318] dark:text-[#8E8E96] dark:hover:text-[#F2F2F4]"
          >
            <span>{formatWorkStageLabel(item.stage)}</span>
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </header>

        <div className="space-y-3 px-4 py-3">
          {/* 步骤列表（单像素分割线，无色块堆砌） */}
          <ul className="divide-y divide-black/[0.045] dark:divide-white/[0.055]">
            {item.slices.map((slice) => (
              <li
                key={slice.sliceId}
                className="flex items-center justify-between gap-3 py-1.5 first:pt-0 last:pb-0 text-[12.5px]"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <PlatformAvatar
                    kind="agent"
                    displayName={slice.worker.displayName}
                    platform={slice.worker.platform}
                    size="sm"
                    className="[&>div]:h-5 [&>div]:w-5 [&>div]:text-[10px]"
                  />
                  <span className="shrink-0 font-medium text-[#181B22] dark:text-[#ECECEF]">
                    {slice.worker.displayName}
                  </span>
                  <span className="truncate text-[#687082] dark:text-[#9B9BA3]">
                    {slice.liveSummary}
                  </span>
                </div>

                <span className="shrink-0 font-mono text-[11px] tabular-nums text-[#687082] dark:text-[#8E8E96]">
                  {slice.diffAdded !== undefined ? (
                    <span>
                      <span className="text-[#15803D] dark:text-[#4ADE80]">+{slice.diffAdded}</span>{" "}
                      <span className="text-[#B91C1C] dark:text-[#F87171]">
                        -{slice.diffRemoved ?? 0}
                      </span>
                    </span>
                  ) : (
                    `${String(slice.elapsedSec)}s`
                  )}
                </span>
              </li>
            ))}
          </ul>

          {/* 待确认问题（原生单选列表样式） */}
          {item.attention !== undefined && item.stage === "awaiting_answer" ? (
            <div className="overflow-hidden rounded-xl border border-black/[0.07] bg-[#F8F9FA] dark:border-white/[0.09] dark:bg-[#161619]">
              <p className="border-b border-black/[0.05] px-3 py-2 text-[12.5px] font-medium text-[#111318] dark:border-white/[0.06] dark:text-[#F2F2F4]">
                {item.attention.askedBy.displayName}：{item.attention.question}
              </p>
              <div className="divide-y divide-black/[0.05] dark:divide-white/[0.06]">
                {item.attention.options.map((opt) => (
                  <button
                    key={opt}
                    type="button"
                    onClick={() => {
                      props.onAnswerAttention(item.id, opt);
                      toast.success("已确认并继续");
                    }}
                    className="flex w-full cursor-pointer items-center justify-between gap-2 px-3 py-2 text-left text-[12px] text-[#181B22] transition hover:bg-black/[0.03] dark:text-[#ECECEF] dark:hover:bg-white/[0.04]"
                  >
                    <span className="whitespace-normal break-words">{opt}</span>
                    <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[#94A3B8]" />
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {/* 变更汇总与签收 */}
          {item.review !== undefined &&
          (item.stage === "awaiting_review" || item.stage === "done") ? (
            <div className="space-y-2.5 border-t border-black/[0.05] pt-2.5 text-[12px] dark:border-white/[0.06]">
              <div className="flex flex-wrap items-center justify-between gap-2 text-[#4B5565] dark:text-[#A1A1AA]">
                <div className="flex flex-wrap items-center gap-2">
                  <span>{item.review.filesChanged} 个文件变更</span>
                  <span className="font-mono text-[11.5px] tabular-nums">
                    <span className="text-[#15803D] dark:text-[#4ADE80]">
                      +{item.review.additions}
                    </span>{" "}
                    <span className="text-[#B91C1C] dark:text-[#F87171]">
                      -{item.review.deletions}
                    </span>
                  </span>
                  {item.review.worktreeBranch ? (
                    <span className="inline-flex items-center gap-1 font-mono text-[11px] text-[#687082] dark:text-[#8E8E96]">
                      <GitBranch className="h-3 w-3" />
                      <span>{item.review.worktreeBranch}</span>
                    </span>
                  ) : null}
                </div>

                <button
                  type="button"
                  onClick={() => setFilesExpanded((v) => !v)}
                  className="inline-flex cursor-pointer items-center gap-0.5 text-[11.5px] text-[#687082] hover:text-[#111318] dark:text-[#8E8E96] dark:hover:text-[#F2F2F4]"
                >
                  <span>{filesExpanded ? "收起文件" : "查看文件"}</span>
                  <ChevronDown
                    className={cn("h-3 w-3 transition-transform", filesExpanded && "rotate-180")}
                  />
                </button>
              </div>

              {item.review.verifierNote ? (
                <p className="text-[12px] leading-relaxed text-[#545D6C] dark:text-[#A1A1AA]">
                  复核说明：{item.review.verifierNote}
                </p>
              ) : null}

              {filesExpanded ? (
                <ul className="space-y-1 rounded-lg bg-black/[0.03] px-2.5 py-2 font-mono text-[11px] text-[#3B414E] dark:bg-white/[0.04] dark:text-[#C4C4CA]">
                  {item.review.changedFiles.map((file) => (
                    <li key={file} className="truncate">
                      {file}
                    </li>
                  ))}
                </ul>
              ) : null}

              {item.stage === "awaiting_review" ? (
                <div className="space-y-2 pt-0.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <AppButton
                      variant="primary"
                      size="xs"
                      leadingIcon={<Check className="h-3.5 w-3.5" />}
                      onClick={() => {
                        props.onDecideReview(item.id, "approve");
                        toast.success("已签收变更");
                      }}
                    >
                      签收
                    </AppButton>
                    <AppButton
                      variant="secondary"
                      size="xs"
                      onClick={() => setReworkOpen((v) => !v)}
                    >
                      退回修改
                    </AppButton>
                  </div>

                  {reworkOpen ? (
                    <div className="flex items-center gap-1.5 pt-0.5">
                      <AppInput
                        size="sm"
                        value={reworkDraft}
                        onChange={(e) => setReworkDraft(e.target.value)}
                        placeholder="填写需要调整的说明…"
                        className="flex-1 text-xs"
                      />
                      <AppButton
                        variant="primary"
                        size="xs"
                        disabled={reworkDraft.trim().length === 0}
                        onClick={() => {
                          props.onDecideReview(item.id, "rework", reworkDraft);
                          setReworkDraft("");
                          setReworkOpen(false);
                          toast.info("已退回继续修改");
                        }}
                      >
                        确定
                      </AppButton>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}

          {item.stage === "cancelled" || item.stage === "blocked" ? (
            <div className="flex items-center justify-end">
              <AppButton
                variant="secondary"
                size="xs"
                leadingIcon={<RotateCcw className="h-3 w-3" />}
                onClick={() => {
                  props.onRetry(item.id);
                  toast.info("已恢复运行");
                }}
              >
                重新运行
              </AppButton>
            </div>
          ) : null}
        </div>
      </article>
    </div>
  );
}
