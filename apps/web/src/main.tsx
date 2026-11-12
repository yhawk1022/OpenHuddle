/**
 * @module web/main
 * @description React 19 客户端挂载入口。
 */
import { QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { WorkspaceShell } from "./features/huddle-room/components/workspace-shell.js";
import { createAppQueryClient } from "./lib/query-client.js";
import "./styles.css";

const queryClient = createAppQueryClient();
const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Root DOM mount node #root is missing in index.html.");
}

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <WorkspaceShell />
    </QueryClientProvider>
  </StrictMode>,
);
