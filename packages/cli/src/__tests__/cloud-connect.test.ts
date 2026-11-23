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
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type DaemonSystemDeps,
  collectInheritedDaemonEnvVars,
  getDaemonPidFilePath,
  installDaemonService,
  isPresetCliBinaryAvailable,
  parseWakeAgentPreset,
  readActiveCliProfile,
  runCli,
  startSseListener,
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

function sentMessage(seq: number, content: string) {
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
    vi.unstubAllEnvs();
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

  it("redeems a connection link at its issuer and remembers the joined room", async () => {
    const connectionToken = `oh_connect_ng_${"a".repeat(43)}`;
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(201, PAIR_RESPONSE));
    const out: string[] = [];
    const exitCode = await runCli(
      [
        "connect",
        `https://huddle.example.com/connect#${connectionToken}`,
        "--server",
        "https://stale-config.example.com",
        "--name",
        "Cloud Codex",
        "--platform",
        "codex",
        "--no-listen",
        "--no-greet",
        "--json",
      ],
      { homeDir: tempHome, fetchImpl, stdout: (line) => out.push(line) },
    );
    expect(exitCode).toBe(0);
    expect(fetchImpl).toHaveBeenCalledExactlyOnceWith(
      "https://huddle.example.com/api/v1/agent-connections/redeem",
      expect.objectContaining({
        method: "POST",
        redirect: "error",
        body: JSON.stringify({ name: "Cloud Codex", platform: "codex", connectionToken }),
      }),
    );
    expect(out.join("\n")).not.toContain(connectionToken);
    expect(JSON.parse(out.join("\n"))).toMatchObject({ autoJoinedRoomId: "rom_cloud" });
    expect(readActiveCliProfile(tempHome)).toMatchObject({
      defaultRoomId: "rom_cloud",
      serverUrl: "https://huddle.example.com",
    });
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

  it.each([true, false])(
    "starts the macOS listener with no joined room and reports confirmed=%s without rebinding",
    async (confirmed) => {
      const connectionToken = `oh_connect_na_${"a".repeat(43)}`;
      let meRequests = 0;
      const fetchImpl = vi.fn<typeof fetch>(async (input) => {
        if (String(input).endsWith("/api/v1/agent-connections/redeem")) {
          return jsonResponse(201, { ...PAIR_RESPONSE, autoJoinedRoomId: undefined });
        }
        meRequests += 1;
        if (confirmed && meRequests === 1) {
          return jsonResponse(503, { ok: false });
        }
        return confirmed
          ? jsonResponse(200, {
              ok: true,
              callerKind: "agent",
              agent: { ...PAIR_RESPONSE.agent, reach: "online_sse" },
              owner: PAIR_RESPONSE.owner,
              siblingAgents: [],
            })
          : jsonResponse(401, { ok: false });
      });
      const execSyncCommand = vi.fn(() => ({ exitCode: 0, stdout: "", stderr: "" }));
      const daemonDeps: DaemonSystemDeps = {
        platform: "darwin",
        execSyncCommand,
        spawnDetachedProcess: () => undefined,
        isPidAlive: () => false,
        terminatePid: () => true,
      };
      const out: string[] = [];
      const exitCode = await runCli(
        [
          "connect",
          `https://huddle.example.com/connect#${connectionToken}`,
          "--name",
          "Cloud Codex",
          "--platform",
          "codex",
          "--json",
        ],
        {
          homeDir: tempHome,
          fetchImpl,
          daemonDeps,
          hasPresetBinary: () => true,
          stdout: (line) => out.push(line),
        },
      );

      expect(exitCode).toBe(0);
      const report: unknown = JSON.parse(out.join("\n"));
      expect(report).toMatchObject({
        ok: true,
        listenerMode: "daemon",
        listenerConnected: confirmed,
        agent: { reach: confirmed ? "online_sse" : "offline" },
      });
      expect(report).not.toHaveProperty("autoJoinedRoomId");
      expect(report).not.toHaveProperty("greetedMessageSeq");
      expect(fetchImpl.mock.calls.map(([input]) => new URL(String(input)).pathname)).toEqual([
        "/api/v1/agent-connections/redeem",
        "/api/v1/me",
        ...(confirmed ? ["/api/v1/me"] : []),
      ]);
      expect(execSyncCommand).toHaveBeenCalledWith("launchctl", [
        "load",
        "-w",
        expect.stringContaining("LaunchAgents"),
      ]);
      expect(readActiveCliProfile(tempHome)?.defaultRoomId).toBeUndefined();
    },
  );

  it.each(["codex", "claude_code", "gemini", "antigravity", "deepseek"] as const)(
    "reconnects the %s listener when a stream stops sending events",
    async (preset) => {
      const stop = new AbortController();
      let cancelled = false;
      const stalledStream = new ReadableStream<Uint8Array>({
        cancel() {
          cancelled = true;
        },
      });
      const wake = { type: "wake", roomId: "rom_cloud", latestSeq: 7, reason: "owner_command" };
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response(stalledStream))
        .mockResolvedValueOnce(new Response(`event: wake\ndata: ${JSON.stringify(wake)}\n\n`));
      const onWake = vi.fn(async () => {
        stop.abort();
      });
      await startSseListener({
        serverUrl: "https://huddle.example.com",
        token: PAIR_RESPONSE.token,
        tokenFilePath: join(tempHome, "agent.token"),
        target: { kind: "preset", preset },
        signal: stop.signal,
        idleTimeoutMs: 15,
        maxReconnectAttempts: 1,
        fetchImpl,
        onWake,
        sleepImpl: async () => undefined,
      });

      expect(cancelled).toBe(true);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(onWake).toHaveBeenCalledWith(wake);
    },
  );

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

  it("inherits DeepSeek Harness configuration only for the matching daemon", () => {
    const env = { DSH_HOME: "/tmp/dsh", DEEPSEEK_API_KEY: "test-key" };
    expect(parseWakeAgentPreset("dsh")).toBe("deepseek");
    expect(
      collectInheritedDaemonEnvVars(tempHome, env, { kind: "preset", preset: "deepseek" }),
    ).toEqual(env);
    expect(
      collectInheritedDaemonEnvVars(tempHome, env, { kind: "preset", preset: "codex" }),
    ).toEqual({});
  });

  it.skipIf(process.platform === "win32")(
    "runs a DeepSeek wake turn with the transcript on stdin and posts under its own token",
    async () => {
      writeFileSync(
        join(tempHome, "dsh"),
        [
          "#!/bin/sh",
          '[ "$#" -eq 2 ] && [ "$1" = --profile ] && [ "$2" = headless ] || exit 1',
          'case "$(/bin/cat)" in *"Private transcript fragment"*) printf "%s" "DeepSeek reply";; *) exit 2;; esac',
        ].join("\n"),
        { mode: 0o700 },
      );
      vi.stubEnv("PATH", `${tempHome}:${process.env.PATH ?? ""}`);
      expect(isPresetCliBinaryAvailable("deepseek", tempHome, tempHome)).toBe(true);

      const agent = { ...PAIR_RESPONSE.agent, slug: "cloud-deepseek", platform: "deepseek" };
      const ownerMessage = {
        ...sentMessage(1, "Private transcript fragment").message,
        author: {
          kind: "human",
          userId: PAIR_RESPONSE.owner.id,
          displayName: PAIR_RESPONSE.owner.displayName,
          isYou: false,
          isYourOwner: true,
          trustLevel: "owner_command",
        },
      };
      const posts: { authorization: string | null; body: unknown }[] = [];

      await startSseListener({
        serverUrl: "https://huddle.example.com",
        token: PAIR_RESPONSE.token,
        tokenFilePath: join(tempHome, "deepseek.token"),
        homeDir: tempHome,
        target: { kind: "preset", preset: "deepseek" },
        catchUpInboxOnConnect: false,
        maxReconnectAttempts: 0,
        onLog: () => undefined,
        fetchImpl: async (input, init) => {
          const { pathname } = new URL(String(input));
          switch (pathname) {
            case "/api/v1/events":
              return new Response(
                'event: wake\ndata: {"type":"wake","roomId":"rom_cloud","latestSeq":1,"reason":"owner_command"}\n\n',
              );
            case "/api/v1/me":
              return jsonResponse(200, { ...PAIR_RESPONSE, callerKind: "agent", agent });
            case "/api/v1/rooms/rom_cloud":
              return jsonResponse(200, {
                ok: true,
                room: {
                  id: "rom_cloud",
                  name: "Cloud",
                  topic: "",
                  rules: "",
                  members: [],
                  lastSeq: 1,
                },
              });
            case "/api/v1/rooms/rom_cloud/messages":
              if (init?.method === "POST") {
                posts.push({
                  authorization: new Headers(init.headers).get("authorization"),
                  body: JSON.parse(String(init.body)),
                });
                return jsonResponse(201, sentMessage(2, "DeepSeek reply"));
              }
              return jsonResponse(200, {
                ok: true,
                messages: [ownerMessage],
                latestSeq: 1,
                governance: GOVERNANCE,
              });
            default:
              return jsonResponse(404, { ok: false });
          }
        },
      });

      expect(posts).toEqual([
        {
          authorization: `Bearer ${PAIR_RESPONSE.token}`,
          body: expect.objectContaining({ content: "DeepSeek reply", replyToSeq: 1 }),
        },
      ]);
    },
  );

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
