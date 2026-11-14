/**
 * @module server/modules/messages/service
 * @description 房间消息流增量读取、乐观并发防抢话锁（409）、治理预算熔断（429）、幂等写入与事务后唤醒服务。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 严格单调序号与锁顺序：发送消息事务内首先 `FOR UPDATE` 锁定 `rooms` 行，再执行幂等查重、`evaluatePreSendPolicy` 与 `applyCommittedMessageTurn`，彻底根绝并发撞号与预算逃逸。
 * 2. 双层身份零客户端信任：`authorKind`、`authorUserId`、`authorAgentId` 与 `ownerUserId` 100% 从服务端已验证 `caller` 注入，且读取时针对当前 `viewer` 实时计算 `trustLevel`。
 * 3. 事务后广播（Post-Commit Only）：`message.created`、`governance.updated` 与定向 `wake` 帧必须在事务提交成功后才发布到 `RealtimeBus`，防止被唤醒的 Agent 拉取增量时读不到尚未提交的新消息。
 */
import { applyCommittedMessageTurn, evaluatePreSendPolicy } from "@openhuddle/core-governance";
import {
  type AgentId,
  type AuthenticatedCaller,
  type MessageDto,
  type MessageMention,
  type MessageSeq,
  type ReadCursorSeq,
  type RoomGovernanceState,
  type RoomId,
  type SendMessageRequest,
  type UnreadConflictDetails,
  type WakeReason,
  asMessageSeq,
  asReadCursorSeq,
} from "@openhuddle/protocol";
import { AppError } from "../../infra/errors.js";
import { toActorMemberKey } from "../../infra/identity-stamp.js";
import type { RealtimeBus } from "../../infra/realtime-bus.js";
import {
  type MessagesRepository,
  type RoomAgentMentionTarget,
  stampRawMessageForViewer,
} from "./messages.repo.js";

/** 消息发送者自助撤回时间窗口（2 分钟） */
const AUTHOR_RECALL_WINDOW_MS = 2 * 60_000;

/**
 * 增量拉取房间消息的返回结果。
 */
export interface ReadMessagesResult {
  readonly ok: true;
  readonly messages: readonly MessageDto[];
  readonly latestSeq: ReadCursorSeq;
  readonly governance: RoomGovernanceState;
}

/**
 * 发送房间消息成功后的返回结果。
 */
export interface SendMessageResult {
  readonly ok: true;
  readonly message: MessageDto;
  readonly governance: RoomGovernanceState;
  readonly wokenAgentIds: readonly AgentId[];
}

/**
 * 构造 `MessagesService` 所需的依赖。
 */
export interface MessagesServiceDeps {
  readonly repo: MessagesRepository;
  readonly realtimeBus: RealtimeBus;
}

function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 合并客户端显式提交的 `mentions` 与消息正文中手打的 `@<displayName>` / `@<slug>` / `@全体` 在席 Agent 提及。
 *
 * @remarks
 * 这样无论用户通过前端输入器、CLI `openhuddle send` 还是直接手打 `@庞彦-OpenAICodex`、`@全体`、`@所有人`、`@all`，
 * 服务端都能统一识别并派发 `wake` 事件（仅允许人类触发全员 `@全体`，且自动过滤 Agent 自提及防止自回声死循环）。
 */
function resolveEffectiveMentions(
  content: string,
  explicitMentions: readonly MessageMention[],
  activeRoomAgents: readonly RoomAgentMentionTarget[],
  caller: Readonly<AuthenticatedCaller>,
): readonly MessageMention[] {
  const merged: MessageMention[] = [...explicitMentions];
  const mentionedAgentIds = new Set<AgentId>();
  for (const item of explicitMentions) {
    if (item.kind === "agent") {
      mentionedAgentIds.add(item.agentId);
    }
  }

  const lowerContent = content.toLowerCase();
  if (!lowerContent.includes("@")) {
    return merged;
  }

  // 安全边界：仅允许人类发言者手打 `@全体` / `@所有人` / `@all` / `@everyone` 唤醒房间全部在席 Agent，防止失控 Agent 广播风暴
  const mentionsAllAgents =
    caller.kind === "human" &&
    (content.includes("@全体") ||
      content.includes("@所有人") ||
      /(?<![a-z0-9._%+-])@(?:all|everyone)(?![a-z0-9_-])/iu.test(lowerContent));

  for (const agent of activeRoomAgents) {
    if (caller.kind === "agent" && caller.agentId === agent.agentId) {
      continue;
    }
    if (mentionedAgentIds.has(agent.agentId)) {
      continue;
    }

    if (mentionsAllAgents) {
      mentionedAgentIds.add(agent.agentId);
      merged.push({
        kind: "agent",
        agentId: agent.agentId,
        displayName: agent.displayName,
      });
      continue;
    }

    const lowerName = agent.displayName.trim().toLowerCase();
    const matchedByDisplayName = lowerName.length > 0 && lowerContent.includes(`@${lowerName}`);

    const lowerSlug = agent.slug.trim().toLowerCase();
    const slugPattern =
      lowerSlug.length > 0
        ? new RegExp(`(?<![a-z0-9._%+-])@${escapeRegexLiteral(lowerSlug)}(?![a-z0-9_-])`, "u")
        : null;
    const matchedBySlug = slugPattern?.test(lowerContent) === true;

    if (matchedByDisplayName || matchedBySlug) {
      mentionedAgentIds.add(agent.agentId);
      merged.push({
        kind: "agent",
        agentId: agent.agentId,
        displayName: agent.displayName,
      });
    }
  }

  return merged;
}

function didGovernanceChange(
  before: Readonly<RoomGovernanceState>,
  after: Readonly<RoomGovernanceState>,
): boolean {
  return (
    before.status !== after.status ||
    before.consecutiveAgentTurns !== after.consecutiveAgentTurns ||
    before.roundTableSpokenAgentIds.length !== after.roundTableSpokenAgentIds.length
  );
}

/**
 * 房间消息读写、并发防抢话锁与唤醒编排服务。
 */
export class MessagesService {
  private readonly repo: MessagesRepository;
  private readonly realtimeBus: RealtimeBus;

  /**
   * @param deps - 消息仓储与实时事件总线
   */
  public constructor(deps: Readonly<MessagesServiceDeps>) {
    this.repo = deps.repo;
    this.realtimeBus = deps.realtimeBus;
  }

  /**
   * 按 `seq > afterSeq` 增量拉取房间消息，针对当前查看者动态盖章 `AuthorStamp`，并自动推进已读游标。
   *
   * @param caller - 当前已认证调用者
   * @param roomId - 房间主键
   * @param options - 起始游标 `afterSeq` 与单页条数 `limit`
   * @returns 盖章后的增量消息列表、房间最新序号与当前治理状态
   * @throws {AppError} 房间不存在抛 `404`；调用者不在群内抛 `403 FORBIDDEN_NOT_ROOM_MEMBER`
   */
  public async listMessages(
    caller: Readonly<AuthenticatedCaller>,
    roomId: RoomId,
    options: {
      readonly afterSeq: ReadCursorSeq;
      readonly limit: number;
    },
  ): Promise<ReadMessagesResult> {
    const room = await this.repo.findRoomSnapshot(roomId);
    if (!room) {
      throw new AppError({
        code: "NOT_FOUND",
        statusCode: 404,
        message: `Room "${roomId}" was not found.`,
      });
    }

    const memberKey = toActorMemberKey(caller);
    const memberState = await this.repo.findMemberState(roomId, memberKey);
    if (!memberState) {
      throw new AppError({
        code: "FORBIDDEN_NOT_ROOM_MEMBER",
        statusCode: 403,
        message: "You must be a member of this room to read its messages.",
      });
    }

    const rawMessages = await this.repo.listAfterSeq(roomId, options.afterSeq, options.limit);
    const stampedMessages = rawMessages.map((msg) => stampRawMessageForViewer(msg, caller));

    const lastReturned = rawMessages[rawMessages.length - 1];
    const isCaughtUp =
      rawMessages.length < options.limit ||
      (lastReturned !== undefined && lastReturned.seq >= room.lastSeq);

    const targetReadSeq = isCaughtUp
      ? room.lastSeq
      : (lastReturned?.seq ?? memberState.lastReadSeq);

    await this.repo.advanceReadCursorMonotonically(roomId, memberKey, targetReadSeq);

    return {
      ok: true,
      messages: stampedMessages,
      latestSeq: asReadCursorSeq(room.lastSeq),
      governance: room.governanceJson,
    };
  }

  /**
   * 在排他行锁与纯函数治理引擎保护下发送房间消息，并在事务提交后派发实时广播与 Agent 唤醒帧。
   *
   * @param caller - 服务端权威认证的发送者
   * @param roomId - 目标房间主键
   * @param body - 消息正文、提及列表、幂等键 `opKey` 与乐观读游标 `lastReadSeq`
   * @returns 新写入的消息、更新后的治理快照与获准唤醒的 Agent ID 列表
   * @throws {AppError} 未读冲突抛 `409 CONFLICT_UNREAD_MESSAGES`（含 `missedMessages`）；预算/冷却/圆桌拦截抛 `429`
   */
  public async sendMessage(
    caller: Readonly<AuthenticatedCaller>,
    roomId: RoomId,
    body: Readonly<SendMessageRequest>,
  ): Promise<SendMessageResult> {
    const memberKey = toActorMemberKey(caller);
    const nowMs = Date.now();

    // ADR-0002 联邦铁律：结构化 Attention（等人作答）仅人类成员可发起，Agent 消息永不携带等人语义
    if (body.attention !== undefined && caller.kind !== "human") {
      throw new AppError({
        code: "ATTENTION_HUMAN_ONLY",
        statusCode: 403,
        message:
          "Attention questions can only be raised by human members; agent messages never carry awaiting-human semantics.",
      });
    }

    const txOutcome = await this.repo.runInTransaction(async (txRepo) => {
      // 1. 排他锁住房间行，严格串行化同一房间内的并发发言、游标核验与轮次预算计数
      const room = await txRepo.lockRoomForUpdate(roomId);
      if (!room) {
        throw new AppError({
          code: "NOT_FOUND",
          statusCode: 404,
          message: `Room "${roomId}" was not found.`,
        });
      }

      // 2. 校验房间成员身份并读取在席 Agent 集合
      const memberState = await txRepo.findMemberState(roomId, memberKey);
      if (!memberState) {
        throw new AppError({
          code: "FORBIDDEN_NOT_ROOM_MEMBER",
          statusCode: 403,
          message: "You must be a member of this room before sending messages.",
        });
      }

      const activeRoomAgents = await txRepo.listRoomAgentTargets(roomId);
      const activeRoomAgentIds = activeRoomAgents.map((agent) => agent.agentId);

      // 3. 优先校验客户端 opKey 幂等键：重试请求直接返回原消息，不消耗新序号或轮次预算
      if (body.opKey !== undefined) {
        const existingByOpKey = await txRepo.findByOpKey(roomId, body.opKey);
        if (existingByOpKey) {
          return {
            idempotentHit: true as const,
            rawMessage: existingByOpKey,
            previousGovernance: room.governanceJson,
            nextGovernance: room.governanceJson,
            permittedWakeAgentIds: [] as readonly AgentId[],
          };
        }
      }

      // 4. 调用零 I/O 纯函数领域核校验乐观并发读锁、预算挂起锁、冷却窗口与圆桌顺序
      const effectiveReadSeq: ReadCursorSeq =
        body.lastReadSeq ?? asReadCursorSeq(memberState.lastReadSeq);

      const policyDecision = evaluatePreSendPolicy(room.governanceJson, {
        caller,
        roomLastSeq: asReadCursorSeq(room.lastSeq),
        callerLastReadSeq: effectiveReadSeq,
        ignoreUnread: body.ignoreUnread,
        activeRoomAgentIds,
        nowMs,
      });

      if (!policyDecision.allowed) {
        if (policyDecision.errorCode === "CONFLICT_UNREAD_MESSAGES") {
          const missedRaw = await txRepo.listAfterSeq(roomId, effectiveReadSeq, 100);
          const missedMessages = missedRaw.map((m) => stampRawMessageForViewer(m, caller));
          const conflictDetails: UnreadConflictDetails = {
            latestSeq: asMessageSeq(room.lastSeq),
            yourLastReadSeq: effectiveReadSeq,
            missedMessages,
          };
          throw new AppError({
            code: "CONFLICT_UNREAD_MESSAGES",
            statusCode: 409,
            message: policyDecision.reason,
            details: conflictDetails,
          });
        }

        throw new AppError({
          code: policyDecision.errorCode,
          statusCode: 429,
          message: policyDecision.reason,
          ...(policyDecision.retryAfterMs !== undefined
            ? { details: { retryAfterMs: policyDecision.retryAfterMs } }
            : {}),
        });
      }

      // 5. 计算下一个严格连续序号与候选唤醒目标集合（含正文 @昵称 / @slug 自动解析）
      const nextSeq = asMessageSeq(room.lastSeq + 1);
      const activeAgentSet = new Set<AgentId>(activeRoomAgentIds);
      const effectiveMentions = resolveEffectiveMentions(
        body.content,
        body.mentions,
        activeRoomAgents,
        caller,
      );
      const candidateWakeAgentIds: AgentId[] = [];

      for (const mention of effectiveMentions) {
        if (mention.kind === "agent" && activeAgentSet.has(mention.agentId)) {
          candidateWakeAgentIds.push(mention.agentId);
        }
      }

      // 圆桌模式或房间内仅有唯一在席 Agent 时，人类直接发言无需手打 @昵称 也会自然唤醒目标 Agent
      if (
        caller.kind === "human" &&
        candidateWakeAgentIds.length === 0 &&
        (room.governanceJson.config.mode === "round_table" || activeRoomAgentIds.length === 1)
      ) {
        candidateWakeAgentIds.push(...activeRoomAgentIds);
      }

      // 6. 演进房间治理状态机并过滤最终获准唤醒的 Agent 名单
      const transition = applyCommittedMessageTurn(room.governanceJson, {
        sender: caller,
        candidateWakeAgentIds,
        activeRoomAgentIds,
        nowMs,
      });

      // 7. 严格以服务端验证后的 caller 身份写入消息（杜绝客户端伪造 author），并推进房间序号与发送者游标
      const insertedRaw = await txRepo.insertMessage({
        roomId,
        seq: nextSeq,
        caller,
        type: body.attention !== undefined ? "attention" : "text",
        content: body.content,
        ...(body.replyToSeq !== undefined ? { replyToSeq: body.replyToSeq } : {}),
        mentions: effectiveMentions,
        ...(body.opKey !== undefined ? { opKey: body.opKey } : {}),
        ...(body.attention !== undefined ? { payloadJson: body.attention } : {}),
      });

      await txRepo.updateRoomSeqAndGovernance(roomId, nextSeq, transition.nextState);
      await txRepo.advanceReadCursorMonotonically(roomId, memberKey, nextSeq);

      return {
        idempotentHit: false as const,
        rawMessage: insertedRaw,
        previousGovernance: room.governanceJson,
        nextGovernance: transition.nextState,
        permittedWakeAgentIds: transition.permittedWakeAgentIds,
      };
    });

    const messageForSender = stampRawMessageForViewer(txOutcome.rawMessage, caller);

    // 关键事务后不变量（Post-Commit Only）：仅在数据库事务已提交且非幂等重复命中时向 RealtimeBus 派发事件
    if (!txOutcome.idempotentHit) {
      await this.realtimeBus.publishToRoom(roomId, {
        type: "message.created",
        roomId,
        message: messageForSender,
      });

      if (didGovernanceChange(txOutcome.previousGovernance, txOutcome.nextGovernance)) {
        await this.realtimeBus.publishToRoom(roomId, {
          type: "governance.updated",
          roomId,
          governance: txOutcome.nextGovernance,
        });
      }

      const wakeReason: WakeReason = caller.kind === "human" ? "owner_command" : "direct_mention";
      for (const targetAgentId of txOutcome.permittedWakeAgentIds) {
        await this.realtimeBus.publishToAgent(targetAgentId, {
          type: "wake",
          roomId,
          latestSeq: txOutcome.rawMessage.seq,
          reason: wakeReason,
        });
      }
    }

    return {
      ok: true,
      message: messageForSender,
      governance: txOutcome.nextGovernance,
      wokenAgentIds: txOutcome.permittedWakeAgentIds,
    };
  }

  /**
   * 撤回指定消息（原发送者允许在发送后 2 分钟内撤回，房间人类群主可随时撤回违规消息）。
   *
   * @param caller - 当前已认证调用者
   * @param roomId - 房间主键
   * @param seq - 待撤回消息序号
   * @returns 撤回后的 `MessageDto`
   * @throws {AppError} 超出 2 分钟窗口抛 `400 MESSAGE_RECALL_WINDOW_EXPIRED`；无权限抛 `403 FORBIDDEN_NOT_OWNER`
   */
  public async recallMessage(
    caller: Readonly<AuthenticatedCaller>,
    roomId: RoomId,
    seq: MessageSeq,
  ): Promise<MessageDto> {
    const memberKey = toActorMemberKey(caller);
    const now = new Date();

    const recalledRaw = await this.repo.runInTransaction(async (txRepo) => {
      const room = await txRepo.lockRoomForUpdate(roomId);
      if (!room) {
        throw new AppError({
          code: "NOT_FOUND",
          statusCode: 404,
          message: `Room "${roomId}" was not found.`,
        });
      }

      const memberState = await txRepo.findMemberState(roomId, memberKey);
      if (!memberState) {
        throw new AppError({
          code: "FORBIDDEN_NOT_ROOM_MEMBER",
          statusCode: 403,
          message: "You must be a member of this room.",
        });
      }

      const targetMsg = await txRepo.findBySeq(roomId, seq);
      if (!targetMsg) {
        throw new AppError({
          code: "NOT_FOUND",
          statusCode: 404,
          message: `Message seq=${seq} was not found in room "${roomId}".`,
        });
      }

      const isRoomHumanOwner =
        caller.kind === "human" &&
        (room.ownerUserId === caller.userId || memberState.role === "owner");

      const isOriginalAuthor =
        caller.kind === "human"
          ? targetMsg.rawAuthor.kind === "human" && targetMsg.rawAuthor.userId === caller.userId
          : targetMsg.rawAuthor.kind === "agent" && targetMsg.rawAuthor.agentId === caller.agentId;

      if (!isRoomHumanOwner && !isOriginalAuthor) {
        throw new AppError({
          code: "FORBIDDEN_NOT_OWNER",
          statusCode: 403,
          message: "Only the message author or the human room owner can recall this message.",
        });
      }

      if (
        !isRoomHumanOwner &&
        now.getTime() - targetMsg.createdAt.getTime() > AUTHOR_RECALL_WINDOW_MS
      ) {
        throw new AppError({
          code: "MESSAGE_RECALL_WINDOW_EXPIRED",
          statusCode: 400,
          message: "Messages can only be recalled by their author within 2 minutes of sending.",
        });
      }

      return txRepo.recallMessage(roomId, seq, now);
    });

    return stampRawMessageForViewer(recalledRaw, caller);
  }
}
