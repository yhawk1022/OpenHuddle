/**
 * @module server/infra/identity-stamp
 * @description 成员确定性键映射、Agent 实时可达状态计算与多订阅者视角动态重盖章辅助工具。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. Owner-First 动态视角隔离：广播到房间的 `message.created` 与 `proposal.updated` 事件在推送给每个 SSE 连接前，必须针对该连接的真实 `viewer` 重新执行 `computeAuthorStamp`，绝不允许把甲主人的 `owner_command` 印章原样泄露给乙主人的 Agent。
 * 2. 公开分享零信任视角：匿名公开分享快照统一使用与任何真实用户都不重合的中立只读观察者计算印章，确保 `isYou: false`、`isYourOwner: false`、`trustLevel: "external_participant"`。
 */
import {
  type AgentId,
  type AgentReachState,
  type AuthenticatedCaller,
  type AuthorStamp,
  type RawAuthorIdentity,
  type SseEvent,
  type UserId,
  computeAuthorStamp,
} from "@openhuddle/protocol";
import type { RealtimeBus } from "./realtime-bus.js";

/**
 * 供匿名公开只读分享页使用的零信任中立观察者身份（前缀 `__` 确保永远不可能与真实 `usr_` 主键碰撞）。
 */
export const PUBLIC_NEUTRAL_VIEWER: AuthenticatedCaller = Object.freeze({
  kind: "human",
  userId: "__public_readonly_viewer__" as UserId,
  displayName: "Public Viewer",
});

/**
 * 计算 Agent 实时可达状态所需的最小字段投影。
 */
export interface AgentReachSnapshotInput {
  readonly id: AgentId;
  readonly platform: string;
  readonly wakeKind: string;
  readonly checkinIntervalMin: number | null;
  readonly lastSeenAt: Date | null;
}

/**
 * 根据调用者身份生成 `room_members` 与 `proposal_votes` 表使用的确定性组合键。
 *
 * @param caller - 已认证的人类或 Agent 调用者
 * @returns 形如 `human:usr_...` 或 `agent:agt_...` 的唯一成员键
 */
export function toActorMemberKey(caller: Readonly<AuthenticatedCaller>): string {
  return caller.kind === "human" ? `human:${caller.userId}` : `agent:${caller.agentId}`;
}

/**
 * 结合实时事件总线连接计数与最近心跳时间，计算指定 Agent 的透明可达状态（`reach`）。
 *
 * @param agent - 数据库中的 Agent 元数据快照
 * @param realtimeBus - 当前实例实时事件总线（查询活跃 SSE 连接数）
 * @param nowMs - 当前毫秒时间戳（默认 `Date.now()`）
 * @returns 协议层标准的 `AgentReachState`
 */
export function computeAgentReachState(
  agent: Readonly<AgentReachSnapshotInput>,
  realtimeBus: RealtimeBus,
  nowMs: number = Date.now(),
): AgentReachState {
  if (realtimeBus.getActiveAgentConnectionCount(agent.id) > 0) {
    return "online_sse";
  }
  if (agent.platform === "hosted" || agent.wakeKind === "hosted") {
    return "hosted_ready";
  }
  if (agent.wakeKind === "webhook") {
    return "webhook";
  }
  if (agent.checkinIntervalMin !== null) {
    return "polling";
  }
  if (agent.lastSeenAt !== null && nowMs - agent.lastSeenAt.getTime() <= 5 * 60_000) {
    return "polling";
  }
  return "offline";
}

function toRawAuthorIdentity(stamp: Readonly<AuthorStamp>): RawAuthorIdentity {
  return {
    kind: stamp.kind,
    ...(stamp.userId !== undefined ? { userId: stamp.userId } : {}),
    ...(stamp.agentId !== undefined ? { agentId: stamp.agentId } : {}),
    ownerUserId: stamp.ownerUserId,
    displayName: stamp.displayName,
    ...(stamp.platform !== undefined ? { platform: stamp.platform } : {}),
  };
}

/**
 * 将房间广播的 `SseEvent` 按指定 SSE 订阅者（`viewer`）视角重新计算所有 `AuthorStamp` 信任印章。
 *
 * @remarks
 * 安全防御点：房间总线在事务提交后只广播一次事件，但订阅同一房间的有 Owner A、Agent A1、Agent B1 等异构主体。
 * 在向每条独立 SSE 连接写入帧前重算印章，可确保 Agent B1 收到的 Owner A 消息永远是 `external_participant`，杜绝跨主人提权。
 *
 * @param event - 原始广播的 `SseEvent`
 * @param viewer - 当前 SSE 连接对应的已验证身份
 * @returns 重盖章后的专属 `SseEvent`
 */
export function reStampSseEventForViewer(
  event: SseEvent,
  viewer: Readonly<AuthenticatedCaller>,
): SseEvent {
  if (event.type === "message.created") {
    return {
      type: "message.created",
      roomId: event.roomId,
      message: {
        ...event.message,
        author: computeAuthorStamp(toRawAuthorIdentity(event.message.author), viewer),
      },
    };
  }

  if (event.type === "proposal.updated") {
    return {
      type: "proposal.updated",
      roomId: event.roomId,
      proposal: {
        ...event.proposal,
        votes: event.proposal.votes.map((vote) => ({
          ...vote,
          voter: computeAuthorStamp(toRawAuthorIdentity(vote.voter), viewer),
        })),
        ...(event.proposal.decidedBy !== undefined
          ? { decidedBy: computeAuthorStamp(toRawAuthorIdentity(event.proposal.decidedBy), viewer) }
          : {}),
      },
    };
  }

  return event;
}
