/**
 * @module web/features/huddle-room/governance-bar
 * @description Pachat 68px 通透群聊顶栏（Airy Monochrome Chat Header）：
 * 左侧仅展示移动端 `<` 返回按钮、`17px` 粗体群名与 `12.5px` 自然议题副标题（彻底移除 `#` 频道方盒与噪音徽章）；
 * 右侧排列 Pachat 标志性 `#F5F5F7`（暗色 `dark:bg-white/[0.07]`）圆润胶囊组：
 * `👥 X 个 agent · Y 人`（开关右侧抽屉）、安静的 `轮次 X/Y`（打开 Radix `AppPopover` 治理浮层，仅在 `paused_budget` 时亮起暖琥珀色）、
 * `提案 · N` 与 `+ 邀请`。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 留白与单行节制：主标题栏固定 `68px` 呼吸高度，所有治理开关均收纳进 Radix Portal 浮层，绝不出现任何原生下拉控件或紫色渐变。
 * 2. 异常才提醒：平时 `轮次 X/Y` 保持安静 `#F5F5F7` 中性底色；仅当 `status === "paused_budget"` 需要人类续期，或存在刚拍板通过的结论时，才按需平滑展开副横幅。
 * 3. Tauri v2 & Electron 双端无边框拖拽就绪：顶栏同时标记 `data-tauri-drag-region` 与 `.app-drag-region`，所有胶囊按钮均带 `.app-no-drag`。
 */
import type {
  GovernanceMode,
  RoomDetailDto,
  RoomGovernanceState,
  UpdateGovernanceBody,
} from "@openhuddle/protocol";
import {
  AlertTriangle,
  AtSign,
  CheckCircle2,
  ChevronLeft,
  FileText,
  Lock,
  Play,
  Plus,
  ShieldAlert,
  Users,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";
import {
  AnimatePresence,
  AppButton,
  AppPopover,
  AppSelect,
  type AppSelectOption,
  AppSwitch,
  AppTooltip,
  IconButton,
  type SegmentedTabItem,
  SegmentedTabs,
  cn,
  motion,
  toast,
} from "../../../components/primitives/index.js";

/** `GovernanceBar` 入参属性 */
export interface GovernanceBarProps {
  readonly room: RoomDetailDto;
  readonly governance: RoomGovernanceState;
  readonly proposalsCount: number;
  readonly openProposalsCount: number;
  /** 最近一次已拍板通过的提案标题；为 `null` 时不展示「已拍板」结论条 */
  readonly decidedProposalTitle: string | null;
  readonly isUpdatingGovernance: boolean;
  readonly isInspectorOpen: boolean;
  readonly onUpdateGovernance: (patch: UpdateGovernanceBody) => void;
  readonly onOpenAddAgentModal: () => void;
  readonly onOpenProposals: () => void;
  readonly onToggleInspector: () => void;
  /** 移动端返回会话列表（仅 `< md` 可见） */
  readonly onBackToList: () => void;
}

const MODE_META: ReadonlyArray<{
  readonly value: GovernanceMode;
  readonly label: string;
}> = [
  { value: "free", label: "自由讨论" },
  { value: "round_table", label: "圆桌轮流" },
  { value: "proposal", label: "提案收敛" },
];

const MODE_TAB_ITEMS: ReadonlyArray<SegmentedTabItem<GovernanceMode>> = MODE_META.map((item) => ({
  value: item.value,
  label: item.label,
}));

const BASE_TURN_CAPS: ReadonlyArray<number> = [3, 4, 6, 8, 10, 15, 25];

/** Pachat 顶栏右侧统一柔和胶囊基础类名 */
const HEADER_PILL_BASE_CLASS =
  "app-no-drag inline-flex h-9 shrink-0 cursor-pointer select-none items-center gap-1.5 rounded-full px-3.5 text-[13px] font-medium transition-colors active:scale-[0.97]";

const HEADER_PILL_NEUTRAL_CLASS =
  "bg-[#F5F5F7] text-[#141414] hover:bg-[#EBEBEF] dark:bg-white/[0.07] dark:text-zinc-100 dark:hover:bg-white/[0.12]";

/**
 * 渲染 Pachat 68px 群聊顶栏、Radix 治理配置浮层及按需展开的预算检查点/拍板横幅。
 *
 * @param props - 房间详情、实时治理快照、抽屉开关状态与各项治理回调
 * @returns 顶部 Pachat 群聊头组件
 */
export function GovernanceBar(props: GovernanceBarProps) {
  const { governance } = props;
  const { config } = governance;
  const [governanceOpen, setGovernanceOpen] = useState<boolean>(false);
  const [dismissedDecision, setDismissedDecision] = useState<string | null>(null);

  const usedTurns = governance.consecutiveAgentTurns;
  const maxTurns = config.maxConsecutiveAgentTurns;
  const ratio = maxTurns > 0 ? Math.min(1, usedTurns / maxTurns) : 0;
  const isPaused = governance.status === "paused_budget";

  const agents = useMemo(
    () => props.room.members.filter((m) => m.memberKind === "agent"),
    [props.room.members],
  );
  const humanCount = useMemo(
    () => props.room.members.filter((m) => m.memberKind === "human").length,
    [props.room.members],
  );
  const onlineAgents = useMemo(
    () =>
      agents.filter(
        (m) => m.reach === "online_sse" || m.reach === "hosted_ready" || m.reach === "webhook",
      ).length,
    [agents],
  );

  // 若房间使用了自定义轮次上限（不在预设档位中），动态并入下拉选项以确保 Radix Select.Value 准确回显
  const turnCapOptions: ReadonlyArray<AppSelectOption<string>> = useMemo(() => {
    const merged = BASE_TURN_CAPS.includes(maxTurns)
      ? BASE_TURN_CAPS
      : [...BASE_TURN_CAPS, maxTurns].sort((a, b) => a - b);
    return merged.map((cap) => ({
      value: String(cap),
      label: `${String(cap)} 轮连续发言`,
    }));
  }, [maxTurns]);

  const showDecided =
    !isPaused &&
    props.decidedProposalTitle !== null &&
    props.openProposalsCount === 0 &&
    dismissedDecision !== props.decidedProposalTitle;

  const subtitleText =
    props.room.topic.length > 0
      ? props.room.topic
      : props.room.visibility === "public_shareable"
        ? "公开只读可分享"
        : "仅限邀请加入";

  const visibleProposalBadgeCount =
    props.openProposalsCount > 0 ? props.openProposalsCount : props.proposalsCount;

  const handleModeChange = (nextMode: GovernanceMode): void => {
    if (nextMode === config.mode || props.isUpdatingGovernance) {
      return;
    }
    const label = MODE_META.find((m) => m.value === nextMode)?.label ?? nextMode;
    props.onUpdateGovernance({ mode: nextMode });
    toast.success(`讨论模式已切换为「${label}」`);
  };

  const handleTurnCapChange = (nextValue: string): void => {
    const parsed = Number(nextValue);
    if (!Number.isFinite(parsed) || parsed === maxTurns || props.isUpdatingGovernance) {
      return;
    }
    props.onUpdateGovernance({ maxConsecutiveAgentTurns: parsed });
    toast.success(`连续 Agent 发言上限已设为 ${String(parsed)} 轮`);
  };

  const handleRenewBudget = (): void => {
    if (props.isUpdatingGovernance) {
      return;
    }
    props.onUpdateGovernance({ renewBudget: true });
    toast.success(`已续期轮次预算（+${String(maxTurns)} 轮），Agent 讨论继续`);
  };

  const handleToggleAgentMentions = (checked: boolean): void => {
    if (props.isUpdatingGovernance) {
      return;
    }
    props.onUpdateGovernance({ allowAgentMentions: checked });
    toast.success(checked ? "已允许 Agent 互相 @ 唤醒" : "已关闭 Agent 互相 @ 唤醒");
  };

  const handleToggleReadLock = (checked: boolean): void => {
    if (props.isUpdatingGovernance) {
      return;
    }
    props.onUpdateGovernance({ requireReadBeforeSend: checked });
    toast.success(checked ? "已开启防抢话读锁" : "已关闭防抢话读锁");
  };

  return (
    <header className="glass-bar relative z-20 shrink-0 select-none border-b border-black/[0.06] dark:border-white/[0.06]">
      <div
        data-tauri-drag-region=""
        className="app-drag-region flex h-[68px] items-center justify-between gap-3 px-4 sm:px-6"
      >
        {/* 左：移动端 `<` 返回按钮 + 17px 粗体群名 + 12.5px 议题/可见性副标题 */}
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <IconButton
            variant="ghost"
            size="md"
            label="返回会话列表"
            onClick={props.onBackToList}
            className="-ml-1.5 text-[#141414] md:hidden dark:text-zinc-100"
          >
            <ChevronLeft className="h-5 w-5" />
          </IconButton>

          <div className="min-w-0 flex-1">
            <h1 className="truncate text-[17px] font-semibold tracking-[-0.015em] text-[#141414] dark:text-zinc-100">
              {props.room.name}
            </h1>
            <p className="mt-0.5 truncate text-[12.5px] text-[#6E6E73] dark:text-zinc-400">
              {subtitleText}
            </p>
          </div>
        </div>

        {/* 右：Pachat `#F5F5F7` 圆角胶囊动作组 */}
        <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
          {/* 1. 成员与 Agent 人数胶囊（点击切换右侧 RoomInspector） */}
          <AppTooltip
            side="bottom"
            content={
              props.isInspectorOpen
                ? "收起群成员与设置面板"
                : `${String(onlineAgents)} 个 Agent 在线 · 点击展开群成员面板`
            }
          >
            <button
              type="button"
              aria-pressed={props.isInspectorOpen}
              onClick={props.onToggleInspector}
              className={cn(
                HEADER_PILL_BASE_CLASS,
                "px-3 sm:px-3.5",
                HEADER_PILL_NEUTRAL_CLASS,
                props.isInspectorOpen &&
                  "bg-[#E8E8ED] ring-1 ring-inset ring-black/15 dark:bg-white/[0.14] dark:ring-white/20",
              )}
            >
              <Users className="h-3.5 w-3.5 shrink-0 text-[#5F5F64] dark:text-zinc-400" />
              <span className="hidden sm:inline">
                {agents.length} 个 agent · {humanCount} 人
              </span>
              <span className="tabular-nums sm:hidden">{props.room.members.length}</span>
            </button>
          </AppTooltip>

          {/* 2. 安静的 `轮次 X/Y` 治理胶囊（平时保持 `#F5F5F7` 中性，仅 `paused_budget` 变暖琥珀色） */}
          <AppPopover
            open={governanceOpen}
            onOpenChange={setGovernanceOpen}
            side="bottom"
            align="end"
            className="w-80 space-y-3.5 p-4 text-xs"
            trigger={
              <button
                type="button"
                aria-label="讨论轮次与群聊规则设置"
                className={cn(
                  HEADER_PILL_BASE_CLASS,
                  "px-3 sm:px-3.5",
                  isPaused
                    ? "bg-[#FFF1C2] text-[#5C4813] ring-1 ring-inset ring-[#D99B26]/35 hover:bg-[#FBE8A6] dark:bg-[#2C2718] dark:text-[#F2DF9D] dark:ring-[#E5B34B]/30 dark:hover:bg-[#362F1D]"
                    : cn(
                        HEADER_PILL_NEUTRAL_CLASS,
                        governanceOpen &&
                          "bg-[#E8E8ED] ring-1 ring-inset ring-black/15 dark:bg-white/[0.14] dark:ring-white/20",
                      ),
                )}
              >
                {isPaused ? (
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#D99B26] dark:bg-[#E5B34B]" />
                ) : null}
                <span className="tabular-nums">
                  <span className="hidden sm:inline">轮次 </span>
                  {usedTurns}/{maxTurns}
                </span>
              </button>
            }
          >
            {/* 讨论模式分段器 */}
            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <span className="text-[11.5px] font-semibold text-[#5F5F64] dark:text-zinc-400">
                  讨论节奏
                </span>
              </div>
              <SegmentedTabs
                value={config.mode}
                onValueChange={handleModeChange}
                items={MODE_TAB_ITEMS}
                size="xs"
                fullWidth={true}
                ariaLabel="切换讨论模式"
              />
            </div>

            {/* 连续 Agent 轮次预算与 Radix AppSelect */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-[11.5px] font-semibold text-[#5F5F64] dark:text-zinc-400">
                  连续 Agent 发言上限
                </span>
                <span
                  className={cn(
                    "font-mono text-[11px] font-semibold tabular-nums",
                    isPaused
                      ? "text-[#9A6700] dark:text-[#F2DF9D]"
                      : "text-[#141414] dark:text-zinc-200",
                  )}
                >
                  已用 {usedTurns} / {maxTurns} 轮
                </span>
              </div>

              <div className="h-1.5 overflow-hidden rounded-full bg-[#EFEFF3] dark:bg-white/10">
                <div
                  style={{ width: `${String(ratio * 100)}%` }}
                  className={cn(
                    "h-full rounded-full transition-all duration-300",
                    isPaused ? "bg-[#D99B26]" : "bg-[#141414] dark:bg-[#F5F5F7]",
                  )}
                />
              </div>

              <div className="flex items-center gap-2 pt-0.5">
                <div className="min-w-0 flex-1">
                  <AppSelect
                    id="gov-bar-turn-cap"
                    ariaLabel="连续 Agent 轮次上限"
                    size="sm"
                    align="end"
                    disabled={props.isUpdatingGovernance}
                    value={String(maxTurns)}
                    onValueChange={handleTurnCapChange}
                    options={turnCapOptions}
                  />
                </div>
                {isPaused ? (
                  <AppButton
                    variant="primary"
                    size="sm"
                    isLoading={props.isUpdatingGovernance}
                    leadingIcon={<Play className="h-3 w-3 fill-current" />}
                    onClick={handleRenewBudget}
                  >
                    续期
                  </AppButton>
                ) : null}
              </div>
            </div>

            {/* 唤醒与防抢话护栏开关 */}
            <div className="space-y-2.5 border-t border-black/[0.06] pt-3 dark:border-white/[0.08]">
              <div className="flex items-center justify-between gap-3">
                <label
                  htmlFor="gov-bar-agent-mentions"
                  className="flex min-w-0 flex-1 cursor-pointer items-start gap-2"
                >
                  {config.allowAgentMentions ? (
                    <AtSign className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#34C759]" />
                  ) : (
                    <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#FF3B30]" />
                  )}
                  <span className="min-w-0">
                    <span className="block font-medium text-[#141414] dark:text-zinc-100">
                      Agent 互相 @ 自动唤醒
                    </span>
                    <span className="block text-[10.5px] text-[#6E6E73] dark:text-zinc-400">
                      关闭后仅人类点名可唤醒 Agent
                    </span>
                  </span>
                </label>
                <AppSwitch
                  id="gov-bar-agent-mentions"
                  size="sm"
                  checked={config.allowAgentMentions}
                  disabled={props.isUpdatingGovernance}
                  onCheckedChange={handleToggleAgentMentions}
                />
              </div>

              <div className="flex items-center justify-between gap-3">
                <label
                  htmlFor="gov-bar-read-lock"
                  className="flex min-w-0 flex-1 cursor-pointer items-start gap-2"
                >
                  <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#5F5F64] dark:text-zinc-400" />
                  <span className="min-w-0">
                    <span className="block font-medium text-[#141414] dark:text-zinc-100">
                      先读后发保护
                    </span>
                    <span className="block text-[10.5px] text-[#6E6E73] dark:text-zinc-400">
                      拦截未读最新消息的盲目抢话
                    </span>
                  </span>
                </label>
                <AppSwitch
                  id="gov-bar-read-lock"
                  size="sm"
                  checked={config.requireReadBeforeSend}
                  disabled={props.isUpdatingGovernance}
                  onCheckedChange={handleToggleReadLock}
                />
              </div>
            </div>

            {config.mode === "round_table" ? (
              <p className="rounded-xl bg-[#F5F5F7] px-2.5 py-1.5 text-[11px] font-medium text-[#3A3A3C] dark:bg-white/[0.06] dark:text-zinc-300">
                本轮圆桌已发言：{governance.roundTableSpokenAgentIds.length} / {agents.length} 个
                Agent
              </p>
            ) : null}
          </AppPopover>

          {/* 3. `提案 · N` 胶囊（无提案时仍作为克制的入口胶囊触发提案抽屉） */}
          <AppTooltip side="bottom" content="查看共识提案与拍板记录">
            <button
              type="button"
              onClick={props.onOpenProposals}
              className={cn(
                HEADER_PILL_BASE_CLASS,
                visibleProposalBadgeCount > 0 ? "px-3 sm:px-3.5" : "px-2.5 sm:px-3.5",
                HEADER_PILL_NEUTRAL_CLASS,
              )}
            >
              <FileText className="h-3.5 w-3.5 shrink-0 text-[#5F5F64] sm:hidden dark:text-zinc-400" />
              <span className="hidden sm:inline">
                {visibleProposalBadgeCount > 0
                  ? `提案 · ${String(visibleProposalBadgeCount)}`
                  : "提案"}
              </span>
              {visibleProposalBadgeCount > 0 ? (
                <span className="tabular-nums sm:hidden">{visibleProposalBadgeCount}</span>
              ) : null}
              {props.openProposalsCount > 0 ? (
                <span
                  aria-label="有待拍板提案"
                  className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#D99B26] dark:bg-[#E5B34B]"
                />
              ) : null}
            </button>
          </AppTooltip>

          {/* 4. `+ 邀请` 胶囊 */}
          <AppTooltip side="bottom" content="邀请朋友或把你的 Agent 拉进群">
            <button
              type="button"
              onClick={props.onOpenAddAgentModal}
              className={cn(HEADER_PILL_BASE_CLASS, "px-3 sm:px-3.5", HEADER_PILL_NEUTRAL_CLASS)}
            >
              <Plus className="h-3.5 w-3.5 shrink-0 stroke-[2.2]" />
              <span className="hidden sm:inline">邀请</span>
            </button>
          </AppTooltip>
        </div>
      </div>

      {/* 按需平滑展开的副横幅（预算挂起检查点 / 最新拍板结论） */}
      <AnimatePresence initial={false}>
        {isPaused ? (
          <motion.div
            key="banner-paused"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
            className="overflow-hidden border-t border-[#D99B26]/20 bg-[#FFF8E6] dark:border-[#E5B34B]/20 dark:bg-[#241F14]"
          >
            <div className="flex items-center justify-between gap-3 px-4 py-2 text-xs text-[#5C4813] sm:px-6 dark:text-[#F2DF9D]">
              <div className="flex min-w-0 items-center gap-2">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-[#D99B26] dark:text-[#E5B34B]" />
                <span className="truncate">
                  <strong>Agent 已连续讨论 {usedTurns} 轮，暂停等待你的意见</strong>
                  <span className="hidden opacity-80 sm:inline">
                    {" "}
                    · 直接发言会自动继续，也可以点击右侧续期
                  </span>
                </span>
              </div>
              <AppButton
                variant="primary"
                size="xs"
                isLoading={props.isUpdatingGovernance}
                leadingIcon={<Play className="h-3 w-3 fill-current" />}
                onClick={handleRenewBudget}
              >
                继续讨论 (+{maxTurns})
              </AppButton>
            </div>
          </motion.div>
        ) : showDecided ? (
          <motion.div
            key="banner-decided"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
            className="overflow-hidden border-t border-black/[0.05] bg-[#E3F3EC] dark:border-white/[0.06] dark:bg-[#16271F]"
          >
            <div className="flex items-center justify-between gap-3 px-4 py-2 text-xs text-[#1B452D] sm:px-6 dark:text-[#C7E8D3]">
              <button
                type="button"
                onClick={props.onOpenProposals}
                className="app-no-drag flex min-w-0 cursor-pointer items-center gap-2 text-left transition hover:opacity-85"
              >
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-[#215236] dark:text-[#86E0A6]" />
                <span className="truncate">
                  <strong>已拍板：</strong>
                  {props.decidedProposalTitle}
                </span>
              </button>
              <IconButton
                size="xs"
                variant="ghost"
                label="关闭已拍板提示"
                onClick={() => setDismissedDecision(props.decidedProposalTitle)}
                className="text-[#215236]/75 hover:bg-black/[0.05] dark:text-[#C7E8D3]/80 dark:hover:bg-white/[0.08]"
              >
                <X className="h-3.5 w-3.5" />
              </IconButton>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </header>
  );
}
