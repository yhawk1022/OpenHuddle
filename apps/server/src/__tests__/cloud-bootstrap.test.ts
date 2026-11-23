/**
 * @module server/tests/cloud-bootstrap
 * @description 全环境安装器（`/install.sh`、`/install.ps1`）、动态公网根地址推导与远程 MCP 鉴权边界测试。
 */
import { type ManagedDatabase, createDatabaseClient, ensureCoreSchema } from "@openhuddle/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServerApp } from "../app.js";
import { parseServerEnv } from "../infra/env.js";
import { resolveEffectivePublicBaseUrl } from "../infra/public-url.js";
import { InMemoryRealtimeBus } from "../infra/realtime-bus.js";

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
