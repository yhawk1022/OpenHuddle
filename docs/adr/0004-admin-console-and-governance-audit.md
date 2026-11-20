# ADR-0004：集成式运营与治理管理后台（Admin Console）及安全审计设计

- **状态**：已采纳（Accepted）
- **日期**：2026-11-20
- **关联模块 / 文档**：`packages/protocol/src/admin.ts`、`packages/db/src/schema.ts`、`apps/server/src/modules/admin/`、`apps/web/src/features/admin-console/`、[ARCHITECTURE.md](../ARCHITECTURE.md)

---

## 1. 背景与问题陈述（Context）
随着 OpenHuddle 支持多人类主理人、个人 Agent、群聊治理与结构化提案拍板，平台自托管运维者迫切需要一个集中的运营与治理后台，以解决以下需求：
1. **全局观测与统计**：实时掌握注册用户、活跃会话、SSE 在线 Agent、群聊活跃度与消息/提案增长趋势。
2. **账号与安全边界管控**：支持授予/撤销管理员、封禁违规账号（并同步切断其 Web 会话与名下 Agent）、强制踢下线与安全注销用户。
3. **跨房内容监管与合规审计**：在不污染成员 `last_read_seq` 游标的前提下审查任意群聊消息，支持超窗强制撤回、热调控房间治理规则/预算、解散违规群聊，并对所有后台写操作留下不可变审计日志。
4. **2C4G 部署纪律约束**：方案必须保持单容器同端口部署、免外部组件、普通用户聊天首屏零额外 JS 负载。

## 2. 备选方案评估（Considered Options）
1. **方案 A（拆分为独立 `apps/admin` 应用与独立鉴权密钥）**：需要维护第二套构建/容器与反代配置，且独立 `ADMIN_TOKEN` 无法与人类审计身份一一关联。
2. **方案 B（集成单容器架构：RBAC + `ADMIN_EMAILS` + `/admin` 按需拆包 + `/api/v1/admin/*`）**：后端在现有 Hono 网关内增加 `/api/v1/admin/*`（自动进入 OpenAPI `/api/docs`），前端通过 `React.lazy` 将 `/admin` 拆分为独立异步 chunk；认证复用人类账号会话（邮箱密码 / OTP）与 `ADMIN_EMAILS` 环境变量白名单，由服务端在鉴权层强制阻断 Agent 令牌（`oh_agt_`）。

## 3. 决策结果（Decision）
采用 **方案 B**，并确立以下核心不变量（Invariants）：
1. **管理员引导与 RBAC 隔离**：
   - `users` 表新增 `role`（`user` | `admin`）、`status`（`active` | `suspended`）、`suspended_at`、`suspended_reason`、`last_login_at`。
   - 当配置了 `ADMIN_EMAILS` 时，命中白名单的邮箱在登录或会话校验时自动锁定为 `admin`；当未配置且库内尚无管理员时，首个注册用户（及本地开发环境升级时的最早用户）自动升级为 `admin`。
   - `/api/v1/admin/*` 统一挂载 `createRequireAdminMiddleware`，任何 Agent 令牌或普通用户一律返回 `403 FORBIDDEN_ADMIN_ONLY`。
2. **封禁双端联动阻断（Owner-First 延伸）**：
   - 封禁用户时事务内清空其所有 `user_sessions` 并写入 `status = "suspended"`，事务提交后驱逐其名下全部 Agent 的内存 SSE 订阅；此后该用户请求验证码、密码登录、校验会话或名下任意 Agent 持 `oh_agt_` 令牌调用接口，均被强制拒绝并返回 `403 ACCOUNT_SUSPENDED`。
3. **安全护栏（Guardrails）**：
   - 禁止管理员对自身执行降权、封禁或删除；禁止在界面对 `ADMIN_EMAILS` 环境变量锁定超管执行降权/封禁/删除；禁止降权、封禁或删除全站最后一名活跃管理员（均抛出 `400 ADMIN_GUARDRAIL_VIOLATION`）。
4. **安全级联删户与 Owner-First 不变量**：
   - 删除用户时，先删除其名下房间（触发成员/消息/提案级联清理）并清除相关配对码引用，再直接删除该用户（或其名下 Agent）在其他房间发送的消息，**严禁将 `messages.owner_user_id` 改挂给他人**，保证跨主人信任印章语义绝不被污染。
5. **只读审查游标零污染与强制审计**：
   - 管理员查询房间消息流不推进任何 `room_members.last_read_seq`。
   - 所有后台写操作均在同一数据库事务内向 `admin_audit_logs` 写入操作人邮箱/昵称快照、动作枚举、目标与摘要；房间解散、治理变更与强制撤回在事务提交后推送 SSE 实时事件。

## 4. 影响与后续约束（Consequences）
- **正向收益**：零新增运维容器，Web 构建产物中 `admin-console` 独立拆包加载，管理员在聊天气泡导轨与 `⌘K` 面板一键直达后台，非管理员入口完全不可见。
- **技术权衡**：所有跨房消息与用户统计聚合均采用 PGlite 与 PostgreSQL 16+ 兼容的标准 SQL 编写，后续新增业务表外键引用 `users.id` 时，必须在 `AdminRepository.deleteUserCascadeInTx` 中同步补充清理逻辑。
