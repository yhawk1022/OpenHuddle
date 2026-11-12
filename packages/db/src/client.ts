/**
 * @module db/client
 * @description 统一 PostgreSQL 数据库连接工厂（无缝支持内存/本地嵌入式 PGlite 与生产标准 PostgreSQL 连接池）。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 驱动透明切换：通过 `DATABASE_URL` 前缀自动识别 `memory://`、`file://`（PGlite WASM）与 `postgres://` / `postgresql://`（`pg.Pool`）。
 * 2. 优雅释放：返回包含 `close()` 钩子的连接句柄，确保测试套件结束或服务端收到 `SIGTERM` 时完整排空连接。
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzleNodePg } from "drizzle-orm/node-postgres";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import pg from "pg";
import * as schema from "./schema.js";

/**
 * 统一绑定了 OpenHuddle Schema 的 Drizzle PostgreSQL 数据库抽象类型。
 */
export type OpenHuddleDb = PgDatabase<PgQueryResultHKT, typeof schema>;

/**
 * 创建数据库连接的配置参数。
 */
export interface DatabaseClientOptions {
  /**
   * 数据库连接地址：
   * - `memory://`：用于单测与并发靶场的纯内存隔离实例
   * - `file://./.data/pglite`：零 Docker 嵌入式本地持久化实例
   * - `postgres://...` 或 `postgresql://...`：生产环境标准 PostgreSQL 16+
   */
  readonly url: string;
  /** 标准 PostgreSQL 连接池上限（对 2C4G 主机默认限制为 12，防止耗尽连接内存） */
  readonly maxPoolSize?: number;
}

/**
 * 受控数据库生命周期句柄。
 */
export interface ManagedDatabase {
  readonly driver: "pglite" | "postgres";
  readonly db: OpenHuddleDb;
  /** 当驱动为标准 `postgres` 时暴露底层 `pg.Pool`，供 `LISTEN / NOTIFY` 事件总线使用 */
  readonly pgPool?: pg.Pool;
  readonly close: () => Promise<void>;
}

/**
 * 根据 `url` 协议创建并初始化 PGlite 或标准 PostgreSQL 连接实例。
 *
 * @param options - 数据库连接配置
 * @returns 包含 Drizzle 实例与 `close()` 清理函数的受控句柄
 * @throws {Error} 当 `url` 协议不受支持时抛出异常
 */
export function createDatabaseClient(options: Readonly<DatabaseClientOptions>): ManagedDatabase {
  const { url, maxPoolSize = 12 } = options;

  if (url === "memory://") {
    const client = new PGlite();
    const db = drizzlePglite(client, { schema }) as unknown as OpenHuddleDb;
    return {
      driver: "pglite",
      db,
      close: async () => {
        await client.close();
      },
    };
  }

  if (url.startsWith("file://")) {
    const dataDir = url.slice("file://".length);
    mkdirSync(dirname(dataDir), { recursive: true });
    const client = new PGlite(dataDir);
    const db = drizzlePglite(client, { schema }) as unknown as OpenHuddleDb;
    return {
      driver: "pglite",
      db,
      close: async () => {
        await client.close();
      },
    };
  }

  if (url.startsWith("postgres://") || url.startsWith("postgresql://")) {
    const pool = new pg.Pool({
      connectionString: url,
      max: maxPoolSize,
    });
    const db = drizzleNodePg(pool, { schema }) as unknown as OpenHuddleDb;
    return {
      driver: "postgres",
      db,
      pgPool: pool,
      close: async () => {
        await pool.end();
      },
    };
  }

  throw new Error(
    `Unsupported DATABASE_URL scheme: "${url}". Expected "memory://", "file://...", or "postgres://...".`,
  );
}
