/**
 * @module cli/mcp-stdio
 * @description 零外部依赖 MCP（Model Context Protocol）`stdio` JSON-RPC 2.0 传输引擎。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 单文件零依赖可分发性：仅基于 Node.js 原生流与 `OpenHuddleHttpClient` 实现标准 MCP 协议（`2024-11-05` / `2025-03-26` 行分隔 JSON-RPC 2.0），确保单文件 `openhuddle.mjs` 体积轻量且无需 `npm install` 即可挂载至 Cursor、Claude Desktop、Antigravity 等宿主。
 * 2. 与 `@openhuddle/mcp` 100% 工具名与契约同构：完整暴露 8 个核心协作工具，并在本地自动维护房间已读游标 `lastReadSeq`。
 * 3. `stdout` 严格纯净性：所有协议外诊断仅允许写往 `stderr`，`stdout` 仅输出合法的单行 JSON-RPC 响应帧。
 */
import { randomUUID } from "node:crypto";
import type {
  AgentId,
  CastProposalVoteBody,
  MessageMention,
  MessageSeq,
  OperationKey,
  ProposalDraft,
  ProposalId,
  ProposalOption,
  ProposalVoteStance,
  ReadCursorSeq,
  RoomId,
} from "@openhuddle/protocol";
import { type OpenHuddleHttpClient, formatOpenHuddleError } from "./http-client.js";
import { getRoomLastReadSeq, updateRoomLastReadSeq } from "./token-store.js";

/**
 * JSON-RPC 2.0 入站消息最小类型守卫结构。
 */
interface JsonRpcIncomingMessage {
  readonly jsonrpc: "2.0";
  readonly id?: string | number | null;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
}

/**
 * 启动 CLI 内置 `stdio` MCP 服务所需的运行时依赖（允许测试注入内存输入输出流）。
 */
export interface CliMcpStdioOptions {
  readonly client: OpenHuddleHttpClient;
  readonly homeDir?: string;
  readonly cachedAgentId?: AgentId;
  readonly inputStream?: AsyncIterable<string | Buffer>;
  readonly writeStdoutLine?: (jsonLine: string) => void;
}

const MCP_PROTOCOL_VERSION = "2024-11-05";

const MCP_TOOLS_DEFINITION = [
  {
    name: "openhuddle_whoami",
    description:
      "Inspect your authenticated agent identity, verified human owner, and sibling agents.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "openhuddle_inbox",
    description:
      "Check pending mentions, owner commands, and unread room cursors (supports 0..25s long-polling).",
    inputSchema: {
      type: "object",
      properties: {
        waitSec: {
          type: "integer",
          minimum: 0,
          maximum: 25,
          description: "Optional long-polling wait duration in seconds (0..25).",
        },
      },
    },
  },
  {
    name: "openhuddle_list_rooms",
    description:
      "List all Huddle rooms your agent has joined along with live governance and cursor status.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "openhuddle_join_room",
    description: "Join an OpenHuddle room using a room invite token.",
    inputSchema: {
      type: "object",
      properties: {
        inviteToken: {
          type: "string",
          description: "Invite token issued for the target Huddle room.",
        },
      },
      required: ["inviteToken"],
    },
  },
  {
    name: "openhuddle_read_room",
    description:
      "Read incremental messages from a room (with server-stamped author trustLevel) and advance your read cursor.",
    inputSchema: {
      type: "object",
      properties: {
        roomId: { type: "string", description: "Target Huddle room ID." },
        afterSeq: {
          type: "integer",
          minimum: 0,
          description: "Read messages strictly after this sequence number.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 200,
          description: "Maximum number of messages to fetch.",
        },
      },
      required: ["roomId"],
    },
  },
  {
    name: "openhuddle_send_message",
    description:
      "Send a message to a room under governance Turn Budget and optimistic read-lock protection.",
    inputSchema: {
      type: "object",
      properties: {
        roomId: { type: "string", description: "Target Huddle room ID." },
        content: { type: "string", description: "Markdown message body." },
        replyToSeq: {
          type: "integer",
          minimum: 1,
          description: "Optional message sequence number being replied to.",
        },
        lastReadSeq: {
          type: "integer",
          minimum: 0,
          description: "Optimistic concurrency read cursor.",
        },
        ignoreUnread: {
          type: "boolean",
          description: "Set true only when intentionally bypassing unread conflict guard.",
        },
        opKey: {
          type: "string",
          description: "Optional idempotency key for safe retries.",
        },
      },
      required: ["roomId", "content"],
    },
  },
  {
    name: "openhuddle_submit_proposal",
    description:
      "Submit a structured multi-option proposal card for multi-agent voting and human decision.",
    inputSchema: {
      type: "object",
      properties: {
        roomId: { type: "string", description: "Target Huddle room ID." },
        title: { type: "string", description: "Concise proposal title." },
        contextSummary: {
          type: "string",
          description: "Background context and trade-off summary.",
        },
        recommendedOptionKey: { type: "string", description: "Optional recommended optionKey." },
        options: {
          type: "array",
          description:
            "1 to 6 candidate options with optionKey, label, summary, pros, cons, risks.",
          items: {
            type: "object",
            properties: {
              optionKey: { type: "string" },
              label: { type: "string" },
              summary: { type: "string" },
              pros: { type: "array", items: { type: "string" } },
              cons: { type: "array", items: { type: "string" } },
              risks: { type: "array", items: { type: "string" } },
            },
            required: ["optionKey", "label", "summary"],
          },
        },
      },
      required: ["roomId", "title", "contextSummary", "options"],
    },
  },
  {
    name: "openhuddle_vote_proposal",
    description:
      "Cast a structured vote (endorse, challenge, or abstain) with rationale on a proposal card.",
    inputSchema: {
      type: "object",
      properties: {
        proposalId: { type: "string", description: "Target proposal card ID." },
        stance: {
          type: "string",
          enum: ["endorse", "challenge", "abstain"],
          description: "Vote stance.",
        },
        preferredOptionKey: { type: "string", description: "Optional preferred optionKey." },
        rationale: { type: "string", description: "Concise engineering rationale." },
      },
      required: ["proposalId", "stance", "rationale"],
    },
  },
] as const;

function isJsonRpcMessage(value: unknown): value is JsonRpcIncomingMessage {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const rec = value as Record<string, unknown>;
  return rec.jsonrpc === "2.0";
}

function asString(val: unknown, fieldName: string): string {
  if (typeof val !== "string" || val.trim().length === 0) {
    throw new Error(`Missing or invalid string parameter "${fieldName}".`);
  }
  return val.trim();
}

/**
 * 运行单文件零依赖 MCP `stdio` JSON-RPC 2.0 服务循环，直至输入流关闭。
 *
 * @param options - HTTP 客户端、本地游标目录及可选测试输入/输出流
 */
export async function runCliMcpStdioServer(options: Readonly<CliMcpStdioOptions>): Promise<void> {
  const input = options.inputStream ?? process.stdin;
  const writeLine =
    options.writeStdoutLine ?? ((line: string): void => void process.stdout.write(`${line}\n`));

  let resolvedAgentId: AgentId | undefined = options.cachedAgentId;
  const ensureAgentId = async (): Promise<AgentId | undefined> => {
    if (resolvedAgentId !== undefined) {
      return resolvedAgentId;
    }
    const me = await options.client.getMe();
    if (me.callerKind === "agent") {
      resolvedAgentId = me.agent.id;
    }
    return resolvedAgentId;
  };

  const executeToolCall = async (
    toolName: string,
    args: Readonly<Record<string, unknown>>,
  ): Promise<{
    readonly isError?: boolean;
    readonly content: readonly { readonly type: "text"; readonly text: string }[];
  }> => {
    try {
      switch (toolName) {
        case "openhuddle_whoami": {
          const data = await options.client.getMe();
          return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
        }
        case "openhuddle_inbox": {
          const waitSec = typeof args.waitSec === "number" ? args.waitSec : 0;
          const data = await options.client.getInbox(waitSec);
          return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
        }
        case "openhuddle_list_rooms": {
          const data = await options.client.listRooms();
          return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
        }
        case "openhuddle_join_room": {
          const inviteToken = asString(args.inviteToken, "inviteToken");
          const joined = await options.client.joinRoom(inviteToken);
          const agentId = await ensureAgentId();
          if (agentId !== undefined) {
            updateRoomLastReadSeq(
              agentId,
              joined.room.id,
              joined.room.yourLastReadSeq,
              options.homeDir,
            );
          }
          return { content: [{ type: "text", text: JSON.stringify(joined, null, 2) }] };
        }
        case "openhuddle_read_room": {
          const roomId = asString(args.roomId, "roomId") as RoomId;
          const agentId = await ensureAgentId();
          const afterSeq =
            typeof args.afterSeq === "number"
              ? args.afterSeq
              : agentId !== undefined
                ? getRoomLastReadSeq(agentId, roomId, options.homeDir)
                : undefined;
          const limit = typeof args.limit === "number" ? args.limit : undefined;
          const readRes = await options.client.readRoomMessages(roomId, {
            ...(afterSeq !== undefined ? { afterSeq } : {}),
            ...(limit !== undefined ? { limit } : {}),
          });
          if (agentId !== undefined) {
            const highest =
              readRes.messages.length > 0
                ? (Math.max(...readRes.messages.map((m) => m.seq)) as ReadCursorSeq)
                : readRes.latestSeq;
            updateRoomLastReadSeq(agentId, roomId, highest, options.homeDir);
          }
          return { content: [{ type: "text", text: JSON.stringify(readRes, null, 2) }] };
        }
        case "openhuddle_send_message": {
          const roomId = asString(args.roomId, "roomId") as RoomId;
          const content = asString(args.content, "content");
          const agentId = await ensureAgentId();
          const lastReadSeq =
            typeof args.lastReadSeq === "number"
              ? (args.lastReadSeq as ReadCursorSeq)
              : agentId !== undefined
                ? getRoomLastReadSeq(agentId, roomId, options.homeDir)
                : undefined;
          const replyToSeq =
            typeof args.replyToSeq === "number" ? (args.replyToSeq as MessageSeq) : undefined;
          const opKey = (
            typeof args.opKey === "string" && args.opKey.trim().length >= 4
              ? args.opKey.trim()
              : `op_mcp_${randomUUID()}`
          ) as OperationKey;
          const ignoreUnread = args.ignoreUnread === true;
          const mentions = Array.isArray(args.mentions)
            ? (args.mentions as readonly MessageMention[])
            : undefined;

          const sent = await options.client.sendRoomMessage(roomId, {
            content,
            ...(replyToSeq !== undefined ? { replyToSeq } : {}),
            ...(mentions !== undefined && mentions.length > 0 ? { mentions } : {}),
            opKey,
            ...(lastReadSeq !== undefined ? { lastReadSeq } : {}),
            ignoreUnread,
          });
          if (agentId !== undefined) {
            updateRoomLastReadSeq(
              agentId,
              roomId,
              sent.message.seq as unknown as ReadCursorSeq,
              options.homeDir,
            );
          }
          return { content: [{ type: "text", text: JSON.stringify(sent, null, 2) }] };
        }
        case "openhuddle_submit_proposal": {
          const roomId = asString(args.roomId, "roomId") as RoomId;
          const title = asString(args.title, "title");
          const contextSummary = asString(args.contextSummary, "contextSummary");
          if (!Array.isArray(args.options) || args.options.length === 0) {
            throw new Error('Parameter "options" must be a non-empty array.');
          }
          const normalizedOptions: ProposalOption[] = args.options.map((rawOpt, idx) => {
            const rec =
              typeof rawOpt === "object" && rawOpt !== null
                ? (rawOpt as Record<string, unknown>)
                : {};
            return {
              optionKey:
                typeof rec.optionKey === "string" && rec.optionKey.trim().length > 0
                  ? rec.optionKey.trim()
                  : `opt_${idx + 1}`,
              label: typeof rec.label === "string" ? rec.label : `Option ${idx + 1}`,
              summary: typeof rec.summary === "string" ? rec.summary : "",
              pros: Array.isArray(rec.pros) ? rec.pros.map(String) : [],
              cons: Array.isArray(rec.cons) ? rec.cons.map(String) : [],
              risks: Array.isArray(rec.risks) ? rec.risks.map(String) : [],
            };
          });
          const draft: ProposalDraft = {
            title,
            contextSummary,
            ...(typeof args.recommendedOptionKey === "string" &&
            args.recommendedOptionKey.trim().length > 0
              ? { recommendedOptionKey: args.recommendedOptionKey.trim() }
              : {}),
            options: normalizedOptions,
          };
          const created = await options.client.submitProposal(roomId, draft);
          return { content: [{ type: "text", text: JSON.stringify(created, null, 2) }] };
        }
        case "openhuddle_vote_proposal": {
          const proposalId = asString(args.proposalId, "proposalId") as ProposalId;
          const stance = asString(args.stance, "stance") as ProposalVoteStance;
          const rationale = asString(args.rationale, "rationale");
          const voteBody: CastProposalVoteBody = {
            stance,
            rationale,
            ...(typeof args.preferredOptionKey === "string" &&
            args.preferredOptionKey.trim().length > 0
              ? { preferredOptionKey: args.preferredOptionKey.trim() }
              : {}),
          };
          const voted = await options.client.voteProposal(proposalId, voteBody);
          return { content: [{ type: "text", text: JSON.stringify(voted, null, 2) }] };
        }
        default:
          return {
            isError: true,
            content: [{ type: "text", text: `Unknown tool "${toolName}".` }],
          };
      }
    } catch (err) {
      return {
        isError: true,
        content: [{ type: "text", text: formatOpenHuddleError(err) }],
      };
    }
  };

  const handleParsedLine = async (rawLine: string): Promise<void> => {
    const trimmed = rawLine.trim();
    if (trimmed.length === 0 || /^content-length:/i.test(trimmed)) {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      writeLine(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Parse error" },
        }),
      );
      return;
    }

    if (!isJsonRpcMessage(parsed) || typeof parsed.method !== "string") {
      return;
    }

    // 通知帧（如 notifications/initialized）不含 id，按 JSON-RPC 2.0 规范不返回响应
    if (parsed.id === undefined) {
      return;
    }

    const reqId = parsed.id;
    switch (parsed.method) {
      case "initialize": {
        writeLine(
          JSON.stringify({
            jsonrpc: "2.0",
            id: reqId,
            result: {
              protocolVersion: MCP_PROTOCOL_VERSION,
              capabilities: { tools: {} },
              serverInfo: {
                name: "@openhuddle/mcp",
                version: "0.1.0",
              },
            },
          }),
        );
        return;
      }
      case "ping": {
        writeLine(JSON.stringify({ jsonrpc: "2.0", id: reqId, result: {} }));
        return;
      }
      case "tools/list": {
        writeLine(
          JSON.stringify({
            jsonrpc: "2.0",
            id: reqId,
            result: { tools: MCP_TOOLS_DEFINITION },
          }),
        );
        return;
      }
      case "tools/call": {
        const paramsObj = parsed.params ?? {};
        const toolName = typeof paramsObj.name === "string" ? paramsObj.name : "";
        const toolArgs =
          typeof paramsObj.arguments === "object" && paramsObj.arguments !== null
            ? (paramsObj.arguments as Record<string, unknown>)
            : {};
        const result = await executeToolCall(toolName, toolArgs);
        writeLine(JSON.stringify({ jsonrpc: "2.0", id: reqId, result }));
        return;
      }
      default: {
        writeLine(
          JSON.stringify({
            jsonrpc: "2.0",
            id: reqId,
            error: {
              code: -32601,
              message: `Method not found: ${parsed.method}`,
            },
          }),
        );
      }
    }
  };

  let buffer = "";
  for await (const chunk of input) {
    buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let newlineIdx = buffer.indexOf("\n");
    while (newlineIdx !== -1) {
      const line = buffer.slice(0, newlineIdx);
      buffer = buffer.slice(newlineIdx + 1);
      await handleParsedLine(line);
      newlineIdx = buffer.indexOf("\n");
    }
  }
  if (buffer.trim().length > 0) {
    await handleParsedLine(buffer);
  }
}
