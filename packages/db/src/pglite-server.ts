/**
 * @module db/pglite-server
 * @description 基于内置 PGlite（PostgreSQL 16 WASM）的轻量级 PostgreSQL Wire Protocol v3 TCP 服务端。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 版本强一致与零额外依赖：直接复用工作区锁定的 `@electric-sql/pglite` 实例暴露标准 PostgreSQL 协议端口，避免外部 `npx` 工具链拉取高版本 PG 17 导致本地 `.data/pglite`（`PG_VERSION=16`）二进制不兼容。
 * 2. 握手与生命周期隔离：PGlite WASM 启动后已处于单会话 `PostgresMain` 就绪循环，因此必须在 Socket 层拦截处理 `SSLRequest`、`GSSENCRequest`、`CancelRequest`、`StartupMessage` 与 `Terminate ('X')`，严禁将连接握手包或退出指令直接透传进 WASM（否则会触发 `proc_exit` 导致实例崩溃）。
 * 3. 多连接安全复用（适配 DataGrip / `pgjdbc` / `pg.Pool`）：
 *    - 为每个 TCP 连接的非空命名预处理语句（`Parse` / `Bind` / `Describe` / `Close`）自动注入连接级前缀，彻底消除 DataGrip 多连接并发自增生成同名 `S_1` 时的命名冲突。
 *    - 严格解析后端 `ReadyForQuery ('Z')` 帧状态字节（`I` / `T` / `E`），当某连接持有未提交事务或处于扩展查询流水线中间态时锁定队列亲和性，并在客户端异常断连时自动回滚残留事务。
 */
import { mkdirSync } from "node:fs";
import net from "node:net";
import { dirname } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { ensureCoreSchema } from "./bootstrap.js";
import type { OpenHuddleDb } from "./client.js";
import * as schema from "./schema.js";

/** PostgreSQL Wire Protocol 常量定义 */
const PG_PROTOCOL_V3 = 0x0003_0000; // 196608
const SSL_REQUEST_CODE = 80_877_103;
const SSL_REQUEST_LEN = 8;
const GSSENC_REQUEST_CODE = 80_877_104;
const GSSENC_REQUEST_LEN = 8;
const CANCEL_REQUEST_CODE = 80_877_102;
const CANCEL_REQUEST_LEN = 16;

const MSG_PARSE = 0x50; // 'P'
const MSG_BIND = 0x42; // 'B'
const MSG_DESCRIBE = 0x44; // 'D'
const MSG_CLOSE = 0x43; // 'C'
const MSG_EXECUTE = 0x45; // 'E'
const MSG_FLUSH = 0x48; // 'H'
const MSG_SYNC = 0x53; // 'S'
const MSG_QUERY = 0x51; // 'Q'
const MSG_TERMINATE = 0x58; // 'X'
const MSG_READY_FOR_QUERY = 0x5a; // 'Z'

/**
 * 启动本地 PGlite TCP 服务的配置项。
 */
export interface PgliteSocketServerOptions {
  /**
   * PGlite 数据目录路径，或 `"memory://"`（用于单测隔离）。
   */
  readonly dataDir: string;
  /** 监听主机地址（默认 `"127.0.0.1"`，仅暴露本机回环以保证开发安全） */
  readonly host?: string;
  /** 监听 TCP 端口（默认 `5432`；传 `0` 由操作系统分配空闲端口） */
  readonly port?: number;
  /** 启动时是否自动幂等初始化 OpenHuddle 核心表结构（默认 `true`） */
  readonly bootstrapSchema?: boolean;
}

/**
 * 运行中的 PGlite TCP 服务受控句柄。
 */
export interface ManagedPgliteSocketServer {
  /** 实际绑定的监听地址 */
  readonly host: string;
  /** 实际绑定的监听端口 */
  readonly port: number;
  /** 标准 PostgreSQL 连接串（可供服务端或 CLI 工具使用） */
  readonly connectionUri: string;
  /** JDBC 连接串（可直接粘贴至 DataGrip / IntelliJ Database） */
  readonly jdbcUrl: string;
  /** 优雅关闭所有客户端 Socket、排空队列并刷盘关闭底层 PGlite */
  readonly close: () => Promise<void>;
}

interface QueuedBatch {
  readonly connId: number;
  readonly payload: Uint8Array;
  readonly marksExtendedPipeline: boolean;
  readonly clearsExtendedPipeline: boolean;
  readonly onResponse: (bytes: Uint8Array) => void;
  readonly resolve: () => void;
  readonly reject: (err: Error) => void;
}

/**
 * 编码单条后端 `ParameterStatus ('S')` 消息帧。
 */
function encodeParameterStatus(key: string, value: string): Buffer {
  const body = Buffer.concat([
    Buffer.from(key, "utf8"),
    Buffer.from([0]),
    Buffer.from(value, "utf8"),
    Buffer.from([0]),
  ]);
  const header = Buffer.alloc(5);
  header[0] = 0x53; // 'S'
  header.writeInt32BE(4 + body.length, 1);
  return Buffer.concat([header, body]);
}

/**
 * 构造客户端完成 `StartupMessage` 后的免密握手响应包。
 */
function buildStartupHandshakeReply(connId: number): Buffer {
  const authOk = Buffer.from([0x52, 0, 0, 0, 8, 0, 0, 0, 0]);
  const backendKey = Buffer.alloc(13);
  backendKey[0] = 0x4b; // 'K'
  backendKey.writeInt32BE(12, 1);
  backendKey.writeInt32BE(connId, 5);
  backendKey.writeInt32BE(0x6f68_7067, 9);
  const readyForQuery = Buffer.from([MSG_READY_FOR_QUERY, 0, 0, 0, 5, 0x49]); // 'I'

  return Buffer.concat([
    authOk,
    encodeParameterStatus("server_version", "16.4"),
    encodeParameterStatus("server_encoding", "UTF8"),
    encodeParameterStatus("client_encoding", "UTF8"),
    encodeParameterStatus("DateStyle", "ISO, MDY"),
    encodeParameterStatus("TimeZone", "UTC"),
    encodeParameterStatus("IntervalStyle", "postgres"),
    encodeParameterStatus("integer_datetimes", "on"),
    encodeParameterStatus("standard_conforming_strings", "on"),
    encodeParameterStatus("is_superuser", "on"),
    encodeParameterStatus("session_authorization", "postgres"),
    encodeParameterStatus("in_hot_standby", "off"),
    backendKey,
    readyForQuery,
  ]);
}

/**
 * 构造单条 Simple Query（`'Q'`）协议帧（用于断连自动 `ROLLBACK`）。
 */
function buildSimpleQueryFrame(sqlText: string): Uint8Array {
  const sqlBytes = Buffer.from(`${sqlText}\0`, "utf8");
  const frame = Buffer.alloc(1 + 4 + sqlBytes.length);
  frame[0] = MSG_QUERY;
  frame.writeInt32BE(4 + sqlBytes.length, 1);
  sqlBytes.copy(frame, 5);
  return new Uint8Array(frame);
}

/**
 * 从字节缓冲区指定偏移读取以 `\0` 结尾的 UTF-8 C 字符串。
 */
function readCString(
  buf: Buffer,
  offset: number,
): { readonly value: string; readonly nextOffset: number } | null {
  const zeroIdx = buf.indexOf(0, offset);
  if (zeroIdx === -1) {
    return null;
  }
  return {
    value: buf.subarray(offset, zeroIdx).toString("utf8"),
    nextOffset: zeroIdx + 1,
  };
}

/**
 * 为非空语句名或游标名追加连接级隔离前缀，防止多连接共享单 PGlite 会话时发生 `S_1` 命名冲突。
 * 空字符串（匿名语句/匿名 Portal）按 PostgreSQL 协议规范必须保持为空。
 */
function scopeStatementOrPortalName(connId: number, rawName: string): string {
  if (rawName.length === 0) {
    return "";
  }
  const scoped = `c${connId}_${rawName}`;
  // PostgreSQL NAMEDATALEN 默认上限为 63 字节
  return Buffer.byteLength(scoped, "utf8") <= 63 ? scoped : scoped.slice(0, 63);
}

/**
 * 重写单条前端消息中的命名 Prepared Statement / Portal 标识符。
 */
function rewriteFrontendMessageScope(connId: number, frame: Buffer): Buffer {
  const msgType = frame[0];
  if (msgType === MSG_PARSE) {
    const stmt = readCString(frame, 5);
    if (!stmt || stmt.value.length === 0) {
      return frame;
    }
    const scopedBytes = Buffer.from(`${scopeStatementOrPortalName(connId, stmt.value)}\0`, "utf8");
    const rest = frame.subarray(stmt.nextOffset);
    const out = Buffer.alloc(1 + 4 + scopedBytes.length + rest.length);
    out[0] = MSG_PARSE;
    out.writeInt32BE(4 + scopedBytes.length + rest.length, 1);
    scopedBytes.copy(out, 5);
    rest.copy(out, 5 + scopedBytes.length);
    return out;
  }

  if (msgType === MSG_BIND) {
    const portal = readCString(frame, 5);
    if (!portal) {
      return frame;
    }
    const stmt = readCString(frame, portal.nextOffset);
    if (!stmt || (portal.value.length === 0 && stmt.value.length === 0)) {
      return frame;
    }
    const scopedPortalBytes = Buffer.from(
      `${scopeStatementOrPortalName(connId, portal.value)}\0`,
      "utf8",
    );
    const scopedStmtBytes = Buffer.from(
      `${scopeStatementOrPortalName(connId, stmt.value)}\0`,
      "utf8",
    );
    const rest = frame.subarray(stmt.nextOffset);
    const bodyLen = scopedPortalBytes.length + scopedStmtBytes.length + rest.length;
    const out = Buffer.alloc(1 + 4 + bodyLen);
    out[0] = MSG_BIND;
    out.writeInt32BE(4 + bodyLen, 1);
    scopedPortalBytes.copy(out, 5);
    scopedStmtBytes.copy(out, 5 + scopedPortalBytes.length);
    rest.copy(out, 5 + scopedPortalBytes.length + scopedStmtBytes.length);
    return out;
  }

  if (msgType === MSG_DESCRIBE || msgType === MSG_CLOSE) {
    if (frame.length < 7) {
      return frame;
    }
    const targetKind = frame[5];
    if (targetKind === undefined) {
      return frame;
    }
    const name = readCString(frame, 6);
    if (!name || name.value.length === 0) {
      return frame;
    }
    const scopedBytes = Buffer.from(`${scopeStatementOrPortalName(connId, name.value)}\0`, "utf8");
    const out = Buffer.alloc(1 + 4 + 1 + scopedBytes.length);
    out[0] = msgType;
    out.writeInt32BE(4 + 1 + scopedBytes.length, 1);
    out[5] = targetKind;
    scopedBytes.copy(out, 6);
    return out;
  }

  return frame;
}

/**
 * 按标准后端消息帧边界解析响应包中最后一个 `ReadyForQuery ('Z')` 的事务状态指示符。
 */
function extractLastReadyForQueryStatus(buf: Uint8Array): "I" | "T" | "E" | null {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let offset = 0;
  let lastStatus: "I" | "T" | "E" | null = null;

  while (offset + 5 <= buf.byteLength) {
    const msgType = buf[offset];
    const msgLen = view.getInt32(offset + 1, false);
    if (msgLen < 4 || offset + 1 + msgLen > buf.byteLength) {
      break;
    }
    if (msgType === MSG_READY_FOR_QUERY && msgLen === 5) {
      const indicator = buf[offset + 5];
      if (indicator === 0x49) {
        lastStatus = "I";
      } else if (indicator === 0x54) {
        lastStatus = "T";
      } else if (indicator === 0x45) {
        lastStatus = "E";
      }
    }
    offset += 1 + msgLen;
  }

  return lastStatus;
}

/**
 * 单底层 PGlite 实例上的事务感知串行调度器。
 */
class PgliteProtocolMultiplexer {
  private readonly queue: QueuedBatch[] = [];
  private processing = false;
  /** 当前持有未提交事务或未完成扩展查询流水线的连接 ID */
  private pinnedConnId: number | null = null;
  private inOpenTransaction = false;

  public constructor(private readonly pglite: PGlite) {}

  public enqueue(batch: Omit<QueuedBatch, "resolve" | "reject">): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.queue.push({ ...batch, resolve, reject });
      void this.drain();
    });
  }

  /**
   * 当客户端断开连接时清理其排队请求；若该连接持有未提交事务则自动执行 `ROLLBACK` 释放会话锁。
   */
  public async handleClientDisconnect(connId: number): Promise<void> {
    for (let i = this.queue.length - 1; i >= 0; i -= 1) {
      const item = this.queue[i];
      if (item && item.connId === connId) {
        this.queue.splice(i, 1);
        item.reject(new Error(`Client #${connId} disconnected`));
      }
    }

    if (this.pinnedConnId === connId) {
      await this.pglite.runExclusive(async () => {
        if (this.inOpenTransaction) {
          await this.pglite.execProtocolRaw(buildSimpleQueryFrame("ROLLBACK"));
        } else {
          // 同步冲洗可能残留的扩展查询半包状态
          await this.pglite.execProtocolRaw(new Uint8Array([MSG_SYNC, 0, 0, 0, 4]));
        }
      });
      this.pinnedConnId = null;
      this.inOpenTransaction = false;
      void this.drain();
    }
  }

  private async drain(): Promise<void> {
    if (this.processing) {
      return;
    }
    this.processing = true;

    try {
      while (this.queue.length > 0) {
        let targetIdx = 0;
        if (this.pinnedConnId !== null) {
          targetIdx = this.queue.findIndex((item) => item.connId === this.pinnedConnId);
          if (targetIdx === -1) {
            // 持有事务/流水线的连接尚未发来后续语句，暂停消费其他连接以防串会话
            break;
          }
        }

        const next = this.queue.splice(targetIdx, 1)[0];
        if (!next) {
          break;
        }

        try {
          const responseCopy = await this.pglite.runExclusive(async () => {
            const raw = await this.pglite.execProtocolRaw(next.payload);
            // 关键内存不变量：`execProtocolRaw` 返回 `HEAPU8.subarray` 视图，必须在下次 WASM 调用前深拷贝
            return new Uint8Array(raw);
          });

          const rfqStatus = extractLastReadyForQueryStatus(responseCopy);
          if (rfqStatus === "T" || rfqStatus === "E") {
            this.pinnedConnId = next.connId;
            this.inOpenTransaction = true;
          } else if (rfqStatus === "I") {
            this.pinnedConnId = null;
            this.inOpenTransaction = false;
          } else if (next.marksExtendedPipeline && !next.clearsExtendedPipeline) {
            this.pinnedConnId = next.connId;
          }

          next.onResponse(responseCopy);
          next.resolve();
        } catch (err) {
          const wrapped = err instanceof Error ? err : new Error(String(err));
          next.reject(wrapped);
        }
      }
    } finally {
      this.processing = false;
    }
  }
}

/**
 * 启动基于本地 PGlite 的 PostgreSQL Wire Protocol TCP 服务。
 *
 * @param options - 数据目录、监听地址与端口配置
 * @returns 包含监听端口、DataGrip JDBC 地址及 `close()` 方法的受控实例
 * @throws {Error} 当端口占用或底层 PGlite 初始化失败时抛出
 */
export async function startPgliteSocketServer(
  options: Readonly<PgliteSocketServerOptions>,
): Promise<ManagedPgliteSocketServer> {
  const host = options.host ?? "127.0.0.1";
  const requestedPort = options.port ?? 5432;
  const bootstrapSchema = options.bootstrapSchema ?? true;

  if (options.dataDir !== "memory://") {
    mkdirSync(dirname(options.dataDir), { recursive: true });
  }

  const pglite = options.dataDir === "memory://" ? new PGlite() : new PGlite(options.dataDir);
  await pglite.waitReady;

  if (bootstrapSchema) {
    const drizzleDb = drizzlePglite(pglite, { schema }) as unknown as OpenHuddleDb;
    await ensureCoreSchema(drizzleDb);
  }

  const multiplexer = new PgliteProtocolMultiplexer(pglite);
  const activeSockets = new Set<net.Socket>();
  let nextConnId = 1;
  let closing = false;

  const server = net.createServer((socket) => {
    if (closing) {
      socket.destroy();
      return;
    }

    const connId = nextConnId;
    nextConnId += 1;
    activeSockets.add(socket);
    socket.setNoDelay(true);

    let handshakeCompleted = false;
    let terminated = false;
    const isTerminated = (): boolean => terminated;
    let buffer = Buffer.alloc(0);
    let processingSocket = false;

    const processBufferedFrames = async (): Promise<void> => {
      if (processingSocket || isTerminated()) {
        return;
      }
      processingSocket = true;

      try {
        while (buffer.length > 0 && !isTerminated()) {
          if (!handshakeCompleted) {
            if (buffer.length < 8) {
              break;
            }
            const packetLen = buffer.readInt32BE(0);
            const code = buffer.readInt32BE(4);

            // 1. SSL 协商请求（DataGrip / pgjdbc 默认首包）：回复 'N' 回退明文连接
            if (packetLen === SSL_REQUEST_LEN && code === SSL_REQUEST_CODE) {
              buffer = buffer.subarray(SSL_REQUEST_LEN);
              if (socket.writable) {
                socket.write("N");
              }
              continue;
            }

            // 2. GSSAPI 加密协商请求：回复 'N'
            if (packetLen === GSSENC_REQUEST_LEN && code === GSSENC_REQUEST_CODE) {
              buffer = buffer.subarray(GSSENC_REQUEST_LEN);
              if (socket.writable) {
                socket.write("N");
              }
              continue;
            }

            // 3. 查询取消请求（独立短连接）：静默消费并关闭该临时 Socket
            if (packetLen === CANCEL_REQUEST_LEN && code === CANCEL_REQUEST_CODE) {
              buffer = buffer.subarray(CANCEL_REQUEST_LEN);
              terminated = true;
              socket.end();
              break;
            }

            if (packetLen < 8 || code !== PG_PROTOCOL_V3) {
              terminated = true;
              socket.destroy();
              break;
            }

            if (buffer.length < packetLen) {
              break;
            }

            // 消费完整 StartupMessage 并直接在 Socket 层返回免密就绪握手
            buffer = buffer.subarray(packetLen);
            handshakeCompleted = true;
            if (socket.writable) {
              socket.write(buildStartupHandshakeReply(connId));
            }
            continue;
          }

          // 已完成握手：聚合当前缓冲区内所有完整前端消息帧
          if (buffer.length < 5) {
            break;
          }

          const rewrittenFrames: Buffer[] = [];
          let marksExtendedPipeline = false;
          let clearsExtendedPipeline = false;
          let sawTerminate = false;

          while (buffer.length >= 5) {
            const msgType = buffer[0];
            const msgLen = buffer.readInt32BE(1);
            if (msgType === undefined || msgLen < 4) {
              terminated = true;
              socket.destroy();
              return;
            }
            const frameTotal = 1 + msgLen;
            if (buffer.length < frameTotal) {
              break;
            }

            const rawFrame = buffer.subarray(0, frameTotal);
            buffer = buffer.subarray(frameTotal);

            // 拦截客户端正常断开指令 'X'，严禁送入 WASM 以免触发后端进程退出
            if (msgType === MSG_TERMINATE) {
              sawTerminate = true;
              break;
            }

            if (
              msgType === MSG_PARSE ||
              msgType === MSG_BIND ||
              msgType === MSG_DESCRIBE ||
              msgType === MSG_EXECUTE ||
              msgType === MSG_CLOSE ||
              msgType === MSG_FLUSH
            ) {
              marksExtendedPipeline = true;
            }
            if (msgType === MSG_SYNC || msgType === MSG_QUERY) {
              clearsExtendedPipeline = true;
            }

            rewrittenFrames.push(rewriteFrontendMessageScope(connId, rawFrame));

            // 遇到同步边界（Sync 或 Simple Query）先作为一批提交，以便及时更新事务状态位
            if (msgType === MSG_SYNC || msgType === MSG_QUERY) {
              break;
            }
          }

          if (rewrittenFrames.length > 0) {
            const combined = Buffer.concat(rewrittenFrames);
            await multiplexer.enqueue({
              connId,
              payload: new Uint8Array(combined),
              marksExtendedPipeline,
              clearsExtendedPipeline,
              onResponse: (bytes) => {
                if (bytes.byteLength > 0 && socket.writable) {
                  socket.write(Buffer.from(bytes));
                }
              },
            });
          } else if (!sawTerminate) {
            // 缓冲区内仅有半包，等待后续 TCP 分片到达
            break;
          }

          if (sawTerminate) {
            terminated = true;
            await multiplexer.handleClientDisconnect(connId);
            socket.end();
            break;
          }
        }
      } catch {
        terminated = true;
        socket.destroy();
      } finally {
        processingSocket = false;
      }
    };

    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      void processBufferedFrames();
    });

    const cleanup = (): void => {
      activeSockets.delete(socket);
      terminated = true;
      void multiplexer.handleClientDisconnect(connId);
    };

    socket.on("close", cleanup);
    socket.on("error", cleanup);
  });

  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => {
        server.off("listening", onListening);
        reject(err);
      };
      const onListening = (): void => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(requestedPort, host);
    });
  } catch (err) {
    await pglite.close();
    throw err;
  }

  const addr = server.address();
  if (!addr || typeof addr === "string") {
    await pglite.close();
    throw new Error("Expected TCP AddressInfo from net.Server");
  }

  const boundPort = addr.port;
  const connectionUri = `postgresql://postgres@${host}:${boundPort}/template1?sslmode=disable`;
  const jdbcUrl = `jdbc:postgresql://${host}:${boundPort}/template1`;

  return {
    host,
    port: boundPort,
    connectionUri,
    jdbcUrl,
    close: async () => {
      if (closing) {
        return;
      }
      closing = true;
      for (const socket of activeSockets) {
        socket.destroy();
      }
      activeSockets.clear();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      await pglite.close();
    },
  };
}
