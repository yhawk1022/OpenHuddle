/**
 * @module server/modules/friends/service
 * @description 站内用户发现与好友申请制编排服务（ADR-0005）。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 仅限人类操作：任何 Agent 令牌调用好友或站内用户目录接口一律返回 `403 FORBIDDEN_NOT_OWNER`，确保社交图谱完全由人类本人控制。
 * 2. 双向互申自动合流：若甲向乙发送好友申请时，乙此前已向甲发过待处理申请，在同一行锁事务内自动合流升级为 `accepted`。
 * 3. 事务后实时同步（Post-Commit Only）：任何申请、通过、拒绝或解除操作均在事务提交后通过 `RealtimeBus.publishToUser` 推送 `friendship.updated`。
 */
import type {
  AcceptFriendRequestResponse,
  AuthenticatedCaller,
  DirectoryUserSearchResponse,
  FriendsOverviewResponse,
  FriendshipId,
  PublicUserProfileDto,
  SendFriendRequestBody,
  SendFriendRequestResponse,
  UserId,
} from "@openhuddle/protocol";
import { assertHumanCaller } from "../../infra/auth-middleware.js";
import { generateFriendshipId } from "../../infra/crypto.js";
import { AppError } from "../../infra/errors.js";
import type { RealtimeBus } from "../../infra/realtime-bus.js";
import { type FriendsRepository, toCanonicalUserPair } from "./friends.repo.js";

/**
 * 构造 `FriendsService` 所需的依赖。
 */
export interface FriendsServiceDeps {
  readonly repo: FriendsRepository;
  readonly realtimeBus: RealtimeBus;
}

/**
 * 好友关系、申请与站内通讯录编排服务。
 */
export class FriendsService {
  private readonly repo: FriendsRepository;
  private readonly realtimeBus: RealtimeBus;

  /**
   * @param deps - 好友仓储与实时事件总线
   */
  public constructor(deps: Readonly<FriendsServiceDeps>) {
    this.repo = deps.repo;
    this.realtimeBus = deps.realtimeBus;
  }

  /**
   * 内部供 `RoomsService` 与 `MessagesService` 复用的好友关系强校验辅助方法。
   *
   * @param userA - 用户 A 主键
   * @param userB - 用户 B 主键
   * @returns 双方是否已建立有效 `accepted` 好友关系
   */
  public async areAcceptedFriends(userA: UserId, userB: UserId): Promise<boolean> {
    return this.repo.areUsersAcceptedFriends(userA, userB);
  }

  /**
   * 查询指定活跃人类的公开名片（供单聊与拉群校验目标用户状态）。
   *
   * @param userId - 目标用户主键
   * @returns `PublicUserProfileDto` 或 `undefined`
   */
  public async findActiveUserById(userId: UserId): Promise<PublicUserProfileDto | undefined> {
    return this.repo.findActiveUserById(userId);
  }

  /**
   * 获取当前人类用户的完整通讯录快照（好友列表、收发申请与站内开放私聊 Agent）。
   *
   * @param caller - 当前已认证调用者（必须为人类）
   * @returns `FriendsOverviewResponse`
   */
  public async getOverview(
    caller: Readonly<AuthenticatedCaller>,
  ): Promise<FriendsOverviewResponse> {
    const human = assertHumanCaller(caller);
    const data = await this.repo.getFriendsOverviewData(human.userId, this.realtimeBus);
    return {
      ok: true,
      friends: [...data.friends],
      incomingRequests: [...data.incomingRequests],
      outgoingRequests: [...data.outgoingRequests],
      discoverableAgents: [...data.discoverableAgents],
    };
  }

  /**
   * 按昵称或邮箱检索站内活跃人类用户并返回当前社交关系。
   *
   * @param caller - 当前已认证调用者（必须为人类）
   * @param query - 搜索关键词
   * @returns `DirectoryUserSearchResponse`
   */
  public async searchUsers(
    caller: Readonly<AuthenticatedCaller>,
    query: string,
  ): Promise<DirectoryUserSearchResponse> {
    const human = assertHumanCaller(caller);
    const users = await this.repo.searchActiveUsers(human.userId, query, 20);
    return {
      ok: true,
      users: [...users],
    };
  }

  /**
   * 发送好友申请（或在对端已向本人发起待审申请时自动通过成为好友）。
   *
   * @param caller - 当前已认证调用者（必须为人类）
   * @param body - 目标用户 ID 或邮箱及可选验证附言
   * @returns `SendFriendRequestResponse`
   * @throws {AppError} 对自己申请抛 `400 CANNOT_FRIEND_SELF`；目标不存在或封禁抛 `404 NOT_FOUND`
   */
  public async sendFriendRequest(
    caller: Readonly<AuthenticatedCaller>,
    body: Readonly<SendFriendRequestBody>,
  ): Promise<SendFriendRequestResponse> {
    const human = assertHumanCaller(caller);

    const target =
      body.targetUserId !== undefined
        ? await this.repo.findActiveUserById(body.targetUserId)
        : body.email !== undefined
          ? await this.repo.findActiveUserByEmail(body.email)
          : undefined;

    if (!target) {
      throw new AppError({
        code: "NOT_FOUND",
        statusCode: 404,
        message: "未找到对应的正常活跃用户，请核对邮箱或昵称。",
      });
    }

    if (target.userId === human.userId) {
      throw new AppError({
        code: "CANNOT_FRIEND_SELF",
        statusCode: 400,
        message: "不能向自己发送好友申请。",
      });
    }

    const { pairKey, userLowId, userHighId } = toCanonicalUserPair(human.userId, target.userId);
    const cleanNote = body.note?.trim();
    const now = new Date();

    const txOutcome = await this.repo.runInTransaction(async (txRepo) => {
      // 1. 尝试无锁冲突安全插入；若已存在同 pairKey 记录则回落至排他行锁演进状态机
      const inserted = await txRepo.tryInsertPendingRequest({
        id: generateFriendshipId(),
        pairKey,
        userLowId,
        userHighId,
        requesterUserId: human.userId,
        addresseeUserId: target.userId,
        ...(cleanNote !== undefined && cleanNote.length > 0 ? { note: cleanNote } : {}),
      });

      if (inserted) {
        return {
          status: "pending" as const,
          friendshipId: inserted.id,
          autoAccepted: false,
          shouldBroadcast: true,
        };
      }

      const locked = await txRepo.lockByPairKeyForUpdate(pairKey);
      if (!locked) {
        // 极端竞态下对端刚删除记录：重新插入
        const retried = await txRepo.tryInsertPendingRequest({
          id: generateFriendshipId(),
          pairKey,
          userLowId,
          userHighId,
          requesterUserId: human.userId,
          addresseeUserId: target.userId,
          ...(cleanNote !== undefined && cleanNote.length > 0 ? { note: cleanNote } : {}),
        });
        if (!retried) {
          throw new Error("Unexpected race while creating friendship request.");
        }
        return {
          status: "pending" as const,
          friendshipId: retried.id,
          autoAccepted: false,
          shouldBroadcast: true,
        };
      }

      if (locked.status === "accepted") {
        return {
          status: "accepted" as const,
          friendshipId: locked.id,
          autoAccepted: false,
          shouldBroadcast: false,
        };
      }

      // 双向互申自动合流：对方此前已向我发起待处理申请，直接合并通过
      if (locked.addresseeUserId === human.userId) {
        const accepted = await txRepo.markAccepted(locked.id, now);
        return {
          status: "accepted" as const,
          friendshipId: accepted.id,
          autoAccepted: true,
          shouldBroadcast: true,
        };
      }

      if (cleanNote !== undefined && cleanNote.length > 0 && cleanNote !== locked.note) {
        await txRepo.updatePendingNote(locked.id, cleanNote);
      }

      return {
        status: "pending" as const,
        friendshipId: locked.id,
        autoAccepted: false,
        shouldBroadcast: true,
      };
    });

    if (txOutcome.shouldBroadcast) {
      await Promise.all([
        this.realtimeBus.publishToUser(human.userId, { type: "friendship.updated" }),
        this.realtimeBus.publishToUser(target.userId, { type: "friendship.updated" }),
      ]);
    }

    return {
      ok: true,
      status: txOutcome.status,
      friendshipId: txOutcome.friendshipId,
      autoAccepted: txOutcome.autoAccepted,
    };
  }

  /**
   * 同意收到的待处理好友申请。
   *
   * @param caller - 当前已认证调用者（必须为申请接收方本人）
   * @param friendshipId - 好友申请主键
   * @returns 包含新好友详情的 `AcceptFriendRequestResponse`
   */
  public async acceptFriendRequest(
    caller: Readonly<AuthenticatedCaller>,
    friendshipId: FriendshipId,
  ): Promise<AcceptFriendRequestResponse> {
    const human = assertHumanCaller(caller);
    const now = new Date();

    const acceptedRecord = await this.repo.runInTransaction(async (txRepo) => {
      const locked = await txRepo.lockByIdForUpdate(friendshipId);
      if (!locked) {
        throw new AppError({
          code: "NOT_FOUND",
          statusCode: 404,
          message: "该好友申请不存在或已被撤回。",
        });
      }

      // 安全边界：仅申请的目标接收人（addressee）本人有权点击同意，发起人不可自批通过
      if (locked.addresseeUserId !== human.userId) {
        throw new AppError({
          code: "FORBIDDEN_NOT_OWNER",
          statusCode: 403,
          message: "只有好友申请的接收方本人可以同意该请求。",
        });
      }

      if (locked.status === "accepted") {
        return locked;
      }

      return txRepo.markAccepted(locked.id, now);
    });

    const peerUserId =
      acceptedRecord.userLowId === human.userId
        ? acceptedRecord.userHighId
        : acceptedRecord.userLowId;

    await Promise.all([
      this.realtimeBus.publishToUser(human.userId, { type: "friendship.updated" }),
      this.realtimeBus.publishToUser(peerUserId, { type: "friendship.updated" }),
    ]);

    const overview = await this.repo.getFriendsOverviewData(human.userId, this.realtimeBus);
    const hydratedFriend = overview.friends.find((f) => f.user.userId === peerUserId);
    if (!hydratedFriend) {
      throw new AppError({
        code: "NOT_FOUND",
        statusCode: 404,
        message: "对方账号状态异常，无法建立好友关系。",
      });
    }

    return {
      ok: true,
      friend: hydratedFriend,
    };
  }

  /**
   * 拒绝收到的好友申请或撤回本人发出的待处理申请。
   *
   * @param caller - 当前已认证人类调用者
   * @param friendshipId - 好友申请主键
   */
  public async declineOrCancelRequest(
    caller: Readonly<AuthenticatedCaller>,
    friendshipId: FriendshipId,
  ): Promise<void> {
    const human = assertHumanCaller(caller);

    const peerUserId = await this.repo.runInTransaction(async (txRepo) => {
      const locked = await txRepo.lockByIdForUpdate(friendshipId);
      if (!locked) {
        return undefined;
      }

      if (locked.requesterUserId !== human.userId && locked.addresseeUserId !== human.userId) {
        throw new AppError({
          code: "FORBIDDEN_NOT_OWNER",
          statusCode: 403,
          message: "无权操作他人的好友申请。",
        });
      }

      await txRepo.deleteById(locked.id);
      return locked.userLowId === human.userId ? locked.userHighId : locked.userLowId;
    });

    if (peerUserId !== undefined) {
      await Promise.all([
        this.realtimeBus.publishToUser(human.userId, { type: "friendship.updated" }),
        this.realtimeBus.publishToUser(peerUserId, { type: "friendship.updated" }),
      ]);
    }
  }

  /**
   * 解除与指定人类用户的好友关系。
   *
   * @param caller - 当前已认证人类调用者
   * @param friendUserId - 待解除好友的目标用户主键
   */
  public async removeFriend(
    caller: Readonly<AuthenticatedCaller>,
    friendUserId: UserId,
  ): Promise<void> {
    const human = assertHumanCaller(caller);
    if (friendUserId === human.userId) {
      return;
    }

    const { pairKey } = toCanonicalUserPair(human.userId, friendUserId);
    const deleted = await this.repo.deleteByPairKey(pairKey);
    if (deleted !== undefined) {
      await Promise.all([
        this.realtimeBus.publishToUser(human.userId, { type: "friendship.updated" }),
        this.realtimeBus.publishToUser(friendUserId, { type: "friendship.updated" }),
      ]);
    }
  }
}
