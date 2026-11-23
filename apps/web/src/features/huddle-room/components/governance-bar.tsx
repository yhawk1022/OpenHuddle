/**
 * @module web/features/huddle-room/governance-bar
 * @description Apple Liquid Glass 悬浮双岛群聊顶栏（Spatial Floating Header Islands）：
 * 左侧为圆润液态玻璃群标题胶囊（移动端返回键、`15.5px` 群名称与 `11.5px` 议题/可见性副标题），
 * 右侧为同心圆角液态玻璃控制胶囊（成员抽屉开关、`轮次 X/Y` Radix 治理浮层、`提案 · N` 与 `+ 邀请`）；
 * 两岛之间保留通透呼吸留白，消息流从下方滑过时透过 `liquid-glass-bar` 产生真实光学折射。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 严格不嵌套重度模糊：外层胶囊挂载 `relative liquid-glass-bar`（含 135° 菲涅尔高光边框），内部子胶囊仅使用轻触态半透色阶，杜绝多层 `backdrop-filter` 叠加。
 * 2. 异常才提醒：平时 `轮次 X/Y` 保持安静中性；仅当 `status === "paused_budget"` 需要人类续期，或存在刚拍板通过的结论时，才在双岛下方展开独立悬浮玻璃横幅。
 * 3. Tauri v2 & Electron 双端无边框拖拽就绪：顶栏与玻璃岛标记 `data-tauri-drag-region` 与 `.app-drag-region`，交互按钮均带 `.app-no-drag`，且外层对空白处保持 `pointer-events-none` 以允许下方消息流自由滚动。
 */
import type {
  GovernanceMode,
  RoomDetailDto,
  RoomGovernanceState,
  UpdateGovernanceBody,
  UserId,
} from "@openhuddle/protocol";
import {
  AlertTriangle,
  AtSign,
  Bot,
  CheckCircle2,
  ChevronLeft,
  FileText,
  Lock,
  Play,
  Plus,
  ShieldAlert,
  UserRound,
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
import { getReachVisualMeta } from "../../../lib/format.js";

/** `GovernanceBar` 入参属性 */
export interface GovernanceBarProps {
  readonly room: RoomDetailDto;
  readonly currentUserId?: UserId | undefined;
  readonly governance: RoomGovernanceState;
  readonly proposalsCount: number;
  readonly openProposalsCount: number;
  /** 最近一次已拍板通过的提案标题；为 `null` 时不展示「已拍板」结论条 */
  readonly decidedProposalTitle: string | null;
  readonly isUpdatingGovernance: boolean;
  readonly isInspectorOpen: boolean;
  readonly onUpdateGovernance: (patch: UpdateGovernanceBody) => void;
  readonly onOpenAddAgentModal: () => void;
  /** 点击群聊顶栏「+ 邀请」时打开拉好友/本人 Agent 弹窗（缺省回退至 `onOpenAddAgentModal`） */
  readonly onOpenInviteModal?: (() => void) | undefined;
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

/** 右侧控制胶囊内部子按钮基础类名（与外层 `h-12 p-1.5 rounded-full` 构成精确同心圆角） */
const CONTROL_ITEM_BASE_CLASS =
  "app-no-drag inline-flex h-9 shrink-0 cursor-pointer select-none items-center gap-1.5 rounded-full px-3 text-[12.5px] font-medium transition-colors active:scale-[0.97]";

const CONTROL_ITEM_NEUTRAL_CLASS =
  "text-[#181B22] hover:bg-black/[0.055] dark:text-[#ECECEF] dark:hover:bg-white/[0.09]";

const CONTROL_ITEM_ACTIVE_CLASS =
  "bg-black/[0.08] text-[#111318] shadow-[inset_0_1px_0_rgba(255,255,255,0.5)] dark:bg-white/[0.14] dark:text-white dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.12)]";

/**
 * 渲染悬浮双岛 Apple Liquid Glass 群聊顶栏、Radix 治理配置浮层及按需展开的预算检查点/拍板横幅。
 *
 * @param props - 房间详情、实时治理快照、抽屉开关状态与各项治理回调
 * @returns 顶部悬浮液态玻璃群聊头组件
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
    props.room.kind !== "direct_human" &&
    !isPaused &&
    props.decidedProposalTitle !== null &&
    props.openProposalsCount === 0 &&
    dismissedDecision !== props.decidedProposalTitle;

  const isGroupRoom = props.room.kind === "group";
  const isDirectAgent = props.room.kind === "direct_agent";
  const isDirectHuman = props.room.kind === "direct_human";
  const peer = props.room.peer;

  const subtitleText = useMemo(() => {
    if (isDirectHuman) {
      if (peer?.kind === "human" && peer.email !== undefined && peer.email.length > 0) {
        return `好友私聊 · ${peer.email}`;
      }
      return "好友 1v1 私聊";
    }
    if (isDirectAgent) {
      if (peer?.kind === "agent") {
        const reachLabel = getReachVisualMeta(peer.reach).shortLabel;
        const isMyAgent =
          props.currentUserId !== undefined && peer.ownerUserId === props.currentUserId;
        return isMyAgent
          ? `我的个人 Agent · ${reachLabel}`
          : `${peer.ownerDisplayName} 共享的 Agent · ${reachLabel}`;
      }
      return "Agent 1v1 单聊";
    }
    if (props.room.topic.length > 0) {
      return props.room.topic;
    }
    return props.room.visibility === "public_shareable" ? "公开只读可分享" : "仅限邀请加入";
  }, [
    isDirectAgent,
    isDirectHuman,
    peer,
    props.currentUserId,
    props.room.topic,
    props.room.visibility,
  ]);

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
    <header className="pointer-events-none relative z-20 shrink-0 select-none">
      <div className="flex items-center justify-between gap-2 sm:gap-3">
        {/* 左岛：修长单基线液态玻璃群标题胶囊（杜绝短文本时挤成粗短椭圆球） */}
        <div
          data-tauri-drag-region=""
          className="app-drag-region pointer-events-auto relative liquid-glass-bar flex h-11 min-w-0 flex-1 items-center gap-2 rounded-full pr-4 pl-2.5 sm:max-w-[min(32rem,58%)] sm:flex-initial sm:px-4"
        >
          <IconButton
            variant="ghost"
            size="sm"
            label="返回会话列表"
            onClick={props.onBackToList}
            className="-ml-0.5 shrink-0 text-[#111318] md:hidden dark:text-[#F2F2F4]"
          >
            <ChevronLeft className="h-5 w-5" />
          </IconButton>

          <div className="flex min-w-0 flex-1 items-baseline gap-2">
            <h1 className="shrink-0 max-w-[14rem] truncate text-[14.5px] font-semibold tracking-[-0.015em] text-[#111318] sm:max-w-[18rem] sm:text-[15px] dark:text-[#F2F2F4]">
              {props.room.name}
            </h1>
            <span
              aria-hidden="true"
              className="hidden shrink-0 text-[12px] text-[#939BAD] sm:inline dark:text-[#63636B]"
            >
              ·
            </span>
            <p className="hidden min-w-0 flex-1 truncate text-[12.5px] text-[#687082] sm:block dark:text-[#8E8E96]">
              {subtitleText}
            </p>
          </div>
        </div>

        {/* 右岛：44px 同心圆角液态玻璃控制胶囊组（内距 4px 包裹 36px 按钮） */}
        <div
          data-tauri-drag-region=""
          className="app-drag-region pointer-events-auto relative liquid-glass-bar flex h-11 shrink-0 items-center gap-0.5 rounded-full p-1 sm:gap-1"
        >
          {/* 1. 成员/对方信息面板开关按钮 */}
          <AppTooltip
            side="bottom"
            content={
              props.isInspectorOpen
                ? "收起会话信息面板"
                : isDirectHuman
                  ? "查看好友会话信息"
                  : isDirectAgent
                    ? "查看 Agent 详情与会话设置"
                    : `${String(onlineAgents)} 个 Agent 在线 · 点击展开群成员面板`
            }
          >
            <button
              type="button"
              aria-pressed={props.isInspectorOpen}
              onClick={props.onToggleInspector}
              className={cn(
                CONTROL_ITEM_BASE_CLASS,
                "px-2.5 sm:px-3",
                props.isInspectorOpen ? CONTROL_ITEM_ACTIVE_CLASS : CONTROL_ITEM_NEUTRAL_CLASS,
              )}
            >
              {isDirectHuman ? (
                <>
                  <UserRound className="h-3.5 w-3.5 shrink-0 text-[#687082] dark:text-[#9B9BA3]" />
                  <span className="hidden sm:inline">会话信息</span>
                </>
              ) : isDirectAgent ? (
                <>
                  <Bot className="h-3.5 w-3.5 shrink-0 text-[#687082] dark:text-[#9B9BA3]" />
                  <span className="hidden sm:inline">Agent 详情</span>
                </>
              ) : (
                <>
                  <Users className="h-3.5 w-3.5 shrink-0 text-[#687082] dark:text-[#9B9BA3]" />
                  <span className="hidden lg:inline">
                    {agents.length} 个 agent · {humanCount} 人
                  </span>
                  <span className="tabular-nums lg:hidden">{props.room.members.length}</span>
                </>
              )}
            </button>
          </AppTooltip>

          {/* 2. `轮次 X/Y` 治理按钮（群聊与 Agent 单聊展示；人类 1v1 私聊隐藏） */}
          {!isDirectHuman ? (
            <AppPopover
              open={governanceOpen}
              onOpenChange={setGovernanceOpen}
              side="bottom"
              align="end"
              className="w-80 space-y-3.5 p-4 text-xs"
              trigger={
                <button
                  type="button"
                  aria-label="讨论轮次与会话规则设置"
                  className={cn(
                    CONTROL_ITEM_BASE_CLASS,
                    "px-2.5 sm:px-3",
                    isPaused
                      ? "bg-amber-500/16 text-[#78350F] ring-1 ring-inset ring-amber-500/35 hover:bg-amber-500/24 dark:bg-amber-400/16 dark:text-[#FCD34D] dark:ring-amber-400/30 dark:hover:bg-amber-400/24"
                      : governanceOpen
                        ? CONTROL_ITEM_ACTIVE_CLASS
                        : CONTROL_ITEM_NEUTRAL_CLASS,
                  )}
                >
                  {isPaused ? (
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#D97706] dark:bg-[#FBBF24]" />
                  ) : null}
                  <span className="tabular-nums">
                    <span className="hidden sm:inline">轮次 </span>
                    {usedTurns}/{maxTurns}
                  </span>
                </button>
              }
            >
              {/* 讨论模式分段器（仅多 Agent 群聊展示） */}
              {isGroupRoom ? (
                <div>
                  <div className="mb-1.5 flex items-center justify-between">
                    <span className="text-[11.5px] font-semibold text-[#687082] dark:text-[#8E8E96]">
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
              ) : null}

              {/* 连续 Agent 轮次预算与 Radix AppSelect */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-[11.5px] font-semibold text-[#687082] dark:text-[#8E8E96]">
                    连续 Agent 发言上限
                  </span>
                  <span
                    className={cn(
                      "font-mono text-[11px] font-semibold tabular-nums",
                      isPaused
                        ? "text-[#9A6700] dark:text-[#FCD34D]"
                        : "text-[#111318] dark:text-[#ECECEF]",
                    )}
                  >
                    已用 {usedTurns} / {maxTurns} 轮
                  </span>
                </div>

                <div className="h-1.5 overflow-hidden rounded-full bg-black/[0.06] dark:bg-white/[0.09]">
                  <div
                    style={{ width: `${String(ratio * 100)}%` }}
                    className={cn(
                      "h-full rounded-full transition-all duration-300",
                      isPaused
                        ? "bg-[#D97706] dark:bg-[#FBBF24]"
                        : "bg-[#181B22] dark:bg-[#EAEEF6]",
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
                {isGroupRoom ? (
                  <div className="flex items-center justify-between gap-3">
                    <label
                      htmlFor="gov-bar-agent-mentions"
                      className="flex min-w-0 flex-1 cursor-pointer items-start gap-2"
                    >
                      {config.allowAgentMentions ? (
                        <AtSign className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#16A34A] dark:text-[#34D399]" />
                      ) : (
                        <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#E5484D] dark:text-[#F87171]" />
                      )}
                      <span className="min-w-0">
                        <span className="block font-medium text-[#111318] dark:text-[#F2F2F4]">
                          Agent 互相 @ 自动唤醒
                        </span>
                        <span className="block text-[10.5px] text-[#687082] dark:text-[#8E8E96]">
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
                ) : null}

                <div className="flex items-center justify-between gap-3">
                  <label
                    htmlFor="gov-bar-read-lock"
                    className="flex min-w-0 flex-1 cursor-pointer items-start gap-2"
                  >
                    <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#687082] dark:text-[#8E8E96]" />
                    <span className="min-w-0">
                      <span className="block font-medium text-[#111318] dark:text-[#F2F2F4]">
                        先读后发保护
                      </span>
                      <span className="block text-[10.5px] text-[#687082] dark:text-[#8E8E96]">
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

              {isGroupRoom && config.mode === "round_table" ? (
                <p className="rounded-xl bg-black/[0.04] px-2.5 py-1.5 text-[11px] font-medium text-[#3B414E] dark:bg-white/[0.06] dark:text-[#C4C4CA]">
                  本轮圆桌已发言：{governance.roundTableSpokenAgentIds.length} / {agents.length} 个
                  Agent
                </p>
              ) : null}
            </AppPopover>
          ) : null}

          {/* 3. `提案 · N` 按钮（群聊与 Agent 单聊支持整理方案；纯人类私聊不展示） */}
          {!isDirectHuman ? (
            <AppTooltip side="bottom" content="查看共识提案与拍板记录">
              <button
                type="button"
                onClick={props.onOpenProposals}
                className={cn(
                  CONTROL_ITEM_BASE_CLASS,
                  visibleProposalBadgeCount > 0 ? "px-2.5 sm:px-3" : "px-2.5",
                  CONTROL_ITEM_NEUTRAL_CLASS,
                )}
              >
                <FileText className="h-3.5 w-3.5 shrink-0 text-[#687082] sm:hidden dark:text-[#9B9BA3]" />
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
                    className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#D97706] dark:bg-[#FBBF24]"
                  />
                ) : null}
              </button>
            </AppTooltip>
          ) : null}

          {/* 4. `+ 邀请` 高对比主触点胶囊（仅群聊展示） */}
          {isGroupRoom ? (
            <AppTooltip side="bottom" content="把好友或你的 Agent 拉进群">
              <button
                type="button"
                onClick={props.onOpenInviteModal ?? props.onOpenAddAgentModal}
                className={cn(
                  CONTROL_ITEM_BASE_CLASS,
                  "bg-black/[0.06] px-2.5 text-[#111318] hover:bg-black/[0.10] sm:px-3.5 dark:bg-white/[0.09] dark:text-[#F2F2F4] dark:hover:bg-white/[0.15]",
                )}
              >
                <Plus className="h-3.5 w-3.5 shrink-0 stroke-[2.2]" />
                <span className="hidden sm:inline">邀请</span>
              </button>
            </AppTooltip>
          ) : null}
        </div>
      </div>

      {/* 按需平滑展开的悬浮液态玻璃副横幅（预算挂起检查点 / 最新拍板结论） */}
      <AnimatePresence initial={false}>
        {isPaused ? (
          <motion.div
            key="banner-paused"
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
            className="pointer-events-auto relative liquid-glass-bar mx-auto mt-2 max-w-3xl overflow-hidden rounded-[18px]"
          >
            <div className="flex items-center justify-between gap-3 bg-amber-500/[0.08] px-3.5 py-2 text-xs text-[#6B4E12] sm:px-4 dark:bg-amber-400/[0.08] dark:text-[#F5DF9D]">
              <div className="flex min-w-0 items-center gap-2">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-[#D97706] dark:text-[#FBBF24]" />
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
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
            className="pointer-events-auto relative liquid-glass-bar mx-auto mt-2 max-w-3xl overflow-hidden rounded-[18px]"
          >
            <div className="flex items-center justify-between gap-3 bg-emerald-500/[0.08] px-3.5 py-2 text-xs text-[#145335] sm:px-4 dark:bg-emerald-400/[0.08] dark:text-[#A7F3D0]">
              <button
                type="button"
                onClick={props.onOpenProposals}
                className="app-no-drag flex min-w-0 cursor-pointer items-center gap-2 text-left transition hover:opacity-85"
              >
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-[#16A34A] dark:text-[#34D399]" />
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
                className="text-[#145335]/75 hover:bg-black/[0.05] dark:text-[#A7F3D0]/80 dark:hover:bg-white/[0.08]"
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
