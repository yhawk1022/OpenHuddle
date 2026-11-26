/**
 * @module web/features/huddle-room/work-inspector-tab
 * @description 右侧会话信息抽屉（`356px`）内的「任务」页签（原生桌面面板范式：细分割线分组 + 安静折叠偏好，零口号横幅）。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 去 AI 化克制布局：移除顶部营销口号卡与常驻预览芯片，将演示数据入口收敛至右上角 `⋯` 菜单，保持真实桌面软件的工具感。
 * 2. 防嵌套模糊：内部列表统一采用单层半透实底 `SECTION_CARD_CLASS` 与单像素分割线，绝不叠加二次 `backdrop-filter`。
 */
import type { AgentId, RoomId, RoomMemberDto } from "@openhuddle/protocol";
import {
  ArrowUpRight,
  Check,
  ChevronDown,
  CornerDownLeft,
  FolderGit2,
  MoreHorizontal,
  Plus,
  RotateCcw,
  SlidersHorizontal,
  Square,
} from "lucide-react";
import { useMemo, useState } from "react";
import {
  AppButton,
  type AppDropdownEntry,
  AppDropdownMenu,
  AppInput,
  AppSelect,
  type AppSelectOption,
  type SegmentedTabItem,
  SegmentedTabs,
  cn,
  toast,
} from "../../../components/primitives/index.js";
import { PlatformAvatar } from "../../../components/ui/identity-badges.js";
import { useWorkspaceDirectory } from "../work/solo-workbench-store.js";
import { bindRoomWorkspaceOnServer } from "../work/work-server-sync.js";
import type {
  ObserveDryRunEntry,
  RoomOrchestrationDefaults,
  RoomWorkItemView,
  SuperAgentIntakeMode,
  WorkShowcasePreset,
} from "../work/work-types.js";
import { WorkStageGlyph, getWorkTopologyLabel } from "../work/work-utils.js";
import { WorkAttentionCard } from "./work-attention-card.js";

const SECTION_CARD_CLASS =
  "overflow-hidden rounded-[16px] bg-white/72 ring-1 ring-inset ring-black/[0.055] dark:bg-white/[0.045] dark:ring-white/[0.075]";

const INTAKE_MODE_ITEMS: ReadonlyArray<SegmentedTabItem<SuperAgentIntakeMode>> = [
  { value: "off", label: "手动交办" },
  { value: "observe", label: "仅建议" },
  { value: "auto", label: "自动接单" },
];

const AUTO_SENTINEL = "__auto__";
const UNBOUND_WORKSPACE_SENTINEL = "__unbound_ws__";

/** `WorkInspectorTab` 入参属性 */
export interface WorkInspectorTabProps {
  readonly roomId: RoomId;
  readonly members: ReadonlyArray<RoomMemberDto>;
  readonly items: ReadonlyArray<RoomWorkItemView>;
  readonly activeRunningItems: ReadonlyArray<RoomWorkItemView>;
  readonly needsHumanItems: ReadonlyArray<RoomWorkItemView>;
  readonly defaults: RoomOrchestrationDefaults;
  readonly observeLogs: ReadonlyArray<ObserveDryRunEntry>;
  readonly focusedWorkItemId: string | null;
  readonly onUpdateDefaults: (patch: Partial<RoomOrchestrationDefaults>) => void;
  readonly onSteerSlice: (workItemId: string, note: string, sliceId?: string | undefined) => void;
  readonly onStopItem: (workItemId: string) => Promise<void> | void;
  readonly onRetryItem: (workItemId: string) => void;
  readonly onAnswerAttention: (workItemId: string, choice: string) => Promise<void> | void;
  readonly onDecideReview: (workItemId: string, decision: "approve" | "rework") => void;
  readonly onOpenComposerDispatch: () => void;
  readonly onOpenWorkbench?: ((workspaceId?: string | undefined) => void) | undefined;
  readonly onLoadShowcase: (preset: WorkShowcasePreset) => void;
  readonly onClearShowcase: () => void;
}

/**
 * 渲染 `RoomInspector` 内的「任务」页签。
 */
export function WorkInspectorTab(props: WorkInspectorTabProps) {
  const [expandedId, setExpandedId] = useState<string | null>(props.focusedWorkItemId);
  const [steerTargetKey, setSteerTargetKey] = useState<string | null>(null);
  const [steerInput, setSteerInput] = useState<string>("");
  const [defaultsOpen, setDefaultsOpen] = useState<boolean>(false);
  const [stoppingId, setStoppingId] = useState<string | null>(null);

  const workbenchSnap = useWorkspaceDirectory();
  const boundWorkspaceId = workbenchSnap.roomBindings[props.roomId] ?? null;
  const boundWorkspace = useMemo(
    () =>
      boundWorkspaceId !== null
        ? (workbenchSnap.workspaces.find((w) => w.id === boundWorkspaceId) ?? null)
        : null,
    [boundWorkspaceId, workbenchSnap.workspaces],
  );

  const workspaceSelectOptions: ReadonlyArray<AppSelectOption<string>> = useMemo(
    () => [
      { value: UNBOUND_WORKSPACE_SENTINEL, label: "未关联（仅聊天）" },
      ...workbenchSnap.workspaces.map((ws) => ({
        value: ws.id,
        label: ws.name,
      })),
    ],
    [workbenchSnap.workspaces],
  );

  const agentMembers = useMemo(
    () => props.members.filter((m) => m.memberKind === "agent" && m.agentId !== undefined),
    [props.members],
  );

  const roleSelectOptions: ReadonlyArray<AppSelectOption<string>> = useMemo(
    () => [
      { value: AUTO_SENTINEL, label: "自动分配" },
      ...agentMembers.map((a) => ({
        value: String(a.agentId),
        label: a.displayName,
      })),
    ],
    [agentMembers],
  );

  const completedItems = useMemo(
    () => props.items.filter((i) => i.stage === "done" || i.stage === "cancelled"),
    [props.items],
  );

  const menuEntries: ReadonlyArray<AppDropdownEntry> = useMemo(
    () => [
      ...(props.onOpenWorkbench !== undefined
        ? [
            {
              id: "insp-open-workbench",
              label: "打开工作台…",
              onSelect: () => props.onOpenWorkbench?.(boundWorkspace?.id),
            } satisfies AppDropdownEntry,
          ]
        : []),
      ...(props.items.some((i) => !i.id.startsWith("wrk_"))
        ? [
            {
              id: "insp-demo-clear",
              label: "清空本地记录",
              danger: true,
              onSelect: () => props.onClearShowcase(),
            } satisfies AppDropdownEntry,
          ]
        : []),
    ],
    [boundWorkspace?.id, props],
  );

  const submitSliceSteer = (workItemId: string, sliceId: string): void => {
    const clean = steerInput.trim();
    if (clean.length === 0) {
      return;
    }
    props.onSteerSlice(workItemId, clean, sliceId);
    toast.success("已发送补充说明");
    setSteerInput("");
    setSteerTargetKey(null);
  };

  const handleStopItem = (workItemId: string): void => {
    if (stoppingId === workItemId) {
      return;
    }
    setStoppingId(workItemId);
    void Promise.resolve(props.onStopItem(workItemId))
      .then(() => toast.info("已停止任务"))
      .catch((err: unknown) => toast.error(err instanceof Error ? err.message : "停止任务失败"))
      .finally(() => setStoppingId((cur) => (cur === workItemId ? null : cur)));
  };

  return (
    <div className="space-y-3.5 pb-2">
      {/* 关联工作区挂载栏（Owner-First 受控沙盒：群内交办自动归入工作台，外部 Agent 硬锁仅聊天） */}
      <div className={cn(SECTION_CARD_CLASS, "p-3")}>
        <div className="flex items-center justify-between gap-2">
          <span className="inline-flex shrink-0 items-center gap-1.5 text-[12px] font-medium text-[#3B414E] dark:text-[#C4C4CA]">
            <FolderGit2 className="h-3.5 w-3.5 text-[#687082] dark:text-[#8E8E96]" />
            <span>关联工作区</span>
          </span>

          <AppSelect
            size="sm"
            ariaLabel="关联本机工作区"
            value={boundWorkspace?.id ?? UNBOUND_WORKSPACE_SENTINEL}
            onValueChange={(nextVal) => {
              if (nextVal === UNBOUND_WORKSPACE_SENTINEL) {
                void bindRoomWorkspaceOnServer(props.roomId, null)
                  .then(() => toast.info("已解除本群工作区关联"))
                  .catch((err: unknown) =>
                    toast.error(err instanceof Error ? err.message : "解除工作区关联失败"),
                  );
              } else {
                const targetWs = workbenchSnap.workspaces.find((w) => w.id === nextVal);
                void bindRoomWorkspaceOnServer(props.roomId, nextVal)
                  .then(() => toast.success(`已关联工作区「${targetWs?.name ?? nextVal}」`))
                  .catch((err: unknown) =>
                    toast.error(err instanceof Error ? err.message : "关联工作区失败"),
                  );
              }
            }}
            options={workspaceSelectOptions}
            className="h-7 w-auto max-w-[168px] shrink-0 text-[12px]"
          />
        </div>

        {boundWorkspace !== null ? (
          <div className="mt-2 space-y-1 border-t border-black/[0.05] pt-2 text-[11px] text-[#687082] dark:border-white/[0.06] dark:text-[#8E8E96]">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate font-mono">{boundWorkspace.localPath}</span>
              {props.onOpenWorkbench !== undefined ? (
                <button
                  type="button"
                  onClick={() => props.onOpenWorkbench?.(boundWorkspace.id)}
                  className="inline-flex shrink-0 cursor-pointer items-center gap-0.5 font-sans text-[11px] font-medium text-[#2563EB] hover:underline dark:text-[#60A5FA]"
                >
                  <span>打开工作台</span>
                  <ArrowUpRight className="h-3 w-3" />
                </button>
              ) : null}
            </div>
            <p className="leading-relaxed">
              群内交办将自动归入该工作区；非本人名下的外部 Agent 始终仅限聊天讨论。
            </p>
          </div>
        ) : null}
      </div>

      {/* 顶部操作行：新建任务 + 更多选项菜单 */}
      <div className="flex items-center justify-between gap-2 px-0.5">
        <span className="text-[12px] font-medium text-[#687082] dark:text-[#8E8E96]">
          {props.items.length > 0 ? `共 ${String(props.items.length)} 项任务` : "群内任务"}
        </span>

        <div className="flex items-center gap-1">
          <AppButton
            variant="secondary"
            size="xs"
            leadingIcon={<Plus className="h-3.5 w-3.5" />}
            onClick={props.onOpenComposerDispatch}
          >
            新建任务
          </AppButton>

          {menuEntries.length > 0 ? (
            <AppDropdownMenu
              align="end"
              items={menuEntries}
              trigger={
                <button
                  type="button"
                  aria-label="任务菜单"
                  className="inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded-full text-[#687082] transition hover:bg-black/[0.05] hover:text-[#111318] dark:text-[#8E8E96] dark:hover:bg-white/[0.08] dark:hover:text-white"
                >
                  <MoreHorizontal className="h-4 w-4" />
                </button>
              }
            />
          ) : null}
        </div>
      </div>

      {/* 空态 */}
      {props.items.length === 0 ? (
        <div className={cn(SECTION_CARD_CLASS, "px-4 py-8 text-center")}>
          <p className="text-[13px] font-medium text-[#3B414E] dark:text-[#C4C4CA]">暂无任务</p>
          <p className="mt-1 text-[11.5px] leading-relaxed text-[#8E96A6] dark:text-[#71717A]">
            点击「新建任务」或在输入框开启交办，将事项分配给群内 Agent
          </p>
        </div>
      ) : null}

      {/* 1. 待确认任务组 */}
      {props.needsHumanItems.length > 0 ? (
        <section className="space-y-1.5">
          <div className="flex items-center justify-between px-1 text-[11.5px] font-medium text-[#687082] dark:text-[#8E8E96]">
            <span>待确认</span>
            <span className="tabular-nums">{props.needsHumanItems.length}</span>
          </div>

          <div
            className={cn(
              SECTION_CARD_CLASS,
              "divide-y divide-black/[0.05] dark:divide-white/[0.06]",
            )}
          >
            {props.needsHumanItems.map((item) => (
              <div key={`needs-${item.id}`} className="space-y-2.5 p-3 text-xs">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex min-w-0 flex-1 items-start gap-2">
                    <span className="mt-0.5">
                      <WorkStageGlyph stage={item.stage} />
                    </span>
                    <p className="min-w-0 flex-1 font-medium leading-snug text-[#111318] dark:text-[#F2F2F4]">
                      {item.title}
                    </p>
                  </div>

                  {item.stage === "awaiting_answer" ? (
                    <button
                      type="button"
                      title="停止任务"
                      aria-label="停止任务"
                      disabled={stoppingId === item.id}
                      onClick={() => handleStopItem(item.id)}
                      className="relative inline-flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-[#8E96A6] transition hover:bg-black/[0.05] hover:text-[#DC2626] disabled:cursor-not-allowed disabled:opacity-45 [@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:-inset-2.5 dark:hover:bg-white/[0.08] dark:hover:text-[#F87171]"
                    >
                      <Square className="h-2.5 w-2.5 fill-current" />
                    </button>
                  ) : null}
                </div>

                {item.stage === "awaiting_answer" && item.attention !== undefined ? (
                  <div className="pl-5">
                    <WorkAttentionCard
                      variant="inspector"
                      key={`${item.id}:${item.attention.question}`}
                      askedByName={item.attention.askedBy.displayName}
                      question={item.attention.question}
                      options={item.attention.options}
                      onSubmitAnswer={(choice) => props.onAnswerAttention(item.id, choice)}
                    />
                  </div>
                ) : null}

                {item.stage === "awaiting_review" && item.review !== undefined ? (
                  <div className="space-y-2 pl-5">
                    <p className="text-[11.5px] text-[#687082] dark:text-[#9B9BA3]">
                      {item.review.filesChanged} 个文件变更 ·{" "}
                      <span className="font-mono text-[#15803D] dark:text-[#4ADE80]">
                        +{item.review.additions}
                      </span>{" "}
                      <span className="font-mono text-[#B91C1C] dark:text-[#F87171]">
                        -{item.review.deletions}
                      </span>
                    </p>
                    {item.review.verifierNote !== undefined ? (
                      <p className="text-[11.5px] leading-relaxed text-[#4B5565] dark:text-[#A1A1AA]">
                        {item.review.verifierNote}
                      </p>
                    ) : null}
                    <div className="flex items-center gap-1.5 pt-0.5">
                      <AppButton
                        size="xs"
                        variant="primary"
                        leadingIcon={<Check className="h-3 w-3" />}
                        onClick={() => {
                          props.onDecideReview(item.id, "approve");
                          toast.success("已签收");
                        }}
                      >
                        签收
                      </AppButton>
                      <AppButton
                        size="xs"
                        variant="secondary"
                        onClick={() => {
                          props.onDecideReview(item.id, "rework");
                          toast.info("已退回修改");
                        }}
                      >
                        退回
                      </AppButton>
                    </div>
                  </div>
                ) : null}

                {item.stage === "blocked" ? (
                  <div className="pl-5">
                    <AppButton
                      size="xs"
                      variant="secondary"
                      leadingIcon={<RotateCcw className="h-3 w-3" />}
                      onClick={() => props.onRetryItem(item.id)}
                    >
                      重新运行
                    </AppButton>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {/* 2. 进行中任务组 */}
      {props.activeRunningItems.length > 0 ? (
        <section className="space-y-1.5">
          <div className="flex items-center justify-between px-1 text-[11.5px] font-medium text-[#687082] dark:text-[#8E8E96]">
            <span>进行中</span>
            <span className="tabular-nums">{props.activeRunningItems.length}</span>
          </div>

          <div
            className={cn(
              SECTION_CARD_CLASS,
              "divide-y divide-black/[0.05] dark:divide-white/[0.06]",
            )}
          >
            {props.activeRunningItems.map((item) => (
              <div key={`run-${item.id}`} className="space-y-2.5 p-3 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <WorkStageGlyph stage={item.stage} />
                    <p className="truncate font-medium text-[#111318] dark:text-[#F2F2F4]">
                      {item.title}
                    </p>
                  </div>

                  <button
                    type="button"
                    title="停止任务"
                    aria-label="停止任务"
                    disabled={stoppingId === item.id}
                    onClick={() => handleStopItem(item.id)}
                    className="relative inline-flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-[#8E96A6] transition hover:bg-black/[0.05] hover:text-[#DC2626] disabled:cursor-not-allowed disabled:opacity-45 [@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:-inset-2.5 dark:hover:bg-white/[0.08] dark:hover:text-[#F87171]"
                  >
                    <Square className="h-2.5 w-2.5 fill-current" />
                  </button>
                </div>

                <div className="space-y-2 pl-5">
                  {item.slices.map((slice) => {
                    const key = `${item.id}:${slice.sliceId}`;
                    const steerOpen = steerTargetKey === key;
                    return (
                      <div key={slice.sliceId} className="space-y-1.5">
                        <div className="flex items-center justify-between gap-2">
                          <span className="flex min-w-0 items-center gap-1.5">
                            <PlatformAvatar
                              kind="agent"
                              displayName={slice.worker.displayName}
                              platform={slice.worker.platform}
                              size="sm"
                              className="[&>div]:h-4 [&>div]:w-4 [&>div]:text-[9px]"
                            />
                            <span className="truncate font-medium text-[#181B22] dark:text-[#ECECEF]">
                              {slice.worker.displayName}
                            </span>
                          </span>
                          <div className="flex shrink-0 items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => setSteerTargetKey(steerOpen ? null : key)}
                              className="cursor-pointer text-[11px] text-[#687082] hover:text-[#111318] dark:text-[#8E8E96] dark:hover:text-white"
                            >
                              补充
                            </button>
                            <span className="font-mono text-[10.5px] tabular-nums text-[#8E96A6]">
                              {slice.elapsedSec}s
                            </span>
                          </div>
                        </div>

                        <p className="text-[11px] text-[#687082] dark:text-[#9B9BA3]">
                          {slice.liveSummary}
                        </p>

                        {steerOpen ? (
                          <div className="flex items-center gap-1 pt-0.5">
                            <AppInput
                              size="sm"
                              value={steerInput}
                              onChange={(e) => setSteerInput(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                                  e.preventDefault();
                                  submitSliceSteer(item.id, slice.sliceId);
                                }
                              }}
                              placeholder="补充要求…"
                              className="flex-1 text-xs"
                            />
                            <AppButton
                              size="xs"
                              variant="secondary"
                              onClick={() => submitSliceSteer(item.id, slice.sliceId)}
                            >
                              <CornerDownLeft className="h-3 w-3" />
                            </AppButton>
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {/* 3. 已完成任务组 */}
      {completedItems.length > 0 ? (
        <section className="space-y-1.5">
          <div className="flex items-center justify-between px-1 text-[11.5px] font-medium text-[#687082] dark:text-[#8E8E96]">
            <span>已完成</span>
            <span className="tabular-nums">{completedItems.length}</span>
          </div>

          <div
            className={cn(
              SECTION_CARD_CLASS,
              "divide-y divide-black/[0.05] dark:divide-white/[0.06]",
            )}
          >
            {completedItems.map((item) => {
              const open = expandedId === item.id;
              return (
                <div key={`done-${item.id}`} className="p-2.5 text-xs">
                  <button
                    type="button"
                    onClick={() => setExpandedId(open ? null : item.id)}
                    className="flex w-full cursor-pointer items-center justify-between gap-2 text-left"
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <WorkStageGlyph stage={item.stage} />
                      <span className="truncate text-[#4B5565] dark:text-[#A1A1AA]">
                        {item.title}
                      </span>
                    </span>
                    <ChevronDown
                      className={cn(
                        "h-3.5 w-3.5 shrink-0 text-[#94A3B8] transition-transform",
                        open && "rotate-180",
                      )}
                    />
                  </button>

                  {open ? (
                    <div className="mt-2 space-y-1 pl-5 text-[11px] text-[#687082] dark:text-[#8E8E96]">
                      <p>
                        {getWorkTopologyLabel(item.topology)} · {item.primaryWorker.displayName}
                      </p>
                      {item.stage === "cancelled" ? (
                        <button
                          type="button"
                          onClick={() => props.onRetryItem(item.id)}
                          className="mt-1 inline-flex cursor-pointer items-center gap-1 font-medium text-[#111318] hover:underline dark:text-[#F2F2F4]"
                        >
                          <RotateCcw className="h-3 w-3" />
                          <span>重新运行</span>
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </section>
      ) : null}

      {/* 4. 折叠式默认分工设置 */}
      <div className={cn(SECTION_CARD_CLASS, "p-2.5 text-xs")}>
        <button
          type="button"
          onClick={() => setDefaultsOpen((v) => !v)}
          className="flex w-full cursor-pointer items-center justify-between text-left text-[12px] font-medium text-[#4B5565] dark:text-[#A1A1AA]"
        >
          <span className="inline-flex items-center gap-1.5">
            <SlidersHorizontal className="h-3.5 w-3.5 text-[#687082]" />
            <span>默认分工偏好</span>
          </span>
          <ChevronDown
            className={cn(
              "h-3.5 w-3.5 text-[#94A3B8] transition-transform",
              defaultsOpen && "rotate-180",
            )}
          />
        </button>

        {defaultsOpen ? (
          <div className="mt-3 space-y-3 border-t border-black/[0.05] pt-3 dark:border-white/[0.06]">
            <div>
              <span className="mb-1.5 block text-[11px] text-[#687082] dark:text-[#8E8E96]">
                接单方式
              </span>
              <SegmentedTabs
                size="xs"
                fullWidth={true}
                items={INTAKE_MODE_ITEMS}
                value={props.defaults.intakeMode}
                onValueChange={(intakeMode) => props.onUpdateDefaults({ intakeMode })}
              />
            </div>

            {agentMembers.length > 0 ? (
              <>
                <div>
                  <span className="mb-1 block text-[11px] text-[#687082] dark:text-[#8E8E96]">
                    默认拆单人
                  </span>
                  <AppSelect
                    size="sm"
                    ariaLabel="默认拆单人"
                    value={props.defaults.coordinatorAgentId ?? AUTO_SENTINEL}
                    onValueChange={(v) =>
                      props.onUpdateDefaults({
                        coordinatorAgentId: v === AUTO_SENTINEL ? undefined : (v as AgentId),
                      })
                    }
                    options={roleSelectOptions}
                  />
                </div>

                <div>
                  <span className="mb-1 block text-[11px] text-[#687082] dark:text-[#8E8E96]">
                    默认复核人
                  </span>
                  <AppSelect
                    size="sm"
                    ariaLabel="默认复核人"
                    value={props.defaults.verifierAgentId ?? AUTO_SENTINEL}
                    onValueChange={(v) =>
                      props.onUpdateDefaults({
                        verifierAgentId: v === AUTO_SENTINEL ? undefined : (v as AgentId),
                      })
                    }
                    options={roleSelectOptions}
                  />
                </div>
              </>
            ) : null}

            {props.defaults.intakeMode === "observe" && props.observeLogs.length > 0 ? (
              <div className="space-y-1 border-t border-black/[0.05] pt-2 text-[11px] text-[#687082] dark:border-white/[0.06] dark:text-[#8E8E96]">
                {props.observeLogs.slice(0, 3).map((entry) => (
                  <p key={entry.id} className="truncate">
                    建议交由 {entry.suggestedAssigneeName}：{entry.triggerSnippet}
                  </p>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
