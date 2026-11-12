/**
 * @module server/modules/system/routes
 * @description 平台健康探针与运行时拓扑自检 OpenAPI 路由模块。
 *
 * 架构职责与关键不变量（Invariants）：
 * 路由层仅做 OpenAPI 契约绑定与状态返回，供容器编排（Docker Healthcheck / Caddy）与联调面板探测服务就绪度。
 */
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";

/**
 * 系统探针响应负载 Schema。
 */
export const HealthResponseSchema = z.object({
  ok: z.literal(true),
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
  summary: "Check server, database driver, and realtime bus readiness",
  responses: {
    200: {
      description: "Service is healthy and ready to accept connections",
      content: {
        "application/json": {
          schema: HealthResponseSchema,
        },
      },
    },
  },
});

/**
 * 创建系统自检子路由器。
 *
 * @param meta - 当前实例激活的数据库与事件总线驱动标识
 * @returns 挂载了 `/health` OpenAPI 路由的子应用
 */
export function createSystemRouter(meta: {
  readonly databaseDriver: "pglite" | "postgres";
  readonly realtimeBusDriver: "memory" | "postgres";
}): OpenAPIHono {
  const router = new OpenAPIHono();

  router.openapi(healthRoute, (c) => {
    return c.json(
      {
        ok: true as const,
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
