/**
 * @module web/features/admin-console/audit-logs-view
 * @description 管理员后台操作审计日志视图（支持按目标实体分类筛选、全文检索与元数据详情展开）。
 */
import type { AdminAuditTargetType } from "@openhuddle/protocol";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Search, X } from "lucide-react";
import { useState } from "react";
import {
  AppInput,
  AppSelect,
  type AppSelectOption,
  IconButton,
} from "../../../components/primitives/index.js";
import { adminAuditLogsQueryOptions } from "../api/admin-console.queries.js";
import {
  AdminEmptyState,
  AdminErrorState,
  AdminPaginationBar,
  AdminStatusPill,
  AdminTableSkeleton,
  formatAdminDateTime,
} from "./admin-shared-ui.js";

type TargetTypeFilter = "__all__" | AdminAuditTargetType;

const TARGET_TYPE_OPTIONS: ReadonlyArray<AppSelectOption<TargetTypeFilter>> = [
  { value: "__all__", label: "全部操作对象" },
  { value: "user", label: "用户账号 (user)" },
  { value: "session", label: "登录会话 (session)" },
  { value: "room", label: "群聊房间 (room)" },
  { value: "message", label: "群聊消息 (message)" },
  { value: "agent", label: "智能体 (agent)" },
  { value: "proposal", label: "结构化提案 (proposal)" },
  { value: "pairing_code", label: "配对码 (pairing_code)" },
  { value: "system", label: "批量维护 (system)" },
];

/**
 * 渲染后台审计日志记录视图。
 */
export function AdminAuditLogsView() {
  const [page, setPage] = useState<number>(1);
  const [targetFilter, setTargetFilter] = useState<TargetTypeFilter>("__all__");
  const [searchInput, setSearchInput] = useState<string>("");
  const [expandedLogId, setExpandedLogId] = useState<string | null>(null);

  const logsQuery = useQuery(
    adminAuditLogsQueryOptions({
      page,
      pageSize: 20,
      ...(targetFilter !== "__all__" ? { targetType: targetFilter } : {}),
      ...(searchInput.trim().length > 0 ? { search: searchInput.trim() } : {}),
    }),
  );

  return (
    <div className="space-y-4">
      <div className="oh-elevated-card flex flex-wrap items-center gap-2.5 rounded-2xl p-3.5">
        <div className="min-w-[220px] flex-1">
          <AppInput
            size="sm"
            value={searchInput}
            onChange={(e) => {
              setSearchInput(e.target.value);
              setPage(1);
            }}
            placeholder="搜索操作人、目标 ID 或审计摘要…"
            aria-label="搜索审计日志"
            leadingIcon={<Search className="h-3.5 w-3.5" />}
            trailingSlot={
              searchInput.length > 0 ? (
                <IconButton
                  size="xs"
                  variant="ghost"
                  label="清空搜索"
                  onClick={() => {
                    setSearchInput("");
                    setPage(1);
                  }}
                >
                  <X className="h-3 w-3" />
                </IconButton>
              ) : undefined
            }
          />
        </div>

        <div className="w-48">
          <AppSelect
            size="sm"
            value={targetFilter}
            onValueChange={(val) => {
              setTargetFilter(val);
              setPage(1);
            }}
            options={TARGET_TYPE_OPTIONS}
            ariaLabel="按审计目标类型筛选"
          />
        </div>
      </div>

      <div className="oh-elevated-card overflow-hidden rounded-2xl">
        {logsQuery.isPending ? (
          <AdminTableSkeleton rows={6} />
        ) : logsQuery.isError || !logsQuery.data ? (
          <AdminErrorState
            message={
              logsQuery.error instanceof Error ? logsQuery.error.message : "加载审计日志失败"
            }
            onRetry={() => void logsQuery.refetch()}
          />
        ) : logsQuery.data.logs.length === 0 ? (
          <AdminEmptyState
            title="暂无操作审计日志"
            description="所有通过后台触发的权限调整、封禁、删房与撤回动作均会不可变留痕"
          />
        ) : (
          <>
            <ul className="divide-y divide-black/[0.05] dark:divide-white/[0.06]">
              {logsQuery.data.logs.map((log) => {
                const hasMeta = log.metadata !== undefined && Object.keys(log.metadata).length > 0;
                const isExpanded = expandedLogId === log.id;
                return (
                  <li key={log.id} className="px-4 py-3.5 text-xs">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <AdminStatusPill tone="accent">{log.action}</AdminStatusPill>
                          <AdminStatusPill tone="neutral">{log.targetType}</AdminStatusPill>
                          <span className="font-semibold text-[#111318] dark:text-[#ECEFF6]">
                            {log.summary}
                          </span>
                        </div>
                        <p className="text-[11.5px] text-[#687082] dark:text-[#8E96AB]">
                          操作人：{log.actorDisplayName} ({log.actorEmail}) · 目标标识：
                          <span className="font-mono">{log.targetId}</span>
                        </p>
                      </div>

                      <div className="flex shrink-0 items-center gap-2">
                        <span className="font-mono text-[11px] text-[#939BAD] tabular-nums dark:text-[#63636B]">
                          {formatAdminDateTime(log.createdAtIso)}
                        </span>
                        {hasMeta ? (
                          <button
                            type="button"
                            onClick={() => setExpandedLogId(isExpanded ? null : log.id)}
                            className="inline-flex cursor-pointer items-center gap-1 rounded-full bg-black/[0.04] px-2.5 py-1 text-[11px] font-medium text-[#3B414E] transition hover:bg-black/[0.08] dark:bg-white/[0.06] dark:text-[#B4BCD0] dark:hover:bg-white/[0.1]"
                          >
                            {isExpanded ? (
                              <ChevronDown className="h-3 w-3" />
                            ) : (
                              <ChevronRight className="h-3 w-3" />
                            )}
                            <span>详情</span>
                          </button>
                        ) : null}
                      </div>
                    </div>

                    {isExpanded && hasMeta ? (
                      <pre className="mt-2.5 overflow-x-auto rounded-xl border border-black/[0.06] bg-im-code p-3 font-mono text-[11px] leading-relaxed text-[#3B414E] dark:border-white/[0.07] dark:text-[#B4BCD0]">
                        {JSON.stringify(log.metadata, null, 2)}
                      </pre>
                    ) : null}
                  </li>
                );
              })}
            </ul>

            <AdminPaginationBar pagination={logsQuery.data.pagination} onPageChange={setPage} />
          </>
        )}
      </div>
    </div>
  );
}
