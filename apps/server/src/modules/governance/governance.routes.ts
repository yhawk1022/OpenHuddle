/**
 * @module server/modules/governance/routes
 * @description 房间治理配置热更新与预算续命（`PATCH /api/v1/rooms/:roomId/governance`）OpenAPI 路由模块。
 *
 * 架构职责与关键不变量（Invariants）：
 * 仅声明 OpenAPI 契约与挂载鉴权中间件，实际权限校验、行锁合并与事务后广播由 `GovernanceService` 执行。
 */
import { type OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
  ApiErrorEnvelopeSchema,
  RoomDetailDtoSchema,
  RoomIdSchema,
  UpdateGovernanceBodySchema,
} from "@openhuddle/protocol";
import { createRequireAuthMiddleware } from "../../infra/auth-middleware.js";
import { createOpenApiRouter } from "../../infra/openapi-router.js";
import type { AuthService } from "../auth/auth.service.js";
import type { GovernanceService } from "./governance.service.js";

const RoomIdParamsSchema = z.object({
  roomId: RoomIdSchema,
});

const GovernanceUpdatedResponseSchema = z.object({
  ok: z.literal(true),
  room: RoomDetailDtoSchema,
});

const patchGovernanceRoute = createRoute({
  method: "patch",
  path: "/rooms/{roomId}/governance",
  tags: ["Governance"],
  summary:
    "Update room governance policy, visibility, or renew agent turn budget (Human owner/moderator)",
  request: {
    params: RoomIdParamsSchema,
    body: {
      required: true,
      content: {
        "application/json": {
          schema: UpdateGovernanceBodySchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: "Updated room governance state",
      content: {
        "application/json": {
          schema: GovernanceUpdatedResponseSchema,
        },
      },
    },
    403: {
      description: "Caller is not a human owner or moderator",
      content: {
        "application/json": {
          schema: ApiErrorEnvelopeSchema,
        },
      },
    },
    404: {
      description: "Room not found",
      content: {
        "application/json": {
          schema: ApiErrorEnvelopeSchema,
        },
      },
    },
  },
});

/**
 * 创建房间治理 OpenAPI 子路由器。
 *
 * @param deps - 认证服务与治理领域服务
 * @returns 挂载了 `PATCH /rooms/:roomId/governance` 的 `OpenAPIHono`
 */
export function createGovernanceRouter(deps: {
  readonly authService: AuthService;
  readonly governanceService: GovernanceService;
}): OpenAPIHono {
  const router = createOpenApiRouter();
  const requireAuth = createRequireAuthMiddleware(deps.authService);

  router.use("/rooms/*/governance", requireAuth);

  router.openapi(patchGovernanceRoute, async (c) => {
    const caller = c.get("caller");
    const { roomId } = c.req.valid("param");
    const body = c.req.valid("json");
    const room = await deps.governanceService.updateRoomGovernance(caller, roomId, body);
    return c.json({ ok: true as const, room }, 200);
  });

  return router;
}
