/**
 * @module web/features/admin-console/users-view
 * @description 用户账号运营管理视图（检索筛选、资料修改、权限授撤、封禁/解封、强制下线及安全注销级联清理）。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 护栏前端显性化：对当前登录管理员本人及 `ADMIN_EMAILS` 环境变量锁定超管，主动禁用自我降权/封禁/删号按钮并给出原因说明。
 * 2. 一站式关联洞察：右侧详情抽屉聚合该用户的关联 Agent、所在群聊及登录会话，支持逐条或一键清理。
 */
import type { AdminUserItem, UserId, UserRole, UserStatus } from "@openhuddle/protocol";
import { useQuery } from "@tanstack/react-query";
import {
  Ban,
  Bot,
  CheckCircle2,
  KeyRound,
  Lock,
  MessagesSquare,
  Search,
  Shield,
  ShieldOff,
  Trash2,
  UserCheck,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import {
  AppButton,
  AppInput,
  AppSelect,
  type AppSelectOption,
  AppSheetDrawer,
  IconButton,
} from "../../../components/primitives/index.js";
import { getPlatformVisualMeta, getReachVisualMeta } from "../../../lib/format.js";
import {
  adminUserDetailQueryOptions,
  adminUsersQueryOptions,
  useAdminDeleteAgentMutation,
  useAdminDeleteUserMutation,
  useAdminRevokeSessionMutation,
  useAdminRevokeUserSessionsMutation,
  useAdminUpdateUserMutation,
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

type RoleFilterValue = "__all__" | UserRole;
type StatusFilterValue = "__all__" | UserStatus;

const ROLE_OPTIONS: ReadonlyArray<AppSelectOption<RoleFilterValue>> = [
  { value: "__all__", label: "全部角色" },
  { value: "admin", label: "管理员" },
  { value: "user", label: "普通用户" },
];

const STATUS_OPTIONS: ReadonlyArray<AppSelectOption<StatusFilterValue>> = [
  { value: "__all__", label: "全部状态" },
  { value: "active", label: "正常活跃" },
  { value: "suspended", label: "已封禁" },
];

/**
 * 单个用户全量档案与治理抽屉面板。
 */
function AdminUserDetailDrawerContent(props: {
  readonly userId: UserId;
  readonly currentUserId: UserId;
  readonly onDeletedClose: () => void;
}) {
  const detailQuery = useQuery(adminUserDetailQueryOptions(props.userId));
  const updateUserMutation = useAdminUpdateUserMutation();
  const deleteUserMutation = useAdminDeleteUserMutation();
  const revokeAllSessionsMutation = useAdminRevokeUserSessionsMutation();
  const revokeSessionMutation = useAdminRevokeSessionMutation();
  const deleteAgentMutation = useAdminDeleteAgentMutation();

  const [displayNameDraft, setDisplayNameDraft] = useState<string>("");
  const [suspendReasonDraft, setSuspendReasonDraft] = useState<string>("");
  const [suspendModalOpen, setSuspendModalOpen] = useState<boolean>(false);
  const [deleteModalOpen, setDeleteModalOpen] = useState<boolean>(false);

  const user = detailQuery.data?.user;
  useEffect(() => {
    if (user !== undefined) {
      setDisplayNameDraft(user.displayName);
      setSuspendReasonDraft(user.suspendedReason ?? "");
    }
  }, [user]);

  if (detailQuery.isPending) {
    return <AdminTableSkeleton rows={4} />;
  }

  if (detailQuery.isError || !detailQuery.data) {
    return (
      <AdminErrorState
        title="加载用户详情失败"
        message={detailQuery.error instanceof Error ? detailQuery.error.message : "请稍后重试"}
        onRetry={() => void detailQuery.refetch()}
      />
    );
  }

  const detail = detailQuery.data;
  const u = detail.user;
  const isSelf = u.id === props.currentUserId;
  const isProtectedAdmin = isSelf || u.isEnvPinnedAdmin;

  const handleSaveDisplayName = (): void => {
    const trimmed = displayNameDraft.trim();
    if (trimmed.length === 0 || trimmed === u.displayName) {
      return;
    }
    updateUserMutation.mutate({
      userId: u.id,
      body: { displayName: trimmed },
    });
  };

  const handleToggleRole = (): void => {
    const nextRole: UserRole = u.role === "admin" ? "user" : "admin";
    updateUserMutation.mutate({
      userId: u.id,
      body: { role: nextRole },
    });
  };

  const handleUnsuspend = (): void => {
    updateUserMutation.mutate({
      userId: u.id,
      body: { status: "active" },
    });
  };

  return (
    <div className="space-y-5 p-4 sm:p-5">
      {/* 1. 基础信息与状态徽章 */}
      <div className="rounded-2xl border border-black/[0.06] bg-black/[0.02] p-4 dark:border-white/[0.07] dark:bg-white/[0.03]">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <h3 className="truncate text-[15px] font-semibold text-[#111318] dark:text-[#ECEFF6]">
              {u.displayName}
            </h3>
            <p className="truncate text-xs text-[#687082] dark:text-[#8E96AB]">{u.email}</p>
            <p className="mt-1 font-mono text-[11px] text-[#939BAD] dark:text-[#63636B]">{u.id}</p>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {u.role === "admin" ? (
              <AdminStatusPill tone="accent">管理员</AdminStatusPill>
            ) : (
              <AdminStatusPill tone="neutral">普通用户</AdminStatusPill>
            )}
            {u.isEnvPinnedAdmin ? (
              <AdminStatusPill tone="info">
                <Lock className="mr-1 inline h-3 w-3" />
                环境变量超管
              </AdminStatusPill>
            ) : null}
            {u.status === "suspended" ? (
              <AdminStatusPill tone="danger">已封禁</AdminStatusPill>
            ) : (
              <AdminStatusPill tone="success">正常活跃</AdminStatusPill>
            )}
          </div>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-[#687082] sm:grid-cols-4 dark:text-[#8E96AB]">
          <div>
            <span className="block text-[11px]">注册时间</span>
            <strong className="font-mono text-[#111318] tabular-nums dark:text-[#ECEFF6]">
              {formatAdminDateTime(u.createdAtIso)}
            </strong>
          </div>
          <div>
            <span className="block text-[11px]">最近登录</span>
            <strong className="font-mono text-[#111318] tabular-nums dark:text-[#ECEFF6]">
              {formatAdminDateTime(u.lastLoginAtIso)}
            </strong>
          </div>
          <div>
            <span className="block text-[11px]">Agent / 建群</span>
            <strong className="font-mono text-[#111318] tabular-nums dark:text-[#ECEFF6]">
              {u.stats.agentCount} / {u.stats.ownedRoomCount}
            </strong>
          </div>
          <div>
            <span className="block text-[11px]">活跃会话 / 消息</span>
            <strong className="font-mono text-[#111318] tabular-nums dark:text-[#ECEFF6]">
              {u.stats.activeSessionCount} / {u.stats.messageCount}
            </strong>
          </div>
        </div>

        {u.status === "suspended" ? (
          <div className="mt-3 rounded-xl border border-[#E5484D]/25 bg-[#E5484D]/8 px-3 py-2 text-xs text-[#991B1B] dark:border-[#F05252]/30 dark:bg-[#F05252]/12 dark:text-[#FCA5A5]">
            封禁时间：{formatAdminDateTime(u.suspendedAtIso)}
            {u.suspendedReason ? ` · 原因：${u.suspendedReason}` : ""}
          </div>
        ) : null}
      </div>

      {/* 2. 昵称修改与角色权限控制 */}
      <div className="space-y-3 rounded-2xl border border-black/[0.06] p-4 dark:border-white/[0.07]">
        <h4 className="text-xs font-semibold tracking-wide text-[#687082] uppercase dark:text-[#8E96AB]">
          账号资料与权限治理
        </h4>

        <div className="flex items-center gap-2">
          <AppInput
            size="sm"
            containerClassName="min-w-0 flex-1"
            value={displayNameDraft}
            onChange={(e) => setDisplayNameDraft(e.target.value)}
            placeholder="输入用户展示昵称"
            aria-label="修改用户展示昵称"
          />
          <AppButton
            variant="secondary"
            size="sm"
            className="shrink-0 whitespace-nowrap"
            disabled={
              displayNameDraft.trim().length === 0 || displayNameDraft.trim() === u.displayName
            }
            isLoading={updateUserMutation.isPending}
            onClick={handleSaveDisplayName}
          >
            保存昵称
          </AppButton>
        </div>

        <div className="flex flex-wrap items-center gap-2 pt-1">
          <AppButton
            variant={u.role === "admin" ? "secondary" : "primary"}
            size="sm"
            disabled={u.role === "admin" && isProtectedAdmin}
            isLoading={updateUserMutation.isPending}
            leadingIcon={
              u.role === "admin" ? (
                <ShieldOff className="h-3.5 w-3.5" />
              ) : (
                <Shield className="h-3.5 w-3.5" />
              )
            }
            onClick={handleToggleRole}
          >
            {u.role === "admin" ? "撤销管理员权限" : "授予管理员权限"}
          </AppButton>

          {u.status === "suspended" ? (
            <AppButton
              variant="secondary"
              size="sm"
              isLoading={updateUserMutation.isPending}
              leadingIcon={<CheckCircle2 className="h-3.5 w-3.5 text-[#16A34A]" />}
              onClick={handleUnsuspend}
            >
              解除账号封禁
            </AppButton>
          ) : (
            <AppButton
              variant="dangerSoft"
              size="sm"
              disabled={isProtectedAdmin}
              leadingIcon={<Ban className="h-3.5 w-3.5" />}
              onClick={() => setSuspendModalOpen(true)}
            >
              封禁账号
            </AppButton>
          )}

          <AppButton
            variant="secondary"
            size="sm"
            disabled={u.stats.activeSessionCount === 0}
            isLoading={revokeAllSessionsMutation.isPending}
            leadingIcon={<KeyRound className="h-3.5 w-3.5" />}
            onClick={() => revokeAllSessionsMutation.mutate(u.id)}
          >
            踢下线全部会话
          </AppButton>

          <AppButton
            variant="danger"
            size="sm"
            disabled={isProtectedAdmin}
            leadingIcon={<Trash2 className="h-3.5 w-3.5" />}
            onClick={() => setDeleteModalOpen(true)}
          >
            彻底删除用户
          </AppButton>
        </div>

        {isProtectedAdmin ? (
          <p className="text-[11.5px] text-[#687082] dark:text-[#7D869C]">
            {isSelf
              ? "安全护栏已启用：禁止对当前登录的管理员自身执行降权、封禁或删除操作。"
              : "安全护栏已启用：该用户受服务端 ADMIN_EMAILS 环境变量白名单锁定，请先调整配置后再操作。"}
          </p>
        ) : null}
      </div>

      {/* 3. 名下个人 Agent 列表 */}
      <div className="space-y-2.5">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-[#687082] dark:text-[#8E96AB]">
          <Bot className="h-3.5 w-3.5" />
          <span>名下绑定 Agent ({detail.agents.length})</span>
        </div>
        {detail.agents.length === 0 ? (
          <p className="rounded-xl bg-black/[0.025] px-3 py-3 text-xs text-[#939BAD] dark:bg-white/[0.03] dark:text-[#63636B]">
            尚未绑定个人 Agent
          </p>
        ) : (
          <ul className="space-y-1.5">
            {detail.agents.map((agt) => {
              const pMeta = getPlatformVisualMeta(agt.platform);
              const rMeta = getReachVisualMeta(agt.reach);
              return (
                <li
                  key={agt.id}
                  className="flex items-center justify-between gap-2 rounded-xl border border-black/[0.06] px-3 py-2 text-xs dark:border-white/[0.07]"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-semibold text-[#111318] dark:text-[#ECEFF6]">
                        {agt.displayName}
                      </span>
                      <AdminStatusPill dotClass={rMeta.dotClass}>{pMeta.label}</AdminStatusPill>
                    </div>
                    <p className="mt-0.5 truncate font-mono text-[11px] text-[#939BAD] dark:text-[#63636B]">
                      {agt.id} · 最近心跳 {formatAdminDateTime(agt.lastSeenAtIso)}
                    </p>
                  </div>
                  <AppButton
                    variant="dangerSoft"
                    size="xs"
                    isLoading={deleteAgentMutation.isPending}
                    onClick={() => deleteAgentMutation.mutate(agt.id)}
                  >
                    吊销
                  </AppButton>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* 4. 已加入群聊 */}
      <div className="space-y-2.5">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-[#687082] dark:text-[#8E96AB]">
          <MessagesSquare className="h-3.5 w-3.5" />
          <span>参与的群聊房间 ({detail.rooms.length})</span>
        </div>
        {detail.rooms.length === 0 ? (
          <p className="rounded-xl bg-black/[0.025] px-3 py-3 text-xs text-[#939BAD] dark:bg-white/[0.03] dark:text-[#63636B]">
            暂未加入任何群聊
          </p>
        ) : (
          <ul className="space-y-1.5">
            {detail.rooms.map((rm) => (
              <li
                key={rm.id}
                className="flex items-center justify-between gap-2 rounded-xl border border-black/[0.06] px-3 py-2 text-xs dark:border-white/[0.07]"
              >
                <div className="min-w-0">
                  <span className="block truncate font-semibold text-[#111318] dark:text-[#ECEFF6]">
                    {rm.name}
                  </span>
                  <span className="block font-mono text-[11px] text-[#939BAD] dark:text-[#63636B]">
                    {rm.id} · 最新序号 #{rm.lastSeq}
                  </span>
                </div>
                <AdminStatusPill tone={rm.isRoomOwner ? "accent" : "neutral"}>
                  {rm.isRoomOwner ? "群主" : rm.memberRole}
                </AdminStatusPill>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* 5. 登录会话 */}
      <div className="space-y-2.5">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-[#687082] dark:text-[#8E96AB]">
          <KeyRound className="h-3.5 w-3.5" />
          <span>最近登录会话 ({detail.sessions.length})</span>
        </div>
        {detail.sessions.length === 0 ? (
          <p className="rounded-xl bg-black/[0.025] px-3 py-3 text-xs text-[#939BAD] dark:bg-white/[0.03] dark:text-[#63636B]">
            暂无登录会话记录
          </p>
        ) : (
          <ul className="space-y-1.5">
            {detail.sessions.map((ses) => (
              <li
                key={ses.id}
                className="flex items-center justify-between gap-2 rounded-xl border border-black/[0.06] px-3 py-2 text-xs dark:border-white/[0.07]"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate font-mono text-[11.5px] font-medium text-[#111318] dark:text-[#ECEFF6]">
                      {ses.id}
                    </span>
                    <AdminStatusPill tone={ses.isExpired ? "warning" : "success"}>
                      {ses.isExpired ? "已过期" : "活跃中"}
                    </AdminStatusPill>
                  </div>
                  <p className="mt-0.5 text-[11px] text-[#687082] dark:text-[#7D869C]">
                    创建 {formatAdminDateTime(ses.createdAtIso)} · 过期{" "}
                    {formatAdminDateTime(ses.expiresAtIso)}
                  </p>
                </div>
                <AppButton
                  variant="dangerSoft"
                  size="xs"
                  isLoading={revokeSessionMutation.isPending}
                  onClick={() => revokeSessionMutation.mutate(ses.id)}
                >
                  下线
                </AppButton>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* 封禁账号弹窗 */}
      <AdminConfirmModal
        open={suspendModalOpen}
        title={`封禁账号「${u.displayName}」`}
        description="封禁后将立即注销其全部 Web 登录会话，并同步阻断该用户名下所有 Agent 访问平台。"
        confirmLabel="确认封禁"
        isPending={updateUserMutation.isPending}
        onClose={() => setSuspendModalOpen(false)}
        onConfirm={() => {
          updateUserMutation.mutate(
            {
              userId: u.id,
              body: {
                status: "suspended",
                ...(suspendReasonDraft.trim().length > 0
                  ? { suspendedReason: suspendReasonDraft.trim() }
                  : {}),
              },
            },
            {
              onSuccess: () => setSuspendModalOpen(false),
            },
          );
        }}
      >
        <div className="space-y-2.5">
          <p className="text-xs leading-relaxed text-[#3B414E] dark:text-[#B4BCD0]">
            封禁后该用户无法登录或申请验证码，其绑定的全部个人 Agent 也会即时失效（返回{" "}
            <code className="font-mono">403 ACCOUNT_SUSPENDED</code>）。
          </p>
          <AppInput
            size="md"
            value={suspendReasonDraft}
            onChange={(e) => setSuspendReasonDraft(e.target.value)}
            placeholder="可选：填写封禁原因（将写入审计日志与账号备注）"
            aria-label="封禁原因"
          />
        </div>
      </AdminConfirmModal>

      {/* 彻底删除用户弹窗 */}
      <AdminConfirmModal
        open={deleteModalOpen}
        title={`彻底删除用户「${u.displayName}」`}
        description="该操作不可恢复，将永久销毁账号、个人 Agent、登录会话、其创建的群聊及跨房历史发言。"
        confirmLabel="确认永久删除"
        isPending={deleteUserMutation.isPending}
        onClose={() => setDeleteModalOpen(false)}
        onConfirm={() => {
          deleteUserMutation.mutate(u.id, {
            onSuccess: () => {
              setDeleteModalOpen(false);
              props.onDeletedClose();
            },
          });
        }}
      />
    </div>
  );
}

/** `AdminUsersView` 入参属性 */
export interface AdminUsersViewProps {
  readonly currentUserId: UserId;
  readonly initialSelectedUserId?: UserId | null | undefined;
  readonly onClearInitialSelection?: (() => void) | undefined;
}

/**
 * 渲染全平台用户账号管理表格与详情抽屉。
 */
export function AdminUsersView(props: AdminUsersViewProps) {
  const [page, setPage] = useState<number>(1);
  const [searchInput, setSearchInput] = useState<string>("");
  const [roleFilter, setRoleFilter] = useState<RoleFilterValue>("__all__");
  const [statusFilter, setStatusFilter] = useState<StatusFilterValue>("__all__");
  const [selectedUserId, setSelectedUserId] = useState<UserId | null>(
    props.initialSelectedUserId ?? null,
  );

  useEffect(() => {
    if (props.initialSelectedUserId) {
      setSelectedUserId(props.initialSelectedUserId);
      props.onClearInitialSelection?.();
    }
  }, [props.initialSelectedUserId, props.onClearInitialSelection]);

  const query = {
    page,
    pageSize: 15,
    ...(searchInput.trim().length > 0 ? { search: searchInput.trim() } : {}),
    ...(roleFilter !== "__all__" ? { role: roleFilter } : {}),
    ...(statusFilter !== "__all__" ? { status: statusFilter } : {}),
  };

  const usersQuery = useQuery(adminUsersQueryOptions(query));

  return (
    <div className="space-y-4">
      {/* 筛选工具条 */}
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
            placeholder="搜索用户邮箱、昵称或 usr_ ID…"
            aria-label="搜索用户"
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

        <div className="w-[calc(50%-0.3125rem)] sm:w-36">
          <AppSelect
            size="sm"
            value={roleFilter}
            onValueChange={(val) => {
              setRoleFilter(val);
              setPage(1);
            }}
            options={ROLE_OPTIONS}
            ariaLabel="按角色筛选"
          />
        </div>

        <div className="w-[calc(50%-0.3125rem)] sm:w-36">
          <AppSelect
            size="sm"
            value={statusFilter}
            onValueChange={(val) => {
              setStatusFilter(val);
              setPage(1);
            }}
            options={STATUS_OPTIONS}
            ariaLabel="按状态筛选"
          />
        </div>
      </div>

      {/* 用户数据表格卡片 */}
      <div className="oh-elevated-card overflow-hidden rounded-2xl">
        {usersQuery.isPending ? (
          <AdminTableSkeleton rows={6} />
        ) : usersQuery.isError || !usersQuery.data ? (
          <AdminErrorState
            message={
              usersQuery.error instanceof Error ? usersQuery.error.message : "加载用户列表失败"
            }
            onRetry={() => void usersQuery.refetch()}
          />
        ) : usersQuery.data.users.length === 0 ? (
          <AdminEmptyState
            title="没有符合条件的用户"
            description="尝试调整搜索关键词或角色/状态筛选条件"
          />
        ) : (
          <>
            <div className="overflow-x-auto overscroll-x-contain">
              <table className="w-full min-w-[780px] border-collapse text-left text-[13px]">
                <thead>
                  <tr className="border-b border-black/[0.06] bg-black/[0.02] text-[11.5px] font-semibold text-[#687082] dark:border-white/[0.07] dark:bg-white/[0.02] dark:text-[#8E96AB]">
                    <th className="px-4 py-3">用户身份</th>
                    <th className="px-3 py-3">权限角色</th>
                    <th className="px-3 py-3">账号状态</th>
                    <th className="px-3 py-3 text-right">Agent / 建群 / 消息</th>
                    <th className="px-3 py-3 text-right">活跃会话</th>
                    <th className="px-3 py-3">最近登录</th>
                    <th className="px-4 py-3 text-right">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-black/[0.05] dark:divide-white/[0.06]">
                  {usersQuery.data.users.map((item: AdminUserItem) => (
                    <tr
                      key={item.id}
                      className="transition-colors hover:bg-black/[0.02] dark:hover:bg-white/[0.025]"
                    >
                      <td className="px-4 py-3">
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className="font-semibold text-[#111318] dark:text-[#ECEFF6]">
                              {item.displayName}
                            </span>
                            {item.id === props.currentUserId ? (
                              <AdminStatusPill tone="info">当前登录</AdminStatusPill>
                            ) : null}
                          </div>
                          <div className="text-xs text-[#687082] dark:text-[#8E96AB]">
                            {item.email}
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-3">
                        <div className="flex flex-wrap items-center gap-1">
                          <AdminStatusPill tone={item.role === "admin" ? "accent" : "neutral"}>
                            {item.role === "admin" ? "管理员" : "普通用户"}
                          </AdminStatusPill>
                          {item.isEnvPinnedAdmin ? (
                            <AdminStatusPill tone="info">白名单</AdminStatusPill>
                          ) : null}
                        </div>
                      </td>
                      <td className="px-3 py-3">
                        <AdminStatusPill tone={item.status === "suspended" ? "danger" : "success"}>
                          {item.status === "suspended" ? "已封禁" : "正常"}
                        </AdminStatusPill>
                      </td>
                      <td className="px-3 py-3 text-right font-mono text-xs text-[#3B414E] tabular-nums dark:text-[#B4BCD0]">
                        {item.stats.agentCount} / {item.stats.ownedRoomCount} /{" "}
                        {item.stats.messageCount}
                      </td>
                      <td className="px-3 py-3 text-right font-mono text-xs tabular-nums">
                        <span
                          className={
                            item.stats.activeSessionCount > 0
                              ? "font-semibold text-[#16A34A] dark:text-[#34D399]"
                              : "text-[#939BAD] dark:text-[#63636B]"
                          }
                        >
                          {item.stats.activeSessionCount}
                        </span>
                      </td>
                      <td className="px-3 py-3 font-mono text-xs text-[#687082] tabular-nums dark:text-[#8E96AB]">
                        {formatAdminDateTime(item.lastLoginAtIso)}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <AppButton
                          variant="secondary"
                          size="xs"
                          leadingIcon={<UserCheck className="h-3 w-3" />}
                          onClick={() => setSelectedUserId(item.id)}
                        >
                          管理
                        </AppButton>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <AdminPaginationBar pagination={usersQuery.data.pagination} onPageChange={setPage} />
          </>
        )}
      </div>

      {/* 右侧用户详情与治理抽屉 */}
      <AppSheetDrawer
        open={selectedUserId !== null}
        onOpenChange={(open) => {
          if (!open) {
            setSelectedUserId(null);
          }
        }}
        title="用户账号治理详情"
        subtitle="权限切换、会话下线、封禁控制与级联注销"
        side="right"
        className="sm:w-[min(94vw,660px)]"
      >
        {selectedUserId !== null ? (
          <AdminUserDetailDrawerContent
            userId={selectedUserId}
            currentUserId={props.currentUserId}
            onDeletedClose={() => setSelectedUserId(null)}
          />
        ) : null}
      </AppSheetDrawer>
    </div>
  );
}
