/**
 * @module web/features/admin-console/sessions-view
 * @description 全平台人类 Web 登录会话监管视图（支持活跃/过期筛选、单条强制踢下线与批量清理过期会话）。
 */
import type { AdminSessionFilterStatus, AdminSessionItem, SessionId } from "@openhuddle/protocol";
import { useQuery } from "@tanstack/react-query";
import { Eraser, LogOut, Search, X } from "lucide-react";
import { useMemo, useState } from "react";
import {
  AppButton,
  AppInput,
  IconButton,
  type SegmentedTabItem,
  SegmentedTabs,
} from "../../../components/primitives/index.js";
import {
  adminSessionsQueryOptions,
  useAdminPurgeExpiredSessionsMutation,
  useAdminRevokeSessionMutation,
} from "../api/admin-console.queries.js";
import { resolveAdminErrorMessage, useAdminI18n } from "../i18n/index.js";
import {
  AdminConfirmModal,
  AdminEmptyState,
  AdminErrorState,
  AdminPaginationBar,
  AdminStatusPill,
  AdminTableSkeleton,
  formatAdminDateTime,
} from "./admin-shared-ui.js";

/**
 * 渲染登录会话管理视图。
 */
export function AdminSessionsView() {
  const { locale, t } = useAdminI18n();
  const [page, setPage] = useState<number>(1);
  const [status, setStatus] = useState<AdminSessionFilterStatus>("active");
  const [searchInput, setSearchInput] = useState<string>("");
  const [pendingRevoke, setPendingRevoke] = useState<AdminSessionItem | null>(null);

  const sessionStatusTabs = useMemo<ReadonlyArray<SegmentedTabItem<AdminSessionFilterStatus>>>(
    () => [
      { value: "active", label: t("sessions.tab.active") },
      { value: "expired", label: t("sessions.tab.expired") },
      { value: "all", label: t("sessions.tab.all") },
    ],
    [t],
  );

  const sessionsQuery = useQuery(
    adminSessionsQueryOptions({
      page,
      pageSize: 20,
      status,
      ...(searchInput.trim().length > 0 ? { search: searchInput.trim() } : {}),
    }),
  );

  const revokeMutation = useAdminRevokeSessionMutation();
  const purgeMutation = useAdminPurgeExpiredSessionsMutation();

  const handleConfirmRevoke = (sessionId: SessionId): void => {
    revokeMutation.mutate(sessionId, {
      onSuccess: () => setPendingRevoke(null),
    });
  };

  return (
    <div className="space-y-4">
      <div className="oh-elevated-card flex flex-wrap items-center justify-between gap-3 rounded-2xl p-3.5">
        <div className="flex w-full flex-wrap items-center gap-2.5 sm:w-auto">
          <div className="no-scrollbar max-w-full overflow-x-auto">
            <SegmentedTabs
              value={status}
              onValueChange={(next) => {
                setStatus(next);
                setPage(1);
              }}
              items={sessionStatusTabs}
              size="sm"
              ariaLabel={t("sessions.tab.aria")}
            />
          </div>

          <div className="w-full sm:w-72">
            <AppInput
              size="sm"
              type="search"
              enterKeyHint="search"
              value={searchInput}
              onChange={(e) => {
                setSearchInput(e.target.value);
                setPage(1);
              }}
              placeholder={t("sessions.search.placeholder")}
              aria-label={t("sessions.search.aria")}
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
        </div>

        <AppButton
          variant="secondary"
          size="sm"
          className="w-full sm:w-auto"
          isLoading={purgeMutation.isPending}
          leadingIcon={<Eraser className="h-3.5 w-3.5" />}
          onClick={() => purgeMutation.mutate()}
        >
          {t("sessions.action.purgeExpired")}
        </AppButton>
      </div>

      <div className="oh-elevated-card overflow-hidden rounded-2xl">
        {sessionsQuery.isPending ? (
          <AdminTableSkeleton rows={6} />
        ) : sessionsQuery.isError || !sessionsQuery.data ? (
          <AdminErrorState
            message={resolveAdminErrorMessage(
              sessionsQuery.error,
              t("sessions.error.loadList"),
              locale,
            )}
            onRetry={() => void sessionsQuery.refetch()}
          />
        ) : sessionsQuery.data.sessions.length === 0 ? (
          <AdminEmptyState
            title={t("sessions.empty.title")}
            description={t("sessions.empty.description")}
          />
        ) : (
          <>
            <div className="overflow-x-auto overscroll-x-contain">
              <table className="w-full min-w-[740px] border-collapse text-left text-[13px]">
                <thead>
                  <tr className="border-b border-black/[0.06] bg-black/[0.02] text-[11.5px] font-semibold text-[#687082] dark:border-white/[0.07] dark:bg-white/[0.02] dark:text-[#8E96AB]">
                    <th className="px-4 py-3">{t("sessions.table.user")}</th>
                    <th className="px-3 py-3">{t("sessions.table.sessionId")}</th>
                    <th className="px-3 py-3">{t("sessions.table.status")}</th>
                    <th className="px-3 py-3">{t("sessions.table.issuedAt")}</th>
                    <th className="px-3 py-3">{t("sessions.table.expiresAt")}</th>
                    <th className="px-4 py-3 text-right">{t("sessions.table.actions")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-black/[0.05] dark:divide-white/[0.06]">
                  {sessionsQuery.data.sessions.map((item) => (
                    <tr
                      key={item.id}
                      className="transition-colors hover:bg-black/[0.02] dark:hover:bg-white/[0.025]"
                    >
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-[#111318] dark:text-[#ECEFF6]">
                            {item.userDisplayName}
                          </span>
                          {item.userRole === "admin" ? (
                            <AdminStatusPill tone="accent">
                              {t("common.role.admin")}
                            </AdminStatusPill>
                          ) : null}
                          {item.userStatus === "suspended" ? (
                            <AdminStatusPill tone="danger">
                              {t("common.status.suspended")}
                            </AdminStatusPill>
                          ) : null}
                        </div>
                        <div className="text-xs text-[#687082] dark:text-[#8E96AB]">
                          {item.userEmail}
                        </div>
                      </td>
                      <td className="px-3 py-3 font-mono text-xs text-[#3B414E] dark:text-[#B4BCD0]">
                        {item.id}
                      </td>
                      <td className="px-3 py-3">
                        <AdminStatusPill tone={item.isExpired ? "warning" : "success"}>
                          {item.isExpired
                            ? t("common.status.expired")
                            : t("common.status.sessionActive")}
                        </AdminStatusPill>
                      </td>
                      <td className="px-3 py-3 font-mono text-xs text-[#687082] tabular-nums dark:text-[#8E96AB]">
                        {formatAdminDateTime(item.createdAtIso)}
                      </td>
                      <td className="px-3 py-3 font-mono text-xs text-[#687082] tabular-nums dark:text-[#8E96AB]">
                        {formatAdminDateTime(item.expiresAtIso)}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <AppButton
                          variant="dangerSoft"
                          size="xs"
                          leadingIcon={<LogOut className="h-3 w-3" />}
                          onClick={() => setPendingRevoke(item)}
                        >
                          {t("sessions.action.forceRevoke")}
                        </AppButton>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <AdminPaginationBar pagination={sessionsQuery.data.pagination} onPageChange={setPage} />
          </>
        )}
      </div>

      <AdminConfirmModal
        open={pendingRevoke !== null}
        title={t("sessions.modal.revokeTitle")}
        description={
          pendingRevoke
            ? t("sessions.modal.revokeDescription", {
                name: pendingRevoke.userDisplayName,
                email: pendingRevoke.userEmail,
                sessionId: pendingRevoke.id,
              })
            : ""
        }
        confirmLabel={t("sessions.modal.revokeConfirm")}
        isPending={revokeMutation.isPending}
        onClose={() => setPendingRevoke(null)}
        onConfirm={() => {
          if (pendingRevoke) {
            handleConfirmRevoke(pendingRevoke.id);
          }
        }}
      />
    </div>
  );
}
