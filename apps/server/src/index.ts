import { realpathSync } from "node:fs";
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
import { createDatabaseClient, ensureCoreSchema } from "@openhuddle/db";
import { createServerApp } from "./app.js";
import { parseServerEnv } from "./infra/env.js";
import { createRootLogger } from "./infra/logger.js";
import { PostgresListenNotifyBus } from "./infra/postgres-bus.js";
import { InMemoryRealtimeBus, type RealtimeBus } from "./infra/realtime-bus.js";

/**
 * 引导并运行服务端主进程。
 */
export async function startServer(): Promise<void> {
  const env = parseServerEnv();
  const logger = createRootLogger(env.LOG_LEVEL);

  const database = createDatabaseClient({ url: env.DATABASE_URL });
  await ensureCoreSchema(database.db);

  let realtimeBus: RealtimeBus;
  if (env.REALTIME_BUS_DRIVER === "postgres" && database.pgPool !== undefined) {
    const pgBus = new PostgresListenNotifyBus({
      pool: database.pgPool,
      logger,
    });
    await pgBus.start();
    realtimeBus = pgBus;
  } else {
    if (env.REALTIME_BUS_DRIVER === "postgres" && database.pgPool === undefined) {
      logger.warn(
        { databaseDriver: database.driver },
        "REALTIME_BUS_DRIVER=postgres requested without pg.Pool; falling back to InMemoryRealtimeBus",
      );
    }
    realtimeBus = new InMemoryRealtimeBus();
  }

  const app = createServerApp({ env, database, realtimeBus });

  const server = serve(
    {
      fetch: app.fetch,
      port: env.PORT,
    },
    (info) => {
      logger.info(
        {
          port: info.port,
          databaseDriver: database.driver,
          realtimeBusDriver: env.REALTIME_BUS_DRIVER,
          docsUrl: `${env.PUBLIC_BASE_URL}/api/docs`,
        },
        "OpenHuddle server listening",
      );
    },
  );

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "Shutting down OpenHuddle server gracefully...");
    server.close();
    await realtimeBus.close();
    await database.close();
    process.exit(0);
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
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
  void startServer();
}
