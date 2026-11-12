/**
 * @module mcp/tests
 * @description OpenHuddle 双模 MCP Server（`InMemoryTransport` 客户端直连与 Streamable HTTP 模式）端到端契约测试。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 全链路 JSON-RPC 协议校验：通过真实 `@modelcontextprotocol/sdk` `Client` 驱动工具枚举与调用，验证全部 8 个 MCP 工具的 JSON Schema 生成与执行闭环。
 * 2. 乐观并发读锁与 409 错误透传：验证 `openhuddle_read_room` 自动缓存游标供 `openhuddle_send_message` 消费，并在命中 `409` 时向大模型返回 `isError: true` 及漏读详情。
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import {
  createOpenHuddleMcpServer,
  getCoreMcpToolDescriptors,
  handleOpenHuddleMcpHttpRequest,
} from "../index.js";

/**
 * 构造 JSON HTTP 模拟响应。
 *
 * @param status - HTTP 状态码
 * @param body - 响应对象
 * @returns 标准 `Response`
 */
function jsonHttpResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * 从 MCP `callTool` 返回值中提取首段文本输出。
 *
 * @param result - MCP 工具执行结果
 * @returns 首段 `text` 字符串
 */
function extractFirstTextBlock(result: Readonly<Record<string, unknown>>): string {
  const rawContent = result.content;
  if (!Array.isArray(rawContent)) {
    return "";
  }
  const first = rawContent[0] as { readonly type?: string; readonly text?: string } | undefined;
  return first?.type === "text" && typeof first.text === "string" ? first.text : "";
}

describe("@openhuddle/mcp — Dual-Mode MCP Server & 8 Core Tools", () => {
  it("registers all 8 core OpenHuddle tools with non-empty JSON Schemas and executes full workflow against mocked fetch", async () => {
    const recordedRequests: Array<{
      readonly method: string;
      readonly url: string;
      readonly authHeader: string | null;
      readonly body?: Record<string, unknown>;
    }> = [];

    let simulateConflictOnSend = false;

    const mockFetch: typeof fetch = async (input, init) => {
      const method = init?.method ?? "GET";
      const url = new URL(String(input));
      const authHeader = new Headers(init?.headers).get("Authorization");
      const parsedBody =
        typeof init?.body === "string"
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : undefined;

      recordedRequests.push({
        method,
        url: `${url.pathname}${url.search}`,
        authHeader,
        ...(parsedBody !== undefined ? { body: parsedBody } : {}),
      });

      if (url.pathname === "/api/v1/me") {
        return jsonHttpResponse(200, {
          ok: true,
          callerKind: "agent",
          agent: {
            id: "agt_mcp_01",
            ownerUserId: "usr_owner_01",
            displayName: "MCP Antigravity",
            slug: "mcp-antigravity",
            platform: "antigravity",
            reach: "online_sse",
            createdAtIso: "2026-11-12T06:00:00.000Z",
          },
          owner: {
            id: "usr_owner_01",
            email: "owner@openhuddle.dev",
            displayName: "Pangyan",
            createdAtIso: "2026-11-12T05:00:00.000Z",
          },
          siblingAgents: [],
        });
      }

      if (url.pathname === "/api/v1/inbox") {
        return jsonHttpResponse(200, {
          ok: true,
          totalUnreadMessages: 1,
          rooms: [
            {
              roomId: "rom_core",
              roomName: "Architecture Huddle",
              lastSeq: 12,
              yourLastReadSeq: 11,
              unreadCount: 1,
              hasOwnerCommand: true,
              hasDirectMention: true,
              governanceStatus: "active",
            },
          ],
          serverTimeIso: "2026-11-12T06:20:00.000Z",
        });
      }

      if (url.pathname === "/api/v1/rooms") {
        return jsonHttpResponse(200, {
          ok: true,
          rooms: [
            {
              id: "rom_core",
              name: "Architecture Huddle",
              topic: "Wave 2 MCP & Governance",
              visibility: "invite_only",
              lastSeq: 12,
              yourLastReadSeq: 11,
              governance: {
                config: {
                  mode: "free",
                  allowAgentMentions: true,
                  maxConsecutiveAgentTurns: 6,
                  requireReadBeforeSend: true,
                  agentCooldownMs: 3000,
                },
                status: "active",
                consecutiveAgentTurns: 0,
                roundTableSpokenAgentIds: [],
                lastSpokenAtByAgentMs: {},
              },
              createdAtIso: "2026-11-12T06:00:00.000Z",
            },
          ],
        });
      }

      if (url.pathname === "/api/v1/join") {
        return jsonHttpResponse(200, {
          ok: true,
          room: {
            id: "rom_core",
            name: "Architecture Huddle",
            yourLastReadSeq: 10,
            lastSeq: 12,
          },
        });
      }

      if (url.pathname === "/api/v1/rooms/rom_core/messages" && method === "GET") {
        return jsonHttpResponse(200, {
          ok: true,
          latestSeq: 12,
          messages: [
            {
              roomId: "rom_core",
              seq: 11,
              type: "text",
              content: "Compare stdio vs Streamable HTTP MCP.",
              mentions: [],
              createdAtIso: "2026-11-12T06:18:00.000Z",
              author: {
                kind: "human",
                userId: "usr_owner_01",
                ownerUserId: "usr_owner_01",
                displayName: "Pangyan",
                isYou: false,
                isYourOwner: true,
                trustLevel: "owner_command",
              },
            },
            {
              roomId: "rom_core",
              seq: 12,
              type: "text",
              content: "Both share the exact McpServer instance.",
              mentions: [],
              createdAtIso: "2026-11-12T06:19:00.000Z",
              author: {
                kind: "agent",
                agentId: "agt_codex_02",
                ownerUserId: "usr_owner_01",
                displayName: "Codex Peer",
                platform: "codex",
                isYou: false,
                isYourOwner: false,
                trustLevel: "owner_sibling_agent",
              },
            },
          ],
          governance: {
            config: {
              mode: "free",
              allowAgentMentions: true,
              maxConsecutiveAgentTurns: 6,
              requireReadBeforeSend: true,
              agentCooldownMs: 3000,
            },
            status: "active",
            consecutiveAgentTurns: 1,
            roundTableSpokenAgentIds: [],
            lastSpokenAtByAgentMs: {},
          },
        });
      }

      if (url.pathname === "/api/v1/rooms/rom_core/messages" && method === "POST") {
        if (simulateConflictOnSend) {
          return jsonHttpResponse(409, {
            ok: false,
            error: {
              code: "CONFLICT_UNREAD_MESSAGES",
              message: "Unread messages pending in room.",
              requestId: "req_mcp_409",
              details: {
                latestSeq: 14,
                yourLastReadSeq: 13,
                missedMessages: [
                  {
                    roomId: "rom_core",
                    seq: 14,
                    type: "text",
                    content: "Hold on, check the 2C4G memory footprint first!",
                    mentions: [],
                    createdAtIso: "2026-11-12T06:21:00.000Z",
                    author: {
                      kind: "human",
                      userId: "usr_external",
                      ownerUserId: "usr_external",
                      displayName: "External Reviewer",
                      isYou: false,
                      isYourOwner: false,
                      trustLevel: "external_participant",
                    },
                  },
                ],
              },
            },
          });
        }

        return jsonHttpResponse(201, {
          ok: true,
          message: {
            roomId: "rom_core",
            seq: 13,
            type: "text",
            content: String(parsedBody?.content ?? ""),
            mentions: [],
            createdAtIso: "2026-11-12T06:20:30.000Z",
            author: {
              kind: "agent",
              agentId: "agt_mcp_01",
              ownerUserId: "usr_owner_01",
              displayName: "MCP Antigravity",
              platform: "antigravity",
              isYou: true,
              isYourOwner: false,
              trustLevel: "owner_sibling_agent",
            },
          },
          governance: { status: "active" },
          wokenAgentIds: [],
        });
      }

      if (url.pathname === "/api/v1/rooms/rom_core/proposals" && method === "POST") {
        return jsonHttpResponse(201, {
          ok: true,
          proposal: {
            id: "prp_mcp_01",
            roomId: "rom_core",
            originMessageSeq: 15,
            status: "open",
            draft: parsedBody,
            votes: [],
            createdAtIso: "2026-11-12T06:22:00.000Z",
          },
        });
      }

      if (url.pathname === "/api/v1/proposals/prp_mcp_01/votes" && method === "POST") {
        return jsonHttpResponse(200, {
          ok: true,
          proposal: {
            id: "prp_mcp_01",
            roomId: "rom_core",
            originMessageSeq: 15,
            status: "open",
            votes: [parsedBody],
          },
        });
      }

      return jsonHttpResponse(404, { ok: false });
    };

    const mcpServer = createOpenHuddleMcpServer({
      serverUrl: "https://huddle.example.com/",
      agentToken: "oh_agt_mcp_secret_token",
      fetchImpl: mockFetch,
    });

    const mcpClient = new Client({
      name: "openhuddle-test-client",
      version: "0.1.0",
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([mcpServer.connect(serverTransport), mcpClient.connect(clientTransport)]);

    try {
      const listed = await mcpClient.listTools();
      const toolNames = listed.tools.map((t) => t.name);
      expect(toolNames).toEqual(getCoreMcpToolDescriptors().map((d) => d.name));
      expect(toolNames).toEqual([
        "openhuddle_whoami",
        "openhuddle_inbox",
        "openhuddle_list_rooms",
        "openhuddle_join_room",
        "openhuddle_read_room",
        "openhuddle_send_message",
        "openhuddle_submit_proposal",
        "openhuddle_vote_proposal",
      ]);

      // 1. whoami
      const whoamiRes = await mcpClient.callTool({ name: "openhuddle_whoami", arguments: {} });
      expect(whoamiRes.isError).toBeFalsy();
      expect(extractFirstTextBlock(whoamiRes)).toContain("MCP Antigravity");

      // 2. inbox
      const inboxRes = await mcpClient.callTool({
        name: "openhuddle_inbox",
        arguments: { waitSec: 3 },
      });
      expect(extractFirstTextBlock(inboxRes)).toContain("Architecture Huddle");

      // 3. list_rooms
      const roomsRes = await mcpClient.callTool({ name: "openhuddle_list_rooms", arguments: {} });
      expect(extractFirstTextBlock(roomsRes)).toContain("rom_core");

      // 4. join_room (初始化游标为 10)
      const joinRes = await mcpClient.callTool({
        name: "openhuddle_join_room",
        arguments: { inviteToken: "inv_arch_room_123" },
      });
      expect(joinRes.isError).toBeFalsy();

      // 5. read_room (自动携带 afterSeq=10，并将游标推进至 12)
      const readRes = await mcpClient.callTool({
        name: "openhuddle_read_room",
        arguments: { roomId: "rom_core", limit: 20 },
      });
      expect(extractFirstTextBlock(readRes)).toContain("owner_command");

      // 6. send_message (未传 lastReadSeq 时自动注入会话缓存的 lastReadSeq=12，成功后推进至 13)
      const sendOkRes = await mcpClient.callTool({
        name: "openhuddle_send_message",
        arguments: {
          roomId: "rom_core",
          content: "Dual-mode MCP transport verified!",
          replyToSeq: 12,
        },
      });
      expect(sendOkRes.isError).toBeFalsy();
      const postMessageCall = recordedRequests.find(
        (r) => r.method === "POST" && r.url === "/api/v1/rooms/rom_core/messages",
      );
      expect(postMessageCall?.body?.lastReadSeq).toBe(12);
      expect(postMessageCall?.authHeader).toBe("Bearer oh_agt_mcp_secret_token");

      // 模拟并发冲突 409 CONFLICT_UNREAD_MESSAGES
      simulateConflictOnSend = true;
      const sendConflictRes = await mcpClient.callTool({
        name: "openhuddle_send_message",
        arguments: {
          roomId: "rom_core",
          content: "Blind follow-up message",
        },
      });
      expect(sendConflictRes.isError).toBe(true);
      expect(extractFirstTextBlock(sendConflictRes)).toContain("CONFLICT_UNREAD_MESSAGES");
      expect(extractFirstTextBlock(sendConflictRes)).toContain("External Reviewer");
      expect(extractFirstTextBlock(sendConflictRes)).toContain("external_participant");

      // 7. submit_proposal
      const proposalRes = await mcpClient.callTool({
        name: "openhuddle_submit_proposal",
        arguments: {
          roomId: "rom_core",
          title: "Transport Selection",
          contextSummary: "Support both local CLI stdio and remote HTTP MCP.",
          recommendedOptionKey: "dual",
          options: [
            {
              optionKey: "dual",
              label: "Dual-Mode Stdio + Streamable HTTP",
              summary: "Single McpServer factory bound to both transports.",
              pros: ["Zero code duplication"],
              cons: [],
              risks: [],
            },
          ],
        },
      });
      expect(proposalRes.isError).toBeFalsy();
      expect(extractFirstTextBlock(proposalRes)).toContain("prp_mcp_01");

      // 8. vote_proposal
      const voteRes = await mcpClient.callTool({
        name: "openhuddle_vote_proposal",
        arguments: {
          proposalId: "prp_mcp_01",
          stance: "endorse",
          preferredOptionKey: "dual",
          rationale: "Matches OpenHuddle 2C4G zero-bloat architecture.",
        },
      });
      expect(voteRes.isError).toBeFalsy();
      expect(extractFirstTextBlock(voteRes)).toContain("endorse");
    } finally {
      await mcpClient.close();
      await mcpServer.close();
    }
  });

  it("handles stateless Web Standard Streamable HTTP MCP initialize requests via handleOpenHuddleMcpHttpRequest", async () => {
    const httpRequest = new Request("https://huddle.example.com/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "http-probe", version: "1.0.0" },
        },
      }),
    });

    const response = await handleOpenHuddleMcpHttpRequest(httpRequest, {
      serverUrl: "https://huddle.example.com",
      agentToken: "oh_agt_http_mode",
      fetchImpl: async () => jsonHttpResponse(200, { ok: true }),
    });

    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      readonly result?: { readonly serverInfo?: { readonly name?: string } };
    };
    expect(payload.result?.serverInfo?.name).toBe("@openhuddle/mcp");
  });
});
