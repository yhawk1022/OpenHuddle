/**
 * @module server/modules/mcp/routes
 * @description 面向云端与远程异构 Agent 的无状态 Streamable HTTP MCP 网关路由（`/api/v1/mcp`）。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 强鉴权隔离：所有 `/api/v1/mcp` 请求必须携带已验证的 `Authorization: Bearer oh_agt_...` 专属令牌；人类 Cookie 会话或匿名调用一律以 `403 FORBIDDEN_NOT_OWNER` / `401 UNAUTHORIZED` 拒绝。
 * 2. 进程内零网络回跳：内部桥接直接复用传入的 `internalFetch`（对接当前 Hono 应用实例），无需额外本地 TCP 回环连接，兼容容器多网络命名空间与零端口单测靶场。
 */
import type { OpenAPIHono } from "@hono/zod-openapi";
import { handleOpenHuddleMcpHttpRequest } from "@openhuddle/mcp";
import { createRequireAuthMiddleware } from "../../infra/auth-middleware.js";
import type { ServerEnv } from "../../infra/env.js";
import { AppError } from "../../infra/errors.js";
import { createOpenApiRouter } from "../../infra/openapi-router.js";
import { resolveEffectivePublicBaseUrl } from "../../infra/public-url.js";
import type { AuthService } from "../auth/auth.service.js";

/**
 * 创建挂载于 `/api/v1/mcp` 的远程 Streamable HTTP MCP 路由器。
 *
 * @param deps - 认证服务、运行配置与进程内请求分发回调
 * @returns Hono 子路由实例
 */
export function createMcpRouter(deps: {
  readonly authService: AuthService;
  readonly env: ServerEnv;
  readonly internalFetch: typeof fetch;
}): OpenAPIHono {
  const router = createOpenApiRouter();
  const requireAuth = createRequireAuthMiddleware(deps.authService);

  router.use("/mcp", requireAuth);

  router.all("/mcp", async (c) => {
    const caller = c.get("caller");
    if (caller.kind !== "agent") {
      throw new AppError({
        code: "FORBIDDEN_NOT_OWNER",
        statusCode: 403,
        message:
          "Remote MCP endpoint requires a scoped Agent Bearer token (Authorization: Bearer oh_agt_...).",
      });
    }

    const authHeader = c.req.header("authorization") ?? "";
    const bearerMatch = authHeader.match(/^Bearer\s+(\S+)$/i);
    const agentToken = bearerMatch?.[1]?.trim();
    if (!agentToken) {
      throw new AppError({
        code: "UNAUTHORIZED",
        statusCode: 401,
        message: "Missing Authorization: Bearer <oh_agt_token> header.",
      });
    }

    const serverUrl = resolveEffectivePublicBaseUrl(deps.env.PUBLIC_BASE_URL, c.req.raw);
    return handleOpenHuddleMcpHttpRequest(c.req.raw, {
      serverUrl,
      agentToken,
      fetchImpl: deps.internalFetch,
    });
  });

  return router;
}
