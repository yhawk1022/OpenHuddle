/**
 * @module server/modules/auth/routes
 * @description 人类邮箱+密码注册（`/auth/register*`）、登录（`/auth/login`）、重置/修改密码（`/auth/password*`）、旧版 OTP 兼容（`/auth/otp/*`）、登出及双层身份自省（`/me`）OpenAPI 路由模块。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 路由层零 SQL、零业务分支：仅负责绑定 `@openhuddle/protocol` Schema、提取客户端 IP、设置/清理 `HttpOnly` 会话 Cookie 并序列化响应。
 * 2. Cookie 安全基线：登录/注册/改密成功下发的 `oh_session` 固定开启 `HttpOnly; Path=/; SameSite=Lax; Max-Age=2592000`（生产自动 `Secure`）。
 */
import { type OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
  ApiErrorEnvelopeSchema,
  AuthCodeSentResponseSchema,
  AuthPublicConfigResponseSchema,
  AuthSessionResponseSchema,
  ChangePasswordBodySchema,
  ConfirmPasswordResetBodySchema,
  LoginWithPasswordBodySchema,
  MeResponseSchema,
  RegisterWithPasswordBodySchema,
  RequestOtpBodySchema,
  RequestOtpResponseSchema,
  RequestPasswordResetCodeBodySchema,
  RequestRegisterCodeBodySchema,
  UpdateMeBodySchema,
  VerifyOtpBodySchema,
  VerifyOtpResponseSchema,
} from "@openhuddle/protocol";
import type { Context } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import {
  SESSION_COOKIE_NAME,
  createRequireAuthMiddleware,
  extractRawCredential,
} from "../../infra/auth-middleware.js";
import type { ServerEnv } from "../../infra/env.js";
import { createOpenApiRouter } from "../../infra/openapi-router.js";
import { extractClientIp } from "../../infra/rate-limiter.js";
import { type AuthService, SESSION_TTL_SEC } from "./auth.service.js";

const LogoutResponseSchema = z.object({
  ok: z.literal(true),
});

const errorJsonContent = {
  "application/json": {
    schema: ApiErrorEnvelopeSchema,
  },
} as const;

const authConfigRoute = createRoute({
  method: "get",
  path: "/auth/config",
  tags: ["Auth"],
  summary: "Get public authentication & registration capabilities (zero secrets)",
  responses: {
    200: {
      description: "Public auth capabilities",
      content: {
        "application/json": {
          schema: AuthPublicConfigResponseSchema,
        },
      },
    },
  },
});

const requestRegisterCodeRoute = createRoute({
  method: "post",
  path: "/auth/register/request-code",
  tags: ["Auth"],
  summary: "Send a 6-digit email verification code for new user registration",
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: RequestRegisterCodeBodySchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: "Registration verification code dispatched",
      content: {
        "application/json": {
          schema: AuthCodeSentResponseSchema,
        },
      },
    },
    400: { description: "Invalid email payload", content: errorJsonContent },
    403: {
      description: "Public signup disabled or email domain not allowed",
      content: errorJsonContent,
    },
    409: { description: "Email is already registered", content: errorJsonContent },
    429: { description: "Rate limit or resend cooldown active", content: errorJsonContent },
    502: { description: "Upstream SMTP relay failed", content: errorJsonContent },
    503: { description: "Email delivery service not configured", content: errorJsonContent },
  },
});

const registerWithPasswordRoute = createRoute({
  method: "post",
  path: "/auth/register",
  tags: ["Auth"],
  summary: "Verify 6-digit email activation code, create account with password, and sign in",
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: RegisterWithPasswordBodySchema,
        },
      },
    },
  },
  responses: {
    201: {
      description: "Account created and human session issued",
      content: {
        "application/json": {
          schema: AuthSessionResponseSchema,
        },
      },
    },
    400: { description: "Invalid payload or verification code", content: errorJsonContent },
    403: {
      description: "Public signup disabled or email domain not allowed",
      content: errorJsonContent,
    },
    409: { description: "Email is already registered", content: errorJsonContent },
    429: { description: "Rate limit or OTP max attempts exceeded", content: errorJsonContent },
  },
});

const loginWithPasswordRoute = createRoute({
  method: "post",
  path: "/auth/login",
  tags: ["Auth"],
  summary: "Sign in with email and password and issue human session cookie & bearer token",
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: LoginWithPasswordBodySchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: "Authenticated human user and issued oh_ses_ session",
      content: {
        "application/json": {
          schema: AuthSessionResponseSchema,
        },
      },
    },
    400: { description: "Invalid login payload", content: errorJsonContent },
    401: { description: "Invalid email or password", content: errorJsonContent },
    403: { description: "Account has been suspended", content: errorJsonContent },
    429: { description: "Too many failed login attempts", content: errorJsonContent },
  },
});

const requestPasswordResetCodeRoute = createRoute({
  method: "post",
  path: "/auth/password-reset/request-code",
  tags: ["Auth"],
  summary: "Request a 6-digit email verification code to reset or set a login password",
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: RequestPasswordResetCodeBodySchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: "Reset code dispatched (anti-enumeration silent success for unknown emails)",
      content: {
        "application/json": {
          schema: AuthCodeSentResponseSchema,
        },
      },
    },
    400: { description: "Invalid email payload", content: errorJsonContent },
    403: { description: "Account has been suspended", content: errorJsonContent },
    429: { description: "Rate limit or resend cooldown active", content: errorJsonContent },
    502: { description: "Upstream SMTP relay failed", content: errorJsonContent },
    503: { description: "Email delivery service not configured", content: errorJsonContent },
  },
});

const confirmPasswordResetRoute = createRoute({
  method: "post",
  path: "/auth/password-reset/confirm",
  tags: ["Auth"],
  summary:
    "Verify 6-digit reset code, update password, revoke old sessions, and issue a fresh session",
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: ConfirmPasswordResetBodySchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: "Password updated and fresh human session issued",
      content: {
        "application/json": {
          schema: AuthSessionResponseSchema,
        },
      },
    },
    400: {
      description: "Invalid or expired reset code / invalid password",
      content: errorJsonContent,
    },
    403: { description: "Account has been suspended", content: errorJsonContent },
    429: { description: "Rate limit or OTP max attempts exceeded", content: errorJsonContent },
  },
});

const changePasswordRoute = createRoute({
  method: "post",
  path: "/auth/password/change",
  tags: ["Auth"],
  summary: "Change password (or set initial password for legacy users) and rotate active session",
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: ChangePasswordBodySchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: "Password changed and fresh session issued",
      content: {
        "application/json": {
          schema: AuthSessionResponseSchema,
        },
      },
    },
    400: { description: "Invalid new password", content: errorJsonContent },
    401: {
      description: "Missing credentials or incorrect current password",
      content: errorJsonContent,
    },
    403: { description: "Agents cannot call human password endpoints", content: errorJsonContent },
  },
});

const requestOtpRoute = createRoute({
  method: "post",
  path: "/auth/otp/request",
  tags: ["Auth"],
  summary: "[Legacy compatibility] Request a 6-digit email OTP verification code",
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
    400: { description: "Invalid email payload", content: errorJsonContent },
    403: { description: "Account suspended or signup restricted", content: errorJsonContent },
    429: { description: "Rate limit or resend cooldown active", content: errorJsonContent },
    502: { description: "Upstream SMTP relay failed", content: errorJsonContent },
    503: { description: "Email delivery service not configured", content: errorJsonContent },
  },
});

const verifyOtpRoute = createRoute({
  method: "post",
  path: "/auth/otp/verify",
  tags: ["Auth"],
  summary:
    "[Legacy compatibility] Verify 6-digit OTP code and issue human session cookie & bearer token",
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
    401: { description: "Invalid or expired OTP code", content: errorJsonContent },
    403: {
      description: "Account has been suspended or signup restricted",
      content: errorJsonContent,
    },
    429: { description: "Rate limit or OTP max attempts exceeded", content: errorJsonContent },
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
    401: { description: "Missing or invalid credentials", content: errorJsonContent },
  },
});

const patchMeRoute = createRoute({
  method: "patch",
  path: "/me",
  tags: ["Auth"],
  summary: "Update caller profile, including appearance preferences for signed-in humans",
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
    401: { description: "Missing or invalid credentials", content: errorJsonContent },
    403: {
      description: "Agent cannot set human appearance preferences",
      content: errorJsonContent,
    },
  },
});

function writeSessionCookie(c: Context, env: ServerEnv, sessionToken: string): void {
  setCookie(c, SESSION_COOKIE_NAME, sessionToken, {
    httpOnly: true,
    path: "/",
    sameSite: "Lax",
    maxAge: SESSION_TTL_SEC,
    secure: env.NODE_ENV === "production",
  });
}

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

  router.openapi(authConfigRoute, async (c) => {
    return c.json(deps.authService.getPublicConfig(), 200);
  });

  router.openapi(requestRegisterCodeRoute, async (c) => {
    const body = c.req.valid("json");
    const response = await deps.authService.requestRegisterCode(body, extractClientIp(c));
    return c.json(response, 200);
  });

  router.openapi(registerWithPasswordRoute, async (c) => {
    const body = c.req.valid("json");
    const result = await deps.authService.registerWithPassword(body, extractClientIp(c));
    writeSessionCookie(c, deps.env, result.sessionToken);
    return c.json(result, 201);
  });

  router.openapi(loginWithPasswordRoute, async (c) => {
    const body = c.req.valid("json");
    const result = await deps.authService.loginWithPassword(body, extractClientIp(c));
    writeSessionCookie(c, deps.env, result.sessionToken);
    return c.json(result, 200);
  });

  router.openapi(requestPasswordResetCodeRoute, async (c) => {
    const body = c.req.valid("json");
    const response = await deps.authService.requestPasswordResetCode(body, extractClientIp(c));
    return c.json(response, 200);
  });

  router.openapi(confirmPasswordResetRoute, async (c) => {
    const body = c.req.valid("json");
    const result = await deps.authService.confirmPasswordReset(body, extractClientIp(c));
    writeSessionCookie(c, deps.env, result.sessionToken);
    return c.json(result, 200);
  });

  router.use("/auth/password/change", requireAuth);
  router.openapi(changePasswordRoute, async (c) => {
    const caller = c.get("caller");
    const body = c.req.valid("json");
    const result = await deps.authService.changePassword(caller, body);
    writeSessionCookie(c, deps.env, result.sessionToken);
    return c.json(result, 200);
  });

  router.openapi(requestOtpRoute, async (c) => {
    const body = c.req.valid("json");
    const response = await deps.authService.requestOtp(body, extractClientIp(c));
    return c.json(response, 200);
  });

  router.openapi(verifyOtpRoute, async (c) => {
    const body = c.req.valid("json");
    const result = await deps.authService.verifyOtp(body, extractClientIp(c));
    writeSessionCookie(c, deps.env, result.sessionToken);
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
