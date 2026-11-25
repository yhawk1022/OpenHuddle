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
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type DaemonSystemDeps,
  buildLinuxSystemdUnit,
  buildWindowsSchtasksArgs,
  collectInheritedDaemonEnvVars,
  getDaemonPidFilePath,
  getDaemonServiceStatus,
  installDaemonService,
  isPresetCliBinaryAvailable,
  parseWakeAgentPreset,
  readActiveCliProfile,
  runCli,
  startSseListener,
  stopDaemonService,
} from "../cli.js";
import { getMacPlistPath } from "../daemon-manager.js";
import { resolveWindowsNodeShimEntry } from "../host-env.js";

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
    vi.stubEnv("OPENHUDDLE_HOME", undefined);
    vi.stubEnv("OPENHUDDLE_ROOM_ID", undefined);
    vi.stubEnv("OPENHUDDLE_TOKEN_FILE", undefined);
    vi.stubEnv("OPENHUDDLE_URL", undefined);
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
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(201, PAIR_RESPONSE))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          ok: true,
          callerKind: "agent",
          agent: PAIR_RESPONSE.agent,
          owner: PAIR_RESPONSE.owner,
          siblingAgents: [],
        }),
      );
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

    vi.stubEnv("OPENHUDDLE_URL", "https://stale-config.example.com");
    expect(
      await runCli(["whoami", "--json"], { homeDir: tempHome, fetchImpl, stdout: () => undefined }),
    ).toBe(0);
    const [url, request] = fetchImpl.mock.lastCall ?? [];
    expect(url).toBe("https://huddle.example.com/api/v1/me");
    expect(new Headers(request?.headers).get("authorization")).toBe(
      `Bearer ${PAIR_RESPONSE.token}`,
    );
  });

  it("checks local state before spending a single-use connection link", async () => {
    const stateDir = join(tempHome, "OpenHuddle state");
    vi.stubEnv("OPENHUDDLE_HOME", stateDir);
    mkdirSync(join(stateDir, "active-profile.json"), { recursive: true });
    const fetchImpl = vi.fn<typeof fetch>();
    const output: string[] = [];

    const exitCode = await runCli(
      ["connect", `https://huddle.example.com/connect#oh_connect_na_${"a".repeat(43)}`, "--json"],
      { homeDir: tempHome, fetchImpl, stdout: (line) => output.push(line) },
    );

    expect(exitCode).toBe(1);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(JSON.parse(output.join("\n"))).toMatchObject({
      ok: false,
      error: { code: "CLI_ERROR", message: expect.stringContaining("active-profile.json") },
    });
  });

  it("reconnects the same Agent without forgetting its default room or credential path", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(201, PAIR_RESPONSE))
      .mockResolvedValueOnce(jsonResponse(201, sentMessage(1, "Room arrival")))
      .mockResolvedValueOnce(
        jsonResponse(201, {
          ...PAIR_RESPONSE,
          autoJoinedRoomId: undefined,
          agent: { ...PAIR_RESPONSE.agent, displayName: "Renamed Cloud Agent" },
          token: "oh_agt_cloud_rotated",
        }),
      )
      .mockResolvedValueOnce(jsonResponse(201, sentMessage(2, "Still in the same room")));
    const output: string[] = [];
    const context = { homeDir: tempHome, fetchImpl, stdout: (line: string) => output.push(line) };

    expect(
      await runCli(
        [
          "connect",
          `https://huddle.example.com/connect#oh_connect_ng_${"a".repeat(43)}`,
          "--name",
          "Cloud Codex",
          "--no-listen",
          "--json",
        ],
        context,
      ),
    ).toBe(0);
    const original = readActiveCliProfile(tempHome);

    expect(
      await runCli(
        [
          "connect",
          `https://huddle.example.com/connect#oh_connect_ra_${"b".repeat(43)}`,
          "--name",
          "Renamed Cloud Agent",
          "--no-greet",
          "--no-listen",
          "--json",
        ],
        context,
      ),
    ).toBe(0);
    expect(readActiveCliProfile(tempHome)).toMatchObject({
      agentId: original?.agentId,
      tokenFilePath: original?.tokenFilePath,
      defaultRoomId: "rom_cloud",
    });

    expect(await runCli(["reply", "Still in the same room"], context)).toBe(0);
    const [url, request] = fetchImpl.mock.lastCall ?? [];
    expect(url).toBe("https://huddle.example.com/api/v1/rooms/rom_cloud/messages");
    expect(new Headers(request?.headers).get("authorization")).toBe("Bearer oh_agt_cloud_rotated");
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("connect from a cloud sandbox without local preset binary keeps token, skips daemon, remembers room, and enables zero-arg reply", async () => {
    const stateDir = join(tempHome, "OpenHuddle state");
    vi.stubEnv("OPENHUDDLE_HOME", stateDir);
    const hasPresetBinary = vi.fn(() => false);
    const calls: string[] = [];
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const method = init?.method ?? "GET";
      const url = new URL(String(input));
      calls.push(`${method} ${url.origin}${url.pathname}`);
      if (url.pathname === "/api/v1/pair") {
        return jsonResponse(201, {
          ...PAIR_RESPONSE,
          agent: { ...PAIR_RESPONSE.agent, platform: "custom" },
        });
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
        "custom",
        "--agent",
        "codex",
        "--name",
        "Cloud Codex",
        "--json",
      ],
      {
        homeDir: tempHome,
        fetchImpl,
        hasPresetBinary,
        stdout: (l) => out.push(l),
        stderr: () => undefined,
      },
    );

    expect(exitCode).toBe(0);
    const report = JSON.parse(out.join("\n")) as Record<string, unknown>;
    expect(report.listenerMode).toBe("on_demand_cli");
    expect(report.note).toContain('no local "codex" binary found');
    expect(hasPresetBinary).toHaveBeenCalledWith("codex");
    expect(report.serverUrl).toBe("https://huddle.example.com");
    expect(calls[0]).toBe("POST https://huddle.example.com/api/v1/pair");
    expect(String(bodies[0]?.content)).toBe("大家好，我是 Cloud Codex，已加入群聊。");

    const profile = readActiveCliProfile(tempHome);
    expect(profile?.defaultRoomId).toBe("rom_cloud");
    expect(profile?.tokenFilePath).toBe(join(stateDir, "tokens", "cloud-codex.token"));
    expect(existsSync(join(stateDir, "active-profile.json"))).toBe(true);
    expect(existsSync(join(stateDir, "cursors", "agt_cloud.json"))).toBe(true);
    expect(existsSync(join(tempHome, ".openhuddle"))).toBe(false);

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

  it("uses the configured state directory in generated services and detached lifecycle operations", () => {
    const stateDir = join(tempHome, "sandbox state");
    vi.stubEnv("OPENHUDDLE_HOME", stateDir);
    const spec = {
      slug: "sandbox-agent",
      nodeBinaryPath: "/usr/bin/node",
      cliScriptPath: join(stateDir, "openhuddle.mjs"),
      serverUrl: "https://huddle.example.com",
      tokenFilePath: join(stateDir, "tokens", "sandbox-agent.token"),
      target: { kind: "preset", preset: "codex" } as const,
      homeDir: tempHome,
      envVars: {},
      envPath: "/usr/bin:/bin",
    };
    const execSyncCommand = vi.fn(() => ({ exitCode: 1, stdout: "", stderr: "unavailable" }));
    const spawnDetachedProcess = vi.fn<DaemonSystemDeps["spawnDetachedProcess"]>(() => 4242);
    const terminatePid = vi.fn(() => true);
    const deps: DaemonSystemDeps = {
      platform: "darwin",
      execSyncCommand,
      spawnDetachedProcess,
      isPidAlive: () => true,
      terminatePid,
    };

    const install = installDaemonService(spec, deps);
    const configPath = getMacPlistPath(tempHome, spec.slug);
    const stdoutPath = join(stateDir, "logs", "listen-sandbox-agent.out.log");
    const pidFilePath = join(stateDir, "run", "sandbox-agent.pid");
    expect(install).toMatchObject({ mode: "detached", configFilePath: configPath, pidFilePath });
    expect(readFileSync(configPath, "utf8")).toContain(`<string>${stdoutPath}</string>`);
    expect(readFileSync(configPath, "utf8")).toContain(
      `<key>OPENHUDDLE_HOME</key>\n      <string>${stateDir}</string>`,
    );
    expect(buildLinuxSystemdUnit({ ...spec, stateDir: "/sandbox state" })).toContain(
      'Environment="OPENHUDDLE_HOME=/sandbox state"',
    );
    expect(buildWindowsSchtasksArgs({ ...spec, stateDir })[6]).toContain(
      `--state-dir "${stateDir}"`,
    );
    expect(spawnDetachedProcess.mock.calls[0]?.[2]).toMatchObject({
      stdoutPath,
      env: { OPENHUDDLE_HOME: stateDir },
    });

    const params = { slug: spec.slug, homeDir: tempHome };
    expect(getDaemonServiceStatus(params, deps)).toMatchObject({ running: true, pid: 4242 });
    expect(stopDaemonService(params, deps)).toMatchObject({
      running: false,
      logOutPath: stdoutPath,
    });
    expect(terminatePid).toHaveBeenCalledWith(4242);
    expect(existsSync(pidFilePath)).toBe(false);
    expect(existsSync(join(tempHome, ".openhuddle"))).toBe(false);

    // 沙箱看得到宿主 HOME，但不能在其中创建 LaunchAgents；已配置的状态根仍可用。
    rmSync(join(tempHome, "Library"), { recursive: true });
    writeFileSync(join(tempHome, "Library"), "unavailable");
    expect(installDaemonService(spec, deps)).toMatchObject({ mode: "detached", pidFilePath });
    expect(execSyncCommand).toHaveBeenCalledTimes(4);
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

  it.each(["%dp0%\\", "%~dp0"])(
    "resolves the Windows Node shim form %s without a shell",
    (prefix) => {
      const bin = join(tempHome, "fake node package");
      const entry = join(bin, "cli.mjs");
      const shim = join(tempHome, "gemini.cmd");
      mkdirSync(bin);
      writeFileSync(entry, "// executable entry fixture\n");
      writeFileSync(shim, `@ECHO off\r\n"%_prog%"  "${prefix}fake node package\\cli.mjs" %*\r\n`);

      expect(resolveWindowsNodeShimEntry(shim)).toBe(entry);
      expect(resolveWindowsNodeShimEntry(entry)).toBeUndefined();
      rmSync(entry);
      expect(resolveWindowsNodeShimEntry(shim)).toBeUndefined();
    },
  );

  it.skipIf(process.platform === "win32").each([
    [
      "codex",
      "codex",
      [
        '[ "$1" = exec ] || exit 1',
        'while [ "$#" -gt 0 ] && [ "$1" != -o ]; do shift; done',
        '[ "$#" -eq 3 ] && [ "$3" = - ] || exit 1',
        'case "$(/bin/cat)" in *"Private transcript fragment"*) printf "%s" "Runner reply" > "$2";; *) exit 2;; esac',
      ],
    ],
    [
      "claude_code",
      "claude",
      [
        '[ "$1" = -p ] && [ "$6" = none ] || exit 1',
        '[ -z "${CLAUDECODE:-}" ] || exit 1',
        'case "$(/bin/cat)" in *"Private transcript fragment"*) printf "%s" "Runner reply";; *) exit 2;; esac',
      ],
    ],
    [
      "antigravity",
      "agy",
      [
        '[ "$1" = --output-format ] && [ "$8" = --print ] || exit 1',
        'case "$9" in *"Private transcript fragment"*) printf "%s" "Runner reply";; *) exit 2;; esac',
      ],
    ],
    [
      "gemini",
      "gemini",
      [
        '[ "$1" = -p ] && [ "$3" = -o ] && [ "$4" = text ] || exit 1',
        'case "$(/bin/cat)" in *"Private transcript fragment"*) printf "%s" "Runner reply";; *) exit 2;; esac',
      ],
    ],
    [
      "deepseek",
      "dsh",
      [
        '[ "$#" -eq 2 ] && [ "$1" = --profile ] && [ "$2" = headless ] || exit 1',
        'case "$(/bin/cat)" in *"Private transcript fragment"*) printf "%s" "Runner reply";; *) exit 2;; esac',
      ],
    ],
  ] as const)(
    "launches the %s preset with a fixture executable and replies as the registered Agent",
    async (preset, binary, scriptLines) => {
      writeFileSync(join(tempHome, binary), ["#!/bin/sh", ...scriptLines].join("\n"), {
        mode: 0o700,
      });
      vi.stubEnv("PATH", `${tempHome}:${process.env.PATH ?? ""}`);
      expect(isPresetCliBinaryAvailable(preset, tempHome, tempHome)).toBe(true);

      const agent = { ...PAIR_RESPONSE.agent, slug: "cloud-custom", platform: "custom" };
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
        tokenFilePath: join(tempHome, "custom.token"),
        homeDir: tempHome,
        target: { kind: "preset", preset },
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
                return jsonResponse(201, sentMessage(2, "Runner reply"));
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
          body: expect.objectContaining({ content: "Runner reply", replyToSeq: 1 }),
        },
      ]);
    },
  );

  it.skipIf(process.platform === "win32")(
    "launches a custom runner with its wake context and credential path",
    async () => {
      const scriptPath = join(tempHome, "custom runner.sh");
      const tokenPath = join(tempHome, "tokens", "custom.token");
      writeFileSync(
        scriptPath,
        [
          "#!/bin/sh",
          'printf "%s\\n" "$OPENHUDDLE_ROOM_ID" "$OPENHUDDLE_LATEST_SEQ" "$OPENHUDDLE_WAKE_REASON" "$OPENHUDDLE_TOKEN_FILE" "$OPENHUDDLE_URL" > "$0.context"',
        ].join("\n"),
      );
      const fetchImpl = vi.fn<typeof fetch>(
        async () =>
          new Response(
            'event: wake\ndata: {"type":"wake","roomId":"rom_cloud","latestSeq":7,"reason":"direct_mention"}\n\n',
          ),
      );

      await startSseListener({
        serverUrl: "https://huddle.example.com",
        token: PAIR_RESPONSE.token,
        tokenFilePath: tokenPath,
        target: { kind: "custom", command: `/bin/sh ${JSON.stringify(scriptPath)}` },
        catchUpInboxOnConnect: false,
        maxReconnectAttempts: 0,
        fetchImpl,
        onLog: () => undefined,
      });

      expect(readFileSync(`${scriptPath}.context`, "utf8").trim().split("\n")).toEqual([
        "rom_cloud",
        "7",
        "direct_mention",
        tokenPath,
        "https://huddle.example.com",
      ]);
      expect(fetchImpl).toHaveBeenCalledExactlyOnceWith(
        "https://huddle.example.com/api/v1/events",
        expect.any(Object),
      );
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
