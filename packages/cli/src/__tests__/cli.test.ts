/**
 * @module cli/tests
 * @description OpenHuddle 单文件零依赖 CLI 完整单元测试与模拟服务端契约测试套件。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 全沙箱隔离：所有凭据读写、游标缓存与守护配置文件均落盘于临时目录（`mkdtempSync`），绝不触碰宿主机真实 `~/.openhuddle` 或系统 `launchctl`/`systemctl`。
 * 2. 跨平台全覆盖：在同一测试矩阵内对 macOS `launchd`、Linux `systemd --user` 与 Windows `schtasks` + PID 锁进行 100% 确定性断言。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MessageSeq, RoomId } from "@openhuddle/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type DaemonServiceSpec,
  type DaemonSystemDeps,
  RoomWakeQueue,
  type WakeEventPayload,
  buildLinuxSystemdUnit,
  buildMacLaunchdPlist,
  buildWakeProcessEnv,
  buildWakeShellCommand,
  buildWindowsSchtasksArgs,
  computeReconnectDelayMs,
  getDaemonPidFilePath,
  parseCliArgs,
  parseWakeEventFrame,
  readDaemonPidFile,
  readSseFrames,
  readStoredCredentials,
  runCli,
  startSseListener,
} from "../cli.js";

/**
 * 构造 JSON HTTP 模拟响应辅助函数。
 *
 * @param status - HTTP 状态码
 * @param body - 待序列化对象
 * @returns 标准 `Response` 实例
 */
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * 将多个文本块编码为 `ReadableStream<Uint8Array>` 以模拟分片 SSE 网络流。
 *
 * @param chunks - 模拟逐块到达的 UTF-8 文本数组
 * @returns 字节可读流
 */
function createChunkedSseStream(chunks: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index];
      if (chunk === undefined) {
        controller.close();
        return;
      }
      index += 1;
      controller.enqueue(encoder.encode(chunk));
    },
  });
}

const DEFAULT_GOVERNANCE_FIXTURE = {
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
};

describe("@openhuddle/cli — Zero-Dependency CLI & Cross-Platform SSE Daemon", () => {
  let tempHome = "";

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "openhuddle-cli-test-"));
  });

  afterEach(() => {
    if (tempHome.length > 0 && existsSync(tempHome)) {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  describe("parseCliArgs", () => {
    it("parses positional arguments, isolated --token-file, --server, and boolean flags", () => {
      const parsed = parseCliArgs(
        [
          "send",
          "rom_001",
          "Hello",
          "team!",
          "--server",
          "https://huddle.example.com/",
          "--token-file",
          "/tmp/codex.token",
          "--reply=7",
          "--ignore-unread",
          "--json",
        ],
        tempHome,
      );

      expect(parsed.command).toBe("send");
      expect(parsed.positionals).toEqual(["rom_001", "Hello", "team!"]);
      expect(parsed.serverUrl).toBe("https://huddle.example.com");
      expect(parsed.tokenFilePath).toBe("/tmp/codex.token");
      expect(parsed.hasExplicitTokenFile).toBe(true);
      expect(parsed.hasExplicitServerUrl).toBe(true);
      expect(parsed.json).toBe(true);
      expect(parsed.booleanFlags.has("--ignore-unread")).toBe(true);
      expect(parsed.flags.reply).toEqual(["7"]);
    });
  });

  describe("Token Store 0o600 Isolation & Collision Guard", () => {
    it("blocks overwriting default.token when GET /api/v1/me reports a DIFFERENT active agent and prints exact --token-file rerun command", async () => {
      const stdoutLines: string[] = [];
      const stderrLines: string[] = [];
      let pairEndpointCalledCount = 0;

      // 第 1 步：配对第一个 Agent（Pangyan Antigravity）写入默认路径
      const firstPairFetch: typeof fetch = async (input) => {
        const url = String(input);
        if (url.endsWith("/api/v1/pair")) {
          pairEndpointCalledCount += 1;
          return jsonResponse(200, {
            ok: true,
            token: "oh_agt_alpha_secret_token_111",
            agent: {
              id: "agt_alpha",
              ownerUserId: "usr_pangyan",
              displayName: "Pangyan Antigravity",
              slug: "pangyan-antigravity",
              platform: "antigravity",
              reach: "offline",
              createdAtIso: "2026-11-12T06:00:00.000Z",
            },
            owner: {
              id: "usr_pangyan",
              email: "pangyan@example.com",
              displayName: "Pangyan",
              createdAtIso: "2026-11-12T05:00:00.000Z",
            },
          });
        }
        throw new Error(`Unexpected URL: ${url}`);
      };

      const firstExit = await runCli(
        [
          "pair",
          "HUDDLE-1111",
          "--name",
          "Pangyan Antigravity",
          "--platform",
          "antigravity",
          "--server",
          "http://localhost:3100",
        ],
        {
          homeDir: tempHome,
          fetchImpl: firstPairFetch,
          stdout: (line) => stdoutLines.push(line),
          stderr: (line) => stderrLines.push(line),
        },
      );

      expect(firstExit).toBe(0);
      expect(pairEndpointCalledCount).toBe(1);

      const defaultTokenPath = join(tempHome, ".openhuddle", "tokens", "default.token");
      expect(existsSync(defaultTokenPath)).toBe(true);
      if (process.platform !== "win32") {
        const mode = statSync(defaultTokenPath).mode & 0o777;
        expect(mode).toBe(0o600);
      }

      // 第 2 步：未带 --token-file 配对第二个异构 Agent（Pangyan Codex），应被防撞卫士拦截且不消耗新配对码
      stderrLines.length = 0;
      const collisionFetch: typeof fetch = async (input, init) => {
        const url = String(input);
        if (url.endsWith("/api/v1/me")) {
          const authHeader = new Headers(init?.headers).get("Authorization");
          expect(authHeader).toBe("Bearer oh_agt_alpha_secret_token_111");
          return jsonResponse(200, {
            ok: true,
            callerKind: "agent",
            agent: {
              id: "agt_alpha",
              ownerUserId: "usr_pangyan",
              displayName: "Pangyan Antigravity",
              slug: "pangyan-antigravity",
              platform: "antigravity",
              reach: "online_sse",
              createdAtIso: "2026-11-12T06:00:00.000Z",
            },
            owner: {
              id: "usr_pangyan",
              email: "pangyan@example.com",
              displayName: "Pangyan",
              createdAtIso: "2026-11-12T05:00:00.000Z",
            },
            siblingAgents: [],
          });
        }
        if (url.endsWith("/api/v1/pair")) {
          pairEndpointCalledCount += 1;
          return jsonResponse(200, { ok: true });
        }
        throw new Error(`Unexpected URL: ${url}`);
      };

      const secondExit = await runCli(
        [
          "pair",
          "HUDDLE-2222",
          "--name",
          "Pangyan Codex",
          "--platform",
          "codex",
          "--server",
          "http://localhost:3100",
        ],
        {
          homeDir: tempHome,
          fetchImpl: collisionFetch,
          stdout: (line) => stdoutLines.push(line),
          stderr: (line) => stderrLines.push(line),
        },
      );

      expect(secondExit).toBe(1);
      // 关键不变量：防撞拦截发生在调用 POST /api/v1/pair 之前，一次性配对码 HUDDLE-2222 绝不被误核销
      expect(pairEndpointCalledCount).toBe(1);
      const errText = stderrLines.join("\n");
      expect(errText).toContain("Pangyan Antigravity");
      expect(errText).toContain("--token-file ~/.openhuddle/tokens/pangyan-codex.token");
      expect(readStoredCredentials(defaultTokenPath)?.token).toBe("oh_agt_alpha_secret_token_111");
    });

    it("allows overwriting default.token when existing token is revoked (401)", async () => {
      const defaultTokenPath = join(tempHome, ".openhuddle", "tokens", "default.token");
      let pairCalled = false;

      // 先植入一个旧 Token
      await runCli(["pair", "HUDDLE-OLD1", "--name", "Old Agent", "--platform", "custom"], {
        homeDir: tempHome,
        fetchImpl: async () =>
          jsonResponse(200, {
            ok: true,
            token: "oh_agt_revoked_000",
            agent: {
              id: "agt_old",
              ownerUserId: "usr_1",
              displayName: "Old Agent",
              slug: "old-agent",
              platform: "custom",
              reach: "offline",
              createdAtIso: "2026-11-12T06:00:00.000Z",
            },
            owner: {
              id: "usr_1",
              email: "u@example.com",
              displayName: "Owner",
              createdAtIso: "2026-11-12T06:00:00.000Z",
            },
          }),
        stdout: () => undefined,
        stderr: () => undefined,
      });

      const exitCode = await runCli(
        ["pair", "HUDDLE-NEW2", "--name", "Fresh Claude", "--platform", "claude_code"],
        {
          homeDir: tempHome,
          fetchImpl: async (input) => {
            const url = String(input);
            if (url.endsWith("/api/v1/me")) {
              return jsonResponse(401, {
                ok: false,
                error: {
                  code: "UNAUTHORIZED",
                  message: "Token revoked",
                  requestId: "req_401",
                },
              });
            }
            pairCalled = true;
            return jsonResponse(200, {
              ok: true,
              token: "oh_agt_fresh_claude_999",
              agent: {
                id: "agt_claude",
                ownerUserId: "usr_1",
                displayName: "Fresh Claude",
                slug: "fresh-claude",
                platform: "claude_code",
                reach: "offline",
                createdAtIso: "2026-11-12T06:05:00.000Z",
              },
              owner: {
                id: "usr_1",
                email: "u@example.com",
                displayName: "Owner",
                createdAtIso: "2026-11-12T06:00:00.000Z",
              },
            });
          },
          stdout: () => undefined,
          stderr: () => undefined,
        },
      );

      expect(exitCode).toBe(0);
      expect(pairCalled).toBe(true);
      expect(readStoredCredentials(defaultTokenPath)?.token).toBe("oh_agt_fresh_claude_999");
    });
  });

  describe("Read Cursor Persistence, Send Optimistic Lock & 409 Missed Messages Reporting", () => {
    it("automatically forwards cached lastReadSeq on send and prints missed messages clearly on 409 CONFLICT_UNREAD_MESSAGES", async () => {
      const tokenPath = join(tempHome, ".openhuddle", "tokens", "codex.token");
      const outLines: string[] = [];
      const errLines: string[] = [];
      let capturedSendBody: Record<string, unknown> | undefined;

      // 配对初始化独立凭据
      await runCli(
        [
          "pair",
          "HUDDLE-CODEX",
          "--name",
          "Codex Worker",
          "--platform",
          "codex",
          "--token-file",
          tokenPath,
          "--server",
          "http://localhost:3200",
        ],
        {
          homeDir: tempHome,
          fetchImpl: async () =>
            jsonResponse(200, {
              ok: true,
              token: "oh_agt_codex_worker",
              agent: {
                id: "agt_codex_1",
                ownerUserId: "usr_owner",
                displayName: "Codex Worker",
                slug: "codex-worker",
                platform: "codex",
                reach: "online_sse",
                createdAtIso: "2026-11-12T06:00:00.000Z",
              },
              owner: {
                id: "usr_owner",
                email: "owner@example.com",
                displayName: "Owner",
                createdAtIso: "2026-11-12T06:00:00.000Z",
              },
            }),
          stdout: () => undefined,
          stderr: () => undefined,
        },
      );

      // 执行 read rom_arch，推进本地 lastReadSeq 到 15
      const readCode = await runCli(["read", "rom_arch", "--token-file", tokenPath], {
        homeDir: tempHome,
        fetchImpl: async (input) => {
          expect(String(input)).toBe("http://localhost:3200/api/v1/rooms/rom_arch/messages");
          return jsonResponse(200, {
            ok: true,
            latestSeq: 15,
            governance: DEFAULT_GOVERNANCE_FIXTURE,
            messages: [
              {
                roomId: "rom_arch",
                seq: 15,
                type: "text",
                content: "Please evaluate the PGlite migration plan.",
                mentions: [],
                createdAtIso: "2026-11-12T06:10:00.000Z",
                author: {
                  kind: "human",
                  userId: "usr_owner",
                  ownerUserId: "usr_owner",
                  displayName: "Owner",
                  isYou: false,
                  isYourOwner: true,
                  trustLevel: "owner_command",
                },
              },
            ],
          });
        },
        stdout: (line) => outLines.push(line),
        stderr: (line) => errLines.push(line),
      });

      expect(readCode).toBe(0);
      expect(outLines.join("\n")).toContain("[#15] Owner (human, trust=owner_command)");

      // 执行 send rom_arch，验证自动附带 lastReadSeq: 15，并模拟并发命中 409 CONFLICT_UNREAD_MESSAGES
      errLines.length = 0;
      const sendConflictCode = await runCli(
        ["send", "rom_arch", "I recommend zero-downtime dual-write.", "--token-file", tokenPath],
        {
          homeDir: tempHome,
          fetchImpl: async (_input, init) => {
            capturedSendBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
            return jsonResponse(409, {
              ok: false,
              error: {
                code: "CONFLICT_UNREAD_MESSAGES",
                message: "New messages arrived in room before your send.",
                requestId: "req_conflict_16",
                details: {
                  latestSeq: 16,
                  yourLastReadSeq: 15,
                  missedMessages: [
                    {
                      roomId: "rom_arch",
                      seq: 16,
                      type: "text",
                      content: "Wait — single-node PGlite does not need dual-write!",
                      mentions: [],
                      createdAtIso: "2026-11-12T06:10:05.000Z",
                      author: {
                        kind: "agent",
                        agentId: "agt_sibling",
                        ownerUserId: "usr_owner",
                        displayName: "Antigravity Peer",
                        platform: "antigravity",
                        isYou: false,
                        isYourOwner: false,
                        trustLevel: "owner_sibling_agent",
                      },
                    },
                  ],
                },
              },
            });
          },
          stdout: (line) => outLines.push(line),
          stderr: (line) => errLines.push(line),
        },
      );

      expect(sendConflictCode).toBe(1);
      expect(capturedSendBody?.lastReadSeq).toBe(15);
      const conflictReport = errLines.join("\n");
      expect(conflictReport).toContain("CONFLICT_UNREAD_MESSAGES");
      expect(conflictReport).toContain("req_conflict_16");
      expect(conflictReport).toContain("[#16] Antigravity Peer");
      expect(conflictReport).toContain("Wait — single-node PGlite does not need dual-write!");
    });

    it("executes whoami, inbox, rooms, create, join, members, propose, and vote with --json mode", async () => {
      const tokenPath = join(tempHome, ".openhuddle", "tokens", "json-agent.token");
      await runCli(
        [
          "pair",
          "HUDDLE-JSON",
          "--name",
          "JSON Agent",
          "--platform",
          "antigravity",
          "--token-file",
          tokenPath,
          "--server",
          "http://localhost:3300",
        ],
        {
          homeDir: tempHome,
          fetchImpl: async () =>
            jsonResponse(200, {
              ok: true,
              token: "oh_agt_json_mode",
              agent: {
                id: "agt_json",
                ownerUserId: "usr_1",
                displayName: "JSON Agent",
                slug: "json-agent",
                platform: "antigravity",
                reach: "online_sse",
                createdAtIso: "2026-11-12T06:00:00.000Z",
              },
              owner: {
                id: "usr_1",
                email: "owner@example.com",
                displayName: "Owner",
                createdAtIso: "2026-11-12T06:00:00.000Z",
              },
            }),
          stdout: () => undefined,
          stderr: () => undefined,
        },
      );

      const capturedCalls: string[] = [];
      const mockApiFetch: typeof fetch = async (input, init) => {
        const method = init?.method ?? "GET";
        const url = new URL(String(input));
        capturedCalls.push(`${method} ${url.pathname}${url.search}`);

        if (url.pathname === "/api/v1/inbox") {
          return jsonResponse(200, {
            ok: true,
            totalUnreadMessages: 2,
            rooms: [],
            serverTimeIso: "2026-11-12T06:15:00.000Z",
          });
        }
        if (url.pathname === "/api/v1/rooms/rom_1/proposals" && method === "POST") {
          return jsonResponse(201, {
            ok: true,
            proposal: {
              id: "prp_001",
              roomId: "rom_1",
              originMessageSeq: 8,
              status: "open",
              draft: JSON.parse(String(init?.body ?? "{}")),
              votes: [],
              createdAtIso: "2026-11-12T06:15:00.000Z",
            },
          });
        }
        if (url.pathname === "/api/v1/proposals/prp_001/votes" && method === "POST") {
          return jsonResponse(200, {
            ok: true,
            proposal: {
              id: "prp_001",
              roomId: "rom_1",
              originMessageSeq: 8,
              status: "open",
              draft: {
                title: "Auth Strategy",
                contextSummary: "Compare tokens",
                options: [
                  {
                    optionKey: "sha256",
                    label: "SHA-256 Bearer",
                    summary: "Fast stateless hash",
                    pros: [],
                    cons: [],
                    risks: [],
                  },
                ],
              },
              votes: [
                {
                  voter: {
                    kind: "agent",
                    agentId: "agt_json",
                    ownerUserId: "usr_1",
                    displayName: "JSON Agent",
                    isYou: true,
                    isYourOwner: false,
                    trustLevel: "owner_sibling_agent",
                  },
                  stance: "endorse",
                  preferredOptionKey: "sha256",
                  rationale: "Zero JWT revocation lag.",
                  createdAtIso: "2026-11-12T06:16:00.000Z",
                },
              ],
              createdAtIso: "2026-11-12T06:15:00.000Z",
            },
          });
        }
        return jsonResponse(200, { ok: true });
      };

      const jsonOutputs: string[] = [];
      expect(
        await runCli(["inbox", "--wait", "5", "--json", "--token-file", tokenPath], {
          homeDir: tempHome,
          fetchImpl: mockApiFetch,
          stdout: (l) => jsonOutputs.push(l),
        }),
      ).toBe(0);

      expect(
        await runCli(
          [
            "propose",
            "rom_1",
            "--title",
            "Auth Strategy",
            "--summary",
            "Compare tokens",
            "--option",
            "sha256:SHA-256 Bearer:Fast stateless hash",
            "--json",
            "--token-file",
            tokenPath,
          ],
          {
            homeDir: tempHome,
            fetchImpl: mockApiFetch,
            stdout: (l) => jsonOutputs.push(l),
          },
        ),
      ).toBe(0);

      expect(
        await runCli(
          [
            "vote",
            "prp_001",
            "--stance",
            "endorse",
            "--option",
            "sha256",
            "--rationale",
            "Zero JWT revocation lag.",
            "--json",
            "--token-file",
            tokenPath,
          ],
          {
            homeDir: tempHome,
            fetchImpl: mockApiFetch,
            stdout: (l) => jsonOutputs.push(l),
          },
        ),
      ).toBe(0);

      expect(capturedCalls).toEqual([
        "GET /api/v1/inbox?waitSec=5",
        "POST /api/v1/rooms/rom_1/proposals",
        "POST /api/v1/proposals/prp_001/votes",
      ]);
      expect(jsonOutputs).toHaveLength(3);
    });
  });

  describe("SSE Stream Parser, Exponential Backoff & Per-Room Coalescing Serial Queue", () => {
    it("computes exponential backoff 1s -> 2s -> 4s -> 8s -> 16s -> capped 30s", () => {
      expect(computeReconnectDelayMs(0)).toBe(1_000);
      expect(computeReconnectDelayMs(1)).toBe(2_000);
      expect(computeReconnectDelayMs(2)).toBe(4_000);
      expect(computeReconnectDelayMs(3)).toBe(8_000);
      expect(computeReconnectDelayMs(4)).toBe(16_000);
      expect(computeReconnectDelayMs(5)).toBe(30_000);
      expect(computeReconnectDelayMs(9)).toBe(30_000);
    });

    it("parses chunk-split SSE frames with comments and CRLF boundaries", async () => {
      const stream = createChunkedSseStream([
        ": keep-alive\r\nevent: connected\r",
        '\ndata: {"type":"connected","connectionId":"c1"}\r\n\r\neve',
        'nt: wake\ndata: {"type":"wake","roomId":"rom_77",',
        '"latestSeq":42,"reason":"direct_mention"}\n\n',
      ]);

      const frames = [];
      for await (const frame of readSseFrames(stream)) {
        frames.push(frame);
      }

      expect(frames).toHaveLength(2);
      expect(frames[0]?.event).toBe("connected");
      const wake = frames[1] !== undefined ? parseWakeEventFrame(frames[1]) : undefined;
      expect(wake).toEqual({
        type: "wake",
        roomId: "rom_77",
        latestSeq: 42,
        reason: "direct_mention",
      });
    });

    it("serializes wakes per room, coalesces rapid pending latestSeq, preserves owner_command priority, and runs distinct rooms in parallel", async () => {
      const executionLog: Array<{
        readonly roomId: string;
        readonly seq: number;
        readonly reason: string;
      }> = [];
      let activeInRoomA = 0;
      let maxConcurrentInRoomA = 0;
      let releaseFirstRoomARun: (() => void) | undefined;

      const firstRoomARunGate = new Promise<void>((resolveGate) => {
        releaseFirstRoomARun = resolveGate;
      });

      const queue = new RoomWakeQueue(async (wake) => {
        if (wake.roomId === ("rom_A" as RoomId)) {
          activeInRoomA += 1;
          maxConcurrentInRoomA = Math.max(maxConcurrentInRoomA, activeInRoomA);
          executionLog.push({ roomId: wake.roomId, seq: wake.latestSeq, reason: wake.reason });
          if (wake.latestSeq === (10 as MessageSeq)) {
            await firstRoomARunGate;
          }
          activeInRoomA -= 1;
          return;
        }

        // rom_B 应不受 rom_A 挂起影响立即并行完成
        executionLog.push({ roomId: wake.roomId, seq: wake.latestSeq, reason: wake.reason });
      });

      const makeWake = (
        roomId: string,
        latestSeq: number,
        reason: WakeEventPayload["reason"],
      ): WakeEventPayload => ({
        type: "wake",
        roomId: roomId as RoomId,
        latestSeq: latestSeq as MessageSeq,
        reason,
      });

      queue.enqueue(makeWake("rom_A", 10, "direct_mention"));
      // 在 rom_A(#10) 仍在执行期间连续涌入 #11, #12(owner_command), #13(reply_to_you)
      queue.enqueue(makeWake("rom_A", 11, "reply_to_you"));
      queue.enqueue(makeWake("rom_A", 12, "owner_command"));
      queue.enqueue(makeWake("rom_A", 13, "reply_to_you"));
      // 同时推入另一房间 rom_B(#5)
      queue.enqueue(makeWake("rom_B", 5, "round_table_turn"));

      await Promise.resolve();
      // 此时 rom_B(#5) 已执行，而 rom_A 仅启动了 #10
      expect(executionLog).toContainEqual({
        roomId: "rom_B",
        seq: 5,
        reason: "round_table_turn",
      });

      releaseFirstRoomARun?.();
      await queue.drain();

      expect(maxConcurrentInRoomA).toBe(1);
      const roomARuns = executionLog.filter((item) => item.roomId === "rom_A");
      // 4 次连续唤醒被精确合并为 2 次串行执行：#10 与合并后的 #13（且保留了 #12 的 owner_command 最高优先级！）
      expect(roomARuns).toEqual([
        { roomId: "rom_A", seq: 10, reason: "direct_mention" },
        { roomId: "rom_A", seq: 13, reason: "owner_command" },
      ]);
    });

    it("reconnects with backoff on SSE drop and builds standard OPENHUDDLE_* wake env & agent preset templates", async () => {
      const controller = new AbortController();
      const recordedDelays: number[] = [];
      const wokenEvents: WakeEventPayload[] = [];
      let connectionCount = 0;

      await startSseListener({
        serverUrl: "http://localhost:3400",
        token: "oh_agt_listener_token",
        tokenFilePath: "/tmp/listener.token",
        target: { kind: "preset", preset: "antigravity" },
        signal: controller.signal,
        sleepImpl: async (delayMs) => {
          recordedDelays.push(delayMs);
        },
        fetchImpl: async () => {
          connectionCount += 1;
          if (connectionCount === 1) {
            throw new Error("ECONNRESET simulated");
          }
          return new Response(
            createChunkedSseStream([
              'event: wake\ndata: {"type":"wake","roomId":"rom_live","latestSeq":99,"reason":"proposal_vote_requested"}\n\n',
            ]),
            { status: 200, headers: { "Content-Type": "text/event-stream" } },
          );
        },
        onWake: async (wake) => {
          wokenEvents.push(wake);
          controller.abort();
        },
        onLog: () => undefined,
      });

      expect(connectionCount).toBe(2);
      expect(recordedDelays).toEqual([1_000]);
      expect(wokenEvents).toHaveLength(1);
      expect(wokenEvents[0]?.latestSeq).toBe(99);

      const envVars = buildWakeProcessEnv(
        wokenEvents[0] as WakeEventPayload,
        "/tmp/listener.token",
        "http://localhost:3400/",
      );
      expect(envVars).toEqual({
        OPENHUDDLE_ROOM_ID: "rom_live",
        OPENHUDDLE_LATEST_SEQ: "99",
        OPENHUDDLE_WAKE_REASON: "proposal_vote_requested",
        OPENHUDDLE_TOKEN_FILE: "/tmp/listener.token",
        OPENHUDDLE_URL: "http://localhost:3400",
      });

      expect(buildWakeShellCommand({ kind: "preset", preset: "antigravity" })).toContain("agy");
      expect(buildWakeShellCommand({ kind: "preset", preset: "codex" })).toContain("codex exec");
      expect(buildWakeShellCommand({ kind: "preset", preset: "claude_code" })).toContain(
        "claude -p",
      );
      expect(buildWakeShellCommand({ kind: "custom", command: "./my-hook.sh" })).toBe(
        "./my-hook.sh",
      );
    });
  });

  describe("Cross-Platform Daemon Config Generators & Service Controllers (macOS / Linux / Windows)", () => {
    const sampleSpec: DaemonServiceSpec = {
      slug: "pangyan-codex",
      nodeBinaryPath: "/usr/local/bin/node",
      cliScriptPath: "/Users/pangyan/.openhuddle/openhuddle.mjs",
      serverUrl: "https://huddle.internal",
      tokenFilePath: "/Users/pangyan/.openhuddle/tokens/pangyan-codex.token",
      target: { kind: "preset", preset: "codex" },
      homeDir: "/Users/pangyan",
    };

    it("generates valid macOS launchd plist with KeepAlive, RunAtLoad, and log paths", () => {
      const plist = buildMacLaunchdPlist(sampleSpec);
      expect(plist).toContain("<string>dev.openhuddle.listen.pangyan-codex</string>");
      expect(plist).toContain("<key>RunAtLoad</key>");
      expect(plist).toContain("<key>KeepAlive</key>");
      expect(plist).toContain("listen-pangyan-codex.out.log");
      expect(plist).toContain("<string>codex</string>");
    });

    it("generates valid Linux systemd user service unit with Restart=always and % escaping", () => {
      const unit = buildLinuxSystemdUnit({
        ...sampleSpec,
        target: { kind: "custom", command: 'echo "100% ready"' },
      });
      expect(unit).toContain("Description=OpenHuddle SSE Wake Listener (pangyan-codex)");
      expect(unit).toContain("Restart=always");
      expect(unit).toContain("ExecStart=/usr/local/bin/node");
      expect(unit).toContain('"echo \\"100%% ready\\""');
      expect(unit).toContain("WantedBy=default.target");
    });

    it("generates Windows schtasks ONLOGON arguments and manages hidden detached PID lockfile lifecycle", async () => {
      const winSpec: DaemonServiceSpec = {
        slug: "win-claude",
        nodeBinaryPath: "C:\\Program Files\\nodejs\\node.exe",
        cliScriptPath: "C:\\Users\\dev\\.openhuddle\\openhuddle.mjs",
        serverUrl: "https://huddle.internal",
        tokenFilePath: "C:\\Users\\dev\\.openhuddle\\tokens\\win-claude.token",
        target: { kind: "preset", preset: "claude_code" },
        homeDir: tempHome,
      };

      const schtasksArgs = buildWindowsSchtasksArgs(winSpec);
      expect(schtasksArgs.slice(0, 5)).toEqual([
        "/Create",
        "/SC",
        "ONLOGON",
        "/TN",
        "OpenHuddle\\Listen-win-claude",
      ]);
      expect(schtasksArgs[6]).toContain('"C:\\Program Files\\nodejs\\node.exe"');
      expect(schtasksArgs[6]).toContain("spawn-detached");
      expect(schtasksArgs[7]).toBe("/F");

      // 在当前宿主机上完整演练 Windows install -> status -> stop 守护生命周期与 PID 锁管理
      const winTokenPath = join(tempHome, ".openhuddle", "tokens", "win-claude.token");
      await runCli(
        [
          "pair",
          "HUDDLE-WIN",
          "--name",
          "Win Claude",
          "--platform",
          "claude_code",
          "--token-file",
          winTokenPath,
        ],
        {
          homeDir: tempHome,
          fetchImpl: async () =>
            jsonResponse(200, {
              ok: true,
              token: "oh_agt_win_token",
              agent: {
                id: "agt_win",
                ownerUserId: "usr_win",
                displayName: "Win Claude",
                slug: "win-claude",
                platform: "claude_code",
                reach: "offline",
                createdAtIso: "2026-11-12T06:00:00.000Z",
              },
              owner: {
                id: "usr_win",
                email: "win@example.com",
                displayName: "Win Owner",
                createdAtIso: "2026-11-12T06:00:00.000Z",
              },
            }),
          stdout: () => undefined,
          stderr: () => undefined,
        },
      );

      const alivePids = new Set<number>();
      const executedCommands: Array<{ readonly cmd: string; readonly args: readonly string[] }> =
        [];
      const mockWinDeps: DaemonSystemDeps = {
        platform: "win32",
        execSyncCommand(cmd, args) {
          executedCommands.push({ cmd, args });
          return { exitCode: 0, stdout: "SUCCESS", stderr: "" };
        },
        spawnDetachedProcess() {
          const fakePid = 42_888;
          alivePids.add(fakePid);
          return fakePid;
        },
        isPidAlive(pid) {
          return alivePids.has(pid);
        },
        terminatePid(pid) {
          return alivePids.delete(pid);
        },
      };

      const statusOutputs: string[] = [];
      expect(
        await runCli(
          ["listen", "install", "--agent", "claude_code", "--token-file", winTokenPath, "--json"],
          {
            homeDir: tempHome,
            daemonDeps: mockWinDeps,
            stdout: (l) => statusOutputs.push(l),
          },
        ),
      ).toBe(0);

      const pidFile = getDaemonPidFilePath(tempHome, "win-claude");
      expect(readDaemonPidFile(pidFile)).toBe(42_888);
      expect(readFileSync(pidFile, "utf8").trim()).toBe("42888");

      expect(
        await runCli(["listen", "status", "--token-file", winTokenPath, "--json"], {
          homeDir: tempHome,
          daemonDeps: mockWinDeps,
          stdout: (l) => statusOutputs.push(l),
        }),
      ).toBe(0);
      expect(JSON.parse(statusOutputs[1] ?? "{}")).toMatchObject({
        ok: true,
        running: true,
        pid: 42_888,
      });

      expect(
        await runCli(["listen", "stop", "--token-file", winTokenPath, "--json"], {
          homeDir: tempHome,
          daemonDeps: mockWinDeps,
          stdout: (l) => statusOutputs.push(l),
        }),
      ).toBe(0);
      expect(existsSync(pidFile)).toBe(false);
      expect(alivePids.has(42_888)).toBe(false);
      expect(executedCommands.some((c) => c.cmd === "schtasks" && c.args[0] === "/Delete")).toBe(
        true,
      );
    });

    it("executes macOS launchctl and Linux systemctl --user daemon install/status/stop lifecycles", async () => {
      const macTokenPath = join(tempHome, ".openhuddle", "tokens", "mac-agy.token");
      await runCli(
        [
          "pair",
          "HUDDLE-MAC",
          "--name",
          "Mac Agy",
          "--platform",
          "antigravity",
          "--token-file",
          macTokenPath,
        ],
        {
          homeDir: tempHome,
          fetchImpl: async () =>
            jsonResponse(200, {
              ok: true,
              token: "oh_agt_mac_token",
              agent: {
                id: "agt_mac",
                ownerUserId: "usr_mac",
                displayName: "Mac Agy",
                slug: "mac-agy",
                platform: "antigravity",
                reach: "offline",
                createdAtIso: "2026-11-12T06:00:00.000Z",
              },
              owner: {
                id: "usr_mac",
                email: "mac@example.com",
                displayName: "Mac Owner",
                createdAtIso: "2026-11-12T06:00:00.000Z",
              },
            }),
          stdout: () => undefined,
          stderr: () => undefined,
        },
      );

      const macCalls: string[] = [];
      const mockMacDeps: DaemonSystemDeps = {
        platform: "darwin",
        execSyncCommand(cmd, args) {
          macCalls.push(`${cmd} ${args.join(" ")}`);
          return { exitCode: 0, stdout: "loaded", stderr: "" };
        },
        spawnDetachedProcess: () => 1001,
        isPidAlive: () => true,
        terminatePid: () => true,
      };

      expect(
        await runCli(["listen", "install", "--agent", "agy", "--token-file", macTokenPath], {
          homeDir: tempHome,
          daemonDeps: mockMacDeps,
          stdout: () => undefined,
        }),
      ).toBe(0);
      expect(
        await runCli(["listen", "status", "--token-file", macTokenPath], {
          homeDir: tempHome,
          daemonDeps: mockMacDeps,
          stdout: () => undefined,
        }),
      ).toBe(0);
      expect(
        await runCli(["listen", "stop", "--token-file", macTokenPath], {
          homeDir: tempHome,
          daemonDeps: mockMacDeps,
          stdout: () => undefined,
        }),
      ).toBe(0);
      expect(macCalls.some((c) => c.startsWith("launchctl load -w "))).toBe(true);
      expect(macCalls.some((c) => c.startsWith("launchctl list dev.openhuddle.listen."))).toBe(
        true,
      );
      expect(macCalls.some((c) => c.startsWith("launchctl unload -w "))).toBe(true);

      const linuxCalls: string[] = [];
      const mockLinuxDeps: DaemonSystemDeps = {
        platform: "linux",
        execSyncCommand(cmd, args) {
          linuxCalls.push(`${cmd} ${args.join(" ")}`);
          return { exitCode: 0, stdout: "active", stderr: "" };
        },
        spawnDetachedProcess: () => 1002,
        isPidAlive: () => true,
        terminatePid: () => true,
      };

      expect(
        await runCli(["listen", "install", "--run", "./wake.sh", "--token-file", macTokenPath], {
          homeDir: tempHome,
          daemonDeps: mockLinuxDeps,
          stdout: () => undefined,
        }),
      ).toBe(0);
      expect(
        await runCli(["listen", "status", "--token-file", macTokenPath], {
          homeDir: tempHome,
          daemonDeps: mockLinuxDeps,
          stdout: () => undefined,
        }),
      ).toBe(0);
      expect(
        await runCli(["listen", "stop", "--token-file", macTokenPath], {
          homeDir: tempHome,
          daemonDeps: mockLinuxDeps,
          stdout: () => undefined,
        }),
      ).toBe(0);
      expect(linuxCalls).toContain("systemctl --user daemon-reload");
      expect(linuxCalls).toContain(
        "systemctl --user enable --now openhuddle-listen-mac-agy.service",
      );
      expect(linuxCalls).toContain("systemctl --user is-active openhuddle-listen-mac-agy.service");
      expect(linuxCalls).toContain(
        "systemctl --user disable --now openhuddle-listen-mac-agy.service",
      );
    });
  });
});
