/**
 * @module db/pglite-backup
 * @description 本地嵌入式 PGlite 数据目录的压缩快照、保留清理与快照恢复。
 *
 * 为什么需要：PGlite 0.2 在进程被强杀（`SIGKILL`）或双进程写同一目录时可能丢失有效检查点，
 * 损坏后只能尽力抢救。定期快照把最坏情况下的数据损失限制在一个快照间隔内。
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const SNAPSHOT_PREFIX = "pglite-";
const SNAPSHOT_SUFFIX = ".tar.gz";

/** 默认保留的快照数量 */
export const DEFAULT_PGLITE_SNAPSHOT_KEEP = 5;

function listSnapshotFiles(backupDir: string): string[] {
  if (!existsSync(backupDir)) {
    return [];
  }
  return readdirSync(backupDir)
    .filter((name) => name.startsWith(SNAPSHOT_PREFIX) && name.endsWith(SNAPSHOT_SUFFIX))
    .sort();
}

/**
 * 返回最新快照的绝对路径与写入时间；没有快照时返回 `undefined`。
 */
export function findLatestPgliteSnapshot(
  backupDir: string,
): { readonly path: string; readonly mtimeMs: number } | undefined {
  const files = listSnapshotFiles(backupDir);
  const latest = files[files.length - 1];
  if (latest === undefined) {
    return undefined;
  }
  const fullPath = join(backupDir, latest);
  return { path: fullPath, mtimeMs: statSync(fullPath).mtimeMs };
}

/**
 * 将运行中的 PGlite 实例导出为 gzip 快照（先写临时文件再原子改名），并只保留最近 `keep` 份。
 *
 * @returns 新快照的绝对路径
 */
export async function writePgliteSnapshot(
  client: PGlite,
  backupDir: string,
  keep: number = DEFAULT_PGLITE_SNAPSHOT_KEEP,
): Promise<string> {
  mkdirSync(backupDir, { recursive: true });
  const blob = await client.dumpDataDir("gzip");
  const bytes = Buffer.from(await blob.arrayBuffer());
  // 文件名按时间字典序可排序，`:` 与 `.` 替换掉以兼容 Windows
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const finalPath = join(backupDir, `${SNAPSHOT_PREFIX}${stamp}${SNAPSHOT_SUFFIX}`);
  const tmpPath = `${finalPath}.tmp-${String(process.pid)}`;
  writeFileSync(tmpPath, bytes);
  renameSync(tmpPath, finalPath);

  const files = listSnapshotFiles(backupDir);
  const excess = files.length - Math.max(1, keep);
  for (let i = 0; i < excess; i += 1) {
    const stale = files[i];
    if (stale !== undefined) {
      rmSync(join(backupDir, stale), { force: true });
    }
  }
  return finalPath;
}

/**
 * 将快照解压恢复到一个尚不存在的 `dataDir`，恢复后正常关闭实例使其落盘。
 *
 * @throws {Error} 当 `dataDir` 已存在时拒绝覆盖
 */
export async function restorePgliteSnapshot(snapshotPath: string, dataDir: string): Promise<void> {
  if (existsSync(dataDir)) {
    throw new Error(`Refusing to restore PGlite snapshot into existing directory "${dataDir}".`);
  }
  const blob = new Blob([readFileSync(snapshotPath)]);
  const client = new PGlite(dataDir, { loadDataDir: blob });
  try {
    await client.waitReady;
    await client.query("SELECT 1");
  } finally {
    await client.close();
  }
}

/**
 * 只保留最近 `keep` 个同前缀的损坏归档目录（如 `pglite.corrupt-<ts>`），避免磁盘被历史归档占满。
 */
export function pruneArchivedDirectories(parentDir: string, prefix: string, keep: number): void {
  if (!existsSync(parentDir)) {
    return;
  }
  const archives = readdirSync(parentDir)
    .filter((name) => name.startsWith(prefix))
    .map((name) => ({ name, mtimeMs: statSync(join(parentDir, name)).mtimeMs }))
    .sort((a, b) => a.mtimeMs - b.mtimeMs);
  const excess = archives.length - Math.max(0, keep);
  for (let i = 0; i < excess; i += 1) {
    const stale = archives[i];
    if (stale !== undefined) {
      rmSync(join(parentDir, stale.name), { recursive: true, force: true });
    }
  }
}
