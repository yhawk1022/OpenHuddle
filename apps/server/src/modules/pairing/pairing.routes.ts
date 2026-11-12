/**
 * @module server/modules/pairing/routes
 * @description 配对码签发（`POST /api/v1/pairing-codes`）与公开 Agent 绑定（`POST /api/v1/pair`）OpenAPI 路由模块。
 *
 * 架构职责与关键不变量（Invariants）：
 * 路由层仅做 OpenAPI 入参校验、鉴权中间件挂载与 HTTP 201 序列化，所有锁与认领判定下沉至 `PairingService`。
 */
import { type OpenAPIHono, createRoute } from "@hono/zod-openapi";
import {
  ApiErrorEnvelopeSchema,
  CreatePairingCodeBodySchema,
  CreatePairingCodeResponseSchema,
  PairAgentRequestSchema,
  PairAgentResponseSchema,
} from "@openhuddle/protocol";
import { createRequireAuthMiddleware } from "../../infra/auth-middleware.js";
import { createOpenApiRouter } from "../../infra/openapi-router.js";
import type { AuthService } from "../auth/auth.service.js";
import type { PairingService } from "./pairing.service.js";

const createPairingCodeRoute = createRoute({
  method: "post",
  path: "/pairing-codes",
  tags: ["Pairing"],
  summary: "Issue a one-time HUDDLE-XXXX-XXXX pairing code for a personal AI agent (Human only)",
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: CreatePairingCodeBodySchema,
        },
      },
    },
  },
  responses: {
    201: {
      description: "Pairing code generated with ready-to-paste onboarding prompt",
      content: {
        "application/json": {
          schema: CreatePairingCodeResponseSchema,
        },
      },
    },
    401: {
      description: "Unauthenticated",
      content: {
        "application/json": {
          schema: ApiErrorEnvelopeSchema,
        },
      },
    },
    403: {
      description: "Caller is not a human owner or not a member of autoJoinRoomId",
      content: {
        "application/json": {
          schema: ApiErrorEnvelopeSchema,
        },
      },
    },
  },
});

const pairAgentRoute = createRoute({
  method: "post",
  path: "/pair",
  tags: ["Pairing"],
  summary: "Bind or reclaim a personal AI agent using a one-time pairing code",
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: PairAgentRequestSchema,
        },
      },
    },
  },
  responses: {
    201: {
      description: "Agent paired and scoped oh_agt_ bearer token issued",
      content: {
        "application/json": {
          schema: PairAgentResponseSchema,
        },
      },
    },
    400: {
      description: "Invalid, already used, or expired pairing code",
      content: {
        "application/json": {
          schema: ApiErrorEnvelopeSchema,
        },
      },
    },
    409: {
      description: "Agent slug already active without reclaim=true",
      content: {
        "application/json": {
          schema: ApiErrorEnvelopeSchema,
        },
      },
    },
  },
});

/**
 * 创建配对接入 OpenAPI 子路由器。
 *
 * @param deps - 认证服务与配对服务实例
 * @returns 挂载了 `/pairing-codes` 与 `/pair` 的 `OpenAPIHono`
 */
export function createPairingRouter(deps: {
  readonly authService: AuthService;
  readonly pairingService: PairingService;
}): OpenAPIHono {
  const router = createOpenApiRouter();
  const requireAuth = createRequireAuthMiddleware(deps.authService);

  router.use("/pairing-codes", requireAuth);

  router.openapi(createPairingCodeRoute, async (c) => {
    const caller = c.get("caller");
    const body = c.req.valid("json");
    const result = await deps.pairingService.createPairingCode(caller, body);
    return c.json(result, 201);
  });

  router.openapi(pairAgentRoute, async (c) => {
    const body = c.req.valid("json");
    const result = await deps.pairingService.pairAgent(body);
    return c.json(result, 201);
  });

  return router;
}
