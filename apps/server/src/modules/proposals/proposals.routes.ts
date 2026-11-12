/**
 * @module server/modules/proposals/routes
 * @description 结构化提案查询、手动提交、AI 自动提炼、表态投票与人类拍板（`/rooms/:roomId/proposals*`、`/proposals/:proposalId/*`）OpenAPI 路由模块。
 *
 * 架构职责与关键不变量（Invariants）：
 * 路由层仅做 OpenAPI 3.1 参数/载荷校验、鉴权中间件绑定与状态码序列化，所有行锁、权限与事务后事件发布均位于 `ProposalsService`。
 */
import { type OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
  ApiErrorEnvelopeSchema,
  CastProposalVoteBodySchema,
  DecideProposalBodySchema,
  ProposalCardDtoSchema,
  ProposalDraftSchema,
  ProposalIdSchema,
  RoomIdSchema,
  SynthesizeProposalBodySchema,
} from "@openhuddle/protocol";
import { createRequireAuthMiddleware } from "../../infra/auth-middleware.js";
import { createOpenApiRouter } from "../../infra/openapi-router.js";
import type { AuthService } from "../auth/auth.service.js";
import type { ProposalsService } from "./proposals.service.js";

const RoomIdParamsSchema = z.object({
  roomId: RoomIdSchema,
});

const ProposalIdParamsSchema = z.object({
  proposalId: ProposalIdSchema,
});

const ListProposalsResponseSchema = z.object({
  ok: z.literal(true),
  proposals: z.array(ProposalCardDtoSchema),
});

const SingleProposalResponseSchema = z.object({
  ok: z.literal(true),
  proposal: ProposalCardDtoSchema,
});

const listRoomProposalsRoute = createRoute({
  method: "get",
  path: "/rooms/{roomId}/proposals",
  tags: ["Proposals"],
  summary: "List structured proposals, votes, and human decisions in a room",
  request: {
    params: RoomIdParamsSchema,
  },
  responses: {
    200: {
      description: "Proposals stamped for the authenticated viewer",
      content: {
        "application/json": {
          schema: ListProposalsResponseSchema,
        },
      },
    },
    403: {
      description: "Caller is not a room member",
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

const createRoomProposalRoute = createRoute({
  method: "post",
  path: "/rooms/{roomId}/proposals",
  tags: ["Proposals"],
  summary: "Submit a structured multi-option proposal card to a huddle room",
  request: {
    params: RoomIdParamsSchema,
    body: {
      required: true,
      content: {
        "application/json": {
          schema: ProposalDraftSchema,
        },
      },
    },
  },
  responses: {
    201: {
      description: "Proposal card created and timeline message appended",
      content: {
        "application/json": {
          schema: SingleProposalResponseSchema,
        },
      },
    },
    400: {
      description: "Invalid option keys or schema failure",
      content: {
        "application/json": {
          schema: ApiErrorEnvelopeSchema,
        },
      },
    },
    403: {
      description: "Caller is not a room member",
      content: {
        "application/json": {
          schema: ApiErrorEnvelopeSchema,
        },
      },
    },
  },
});

const synthesizeRoomProposalRoute = createRoute({
  method: "post",
  path: "/rooms/{roomId}/proposals/synthesize",
  tags: ["Proposals"],
  summary: "Synthesize recent huddle messages into a structured proposal card via AI Moderator",
  request: {
    params: RoomIdParamsSchema,
    body: {
      required: false,
      content: {
        "application/json": {
          schema: SynthesizeProposalBodySchema,
        },
      },
    },
  },
  responses: {
    201: {
      description: "Synthesized proposal card persisted",
      content: {
        "application/json": {
          schema: SingleProposalResponseSchema,
        },
      },
    },
    403: {
      description: "Caller is not a room member",
      content: {
        "application/json": {
          schema: ApiErrorEnvelopeSchema,
        },
      },
    },
  },
});

const castProposalVoteRoute = createRoute({
  method: "post",
  path: "/proposals/{proposalId}/votes",
  tags: ["Proposals"],
  summary:
    "Cast or update a structured stance vote (endorse | challenge | abstain) on an open proposal",
  request: {
    params: ProposalIdParamsSchema,
    body: {
      required: true,
      content: {
        "application/json": {
          schema: CastProposalVoteBodySchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: "Updated proposal card with recorded vote",
      content: {
        "application/json": {
          schema: SingleProposalResponseSchema,
        },
      },
    },
    400: {
      description: "Proposal already closed or invalid preferredOptionKey",
      content: {
        "application/json": {
          schema: ApiErrorEnvelopeSchema,
        },
      },
    },
    403: {
      description: "Caller is not a member of the proposal's room",
      content: {
        "application/json": {
          schema: ApiErrorEnvelopeSchema,
        },
      },
    },
  },
});

const decideProposalRoute = createRoute({
  method: "post",
  path: "/proposals/{proposalId}/decide",
  tags: ["Proposals"],
  summary: "Approve or reject a proposal as the human room owner or moderator",
  request: {
    params: ProposalIdParamsSchema,
    body: {
      required: true,
      content: {
        "application/json": {
          schema: DecideProposalBodySchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: "Finalized proposal card with human decision",
      content: {
        "application/json": {
          schema: SingleProposalResponseSchema,
        },
      },
    },
    403: {
      description: "Caller is an AI agent or lacks human owner/moderator authority",
      content: {
        "application/json": {
          schema: ApiErrorEnvelopeSchema,
        },
      },
    },
    404: {
      description: "Proposal not found",
      content: {
        "application/json": {
          schema: ApiErrorEnvelopeSchema,
        },
      },
    },
  },
});

/**
 * 创建结构化提案、投票与人类拍板 OpenAPI 子路由器。
 *
 * @param deps - 认证服务与提案领域服务
 * @returns 挂载了 `/rooms/:roomId/proposals*` 与 `/proposals/:proposalId/*` 的 `OpenAPIHono`
 */
export function createProposalsRouter(deps: {
  readonly authService: AuthService;
  readonly proposalsService: ProposalsService;
}): OpenAPIHono {
  const router = createOpenApiRouter();
  const requireAuth = createRequireAuthMiddleware(deps.authService);

  router.use("/rooms/*/proposals", requireAuth);
  router.use("/rooms/*/proposals/*", requireAuth);
  router.use("/proposals/*", requireAuth);

  router.openapi(listRoomProposalsRoute, async (c) => {
    const caller = c.get("caller");
    const { roomId } = c.req.valid("param");
    const proposals = await deps.proposalsService.listProposals(caller, roomId);
    return c.json({ ok: true as const, proposals: [...proposals] }, 200);
  });

  router.openapi(createRoomProposalRoute, async (c) => {
    const caller = c.get("caller");
    const { roomId } = c.req.valid("param");
    const draft = c.req.valid("json");
    const proposal = await deps.proposalsService.createProposal(caller, roomId, draft);
    return c.json({ ok: true as const, proposal }, 201);
  });

  router.openapi(synthesizeRoomProposalRoute, async (c) => {
    const caller = c.get("caller");
    const { roomId } = c.req.valid("param");
    let rawJson: unknown = {};
    try {
      rawJson = await c.req.json();
    } catch {
      rawJson = {};
    }
    const body = SynthesizeProposalBodySchema.parse(rawJson ?? {});
    const proposal = await deps.proposalsService.synthesizeProposal(caller, roomId, body);
    return c.json({ ok: true as const, proposal }, 201);
  });

  router.openapi(castProposalVoteRoute, async (c) => {
    const caller = c.get("caller");
    const { proposalId } = c.req.valid("param");
    const body = c.req.valid("json");
    const proposal = await deps.proposalsService.castVote(caller, proposalId, body);
    return c.json({ ok: true as const, proposal }, 200);
  });

  router.openapi(decideProposalRoute, async (c) => {
    const caller = c.get("caller");
    const { proposalId } = c.req.valid("param");
    const body = c.req.valid("json");
    const proposal = await deps.proposalsService.decideProposal(caller, proposalId, body);
    return c.json({ ok: true as const, proposal }, 200);
  });

  return router;
}
