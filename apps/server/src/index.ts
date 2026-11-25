import { realpathSync } from "node:fs";
import net from "node:net";
import { pathToFileURL } from "node:url";
/**
 * @module server/index
 * @description OpenHuddle Node.js 进程启动入口、实时事件总线自动选型（`InMemory` / `PostgreSQL LISTEN/NOTIFY`）与优雅停机生命周期管理。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 启动前自动执行幂等 `ensureCoreSchema`，确保本地嵌入式 PGlite 或生产 PostgreSQL 首次拉起即可直接使用。
 * 2. 2C4G 免 Redis 弹性：当 `REALTIME_BUS_DRIVER === "postgres"` 且底层连接池就绪时自动启用 `PostgresListenNotifyBus` 跨进程广播，否则回退轻量进程内 `InMemoryRealtimeBus`。
 * 3. 监听 `SIGINT` / `SIGTERM` 信号，依序停止接收新 HTTP 请求、关闭实时总线订阅并排空数据库连接池。
 */
import { serve } from "@hono/node-server";
import type { ManagedDatabase } from "@openhuddle/db";
import { createServerApp, stopServerAppBackgroundTasks } from "./app.js";
import { parseServerEnv } from "./infra/env.js";
import {
  type PgliteSnapshotScheduler,
  openDatabaseWithLocalRecovery,
  startPgliteSnapshotScheduler,
} from "./infra/local-pglite-guard.js";
import { createRootLogger } from "./infra/logger.js";
import { PostgresListenNotifyBus } from "./infra/postgres-bus.js";
import { InMemoryRealtimeBus, type RealtimeBus } from "./infra/realtime-bus.js";
import { startWorkLeaseReaper } from "./modules/workspaces/work-lease-reaper.js";
import { WorkspacesRepository } from "./modules/workspaces/workspaces.repo.js";
import { WorkspacesService } from "./modules/workspaces/workspaces.service.js";

const DEV_PORT_RELEASE_WAIT_MS = 3_000;
/**
 * 停机时上层任务的排空上限。`tsx watch` 在上一个子进程未退出时再次触发重跑会直接 `SIGKILL`，
 * 强杀发生在 PGlite 写盘途中会损坏数据目录，所以这里尽量短，优先保证数据库正常关闭。
 */
const SHUTDOWN_DRAIN_TIMEOUT_MS = 300;
/** 停机信号到达时若仍在启动，最多等待启动完成的毫秒数（低于 tsx 的 5 秒强杀阈值） */
const STARTUP_SETTLE_TIMEOUT_MS = 3_000;

function probeLoopbackPortOnce(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const probe = net.createServer();
    probe.once("error", (err: NodeJS.ErrnoException) => {
      resolve(err.code !== "EADDRINUSE");
    });
    probe.listen(port, "127.0.0.1", () => {
      probe.close(() => resolve(true));
    });
  });
}

/**
 * 在绑定通配网卡（`0.0.0.0` / `::`）前预检 `127.0.0.1:<port>` 是否已被旧进程独占：
 * macOS/BSD 下 `0.0.0.0:3000` 可与既有 `127.0.0.1:3000` 并存而不抛 `EADDRINUSE`，导致本机反向代理流量被旧进程静默劫持。
 * 开发态兼容 `tsx watch` 热重载瞬态端口释放窗口，避免旧子进程退场瞬间误报冲突崩溃。
 */
async function assertLoopbackPortAvailable(
  host: string,
  port: number,
  waitMs: number,
): Promise<void> {
  if (host !== "0.0.0.0" && host !== "::") {
    return;
  }
  const deadline = Date.now() + Math.max(0, waitMs);
  for (;;) {
    const available = await probeLoopbackPortOnce(port);
    if (available) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Port ${String(port)} on 127.0.0.1 is already occupied by another process; stop the conflicting process before starting OpenHuddle.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
}

/**
 * 引导并运行服务端主进程。
 *
 * 停机信号在函数入口即注册：热重载可能在 PGlite 初始化或建表途中发来 `SIGTERM`，
 * 默认处理会立即退出并留下写到一半的数据目录。这里先等启动收尾，再按序关闭资源。
 */
export async function startServer(): Promise<void> {
  const env = parseServerEnv();
  const logger = createRootLogger(env.LOG_LEVEL);

  let database: ManagedDatabase | undefined;
  let server: ReturnType<typeof serve> | undefined;
  let stopBackground: (() => Promise<void>) | undefined;
  let snapshotScheduler: PgliteSnapshotScheduler | undefined;
  let markStartupSettled: () => void = () => undefined;
  const startupSettled = new Promise<void>((resolve) => {
    markStartupSettled = resolve;
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info({ signal }, "Shutting down OpenHuddle server gracefully...");
    await Promise.race([
      startupSettled,
      new Promise<void>((resolve) => setTimeout(resolve, STARTUP_SETTLE_TIMEOUT_MS)),
    ]);
    server?.close();
    await Promise.race([
      (async () => {
        await snapshotScheduler?.stop(SHUTDOWN_DRAIN_TIMEOUT_MS);
        await stopBackground?.();
      })(),
      new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_DRAIN_TIMEOUT_MS)),
    ]).catch(() => undefined);
    await database?.close().catch((err: unknown) => {
      logger.error({ err }, "Error while closing database during shutdown");
    });
    process.exit(0);
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGHUP", () => void shutdown("SIGHUP"));

  try {
    await assertLoopbackPortAvailable(
      env.HOST,
      env.PORT,
      env.NODE_ENV === "production" ? 0 : DEV_PORT_RELEASE_WAIT_MS,
    );

    const db = await openDatabaseWithLocalRecovery(env, logger);
    database = db;
    if (shuttingDown) {
      return;
    }

    let realtimeBus: RealtimeBus;
    if (env.REALTIME_BUS_DRIVER === "postgres" && db.pgPool !== undefined) {
      const pgBus = new PostgresListenNotifyBus({
        pool: db.pgPool,
        logger,
      });
      await pgBus.start();
      realtimeBus = pgBus;
    } else {
      if (env.REALTIME_BUS_DRIVER === "postgres" && db.pgPool === undefined) {
        logger.warn(
          { databaseDriver: db.driver },
          "REALTIME_BUS_DRIVER=postgres requested without pg.Pool; falling back to InMemoryRealtimeBus",
        );
      }
      realtimeBus = new InMemoryRealtimeBus();
    }

    const app = createServerApp({ env, database: db, realtimeBus });
    const leaseReaper = startWorkLeaseReaper({
      workspacesService: new WorkspacesService({
        repo: new WorkspacesRepository(db.db),
        realtimeBus,
        logger,
      }),
      logger,
    });
    stopBackground = async () => {
      await stopServerAppBackgroundTasks(app);
      await leaseReaper.stop();
      await realtimeBus.close();
    };

    server = serve(
      {
        fetch: app.fetch,
        port: env.PORT,
        hostname: env.HOST,
      },
      (info) => {
        logger.info(
          {
            host: env.HOST,
            port: info.port,
            databaseDriver: db.driver,
            realtimeBusDriver: env.REALTIME_BUS_DRIVER,
            docsUrl: `${env.PUBLIC_BASE_URL}/api/docs`,
          },
          "OpenHuddle server listening",
        );
      },
    );
    snapshotScheduler = startPgliteSnapshotScheduler(env, db, logger);
  } catch (err) {
    await database?.close().catch(() => undefined);
    throw err;
  } finally {
    markStartupSettled();
  }
}

// 仅当作为主入口直接执行时拉起端口监听，避免测试导入时产生副作用。
// 关键不变量：必须经 `realpathSync + pathToFileURL` 归一化比较——tsx 传相对路径
// （`src/index.ts`）或 macOS 符号链接路径（`/tmp` -> `/private/tmp`）时，
// 裸拼 `file://${process.argv[1]}` 与 `import.meta.url`（Node 自动解析真实路径）永不相等，
// 导致 `tsx watch src/index.ts` 静默空退出。
if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  startServer().catch((err: unknown) => {
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    process.stderr.write(`[openhuddle-server] Fatal startup error: ${message}\n`);
    process.exit(1);
  });
}
