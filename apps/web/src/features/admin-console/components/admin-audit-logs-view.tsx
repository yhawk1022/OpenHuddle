/**
 * @module web/features/admin-console/audit-logs-view
 * @description 管理员后台操作审计日志视图（支持按目标实体分类筛选、全文检索与元数据详情展开）。
 */
import type { AdminAuditTargetType } from "@openhuddle/protocol";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Search, X } from "lucide-react";
import { useMemo, useState } from "react";
import {
  AppInput,
  AppSelect,
  type AppSelectOption,
  IconButton,
} from "../../../components/primitives/index.js";
import { HighlightedCodeBlock } from "../../../components/ui/syntax-code.js";
import { adminAuditLogsQueryOptions } from "../api/admin-console.queries.js";
import {
  getAuditActionLabel,
  getAuditTargetLabel,
  resolveAdminErrorMessage,
  useAdminI18n,
} from "../i18n/index.js";
import {
  AdminEmptyState,
  AdminErrorState,
  AdminPaginationBar,
  AdminStatusPill,
  AdminTableSkeleton,
  formatAdminDateTime,
} from "./admin-shared-ui.js";

type TargetTypeFilter = "__all__" | AdminAuditTargetType;

/**
 * 渲染后台审计日志记录视图。
 */
export function AdminAuditLogsView() {
  const { locale, t } = useAdminI18n();
  const [page, setPage] = useState<number>(1);
  const [targetFilter, setTargetFilter] = useState<TargetTypeFilter>("__all__");
  const [searchInput, setSearchInput] = useState<string>("");
  const [expandedLogId, setExpandedLogId] = useState<string | null>(null);

  const targetTypeOptions = useMemo<ReadonlyArray<AppSelectOption<TargetTypeFilter>>>(
    () => [
      { value: "__all__", label: t("auditLogs.filter.allTargets") },
      { value: "user", label: t("auditLogs.filter.user") },
      { value: "session", label: t("auditLogs.filter.session") },
      { value: "room", label: t("auditLogs.filter.room") },
      { value: "message", label: t("auditLogs.filter.message") },
      { value: "agent", label: t("auditLogs.filter.agent") },
      { value: "proposal", label: t("auditLogs.filter.proposal") },
      { value: "pairing_code", label: t("auditLogs.filter.pairing_code") },
      { value: "system", label: t("auditLogs.filter.system") },
    ],
    [t],
  );

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
        <div className="w-full sm:min-w-[220px] sm:flex-1">
          <AppInput
            size="sm"
            type="search"
            enterKeyHint="search"
            value={searchInput}
            onChange={(e) => {
              setSearchInput(e.target.value);
              setPage(1);
            }}
            placeholder={t("auditLogs.search.placeholder")}
            aria-label={t("auditLogs.search.aria")}
            leadingIcon={<Search className="h-3.5 w-3.5" />}
            trailingSlot={
              searchInput.length > 0 ? (
                <IconButton
                  size="xs"
                  variant="ghost"
                  label={t("shared.action.clearSearch")}
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

        <div className="w-full sm:w-48">
          <AppSelect
            size="sm"
            value={targetFilter}
            onValueChange={(val) => {
              setTargetFilter(val);
              setPage(1);
            }}
            options={targetTypeOptions}
            ariaLabel={t("auditLogs.filter.targetAria")}
          />
        </div>
      </div>

      <div className="oh-elevated-card overflow-hidden rounded-2xl">
        {logsQuery.isPending ? (
          <AdminTableSkeleton rows={6} />
        ) : logsQuery.isError || !logsQuery.data ? (
          <AdminErrorState
            message={resolveAdminErrorMessage(
              logsQuery.error,
              t("auditLogs.error.loadList"),
              locale,
            )}
            onRetry={() => void logsQuery.refetch()}
          />
        ) : logsQuery.data.logs.length === 0 ? (
          <AdminEmptyState
            title={t("auditLogs.empty.title")}
            description={t("auditLogs.empty.description")}
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
                          <AdminStatusPill tone="accent" title={log.action}>
                            {getAuditActionLabel(log.action, t)}
                          </AdminStatusPill>
                          <AdminStatusPill tone="neutral" title={log.targetType}>
                            {getAuditTargetLabel(log.targetType, t)}
                          </AdminStatusPill>
                          <span className="font-semibold text-[#111318] dark:text-[#ECEFF6]">
                            {log.summary}
                          </span>
                        </div>
                        <p className="text-[11.5px] text-[#687082] dark:text-[#8E96AB]">
                          {t("auditLogs.actorPrefix", {
                            name: log.actorDisplayName,
                            email: log.actorEmail,
                          })}
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
                            <span>{t("auditLogs.details")}</span>
                          </button>
                        ) : null}
                      </div>
                    </div>

                    {isExpanded && hasMeta ? (
                      <pre className="mt-2.5 overflow-x-auto overscroll-x-contain rounded-xl border border-black/[0.06] bg-im-code p-3 font-mono text-[11px] leading-relaxed text-[#3B414E] dark:border-white/[0.07] dark:text-[#B4BCD0]">
                        <HighlightedCodeBlock
                          code={JSON.stringify(log.metadata, null, 2)}
                          language="json"
                        />
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
