/**
 * @module cli/tests/listener-identity
 * @description 验证同一宿主中的同名 Agent 使用独立 Token 和监听服务，卸载操作按凭据归属执行。
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { runCli } from "../cli.js";
import { type DaemonSystemDeps, getMacPlistPath } from "../daemon-manager.js";

it("isolates listeners for same-name Agents and preserves credentials while an instance is offline", async () => {
  const homeDir = mkdtempSync(join(tmpdir(), "openhuddle-listener-identity-"));
  const daemonDeps: DaemonSystemDeps = {
    platform: "darwin",
    execSyncCommand: () => ({ exitCode: 0, stdout: "", stderr: "" }),
    spawnDetachedProcess: () => 1000,
    isPidAlive: () => false,
    terminatePid: () => true,
  };
  const owner = {
    id: "usr_owner",
    displayName: "Owner",
    email: "owner@example.com",
    createdAtIso: new Date(0).toISOString(),
  };
  const name = "Shared Codex";
  const slug = "shared-codex";
  const agent = (id: string) => ({
    id,
    ownerUserId: owner.id,
    displayName: name,
    slug,
    platform: "codex",
    reach: "offline",
    createdAtIso: owner.createdAtIso,
  });
  const context = {
    homeDir,
    daemonDeps,
    hasPresetBinary: () => true,
    stdout: () => undefined,
    stderr: () => undefined,
  };
  const tokenDir = join(homeDir, ".openhuddle", "tokens");
  let secondId = "agt_second_owner";
  const connect = (server: string, pairId: string) =>
    runCli(
      [
        "connect",
        "HUDDLE-AAAA-BBBB",
        "--name",
        name,
        "--platform",
        "codex",
        "--server",
        `http://${server}`,
        "--no-greet",
      ],
      {
        ...context,
        fetchImpl: async (input) => {
          const url = new URL(String(input));
          expect(url.host).toBe(server);
          if (url.pathname === "/api/v1/me") {
            if (pairId === secondId)
              return Response.json({
                ok: true,
                callerKind: "agent",
                agent: agent("agt_first_owner"),
                owner,
                siblingAgents: [],
              });
            throw new Error("Old server unavailable");
          }
          expect(url.pathname).toBe("/api/v1/pair");
          return Response.json(
            { ok: true, agent: agent(pairId), owner, token: `oh_agt_fixture_${pairId}` },
            { status: 201 },
          );
        },
      },
    );

  try {
    vi.stubEnv("OPENHUDDLE_HOME", undefined);
    expect(await connect("localhost:3100", "agt_first_owner")).toBe(0);
    const firstPlist = getMacPlistPath(homeDir, slug);
    const firstConfig = readFileSync(firstPlist, "utf8");

    // 同服务允许不同主人使用同一 slug。配对响应属于第二个 Agent 时保留旧文件。
    expect(await connect("localhost:3100", secondId)).toBe(0);
    const secondTokenPath = join(tokenDir, `${slug}-2.token`);
    expect(readFileSync(getMacPlistPath(homeDir, `${slug}-2`), "utf8")).toContain(secondTokenPath);

    // 对已有另一个实例的同名凭据，甚至无须探测旧实例就可分配独立文件。
    secondId = "agt_unused";
    expect(await connect("localhost:3200", "agt_other_server")).toBe(0);
    expect(readFileSync(getMacPlistPath(homeDir, `${slug}-3`), "utf8")).toContain(
      "http://localhost:3200",
    );

    // 凭据状态未知时也不能把网络故障误当成吊销。
    expect(await connect("localhost:3100", "agt_unavailable_server_probe")).toBe(0);
    expect(readFileSync(getMacPlistPath(homeDir, `${slug}-4`), "utf8")).toContain(
      `${slug}-4.token`,
    );
    expect(readFileSync(firstPlist, "utf8")).toBe(firstConfig);
    expect(readFileSync(join(tokenDir, `${slug}.token`), "utf8")).toContain(
      "oh_agt_fixture_agt_first_owner",
    );

    expect(await runCli(["listen", "stop", "--token-file", secondTokenPath], context)).toBe(0);
    expect(readFileSync(firstPlist, "utf8")).toBe(firstConfig);
    expect(() => readFileSync(getMacPlistPath(homeDir, `${slug}-2`))).toThrow();
  } finally {
    vi.unstubAllEnvs();
    rmSync(homeDir, { force: true, recursive: true });
  }
});
