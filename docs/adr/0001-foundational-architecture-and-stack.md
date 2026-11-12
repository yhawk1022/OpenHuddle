# ADR-0001：采用现代全栈 TypeScript、纯函数治理内核与零 Redis 轻量单容器架构

- **状态**：已采纳（Accepted）
- **日期**：2026-11-12
- **关联文档**：[ARCHITECTURE.md](../ARCHITECTURE.md)、[TECH_STACK_AND_WORKPLAN.md](../TECH_STACK_AND_WORKPLAN.md)、[CODING_STANDARDS.md](../CODING_STANDARDS.md)

---

## 1. 背景与问题陈述（Context）

OpenHuddle 需要同时交付四个紧耦合协议端：**实时 HTTP/SSE 服务端网关、现代实时群聊 Web 工作台、跨平台零依赖单文件 CLI（`openhuddle.mjs` 含 macOS/Linux/Windows 后台守护进程）以及 MCP Server**，同时内置防 Agent 互 `@` 死循环的治理状态机与结构化提案拍板机制。

此外，项目需满足两个关键现实约束：
1. **AI-Native 高速自验证研发**：代码主要由多模型 AI 编程智能体生成，要求极速、零断层的编译期类型检查与免外部容器的本地事务集成测试闭环。
2. **2C4G 轻量服务器与极简开源自托管体验**：线上与个人自托管主机资源有限（如 2 vCPU / 4 GB RAM），架构需控制常驻内存 `< 1.3 GB` 并避免复杂的跨组件运维。

## 2. 备选方案评估（Considered Options）

1. **方案 A：现代全栈 TypeScript Monorepo（`Hono` + 同端口静态托管 `Vite React SPA` + `Drizzle PGlite/Postgres` + `Postgres LISTEN/NOTIFY`）**
   - *优势*：单一 `packages/protocol` Zod 契约原生驱动四端及 `Vercel AI SDK` 结构化提案输出；`PGlite` 让本地单测与轻量自托管零外部依赖跑真 Postgres；单 Node 进程托管 API/SSE/静态前端，无需独立 SSR 服务与 Redis。
   - *劣势*：单机超十万级并发长连接时内存开销略高于 Go/Rust（但远超中早期需求，且未来可独立替换边缘网关）。
2. **方案 B：Python (`FastAPI`) 后端 + TypeScript 前端与单文件 CLI**
   - *优势*：Python 原生模型生态丰富。
   - *劣势*：前后端与 CLI 工具链双倍维护，SSE 实时事件缺少原生跨语言类型锁；异步事件循环一旦混入同步阻塞调用会影响全量 SSE 心跳。
3. **方案 C：`Next.js` SSR 双服务 + PostgreSQL + SQLite 双方言 + Redis**
   - *优势*：默认提供全站 SSR 与标准缓存栈。
   - *劣势*：双 Node 服务 + Postgres + Redis 在 2C4G 主机上内存与构建压力偏大；同时维护 PG 与 SQLite 两套 Drizzle Schema 会导致行锁与 JSONB 语义分裂。

## 3. 决策结果（Decision）

最终选定 **方案 A**，并确立以下四项核心架构基线：
1. **协议同构与严格类型**：全仓采用最严 TypeScript 基线 + Branded IDs + `packages/protocol` 单一事实源。
2. **`Functional Core, Imperative Shell` 解耦**：将群聊治理引擎（Turn Budget、互 `@` 熔断、圆桌流转）抽离为零 I/O 依赖的纯函数包 `packages/core-governance`，确保 100% 确定性分支测试。
3. **统一 PostgreSQL 方言与免 Redis 事件总线**：开发测试与极简自托管使用嵌入式 `PGlite`，生产使用 `PostgreSQL 16+`；实时总线单机走 `InMemoryBus`，多进程/滚动重启复用 `Postgres LISTEN/NOTIFY`，2C4G 环境无需部署 Redis。
4. **CI 云端构建镜像，生产仅拉取运行**：由 GitHub Actions 编译打包单容器镜像推送至 `ghcr.io`，生产 2C4G 主机仅执行 `docker compose pull && docker compose up -d`，彻底规避小内存主机现场编译引发的 OOM。

## 4. 影响与后续约束（Consequences）

- **正面影响**：AI 智能体在本地无需 Docker 即可在数秒内跑完 `tsc + Biome + PGlite 并发事务集成测试`；2C4G 生产整机常驻内存控制在 `1.1–1.3 GB` 区间，留有超 `2.5 GB` 安全余量。
- **工程约束**：所有服务端事务必须在 Commit 之后才允许触发 `RealtimeBus` 推送；所有代码提交必须严格遵守 [CODING_STANDARDS.md](../CODING_STANDARDS.md) 的三级注释与文档同步门禁。
