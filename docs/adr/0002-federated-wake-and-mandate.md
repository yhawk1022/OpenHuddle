# ADR-0002：联邦化授权与注意力协议——借鉴 dsh-superagent 的机制、拒绝其单一信任域

- **状态**：提议（Proposed，待团队评审）
- **日期**：2026-11-14
- **关联文档**：[ADR-0001](./0001-foundational-architecture-and-stack.md)、[ARCHITECTURE.md](../ARCHITECTURE.md)
- **外部参考**：[deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype)（MIT，Router-Worker 研究原型）及其《Domain concepts》设计文档

---

## 1. 背景与问题陈述（Context）

OpenHuddle 的核心差异化是**跨主人本地 Agent 协作**：不同人的个人 Agent（Claude Code / Codex / Antigravity / DeepSeek Harness…）在同一房间平权研讨，由人类终审。当前治理体系存在四个结构性缺口：

1. **拍板无授权语义**：`DecisionCard` 的 `approved/rejected` 是裸布尔值——"谁批准了什么范围、基于哪版群规、对谁有效"不可追溯；跨主人场景下 Alice 的批准不应指挥 Bob 的 Agent，但协议层无从表达。
2. **等人无结构**：轮次预算耗尽只有一句"请插话引导"的提示；"在等哪个人类、等什么问题、等多久"全靠从自由文本里猜。
3. **唤醒是机械匹配**：`@mention`/`@全体` 即唤醒，无法表达"我的 Agent 只在工作时段响应""这类任务别烧我的 token"——每主人对自有 Agent 的私有策略没有协议位置。
4. **Agent 消息的语义边界未成文**：互 `@` 熔断是补丁式的；缺少一条宪法级规则来界定 Agent 消息能/不能触发什么。

DeepSeek 的 dsh-superagent 提供了一套严谨的"事件 → 判断 → 授权 → 工作"领域模型（`Trigger` / `Eval` / `Ticket` / `Mandate` / `Attention` / `Policy`），但其前提是**单一信任域**：一个主人、一份 Policy、一个授权者，Executor 天然服从 Router。直接照搬意味着引入房间级中央 Router——任何中央大脑都无权指挥他人的 Agent，也无人能审计它，与 Owner-First 信任边界根本冲突。

## 2. 备选方案评估（Considered Options）

1. **方案 A：原样引入 dsh 的中央 Router-Worker 模型**
   - *优势*：判断/授权/工作分层清晰，单主人场景已被 dsh 验证。
   - *劣势*：违反 Owner-First——房间级 Router 指挥他人 Agent 无授权依据；引入"无人可审计的中央大脑"；N 主人 × M Agent 的策略冲突无解。
2. **方案 B：维持现状（机械治理 + 裸拍板）**
   - *优势*：零改动成本。
   - *劣势*：授权流不可审计；多人等待无结构；唤醒 token 浪费随群规模线性放大；与"决策平台"定位的差距随协作复杂度暴露。
3. **方案 C（本 ADR 推荐）：联邦化改造——房间共享确定性 Gate，每主人持有私有 Assessment 与 Mandate 边界**
   - *优势*：完整吸收 dsh 的机制词汇（Mandate / Attention / Policy / 幂等 Trigger / 自消息丢弃），但把授权权柄留在每个主人手里；与既有 `trustLevel` 体系同一哲学的自然延伸。
   - *劣势*：协议字段与治理状态机需分四个阶段渐进交付（见 §3.5）。

## 3. 决策结果（Decision）

采纳**方案 C**，确立四条支柱：

### 3.1 双层 Policy（房间 Gate + 主人私有策略）

- **房间层**（已存在）：`governance_json`（轮次预算、互 `@` 熔断、圆桌模式）——全体成员共商的确定性 Gate，语义不变。
- **主人层**（新增）：`agents.wake_policy_json`，每主人对自己的 Agent 声明私有策略，至少覆盖：静音时段（如 `quietHours`）、任务类型许可（如拒绝执行他人提议的 shell 类任务）、每房每日唤醒预算。服务端唤醒分发器（`filterWakeTargets`）与 Agent 本地 harness **双重执行**——服务端过滤是优化，本地拒绝是边界。

### 3.2 Mandate 作用域（授权只及于批准者名下 Agent）

`DecisionCard` 新增 `mandate` 字段：

```ts
{
  scope: string,               // 授权做什么（自然语言 + 结构化标签）
  strength: "suggest" | "act" | "act_with_review",
  policyVersion: number,       // 基于哪一版房间治理/提案时的群规快照
  approverUserIds: UserId[],   // 谁批准——授权力仅及于其名下 Agent
}
```

- 非批准者名下的 Agent 收到该 Decision 时，`trustLevel` 语义自动降级为参考信息（`external_participant` 视角）。
- 挂起后恢复（resume）必须重验 Mandate 仍被当前 Policy 覆盖（对齐 dsh 的 "ended Tickets revalidate Mandate"）。

### 3.3 收件人 Attention（结构化等人，带明确指向）

新增消息类型 `attention`：

```ts
{
  question: string,
  options: string[],           // 可选的一键作答项
  addresseeUserIds: UserId[],  // 在等哪个人类（谁的 Agent 提问默认等谁）
  expiresAtIso: string,        // 截止；超时未答自动沉没为普通系统提示
}
```

- 人类点击选项即在时间线内生成回复（免跳转弹窗）；作答可直接驱动治理状态机（如解除 `paused_budget`）。
- **Agent 消息永不创建 Attention**（见 3.4）；只有人类消息与 AI Moderator（无投票权主持人）可以。

### 3.4 Agent 无授权语义（宪法条款）

写入 `packages/core-governance` 的不变量测试，服务端强制：

1. Agent 消息**不重置**轮次预算、**不解除** `paused_budget` / 熔断态；
2. Agent 消息**不赋予**任何执行授权、**不创建** Attention；
3. 回复引用（`replyTo`）仅提供上下文，**不构成**唤醒路由或授权依据（对齐 dsh "Correlation never routes"）。

### 3.5 迁移路径（四阶段，全部向后兼容）

| 阶段 | 内容 | 依赖 |
| --- | --- | --- |
| P1 | 协议新增 `mandate` / `attention` / `wake_policy_json`（全部 optional-first，v0.1 客户端零破坏） | `packages/protocol` 独立 contract 提交 |
| P2 | 治理状态机吸收 §3.4 四条铁律（纯函数 + 100% 分支测试） | P1 |
| P3 | 拍板卡 Mandate UI + 时间线 Attention 一键作答 | P1 |
| P4 | Assessment 智能唤醒：BYOK AI Moderator 在确定性 Gate 之上判断"这条消息值不值得唤醒谁"（对齐 dsh Eval 的 Gate+Assessment 双层；哲学镜像：dsh 省人的注意力，OpenHuddle 省 Agent 的 token） | P1–P3 稳定后 |

## 4. 影响与后续约束（Consequences）

- **正面影响**：授权流可审计（谁、凭哪版规则、批了什么、对谁有效）；多人等待有结构；唤醒浪费有主人侧闸门；与 dsh 概念体系互通（`Trigger` 幂等 ↔ `opKey`，read position ↔ `seq` 游标，自消息丢弃 ↔ 互 `@` 熔断——既有设计获独立印证）。
- **工程约束**：所有新协议字段必须 optional-first 落地并同步 OpenAPI/文档；`core-governance` 保持零 I/O 纯函数，铁律以不变量测试固化；对外部机制的引用（dsh-superagent）须在代码文档与本 ADR 注明出处，避免无溯源搬运。
- **明确不做**：房间级中央 Router、执行沙箱/子 Agent 池、跨主人记忆聚合——执行与记忆永远留在各 Agent 自己的主机（Owner-First 边界，参见 ADR-0001 §3）。
