/**
 * @module server/modules/events/routes
 * @description SSE 实时事件流（`GET /api/v1/events`）与增量巡检长轮询收件箱（`GET /api/v1/inbox`）路由模块。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 连接资源零泄漏：SSE 流在客户端断开（`onAbort`）或写入失败时必须幂等卸载所有 `RealtimeBus` 监听器与 15s 心跳定时器。
 * 2. 即连即应答：SSE 建立后立即推送首帧 `connected` 事件，确保浏览器 `EventSource` 与本地 CLI Listener 立刻转入就绪态。
 */
import { randomUUID } from "node:crypto";
import { type OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { ApiErrorEnvelopeSchema, InboxResponseSchema, type SseEvent } from "@openhuddle/protocol";
import { streamSSE } from "hono/streaming";
import { createRequireAuthMiddleware } from "../../infra/auth-middleware.js";
import { createOpenApiRouter } from "../../infra/openapi-router.js";
import type { AuthService } from "../auth/auth.service.js";
import type { EventsService } from "./events.service.js";

/** SSE 保活心跳间隔（15 秒，防止反向代理空闲断连） */
const SSE_HEARTBEAT_INTERVAL_MS = 15_000;

const InboxQuerySchema = z.object({
  waitSec: z.coerce.number().min(0).max(25).default(0),
});

const getInboxRoute = createRoute({
  method: "get",
  path: "/inbox",
  tags: ["Events"],
  summary:
    "Query unread room counts, owner commands, and mentions (supports ?waitSec=0..25 long-polling)",
  request: {
    query: InboxQuerySchema,
  },
  responses: {
    200: {
      description: "Inbox unread summary",
      content: {
        "application/json": {
          schema: InboxResponseSchema,
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

const getEventsDocRoute = createRoute({
  method: "get",
  path: "/events",
  tags: ["Events"],
  summary:
    "Subscribe to real-time Server-Sent Events (wake, message.created, governance.updated, proposal.updated)",
  responses: {
    200: {
      description: "text/event-stream SSE feed",
      content: {
        "text/event-stream": {
          schema: z.string(),
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
 * 创建实时事件流与收件箱 OpenAPI 子路由器。
 *
 * @param deps - 认证服务与事件编排服务
 * @returns 挂载了 `/events` 与 `/inbox` 的 `OpenAPIHono`
 */
export function createEventsRouter(deps: {
  readonly authService: AuthService;
  readonly eventsService: EventsService;
}): OpenAPIHono {
  const router = createOpenApiRouter();
  const requireAuth = createRequireAuthMiddleware(deps.authService);

  router.use("/inbox", requireAuth);
  router.use("/events", requireAuth);

  router.openapi(getInboxRoute, async (c) => {
    const caller = c.get("caller");
    const { waitSec } = c.req.valid("query");
    const response = await deps.eventsService.getInbox(caller, waitSec, c.req.raw.signal);
    return c.json(response, 200);
  });

  router.openapi(getEventsDocRoute, (c) => {
    const caller = c.get("caller");
    const connectionId = randomUUID();

    return streamSSE(c, async (stream) => {
      const writeFrame = async (event: SseEvent): Promise<void> => {
        await stream.writeSSE({
          event: event.type,
          data: JSON.stringify(event),
        });
      };

      await writeFrame({
        type: "connected",
        serverTimeIso: new Date().toISOString(),
        connectionId,
      });

      const unsubscribe = await deps.eventsService.subscribeCallerStream(caller, (event) => {
        void writeFrame(event).catch(() => {
          unsubscribe();
        });
      });

      const heartbeatTimer = setInterval(() => {
        void writeFrame({
          type: "heartbeat",
          serverTimeIso: new Date().toISOString(),
        }).catch(() => {
          clearInterval(heartbeatTimer);
          unsubscribe();
        });
      }, SSE_HEARTBEAT_INTERVAL_MS);

      await new Promise<void>((resolve) => {
        const teardown = (): void => {
          clearInterval(heartbeatTimer);
          unsubscribe();
          resolve();
        };

        stream.onAbort(teardown);
        if (c.req.raw.signal.aborted) {
          teardown();
        } else {
          c.req.raw.signal.addEventListener("abort", teardown, { once: true });
        }
      });
    });
  });

  return router;
}
