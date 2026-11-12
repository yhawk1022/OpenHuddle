/**
 * @module server/index
 * @description OpenHuddle Node.js 进程启动入口与优雅停机（Graceful Shutdown）生命周期管理。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 启动前自动执行幂等 `ensureCoreSchema`，确保本地嵌入式 PGlite 或新数据库首次拉起即可直接使用。
 * 2. 监听 `SIGINT` / `SIGTERM` 信号，依序停止接收新 HTTP 请求、关闭实时总线订阅并排空数据库连接池。
 */
import { serve } from "@hono/node-server";
import { createDatabaseClient, ensureCoreSchema } from "@openhuddle/db";
import { createServerApp } from "./app.js";
import { parseServerEnv } from "./infra/env.js";
import { createRootLogger } from "./infra/logger.js";
import { InMemoryRealtimeBus } from "./infra/realtime-bus.js";

/**
 * 引导并运行服务端主进程。
 */
export async function startServer(): Promise<void> {
  const env = parseServerEnv();
  const logger = createRootLogger(env.LOG_LEVEL);

  const database = createDatabaseClient({ url: env.DATABASE_URL });
  await ensureCoreSchema(database.db);

  const realtimeBus = new InMemoryRealtimeBus();
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

// 仅当作为主入口直接执行时拉起端口监听，避免测试导入时产生副作用
if (import.meta.url === `file://${process.argv[1]}`) {
  void startServer();
}
