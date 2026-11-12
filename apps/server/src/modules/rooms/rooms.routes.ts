/**
 * @module server/modules/rooms/routes
 * @description 房间管理（`/rooms*`、`/join`）与公开分享快照（`/api/v1/share/:inviteToken` 及 HTML OpenGraph `/share/:inviteToken`）路由模块。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 路由层纯净：仅做参数提取、鉴权挂载与响应包装。
 * 2. 社交预览防 XSS：渲染 `/share/:inviteToken` 的 OpenGraph HTML 时对房间名称与主题执行严格 HTML 实体转义。
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { type OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
  ApiErrorEnvelopeSchema,
  CreateRoomBodySchema,
  JoinRoomBodySchema,
  MessageDtoSchema,
  ProposalCardDtoSchema,
  RoomDetailDtoSchema,
  RoomIdSchema,
  RoomMemberDtoSchema,
  RoomSummaryDtoSchema,
} from "@openhuddle/protocol";
import { createRequireAuthMiddleware } from "../../infra/auth-middleware.js";
import type { ServerEnv } from "../../infra/env.js";
import { createOpenApiRouter } from "../../infra/openapi-router.js";
import type { AuthService } from "../auth/auth.service.js";
import type { PublicRoomShareSnapshot, RoomsService } from "./rooms.service.js";

const RoomIdParamsSchema = z.object({
  roomId: RoomIdSchema,
});

const InviteTokenParamsSchema = z.object({
  inviteToken: z.string().trim().min(4).max(128),
});

const ListRoomsResponseSchema = z.object({
  ok: z.literal(true),
  rooms: z.array(RoomSummaryDtoSchema),
});

const SingleRoomResponseSchema = z.object({
  ok: z.literal(true),
  room: RoomDetailDtoSchema,
});

const LeaveRoomResponseSchema = z.object({
  ok: z.literal(true),
});

const RoomMembersResponseSchema = z.object({
  ok: z.literal(true),
  members: z.array(RoomMemberDtoSchema),
});

const PublicShareSnapshotResponseSchema = z.object({
  ok: z.literal(true),
  room: RoomDetailDtoSchema,
  messages: z.array(MessageDtoSchema),
  proposals: z.array(ProposalCardDtoSchema),
});

const listRoomsRoute = createRoute({
  method: "get",
  path: "/rooms",
  tags: ["Rooms"],
  summary: "List huddle rooms joined by the authenticated caller",
  responses: {
    200: {
      description: "Joined rooms summary list",
      content: { "application/json": { schema: ListRoomsResponseSchema } },
    },
  },
});

const createRoomRoute = createRoute({
  method: "post",
  path: "/rooms",
  tags: ["Rooms"],
  summary: "Create a new multi-agent huddle room",
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: CreateRoomBodySchema } },
    },
  },
  responses: {
    201: {
      description: "Created room details",
      content: { "application/json": { schema: SingleRoomResponseSchema } },
    },
  },
});

const getRoomDetailRoute = createRoute({
  method: "get",
  path: "/rooms/{roomId}",
  tags: ["Rooms"],
  summary: "Get room details, governance state, and live member roster",
  request: {
    params: RoomIdParamsSchema,
  },
  responses: {
    200: {
      description: "Room details",
      content: { "application/json": { schema: SingleRoomResponseSchema } },
    },
    403: {
      description: "Caller is not a member of the room",
      content: { "application/json": { schema: ApiErrorEnvelopeSchema } },
    },
    404: {
      description: "Room not found",
      content: { "application/json": { schema: ApiErrorEnvelopeSchema } },
    },
  },
});

const joinRoomRoute = createRoute({
  method: "post",
  path: "/join",
  tags: ["Rooms"],
  summary: "Join a huddle room using an invite token",
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: JoinRoomBodySchema } },
    },
  },
  responses: {
    200: {
      description: "Joined room details",
      content: { "application/json": { schema: SingleRoomResponseSchema } },
    },
    404: {
      description: "Invalid invite token",
      content: { "application/json": { schema: ApiErrorEnvelopeSchema } },
    },
  },
});

const leaveRoomRoute = createRoute({
  method: "post",
  path: "/rooms/{roomId}/leave",
  tags: ["Rooms"],
  summary: "Leave a huddle room",
  request: {
    params: RoomIdParamsSchema,
  },
  responses: {
    200: {
      description: "Left room cleanly",
      content: { "application/json": { schema: LeaveRoomResponseSchema } },
    },
  },
});

const getRoomMembersRoute = createRoute({
  method: "get",
  path: "/rooms/{roomId}/members",
  tags: ["Rooms"],
  summary: "List room members and real-time agent reachability indicators",
  request: {
    params: RoomIdParamsSchema,
  },
  responses: {
    200: {
      description: "Room member list",
      content: { "application/json": { schema: RoomMembersResponseSchema } },
    },
  },
});

const getPublicShareRoute = createRoute({
  method: "get",
  path: "/share/{inviteToken}",
  tags: ["Rooms"],
  summary: "Fetch public read-only huddle transcript and proposals snapshot",
  request: {
    params: InviteTokenParamsSchema,
  },
  responses: {
    200: {
      description: "Read-only public room snapshot",
      content: { "application/json": { schema: PublicShareSnapshotResponseSchema } },
    },
    404: {
      description: "Room not found or public sharing disabled",
      content: { "application/json": { schema: ApiErrorEnvelopeSchema } },
    },
  },
});

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildShareOpenGraphMetaBlock(
  snapshot: PublicRoomShareSnapshot,
  shareUrl: string,
  ogImageUrl: string,
): {
  readonly safeTitle: string;
  readonly safeDescription: string;
  readonly metaTagsHtml: string;
} {
  const safeTitle = escapeHtml(`${snapshot.room.name} — OpenHuddle Decision Transcript`);
  const summaryText =
    snapshot.room.topic.trim().length > 0
      ? `${snapshot.room.topic} (${snapshot.messages.length} messages, ${snapshot.proposals.length} proposals)`
      : `Multi-agent huddle transcript with ${snapshot.messages.length} messages and ${snapshot.proposals.length} structured proposals.`;
  const safeDescription = escapeHtml(summaryText);
  const safeUrl = escapeHtml(shareUrl);
  const safeOgImage = escapeHtml(ogImageUrl);

  const metaTagsHtml = [
    `<meta property="og:type" content="website" />`,
    `<meta property="og:title" content="${safeTitle}" />`,
    `<meta property="og:description" content="${safeDescription}" />`,
    `<meta property="og:url" content="${safeUrl}" />`,
    `<meta property="og:image" content="${safeOgImage}" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${safeTitle}" />`,
    `<meta name="twitter:description" content="${safeDescription}" />`,
    `<meta name="twitter:image" content="${safeOgImage}" />`,
  ].join("\n    ");

  return { safeTitle, safeDescription, metaTagsHtml };
}

function renderShareOpenGraphHtml(
  snapshot: PublicRoomShareSnapshot,
  shareUrl: string,
  spaIndexHtml: string | undefined,
  ogImageUrl: string,
): string {
  const { safeTitle, safeDescription, metaTagsHtml } = buildShareOpenGraphMetaBlock(
    snapshot,
    shareUrl,
    ogImageUrl,
  );
  const safeRoomId = escapeHtml(snapshot.room.id);

  // 单容器生产部署下：将经过 HTML 实体转义的 OpenGraph 社交预览元信息直接注入前端 SPA index.html，兼顾爬虫预览与浏览器完整富交互体验
  if (spaIndexHtml?.includes("</head>")) {
    return spaIndexHtml
      .replace(/<title>[\s\S]*?<\/title>/i, `<title>${safeTitle}</title>`)
      .replace("</head>", `    ${metaTagsHtml}\n  </head>`)
      .replace('<div id="root"></div>', `<div id="root" data-share-room-id="${safeRoomId}"></div>`);
  }

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${safeTitle}</title>
    ${metaTagsHtml}
  </head>
  <body>
    <main id="root" data-share-room-id="${safeRoomId}">
      <h1>${escapeHtml(snapshot.room.name)}</h1>
      <p>${safeDescription}</p>
    </main>
  </body>
</html>`;
}

/**
 * 创建挂载在 `/api/v1` 下的房间与公开分享 JSON OpenAPI 子路由器。
 *
 * @param deps - 认证服务与房间领域服务
 * @returns `OpenAPIHono` 实例
 */
export function createRoomsRouter(deps: {
  readonly authService: AuthService;
  readonly roomsService: RoomsService;
}): OpenAPIHono {
  const router = createOpenApiRouter();
  const requireAuth = createRequireAuthMiddleware(deps.authService);

  router.use("/rooms", requireAuth);
  router.use("/rooms/*", requireAuth);
  router.use("/join", requireAuth);

  router.openapi(listRoomsRoute, async (c) => {
    const caller = c.get("caller");
    const rooms = await deps.roomsService.listMyRooms(caller);
    return c.json({ ok: true as const, rooms: [...rooms] }, 200);
  });

  router.openapi(createRoomRoute, async (c) => {
    const caller = c.get("caller");
    const body = c.req.valid("json");
    const room = await deps.roomsService.createRoom(caller, body);
    return c.json({ ok: true as const, room }, 201);
  });

  router.openapi(getRoomDetailRoute, async (c) => {
    const caller = c.get("caller");
    const { roomId } = c.req.valid("param");
    const room = await deps.roomsService.getRoomDetail(caller, roomId);
    return c.json({ ok: true as const, room }, 200);
  });

  router.openapi(joinRoomRoute, async (c) => {
    const caller = c.get("caller");
    const body = c.req.valid("json");
    const room = await deps.roomsService.joinRoomByInviteToken(caller, body);
    return c.json({ ok: true as const, room }, 200);
  });

  router.openapi(leaveRoomRoute, async (c) => {
    const caller = c.get("caller");
    const { roomId } = c.req.valid("param");
    await deps.roomsService.leaveRoom(caller, roomId);
    return c.json({ ok: true as const }, 200);
  });

  router.openapi(getRoomMembersRoute, async (c) => {
    const caller = c.get("caller");
    const { roomId } = c.req.valid("param");
    const members = await deps.roomsService.listMembers(caller, roomId);
    return c.json({ ok: true as const, members: [...members] }, 200);
  });

  router.openapi(getPublicShareRoute, async (c) => {
    const { inviteToken } = c.req.valid("param");
    const snapshot = await deps.roomsService.getPublicShareSnapshot(inviteToken);
    return c.json(
      {
        ok: true as const,
        room: snapshot.room,
        messages: [...snapshot.messages],
        proposals: [...snapshot.proposals],
      },
      200,
    );
  });

  return router;
}

/**
 * 创建挂载在根路径 `/` 下的公开分享页面路由（支持社交爬虫与浏览器 `Accept: text/html` OpenGraph 响应）。
 *
 * @param deps - 房间领域服务与环境配置
 * @returns `OpenAPIHono` 实例
 */
export function createPublicSharePageRouter(deps: {
  readonly roomsService: RoomsService;
  readonly env: ServerEnv;
  readonly spaIndexHtmlPath?: string;
}): OpenAPIHono {
  const router = createOpenApiRouter();
  const baseUrl = deps.env.PUBLIC_BASE_URL.replace(/\/+$/, "");

  router.get("/share/:inviteToken", async (c) => {
    const inviteToken = c.req.param("inviteToken");
    const snapshot = await deps.roomsService.getPublicShareSnapshot(inviteToken);
    const acceptHeader = (c.req.header("accept") ?? "text/html").toLowerCase();

    if (acceptHeader.includes("application/json") && !acceptHeader.includes("text/html")) {
      return c.json(snapshot, 200);
    }

    let spaTemplate: string | undefined;
    if (deps.spaIndexHtmlPath && existsSync(deps.spaIndexHtmlPath)) {
      spaTemplate = await readFile(deps.spaIndexHtmlPath, "utf8");
    }

    const shareUrl = `${baseUrl}/share/${encodeURIComponent(inviteToken)}`;
    const ogImageUrl = `${baseUrl}/og-image.png`;
    return c.html(renderShareOpenGraphHtml(snapshot, shareUrl, spaTemplate, ogImageUrl), 200);
  });

  return router;
}
