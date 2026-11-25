/**
 * @module web/main
 * @description React 19 客户端挂载入口、全局无障碍原语宿主（Radix `Tooltip.Provider` + Sonner `AppToaster`）与轻量顶层路由分发。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 全局单一 Provider 挂载：顶层统一提供 `QueryClientProvider`、`AppTooltipProvider`（`delayDuration={150}`）与 `<AppToaster />`，避免各业务子组件重复创建 Portal 宿主。
 * 2. 路由极简隔离：`/share/:inviteToken` 走公开只读会话回放视图，其余路径走认证多智能体 IM 工作台。
 */
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { StrictMode, Suspense, lazy, useEffect, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import {
  AppToaster,
  AppTooltipProvider,
  MotionConfig,
  startDisplayRefreshRuntime,
} from "./components/primitives/index.js";
import { AuthScreen, currentMeQueryOptions } from "./features/auth-pairing/index.js";
import { WorkspaceShell } from "./features/huddle-room/components/workspace-shell.js";
import { PublicSharePage } from "./features/public-share/index.js";
import { startPwaInstallRuntime } from "./features/pwa-install/index.js";
import { createAppQueryClient } from "./lib/query-client.js";
import { useBrowserLocation } from "./lib/session-store.js";
import { startThemeSync, useGuestThemePreference } from "./lib/theme-store.js";
import { startVisualViewportSync } from "./lib/viewport-sync.js";
import "./styles.css";

const queryClient = createAppQueryClient();

// 按需独立拆包加载管理后台，确保普通用户访问聊天工作台零额外体积负担
const LazyAdminConsolePage = lazy(() =>
  import("./features/admin-console/index.js").then((m) => ({
    default: m.AdminConsolePage,
  })),
);

function safeDecodeUriSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * 顶层客户端路由分发器。
 *
 * @returns 公开分享只读页、运营管理后台或认证 IM 协作工作台
 */
export function AppRoot() {
  const location = useBrowserLocation();
  const shareMatch = /^\/share\/([^/?#]+)/.exec(location.pathname);
  // 只观察认证入口的自省结果，公开页面无需额外发起身份请求。
  const meQuery = useQuery({ ...currentMeQueryOptions(), enabled: false });
  const guestPreference = useGuestThemePreference();
  const authenticated =
    shareMatch === null && !meQuery.isError && meQuery.data?.callerKind === "human";
  const preference = authenticated
    ? (meQuery.data?.themePreference ?? "auto")
    : shareMatch !== null
      ? "dark"
      : guestPreference;
  useLayoutEffect(() => startThemeSync(preference), [preference]);
  useLayoutEffect(() => startVisualViewportSync(), []);
  useLayoutEffect(() => startDisplayRefreshRuntime(), []);
  useEffect(() => {
    startPwaInstallRuntime();
  }, []);

  if (shareMatch?.[1] !== undefined) {
    return <PublicSharePage inviteToken={safeDecodeUriSegment(shareMatch[1])} />;
  }

  if (/^\/welcome(\/|$)/.test(location.pathname)) {
    return <AuthScreen portalMode="welcome" />;
  }

  if (/^\/admin(\/|$)/.test(location.pathname)) {
    return (
      <Suspense
        fallback={
          <main className="flex h-vvh flex-col items-center justify-center gap-2 bg-app-frame text-im-fg">
            <span className="text-[15px] font-semibold tracking-[-0.015em]">OpenHuddle</span>
            <span className="text-xs text-im-muted">正在加载管理后台…</span>
          </main>
        }
      >
        <LazyAdminConsolePage />
      </Suspense>
    );
  }

  return <WorkspaceShell />;
}

const rootElement = document.getElementById("root");

if (rootElement) {
  createRoot(rootElement).render(
    <StrictMode>
      <MotionConfig reducedMotion="user">
        <QueryClientProvider client={queryClient}>
          <AppTooltipProvider delayDuration={150}>
            <AppRoot />
            <AppToaster />
          </AppTooltipProvider>
        </QueryClientProvider>
      </MotionConfig>
    </StrictMode>,
  );
}
