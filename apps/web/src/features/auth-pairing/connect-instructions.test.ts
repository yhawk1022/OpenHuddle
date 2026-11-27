/**
 * @module web/features/auth-pairing/connect-instructions.test
 * @description 验证接入目标身份与执行器独立，中英双语提示词与各平台协议锚点、CLI 执行不变量保持一致。
 */
import { execFileSync } from "node:child_process";
import {
  AgentPlatformSchema,
  OwnedAgentSummaryDtoSchema,
  type SupportedLocale,
} from "@openhuddle/protocol";
import { describe, expect, it } from "vitest";
import { withLocale } from "../../lib/i18n/index.js";
import {
  buildAgentConnectInstructions,
  buildAgentMcpConfigs,
  defaultAgentReplyMode,
  findNewAgentMatchingInstructions,
  resolveAgentConnectEndpoint,
} from "./connect-instructions.js";

const connection = {
  connectUrl: "https://huddle.example.com/connect#example-token",
  serverUrl: "https://huddle.example.com",
  name: "O'Brien's Agent",
  platform: "custom",
  isLoopback: false,
} as const;

describe("Agent connection instructions", () => {
  it.each(["zh-CN", "en"] as const)(
    "uses the current session by default for a platform without a native runner (%s)",
    (locale: SupportedLocale) => {
      const replyMode = defaultAgentReplyMode(connection.platform);
      const { posix, powerShell, prompt } = buildAgentConnectInstructions({
        ...connection,
        replyMode,
        runnerLabel: undefined,
        locale,
      });

      expect(replyMode).toBe("on_demand");
      expect(posix).toContain("--platform custom --no-listen");
      expect(powerShell).toContain("--platform custom --no-listen");
      expect(prompt).toContain("/api/v1/mcp");
      expect(prompt).toContain("/api/v1/rooms/{roomId}/messages");
      expect(prompt).toContain("openhuddle attachment <seq> --room <roomId>");
      expect(prompt).toContain("openhuddle_get_attachment");
      expect(prompt).toContain("GET /api/v1/rooms/{roomId}/messages/{seq}/attachment");
      expect(prompt).toContain('openhuddle reply "..." --image <path>');
      expect(prompt).toContain("openhuddle_send_message");
      expect(prompt).toContain('author.trustLevel === "owner_command"');
      expect(prompt).not.toContain("Realtime listener connected.");
      if (locale === "zh-CN") {
        expect(prompt).toContain("按需读写消息");
      } else {
        expect(prompt).toContain("Read and send messages on demand");
        expect(/\p{Script=Han}/u.test(prompt)).toBe(false);
      }
    },
  );

  it("selects a different execution engine without changing the Agent platform (zh-CN & en)", () => {
    const zh = buildAgentConnectInstructions({
      ...connection,
      replyMode: "deepseek",
      runnerLabel: "DeepSeek",
      roomName: "接入测试",
      locale: "zh-CN",
    });

    expect(defaultAgentReplyMode("deepseek")).toBe("deepseek");
    expect(zh.posix).toContain(
      "--name 'O'\\''Brien'\\''s Agent' --platform custom --agent deepseek",
    );
    expect(zh.powerShell).toContain(
      "--name 'O''Brien''s Agent' --platform custom --agent deepseek",
    );
    expect(zh.prompt).toContain("加入「接入测试」");
    expect(zh.prompt).toContain("Realtime listener connected.");
    expect(zh.prompt).toContain("若监听未启动，保留凭据并报告原因");
    expect(zh.prompt.indexOf(zh.posix)).toBeLessThan(zh.prompt.indexOf("POST"));

    const en = buildAgentConnectInstructions({
      ...connection,
      replyMode: "deepseek",
      runnerLabel: "DeepSeek",
      roomName: "Integration Test",
      locale: "en",
    });

    // CLI commands and HTTP payload must remain byte-for-byte identical across locales
    expect(en.posix).toBe(zh.posix);
    expect(en.powerShell).toBe(zh.powerShell);
    expect(en.http).toBe(zh.http);
    expect(en.installers).toEqual(zh.installers);
    expect(en.prompt).toContain('join "Integration Test"');
    expect(en.prompt).toContain("Realtime listener connected.");
    expect(en.prompt).toContain('author.trustLevel === "owner_command"');
    expect(en.prompt).toContain("keep the saved credentials and report the reason");
    expect(en.prompt.indexOf(en.posix)).toBeLessThan(en.prompt.indexOf("POST"));
    expect(/\p{Script=Han}/u.test(en.prompt)).toBe(false);
  });

  it.each(AgentPlatformSchema.options)(
    "offers a tool-only route for %s in both zh-CN and en",
    (platform) => {
      for (const locale of ["zh-CN", "en"] as const) {
        const { posix, powerShell, http, prompt } = buildAgentConnectInstructions({
          ...connection,
          platform,
          replyMode: "on_demand",
          runnerLabel: undefined,
          locale,
        });
        expect(posix).toContain(`--platform ${platform} --no-listen`);
        expect(powerShell).toContain(`--platform ${platform} --no-listen`);
        expect(http).toContain(`"platform":"${platform}"`);
        expect(prompt.indexOf(http)).toBeLessThan(prompt.indexOf(posix));
        expect(prompt).toContain(posix);
        expect(prompt).toContain('"connectionToken":"example-token"');
        expect(prompt).not.toMatch(
          /curl|install\.(sh|ps1)|Invoke-WebRequest|ExecutionPolicy|Bypass/,
        );
      }
    },
  );

  it("falls back to the active global locale when locale parameter is omitted", () => {
    const zhPrompt = withLocale(
      "zh-CN",
      () =>
        buildAgentConnectInstructions({
          ...connection,
          replyMode: "on_demand",
          runnerLabel: undefined,
        }).prompt,
    );
    const enPrompt = withLocale(
      "en",
      () =>
        buildAgentConnectInstructions({
          ...connection,
          replyMode: "on_demand",
          runnerLabel: undefined,
        }).prompt,
    );

    expect(zhPrompt).toContain("请将你接入我的 OpenHuddle 账号");
    expect(enPrompt).toContain("Please connect yourself to my OpenHuddle account");
    expect(/\p{Script=Han}/u.test(enPrompt)).toBe(false);
  });

  it("uses a reachable public origin for the connection link, installer, and HTTP redemption", () => {
    const endpoint = resolveAgentConnectEndpoint(
      "http://localhost:3000/connect#example-token",
      connection.serverUrl,
    );
    expect(endpoint).toEqual({
      connectUrl: connection.connectUrl,
      serverUrl: connection.serverUrl,
      isLoopback: false,
    });
    const instructions = buildAgentConnectInstructions({
      ...endpoint,
      name: connection.name,
      platform: "cursor",
      replyMode: "on_demand",
      runnerLabel: undefined,
    });
    expect(instructions.posix).toContain(connection.connectUrl);
    expect(instructions.installers[0]?.download).toContain(`${connection.serverUrl}/install.sh`);
    expect(instructions.posix).not.toContain("localhost");
    expect(instructions.http).toContain(
      `POST ${connection.serverUrl}/api/v1/agent-connections/redeem`,
    );
    expect(instructions.http).toContain('"connectionToken":"example-token"');
    expect(
      resolveAgentConnectEndpoint(
        "http://localhost:3000/connect#example-token",
        "http://localhost:5173",
      ),
    ).toEqual({
      connectUrl: "http://localhost:3000/connect#example-token",
      serverUrl: "http://localhost:3000",
      isLoopback: true,
    });
  });

  it("provides a separate explicit download and execution path on both platforms", () => {
    const { installers } = buildAgentConnectInstructions({
      ...connection,
      replyMode: "on_demand",
      runnerLabel: undefined,
    });
    const [posix, windows] = installers;
    expect(posix?.download).toContain(`${connection.serverUrl}/install.sh`);
    expect(posix?.download).not.toContain("| sh");
    expect(posix?.download).not.toContain("example-token");
    expect(posix?.connect).toContain(
      `sh "$openhuddle_installer" connect '${connection.connectUrl}'`,
    );
    expect(windows?.download).toContain(`${connection.serverUrl}/install.ps1`);
    expect(windows?.download).not.toContain("example-token");
    expect(windows?.connect).toContain(
      `& $OpenHuddleInstaller -ConnectUrl '${connection.connectUrl}'`,
    );
    expect(windows?.connect).toContain("-NoListen");
    expect(windows?.connect).not.toMatch(/ExecutionPolicy|Bypass/);
  });

  it.skipIf(process.platform === "win32")(
    "passes the signed URL and selected mode to the downloaded POSIX installer",
    () => {
      for (const locale of ["zh-CN", "en"] as const) {
        const { installers } = buildAgentConnectInstructions({
          ...connection,
          replyMode: "deepseek",
          runnerLabel: "DeepSeek",
          locale,
        });
        const posix = installers[0];
        if (posix === undefined) {
          throw new Error("Missing POSIX installer instructions");
        }
        const shell = [
          'trap \'[ -z "$openhuddle_installer" ] || rm -f "$openhuddle_installer"\' EXIT',
          'curl() { while [ "$1" != "-o" ]; do shift; done; printf \'%s\\n\' \'printf "%s\\n" "$@"\' > "$2"; }',
          posix.download,
          posix.connect,
        ].join("\n");
        const result = execFileSync("/bin/sh", ["-ec", shell], { encoding: "utf8" });
        expect(result.trimEnd().split("\n").slice(1)).toEqual([
          "connect",
          connection.connectUrl,
          "--name",
          connection.name,
          "--platform",
          connection.platform,
          "--agent",
          "deepseek",
        ]);
      }
    },
  );

  it("does not guess the MCP process or token path in zh-CN and en", () => {
    const zhConfigs = buildAgentMcpConfigs(connection.serverUrl, "zh-CN");
    expect(JSON.parse(zhConfigs.stdio)).toMatchObject({
      mcpServers: {
        openhuddle: {
          command: "<Node.js 可执行文件的绝对路径>",
          args: [
            "<实际 openhuddle.mjs 文件的绝对路径>",
            "mcp",
            "--server",
            connection.serverUrl,
            "--token-file",
            "<本次连接保存的令牌文件绝对路径>",
          ],
          env: { OPENHUDDLE_HOME: "<实际 OpenHuddle 安装目录的绝对路径>" },
        },
      },
    });
    expect(zhConfigs.stdio).not.toContain("~/.openhuddle");
    expect(zhConfigs.remote).toContain(`${connection.serverUrl}/api/v1/mcp`);
    expect(JSON.parse(zhConfigs.remote)).toMatchObject({
      mcpServers: {
        openhuddle: {
          url: `${connection.serverUrl}/api/v1/mcp`,
          headers: { Authorization: "Bearer <兑换返回的 token>" },
        },
      },
    });

    const enConfigs = withLocale("en", () => buildAgentMcpConfigs(connection.serverUrl));
    expect(JSON.parse(enConfigs.stdio)).toMatchObject({
      mcpServers: {
        openhuddle: {
          command: "<absolute path to the Node.js executable>",
          args: [
            "<absolute path to openhuddle.mjs>",
            "mcp",
            "--server",
            connection.serverUrl,
            "--token-file",
            "<absolute path to the saved token file for this connection>",
          ],
          env: {
            OPENHUDDLE_HOME: "<absolute path to your OpenHuddle installation directory>",
          },
        },
      },
    });
    expect(JSON.parse(enConfigs.remote)).toMatchObject({
      mcpServers: {
        openhuddle: {
          url: `${connection.serverUrl}/api/v1/mcp`,
          headers: { Authorization: "Bearer <token returned by redeem>" },
        },
      },
    });
    expect(enConfigs.stdio).not.toContain("~/.openhuddle");
    expect(/\p{Script=Han}/u.test(enConfigs.stdio)).toBe(false);
    expect(/\p{Script=Han}/u.test(enConfigs.remote)).toBe(false);
  });

  it("reports only a unique new account identity matching the copied name and platform", () => {
    const agent = OwnedAgentSummaryDtoSchema.parse({
      id: "agt_new",
      ownerUserId: "usr_test",
      displayName: connection.name,
      slug: "agent-name",
      platform: "custom",
      reach: "polling",
      createdAtIso: "2026-11-23T12:00:00.000Z",
    });
    const unrelated = OwnedAgentSummaryDtoSchema.parse({
      ...agent,
      id: "agt_other",
      platform: "codex",
    });
    const identity = { name: connection.name, platform: connection.platform };
    expect(findNewAgentMatchingInstructions([unrelated], new Set(), identity)).toBeNull();
    expect(findNewAgentMatchingInstructions([unrelated, agent], new Set(), identity)).toBe(agent);
    expect(findNewAgentMatchingInstructions([agent], new Set([agent.id]), identity)).toBeNull();
    expect(
      findNewAgentMatchingInstructions(
        [agent, { ...unrelated, platform: "custom" }],
        new Set(),
        identity,
      ),
    ).toBeNull();
  });
});
