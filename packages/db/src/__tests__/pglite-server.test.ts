/**
 * @module db/tests/pglite-server
 * @description 验证内置 PGlite Wire Protocol TCP 服务端（`pnpm db:serve` 底层）的多连接复用、SSL 协商、同名 Prepared Statement 隔离与事务亲和回滚。
 */
import net from "node:net";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ManagedPgliteSocketServer, startPgliteSocketServer } from "../index.js";

describe("@openhuddle/db — PGlite Wire Protocol TCP Server", () => {
  let server: ManagedPgliteSocketServer;

  beforeEach(async () => {
    server = await startPgliteSocketServer({
      dataDir: "memory://",
      host: "127.0.0.1",
      port: 0,
      bootstrapSchema: true,
    });
  });

  afterEach(async () => {
    await server.close();
  });

  it("negotiates SSLRequest ('N') and serves concurrent queries with identical named prepared statements", async () => {
    // 1. 验证 DataGrip / pgjdbc 默认发起的 8 字节 SSLRequest 握手能收到明文回退字节 'N'
    const sslReply = await new Promise<string>((resolve, reject) => {
      const sock = net.createConnection({ host: server.host, port: server.port }, () => {
        const req = Buffer.alloc(8);
        req.writeInt32BE(8, 0);
        req.writeInt32BE(80_877_103, 4);
        sock.write(req);
      });
      sock.once("data", (chunk: Buffer) => {
        const reply = chunk.toString("utf8");
        sock.destroy();
        resolve(reply);
      });
      sock.once("error", reject);
    });
    expect(sslReply).toBe("N");

    // 2. 验证多个独立连接同时使用相同的命名 Prepared Statement ("S_1") 不会在单会话 PGlite 上冲突
    const pool = new pg.Pool({
      host: server.host,
      port: server.port,
      user: "postgres",
      database: "template1",
      max: 4,
    });

    try {
      const [c1, c2] = await Promise.all([pool.connect(), pool.connect()]);
      try {
        const [r1, r2] = await Promise.all([
          c1.query({
            name: "S_1",
            text: "SELECT $1::text AS tag, count(*)::int AS cnt FROM pg_tables WHERE schemaname = 'public'",
            values: ["conn-1"],
          }),
          c2.query({
            name: "S_1",
            text: "SELECT $1::int + $2::int AS sum_val",
            values: [19, 23],
          }),
        ]);

        expect(r1.rows[0]?.tag).toBe("conn-1");
        expect(r1.rows[0]?.cnt).toBeGreaterThanOrEqual(11);
        expect(r2.rows[0]?.sum_val).toBe(42);
      } finally {
        c1.release();
        c2.release();
      }
    } finally {
      await pool.end();
    }
  });

  it("pins active transactions to the owning connection and auto-rolls back on abrupt disconnect", async () => {
    const txClient = new pg.Client({
      host: server.host,
      port: server.port,
      user: "postgres",
      database: "template1",
    });
    const readerClient = new pg.Client({
      host: server.host,
      port: server.port,
      user: "postgres",
      database: "template1",
    });

    txClient.on("error", () => {});
    await txClient.connect();
    await readerClient.connect();

    try {
      await txClient.query("BEGIN");
      await txClient.query(
        "INSERT INTO users (id, email, display_name) VALUES ('usr_uncommitted', 'temp@openhuddle.dev', 'Temp')",
      );

      // 另一连接发起的查询必须排队等待当前事务结束，不能插队读取未提交脏状态或破坏当前事务
      let readerResolved = false;
      const pendingRead = readerClient
        .query("SELECT id FROM users WHERE id = 'usr_uncommitted'")
        .then((res) => {
          readerResolved = true;
          return res;
        });

      await new Promise((r) => setTimeout(r, 30));
      expect(readerResolved).toBe(false);

      // 模拟持有未提交事务的客户端异常断连：服务端应自动执行 ROLLBACK 并唤醒挂起连接
      const rawStream = (txClient as unknown as { connection?: { stream?: net.Socket } }).connection
        ?.stream;
      rawStream?.destroy();

      const readAfterRollback = await pendingRead;
      expect(readAfterRollback.rowCount).toBe(0);
    } finally {
      await readerClient.end().catch(() => {});
      await txClient.end().catch(() => {});
    }
  });
});
