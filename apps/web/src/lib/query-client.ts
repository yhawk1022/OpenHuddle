/**
 * @module web/lib/query-client
 * @description TanStack Query 全局服务端缓存实例工厂。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 作为前端唯一的远程服务端状态真相源（Single Source of Truth）。
 * 2. 配置合理的默认 `staleTime`，避免组件重挂载时产生重复轮询风暴；增量变更由单一 SSE 流定向打补丁或触发失效。
 */
import { QueryClient } from "@tanstack/react-query";

/**
 * 创建配置了生产级缓存策略的 `QueryClient` 实例。
 *
 * @returns 隔离的 `QueryClient` 实例
 */
export function createAppQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        retry: 1,
        refetchOnWindowFocus: false,
      },
    },
  });
}
