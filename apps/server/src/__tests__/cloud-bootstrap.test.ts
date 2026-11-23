/**
 * @module server/tests/cloud-bootstrap
 * @description 全环境安装器（`/install.sh`、`/install.ps1`）、动态公网根地址推导与远程 MCP 鉴权边界测试。
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ManagedDatabase, createDatabaseClient, ensureCoreSchema } from "@openhuddle/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServerApp } from "../app.js";
import { parseServerEnv } from "../infra/env.js";
import { resolveEffectivePublicBaseUrl } from "../infra/public-url.js";
import { InMemoryRealtimeBus } from "../infra/realtime-bus.js";
import { renderInstallShellScript } from "../modules/pairing/bootstrap-docs.routes.js";

describe("@openhuddle/server — universal installer & cloud access", () => {
  let database: ManagedDatabase;
  let bus: InMemoryRealtimeBus;

  beforeEach(async () => {
    database = createDatabaseClient({ url: "memory://" });
    await ensureCoreSchema(database.db);
    bus = new InMemoryRealtimeBus();
  });

  afterEach(async () => {
    await bus.close();
    await database.close();
  });

  it("derives public base URL from forwarded headers only when configured URL is loopback, rejecting malicious hosts", () => {
    const req = (headers: Record<string, string>) =>
      new Request("http://localhost/install.sh", { headers });
    expect(
      resolveEffectivePublicBaseUrl(
        "http://localhost",
        req({ host: "cyanarch.com", "x-forwarded-proto": "https" }),
      ),
    ).toBe("https://cyanarch.com");
    expect(
      resolveEffectivePublicBaseUrl("https://huddle.example.com", req({ host: "evil.com" })),
    ).toBe("https://huddle.example.com");
    expect(
      resolveEffectivePublicBaseUrl("http://localhost:3000", req({ host: "evil.com;rm -rf /" })),
    ).toBe("http://localhost:3000");
    expect(
      resolveEffectivePublicBaseUrl("http://localhost:3000", req({ host: "localhost:5173" })),
    ).toBe("http://localhost:3000");
  });

  it("serves /install.sh with node + posix fallback, safe preset quoting, and /install.ps1", async () => {
    const env = parseServerEnv({
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      PUBLIC_BASE_URL: "https://huddle.example.com",
      DATABASE_URL: "memory://",
    });
    const app = createServerApp({ env, database, realtimeBus: bus });

    const shRes = await app.request(
      "/install.sh?code=HUDDLE-AB12-CD34&name=O'Brien%20Bot&platform=codex",
    );
    expect(shRes.status).toBe(200);
    const sh = await shRes.text();
    expect(sh.startsWith("#!/bin/sh")).toBe(true);
    expect(sh).toContain("BASE_URL='https://huddle.example.com'");
    expect(sh).toContain("/openhuddle.mjs");
    expect(sh).toContain("posix-sh-fallback");
    expect(sh).toContain(`connect 'HUDDLE-AB12-CD34' --name 'O'\\''Brien Bot' --platform 'codex'`);

    const psRes = await app.request("/install.ps1?code=HUDDLE-AB12-CD34");
    const ps = await psRes.text();
    expect(ps).toContain("[string]$Code = 'HUDDLE-AB12-CD34'");
    expect(ps).toContain("openhuddle.cmd");

    const installMd = await (await app.request("/install.md")).text();
    expect(installMd).toContain("https://huddle.example.com/install.sh | sh -s -- connect");
    expect(installMd).toContain("/api/v1/mcp");
  });

  it("rejects anonymous and human callers on remote MCP endpoint", async () => {
    const env = parseServerEnv({
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      DATABASE_URL: "memory://",
    });
    const app = createServerApp({ env, database, realtimeBus: bus });
    const anon = await app.request("/api/v1/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(anon.status).toBe(401);
  });
});

it.skipIf(process.platform === "win32")(
  "connects in the shipped POSIX fallback without a Node runtime",
  () => {
    const tempDir = mkdtempSync(join(tmpdir(), "openhuddle-fallback-"));
    try {
      const home = join(tempDir, "Agent's home");
      const tools = join(tempDir, "bin");
      const capture = join(tempDir, "request.json");
      const installed = join(tempDir, "openhuddle");
      mkdirSync(tools);
      const url = "https://huddle.example.com";
      const installer = renderInstallShellScript(url);
      const fallback = installer.split("<<'SH_CLI_EOF'\n")[1]?.split("\nSH_CLI_EOF")[0];
      if (fallback === undefined) {
        throw new Error("Installer did not include the POSIX fallback");
      }
      writeFileSync(installed, fallback);
      for (const utility of ["cat", "chmod", "head", "mkdir", "mktemp", "mv", "rm", "sed", "tr"]) {
        const executable = execFileSync("/bin/sh", ["-c", 'command -v "$1"', "sh", utility], {
          encoding: "utf8",
        }).trim();
        symlinkSync(executable, join(tools, utility));
      }
      writeFileSync(
        join(tools, "curl"),
        [
          "#!/bin/sh",
          'case "$*" in',
          '  *"/api/v1/agent-connections/redeem"*)',
          '    cat > "$CAPTURE"',
          '    printf \'%s\' \'{"token":"oh_agt_test","autoJoinedRoomId":"rom_example"}\' ;;',
          '  *"/api/v1/rooms"*)',
          '    case "$*" in *"Authorization: Bearer oh_agt_test"*) printf \'%s\' \'{"rooms":[{"id":"rom_example"}]}\' ;; *) exit 1 ;; esac ;;',
          "  *) exit 1 ;;",
          "esac",
        ].join("\n"),
        { mode: 0o700 },
      );
      const env = {
        HOME: home,
        INSTALLED_OH_HOME: home,
        INSTALLED_OH_SERVER: url,
        PATH: tools,
        CAPTURE: capture,
      };
      const connectionToken = `oh_connect_ng_${"a".repeat(43)}`;
      const output = execFileSync(
        "/bin/sh",
        [
          installed,
          "connect",
          `${url}/connect#${connectionToken}`,
          "--name",
          "Cloud Agent",
          "--platform",
          "codex",
          "--no-greet",
        ],
        { env, encoding: "utf8" },
      );
      expect(output).toContain("room=rom_example");
      expect(output).not.toContain(connectionToken);
      expect(JSON.parse(readFileSync(capture, "utf8"))).toEqual({
        connectionToken,
        name: "Cloud Agent",
        platform: "codex",
      });
      expect(
        JSON.parse(execFileSync("/bin/sh", [installed, "rooms"], { env, encoding: "utf8" })),
      ).toEqual({ rooms: [{ id: "rom_example" }] });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  },
);
