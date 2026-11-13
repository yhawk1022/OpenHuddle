/**
 * @module server/modules/pairing/routes
 * @description 配对码签发（`POST /api/v1/pairing-codes`）与公开 Agent 绑定（`POST /api/v1/pair`）OpenAPI 路由模块。
 *
 * 架构职责与关键不变量（Invariants）：
 * 路由层仅做 OpenAPI 入参校验、鉴权中间件挂载与 HTTP 201 序列化，所有锁与认领判定下沉至 `PairingService`。
 */
import { type OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
  AgentIdSchema,
  ApiErrorEnvelopeSchema,
  ConnectLocalAgentBodySchema,
  ConnectLocalAgentResponseSchema,
  CreatePairingCodeBodySchema,
  CreatePairingCodeResponseSchema,
  DeleteOwnedAgentResponseSchema,
  LocalAgentsStatusResponseSchema,
  PairAgentRequestSchema,
  PairAgentResponseSchema,
} from "@openhuddle/protocol";
import { createRequireAuthMiddleware } from "../../infra/auth-middleware.js";
import { createOpenApiRouter } from "../../infra/openapi-router.js";
import type { AuthService } from "../auth/auth.service.js";
import type { LocalConnectService } from "./local-connect.service.js";
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

const localAgentsStatusRoute = createRoute({
  method: "get",
  path: "/local-agents/status",
  tags: ["Pairing"],
  summary:
    "Detect installed local coding agent CLIs when running on localhost / 127.0.0.1 (Human only)",
  responses: {
    200: {
      description: "Local CLI availability snapshot",
      content: {
        "application/json": {
          schema: LocalAgentsStatusResponseSchema,
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
      description: "Caller is not a human user",
      content: {
        "application/json": {
          schema: ApiErrorEnvelopeSchema,
        },
      },
    },
  },
});

const connectLocalAgentRoute = createRoute({
  method: "post",
  path: "/local-agents/connect",
  tags: ["Pairing"],
  summary:
    "One-click pair, greet, and start background SSE daemon for a local CLI agent (localhost only)",
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: ConnectLocalAgentBodySchema,
        },
      },
    },
  },
  responses: {
    201: {
      description: "Local CLI agent paired and background SSE listener started",
      content: {
        "application/json": {
          schema: ConnectLocalAgentResponseSchema,
        },
      },
    },
    400: {
      description: "Requested local CLI binary is not installed on host",
      content: {
        "application/json": {
          schema: ApiErrorEnvelopeSchema,
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
      description: "Forbidden on non-loopback deployment or non-human caller",
      content: {
        "application/json": {
          schema: ApiErrorEnvelopeSchema,
        },
      },
    },
  },
});

const deleteOwnedAgentRoute = createRoute({
  method: "delete",
  path: "/agents/{agentId}",
  tags: ["Pairing"],
  summary:
    "Delete an owned personal AI agent, revoke its token, remove it from all rooms, and stop any local listener daemon (Human owner only)",
  request: {
    params: z.object({
      agentId: AgentIdSchema,
    }),
  },
  responses: {
    200: {
      description: "Agent deleted and credentials revoked",
      content: {
        "application/json": {
          schema: DeleteOwnedAgentResponseSchema,
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
      description: "Caller is not the human owner of this agent",
      content: {
        "application/json": {
          schema: ApiErrorEnvelopeSchema,
        },
      },
    },
    404: {
      description: "Target agent not found",
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
 * @param deps - 认证服务、配对服务与可选本机一键直连服务
 * @returns 挂载了 `/pairing-codes`、`/pair`、`/agents/{agentId}` 与 `/local-agents/*` 的 `OpenAPIHono`
 */
export function createPairingRouter(deps: {
  readonly authService: AuthService;
  readonly pairingService: PairingService;
  readonly localConnectService?: LocalConnectService;
}): OpenAPIHono {
  const router = createOpenApiRouter();
  const requireAuth = createRequireAuthMiddleware(deps.authService);

  router.use("/pairing-codes", requireAuth);
  router.use("/agents/*", requireAuth);
  router.use("/local-agents/*", requireAuth);

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

  router.openapi(deleteOwnedAgentRoute, async (c) => {
    const caller = c.get("caller");
    const { agentId } = c.req.valid("param");
    const deleted = await deps.pairingService.deleteOwnedAgent(caller, agentId);
    const stoppedLocalDaemon =
      deps.localConnectService !== undefined
        ? deps.localConnectService.cleanupDeletedLocalAgent(deleted)
        : false;
    return c.json(
      {
        ok: true as const,
        deletedAgentId: deleted.id,
        stoppedLocalDaemon,
      },
      200,
    );
  });

  if (deps.localConnectService !== undefined) {
    const localService = deps.localConnectService;
    router.openapi(localAgentsStatusRoute, (c) => {
      const caller = c.get("caller");
      return c.json(localService.getStatus(caller), 200);
    });

    router.openapi(connectLocalAgentRoute, async (c) => {
      const caller = c.get("caller");
      const body = c.req.valid("json");
      const result = await localService.connectLocalAgent(caller, body);
      return c.json(result, 201);
    });
  }

  return router;
}
