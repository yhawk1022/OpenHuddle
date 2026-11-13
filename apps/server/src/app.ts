/**
 * @module server/app
 * @description OpenHuddle Hono 核心网关组装工厂（全局日志追踪、双层身份鉴权、全业务域路由挂载、OpenAPI `/api/docs`、外部 Agent 自举文档及单容器 SPA 静态托管）。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 依赖显式注入：通过 `AppDependencies` 注入数据库连接、实时事件总线与配置，使集成测试可在零端口监听模式下直接调用 `app.request()` 秒级自验。
 * 2. 单容器前后端合体服务：生产模式下直接安全托管 `apps/web/dist` 构建产物与 SPA History 回退，但任何 `/api/*` 未命中路径一律返回标准 JSON `404 NOT_FOUND`，绝不回退 HTML。
 * 3. 错误响应零内部泄漏：未知异常在生产模式下隐藏原始堆栈，仅回传标准 `INTERNAL_SERVER_ERROR` 与 `requestId`。
 */
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { ManagedDatabase } from "@openhuddle/db";
import type { ApiErrorEnvelope } from "@openhuddle/protocol";
import { Scalar } from "@scalar/hono-api-reference";
import { ZodError } from "zod";
import type { ServerEnv } from "./infra/env.js";
import { AppError } from "./infra/errors.js";
import { createRequestContextMiddleware, createRootLogger } from "./infra/logger.js";
import { createOpenApiRouter } from "./infra/openapi-router.js";
import type { RealtimeBus } from "./infra/realtime-bus.js";
import { AiModeratorService } from "./modules/ai-moderator/ai-moderator.service.js";
import { AuthRepository } from "./modules/auth/auth.repo.js";
import { createAuthRouter } from "./modules/auth/auth.routes.js";
import { AuthService } from "./modules/auth/auth.service.js";
import { createEventsRouter } from "./modules/events/events.routes.js";
import { EventsService } from "./modules/events/events.service.js";
import { createGovernanceRouter } from "./modules/governance/governance.routes.js";
import { GovernanceService } from "./modules/governance/governance.service.js";
import { MessagesRepository } from "./modules/messages/messages.repo.js";
import { createMessagesRouter } from "./modules/messages/messages.routes.js";
import { MessagesService } from "./modules/messages/messages.service.js";
import { createBootstrapDocsRouter } from "./modules/pairing/bootstrap-docs.routes.js";
import {
  LocalConnectService,
  type LocalDaemonInstallerFn,
} from "./modules/pairing/local-connect.service.js";
import { PairingRepository } from "./modules/pairing/pairing.repo.js";
import { createPairingRouter } from "./modules/pairing/pairing.routes.js";
import { PairingService } from "./modules/pairing/pairing.service.js";
import { ProposalsRepository } from "./modules/proposals/proposals.repo.js";
import { createProposalsRouter } from "./modules/proposals/proposals.routes.js";
import { ProposalsService } from "./modules/proposals/proposals.service.js";
import { RoomsRepository } from "./modules/rooms/rooms.repo.js";
import { createPublicSharePageRouter, createRoomsRouter } from "./modules/rooms/rooms.routes.js";
import { RoomsService } from "./modules/rooms/rooms.service.js";
import { createSystemRouter } from "./modules/system/system.routes.js";

const DEFAULT_WEB_DIST_DIR = fileURLToPath(new URL("../../web/dist", import.meta.url));

const STATIC_MIME_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".txt": "text/plain; charset=utf-8",
};

/**
 * 组装 Hono 应用所需的外部基础设施依赖。
 */
export interface AppDependencies {
  readonly env: ServerEnv;
  readonly database: ManagedDatabase;
  readonly realtimeBus: RealtimeBus;
  readonly cliBundlePath?: string;
  readonly webDistDir?: string;
  readonly localConnectHomeDir?: string;
  readonly localConnectPathEnv?: string;
  readonly localDaemonInstaller?: LocalDaemonInstallerFn;
}

function getMimeTypeForFile(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return STATIC_MIME_TYPES[ext] ?? "application/octet-stream";
}

/**
 * 在严格限定于 `rootDir` 沙箱目录内的前提下解析请求相对路径，阻断一切 `..` 目录穿越或空字节注入。
 */
function resolveSafeStaticPath(rootDir: string, urlPathname: string): string | undefined {
  if (urlPathname.includes("\0")) {
    return undefined;
  }
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(urlPathname);
  } catch {
    return undefined;
  }
  const normalizedRoot = path.resolve(rootDir);
  const relative = decodedPath.replace(/^\/+/, "");
  const candidate = path.resolve(normalizedRoot, relative);
  if (candidate !== normalizedRoot && !candidate.startsWith(`${normalizedRoot}${path.sep}`)) {
    return undefined;
  }
  return candidate;
}

/**
 * 创建并配置完整的 OpenHuddle HTTP / SSE / OpenAPI 应用实例。
 *
 * @param deps - 已初始化的环境配置、数据库与实时事件总线
 * @returns 类型完备的 `OpenAPIHono` 实例
 */
export function createServerApp(deps: Readonly<AppDependencies>): OpenAPIHono {
  const rootLogger = createRootLogger(deps.env.LOG_LEVEL);
  const app = createOpenApiRouter();
  const webDistDir = deps.webDistDir ?? DEFAULT_WEB_DIST_DIR;
  const spaIndexHtmlPath = path.join(webDistDir, "index.html");

  // 1. 初始化仓储层（Repositories）
  const authRepo = new AuthRepository(deps.database.db);
  const pairingRepo = new PairingRepository(deps.database.db);
  const roomsRepo = new RoomsRepository(deps.database.db);
  const messagesRepo = new MessagesRepository(deps.database.db);
  const proposalsRepo = new ProposalsRepository(deps.database.db);

  // 2. 初始化领域编排服务层（Services）
  const authService = new AuthService({
    repo: authRepo,
    env: deps.env,
    realtimeBus: deps.realtimeBus,
  });
  const pairingService = new PairingService({
    repo: pairingRepo,
    env: deps.env,
    realtimeBus: deps.realtimeBus,
  });
  const roomsService = new RoomsService({
    roomsRepo,
    messagesRepo,
    proposalsRepo,
    realtimeBus: deps.realtimeBus,
  });
  const governanceService = new GovernanceService({
    roomsRepo,
    realtimeBus: deps.realtimeBus,
  });
  const messagesService = new MessagesService({
    repo: messagesRepo,
    realtimeBus: deps.realtimeBus,
  });
  const localConnectService = new LocalConnectService({
    env: deps.env,
    pairingService,
    messagesService,
    ...(deps.cliBundlePath !== undefined ? { cliBundlePath: deps.cliBundlePath } : {}),
    ...(deps.localConnectHomeDir !== undefined ? { homeDir: deps.localConnectHomeDir } : {}),
    ...(deps.localConnectPathEnv !== undefined ? { pathEnv: deps.localConnectPathEnv } : {}),
    ...(deps.localDaemonInstaller !== undefined
      ? { installDaemonFn: deps.localDaemonInstaller }
      : {}),
  });
  const eventsService = new EventsService({
    roomsRepo,
    messagesRepo,
    realtimeBus: deps.realtimeBus,
  });
  const aiModerator = new AiModeratorService({
    env: deps.env,
    logger: rootLogger,
  });
  const proposalsService = new ProposalsService({
    proposalsRepo,
    roomsRepo,
    messagesRepo,
    aiModerator,
    realtimeBus: deps.realtimeBus,
  });

  app.use("*", createRequestContextMiddleware(rootLogger));

  // 3. 挂载 /api/v1 全部业务契约子路由
  const apiV1 = createOpenApiRouter();
  apiV1.route(
    "/",
    createSystemRouter({
      databaseDriver: deps.database.driver,
      realtimeBusDriver: deps.env.REALTIME_BUS_DRIVER,
    }),
  );
  apiV1.route("/", createAuthRouter({ authService, env: deps.env }));
  apiV1.route("/", createPairingRouter({ authService, pairingService, localConnectService }));
  apiV1.route("/", createRoomsRouter({ authService, roomsService }));
  apiV1.route("/", createGovernanceRouter({ authService, governanceService }));
  apiV1.route("/", createMessagesRouter({ authService, messagesService }));
  apiV1.route("/", createEventsRouter({ authService, eventsService }));
  apiV1.route("/", createProposalsRouter({ authService, proposalsService }));

  app.route("/api/v1", apiV1);

  // 4. 挂载根路径外部 Agent 自举文档 (/install.md, /skill.md, /openhuddle.mjs) 与公开只读分享页 (/share/:inviteToken)
  app.route(
    "/",
    createBootstrapDocsRouter({
      env: deps.env,
      ...(deps.cliBundlePath !== undefined ? { cliBundlePath: deps.cliBundlePath } : {}),
    }),
  );
  app.route(
    "/",
    createPublicSharePageRouter({
      roomsService,
      env: deps.env,
      spaIndexHtmlPath,
    }),
  );

  // 5. 自动暴露 OpenAPI 3.1 JSON 契约与 Scalar 在线交互调试面板 (/api/docs)
  app.doc("/api/openapi.json", {
    openapi: "3.1.0",
    info: {
      title: "OpenHuddle API",
      version: "0.1.0",
      description:
        "Multi-agent group huddle, governance state machine, and human decision platform API.",
    },
  });

  app.get(
    "/api/docs",
    Scalar({
      url: "/api/openapi.json",
    }),
  );

  // 6. 单容器生产前端静态资源与 SPA History 回退（严格排除 /api/* 命名空间）
  app.get("*", async (c, next) => {
    const reqPath = c.req.path;
    if (reqPath === "/api" || reqPath.startsWith("/api/")) {
      await next();
      return;
    }

    if (!existsSync(webDistDir)) {
      await next();
      return;
    }

    const candidateFile = resolveSafeStaticPath(
      webDistDir,
      reqPath === "/" ? "/index.html" : reqPath,
    );

    if (candidateFile && existsSync(candidateFile)) {
      const fileStat = await stat(candidateFile);
      if (fileStat.isFile()) {
        const bytes = await readFile(candidateFile);
        const isImmutableAsset = reqPath.startsWith("/assets/");
        return c.body(bytes, 200, {
          "content-type": getMimeTypeForFile(candidateFile),
          "cache-control": isImmutableAsset ? "public, max-age=31536000, immutable" : "no-cache",
        });
      }
    }

    const hasFileExtension = path.extname(reqPath).length > 0;
    const acceptHeader = (c.req.header("accept") ?? "*/*").toLowerCase();
    const acceptsHtml = acceptHeader.includes("text/html") || acceptHeader.includes("*/*");

    if (!hasFileExtension && acceptsHtml && existsSync(spaIndexHtmlPath)) {
      const htmlBytes = await readFile(spaIndexHtmlPath);
      return c.body(htmlBytes, 200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-cache",
      });
    }

    await next();
    return;
  });

  app.notFound((c) => {
    const body: ApiErrorEnvelope = {
      ok: false,
      error: {
        code: "NOT_FOUND",
        message: `Route not found: ${c.req.method} ${c.req.path}`,
        requestId: c.get("requestId") ?? "unknown",
      },
    };
    return c.json(body, 404);
  });

  app.onError((err, c) => {
    const requestId = c.get("requestId") ?? "unknown";
    const log = c.get("logger") ?? rootLogger;

    if (err instanceof AppError) {
      log.warn({ code: err.code, details: err.details }, err.message);
      const body: ApiErrorEnvelope = {
        ok: false,
        error: {
          code: err.code,
          message: err.message,
          requestId,
          ...(err.details !== undefined ? { details: err.details } : {}),
        },
      };
      return c.json(body, err.statusCode);
    }

    if (err instanceof ZodError) {
      const body: ApiErrorEnvelope = {
        ok: false,
        error: {
          code: "VALIDATION_ERROR",
          message: "Request validation failed.",
          requestId,
          details: err.flatten(),
        },
      };
      return c.json(body, 400);
    }

    log.error({ err }, "Unhandled internal server exception");
    const body: ApiErrorEnvelope = {
      ok: false,
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message:
          deps.env.NODE_ENV === "production"
            ? "An unexpected internal server error occurred."
            : err.message,
        requestId,
      },
    };
    return c.json(body, 500);
  });

  return app;
}
