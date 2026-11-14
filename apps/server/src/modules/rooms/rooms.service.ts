/**
 * @module server/modules/rooms/service
 * @description 房间生命周期（创建、入群、退群、成员列表）与公开只读分享快照（`/share/:inviteToken`）编排服务。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 双模态建群归属：人类创建房间直接成为 `"owner"`；Agent 代主人创建房间时，自动将其归属主人添加为 `"owner"`，并将该 Agent 添加为 `"member"`，确保房间治理权永远掌握在人类手中。
 * 2. 公开分享零凭据泄露：仅 `visibility === "public_shareable"` 的房间可对外生成分享快照，且强制剥离 `inviteToken` 并使用中立匿名视角盖章。
 */
import {
  type AgentId,
  type AuthenticatedCaller,
  type CreateRoomBody,
  type JoinRoomBody,
  type MessageDto,
  type ProposalCardDto,
  type RoomDetailDto,
  type RoomId,
  type RoomMemberDto,
  type RoomSummaryDto,
  asReadCursorSeq,
  createDefaultGovernanceState,
} from "@openhuddle/protocol";
import { generateInviteToken, generateRoomId } from "../../infra/crypto.js";
import { AppError } from "../../infra/errors.js";
import { PUBLIC_NEUTRAL_VIEWER, toActorMemberKey } from "../../infra/identity-stamp.js";
import type { RealtimeBus } from "../../infra/realtime-bus.js";
import type { SafeAgentRecord } from "../auth/auth.repo.js";
import { type MessagesRepository, stampRawMessageForViewer } from "../messages/messages.repo.js";
import {
  type ProposalsRepository,
  stampRawProposalForViewer,
} from "../proposals/proposals.repo.js";
import { type RoomsRepository, buildRoomDetailDto } from "./rooms.repo.js";

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
  /** 按主键查询 Agent 归属主人（由 pairing 仓储提供，用于建群直拉本人 Agent 的归属校验） */
  readonly findAgentById: (agentId: AgentId) => Promise<SafeAgentRecord | undefined>;
}

/**
 * 房间、成员与公开分享编排服务。
 */
export class RoomsService {
  private readonly roomsRepo: RoomsRepository;
  private readonly messagesRepo: MessagesRepository;
  private readonly proposalsRepo: ProposalsRepository;
  private readonly realtimeBus: RealtimeBus;
  private readonly findAgentById: RoomsServiceDeps["findAgentById"];

  /**
   * @param deps - 房间、消息、提案仓储及实时事件总线
   */
  public constructor(deps: Readonly<RoomsServiceDeps>) {
    this.roomsRepo = deps.roomsRepo;
    this.messagesRepo = deps.messagesRepo;
    this.proposalsRepo = deps.proposalsRepo;
    this.realtimeBus = deps.realtimeBus;
    this.findAgentById = deps.findAgentById;
  }

  /**
   * 列出当前人类或 Agent 已加入的全部房间概览。
   *
   * @param caller - 当前已认证身份
   * @returns `RoomSummaryDto` 数组
   */
  public async listMyRooms(
    caller: Readonly<AuthenticatedCaller>,
  ): Promise<readonly RoomSummaryDto[]> {
    return this.roomsRepo.listJoinedRooms(toActorMemberKey(caller));
  }

  /**
   * 创建新 Huddle 房间并初始化治理快照与群主成员关系。
   *
   * @param caller - 当前已认证人类或 Agent
   * @param body - 房间名称、主题、规则、可见性及治理覆盖参数
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

    // Owner-First 建群直拉：逐个校验 Agent 归属（仅允许本人名下），杜绝替他人 Agent 强制入群
    const initialAgentIds = [...new Set(body.initialAgentIds)];
    const ownedAgents = new Map<AgentId, SafeAgentRecord>();
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
      ownedAgents.set(agentId, agent);
    }

    const roomRecord = await this.roomsRepo.runInTransaction(async (txRepo) => {
      const created = await txRepo.insertRoom({
        id: roomId,
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

      for (const agentId of ownedAgents.keys()) {
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

    const members = await this.roomsRepo.listHydratedMembers(roomRecord.id, this.realtimeBus);
    return buildRoomDetailDto(roomRecord, members, {
      yourLastReadSeq: 0,
      includeInviteToken: true,
    });
  }

  /**
   * 获取指定房间完整详情（含成员实时可达状态与邀请令牌）。
   *
   * @param caller - 当前已认证身份
   * @param roomId - 房间主键
   * @returns `RoomDetailDto`
   * @throws {AppError} 房间不存在抛 `404`；调用者不在群内抛 `403 FORBIDDEN_NOT_ROOM_MEMBER`
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

    const members = await this.roomsRepo.listHydratedMembers(roomId, this.realtimeBus);
    return buildRoomDetailDto(room, members, {
      yourLastReadSeq: membership.lastReadSeq,
      includeInviteToken: true,
    });
  }

  /**
   * 凭房间邀请令牌（`inv_...`）幂等加入目标房间。
   *
   * @param caller - 当前已认证人类或 Agent
   * @param body - 含 `inviteToken` 的请求体
   * @returns 入群后的 `RoomDetailDto`
   * @throws {AppError} 邀请令牌无效抛 `404 NOT_FOUND`
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

    const memberKey = toActorMemberKey(caller);
    await this.roomsRepo.addRoomMemberIfAbsent({
      roomId: room.id,
      memberKey,
      memberKind: caller.kind,
      ...(caller.kind === "human" ? { userId: caller.userId } : { agentId: caller.agentId }),
      role: caller.kind === "human" && room.ownerUserId === caller.userId ? "owner" : "member",
      lastReadSeq: 0,
    });

    const membership = await this.roomsRepo.findMembership(room.id, memberKey);
    const members = await this.roomsRepo.listHydratedMembers(room.id, this.realtimeBus);

    return buildRoomDetailDto(room, members, {
      yourLastReadSeq: membership?.lastReadSeq ?? 0,
      includeInviteToken: true,
    });
  }

  /**
   * 退出指定房间。
   *
   * @param caller - 当前已认证调用者
   * @param roomId - 房间主键
   * @throws {AppError} 房间不存在抛 `404`；非成员抛 `403 FORBIDDEN_NOT_ROOM_MEMBER`
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
   * 加载公开分享房间（`visibility === "public_shareable"`）的零信任只读快照。
   *
   * @param inviteToken - 分享链接中的 `inviteToken`
   * @returns 房间详情、消息流与提案列表快照
   * @throws {AppError} 当房间不存在或未开启 `public_shareable` 时统一抛 `404 NOT_FOUND`（防枚举探测）
   */
  public async getPublicShareSnapshot(inviteToken: string): Promise<PublicRoomShareSnapshot> {
    const room = await this.roomsRepo.findRoomByInviteToken(inviteToken);
    if (!room || room.visibility !== "public_shareable") {
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
    const messages = rawMessages.map((msg) => stampRawMessageForViewer(msg, PUBLIC_NEUTRAL_VIEWER));
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
