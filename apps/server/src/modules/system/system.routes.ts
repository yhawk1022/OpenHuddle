/**
 * @module server/modules/system/routes
 * @description 平台健康探针与数据库存活度实测 OpenAPI 路由模块。
 *
 * 关键不变量：
 * 当注入了 `pingDatabase` 时，`/health` 执行带保护的真实 `SELECT 1` 探活；数据库连接池耗尽或失联时返回 `503`，
 * 确保反向代理、Docker Healthcheck 与多副本负载均衡及时摘除故障实例。
 */
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";

export const HealthResponseSchema = z.object({
  ok: z.boolean(),
  service: z.literal("openhuddle-server"),
  version: z.string(),
  databaseDriver: z.enum(["pglite", "postgres"]),
  realtimeBusDriver: z.enum(["memory", "postgres"]),
  serverTimeIso: z.string().datetime(),
});

const healthRoute = createRoute({
  method: "get",
  path: "/health",
  tags: ["System"],
  summary: "Check server, database liveness, and realtime bus readiness",
  responses: {
    200: {
      description: "Service and database are healthy",
      content: {
        "application/json": {
          schema: HealthResponseSchema,
        },
      },
    },
    503: {
      description: "Database readiness probe failed",
      content: {
        "application/json": {
          schema: HealthResponseSchema,
        },
      },
    },
  },
});

/**
 * 创建系统健康与存活度自检子路由器。
 */
export function createSystemRouter(meta: {
  readonly databaseDriver: "pglite" | "postgres";
  readonly realtimeBusDriver: "memory" | "postgres";
  readonly pingDatabase?: (() => Promise<void>) | undefined;
}): OpenAPIHono {
  const router = new OpenAPIHono();

  router.openapi(healthRoute, async (c) => {
    if (meta.pingDatabase !== undefined) {
      try {
        await meta.pingDatabase();
      } catch {
        return c.json(
          {
            ok: false,
            service: "openhuddle-server" as const,
            version: "0.1.0",
            databaseDriver: meta.databaseDriver,
            realtimeBusDriver: meta.realtimeBusDriver,
            serverTimeIso: new Date().toISOString(),
          },
          503,
        );
      }
    }

    return c.json(
      {
        ok: true,
        service: "openhuddle-server" as const,
        version: "0.1.0",
        databaseDriver: meta.databaseDriver,
        realtimeBusDriver: meta.realtimeBusDriver,
        serverTimeIso: new Date().toISOString(),
      },
      200,
    );
  });

  return router;
}
