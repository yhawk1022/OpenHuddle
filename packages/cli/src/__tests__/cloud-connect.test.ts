/**
 * @module cli/tests/cloud-connect
 * @description 云端/容器环境敏捷接入（`connect`、活跃身份记忆、`reply` 默认房间、守护降级链、内置 MCP stdio）测试套件。
 *
 * 关键不变量：
 * 1. 云端沙箱无本地预设二进制时 `connect` 绝不启动守护、仍保留 token 并返回 `listenerMode=on_demand_cli`。
 * 2. Linux 容器无 `systemd --user` 时自动降级为脱离后台 Worker。
 * 3. MCP stdio 帧流与 `@openhuddle/mcp` 工具名同构，`stdout` 仅输出 JSON-RPC 行。
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type DaemonSystemDeps,
  getDaemonPidFilePath,
  installDaemonService,
  readActiveCliProfile,
  runCli,
} from "../cli.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const PAIR_RESPONSE = {
  ok: true,
  token: "oh_agt_cloud_token",
  autoJoinedRoomId: "rom_cloud",
  agent: {
    id: "agt_cloud",
    ownerUserId: "usr_cloud",
    displayName: "Cloud Codex",
    slug: "cloud-codex",
    platform: "codex",
    reach: "offline",
    createdAtIso: "2026-11-23T06:00:00.000Z",
  },
  owner: {
    id: "usr_cloud",
    email: "cloud@example.com",
    displayName: "Cloud Owner",
    createdAtIso: "2026-11-23T05:00:00.000Z",
  },
};

const GOVERNANCE = {
  status: "active",
  consecutiveAgentTurns: 0,
  roundTableNextAgentIndex: 0,
  config: {
    mode: "free",
    maxConsecutiveAgentTurns: 6,
    agentCooldownMs: 0,
    requireReadBeforeSend: true,
    allowAgentMentions: true,
  },
};

function sentMessage(seq: number, content: string): Record<string, unknown> {
  return {
    ok: true,
    message: {
      roomId: "rom_cloud",
      seq,
      type: "text",
      content,
      mentions: [],
      createdAtIso: "2026-11-23T06:00:01.000Z",
      author: {
        kind: "agent",
        agentId: "agt_cloud",
        ownerUserId: "usr_cloud",
        displayName: "Cloud Codex",
        isYou: true,
        isYourOwner: false,
        trustLevel: "owner_sibling_agent",
      },
    },
    governance: GOVERNANCE,
    wokenAgentIds: [],
  };
}

describe("@openhuddle/cli — cloud & container agile connect", () => {
  let tempHome = "";

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "openhuddle-cloud-test-"));
  });

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
  });

  it("runs the bundled CLI through an aliased installation directory", () => {
    const bundleDir = fileURLToPath(new URL("../../../../apps/server/public/", import.meta.url));
    const installedDir = join(tempHome, "cli-install");
    symlinkSync(bundleDir, installedDir, "junction");

    const output = execFileSync(
      process.execPath,
      [join(installedDir, "openhuddle.mjs"), "--help"],
      {
        encoding: "utf8",
      },
    );

    expect(output).toContain("Usage: openhuddle <command> [options]");
  });

  it("connect from a cloud sandbox without local preset binary keeps token, skips daemon, remembers room, and enables zero-arg reply", async () => {
    const calls: string[] = [];
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const method = init?.method ?? "GET";
      const url = new URL(String(input));
      calls.push(`${method} ${url.origin}${url.pathname}`);
      if (url.pathname === "/api/v1/pair") {
        return jsonResponse(201, PAIR_RESPONSE);
      }
      if (url.pathname === "/api/v1/rooms/rom_cloud/messages" && method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        bodies.push(body);
        return jsonResponse(201, sentMessage(10 + bodies.length, String(body.content ?? "")));
      }
      return jsonResponse(404, { ok: false });
    };

    const out: string[] = [];
    const exitCode = await runCli(
      [
        "connect",
        "https://huddle.example.com/?code=HUDDLE-ABCD-1234",
        "--platform",
        "codex",
        "--name",
        "Cloud Codex",
        "--json",
      ],
      {
        homeDir: tempHome,
        fetchImpl,
        hasPresetBinary: () => false,
        stdout: (l) => out.push(l),
        stderr: () => undefined,
      },
    );

    expect(exitCode).toBe(0);
    const report = JSON.parse(out.join("\n")) as Record<string, unknown>;
    expect(report.listenerMode).toBe("on_demand_cli");
    expect(report.serverUrl).toBe("https://huddle.example.com");
    expect(calls[0]).toBe("POST https://huddle.example.com/api/v1/pair");
    expect(String(bodies[0]?.content)).toContain("已连入群聊就绪");

    const profile = readActiveCliProfile(tempHome);
    expect(profile?.defaultRoomId).toBe("rom_cloud");
    expect(profile?.tokenFilePath).toBe(
      join(tempHome, ".openhuddle", "tokens", "cloud-codex.token"),
    );

    // reply 无需 --server / --token-file / roomId
    const replyOut: string[] = [];
    const replyExit = await runCli(["reply", "LGTM", "from", "cloud"], {
      homeDir: tempHome,
      fetchImpl,
      stdout: (l) => replyOut.push(l),
      stderr: () => undefined,
    });
    expect(replyExit).toBe(0);
    expect(bodies[1]?.content).toBe("LGTM from cloud");
    expect(bodies[1]?.lastReadSeq).toBe(11);
    expect(replyOut.join("\n")).toContain("Sent message #12 to rom_cloud");
  });

  it("falls back to a detached background worker when systemd --user is unavailable in Linux containers", () => {
    const spawned: string[][] = [];
    const deps: DaemonSystemDeps = {
      platform: "linux",
      execSyncCommand: () => ({ exitCode: 1, stdout: "", stderr: "Failed to connect to bus" }),
      spawnDetachedProcess: (_node, args) => {
        spawned.push([...args]);
        return 4242;
      },
      isPidAlive: () => false,
      terminatePid: () => true,
    };
    const report = installDaemonService(
      {
        slug: "container-agent",
        nodeBinaryPath: "/usr/bin/node",
        cliScriptPath: join(tempHome, "openhuddle.mjs"),
        serverUrl: "https://huddle.example.com",
        tokenFilePath: join(tempHome, "t.token"),
        target: { kind: "custom", command: "./wake.sh" },
        homeDir: tempHome,
        envVars: {},
        envPath: "/usr/bin:/bin",
      },
      deps,
    );
    expect(report.mode).toBe("detached");
    expect(report.pid).toBe(4242);
    expect(spawned[0]).toContain("listen");
    expect(readFileSync(getDaemonPidFilePath(tempHome, "container-agent"), "utf8").trim()).toBe(
      "4242",
    );
  });

  it("serves built-in zero-dependency MCP stdio initialize, tools/list and tools/call", async () => {
    const tokenFile = join(tempHome, ".openhuddle", "tokens", "mcp.token");
    await runCli(
      [
        "pair",
        "HUDDLE-MCP",
        "--name",
        "Cloud Codex",
        "--platform",
        "codex",
        "--token-file",
        tokenFile,
      ],
      {
        homeDir: tempHome,
        fetchImpl: async () => jsonResponse(201, PAIR_RESPONSE),
        stdout: () => undefined,
        stderr: () => undefined,
      },
    );
    expect(existsSync(tokenFile)).toBe(true);

    async function* frames(): AsyncGenerator<string> {
      yield `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`;
      yield `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`;
      yield `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`;
      yield `${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "openhuddle_list_rooms", arguments: {} } })}\n`;
    }

    const lines: string[] = [];
    const exit = await runCli(["mcp", "--token-file", tokenFile], {
      homeDir: tempHome,
      fetchImpl: async (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/api/v1/rooms") {
          return jsonResponse(200, { ok: true, rooms: [] });
        }
        return jsonResponse(404, { ok: false });
      },
      mcpInputStream: frames(),
      stdout: (l) => lines.push(l),
      stderr: () => undefined,
    });

    expect(exit).toBe(0);
    expect(lines).toHaveLength(3);
    const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect((parsed[0]?.result as { serverInfo: { name: string } }).serverInfo.name).toBe(
      "@openhuddle/mcp",
    );
    const tools = (parsed[1]?.result as { tools: { name: string }[] }).tools.map((t) => t.name);
    expect(tools).toContain("openhuddle_send_message");
    expect(tools).toHaveLength(8);
    const callResult = parsed[2]?.result as { isError?: boolean; content: { text: string }[] };
    expect(callResult.isError).toBeUndefined();
    expect(callResult.content[0]?.text).toContain('"rooms": []');
  });
});
