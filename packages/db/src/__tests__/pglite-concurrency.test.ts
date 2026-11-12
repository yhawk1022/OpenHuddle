/**
 * @module db/tests/pglite-concurrency
 * @description 基于真实内存态 PGlite 内核验证房间消息 `seq` 行锁严格单调递增与 `op_key` 幂等去重不变量。
 */
import { type MessageSeq, asMessageSeq, createDefaultGovernanceState } from "@openhuddle/protocol";
import { and, asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type ManagedDatabase,
  type OpenHuddleDb,
  createDatabaseClient,
  ensureCoreSchema,
  messagesTable,
  roomsTable,
  usersTable,
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
