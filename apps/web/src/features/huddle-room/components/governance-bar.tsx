/**
 * @module web/features/huddle-room/governance-bar
 * @description 房间顶部人类裁判治理胶囊栏（模式切换、Turn Budget 轮次计量表、Agent 互 `@` 熔断开关与预算挂起一键续期横幅）。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 超越 Pachat 的核心差异化控制台：将服务端 `RoomGovernanceState` 实时转化为一眼可读的进度刻度与一键熔断开关。
 * 2. 挂起态强提醒：当 `status === "paused_budget"` 时在顶部呈现醒目的琥珀色检查点横幅，支持人类一键 `+ Renew Turn Budget` 恢复自动唤醒链。
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
  Bot,
  Hash,
  Lock,
  Menu,
  PanelRightOpen,
  Play,
  ShieldAlert,
  Sparkles,
  Users,
} from "lucide-react";

/** `GovernanceBar` 入参属性 */
export interface GovernanceBarProps {
  readonly room: RoomDetailDto;
  readonly governance: RoomGovernanceState;
  readonly proposalsCount: number;
  readonly openProposalsCount: number;
  readonly isUpdatingGovernance: boolean;
  readonly onUpdateGovernance: (patch: UpdateGovernanceBody) => void;
  readonly onOpenAddAgentModal: () => void;
  readonly onOpenMobileSidebar: () => void;
  readonly onToggleMobileInspector: () => void;
}

const MODE_OPTIONS: ReadonlyArray<{ readonly value: GovernanceMode; readonly label: string }> = [
  { value: "free", label: "Free 自由" },
  { value: "round_table", label: "Round Table 圆桌" },
  { value: "proposal", label: "Proposal 提案" },
];

/**
 * 渲染房间头部信息栏、内联治理胶囊及 `paused_budget` 挂起续期横幅。
 *
 * @param props - 房间详情、实时治理快照与裁判变更回调
 * @returns 顶部治理控制台组件
 */
export function GovernanceBar(props: GovernanceBarProps) {
  const { governance } = props;
  const { config } = governance;
  const usedTurns = governance.consecutiveAgentTurns;
  const maxTurns = config.maxConsecutiveAgentTurns;
  const ratio = maxTurns > 0 ? Math.min(1, usedTurns / maxTurns) : 0;
  const isPaused = governance.status === "paused_budget";

  const meterFillClass = isPaused
    ? "bg-amber-500"
    : ratio >= 0.75
      ? "bg-amber-500"
      : "bg-emerald-500";

  return (
    <header className="shrink-0 border-b border-slate-200/85 bg-white/90 backdrop-blur-md dark:border-white/[0.07] dark:bg-[#0d1018]/90">
      {/* 第一行：房间标题、议题摘要与「拉入 Agent / 右栏抽屉」快捷按钮 */}
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <button
            type="button"
            onClick={props.onOpenMobileSidebar}
            aria-label="展开房间列表"
            className="rounded-lg border border-slate-200 p-1.5 text-slate-600 lg:hidden dark:border-white/10 dark:text-slate-300"
          >
            <Menu className="h-4 w-4" />
          </button>

          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Hash className="h-4 w-4 shrink-0 text-indigo-500" />
              <h1 className="truncate text-[15px] font-bold tracking-tight text-slate-900 dark:text-white">
                {props.room.name}
              </h1>
              <span className="rounded-md bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-500 dark:bg-white/[0.06] dark:text-slate-400">
                #{props.room.lastSeq}
              </span>
            </div>
            {props.room.topic.length > 0 ? (
              <p className="mt-0.5 truncate text-xs text-slate-500 dark:text-slate-400">
                {props.room.topic}
              </p>
            ) : null}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={props.onOpenAddAgentModal}
            className="inline-flex items-center gap-1.5 rounded-xl bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white shadow-2xs transition hover:bg-indigo-500"
          >
            <Bot className="h-3.5 w-3.5" />
            <span>+ 拉入 Agent / 邀请</span>
          </button>

          <button
            type="button"
            onClick={props.onToggleMobileInspector}
            className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 xl:hidden dark:border-white/10 dark:bg-white/[0.04] dark:text-slate-200"
          >
            <PanelRightOpen className="h-3.5 w-3.5 text-indigo-500" />
            <span>成员 {props.room.members.length}</span>
            {props.openProposalsCount > 0 ? (
              <span className="rounded-full bg-amber-500 px-1.5 py-0.2 text-[10px] font-bold text-white">
                {props.openProposalsCount} 待拍板
              </span>
            ) : (
              <span className="text-slate-400">· 提案 {props.proposalsCount}</span>
            )}
          </button>
        </div>
      </div>

      {/* 第二行：紧凑型裁判治理控制胶囊条（Mode / Turn Budget Meter / 互 @ 熔断 / 防抢话读锁） */}
      <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 bg-slate-50/70 px-4 py-2 text-xs dark:border-white/[0.05] dark:bg-white/[0.015]">
        {/* 1. 讨论模式切换器 */}
        <div className="inline-flex items-center rounded-xl border border-slate-200/90 bg-white p-0.5 dark:border-white/10 dark:bg-[#090c13]">
          {MODE_OPTIONS.map((opt) => {
            const active = config.mode === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                disabled={props.isUpdatingGovernance}
                onClick={() => {
                  if (!active) {
                    props.onUpdateGovernance({ mode: opt.value });
                  }
                }}
                className={`rounded-lg px-2.5 py-1 text-[11px] font-semibold transition ${
                  active
                    ? "bg-indigo-600 text-white shadow-2xs"
                    : "text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white"
                }`}
              >
                {opt.label}
              </button>
            );
          })}
        </div>

        {/* 2. Turn Budget 连续 Agent 轮次可视化计量表 */}
        <div className="inline-flex items-center gap-2 rounded-xl border border-slate-200/90 bg-white px-2.5 py-1 dark:border-white/10 dark:bg-[#090c13]">
          <span className="text-[11px] font-medium text-slate-500 dark:text-slate-400">
            Turn Budget
          </span>
          <div className="h-2 w-20 overflow-hidden rounded-full bg-slate-200 dark:bg-white/10">
            <div
              style={{ width: `${String(ratio * 100)}%` }}
              className={`h-full transition-all duration-300 ${meterFillClass}`}
            />
          </div>
          <span
            className={`font-mono text-[11px] font-bold ${
              isPaused ? "text-amber-600 dark:text-amber-400" : "text-slate-800 dark:text-slate-200"
            }`}
          >
            {usedTurns}/{maxTurns}
          </span>
          <select
            aria-label="调整最大连续 Agent 轮次预算"
            disabled={props.isUpdatingGovernance}
            value={String(maxTurns)}
            onChange={(e) =>
              props.onUpdateGovernance({ maxConsecutiveAgentTurns: Number(e.target.value) })
            }
            className="rounded border border-slate-200/80 bg-transparent px-1 py-0.5 font-mono text-[10.5px] text-slate-600 focus:outline-none dark:border-white/10 dark:text-slate-300"
          >
            {[3, 4, 6, 8, 10, 15, 25].map((cap) => (
              <option key={cap} value={String(cap)} className="bg-white dark:bg-slate-900">
                上限 {cap}
              </option>
            ))}
          </select>
        </div>

        {/* 3. 一键 Agent 互 @ 唤醒熔断器 */}
        <button
          type="button"
          disabled={props.isUpdatingGovernance}
          onClick={() =>
            props.onUpdateGovernance({ allowAgentMentions: !config.allowAgentMentions })
          }
          title={
            config.allowAgentMentions
              ? "当前允许 Agent 之间互相 @ 触发唤醒；点击可立即熔断互 @ 链"
              : "已开启互 @ 熔断保护：仅人类发言可触发自动唤醒；点击可恢复互 @"
          }
          className={`inline-flex items-center gap-1.5 rounded-xl border px-2.5 py-1 text-[11px] font-semibold transition ${
            config.allowAgentMentions
              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/18 dark:text-emerald-300"
              : "border-rose-500/35 bg-rose-500/12 text-rose-700 hover:bg-rose-500/20 dark:text-rose-300"
          }`}
        >
          {config.allowAgentMentions ? (
            <>
              <AtSign className="h-3 w-3" />
              <span>Agent 互 @ 唤醒：开启</span>
            </>
          ) : (
            <>
              <ShieldAlert className="h-3 w-3" />
              <span>Agent 互 @ 已熔断</span>
            </>
          )}
        </button>

        {/* 4. 乐观防抢话读锁开关 */}
        <button
          type="button"
          disabled={props.isUpdatingGovernance}
          onClick={() =>
            props.onUpdateGovernance({ requireReadBeforeSend: !config.requireReadBeforeSend })
          }
          title="开启后，Agent 若未读取最新 seq 消息即盲目抢话将被 409 拦截并要求补读增量"
          className={`inline-flex items-center gap-1 rounded-xl border px-2.5 py-1 text-[11px] font-medium transition ${
            config.requireReadBeforeSend
              ? "border-indigo-500/30 bg-indigo-500/10 text-indigo-700 dark:text-indigo-300"
              : "border-slate-200 bg-white text-slate-500 dark:border-white/10 dark:bg-transparent dark:text-slate-400"
          }`}
        >
          <Lock className="h-3 w-3" />
          <span>防抢话读锁：{config.requireReadBeforeSend ? "开" : "关"}</span>
        </button>

        {/* 圆桌模式进度提示 */}
        {config.mode === "round_table" ? (
          <span className="inline-flex items-center gap-1 rounded-xl border border-violet-500/30 bg-violet-500/10 px-2.5 py-1 text-[11px] font-medium text-violet-700 dark:text-violet-300">
            <Users className="h-3 w-3" />
            <span>本轮圆桌已表态：{governance.roundTableSpokenAgentIds.length} 位 Agent</span>
          </span>
        ) : null}

        {config.mode === "proposal" ? (
          <span className="inline-flex items-center gap-1 rounded-xl border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-[11px] font-medium text-amber-700 dark:text-amber-300">
            <Sparkles className="h-3 w-3" />
            <span>提案收敛模式已激活</span>
          </span>
        ) : null}
      </div>

      {/* 第三行：当触达连续 Agent 发言预算上限（paused_budget）时的醒目琥珀色横幅与一键续期按钮 */}
      {isPaused ? (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-amber-500/35 bg-amber-500/15 px-4 py-2.5 text-xs text-amber-950 dark:bg-amber-500/18 dark:text-amber-100">
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
            <span>
              <strong>防死循环预算检查点已触发：</strong>群内 Agent 已连续自动发言{" "}
              <code className="font-mono font-bold">{usedTurns}</code>{" "}
              轮，自动唤醒链已安全挂起。你可以直接发言插话重置计数，或一键续期预算继续讨论：
            </span>
          </div>

          <button
            type="button"
            disabled={props.isUpdatingGovernance}
            onClick={() => props.onUpdateGovernance({ renewBudget: true })}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-xl bg-amber-500 px-3.5 py-1.5 text-xs font-bold text-slate-950 shadow-xs transition hover:bg-amber-400 disabled:opacity-50"
          >
            <Play className="h-3.5 w-3.5 fill-current" />
            <span>+ Renew Turn Budget (继续 +{maxTurns} 轮)</span>
          </button>
        </div>
      ) : null}
    </header>
  );
}
