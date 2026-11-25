/**
 * @module server/infra/local-pglite-guard
 * @description 开发态本地嵌入式 PGlite 的打开、损坏自愈与定时快照。
 *
 * 损坏时的恢复顺序：
 * 1. 把损坏目录改名归档为 `<dataDir>.corrupt-<ts>`（原件不动，可人工再救）。
 * 2. 有快照就从最新快照恢复，否则建空库。
 * 3. 从损坏归档中尽力抢救比快照更新的行（`ON CONFLICT DO NOTHING` 合并）。
 * 4. 只保留最近 3 个损坏归档。
 */
import { existsSync, renameSync, rmSync } from "node:fs";
import { basename, dirname } from "node:path";
import {
  DEFAULT_PGLITE_SNAPSHOT_KEEP,
  type ManagedDatabase,
  createDatabaseClient,
  ensureCoreSchema,
  findLatestPgliteSnapshot,
  isCorruptedLocalPgliteError,
  pruneArchivedDirectories,
  restorePgliteSnapshot,
  salvageCorruptedPgliteInto,
  writePgliteSnapshot,
} from "@openhuddle/db";
import type { Logger } from "pino";
import type { ServerEnv } from "./env.js";

const CORRUPT_ARCHIVE_KEEP = 3;
/** 启动后延迟首个快照，避免热重载连发时每次重启都导出 */
const FIRST_SNAPSHOT_DELAY_MS = 15_000;
/** 距最新快照不足该间隔时跳过启动快照 */
const MIN_SNAPSHOT_AGE_MS = 10 * 60_000;
/** 运行期周期快照间隔 */
const SNAPSHOT_INTERVAL_MS = 30 * 60_000;

/** 本地 PGlite 数据目录（仅 `file://` 时有值） */
export function resolveLocalPgliteDataDir(env: ServerEnv): string | undefined {
  return env.DATABASE_URL.startsWith("file://")
    ? env.DATABASE_URL.slice("file://".length)
    : undefined;
}

/** 快照目录：与数据目录同级的 `<dataDir>.backups` */
export function resolvePgliteBackupDir(dataDir: string): string {
  return `${dataDir}.backups`;
}

/**
 * 打开数据库并初始化表结构；开发态本地 PGlite 损坏时自动归档、从快照恢复并抢救数据。
 */
export async function openDatabaseWithLocalRecovery(
  env: ServerEnv,
  logger: Logger,
): Promise<ManagedDatabase> {
  let database = createDatabaseClient({ url: env.DATABASE_URL });
  try {
    await ensureCoreSchema(database.db);
    return database;
  } catch (err) {
    await database.close().catch(() => undefined);
    const dataDir = resolveLocalPgliteDataDir(env);
    if (
      env.NODE_ENV === "production" ||
      dataDir === undefined ||
      !isCorruptedLocalPgliteError(err)
    ) {
      throw err;
    }

    const archiveDir = `${dataDir}.corrupt-${String(Date.now())}`;
    logger.warn(
      { dataDir, archiveDir, err: err instanceof Error ? err.message : String(err) },
      "Local PGlite data directory is corrupted; archiving it and recovering",
    );
    if (existsSync(dataDir)) {
      renameSync(dataDir, archiveDir);
    }
    rmSync(`${dataDir}.owner.pid`, { force: true });

    const snapshot = findLatestPgliteSnapshot(resolvePgliteBackupDir(dataDir));
    if (snapshot) {
      try {
        await restorePgliteSnapshot(snapshot.path, dataDir);
        logger.info(
          { snapshot: snapshot.path, snapshotAt: new Date(snapshot.mtimeMs).toISOString() },
          "Restored local PGlite from latest snapshot",
        );
      } catch (restoreErr) {
        rmSync(dataDir, { recursive: true, force: true });
        logger.error(
          {
            snapshot: snapshot.path,
            err: restoreErr instanceof Error ? restoreErr.message : String(restoreErr),
          },
          "Failed to restore PGlite snapshot; starting from an empty database",
        );
      }
    }

    database = createDatabaseClient({ url: env.DATABASE_URL });
    await ensureCoreSchema(database.db);
    const report = await salvageCorruptedPgliteInto(archiveDir, database.db);
    logger.info(
      { archiveDir, salvagedTables: report.salvagedTables, salvagedRows: report.salvagedRows },
      "Local PGlite recovery finished",
    );
    pruneArchivedDirectories(
      dirname(dataDir),
      `${basename(dataDir)}.corrupt-`,
      CORRUPT_ARCHIVE_KEEP,
    );
    return database;
  }
}

/** 快照调度器句柄 */
export interface PgliteSnapshotScheduler {
  /** 停止定时器，并等待正在进行的快照最多 `timeoutMs` 毫秒 */
  readonly stop: (timeoutMs: number) => Promise<void>;
}

/**
 * 为开发态本地 PGlite 启动定时快照；非本地库或生产环境返回空操作调度器。
 */
export function startPgliteSnapshotScheduler(
  env: ServerEnv,
  database: ManagedDatabase,
  logger: Logger,
): PgliteSnapshotScheduler {
  const dataDir = resolveLocalPgliteDataDir(env);
  const client = database.pglite;
  if (env.NODE_ENV === "production" || dataDir === undefined || client === undefined) {
    return { stop: async () => undefined };
  }

  const backupDir = resolvePgliteBackupDir(dataDir);
  let inFlight: Promise<void> | undefined;
  let stopped = false;

  const takeSnapshot = (reason: "startup" | "interval"): void => {
    if (stopped || inFlight) {
      return;
    }
    if (reason === "startup") {
      const latest = findLatestPgliteSnapshot(backupDir);
      if (latest && Date.now() - latest.mtimeMs < MIN_SNAPSHOT_AGE_MS) {
        return;
      }
    }
    inFlight = writePgliteSnapshot(client, backupDir, DEFAULT_PGLITE_SNAPSHOT_KEEP)
      .then((path) => {
        logger.info({ snapshot: path, reason }, "Wrote local PGlite snapshot");
      })
      .catch((err: unknown) => {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err), reason },
          "Failed to write local PGlite snapshot",
        );
      })
      .finally(() => {
        inFlight = undefined;
      });
  };

  const firstTimer = setTimeout(() => takeSnapshot("startup"), FIRST_SNAPSHOT_DELAY_MS);
  const intervalTimer = setInterval(() => takeSnapshot("interval"), SNAPSHOT_INTERVAL_MS);
  firstTimer.unref();
  intervalTimer.unref();

  return {
    stop: async (timeoutMs) => {
      stopped = true;
      clearTimeout(firstTimer);
      clearInterval(intervalTimer);
      if (inFlight) {
        await Promise.race([inFlight, new Promise((resolve) => setTimeout(resolve, timeoutMs))]);
      }
    },
  };
}
