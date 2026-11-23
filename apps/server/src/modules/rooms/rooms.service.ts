/**
 * @module server/modules/rooms/service
 * @description 多模态会话生命周期（群聊创建/拉人/入群/退群/删除、1v1 单聊 Agent、1v1 好友私聊）与公开只读分享快照编排服务（ADR-0005）。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 双模态建群归属：人类创建房间直接成为 `"owner"`；Agent 代主人创建房间时，自动将其归属主人添加为 `"owner"`，确保治理权掌握在人类手中。
 * 2. 好友准入与跨主人 Agent 私聊护栏：直接拉其他人类进群或开启 1v1 人类私聊必须通过 `areAcceptedFriends` 核验；非归属主人开启 1v1 Agent 单聊必须通过 `agent.allowExternalDm === true` 核验。
 * 3. 单聊成员不可变封闭性：`direct_agent` 与 `direct_human` 会话物理封锁邀请码入群、拉第三人、单方退群与公开只读分享。
 * 4. 事务后动态挂载推送（Post-Commit Only）：每当新成员加入或新建单聊时，事务提交后向相关人类/Agent 推送 `room.upserted`，驱动在线 SSE 流即时挂载房间订阅。
 */
import {
  type AddRoomMembersBody,
  type AgentId,
  type AuthenticatedCaller,
  type CreateRoomBody,
  type JoinRoomBody,
  type MessageDto,
  type OpenDirectAgentRoomBody,
  type OpenDirectHumanRoomBody,
  type OpenDirectRoomResponse,
  type ProposalCardDto,
  type PublicUserProfileDto,
  type RoomDetailDto,
  type RoomId,
  type RoomMemberDto,
  type RoomSummaryDto,
  type UserId,
  asReadCursorSeq,
  createDefaultGovernanceState,
} from "@openhuddle/protocol";
import { assertHumanCaller } from "../../infra/auth-middleware.js";
import { generateInviteToken, generateRoomId } from "../../infra/crypto.js";
import { AppError } from "../../infra/errors.js";
import { PUBLIC_NEUTRAL_VIEWER, toActorMemberKey } from "../../infra/identity-stamp.js";
import type { RealtimeBus } from "../../infra/realtime-bus.js";
import type { SafeAgentRecord } from "../auth/auth.repo.js";
import { toDirectAgentPairKey, toDirectHumanPairKey } from "../friends/friends.repo.js";
import { type MessagesRepository, stampRawMessageForViewer } from "../messages/messages.repo.js";
import {
  type ProposalsRepository,
  stampRawProposalForViewer,
} from "../proposals/proposals.repo.js";
import {
  type RoomRecord,
  type RoomsRepository,
  buildRoomDetailDto,
  resolveDirectPeerForViewer,
} from "./rooms.repo.js";

/**
 * 公开只读分享页完整返回载荷。
 */
export interface PublicRoomShareSnapshot {
  readonly ok: true;
  readonly room: RoomDetailDto;
  readonly messages: readonly MessageDto[];
  readonly proposals: readonly ProposalCardDto[];
}

/**
 * 构造 `RoomsService` 所需的依赖。
 */
export interface RoomsServiceDeps {
  readonly roomsRepo: RoomsRepository;
  readonly messagesRepo: MessagesRepository;
  readonly proposalsRepo: ProposalsRepository;
  readonly realtimeBus: RealtimeBus;
  /** 按主键查询 Agent 归属主人及外部私聊开关 */
  readonly findAgentById: (agentId: AgentId) => Promise<SafeAgentRecord | undefined>;
  /** 按主键查询正常活跃的人类用户名片 */
  readonly findActiveUserById?: (userId: UserId) => Promise<PublicUserProfileDto | undefined>;
  /** 核验两名人类用户当前是否已建立 `accepted` 好友关系 */
  readonly areAcceptedFriends?: (userA: UserId, userB: UserId) => Promise<boolean>;
}

/**
 * 房间、成员、1v1 单聊与公开分享编排服务。
 */
export class RoomsService {
  private readonly roomsRepo: RoomsRepository;
  private readonly messagesRepo: MessagesRepository;
  private readonly proposalsRepo: ProposalsRepository;
  private readonly realtimeBus: RealtimeBus;
  private readonly findAgentById: RoomsServiceDeps["findAgentById"];
  private readonly findActiveUserById: (
    userId: UserId,
  ) => Promise<PublicUserProfileDto | undefined>;
  private readonly areAcceptedFriends: (userA: UserId, userB: UserId) => Promise<boolean>;

  /**
   * @param deps - 房间、消息、提案仓储、好友核验回调及实时事件总线
   */
  public constructor(deps: Readonly<RoomsServiceDeps>) {
    this.roomsRepo = deps.roomsRepo;
    this.messagesRepo = deps.messagesRepo;
    this.proposalsRepo = deps.proposalsRepo;
    this.realtimeBus = deps.realtimeBus;
    this.findAgentById = deps.findAgentById;
    this.findActiveUserById = deps.findActiveUserById ?? (async () => undefined);
    this.areAcceptedFriends = deps.areAcceptedFriends ?? (async () => false);
  }

  private async hydrateRoomDetailForViewer(
    room: Readonly<RoomRecord>,
    viewer: Readonly<AuthenticatedCaller>,
    yourLastReadSeq: number,
  ): Promise<RoomDetailDto> {
    const { members, internal } = await this.roomsRepo.listHydratedMembersWithPeerMeta(
      room.id,
      this.realtimeBus,
    );
    const peer =
      room.kind !== "group" ? resolveDirectPeerForViewer(room.kind, internal, viewer) : undefined;

    return buildRoomDetailDto(room, members, {
      yourLastReadSeq,
      includeInviteToken: room.kind === "group",
      viewer,
      ...(peer !== undefined ? { peerOverride: peer } : {}),
    });
  }

  private async notifyRoomUpserted(
    roomId: RoomId,
    userIds: readonly UserId[],
    agentIds: readonly AgentId[],
  ): Promise<void> {
    const uniqueUsers = [...new Set(userIds)];
    const uniqueAgents = [...new Set(agentIds)];
    await Promise.all([
      ...uniqueUsers.map((uid) =>
        this.realtimeBus.publishToUser(uid, { type: "room.upserted", roomId }),
      ),
      ...uniqueAgents.map((aid) =>
        this.realtimeBus.publishToAgent(aid, { type: "room.upserted", roomId }),
      ),
    ]);
  }

  /**
   * 列出当前人类或 Agent 已加入的全部会话房间概览（含视角化单聊 `peer`）。
   *
   * @param caller - 当前已认证身份
   * @returns `RoomSummaryDto` 数组
   */
  public async listMyRooms(
    caller: Readonly<AuthenticatedCaller>,
  ): Promise<readonly RoomSummaryDto[]> {
    return this.roomsRepo.listJoinedRooms(toActorMemberKey(caller), caller, this.realtimeBus);
  }

  /**
   * 创建新 Huddle 群聊房间，支持同时直拉本人名下 Agent 与已添加的人类好友。
   *
   * @param caller - 当前已认证人类或 Agent
   * @param body - 房间名称、主题、规则、可见性、治理参数与初始直拉成员
   * @returns 新建房间的 `RoomDetailDto`
   */
  public async createRoom(
    caller: Readonly<AuthenticatedCaller>,
    body: Readonly<CreateRoomBody>,
  ): Promise<RoomDetailDto> {
    const roomId = generateRoomId();
    const inviteToken = generateInviteToken();
    const govOverrides = body.governance;
    const initialGovernance = createDefaultGovernanceState(
      govOverrides !== undefined
        ? {
            ...(govOverrides.mode !== undefined ? { mode: govOverrides.mode } : {}),
            ...(govOverrides.allowAgentMentions !== undefined
              ? { allowAgentMentions: govOverrides.allowAgentMentions }
              : {}),
            ...(govOverrides.maxConsecutiveAgentTurns !== undefined
              ? { maxConsecutiveAgentTurns: govOverrides.maxConsecutiveAgentTurns }
              : {}),
            ...(govOverrides.requireReadBeforeSend !== undefined
              ? { requireReadBeforeSend: govOverrides.requireReadBeforeSend }
              : {}),
            ...(govOverrides.agentCooldownMs !== undefined
              ? { agentCooldownMs: govOverrides.agentCooldownMs }
              : {}),
          }
        : undefined,
    );
    const ownerUserId = caller.kind === "human" ? caller.userId : caller.ownerUserId;

    // 1. Owner-First 建群直拉 Agent：仅允许归群主本人所有的 Agent
    const initialAgentIds = [...new Set(body.initialAgentIds)];
    for (const agentId of initialAgentIds) {
      const agent = await this.findAgentById(agentId);
      if (agent === undefined) {
        throw new AppError({
          code: "NOT_FOUND",
          statusCode: 404,
          message: `Agent "${agentId}" was not found.`,
        });
      }
      if (agent.ownerUserId !== ownerUserId) {
        throw new AppError({
          code: "FORBIDDEN_NOT_OWNER",
          statusCode: 403,
          message: `Agent "${agentId}" is not owned by the room creator; only your own agents can be pulled into a new huddle.`,
        });
      }
    }

    // 2. ADR-0005 建群直拉人类好友：仅允许人类创建者拉入已通过（accepted）的好友
    const friendUserIds = [...new Set(body.initialUserIds)].filter((uid) => uid !== ownerUserId);
    if (friendUserIds.length > 0 && caller.kind !== "human") {
      throw new AppError({
        code: "FORBIDDEN_NOT_OWNER",
        statusCode: 403,
        message: "Only human callers can directly pull other human friends into a room.",
      });
    }
    for (const friendUserId of friendUserIds) {
      const activeUser = await this.findActiveUserById(friendUserId);
      if (!activeUser) {
        throw new AppError({
          code: "NOT_FOUND",
          statusCode: 404,
          message: `User "${friendUserId}" was not found or is inactive.`,
        });
      }
      const isFriend = await this.areAcceptedFriends(ownerUserId, friendUserId);
      if (!isFriend) {
        throw new AppError({
          code: "FORBIDDEN_NOT_FRIENDS",
          statusCode: 403,
          message: `只能将已添加的好友（${activeUser.displayName}）直接拉入群聊，或改发邀请码邀请对方加入。`,
        });
      }
    }

    const roomRecord = await this.roomsRepo.runInTransaction(async (txRepo) => {
      const created = await txRepo.insertRoom({
        id: roomId,
        kind: "group",
        ownerUserId,
        name: body.name,
        topic: body.topic,
        rules: body.rules,
        visibility: body.visibility,
        inviteToken,
        governanceJson: initialGovernance,
      });

      await txRepo.addRoomMemberIfAbsent({
        roomId: created.id,
        memberKey: `human:${ownerUserId}`,
        memberKind: "human",
        userId: ownerUserId,
        role: "owner",
        lastReadSeq: 0,
      });

      for (const friendUserId of friendUserIds) {
        await txRepo.addRoomMemberIfAbsent({
          roomId: created.id,
          memberKey: `human:${friendUserId}`,
          memberKind: "human",
          userId: friendUserId,
          role: "member",
          lastReadSeq: 0,
        });
      }

      if (caller.kind === "agent") {
        await txRepo.addRoomMemberIfAbsent({
          roomId: created.id,
          memberKey: `agent:${caller.agentId}`,
          memberKind: "agent",
          agentId: caller.agentId,
          role: "member",
          lastReadSeq: 0,
        });
      }

      for (const agentId of initialAgentIds) {
        await txRepo.addRoomMemberIfAbsent({
          roomId: created.id,
          memberKey: `agent:${agentId}`,
          memberKind: "agent",
          agentId,
          role: "member",
          lastReadSeq: 0,
        });
      }

      return created;
    });

    // Post-Commit：实时通知群主其他标签页、被拉入的好友以及被拉入的在线 Agent
    const notifyAgents =
      caller.kind === "agent" ? [...initialAgentIds, caller.agentId] : initialAgentIds;
    await this.notifyRoomUpserted(roomRecord.id, [ownerUserId, ...friendUserIds], notifyAgents);

    return this.hydrateRoomDetailForViewer(roomRecord, caller, 0);
  }

  /**
   * 人类群成员可直接拉入已添加的好友或本人名下的个人 Agent（ADR-0005）。
   *
   * @param caller - 当前已认证人类成员
   * @param roomId - 目标群聊主键
   * @param body - 待拉入的好友 `userIds` 与本人 `agentIds`
   * @returns 更新成员名册后的 `RoomDetailDto`
   */
  public async addMembersToGroupRoom(
    caller: Readonly<AuthenticatedCaller>,
    roomId: RoomId,
    body: Readonly<AddRoomMembersBody>,
  ): Promise<RoomDetailDto> {
    const human = assertHumanCaller(caller);
    const room = await this.roomsRepo.findRoomById(roomId);
    if (!room) {
      throw new AppError({
        code: "NOT_FOUND",
        statusCode: 404,
        message: `Room "${roomId}" was not found.`,
      });
    }

    if (room.kind !== "group") {
      throw new AppError({
        code: "DIRECT_ROOM_IMMUTABLE_ROSTER",
        statusCode: 400,
        message: "一对一单聊房间不支持拉入其他成员；如需多人协作请新建群聊。",
      });
    }

    const callerMembership = await this.roomsRepo.findMembership(roomId, toActorMemberKey(human));
    if (!callerMembership) {
      throw new AppError({
        code: "FORBIDDEN_NOT_ROOM_MEMBER",
        statusCode: 403,
        message: "You must be a member of this room to invite friends or agents.",
      });
    }

    const uniqueAgentIds = [...new Set(body.agentIds)];
    for (const agentId of uniqueAgentIds) {
      const agent = await this.findAgentById(agentId);
      if (!agent) {
        throw new AppError({
          code: "NOT_FOUND",
          statusCode: 404,
          message: `Agent "${agentId}" was not found.`,
        });
      }
      if (agent.ownerUserId !== human.userId) {
        throw new AppError({
          code: "FORBIDDEN_NOT_OWNER",
          statusCode: 403,
          message: "只能将自己名下的个人 Agent 直接拉入群聊。",
        });
      }
    }

    const uniqueUserIds = [...new Set(body.userIds)].filter((uid) => uid !== human.userId);
    for (const targetUserId of uniqueUserIds) {
      const activeUser = await this.findActiveUserById(targetUserId);
      if (!activeUser) {
        throw new AppError({
          code: "NOT_FOUND",
          statusCode: 404,
          message: `User "${targetUserId}" was not found or is inactive.`,
        });
      }
      const isFriend = await this.areAcceptedFriends(human.userId, targetUserId);
      if (!isFriend) {
        throw new AppError({
          code: "FORBIDDEN_NOT_FRIENDS",
          statusCode: 403,
          message: `只能直接拉入已添加的好友（${activeUser.displayName}）。`,
        });
      }
    }

    const added = await this.roomsRepo.runInTransaction(async (txRepo) => {
      const addedUsers: UserId[] = [];
      const addedAgents: AgentId[] = [];

      for (const uid of uniqueUserIds) {
        const wasInserted = await txRepo.addRoomMemberIfAbsent({
          roomId: room.id,
          memberKey: `human:${uid}`,
          memberKind: "human",
          userId: uid,
          role: "member",
          lastReadSeq: 0,
        });
        if (wasInserted) {
          addedUsers.push(uid);
        }
      }

      for (const aid of uniqueAgentIds) {
        const wasInserted = await txRepo.addRoomMemberIfAbsent({
          roomId: room.id,
          memberKey: `agent:${aid}`,
          memberKind: "agent",
          agentId: aid,
          role: "member",
          lastReadSeq: 0,
        });
        if (wasInserted) {
          addedAgents.push(aid);
        }
      }

      return { addedUsers, addedAgents };
    });

    if (added.addedUsers.length > 0 || added.addedAgents.length > 0) {
      // 事务提交后刷新已订阅的成员名册，再通知新成员挂载房间订阅。
      await this.realtimeBus.publishToRoom(room.id, { type: "room.upserted", roomId: room.id });
      await this.notifyRoomUpserted(room.id, added.addedUsers, added.addedAgents);
    }

    return this.hydrateRoomDetailForViewer(room, human, callerMembership.lastReadSeq);
  }

  /**
   * 打开或幂等复用当前人类与目标 Agent 的 1v1 单聊会话（ADR-0005）。
   *
   * @param caller - 当前已认证调用者（必须为人类）
   * @param body - 目标 `agentId`
   * @returns `{ ok: true, created, room }`
   */
  public async openDirectAgentRoom(
    caller: Readonly<AuthenticatedCaller>,
    body: Readonly<OpenDirectAgentRoomBody>,
  ): Promise<OpenDirectRoomResponse> {
    const human = assertHumanCaller(caller);
    const agent = await this.findAgentById(body.agentId);
    if (!agent) {
      throw new AppError({
        code: "NOT_FOUND",
        statusCode: 404,
        message: `Agent "${body.agentId}" was not found.`,
      });
    }

    // 校验该 Agent 的主人账号未被封禁
    const agentOwner = await this.findActiveUserById(agent.ownerUserId);
    if (!agentOwner) {
      throw new AppError({
        code: "NOT_FOUND",
        statusCode: 404,
        message: "该 Agent 所属账号不可用。",
      });
    }

    const isOwnAgent = agent.ownerUserId === human.userId;
    if (!isOwnAgent && !agent.allowExternalDm) {
      throw new AppError({
        code: "FORBIDDEN_EXTERNAL_AGENT_DM_DISABLED",
        statusCode: 403,
        message: "该 Agent 未开启「允许其他用户私聊」，仅其绑定主人可发起 1v1 单聊。",
      });
    }

    const directPairKey = toDirectAgentPairKey(human.userId, agent.id);
    const defaultTopic = isOwnAgent
      ? "与我的个人 Agent 一对一单聊"
      : `与 ${agentOwner.displayName} 共享的 Agent 单聊`;

    const txOutcome = await this.roomsRepo.runInTransaction(async (txRepo) => {
      const existing = await txRepo.findRoomByDirectPairKey(directPairKey);
      if (existing) {
        await txRepo.addRoomMemberIfAbsent({
          roomId: existing.id,
          memberKey: `human:${human.userId}`,
          memberKind: "human",
          userId: human.userId,
          role: "owner",
          lastReadSeq: 0,
        });
        await txRepo.addRoomMemberIfAbsent({
          roomId: existing.id,
          memberKey: `agent:${agent.id}`,
          memberKind: "agent",
          agentId: agent.id,
          role: "member",
          lastReadSeq: 0,
        });
        return { room: existing, created: false };
      }

      const dmGovernance = createDefaultGovernanceState({
        mode: "free",
        allowAgentMentions: false,
        maxConsecutiveAgentTurns: 6,
        requireReadBeforeSend: true,
        agentCooldownMs: 1_000,
      });

      const inserted = await txRepo.tryInsertDirectRoom({
        id: generateRoomId(),
        kind: "direct_agent",
        directPairKey,
        ownerUserId: human.userId,
        name: agent.displayName,
        topic: defaultTopic,
        inviteToken: generateInviteToken(),
        governanceJson: dmGovernance,
      });

      const targetRoom = inserted ?? (await txRepo.findRoomByDirectPairKey(directPairKey));
      if (!targetRoom) {
        throw new Error("Failed to resolve direct_agent room after upsert.");
      }

      await txRepo.addRoomMemberIfAbsent({
        roomId: targetRoom.id,
        memberKey: `human:${human.userId}`,
        memberKind: "human",
        userId: human.userId,
        role: "owner",
        lastReadSeq: 0,
      });
      await txRepo.addRoomMemberIfAbsent({
        roomId: targetRoom.id,
        memberKey: `agent:${agent.id}`,
        memberKind: "agent",
        agentId: agent.id,
        role: "member",
        lastReadSeq: 0,
      });

      return { room: targetRoom, created: inserted !== undefined };
    });

    if (txOutcome.created) {
      await this.notifyRoomUpserted(txOutcome.room.id, [human.userId], [agent.id]);
    }

    const membership = await this.roomsRepo.findMembership(
      txOutcome.room.id,
      toActorMemberKey(human),
    );
    const detail = await this.hydrateRoomDetailForViewer(
      txOutcome.room,
      human,
      membership?.lastReadSeq ?? 0,
    );

    return {
      ok: true,
      created: txOutcome.created,
      room: detail,
    };
  }

  /**
   * 打开或幂等复用当前人类与已添加好友之间的 1v1 私聊会话（ADR-0005）。
   *
   * @param caller - 当前已认证调用者（必须为人类）
   * @param body - 目标人类好友 `targetUserId`
   * @returns `{ ok: true, created, room }`
   */
  public async openDirectHumanRoom(
    caller: Readonly<AuthenticatedCaller>,
    body: Readonly<OpenDirectHumanRoomBody>,
  ): Promise<OpenDirectRoomResponse> {
    const human = assertHumanCaller(caller);
    if (body.targetUserId === human.userId) {
      throw new AppError({
        code: "CANNOT_FRIEND_SELF",
        statusCode: 400,
        message: "不能与自己发起人类私聊；如需个人 AI 助手请点击你的 Agent 发起单聊。",
      });
    }

    const targetUser = await this.findActiveUserById(body.targetUserId);
    if (!targetUser) {
      throw new AppError({
        code: "NOT_FOUND",
        statusCode: 404,
        message: "未找到对应的活跃用户。",
      });
    }

    const isFriend = await this.areAcceptedFriends(human.userId, targetUser.userId);
    if (!isFriend) {
      throw new AppError({
        code: "FORBIDDEN_NOT_FRIENDS",
        statusCode: 403,
        message: `需要先将「${targetUser.displayName}」添加为好友并等待通过后，才能发起 1v1 私聊。`,
      });
    }

    const directPairKey = toDirectHumanPairKey(human.userId, targetUser.userId);

    const txOutcome = await this.roomsRepo.runInTransaction(async (txRepo) => {
      const existing = await txRepo.findRoomByDirectPairKey(directPairKey);
      if (existing) {
        await txRepo.addRoomMemberIfAbsent({
          roomId: existing.id,
          memberKey: `human:${human.userId}`,
          memberKind: "human",
          userId: human.userId,
          role: "owner",
          lastReadSeq: 0,
        });
        await txRepo.addRoomMemberIfAbsent({
          roomId: existing.id,
          memberKey: `human:${targetUser.userId}`,
          memberKind: "human",
          userId: targetUser.userId,
          role: "owner",
          lastReadSeq: 0,
        });
        return { room: existing, created: false };
      }

      const dmGovernance = createDefaultGovernanceState({
        mode: "free",
        allowAgentMentions: false,
        maxConsecutiveAgentTurns: 6,
        requireReadBeforeSend: false,
        agentCooldownMs: 0,
      });

      const inserted = await txRepo.tryInsertDirectRoom({
        id: generateRoomId(),
        kind: "direct_human",
        directPairKey,
        ownerUserId: human.userId,
        name: `${human.displayName} & ${targetUser.displayName}`,
        topic: "好友一对一私聊",
        inviteToken: generateInviteToken(),
        governanceJson: dmGovernance,
      });

      const targetRoom = inserted ?? (await txRepo.findRoomByDirectPairKey(directPairKey));
      if (!targetRoom) {
        throw new Error("Failed to resolve direct_human room after upsert.");
      }

      await txRepo.addRoomMemberIfAbsent({
        roomId: targetRoom.id,
        memberKey: `human:${human.userId}`,
        memberKind: "human",
        userId: human.userId,
        role: "owner",
        lastReadSeq: 0,
      });
      await txRepo.addRoomMemberIfAbsent({
        roomId: targetRoom.id,
        memberKey: `human:${targetUser.userId}`,
        memberKind: "human",
        userId: targetUser.userId,
        role: "owner",
        lastReadSeq: 0,
      });

      return { room: targetRoom, created: inserted !== undefined };
    });

    if (txOutcome.created) {
      await this.notifyRoomUpserted(txOutcome.room.id, [human.userId, targetUser.userId], []);
    }

    const membership = await this.roomsRepo.findMembership(
      txOutcome.room.id,
      toActorMemberKey(human),
    );
    const detail = await this.hydrateRoomDetailForViewer(
      txOutcome.room,
      human,
      membership?.lastReadSeq ?? 0,
    );

    return {
      ok: true,
      created: txOutcome.created,
      room: detail,
    };
  }

  /**
   * 获取指定房间完整详情（含成员实时可达状态、单聊对端信息与群聊邀请令牌）。
   *
   * @param caller - 当前已认证身份
   * @param roomId - 房间主键
   * @returns `RoomDetailDto`
   */
  public async getRoomDetail(
    caller: Readonly<AuthenticatedCaller>,
    roomId: RoomId,
  ): Promise<RoomDetailDto> {
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
        message: "You must join this huddle room before viewing its details.",
      });
    }

    return this.hydrateRoomDetailForViewer(room, caller, membership.lastReadSeq);
  }

  /**
   * 凭房间邀请令牌（`inv_...`）幂等加入目标群聊房间（单聊房间严格禁止）。
   *
   * @param caller - 当前已认证人类或 Agent
   * @param body - 含 `inviteToken` 的请求体
   * @returns 入群后的 `RoomDetailDto`
   */
  public async joinRoomByInviteToken(
    caller: Readonly<AuthenticatedCaller>,
    body: Readonly<JoinRoomBody>,
  ): Promise<RoomDetailDto> {
    const room = await this.roomsRepo.findRoomByInviteToken(body.inviteToken);
    if (!room) {
      throw new AppError({
        code: "NOT_FOUND",
        statusCode: 404,
        message: "Invalid room invite token.",
      });
    }

    if (room.kind !== "group") {
      throw new AppError({
        code: "DIRECT_ROOM_IMMUTABLE_ROSTER",
        statusCode: 400,
        message: "一对一单聊会话不支持通过邀请码加入。",
      });
    }

    const memberKey = toActorMemberKey(caller);
    const wasInserted = await this.roomsRepo.addRoomMemberIfAbsent({
      roomId: room.id,
      memberKey,
      memberKind: caller.kind,
      ...(caller.kind === "human" ? { userId: caller.userId } : { agentId: caller.agentId }),
      role: caller.kind === "human" && room.ownerUserId === caller.userId ? "owner" : "member",
      lastReadSeq: 0,
    });

    if (wasInserted) {
      await this.notifyRoomUpserted(
        room.id,
        caller.kind === "human" ? [caller.userId] : [],
        caller.kind === "agent" ? [caller.agentId] : [],
      );
    }

    const membership = await this.roomsRepo.findMembership(room.id, memberKey);
    return this.hydrateRoomDetailForViewer(room, caller, membership?.lastReadSeq ?? 0);
  }

  /**
   * 退出指定群聊房间（1v1 单聊不支持单方退群）。
   *
   * @param caller - 当前已认证调用者
   * @param roomId - 房间主键
   */
  public async leaveRoom(caller: Readonly<AuthenticatedCaller>, roomId: RoomId): Promise<void> {
    const room = await this.roomsRepo.findRoomById(roomId);
    if (!room) {
      throw new AppError({
        code: "NOT_FOUND",
        statusCode: 404,
        message: `Room "${roomId}" was not found.`,
      });
    }

    if (room.kind !== "group") {
      throw new AppError({
        code: "DIRECT_ROOM_IMMUTABLE_ROSTER",
        statusCode: 400,
        message: "一对一单聊会话不支持单方退出。",
      });
    }

    const memberKey = toActorMemberKey(caller);
    const membership = await this.roomsRepo.findMembership(roomId, memberKey);
    if (!membership) {
      throw new AppError({
        code: "FORBIDDEN_NOT_ROOM_MEMBER",
        statusCode: 403,
        message: "You are not a member of this room.",
      });
    }

    await this.roomsRepo.removeMember(roomId, memberKey);
  }

  /**
   * 彻底删除指定会话房间（群聊仅限群主删除；1v1 单聊支持会话人类参与方清理删除）。
   *
   * @param caller - 当前已认证调用者（人类）
   * @param roomId - 待删除的房间主键
   * @returns 被删除的 `RoomRecord` 快照
   */
  public async deleteRoom(
    caller: Readonly<AuthenticatedCaller>,
    roomId: RoomId,
  ): Promise<RoomRecord> {
    const human = assertHumanCaller(caller);

    const deletedRoom = await this.roomsRepo.runInTransaction(async (txRepo) => {
      // 并发控制点：先加排他行锁再校验权限与执行删除，串行化并发发言、治理修改或重复删除请求
      const lockedRoom = await txRepo.lockRoomByIdForUpdate(roomId);
      if (!lockedRoom) {
        throw new AppError({
          code: "NOT_FOUND",
          statusCode: 404,
          message: `Room "${roomId}" was not found.`,
        });
      }

      if (lockedRoom.kind === "direct_human") {
        // 人类 1v1 私聊中双方均为平等 owner 角色，任意一方人类参与者可删除该私聊会话
        const membership = await txRepo.findMembership(roomId, `human:${human.userId}`);
        if (!membership && lockedRoom.ownerUserId !== human.userId) {
          throw new AppError({
            code: "FORBIDDEN_NOT_OWNER",
            statusCode: 403,
            message: "Only participants of this direct chat can delete it.",
          });
        }
      } else if (lockedRoom.ownerUserId !== human.userId) {
        // Owner-First 安全边界：群聊与 Agent 单聊仅房间的人类归属主人本人可执行物理删除
        throw new AppError({
          code: "FORBIDDEN_NOT_OWNER",
          statusCode: 403,
          message: "Only the human room owner can delete this room.",
        });
      }

      await txRepo.clearPairingCodesForRoom(roomId);
      await txRepo.deleteRoomById(roomId);
      return lockedRoom;
    });

    // Post-Commit：事务提交成功后先向当前在线成员广播 room.deleted，再驱逐该房间的内存监听器集合
    await this.realtimeBus.publishToRoom(roomId, {
      type: "room.deleted",
      roomId,
    });
    this.realtimeBus.evictRoomSubscribers(roomId);

    return deletedRoom;
  }

  /**
   * 获取房间成员列表（含实时在线通道状态灯）。
   *
   * @param caller - 当前已认证调用者
   * @param roomId - 房间主键
   * @returns `RoomMemberDto` 数组
   */
  public async listMembers(
    caller: Readonly<AuthenticatedCaller>,
    roomId: RoomId,
  ): Promise<readonly RoomMemberDto[]> {
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
        message: "You must be a member of this room to inspect its roster.",
      });
    }

    return this.roomsRepo.listHydratedMembers(roomId, this.realtimeBus);
  }

  /**
   * 加载公开分享房间（仅限 `kind === "group"` 且 `visibility === "public_shareable"`）的零信任只读快照。
   *
   * @param inviteToken - 分享链接中的 `inviteToken`
   * @returns 房间详情、消息流与提案列表快照
   */
  public async getPublicShareSnapshot(inviteToken: string): Promise<PublicRoomShareSnapshot> {
    const room = await this.roomsRepo.findRoomByInviteToken(inviteToken);
    if (!room || room.kind !== "group" || room.visibility !== "public_shareable") {
      throw new AppError({
        code: "NOT_FOUND",
        statusCode: 404,
        message: "Shared huddle snapshot was not found or public sharing is disabled.",
      });
    }

    const [members, rawMessages, rawProposals] = await Promise.all([
      this.roomsRepo.listHydratedMembers(room.id, this.realtimeBus),
      this.messagesRepo.listAfterSeq(room.id, asReadCursorSeq(0), 500),
      this.proposalsRepo.listHydratedProposalsByRoom(room.id),
    ]);

    const roomDto = buildRoomDetailDto(room, members, {
      yourLastReadSeq: room.lastSeq,
      includeInviteToken: false,
    });

    // 安全防御点：所有消息与提案投票统一按中立公开观察者盖章，强制 isYou=false, isYourOwner=false, trustLevel="external_participant"
    const messages = rawMessages.map((msg) =>
      stampRawMessageForViewer({ ...msg, attachment: undefined }, PUBLIC_NEUTRAL_VIEWER),
    );
    const proposals = rawProposals.map((prop) =>
      stampRawProposalForViewer(prop, PUBLIC_NEUTRAL_VIEWER),
    );

    return {
      ok: true,
      room: roomDto,
      messages,
      proposals,
    };
  }
}
