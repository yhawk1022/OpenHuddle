/**
 * @module mcp
 * @description OpenHuddle 双模 MCP Server 实现（同时支持本地 `StdioServerTransport` 与远程 `WebStandardStreamableHTTPServerTransport`）。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. CLI 与 MCP 100% 能力对偶：全部 8 个核心工具入参均经由 `@openhuddle/protocol` Zod 契约校验，共享同一套乐观并发读锁与双层身份信任模型。
 * 2. 双传输同构复用：`createOpenHuddleMcpServer` 构造纯协议无关的 `McpServer` 实例，既可通过 `startOpenHuddleMcpStdioServer` 挂载至本地宿主，也可通过 `handleOpenHuddleMcpHttpRequest` 零胶水嵌入 Hono Streamable HTTP 网关。
 * 3. `stdio` 通道纯净性：严禁向 `stdout` 写入任何调试文本（`biome.json` 已开启 `noConsoleLog: "error"`），防止污染 JSON-RPC 2.0 帧流。
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  CastProposalVoteBodySchema,
  ClaimWorkSliceBodySchema,
  CompleteWorkSliceBodySchema,
  HeartbeatWorkSliceBodySchema,
  JoinRoomBodySchema,
  ProposalDraftSchema,
  ProposalIdSchema,
  ProposalOptionSchema,
  ProposalVoteStanceSchema,
  RaiseWorkAttentionBodySchema,
  RoomIdSchema,
  SendMessageRequestSchema,
  WorkItemIdSchema,
  WorkSliceIdSchema,
  WorkSliceProvenanceSchema,
  WorkStageSchema,
  WorkVerifyVerdictSchema,
  WorkspaceIdSchema,
} from "@openhuddle/protocol";
import { z } from "zod";
import { type McpBridgeResult, OpenHuddleMcpApiBridge } from "./api-bridge.js";

/**
 * 声明单个 MCP 工具元数据的只读描述结构。
 */
export interface OpenHuddleMcpToolDescriptor {
  readonly name: string;
  readonly description: string;
}

/**
 * 创建 OpenHuddle MCP Server 所需的连接与鉴权配置。
 */
export interface OpenHuddleMcpServerConfig {
  readonly serverUrl: string;
  readonly agentToken: string;
  readonly fetchImpl?: typeof fetch;
}

const CORE_TOOL_DESCRIPTORS: readonly OpenHuddleMcpToolDescriptor[] = [
  {
    name: "openhuddle_whoami",
    description:
      "Inspect your authenticated agent identity, verified human owner, and sibling agents.",
  },
  {
    name: "openhuddle_inbox",
    description:
      "Check pending mentions, owner commands, and unread room cursors (supports 0..25s long-polling).",
  },
  {
    name: "openhuddle_list_rooms",
    description:
      "List all Huddle rooms your agent has joined along with live governance and cursor status.",
  },
  {
    name: "openhuddle_join_room",
    description: "Join an OpenHuddle room using a room invite token.",
  },
  {
    name: "openhuddle_read_room",
    description:
      "Read incremental messages from a room (with server-stamped author trustLevel) and advance your read cursor.",
  },
  {
    name: "openhuddle_send_message",
    description:
      "Send a message to a room under governance Turn Budget and optimistic read-lock protection.",
  },
  {
    name: "openhuddle_submit_proposal",
    description:
      "Submit a structured multi-option proposal card for multi-agent voting and human decision.",
  },
  {
    name: "openhuddle_vote_proposal",
    description:
      "Cast a structured vote (endorse, challenge, or abstain) with rationale on a proposal card.",
  },
  {
    name: "openhuddle_list_workspaces",
    description:
      "List 5D controlled workspaces owned by your human owner or bound to a specific Huddle room.",
  },
  {
    name: "openhuddle_list_work",
    description:
      "List multi-agent collaborative work items and slices (set claimableOnly=true to poll your work queue).",
  },
  {
    name: "openhuddle_claim_work_slice",
    description:
      "Claim a pending work slice or take over an expired lease, returning a monotonic leaseVersion fencing token.",
  },
  {
    name: "openhuddle_update_work_slice",
    description:
      "Renew an active slice lease with live progress summary, or pause the slice to ask a structured clarification question.",
  },
  {
    name: "openhuddle_complete_work_slice",
    description:
      "Complete an execution slice with diff/provenance or submit a verifier verdict (passed | changes_requested).",
  },
];

/**
 * 获取 OpenHuddle 标准暴露的 8 个核心 MCP 工具元数据清单。
 *
 * @returns 只读 MCP 工具元数据列表
 */
export function getCoreMcpToolDescriptors(): readonly OpenHuddleMcpToolDescriptor[] {
  return CORE_TOOL_DESCRIPTORS;
}

/**
 * 将桥接器结果转换为符合 MCP 规范的 `CallToolResult`。
 *
 * @param result - 底层 HTTP 桥接返回结构
 * @returns 标准 MCP 工具执行响应
 */
function toMcpCallToolResult(result: McpBridgeResult): CallToolResult {
  if (!result.ok) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: result.formattedError,
        },
      ],
    };
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(result.data, null, 2),
      },
    ],
  };
}

function toValidationErrorResult(error: z.ZodError): CallToolResult {
  const summary = error.issues
    .map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`)
    .join("; ");
  return {
    isError: true,
    content: [{ type: "text", text: `Invalid MCP tool arguments: ${summary}` }],
  };
}

/**
 * 创建并注册完备 8 大协作工具的 `McpServer` 实例。
 *
 * @remarks
 * 工具入参的 JSON Schema 采用无 `.transform()` 的原生 Zod 结构以保证 `zod-to-json-schema` 输出最清晰的字段定义；
 * 在工具执行体内再二次调用 `@openhuddle/protocol` 的名义品牌 Schema 完成强类型收窄与领域规则校验。
 *
 * @param config - 包含 `serverUrl` 与 `agentToken`（及可选测试 `fetchImpl`）的配置项
 * @returns 已注册全部 OpenHuddle 工具的 `McpServer`
 * @throws {Error} 当 `serverUrl` 或 `agentToken` 为空时立即失败抛出
 */
export function createOpenHuddleMcpServer(config: Readonly<OpenHuddleMcpServerConfig>): McpServer {
  if (config.serverUrl.trim().length === 0) {
    throw new Error("createOpenHuddleMcpServer requires a non-empty `serverUrl`.");
  }
  if (config.agentToken.trim().length === 0) {
    throw new Error("createOpenHuddleMcpServer requires a non-empty `agentToken`.");
  }

  const bridge = new OpenHuddleMcpApiBridge(config);

  const server = new McpServer(
    {
      name: "@openhuddle/mcp",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  // 1. openhuddle_whoami
  server.registerTool(
    "openhuddle_whoami",
    {
      description:
        "Inspect your authenticated agent identity, verified human owner, and sibling agents.",
    },
    async (): Promise<CallToolResult> => {
      return toMcpCallToolResult(await bridge.whoami());
    },
  );

  // 2. openhuddle_inbox
  server.registerTool(
    "openhuddle_inbox",
    {
      description:
        "Check pending mentions, owner commands, and unread room cursors (supports 0..25s long-polling).",
      inputSchema: {
        waitSec: z
          .number()
          .int()
          .min(0)
          .max(25)
          .optional()
          .describe("Optional long-polling wait duration in seconds (0..25)."),
      },
    },
    async (args): Promise<CallToolResult> => {
      return toMcpCallToolResult(await bridge.getInbox(args.waitSec ?? 0));
    },
  );

  // 3. openhuddle_list_rooms
  server.registerTool(
    "openhuddle_list_rooms",
    {
      description:
        "List all Huddle rooms your agent has joined along with live governance and cursor status.",
    },
    async (): Promise<CallToolResult> => {
      return toMcpCallToolResult(await bridge.listRooms());
    },
  );

  // 4. openhuddle_join_room
  server.registerTool(
    "openhuddle_join_room",
    {
      description: "Join an OpenHuddle room using a room invite token.",
      inputSchema: {
        inviteToken: z
          .string()
          .min(4)
          .max(128)
          .describe("Invite token issued for the target Huddle room."),
      },
    },
    async (args): Promise<CallToolResult> => {
      const parsedBody = JoinRoomBodySchema.safeParse({ inviteToken: args.inviteToken });
      if (!parsedBody.success) {
        return toValidationErrorResult(parsedBody.error);
      }
      return toMcpCallToolResult(await bridge.joinRoom(parsedBody.data));
    },
  );

  // 5. openhuddle_read_room
  server.registerTool(
    "openhuddle_read_room",
    {
      description:
        "Read incremental messages from a room (with server-stamped author trustLevel) and advance your read cursor.",
      inputSchema: {
        roomId: z.string().min(3).max(64).describe("Target Huddle room ID."),
        afterSeq: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Read messages strictly after this sequence number."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe("Maximum number of messages to fetch."),
      },
    },
    async (args): Promise<CallToolResult> => {
      const brandedRoomId = RoomIdSchema.safeParse(args.roomId);
      if (!brandedRoomId.success) {
        return toValidationErrorResult(brandedRoomId.error);
      }
      const res = await bridge.readRoom(brandedRoomId.data, {
        ...(args.afterSeq !== undefined ? { afterSeq: args.afterSeq } : {}),
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
      });
      return toMcpCallToolResult(res);
    },
  );

  // 6. openhuddle_send_message
  const mentionInputSchema = z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("human"),
      userId: z.string().min(3).max(64),
      displayName: z.string().min(1).max(80),
    }),
    z.object({
      kind: z.literal("agent"),
      agentId: z.string().min(3).max(64),
      displayName: z.string().min(1).max(80),
    }),
  ]);

  server.registerTool(
    "openhuddle_send_message",
    {
      description:
        "Send a message to a room under governance Turn Budget and optimistic read-lock protection.",
      inputSchema: {
        roomId: z.string().min(3).max(64).describe("Target Huddle room ID."),
        content: z.string().min(1).max(16_000).describe("Markdown message body."),
        replyToSeq: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("Optional message sequence number being replied to."),
        mentions: z
          .array(mentionInputSchema)
          .max(20)
          .optional()
          .describe("Explicit human or agent mentions."),
        opKey: z
          .string()
          .min(4)
          .max(128)
          .optional()
          .describe("Optional idempotency key for safe retries."),
        lastReadSeq: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(
            "Optimistic concurrency read cursor; defaults to the latest cursor from openhuddle_read_room.",
          ),
        ignoreUnread: z
          .boolean()
          .optional()
          .describe("Set true only when intentionally bypassing unread-message conflict guard."),
      },
    },
    async (args): Promise<CallToolResult> => {
      const brandedRoomId = RoomIdSchema.safeParse(args.roomId);
      if (!brandedRoomId.success) {
        return toValidationErrorResult(brandedRoomId.error);
      }
      const parsedRequest = SendMessageRequestSchema.safeParse({
        content: args.content,
        ...(args.replyToSeq !== undefined ? { replyToSeq: args.replyToSeq } : {}),
        ...(args.mentions !== undefined ? { mentions: args.mentions } : {}),
        ...(args.opKey !== undefined ? { opKey: args.opKey } : {}),
        ...(args.lastReadSeq !== undefined ? { lastReadSeq: args.lastReadSeq } : {}),
        ...(args.ignoreUnread !== undefined ? { ignoreUnread: args.ignoreUnread } : {}),
      });
      if (!parsedRequest.success) {
        return toValidationErrorResult(parsedRequest.error);
      }
      return toMcpCallToolResult(await bridge.sendMessage(brandedRoomId.data, parsedRequest.data));
    },
  );

  // 7. openhuddle_submit_proposal
  server.registerTool(
    "openhuddle_submit_proposal",
    {
      description:
        "Submit a structured multi-option proposal card for multi-agent voting and human decision.",
      inputSchema: {
        roomId: z.string().min(3).max(64).describe("Target Huddle room ID."),
        title: z.string().min(2).max(160).describe("Concise proposal title."),
        contextSummary: z
          .string()
          .min(2)
          .max(2_000)
          .describe("Background context and core trade-off summary."),
        recommendedOptionKey: z
          .string()
          .min(1)
          .max(32)
          .optional()
          .describe("Optional recommended optionKey."),
        options: z
          .array(ProposalOptionSchema)
          .min(1)
          .max(6)
          .describe("1 to 6 structured candidate options with pros, cons, and risks."),
      },
    },
    async (args): Promise<CallToolResult> => {
      const brandedRoomId = RoomIdSchema.safeParse(args.roomId);
      if (!brandedRoomId.success) {
        return toValidationErrorResult(brandedRoomId.error);
      }
      const draft = ProposalDraftSchema.safeParse({
        title: args.title,
        contextSummary: args.contextSummary,
        ...(args.recommendedOptionKey !== undefined
          ? { recommendedOptionKey: args.recommendedOptionKey }
          : {}),
        options: args.options,
      });
      if (!draft.success) {
        return toValidationErrorResult(draft.error);
      }
      return toMcpCallToolResult(await bridge.submitProposal(brandedRoomId.data, draft.data));
    },
  );

  // 8. openhuddle_vote_proposal
  server.registerTool(
    "openhuddle_vote_proposal",
    {
      description:
        "Cast a structured vote (endorse, challenge, or abstain) with rationale on a proposal card.",
      inputSchema: {
        proposalId: z.string().min(3).max(64).describe("Target proposal card ID."),
        stance: ProposalVoteStanceSchema.describe("Vote stance: endorse, challenge, or abstain."),
        preferredOptionKey: z
          .string()
          .min(1)
          .max(32)
          .optional()
          .describe("Optional preferred optionKey from the proposal options."),
        rationale: z
          .string()
          .min(1)
          .max(600)
          .describe("Concise engineering rationale backing your stance."),
      },
    },
    async (args): Promise<CallToolResult> => {
      const brandedProposalId = ProposalIdSchema.safeParse(args.proposalId);
      if (!brandedProposalId.success) {
        return toValidationErrorResult(brandedProposalId.error);
      }
      const voteBody = CastProposalVoteBodySchema.safeParse({
        stance: args.stance,
        ...(args.preferredOptionKey !== undefined
          ? { preferredOptionKey: args.preferredOptionKey }
          : {}),
        rationale: args.rationale,
      });
      if (!voteBody.success) {
        return toValidationErrorResult(voteBody.error);
      }
      return toMcpCallToolResult(await bridge.voteProposal(brandedProposalId.data, voteBody.data));
    },
  );

  // 9. openhuddle_list_workspaces
  server.registerTool(
    "openhuddle_list_workspaces",
    {
      description:
        "List 5D controlled workspaces owned by your human owner or bound to a specific Huddle room.",
      inputSchema: {
        roomId: z
          .string()
          .min(3)
          .max(64)
          .optional()
          .describe("Optional Huddle room ID to inspect bound workspaces in that room."),
      },
    },
    async (args): Promise<CallToolResult> => {
      if (args.roomId !== undefined) {
        const parsedRoom = RoomIdSchema.safeParse(args.roomId);
        if (!parsedRoom.success) {
          return toValidationErrorResult(parsedRoom.error);
        }
        return toMcpCallToolResult(await bridge.listWorkspaces(parsedRoom.data));
      }
      return toMcpCallToolResult(await bridge.listWorkspaces());
    },
  );

  // 10. openhuddle_list_work
  server.registerTool(
    "openhuddle_list_work",
    {
      description:
        "List multi-agent collaborative work items and slices (set claimableOnly=true to poll your work queue).",
      inputSchema: {
        workspaceId: z.string().min(3).max(64).optional().describe("Filter by workspace ID."),
        roomId: z.string().min(3).max(64).optional().describe("Filter by Huddle room ID."),
        stage: WorkStageSchema.optional().describe("Filter by work item lifecycle stage."),
        claimableOnly: z
          .boolean()
          .optional()
          .describe(
            "When true, returns only work items containing slices claimable by you right now.",
          ),
      },
    },
    async (args): Promise<CallToolResult> => {
      const wsId =
        args.workspaceId !== undefined ? WorkspaceIdSchema.safeParse(args.workspaceId) : undefined;
      if (wsId && !wsId.success) {
        return toValidationErrorResult(wsId.error);
      }
      const rmId = args.roomId !== undefined ? RoomIdSchema.safeParse(args.roomId) : undefined;
      if (rmId && !rmId.success) {
        return toValidationErrorResult(rmId.error);
      }
      return toMcpCallToolResult(
        await bridge.listWorkItems({
          ...(wsId?.success ? { workspaceId: wsId.data } : {}),
          ...(rmId?.success ? { roomId: rmId.data } : {}),
          ...(args.stage !== undefined ? { stage: args.stage } : {}),
          ...(args.claimableOnly !== undefined ? { claimableOnly: args.claimableOnly } : {}),
        }),
      );
    },
  );

  // 11. openhuddle_claim_work_slice
  server.registerTool(
    "openhuddle_claim_work_slice",
    {
      description:
        "Claim a pending work slice or take over an expired lease, returning a monotonic leaseVersion fencing token.",
      inputSchema: {
        workItemId: z.string().min(3).max(64).describe("Target work item ID."),
        sliceId: z.string().min(3).max(64).describe("Target work slice ID."),
        leaseTtlMs: z
          .number()
          .int()
          .min(15_000)
          .max(600_000)
          .optional()
          .describe("Lease duration in milliseconds (default 120000)."),
        agentEnvironment: z
          .string()
          .min(1)
          .max(120)
          .optional()
          .describe("Host environment label (e.g. Local Mac, Cloud Devbox, Remote MCP)."),
      },
    },
    async (args): Promise<CallToolResult> => {
      const itemId = WorkItemIdSchema.safeParse(args.workItemId);
      if (!itemId.success) return toValidationErrorResult(itemId.error);
      const slcId = WorkSliceIdSchema.safeParse(args.sliceId);
      if (!slcId.success) return toValidationErrorResult(slcId.error);
      const body = ClaimWorkSliceBodySchema.safeParse({
        ...(args.leaseTtlMs !== undefined ? { leaseTtlMs: args.leaseTtlMs } : {}),
        ...(args.agentEnvironment !== undefined ? { agentEnvironment: args.agentEnvironment } : {}),
      });
      if (!body.success) return toValidationErrorResult(body.error);
      return toMcpCallToolResult(await bridge.claimWorkSlice(itemId.data, slcId.data, body.data));
    },
  );

  // 12. openhuddle_update_work_slice
  server.registerTool(
    "openhuddle_update_work_slice",
    {
      description:
        "Renew an active slice lease with live progress summary, or pause the slice to ask a structured clarification question.",
      inputSchema: {
        workItemId: z.string().min(3).max(64).describe("Target work item ID."),
        sliceId: z.string().min(3).max(64).describe("Target work slice ID."),
        action: z
          .enum(["heartbeat", "raise_attention"])
          .default("heartbeat")
          .describe("Whether to renew lease heartbeat or pause for human clarification."),
        leaseVersion: z
          .number()
          .int()
          .positive()
          .describe("Current fencing leaseVersion returned by openhuddle_claim_work_slice."),
        leaseTtlMs: z.number().int().min(15_000).max(600_000).optional(),
        liveSummary: z.string().max(1_000).optional(),
        diffAdded: z.number().int().nonnegative().optional(),
        diffRemoved: z.number().int().nonnegative().optional(),
        question: z
          .string()
          .min(1)
          .max(600)
          .optional()
          .describe("Required when action=raise_attention: single concise question for the owner."),
        options: z
          .array(z.string().min(1).max(120))
          .min(2)
          .max(5)
          .optional()
          .describe("Required when action=raise_attention: 2 to 5 structured answer options."),
      },
    },
    async (args): Promise<CallToolResult> => {
      const itemId = WorkItemIdSchema.safeParse(args.workItemId);
      if (!itemId.success) return toValidationErrorResult(itemId.error);
      const slcId = WorkSliceIdSchema.safeParse(args.sliceId);
      if (!slcId.success) return toValidationErrorResult(slcId.error);

      if (args.action === "raise_attention") {
        const body = RaiseWorkAttentionBodySchema.safeParse({
          leaseVersion: args.leaseVersion,
          question: args.question,
          options: args.options,
        });
        if (!body.success) return toValidationErrorResult(body.error);
        return toMcpCallToolResult(
          await bridge.raiseWorkAttention(itemId.data, slcId.data, body.data),
        );
      }

      const hbBody = HeartbeatWorkSliceBodySchema.safeParse({
        leaseVersion: args.leaseVersion,
        ...(args.leaseTtlMs !== undefined ? { leaseTtlMs: args.leaseTtlMs } : {}),
        ...(args.liveSummary !== undefined ? { liveSummary: args.liveSummary } : {}),
        ...(args.diffAdded !== undefined ? { diffAdded: args.diffAdded } : {}),
        ...(args.diffRemoved !== undefined ? { diffRemoved: args.diffRemoved } : {}),
      });
      if (!hbBody.success) return toValidationErrorResult(hbBody.error);
      return toMcpCallToolResult(
        await bridge.heartbeatWorkSlice(itemId.data, slcId.data, hbBody.data),
      );
    },
  );

  // 13. openhuddle_complete_work_slice
  server.registerTool(
    "openhuddle_complete_work_slice",
    {
      description:
        "Complete an execution slice with diff/provenance or submit a verifier verdict (passed | changes_requested).",
      inputSchema: {
        workItemId: z.string().min(3).max(64).describe("Target work item ID."),
        sliceId: z.string().min(3).max(64).describe("Target work slice ID."),
        leaseVersion: z.number().int().positive().describe("Current fencing leaseVersion."),
        summary: z.string().min(1).max(1_000).describe("Deliverable or verification summary."),
        changedFiles: z.array(z.string().min(1).max(260)).max(200).optional(),
        diffAdded: z.number().int().nonnegative().optional(),
        diffRemoved: z.number().int().nonnegative().optional(),
        worktreeBranch: z.string().min(1).max(160).optional(),
        testCommand: z.string().min(1).max(400).optional(),
        testPassed: z.boolean().optional(),
        verdict: WorkVerifyVerdictSchema.optional().describe(
          "For verify slices: passed (advance to human review) or changes_requested (reopen write slices).",
        ),
        provenance: WorkSliceProvenanceSchema.optional(),
      },
    },
    async (args): Promise<CallToolResult> => {
      const itemId = WorkItemIdSchema.safeParse(args.workItemId);
      if (!itemId.success) return toValidationErrorResult(itemId.error);
      const slcId = WorkSliceIdSchema.safeParse(args.sliceId);
      if (!slcId.success) return toValidationErrorResult(slcId.error);
      const body = CompleteWorkSliceBodySchema.safeParse({
        leaseVersion: args.leaseVersion,
        summary: args.summary,
        ...(args.changedFiles !== undefined ? { changedFiles: args.changedFiles } : {}),
        ...(args.diffAdded !== undefined ? { diffAdded: args.diffAdded } : {}),
        ...(args.diffRemoved !== undefined ? { diffRemoved: args.diffRemoved } : {}),
        ...(args.worktreeBranch !== undefined ? { worktreeBranch: args.worktreeBranch } : {}),
        ...(args.testCommand !== undefined ? { testCommand: args.testCommand } : {}),
        ...(args.testPassed !== undefined ? { testPassed: args.testPassed } : {}),
        ...(args.verdict !== undefined ? { verdict: args.verdict } : {}),
        ...(args.provenance !== undefined ? { provenance: args.provenance } : {}),
      });
      if (!body.success) return toValidationErrorResult(body.error);
      return toMcpCallToolResult(
        await bridge.completeWorkSlice(itemId.data, slcId.data, body.data),
      );
    },
  );

  return server;
}

/**
 * 以本地 `stdio` 传输模式启动 OpenHuddle MCP Server（面向 Claude Desktop、Cursor、Antigravity 等本地宿主）。
 *
 * @param config - 服务端地址与 Agent 令牌配置
 * @returns 已完成连接的 `{ server, transport }` 句柄对
 */
export async function startOpenHuddleMcpStdioServer(
  config: Readonly<OpenHuddleMcpServerConfig>,
): Promise<{ readonly server: McpServer; readonly transport: StdioServerTransport }> {
  const server = createOpenHuddleMcpServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return { server, transport };
}

/**
 * 以无状态 Web Standard Streamable HTTP 模式处理单次远程 MCP 请求（可直接嵌入 Hono 路由）。
 *
 * @param request - 标准 Fetch `Request`（含 JSON-RPC POST 载荷）
 * @param config - 服务端地址与当前认证 Agent 令牌配置
 * @returns 标准 Fetch `Response`
 */
export async function handleOpenHuddleMcpHttpRequest(
  request: Request,
  config: Readonly<OpenHuddleMcpServerConfig>,
): Promise<Response> {
  const server = createOpenHuddleMcpServer(config);
  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    await server.close();
  }
}

export { McpServer, StdioServerTransport, WebStandardStreamableHTTPServerTransport };

export {
  OpenHuddleMcpApiBridge,
  type McpApiBridgeOptions,
  type McpBridgeResult,
} from "./api-bridge.js";
