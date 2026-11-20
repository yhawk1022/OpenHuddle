/**
 * @module web/features/admin-console/pairing-codes-view
 * @description 全平台一次性 Agent 配对码监控视图（状态筛选、单码吊销与过期/已用记录批量清理）。
 */
import type { AdminPairingCodeItem, AdminPairingCodeStatus } from "@openhuddle/protocol";
import { useQuery } from "@tanstack/react-query";
import { Eraser, Search, Trash2, X } from "lucide-react";
import { useState } from "react";
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

const CODE_STATUS_TABS: ReadonlyArray<SegmentedTabItem<CodeFilter>> = [
  { value: "__all__", label: "全部" },
  { value: "active", label: "待核销" },
  { value: "used", label: "已使用" },
  { value: "expired", label: "已过期" },
];

const CODE_TONE: Readonly<Record<AdminPairingCodeStatus, AdminTone>> = {
  active: "success",
  used: "neutral",
  expired: "warning",
};

const CODE_LABEL: Readonly<Record<AdminPairingCodeStatus, string>> = {
  active: "待核销",
  used: "已核销",
  expired: "已过期",
};

/**
 * 渲染全局配对码监管视图。
 */
export function AdminPairingCodesView() {
  const [page, setPage] = useState<number>(1);
  const [statusFilter, setStatusFilter] = useState<CodeFilter>("__all__");
  const [searchInput, setSearchInput] = useState<string>("");
  const [pendingRevoke, setPendingRevoke] = useState<AdminPairingCodeItem | null>(null);

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
        <div className="flex flex-wrap items-center gap-2.5">
          <SegmentedTabs
            value={statusFilter}
            onValueChange={(next) => {
              setStatusFilter(next);
              setPage(1);
            }}
            items={CODE_STATUS_TABS}
            size="sm"
            ariaLabel="按配对码状态筛选"
          />

          <div className="w-60 sm:w-72">
            <AppInput
              size="sm"
              value={searchInput}
              onChange={(e) => {
                setSearchInput(e.target.value);
                setPage(1);
              }}
              placeholder="搜索 HUDDLE- 配对码或签发人邮箱…"
              aria-label="搜索配对码"
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
        </div>

        <AppButton
          variant="secondary"
          size="sm"
          isLoading={purgeMutation.isPending}
          leadingIcon={<Eraser className="h-3.5 w-3.5" />}
          onClick={() => purgeMutation.mutate()}
        >
          清理无效配对码
        </AppButton>
      </div>

      <div className="oh-elevated-card overflow-hidden rounded-2xl">
        {codesQuery.isPending ? (
          <AdminTableSkeleton rows={5} />
        ) : codesQuery.isError || !codesQuery.data ? (
          <AdminErrorState
            message={
              codesQuery.error instanceof Error ? codesQuery.error.message : "加载配对码列表失败"
            }
            onRetry={() => void codesQuery.refetch()}
          />
        ) : codesQuery.data.pairingCodes.length === 0 ? (
          <AdminEmptyState
            title="暂无配对码记录"
            description="目前没有匹配的 Agent 配对码或认领恢复码"
          />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[780px] border-collapse text-left text-[13px]">
                <thead>
                  <tr className="border-b border-black/[0.06] bg-black/[0.02] text-[11.5px] font-semibold text-[#687082] dark:border-white/[0.07] dark:bg-white/[0.02] dark:text-[#8E96AB]">
                    <th className="px-4 py-3">配对码</th>
                    <th className="px-3 py-3">签发主人</th>
                    <th className="px-3 py-3">状态</th>
                    <th className="px-3 py-3">绑定目标</th>
                    <th className="px-3 py-3">过期时间</th>
                    <th className="px-4 py-3 text-right">操作</th>
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
                          {CODE_LABEL[item.status]}
                        </AdminStatusPill>
                      </td>
                      <td className="px-3 py-3 text-xs text-[#3B414E] dark:text-[#B4BCD0]">
                        {item.autoJoinRoomName ? (
                          <span>入群：{item.autoJoinRoomName}</span>
                        ) : item.reclaimAgentId ? (
                          <span className="font-mono">认领：{item.reclaimAgentId}</span>
                        ) : (
                          <span className="text-[#939BAD] dark:text-[#63636B]">通用绑定</span>
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
                          吊销
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
        title={pendingRevoke ? `吊销配对码 ${pendingRevoke.code}` : "吊销配对码"}
        description="吊销后该配对码立即从存储移除，无法再用于接入新 Agent。"
        confirmLabel="确认吊销"
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
