/**
 * @module web/lib/query-keys
 * @description 全局标准化 TanStack Query 缓存键工厂与复合缓存载荷结构定义。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 单一键空间定义：SSE 实时增量引擎（`sse-sync.ts`）与各业务域 `queryOptions` 必须共享本模块的键构造函数，严禁手写散落的字符串数组导致失效脱靶。
 * 2. 乐观状态共栖：房间消息流缓存同时承载服务端已提交的权威 `MessageDto` 与客户端乐观发送中标记（`_optimistic`），通过 `opKey` 与 `seq` 幂等对齐。
 */
import type { MessageDto, OperationKey, RoomGovernanceState, RoomId } from "@openhuddle/protocol";

/**
 * 客户端消息列表中的单条消息视图项（兼容乐观发送态）。
 */
export interface OptimisticMessageItem extends MessageDto {
  /** 客户端幂等追踪键，用于服务端响应或 SSE 回推时原地替换乐观气泡 */
  readonly _opKey?: OperationKey | undefined;
  /** 是否处于尚未收到服务端 `seq` 确认的乐观挂起态 */
  readonly _optimisticPending?: boolean | undefined;
}

/**
 * `["rooms", roomId, "messages"]` 缓存在 `QueryClient` 中的标准数据结构。
 */
export interface RoomMessagesCacheData {
  readonly ok: true;
  readonly messages: ReadonlyArray<OptimisticMessageItem>;
  readonly latestSeq: number;
  readonly governance: RoomGovernanceState;
}

/**
 * 全局标准化 `QueryKey` 工厂集合。
 */
export const huddleQueryKeys = {
  /** 系统健康探针缓存键 */
  health: () => ["system", "health"] as const,
  /** 当前认证人类身份与名下 Agent 列表缓存键 */
  me: () => ["me"] as const,
  /** 本机已安装的预设 Agent CLI 可用性探测缓存键 */
  localAgentsStatus: () => ["localAgents", "status"] as const,
  /** 当前用户已加入的所有 Huddle 房间概览列表缓存键 */
  rooms: () => ["rooms"] as const,
  /** 指定房间详情（含成员可达性列表与邀请令牌）缓存键 */
  roomDetail: (roomId: RoomId) => ["rooms", roomId] as const,
  /** 指定房间消息时间线与实时治理快照缓存键 */
  roomMessages: (roomId: RoomId) => ["rooms", roomId, "messages"] as const,
  /** 指定房间结构化提案与决策卡片列表缓存键 */
  roomProposals: (roomId: RoomId) => ["rooms", roomId, "proposals"] as const,
  /** 公开只读分享回放页缓存键 */
  publicShare: (inviteToken: string) => ["share", inviteToken] as const,
} as const;
