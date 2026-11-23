/**
 * @module db/serve-cli
 * @description 本地 PGlite 独立 TCP 数据库服务命令行入口（`pnpm db:serve`）。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 路径确定性：默认定位至服务端本地嵌入式数据目录 `apps/server/.data/pglite`，无论从仓库根目录还是子包目录执行均指向同一份本地数据。
 * 2. 单写者防冲突保护：启动时写入进程级锁文件并探测存活 PID，防止多个独立服务进程同时挂载同一份 PGlite `PGDATA` 目录导致 WAL 损坏。
 * 3. 优雅刷盘退出：捕获 `SIGINT` / `SIGTERM` 后先断开客户端连接并等待 `pglite.close()` 完整同步文件系统，再清理锁文件退出。
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startPgliteSocketServer } from "./pglite-server.js";

const cliDir = dirname(fileURLToPath(import.meta.url));
const defaultDataDir = resolve(cliDir, "../../../apps/server/.data/pglite");

interface CliOptions {
  readonly dataDir: string;
  readonly host: string;
  readonly port: number;
  readonly showHelp: boolean;
}

/**
 * 解析命令行参数与环境变量。
 */
function parseCliArgs(argv: readonly string[]): CliOptions {
  let envDataDir = defaultDataDir;
  const rawDbUrl = process.env.DATABASE_URL;
  if (rawDbUrl?.startsWith("file://")) {
    envDataDir = resolve(process.cwd(), rawDbUrl.slice("file://".length));
  }

  let dataDir = envDataDir;
  let host = process.env.PGLITE_HOST ?? "127.0.0.1";
  let port = Number.parseInt(process.env.PGLITE_PORT ?? "5432", 10);
  let showHelp = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg || arg === "--") {
      continue;
    }
    if (arg === "--help") {
      showHelp = true;
      continue;
    }
    if (arg === "--db" || arg === "-d") {
      const next = argv[i + 1];
      if (!next) {
        throw new Error(`Missing value for ${arg}`);
      }
      dataDir = next === "memory://" ? next : resolve(process.cwd(), next);
      i += 1;
      continue;
    }
    if (arg.startsWith("--db=")) {
      const val = arg.slice("--db=".length);
      dataDir = val === "memory://" ? val : resolve(process.cwd(), val);
      continue;
    }
    if (arg === "--host" || arg === "-h") {
      const next = argv[i + 1];
      if (!next) {
        throw new Error(`Missing value for ${arg}`);
      }
      host = next;
      i += 1;
      continue;
    }
    if (arg.startsWith("--host=")) {
      host = arg.slice("--host=".length);
      continue;
    }
    if (arg === "--port" || arg === "-p") {
      const next = argv[i + 1];
      if (!next) {
        throw new Error(`Missing value for ${arg}`);
      }
      port = Number.parseInt(next, 10);
      i += 1;
      continue;
    }
    if (arg.startsWith("--port=")) {
      port = Number.parseInt(arg.slice("--port=".length), 10);
      continue;
    }
    throw new Error(`Unknown argument: "${arg}". Run with --help for usage.`);
  }

  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`Invalid port number: "${String(port)}". Expected 0..65535.`);
  }

  return { dataDir, host, port, showHelp };
}

/**
 * 检查目标 PID 是否仍在当前操作系统存活。
 */
function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 为本地持久化 PGlite 目录获取单进程互斥锁文件。
 */
function acquirePidLock(dataDir: string): () => void {
  if (dataDir === "memory://") {
    return () => {};
  }
  mkdirSync(dataDir, { recursive: true });
  // PGlite 首次初始化要求 PGDATA 为空。将锁放在真实目录旁边，避免别名绕过同一把锁。
  const lockPath = `${realpathSync(dataDir)}.openhuddle-db-serve.pid`;
  if (existsSync(lockPath)) {
    const existingPid = Number.parseInt(readFileSync(lockPath, "utf8").trim(), 10);
    if (existingPid !== process.pid && isPidAlive(existingPid)) {
      throw new Error(
        `PGlite directory is already served by running process PID ${existingPid} (${lockPath}).`,
      );
    }
  }
  writeFileSync(lockPath, `${process.pid}\n`, "utf8");
  return () => {
    try {
      rmSync(lockPath, { force: true });
    } catch {
      // 忽略退出阶段的清理异常
    }
  };
}

/**
 * 启动独立 PGlite CLI 守护循环。
 */
async function main(): Promise<void> {
  const options = parseCliArgs(process.argv.slice(2));
  if (options.showHelp) {
    process.stdout.write(
      [
        "Usage: pnpm db:serve [-- [--port 5432] [--host 127.0.0.1] [--db <path>]]",
        "",
        "Options:",
        `  -d, --db <path>    PGlite data directory (default: ${defaultDataDir})`,
        "  -p, --port <port>  TCP port to listen on (default: 5432)",
        "  -h, --host <host>  Bind host address (default: 127.0.0.1)",
        "      --help         Show this help message",
        "",
      ].join("\n"),
    );
    return;
  }

  const releaseLock = acquirePidLock(options.dataDir);
  let serverHandle: Awaited<ReturnType<typeof startPgliteSocketServer>> | undefined;

  try {
    serverHandle = await startPgliteSocketServer({
      dataDir: options.dataDir,
      host: options.host,
      port: options.port,
      bootstrapSchema: true,
    });
  } catch (err) {
    releaseLock();
    throw err;
  }

  process.stdout.write(
    [
      "",
      "OpenHuddle PGlite TCP Server is listening!",
      `  Data Dir : ${options.dataDir}`,
      `  Host     : ${serverHandle.host}`,
      `  Port     : ${serverHandle.port}`,
      "  Database : template1",
      "  User     : postgres (no password required)",
      `  JDBC URL : ${serverHandle.jdbcUrl}`,
      `  Conn URI : ${serverHandle.connectionUri}`,
      "",
      "Tip: Do not run default `file://` `pnpm dev` at the same time.",
      `     To run the dev server alongside DataGrip, use: DATABASE_URL="${serverHandle.connectionUri}" pnpm dev`,
      "Press Ctrl+C to flush WAL and stop.",
      "",
    ].join("\n"),
  );

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    process.stdout.write(`\nReceived ${signal}, flushing PGlite and closing socket server...\n`);
    try {
      if (serverHandle) {
        await serverHandle.close();
      }
    } finally {
      releaseLock();
    }
    process.exit(0);
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[db:serve] Failed to start PGlite TCP server: ${message}\n`);
  process.exit(1);
});
