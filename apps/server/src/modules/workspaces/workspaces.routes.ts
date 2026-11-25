/**
 * @module server/modules/workspaces/routes
 * @description 五维工作区管理、房间工作区挂载与多 Agent 协作工单/分片租约 OpenAPI 路由模块。
 */
import { type OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
  AnswerWorkAttentionBodySchema,
  ApiErrorEnvelopeSchema,
  BindRoomWorkspaceBodySchema,
  BindRoomWorkspaceResponseSchema,
  ClaimWorkSliceBodySchema,
  ClaimWorkSliceResponseSchema,
  CompleteWorkSliceBodySchema,
  ControlWorkItemBodySchema,
  CreateWorkItemBodySchema,
  CreateWorkspaceBodySchema,
  DecideWorkReviewBodySchema,
  DeleteWorkspaceResponseSchema,
  HeartbeatWorkSliceBodySchema,
  ListWorkItemsQuerySchema,
  ListWorkItemsResponseSchema,
  ListWorkspacesResponseSchema,
  RaiseWorkAttentionBodySchema,
  RoomIdSchema,
  RoomWorkspacesResponseSchema,
  SingleWorkItemResponseSchema,
  SingleWorkspaceResponseSchema,
  SteerWorkItemBodySchema,
  UpdateWorkspaceBodySchema,
  WorkItemIdSchema,
  WorkSliceIdSchema,
  WorkspaceIdSchema,
} from "@openhuddle/protocol";
import { createRequireAuthMiddleware } from "../../infra/auth-middleware.js";
import { createOpenApiRouter } from "../../infra/openapi-router.js";
import type { AuthService } from "../auth/auth.service.js";
import type { WorkspacesService } from "./workspaces.service.js";

const WorkspaceIdParamsSchema = z.object({
  workspaceId: WorkspaceIdSchema,
});

const RoomIdParamsSchema = z.object({
  roomId: RoomIdSchema,
});

const WorkItemIdParamsSchema = z.object({
  workItemId: WorkItemIdSchema,
});

const WorkSliceParamsSchema = z.object({
  workItemId: WorkItemIdSchema,
  sliceId: WorkSliceIdSchema,
});

const listWorkspacesRoute = createRoute({
  method: "get",
  path: "/workspaces",
  tags: ["Workspaces"],
  summary: "List owned 5D workspaces and room workspace bindings",
  responses: {
    200: {
      description: "Owned workspaces and active room bindings",
      content: { "application/json": { schema: ListWorkspacesResponseSchema } },
    },
  },
});

const createWorkspaceRoute = createRoute({
  method: "post",
  path: "/workspaces",
  tags: ["Workspaces"],
  summary: "Create a controlled 5D workspace",
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: CreateWorkspaceBodySchema } },
    },
  },
  responses: {
    201: {
      description: "Created workspace",
      content: { "application/json": { schema: SingleWorkspaceResponseSchema } },
    },
    400: {
      description: "Validation error",
      content: { "application/json": { schema: ApiErrorEnvelopeSchema } },
    },
    403: {
      description: "Caller is not a human owner",
      content: { "application/json": { schema: ApiErrorEnvelopeSchema } },
    },
  },
});

const updateWorkspaceRoute = createRoute({
  method: "patch",
  path: "/workspaces/{workspaceId}",
  tags: ["Workspaces"],
  summary: "Update workspace roots, host mode, sandbox policy, or default agents",
  request: {
    params: WorkspaceIdParamsSchema,
    body: {
      required: true,
      content: { "application/json": { schema: UpdateWorkspaceBodySchema } },
    },
  },
  responses: {
    200: {
      description: "Updated workspace",
      content: { "application/json": { schema: SingleWorkspaceResponseSchema } },
    },
    403: {
      description: "Caller does not own this workspace",
      content: { "application/json": { schema: ApiErrorEnvelopeSchema } },
    },
    404: {
      description: "Workspace not found",
      content: { "application/json": { schema: ApiErrorEnvelopeSchema } },
    },
  },
});

const deleteWorkspaceRoute = createRoute({
  method: "delete",
  path: "/workspaces/{workspaceId}",
  tags: ["Workspaces"],
  summary: "Delete an owned workspace and cascade room bindings",
  request: {
    params: WorkspaceIdParamsSchema,
  },
  responses: {
    200: {
      description: "Deleted workspace receipt",
      content: { "application/json": { schema: DeleteWorkspaceResponseSchema } },
    },
    403: {
      description: "Caller does not own this workspace",
      content: { "application/json": { schema: ApiErrorEnvelopeSchema } },
    },
    404: {
      description: "Workspace not found",
      content: { "application/json": { schema: ApiErrorEnvelopeSchema } },
    },
  },
});

const bindRoomWorkspaceRoute = createRoute({
  method: "put",
  path: "/rooms/{roomId}/workspace-binding",
  tags: ["Workspaces"],
  summary: "Bind or unbind the caller's owned workspace for a huddle room",
  request: {
    params: RoomIdParamsSchema,
    body: {
      required: true,
      content: { "application/json": { schema: BindRoomWorkspaceBodySchema } },
    },
  },
  responses: {
    200: {
      description: "Updated room workspace binding",
      content: { "application/json": { schema: BindRoomWorkspaceResponseSchema } },
    },
    403: {
      description: "Caller is not a room member or workspace owner",
      content: { "application/json": { schema: ApiErrorEnvelopeSchema } },
    },
  },
});

const listRoomWorkspacesRoute = createRoute({
  method: "get",
  path: "/rooms/{roomId}/workspaces",
  tags: ["Workspaces"],
  summary: "List bound workspaces in a room (local paths automatically redacted for non-owners)",
  request: {
    params: RoomIdParamsSchema,
  },
  responses: {
    200: {
      description: "Viewer-redacted bound workspaces in the room",
      content: { "application/json": { schema: RoomWorkspacesResponseSchema } },
    },
    403: {
      description: "Caller is not a room member",
      content: { "application/json": { schema: ApiErrorEnvelopeSchema } },
    },
  },
});

const listWorkItemsRoute = createRoute({
  method: "get",
  path: "/work-items",
  tags: ["Collaborative Work"],
  summary: "List multi-agent collaborative work items (supports claimableOnly queue filter)",
  request: {
    query: ListWorkItemsQuerySchema,
  },
  responses: {
    200: {
      description: "Hydrated collaborative work items",
      content: { "application/json": { schema: ListWorkItemsResponseSchema } },
    },
  },
});

const createWorkItemRoute = createRoute({
  method: "post",
  path: "/work-items",
  tags: ["Collaborative Work"],
  summary: "Dispatch a direct, verify_loop, or parallel swarm work item",
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: CreateWorkItemBodySchema } },
    },
  },
  responses: {
    201: {
      description: "Work item created and initial workers notified",
      content: { "application/json": { schema: SingleWorkItemResponseSchema } },
    },
    400: {
      description: "Invalid topology or missing verifier",
      content: { "application/json": { schema: ApiErrorEnvelopeSchema } },
    },
    403: {
      description: "Owner-First workspace isolation violation",
      content: { "application/json": { schema: ApiErrorEnvelopeSchema } },
    },
    409: {
      description: "Overlapping ownedPaths across concurrent write slices",
      content: { "application/json": { schema: ApiErrorEnvelopeSchema } },
    },
  },
});

const getWorkItemRoute = createRoute({
  method: "get",
  path: "/work-items/{workItemId}",
  tags: ["Collaborative Work"],
  summary: "Get a hydrated collaborative work item with slice leases and review state",
  request: {
    params: WorkItemIdParamsSchema,
  },
  responses: {
    200: {
      description: "Hydrated work item",
      content: { "application/json": { schema: SingleWorkItemResponseSchema } },
    },
    404: {
      description: "Work item not found",
      content: { "application/json": { schema: ApiErrorEnvelopeSchema } },
    },
  },
});

const claimWorkSliceRoute = createRoute({
  method: "post",
  path: "/work-items/{workItemId}/slices/{sliceId}/claim",
  tags: ["Collaborative Work"],
  summary: "Claim a pending slice or take over an expired lease with monotonic fencing version",
  request: {
    params: WorkSliceParamsSchema,
    body: {
      required: false,
      content: { "application/json": { schema: ClaimWorkSliceBodySchema } },
    },
  },
  responses: {
    200: {
      description: "Lease acquired with bumped fencing version",
      content: { "application/json": { schema: ClaimWorkSliceResponseSchema } },
    },
    403: {
      description: "Unauthorized workspace or slice access",
      content: { "application/json": { schema: ApiErrorEnvelopeSchema } },
    },
    409: {
      description: "Active unexpired lease held or invalid stage transition",
      content: { "application/json": { schema: ApiErrorEnvelopeSchema } },
    },
  },
});

const heartbeatWorkSliceRoute = createRoute({
  method: "post",
  path: "/work-items/{workItemId}/slices/{sliceId}/heartbeat",
  tags: ["Collaborative Work"],
  summary: "Renew slice lease TTL and update live progress summary under fencing version guard",
  request: {
    params: WorkSliceParamsSchema,
    body: {
      required: true,
      content: { "application/json": { schema: HeartbeatWorkSliceBodySchema } },
    },
  },
  responses: {
    200: {
      description: "Renewed slice lease",
      content: { "application/json": { schema: SingleWorkItemResponseSchema } },
    },
    409: {
      description: "Stale or expired leaseVersion",
      content: { "application/json": { schema: ApiErrorEnvelopeSchema } },
    },
  },
});

const raiseWorkAttentionRoute = createRoute({
  method: "post",
  path: "/work-items/{workItemId}/slices/{sliceId}/attention",
  tags: ["Collaborative Work"],
  summary:
    "Pause slice lease and ask a single structured clarification question to the human owner",
  request: {
    params: WorkSliceParamsSchema,
    body: {
      required: true,
      content: { "application/json": { schema: RaiseWorkAttentionBodySchema } },
    },
  },
  responses: {
    200: {
      description: "Work item paused awaiting human answer",
      content: { "application/json": { schema: SingleWorkItemResponseSchema } },
    },
    409: {
      description: "Stale leaseVersion or invalid stage",
      content: { "application/json": { schema: ApiErrorEnvelopeSchema } },
    },
  },
});

const completeWorkSliceRoute = createRoute({
  method: "post",
  path: "/work-items/{workItemId}/slices/{sliceId}/complete",
  tags: ["Collaborative Work"],
  summary:
    "Complete an execution or verification slice (triggers swarm barrier & write->verify relay)",
  request: {
    params: WorkSliceParamsSchema,
    body: {
      required: true,
      content: { "application/json": { schema: CompleteWorkSliceBodySchema } },
    },
  },
  responses: {
    200: {
      description: "Updated work item after slice completion",
      content: { "application/json": { schema: SingleWorkItemResponseSchema } },
    },
    409: {
      description: "Stale leaseVersion or invalid transition",
      content: { "application/json": { schema: ApiErrorEnvelopeSchema } },
    },
  },
});

const steerWorkItemRoute = createRoute({
  method: "post",
  path: "/work-items/{workItemId}/steer",
  tags: ["Collaborative Work"],
  summary: "Inject a mid-run human steering instruction into active slices",
  request: {
    params: WorkItemIdParamsSchema,
    body: {
      required: true,
      content: { "application/json": { schema: SteerWorkItemBodySchema } },
    },
  },
  responses: {
    200: {
      description: "Steering instruction recorded and workers notified",
      content: { "application/json": { schema: SingleWorkItemResponseSchema } },
    },
    403: {
      description: "Caller is not an authorized human owner",
      content: { "application/json": { schema: ApiErrorEnvelopeSchema } },
    },
  },
});

const answerWorkAttentionRoute = createRoute({
  method: "post",
  path: "/work-items/{workItemId}/attention/answer",
  tags: ["Collaborative Work"],
  summary: "Answer a paused worker's clarification prompt and resume execution",
  request: {
    params: WorkItemIdParamsSchema,
    body: {
      required: true,
      content: { "application/json": { schema: AnswerWorkAttentionBodySchema } },
    },
  },
  responses: {
    200: {
      description: "Clarification answered and worker woken",
      content: { "application/json": { schema: SingleWorkItemResponseSchema } },
    },
    403: {
      description: "Caller is not an authorized human owner",
      content: { "application/json": { schema: ApiErrorEnvelopeSchema } },
    },
  },
});

const decideWorkReviewRoute = createRoute({
  method: "post",
  path: "/work-items/{workItemId}/review",
  tags: ["Collaborative Work"],
  summary: "Approve deliverable into done or request rework as the human owner (agents forbidden)",
  request: {
    params: WorkItemIdParamsSchema,
    body: {
      required: true,
      content: { "application/json": { schema: DecideWorkReviewBodySchema } },
    },
  },
  responses: {
    200: {
      description: "Updated work item after human review decision",
      content: { "application/json": { schema: SingleWorkItemResponseSchema } },
    },
    403: {
      description: "Caller is an AI agent or lacks owner authority",
      content: { "application/json": { schema: ApiErrorEnvelopeSchema } },
    },
    409: {
      description: "Work item is not awaiting review",
      content: { "application/json": { schema: ApiErrorEnvelopeSchema } },
    },
  },
});

const controlWorkItemRoute = createRoute({
  method: "post",
  path: "/work-items/{workItemId}/control",
  tags: ["Collaborative Work"],
  summary: "Stop, retry, or escalate a work item to a huddle room",
  request: {
    params: WorkItemIdParamsSchema,
    body: {
      required: true,
      content: { "application/json": { schema: ControlWorkItemBodySchema } },
    },
  },
  responses: {
    200: {
      description: "Updated work item after control action",
      content: { "application/json": { schema: SingleWorkItemResponseSchema } },
    },
    403: {
      description: "Caller is not an authorized human owner",
      content: { "application/json": { schema: ApiErrorEnvelopeSchema } },
    },
  },
});

/**
 * 创建五维工作区与多 Agent 协作任务 OpenAPI 子路由器。
 */
export function createWorkspacesRouter(deps: {
  readonly authService: AuthService;
  readonly workspacesService: WorkspacesService;
}): OpenAPIHono {
  const router = createOpenApiRouter();
  const requireAuth = createRequireAuthMiddleware(deps.authService);

  router.use("/workspaces", requireAuth);
  router.use("/workspaces/*", requireAuth);
  router.use("/rooms/*/workspace-binding", requireAuth);
  router.use("/rooms/*/workspaces", requireAuth);
  router.use("/work-items", requireAuth);
  router.use("/work-items/*", requireAuth);

  router.openapi(listWorkspacesRoute, async (c) => {
    const res = await deps.workspacesService.listWorkspaces(c.get("caller"));
    return c.json(res, 200);
  });

  router.openapi(createWorkspaceRoute, async (c) => {
    const workspace = await deps.workspacesService.createWorkspace(
      c.get("caller"),
      c.req.valid("json"),
    );
    return c.json({ ok: true as const, workspace }, 201);
  });

  router.openapi(updateWorkspaceRoute, async (c) => {
    const { workspaceId } = c.req.valid("param");
    const workspace = await deps.workspacesService.updateWorkspace(
      c.get("caller"),
      workspaceId,
      c.req.valid("json"),
    );
    return c.json({ ok: true as const, workspace }, 200);
  });

  router.openapi(deleteWorkspaceRoute, async (c) => {
    const { workspaceId } = c.req.valid("param");
    const deletedWorkspaceId = await deps.workspacesService.deleteWorkspace(
      c.get("caller"),
      workspaceId,
    );
    return c.json({ ok: true as const, deletedWorkspaceId }, 200);
  });

  router.openapi(bindRoomWorkspaceRoute, async (c) => {
    const { roomId } = c.req.valid("param");
    const res = await deps.workspacesService.bindRoomWorkspace(
      c.get("caller"),
      roomId,
      c.req.valid("json"),
    );
    return c.json(res, 200);
  });

  router.openapi(listRoomWorkspacesRoute, async (c) => {
    const { roomId } = c.req.valid("param");
    const res = await deps.workspacesService.listRoomWorkspaces(c.get("caller"), roomId);
    return c.json(res, 200);
  });

  router.openapi(listWorkItemsRoute, async (c) => {
    const items = await deps.workspacesService.listWorkItems(c.get("caller"), c.req.valid("query"));
    return c.json({ ok: true as const, items: [...items] }, 200);
  });

  router.openapi(createWorkItemRoute, async (c) => {
    const item = await deps.workspacesService.createWorkItem(c.get("caller"), c.req.valid("json"));
    return c.json({ ok: true as const, item }, 201);
  });

  router.openapi(getWorkItemRoute, async (c) => {
    const { workItemId } = c.req.valid("param");
    const item = await deps.workspacesService.getWorkItem(c.get("caller"), workItemId);
    return c.json({ ok: true as const, item }, 200);
  });

  router.openapi(claimWorkSliceRoute, async (c) => {
    const { workItemId, sliceId } = c.req.valid("param");
    let rawJson: unknown = {};
    try {
      rawJson = await c.req.json();
    } catch {
      rawJson = {};
    }
    const body = ClaimWorkSliceBodySchema.parse(rawJson ?? {});
    const res = await deps.workspacesService.claimSlice(c.get("caller"), workItemId, sliceId, body);
    return c.json(res, 200);
  });

  router.openapi(heartbeatWorkSliceRoute, async (c) => {
    const { workItemId, sliceId } = c.req.valid("param");
    const item = await deps.workspacesService.heartbeatSlice(
      c.get("caller"),
      workItemId,
      sliceId,
      c.req.valid("json"),
    );
    return c.json({ ok: true as const, item }, 200);
  });

  router.openapi(raiseWorkAttentionRoute, async (c) => {
    const { workItemId, sliceId } = c.req.valid("param");
    const item = await deps.workspacesService.raiseAttention(
      c.get("caller"),
      workItemId,
      sliceId,
      c.req.valid("json"),
    );
    return c.json({ ok: true as const, item }, 200);
  });

  router.openapi(completeWorkSliceRoute, async (c) => {
    const { workItemId, sliceId } = c.req.valid("param");
    const item = await deps.workspacesService.completeSlice(
      c.get("caller"),
      workItemId,
      sliceId,
      c.req.valid("json"),
    );
    return c.json({ ok: true as const, item }, 200);
  });

  router.openapi(steerWorkItemRoute, async (c) => {
    const { workItemId } = c.req.valid("param");
    const item = await deps.workspacesService.steerWorkItem(
      c.get("caller"),
      workItemId,
      c.req.valid("json"),
    );
    return c.json({ ok: true as const, item }, 200);
  });

  router.openapi(answerWorkAttentionRoute, async (c) => {
    const { workItemId } = c.req.valid("param");
    const item = await deps.workspacesService.answerAttention(
      c.get("caller"),
      workItemId,
      c.req.valid("json"),
    );
    return c.json({ ok: true as const, item }, 200);
  });

  router.openapi(decideWorkReviewRoute, async (c) => {
    const { workItemId } = c.req.valid("param");
    const item = await deps.workspacesService.decideReview(
      c.get("caller"),
      workItemId,
      c.req.valid("json"),
    );
    return c.json({ ok: true as const, item }, 200);
  });

  router.openapi(controlWorkItemRoute, async (c) => {
    const { workItemId } = c.req.valid("param");
    const item = await deps.workspacesService.controlWorkItem(
      c.get("caller"),
      workItemId,
      c.req.valid("json"),
    );
    return c.json({ ok: true as const, item }, 200);
  });

  return router;
}
