# ADR-0003：人类邮箱+密码注册登录体系与零外部依赖原生 SMTP 邮件投递

- **状态**：已采纳（Accepted）
- **日期**：2026-11-20
- **关联模块 / 文档**：`packages/protocol/src/auth.ts`、`packages/db/src/schema.ts`、`apps/server/src/infra/mailer.ts`、`apps/server/src/modules/auth/`、`apps/web/src/features/auth-pairing/`、[ARCHITECTURE.md](../ARCHITECTURE.md)

---

## 1. 背景与问题陈述（Context）

OpenHuddle v0.1 早期仅实现了开发态邮箱 OTP 登录（`POST /api/v1/auth/otp/request` + `verify`）：
1. **生产环境无法真正发信**：验证码仅落库并返回 `devOtpCode`，在 `NODE_ENV=production` 且关闭回显时无外部发信通道，导致生产用户无法登录。
2. **缺少独立注册、登录与密码管理闭环**：未区分注册与登录、不支持日常密码登录、缺乏忘记密码/修改密码、缺少注册开关与域名白名单自托管治理，也缺少重发冷却与错误次数防爆破保护。
3. **2C4G 单容器部署约束**：生产容器基于 `node:22-bookworm-slim`（无 Python 运行时，限制 V8 堆内存 `512MB`），发信方案需原生兼容阿里云 DirectMail（`smtpdm.aliyun.com:465` 隐式 TLS + `smtp.json` 凭据，参考 `cyanarch-mail.py`）与标准 Docker 环境变量，同时不引入重型三方依赖或 native C++ 编译插件。

## 2. 备选方案评估（Considered Options）

1. **方案 A：邮箱+密码为主 + 邮箱 6 位验证码激活注册与重置密码 + 零外部依赖原生 Node.js `node:tls`/`node:net` SMTP 客户端 + `node:crypto.scrypt` 密码哈希（保留旧 OTP 路由兼容）**
   - *优势*：日常登录零等待收件；注册与重置密码强绑定邮箱真实性核验；零新增 npm/Python/C++ 依赖，容器体积与攻击面最小；`scrypt` 内存困难 KDF 在 libuv 线程池异步运行不阻塞 SSE 事件循环；完整兼容 `SMTP_*` 环境变量与 `SMTP_CREDENTIALS_FILE`（`~/.config/cyanarch-mail/smtp.json` + 默认 `smtpdm.aliyun.com:465`）。
   - *劣势*：需在服务端自研完善的 SMTP 多行响应解析、RFC 2047 UTF-8 编码、点号转义与超时清理，需配齐真实回环 TCP 协议级测试。
2. **方案 B：服务端调用外部 Python 脚本（`cyanarch-mail.py`）发信**
   - *优势*：直接复用脚本。
   - *劣势*：破坏单容器 Node 镜像纯粹性（`node:22-bookworm-slim` 默认无 Python3），子进程派生在并发下开销高且跨平台错误码难以结构化映射。
3. **方案 C：仅保留无密码邮箱 OTP 登录**
   - *优势*：无需存储密码哈希。
   - *劣势*：每次重新登录均需等待收件箱送达，且与用户明确的「邮箱验证注册 + 日常密码登录 + 邮箱验证码找回密码」诉求不符。

## 3. 决策结果（Decision）

采纳 **方案 A**，确立以下核心设计不变量（Invariants）：

1. **认证流程与兼容策略**：
   - **注册（`POST /auth/register/request-code` → `POST /auth/register`）**：必须先通过邮箱 6 位验证码激活核验，再提交昵称与 8–128 位密码创建账号并签发 `oh_ses_` 会话；重复邮箱返回 `409 EMAIL_ALREADY_REGISTERED`。
   - **日常登录（`POST /auth/login`）**：仅使用邮箱 + 密码；对不存在邮箱或早期无密码账号仍执行同等耗时虚拟 `scrypt` 校验，统一返回 `401 INVALID_CREDENTIALS` 防止账号枚举。
   - **忘记密码 / 修改密码（`/auth/password-reset/*`、`/auth/password/change`）**：通过邮箱 6 位验证码重设密码或已登录修改密码（同步允许早期无密码老用户首次补设密码）；改密成功在同一事务内**清空该账号全部历史 `user_sessions`** 并签发全新会话令牌。
   - **旧版 OTP 兼容**：保留 `POST /auth/otp/request` 与 `POST /auth/otp/verify` 向后兼容，并接入相同的用途隔离（`purpose = "login"`）、5 次错误熔断与真实 SMTP 投递。
2. **验证码安全隔离与失败回滚**：
   - `auth_otp_codes` 引入 `purpose`（`register` | `password_reset` | `login`）与 `attempt_count`；跨用途不可复用；单码输错 5 次触发 `429 OTP_ATTEMPTS_EXCEEDED` 并原子作废；核销采用 `UPDATE ... WHERE consumed_at IS NULL RETURNING id` 消除并发双花。
   - SMTP 投递失败时自动回滚刚插入的验证码记录并抛出 `502 EMAIL_DELIVERY_FAILED`，避免用户被 60 秒重发冷却误伤。
3. **SMTP 双源配置与生产安全闭环**：
   - 支持标准 `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` / `SMTP_FROM_NAME` / `SMTP_TIMEOUT_MS`，并支持 `SMTP_CREDENTIALS_FILE`（支持 `~/` 展开，缺省主机对齐阿里云 DirectMail `smtpdm.aliyun.com:465` 隐式 TLS）；环境变量优先级高于文件值。
   - 未配置 SMTP 时：开发/测试环境自动回退 `dev_echo` 返回 `devOtpCode`；生产环境默认快速失败返回 `503 EMAIL_DELIVERY_UNAVAILABLE`（绝不静默吞掉验证码）。
4. **自托管注册准入与全链路防刷**：
   - 支持 `ALLOW_PUBLIC_SIGNUP`（默认 `"true"`）、`ALLOWED_EMAIL_DOMAINS`（可选域名白名单）与 `OTP_RESEND_COOLDOWN_SEC`（默认 `60`），并通过无敏感信息的 `GET /api/v1/auth/config` 驱动前端 UI 自适应呈现。
   - 叠加数据库级重发冷却 + 单邮箱每小时上限（10 次）+ 有界内存 IP / `(IP, email)` 滑动窗口限流。

## 4. 影响与后续约束（Consequences）

- **正面影响**：OpenHuddle 具备可直接上线自托管的完整账户注册、登录、找回密码、改密与真实 SMTP 邮件投递能力，零新增第三方运行时依赖，完全符合 2C4G 单容器内存红线。
- **工程约束**：
  - `users.password_hash` 严禁出现在任何 `HumanUserDto`、管理后台列表或日志字段中；仅暴露脱敏布尔值 `hasPassword` 与 `emailVerified`。
  - 所有邮件头字段必须经过 CR/LF 注入校验，所有中文主题与发件人名称统一按 RFC 2047 UTF-8 Base64 编码，正文采用 `multipart/alternative`（Base64 编码纯文本 + 内联样式 HTML）。
