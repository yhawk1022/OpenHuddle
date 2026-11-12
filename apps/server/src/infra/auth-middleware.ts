/**
 * @module server/infra/auth-middleware
 * @description 统一双层身份鉴权 Hono 中间件（支持 `Authorization: Bearer`、`?token=` SSE 参数与 `oh_session` Cookie）。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 权威身份源头：下游路由一律通过 `c.get("caller")` 读取已验证的 `AuthenticatedCaller`，严禁从客户端 JSON Body 读取身份声明。
 * 2. 多通道提取优先级：显式 `Authorization: Bearer` 头优先于 URL `?token=` 查询参数，最后回退至浏览器 `Cookie: oh_session=...`，防止同浏览器调试时 Cookie 误覆盖显式 Agent Token。
 */
import type { AuthenticatedCaller } from "@openhuddle/protocol";
import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import type { AuthService } from "../modules/auth/auth.service.js";
import { AppError } from "./errors.js";

/** Web 端人类登录会话的 HttpOnly Cookie 键名 */
export const SESSION_COOKIE_NAME = "oh_session";

declare module "hono" {
  interface ContextVariableMap {
    caller: AuthenticatedCaller;
  }
}

/**
 * 从当前 HTTP / SSE 请求上下文中按优先级提取原始认证令牌。
 *
 * @param c - Hono 请求上下文
 * @returns 提取到的 `oh_ses_...` 或 `oh_agt_...` 明文令牌，未携带则返回 `undefined`
 */
export function extractRawCredential(c: Context): string | undefined {
  const authHeader = c.req.header("authorization")?.trim();
  if (authHeader && /^bearer\s+/i.test(authHeader)) {
    const bearerToken = authHeader.replace(/^bearer\s+/i, "").trim();
    if (bearerToken.length > 0) {
      return bearerToken;
    }
  }

  const queryToken = c.req.query("token")?.trim();
  if (queryToken && queryToken.length > 0) {
    return queryToken;
  }

  const cookieToken = getCookie(c, SESSION_COOKIE_NAME)?.trim();
  if (cookieToken && cookieToken.length > 0) {
    return cookieToken;
  }

  return undefined;
}

/**
 * 创建强制要求合法人类或 Agent 凭据的 Hono 鉴权中间件。
 *
 * @param authService - 认证领域服务实例
 * @returns 将 `AuthenticatedCaller` 注入 `c.set("caller", ...)` 的中间件处理器
 */
export function createRequireAuthMiddleware(authService: AuthService): MiddlewareHandler {
  return createMiddleware(async (c, next) => {
    // 幂等短路：当父级子路由（如 /rooms/*）已完成权威鉴权时直接复用，避免同一请求重复查库与更新心跳
    if (c.get("caller") !== undefined) {
      await next();
      return;
    }

    const rawCredential = extractRawCredential(c);
    const caller = await authService.authenticateToken(rawCredential);

    c.set("caller", caller);

    const existingLogger = c.get("logger");
    if (existingLogger) {
      c.set(
        "logger",
        existingLogger.child({
          callerKind: caller.kind,
          callerId: caller.kind === "human" ? caller.userId : caller.agentId,
        }),
      );
    }

    await next();
  });
}

/**
 * 断言当前调用者必须为人类主人（`kind === "human"`），否则立即抛出 `403 FORBIDDEN_NOT_OWNER`。
 *
 * @remarks
 * 用于保护配对码签发、房间治理策略修改及提案最终拍板等仅限人类执行的特权接口。
 *
 * @param caller - 当前请求上下文中的已认证身份
 * @returns 收窄为人类分支的调用者身份
 * @throws {AppError} 当调用者为 `agent` 时抛出 `403 FORBIDDEN_NOT_OWNER`
 */
export function assertHumanCaller(
  caller: Readonly<AuthenticatedCaller>,
): Extract<AuthenticatedCaller, { readonly kind: "human" }> {
  if (caller.kind !== "human") {
    throw new AppError({
      code: "FORBIDDEN_NOT_OWNER",
      statusCode: 403,
      message: "This operation requires human owner privileges; agents are not permitted.",
    });
  }
  return caller;
}
