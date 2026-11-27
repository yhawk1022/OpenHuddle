/**
 * @module web/features/admin-console/page
 * @description OpenHuddle 运营与治理管理后台顶层页面外壳（`/admin` 及 `/admin/*`）。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 四态与 RBAC 强门禁：加载态 → 未登录直出 `OtpSignInScreen` → 非管理员友好 `403` 拒止与回工作台入口 → 管理员完整工作台。
 * 2. 严格单向特性边界：仅通过 `../../auth-pairing/index.js` 公共门面访问登录认证能力，绝不跨特性深层私引内部实现。
 * 3. 桌面原生外壳锁定：外层锁定 `h-dvh w-screen overflow-hidden`，导航侧栏与主工作区各自独立 `overflow-y-auto` 滚动，兼容 Tauri v2 / Electron 拖拽顶栏。
 */
import type { HumanUserDto, RoomId, UserId } from "@openhuddle/protocol";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  BarChart3,
  Bot,
  CheckSquare,
  FileClock,
  KeyRound,
  LogOut,
  Menu,
  MessagesSquare,
  QrCode,
  RefreshCw,
  Shield,
  ShieldAlert,
  Users,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import type { ReactNode } from "react";
import { useCallback, useMemo, useState } from "react";
import { BrandMark } from "../../../components/brand-mark.js";
import {
  AppButton,
  AppSheetDrawer,
  AppTooltip,
  IconButton,
  cn,
  toast,
  usePrefersReducedMotion,
} from "../../../components/primitives/index.js";
import { PlatformAvatar } from "../../../components/ui/identity-badges.js";
import { adminQueryKeys } from "../../../lib/query-keys.js";
import { navigateBackOr, navigateTo, useBrowserLocation } from "../../../lib/session-store.js";
import {
  AccountThemeMenu,
  OtpSignInScreen,
  currentMeQueryOptions,
  useLogoutMutation,
} from "../../auth-pairing/index.js";
import { useAdminI18n } from "../i18n/index.js";
import { AdminAgentsView } from "./admin-agents-view.js";
import { AdminAuditLogsView } from "./admin-audit-logs-view.js";
import { type AdminNavSection, AdminOverviewView } from "./admin-overview-view.js";
import { AdminPairingCodesView } from "./admin-pairing-codes-view.js";
import { AdminProposalsView } from "./admin-proposals-view.js";
import { AdminRoomsView } from "./admin-rooms-view.js";
import { AdminSessionsView } from "./admin-sessions-view.js";
import { AdminStatusPill } from "./admin-shared-ui.js";
import { AdminUsersView } from "./admin-users-view.js";

type AdminNavLabelKey =
  | "nav.overview.label"
  | "nav.users.label"
  | "nav.sessions.label"
  | "nav.rooms.label"
  | "nav.agents.label"
  | "nav.proposals.label"
  | "nav.pairingCodes.label"
  | "nav.auditLogs.label";

type AdminNavDescriptionKey =
  | "nav.overview.description"
  | "nav.users.description"
  | "nav.sessions.description"
  | "nav.rooms.description"
  | "nav.agents.description"
  | "nav.proposals.description"
  | "nav.pairingCodes.description"
  | "nav.auditLogs.description";

interface AdminNavItemConfig {
  readonly id: AdminNavSection;
  readonly path: string;
  readonly labelKey: AdminNavLabelKey;
  readonly descriptionKey: AdminNavDescriptionKey;
  readonly icon: ReactNode;
}

const ADMIN_NAV_ITEMS: ReadonlyArray<AdminNavItemConfig> = [
  {
    id: "overview",
    path: "/admin",
    labelKey: "nav.overview.label",
    descriptionKey: "nav.overview.description",
    icon: <BarChart3 className="h-4 w-4" />,
  },
  {
    id: "users",
    path: "/admin/users",
    labelKey: "nav.users.label",
    descriptionKey: "nav.users.description",
    icon: <Users className="h-4 w-4" />,
  },
  {
    id: "sessions",
    path: "/admin/sessions",
    labelKey: "nav.sessions.label",
    descriptionKey: "nav.sessions.description",
    icon: <KeyRound className="h-4 w-4" />,
  },
  {
    id: "rooms",
    path: "/admin/rooms",
    labelKey: "nav.rooms.label",
    descriptionKey: "nav.rooms.description",
    icon: <MessagesSquare className="h-4 w-4" />,
  },
  {
    id: "agents",
    path: "/admin/agents",
    labelKey: "nav.agents.label",
    descriptionKey: "nav.agents.description",
    icon: <Bot className="h-4 w-4" />,
  },
  {
    id: "proposals",
    path: "/admin/proposals",
    labelKey: "nav.proposals.label",
    descriptionKey: "nav.proposals.description",
    icon: <CheckSquare className="h-4 w-4" />,
  },
  {
    id: "pairing-codes",
    path: "/admin/pairing-codes",
    labelKey: "nav.pairingCodes.label",
    descriptionKey: "nav.pairingCodes.description",
    icon: <QrCode className="h-4 w-4" />,
  },
  {
    id: "audit-logs",
    path: "/admin/audit-logs",
    labelKey: "nav.auditLogs.label",
    descriptionKey: "nav.auditLogs.description",
    icon: <FileClock className="h-4 w-4" />,
  },
];

function resolveSectionFromPath(pathname: string): AdminNavSection {
  const normalized = pathname.replace(/\/+$/, "") || "/admin";
  if (normalized === "/admin/users") {
    return "users";
  }
  if (normalized === "/admin/sessions") {
    return "sessions";
  }
  if (normalized === "/admin/rooms") {
    return "rooms";
  }
  if (normalized === "/admin/agents") {
    return "agents";
  }
  if (normalized === "/admin/proposals") {
    return "proposals";
  }
  if (normalized === "/admin/pairing-codes") {
    return "pairing-codes";
  }
  if (normalized === "/admin/audit-logs") {
    return "audit-logs";
  }
  return "overview";
}

function AdminSidebarNav(props: {
  readonly activeSection: AdminNavSection;
  readonly currentUser: HumanUserDto;
  readonly onSelectSection: (section: AdminNavSection) => void;
  readonly onBackToWorkspace: () => void;
  readonly onLogout: () => void;
}) {
  const { t } = useAdminI18n();

  return (
    <div className="flex h-full flex-col bg-sidebar-surface select-none">
      {/* 品牌与后台标识 */}
      <div
        data-tauri-drag-region=""
        className="app-drag-region flex min-h-[64px] shrink-0 items-center justify-between gap-2 border-b border-im-border px-4 pt-[env(safe-area-inset-top,0px)] md:pt-0"
      >
        <div className="flex min-w-0 items-center gap-2.5">
          <BrandMark size={28} />
          <div className="min-w-0 leading-tight">
            <span className="block truncate text-[14px] font-semibold tracking-[-0.015em] text-im-fg">
              OpenHuddle
            </span>
            <span className="block text-[11px] font-medium text-im-muted">
              {t("nav.brandSubtitle")}
            </span>
          </div>
        </div>
        <AdminStatusPill tone="accent">{t("nav.badge")}</AdminStatusPill>
      </div>

      {/* 导航菜单 */}
      <nav aria-label={t("nav.ariaLabel")} className="flex-1 space-y-1 overflow-y-auto px-2.5 py-3">
        {ADMIN_NAV_ITEMS.map((item) => {
          const isActive = item.id === props.activeSection;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => props.onSelectSection(item.id)}
              aria-current={isActive ? "page" : undefined}
              className={cn(
                "app-no-drag flex w-full cursor-pointer items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[13px] transition-colors",
                isActive
                  ? "bg-im-accent font-semibold text-im-accent-fg shadow-xs"
                  : "font-medium text-im-fg-soft hover:bg-black/[0.045] hover:text-im-fg dark:hover:bg-white/[0.06]",
              )}
            >
              <span className="shrink-0">{item.icon}</span>
              <span className="truncate">{t(item.labelKey)}</span>
            </button>
          );
        })}
      </nav>

      {/* 底部返回工作台与当前管理员信息 */}
      <div className="shrink-0 space-y-2.5 border-t border-im-border p-3 pb-[max(0.75rem,env(safe-area-inset-bottom,0px))] md:pb-3">
        <AppButton
          variant="secondary"
          size="sm"
          fullWidth={true}
          leadingIcon={<ArrowLeft className="h-3.5 w-3.5" />}
          onClick={props.onBackToWorkspace}
        >
          {t("nav.backToWorkspace")}
        </AppButton>

        <div className="flex items-center justify-between gap-2 rounded-xl bg-black/[0.03] px-2.5 py-2 dark:bg-white/[0.04]">
          <div className="flex min-w-0 items-center gap-2">
            <PlatformAvatar
              kind="human"
              displayName={props.currentUser.displayName}
              size="sm"
              className="[&>div]:h-7 [&>div]:w-7 [&>div]:rounded-full [&>div]:text-[10px]"
            />
            <div className="min-w-0">
              <span className="block truncate text-xs font-semibold text-im-fg">
                {props.currentUser.displayName}
              </span>
              <span className="block truncate text-[10.5px] text-im-muted">
                {props.currentUser.email}
              </span>
            </div>
          </div>
          <AppTooltip side="top" content={t("nav.logout")}>
            <IconButton
              size="xs"
              variant="ghost"
              label={t("nav.logout")}
              onClick={props.onLogout}
              className="text-im-muted hover:text-[#E5484D]"
            >
              <LogOut className="h-3.5 w-3.5" />
            </IconButton>
          </AppTooltip>
        </div>
      </div>
    </div>
  );
}

function AuthenticatedAdminConsole(props: { readonly currentUser: HumanUserDto }) {
  const { t } = useAdminI18n();
  const location = useBrowserLocation();
  const queryClient = useQueryClient();
  const logoutMutation = useLogoutMutation();
  const reducedMotion = usePrefersReducedMotion();

  const activeSection = useMemo(
    () => resolveSectionFromPath(location.pathname),
    [location.pathname],
  );
  const [mobileNavOpen, setMobileNavOpen] = useState<boolean>(false);
  const [initialUserId, setInitialUserId] = useState<UserId | null>(null);
  const [initialRoomId, setInitialRoomId] = useState<RoomId | null>(null);
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);

  const navigateToSection = useCallback((section: AdminNavSection): void => {
    const matched = ADMIN_NAV_ITEMS.find((item) => item.id === section);
    navigateTo(matched?.path ?? "/admin");
    setMobileNavOpen(false);
  }, []);

  const handleInspectUserFromDashboard = useCallback(
    (userId: UserId): void => {
      setInitialUserId(userId);
      navigateToSection("users");
    },
    [navigateToSection],
  );

  const handleInspectRoomFromElsewhere = useCallback(
    (roomId: RoomId): void => {
      setInitialRoomId(roomId);
      navigateToSection("rooms");
    },
    [navigateToSection],
  );

  const handleRefreshAll = useCallback(async (): Promise<void> => {
    setIsRefreshing(true);
    try {
      await queryClient.invalidateQueries({ queryKey: adminQueryKeys.all() });
      toast.success(t("page.toast.refreshed"));
    } finally {
      setIsRefreshing(false);
    }
  }, [queryClient, t]);

  const handleLogout = useCallback((): void => {
    logoutMutation.mutate(undefined, {
      onSuccess: () => toast.success(t("page.toast.signedOut")),
    });
  }, [logoutMutation, t]);

  const activeNavMeta =
    ADMIN_NAV_ITEMS.find((item) => item.id === activeSection) ?? ADMIN_NAV_ITEMS[0];

  return (
    <div className="flex h-vvh w-full overflow-hidden bg-app-frame text-im-fg md:p-2">
      <div className="oh-shell-frame flex h-full w-full overflow-hidden md:rounded-[20px]">
        {/* 桌面端左侧导航栏 */}
        <aside className="hidden w-[248px] shrink-0 border-r border-im-border md:block">
          <AdminSidebarNav
            activeSection={activeSection}
            currentUser={props.currentUser}
            onSelectSection={navigateToSection}
            onBackToWorkspace={() => navigateBackOr("/")}
            onLogout={handleLogout}
          />
        </aside>

        {/* 右侧主画布 */}
        <div className="flex min-w-0 flex-1 flex-col bg-im-canvas pt-[env(safe-area-inset-top,0px)] md:pt-0">
          {/* 64px 轻磨砂顶栏 */}
          <header
            data-tauri-drag-region=""
            className="oh-bar-frosted app-drag-region flex h-[60px] shrink-0 items-center justify-between gap-2 border-b border-im-border px-3.5 sm:h-[64px] sm:gap-3 sm:px-6"
          >
            <div className="flex min-w-0 items-center gap-2">
              <div className="md:hidden">
                <IconButton
                  size="sm"
                  variant="ghost"
                  label={t("nav.openMenu")}
                  onClick={() => setMobileNavOpen(true)}
                >
                  <Menu className="h-4 w-4" />
                </IconButton>
              </div>
              <div className="min-w-0">
                <h1 className="truncate text-[15px] font-semibold tracking-[-0.015em] text-im-fg sm:text-[15.5px]">
                  {activeNavMeta !== undefined ? t(activeNavMeta.labelKey) : t("nav.fallbackTitle")}
                </h1>
                <p className="hidden truncate text-xs text-im-muted sm:block">
                  {activeNavMeta !== undefined ? t(activeNavMeta.descriptionKey) : ""}
                </p>
              </div>
            </div>

            <div className="app-no-drag flex shrink-0 items-center gap-1 sm:gap-1.5">
              <AppTooltip side="bottom" content={t("nav.refreshData")}>
                <IconButton
                  size="sm"
                  variant="ghost"
                  label={t("nav.refreshData")}
                  isLoading={isRefreshing}
                  onClick={() => void handleRefreshAll()}
                >
                  <RefreshCw className="h-4 w-4" />
                </IconButton>
              </AppTooltip>

              <AccountThemeMenu align="end" />

              <AppButton
                variant="secondary"
                size="xs"
                className="inline-flex shrink-0 whitespace-nowrap"
                leadingIcon={<ArrowLeft className="h-3.5 w-3.5" />}
                onClick={() => navigateBackOr("/")}
              >
                <span className="max-[359px]:hidden">{t("nav.topBackWorkspace")}</span>
                <span className="min-[360px]:hidden">{t("nav.topBackShort")}</span>
              </AppButton>
            </div>
          </header>

          {/* 独立可滚动业务视图容器 */}
          <main className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3.5 py-4 pb-[max(1.25rem,env(safe-area-inset-bottom,0px))] sm:px-6 sm:py-5">
            <div className="mx-auto max-w-7xl">
              <AnimatePresence mode="wait" initial={false}>
                <motion.div
                  key={activeSection}
                  initial={reducedMotion ? false : { opacity: 0, y: 5 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={reducedMotion ? { opacity: 0 } : { opacity: 0, y: -4 }}
                  transition={reducedMotion ? { duration: 0 } : { duration: 0.15, ease: "easeOut" }}
                >
                  {activeSection === "overview" ? (
                    <AdminOverviewView
                      onNavigateSection={navigateToSection}
                      onInspectUser={handleInspectUserFromDashboard}
                      onInspectRoom={handleInspectRoomFromElsewhere}
                    />
                  ) : activeSection === "users" ? (
                    <AdminUsersView
                      currentUserId={props.currentUser.id}
                      initialSelectedUserId={initialUserId}
                      onClearInitialSelection={() => setInitialUserId(null)}
                    />
                  ) : activeSection === "sessions" ? (
                    <AdminSessionsView />
                  ) : activeSection === "rooms" ? (
                    <AdminRoomsView
                      initialSelectedRoomId={initialRoomId}
                      onClearInitialSelection={() => setInitialRoomId(null)}
                    />
                  ) : activeSection === "agents" ? (
                    <AdminAgentsView />
                  ) : activeSection === "proposals" ? (
                    <AdminProposalsView onInspectRoom={handleInspectRoomFromElsewhere} />
                  ) : activeSection === "pairing-codes" ? (
                    <AdminPairingCodesView />
                  ) : (
                    <AdminAuditLogsView />
                  )}
                </motion.div>
              </AnimatePresence>
            </div>
          </main>
        </div>
      </div>

      {/* 移动端导航抽屉 */}
      <AppSheetDrawer
        open={mobileNavOpen}
        onOpenChange={setMobileNavOpen}
        title={t("nav.mobileDrawerTitle")}
        side="left"
        mobileAsBottomSheet={false}
        hideHeader={true}
        className="w-[min(82vw,280px)] p-0"
      >
        <AdminSidebarNav
          activeSection={activeSection}
          currentUser={props.currentUser}
          onSelectSection={navigateToSection}
          onBackToWorkspace={() => {
            setMobileNavOpen(false);
            navigateTo("/");
          }}
          onLogout={handleLogout}
        />
      </AppSheetDrawer>
    </div>
  );
}

/**
 * OpenHuddle 运营与治理管理后台入口组件（自动完成登录与管理员角色门禁校验）。
 */
export function AdminConsolePage() {
  const { t } = useAdminI18n();
  const meQuery = useQuery(currentMeQueryOptions());
  const logoutMutation = useLogoutMutation();

  // 后台入口与工作台共用认证表单，重试时保持用户输入。
  if (meQuery.isPending && !meQuery.isFetched) {
    return (
      <main className="flex h-vvh w-full flex-col items-center justify-center gap-2.5 bg-app-frame text-im-fg">
        <Shield className="h-6 w-6 animate-pulse text-im-muted" />
        <span className="text-[15px] font-semibold tracking-[-0.015em]">
          {t("page.loading.verifying")}
        </span>
      </main>
    );
  }

  if (meQuery.isError || !meQuery.data || meQuery.data.callerKind !== "human") {
    return <OtpSignInScreen />;
  }

  if (meQuery.data.user.role !== "admin") {
    return (
      <main className="flex h-vvh w-full items-center justify-center bg-app-frame p-5 text-im-fg sm:p-6">
        <div className="oh-elevated-card max-w-md rounded-3xl p-6 text-center sm:p-7">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-[#E5484D]/12 text-[#D70015] dark:bg-[#F05252]/15 dark:text-[#FF6961]">
            <ShieldAlert className="h-6 w-6" />
          </div>
          <h1 className="mt-4 text-[18px] font-semibold tracking-[-0.02em] text-im-fg">
            {t("page.forbidden.title")}
          </h1>
          <p className="mt-2 text-[13px] leading-relaxed text-im-muted">
            {t("page.forbidden.bodyPrefix")}
            <strong className="text-im-fg">{meQuery.data.user.email}</strong>
            {t("page.forbidden.bodyMiddle")}
            <code className="font-mono text-xs">ADMIN_EMAILS</code>
            {t("page.forbidden.bodySuffix")}
          </p>
          <div className="mt-6 flex flex-wrap items-center justify-center gap-2.5">
            <AppButton
              variant="primary"
              size="md"
              leadingIcon={<ArrowLeft className="h-4 w-4" />}
              onClick={() => navigateBackOr("/")}
            >
              {t("nav.backToWorkspace")}
            </AppButton>
            <AppButton
              variant="secondary"
              size="md"
              leadingIcon={<LogOut className="h-4 w-4" />}
              isLoading={logoutMutation.isPending}
              onClick={() => logoutMutation.mutate()}
            >
              {t("page.forbidden.switchAccount")}
            </AppButton>
          </div>
        </div>
      </main>
    );
  }

  return <AuthenticatedAdminConsole currentUser={meQuery.data.user} />;
}
