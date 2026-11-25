/**
 * @module db/client
 * @description 统一 PostgreSQL 数据库连接工厂（无缝支持内存/本地嵌入式 PGlite 与生产标准 PostgreSQL 连接池）。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 驱动透明切换：通过 `DATABASE_URL` 前缀自动识别 `memory://`、`file://`（PGlite WASM）与 `postgres://` / `postgresql://`（`pg.Pool`）。
 * 2. 优雅释放：返回包含 `close()` 钩子的连接句柄，确保测试套件结束或服务端收到 `SIGTERM` 时完整排空连接。
 */
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzleNodePg } from "drizzle-orm/node-postgres";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import pg from "pg";
import * as schema from "./schema.js";

const LOCK_POLL_INTERVAL_MS = 50;
const DEFAULT_LOCK_WAIT_TIMEOUT_MS = 5_000;
const STALE_UNREADABLE_LOCK_GRACE_MS = 1_000;
const SYNC_SLEEP_ARRAY = new Int32Array(new SharedArrayBuffer(4));

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
  /** 本地 `file://` PGlite 目录被另一存活进程持有时的最长等待释放毫秒数（兼容 `tsx watch` 热重载平滑交接） */
  readonly lockWaitTimeoutMs?: number;
  /** 可选空闲连接异常回调；缺省吞并后台连接闪断事件，防止未监听 `error` 击穿 Node 进程 */
  readonly onPoolError?: (err: Error) => void;
}

/**
 * 受控数据库生命周期句柄。
 */
export interface ManagedDatabase {
  readonly driver: "pglite" | "postgres";
  readonly db: OpenHuddleDb;
  /** 当驱动为标准 `postgres` 时暴露底层 `pg.Pool`，供 `LISTEN / NOTIFY` 事件总线使用 */
  readonly pgPool?: pg.Pool;
  /** 当驱动为 `pglite` 时暴露底层实例，供本地快照导出使用 */
  readonly pglite?: PGlite;
  readonly close: () => Promise<void>;
}

function isHostProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  if (pid === process.pid) {
    return true;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function parseLockOwnerPid(rawText: string): number | undefined {
  const trimmed = rawText.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as { readonly pid?: unknown };
      if (typeof parsed.pid === "number" && Number.isInteger(parsed.pid) && parsed.pid > 0) {
        return parsed.pid;
      }
    } catch {
      return undefined;
    }
  }
  const numericPid = Number.parseInt(trimmed, 10);
  return Number.isInteger(numericPid) && numericPid > 0 ? numericPid : undefined;
}

function sleepBlockingMs(ms: number): void {
  if (ms <= 0) {
    return;
  }
  Atomics.wait(SYNC_SLEEP_ARRAY, 0, 0, ms);
}

/**
 * 以内核级 `O_CREAT | O_EXCL`（`"wx"`）原子获取 PGlite 数据目录单写者互斥锁，彻底杜绝双进程并发写坏 WAL 与系统表索引。
 */
function acquirePgliteDirectoryLock(dataDir: string, lockWaitTimeoutMs: number): () => void {
  mkdirSync(dirname(dataDir), { recursive: true });
  const hostLockPath = `${dataDir}.owner.pid`;
  const deadlineMs = Date.now() + Math.max(0, lockWaitTimeoutMs);
  let lastActiveHolderPid: number | undefined;

  for (;;) {
    try {
      const fd = openSync(hostLockPath, "wx", 0o600);
      try {
        const payload = `${JSON.stringify({ pid: process.pid, acquiredAt: Date.now() })}\n`;
        writeSync(fd, payload, undefined, "utf8");
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        throw err;
      }

      let holderPid: number | undefined;
      let lockMtimeMs = Date.now();
      try {
        holderPid = parseLockOwnerPid(readFileSync(hostLockPath, "utf8"));
        lockMtimeMs = statSync(hostLockPath).mtimeMs;
      } catch {
        // 锁文件可能刚被上一持有者删除，下一轮立即重试原子创建
        continue;
      }

      if (holderPid !== undefined && !isHostProcessAlive(holderPid)) {
        rmSync(hostLockPath, { force: true });
        continue;
      }

      if (holderPid === undefined && Date.now() - lockMtimeMs >= STALE_UNREADABLE_LOCK_GRACE_MS) {
        rmSync(hostLockPath, { force: true });
        continue;
      }

      lastActiveHolderPid = holderPid;
      const remainingMs = deadlineMs - Date.now();
      if (remainingMs <= 0) {
        const pidLabel =
          lastActiveHolderPid !== undefined
            ? `PID ${String(lastActiveHolderPid)}`
            : "another process";
        throw new Error(
          `PGlite data directory "${dataDir}" is already in use by active process ${pidLabel}.`,
        );
      }
      sleepBlockingMs(Math.min(LOCK_POLL_INTERVAL_MS, remainingMs));
    }
  }

  // PGlite WASM 内部恒定使用虚拟 PID，仅在已独占持有宿主机目录锁后清理陈旧 PostgreSQL 锁文件
  if (existsSync(dataDir)) {
    const staleLocks = ["postmaster.pid", ".s.PGSQL.5432.lock", ".s.PGSQL.5432.lock.out"];
    for (const lockName of staleLocks) {
      const lockFile = join(dataDir, lockName);
      if (existsSync(lockFile)) {
        rmSync(lockFile, { force: true });
      }
    }
  }

  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    try {
      if (existsSync(hostLockPath)) {
        const recordedPid = parseLockOwnerPid(readFileSync(hostLockPath, "utf8"));
        if (recordedPid === undefined || recordedPid === process.pid) {
          rmSync(hostLockPath, { force: true });
        }
      }
    } catch {
      // 忽略退出阶段重复清理异常
    }
  };
}

/**
 * 根据 `url` 协议创建并初始化 PGlite 或标准 PostgreSQL 连接实例。
 *
 * @param options - 数据库连接配置
 * @returns 包含 Drizzle 实例与 `close()` 清理函数的受控句柄
 * @throws {Error} 当 `url` 协议不受支持时抛出异常
 */
export function createDatabaseClient(options: Readonly<DatabaseClientOptions>): ManagedDatabase {
  const { url, maxPoolSize = 12, lockWaitTimeoutMs = DEFAULT_LOCK_WAIT_TIMEOUT_MS } = options;

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
    const releaseDirectoryLock = acquirePgliteDirectoryLock(dataDir, lockWaitTimeoutMs);
    let client: PGlite;
    try {
      client = new PGlite(dataDir);
    } catch (err) {
      releaseDirectoryLock();
      throw err;
    }
    const db = drizzlePglite(client, { schema }) as unknown as OpenHuddleDb;
    return {
      driver: "pglite",
      db,
      pglite: client,
      close: async () => {
        try {
          await client.close();
        } finally {
          releaseDirectoryLock();
        }
      },
    };
  }

  if (url.startsWith("postgres://") || url.startsWith("postgresql://")) {
    const pool = new pg.Pool({
      connectionString: url,
      max: maxPoolSize,
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 30_000,
      keepAlive: true,
      keepAliveInitialDelayMillis: 10_000,
      statement_timeout: 15_000,
    });
    // pg.Pool 空闲连接遇到服务端重启或防火墙回收时会派发 EventEmitter 'error' 事件；必须挂载监听器防止进程崩溃
    pool.on("error", (err) => {
      options.onPoolError?.(err);
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
