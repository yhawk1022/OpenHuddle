# ADR-0005：统一多模态会话（1v1 单聊 Agent / 1v1 好友私聊 / 群聊）、好友申请制与跨主人 Agent 私聊沙箱

- **状态**：已采纳（Accepted）
- **日期**：2026-11-23
- **关联模块 / 文档**：`packages/protocol/src/{rooms,friends,events}.ts`、`packages/db/src/{schema,bootstrap}.ts`、`apps/server/src/modules/{friends,rooms,messages,events,pairing}/`、`apps/web/src/features/huddle-room/`、[ARCHITECTURE.md](../ARCHITECTURE.md)

---

## 1. 背景与问题陈述（Context）
早期 OpenHuddle 仅支持多方群聊房间（Group Huddle），人类成员加入房间依赖手动粘贴 `inv_...` 邀请码，且缺少以下高频协作场景：
1. **单聊个人 Agent（1v1 Direct Agent Chat）**：用户希望无需建群即可随时与自己绑定的个人 Agent（Claude Code、Codex、Antigravity 等）一对一私密对话；同时，部分用户希望将自己的专业角色 Agent 开放给站内同伴私聊咨询，但必须严防外部用户通过私聊 Prompt Injection 诱导越权操作宿主环境。
2. **与其他人类用户聊天（1v1 Direct Human Chat）**：团队与社区协作中需要人类之间的直接私聊，但若无准入机制将导致陌生人骚扰。用户明确选择采用**好友申请制**（发送好友请求 → 对方同意后建立好友关系与 1v1 私聊）。
3. **建群与群内直接拉人**：建立好友关系后，建群或群内邀请应支持直接勾选已添加的好友入群（同时保留原有的邀请码入群能力）。
4. **在线态新会话零漏推**：既有 SSE 订阅器仅在连接握手瞬间查询并挂载当时已加入的房间；当他人新建 1v1 私聊或将在线用户拉入新群时，若无用户级通道与动态挂载机制，首条消息将无法实时送达在线端。

## 2. 备选方案评估（Considered Options）
1. **方案 A（独立私聊表 `dm_threads` / `dm_messages`）**：群聊与私聊拆成两套表结构与两套读写接口。缺点是破坏单调递增 `seq`、乐观并发读锁（`409`）、撤回机制、CLI `openhuddle.mjs` 与 MCP 工具的同构性，导致四端代码翻倍。
2. **方案 B（统一 `rooms` 会话容器 + `kind` 判别式 + `direct_pair_key` 唯一约束 + 独立 `friendships` 关系状态机）**：复用成熟的 `rooms` / `room_members` / `messages` 事务底座，通过 `rooms.kind`（`group` | `direct_agent` | `direct_human`）区分会话语义，配合服务端视角化 `peer` 水合、好友关系强校验、跨主人 Agent `allow_external_dm` 显式授权开关与用户级 SSE 动态挂载。

## 3. 决策结果（Decision）
采用 **方案 B**，并强制执行以下核心架构与安全不变量（Invariants）：

1. **统一会话容器与确定性防重键（`rooms.kind` & `rooms.direct_pair_key`）**：
   - `rooms` 表新增 `kind TEXT NOT NULL DEFAULT 'group'` 与可空唯一索引列 `direct_pair_key TEXT UNIQUE`。
   - `direct_agent` 会话固定采用 `dm_agent:<humanUserId>:<agentId>` 作为唯一对键；`direct_human` 会话按字典序排序双方 `UserId` 生成 `dm_human:<lowUserId>:<highUserId>`，在数据库唯一约束层面彻底根绝并发重复创建多个 1v1 会话窗口。
   - 严禁在 `direct_agent` / `direct_human` 会话上执行邀请码入群（`/join`）、拉入第三人、签发自动入群配对码、退出半边会话或开启公开只读分享（`public_shareable`），违规一律拦截并返回 `400 DIRECT_ROOM_IMMUTABLE_ROSTER`。

2. **好友申请状态机与人类私聊准入（`friendships`）**：
   - 新增 `friendships` 表，以规范化无序对键 `pair_key = "<lowUserId>:<highUserId>"` 建唯一索引，确保任意两名用户间最多只存在一条关系记录。
   - 若甲向乙发起申请时，乙此前已向甲发起过待处理申请（双向互申），服务端在同一事务内自动合流升级为 `accepted` 好友状态。
   - 创建 `direct_human` 单聊、在 `direct_human` 中发送消息，以及建群/群内直接勾选拉入其他人类用户，服务端均强制校验双方当前处于 `accepted` 好友关系，否则拒绝并返回 `403 FORBIDDEN_NOT_FRIENDS`（解除好友后历史记录可读但阻断继续发消息防骚扰）。

3. **跨主人 Agent 私聊显式开关与 Owner-First 防注入铁律（`agents.allow_external_dm`）**：
   - `agents` 表新增 `allow_external_dm BOOLEAN NOT NULL DEFAULT FALSE`，仅 Agent 的人类归属主人可通过 `PATCH /api/v1/agents/{agentId}` 开启或随时关停。
   - 非归属主人请求打开 `direct_agent` 会话或在其中发言时，服务端实时校验 `targetAgent.allowExternalDm === true`；一旦主人关闭该开关，外部用户的后续发言立即以 `403 FORBIDDEN_EXTERNAL_AGENT_DM_DISABLED` 熔断阻断。
   - **唤醒原因与身份印章强隔离**：修正并固化 `MessagesService` 唤醒派发规则——仅当人类发言者确系目标 Agent 的绑定主人（`targetAgent.ownerUserId === caller.userId`）时，`wake.reason` 才可标记为 `"owner_command"`；外部人类在群聊或跨主人私聊中触发的唤醒一律降级为 `"direct_mention"`，消息 `AuthorStamp.trustLevel` 恒为 `"external_participant"`，且本地 CLI 守护进程提示词注入显式跨主人私聊防泄密护栏。

4. **用户级实时通道与在线动态房间挂载（`publishToUser` + `room.upserted`）**：
   - `RealtimeBus`（含 `InMemoryRealtimeBus` 与 `PostgresListenNotifyBus`）新增 `publishToUser` / `subscribeUser` 作用域，协议层新增 `room.upserted` 与 `friendship.updated` SSE 事件。
   - 当在线人类或 Agent 被加入新会话（新建私聊或被好友拉入群聊）时，事务提交后向目标推送 `room.upserted`，`EventsService` 在不中断现有长连接的前提下原地动态挂载 `subscribeRoom(roomId)`，实现首条消息毫秒级零丢失直达。

## 4. 影响与后续约束（Consequences）
- **正向收益**：100% 继承既有 `PGlite / PostgreSQL` 行级排他锁序号机制，CLI 与 MCP 无需学习第二套消息 API 即可天然收发单聊；Web 协作舱通过视角化 `peer` 元数据呈现原生 IM 级单聊/群聊与好友通讯录体验。
- **后续约束**：任何涉及房间成员增删或公开分享的扩展逻辑，必须首先校验 `room.kind === "group"`，不得破坏 `direct_*` 会话的双人封闭不变量。
