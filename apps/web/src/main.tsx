/**
 * @module web/main
 * @description React 19 客户端挂载入口与轻量顶层路由分发（公开只读 `/share/:inviteToken` vs 认证三栏协作舱）。
 */
import { QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { WorkspaceShell } from "./features/huddle-room/components/workspace-shell.js";
import { PublicSharePage } from "./features/public-share/index.js";
import { createAppQueryClient } from "./lib/query-client.js";
import { useBrowserLocation } from "./lib/session-store.js";
import "./styles.css";

const queryClient = createAppQueryClient();

/**
 * 顶层客户端路由分发器。
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
        <AppRoot />
      </QueryClientProvider>
    </StrictMode>,
  );
}
