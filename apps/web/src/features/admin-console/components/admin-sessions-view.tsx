/**
 * @module web/features/admin-console/sessions-view
 * @description 全平台人类 Web 登录会话监管视图（支持活跃/过期筛选、单条强制踢下线与批量清理过期会话）。
 */
import type { AdminSessionFilterStatus, AdminSessionItem, SessionId } from "@openhuddle/protocol";
import { useQuery } from "@tanstack/react-query";
import { Eraser, LogOut, Search, X } from "lucide-react";
import { useState } from "react";
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
import {
  AdminConfirmModal,
  AdminEmptyState,
  AdminErrorState,
  AdminPaginationBar,
  AdminStatusPill,
  AdminTableSkeleton,
  formatAdminDateTime,
} from "./admin-shared-ui.js";

const SESSION_STATUS_TABS: ReadonlyArray<SegmentedTabItem<AdminSessionFilterStatus>> = [
  { value: "active", label: "活跃会话" },
  { value: "expired", label: "已过期" },
  { value: "all", label: "全部" },
];

/**
 * 渲染登录会话管理视图。
 */
export function AdminSessionsView() {
  const [page, setPage] = useState<number>(1);
  const [status, setStatus] = useState<AdminSessionFilterStatus>("active");
  const [searchInput, setSearchInput] = useState<string>("");
  const [pendingRevoke, setPendingRevoke] = useState<AdminSessionItem | null>(null);

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
              items={SESSION_STATUS_TABS}
              size="sm"
              ariaLabel="按会话有效期筛选"
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
              placeholder="搜索用户邮箱、昵称或 ses_ ID…"
              aria-label="搜索登录会话"
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
          className="w-full sm:w-auto"
          isLoading={purgeMutation.isPending}
          leadingIcon={<Eraser className="h-3.5 w-3.5" />}
          onClick={() => purgeMutation.mutate()}
        >
          清理全部过期会话
        </AppButton>
      </div>

      <div className="oh-elevated-card overflow-hidden rounded-2xl">
        {sessionsQuery.isPending ? (
          <AdminTableSkeleton rows={6} />
        ) : sessionsQuery.isError || !sessionsQuery.data ? (
          <AdminErrorState
            message={
              sessionsQuery.error instanceof Error
                ? sessionsQuery.error.message
                : "加载会话列表失败"
            }
            onRetry={() => void sessionsQuery.refetch()}
          />
        ) : sessionsQuery.data.sessions.length === 0 ? (
          <AdminEmptyState
            title="暂无符合条件的登录会话"
            description="当前筛选维度下没有活跃或过期的 Web 会话记录"
          />
        ) : (
          <>
            <div className="overflow-x-auto overscroll-x-contain">
              <table className="w-full min-w-[740px] border-collapse text-left text-[13px]">
                <thead>
                  <tr className="border-b border-black/[0.06] bg-black/[0.02] text-[11.5px] font-semibold text-[#687082] dark:border-white/[0.07] dark:bg-white/[0.02] dark:text-[#8E96AB]">
                    <th className="px-4 py-3">所属用户</th>
                    <th className="px-3 py-3">会话标识</th>
                    <th className="px-3 py-3">状态</th>
                    <th className="px-3 py-3">签发时间</th>
                    <th className="px-3 py-3">过期时间</th>
                    <th className="px-4 py-3 text-right">操作</th>
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
                            <AdminStatusPill tone="accent">管理员</AdminStatusPill>
                          ) : null}
                          {item.userStatus === "suspended" ? (
                            <AdminStatusPill tone="danger">已封禁</AdminStatusPill>
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
                          {item.isExpired ? "已过期" : "活跃中"}
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
                          强制下线
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
        title="强制吊销登录会话"
        description={
          pendingRevoke
            ? `确定使 ${pendingRevoke.userDisplayName} (${pendingRevoke.userEmail}) 的会话 ${pendingRevoke.id} 立即失效吗？`
            : ""
        }
        confirmLabel="确认下线"
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
