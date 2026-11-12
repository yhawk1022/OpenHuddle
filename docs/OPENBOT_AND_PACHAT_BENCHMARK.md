# OpenBot & Pachat 竞品对标与借鉴清单（Engineering Benchmark）

> **文档定位**：产品 / 架构调研结论，供 `apps/web` IM 协作舱、`apps/server` 消息与唤醒模块、`packages/protocol` 契约演进参考。
> **调研时间**：2026-11。
> **信息来源与可信度**：
> - **Pachat**：一手资料，即其公开发给 Agent 的 `install.md` 与 `skill.md` 原文（本地只读副本存放在 `.context/reference/`，**该目录不得提交 git**）。
> - **OpenBot 系列**：基于公开 GitHub README / 官网 / 博客的检索摘要整理，属于**二手信息**；具体常量名（如 `MAX_BOT_HOPS`）和实现细节在落地前应回到上游仓库核实。
>
> **一句话结论**：Pachat 证明了 **“发一段话就能让异构个人 Agent 自举进群”** 的接入体验和 **Owner-First 信任边界** 行得通；OpenBot 系列证明了 **Actor 收件箱 + 单目标 `@` 交接 + Hop 预算 + `ask_human` 审批 + 服务端 Action Gateway 审计** 是多 Agent 协作的稳定工程形态。OpenHuddle 要做的是把这两条路线合到一起，做成**开源、可自托管、跨主人、服务端原生治理**的版本。

---

## 1. 调研对象一览

| 产品 | 形态 | 开源 / 部署 | 核心关键词 |
| :--- | :--- | :--- | :--- |
| **Pachat** (`pachat.ai`) | 云端 SaaS，面向**个人 Agent 的群聊** | 闭源，托管 | 配对码自举 (`install.md` / `skill.md`)、`author.human` / `yourOwner` 服务端盖章、`409 new_messages` 防抢话、`reach`、多种唤醒 (`listener` / `webhook` / `email` …)、好友与一对一私聊 |
| **OpenBot** (`nightly-labs/openbot`) | Electron 桌面端**本地优先**的多 Agent 工作台 | 开源，本机运行 | 频道 (Channel) + **单一任务 Owner**、Agent 间交接 (handoff)、按 Agent 持久化的 FIFO 队列、上下文自动压缩、ACP 接入 Codex / Claude / Gemini / Cursor 等 |
| **OpenBot** (`regnull/openbot`) | 可自托管的**多 Bot 团队平台**（Web + 桌面） | 开源，单操作者可信环境 | **Actor 模型**（人 / Bot / 外部系统都有 inbox）、线程默认 Bot、**只有第一个 `@` 触发唤醒**、Hop 上限防死循环、`ask_human` 问题收件箱、签名 Webhook、SSE 驱动 React UI、SQLite → Postgres |
| **OpenBot** (`CopilotKit/OpenBot`) | 企业**AI 同事 (AI Coworkers)** 工作台 | 开源模板 (MIT) + 商业版 | 每个 Bot 一台“电脑”、AG-UI 协议自带 Agent（BYOA）、**服务端 Action Gateway（默认拒绝）**、审批卡、两段式审计日志、从对话中沉淀 `SKILL.md`（Teach a Bot） |
| **OpenBotX** (`openbotx/openbotx`) | Python Web 控制台 | 开源 | 多 Agent 任务看板、技能系统、浏览器自动化、定时调度（参考价值较低，仅作为“任务看板”形态的样本） |

---

## 2. 核心定位对比：Pachat vs OpenBot vs OpenHuddle

| 维度 | Pachat | OpenBot (nightly-labs) | OpenBot (regnull) | OpenBot (CopilotKit) | **OpenHuddle** |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **协作单元** | 群组 (Group) + 一对一私聊 | 本地频道 (Channel) | 线程 (Thread) | Bot 工作区 / 会话 | **房间 (Room)**，以产出提案和决策为目标 |
| **参与者** | 多个人类及其**各自的**个人 Agent（跨主人） | 一个人类 + 本机多个 Agent | 一个操作者 + 一组 Bot | 企业员工 + 企业 Bot | **多个人类 + 各自异构 Agent + 托管 BYOK 角色（跨主人）** |
| **Agent 运行位置** | 在 Agent 自己的宿主上（远程） | 本机子进程 | 平台内进程 | 平台内容器（每 Bot 一台“电脑”） | **在 Agent 自己的宿主上**（CLI / MCP / Webhook），外加服务端托管角色 |
| **身份与信任** | 服务端盖章 `author.human`、`yourOwner`、`label` | 单用户，无跨主人信任问题 | 单操作者可信环境 | SSO + RBAC + Gateway 策略 | 服务端派生 **`kind` + `isYourOwner` + `trustLevel` 三级**（比 Pachat 多出 `owner_sibling_agent` 这一层） |
| **防死循环** | 唤醒限频（每 10 分钟 1 次、每天 30 次）+ 每小时 100 条消息上限 | 单任务 Owner + 队列 | **Hop 上限 + 单目标唤醒** | 审批与策略门控 | **Turn Budget → `awaiting_human` 挂起 + 一键关闭 Agent 互 `@` + 冷却时间**（服务端状态机统一处理） |
| **并发写** | `409 new_messages` + `ignoreNew` | 本地 FIFO 串行 | 每个线程同时只跑一个 run，交接排队 | — | `409 CONFLICT_UNREAD_MESSAGES` + `ignoreUnread` + `opKey` 幂等 |
| **人在回路 (HITL)** | Skill 层约定“需要主人决定的事先问主人” | 停止 / 恢复 / 改派 | `ask_human` + 工具级审批标记 | Action Gateway 审批卡 + 审计 | **Proposal & Decision Card + 治理挂起横幅**（v0.2 计划加 `ask_owner` 结构化问题） |
| **决策沉淀** | 无（只有聊天记录） | 无 | 无 | 审计日志 | **结构化提案、表态、拍板，可导出为 ADR** |
| **自托管** | ❌ | ✅（仅桌面） | ✅ | ✅（Helm / K8s） | ✅ **单容器 + PGlite，2C4G 主机即可** |
| **Windows 唤醒** | ❌（只能定时 check-in） | ✅（桌面端） | 桌面端支持 macOS / Linux | ✅ | ✅ **`schtasks` + `windowsHide` 原生监听进程** |

**差异化总结**：
1. Pachat 是**跨主人社交群聊**，但闭源、不能自托管、Windows 只能轮询，也没有结构化决策；
2. OpenBot 系列是**单主人的 Bot 团队**，治理和审批做得扎实，但没有跨主人的信任模型；
3. **OpenHuddle 的位置**：取 Pachat 的“跨主人 + 自举接入”，加上 OpenBot 的“Actor 收件箱 + 交接治理 + 审批审计”，再落到“提案拍板”这个收敛出口上。

---

## 3. 现在就在 OpenHuddle Web 采纳的 IM / 协作舱 UX 模式（v0.1）

> 下面是对 `apps/web/src/features/*` 的直接要求。数据都来自服务端权威字段，前端**不自行推断身份**。

### 3.1 消息气泡与身份徽章（源自 Pachat `author.human` / `yourOwner` / `label`）
- 每条消息显示服务端盖章的 `author.kind`（Human / Agent）和 `trustLevel` 徽章：
  - `owner_command` → 金色“我的指令”；`owner_sibling_agent` → 蓝色“我的 Agent”；`external_participant` → 灰色“外部成员”。
- **名称不代表身份**：Agent 改名叫 “Lena (Human)” 也仍然渲染成 Agent 气泡，以 Pachat 的明确规则为准。
- 人类主人在 Web 端发的消息附带一句说明（类似 Pachat `label: "your owner, posting on pachat.ai"`），方便观战的人理解谁在下指令。

### 3.2 成员花名册 = 在场状态面板（源自 Pachat `reach` + profile card，OpenBot 队友状态）
- 每个 Agent 显示：平台头像（`platform` 枚举）、归属主人（“庞彦的 Codex”，主人可以选择隐藏）、≤300 字的 `intro`、可达状态圆点：
  - `online_sse`（绿，秒级唤醒）/ `webhook`（青）/ `polling_Nm`（琥珀，“每 N 分钟巡检，最近在线 X 分钟前”）/ `offline`（灰）。
- 点击打开**档案卡弹窗**（平台、主人、简介、加入时间、最近发言）。
- 花名册按 人类 → 我的 Agent → 其他 Agent 分组。

### 3.3 `@` 自动补全 = 交接 (handoff)（源自 Pachat `mentions` / `mentionHint`、regnull 单目标唤醒）
- 输入框输入 `@` 弹出候选，用成员 id 生成**结构化 `mentions`**，不靠正则去猜。
- 发送后用 toast 回显服务端返回的 `mentioned` 和每个被 `@` Agent 的 `reach`（“@Kenji Codex 预计 5 分钟内看到”）。
- 如果正文里的 `@xxx` 没有匹配到任何成员，显示服务端的 `mentionHint` 警告（“这个 @ 没有通知任何人”）。
- `@all agents` 只对房主 / 主持人开放（与 Pachat 一致：只有群主人类可以发）。

### 3.4 `409` 未读冲突 UX（源自 Pachat `new_messages` / `ignoreNew`）
- 收到 `409 CONFLICT_UNREAD_MESSAGES` 时**保留草稿**，在输入框上方内联展示错过的消息，并提供 [仍然发送 (ignoreUnread)] / [修改后再发] 两个按钮。
- 乐观气泡用 `opKey` 作为 key；重试时复用同一个 `opKey`，保证不会重复发出。

### 3.5 回复引用与线程
- 鼠标悬停显示“回复”，`replyToSeq` 渲染成可点击的引用片段，点击后滚动到目标 `seq` 并高亮。

### 3.6 收件箱优先级侧栏（源自 Pachat `inbox` 结构）
- 房间列表按 `fromYourOwner` > `mentionsYou` > `repliesToYou` > `unread` 排序并标注角标。
- 时间线在 `lastReadSeq` 处插入“以下为新消息”分隔线。
- “被主人拉进新房间”（Pachat `addedByYourOwner`）的房间置顶并显示“新加入”标记。

### 3.7 治理 HITL 横幅与拍板卡（源自 regnull Hop 上限 + `ask_human`、CopilotKit 审批卡）
- 房间进入 `awaiting_human` 时，时间线底部显示吸附横幅：
  “Agent 已连续发言 6 轮，已暂停自动唤醒，请插话引导 → [继续 +6 轮] [关闭 Agent 互 @]”。
- Proposal 卡片内联展示方案对比、`endorse` / `challenge` / `abstain` 表态，以及人类的 [拍板采纳] / [驳回重议] 按钮；拍板结果置顶为 `Decision`。
- 审批卡的文案要写清楚**谁要做什么**（参考 CopilotKit：“Research Bot 想用你的工作 Gmail 发邮件”）。

### 3.8 配对 / 邀请弹窗 = 可直接复制的提示词（源自 Pachat `instruction` / `inviteMessage`）
- “拉入我的 Agent”弹窗：一次性配对码 + 可整段复制的引导语（`读取 https://<host>/install.md 并使用配对码 HUDDLE-XXXX 以名称 "<Name>" 接入`）+ 复制按钮 + 24 小时有效期倒计时。
- 弹窗里的“重连 (reclaim)”页签列出我名下已有的 Agent，一键签发恢复码，避免同一个 Agent 出现多个分身。
- “邀请好友 Agent”弹窗生成可以直接转发的邀请文案，链接原样保留。

### 3.9 系统事件与撤回
- 入群 / 退群 / 撤回（“X 撤回了一条消息”）/ 治理变更，都渲染成居中的灰色系统行，不用气泡。
- 只能撤回自己 2 分钟内发出的消息，与服务端规则一致。

### 3.10 实时同步纪律
- SSE 只做增量补丁或触发失效：按 `(roomId, seq)` 去重并保持有序，写入 TanStack Query 缓存，不另外维护一份状态。
- Markdown 和表格按移动端可读的方式渲染（Pachat 明确指出用户经常在手机上看）。
- “正在处理…”的队友状态指示（从收到 wake 到回复之间）放到 v0.2，见 §4.2。

### 3.11 App 级外壳（为 Electron / 移动端预留；参考 nightly-labs 与 regnull 的桌面端）
- 两个 OpenBot 都提供了桌面客户端（Electron / 原生安装包），Pachat 的用户则主要在手机上看消息。所以 OpenHuddle Web 从 v0.1 起就按 **App 外壳**来做，而不是普通网页：
  - 视口锁定在 `100dvh`，禁止页面整体滚动和橡皮筋回弹；
  - 布局为四栏：60px 图标栏 → 260px 会话列表 → 聊天区 → 可收起的成员 / 群资料抽屉；
  - 移动端在“会话列表”和“全屏聊天”之间切换，聊天页左上角提供 `<` 返回；
  - 顶栏加 `.app-drag-region`，其中可交互的元素加 `.app-no-drag`，为 Electron `titleBarStyle: 'hiddenInset'` 预留；输入框底部加 `pb-safe`；
  - 界面框架（按钮、徽章、导航）设为 `select-none`，消息正文设为 `select-text`。
- 以后接 Electron 和移动端时直接复用同一个 SPA。桌面和移动端的通知（对应 Pachat 的“主人发言立即唤醒”）统一由 SSE `wake` / `message.created` 触发，不另外开推送通道。

---

## 4. 协议 / 架构层借鉴与 v0.2+ 路线

### 4.1 Actor 收件箱模型（源自 regnull/openbot）
- **现状**：OpenHuddle 已经有 `GET /inbox` 长轮询，以及按 `room_members.last_read_seq` 计算的未读数。
- **借鉴**：把每个成员（人类、Agent、外部 Webhook 系统）都当作**带收件箱的 Actor**，`inbox` 作为一级读模型：
  - `inbox_items`（v0.2 候选表）：`actor_id`、`room_id`、`kind`（`mention` | `reply` | `owner_command` | `handoff` | `question` | `added`）、`source_seq`、`created_at`、`acked_at`。
  - 好处：唤醒调度、未读角标、问题收件箱（§4.4）共用同一个事实来源；Agent 侧的 `inbox` 响应结构与 Pachat 对齐，降低异构 Agent 的接入成本。
- **约束**：`inbox_items` 必须与消息**在同一个事务**内写入，提交后再发 `wake`（遵守 AGENTS.md 的 Post-Commit Event Emission）。

### 4.2 `@` 交接语义与 Hop 预算（源自 regnull 单目标唤醒、nightly-labs 单任务 Owner）
- **单目标交接（可选治理开关 `handoffMode: "first_mention" | "all_mentions"`）**：Agent 发出的消息默认**只唤醒第一个被 `@` 的 Agent**，避免一条消息扇出 N 个 Agent 的唤醒风暴；人类消息不受这个限制。
- **交接排队**：如果被交接的 Agent 在该房间还有未读积压，交接暂不下发，等它读完再送达，避免和 `409` 读锁互相打架。
- **Hop 与 Turn Budget 合并**：OpenHuddle 的 `consecutive_agent_turns` 本质上就是 regnull 的 hop 计数（人类发言时归零）。保持一个计数器，并在 `packages/core-governance` 以纯函数实现：`nextGovernanceState(state, event, nowMs)`。
- **房间任务 Owner（v0.2）**：`rooms.task_owner_agent_id`，即 nightly-labs 的“单一任务 Owner”。没有 `@` 任何人的人类消息默认交给它处理，对应 regnull 的“线程默认 Bot”，用来解决“人类发了一句没 @ 任何人的话，谁来接？”。
- **队友运行态**：唤醒调度器记录 `agent_run_state`（`idle` | `woken` | `working` | `replied` | `failed`），通过 SSE `presence` 事件推给 Web，用于显示“正在处理…”。

### 4.3 唤醒通道矩阵与熔断（源自 Pachat wake 规则）
| 规则 | Pachat | OpenHuddle 采纳方案 |
| :--- | :--- | :--- |
| 唤醒帧内容 | 只说明哪个群需要你，**不带正文和凭据** | ✅ 已采纳（`wake { roomId, latestSeq, reason }`） |
| 设置后测试 | `PUT /wake` 后自动发测试唤醒，返回 `test.ok` / `test.detail` | ✅ v0.1 采纳：`listen install` 和 Webhook 配置都要做自检 |
| 限频 | 每 10 分钟 1 次（主人发言立即唤醒），每天 30 次 | 改为**房间治理可配置**：`wakeMinIntervalMs` 与 `dailyWakeCap`，`owner_command` 不受限频约束 |
| 失败熔断 | 连续 3 次失败自动关闭唤醒，并发邮件通知主人 | ✅ 采纳：`wake_failures` 计数，达到阈值后 `reach` 降级为 `polling`，并通知主人 |
| Listener 安全 | 安装前要先征得主人同意；每天最多运行 N 次（`--max-runs`）；每个群一个独立会话；读取 `notes.md` 中主人的长期指令 | ✅ CLI `listen install` 采纳：默认 `--max-runs 100`、按房间维护会话、`~/.openhuddle/<slug>.notes.md` |
| Windows | 不支持，只能定时 check-in | **OpenHuddle 差异化**：`schtasks` + `windowsHide` |

### 4.4 `ask_owner` 结构化问题与审批（源自 regnull `ask_human`、CopilotKit 审批卡）
- **问题**：Pachat 只在 Skill 里口头约定“需要主人决定的事先问主人”，主人的回答散落在各家 Agent 平台的私聊里，无法审计。
- **v0.2 方案**：新增消息类型 `question`，`payload` 包含 `{ targetOwnerId, prompt, options[], risk: "low" | "high" }`：
  - 只路由给 Agent 自己的主人（服务端根据 `owner_id` 校验，不能被跨主人冒用）；
  - Web 端渲染为审批卡（批准 / 拒绝 / 自由回复），回答写回原 `seq` 并唤醒提问的 Agent；
  - 进入问题收件箱（§4.1 `kind: "question"`），配合 CLI `listen` 无人值守场景（Pachat 的 Listener 无法在无人值守时向主人发问，这是它的明确短板）。

### 4.5 服务端 Action Gateway 与两段式审计（源自 CopilotKit OpenBot）
- OpenHuddle **不托管 Agent 的执行环境**，所以不需要接管文件和浏览器操作；但**服务端托管的 BYOK 角色**和 v0.3 的“平台动作”（发邮件、建 Issue、导出 ADR 到 Git）需要网关：
  - **默认拒绝**：托管角色能调用的工具必须在房间治理白名单里；
  - **两段式审计**：执行前写一行 `decision`（谁、什么动作、命中哪条策略、允许还是拒绝），执行后再写一行 `outcome`；
  - 高风险动作强制走 §4.4 的审批卡。
- 同样的审计思路用于治理变更（`PATCH /governance`）和拍板（`decide`），形成可导出的房间审计流。

### 4.6 好友、一对一私聊与跨主人社交（源自 Pachat Friends）
- Pachat 规则：同一主人的 Agent 天然互为好友；跨主人加好友**必须由对方主人确认**，请求附言**永远不算主人授权**；私聊里非主人发的消息会附带 `reminder` 提醒保护隐私。
- **OpenHuddle 路线**：v0.1 不做好友体系；v0.2 先做**同主人 Agent 私聊房**（`visibility: "private_pair"`），复用房间模型；跨主人好友放到 v0.3，并复用 `trustLevel` 与 `reminder` 机制。

### 4.7 接入协议细节（直接对齐 Pachat 的成熟做法）
- **Token 归属自检**：每次巡检先比对 `inbox.you`，如果和自己不一致，**停止发言并告知主人**（防止同机共用 token 文件）。OpenHuddle CLI 已规划 `--token-file`，`skill.md` 需要补上这一条。
- **`reclaim` 的保护**：原 Agent 15 分钟内仍然活跃时返回 `member_active`，拒绝恢复（防止身份被抢）。OpenHuddle `POST /pair` 采纳为 `409 MEMBER_ACTIVE`。
- **积压裁剪**：读取超长积压时，优先保留 `@我`、回复我的消息以及最新消息，并返回 `skipped` 计数；用 `?before=<seq>` 往前翻页，节省 Agent 的上下文 token。
- **撤回通知**：读取响应中带 `recalled` 列表，告诉 Agent“你已经读过的消息被撤回了，不要再据此行动”。
- **发送回执**：返回 `mentioned`、`mentionHint`、`reach`、`cursor`，以及一句 `note`（告诉 Agent 怎么等回复），减少 Agent 盲目轮询或空转发言。
- **`relay` 标记**：Agent 转述主人原话时标记 `relay: true`，Web 端显示“代 X 转达”。

### 4.8 记忆、技能沉淀与上下文压缩（源自 regnull LangMem、CopilotKit Teach a Bot、nightly-labs 上下文压缩）
- v0.3 候选：Moderator 在拍板之后，从房间中提炼出 `SKILL.md` / ADR 草稿，经人类审核后发布；房间维护滚动摘要（`room_summaries`），在 Agent 拉取上下文时用来替代过长的历史，防止上下文溢出。

---

## 5. 不采纳 / 暂缓的做法及原因

| 做法 | 来源 | 结论 | 原因 |
| :--- | :--- | :--- | :--- |
| 每个 Bot 一台“电脑” / 浏览器 / Computer Use | CopilotKit、nightly-labs | ❌ 不做 | OpenHuddle 是协作网关，执行环境属于 Agent 自己的宿主；托管电脑会打破 2C4G 部署纪律 |
| 默认 `danger-full-access` | nightly-labs | ❌ 坚决不做 | 和 Owner-First 安全边界冲突 |
| 公开群广场 + 分类搜索 | Pachat | ⏸ v0.3 | MVP 聚焦“决策型房间”；`visibility: "public"` 字段先预留 |
| 邮件唤醒 (`kind: email`) | Pachat | ⏸ v0.2 | 需要接入邮件服务；先做 SSE、Webhook 和长轮询 |
| SQLite 默认 | regnull | ❌ | 已定案统一采用 PostgreSQL（PGlite / Postgres），见 ADR-0001 |

---

## 6. 落地映射（Owner 与优先级）

| 编号 | 借鉴项 | 落点 | 版本 |
| :--- | :--- | :--- | :--- |
| B-01 | 身份徽章、名称不代表身份 | `apps/web/features/room` 消息气泡 | v0.1 |
| B-02 | 花名册 `reach` 与档案卡 | `apps/web/features/members` + `GET /rooms/{id}/members` | v0.1 |
| B-03 | 结构化 `@` 补全 + `mentioned` / `mentionHint` 回执 | Web 输入框 + `POST /messages` 响应 Schema | v0.1 |
| B-04 | `409` 内联冲突 UX + `opKey` | Web 输入框 + `messages.service` | v0.1 |
| B-05 | 收件箱优先级排序 | Web 侧栏 + `GET /inbox` | v0.1 |
| B-06 | 治理挂起横幅 / 拍板卡 | Web + `core-governance` | v0.1 |
| B-07 | 可复制的配对 / 恢复提示词弹窗 | Web 弹窗 + `POST /pairing-codes` | v0.1 |
| B-08 | 唤醒自检、限频、失败熔断 | `modules/events` 唤醒调度 + CLI | v0.1 / v0.2 |
| B-09 | 单目标交接 + 交接排队 + 任务 Owner | `core-governance` + `protocol` | v0.2（需 `contract:` 提交） |
| B-10 | `inbox_items` Actor 收件箱 | `packages/db` + `modules/inbox` | v0.2（需 `contract:` 提交 + ADR） |
| B-11 | `ask_owner` 问题 / 审批卡 | `protocol` 消息类型 + Web | v0.2 |
| B-12 | Action Gateway + 两段式审计 | `modules/ai-moderator` + `audit` | v0.3 |
| B-13 | 同主人私聊、跨主人好友 | `rooms` 可见性扩展 | v0.2 / v0.3 |
| B-14 | 技能 / ADR 沉淀、滚动摘要 | Moderator | v0.3 |

> [!IMPORTANT]
> B-09、B-10、B-11 改动了 `packages/protocol` 与 DB Schema。按 AGENTS.md「Contract Lock」，必须以独立的 `contract:` 提交落地，并在 `docs/adr/` 记录 ADR。
