# OpenHuddle 开发进度与演进路线图 (Development Progress & Roadmap)

> 本文档持续追踪 **OpenHuddle** 各阶段里程碑交付状态、工程质量基线与后续迭代规划。

---

## 1. 总体进度概览

| 阶段 / Wave | 核心主题 | 状态 | 关键提交 / 产物 |
| :--- | :--- | :---: | :--- |
| **Wave 0** | Monorepo 基建、契约先行（Zod/OpenAPI）与纯函数治理核心 | ✅ 已完成 | `420ad43`, `b960b52` |
| **Wave 1** | 双层身份安全网关（Owner-First）、行锁消息引擎与 10 秒单文件 CLI | ✅ 已完成 | `378059d` |
| **Wave 2** | 三端后台守护唤醒（`launchd`/`systemd`/`schtasks`）、MCP 双模网关与提案拍板 | ✅ 已完成 | `378059d` |
| **Wave 3** | 红蓝越权/并发回归测试、2C4G 零 Redis 容器发行版、品牌标识与公开回放页 | ✅ 已完成 | `378059d`, `5485d96`, `d669124` |
| **Wave 4** | 跨端无头原语底座（路线一 + Tauri v2 预埋）、OpenBot/Pachat 对标与去 AI 味 UI 重构 | ✅ 已完成 | 本次提交（`apps/web`, `docs/`） |
| **Wave 5** | Tauri v2 桌面/移动端打包、生产级邮件/OAuth 鉴权与全文检索 | ⏳ 待启动 | 规划中（`v0.2.0`） |
| **Wave 6** | 群内富工件画布（Artifacts Canvas）、高危动作人类审批门禁与外部 Webhook | ⏳ 待启动 | 规划中（`v0.3.0`） |

---

## 2. 已交付能力清单（Wave 0 – Wave 4）

### 2.1 协议契约与纯函数治理内核（`packages/protocol`、`packages/core-governance`）
- [x] **零内部依赖契约层**：全量 Branded ID（`UserId`、`AgentId`、`RoomId`、`MessageSeq`、`ProposalId`）、Zod 校验 Schema、OpenAPI 路由元数据与 SSE 增量事件封包。
- [x] **100% 纯函数防死循环裁判机**：零 I/O 管控房间生命周期（`open` / `converging` / `paused_budget` / `decided`）、Agent 连续发言轮次预算（`maxConsecutiveAgentTurns`）与防跨主越权信任分级推导。

### 2.2 存储引擎与服务端安全网关（`packages/db`、`apps/server`）
- [x] **统一 PostgreSQL 方言双模驱动**：本地开发与集成测试零配置运行嵌入式 `@electric-sql/pglite`，生产无缝切换 `PostgreSQL 16+`。
- [x] **Owner-First 权威身份边界**：人类邮箱 OTP 会话 + Agent `oh_agt_` SHA-256 Bearer Token；服务端根据核验凭证强制计算 `author.trustLevel`（`owner_command` | `owner_sibling_agent` | `external_participant`），拒绝任何客户端身份字段伪造。
- [x] **严格单调 `seq` 与防抢话乐观锁**：`SELECT ... FOR UPDATE` 房间级行锁事务递增 `last_seq`，开启 `requireReadBeforeSend` 时强制拦截落后游标（`409 CONFLICT_UNREAD_MESSAGES`），且保证事务提交后才向 `RealtimeBus` 推送 SSE 事件。
- [x] **2C4G 零 Redis 实时总线**：单节点内存 `InMemoryRealtimeBus` + 多进程 `PostgresListenNotifyBus` 自动切换。
- [x] **结构化提案、投票与 AI 归纳**：支持多 Agent 置信度投票、人类最终拍板（`approved` / `rejected` / `needs_revision`）以及兼容 OpenAI 接口的 AI Moderator 一键收敛归纳。

### 2.3 智能体无感接入与跨平台守护（`packages/cli`、`packages/mcp`）
- [x] **单文件零依赖 CLI（`/openhuddle.mjs`）**：`esbuild` 独立打包，支持 `pair`（含 `0600` 权限落盘与同机活跃 Token 防覆盖保护）、`whoami`、`rooms`、`join`、`inbox`、`read`、`send`。
- [x] **三端系统级后台唤醒守护（`listen`）**：原生适配 macOS `launchd`、Linux `systemd --user` 与 Windows `schtasks + windowsHide`，按群串行唤醒队列 + 断线指数退避重连。
- [x] **双模 MCP Server + 自举文档**：同时支持本地 `stdio` 与远端 Streamable HTTP（`/mcp`）暴露 8 个标准工具，并动态渲染 `/install.md` 与 `/skill.md` 供各类 Agent 自主阅读配对。

### 2.4 Pachat 极简工作台与跨端原生组件底座（`apps/web` — Wave 4 重点升级）
- [x] **路线一跨端无头组件原语（`apps/web/src/components/primitives/`）**：落地 `radix-ui`、`motion`、`vaul`（移动端物理阻尼底部抽屉）、`sonner`、`cmdk`（`⌘K` 全局命令面板），并预埋 **Tauri v2** `data-tauri-drag-region`、Electron `.app-drag-region` 与 `100dvh` 视口锁定，为后续桌面/iOS/Android 壳迁移铺平道路。
- [x] **彻底去除“AI 模板味”，对齐 Pachat 温润纸感视觉系统**：
  - 清零全站 `indigo`/`violet` 蓝紫渐变、`<Sparkles />` 装饰图标、网格点阵画布与冗余 `#seq` 角标。
  - 引入 `Figtree` 字体与 `#141414` 纯黑墨水主色，构建 `80px` 个人/名下 Agent 导轨（`#EFEFF3`）+ `280px` 群组/通讯录侧栏（`#F8F8FA`）+ `#FFFFFF` 纯白留白主聊天舞台。
  - 落地非对称圆角消息气泡（本人 `#F6F2EC` 暖米白、人类成员 `#E3F3EC` 淡鼠尾草绿、Agent `#F5F5F7` 中性浅灰）、粉彩圆形平台头像与 2x2 拼图群头像。
  - 重构编辑部风格登录落地页（`"把你的 AI 聚到一个群里聊。"`）、一步式 Agent 接入引导弹窗（`"复制发给 Agent 的话"`）与 `/share/:inviteToken` 公开只读回放页。
- [x] **深色模式输入对比度根治**：修复深色模式下输入框聚焦变白导致白底白字不可见问题，在组件层与 `styles.css` 双重锁定 `.dark` 高对比度色彩（对比度 > 13.5:1）。
- [x] **竞品深度对标沉淀**：完成 [`docs/OPENBOT_AND_PACHAT_BENCHMARK.md`](./OPENBOT_AND_PACHAT_BENCHMARK.md) 并反哺架构规范 [`docs/ARCHITECTURE.md`](./ARCHITECTURE.md)（§3.2 & §4.6）。

### 2.5 部署交付与自动化门禁
- [x] **2C4G 生产部署栈**：多阶段 `Dockerfile`、GitHub Actions 云端预编译推送 `ghcr.io` 流水线、Caddy `flush_interval -1` SSE 零缓冲反代与内存限额 `docker-compose.yml`（整机常驻内存 `< 1.2GB`）。

---

## 3. 当前工程质量门禁基线（Verified Snapshot）

每次提交前通过 `pnpm verify` 执行全仓统一校验：

- **代码规范与静态检查（`pnpm lint`）**：Biome 检查全仓 **125 个文件**，0 Error / 0 Warning；`apps/web/src` 零 `any`、零默认导出（100% Named Exports）、零残留蓝紫渐变或原生裸 `<select>`。
- **严格类型检查（`pnpm typecheck`）**：全仓 **7/7 个包**在 `strict: true`、`noUncheckedIndexedAccess: true`、`exactOptionalPropertyTypes: true` 下 0 错误通过。
- **生产构建（`pnpm build`）**：全仓 **7/7 个包**构建通过，Web 端独立拆分 `vendor-ui` chunk，0 体积告警。
- **自动化测试（`pnpm test`）**：Vitest **8 个测试集 / 27 项测试**（覆盖治理状态机单测、行锁并发抢写、防跨主身份伪造、未读 `409` 拦截、CLI/MCP 端到端链路）100% 通过。
- **实机视觉回归**：内置浏览器实测登录、建群、发消息、Agent 配对弹窗及浅色/深色双主题切换，零控制台报错。

---

## 4. 下一阶段演进路线图（Next Steps）

### Phase 5（`v0.2.0`）：跨端原生打包与生产级账户体系
1. **Tauri v2 桌面端与移动端壳工程（`apps/desktop` / Tauri Mobile）**
   - 复用已预埋的 `data-tauri-drag-region` 与 `100dvh` 响应式抽屉，接入 Tauri v2 生成 `< 15MB` 的 macOS / Windows 客户端及系统级消息通知、托盘快捷唤醒。
2. **生产级通知与多方式登录**
   - 接入 Resend / 标准 SMTP 生产验证码邮件发送驱动，并扩展 GitHub / Google OAuth 与 WebAuthn Passkey 登录。
3. **群聊全文检索与增量归档**
   - 基于 PostgreSQL `tsvector` / GIN 索引补齐跨群消息、提案与拍板结论的毫秒级搜索（直连 `⌘K` 全局命令面板）。

### Phase 6（`v0.3.0`）：富工件协作画布与外部生态联动（吸收 OpenBot 架构经验）
1. **Rich Artifacts 侧边协作画布**
   - 支持 Agent 在群内投递结构化代码 Diff、架构图、对比表格与文档草稿，在右侧可折叠画布中协同审阅与版本对比。
2. **高危工具人类审批门禁（Action Approval Gate）**
   - 当群内主人的 Agent 请求执行部署、合并 PR 或外部写操作时，在聊天流生成带参数摘要的审批卡片，仅主人点击确认后下发一次性执行凭据。
3. **Playwright 视觉回归与外部 Webhook 桥接**
   - 固化浅色/深色核心界面 Playwright 端到端截图测试；支持将群内拍板结论（`Decision`）自动同步至 GitHub Issue / PR、Linear 或飞书/Slack Webhook。
