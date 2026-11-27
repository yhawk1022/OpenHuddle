/**
 * @module db/tests/pglite-salvage
 * @description 验证 PGlite 跨版本列漂移抢救与旧表增量补列（`language_preference`）幂等迁移不变量。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createDatabaseClient,
  ensureCoreSchema,
  salvageCorruptedPgliteInto,
  usersTable,
} from "../index.js";

describe("@openhuddle/db — cross-version PGlite salvage & schema evolution", () => {
  let sandboxDir: string;

  beforeEach(() => {
    sandboxDir = mkdtempSync(join(tmpdir(), "openhuddle-pglite-salvage-"));
  });

  afterEach(() => {
    rmSync(sandboxDir, { recursive: true, force: true });
  });

  it("salvages overlapping columns when source table has extra columns absent in target table", async () => {
    const sourceDir = join(sandboxDir, "source-pglite");
    const source = createDatabaseClient({ url: `file://${sourceDir}` });
    try {
      await ensureCoreSchema(source.db);
      // 模拟未来版本新增列（目标表不存在该列）
      await source.db.execute(
        sql.raw("ALTER TABLE users ADD COLUMN future_v99_flag TEXT NOT NULL DEFAULT 'enabled'"),
      );
      await source.db.insert(usersTable).values({
        id: "usr_drift_1",
        email: "drift@example.com",
        displayName: "Drift User",
        themePreference: "dark",
        languagePreference: "en",
      });
    } finally {
      await source.close();
    }

    // 1. 抢救到当前版本目标库（源表多出 future_v99_flag 列）
    const currentTarget = createDatabaseClient({ url: "memory://" });
    try {
      await ensureCoreSchema(currentTarget.db);
      const report = await salvageCorruptedPgliteInto(sourceDir, currentTarget.db);
      expect(report.salvagedTables).toBeGreaterThanOrEqual(1);
      expect(report.salvagedRows).toBeGreaterThanOrEqual(1);

      const rows = await currentTarget.db
        .select({
          id: usersTable.id,
          email: usersTable.email,
          displayName: usersTable.displayName,
          themePreference: usersTable.themePreference,
          languagePreference: usersTable.languagePreference,
        })
        .from(usersTable);
      expect(rows).toEqual([
        {
          id: "usr_drift_1",
          email: "drift@example.com",
          displayName: "Drift User",
          themePreference: "dark",
          languagePreference: "en",
        },
      ]);
    } finally {
      await currentTarget.close();
    }

    // 2. 抢救到模拟回滚后的旧版目标库（目标 users 表缺少 language_preference 与 future_v99_flag）
    const legacyTarget = createDatabaseClient({ url: "memory://" });
    try {
      await legacyTarget.db.execute(
        sql.raw(`CREATE TABLE users (
          id TEXT PRIMARY KEY,
          email TEXT NOT NULL,
          display_name TEXT NOT NULL,
          theme_preference TEXT NOT NULL DEFAULT 'auto',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`),
      );

      const legacyReport = await salvageCorruptedPgliteInto(sourceDir, legacyTarget.db);
      expect(legacyReport.salvagedTables).toBe(1);
      expect(legacyReport.salvagedRows).toBe(1);

      const legacyRows = await legacyTarget.db.execute(
        sql.raw("SELECT id, email, display_name, theme_preference FROM users"),
      );
      expect(legacyRows.rows).toEqual([
        {
          id: "usr_drift_1",
          email: "drift@example.com",
          display_name: "Drift User",
          theme_preference: "dark",
        },
      ]);
    } finally {
      await legacyTarget.close();
    }
  });

  it("adds language_preference idempotently on legacy users tables with default 'auto'", async () => {
    const legacy = createDatabaseClient({ url: "memory://" });
    try {
      await legacy.db.execute(
        sql.raw(`CREATE TABLE users (
          id TEXT PRIMARY KEY,
          email TEXT NOT NULL,
          display_name TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`),
      );
      await legacy.db.execute(
        sql.raw(
          "INSERT INTO users (id, email, display_name) VALUES ('usr_old', 'old@example.com', 'Old User')",
        ),
      );

      // 连续两次幂等运行 ensureCoreSchema
      await ensureCoreSchema(legacy.db);
      await ensureCoreSchema(legacy.db);

      const rows = await legacy.db
        .select({
          id: usersTable.id,
          themePreference: usersTable.themePreference,
          languagePreference: usersTable.languagePreference,
        })
        .from(usersTable);
      expect(rows).toEqual([
        {
          id: "usr_old",
          themePreference: "auto",
          languagePreference: "auto",
        },
      ]);
    } finally {
      await legacy.close();
    }
  });
});
