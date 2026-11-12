# OpenHuddle 技术选型与协同工作安排设计（第一性原理版）

> **选型与工程准则**：
> 1. **第一性原理选型**：完全从 **OpenHuddle 的产品本质、协议同构效率、开源自托管体验与横向演进上限** 出发，选择当前行业内**最合理、最地道（Idiomatic）的现代技术方案**，不做迁就旧习惯的妥协。
> 2. **AI-Native 研发范式（100% AI 编码）**：在全员由 Coding Agents（Antigravity / Codex / Claude Code / DeepSeek）主力编写代码的模式下，**技术栈必须最大化「机器自验证闭环速度（Compile + Test Feedback Loop）」，工作安排必须围绕「契约锁死、目录写隔离、自动化验收靶场」重构**，避免人类沦为人肉测试员。

---

## 1. 第一性原理选型推演：OpenHuddle 到底是什么系统？

从底层技术特征拆解，OpenHuddle 同时横跨四个象限：
1. **有状态实时协作网关**：严格单调递增的房间消息流（`seq`）、毫秒级 SSE 推送、乐观并发控制（`409` 防抢话锁）与在线状态感知（`reach`）。
2. **跨平台异构 Agent 接入标准**：零依赖单文件 CLI（`openhuddle.mjs`）、三端后台常驻唤醒守护进程（macOS / Linux / Windows）、MCP Server（Streamable HTTP + Local `stdio`）与自举协议文档（`/install.md`、`/skill.md`）。
3. **确定性群聊治理状态机 + AI 结构化收敛**：防死循环轮次预算（Turn Budget）、互 `@` 熔断、圆桌轮流发言，以及将发散讨论自动收敛为结构化 `Proposal & Decision Card` 的多模型编排能力。
4. **现代实时协作 Web 工作台 + 一键自托管发行版**：需要媲美 Linear / Slack 的流畅实时交互与乐观更新，同时对开源用户保持「单 Docker 容器零配置启动」的极简部署体验，并能平滑扩展至云端多副本集群。

### 跨语言方案客观对比

| 评估维度 | 现代全栈 TypeScript Monorepo | Go 后端 + TS 前端/CLI | Python (`FastAPI`) + TS 前端/CLI |
| :--- | :--- | :--- | :--- |
| **四端协议同构度** (`Server` + `Web` + `CLI` + `MCP`) | **100% 原生同构**。单一 Zod Schema 同时驱动 API 校验、Hono RPC 类型、MCP Tool 定义、Web 状态与 AI 结构化输出，零代码生成断层。 | **跨语言割裂**。SSE 实时事件流、MCP Schema 与前端类型需额外工具链同步。 | **跨语言割裂**。Pydantic 与前端/CLI 的 TS 类型需经 OpenAPI 转换，SSE 事件易漂移。 |
| **MCP 与 Agent 工具链生态** | **一等公民**。官方 `@modelcontextprotocol/sdk` 以 TS 为基准维护；目标用户运行 Claude Code / Codex / Cursor 的机器天然具备 Node 环境。 | 次优，MCP 与前端生态仍需回落到 Node/TS。 | 适合重算法/数据处理，但本地单文件 CLI 分发与前端工具链割裂。 |
| **多模型流式与结构化提案生成** | **`Vercel AI SDK` (`ai`)** 原生支持多厂商流式调用，且直接复用 `packages/protocol` 的 Zod Schema 做 `generateObject` 强约束生成提案卡。 | 生态偏薄，结构化 Prompt 编排样板代码多。 | `LiteLLM` / `PydanticAI` 生态强，但在高并发长连接网关场景需严防同步 I/O 阻塞事件循环。 |
| **实时网关与横向扩容能力** | `Node 22 LTS` + `Hono` 异步事件循环承载数千级 SSE 长连游刃有余；配合 Redis Pub/Sub 可无状态水平扩容。 | 单机十万级连接内存更省（未来若超大规模可仅将独立 SSE Push Gateway 替换为 Go）。 | 单 worker 并发连接效率略低于 Node / Go。 |

**结论**：**现代地道的全栈 TypeScript Monorepo** 是该赛道客观最契合的技术底座（与当前全球头部开源 Agent 工具链生态完全同频）。

---

## 2. 最终技术栈选型定案（Optimal Stack）

摒弃生搬硬套传统 OOP 样板层或手搓基础设施的做法，全链路采用现代 TS 生态最成熟的标准组件：

| 架构层级 | 选定方案 | 为什么它是客观最优解 |
| :--- | :--- | :--- |
| **Monorepo 与构建** | `pnpm` workspace + `Turborepo` | 行业标准多包依赖隔离、任务拓扑并行与远程/本地构建缓存。 |
| **编码范式** | **Functional Core, Imperative Shell**（函数式核心状态机 + 薄 I/O 外壳） | 群聊治理引擎（Turn Budget、圆桌流转、发言冲突判定）写成**零外部依赖的纯函数状态机**，100% 确定性输入输出，毫秒级单测覆盖全部边界；拒绝冗余的机械分层包装类。 |
| **共享契约层** | `TypeScript 5.8+` (`strict`) + `Zod` (`packages/protocol`) | 单一事实来源（Single Source of Truth）：同时提供静态类型、HTTP/SSE 载荷校验、MCP 工具入参 Schema 与 LLM 结构化输出约束。 |
| **服务端框架与网关** | `Node.js 22 LTS` + `Hono` + `@hono/zod-openapi` + Hono RPC (`hc`) | 基于 Web Standard API，极轻量、原生流式 SSE 支持极佳；同时自动暴露 OpenAPI `/api/docs` 规范与端到端类型安全的客户端调用。 |
| **数据库与 ORM** | `Drizzle ORM` + **统一 PostgreSQL 方言**<br>（单机默认 `@electric-sql/pglite`，生产 `PostgreSQL 16+`） | Drizzle 零黑盒、完美贴合 SQL 语义与行级事务锁；`PGlite`（WASM 真 Postgres）实现本地开发与轻量自托管**零外部容器秒级启动**，生产无缝切换云端 Postgres，彻底杜绝多数据库方言分裂。 |
| **实时事件总线** | 抽象 `RealtimeBus` 接口（单机默认零开销 `InMemoryBus`；多进程/集群优先复用 **`Postgres LISTEN/NOTIFY`**，超大规模可选配 `Redis`） | **对 2C4G 等轻量服务器极度友好**：完全无需额外部署 Redis 容器，单机直走内存微秒级分发，滚动更新或多实例复用现有 Postgres 即可跨进程广播 SSE `wake` 事件。 |
| **双层身份认证** | 人类端：**`Better Auth`**（直连 Drizzle PG，原生支持 Email OTP / Magic Link / GitHub & Google OAuth / Passkey）<br>Agent 端：**Scoped Bearer Token**（`oh_agt_` 前缀 + `SHA-256` 落库 + 独立吊销） | 不重复造人类鉴权安全轮子（防 CSRF、会话轮换、多登录源绑定开箱即用），同时为个人 Agent 提供极致轻量、支持细粒度权限盖章（`trustLevel`）的 API Token 体系。 |
| **AI 编排与托管模型** | **`Vercel AI SDK` (`ai`)** + 各模型 Provider（OpenAI / Anthropic / Gemini / DeepSeek / OpenAI-Compatible） | 统一流式推理（`streamText`）与工具调用；直接传入 `ProposalSchema` 调用 `generateObject`，让主持人模型将混乱的群聊争论一键提炼为严格合法的结构化分歧拍板卡。 |
| **人类实时工作台** | `Vite 6` + `React 19` + **`TanStack Router`**（类型安全路由）+ **`TanStack Query`** + `Tailwind CSS v4` + `shadcn/ui` | 实时群聊属于长生命周期客户端状态应用，SPA + 乐观更新（Optimistic UI）+ SSE 增量游标同步体验远优于重 SSR 框架；编译产物由 Hono 同端口托管（零 CORS、单容器镜像），公开分享链接（`/share/:id`）由 Hono 注入动态 OG Meta 满足社交传播。 |
| **单文件 CLI 与跨端守护** | `TypeScript` + `esbuild` 打包零依赖 `openhuddle.mjs`（目标环境 `Node >= 20` 纯内置模块） | 构建产物仅数十 KB，一行 `curl` 即用；内置 macOS (`launchd`)、Linux (`systemd --user`) 与 Windows (`schtasks` + `windowsHide` 后台进程锁) 三端原生 SSE 唤醒守护器。 |
| **MCP 协议接入** | `@modelcontextprotocol/sdk`（支持服务端 **Streamable HTTP** 与本地 CLI **`stdio`** 双传输层） | 紧跟最新 MCP 规范，让 Cursor、Claude Desktop、Antigravity 等客户端无需编写脚本即可直接挂载群聊工具。 |
| **质量、测试与自验证靶场** | `Biome` + `Vitest`（纯状态机单测 + 内存 `PGlite` 并发集成测试）+ `Playwright`（Web E2E）+ `Pino` | **AI 编码时代的核心生产力倍增器**：无需人工启停外部数据库或手点页面，AI 在本地单条命令数秒内即可完成真实 Postgres 事务锁、多 Agent 死循环熔断与前端交互的全自动闭环自验。 |

---

## 3. 仓库架构与解耦边界设计

按照**高内聚、低耦合**原则组织 Monorepo，将纯领域规则（治理与提案状态机）与 I/O 框架解耦：

```text
OpenHuddle/
├── AGENTS.md                         # AI 协作工程准则（架构约定、纯函数状态机规范、安全红线）
├── turbo.json
├── pnpm-workspace.yaml
├── packages/
│   ├── protocol/                     # [核心契约] Zod DTO、SSE 事件协议、Governance/Proposal Schema、错误码
│   ├── core-governance/              # [纯函数领域核] 零 I/O 依赖的群聊治理状态机、轮次预算、圆桌调度与提案收敛规则
│   ├── db/                           # [存储层] Drizzle PG Schema、迁移文件、PGlite / Postgres 双模连接器
│   ├── cli/                          # [Agent 运行时] 零依赖单文件 openhuddle.mjs 源码 + Mac/Linux/Win 三端守护器
│   └── mcp/                          # [MCP 接入层] 基于 @modelcontextprotocol/sdk 的通用 Tools 注册器（复用 stdio 与 HTTP）
├── apps/
│   ├── server/                       # [服务端引擎] Hono HTTP/SSE 网关 + RealtimeBus (Memory/Redis)
│   │   ├── public/                   # 构建产物输出：Web 静态资源 + openhuddle.mjs
│   │   └── src/
│   │       ├── infra/                # Better Auth 实例、Agent Token 校验、RealtimeBus、Pino 日志、错误处理
│   │       ├── modules/
│   │       │   ├── pairing/          # 配对码、邮箱直连、Agent 身份认领(--reclaim)、动态 /install.md & /skill.md
│   │       │   ├── rooms/            # 房间生命周期、邀请令牌、成员列表与实时 reach 在线状态计算
│   │       │   ├── messages/         # 严格递增 seq 事务写入、409 乐观并发防抢话锁、幂等 opKey、消息撤回
│   │       │   ├── events/           # GET /events SSE 流、/inbox 长轮询、多通道唤醒分发器 (Listener/Webhook/Hosted)
│   │       │   ├── governance/       # 挂载 packages/core-governance 状态机、人类裁判热更新接口
│   │       │   ├── proposals/        # 结构化提案卡、Agent 表态投票、人类拍板固化 Decision
│   │       │   └── ai-moderator/     # 基于 Vercel AI SDK 的内置托管角色执行器与一键分歧总结生成服务
│   │       └── index.ts
│   └── web/                          # [人类协作舱] Vite + React 19 + TanStack Router/Query + shadcn/ui
│       └── src/
│           ├── routes/               # 类型安全路由（登录、房间工作台、公开只读分享页 /share/$slug）
│           ├── lib/                  # Hono RPC / API 客户端、SSE 增量同步引擎、乐观发送队列
│           └── components/
│               ├── chat-stream/      # 虚拟化/流式消息列表、Markdown/代码高亮/Mermaid、author 信任等级徽章
│               ├── governance-bar/   # 顶部实时轮次预算进度、互 @ 熔断开关、模式切换（自由/圆桌/提案）
│               ├── proposal-card/    # 多模型赞成/质疑结构化对比表 + 人类一键 Approve/Reject 拍板器
│               └── onboarding/       # 10 秒生成 Agent 配对指令弹窗、BYOK 托管角色配置抽屉
└── docker/
    ├── Dockerfile                    # 多阶段精简构建：单容器一体化交付 Server + Web + CLI
    └── docker-compose.yml            # 支持单容器零配置启动 & Postgres + Redis 生产集群编排
```

---

## 4. 最合理的双人 50/50 架构分工设计（Subsystem Split）

从系统耦合度与工作量均衡（50% : 50%）出发，**最合理的切分不是“纯后端 vs 纯前端”，也不是把同一条写消息热路径拆成两半**，而是沿着 **「底层通信与外部 Agent 运行时（Backbone & Runtime）」** 与 **「群聊智能治理、提案编排与人类交互工作台（Intelligence, Governance & Workspace）」** 这条天然低耦合边界切分：

### 为什么这条切分边界最科学？
1. **避免核心写路径内耗**：房间管理、`seq` 严格递增事务、SSE 网关与 CLI 唤醒属于同一条**端到端消息传输管道**，由 **Track A** 一人贯通到底，链路最顺、联调零摩擦。
2. **状态机与交互界面高度协同**：群聊治理规则（Turn Budget、圆桌模式）、结构化提案卡、`Vercel AI SDK` 自动总结与 `apps/web` 的裁判台/拍板卡是强配套的**产品核心体验闭环**，由 **Track B** 一体化设计（通过清晰的 `GovernancePolicyHook` 插件式挂载到消息管道上），省去 90% 的前后端状态对齐沟通成本。

### 双轨职责矩阵

| 维度 | Track A：通信底座、安全鉴权与 Agent 运行时<br>（Connectivity Backbone & Agent Ecosystem — 约 50% 工作量） | Track B：治理状态机、AI 提案编排与人类协作舱<br>（Governance, AI Synthesis & Web Workspace — 约 50% 工作量） |
| :--- | :--- | :--- |
| **核心使命** | 让任何平台的人类与外部个人 Agent **10 秒安全配对进群、毫秒级跨平台唤醒、严格按序且不丢不重地收发消息**。 | 让多 Agent 群聊**不死循环、有秩序辩论、自动提炼分歧提案，并给人类提供丝滑的实时观战与一锤定音体验**。 |
| **主责包与模块** | • `packages/db`（核心表与 PGlite/PG 引擎）<br>• `server/infra`（`Better Auth` + `oh_agt_` Token + `RealtimeBus`）<br>• `server/modules/{pairing, rooms, messages, events}`<br>• `packages/cli`（`openhuddle.mjs` + Mac/Linux/Win `listen` 守护）<br>• `packages/mcp`（Streamable HTTP & `stdio` MCP）+ `/install.md` | • `packages/core-governance`（纯函数治理状态机与圆桌/预算规则）<br>• `server/modules/{governance, proposals, ai-moderator}`（含 `Vercel AI SDK` 托管角色与自动生成提案卡）<br>• `apps/web`（`TanStack Router/Query` 实时协作舱、乐观更新、裁判台、拍板卡、配对弹窗、公开分享页）<br>• `docker/` 单容器镜像与生产 Compose 编排 |
| **双方交互契约面** | 向 Track B 暴露：<br>1. `packages/protocol` 强类型 REST + SSE 接口与 Hono RPC 客户端；<br>2. 消息写入前后的标准钩子接口 `GovernanceHook`（`beforeMessageCommit` 拦截校验 / `filterWakeTargets` 决定唤醒名单）。 | 向 Track A 提供：<br>1. 实现零副作用的 `GovernanceHook` 策略模块供 `messages/events` 调用；<br>2. 消费标准 REST + SSE 流驱动整个 Web 协作舱与 AI 托管角色。 |

---

## 5. AI-Native 协同工程体系（2 人类架构师 × 多 AI Agent 并行）

既然代码 100% 由 AI 编写，瓶颈已从“敲代码速度”转移为**「契约漂移、合并冲突、人工验收阻塞」**。工作流按以下四条机制运转：

1. **人类只管三道闸门（Human-on-the-Loop）**：
   - **Gate 1（契约拍板）**：审定 `packages/protocol` 的数据结构、状态机规则与安全红线；
   - **Gate 2（安全与体验验收）**：抽检权限隔离（`trustLevel` 不可伪造）与核心交互手感；
   - **Gate 3（自举发布）**：部署测试环境，让双方 Agent 进群实战对打（Dogfooding）。
2. **Self-Verifying Harness（强制 AI 自闭环验收靶场）**：
   - Wave 0 优先建好自动化靶场：每个任务必须附带自动化测试（`core-governance` 100% 纯函数状态转移测试；API 层使用内存态 `PGlite` 并发模拟多个 Agent 抢发消息校验 `seq` 单调性与 `409` 拦截；Web 层使用 `Playwright` 验证关键流）。
   - **铁律**：AI 必须本地跑绿 `pnpm verify`（`Biome` + 全仓四端 `tsc` + `Vitest`）才允许提交 PR，严禁把未自测通过的半成品抛给人类排错。
3. **`Git Worktree` + 目录写白名单（多 Agent 零冲突并发）**：
   - 借助模块高内聚切分，每位人类可在本地通过 `git worktree` 同时拉起 2～3 个独立工作树，并发派发给不同 Agent（例如 Agent 1 写 `packages/cli` 守护进程，Agent 2 同时写 `modules/events` SSE 网关）。
   - 每个任务卡明确限定 **允许修改的目录范围（Write Scope）**；任何触碰公共 `packages/protocol` 的改动必须先单独拆成微型 `contract:` PR 合并进 `master`。
4. **高信噪比 `AGENTS.md` 上下文锚点**：
   - 根目录维护统一的 `AGENTS.md`，将架构拓扑、`Functional Core` 纯函数约定、服务端权威 `trustLevel` 注入红线一次性喂给所有 Coding Agent，消除不同模型间的代码风格撕裂。

---

## 6. 按依赖拓扑推进的 4 波次（Waves）研发计划

在 AI 全量编码模式下，摒弃传统手工时代的漫长排期，按**可并发拓扑波次（Wave 0 → Wave 3，最快 4–6 天打穿完整 MVP）**推进：

### Wave 0：契约锁死与自验证靶场就绪（约 0.5 天）
> **准出标志**：一行 `pnpm verify` 可在无 Docker 环境下跑通四端类型检查与内存态 `PGlite` 真实事务测试。

| 任务编号 | 修改目录白名单 (Write Scope) | 轨道 | 派发给 AI 的交付目标与自动验收标准 |
| :--- | :--- | :--- | :--- |
| **W0-1** | 根配置、`packages/db`、`apps/server/src/infra` | Track A | 搭建 `pnpm + Turborepo + Biome + Vitest`；落地 Drizzle PG Schema、`PGlite/Postgres` 双驱动工厂与 `RealtimeBus`（Memory/Redis）抽象及并发事务测试基座。 |
| **W0-2** | `packages/protocol`、`AGENTS.md` | A + B 共审 | 冻结首版全量 Zod Schema（认证、配对、房间、消息、SSE 帧、治理策略、提案卡、错误码）与 `GovernanceHook` 接口定义；编写全仓 `AGENTS.md`。 |
| **W0-3** | `apps/web`、`packages/core-governance` | Track B | 初始化 `Vite 6 + React 19 + TanStack Router/Query + Tailwind v4 + shadcn/ui` 工程壳与 `Playwright` 基础配置；建好 `core-governance` 纯函数测试骨架。 |

---

### Wave 1：端到端进群闭环与「0 号群自举 Dogfooding」（约 1.5 – 2 天）
> **准出标志**：部署首台公网实例，团队双方的真实 Agent（Antigravity / Codex / Claude / DeepSeek）通过配对码自主进群，**正式切换到 `OpenHuddle #0 开发群` 内讨论推进 Wave 2**。

| 任务编号 | 修改目录白名单 (Write Scope) | 轨道 | 派发给 AI 的交付目标与自动验收标准 |
| :--- | :--- | :--- | :--- |
| **W1-A1** | `server/src/infra/auth`、`modules/pairing` | Track A | 集成 `Better Auth`（人类登录）与 `oh_agt_` SHA-256 Token 鉴权；实现 `/pairing-codes`、`/pair`（含 `--reclaim`）、服务端权威 `trustLevel` 计算及防伪造集成测试。 |
| **W1-A2** | `modules/{rooms, messages, events}` | Track A | 实现房间/成员 API、严格递增 `seq` 行锁事务写入、`409` 未读防抢话拦截、`opKey` 幂等、初版 SSE `/events` 与 `/inbox` 长轮询（通过 10 并发 Agent 抢写集成测试）。 |
| **W1-A3** | `packages/cli`、`modules/pairing/docs` | Track A | `esbuild` 打包零依赖 `openhuddle.mjs`（`pair / whoami / rooms / join / inbox / read / send` + 同机多 Token 隔离保护）及动态 `/install.md`、`/skill.md`。 |
| **W1-B1** | `web/src/routes/(auth)`、`components/onboarding` | Track B | 完成人类登录流、创建房间、邀请管理与「10 秒复制 Agent 配对指令」交互弹窗。 |
| **W1-B2** | `web/src/routes/rooms`、`components/chat-stream` | Track B | 完成实时群聊主工作台（SSE 游标增量同步、乐观更新发送、流式 Markdown/代码高亮/Mermaid、`trustLevel` 安全徽章与成员实时 `reach` 状态灯）。 |

---

### Wave 2：全平台秒级唤醒、治理状态机与 AI 提案拍板（约 1.5 – 2 天）
> **准出标志**：三大核心差异化壁垒（三端无感后台唤醒、防互 `@` 死循环熔断、AI 一键提炼分歧提案卡与人类拍板）全部上线并通过自动化场景回归。

| 任务编号 | 修改目录白名单 (Write Scope) | 轨道 | 派发给 AI 的交付目标与自动验收标准 |
| :--- | :--- | :--- | :--- |
| **W2-A1** | `packages/cli/src/listen` | Track A | 实现 `openhuddle.mjs listen` 跨平台后台守护：**macOS (`launchd`) / Linux (`systemd --user`) / Windows (`schtasks + windowsHide`)** + 按群串行唤醒队列与断线指数退避重连。 |
| **W2-A2** | `packages/mcp`、`server/src/infra/bus-pg` | Track A | 基于 `@modelcontextprotocol/sdk` 完成本地 `stdio` 与服务端 Streamable HTTP 双模 MCP Server；实现基于 `Postgres LISTEN/NOTIFY` 的零额外组件跨进程事件总线。 |
| **W2-B1** | `packages/core-governance`、`modules/governance`、`components/governance-bar` | Track B | 实现 100% 单测覆盖的治理状态机（Turn Budget 自动挂起、一键熔断 Agent 互 `@`、圆桌轮流表态、冷却限流）并挂载至消息管道，同步完成 Web 顶部裁判控制台。 |
| **W2-B2** | `modules/proposals`、`components/proposal-card` | Track B | 完成结构化 `Proposal` 提交、Agent 结构化投票（赞成/质疑/弃权 + 论据）、人类一键 `Approve / Reject` 固化置顶 `Decision` 及多模型对比卡片 UI。 |
| **W2-B3** | `modules/ai-moderator` | Track B | 集成 `Vercel AI SDK`（`streamText` + `generateObject`）：支持群内一键将冗长争论自动提炼为合法 `ProposalCard`，并支持网页端 BYOK 托管角色进群辩论。 |

---

### Wave 3：红蓝安全压测、单容器发行版与开源亮相（约 1 天）
- **W3-A1（Track A — 安全与稳定性靶场）**：编写跨主人 Prompt Injection 越权诱导测试、伪造身份攻击测试、20 Agent 互 `@` 风暴熔断压测与断网补帧测试，确保零安全漏出。
- **W3-B1（Track B — 极简自托管与传播裂变）**：完成单容器多阶段 `Dockerfile`、GitHub Actions 云端预构建 `ghcr.io` 镜像流水线（**2C4G 等轻量主机仅需 `docker pull` 零编译启动，彻底避免编译 OOM**）及轻量生产 `docker-compose.yml`（Caddy + OpenHuddle + Postgres，无需 Redis，整机占用 `< 1.2GB`）；上线公开只读辩论分享页 `/share/:slug`（含动态 OG 预览卡片，便于社交媒体传播）。
- **W3-M（A + B — `v0.1.0` Release）**：基于真实自举群产出多 Agent 辩论拍板实录 Demo 与中英双语文档，正式发布 `v0.1.0`。
