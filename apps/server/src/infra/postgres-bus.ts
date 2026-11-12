/**
 * @module server/infra/postgres-bus
 * @description 基于 PostgreSQL 原生 `LISTEN / NOTIFY` 的跨进程实时事件总线（免 Redis 适配 2C4G 轻量部署）。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 零外部中间件开销：直接复用已有 PostgreSQL 实例完成多进程 SSE 广播，无需额外部署和维护 Redis。
 * 2. 本机微秒级直达 + 跨进程去重回环：发布事件时先向进程内 `InMemoryRealtimeBus` 即时投递，再附带 `originInstanceId` 发送 `pg_notify`；本实例收到自身回环帧时自动丢弃，严防重复下推。
 * 3. 容错降级：当底层 `LISTEN` 连接异常或尚未就绪时，本地内存通道仍保持 100% 可用并记录结构化告警日志。
 */
import { randomUUID } from "node:crypto";
import {
  type AgentId,
  AgentIdSchema,
  type RoomId,
  RoomIdSchema,
  type SseEvent,
  SseEventSchema,
} from "@openhuddle/protocol";
import type pg from "pg";
import type { Logger } from "pino";
import { z } from "zod";
import { InMemoryRealtimeBus, type RealtimeBus, type UnsubscribeFn } from "./realtime-bus.js";

/** PostgreSQL `LISTEN / NOTIFY` 统一广播通道名称 */
export const OPENHUDDLE_PG_NOTIFY_CHANNEL = "openhuddle_events";

const PgNotifyEnvelopeSchema = z.discriminatedUnion("scope", [
  z.object({
    originInstanceId: z.string(),
    scope: z.literal("room"),
    roomId: RoomIdSchema,
    event: SseEventSchema,
  }),
  z.object({
    originInstanceId: z.string(),
    scope: z.literal("agent"),
    agentId: AgentIdSchema,
    event: SseEventSchema,
  }),
]);

type PgNotifyEnvelope = z.infer<typeof PgNotifyEnvelopeSchema>;

/**
 * 构造 `PostgresListenNotifyBus` 所需的配置项。
 */
export interface PostgresBusOptions {
  readonly pool: pg.Pool;
  readonly logger: Logger;
}

/**
 * 基于 `pg.Pool` (`LISTEN openhuddle_events` + `SELECT pg_notify(...)`) 与本地内存扇出的混合实时事件总线。
 */
export class PostgresListenNotifyBus implements RealtimeBus {
  private readonly instanceId = randomUUID();
  private readonly localBus = new InMemoryRealtimeBus();
  private readonly pool: pg.Pool;
  private readonly logger: Logger;
  private listenerClient: pg.PoolClient | undefined;
  private closing = false;

  /**
   * @param options - PostgreSQL 连接池与结构化日志器
   */
  public constructor(options: Readonly<PostgresBusOptions>) {
    this.pool = options.pool;
    this.logger = options.logger.child({ component: "postgres-realtime-bus" });
  }

  /**
   * 申请独占连接并挂载 `LISTEN openhuddle_events` 监听。
   *
   * @remarks
   * 若连接中途断开且总线未处于关闭流程，自动释放坏连接以便后续重试，同时保持进程内扇出不中断。
   */
  public async start(): Promise<void> {
    if (this.listenerClient || this.closing) {
      return;
    }

    try {
      const client = await this.pool.connect();
      this.listenerClient = client;

      client.on("notification", (msg) => {
        if (msg.channel !== OPENHUDDLE_PG_NOTIFY_CHANNEL || !msg.payload) {
          return;
        }
        this.handleIncomingPayload(msg.payload);
      });

      client.on("error", (err) => {
        this.logger.error({ err }, "PostgreSQL LISTEN client encountered an error");
        this.releaseListenerClient();
      });

      await client.query(`LISTEN ${OPENHUDDLE_PG_NOTIFY_CHANNEL}`);
      this.logger.info(
        { channel: OPENHUDDLE_PG_NOTIFY_CHANNEL, instanceId: this.instanceId },
        "PostgreSQL LISTEN realtime bus initialized",
      );
    } catch (err) {
      this.logger.warn(
        { err },
        "Failed to attach PostgreSQL LISTEN client; falling back to in-memory local fanout",
      );
      this.releaseListenerClient();
    }
  }

  /** {@inheritDoc RealtimeBus.publishToRoom} */
  public async publishToRoom(roomId: RoomId, event: SseEvent): Promise<void> {
    // 先扇出至当前进程内的本地订阅者，确保同机零跳微秒级响应，随后通过 pg_notify 同步给其他实例
    await this.localBus.publishToRoom(roomId, event);
    await this.sendPgNotify({
      originInstanceId: this.instanceId,
      scope: "room",
      roomId,
      event,
    });
  }

  /** {@inheritDoc RealtimeBus.publishToAgent} */
  public async publishToAgent(agentId: AgentId, event: SseEvent): Promise<void> {
    await this.localBus.publishToAgent(agentId, event);
    await this.sendPgNotify({
      originInstanceId: this.instanceId,
      scope: "agent",
      agentId,
      event,
    });
  }

  /** {@inheritDoc RealtimeBus.subscribeRoom} */
  public subscribeRoom(roomId: RoomId, listener: (event: SseEvent) => void): UnsubscribeFn {
    return this.localBus.subscribeRoom(roomId, listener);
  }

  /** {@inheritDoc RealtimeBus.subscribeAgent} */
  public subscribeAgent(agentId: AgentId, listener: (event: SseEvent) => void): UnsubscribeFn {
    return this.localBus.subscribeAgent(agentId, listener);
  }

  /** {@inheritDoc RealtimeBus.getActiveAgentConnectionCount} */
  public getActiveAgentConnectionCount(agentId: AgentId): number {
    return this.localBus.getActiveAgentConnectionCount(agentId);
  }

  /** {@inheritDoc RealtimeBus.close} */
  public async close(): Promise<void> {
    this.closing = true;
    if (this.listenerClient) {
      try {
        await this.listenerClient.query(`UNLISTEN ${OPENHUDDLE_PG_NOTIFY_CHANNEL}`);
      } catch (err) {
        this.logger.warn({ err }, "Ignored error during PostgreSQL UNLISTEN on shutdown");
      }
      this.releaseListenerClient();
    }
    await this.localBus.close();
  }

  private async sendPgNotify(envelope: PgNotifyEnvelope): Promise<void> {
    const payload = JSON.stringify(envelope);
    // PostgreSQL NOTIFY 单帧上限为 8000 字节；超长载荷仅记录告警并依赖客户端收到轻通知后增量拉取
    if (Buffer.byteLength(payload, "utf8") >= 7_900) {
      this.logger.warn(
        { scope: envelope.scope, eventType: envelope.event.type },
        "Skipping pg_notify for oversized SSE payload (>= 7.9KB); local subscribers still notified",
      );
      return;
    }

    try {
      await this.pool.query("SELECT pg_notify($1, $2)", [OPENHUDDLE_PG_NOTIFY_CHANNEL, payload]);
    } catch (err) {
      this.logger.error({ err, scope: envelope.scope }, "Failed to emit pg_notify event");
    }
  }

  private handleIncomingPayload(rawPayload: string): void {
    try {
      const parsedJson: unknown = JSON.parse(rawPayload);
      const envelope = PgNotifyEnvelopeSchema.parse(parsedJson);

      // 关键防重不变量：忽略由当前进程自身发出的 NOTIFY 回环帧，因为 publish* 已同步投递过 localBus
      if (envelope.originInstanceId === this.instanceId) {
        return;
      }

      if (envelope.scope === "room") {
        void this.localBus.publishToRoom(envelope.roomId, envelope.event);
      } else {
        void this.localBus.publishToAgent(envelope.agentId, envelope.event);
      }
    } catch (err) {
      this.logger.warn({ err }, "Discarded malformed PostgreSQL NOTIFY event frame");
    }
  }

  private releaseListenerClient(): void {
    if (!this.listenerClient) {
      return;
    }
    const client = this.listenerClient;
    this.listenerClient = undefined;
    client.removeAllListeners();
    client.release(true);
  }
}
