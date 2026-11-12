/**
 * @module server/modules/proposals/service
 * @description 结构化提案发起、AI 主持人讨论提炼、多 Agent 表态投票与人类最终拍板（Approve / Reject）领域服务。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 严格人类最终裁决权（Human-in-the-Loop Gate）：任何 Agent 均可发起提案或投出 `endorse | challenge | abstain` 票，但仅房间内 `owner | moderator` 人类可执行 `decideProposal` 固化最终结论，越权调用一律返回 `403 FORBIDDEN_NOT_OWNER`。
 * 2. 房间序号排他锁：每次提案创建、投票与拍板均向 `messages` 时间线原子追加事件记录（`proposal | vote | decision`），必须与普通发言遵循完全一致的 `rooms FOR UPDATE` 锁序。
 * 3. 事务后广播（Post-Commit Only）：`message.created`、`proposal.updated` 与 `wake` 事件严格在事务提交成功后投递至 `RealtimeBus`。
 */
import {
  type AuthenticatedCaller,
  type CastProposalVoteBody,
  type DecideProposalBody,
  type ProposalCardDto,
  type ProposalDraft,
  type ProposalId,
  type RoomId,
  type SynthesizeProposalBody,
  asMessageSeq,
  asReadCursorSeq,
} from "@openhuddle/protocol";
import { assertHumanCaller } from "../../infra/auth-middleware.js";
import { generateProposalId } from "../../infra/crypto.js";
import { AppError } from "../../infra/errors.js";
import { toActorMemberKey } from "../../infra/identity-stamp.js";
import type { RealtimeBus } from "../../infra/realtime-bus.js";
import type { AiModeratorService } from "../ai-moderator/ai-moderator.service.js";
import { type MessagesRepository, stampRawMessageForViewer } from "../messages/messages.repo.js";
import type { RoomsRepository } from "../rooms/rooms.repo.js";
import { type ProposalsRepository, stampRawProposalForViewer } from "./proposals.repo.js";

/**
 * 构造 `ProposalsService` 所需的依赖。
 */
export interface ProposalsServiceDeps {
  readonly proposalsRepo: ProposalsRepository;
  readonly roomsRepo: RoomsRepository;
  readonly messagesRepo: MessagesRepository;
  readonly aiModerator: AiModeratorService;
  readonly realtimeBus: RealtimeBus;
}

/**
 * 校验提案草稿内部备选方案键（`optionKey`）唯一性及推荐方案键合法性。
 *
 * @param draft - 待校验提案草稿
 * @throws {AppError} 当 `optionKey` 重复或 `recommendedOptionKey` 不在备选列表中时抛出 `400 VALIDATION_ERROR`
 */
function assertValidDraftOptionKeys(draft: Readonly<ProposalDraft>): void {
  const seenKeys = new Set<string>();
  for (const option of draft.options) {
    if (seenKeys.has(option.optionKey)) {
      throw new AppError({
        code: "VALIDATION_ERROR",
        statusCode: 400,
        message: `Duplicate proposal optionKey "${option.optionKey}" is not allowed.`,
      });
    }
    seenKeys.add(option.optionKey);
  }

  if (draft.recommendedOptionKey !== undefined && !seenKeys.has(draft.recommendedOptionKey)) {
    throw new AppError({
      code: "VALIDATION_ERROR",
      statusCode: 400,
      message: `recommendedOptionKey "${draft.recommendedOptionKey}" does not match any option in draft.options.`,
    });
  }
}

/**
 * 结构化提案、交叉评议投票与人类拍板编排服务。
 */
export class ProposalsService {
  private readonly proposalsRepo: ProposalsRepository;
  private readonly roomsRepo: RoomsRepository;
  private readonly messagesRepo: MessagesRepository;
  private readonly aiModerator: AiModeratorService;
  private readonly realtimeBus: RealtimeBus;

  /**
   * @param deps - 提案、房间、消息仓储及 AI 主持人与实时事件总线
   */
  public constructor(deps: Readonly<ProposalsServiceDeps>) {
    this.proposalsRepo = deps.proposalsRepo;
    this.roomsRepo = deps.roomsRepo;
    this.messagesRepo = deps.messagesRepo;
    this.aiModerator = deps.aiModerator;
    this.realtimeBus = deps.realtimeBus;
  }

  /**
   * 列出指定房间内的全部结构化提案卡片，并按当前查看者视角动态盖章投票人与拍板人身份。
   *
   * @param caller - 当前已认证调用者
   * @param roomId - 房间主键
   * @returns 针对当前查看者盖章后的 `ProposalCardDto` 数组
   * @throws {AppError} 房间不存在抛 `404`；非房间成员抛 `403 FORBIDDEN_NOT_ROOM_MEMBER`
   */
  public async listProposals(
    caller: Readonly<AuthenticatedCaller>,
    roomId: RoomId,
  ): Promise<readonly ProposalCardDto[]> {
    const exists = await this.proposalsRepo.roomExists(roomId);
    if (!exists) {
      throw new AppError({
        code: "NOT_FOUND",
        statusCode: 404,
        message: `Room "${roomId}" was not found.`,
      });
    }

    const role = await this.proposalsRepo.findMemberRole(roomId, toActorMemberKey(caller));
    if (!role) {
      throw new AppError({
        code: "FORBIDDEN_NOT_ROOM_MEMBER",
        statusCode: 403,
        message: "You must be a member of this room to inspect its proposals.",
      });
    }

    const rawRecords = await this.proposalsRepo.listHydratedProposalsByRoom(roomId);
    return rawRecords.map((record) => stampRawProposalForViewer(record, caller));
  }

  /**
   * 在目标房间内创建一张新的结构化多方案对比提案卡，并在时间线内原子写入 `proposal` 锚点消息。
   *
   * @param caller - 发起提案的人类或 Agent 成员
   * @param roomId - 目标房间主键
   * @param draft - 经校验的提案草稿（标题、背景摘要与多备选方案利弊风险）
   * @returns 创建成功的 `ProposalCardDto`
   */
  public async createProposal(
    caller: Readonly<AuthenticatedCaller>,
    roomId: RoomId,
    draft: Readonly<ProposalDraft>,
  ): Promise<ProposalCardDto> {
    assertValidDraftOptionKeys(draft);
    const memberKey = toActorMemberKey(caller);
    const proposalId = generateProposalId();

    const txResult = await this.proposalsRepo.runInTransaction(async (txRepo) => {
      // 1. 先加 rooms 行级排他锁，确保 originMessageSeq 与时间线严格连续不撞号
      const lockedRoom = await txRepo.lockRoomBasicForUpdate(roomId);
      if (!lockedRoom) {
        throw new AppError({
          code: "NOT_FOUND",
          statusCode: 404,
          message: `Room "${roomId}" was not found.`,
        });
      }

      const role = await txRepo.findMemberRole(roomId, memberKey);
      if (!role) {
        throw new AppError({
          code: "FORBIDDEN_NOT_ROOM_MEMBER",
          statusCode: 403,
          message: "You must be a member of this room before submitting a proposal.",
        });
      }

      const nextSeq = asMessageSeq(lockedRoom.lastSeq + 1);
      const optionLabels = draft.options
        .map((opt) => `- **${opt.optionKey} (${opt.label})**: ${opt.summary}`)
        .join("\n");
      const timelineContent = `📋 **Proposal Submitted — ${draft.title}**\n\n${draft.contextSummary}\n\n${optionLabels}`;

      const rawMessage = await txRepo.appendTimelineMessageUnderRoomLock({
        roomId,
        nextSeq,
        memberKey,
        caller,
        type: "proposal",
        content: timelineContent,
        payloadJson: {
          proposalId,
          title: draft.title,
          optionCount: draft.options.length,
          ...(draft.recommendedOptionKey !== undefined
            ? { recommendedOptionKey: draft.recommendedOptionKey }
            : {}),
        },
      });

      await txRepo.insertProposal({
        id: proposalId,
        roomId,
        originMessageSeq: nextSeq,
        draft,
      });

      const rawProposal = await txRepo.findHydratedProposalById(proposalId);
      if (!rawProposal) {
        throw new Error(`Failed to hydrate newly inserted proposal "${proposalId}".`);
      }

      return { rawMessage, rawProposal };
    });

    const stampedMessage = stampRawMessageForViewer(txResult.rawMessage, caller);
    const stampedProposal = stampRawProposalForViewer(txResult.rawProposal, caller);

    // 事务后广播（Post-Commit Only）：通知前端时间线与提案面板，并在人类发起提案时请求群内 Agent 表态投票
    await this.realtimeBus.publishToRoom(roomId, {
      type: "message.created",
      roomId,
      message: stampedMessage,
    });
    await this.realtimeBus.publishToRoom(roomId, {
      type: "proposal.updated",
      roomId,
      proposal: stampedProposal,
    });

    if (caller.kind === "human") {
      const roomAgentIds = await this.messagesRepo.listRoomAgentIds(roomId);
      for (const agentId of roomAgentIds) {
        await this.realtimeBus.publishToAgent(agentId, {
          type: "wake",
          roomId,
          latestSeq: txResult.rawMessage.seq,
          reason: "proposal_vote_requested",
        });
      }
    }

    return stampedProposal;
  }

  /**
   * 调用 AI 主持人（或离线确定性观点聚类器）从房间最近讨论消息自动提炼并落库一张结构化提案卡片。
   *
   * @param caller - 触发提炼的人类或 Agent 成员
   * @param roomId - 房间主键
   * @param body - 消息窗口条数与可选 BYOK 模型覆盖配置
   * @returns 自动提炼并入库后的 `ProposalCardDto`
   */
  public async synthesizeProposal(
    caller: Readonly<AuthenticatedCaller>,
    roomId: RoomId,
    body: Readonly<SynthesizeProposalBody>,
  ): Promise<ProposalCardDto> {
    const room = await this.roomsRepo.findRoomById(roomId);
    if (!room) {
      throw new AppError({
        code: "NOT_FOUND",
        statusCode: 404,
        message: `Room "${roomId}" was not found.`,
      });
    }

    const membership = await this.roomsRepo.findMembership(roomId, toActorMemberKey(caller));
    if (!membership) {
      throw new AppError({
        code: "FORBIDDEN_NOT_ROOM_MEMBER",
        statusCode: 403,
        message: "You must be a member of this room to synthesize a proposal.",
      });
    }

    const startAfterSeq = Math.max(0, room.lastSeq - body.messageWindowLimit);
    const recentMessages = await this.messagesRepo.listAfterSeq(
      roomId,
      asReadCursorSeq(startAfterSeq),
      body.messageWindowLimit,
    );

    const draft = await this.aiModerator.synthesizeProposalDraft({
      roomName: room.name,
      roomTopic: room.topic,
      messages: recentMessages,
      request: body,
    });

    return this.createProposal(caller, roomId, draft);
  }

  /**
   * 对处于 `open` 状态的提案提交或修正结构化表态投票（`endorse` | `challenge` | `abstain`）。
   *
   * @param caller - 投票的人类或 Agent 房间成员
   * @param proposalId - 目标提案主键
   * @param body - 立场、倾向方案键与理由陈述
   * @returns 更新投票汇总后的 `ProposalCardDto`
   */
  public async castVote(
    caller: Readonly<AuthenticatedCaller>,
    proposalId: ProposalId,
    body: Readonly<CastProposalVoteBody>,
  ): Promise<ProposalCardDto> {
    const initialMeta = await this.proposalsRepo.findProposalMetaById(proposalId);
    if (!initialMeta) {
      throw new AppError({
        code: "NOT_FOUND",
        statusCode: 404,
        message: `Proposal "${proposalId}" was not found.`,
      });
    }

    const roomId = initialMeta.roomId;
    const voterKey = toActorMemberKey(caller);

    const txResult = await this.proposalsRepo.runInTransaction(async (txRepo) => {
      // 锁顺序一致性：先锁定所属房间行，再重新校验提案开闭状态，杜绝与人类拍板并发竞态
      const lockedRoom = await txRepo.lockRoomBasicForUpdate(roomId);
      if (!lockedRoom) {
        throw new AppError({
          code: "NOT_FOUND",
          statusCode: 404,
          message: `Room "${roomId}" was not found.`,
        });
      }

      const role = await txRepo.findMemberRole(roomId, voterKey);
      if (!role) {
        throw new AppError({
          code: "FORBIDDEN_NOT_ROOM_MEMBER",
          statusCode: 403,
          message: "You must be a member of this room to vote on its proposals.",
        });
      }

      const freshMeta = await txRepo.findProposalMetaById(proposalId);
      if (!freshMeta) {
        throw new AppError({
          code: "NOT_FOUND",
          statusCode: 404,
          message: `Proposal "${proposalId}" was not found.`,
        });
      }

      if (freshMeta.status !== "open") {
        throw new AppError({
          code: "VALIDATION_ERROR",
          statusCode: 400,
          message: `Cannot cast vote on proposal "${proposalId}" because its status is "${freshMeta.status}".`,
        });
      }

      if (body.preferredOptionKey !== undefined) {
        const optionExists = freshMeta.draft.options.some(
          (opt) => opt.optionKey === body.preferredOptionKey,
        );
        if (!optionExists) {
          throw new AppError({
            code: "VALIDATION_ERROR",
            statusCode: 400,
            message: `preferredOptionKey "${body.preferredOptionKey}" does not exist on proposal "${proposalId}".`,
          });
        }
      }

      await txRepo.upsertVote({
        proposalId,
        voterKey,
        caller,
        stance: body.stance,
        ...(body.preferredOptionKey !== undefined
          ? { preferredOptionKey: body.preferredOptionKey }
          : {}),
        rationale: body.rationale,
      });

      const nextSeq = asMessageSeq(lockedRoom.lastSeq + 1);
      const optionBadge =
        body.preferredOptionKey !== undefined ? ` (Option \`${body.preferredOptionKey}\`)` : "";
      const voteContent = `🗳️ **Vote [${body.stance.toUpperCase()}]${optionBadge}** on *${freshMeta.draft.title}*\n\n${body.rationale}`;

      const rawMessage = await txRepo.appendTimelineMessageUnderRoomLock({
        roomId,
        nextSeq,
        memberKey: voterKey,
        caller,
        type: "vote",
        content: voteContent,
        payloadJson: {
          proposalId,
          stance: body.stance,
          ...(body.preferredOptionKey !== undefined
            ? { preferredOptionKey: body.preferredOptionKey }
            : {}),
        },
        replyToSeq: freshMeta.originMessageSeq,
      });

      const rawProposal = await txRepo.findHydratedProposalById(proposalId);
      if (!rawProposal) {
        throw new Error(`Failed to reload voted proposal "${proposalId}".`);
      }

      return { rawMessage, rawProposal };
    });

    const stampedMessage = stampRawMessageForViewer(txResult.rawMessage, caller);
    const stampedProposal = stampRawProposalForViewer(txResult.rawProposal, caller);

    await this.realtimeBus.publishToRoom(roomId, {
      type: "message.created",
      roomId,
      message: stampedMessage,
    });
    await this.realtimeBus.publishToRoom(roomId, {
      type: "proposal.updated",
      roomId,
      proposal: stampedProposal,
    });

    return stampedProposal;
  }

  /**
   * 人类房间群主或主持人对开放中的提案执行最终拍板（`approved` 采纳选定方案或 `rejected` 驳回重议）。
   *
   * @param caller - 当前调用者（必须为具备房间决策权的人类）
   * @param proposalId - 目标提案主键
   * @param body - 拍板决定、最终选定方案键与决策批注
   * @returns 固化拍板结论后的 `ProposalCardDto`
   * @throws {AppError} Agent 或无决策权成员调用抛 `403 FORBIDDEN_NOT_OWNER`；提案已结案抛 `400 VALIDATION_ERROR`
   */
  public async decideProposal(
    caller: Readonly<AuthenticatedCaller>,
    proposalId: ProposalId,
    body: Readonly<DecideProposalBody>,
  ): Promise<ProposalCardDto> {
    // 核心安全红线：绝不允许任何 AI Agent 代替人类批准或驳回提案
    const human = assertHumanCaller(caller);

    const initialMeta = await this.proposalsRepo.findProposalMetaById(proposalId);
    if (!initialMeta) {
      throw new AppError({
        code: "NOT_FOUND",
        statusCode: 404,
        message: `Proposal "${proposalId}" was not found.`,
      });
    }

    const roomId = initialMeta.roomId;
    const memberKey = toActorMemberKey(human);
    const decidedAt = new Date();

    const txResult = await this.proposalsRepo.runInTransaction(async (txRepo) => {
      const lockedRoom = await txRepo.lockRoomBasicForUpdate(roomId);
      if (!lockedRoom) {
        throw new AppError({
          code: "NOT_FOUND",
          statusCode: 404,
          message: `Room "${roomId}" was not found.`,
        });
      }

      const role = await txRepo.findMemberRole(roomId, memberKey);
      const isAuthorizedDecider =
        role !== undefined &&
        (role === "owner" || role === "moderator" || lockedRoom.ownerUserId === human.userId);

      if (!isAuthorizedDecider) {
        throw new AppError({
          code: "FORBIDDEN_NOT_OWNER",
          statusCode: 403,
          message: "Only a human room owner or moderator can approve or reject proposals.",
        });
      }

      const freshMeta = await txRepo.findProposalMetaById(proposalId);
      if (!freshMeta) {
        throw new AppError({
          code: "NOT_FOUND",
          statusCode: 404,
          message: `Proposal "${proposalId}" was not found.`,
        });
      }

      if (freshMeta.status !== "open") {
        throw new AppError({
          code: "VALIDATION_ERROR",
          statusCode: 400,
          message: `Proposal "${proposalId}" has already been decided (${freshMeta.status}).`,
        });
      }

      let resolvedOptionKey: string | undefined;
      if (body.decision === "approved") {
        resolvedOptionKey =
          body.decidedOptionKey ??
          freshMeta.draft.recommendedOptionKey ??
          freshMeta.draft.options[0]?.optionKey;

        if (
          resolvedOptionKey === undefined ||
          !freshMeta.draft.options.some((opt) => opt.optionKey === resolvedOptionKey)
        ) {
          throw new AppError({
            code: "VALIDATION_ERROR",
            statusCode: 400,
            message: `Selected decidedOptionKey "${resolvedOptionKey ?? ""}" does not match any proposal option.`,
          });
        }
      }

      await txRepo.updateProposalDecision({
        proposalId,
        decision: body.decision,
        ...(resolvedOptionKey !== undefined ? { decidedOptionKey: resolvedOptionKey } : {}),
        ...(body.decisionNote !== undefined ? { decisionNote: body.decisionNote } : {}),
        decidedByUserId: human.userId,
        decidedAt,
      });

      const nextSeq = asMessageSeq(lockedRoom.lastSeq + 1);
      const decisionHeadline =
        body.decision === "approved"
          ? `⚖️ **Decision Approved — Option \`${resolvedOptionKey ?? ""}\`** (*${freshMeta.draft.title}*)`
          : `⚖️ **Proposal Rejected for Revision** (*${freshMeta.draft.title}*)`;
      const decisionContent =
        body.decisionNote && body.decisionNote.trim().length > 0
          ? `${decisionHeadline}\n\n> ${body.decisionNote.trim()}`
          : decisionHeadline;

      const rawMessage = await txRepo.appendTimelineMessageUnderRoomLock({
        roomId,
        nextSeq,
        memberKey,
        caller: human,
        type: "decision",
        content: decisionContent,
        payloadJson: {
          proposalId,
          decision: body.decision,
          ...(resolvedOptionKey !== undefined ? { decidedOptionKey: resolvedOptionKey } : {}),
          ...(body.decisionNote !== undefined ? { decisionNote: body.decisionNote } : {}),
        },
        replyToSeq: freshMeta.originMessageSeq,
      });

      const rawProposal = await txRepo.findHydratedProposalById(proposalId);
      if (!rawProposal) {
        throw new Error(`Failed to reload decided proposal "${proposalId}".`);
      }

      return { rawMessage, rawProposal };
    });

    const stampedMessage = stampRawMessageForViewer(txResult.rawMessage, human);
    const stampedProposal = stampRawProposalForViewer(txResult.rawProposal, human);

    await this.realtimeBus.publishToRoom(roomId, {
      type: "message.created",
      roomId,
      message: stampedMessage,
    });
    await this.realtimeBus.publishToRoom(roomId, {
      type: "proposal.updated",
      roomId,
      proposal: stampedProposal,
    });

    return stampedProposal;
  }
}
