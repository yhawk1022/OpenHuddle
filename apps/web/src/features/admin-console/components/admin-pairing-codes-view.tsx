/**
 * @module web/features/admin-console/pairing-codes-view
 * @description 全平台一次性 Agent 配对码监控视图（状态筛选、单码吊销与过期/已用记录批量清理）。
 */
import type { AdminPairingCodeItem, AdminPairingCodeStatus } from "@openhuddle/protocol";
import { useQuery } from "@tanstack/react-query";
import { Eraser, Search, Trash2, X } from "lucide-react";
import { useMemo, useState } from "react";
import {
  AppButton,
  AppInput,
  IconButton,
  type SegmentedTabItem,
  SegmentedTabs,
} from "../../../components/primitives/index.js";
import {
  adminPairingCodesQueryOptions,
  useAdminPurgePairingCodesMutation,
  useAdminRevokePairingCodeMutation,
} from "../api/admin-console.queries.js";
import { resolveAdminErrorMessage, useAdminI18n } from "../i18n/index.js";
import {
  AdminConfirmModal,
  AdminEmptyState,
  AdminErrorState,
  AdminPaginationBar,
  AdminStatusPill,
  AdminTableSkeleton,
  type AdminTone,
  formatAdminDateTime,
} from "./admin-shared-ui.js";

type CodeFilter = "__all__" | AdminPairingCodeStatus;

const CODE_TONE: Readonly<Record<AdminPairingCodeStatus, AdminTone>> = {
  active: "success",
  used: "neutral",
  expired: "warning",
};

/**
 * 渲染全局配对码监管视图。
 */
export function AdminPairingCodesView() {
  const { locale, t } = useAdminI18n();
  const [page, setPage] = useState<number>(1);
  const [statusFilter, setStatusFilter] = useState<CodeFilter>("__all__");
  const [searchInput, setSearchInput] = useState<string>("");
  const [pendingRevoke, setPendingRevoke] = useState<AdminPairingCodeItem | null>(null);

  const codeStatusTabs = useMemo<ReadonlyArray<SegmentedTabItem<CodeFilter>>>(
    () => [
      { value: "__all__", label: t("pairingCodes.tab.all") },
      { value: "active", label: t("pairingCodes.tab.active") },
      { value: "used", label: t("pairingCodes.tab.used") },
      { value: "expired", label: t("pairingCodes.tab.expired") },
    ],
    [t],
  );

  const codeLabel = useMemo<Readonly<Record<AdminPairingCodeStatus, string>>>(
    () => ({
      active: t("pairingCodes.status.active"),
      used: t("pairingCodes.status.used"),
      expired: t("pairingCodes.status.expired"),
    }),
    [t],
  );

  const codesQuery = useQuery(
    adminPairingCodesQueryOptions({
      page,
      pageSize: 20,
      ...(statusFilter !== "__all__" ? { status: statusFilter } : {}),
      ...(searchInput.trim().length > 0 ? { search: searchInput.trim() } : {}),
    }),
  );

  const revokeMutation = useAdminRevokePairingCodeMutation();
  const purgeMutation = useAdminPurgePairingCodesMutation();

  return (
    <div className="space-y-4">
      <div className="oh-elevated-card flex flex-wrap items-center justify-between gap-3 rounded-2xl p-3.5">
        <div className="flex w-full flex-wrap items-center gap-2.5 sm:w-auto">
          <div className="no-scrollbar max-w-full overflow-x-auto">
            <SegmentedTabs
              value={statusFilter}
              onValueChange={(next) => {
                setStatusFilter(next);
                setPage(1);
              }}
              items={codeStatusTabs}
              size="sm"
              ariaLabel={t("pairingCodes.tab.aria")}
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
              placeholder={t("pairingCodes.search.placeholder")}
              aria-label={t("pairingCodes.search.aria")}
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
          {t("pairingCodes.action.purgeInactive")}
        </AppButton>
      </div>

      <div className="oh-elevated-card overflow-hidden rounded-2xl">
        {codesQuery.isPending ? (
          <AdminTableSkeleton rows={5} />
        ) : codesQuery.isError || !codesQuery.data ? (
          <AdminErrorState
            message={resolveAdminErrorMessage(
              codesQuery.error,
              t("pairingCodes.error.loadList"),
              locale,
            )}
            onRetry={() => void codesQuery.refetch()}
          />
        ) : codesQuery.data.pairingCodes.length === 0 ? (
          <AdminEmptyState
            title={t("pairingCodes.empty.title")}
            description={t("pairingCodes.empty.description")}
          />
        ) : (
          <>
            <div className="overflow-x-auto overscroll-x-contain">
              <table className="w-full min-w-[780px] border-collapse text-left text-[13px]">
                <thead>
                  <tr className="border-b border-black/[0.06] bg-black/[0.02] text-[11.5px] font-semibold text-[#687082] dark:border-white/[0.07] dark:bg-white/[0.02] dark:text-[#8E96AB]">
                    <th className="px-4 py-3">{t("pairingCodes.table.code")}</th>
                    <th className="px-3 py-3">{t("pairingCodes.table.owner")}</th>
                    <th className="px-3 py-3">{t("pairingCodes.table.status")}</th>
                    <th className="px-3 py-3">{t("pairingCodes.table.target")}</th>
                    <th className="px-3 py-3">{t("pairingCodes.table.expiresAt")}</th>
                    <th className="px-4 py-3 text-right">{t("pairingCodes.table.actions")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-black/[0.05] dark:divide-white/[0.06]">
                  {codesQuery.data.pairingCodes.map((item) => (
                    <tr
                      key={item.code}
                      className="transition-colors hover:bg-black/[0.02] dark:hover:bg-white/[0.025]"
                    >
                      <td className="px-4 py-3 font-mono text-xs font-semibold text-[#111318] dark:text-[#ECEFF6]">
                        {item.code}
                      </td>
                      <td className="px-3 py-3">
                        <div className="text-xs font-medium text-[#111318] dark:text-[#ECEFF6]">
                          {item.ownerDisplayName}
                        </div>
                        <div className="text-[11px] text-[#687082] dark:text-[#8E96AB]">
                          {item.ownerEmail}
                        </div>
                      </td>
                      <td className="px-3 py-3">
                        <AdminStatusPill tone={CODE_TONE[item.status]}>
                          {codeLabel[item.status]}
                        </AdminStatusPill>
                      </td>
                      <td className="px-3 py-3 text-xs text-[#3B414E] dark:text-[#B4BCD0]">
                        {item.autoJoinRoomName ? (
                          <span>
                            {t("pairingCodes.target.joinRoom", { room: item.autoJoinRoomName })}
                          </span>
                        ) : item.reclaimAgentId ? (
                          <span className="font-mono">
                            {t("pairingCodes.target.reclaim", { agentId: item.reclaimAgentId })}
                          </span>
                        ) : (
                          <span className="text-[#939BAD] dark:text-[#63636B]">
                            {t("pairingCodes.target.general")}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-3 font-mono text-xs text-[#687082] tabular-nums dark:text-[#8E96AB]">
                        {formatAdminDateTime(item.expiresAtIso)}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <AppButton
                          variant="dangerSoft"
                          size="xs"
                          leadingIcon={<Trash2 className="h-3 w-3" />}
                          onClick={() => setPendingRevoke(item)}
                        >
                          {t("shared.action.revoke")}
                        </AppButton>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <AdminPaginationBar pagination={codesQuery.data.pagination} onPageChange={setPage} />
          </>
        )}
      </div>

      <AdminConfirmModal
        open={pendingRevoke !== null}
        title={
          pendingRevoke
            ? t("pairingCodes.modal.revokeTitle", { code: pendingRevoke.code })
            : t("pairingCodes.modal.revokeTitleFallback")
        }
        description={t("pairingCodes.modal.revokeDescription")}
        confirmLabel={t("shared.action.confirmRevoke")}
        isPending={revokeMutation.isPending}
        onClose={() => setPendingRevoke(null)}
        onConfirm={() => {
          if (!pendingRevoke) {
            return;
          }
          revokeMutation.mutate(pendingRevoke.code, {
            onSuccess: () => setPendingRevoke(null),
          });
        }}
      />
    </div>
  );
}
