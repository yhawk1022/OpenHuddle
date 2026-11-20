/**
 * @module server/modules/admin/routes
 * @description 运营与治理管理后台 OpenAPI 路由模块（`/api/v1/admin/*`）。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 全局强管理员门禁：通过 `router.use("/admin/*", requireAdmin)` 统一校验人类管理员会话，彻底拒绝未登录、普通用户及任何 Agent 令牌。
 * 2. 路由层纯净：仅做 `@openhuddle/protocol` Zod 契约绑定、请求参数提取与结果序列化，所有权限护栏与审计落库均位于 `AdminService`。
 * 3. OpenAPI 活文档同源：自动纳入 `/api/openapi.json` 与 `/api/docs`（Tag: `Admin`）。
 */
import { type OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
  AdminAgentListQuerySchema,
  AdminAgentListResponseSchema,
  AdminAuditLogListQuerySchema,
  AdminAuditLogListResponseSchema,
  AdminDeleteAgentResponseSchema,
  AdminDeleteProposalResponseSchema,
  AdminDeleteRoomResponseSchema,
  AdminDeleteUserResponseSchema,
  AdminOverviewQuerySchema,
  AdminOverviewResponseSchema,
  AdminPairingCodeListQuerySchema,
  AdminPairingCodeListResponseSchema,
  AdminProposalListQuerySchema,
  AdminProposalListResponseSchema,
  AdminPurgeExpiredSessionsResponseSchema,
  AdminPurgePairingCodesResponseSchema,
  AdminRecallMessageBodySchema,
  AdminRecallMessageResponseSchema,
  AdminRevokePairingCodeResponseSchema,
  AdminRevokeSessionResponseSchema,
  AdminRevokeUserSessionsResponseSchema,
  AdminRoomDetailResponseSchema,
  AdminRoomListQuerySchema,
  AdminRoomListResponseSchema,
  AdminRoomMessagesQuerySchema,
  AdminRoomMessagesResponseSchema,
  AdminSessionListQuerySchema,
  AdminSessionListResponseSchema,
  AdminUpdateRoomBodySchema,
  AdminUpdateRoomResponseSchema,
  AdminUpdateUserBodySchema,
  AdminUpdateUserResponseSchema,
  AdminUserDetailResponseSchema,
  AdminUserListQuerySchema,
  AdminUserListResponseSchema,
  AgentIdSchema,
  ApiErrorEnvelopeSchema,
  PairingCodeSchema,
  ProposalIdSchema,
  RoomIdSchema,
  SessionIdSchema,
  UserIdSchema,
  asMessageSeq,
} from "@openhuddle/protocol";
import { createRequireAdminMiddleware } from "../../infra/auth-middleware.js";
import { createOpenApiRouter } from "../../infra/openapi-router.js";
import type { AuthService } from "../auth/auth.service.js";
import type { AdminService } from "./admin.service.js";

const UserIdParamsSchema = z.object({
  userId: UserIdSchema,
});

const SessionIdParamsSchema = z.object({
  sessionId: SessionIdSchema,
});

const RoomIdParamsSchema = z.object({
  roomId: RoomIdSchema,
});

const RoomMessageParamsSchema = z.object({
  roomId: RoomIdSchema,
  seq: z.coerce.number().int().min(1).transform(asMessageSeq),
});

const AgentIdParamsSchema = z.object({
  agentId: AgentIdSchema,
});

const ProposalIdParamsSchema = z.object({
  proposalId: ProposalIdSchema,
});

const PairingCodeParamsSchema = z.object({
  code: PairingCodeSchema,
});

const adminErrorResponses = {
  400: {
    description: "Validation failed or admin guardrail violation",
    content: { "application/json": { schema: ApiErrorEnvelopeSchema } },
  },
  401: {
    description: "Authentication required",
    content: { "application/json": { schema: ApiErrorEnvelopeSchema } },
  },
  403: {
    description: "Platform administrator privileges required",
    content: { "application/json": { schema: ApiErrorEnvelopeSchema } },
  },
  404: {
    description: "Target resource not found",
    content: { "application/json": { schema: ApiErrorEnvelopeSchema } },
  },
} as const;

const getOverviewRoute = createRoute({
  method: "get",
  path: "/admin/overview",
  tags: ["Admin"],
  summary:
    "Get platform KPIs, daily growth/message trends, distributions, top rankings, and runtime telemetry",
  request: { query: AdminOverviewQuerySchema },
  responses: {
    200: {
      description: "Platform analytics overview",
      content: { "application/json": { schema: AdminOverviewResponseSchema } },
    },
    ...adminErrorResponses,
  },
});

const listUsersRoute = createRoute({
  method: "get",
  path: "/admin/users",
  tags: ["Admin"],
  summary: "List human user accounts with filters, resource counts, and pagination",
  request: { query: AdminUserListQuerySchema },
  responses: {
    200: {
      description: "Paginated user list",
      content: { "application/json": { schema: AdminUserListResponseSchema } },
    },
    ...adminErrorResponses,
  },
});

const getUserDetailRoute = createRoute({
  method: "get",
  path: "/admin/users/{userId}",
  tags: ["Admin"],
  summary: "Inspect a single user account along with owned agents, joined rooms, and sessions",
  request: { params: UserIdParamsSchema },
  responses: {
    200: {
      description: "Detailed user profile and associated entities",
      content: { "application/json": { schema: AdminUserDetailResponseSchema } },
    },
    ...adminErrorResponses,
  },
});

const updateUserRoute = createRoute({
  method: "patch",
  path: "/admin/users/{userId}",
  tags: ["Admin"],
  summary: "Update user display name, role (user/admin), or suspension status",
  request: {
    params: UserIdParamsSchema,
    body: {
      required: true,
      content: { "application/json": { schema: AdminUpdateUserBodySchema } },
    },
  },
  responses: {
    200: {
      description: "Updated user account",
      content: { "application/json": { schema: AdminUpdateUserResponseSchema } },
    },
    ...adminErrorResponses,
  },
});

const deleteUserRoute = createRoute({
  method: "delete",
  path: "/admin/users/{userId}",
  tags: ["Admin"],
  summary:
    "Permanently delete a user account and cascade clean up owned rooms, agents, and sessions",
  request: { params: UserIdParamsSchema },
  responses: {
    200: {
      description: "User deleted and cascaded",
      content: { "application/json": { schema: AdminDeleteUserResponseSchema } },
    },
    ...adminErrorResponses,
  },
});

const revokeUserSessionsRoute = createRoute({
  method: "post",
  path: "/admin/users/{userId}/sessions/revoke-all",
  tags: ["Admin"],
  summary: "Force sign-out all active web sessions belonging to a user",
  request: { params: UserIdParamsSchema },
  responses: {
    200: {
      description: "User sessions revoked",
      content: { "application/json": { schema: AdminRevokeUserSessionsResponseSchema } },
    },
    ...adminErrorResponses,
  },
});

const listSessionsRoute = createRoute({
  method: "get",
  path: "/admin/sessions",
  tags: ["Admin"],
  summary: "List human web login sessions across the platform",
  request: { query: AdminSessionListQuerySchema },
  responses: {
    200: {
      description: "Paginated session list",
      content: { "application/json": { schema: AdminSessionListResponseSchema } },
    },
    ...adminErrorResponses,
  },
});

const revokeSessionRoute = createRoute({
  method: "delete",
  path: "/admin/sessions/{sessionId}",
  tags: ["Admin"],
  summary: "Revoke a single web login session immediately",
  request: { params: SessionIdParamsSchema },
  responses: {
    200: {
      description: "Session revoked",
      content: { "application/json": { schema: AdminRevokeSessionResponseSchema } },
    },
    ...adminErrorResponses,
  },
});

const purgeExpiredSessionsRoute = createRoute({
  method: "post",
  path: "/admin/sessions/purge-expired",
  tags: ["Admin"],
  summary: "Purge all expired web login sessions from storage",
  responses: {
    200: {
      description: "Expired sessions purged",
      content: { "application/json": { schema: AdminPurgeExpiredSessionsResponseSchema } },
    },
    ...adminErrorResponses,
  },
});

const listRoomsRoute = createRoute({
  method: "get",
  path: "/admin/rooms",
  tags: ["Admin"],
  summary: "List all huddle rooms across the platform with member/message/proposal stats",
  request: { query: AdminRoomListQuerySchema },
  responses: {
    200: {
      description: "Paginated room list",
      content: { "application/json": { schema: AdminRoomListResponseSchema } },
    },
    ...adminErrorResponses,
  },
});

const getRoomDetailRoute = createRoute({
  method: "get",
  path: "/admin/rooms/{roomId}",
  tags: ["Admin"],
  summary: "Inspect any huddle room's metadata, live members, and proposals",
  request: { params: RoomIdParamsSchema },
  responses: {
    200: {
      description: "Detailed room view",
      content: { "application/json": { schema: AdminRoomDetailResponseSchema } },
    },
    ...adminErrorResponses,
  },
});

const getRoomMessagesRoute = createRoute({
  method: "get",
  path: "/admin/rooms/{roomId}/messages",
  tags: ["Admin"],
  summary:
    "Inspect messages in any room for content moderation (without advancing member read cursors)",
  request: {
    params: RoomIdParamsSchema,
    query: AdminRoomMessagesQuerySchema,
  },
  responses: {
    200: {
      description: "Chronological room messages",
      content: { "application/json": { schema: AdminRoomMessagesResponseSchema } },
    },
    ...adminErrorResponses,
  },
});

const updateRoomRoute = createRoute({
  method: "patch",
  path: "/admin/rooms/{roomId}",
  tags: ["Admin"],
  summary:
    "Update room metadata, visibility, or governance configuration (including budget renewal)",
  request: {
    params: RoomIdParamsSchema,
    body: {
      required: true,
      content: { "application/json": { schema: AdminUpdateRoomBodySchema } },
    },
  },
  responses: {
    200: {
      description: "Updated room summary",
      content: { "application/json": { schema: AdminUpdateRoomResponseSchema } },
    },
    ...adminErrorResponses,
  },
});

const deleteRoomRoute = createRoute({
  method: "delete",
  path: "/admin/rooms/{roomId}",
  tags: ["Admin"],
  summary: "Force delete any huddle room and notify connected subscribers",
  request: { params: RoomIdParamsSchema },
  responses: {
    200: {
      description: "Room deleted",
      content: { "application/json": { schema: AdminDeleteRoomResponseSchema } },
    },
    ...adminErrorResponses,
  },
});

const recallRoomMessageRoute = createRoute({
  method: "post",
  path: "/admin/rooms/{roomId}/messages/{seq}/recall",
  tags: ["Admin"],
  summary: "Force recall any message in a room regardless of author recall window",
  request: {
    params: RoomMessageParamsSchema,
    body: {
      required: false,
      content: { "application/json": { schema: AdminRecallMessageBodySchema } },
    },
  },
  responses: {
    200: {
      description: "Message recalled",
      content: { "application/json": { schema: AdminRecallMessageResponseSchema } },
    },
    ...adminErrorResponses,
  },
});

const listAgentsRoute = createRoute({
  method: "get",
  path: "/admin/agents",
  tags: ["Admin"],
  summary: "List all paired personal/hosted agents across all owners",
  request: { query: AdminAgentListQuerySchema },
  responses: {
    200: {
      description: "Paginated agent list",
      content: { "application/json": { schema: AdminAgentListResponseSchema } },
    },
    ...adminErrorResponses,
  },
});

const deleteAgentRoute = createRoute({
  method: "delete",
  path: "/admin/agents/{agentId}",
  tags: ["Admin"],
  summary: "Force revoke and delete any agent across the platform",
  request: { params: AgentIdParamsSchema },
  responses: {
    200: {
      description: "Agent deleted",
      content: { "application/json": { schema: AdminDeleteAgentResponseSchema } },
    },
    ...adminErrorResponses,
  },
});

const listProposalsRoute = createRoute({
  method: "get",
  path: "/admin/proposals",
  tags: ["Admin"],
  summary: "List structured proposals and human decisions across all rooms",
  request: { query: AdminProposalListQuerySchema },
  responses: {
    200: {
      description: "Paginated proposal list",
      content: { "application/json": { schema: AdminProposalListResponseSchema } },
    },
    ...adminErrorResponses,
  },
});

const deleteProposalRoute = createRoute({
  method: "delete",
  path: "/admin/proposals/{proposalId}",
  tags: ["Admin"],
  summary: "Delete a proposal and its votes from the platform",
  request: { params: ProposalIdParamsSchema },
  responses: {
    200: {
      description: "Proposal deleted",
      content: { "application/json": { schema: AdminDeleteProposalResponseSchema } },
    },
    ...adminErrorResponses,
  },
});

const listPairingCodesRoute = createRoute({
  method: "get",
  path: "/admin/pairing-codes",
  tags: ["Admin"],
  summary: "List agent pairing codes and their lifecycle status",
  request: { query: AdminPairingCodeListQuerySchema },
  responses: {
    200: {
      description: "Paginated pairing codes list",
      content: { "application/json": { schema: AdminPairingCodeListResponseSchema } },
    },
    ...adminErrorResponses,
  },
});

const revokePairingCodeRoute = createRoute({
  method: "delete",
  path: "/admin/pairing-codes/{code}",
  tags: ["Admin"],
  summary: "Revoke and delete a pairing code",
  request: { params: PairingCodeParamsSchema },
  responses: {
    200: {
      description: "Pairing code revoked",
      content: { "application/json": { schema: AdminRevokePairingCodeResponseSchema } },
    },
    ...adminErrorResponses,
  },
});

const purgePairingCodesRoute = createRoute({
  method: "post",
  path: "/admin/pairing-codes/purge-expired",
  tags: ["Admin"],
  summary: "Purge all used and expired pairing codes",
  responses: {
    200: {
      description: "Inactive pairing codes purged",
      content: { "application/json": { schema: AdminPurgePairingCodesResponseSchema } },
    },
    ...adminErrorResponses,
  },
});

const listAuditLogsRoute = createRoute({
  method: "get",
  path: "/admin/audit-logs",
  tags: ["Admin"],
  summary: "Query chronological administrator action audit logs",
  request: { query: AdminAuditLogListQuerySchema },
  responses: {
    200: {
      description: "Paginated audit logs",
      content: { "application/json": { schema: AdminAuditLogListResponseSchema } },
    },
    ...adminErrorResponses,
  },
});

/**
 * 创建运营与治理管理后台 OpenAPI 子路由器。
 *
 * @param deps - 认证服务与后台管理编排服务
 * @returns 挂载了 `/admin/*` 全量管理契约的 `OpenAPIHono`
 */
export function createAdminRouter(deps: {
  readonly authService: AuthService;
  readonly adminService: AdminService;
}): OpenAPIHono {
  const router = createOpenApiRouter();
  const requireAdmin = createRequireAdminMiddleware(deps.authService);

  router.use("/admin/*", requireAdmin);

  router.openapi(getOverviewRoute, async (c) => {
    const caller = c.get("caller");
    const { days } = c.req.valid("query");
    const result = await deps.adminService.getOverview(caller, days);
    return c.json(result, 200);
  });

  router.openapi(listUsersRoute, async (c) => {
    const caller = c.get("caller");
    const query = c.req.valid("query");
    const result = await deps.adminService.listUsers(caller, query);
    return c.json(
      { ok: true as const, users: [...result.users], pagination: result.pagination },
      200,
    );
  });

  router.openapi(getUserDetailRoute, async (c) => {
    const caller = c.get("caller");
    const { userId } = c.req.valid("param");
    const result = await deps.adminService.getUserDetail(caller, userId);
    return c.json(result, 200);
  });

  router.openapi(updateUserRoute, async (c) => {
    const caller = c.get("caller");
    const { userId } = c.req.valid("param");
    const body = c.req.valid("json");
    const result = await deps.adminService.updateUser(caller, userId, body);
    return c.json(result, 200);
  });

  router.openapi(deleteUserRoute, async (c) => {
    const caller = c.get("caller");
    const { userId } = c.req.valid("param");
    const result = await deps.adminService.deleteUser(caller, userId);
    return c.json(result, 200);
  });

  router.openapi(revokeUserSessionsRoute, async (c) => {
    const caller = c.get("caller");
    const { userId } = c.req.valid("param");
    const result = await deps.adminService.revokeAllUserSessions(caller, userId);
    return c.json(result, 200);
  });

  router.openapi(listSessionsRoute, async (c) => {
    const caller = c.get("caller");
    const query = c.req.valid("query");
    const result = await deps.adminService.listSessions(caller, query);
    return c.json(
      { ok: true as const, sessions: [...result.sessions], pagination: result.pagination },
      200,
    );
  });

  router.openapi(purgeExpiredSessionsRoute, async (c) => {
    const caller = c.get("caller");
    const result = await deps.adminService.purgeExpiredSessions(caller);
    return c.json(result, 200);
  });

  router.openapi(revokeSessionRoute, async (c) => {
    const caller = c.get("caller");
    const { sessionId } = c.req.valid("param");
    const result = await deps.adminService.revokeSession(caller, sessionId);
    return c.json(result, 200);
  });

  router.openapi(listRoomsRoute, async (c) => {
    const caller = c.get("caller");
    const query = c.req.valid("query");
    const result = await deps.adminService.listRooms(caller, query);
    return c.json(
      { ok: true as const, rooms: [...result.rooms], pagination: result.pagination },
      200,
    );
  });

  router.openapi(getRoomDetailRoute, async (c) => {
    const caller = c.get("caller");
    const { roomId } = c.req.valid("param");
    const result = await deps.adminService.getRoomDetail(caller, roomId);
    return c.json(result, 200);
  });

  router.openapi(getRoomMessagesRoute, async (c) => {
    const caller = c.get("caller");
    const { roomId } = c.req.valid("param");
    const query = c.req.valid("query");
    const result = await deps.adminService.getRoomMessages(caller, roomId, query);
    return c.json(result, 200);
  });

  router.openapi(updateRoomRoute, async (c) => {
    const caller = c.get("caller");
    const { roomId } = c.req.valid("param");
    const body = c.req.valid("json");
    const result = await deps.adminService.updateRoom(caller, roomId, body);
    return c.json(result, 200);
  });

  router.openapi(deleteRoomRoute, async (c) => {
    const caller = c.get("caller");
    const { roomId } = c.req.valid("param");
    const result = await deps.adminService.deleteRoom(caller, roomId);
    return c.json(result, 200);
  });

  router.openapi(recallRoomMessageRoute, async (c) => {
    const caller = c.get("caller");
    const { roomId, seq } = c.req.valid("param");
    let rawJson: unknown = {};
    try {
      rawJson = await c.req.json();
    } catch {
      rawJson = {};
    }
    const body = AdminRecallMessageBodySchema.parse(rawJson ?? {});
    const result = await deps.adminService.recallMessage(caller, roomId, seq, body);
    return c.json(result, 200);
  });

  router.openapi(listAgentsRoute, async (c) => {
    const caller = c.get("caller");
    const query = c.req.valid("query");
    const result = await deps.adminService.listAgents(caller, query);
    return c.json(
      { ok: true as const, agents: [...result.agents], pagination: result.pagination },
      200,
    );
  });

  router.openapi(deleteAgentRoute, async (c) => {
    const caller = c.get("caller");
    const { agentId } = c.req.valid("param");
    const result = await deps.adminService.deleteAgent(caller, agentId);
    return c.json(result, 200);
  });

  router.openapi(listProposalsRoute, async (c) => {
    const caller = c.get("caller");
    const query = c.req.valid("query");
    const result = await deps.adminService.listProposals(caller, query);
    return c.json(
      { ok: true as const, proposals: [...result.proposals], pagination: result.pagination },
      200,
    );
  });

  router.openapi(deleteProposalRoute, async (c) => {
    const caller = c.get("caller");
    const { proposalId } = c.req.valid("param");
    const result = await deps.adminService.deleteProposal(caller, proposalId);
    return c.json(result, 200);
  });

  router.openapi(listPairingCodesRoute, async (c) => {
    const caller = c.get("caller");
    const query = c.req.valid("query");
    const result = await deps.adminService.listPairingCodes(caller, query);
    return c.json(
      {
        ok: true as const,
        pairingCodes: [...result.pairingCodes],
        pagination: result.pagination,
      },
      200,
    );
  });

  router.openapi(purgePairingCodesRoute, async (c) => {
    const caller = c.get("caller");
    const result = await deps.adminService.purgePairingCodes(caller);
    return c.json(result, 200);
  });

  router.openapi(revokePairingCodeRoute, async (c) => {
    const caller = c.get("caller");
    const { code } = c.req.valid("param");
    const result = await deps.adminService.revokePairingCode(caller, code);
    return c.json(result, 200);
  });

  router.openapi(listAuditLogsRoute, async (c) => {
    const caller = c.get("caller");
    const query = c.req.valid("query");
    const result = await deps.adminService.listAuditLogs(caller, query);
    return c.json(
      { ok: true as const, logs: [...result.logs], pagination: result.pagination },
      200,
    );
  });

  return router;
}
