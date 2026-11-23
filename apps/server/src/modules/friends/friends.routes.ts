/**
 * @module server/modules/friends/routes
 * @description 站内用户搜索（`/users/search`）与好友关系管理（`/friends*`）OpenAPI 路由模块（ADR-0005）。
 *
 * 架构职责与关键不变量（Invariants）：
 * 路由层零 SQL、零权限分支，统一挂载 `requireAuth` 并将请求委派给 `FriendsService`。
 */
import { type OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
  AcceptFriendRequestResponseSchema,
  ApiErrorEnvelopeSchema,
  DirectoryUserSearchQuerySchema,
  DirectoryUserSearchResponseSchema,
  FriendsOverviewResponseSchema,
  FriendshipIdSchema,
  RemoveFriendshipResponseSchema,
  SendFriendRequestBodySchema,
  SendFriendRequestResponseSchema,
  UpdateFriendRemarkBodySchema,
  UpdateFriendRemarkResponseSchema,
  UserIdSchema,
} from "@openhuddle/protocol";
import { createRequireAuthMiddleware } from "../../infra/auth-middleware.js";
import { createOpenApiRouter } from "../../infra/openapi-router.js";
import type { AuthService } from "../auth/auth.service.js";
import type { FriendsService } from "./friends.service.js";

const FriendshipIdParamsSchema = z.object({
  friendshipId: FriendshipIdSchema,
});

const FriendUserIdParamsSchema = z.object({
  friendUserId: UserIdSchema,
});

const errorJsonContent = {
  "application/json": {
    schema: ApiErrorEnvelopeSchema,
  },
} as const;

const searchUsersRoute = createRoute({
  method: "get",
  path: "/users/search",
  tags: ["Friends"],
  summary: "Search active platform users by display name or email (Human only)",
  request: {
    query: DirectoryUserSearchQuerySchema,
  },
  responses: {
    200: {
      description: "Matched active users with friendship relationship status",
      content: { "application/json": { schema: DirectoryUserSearchResponseSchema } },
    },
    401: { description: "Unauthenticated", content: errorJsonContent },
    403: { description: "Caller is not a human user", content: errorJsonContent },
  },
});

const getFriendsOverviewRoute = createRoute({
  method: "get",
  path: "/friends",
  tags: ["Friends"],
  summary:
    "List accepted friends, pending friend requests, and cross-owner DM-enabled agents (Human only)",
  responses: {
    200: {
      description: "Friends directory and requests overview",
      content: { "application/json": { schema: FriendsOverviewResponseSchema } },
    },
    401: { description: "Unauthenticated", content: errorJsonContent },
    403: { description: "Caller is not a human user", content: errorJsonContent },
  },
});

const sendFriendRequestRoute = createRoute({
  method: "post",
  path: "/friends/requests",
  tags: ["Friends"],
  summary: "Send a friend request by userId or email (auto-accepts mutual pending requests)",
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: SendFriendRequestBodySchema } },
    },
  },
  responses: {
    201: {
      description: "Friend request created or mutually accepted",
      content: { "application/json": { schema: SendFriendRequestResponseSchema } },
    },
    400: { description: "Invalid payload or self-friending", content: errorJsonContent },
    403: { description: "Caller is not a human user", content: errorJsonContent },
    404: { description: "Target user not found or suspended", content: errorJsonContent },
  },
});

const acceptFriendRequestRoute = createRoute({
  method: "post",
  path: "/friends/requests/{friendshipId}/accept",
  tags: ["Friends"],
  summary: "Accept an incoming pending friend request",
  request: {
    params: FriendshipIdParamsSchema,
  },
  responses: {
    200: {
      description: "Friendship accepted",
      content: { "application/json": { schema: AcceptFriendRequestResponseSchema } },
    },
    403: { description: "Caller is not the addressee of this request", content: errorJsonContent },
    404: { description: "Request not found", content: errorJsonContent },
  },
});

const declineFriendRequestRoute = createRoute({
  method: "post",
  path: "/friends/requests/{friendshipId}/decline",
  tags: ["Friends"],
  summary: "Decline an incoming friend request or cancel an outgoing pending request",
  request: {
    params: FriendshipIdParamsSchema,
  },
  responses: {
    200: {
      description: "Friend request declined or cancelled",
      content: { "application/json": { schema: RemoveFriendshipResponseSchema } },
    },
    403: { description: "Not a participant of this friend request", content: errorJsonContent },
  },
});

const updateFriendRemarkRoute = createRoute({
  method: "patch",
  path: "/friends/{friendshipId}/remark",
  tags: ["Friends"],
  summary: "Set or clear your private remark for an accepted friend (Human only)",
  request: {
    params: FriendshipIdParamsSchema,
    body: {
      required: true,
      content: { "application/json": { schema: UpdateFriendRemarkBodySchema } },
    },
  },
  responses: {
    200: {
      description: "Saved private remark, or null if cleared",
      content: { "application/json": { schema: UpdateFriendRemarkResponseSchema } },
    },
    400: { description: "Invalid remark", content: errorJsonContent },
    401: { description: "Caller is unauthenticated", content: errorJsonContent },
    403: { description: "Caller is not a human user", content: errorJsonContent },
    404: { description: "Accepted friendship unavailable to caller", content: errorJsonContent },
  },
});

const removeFriendRoute = createRoute({
  method: "delete",
  path: "/friends/{friendUserId}",
  tags: ["Friends"],
  summary: "Remove an accepted friend",
  request: {
    params: FriendUserIdParamsSchema,
  },
  responses: {
    200: {
      description: "Friend removed cleanly",
      content: { "application/json": { schema: RemoveFriendshipResponseSchema } },
    },
    403: { description: "Caller is not a human user", content: errorJsonContent },
  },
});

/**
 * 创建挂载在 `/api/v1` 下的站内用户检索与好友管理 OpenAPI 子路由器。
 *
 * @param deps - 认证服务与好友服务
 * @returns `OpenAPIHono` 实例
 */
export function createFriendsRouter(deps: {
  readonly authService: AuthService;
  readonly friendsService: FriendsService;
}): OpenAPIHono {
  const router = createOpenApiRouter();
  const requireAuth = createRequireAuthMiddleware(deps.authService);

  router.use("/users/search", requireAuth);
  router.use("/friends", requireAuth);
  router.use("/friends/*", requireAuth);

  router.openapi(searchUsersRoute, async (c) => {
    const caller = c.get("caller");
    const { q } = c.req.valid("query");
    const result = await deps.friendsService.searchUsers(caller, q);
    return c.json(result, 200);
  });

  router.openapi(getFriendsOverviewRoute, async (c) => {
    const caller = c.get("caller");
    const result = await deps.friendsService.getOverview(caller);
    return c.json(result, 200);
  });

  router.openapi(sendFriendRequestRoute, async (c) => {
    const caller = c.get("caller");
    const body = c.req.valid("json");
    const result = await deps.friendsService.sendFriendRequest(caller, body);
    return c.json(result, 201);
  });

  router.openapi(acceptFriendRequestRoute, async (c) => {
    const caller = c.get("caller");
    const { friendshipId } = c.req.valid("param");
    const result = await deps.friendsService.acceptFriendRequest(caller, friendshipId);
    return c.json(result, 200);
  });

  router.openapi(declineFriendRequestRoute, async (c) => {
    const caller = c.get("caller");
    const { friendshipId } = c.req.valid("param");
    await deps.friendsService.declineOrCancelRequest(caller, friendshipId);
    return c.json({ ok: true as const }, 200);
  });

  router.openapi(updateFriendRemarkRoute, async (c) => {
    const caller = c.get("caller");
    const { friendshipId } = c.req.valid("param");
    const result = await deps.friendsService.updateFriendRemark(
      caller,
      friendshipId,
      c.req.valid("json"),
    );
    return c.json(result, 200);
  });

  router.openapi(removeFriendRoute, async (c) => {
    const caller = c.get("caller");
    const { friendUserId } = c.req.valid("param");
    await deps.friendsService.removeFriend(caller, friendUserId);
    return c.json({ ok: true as const }, 200);
  });

  return router;
}
