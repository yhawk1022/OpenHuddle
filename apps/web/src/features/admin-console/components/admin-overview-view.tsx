/**
 * @module web/features/admin-console/overview-view
 * @description 运营与治理管理后台核心数据统计大盘视图（KPI 总览、多日趋势图、平台/治理分布、Top 活跃排行与运行态遥测）。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 下钻联动：点击任意 KPI 卡或 Top 排行条目，可直接跳转至对应管理模块或直接定位详情抽屉。
 * 2. 四态完备：加载骨架、错误重试、空榜单与正常态严格覆盖。
 */
import type { RoomId, UserId } from "@openhuddle/protocol";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  ArrowRight,
  Bot,
  CheckSquare,
  Cpu,
  Database,
  FileClock,
  KeyRound,
  MessageSquare,
  MessagesSquare,
  Radio,
  Users,
} from "lucide-react";
import { useState } from "react";
import {
  AppButton,
  type SegmentedTabItem,
  SegmentedTabs,
} from "../../../components/primitives/index.js";
import { adminOverviewQueryOptions } from "../api/admin-console.queries.js";
import { AdminBreakdownCard, AdminTrendChartCard } from "./admin-charts.js";
import {
  AdminErrorState,
  AdminStatCard,
  AdminStatusPill,
  formatAdminDateTime,
  formatUptimeDuration,
} from "./admin-shared-ui.js";

/** 大盘下钻目标导航键 */
export type AdminNavSection =
  | "overview"
  | "users"
  | "sessions"
  | "rooms"
  | "agents"
  | "proposals"
  | "pairing-codes"
  | "audit-logs";

type WindowPreset = "7" | "14" | "30";

const WINDOW_TABS: ReadonlyArray<SegmentedTabItem<WindowPreset>> = [
  { value: "7", label: "近 7 天" },
  { value: "14", label: "近 14 天" },
  { value: "30", label: "近 30 天" },
];

const REACH_ACCENT_MAP: Readonly<Record<string, string>> = {
  online_sse: "bg-[#16A34A] dark:bg-[#34D399]",
  hosted_ready: "bg-[#16A34A]/80 dark:bg-[#34D399]/80",
  webhook: "bg-[#2563EB] dark:bg-[#60A5FA]",
  polling: "bg-[#D97706] dark:bg-[#FBBF24]",
  offline: "bg-[#939BAD] dark:bg-[#586075]",
};

const GOVERNANCE_ACCENT_MAP: Readonly<Record<string, string>> = {
  free: "bg-[#181B22] dark:bg-[#ECEFF6]",
  round_table: "bg-[#2563EB] dark:bg-[#60A5FA]",
  proposal: "bg-[#16A34A] dark:bg-[#34D399]",
};

/** `AdminOverviewView` 入参属性 */
export interface AdminOverviewViewProps {
  readonly onNavigateSection: (section: AdminNavSection) => void;
  readonly onInspectUser: (userId: UserId) => void;
  readonly onInspectRoom: (roomId: RoomId) => void;
}

/**
 * 渲染后台运营数据统计大盘。
 */
export function AdminOverviewView(props: AdminOverviewViewProps) {
  const [windowPreset, setWindowPreset] = useState<WindowPreset>("14");
  const windowDays = Number(windowPreset);
  const overviewQuery = useQuery(adminOverviewQueryOptions(windowDays));

  if (overviewQuery.isPending) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3, 4, 5, 6].map((idx) => (
            <div
              key={`kpi-sk-${String(idx)}`}
              className="oh-elevated-card h-28 animate-pulse rounded-2xl p-4"
            />
          ))}
        </div>
        <div className="oh-elevated-card h-72 animate-pulse rounded-2xl" />
      </div>
    );
  }

  if (overviewQuery.isError || !overviewQuery.data) {
    return (
      <AdminErrorState
        title="无法加载统计大盘"
        message={
          overviewQuery.error instanceof Error
            ? overviewQuery.error.message
            : "请检查网络或管理员权限后重试"
        }
        onRetry={() => void overviewQuery.refetch()}
      />
    );
  }

  const data = overviewQuery.data;
  const { kpis, runtime } = data;

  return (
    <div className="space-y-5">
      {/* 1. 运行态健康条与时间窗口切换 */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <AdminStatusPill tone="success" dotClass="bg-[#16A34A] dark:bg-[#34D399]">
            运行中 · {formatUptimeDuration(runtime.uptimeSec)}
          </AdminStatusPill>
          <AdminStatusPill tone="neutral">
            <Database className="mr-1 inline h-3 w-3" />
            {runtime.databaseDriver === "postgres" ? "PostgreSQL 16+" : "PGlite 嵌入式"}
          </AdminStatusPill>
          <AdminStatusPill tone="neutral">
            <Radio className="mr-1 inline h-3 w-3" />
            {runtime.realtimeBusDriver === "postgres" ? "PG LISTEN/NOTIFY" : "进程内实时总线"}
          </AdminStatusPill>
          <AdminStatusPill tone="info">
            <Activity className="mr-1 inline h-3 w-3" />
            实时连接 {runtime.activeAgentConnections} Agent / {runtime.activeRoomSubscriptions}{" "}
            房间订阅
          </AdminStatusPill>
        </div>

        <SegmentedTabs
          value={windowPreset}
          onValueChange={setWindowPreset}
          items={WINDOW_TABS}
          size="sm"
          ariaLabel="选择统计趋势时间范围"
        />
      </div>

      {/* 2. 六大核心 KPI 指标卡 */}
      <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 xl:grid-cols-3">
        <AdminStatCard
          label="注册人类账号"
          value={kpis.totalUsers}
          icon={<Users className="h-4 w-4" />}
          badge={
            kpis.suspendedUsers > 0 ? (
              <AdminStatusPill tone="danger">封禁 {kpis.suspendedUsers}</AdminStatusPill>
            ) : (
              <AdminStatusPill tone="success">近 7 天 +{kpis.newUsers7d}</AdminStatusPill>
            )
          }
          hint={`管理员 ${kpis.adminUsers} 名 · 点击管理账号`}
          onClick={() => props.onNavigateSection("users")}
        />

        <AdminStatCard
          label="Web 活跃登录会话"
          value={kpis.activeSessions}
          icon={<KeyRound className="h-4 w-4" />}
          badge={
            kpis.expiredSessions > 0 ? (
              <AdminStatusPill tone="warning">待清理 {kpis.expiredSessions}</AdminStatusPill>
            ) : (
              <AdminStatusPill tone="neutral">状态健康</AdminStatusPill>
            )
          }
          hint="支持实时查验与强制踢下线"
          onClick={() => props.onNavigateSection("sessions")}
        />

        <AdminStatCard
          label="已接入 Agent"
          value={kpis.totalAgents}
          icon={<Bot className="h-4 w-4" />}
          badge={
            <AdminStatusPill
              tone={kpis.onlineSseAgents > 0 ? "success" : "neutral"}
              dotClass={
                kpis.onlineSseAgents > 0
                  ? "bg-[#16A34A] dark:bg-[#34D399]"
                  : "bg-[#939BAD] dark:bg-[#586075]"
              }
            >
              SSE 在线 {kpis.onlineSseAgents}
            </AdminStatusPill>
          }
          hint="覆盖本地守护与云端托管智能体"
          onClick={() => props.onNavigateSection("agents")}
        />

        <AdminStatCard
          label="协作群聊房间"
          value={kpis.totalRooms}
          icon={<MessagesSquare className="h-4 w-4" />}
          badge={
            kpis.pausedBudgetRooms > 0 ? (
              <AdminStatusPill tone="warning">预算挂起 {kpis.pausedBudgetRooms}</AdminStatusPill>
            ) : (
              <AdminStatusPill tone="info">公开分享 {kpis.publicShareableRooms}</AdminStatusPill>
            )
          }
          hint="支持跨房内容审查、治理热调控与解散"
          onClick={() => props.onNavigateSection("rooms")}
        />

        <AdminStatCard
          label="累计消息总数"
          value={kpis.totalMessages}
          icon={<MessageSquare className="h-4 w-4" />}
          badge={<AdminStatusPill tone="info">24h +{kpis.messages24h}</AdminStatusPill>}
          hint={`近 7 天 ${kpis.messages7d.toLocaleString()} 条 · 已撤回 ${kpis.recalledMessages} 条`}
          onClick={() => props.onNavigateSection("rooms")}
        />

        <AdminStatCard
          label="结构化提案与表态"
          value={kpis.totalProposals}
          icon={<CheckSquare className="h-4 w-4" />}
          badge={
            kpis.openProposals > 0 ? (
              <AdminStatusPill tone="warning">待拍板 {kpis.openProposals}</AdminStatusPill>
            ) : (
              <AdminStatusPill tone="success">已通过 {kpis.approvedProposals}</AdminStatusPill>
            )
          }
          hint={`驳回 ${kpis.rejectedProposals} · 累计投票 ${kpis.totalVotes} · 有效配对码 ${kpis.activePairingCodes}`}
          onClick={() => props.onNavigateSection("proposals")}
        />
      </div>

      {/* 3. 多日活跃与增长趋势图 */}
      <AdminTrendChartCard points={data.dailyTrends} windowDays={data.windowDays} />

      {/* 4. 三维结构分布条形卡 */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <AdminBreakdownCard
          title="Agent 宿主平台分布"
          subtitle="各 CLI / IDE / 托管智能体接入占比"
          entries={data.agentPlatformDistribution}
        />
        <AdminBreakdownCard
          title="Agent 在线可达通道"
          subtitle="实时 SSE、Webhook 与巡检健康分布"
          entries={data.agentReachDistribution}
          accentMap={REACH_ACCENT_MAP}
        />
        <AdminBreakdownCard
          title="群聊治理模式分布"
          subtitle="自由讨论、圆桌轮流与提案收敛使用情况"
          entries={data.roomGovernanceDistribution}
          accentMap={GOVERNANCE_ACCENT_MAP}
        />
      </div>

      {/* 5. Top 活跃群聊 & Top 活跃用户排行榜 */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <section className="oh-elevated-card rounded-2xl p-4 sm:p-5">
          <div className="flex items-center justify-between gap-2">
            <div>
              <h3 className="text-[14px] font-semibold text-[#111318] dark:text-[#ECEFF6]">
                活跃群聊 Top 5
              </h3>
              <p className="mt-0.5 text-xs text-[#687082] dark:text-[#7D869C]">
                按累计消息数与最近互动排序，点击进入消息审查
              </p>
            </div>
            <AppButton
              variant="ghost"
              size="xs"
              trailingIcon={<ArrowRight className="h-3 w-3" />}
              onClick={() => props.onNavigateSection("rooms")}
            >
              全部群聊
            </AppButton>
          </div>

          {data.topActiveRooms.length === 0 ? (
            <p className="py-8 text-center text-xs text-[#939BAD] dark:text-[#63636B]">
              暂无群聊房间
            </p>
          ) : (
            <ul className="mt-3 divide-y divide-black/[0.05] dark:divide-white/[0.06]">
              {data.topActiveRooms.map((room, index) => (
                <li key={room.id}>
                  <button
                    type="button"
                    onClick={() => props.onInspectRoom(room.id)}
                    className="flex w-full cursor-pointer items-center justify-between gap-3 rounded-xl px-2 py-2.5 text-left transition hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
                  >
                    <div className="flex min-w-0 items-center gap-2.5">
                      <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-black/[0.05] font-mono text-[11px] font-semibold text-[#3B414E] tabular-nums dark:bg-white/[0.07] dark:text-[#B4BCD0]">
                        {index + 1}
                      </span>
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate text-[13px] font-semibold text-[#111318] dark:text-[#ECEFF6]">
                            {room.name}
                          </span>
                          {room.governanceStatus === "paused_budget" ? (
                            <AdminStatusPill tone="warning">挂起</AdminStatusPill>
                          ) : null}
                        </div>
                        <p className="truncate text-[11.5px] text-[#687082] dark:text-[#7D869C]">
                          群主 {room.ownerDisplayName} · {room.memberCount} 成员 ·{" "}
                          {room.proposalCount} 提案
                        </p>
                      </div>
                    </div>
                    <div className="shrink-0 text-right">
                      <span className="block font-mono text-[13px] font-semibold text-[#111318] tabular-nums dark:text-[#ECEFF6]">
                        {room.messageCount} 条
                      </span>
                      <span className="block text-[11px] text-[#939BAD] dark:text-[#63636B]">
                        {formatAdminDateTime(room.lastMessageAtIso)}
                      </span>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="oh-elevated-card rounded-2xl p-4 sm:p-5">
          <div className="flex items-center justify-between gap-2">
            <div>
              <h3 className="text-[14px] font-semibold text-[#111318] dark:text-[#ECEFF6]">
                核心活跃用户 Top 5
              </h3>
              <p className="mt-0.5 text-xs text-[#687082] dark:text-[#7D869C]">
                统计本人及名下 Agent 发言总贡献，点击查看账号详情
              </p>
            </div>
            <AppButton
              variant="ghost"
              size="xs"
              trailingIcon={<ArrowRight className="h-3 w-3" />}
              onClick={() => props.onNavigateSection("users")}
            >
              全部用户
            </AppButton>
          </div>

          {data.topActiveUsers.length === 0 ? (
            <p className="py-8 text-center text-xs text-[#939BAD] dark:text-[#63636B]">
              暂无用户账号
            </p>
          ) : (
            <ul className="mt-3 divide-y divide-black/[0.05] dark:divide-white/[0.06]">
              {data.topActiveUsers.map((user, index) => (
                <li key={user.id}>
                  <button
                    type="button"
                    onClick={() => props.onInspectUser(user.id)}
                    className="flex w-full cursor-pointer items-center justify-between gap-3 rounded-xl px-2 py-2.5 text-left transition hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
                  >
                    <div className="flex min-w-0 items-center gap-2.5">
                      <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-black/[0.05] font-mono text-[11px] font-semibold text-[#3B414E] tabular-nums dark:bg-white/[0.07] dark:text-[#B4BCD0]">
                        {index + 1}
                      </span>
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate text-[13px] font-semibold text-[#111318] dark:text-[#ECEFF6]">
                            {user.displayName}
                          </span>
                          {user.role === "admin" ? (
                            <AdminStatusPill tone="accent">管理员</AdminStatusPill>
                          ) : null}
                          {user.status === "suspended" ? (
                            <AdminStatusPill tone="danger">已封禁</AdminStatusPill>
                          ) : null}
                        </div>
                        <p className="truncate text-[11.5px] text-[#687082] dark:text-[#7D869C]">
                          {user.email} · {user.agentCount} Agent · {user.ownedRoomCount} 建群
                        </p>
                      </div>
                    </div>
                    <div className="shrink-0 text-right">
                      <span className="block font-mono text-[13px] font-semibold text-[#111318] tabular-nums dark:text-[#ECEFF6]">
                        {user.messageCount} 条
                      </span>
                      <span className="block text-[11px] text-[#939BAD] dark:text-[#63636B]">
                        最近登录 {formatAdminDateTime(user.lastLoginAtIso)}
                      </span>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {/* 6. 近期管理员操作审计动态 */}
      <section className="oh-elevated-card rounded-2xl p-4 sm:p-5">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <FileClock className="h-4 w-4 text-[#687082] dark:text-[#8E96AB]" />
            <h3 className="text-[14px] font-semibold text-[#111318] dark:text-[#ECEFF6]">
              近期管理操作审计
            </h3>
          </div>
          <AppButton
            variant="ghost"
            size="xs"
            trailingIcon={<ArrowRight className="h-3 w-3" />}
            onClick={() => props.onNavigateSection("audit-logs")}
          >
            查看完整日志
          </AppButton>
        </div>

        {data.recentAuditLogs.length === 0 ? (
          <div className="mt-3 flex items-center justify-center gap-2 rounded-xl bg-black/[0.025] py-6 text-xs text-[#687082] dark:bg-white/[0.03] dark:text-[#7D869C]">
            <Cpu className="h-4 w-4" />
            <span>暂无后台写操作记录，全部管理变更将自动留痕</span>
          </div>
        ) : (
          <ul className="mt-3 divide-y divide-black/[0.05] dark:divide-white/[0.06]">
            {data.recentAuditLogs.map((log) => (
              <li
                key={log.id}
                className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-xs"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <AdminStatusPill tone="neutral">{log.action}</AdminStatusPill>
                    <span className="font-medium text-[#111318] dark:text-[#ECEFF6]">
                      {log.summary}
                    </span>
                  </div>
                  <p className="mt-1 text-[11.5px] text-[#687082] dark:text-[#7D869C]">
                    操作人 {log.actorDisplayName} ({log.actorEmail}) · 目标{" "}
                    <span className="font-mono">{log.targetId}</span>
                  </p>
                </div>
                <span className="shrink-0 font-mono text-[11px] text-[#939BAD] tabular-nums dark:text-[#63636B]">
                  {formatAdminDateTime(log.createdAtIso)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
