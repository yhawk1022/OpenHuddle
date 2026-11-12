/**
 * @module server/tests/app
 * @description 验证 Hono 网关的健康探针、OpenAPI 文档生成与统一错误信封（携带 `x-request-id`）集成行为。
 */
import { type ManagedDatabase, createDatabaseClient, ensureCoreSchema } from "@openhuddle/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServerApp } from "../app.js";
import { parseServerEnv } from "../infra/env.js";
import { InMemoryRealtimeBus } from "../infra/realtime-bus.js";

describe("@openhuddle/server — gateway & OpenAPI contract harness", () => {
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

  it("serves /api/v1/health, exposes /api/openapi.json, and wraps 404 in standard ApiErrorEnvelope", async () => {
    const env = parseServerEnv({
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      DATABASE_URL: "memory://",
    });
    const app = createServerApp({ env, database, realtimeBus: bus });

    const healthRes = await app.request("/api/v1/health", {
      headers: { "x-request-id": "req-test-001" },
    });
    expect(healthRes.status).toBe(200);
    expect(healthRes.headers.get("x-request-id")).toBe("req-test-001");
    const healthJson = (await healthRes.json()) as { ok: boolean; databaseDriver: string };
    expect(healthJson.ok).toBe(true);
    expect(healthJson.databaseDriver).toBe("pglite");

    const openApiRes = await app.request("/api/openapi.json");
    expect(openApiRes.status).toBe(200);
    const openApiSpec = (await openApiRes.json()) as { openapi: string };
    expect(openApiSpec.openapi).toBe("3.1.0");

    const missingRes = await app.request("/api/v1/non-existent", {
      headers: { "x-request-id": "req-404-check" },
    });
    expect(missingRes.status).toBe(404);
    const missingBody = await missingRes.json();
    expect(missingBody).toEqual({
      ok: false,
      error: {
        code: "NOT_FOUND",
        message: "Route not found: GET /api/v1/non-existent",
        requestId: "req-404-check",
      },
    });
  });
});
