/**
 * @module db/tests/pglite-concurrency
 * @description 基于真实内存态 PGlite 内核验证房间消息 `seq` 行锁严格单调递增与 `op_key` 幂等去重不变量。
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type MessageSeq, asMessageSeq, createDefaultGovernanceState } from "@openhuddle/protocol";
import { and, asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type ManagedDatabase,
  type OpenHuddleDb,
  createDatabaseClient,
  ensureCoreSchema,
  findLatestPgliteSnapshot,
  isCorruptedLocalPgliteError,
  messagesTable,
  pruneArchivedDirectories,
  restorePgliteSnapshot,
  roomsTable,
  usersTable,
  writePgliteSnapshot,
} from "../index.js";

/**
 * 模拟服务端在行级锁事务内分配连续 `seq` 并支持 `opKey` 幂等重放的标准写入流程。
 */
async function appendRoomMessageTransactional(
  db: OpenHuddleDb,
  params: {
    readonly roomId: string;
    readonly authorUserId: string;
    readonly content: string;
    readonly opKey?: string;
  },
): Promise<MessageSeq> {
  return db.transaction(async (tx) => {
    // 关键并发不变量：先使用 FOR UPDATE 锁住所属房间行，串行化同一房间内的并发序号分配
    const [room] = await tx
      .select()
      .from(roomsTable)
      .where(eq(roomsTable.id, params.roomId))
      .for("update");

    if (!room) {
      throw new Error(`Room not found: ${params.roomId}`);
    }

    // 幂等检查：若客户端重试携带已落库的 opKey，直接返回原 seq 而不重复生成消息
    if (params.opKey !== undefined) {
      const [existing] = await tx
        .select({ seq: messagesTable.seq })
        .from(messagesTable)
        .where(and(eq(messagesTable.roomId, params.roomId), eq(messagesTable.opKey, params.opKey)))
        .limit(1);

      if (existing) {
        return asMessageSeq(existing.seq);
      }
    }

    const nextSeq = room.lastSeq + 1;

    await tx.update(roomsTable).set({ lastSeq: nextSeq }).where(eq(roomsTable.id, params.roomId));

    await tx.insert(messagesTable).values({
      roomId: params.roomId,
      seq: nextSeq,
      authorKind: "human",
      authorUserId: params.authorUserId,
      ownerUserId: params.authorUserId,
      type: "text",
      content: params.content,
      mentionsJson: [],
      ...(params.opKey !== undefined ? { opKey: params.opKey } : {}),
    });

    return asMessageSeq(nextSeq);
  });
}

describe("@openhuddle/db — in-memory PGlite row-lock seq monotonicity & opKey idempotency", () => {
  let managed: ManagedDatabase;

  beforeEach(async () => {
    managed = createDatabaseClient({ url: "memory://" });
    await ensureCoreSchema(managed.db);

    await managed.db.insert(usersTable).values({
      id: "usr_founder",
      email: "founder@openhuddle.dev",
      displayName: "Founder",
    });

    await managed.db.insert(roomsTable).values({
      id: "rom_zero",
      ownerUserId: "usr_founder",
      name: "OpenHuddle #0",
      inviteToken: "inv_zero_token",
      governanceJson: createDefaultGovernanceState(),
      lastSeq: 0,
    });
  });

  afterEach(async () => {
    await managed.close();
  });

  it("allocates gapless monotonic seq 1..8 under concurrent writes and enforces opKey idempotency", async () => {
    const concurrentWrites = Array.from({ length: 8 }, (_, idx) =>
      appendRoomMessageTransactional(managed.db, {
        roomId: "rom_zero",
        authorUserId: "usr_founder",
        content: `Concurrent message #${idx + 1}`,
        opKey: `op_batch_${idx + 1}`,
      }),
    );

    const assignedSeqs = await Promise.all(concurrentWrites);
    const sortedSeqs = [...assignedSeqs].sort((a, b) => a - b);
    expect(sortedSeqs).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);

    // 重复发送相同 opKey 时必须幂等返回原序号，且房间总消息数保持为 8
    const replayedSeq = await appendRoomMessageTransactional(managed.db, {
      roomId: "rom_zero",
      authorUserId: "usr_founder",
      content: "Concurrent message #3 (retry)",
      opKey: "op_batch_3",
    });
    expect(assignedSeqs).toContain(replayedSeq);

    const rows = await managed.db
      .select({ seq: messagesTable.seq })
      .from(messagesTable)
      .where(eq(messagesTable.roomId, "rom_zero"))
      .orderBy(asc(messagesTable.seq));

    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});

describe("@openhuddle/db — PGlite file:// atomic directory lock & crash recovery guards", () => {
  let sandboxDir: string;

  beforeEach(() => {
    sandboxDir = mkdtempSync(join(tmpdir(), "openhuddle-pglite-lock-"));
  });

  afterEach(() => {
    rmSync(sandboxDir, { recursive: true, force: true });
  });

  it("rejects concurrent second writer on the same PGlite directory and allows clean reopen after close", async () => {
    const dataDir = join(sandboxDir, "pglite");
    const first = createDatabaseClient({
      url: `file://${dataDir}`,
      lockWaitTimeoutMs: 120,
    });
    await ensureCoreSchema(first.db);

    expect(() =>
      createDatabaseClient({
        url: `file://${dataDir}`,
        lockWaitTimeoutMs: 120,
      }),
    ).toThrow(/already in use by active process/);

    await first.close();

    const reopened = createDatabaseClient({
      url: `file://${dataDir}`,
      lockWaitTimeoutMs: 120,
    });
    await ensureCoreSchema(reopened.db);
    await reopened.close();
  });

  it("automatically reclaims stale dead-PID lockfile and stale postmaster.pid after crash", async () => {
    const dataDir = join(sandboxDir, "crashed-pglite");
    const initial = createDatabaseClient({ url: `file://${dataDir}` });
    await ensureCoreSchema(initial.db);
    await initial.close();

    // 模拟进程被 SIGKILL 后残留的死 PID 锁与虚拟 postmaster.pid
    writeFileSync(
      `${dataDir}.owner.pid`,
      `${JSON.stringify({ pid: 999_999, acquiredAt: 1 })}\n`,
      "utf8",
    );
    writeFileSync(join(dataDir, "postmaster.pid"), "-42\n/tmp/pglite/base\n", "utf8");

    const recovered = createDatabaseClient({
      url: `file://${dataDir}`,
      lockWaitTimeoutMs: 200,
    });
    await ensureCoreSchema(recovered.db);
    await recovered.close();
  });

  it("classifies WASM RuntimeError and PostgreSQL XX000 catalog errors as local PGlite corruption", () => {
    const wasmErr = Object.assign(new Error("Aborted()"), { name: "RuntimeError" });
    expect(isCorruptedLocalPgliteError(wasmErr)).toBe(true);

    const catalogErr = Object.assign(
      new Error("pg_attribute catalog is missing 1 attribute(s) for relation OID 16384"),
      { code: "XX000" },
    );
    expect(isCorruptedLocalPgliteError(catalogErr)).toBe(true);
    expect(isCorruptedLocalPgliteError(new Error("Normal validation error"))).toBe(false);
  });
});

describe("@openhuddle/db — PGlite snapshot backup & restore", () => {
  let sandboxDir: string;

  beforeEach(() => {
    sandboxDir = mkdtempSync(join(tmpdir(), "openhuddle-pglite-snap-"));
  });

  afterEach(() => {
    rmSync(sandboxDir, { recursive: true, force: true });
  });

  it("restores rows from the latest snapshot, keeps only N snapshots, and refuses to overwrite", async () => {
    const dataDir = join(sandboxDir, "pglite");
    const backupDir = join(sandboxDir, "pglite.backups");
    const source = createDatabaseClient({ url: `file://${dataDir}` });
    await ensureCoreSchema(source.db);
    await source.db.insert(usersTable).values({
      id: "usr_snapshot",
      email: "snapshot@openhuddle.dev",
      displayName: "Snapshot",
    });
    const pglite = source.pglite;
    expect(pglite).toBeDefined();
    if (!pglite) return;

    for (let i = 0; i < 3; i += 1) {
      await writePgliteSnapshot(pglite, backupDir, 2);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(readdirSync(backupDir).filter((n) => n.endsWith(".tar.gz"))).toHaveLength(2);
    await source.close();

    const latest = findLatestPgliteSnapshot(backupDir);
    expect(latest).toBeDefined();
    if (!latest) return;
    const restoredDir = join(sandboxDir, "restored");
    await restorePgliteSnapshot(latest.path, restoredDir);
    await expect(restorePgliteSnapshot(latest.path, restoredDir)).rejects.toThrow(
      /existing directory/,
    );

    const restored = createDatabaseClient({ url: `file://${restoredDir}` });
    await ensureCoreSchema(restored.db);
    const rows = await restored.db.select({ email: usersTable.email }).from(usersTable);
    expect(rows).toEqual([{ email: "snapshot@openhuddle.dev" }]);
    await restored.close();
  });

  it("prunes old archived corrupt directories beyond the retention count", () => {
    for (const ts of [1, 2, 3, 4]) {
      mkdirSync(join(sandboxDir, `pglite.corrupt-${String(ts)}`));
      utimesSync(join(sandboxDir, `pglite.corrupt-${String(ts)}`), ts, ts);
    }
    mkdirSync(join(sandboxDir, "pglite"));
    pruneArchivedDirectories(sandboxDir, "pglite.corrupt-", 2);
    expect(readdirSync(sandboxDir).sort()).toEqual([
      "pglite",
      "pglite.corrupt-3",
      "pglite.corrupt-4",
    ]);
  });
});
