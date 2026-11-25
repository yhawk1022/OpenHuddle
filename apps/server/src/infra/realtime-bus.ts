/**
 * @module server/infra/realtime-bus
 * @description 实时事件发布订阅总线抽象及单机零开销内存实现（适配 2C4G 免 Redis 架构）。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 严格事务后投递（Post-Commit Only）：上游服务必须在数据库事务成功提交后才允许调用 `publish*`，绝不允许把未提交数据推送给订阅者。
 * 2. 单机零依赖、多进程平滑演进：默认采用 `InMemoryRealtimeBus`（零外部容器、微秒级延迟）；后续多进程部署实现相同接口挂载 `Postgres LISTEN/NOTIFY` 即可无缝切换。
 */
import type { AgentId, RoomId, SseEvent, UserId } from "@openhuddle/protocol";

/** 订阅取消函数签名 */
export type UnsubscribeFn = () => void;

/** Agent 唤醒订阅分为持久 SSE 和一次性收件箱等待，只有 SSE 计作实时在线。 */
export interface AgentEventSubscriptionOptions {
  readonly transport?: "sse" | "inbox" | "work_sse";
  readonly onEvict?: () => void;
}

/**
 * 实时事件总线进程内连接遥测快照。
 */
export interface RealtimeBusTelemetry {
  readonly activeAgentConnections: number;
  readonly activeAgentCount: number;
  readonly activeRoomSubscriptions: number;
  readonly activeRoomCount: number;
}

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
   * 向指定人类用户的所有活跃 Web SSE 连接定向推送事件（如 `room.upserted` 新私聊/新入群通知、`friendship.updated` 好友动态）。
   */
  publishToUser(userId: UserId, event: SseEvent): Promise<void>;

  /**
   * 订阅某个房间的实时事件流。
   * @returns 调用后立即解除监听的清理函数
   */
  subscribeRoom(roomId: RoomId, listener: (event: SseEvent) => void): UnsubscribeFn;

  /**
   * 订阅某个 Agent 的专属唤醒事件流。
   * @param options - 连接方式及凭据失效时的清理回调
   * @returns 调用后立即解除监听的清理函数
   */
  subscribeAgent(
    agentId: AgentId,
    listener: (event: SseEvent) => void,
    options?: Readonly<AgentEventSubscriptionOptions>,
  ): UnsubscribeFn;

  /**
   * 订阅某个人类用户的专属事件流（接收跨人新建单聊、拉群与好友通知）。
   * @returns 调用后立即解除监听的清理函数
   */
  subscribeUser(userId: UserId, listener: (event: SseEvent) => void): UnsubscribeFn;

  /**
   * 获取指定 Agent 当前挂载的活跃实时 SSE 连接数量（用于实时计算 `online_sse` 在线状态灯）。
   */
  getActiveAgentConnectionCount(agentId: AgentId): number;
  /** Undefined when connections on other server instances cannot be observed. */
  hasWorkspaceListener(agentId: AgentId): boolean | undefined;

  /**
   * 当某个 Agent 被删除或轮换凭据时，断开当前实例中该 Agent 的事件连接。
   */
  evictAgentSubscribers(agentId: AgentId): void;

  /**
   * 当某个人类账号被封禁或删除时，立即驱逐该用户名下挂载的内存订阅器。
   */
  evictUserSubscribers(userId: UserId): void;

  /**
   * 当某个群聊房间被群主彻底删除时，在投递 `room.deleted` 广播后立即清理该房间残留的监听器集合，防止内存泄漏。
   */
  evictRoomSubscribers(roomId: RoomId): void;

  /**
   * 获取当前实例内存中的实时事件订阅连接遥测快照（用于运营管理大盘监控）。
   */
  getTelemetry(): RealtimeBusTelemetry;

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
  private readonly agentSubscribers = new Map<
    AgentId,
    Map<(event: SseEvent) => void, Readonly<AgentEventSubscriptionOptions>>
  >();
  private readonly userSubscribers = new Map<UserId, Set<(event: SseEvent) => void>>();

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
    for (const listener of listeners.keys()) {
      listener(event);
    }
  }

  /** {@inheritDoc RealtimeBus.publishToUser} */
  public async publishToUser(userId: UserId, event: SseEvent): Promise<void> {
    const listeners = this.userSubscribers.get(userId);
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
  public subscribeAgent(
    agentId: AgentId,
    listener: (event: SseEvent) => void,
    options: Readonly<AgentEventSubscriptionOptions> = {},
  ): UnsubscribeFn {
    let listeners = this.agentSubscribers.get(agentId);
    if (!listeners) {
      listeners = new Map();
      this.agentSubscribers.set(agentId, listeners);
    }
    listeners.set(listener, options);

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

  /** {@inheritDoc RealtimeBus.subscribeUser} */
  public subscribeUser(userId: UserId, listener: (event: SseEvent) => void): UnsubscribeFn {
    let set = this.userSubscribers.get(userId);
    if (!set) {
      set = new Set();
      this.userSubscribers.set(userId, set);
    }
    set.add(listener);

    return () => {
      const current = this.userSubscribers.get(userId);
      if (!current) {
        return;
      }
      current.delete(listener);
      if (current.size === 0) {
        this.userSubscribers.delete(userId);
      }
    };
  }

  /** {@inheritDoc RealtimeBus.getActiveAgentConnectionCount} */
  public getActiveAgentConnectionCount(agentId: AgentId): number {
    let connections = 0;
    for (const subscription of this.agentSubscribers.get(agentId)?.values() ?? []) {
      if (subscription.transport !== "inbox") connections += 1;
    }
    return connections;
  }

  public hasWorkspaceListener(agentId: AgentId): boolean {
    for (const subscription of this.agentSubscribers.get(agentId)?.values() ?? []) {
      if (subscription.transport === "work_sse") return true;
    }
    return false;
  }

  /** {@inheritDoc RealtimeBus.evictAgentSubscribers} */
  public evictAgentSubscribers(agentId: AgentId): void {
    const listeners = this.agentSubscribers.get(agentId);
    this.agentSubscribers.delete(agentId);
    for (const subscription of listeners?.values() ?? []) {
      subscription.onEvict?.();
    }
  }

  /** {@inheritDoc RealtimeBus.evictUserSubscribers} */
  public evictUserSubscribers(userId: UserId): void {
    this.userSubscribers.delete(userId);
  }

  /** {@inheritDoc RealtimeBus.evictRoomSubscribers} */
  public evictRoomSubscribers(roomId: RoomId): void {
    this.roomSubscribers.delete(roomId);
  }

  /** {@inheritDoc RealtimeBus.getTelemetry} */
  public getTelemetry(): RealtimeBusTelemetry {
    let activeAgentConnections = 0;
    let activeAgentCount = 0;
    for (const agentId of this.agentSubscribers.keys()) {
      const count = this.getActiveAgentConnectionCount(agentId);
      activeAgentConnections += count;
      if (count > 0) activeAgentCount += 1;
    }
    let activeRoomSubscriptions = 0;
    for (const listeners of this.roomSubscribers.values()) {
      activeRoomSubscriptions += listeners.size;
    }
    return {
      activeAgentConnections,
      activeAgentCount,
      activeRoomSubscriptions,
      activeRoomCount: this.roomSubscribers.size,
    };
  }

  /** {@inheritDoc RealtimeBus.close} */
  public async close(): Promise<void> {
    this.roomSubscribers.clear();
    this.agentSubscribers.clear();
    this.userSubscribers.clear();
  }
}
