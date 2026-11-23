# ADR-0006：全环境 CLI 安装链接与云端 Agent 接入

- **状态**：已采纳（Accepted）
- **日期**：2026-11-23
- **关联模块 / 文档**：`packages/cli`、`apps/server/src/modules/pairing/bootstrap-docs.routes.ts`、`apps/server/src/modules/mcp/`、`apps/server/src/infra/public-url.ts`、[ARCHITECTURE.md §4.2](../ARCHITECTURE.md)

---

## 1. 背景与问题陈述（Context）

旧版接入提示词默认 Agent 跑在**有 `systemd`/`launchd` 的本地桌面**，而且本机装有 `claude`/`codex`/`agy` 可执行文件。下面这些环境会接入失败：

1. **云端 Agent 沙箱**（Codex Cloud、Claude Web 沙箱、Cursor 后台 Agent、Docker/K8s 容器）：没有 `systemctl --user`，`pair --listen` 直接报错退出，而一次性配对码此时已经被消耗。
2. **容器内没装嵌套 CLI**：守护进程起来了，但每次唤醒都报 `ENOENT`，并往群里发错误气泡。
3. **公网部署时 `PUBLIC_BASE_URL` 仍是默认回环地址**：下发的命令里是 `http://localhost`，云端 Agent 访问不到。
4. **没有 Node.js 的精简容器**以及**没有 Shell 只能发 HTTP 的 Agent** 完全没有接入路径。

## 2. 备选方案评估（Considered Options）

1. **方案 A：继续只提供长提示词，让 Agent 自己判断环境**：每次都要多轮推理，速度慢、结果不稳定。
2. **方案 B：发布 npm 包 `npx openhuddle`**：依赖 npm 源，在内网或离线容器里不可用，版本也会和服务端漂移。
3. **方案 C（采纳）：服务端直接分发安装器 + CLI 自适应环境**：`curl <server>/install.sh | sh -s -- connect <CODE>` 一条命令完成。CLI 版本始终和服务端一致，不依赖 npm。

## 3. 决策结果（Decision）

- **安装器**：`GET /install.sh`（POSIX）和 `GET /install.ps1`（Windows）。
  - 机器上有 Node.js ≥ 18 时，安装 `openhuddle.mjs` 并生成包装脚本 `~/.openhuddle/bin/openhuddle`。
  - 没有 Node 时，回退为纯 `sh + curl` 的精简 CLI（支持 connect/read/reply/send/wait/inbox/join）。
  - `$HOME` 不可写时，回退到 `/tmp/.openhuddle`。
  - 支持 `?code=&name=&platform=` 预填参数；所有参数都做严格的单引号转义，避免注入。
- **CLI `connect`**：参数省略时自动推断名称、平台和 token 路径（slug 冲突时自动加后缀）；成功后写入 `active-profile.json` 并记住默认房间。之后 `read` / `reply` / `wait` / `members` / `propose` 都不用再填 `--server`、`--token-file` 和 `<roomId>`。
- **守护进程降级链**：`launchd` / `systemd --user` / `schtasks` 失败时，降级为脱离父进程的后台 Worker（PID 锁 + 日志落盘）。如果连后台进程都起不来，就降级为「按需 CLI 模式」：**保留已签发的 token，不让 pair 失败**。
- **预设二进制探测**：用纯文件系统检查探测本机有没有 `claude`/`codex`/`agy`/`gemini`，没有就不启动守护进程，问候语也会如实说明当前状态。
- **`wait`**：通过 SSE 阻塞等待唤醒，SSE 不可用时回退到 `/inbox` 长轮询，为没有常驻进程的云端会话提供实时等待能力。
- **MCP**：新增 `/api/v1/mcp` 远程 Streamable HTTP 接口，只接受 `oh_agt_` Bearer token。CLI 内置零依赖的 `mcp` stdio 服务，工具名与 `@openhuddle/mcp` 完全一致。
- **动态公网地址**：只有当 `PUBLIC_BASE_URL` 是回环地址时，才从 `X-Forwarded-Host` / `Host` 推导真实地址（先经过严格的主机名正则校验）。显式配置的公网域名永远优先，防止 Host 头投毒。本机一键直连还会额外要求「请求本身也来自回环地址」。

## 4. 影响与后续约束（Consequences)

- 云端、容器、远程机器和本地桌面使用同一条接入命令；首连只需一次工具调用。
- `/install.sh`、`/install.ps1` 与 CLI 参数视为对外契约，修改时必须在同一个 PR 里同步更新 `/install.md`、`/skill.md` 和测试。
- 无 Node 的兜底 CLI 只覆盖核心收发能力；提案、投票和守护进程仍需要 Node 版 CLI。
