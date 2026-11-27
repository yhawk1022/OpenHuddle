/**
 * @module web/features/admin-console/proposals-view
 * @description 全平台结构化提案与人类拍板决议监管视图（状态筛选、房间下钻、方案与投票查看及删除）。
 */
import type { AdminProposalItem, ProposalStatus, RoomId } from "@openhuddle/protocol";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink, Search, Trash2, X } from "lucide-react";
import { useMemo, useState } from "react";
import {
  AppButton,
  AppInput,
  AppSelect,
  type AppSelectOption,
  IconButton,
} from "../../../components/primitives/index.js";
import { formatNumber } from "../../../lib/i18n/index.js";
import {
  adminProposalsQueryOptions,
  useAdminDeleteProposalMutation,
} from "../api/admin-console.queries.js";
import { getProposalStatusLabel, resolveAdminErrorMessage, useAdminI18n } from "../i18n/index.js";
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

type ProposalStatusFilter = "__all__" | ProposalStatus;

const STATUS_TONE: Readonly<Record<ProposalStatus, AdminTone>> = {
  open: "warning",
  approved: "success",
  rejected: "danger",
  superseded: "neutral",
};

/**
 * 渲染全局提案与拍板监管视图。
 */
export function AdminProposalsView(props: {
  readonly onInspectRoom: (roomId: RoomId) => void;
}) {
  const { locale, t } = useAdminI18n();
  const [page, setPage] = useState<number>(1);
  const [statusFilter, setStatusFilter] = useState<ProposalStatusFilter>("__all__");
  const [searchInput, setSearchInput] = useState<string>("");
  const [pendingDelete, setPendingDelete] = useState<AdminProposalItem | null>(null);

  const statusOptions = useMemo<ReadonlyArray<AppSelectOption<ProposalStatusFilter>>>(
    () => [
      { value: "__all__", label: t("proposals.filter.allStatuses") },
      { value: "open", label: t("proposals.filter.open") },
      { value: "approved", label: t("proposals.filter.approved") },
      { value: "rejected", label: t("proposals.filter.rejected") },
      { value: "superseded", label: t("proposals.filter.superseded") },
    ],
    [t],
  );

  const proposalsQuery = useQuery(
    adminProposalsQueryOptions({
      page,
      pageSize: 20,
      ...(statusFilter !== "__all__" ? { status: statusFilter } : {}),
      ...(searchInput.trim().length > 0 ? { search: searchInput.trim() } : {}),
    }),
  );

  const deleteMutation = useAdminDeleteProposalMutation();

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
            placeholder={t("proposals.search.placeholder")}
            aria-label={t("proposals.search.aria")}
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

        <div className="w-full sm:w-44">
          <AppSelect
            size="sm"
            value={statusFilter}
            onValueChange={(val) => {
              setStatusFilter(val);
              setPage(1);
            }}
            options={statusOptions}
            ariaLabel={t("proposals.filter.statusAria")}
          />
        </div>
      </div>

      <div className="oh-elevated-card overflow-hidden rounded-2xl">
        {proposalsQuery.isPending ? (
          <AdminTableSkeleton rows={5} />
        ) : proposalsQuery.isError || !proposalsQuery.data ? (
          <AdminErrorState
            message={resolveAdminErrorMessage(
              proposalsQuery.error,
              t("proposals.error.loadList"),
              locale,
            )}
            onRetry={() => void proposalsQuery.refetch()}
          />
        ) : proposalsQuery.data.proposals.length === 0 ? (
          <AdminEmptyState
            title={t("proposals.empty.title")}
            description={t("proposals.empty.description")}
          />
        ) : (
          <>
            <div className="overflow-x-auto overscroll-x-contain">
              <table className="w-full min-w-[820px] border-collapse text-left text-[13px]">
                <thead>
                  <tr className="border-b border-black/[0.06] bg-black/[0.02] text-[11.5px] font-semibold text-[#687082] dark:border-white/[0.07] dark:bg-white/[0.02] dark:text-[#8E96AB]">
                    <th className="px-4 py-3">{t("proposals.table.proposal")}</th>
                    <th className="px-3 py-3">{t("proposals.table.room")}</th>
                    <th className="px-3 py-3">{t("proposals.table.statusDecision")}</th>
                    <th className="px-3 py-3 text-right">{t("proposals.table.optionsVotes")}</th>
                    <th className="px-3 py-3">{t("proposals.table.createdAt")}</th>
                    <th className="px-4 py-3 text-right">{t("proposals.table.actions")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-black/[0.05] dark:divide-white/[0.06]">
                  {proposalsQuery.data.proposals.map((prop) => (
                    <tr
                      key={prop.id}
                      className="transition-colors hover:bg-black/[0.02] dark:hover:bg-white/[0.025]"
                    >
                      <td className="px-4 py-3">
                        <div className="max-w-sm">
                          <span className="block truncate font-semibold text-[#111318] dark:text-[#ECEFF6]">
                            {prop.draft.title}
                          </span>
                          <span className="mt-0.5 block truncate text-xs text-[#687082] dark:text-[#8E96AB]">
                            {prop.draft.contextSummary}
                          </span>
                        </div>
                      </td>
                      <td className="px-3 py-3">
                        <button
                          type="button"
                          onClick={() => props.onInspectRoom(prop.roomId)}
                          className="inline-flex cursor-pointer items-center gap-1 text-xs font-medium text-[#2563EB] hover:underline dark:text-[#60A5FA]"
                        >
                          <span className="max-w-[140px] truncate">{prop.roomName}</span>
                          <ExternalLink className="h-3 w-3 shrink-0" />
                        </button>
                      </td>
                      <td className="px-3 py-3">
                        <div className="space-y-1">
                          <AdminStatusPill tone={STATUS_TONE[prop.status]}>
                            {getProposalStatusLabel(prop.status, t)}
                          </AdminStatusPill>
                          {prop.decidedByDisplayName ? (
                            <p className="text-[11px] text-[#687082] dark:text-[#8E96AB]">
                              {prop.decidedOptionKey
                                ? t("proposals.decidedByWithOption", {
                                    name: prop.decidedByDisplayName,
                                    optionKey: prop.decidedOptionKey,
                                  })
                                : t("proposals.decidedBy", { name: prop.decidedByDisplayName })}
                            </p>
                          ) : null}
                        </div>
                      </td>
                      <td className="px-3 py-3 text-right font-mono text-xs text-[#3B414E] tabular-nums dark:text-[#B4BCD0]">
                        {t("proposals.counts", {
                          options: formatNumber(prop.draft.options.length, undefined, locale),
                          votes: formatNumber(prop.voteCount, undefined, locale),
                        })}
                      </td>
                      <td className="px-3 py-3 font-mono text-xs text-[#687082] tabular-nums dark:text-[#8E96AB]">
                        {formatAdminDateTime(prop.createdAtIso)}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <AppButton
                          variant="dangerSoft"
                          size="xs"
                          leadingIcon={<Trash2 className="h-3 w-3" />}
                          onClick={() => setPendingDelete(prop)}
                        >
                          {t("shared.action.delete")}
                        </AppButton>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <AdminPaginationBar
              pagination={proposalsQuery.data.pagination}
              onPageChange={setPage}
            />
          </>
        )}
      </div>

      <AdminConfirmModal
        open={pendingDelete !== null}
        title={
          pendingDelete
            ? t("proposals.modal.deleteTitle", { title: pendingDelete.draft.title })
            : t("proposals.modal.deleteTitleFallback")
        }
        description={t("proposals.modal.deleteDescription")}
        confirmLabel={t("shared.action.confirmDelete")}
        isPending={deleteMutation.isPending}
        onClose={() => setPendingDelete(null)}
        onConfirm={() => {
          if (!pendingDelete) {
            return;
          }
          deleteMutation.mutate(pendingDelete.id, {
            onSuccess: () => setPendingDelete(null),
          });
        }}
      />
    </div>
  );
}
