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
import { useMemo, useState } from "react";
import {
  AppButton,
  type SegmentedTabItem,
  SegmentedTabs,
} from "../../../components/primitives/index.js";
import { formatNumber } from "../../../lib/i18n/index.js";
import { adminOverviewQueryOptions } from "../api/admin-console.queries.js";
import { getAuditActionLabel, resolveAdminErrorMessage, useAdminI18n } from "../i18n/index.js";
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
  const { locale, t, tp } = useAdminI18n();
  const [windowPreset, setWindowPreset] = useState<WindowPreset>("14");
  const windowDays = Number(windowPreset);
  const overviewQuery = useQuery(adminOverviewQueryOptions(windowDays));

  const windowTabs = useMemo<ReadonlyArray<SegmentedTabItem<WindowPreset>>>(
    () => [
      { value: "7", label: t("overview.window.7d") },
      { value: "14", label: t("overview.window.14d") },
      { value: "30", label: t("overview.window.30d") },
    ],
    [t],
  );

  const reachLabelMap = useMemo<Readonly<Record<string, string>>>(
    () => ({
      online_sse: t("common.reach.online_sse"),
      hosted_ready: t("common.reach.hosted_ready"),
      webhook: t("common.reach.webhook"),
      polling: t("common.reach.polling"),
      offline: t("common.reach.offline"),
    }),
    [t],
  );

  const governanceLabelMap = useMemo<Readonly<Record<string, string>>>(
    () => ({
      free: t("common.governance.free"),
      round_table: t("common.governance.round_table"),
      proposal: t("common.governance.proposal"),
    }),
    [t],
  );

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
        title={t("overview.error.title")}
        message={resolveAdminErrorMessage(
          overviewQuery.error,
          t("overview.error.fallback"),
          locale,
        )}
        onRetry={() => void overviewQuery.refetch()}
      />
    );
  }

  const data = overviewQuery.data;
  const { kpis, runtime } = data;
  const fmt = (value: number): string => formatNumber(value, undefined, locale);

  return (
    <div className="space-y-5">
      {/* 1. 运行态健康条与时间窗口切换 */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <AdminStatusPill tone="success" dotClass="bg-[#16A34A] dark:bg-[#34D399]">
            {t("overview.runtime.running", {
              uptime: formatUptimeDuration(runtime.uptimeSec, locale),
            })}
          </AdminStatusPill>
          <AdminStatusPill tone="neutral">
            <Database className="mr-1 inline h-3 w-3" />
            {runtime.databaseDriver === "postgres"
              ? "PostgreSQL 16+"
              : t("overview.runtime.dbPglite")}
          </AdminStatusPill>
          <AdminStatusPill tone="neutral">
            <Radio className="mr-1 inline h-3 w-3" />
            {runtime.realtimeBusDriver === "postgres"
              ? "PG LISTEN/NOTIFY"
              : t("overview.runtime.busMemory")}
          </AdminStatusPill>
          <AdminStatusPill tone="info">
            <Activity className="mr-1 inline h-3 w-3" />
            {t("overview.runtime.liveConnections", {
              agents: fmt(runtime.activeAgentConnections),
              rooms: fmt(runtime.activeRoomSubscriptions),
            })}
          </AdminStatusPill>
        </div>

        <SegmentedTabs
          value={windowPreset}
          onValueChange={setWindowPreset}
          items={windowTabs}
          size="sm"
          ariaLabel={t("overview.window.ariaLabel")}
        />
      </div>

      {/* 2. 六大核心 KPI 指标卡 */}
      <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 xl:grid-cols-3">
        <AdminStatCard
          label={t("overview.kpi.users.label")}
          value={kpis.totalUsers}
          icon={<Users className="h-4 w-4" />}
          badge={
            kpis.suspendedUsers > 0 ? (
              <AdminStatusPill tone="danger">
                {t("overview.kpi.users.suspendedBadge", { count: fmt(kpis.suspendedUsers) })}
              </AdminStatusPill>
            ) : (
              <AdminStatusPill tone="success">
                {t("overview.kpi.users.new7dBadge", { count: fmt(kpis.newUsers7d) })}
              </AdminStatusPill>
            )
          }
          hint={tp("overview.kpi.users.hint", kpis.adminUsers, {
            formatted: fmt(kpis.adminUsers),
          })}
          onClick={() => props.onNavigateSection("users")}
        />

        <AdminStatCard
          label={t("overview.kpi.sessions.label")}
          value={kpis.activeSessions}
          icon={<KeyRound className="h-4 w-4" />}
          badge={
            kpis.expiredSessions > 0 ? (
              <AdminStatusPill tone="warning">
                {t("overview.kpi.sessions.expiredBadge", { count: fmt(kpis.expiredSessions) })}
              </AdminStatusPill>
            ) : (
              <AdminStatusPill tone="neutral">
                {t("overview.kpi.sessions.healthyBadge")}
              </AdminStatusPill>
            )
          }
          hint={t("overview.kpi.sessions.hint")}
          onClick={() => props.onNavigateSection("sessions")}
        />

        <AdminStatCard
          label={t("overview.kpi.agents.label")}
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
              {t("overview.kpi.agents.sseBadge", { count: fmt(kpis.onlineSseAgents) })}
            </AdminStatusPill>
          }
          hint={t("overview.kpi.agents.hint")}
          onClick={() => props.onNavigateSection("agents")}
        />

        <AdminStatCard
          label={t("overview.kpi.rooms.label")}
          value={kpis.totalRooms}
          icon={<MessagesSquare className="h-4 w-4" />}
          badge={
            kpis.pausedBudgetRooms > 0 ? (
              <AdminStatusPill tone="warning">
                {t("overview.kpi.rooms.pausedBadge", { count: fmt(kpis.pausedBudgetRooms) })}
              </AdminStatusPill>
            ) : (
              <AdminStatusPill tone="info">
                {t("overview.kpi.rooms.publicBadge", { count: fmt(kpis.publicShareableRooms) })}
              </AdminStatusPill>
            )
          }
          hint={t("overview.kpi.rooms.hint")}
          onClick={() => props.onNavigateSection("rooms")}
        />

        <AdminStatCard
          label={t("overview.kpi.messages.label")}
          value={kpis.totalMessages}
          icon={<MessageSquare className="h-4 w-4" />}
          badge={
            <AdminStatusPill tone="info">
              {t("overview.kpi.messages.badge24h", { count: fmt(kpis.messages24h) })}
            </AdminStatusPill>
          }
          hint={t("overview.kpi.messages.hint", {
            messages7d: fmt(kpis.messages7d),
            recalled: fmt(kpis.recalledMessages),
          })}
          onClick={() => props.onNavigateSection("rooms")}
        />

        <AdminStatCard
          label={t("overview.kpi.proposals.label")}
          value={kpis.totalProposals}
          icon={<CheckSquare className="h-4 w-4" />}
          badge={
            kpis.openProposals > 0 ? (
              <AdminStatusPill tone="warning">
                {t("overview.kpi.proposals.openBadge", { count: fmt(kpis.openProposals) })}
              </AdminStatusPill>
            ) : (
              <AdminStatusPill tone="success">
                {t("overview.kpi.proposals.approvedBadge", { count: fmt(kpis.approvedProposals) })}
              </AdminStatusPill>
            )
          }
          hint={t("overview.kpi.proposals.hint", {
            rejected: fmt(kpis.rejectedProposals),
            votes: fmt(kpis.totalVotes),
            codes: fmt(kpis.activePairingCodes),
          })}
          onClick={() => props.onNavigateSection("proposals")}
        />
      </div>

      {/* 3. 多日活跃与增长趋势图 */}
      <AdminTrendChartCard points={data.dailyTrends} windowDays={data.windowDays} />

      {/* 4. 三维结构分布条形卡 */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <AdminBreakdownCard
          title={t("overview.breakdown.platforms.title")}
          subtitle={t("overview.breakdown.platforms.subtitle")}
          entries={data.agentPlatformDistribution}
        />
        <AdminBreakdownCard
          title={t("overview.breakdown.reach.title")}
          subtitle={t("overview.breakdown.reach.subtitle")}
          entries={data.agentReachDistribution}
          accentMap={REACH_ACCENT_MAP}
          labelMap={reachLabelMap}
        />
        <AdminBreakdownCard
          title={t("overview.breakdown.governance.title")}
          subtitle={t("overview.breakdown.governance.subtitle")}
          entries={data.roomGovernanceDistribution}
          accentMap={GOVERNANCE_ACCENT_MAP}
          labelMap={governanceLabelMap}
        />
      </div>

      {/* 5. Top 活跃群聊 & Top 活跃用户排行榜 */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <section className="oh-elevated-card rounded-2xl p-4 sm:p-5">
          <div className="flex items-center justify-between gap-2">
            <div>
              <h3 className="text-[14px] font-semibold text-[#111318] dark:text-[#ECEFF6]">
                {t("overview.topRooms.title")}
              </h3>
              <p className="mt-0.5 text-xs text-[#687082] dark:text-[#7D869C]">
                {t("overview.topRooms.subtitle")}
              </p>
            </div>
            <AppButton
              variant="ghost"
              size="xs"
              trailingIcon={<ArrowRight className="h-3 w-3" />}
              onClick={() => props.onNavigateSection("rooms")}
            >
              {t("overview.topRooms.viewAll")}
            </AppButton>
          </div>

          {data.topActiveRooms.length === 0 ? (
            <p className="py-8 text-center text-xs text-[#939BAD] dark:text-[#63636B]">
              {t("overview.topRooms.empty")}
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
                            <AdminStatusPill tone="warning">
                              {t("common.status.pausedShort")}
                            </AdminStatusPill>
                          ) : null}
                        </div>
                        <p className="truncate text-[11.5px] text-[#687082] dark:text-[#7D869C]">
                          {t("overview.topRooms.meta", {
                            owner: room.ownerDisplayName,
                            members: fmt(room.memberCount),
                            proposals: fmt(room.proposalCount),
                          })}
                        </p>
                      </div>
                    </div>
                    <div className="shrink-0 text-right">
                      <span className="block font-mono text-[13px] font-semibold text-[#111318] tabular-nums dark:text-[#ECEFF6]">
                        {t("overview.topRooms.messageCount", { count: fmt(room.messageCount) })}
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
                {t("overview.topUsers.title")}
              </h3>
              <p className="mt-0.5 text-xs text-[#687082] dark:text-[#7D869C]">
                {t("overview.topUsers.subtitle")}
              </p>
            </div>
            <AppButton
              variant="ghost"
              size="xs"
              trailingIcon={<ArrowRight className="h-3 w-3" />}
              onClick={() => props.onNavigateSection("users")}
            >
              {t("overview.topUsers.viewAll")}
            </AppButton>
          </div>

          {data.topActiveUsers.length === 0 ? (
            <p className="py-8 text-center text-xs text-[#939BAD] dark:text-[#63636B]">
              {t("overview.topUsers.empty")}
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
                            <AdminStatusPill tone="accent">
                              {t("common.role.admin")}
                            </AdminStatusPill>
                          ) : null}
                          {user.status === "suspended" ? (
                            <AdminStatusPill tone="danger">
                              {t("common.status.suspended")}
                            </AdminStatusPill>
                          ) : null}
                        </div>
                        <p className="truncate text-[11.5px] text-[#687082] dark:text-[#7D869C]">
                          {t("overview.topUsers.meta", {
                            email: user.email,
                            agents: fmt(user.agentCount),
                            rooms: fmt(user.ownedRoomCount),
                          })}
                        </p>
                      </div>
                    </div>
                    <div className="shrink-0 text-right">
                      <span className="block font-mono text-[13px] font-semibold text-[#111318] tabular-nums dark:text-[#ECEFF6]">
                        {t("overview.topUsers.messageCount", { count: fmt(user.messageCount) })}
                      </span>
                      <span className="block text-[11px] text-[#939BAD] dark:text-[#63636B]">
                        {t("overview.topUsers.lastLogin", {
                          time: formatAdminDateTime(user.lastLoginAtIso),
                        })}
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
              {t("overview.recentAudit.title")}
            </h3>
          </div>
          <AppButton
            variant="ghost"
            size="xs"
            trailingIcon={<ArrowRight className="h-3 w-3" />}
            onClick={() => props.onNavigateSection("audit-logs")}
          >
            {t("overview.recentAudit.viewAll")}
          </AppButton>
        </div>

        {data.recentAuditLogs.length === 0 ? (
          <div className="mt-3 flex items-center justify-center gap-2 rounded-xl bg-black/[0.025] py-6 text-xs text-[#687082] dark:bg-white/[0.03] dark:text-[#7D869C]">
            <Cpu className="h-4 w-4" />
            <span>{t("overview.recentAudit.empty")}</span>
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
                    <AdminStatusPill tone="neutral" title={log.action}>
                      {getAuditActionLabel(log.action, t)}
                    </AdminStatusPill>
                    <span className="font-medium text-[#111318] dark:text-[#ECEFF6]">
                      {log.summary}
                    </span>
                  </div>
                  <p className="mt-1 text-[11.5px] text-[#687082] dark:text-[#7D869C]">
                    {t("overview.recentAudit.actorPrefix", {
                      name: log.actorDisplayName,
                      email: log.actorEmail,
                    })}
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
