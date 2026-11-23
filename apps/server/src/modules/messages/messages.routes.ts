/**
 * @module server/modules/messages/routes
 * @description 房间消息读写、撤回与授权附件读取的 OpenAPI 路由模块。
 *
 * 架构职责与关键不变量（Invariants）：
 * 路由层仅做 OpenAPI 契约绑定、查询参数转换与状态码返回，事务锁与治理判定全部位于 `MessagesService`。
 */
import { type OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
  AgentIdSchema,
  ApiErrorEnvelopeSchema,
  MAX_MESSAGE_ATTACHMENT_BASE64_LENGTH,
  MessageDtoSchema,
  ReadCursorSeqSchema,
  RoomGovernanceStateSchema,
  RoomIdSchema,
  SendMessageRequestSchema,
  asMessageSeq,
  asReadCursorSeq,
} from "@openhuddle/protocol";
import { bodyLimit } from "hono/body-limit";
import { createRequireAuthMiddleware } from "../../infra/auth-middleware.js";
import { AppError } from "../../infra/errors.js";
import { createOpenApiRouter } from "../../infra/openapi-router.js";
import type { AuthService } from "../auth/auth.service.js";
import type { MessagesService } from "./messages.service.js";

const RoomIdParamsSchema = z.object({
  roomId: RoomIdSchema,
});

const MessageParamsSchema = z.object({
  roomId: RoomIdSchema,
  seq: z.coerce.number().int().min(1).transform(asMessageSeq),
});

const ReadMessagesQuerySchema = z.object({
  afterSeq: z.coerce.number().int().min(0).default(0).transform(asReadCursorSeq),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const ReadMessagesResponseSchema = z.object({
  ok: z.literal(true),
  messages: z.array(MessageDtoSchema),
  latestSeq: ReadCursorSeqSchema,
  governance: RoomGovernanceStateSchema,
});

const SendMessageResponseSchema = z.object({
  ok: z.literal(true),
  message: MessageDtoSchema,
  governance: RoomGovernanceStateSchema,
  wokenAgentIds: z.array(AgentIdSchema),
});

const RecallMessageResponseSchema = z.object({
  ok: z.literal(true),
  message: MessageDtoSchema,
});

const listMessagesRoute = createRoute({
  method: "get",
  path: "/rooms/{roomId}/messages",
  tags: ["Messages"],
  summary: "Fetch incremental room messages after seq and advance caller read cursor",
  request: {
    params: RoomIdParamsSchema,
    query: ReadMessagesQuerySchema,
  },
  responses: {
    200: {
      description: "Incremental messages stamped with viewer-specific AuthorStamp",
      content: {
        "application/json": {
          schema: ReadMessagesResponseSchema,
        },
      },
    },
    403: {
      description: "Not a member of this room",
      content: {
        "application/json": {
          schema: ApiErrorEnvelopeSchema,
        },
      },
    },
  },
});

const sendMessageRoute = createRoute({
  method: "post",
  path: "/rooms/{roomId}/messages",
  tags: ["Messages"],
  summary: "Send a room message under optimistic read lock and governance turn budget",
  // Base64 之外留出空间给正文、提及及 JSON 转义，限制在解析请求体之前生效。
  middleware: bodyLimit({
    maxSize: MAX_MESSAGE_ATTACHMENT_BASE64_LENGTH + 128 * 1024,
    onError: () => {
      throw new AppError({
        code: "VALIDATION_ERROR",
        statusCode: 413,
        message: "The message request exceeds the upload size limit.",
      });
    },
  }),
  request: {
    params: RoomIdParamsSchema,
    body: {
      required: true,
      content: {
        "application/json": {
          schema: SendMessageRequestSchema,
        },
      },
    },
  },
  responses: {
    201: {
      description: "Message committed and post-commit wake events dispatched",
      content: {
        "application/json": {
          schema: SendMessageResponseSchema,
        },
      },
    },
    409: {
      description: "CONFLICT_UNREAD_MESSAGES with missedMessages payload",
      content: {
        "application/json": {
          schema: ApiErrorEnvelopeSchema,
        },
      },
    },
    413: {
      description: "Message request or decoded attachment exceeds the size limit",
      content: {
        "application/json": { schema: ApiErrorEnvelopeSchema },
      },
    },
    429: {
      description: "Governance budget paused, cooldown active, or round-table turn pending",
      content: {
        "application/json": {
          schema: ApiErrorEnvelopeSchema,
        },
      },
    },
  },
});

const binaryAttachment = {
  "application/octet-stream": { schema: z.string().openapi({ format: "binary" }) },
};

const getAttachmentRoute = createRoute({
  method: "get",
  path: "/rooms/{roomId}/messages/{seq}/attachment",
  tags: ["Messages"],
  summary: "Fetch a message attachment as an authenticated member of its room",
  request: {
    params: MessageParamsSchema,
    headers: z.object({ range: z.string().optional() }),
  },
  responses: {
    200: { description: "Image or audio in its original media type", content: binaryAttachment },
    206: { description: "Requested byte range of the attachment", content: binaryAttachment },
    403: {
      description: "Not a member of this room",
      content: { "application/json": { schema: ApiErrorEnvelopeSchema } },
    },
    404: {
      description: "Attachment or message not found",
      content: { "application/json": { schema: ApiErrorEnvelopeSchema } },
    },
    416: { description: "Byte range is outside the attachment" },
  },
});

const recallMessageRoute = createRoute({
  method: "delete",
  path: "/rooms/{roomId}/messages/{seq}",
  tags: ["Messages"],
  summary: "Recall a message within 2 minutes (or anytime by human room owner)",
  request: {
    params: MessageParamsSchema,
  },
  responses: {
    200: {
      description: "Message recalled",
      content: {
        "application/json": {
          schema: RecallMessageResponseSchema,
        },
      },
    },
    400: {
      description: "Recall window expired",
      content: {
        "application/json": {
          schema: ApiErrorEnvelopeSchema,
        },
      },
    },
    403: {
      description: "Caller is neither message author nor human room owner",
      content: {
        "application/json": {
          schema: ApiErrorEnvelopeSchema,
        },
      },
    },
  },
});

function resolveAttachmentRange(
  header: string | undefined,
  size: number,
): { readonly start: number; readonly end: number } | false | undefined {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header ?? "");
  const startValue = match?.[1] ?? "";
  const endValue = match?.[2] ?? "";
  if (startValue === "" && endValue === "") {
    return undefined;
  }
  if (startValue === "") {
    const length = Number(endValue);
    return length > 0 ? { start: Math.max(0, size - length), end: size - 1 } : false;
  }
  const start = Number(startValue);
  const end = endValue === "" ? size - 1 : Math.min(size - 1, Number(endValue));
  return start <= end ? { start, end } : false;
}

/**
 * 创建消息流读写与撤回 OpenAPI 子路由器。
 *
 * @param deps - 认证服务与消息领域服务
 * @returns 挂载了 `/rooms/:roomId/messages*` 的 `OpenAPIHono`
 */
export function createMessagesRouter(deps: {
  readonly authService: AuthService;
  readonly messagesService: MessagesService;
}): OpenAPIHono {
  const router = createOpenApiRouter();
  const requireAuth = createRequireAuthMiddleware(deps.authService);

  router.use("/rooms/*/messages", requireAuth);
  router.use("/rooms/*/messages/*", requireAuth);

  router.openapi(listMessagesRoute, async (c) => {
    const caller = c.get("caller");
    const { roomId } = c.req.valid("param");
    const { afterSeq, limit } = c.req.valid("query");
    const result = await deps.messagesService.listMessages(caller, roomId, { afterSeq, limit });
    return c.json(
      {
        ok: true as const,
        messages: [...result.messages],
        latestSeq: result.latestSeq,
        governance: result.governance,
      },
      200,
    );
  });

  router.openapi(sendMessageRoute, async (c) => {
    const caller = c.get("caller");
    const { roomId } = c.req.valid("param");
    const body = c.req.valid("json");
    const result = await deps.messagesService.sendMessage(caller, roomId, body);
    return c.json(
      {
        ok: true as const,
        message: result.message,
        governance: result.governance,
        wokenAgentIds: [...result.wokenAgentIds],
      },
      201,
    );
  });

  router.openapi(getAttachmentRoute, async (c) => {
    const { roomId, seq } = c.req.valid("param");
    const { bytes, metadata } = await deps.messagesService.getAttachment(
      c.get("caller"),
      roomId,
      seq,
    );
    const headers: Record<string, string> = {
      "accept-ranges": "bytes",
      "cache-control": "private, no-store",
      "content-disposition": "inline",
      "content-type": metadata.mimeType,
      "cross-origin-resource-policy": "same-origin",
      "x-content-type-options": "nosniff",
    };

    const range = resolveAttachmentRange(c.req.valid("header").range, bytes.byteLength);
    if (range === false) {
      return c.body(null, 416, { ...headers, "content-range": `bytes */${bytes.byteLength}` });
    }

    const content = range === undefined ? bytes : bytes.subarray(range.start, range.end + 1);
    headers["content-length"] = String(content.byteLength);
    if (range !== undefined) {
      headers["content-range"] = `bytes ${range.start}-${range.end}/${bytes.byteLength}`;
    }
    // 数据库返回的字节由 ReadableStream 直接交给 HTTP 层，避免为大型附件额外复制一份。
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(content);
        controller.close();
      },
    });
    return c.body(stream, range === undefined ? 200 : 206, headers);
  });

  router.openapi(recallMessageRoute, async (c) => {
    const caller = c.get("caller");
    const { roomId, seq } = c.req.valid("param");
    const message = await deps.messagesService.recallMessage(caller, roomId, seq);
    return c.json({ ok: true as const, message }, 200);
  });

  return router;
}
