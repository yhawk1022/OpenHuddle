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
import { useEffect, useMemo, useState } from "react";
import {
  AppButton,
  AppInput,
  AppSelect,
  type AppSelectOption,
  AppSheetDrawer,
  IconButton,
} from "../../../components/primitives/index.js";
import { getPlatformVisualMeta, getReachVisualMeta } from "../../../lib/format.js";
import { formatNumber } from "../../../lib/i18n/index.js";
import {
  adminUserDetailQueryOptions,
  adminUsersQueryOptions,
  useAdminDeleteAgentMutation,
  useAdminDeleteUserMutation,
  useAdminRevokeSessionMutation,
  useAdminRevokeUserSessionsMutation,
  useAdminUpdateUserMutation,
} from "../api/admin-console.queries.js";
import { getRoomMemberRoleLabel, resolveAdminErrorMessage, useAdminI18n } from "../i18n/index.js";
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

/**
 * 单个用户全量档案与治理抽屉面板。
 */
function AdminUserDetailDrawerContent(props: {
  readonly userId: UserId;
  readonly currentUserId: UserId;
  readonly onDeletedClose: () => void;
}) {
  const { locale, t } = useAdminI18n();
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
        title={t("users.detail.errorTitle")}
        message={resolveAdminErrorMessage(
          detailQuery.error,
          t("shared.error.tryAgainLater"),
          locale,
        )}
        onRetry={() => void detailQuery.refetch()}
      />
    );
  }

  const detail = detailQuery.data;
  const u = detail.user;
  const isSelf = u.id === props.currentUserId;
  const isProtectedAdmin = isSelf || u.isEnvPinnedAdmin;
  const fmt = (value: number): string => formatNumber(value, undefined, locale);

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
              <AdminStatusPill tone="accent">{t("common.role.admin")}</AdminStatusPill>
            ) : (
              <AdminStatusPill tone="neutral">{t("common.role.user")}</AdminStatusPill>
            )}
            {u.isEnvPinnedAdmin ? (
              <AdminStatusPill tone="info">
                <Lock className="mr-1 inline h-3 w-3" />
                {t("users.badge.envPinned")}
              </AdminStatusPill>
            ) : null}
            {u.status === "suspended" ? (
              <AdminStatusPill tone="danger">{t("common.status.suspended")}</AdminStatusPill>
            ) : (
              <AdminStatusPill tone="success">{t("common.status.active")}</AdminStatusPill>
            )}
          </div>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-[#687082] sm:grid-cols-4 dark:text-[#8E96AB]">
          <div>
            <span className="block text-[11px]">{t("users.detail.registeredAt")}</span>
            <strong className="font-mono text-[#111318] tabular-nums dark:text-[#ECEFF6]">
              {formatAdminDateTime(u.createdAtIso)}
            </strong>
          </div>
          <div>
            <span className="block text-[11px]">{t("users.detail.lastLogin")}</span>
            <strong className="font-mono text-[#111318] tabular-nums dark:text-[#ECEFF6]">
              {formatAdminDateTime(u.lastLoginAtIso)}
            </strong>
          </div>
          <div>
            <span className="block text-[11px]">{t("users.detail.agentsRooms")}</span>
            <strong className="font-mono text-[#111318] tabular-nums dark:text-[#ECEFF6]">
              {fmt(u.stats.agentCount)} / {fmt(u.stats.ownedRoomCount)}
            </strong>
          </div>
          <div>
            <span className="block text-[11px]">{t("users.detail.sessionsMessages")}</span>
            <strong className="font-mono text-[#111318] tabular-nums dark:text-[#ECEFF6]">
              {fmt(u.stats.activeSessionCount)} / {fmt(u.stats.messageCount)}
            </strong>
          </div>
        </div>

        {u.status === "suspended" ? (
          <div className="mt-3 rounded-xl border border-[#E5484D]/25 bg-[#E5484D]/8 px-3 py-2 text-xs text-[#991B1B] dark:border-[#F05252]/30 dark:bg-[#F05252]/12 dark:text-[#FCA5A5]">
            {u.suspendedReason
              ? t("users.detail.suspendedWithReason", {
                  time: formatAdminDateTime(u.suspendedAtIso),
                  reason: u.suspendedReason,
                })
              : t("users.detail.suspendedAt", { time: formatAdminDateTime(u.suspendedAtIso) })}
          </div>
        ) : null}
      </div>

      {/* 2. 昵称修改与角色权限控制 */}
      <div className="space-y-3 rounded-2xl border border-black/[0.06] p-4 dark:border-white/[0.07]">
        <h4 className="text-xs font-semibold tracking-wide text-[#687082] uppercase dark:text-[#8E96AB]">
          {t("users.detail.governanceHeading")}
        </h4>

        <div className="flex items-center gap-2">
          <AppInput
            size="sm"
            containerClassName="min-w-0 flex-1"
            value={displayNameDraft}
            onChange={(e) => setDisplayNameDraft(e.target.value)}
            placeholder={t("users.detail.displayNamePlaceholder")}
            aria-label={t("users.detail.displayNameAria")}
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
            {t("users.detail.saveDisplayName")}
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
            {u.role === "admin" ? t("users.detail.revokeAdmin") : t("users.detail.grantAdmin")}
          </AppButton>

          {u.status === "suspended" ? (
            <AppButton
              variant="secondary"
              size="sm"
              isLoading={updateUserMutation.isPending}
              leadingIcon={<CheckCircle2 className="h-3.5 w-3.5 text-[#16A34A]" />}
              onClick={handleUnsuspend}
            >
              {t("users.detail.unsuspend")}
            </AppButton>
          ) : (
            <AppButton
              variant="dangerSoft"
              size="sm"
              disabled={isProtectedAdmin}
              leadingIcon={<Ban className="h-3.5 w-3.5" />}
              onClick={() => setSuspendModalOpen(true)}
            >
              {t("users.detail.suspend")}
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
            {t("users.detail.revokeAllSessions")}
          </AppButton>

          <AppButton
            variant="danger"
            size="sm"
            disabled={isProtectedAdmin}
            leadingIcon={<Trash2 className="h-3.5 w-3.5" />}
            onClick={() => setDeleteModalOpen(true)}
          >
            {t("users.detail.deleteUser")}
          </AppButton>
        </div>

        {isProtectedAdmin ? (
          <p className="text-[11.5px] text-[#687082] dark:text-[#7D869C]">
            {isSelf ? t("users.detail.guardrailSelf") : t("users.detail.guardrailEnv")}
          </p>
        ) : null}
      </div>

      {/* 3. 名下个人 Agent 列表 */}
      <div className="space-y-2.5">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-[#687082] dark:text-[#8E96AB]">
          <Bot className="h-3.5 w-3.5" />
          <span>{t("users.detail.agentsHeading", { count: fmt(detail.agents.length) })}</span>
        </div>
        {detail.agents.length === 0 ? (
          <p className="rounded-xl bg-black/[0.025] px-3 py-3 text-xs text-[#939BAD] dark:bg-white/[0.03] dark:text-[#63636B]">
            {t("users.detail.agentsEmpty")}
          </p>
        ) : (
          <ul className="space-y-1.5">
            {detail.agents.map((agt) => {
              const pMeta = getPlatformVisualMeta(agt.platform, locale);
              const rMeta = getReachVisualMeta(agt.reach, locale);
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
                      {t("users.detail.agentLastSeen", {
                        id: agt.id,
                        time: formatAdminDateTime(agt.lastSeenAtIso),
                      })}
                    </p>
                  </div>
                  <AppButton
                    variant="dangerSoft"
                    size="xs"
                    isLoading={deleteAgentMutation.isPending}
                    onClick={() => deleteAgentMutation.mutate(agt.id)}
                  >
                    {t("shared.action.revoke")}
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
          <span>{t("users.detail.roomsHeading", { count: fmt(detail.rooms.length) })}</span>
        </div>
        {detail.rooms.length === 0 ? (
          <p className="rounded-xl bg-black/[0.025] px-3 py-3 text-xs text-[#939BAD] dark:bg-white/[0.03] dark:text-[#63636B]">
            {t("users.detail.roomsEmpty")}
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
                    {t("users.detail.roomMeta", { id: rm.id, seq: rm.lastSeq })}
                  </span>
                </div>
                <AdminStatusPill tone={rm.isRoomOwner ? "accent" : "neutral"}>
                  {rm.isRoomOwner
                    ? t("common.role.owner")
                    : getRoomMemberRoleLabel(rm.memberRole, t)}
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
          <span>{t("users.detail.sessionsHeading", { count: fmt(detail.sessions.length) })}</span>
        </div>
        {detail.sessions.length === 0 ? (
          <p className="rounded-xl bg-black/[0.025] px-3 py-3 text-xs text-[#939BAD] dark:bg-white/[0.03] dark:text-[#63636B]">
            {t("users.detail.sessionsEmpty")}
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
                      {ses.isExpired
                        ? t("common.status.expired")
                        : t("common.status.sessionActive")}
                    </AdminStatusPill>
                  </div>
                  <p className="mt-0.5 text-[11px] text-[#687082] dark:text-[#7D869C]">
                    {t("users.detail.sessionMeta", {
                      created: formatAdminDateTime(ses.createdAtIso),
                      expires: formatAdminDateTime(ses.expiresAtIso),
                    })}
                  </p>
                </div>
                <AppButton
                  variant="dangerSoft"
                  size="xs"
                  isLoading={revokeSessionMutation.isPending}
                  onClick={() => revokeSessionMutation.mutate(ses.id)}
                >
                  {t("users.detail.sessionRevoke")}
                </AppButton>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* 封禁账号弹窗 */}
      <AdminConfirmModal
        open={suspendModalOpen}
        title={t("users.modal.suspendTitle", { name: u.displayName })}
        description={t("users.modal.suspendDescription")}
        confirmLabel={t("users.modal.suspendConfirm")}
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
            {t("users.modal.suspendBodyPrefix")}
            <code className="font-mono">403 ACCOUNT_SUSPENDED</code>
            {t("users.modal.suspendBodySuffix")}
          </p>
          <AppInput
            size="md"
            value={suspendReasonDraft}
            onChange={(e) => setSuspendReasonDraft(e.target.value)}
            placeholder={t("users.modal.suspendReasonPlaceholder")}
            aria-label={t("users.modal.suspendReasonAria")}
          />
        </div>
      </AdminConfirmModal>

      {/* 彻底删除用户弹窗 */}
      <AdminConfirmModal
        open={deleteModalOpen}
        title={t("users.modal.deleteTitle", { name: u.displayName })}
        description={t("users.modal.deleteDescription")}
        confirmLabel={t("users.modal.deleteConfirm")}
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
  const { locale, t } = useAdminI18n();
  const [page, setPage] = useState<number>(1);
  const [searchInput, setSearchInput] = useState<string>("");
  const [roleFilter, setRoleFilter] = useState<RoleFilterValue>("__all__");
  const [statusFilter, setStatusFilter] = useState<StatusFilterValue>("__all__");
  const [selectedUserId, setSelectedUserId] = useState<UserId | null>(
    props.initialSelectedUserId ?? null,
  );

  const roleOptions = useMemo<ReadonlyArray<AppSelectOption<RoleFilterValue>>>(
    () => [
      { value: "__all__", label: t("users.filter.allRoles") },
      { value: "admin", label: t("common.role.admin") },
      { value: "user", label: t("common.role.user") },
    ],
    [t],
  );

  const statusOptions = useMemo<ReadonlyArray<AppSelectOption<StatusFilterValue>>>(
    () => [
      { value: "__all__", label: t("users.filter.allStatuses") },
      { value: "active", label: t("common.status.active") },
      { value: "suspended", label: t("common.status.suspended") },
    ],
    [t],
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
  const fmt = (value: number): string => formatNumber(value, undefined, locale);

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
            placeholder={t("users.search.placeholder")}
            aria-label={t("users.search.aria")}
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

        <div className="w-[calc(50%-0.3125rem)] sm:w-36">
          <AppSelect
            size="sm"
            value={roleFilter}
            onValueChange={(val) => {
              setRoleFilter(val);
              setPage(1);
            }}
            options={roleOptions}
            ariaLabel={t("users.filter.roleAria")}
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
            options={statusOptions}
            ariaLabel={t("users.filter.statusAria")}
          />
        </div>
      </div>

      {/* 用户数据表格卡片 */}
      <div className="oh-elevated-card overflow-hidden rounded-2xl">
        {usersQuery.isPending ? (
          <AdminTableSkeleton rows={6} />
        ) : usersQuery.isError || !usersQuery.data ? (
          <AdminErrorState
            message={resolveAdminErrorMessage(usersQuery.error, t("users.error.loadList"), locale)}
            onRetry={() => void usersQuery.refetch()}
          />
        ) : usersQuery.data.users.length === 0 ? (
          <AdminEmptyState
            title={t("users.empty.title")}
            description={t("users.empty.description")}
          />
        ) : (
          <>
            <div className="overflow-x-auto overscroll-x-contain">
              <table className="w-full min-w-[780px] border-collapse text-left text-[13px]">
                <thead>
                  <tr className="border-b border-black/[0.06] bg-black/[0.02] text-[11.5px] font-semibold text-[#687082] dark:border-white/[0.07] dark:bg-white/[0.02] dark:text-[#8E96AB]">
                    <th className="px-4 py-3">{t("users.table.identity")}</th>
                    <th className="px-3 py-3">{t("users.table.role")}</th>
                    <th className="px-3 py-3">{t("users.table.status")}</th>
                    <th className="px-3 py-3 text-right">{t("users.table.counts")}</th>
                    <th className="px-3 py-3 text-right">{t("users.table.activeSessions")}</th>
                    <th className="px-3 py-3">{t("users.table.lastLogin")}</th>
                    <th className="px-4 py-3 text-right">{t("users.table.actions")}</th>
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
                              <AdminStatusPill tone="info">
                                {t("users.badge.currentUser")}
                              </AdminStatusPill>
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
                            {item.role === "admin" ? t("common.role.admin") : t("common.role.user")}
                          </AdminStatusPill>
                          {item.isEnvPinnedAdmin ? (
                            <AdminStatusPill tone="info">
                              {t("users.badge.envPinnedShort")}
                            </AdminStatusPill>
                          ) : null}
                        </div>
                      </td>
                      <td className="px-3 py-3">
                        <AdminStatusPill tone={item.status === "suspended" ? "danger" : "success"}>
                          {item.status === "suspended"
                            ? t("common.status.suspended")
                            : t("common.status.activeShort")}
                        </AdminStatusPill>
                      </td>
                      <td className="px-3 py-3 text-right font-mono text-xs text-[#3B414E] tabular-nums dark:text-[#B4BCD0]">
                        {fmt(item.stats.agentCount)} / {fmt(item.stats.ownedRoomCount)} /{" "}
                        {fmt(item.stats.messageCount)}
                      </td>
                      <td className="px-3 py-3 text-right font-mono text-xs tabular-nums">
                        <span
                          className={
                            item.stats.activeSessionCount > 0
                              ? "font-semibold text-[#16A34A] dark:text-[#34D399]"
                              : "text-[#939BAD] dark:text-[#63636B]"
                          }
                        >
                          {fmt(item.stats.activeSessionCount)}
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
                          {t("users.action.manage")}
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
        title={t("users.drawer.title")}
        subtitle={t("users.drawer.subtitle")}
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
