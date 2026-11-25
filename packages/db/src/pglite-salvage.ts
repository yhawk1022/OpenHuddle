/**
 * @module db/pglite-salvage
 * @description 本地嵌入式 PGlite 异常断电或双进程并发写坏 WAL / 系统目录索引时的自动数据抢救工具。
 *
 * 关键恢复原理：
 * 1. 修复被预分配复用的 WAL 检查点段：读取 `global/pg_control` 的 `checkPoint` LSN 计算目标段号，若该段缺失但在 `pg_wal/` 其它预分配段头部的 `xlp_pageaddr` 命中，则补齐目标段文件。
 * 2. 单用户忽略系统索引模式（`-P -O`）：以 `ignore_system_indexes` 与 `allow_system_table_mods` 拉起临时副本，校准失步的 `pg_class.relnatts`，按外键拓扑顺序将完好业务表迁入新库。
 */
import {
  copyFileSync,
  cpSync,
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { PGlite, type PGliteOptions } from "@electric-sql/pglite";
import type { OpenHuddleDb } from "./client.js";

const PGLITE_WAL_SEG_BYTES = 0x100_000;

const SALVAGE_TABLE_ORDER: readonly string[] = [
  "users",
  "auth_otp_codes",
  "user_sessions",
  "agents",
  "pairing_codes",
  "friendships",
  "rooms",
  "room_members",
  "messages",
  "proposals",
  "proposal_votes",
  "admin_audit_logs",
  "workspaces",
  "workspace_room_bindings",
  "work_items",
  "work_slices",
  "work_review_evidence",
];

const JSONB_COLUMN_NAMES: ReadonlySet<string> = new Set([
  "wake_config_json",
  "governance_json",
  "payload_json",
  "mentions_json",
  "draft_json",
  "mandate_json",
  "metadata_json",
  "roots_json",
  "hooks_json",
  "context_json",
  "attention_json",
  "review_json",
  "trace_json",
  "diff_files_json",
  "agent_snapshots_json",
  "owned_paths_json",
  "changed_files_json",
  "steer_notes_json",
  "provenance_json",
]);

/** PGlite 损坏快照数据抢救结果统计 */
export interface PgliteSalvageReport {
  readonly salvagedTables: number;
  readonly salvagedRows: number;
}

interface QueryCapableClient {
  query<TRow = Record<string, unknown>>(
    sqlText: string,
    params?: readonly unknown[],
  ): Promise<{ readonly rows: readonly TRow[] }>;
}

function readPgErrorCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) {
    return undefined;
  }
  const direct = (err as { readonly code?: unknown }).code;
  if (typeof direct === "string") {
    return direct;
  }
  const cause = (err as { readonly cause?: unknown }).cause;
  if (typeof cause === "object" && cause !== null) {
    const nested = (cause as { readonly code?: unknown }).code;
    if (typeof nested === "string") {
      return nested;
    }
  }
  return undefined;
}

/**
 * 判断启动期异常是否属于本地嵌入式 PGlite WASM 崩溃或 PostgreSQL 内部目录损坏（`XX000`）。
 */
export function isCorruptedLocalPgliteError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  if (
    err.name === "RuntimeError" ||
    (err.cause instanceof Error && err.cause.name === "RuntimeError")
  ) {
    return true;
  }
  const pgCode = readPgErrorCode(err);
  if (pgCode === "XX000" || pgCode === "58P01") {
    return true;
  }
  return (
    err.message.includes("Aborted()") || err.message.includes("pg_attribute catalog is missing")
  );
}

function repairRecycledCheckpointWalSegment(workDir: string): void {
  const controlPath = join(workDir, "global", "pg_control");
  const walDir = join(workDir, "pg_wal");
  if (!existsSync(controlPath) || !existsSync(walDir)) {
    return;
  }
  const controlBuf = readFileSync(controlPath);
  if (controlBuf.byteLength < 64) {
    return;
  }
  const checkPointLsn = Number(controlBuf.readBigUInt64LE(32));
  const timelineId = controlBuf.readUInt32LE(48);
  if (!Number.isSafeInteger(checkPointLsn) || checkPointLsn <= 0 || timelineId <= 0) {
    return;
  }

  const segNo = Math.floor(checkPointLsn / PGLITE_WAL_SEG_BYTES);
  const expectedPageAddr = BigInt(segNo) * BigInt(PGLITE_WAL_SEG_BYTES);
  const targetSegName = `${timelineId.toString(16).toUpperCase().padStart(8, "0")}${Math.floor(
    segNo / 0x1_0000_0000,
  )
    .toString(16)
    .toUpperCase()
    .padStart(8, "0")}${(segNo >>> 0).toString(16).toUpperCase().padStart(8, "0")}`;
  const targetSegPath = join(walDir, targetSegName);
  if (existsSync(targetSegPath)) {
    return;
  }

  for (const entry of readdirSync(walDir)) {
    const candidatePath = join(walDir, entry);
    if (!statSync(candidatePath).isFile()) {
      continue;
    }
    const hdr = readFileSync(candidatePath).subarray(0, 24);
    if (hdr.byteLength < 16) {
      continue;
    }
    const pageAddr = hdr.readBigUInt64LE(8);
    if (pageAddr === expectedPageAddr) {
      copyFileSync(candidatePath, targetSegPath);
      return;
    }
  }
}

/**
 * 在临时隔离副本上尽力抢救损坏 PGlite 目录中的完好业务行并幂等写入 `targetDb`。
 * 无论抢救成功与否均保证不修改 `corruptBackupDir` 原始归档，也不向外抛出二次致命异常。
 */
export async function salvageCorruptedPgliteInto(
  corruptBackupDir: string,
  targetDb: OpenHuddleDb,
): Promise<PgliteSalvageReport> {
  const targetClient = (targetDb as unknown as { readonly $client?: QueryCapableClient }).$client;
  if (!targetClient || !existsSync(corruptBackupDir)) {
    return { salvagedTables: 0, salvagedRows: 0 };
  }

  const workDir = `${corruptBackupDir}.salvage-tmp-${String(process.pid)}`;
  let sourcePg: PGlite | undefined;
  let salvagedTables = 0;
  let salvagedRows = 0;

  try {
    cpSync(corruptBackupDir, workDir, { recursive: true });
    for (const staleLock of ["postmaster.pid", ".s.PGSQL.5432.lock", ".s.PGSQL.5432.lock.out"]) {
      rmSync(join(workDir, staleLock), { force: true });
    }
    repairRecycledCheckpointWalSegment(workDir);

    const salvageOptions = {
      startParams: ["--single", "postgres", "-P", "-O"],
    } as unknown as PGliteOptions;
    sourcePg = new PGlite(workDir, salvageOptions);
    await sourcePg.waitReady;

    const publicRels = await sourcePg.query<{
      readonly oid: number;
      readonly relname: string;
      readonly relnatts: number;
    }>(
      "SELECT oid::int AS oid, relname, relnatts::int AS relnatts FROM pg_class WHERE relkind = 'r' AND relnamespace = 2200",
    );

    const existingTables = new Set<string>();
    for (const rel of publicRels.rows) {
      existingTables.add(rel.relname);
      const attrCountRes = await sourcePg.query<{ readonly cnt: number }>(
        "SELECT count(*)::int AS cnt FROM pg_attribute WHERE attrelid = $1 AND attnum > 0",
        [rel.oid],
      );
      const actualAttrCount = attrCountRes.rows[0]?.cnt;
      if (
        actualAttrCount !== undefined &&
        actualAttrCount > 0 &&
        actualAttrCount !== rel.relnatts
      ) {
        await sourcePg.query("UPDATE pg_class SET relnatts = $1 WHERE oid = $2", [
          actualAttrCount,
          rel.oid,
        ]);
      }
    }

    for (const tableName of SALVAGE_TABLE_ORDER) {
      if (!existingTables.has(tableName)) {
        continue;
      }
      try {
        const extracted = await sourcePg.query<Record<string, unknown>>(
          `SELECT * FROM "${tableName}"`,
        );
        const firstRow = extracted.rows[0];
        if (!firstRow) {
          continue;
        }
        const cols = Object.keys(firstRow).filter((col) => /^[a-z0-9_]+$/u.test(col));
        if (cols.length === 0) {
          continue;
        }
        const colSql = cols.map((col) => `"${col}"`).join(", ");
        const placeholderSql = cols
          .map((col, idx) =>
            JSONB_COLUMN_NAMES.has(col) ? `$${String(idx + 1)}::jsonb` : `$${String(idx + 1)}`,
          )
          .join(", ");

        let insertedForTable = 0;
        for (const row of extracted.rows) {
          const values = cols.map((col) => {
            const val = row[col];
            if (val === null || val === undefined) {
              return null;
            }
            if (JSONB_COLUMN_NAMES.has(col)) {
              return JSON.stringify(val);
            }
            return val;
          });
          await targetClient.query(
            `INSERT INTO "${tableName}" (${colSql}) VALUES (${placeholderSql}) ON CONFLICT DO NOTHING`,
            values,
          );
          insertedForTable += 1;
        }

        if (insertedForTable > 0) {
          salvagedTables += 1;
          salvagedRows += insertedForTable;
        }
      } catch {
        // 单张表若仍有页级损坏则跳过，继续抢救其余核心表
      }
    }
  } catch {
    return { salvagedTables, salvagedRows };
  } finally {
    if (sourcePg) {
      await sourcePg.close().catch(() => undefined);
    }
    rmSync(workDir, { recursive: true, force: true });
  }

  return { salvagedTables, salvagedRows };
}
