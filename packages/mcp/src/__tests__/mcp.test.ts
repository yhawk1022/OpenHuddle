/**
 * @module mcp/tests
 * @description OpenHuddle 双模 MCP Server（`InMemoryTransport` 客户端直连与 Streamable HTTP 模式）端到端契约测试。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 全链路 JSON-RPC 协议校验：通过真实 `@modelcontextprotocol/sdk` `Client` 驱动工具枚举与调用，验证MCP 工具的 JSON Schema 生成与执行闭环。
 * 2. 乐观并发读锁与 409 错误透传：验证 `openhuddle_read_room` 自动缓存游标供 `openhuddle_send_message` 消费，并在命中 `409` 时向大模型返回 `isError: true` 及漏读详情。
 */
import { randomFillSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import {
  OpenHuddleMcpApiBridge,
  createOpenHuddleMcpServer,
  getCoreMcpToolDescriptors,
  handleOpenHuddleMcpHttpRequest,
  normalizeMcpAttachmentBase64,
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

describe("@openhuddle/mcp — Dual-Mode MCP Server", () => {
  it("registers the OpenHuddle tools with non-empty JSON Schemas and executes full workflow against mocked fetch", async () => {
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

      if (url.pathname === "/api/v1/workspaces" && method === "GET") {
        return jsonHttpResponse(200, {
          ok: true,
          workspaces: [{ id: "wsp_core_01", name: "OpenHuddle", hostMode: "local_machine" }],
          roomBindings: [],
        });
      }

      if (url.pathname === "/api/v1/work-items" && method === "GET") {
        return jsonHttpResponse(200, {
          ok: true,
          items: [
            {
              id: "wrk_mcp_01",
              workspaceId: "wsp_core_01",
              stage: "working",
              slices: [{ sliceId: "slc_mcp_01", status: "waiting", leaseVersion: 0 }],
            },
          ],
        });
      }

      if (
        url.pathname === "/api/v1/work-items/wrk_mcp_01/slices/slc_mcp_01/claim" &&
        method === "POST"
      ) {
        return jsonHttpResponse(200, {
          ok: true,
          claimedSlice: {
            sliceId: "slc_mcp_01",
            status: "running",
            leaseVersion: 1,
          },
        });
      }

      if (
        url.pathname === "/api/v1/work-items/wrk_mcp_01/slices/slc_mcp_01/heartbeat" &&
        method === "POST"
      ) {
        return jsonHttpResponse(200, {
          ok: true,
          item: { id: "wrk_mcp_01", stage: "working" },
        });
      }

      if (url.pathname.endsWith("/review-evidence") && ["GET", "PUT"].includes(method)) {
        return jsonHttpResponse(200, { ok: true, leaseVersion: 1, patch: "review-patch" });
      }

      if (
        url.pathname === "/api/v1/work-items/wrk_mcp_01/slices/slc_mcp_01/complete" &&
        method === "POST"
      ) {
        return jsonHttpResponse(200, {
          ok: true,
          item: { id: "wrk_mcp_01", stage: "verifying" },
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
        "openhuddle_get_attachment",
        "openhuddle_send_message",
        "openhuddle_submit_proposal",
        "openhuddle_vote_proposal",
        "openhuddle_list_workspaces",
        "openhuddle_list_work",
        "openhuddle_claim_work_slice",
        "openhuddle_update_work_slice",
        "openhuddle_complete_work_slice",
        "openhuddle_put_review_evidence",
        "openhuddle_get_review_evidence",
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

      // 9. list_workspaces + 10. list_work + 11. claim + 12. heartbeat + 13. complete
      const wsRes = await mcpClient.callTool({
        name: "openhuddle_list_workspaces",
        arguments: {},
      });
      expect(wsRes.isError).toBeFalsy();
      expect(extractFirstTextBlock(wsRes)).toContain("wsp_core_01");

      const workRes = await mcpClient.callTool({
        name: "openhuddle_list_work",
        arguments: { claimableOnly: true },
      });
      expect(workRes.isError).toBeFalsy();
      expect(extractFirstTextBlock(workRes)).toContain("wrk_mcp_01");

      const claimRes = await mcpClient.callTool({
        name: "openhuddle_claim_work_slice",
        arguments: {
          workItemId: "wrk_mcp_01",
          sliceId: "slc_mcp_01",
          agentEnvironment: "Local Mac MCP",
        },
      });
      expect(claimRes.isError).toBeFalsy();
      expect(extractFirstTextBlock(claimRes)).toContain('"leaseVersion": 1');

      const hbRes = await mcpClient.callTool({
        name: "openhuddle_update_work_slice",
        arguments: {
          workItemId: "wrk_mcp_01",
          sliceId: "slc_mcp_01",
          action: "heartbeat",
          leaseVersion: 1,
          liveSummary: "Updated DB schema and running tests",
          diffAdded: 42,
        },
      });
      expect(hbRes.isError).toBeFalsy();

      const diffFiles = [
        {
          path: "packages/db/src/schema.ts",
          additions: 1,
          deletions: 0,
          lines: [{ kind: "add", newLine: 1, content: "export const version = 2;" }],
        },
      ];
      const evidenceTarget = { workItemId: "wrk_mcp_01", sliceId: "slc_mcp_01" };
      expect(
        (
          await mcpClient.callTool({
            name: "openhuddle_put_review_evidence",
            arguments: { ...evidenceTarget, leaseVersion: 1, patch: "review-patch" },
          })
        ).isError,
      ).toBeFalsy();
      const reviewEvidence = await mcpClient.callTool({
        name: "openhuddle_get_review_evidence",
        arguments: evidenceTarget,
      });
      expect(extractFirstTextBlock(reviewEvidence)).toContain("review-patch");
      expect(
        recordedRequests.filter((r) => r.url.endsWith("/review-evidence")).map((r) => r.method),
      ).toEqual(["PUT", "GET"]);

      const doneRes = await mcpClient.callTool({
        name: "openhuddle_complete_work_slice",
        arguments: {
          workItemId: "wrk_mcp_01",
          sliceId: "slc_mcp_01",
          leaseVersion: 1,
          summary: "Completed workspace DB migration",
          changedFiles: ["packages/db/src/schema.ts"],
          diffAdded: 42,
          diffRemoved: 1,
          diffFiles,
        },
      });
      expect(
        recordedRequests.find((request) => request.url.endsWith("/complete"))?.body,
      ).toMatchObject({ diffFiles });
      expect(doneRes.isError).toBeFalsy();
      expect(extractFirstTextBlock(doneRes)).toContain("verifying");
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

  it("aborts hung HTTP calls deterministically via AbortSignal.timeout without leaking the agent token", async () => {
    const hungFetch: typeof fetch = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(init.signal?.reason ?? new Error("Aborted"));
        });
      });

    const bridge = new OpenHuddleMcpApiBridge({
      serverUrl: "https://huddle.example.com",
      agentToken: "oh_agt_super_secret_should_not_leak",
      fetchImpl: hungFetch,
      requestTimeoutMs: 40,
    });

    const res = await bridge.listRooms();
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(0);
      expect(res.formattedError).toContain("Network error calling GET /api/v1/rooms");
      expect(res.formattedError).not.toContain("oh_agt_super_secret_should_not_leak");
    }
  });

  it("enforces zero node:fs / zero path-parameter security rules and handles multimodal attachments in memory", async () => {
    // 1. Static source guard: MCP implementation files must NEVER import node:fs
    for (const rel of ["../index.ts", "../api-bridge.ts", "../../../cli/src/mcp-stdio.ts"]) {
      const src = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
      expect(src).not.toMatch(/node:fs|from\s+["']fs["']/);
    }

    // 2. Base64 normalization helper
    expect(normalizeMcpAttachmentBase64("data:image/png;base64,\niVBORw0KGgo\n", "image/png")).toBe(
      "iVBORw0KGgo=",
    );
    // Mismatched data: prefix is intentionally NOT stripped so Zod rejects it
    expect(
      normalizeMcpAttachmentBase64("data:image/svg+xml;base64,PHN2Zz4=", "image/png"),
    ).toContain("data:image/svg+xml");

    const largePng = new PNG({ width: 160, height: 120 });
    randomFillSync(largePng.data);
    const largePngBytes = PNG.sync.write(largePng, { deflateLevel: 0 });
    const fakeJpegBytes = Buffer.alloc(8_000, 0xff);
    const smallBinBytes = Buffer.from("small-binary-report");
    const bigBinBytes = Buffer.alloc(600_000, 0x41);

    let lastSentBody: Record<string, unknown> | undefined;
    const mockFetch: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";

      if (url.pathname === "/api/v1/rooms/rom_mm/messages/1/attachment") {
        return new Response(largePngBytes, {
          status: 200,
          headers: {
            "content-type": "image/png",
            "x-openhuddle-author-trust": "external_participant",
            "x-openhuddle-author-kind": "human",
          },
        });
      }
      if (url.pathname === "/api/v1/rooms/rom_mm/messages/2/attachment") {
        return new Response(fakeJpegBytes, {
          status: 200,
          headers: {
            "content-type": "image/jpeg",
            "x-openhuddle-author-trust": "owner_command",
            "x-openhuddle-author-kind": "human",
          },
        });
      }
      if (url.pathname === "/api/v1/rooms/rom_mm/messages/3/attachment") {
        return new Response(smallBinBytes, {
          status: 200,
          headers: {
            "content-type": "application/octet-stream",
            "content-disposition": "attachment; filename=\"download\"; filename*=UTF-8''report.csv",
            "x-openhuddle-author-trust": "owner_sibling_agent",
            "x-openhuddle-author-kind": "agent",
          },
        });
      }
      if (url.pathname === "/api/v1/rooms/rom_mm/messages/4/attachment") {
        return new Response(bigBinBytes, {
          status: 200,
          headers: {
            "content-type": "application/octet-stream",
            "x-openhuddle-author-trust": "owner_command",
            "x-openhuddle-author-kind": "human",
          },
        });
      }
      if (url.pathname === "/api/v1/rooms/rom_mm/messages" && method === "POST") {
        lastSentBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        return jsonHttpResponse(201, {
          ok: true,
          message: { seq: 10, roomId: "rom_mm", content: lastSentBody.content },
          governance: { status: "active" },
          wokenAgentIds: [],
        });
      }
      return jsonHttpResponse(404, { ok: false });
    };

    const mcpServer = createOpenHuddleMcpServer({
      serverUrl: "https://huddle.example.com",
      agentToken: "oh_agt_mm_test",
      fetchImpl: mockFetch,
    });
    const mcpClient = new Client({ name: "mm-test", version: "0.1.0" });
    const [cTrans, sTrans] = InMemoryTransport.createLinkedPair();
    await Promise.all([mcpServer.connect(sTrans), mcpClient.connect(cTrans)]);

    try {
      const { tools } = await mcpClient.listTools();
      // Verify zero path/url parameters on attachment & message tools
      for (const tool of tools) {
        const schemaJson = JSON.stringify(tool.inputSchema);
        expect(schemaJson).not.toMatch(/"(?:filePath|outputPath|outPath|url)"/);
      }

      // PNG > maxBytes -> downscaled automatically to <= maxBytes, returning [text, image]
      const downscaledRes = await mcpClient.callTool({
        name: "openhuddle_get_attachment",
        arguments: { roomId: "rom_mm", seq: 1, maxBytes: 12_000 },
      });
      expect(downscaledRes.isError).toBeFalsy();
      const blocks = downscaledRes.content as Array<{
        type: string;
        text?: string;
        data?: string;
        mimeType?: string;
      }>;
      expect(blocks).toHaveLength(2);
      const meta1 = JSON.parse(blocks[0]?.text ?? "{}") as Record<string, unknown>;
      expect(meta1).toMatchObject({
        ok: true,
        roomId: "rom_mm",
        seq: 1,
        mimeType: "image/png",
        wasDownscaled: true,
        authorTrustLevel: "external_participant",
        authorKind: "human",
      });
      expect(Number(meta1.byteLength)).toBeLessThanOrEqual(12_000);
      expect(blocks[1]?.type).toBe("image");
      expect(Buffer.from(blocks[1]?.data ?? "", "base64").byteLength).toBe(
        Number(meta1.byteLength),
      );

      // Non-PNG exceeding maxBytes -> clear isError: true with maxBytes hint
      const jpegOverRes = await mcpClient.callTool({
        name: "openhuddle_get_attachment",
        arguments: { roomId: "rom_mm", seq: 2, maxBytes: 2_048 },
      });
      expect(jpegOverRes.isError).toBe(true);
      expect(extractFirstTextBlock(jpegOverRes)).toContain("maxBytes");

      // Non-image default -> metadata text only; includeNonImageBase64=true & <= 512 KiB -> [text, resource]; > 512 KiB -> [text] only
      const binMetaOnly = await mcpClient.callTool({
        name: "openhuddle_get_attachment",
        arguments: { roomId: "rom_mm", seq: 3 },
      });
      expect((binMetaOnly.content as unknown[]).length).toBe(1);

      const binWithResource = await mcpClient.callTool({
        name: "openhuddle_get_attachment",
        arguments: { roomId: "rom_mm", seq: 3, includeNonImageBase64: true },
      });
      expect((binWithResource.content as Array<{ type: string }>).map((b) => b.type)).toEqual([
        "text",
        "resource",
      ]);

      const bigBinNoResource = await mcpClient.callTool({
        name: "openhuddle_get_attachment",
        arguments: { roomId: "rom_mm", seq: 4, includeNonImageBase64: true },
      });
      expect((bigBinNoResource.content as unknown[]).length).toBe(1);

      // Send image attachment without content, stripping data: URL + newlines, and confirm get_attachment never advanced lastReadSeq!
      const tinyPngB64 =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aFzsAAAAASUVORK5CYII=";
      const sendImgRes = await mcpClient.callTool({
        name: "openhuddle_send_message",
        arguments: {
          roomId: "rom_mm",
          attachment: {
            mimeType: "image/png",
            fileName: "arch.png",
            data: `data:image/png;base64,\n${tinyPngB64.slice(0, -1)}\n`,
          },
        },
      });
      expect(sendImgRes.isError).toBeFalsy();
      expect(lastSentBody).toMatchObject({
        content: "",
        attachment: {
          mimeType: "image/png",
          fileName: "arch.png",
          data: tinyPngB64,
        },
      });
      expect(lastSentBody?.lastReadSeq).toBeUndefined();

      // Reject image/svg+xml
      const svgAttempt = await mcpClient.callTool({
        name: "openhuddle_send_message",
        arguments: {
          roomId: "rom_mm",
          attachment: {
            mimeType: "image/svg+xml" as "image/png",
            data: Buffer.from("<svg/>").toString("base64"),
          },
        },
      });
      expect(svgAttempt.isError).toBe(true);
    } finally {
      await mcpClient.close();
      await mcpServer.close();
    }
  });
});
