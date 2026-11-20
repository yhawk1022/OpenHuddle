/**
 * @module server/modules/admin/service
 * @description 运营与治理管理后台领域编排服务（数据大盘聚合、账号与会话控制、跨房内容监管、护栏防护与强制审计日志）。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 强鉴权防线：全部服务方法入口均调用 `assertAdminCaller(caller)`，拒绝普通用户及一切 Agent 令牌越权操作。
 * 2. 不可自我破坏护栏（Guardrails）：禁止管理员对自身账号降权/封禁/删除；禁止降权/封禁/删除 `ADMIN_EMAILS` 锁定超管及全站最后一名活跃管理员。
 * 3. 写操作强制审计：任意修改与删除动作必须在同一数据库事务内写入 `admin_audit_logs`。
 * 4. 事务后广播（Post-Commit Only）：`room.deleted`、`governance.updated`、`message.created` 与内存订阅驱逐必须在事务成功提交后执行。
 */
import { renewTurnBudget } from "@openhuddle/core-governance";
import type {
  AdminAgentItem,
  AdminAgentListQuery,
  AdminAuditLogItem,
  AdminAuditLogListQuery,
  AdminDeleteAgentResponse,
  AdminDeleteProposalResponse,
  AdminDeleteRoomResponse,
  AdminDeleteUserResponse,
  AdminOverviewResponse,
  AdminPagination,
  AdminPairingCodeItem,
  AdminPairingCodeListQuery,
  AdminProposalItem,
  AdminProposalListQuery,
  AdminPurgeExpiredSessionsResponse,
  AdminPurgePairingCodesResponse,
  AdminRecallMessageBody,
  AdminRecallMessageResponse,
  AdminRevokePairingCodeResponse,
  AdminRevokeSessionResponse,
  AdminRevokeUserSessionsResponse,
  AdminRoomDetailResponse,
  AdminRoomItem,
  AdminRoomListQuery,
  AdminRoomMessagesQuery,
  AdminRoomMessagesResponse,
  AdminSessionItem,
  AdminSessionListQuery,
  AdminUpdateRoomBody,
  AdminUpdateRoomResponse,
  AdminUpdateUserBody,
  AdminUpdateUserResponse,
  AdminUserDetailResponse,
  AdminUserItem,
  AdminUserListQuery,
  AgentId,
  AuthenticatedCaller,
  MessageSeq,
  PairingCode,
  ProposalId,
  RoomGovernanceState,
  RoomId,
  SessionId,
  UserId,
} from "@openhuddle/protocol";
import { assertAdminCaller } from "../../infra/auth-middleware.js";
import { generateAuditLogId } from "../../infra/crypto.js";
import { type ServerEnv, parseAdminEmailSet } from "../../infra/env.js";
import { AppError } from "../../infra/errors.js";
import type { RealtimeBus } from "../../infra/realtime-bus.js";
import { type AuthRepository, mapAgentRecordToSummaryDto } from "../auth/auth.repo.js";
import { stampRawMessageForViewer } from "../messages/messages.repo.js";
import {
  type ProposalsRepository,
  stampRawProposalForViewer,
} from "../proposals/proposals.repo.js";
import type { RoomsRepository } from "../rooms/rooms.repo.js";
import type { AdminRepository } from "./admin.repo.js";

/**
 * 构造 `AdminService` 所需的依赖集合。
 */
export interface AdminServiceDeps {
  readonly adminRepo: AdminRepository;
  readonly authRepo: AuthRepository;
  readonly roomsRepo: RoomsRepository;
  readonly proposalsRepo: ProposalsRepository;
  readonly realtimeBus: RealtimeBus;
  readonly env: ServerEnv;
  readonly databaseDriver: "pglite" | "postgres";
  readonly startedAtMs: number;
}

/**
 * 运营与治理管理后台核心服务类。
 */
export class AdminService {
  private readonly adminRepo: AdminRepository;
  private readonly authRepo: AuthRepository;
  private readonly roomsRepo: RoomsRepository;
  private readonly proposalsRepo: ProposalsRepository;
  private readonly realtimeBus: RealtimeBus;
  private readonly env: ServerEnv;
  private readonly databaseDriver: "pglite" | "postgres";
  private readonly startedAtMs: number;

  /**
   * @param deps - 仓储层、实时总线、运行配置与系统启动时间戳
   */
  public constructor(deps: Readonly<AdminServiceDeps>) {
    this.adminRepo = deps.adminRepo;
    this.authRepo = deps.authRepo;
    this.roomsRepo = deps.roomsRepo;
    this.proposalsRepo = deps.proposalsRepo;
    this.realtimeBus = deps.realtimeBus;
    this.env = deps.env;
    this.databaseDriver = deps.databaseDriver;
    this.startedAtMs = deps.startedAtMs;
  }

  private getAdminEmails(): ReadonlySet<string> {
    return parseAdminEmailSet(this.env.ADMIN_EMAILS);
  }

  private extractActorMeta(caller: Readonly<AuthenticatedCaller>) {
    const admin = assertAdminCaller(caller);
    return {
      admin,
      actorUserId: admin.userId,
      actorEmail: admin.email ?? "admin@openhuddle.local",
      actorDisplayName: admin.displayName,
    };
  }

  /* ─────────────────────────────────────────────────────────────
   * 1. 数据统计大盘
   * ───────────────────────────────────────────────────────────── */

  /**
   * 汇总全平台数据统计大盘指标、连续日趋势、结构分布、Top 排行与实时总线遥测。
   */
  public async getOverview(
    caller: Readonly<AuthenticatedCaller>,
    windowDays: number,
  ): Promise<AdminOverviewResponse> {
    assertAdminCaller(caller);
    const now = new Date();
    const nowMs = now.getTime();
    const since24h = new Date(nowMs - 24 * 3_600_000);
    const since7d = new Date(nowMs - 7 * 86_400_000);
    const adminEmails = this.getAdminEmails();

    const [
      dbKpis,
      dailyTrends,
      agentDist,
      roomGovDist,
      topActiveRooms,
      topActiveUsers,
      recentAuditRes,
    ] = await Promise.all([
      this.adminRepo.getDatabaseOverviewKpis(now, since24h, since7d),
      this.adminRepo.getDailyTrends(windowDays, now),
      this.adminRepo.getAgentDistributions(this.realtimeBus, nowMs),
      this.adminRepo.getRoomGovernanceDistribution(),
      this.adminRepo.getTopActiveRooms(5),
      this.adminRepo.getTopActiveUsers(5, adminEmails),
      this.adminRepo.listAuditLogs({ page: 1, pageSize: 8 }),
    ]);

    const busTelemetry = this.realtimeBus.getTelemetry();

    return {
      ok: true,
      windowDays,
      runtime: {
        databaseDriver: this.databaseDriver,
        realtimeBusDriver: this.env.REALTIME_BUS_DRIVER,
        activeAgentConnections: busTelemetry.activeAgentConnections,
        activeAgentCount: busTelemetry.activeAgentCount,
        activeRoomSubscriptions: busTelemetry.activeRoomSubscriptions,
        activeRoomCount: busTelemetry.activeRoomCount,
        uptimeSec: Math.max(0, Math.floor((nowMs - this.startedAtMs) / 1_000)),
        serverTimeIso: now.toISOString(),
      },
      kpis: {
        ...dbKpis,
        onlineSseAgents: agentDist.onlineSseAgents,
      },
      dailyTrends: [...dailyTrends],
      agentPlatformDistribution: [...agentDist.platformDistribution],
      agentReachDistribution: [...agentDist.reachDistribution],
      roomGovernanceDistribution: [...roomGovDist],
      topActiveRooms: [...topActiveRooms],
      topActiveUsers: [...topActiveUsers],
      recentAuditLogs: [...recentAuditRes.logs],
    };
  }

  /* ─────────────────────────────────────────────────────────────
   * 2. 用户账号管理
   * ───────────────────────────────────────────────────────────── */

  /**
   * 分页查询用户账号列表。
   */
  public async listUsers(
    caller: Readonly<AuthenticatedCaller>,
    query: Readonly<AdminUserListQuery>,
  ): Promise<{ readonly users: readonly AdminUserItem[]; readonly pagination: AdminPagination }> {
    assertAdminCaller(caller);
    return this.adminRepo.listUsers(query, new Date(), this.getAdminEmails());
  }

  /**
   * 查询指定用户的全量档案（基本统计、名下 Agent、加入的群聊及登录会话列表）。
   */
  public async getUserDetail(
    caller: Readonly<AuthenticatedCaller>,
    userId: UserId,
  ): Promise<AdminUserDetailResponse> {
    assertAdminCaller(caller);
    const now = new Date();
    const adminEmails = this.getAdminEmails();
    const user = await this.adminRepo.findUserItemById(userId, now, adminEmails);
    if (!user) {
      throw new AppError({
        code: "NOT_FOUND",
        statusCode: 404,
        message: `User "${userId}" was not found.`,
      });
    }

    const [agentRecords, rooms, sessions] = await Promise.all([
      this.authRepo.listAgentsByOwner(userId),
      this.adminRepo.listUserJoinedRoomBriefs(userId),
      this.adminRepo.listSessionsForUser(userId, now, adminEmails),
    ]);

    return {
      ok: true,
      user,
      agents: agentRecords.map((record) => mapAgentRecordToSummaryDto(record, this.realtimeBus)),
      rooms: [...rooms],
      sessions: [...sessions],
    };
  }

  /**
   * 编辑用户展示昵称、升降管理员权限或执行封禁/解封操作（自动执行护栏校验与强审计）。
   */
  public async updateUser(
    caller: Readonly<AuthenticatedCaller>,
    targetUserId: UserId,
    body: Readonly<AdminUpdateUserBody>,
  ): Promise<AdminUpdateUserResponse> {
    const actor = this.extractActorMeta(caller);
    const now = new Date();
    const adminEmails = this.getAdminEmails();

    const target = await this.adminRepo.findUserItemById(targetUserId, now, adminEmails);
    if (!target) {
      throw new AppError({
        code: "NOT_FOUND",
        statusCode: 404,
        message: `User "${targetUserId}" was not found.`,
      });
    }

    const isDemoting = body.role === "user" && target.role === "admin";
    const isSuspending = body.status === "suspended" && target.status !== "suspended";

    // 护栏 1：禁止自我降权或自我封禁，避免管理后台失去全部可用操作入口
    if (targetUserId === actor.actorUserId && (isDemoting || body.status === "suspended")) {
      throw new AppError({
        code: "ADMIN_GUARDRAIL_VIOLATION",
        statusCode: 400,
        message: "You cannot demote or suspend your own administrator account.",
      });
    }

    // 护栏 2：受 ADMIN_EMAILS 环境变量白名单锁定的超级管理员不可在界面被降权或封禁
    if (target.isEnvPinnedAdmin && (isDemoting || body.status === "suspended")) {
      throw new AppError({
        code: "ADMIN_GUARDRAIL_VIOLATION",
        statusCode: 400,
        message:
          "This user is pinned as a super-admin via ADMIN_EMAILS; update environment configuration first.",
      });
    }

    // 护栏 3：禁止降权或封禁全站最后一名活跃管理员
    if (target.role === "admin" && target.status === "active" && (isDemoting || isSuspending)) {
      const activeAdmins = await this.adminRepo.countActiveAdmins();
      if (activeAdmins <= 1) {
        throw new AppError({
          code: "ADMIN_GUARDRAIL_VIOLATION",
          statusCode: 400,
          message: "Cannot demote or suspend the last active administrator.",
        });
      }
    }

    const txResult = await this.adminRepo.runInTransaction(async (txRepo) => {
      let revokedSessionCount = 0;
      let ownedAgentIds: readonly AgentId[] = [];

      const patch: {
        displayName?: string;
        role?: "user" | "admin";
        status?: "active" | "suspended";
        suspendedAt?: Date | null;
        suspendedReason?: string | null;
      } = {};

      if (body.displayName !== undefined && body.displayName !== target.displayName) {
        patch.displayName = body.displayName;
      }
      if (body.role !== undefined && body.role !== target.role) {
        patch.role = body.role;
      }
      if (body.status === "suspended") {
        patch.status = "suspended";
        if (target.status !== "suspended") {
          patch.suspendedAt = now;
        }
        if (body.suspendedReason !== undefined) {
          patch.suspendedReason = body.suspendedReason.length > 0 ? body.suspendedReason : null;
        }
      } else if (body.status === "active" && target.status === "suspended") {
        patch.status = "active";
        patch.suspendedAt = null;
        patch.suspendedReason = null;
      }

      await txRepo.updateUserGovernance(targetUserId, patch);

      if (body.status === "suspended" && target.status !== "suspended") {
        // 封禁即刻切断该人类所有现有 Web 会话并获取其名下 Agent 列表以便事务后驱逐 SSE 长连
        revokedSessionCount = await txRepo.deleteAllSessionsByUserId(targetUserId);
        ownedAgentIds = await txRepo.listOwnedAgentIds(targetUserId);
      }

      if (patch.displayName !== undefined) {
        await txRepo.insertAuditLog({
          id: generateAuditLogId(),
          actorUserId: actor.actorUserId,
          actorEmail: actor.actorEmail,
          actorDisplayName: actor.actorDisplayName,
          action: "user.profile_updated",
          targetType: "user",
          targetId: targetUserId,
          summary: `修改用户 ${target.email} 昵称为「${patch.displayName}」`,
          metadata: {
            previousDisplayName: target.displayName,
            nextDisplayName: patch.displayName,
          },
        });
      }

      if (patch.role !== undefined) {
        await txRepo.insertAuditLog({
          id: generateAuditLogId(),
          actorUserId: actor.actorUserId,
          actorEmail: actor.actorEmail,
          actorDisplayName: actor.actorDisplayName,
          action: "user.role_updated",
          targetType: "user",
          targetId: targetUserId,
          summary:
            patch.role === "admin"
              ? `授予用户 ${target.email} 平台管理员权限`
              : `撤销用户 ${target.email} 的平台管理员权限`,
          metadata: {
            previousRole: target.role,
            nextRole: patch.role,
          },
        });
      }

      if (patch.status === "suspended") {
        await txRepo.insertAuditLog({
          id: generateAuditLogId(),
          actorUserId: actor.actorUserId,
          actorEmail: actor.actorEmail,
          actorDisplayName: actor.actorDisplayName,
          action: "user.suspended",
          targetType: "user",
          targetId: targetUserId,
          summary: `封禁用户 ${target.email}（踢出 ${revokedSessionCount} 个活跃会话）`,
          metadata: {
            revokedSessionCount,
            ...(patch.suspendedReason ? { reason: patch.suspendedReason } : {}),
          },
        });
      } else if (patch.status === "active") {
        await txRepo.insertAuditLog({
          id: generateAuditLogId(),
          actorUserId: actor.actorUserId,
          actorEmail: actor.actorEmail,
          actorDisplayName: actor.actorDisplayName,
          action: "user.unsuspended",
          targetType: "user",
          targetId: targetUserId,
          summary: `解封恢复用户 ${target.email}`,
        });
      }

      const updatedUser = await txRepo.findUserItemById(targetUserId, now, adminEmails);
      if (!updatedUser) {
        throw new Error(`Failed to reload user ${targetUserId} after admin update.`);
      }

      return {
        user: updatedUser,
        revokedSessionCount,
        ownedAgentIds,
      };
    });

    // Post-Commit：对被封禁账号名下 Agent 立即驱逐内存唤醒监听器，阻断离线前保留的长连
    for (const agentId of txResult.ownedAgentIds) {
      this.realtimeBus.evictAgentSubscribers(agentId);
    }

    return {
      ok: true,
      user: txResult.user,
      revokedSessionCount: txResult.revokedSessionCount,
    };
  }

  /**
   * 彻底注销并级联清理指定用户账号及其名下房间、Agent、会话与跨房消息。
   */
  public async deleteUser(
    caller: Readonly<AuthenticatedCaller>,
    targetUserId: UserId,
  ): Promise<AdminDeleteUserResponse> {
    const actor = this.extractActorMeta(caller);
    const now = new Date();
    const adminEmails = this.getAdminEmails();

    const target = await this.adminRepo.findUserItemById(targetUserId, now, adminEmails);
    if (!target) {
      throw new AppError({
        code: "NOT_FOUND",
        statusCode: 404,
        message: `User "${targetUserId}" was not found.`,
      });
    }

    if (targetUserId === actor.actorUserId) {
      throw new AppError({
        code: "ADMIN_GUARDRAIL_VIOLATION",
        statusCode: 400,
        message: "You cannot delete your own administrator account.",
      });
    }

    if (target.isEnvPinnedAdmin) {
      throw new AppError({
        code: "ADMIN_GUARDRAIL_VIOLATION",
        statusCode: 400,
        message:
          "This user is pinned as a super-admin via ADMIN_EMAILS; update environment configuration first.",
      });
    }

    if (target.role === "admin" && target.status === "active") {
      const activeAdmins = await this.adminRepo.countActiveAdmins();
      if (activeAdmins <= 1) {
        throw new AppError({
          code: "ADMIN_GUARDRAIL_VIOLATION",
          statusCode: 400,
          message: "Cannot delete the last active administrator.",
        });
      }
    }

    const cascade = await this.adminRepo.runInTransaction(async (txRepo) => {
      const result = await txRepo.deleteUserCascadeInTx(targetUserId, target.email);
      await txRepo.insertAuditLog({
        id: generateAuditLogId(),
        actorUserId: actor.actorUserId,
        actorEmail: actor.actorEmail,
        actorDisplayName: actor.actorDisplayName,
        action: "user.deleted",
        targetType: "user",
        targetId: targetUserId,
        summary: `彻底删除用户 ${target.email}（连带清理 ${result.deletedRoomIds.length} 个群聊、${result.deletedAgentIds.length} 个 Agent）`,
        metadata: {
          email: target.email,
          deletedRoomCount: result.deletedRoomIds.length,
          deletedAgentCount: result.deletedAgentIds.length,
          deletedSessionCount: result.deletedSessionCount,
        },
      });
      return result;
    });

    // Post-Commit：向所有被连带删除群聊的在线客户端推送 room.deleted 并清理房间及 Agent 订阅
    for (const roomId of cascade.deletedRoomIds) {
      await this.realtimeBus.publishToRoom(roomId, {
        type: "room.deleted",
        roomId,
      });
      this.realtimeBus.evictRoomSubscribers(roomId);
    }
    for (const agentId of cascade.deletedAgentIds) {
      this.realtimeBus.evictAgentSubscribers(agentId);
    }

    return {
      ok: true,
      deletedUserId: targetUserId,
      deletedRoomCount: cascade.deletedRoomIds.length,
      deletedAgentCount: cascade.deletedAgentIds.length,
      deletedSessionCount: cascade.deletedSessionCount,
    };
  }

  /* ─────────────────────────────────────────────────────────────
   * 3. 登录会话管理
   * ───────────────────────────────────────────────────────────── */

  /**
   * 分页检索登录会话列表。
   */
  public async listSessions(
    caller: Readonly<AuthenticatedCaller>,
    query: Readonly<AdminSessionListQuery>,
  ): Promise<{
    readonly sessions: readonly AdminSessionItem[];
    readonly pagination: AdminPagination;
  }> {
    assertAdminCaller(caller);
    return this.adminRepo.listSessions(query, new Date(), this.getAdminEmails());
  }

  /**
   * 强制吊销单条指定登录会话。
   */
  public async revokeSession(
    caller: Readonly<AuthenticatedCaller>,
    sessionId: SessionId,
  ): Promise<AdminRevokeSessionResponse> {
    const actor = this.extractActorMeta(caller);

    await this.adminRepo.runInTransaction(async (txRepo) => {
      const target = await txRepo.findSessionById(sessionId);
      if (!target) {
        throw new AppError({
          code: "NOT_FOUND",
          statusCode: 404,
          message: `Session "${sessionId}" was not found.`,
        });
      }

      await txRepo.deleteSessionById(sessionId);
      await txRepo.insertAuditLog({
        id: generateAuditLogId(),
        actorUserId: actor.actorUserId,
        actorEmail: actor.actorEmail,
        actorDisplayName: actor.actorDisplayName,
        action: "session.revoked",
        targetType: "session",
        targetId: sessionId,
        summary: `强制下线用户 ${target.userEmail} 的登录会话 ${sessionId}`,
        metadata: {
          userId: target.userId,
          userEmail: target.userEmail,
        },
      });
    });

    return {
      ok: true,
      revokedSessionId: sessionId,
    };
  }

  /**
   * 强制踢下线指定用户的全部登录会话。
   */
  public async revokeAllUserSessions(
    caller: Readonly<AuthenticatedCaller>,
    userId: UserId,
  ): Promise<AdminRevokeUserSessionsResponse> {
    const actor = this.extractActorMeta(caller);
    const now = new Date();
    const target = await this.adminRepo.findUserItemById(userId, now, this.getAdminEmails());
    if (!target) {
      throw new AppError({
        code: "NOT_FOUND",
        statusCode: 404,
        message: `User "${userId}" was not found.`,
      });
    }

    const revokedCount = await this.adminRepo.runInTransaction(async (txRepo) => {
      const count = await txRepo.deleteAllSessionsByUserId(userId);
      await txRepo.insertAuditLog({
        id: generateAuditLogId(),
        actorUserId: actor.actorUserId,
        actorEmail: actor.actorEmail,
        actorDisplayName: actor.actorDisplayName,
        action: "user.sessions_revoked_all",
        targetType: "user",
        targetId: userId,
        summary: `强制踢下线用户 ${target.email} 全部会话（共 ${count} 条）`,
        metadata: { revokedCount: count },
      });
      return count;
    });

    return {
      ok: true,
      userId,
      revokedCount,
    };
  }

  /**
   * 一键清理全平台已过期登录会话。
   */
  public async purgeExpiredSessions(
    caller: Readonly<AuthenticatedCaller>,
  ): Promise<AdminPurgeExpiredSessionsResponse> {
    const actor = this.extractActorMeta(caller);
    const now = new Date();

    const purgedCount = await this.adminRepo.runInTransaction(async (txRepo) => {
      const count = await txRepo.purgeExpiredSessions(now);
      await txRepo.insertAuditLog({
        id: generateAuditLogId(),
        actorUserId: actor.actorUserId,
        actorEmail: actor.actorEmail,
        actorDisplayName: actor.actorDisplayName,
        action: "session.purged_expired",
        targetType: "system",
        targetId: "user_sessions",
        summary: `清理全平台已过期登录会话（共 ${count} 条）`,
        metadata: { purgedCount: count },
      });
      return count;
    });

    return {
      ok: true,
      purgedCount,
    };
  }

  /* ─────────────────────────────────────────────────────────────
   * 4. 群聊会话与消息内容监管
   * ───────────────────────────────────────────────────────────── */

  /**
   * 分页查询全平台群聊房间列表。
   */
  public async listRooms(
    caller: Readonly<AuthenticatedCaller>,
    query: Readonly<AdminRoomListQuery>,
  ): Promise<{ readonly rooms: readonly AdminRoomItem[]; readonly pagination: AdminPagination }> {
    assertAdminCaller(caller);
    return this.adminRepo.listRooms(query);
  }

  /**
   * 查询任意群聊的监管详情（成员名册与提案列表）。
   */
  public async getRoomDetail(
    caller: Readonly<AuthenticatedCaller>,
    roomId: RoomId,
  ): Promise<AdminRoomDetailResponse> {
    const admin = assertAdminCaller(caller);
    const found = await this.adminRepo.findAdminRoomById(roomId);
    if (!found) {
      throw new AppError({
        code: "NOT_FOUND",
        statusCode: 404,
        message: `Room "${roomId}" was not found.`,
      });
    }

    const [members, rawProposals] = await Promise.all([
      this.roomsRepo.listHydratedMembers(roomId, this.realtimeBus),
      this.proposalsRepo.listHydratedProposalsByRoom(roomId),
    ]);

    return {
      ok: true,
      room: found.room,
      inviteToken: found.inviteToken,
      members: [...members],
      proposals: rawProposals.map((proposal) => stampRawProposalForViewer(proposal, admin)),
    };
  }

  /**
   * 管理员只读审查任意房间历史消息流（绝不修改任何成员 `last_read_seq` 游标）。
   */
  public async getRoomMessages(
    caller: Readonly<AuthenticatedCaller>,
    roomId: RoomId,
    query: Readonly<AdminRoomMessagesQuery>,
  ): Promise<AdminRoomMessagesResponse> {
    const admin = assertAdminCaller(caller);
    const found = await this.adminRepo.findAdminRoomById(roomId);
    if (!found) {
      throw new AppError({
        code: "NOT_FOUND",
        statusCode: 404,
        message: `Room "${roomId}" was not found.`,
      });
    }

    const { messages, hasMore } = await this.adminRepo.listRoomMessagesForAdmin(roomId, query);
    return {
      ok: true,
      roomId,
      latestSeq: found.room.lastSeq,
      hasMore,
      messages: messages.map((msg) => stampRawMessageForViewer(msg, admin)),
    };
  }

  /**
   * 管理员热更新任意房间元信息、可见性或治理参数并记录审计日志。
   */
  public async updateRoom(
    caller: Readonly<AuthenticatedCaller>,
    roomId: RoomId,
    body: Readonly<AdminUpdateRoomBody>,
  ): Promise<AdminUpdateRoomResponse> {
    const actor = this.extractActorMeta(caller);

    const updatedGovernance = await this.adminRepo.runInTransaction(async (txRepo) => {
      const txRooms = txRepo.getRoomsRepo();
      const lockedRoom = await txRooms.lockRoomByIdForUpdate(roomId);
      if (!lockedRoom) {
        throw new AppError({
          code: "NOT_FOUND",
          statusCode: 404,
          message: `Room "${roomId}" was not found.`,
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

      await txRepo.updateRoomMetaAndGovernance(roomId, {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.topic !== undefined ? { topic: body.topic } : {}),
        ...(body.rules !== undefined ? { rules: body.rules } : {}),
        ...(body.visibility !== undefined ? { visibility: body.visibility } : {}),
        governanceJson: nextState,
      });

      await txRepo.insertAuditLog({
        id: generateAuditLogId(),
        actorUserId: actor.actorUserId,
        actorEmail: actor.actorEmail,
        actorDisplayName: actor.actorDisplayName,
        action: "room.updated",
        targetType: "room",
        targetId: roomId,
        summary: `管理员调整群聊「${body.name ?? lockedRoom.name}」配置与治理规则`,
        metadata: {
          ...body,
        },
      });

      return nextState;
    });

    // Post-Commit：向房间在线成员下推治理热更新帧
    await this.realtimeBus.publishToRoom(roomId, {
      type: "governance.updated",
      roomId,
      governance: updatedGovernance,
    });

    const refreshed = await this.adminRepo.findAdminRoomById(roomId);
    if (!refreshed) {
      throw new Error(`Failed to reload room ${roomId} after admin update.`);
    }
    return {
      ok: true,
      room: refreshed.room,
    };
  }

  /**
   * 管理员强制撤回违规消息（不受 2 分钟作者撤回时限约束，且同步广播在线端）。
   */
  public async recallMessage(
    caller: Readonly<AuthenticatedCaller>,
    roomId: RoomId,
    seq: MessageSeq,
    body: Readonly<AdminRecallMessageBody>,
  ): Promise<AdminRecallMessageResponse> {
    const actor = this.extractActorMeta(caller);
    const now = new Date();

    const recalledRaw = await this.adminRepo.runInTransaction(async (txRepo) => {
      const txMessages = txRepo.getMessagesRepo();
      // 严守锁顺序：rooms FOR UPDATE -> messages
      const lockedRoom = await txMessages.lockRoomForUpdate(roomId);
      if (!lockedRoom) {
        throw new AppError({
          code: "NOT_FOUND",
          statusCode: 404,
          message: `Room "${roomId}" was not found.`,
        });
      }

      const existingMsg = await txMessages.findBySeq(roomId, seq);
      if (!existingMsg) {
        throw new AppError({
          code: "NOT_FOUND",
          statusCode: 404,
          message: `Message seq=${seq} was not found in room "${roomId}".`,
        });
      }

      const recalled = await txMessages.recallMessage(roomId, seq, now);
      await txRepo.insertAuditLog({
        id: generateAuditLogId(),
        actorUserId: actor.actorUserId,
        actorEmail: actor.actorEmail,
        actorDisplayName: actor.actorDisplayName,
        action: "message.recalled",
        targetType: "message",
        targetId: `${roomId}#${seq}`,
        summary: `管理员强制撤回群聊「${lockedRoom.name}」第 #${seq} 条消息`,
        metadata: {
          roomId,
          seq,
          previousAuthorDisplayName: existingMsg.rawAuthor.displayName,
          ...(body.reason ? { reason: body.reason } : {}),
        },
      });

      return recalled;
    });

    const messageDto = stampRawMessageForViewer(recalledRaw, actor.admin);

    // Post-Commit：推送带有 recalledAtIso 的消息更新帧（下游 SSE 会按订阅者重算 AuthorStamp）
    await this.realtimeBus.publishToRoom(roomId, {
      type: "message.created",
      roomId,
      message: messageDto,
    });

    return {
      ok: true,
      message: messageDto,
    };
  }

  /**
   * 管理员强制解散群聊房间并向在线成员推送 `room.deleted`。
   */
  public async deleteRoom(
    caller: Readonly<AuthenticatedCaller>,
    roomId: RoomId,
  ): Promise<AdminDeleteRoomResponse> {
    const actor = this.extractActorMeta(caller);

    await this.adminRepo.runInTransaction(async (txRepo) => {
      const txRooms = txRepo.getRoomsRepo();
      const lockedRoom = await txRooms.lockRoomByIdForUpdate(roomId);
      if (!lockedRoom) {
        throw new AppError({
          code: "NOT_FOUND",
          statusCode: 404,
          message: `Room "${roomId}" was not found.`,
        });
      }

      await txRooms.clearPairingCodesForRoom(roomId);
      await txRooms.deleteRoomById(roomId);
      await txRepo.insertAuditLog({
        id: generateAuditLogId(),
        actorUserId: actor.actorUserId,
        actorEmail: actor.actorEmail,
        actorDisplayName: actor.actorDisplayName,
        action: "room.deleted",
        targetType: "room",
        targetId: roomId,
        summary: `管理员强制解散群聊「${lockedRoom.name}」（原消息序号 #${lockedRoom.lastSeq}）`,
        metadata: {
          roomName: lockedRoom.name,
          ownerUserId: lockedRoom.ownerUserId,
          lastSeq: lockedRoom.lastSeq,
        },
      });
    });

    await this.realtimeBus.publishToRoom(roomId, {
      type: "room.deleted",
      roomId,
    });
    this.realtimeBus.evictRoomSubscribers(roomId);

    return {
      ok: true,
      deletedRoomId: roomId,
    };
  }

  /* ─────────────────────────────────────────────────────────────
   * 5. 全局 Agent、提案、配对码与审计日志
   * ───────────────────────────────────────────────────────────── */

  /**
   * 分页查询全平台已绑定 Agent。
   */
  public async listAgents(
    caller: Readonly<AuthenticatedCaller>,
    query: Readonly<AdminAgentListQuery>,
  ): Promise<{ readonly agents: readonly AdminAgentItem[]; readonly pagination: AdminPagination }> {
    assertAdminCaller(caller);
    return this.adminRepo.listAgents(query, this.realtimeBus, Date.now());
  }

  /**
   * 管理员强制吊销并物理删除任意 Agent（事务提交后驱逐其活跃 SSE 唤醒连接）。
   */
  public async deleteAgent(
    caller: Readonly<AuthenticatedCaller>,
    agentId: AgentId,
  ): Promise<AdminDeleteAgentResponse> {
    const actor = this.extractActorMeta(caller);

    await this.adminRepo.runInTransaction(async (txRepo) => {
      const existing = await txRepo.findAgentBasicById(agentId);
      if (!existing) {
        throw new AppError({
          code: "NOT_FOUND",
          statusCode: 404,
          message: `Agent "${agentId}" was not found.`,
        });
      }

      await txRepo.deleteAgentById(agentId);
      await txRepo.insertAuditLog({
        id: generateAuditLogId(),
        actorUserId: actor.actorUserId,
        actorEmail: actor.actorEmail,
        actorDisplayName: actor.actorDisplayName,
        action: "agent.deleted",
        targetType: "agent",
        targetId: agentId,
        summary: `管理员强制吊销并删除 Agent「${existing.displayName}」`,
        metadata: {
          displayName: existing.displayName,
          ownerUserId: existing.ownerUserId,
        },
      });
    });

    this.realtimeBus.evictAgentSubscribers(agentId);

    return {
      ok: true,
      deletedAgentId: agentId,
    };
  }

  /**
   * 分页查询全平台提案与决策记录。
   */
  public async listProposals(
    caller: Readonly<AuthenticatedCaller>,
    query: Readonly<AdminProposalListQuery>,
  ): Promise<{
    readonly proposals: readonly AdminProposalItem[];
    readonly pagination: AdminPagination;
  }> {
    assertAdminCaller(caller);
    return this.adminRepo.listProposals(query);
  }

  /**
   * 管理员物理删除指定提案及其投票记录。
   */
  public async deleteProposal(
    caller: Readonly<AuthenticatedCaller>,
    proposalId: ProposalId,
  ): Promise<AdminDeleteProposalResponse> {
    const actor = this.extractActorMeta(caller);

    await this.adminRepo.runInTransaction(async (txRepo) => {
      const existing = await txRepo.findProposalBasicById(proposalId);
      if (!existing) {
        throw new AppError({
          code: "NOT_FOUND",
          statusCode: 404,
          message: `Proposal "${proposalId}" was not found.`,
        });
      }

      await txRepo.deleteProposalById(proposalId);
      await txRepo.insertAuditLog({
        id: generateAuditLogId(),
        actorUserId: actor.actorUserId,
        actorEmail: actor.actorEmail,
        actorDisplayName: actor.actorDisplayName,
        action: "proposal.deleted",
        targetType: "proposal",
        targetId: proposalId,
        summary: `管理员删除提案「${existing.title}」`,
        metadata: {
          roomId: existing.roomId,
          title: existing.title,
        },
      });
    });

    return {
      ok: true,
      deletedProposalId: proposalId,
    };
  }

  /**
   * 分页查询全平台一次性配对码列表。
   */
  public async listPairingCodes(
    caller: Readonly<AuthenticatedCaller>,
    query: Readonly<AdminPairingCodeListQuery>,
  ): Promise<{
    readonly pairingCodes: readonly AdminPairingCodeItem[];
    readonly pagination: AdminPagination;
  }> {
    assertAdminCaller(caller);
    return this.adminRepo.listPairingCodes(query, new Date());
  }

  /**
   * 管理员强制吊销并删除单个配对码。
   */
  public async revokePairingCode(
    caller: Readonly<AuthenticatedCaller>,
    code: PairingCode,
  ): Promise<AdminRevokePairingCodeResponse> {
    const actor = this.extractActorMeta(caller);

    await this.adminRepo.runInTransaction(async (txRepo) => {
      const deleted = await txRepo.deletePairingCode(code);
      if (!deleted) {
        throw new AppError({
          code: "NOT_FOUND",
          statusCode: 404,
          message: `Pairing code "${code}" was not found.`,
        });
      }

      await txRepo.insertAuditLog({
        id: generateAuditLogId(),
        actorUserId: actor.actorUserId,
        actorEmail: actor.actorEmail,
        actorDisplayName: actor.actorDisplayName,
        action: "pairing_code.revoked",
        targetType: "pairing_code",
        targetId: code,
        summary: `管理员吊销配对码 ${code}`,
      });
    });

    return {
      ok: true,
      revokedCode: code,
    };
  }

  /**
   * 管理员批量清理全部已消费或已过期配对码。
   */
  public async purgePairingCodes(
    caller: Readonly<AuthenticatedCaller>,
  ): Promise<AdminPurgePairingCodesResponse> {
    const actor = this.extractActorMeta(caller);
    const now = new Date();

    const purgedCount = await this.adminRepo.runInTransaction(async (txRepo) => {
      const count = await txRepo.purgeInactivePairingCodes(now);
      await txRepo.insertAuditLog({
        id: generateAuditLogId(),
        actorUserId: actor.actorUserId,
        actorEmail: actor.actorEmail,
        actorDisplayName: actor.actorDisplayName,
        action: "pairing_code.purged_expired",
        targetType: "system",
        targetId: "pairing_codes",
        summary: `清理全部已核销及过期配对码（共 ${count} 条）`,
        metadata: { purgedCount: count },
      });
      return count;
    });

    return {
      ok: true,
      purgedCount,
    };
  }

  /**
   * 分页查询管理员操作审计日志。
   */
  public async listAuditLogs(
    caller: Readonly<AuthenticatedCaller>,
    query: Readonly<AdminAuditLogListQuery>,
  ): Promise<{
    readonly logs: readonly AdminAuditLogItem[];
    readonly pagination: AdminPagination;
  }> {
    assertAdminCaller(caller);
    return this.adminRepo.listAuditLogs(query);
  }
}
