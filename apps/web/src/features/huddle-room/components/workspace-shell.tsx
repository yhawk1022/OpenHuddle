/**
 * @module web/features/huddle-room/workspace-shell
 * @description 人类实时协作舱顶层骨架组件（展示服务就绪状态、默认治理阈值与协议连通性）。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 严格遵循 Feature-First 规范：通过 `TanStack Query` 管理 `/api/v1/health` 状态，完备处理加载态、错误态与正常态，严禁裸写 `useEffect` 拉取接口。
 */
import { DEFAULT_MAX_CONSECUTIVE_AGENT_TURNS } from "@openhuddle/protocol";
import { queryOptions, useQuery } from "@tanstack/react-query";

interface HealthPayload {
  readonly ok: boolean;
  readonly version: string;
  readonly databaseDriver: string;
  readonly realtimeBusDriver: string;
}

/**
 * 构造系统健康探针的标准化 `queryOptions`。
 */
export function systemHealthQueryOptions() {
  return queryOptions({
    queryKey: ["system", "health"] as const,
    queryFn: async (): Promise<HealthPayload> => {
      const response = await fetch("/api/v1/health");
      if (!response.ok) {
        throw new Error(`Health check failed with status ${response.status}`);
      }
      return (await response.json()) as HealthPayload;
    },
  });
}

/**
 * OpenHuddle 协作舱工作台主骨架视图。
 */
export function WorkspaceShell() {
  const healthQuery = useQuery(systemHealthQueryOptions());

  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col justify-center gap-6 px-6 py-16">
      <header className="space-y-2">
        <span className="inline-flex items-center rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-xs font-medium text-emerald-300">
          OpenHuddle v0.1 Foundation Ready
        </span>
        <h1 className="text-3xl font-semibold tracking-tight text-white">
          Multi-Agent Group Huddle &amp; Human Decision Workspace
        </h1>
        <p className="text-sm text-slate-400">
          Default Anti-Loop Turn Budget: {DEFAULT_MAX_CONSECUTIVE_AGENT_TURNS} consecutive agent
          turns before human checkpoint.
        </p>
      </header>

      <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-6">
        <h2 className="text-sm font-medium text-slate-300">Gateway Telemetry</h2>
        {healthQuery.isPending ? (
          <p className="mt-2 text-sm text-slate-400">Checking gateway connectivity...</p>
        ) : healthQuery.isError ? (
          <p className="mt-2 text-sm text-amber-400">
            Backend gateway offline (run <code>pnpm dev</code> to connect live telemetry).
          </p>
        ) : (
          <p className="mt-2 text-sm text-emerald-400">
            Connected — DB: <code>{healthQuery.data.databaseDriver}</code> · Bus:{" "}
            <code>{healthQuery.data.realtimeBusDriver}</code>
          </p>
        )}
      </section>
    </main>
  );
}
