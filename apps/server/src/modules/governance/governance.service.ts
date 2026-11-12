/**
 * @module server/modules/governance/service
 * @description 人类裁判控制台治理策略热更新、一键续命轮次预算（`renewTurnBudget`）与事务后广播编排服务。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 严格人类裁判权限：仅房间内角色为 `owner` 或 `moderator` 的人类成员可修改治理配置或解锁 `paused_budget`，任何 Agent 或普通外部成员一律返回 `403 FORBIDDEN_NOT_OWNER`。
 * 2. 事务后广播（Post-Commit Only）：`governance.updated` SSE 事件必须在数据库事务提交成功后才能投递至 `RealtimeBus`。
 */
import { renewTurnBudget } from "@openhuddle/core-governance";
import type {
  AuthenticatedCaller,
  RoomDetailDto,
  RoomGovernanceState,
  RoomId,
  UpdateGovernanceBody,
} from "@openhuddle/protocol";
import { assertHumanCaller } from "../../infra/auth-middleware.js";
import { AppError } from "../../infra/errors.js";
import { toActorMemberKey } from "../../infra/identity-stamp.js";
import type { RealtimeBus } from "../../infra/realtime-bus.js";
import { type RoomsRepository, buildRoomDetailDto } from "../rooms/rooms.repo.js";

/**
 * 构造 `GovernanceService` 所需的依赖。
 */
export interface GovernanceServiceDeps {
  readonly roomsRepo: RoomsRepository;
  readonly realtimeBus: RealtimeBus;
}

/**
 * 房间治理策略热更新编排服务。
 */
export class GovernanceService {
  private readonly roomsRepo: RoomsRepository;
  private readonly realtimeBus: RealtimeBus;

  /**
   * @param deps - 房间仓储与实时事件总线
   */
  public constructor(deps: Readonly<GovernanceServiceDeps>) {
    this.roomsRepo = deps.roomsRepo;
    this.realtimeBus = deps.realtimeBus;
  }

  /**
   * 热更新房间治理规则、切换公开可见性或一键重置连续 Agent 轮次预算。
   *
   * @param caller - 当前调用者（必须为房间 `owner` 或 `moderator` 人类）
   * @param roomId - 房间主键
   * @param body - 治理更新项与 `renewBudget` 标志
   * @returns 更新后的完整 `RoomDetailDto`
   * @throws {AppError} Agent 或无裁判权成员抛 `403 FORBIDDEN_NOT_OWNER`；房间不存在抛 `404`
   */
  public async updateRoomGovernance(
    caller: Readonly<AuthenticatedCaller>,
    roomId: RoomId,
    body: Readonly<UpdateGovernanceBody>,
  ): Promise<RoomDetailDto> {
    const human = assertHumanCaller(caller);
    const memberKey = toActorMemberKey(human);

    const txResult = await this.roomsRepo.runInTransaction(async (txRepo) => {
      const lockedRoom = await txRepo.lockRoomByIdForUpdate(roomId);
      if (!lockedRoom) {
        throw new AppError({
          code: "NOT_FOUND",
          statusCode: 404,
          message: `Room "${roomId}" was not found.`,
        });
      }

      const membership = await txRepo.findMembership(roomId, memberKey);
      const isAuthorizedOwnerOrMod =
        membership !== undefined &&
        (membership.role === "owner" ||
          membership.role === "moderator" ||
          lockedRoom.ownerUserId === human.userId);

      if (!isAuthorizedOwnerOrMod) {
        throw new AppError({
          code: "FORBIDDEN_NOT_OWNER",
          statusCode: 403,
          message: "Only a human room owner or moderator can modify room governance settings.",
        });
      }

      const current = lockedRoom.governanceJson;
      const updatedConfig = {
        mode: body.mode ?? current.config.mode,
        allowAgentMentions: body.allowAgentMentions ?? current.config.allowAgentMentions,
        maxConsecutiveAgentTurns:
          body.maxConsecutiveAgentTurns ?? current.config.maxConsecutiveAgentTurns,
        requireReadBeforeSend: body.requireReadBeforeSend ?? current.config.requireReadBeforeSend,
        agentCooldownMs: body.agentCooldownMs ?? current.config.agentCooldownMs,
      };

      let nextState: RoomGovernanceState = {
        ...current,
        config: updatedConfig,
      };

      if (body.renewBudget === true) {
        nextState = renewTurnBudget(nextState);
      } else if (
        nextState.status === "paused_budget" &&
        nextState.consecutiveAgentTurns < updatedConfig.maxConsecutiveAgentTurns
      ) {
        nextState = {
          ...nextState,
          status: "active",
        };
      }

      const updatedRoom = await txRepo.updateGovernanceAndVisibility(roomId, {
        governanceJson: nextState,
        ...(body.visibility !== undefined ? { visibility: body.visibility } : {}),
      });

      return {
        updatedRoom,
        yourLastReadSeq: membership.lastReadSeq,
      };
    });

    // 事务提交后广播：确保所有收到 governance.updated 的客户端立即读取到已落盘的新预算与状态
    await this.realtimeBus.publishToRoom(roomId, {
      type: "governance.updated",
      roomId,
      governance: txResult.updatedRoom.governanceJson,
    });

    const members = await this.roomsRepo.listHydratedMembers(roomId, this.realtimeBus);
    return buildRoomDetailDto(txResult.updatedRoom, members, {
      yourLastReadSeq: txResult.yourLastReadSeq,
      includeInviteToken: true,
    });
  }
}
