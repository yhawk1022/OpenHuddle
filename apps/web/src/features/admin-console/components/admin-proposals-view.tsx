/**
 * @module web/features/admin-console/proposals-view
 * @description 全平台结构化提案与人类拍板决议监管视图（状态筛选、房间下钻、方案与投票查看及删除）。
 */
import type { AdminProposalItem, ProposalStatus, RoomId } from "@openhuddle/protocol";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink, Search, Trash2, X } from "lucide-react";
import { useState } from "react";
import {
  AppButton,
  AppInput,
  AppSelect,
  type AppSelectOption,
  IconButton,
} from "../../../components/primitives/index.js";
import {
  adminProposalsQueryOptions,
  useAdminDeleteProposalMutation,
} from "../api/admin-console.queries.js";
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

const STATUS_OPTIONS: ReadonlyArray<AppSelectOption<ProposalStatusFilter>> = [
  { value: "__all__", label: "全部状态" },
  { value: "open", label: "待拍板 (open)" },
  { value: "approved", label: "已采纳 (approved)" },
  { value: "rejected", label: "已驳回 (rejected)" },
  { value: "superseded", label: "已替代 (superseded)" },
];

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
  const [page, setPage] = useState<number>(1);
  const [statusFilter, setStatusFilter] = useState<ProposalStatusFilter>("__all__");
  const [searchInput, setSearchInput] = useState<string>("");
  const [pendingDelete, setPendingDelete] = useState<AdminProposalItem | null>(null);

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
        <div className="min-w-[220px] flex-1">
          <AppInput
            size="sm"
            value={searchInput}
            onChange={(e) => {
              setSearchInput(e.target.value);
              setPage(1);
            }}
            placeholder="搜索提案标题、所属群聊或 prp_ ID…"
            aria-label="搜索提案"
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

        <div className="w-44">
          <AppSelect
            size="sm"
            value={statusFilter}
            onValueChange={(val) => {
              setStatusFilter(val);
              setPage(1);
            }}
            options={STATUS_OPTIONS}
            ariaLabel="按提案状态筛选"
          />
        </div>
      </div>

      <div className="oh-elevated-card overflow-hidden rounded-2xl">
        {proposalsQuery.isPending ? (
          <AdminTableSkeleton rows={5} />
        ) : proposalsQuery.isError || !proposalsQuery.data ? (
          <AdminErrorState
            message={
              proposalsQuery.error instanceof Error
                ? proposalsQuery.error.message
                : "加载提案列表失败"
            }
            onRetry={() => void proposalsQuery.refetch()}
          />
        ) : proposalsQuery.data.proposals.length === 0 ? (
          <AdminEmptyState
            title="暂无符合条件的提案记录"
            description="尝试切换提案状态或调整搜索关键词"
          />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[820px] border-collapse text-left text-[13px]">
                <thead>
                  <tr className="border-b border-black/[0.06] bg-black/[0.02] text-[11.5px] font-semibold text-[#687082] dark:border-white/[0.07] dark:bg-white/[0.02] dark:text-[#8E96AB]">
                    <th className="px-4 py-3">提案标题与摘要</th>
                    <th className="px-3 py-3">所属群聊</th>
                    <th className="px-3 py-3">状态与拍板结论</th>
                    <th className="px-3 py-3 text-right">方案 / 投票</th>
                    <th className="px-3 py-3">创建时间</th>
                    <th className="px-4 py-3 text-right">操作</th>
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
                            {prop.status}
                          </AdminStatusPill>
                          {prop.decidedByDisplayName ? (
                            <p className="text-[11px] text-[#687082] dark:text-[#8E96AB]">
                              拍板人：{prop.decidedByDisplayName}
                              {prop.decidedOptionKey ? ` · ${prop.decidedOptionKey}` : ""}
                            </p>
                          ) : null}
                        </div>
                      </td>
                      <td className="px-3 py-3 text-right font-mono text-xs text-[#3B414E] tabular-nums dark:text-[#B4BCD0]">
                        {prop.draft.options.length} 方案 / {prop.voteCount} 票
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
                          删除
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
        title={pendingDelete ? `删除提案「${pendingDelete.draft.title}」` : "删除提案"}
        description="确定永久删除该结构化提案及其全部投票表态记录吗？"
        confirmLabel="确认删除"
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
