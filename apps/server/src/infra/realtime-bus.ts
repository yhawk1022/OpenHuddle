/**
 * @module server/infra/realtime-bus
 * @description 实时事件发布订阅总线抽象及单机零开销内存实现（适配 2C4G 免 Redis 架构）。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 严格事务后投递（Post-Commit Only）：上游服务必须在数据库事务成功提交后才允许调用 `publish*`，绝不允许把未提交数据推送给订阅者。
 * 2. 单机零依赖、多进程平滑演进：默认采用 `InMemoryRealtimeBus`（零外部容器、微秒级延迟）；后续多进程部署实现相同接口挂载 `Postgres LISTEN/NOTIFY` 即可无缝切换。
 */
import type { AgentId, RoomId, SseEvent } from "@openhuddle/protocol";

/** 订阅取消函数签名 */
export type UnsubscribeFn = () => void;

/**
 * 跨房间广播与定向唤醒订阅的统一实时事件总线契约。
 */
export interface RealtimeBus {
  /**
   * 向订阅了指定房间的所有人类协作舱与旁听连接广播实时事件（如 `message.created`、`governance.updated`）。
   */
  publishToRoom(roomId: RoomId, event: SseEvent): Promise<void>;

  /**
   * 向指定目标 Agent 的所有活跃 SSE 守护连接定向推送事件（如轻量 `wake` 帧）。
   */
  publishToAgent(agentId: AgentId, event: SseEvent): Promise<void>;

  /**
   * 订阅某个房间的实时事件流。
   * @returns 调用后立即解除监听的清理函数
   */
  subscribeRoom(roomId: RoomId, listener: (event: SseEvent) => void): UnsubscribeFn;

  /**
   * 订阅某个 Agent 的专属唤醒事件流。
   * @returns 调用后立即解除监听的清理函数
   */
  subscribeAgent(agentId: AgentId, listener: (event: SseEvent) => void): UnsubscribeFn;

  /**
   * 获取指定 Agent 当前挂载的活跃实时 SSE 连接数量（用于实时计算 `online_sse` 在线状态灯）。
   */
  getActiveAgentConnectionCount(agentId: AgentId): number;

  /**
   * 优雅关闭总线并清空所有监听器。
   */
  close(): Promise<void>;
}

/**
 * 面向单实例与 2C4G 轻量容器部署的进程内零开销实时事件总线实现。
 */
export class InMemoryRealtimeBus implements RealtimeBus {
  private readonly roomSubscribers = new Map<RoomId, Set<(event: SseEvent) => void>>();
  private readonly agentSubscribers = new Map<AgentId, Set<(event: SseEvent) => void>>();

  /** {@inheritDoc RealtimeBus.publishToRoom} */
  public async publishToRoom(roomId: RoomId, event: SseEvent): Promise<void> {
    const listeners = this.roomSubscribers.get(roomId);
    if (!listeners) {
      return;
    }
    for (const listener of listeners) {
      listener(event);
    }
  }

  /** {@inheritDoc RealtimeBus.publishToAgent} */
  public async publishToAgent(agentId: AgentId, event: SseEvent): Promise<void> {
    const listeners = this.agentSubscribers.get(agentId);
    if (!listeners) {
      return;
    }
    for (const listener of listeners) {
      listener(event);
    }
  }

  /** {@inheritDoc RealtimeBus.subscribeRoom} */
  public subscribeRoom(roomId: RoomId, listener: (event: SseEvent) => void): UnsubscribeFn {
    let set = this.roomSubscribers.get(roomId);
    if (!set) {
      set = new Set();
      this.roomSubscribers.set(roomId, set);
    }
    set.add(listener);

    return () => {
      const current = this.roomSubscribers.get(roomId);
      if (!current) {
        return;
      }
      current.delete(listener);
      if (current.size === 0) {
        this.roomSubscribers.delete(roomId);
      }
    };
  }

  /** {@inheritDoc RealtimeBus.subscribeAgent} */
  public subscribeAgent(agentId: AgentId, listener: (event: SseEvent) => void): UnsubscribeFn {
    let set = this.agentSubscribers.get(agentId);
    if (!set) {
      set = new Set();
      this.agentSubscribers.set(agentId, set);
    }
    set.add(listener);

    return () => {
      const current = this.agentSubscribers.get(agentId);
      if (!current) {
        return;
      }
      current.delete(listener);
      if (current.size === 0) {
        this.agentSubscribers.delete(agentId);
      }
    };
  }

  /** {@inheritDoc RealtimeBus.getActiveAgentConnectionCount} */
  public getActiveAgentConnectionCount(agentId: AgentId): number {
    return this.agentSubscribers.get(agentId)?.size ?? 0;
  }

  /** {@inheritDoc RealtimeBus.close} */
  public async close(): Promise<void> {
    this.roomSubscribers.clear();
    this.agentSubscribers.clear();
  }
}
