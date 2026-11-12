/**
 * @module server/modules/auth/routes
 * @description 人类 OTP 登录（`/auth/otp/*`）、登出（`/auth/logout`）及双层身份自省（`/me`）OpenAPI 路由模块。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 路由层零 SQL、零业务分支：仅负责绑定 `@openhuddle/protocol` Schema、设置/清理 `HttpOnly` 会话 Cookie 并序列化响应。
 * 2. Cookie 安全基线：登录成功下发的 `oh_session` 固定开启 `HttpOnly; Path=/; SameSite=Lax; Max-Age=2592000`。
 */
import { type OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
  ApiErrorEnvelopeSchema,
  MeResponseSchema,
  RequestOtpBodySchema,
  RequestOtpResponseSchema,
  UpdateMeBodySchema,
  VerifyOtpBodySchema,
  VerifyOtpResponseSchema,
} from "@openhuddle/protocol";
import { deleteCookie, setCookie } from "hono/cookie";
import {
  SESSION_COOKIE_NAME,
  createRequireAuthMiddleware,
  extractRawCredential,
} from "../../infra/auth-middleware.js";
import type { ServerEnv } from "../../infra/env.js";
import { createOpenApiRouter } from "../../infra/openapi-router.js";
import { type AuthService, SESSION_TTL_SEC } from "./auth.service.js";

const LogoutResponseSchema = z.object({
  ok: z.literal(true),
});

const requestOtpRoute = createRoute({
  method: "post",
  path: "/auth/otp/request",
  tags: ["Auth"],
  summary: "Request a 6-digit email OTP verification code",
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: RequestOtpBodySchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: "OTP verification code issued",
      content: {
        "application/json": {
          schema: RequestOtpResponseSchema,
        },
      },
    },
    400: {
      description: "Invalid email payload",
      content: {
        "application/json": {
          schema: ApiErrorEnvelopeSchema,
        },
      },
    },
  },
});

const verifyOtpRoute = createRoute({
  method: "post",
  path: "/auth/otp/verify",
  tags: ["Auth"],
  summary: "Verify 6-digit OTP code and issue human session cookie & bearer token",
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: VerifyOtpBodySchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: "Authenticated human user and issued oh_ses_ session",
      content: {
        "application/json": {
          schema: VerifyOtpResponseSchema,
        },
      },
    },
    401: {
      description: "Invalid or expired OTP code",
      content: {
        "application/json": {
          schema: ApiErrorEnvelopeSchema,
        },
      },
    },
  },
});

const logoutRoute = createRoute({
  method: "post",
  path: "/auth/logout",
  tags: ["Auth"],
  summary: "Revoke active human session and clear oh_session cookie",
  responses: {
    200: {
      description: "Logged out cleanly",
      content: {
        "application/json": {
          schema: LogoutResponseSchema,
        },
      },
    },
  },
});

const getMeRoute = createRoute({
  method: "get",
  path: "/me",
  tags: ["Auth"],
  summary: "Inspect current authenticated human or agent identity and live agent reach states",
  responses: {
    200: {
      description: "Authenticated caller profile",
      content: {
        "application/json": {
          schema: MeResponseSchema,
        },
      },
    },
    401: {
      description: "Missing or invalid credentials",
      content: {
        "application/json": {
          schema: ApiErrorEnvelopeSchema,
        },
      },
    },
  },
});

const patchMeRoute = createRoute({
  method: "patch",
  path: "/me",
  tags: ["Auth"],
  summary: "Update display name, agent intro, or checkin interval for current caller",
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: UpdateMeBodySchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: "Updated caller profile",
      content: {
        "application/json": {
          schema: MeResponseSchema,
        },
      },
    },
    401: {
      description: "Missing or invalid credentials",
      content: {
        "application/json": {
          schema: ApiErrorEnvelopeSchema,
        },
      },
    },
  },
});

/**
 * 创建认证与身份自省 OpenAPI 子路由器。
 *
 * @param deps - 认证服务与运行环境配置
 * @returns 挂载了 `/auth/*` 与 `/me` 契约路由的 `OpenAPIHono`
 */
export function createAuthRouter(deps: {
  readonly authService: AuthService;
  readonly env: ServerEnv;
}): OpenAPIHono {
  const router = createOpenApiRouter();
  const requireAuth = createRequireAuthMiddleware(deps.authService);

  router.openapi(requestOtpRoute, async (c) => {
    const body = c.req.valid("json");
    const response = await deps.authService.requestOtp(body);
    return c.json(response, 200);
  });

  router.openapi(verifyOtpRoute, async (c) => {
    const body = c.req.valid("json");
    const result = await deps.authService.verifyOtp(body);

    setCookie(c, SESSION_COOKIE_NAME, result.sessionToken, {
      httpOnly: true,
      path: "/",
      sameSite: "Lax",
      maxAge: SESSION_TTL_SEC,
      secure: deps.env.NODE_ENV === "production",
    });

    return c.json(result, 200);
  });

  router.openapi(logoutRoute, async (c) => {
    const rawToken = extractRawCredential(c);
    await deps.authService.logout(rawToken);
    deleteCookie(c, SESSION_COOKIE_NAME, { path: "/" });
    return c.json({ ok: true as const }, 200);
  });

  router.use("/me", requireAuth);

  router.openapi(getMeRoute, async (c) => {
    const caller = c.get("caller");
    const me = await deps.authService.getMe(caller);
    return c.json(me, 200);
  });

  router.openapi(patchMeRoute, async (c) => {
    const caller = c.get("caller");
    const body = c.req.valid("json");
    const me = await deps.authService.updateMe(caller, body);
    return c.json(me, 200);
  });

  return router;
}
