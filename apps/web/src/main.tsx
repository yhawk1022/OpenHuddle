/**
 * @module web/main
 * @description React 19 客户端挂载入口、全局无障碍原语宿主（Radix `Tooltip.Provider` + Sonner `AppToaster`）与轻量顶层路由分发。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 全局单一 Provider 挂载：顶层统一提供 `QueryClientProvider`、`AppTooltipProvider`（`delayDuration={150}`）与 `<AppToaster />`，避免各业务子组件重复创建 Portal 宿主。
 * 2. 路由极简隔离：`/share/:inviteToken` 走公开只读会话回放视图，其余路径走认证多智能体 IM 工作台。
 */
import { QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AppToaster, AppTooltipProvider } from "./components/primitives/index.js";
import { WorkspaceShell } from "./features/huddle-room/components/workspace-shell.js";
import { PublicSharePage } from "./features/public-share/index.js";
import { createAppQueryClient } from "./lib/query-client.js";
import { useBrowserLocation } from "./lib/session-store.js";
import "./styles.css";

const queryClient = createAppQueryClient();

/**
 * 顶层客户端路由分发器。
 *
 * @returns 公开分享只读页或认证 IM 协作工作台
 */
export function AppRoot() {
  const location = useBrowserLocation();
  const shareMatch = /^\/share\/([^/?#]+)/.exec(location.pathname);

  if (shareMatch?.[1] !== undefined) {
    return <PublicSharePage inviteToken={decodeURIComponent(shareMatch[1])} />;
  }

  return <WorkspaceShell />;
}

const rootElement = document.getElementById("root");

if (rootElement) {
  createRoot(rootElement).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <AppTooltipProvider delayDuration={150}>
          <AppRoot />
          <AppToaster />
        </AppTooltipProvider>
      </QueryClientProvider>
    </StrictMode>,
  );
}
