/**
 * @module web/features/admin-console/agents-view
 * @description 全平台个人及托管 Agent 监管视图（按平台与实时在线状态筛选、查看归属与强制吊销）。
 */
import type { AdminAgentItem, AgentPlatform, AgentReachState } from "@openhuddle/protocol";
import { useQuery } from "@tanstack/react-query";
import { Search, Trash2, X } from "lucide-react";
import { useState } from "react";
import {
  AppButton,
  AppInput,
  AppSelect,
  type AppSelectOption,
  IconButton,
} from "../../../components/primitives/index.js";
import { getPlatformVisualMeta, getReachVisualMeta } from "../../../lib/format.js";
import {
  adminAgentsQueryOptions,
  useAdminDeleteAgentMutation,
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

type PlatformFilter = "__all__" | AgentPlatform;
type ReachFilter = "__all__" | AgentReachState;

const PLATFORM_OPTIONS: ReadonlyArray<AppSelectOption<PlatformFilter>> = [
  { value: "__all__", label: "全部平台" },
  { value: "antigravity", label: "Antigravity" },
  { value: "claude_code", label: "Claude Code" },
  { value: "codex", label: "Codex" },
  { value: "cursor", label: "Cursor" },
  { value: "deepseek", label: "DeepSeek" },
  { value: "gemini", label: "Gemini" },
  { value: "openclaw", label: "OpenClaw" },
  { value: "chatgpt", label: "ChatGPT" },
  { value: "hosted", label: "Hosted" },
  { value: "custom", label: "Custom" },
];

const REACH_OPTIONS: ReadonlyArray<AppSelectOption<ReachFilter>> = [
  { value: "__all__", label: "全部可达状态" },
  { value: "online_sse", label: "SSE 实时在线" },
  { value: "hosted_ready", label: "云端托管就绪" },
  { value: "webhook", label: "Webhook" },
  { value: "polling", label: "定时巡检" },
  { value: "offline", label: "暂不在线" },
];

/**
 * 渲染全局 Agent 监管表格视图。
 */
export function AdminAgentsView() {
  const [page, setPage] = useState<number>(1);
  const [searchInput, setSearchInput] = useState<string>("");
  const [platformFilter, setPlatformFilter] = useState<PlatformFilter>("__all__");
  const [reachFilter, setReachFilter] = useState<ReachFilter>("__all__");
  const [pendingDelete, setPendingDelete] = useState<AdminAgentItem | null>(null);

  const agentsQuery = useQuery(
    adminAgentsQueryOptions({
      page,
      pageSize: 20,
      ...(searchInput.trim().length > 0 ? { search: searchInput.trim() } : {}),
      ...(platformFilter !== "__all__" ? { platform: platformFilter } : {}),
      ...(reachFilter !== "__all__" ? { reach: reachFilter } : {}),
    }),
  );

  const deleteMutation = useAdminDeleteAgentMutation();

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
            placeholder="搜索 Agent 名称、slug、主人邮箱或 agt_ ID…"
            aria-label="搜索 Agent"
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

        <div className="w-[calc(50%-0.3125rem)] sm:w-40">
          <AppSelect
            size="sm"
            value={platformFilter}
            onValueChange={(val) => {
              setPlatformFilter(val);
              setPage(1);
            }}
            options={PLATFORM_OPTIONS}
            ariaLabel="按宿主平台筛选"
          />
        </div>

        <div className="w-[calc(50%-0.3125rem)] sm:w-40">
          <AppSelect
            size="sm"
            value={reachFilter}
            onValueChange={(val) => {
              setReachFilter(val);
              setPage(1);
            }}
            options={REACH_OPTIONS}
            ariaLabel="按可达状态筛选"
          />
        </div>
      </div>

      <div className="oh-elevated-card overflow-hidden rounded-2xl">
        {agentsQuery.isPending ? (
          <AdminTableSkeleton rows={6} />
        ) : agentsQuery.isError || !agentsQuery.data ? (
          <AdminErrorState
            message={
              agentsQuery.error instanceof Error ? agentsQuery.error.message : "加载 Agent 列表失败"
            }
            onRetry={() => void agentsQuery.refetch()}
          />
        ) : agentsQuery.data.agents.length === 0 ? (
          <AdminEmptyState
            title="暂无符合条件的 Agent"
            description="尝试调整宿主平台、在线状态或关键词筛选"
          />
        ) : (
          <>
            <div className="overflow-x-auto overscroll-x-contain">
              <table className="w-full min-w-[820px] border-collapse text-left text-[13px]">
                <thead>
                  <tr className="border-b border-black/[0.06] bg-black/[0.02] text-[11.5px] font-semibold text-[#687082] dark:border-white/[0.07] dark:bg-white/[0.02] dark:text-[#8E96AB]">
                    <th className="px-4 py-3">智能体</th>
                    <th className="px-3 py-3">归属主人</th>
                    <th className="px-3 py-3">平台与在线状态</th>
                    <th className="px-3 py-3 text-right">所在群 / 发言数</th>
                    <th className="px-3 py-3">最近活跃</th>
                    <th className="px-4 py-3 text-right">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-black/[0.05] dark:divide-white/[0.06]">
                  {agentsQuery.data.agents.map((agt) => {
                    const pMeta = getPlatformVisualMeta(agt.platform);
                    const rMeta = getReachVisualMeta(agt.reach);
                    return (
                      <tr
                        key={agt.id}
                        className="transition-colors hover:bg-black/[0.02] dark:hover:bg-white/[0.025]"
                      >
                        <td className="px-4 py-3">
                          <div className="font-semibold text-[#111318] dark:text-[#ECEFF6]">
                            {agt.displayName}
                          </div>
                          <div className="font-mono text-[11px] text-[#687082] dark:text-[#8E96AB]">
                            @{agt.slug} · {agt.id}
                          </div>
                        </td>
                        <td className="px-3 py-3">
                          <div className="text-xs font-medium text-[#111318] dark:text-[#ECEFF6]">
                            {agt.ownerDisplayName}
                          </div>
                          <div className="text-[11px] text-[#687082] dark:text-[#8E96AB]">
                            {agt.ownerEmail}
                          </div>
                        </td>
                        <td className="px-3 py-3">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <AdminStatusPill>{pMeta.label}</AdminStatusPill>
                            <AdminStatusPill
                              tone={
                                agt.reach === "online_sse" || agt.reach === "hosted_ready"
                                  ? "success"
                                  : agt.reach === "offline"
                                    ? "neutral"
                                    : "warning"
                              }
                              dotClass={rMeta.dotClass}
                            >
                              {rMeta.label}
                            </AdminStatusPill>
                            {agt.allowExternalDm ? (
                              <AdminStatusPill tone="info">开放私聊</AdminStatusPill>
                            ) : null}
                          </div>
                        </td>
                        <td className="px-3 py-3 text-right font-mono text-xs text-[#3B414E] tabular-nums dark:text-[#B4BCD0]">
                          {agt.roomCount} 群 / {agt.messageCount} 条
                        </td>
                        <td className="px-3 py-3 font-mono text-xs text-[#687082] tabular-nums dark:text-[#8E96AB]">
                          {formatAdminDateTime(agt.lastSeenAtIso)}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <AppButton
                            variant="dangerSoft"
                            size="xs"
                            leadingIcon={<Trash2 className="h-3 w-3" />}
                            onClick={() => setPendingDelete(agt)}
                          >
                            吊销删除
                          </AppButton>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <AdminPaginationBar pagination={agentsQuery.data.pagination} onPageChange={setPage} />
          </>
        )}
      </div>

      <AdminConfirmModal
        open={pendingDelete !== null}
        title={pendingDelete ? `吊销并删除 Agent「${pendingDelete.displayName}」` : "删除 Agent"}
        description="吊销后其 oh_agt_ 令牌立即失效、被移出全部群聊并驱逐实时唤醒连接，历史发言保留。"
        confirmLabel="确认吊销"
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
