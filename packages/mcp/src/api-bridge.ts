/**
 * @module mcp/api-bridge
 * @description OpenHuddle MCP Server 底层 HTTP 协议桥接与会话级乐观并发游标（`lastReadSeq`）同步器。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 鉴权透传与零泄露：所有请求统一携带 `Authorization: Bearer <agentToken>` 发往 `/api/v1/*`，工具输出绝不回显原始 Bearer 令牌。
 * 2. 会话内自动读锁对齐：在单次 MCP Server 实例生命周期内按 `roomId` 单调追踪 `lastReadSeq`，使 `openhuddle_read_room` -> `openhuddle_send_message` 链路默认满足服务端 `requireReadBeforeSend` 乐观锁要求。
 * 3. 结构化冲突可读性：当命中 `409 CONFLICT_UNREAD_MESSAGES` 时，使用 `@openhuddle/protocol` 的 `ApiErrorEnvelopeSchema` 与 `UnreadConflictDetailsSchema` 强校验并格式化漏读消息及其 `trustLevel`，帮助宿主大模型自主纠偏。
 */
import { randomUUID } from "node:crypto";
import {
  ApiErrorEnvelopeSchema,
  type CastProposalVoteBody,
  InboxResponseSchema,
  type JoinRoomBody,
  MeResponseSchema,
  type ProposalDraft,
  type ProposalId,
  type ReadCursorSeq,
  type RoomId,
  type SendMessageRequest,
  UnreadConflictDetailsSchema,
} from "@openhuddle/protocol";

/**
 * 构建 MCP API 桥接器所需的配置项。
 */
export interface McpApiBridgeOptions {
  readonly serverUrl: string;
  readonly agentToken: string;
  readonly fetchImpl?: typeof fetch;
}

/**
 * 单次 MCP HTTP 调用结果（可辨识联合类型）。
 */
export type McpBridgeResult<TData = unknown> =
  | {
      readonly ok: true;
      readonly data: TData;
    }
  | {
      readonly ok: false;
      readonly status: number;
      readonly formattedError: string;
      readonly rawError?: unknown;
    };

/**
 * 去除服务端地址尾部斜杠以确保路径拼接幂等。
 *
 * @param serverUrl - 原始服务端 URL
 * @returns 规范化后的基础 URL
 */
export function normalizeMcpServerUrl(serverUrl: string): string {
  return serverUrl.trim().replace(/\/+$/, "");
}

/**
 * 封装 MCP 工具集对 OpenHuddle REST API 的类型化调用与房间已读游标缓存。
 */
export class OpenHuddleMcpApiBridge {
  private readonly baseUrl: string;
  private readonly agentToken: string;
  private readonly fetchFn: typeof fetch;
  private readonly roomReadCursors = new Map<string, number>();

  /**
   * 构造桥接器实例。
   *
   * @param options - 服务端根地址、`oh_agt_` 令牌与可选自定义 `fetch`
   */
  public constructor(options: Readonly<McpApiBridgeOptions>) {
    this.baseUrl = normalizeMcpServerUrl(options.serverUrl);
    this.agentToken = options.agentToken.trim();
    this.fetchFn = options.fetchImpl ?? globalThis.fetch;
  }

  /**
   * 获取当前 MCP 会话在指定房间已记录的本地 `lastReadSeq` 游标。
   *
   * @param roomId - 房间 ID
   * @returns 已记录的最大序号或 `undefined`
   */
  public getCachedLastReadSeq(roomId: RoomId): ReadCursorSeq | undefined {
    const seq = this.roomReadCursors.get(roomId);
    return seq !== undefined ? (seq as ReadCursorSeq) : undefined;
  }

  /**
   * 单调推进指定房间的会话内 `lastReadSeq` 缓存。
   *
   * @param roomId - 房间 ID
   * @param seq - 新确认的已读序号
   */
  public advanceRoomCursor(roomId: RoomId, seq: number): void {
    if (!Number.isSafeInteger(seq) || seq < 0) {
      return;
    }
    const prev = this.roomReadCursors.get(roomId) ?? 0;
    if (seq >= prev) {
      this.roomReadCursors.set(roomId, seq);
    }
  }

  /**
   * 调用 `GET /api/v1/me` 自省当前 Agent 与人类 Owner 身份。
   *
   * @returns 结构化自省结果
   */
  public async whoami(): Promise<McpBridgeResult> {
    const res = await this.request("GET", "/api/v1/me");
    if (!res.ok) {
      return res;
    }
    const validated = MeResponseSchema.safeParse(res.data);
    return { ok: true, data: validated.success ? validated.data : res.data };
  }

  /**
   * 调用 `GET /api/v1/inbox` 拉取待处理提及、主人指令与未读统计。
   *
   * @param waitSec - 长轮询等待秒数（`0..25`）
   * @returns 收件箱响应结果
   */
  public async getInbox(waitSec = 0): Promise<McpBridgeResult> {
    const clampedWait = Math.max(0, Math.min(25, Math.trunc(waitSec)));
    const res = await this.request("GET", `/api/v1/inbox?waitSec=${clampedWait}`);
    if (!res.ok) {
      return res;
    }
    const validated = InboxResponseSchema.safeParse(res.data);
    return { ok: true, data: validated.success ? validated.data : res.data };
  }

  /**
   * 调用 `GET /api/v1/rooms` 获取已加入房间列表。
   *
   * @returns 房间列表结果
   */
  public async listRooms(): Promise<McpBridgeResult> {
    return this.request("GET", "/api/v1/rooms");
  }

  /**
   * 调用 `POST /api/v1/join` 使用邀请令牌入群，并初始化该房间游标。
   *
   * @param body - 经协议校验的入群请求体
   * @returns 入群响应结果
   */
  public async joinRoom(body: Readonly<JoinRoomBody>): Promise<McpBridgeResult> {
    const res = await this.request("POST", "/api/v1/join", body);
    if (res.ok && typeof res.data === "object" && res.data !== null) {
      const roomObj = (res.data as Record<string, unknown>).room;
      if (typeof roomObj === "object" && roomObj !== null) {
        const roomRec = roomObj as Record<string, unknown>;
        if (typeof roomRec.id === "string" && typeof roomRec.yourLastReadSeq === "number") {
          this.advanceRoomCursor(roomRec.id as RoomId, roomRec.yourLastReadSeq);
        }
      }
    }
    return res;
  }

  /**
   * 调用 `GET /api/v1/rooms/:roomId/messages` 增量拉取消息并推进会话内 `lastReadSeq`。
   *
   * @param roomId - 房间 ID
   * @param query - 可选 `afterSeq` 与 `limit`
   * @returns 房间增量消息与实时治理快照
   */
  public async readRoom(
    roomId: RoomId,
    query?: { readonly afterSeq?: number; readonly limit?: number },
  ): Promise<McpBridgeResult> {
    const search = new URLSearchParams();
    const effectiveAfter = query?.afterSeq ?? this.roomReadCursors.get(roomId);
    if (effectiveAfter !== undefined) {
      search.set("afterSeq", String(effectiveAfter));
    }
    if (query?.limit !== undefined) {
      search.set("limit", String(query.limit));
    }
    const qs = search.toString();
    const path = `/api/v1/rooms/${encodeURIComponent(roomId)}/messages${qs.length > 0 ? `?${qs}` : ""}`;

    const res = await this.request("GET", path);
    if (res.ok && typeof res.data === "object" && res.data !== null) {
      const payload = res.data as Record<string, unknown>;
      const messages = Array.isArray(payload.messages) ? payload.messages : [];
      let maxSeenSeq: number | undefined;
      for (const item of messages) {
        if (typeof item === "object" && item !== null) {
          const seq = (item as Record<string, unknown>).seq;
          if (typeof seq === "number" && (maxSeenSeq === undefined || seq > maxSeenSeq)) {
            maxSeenSeq = seq;
          }
        }
      }
      if (maxSeenSeq !== undefined) {
        this.advanceRoomCursor(roomId, maxSeenSeq);
      } else if (typeof payload.latestSeq === "number") {
        this.advanceRoomCursor(roomId, payload.latestSeq);
      }
    }
    return res;
  }

  /**
   * 调用 `POST /api/v1/rooms/:roomId/messages` 发送消息，自动注入会话缓存的 `lastReadSeq`。
   *
   * @param roomId - 房间 ID
   * @param requestBody - 经协议校验的消息发送请求体
   * @returns 发送结果或包含漏读详情的 `409` 错误结果
   */
  public async sendMessage(
    roomId: RoomId,
    requestBody: Readonly<SendMessageRequest>,
  ): Promise<McpBridgeResult> {
    const cachedSeq = this.getCachedLastReadSeq(roomId);
    const bodyWithDefaults = {
      content: requestBody.content,
      ...(requestBody.replyToSeq !== undefined ? { replyToSeq: requestBody.replyToSeq } : {}),
      mentions: requestBody.mentions,
      opKey: requestBody.opKey ?? `op_${randomUUID()}`,
      ...(requestBody.lastReadSeq !== undefined
        ? { lastReadSeq: requestBody.lastReadSeq }
        : cachedSeq !== undefined
          ? { lastReadSeq: cachedSeq }
          : {}),
      ignoreUnread: requestBody.ignoreUnread,
    };

    const res = await this.request(
      "POST",
      `/api/v1/rooms/${encodeURIComponent(roomId)}/messages`,
      bodyWithDefaults,
    );

    if (res.ok && typeof res.data === "object" && res.data !== null) {
      const msgObj = (res.data as Record<string, unknown>).message;
      if (typeof msgObj === "object" && msgObj !== null) {
        const seq = (msgObj as Record<string, unknown>).seq;
        if (typeof seq === "number") {
          this.advanceRoomCursor(roomId, seq);
        }
      }
    }

    return res;
  }

  /**
   * 调用 `POST /api/v1/rooms/:roomId/proposals` 提交结构化多方案提案卡。
   *
   * @param roomId - 房间 ID
   * @param draft - 经 `ProposalDraftSchema` 校验的提案草稿
   * @returns 创建后的提案卡片结果
   */
  public async submitProposal(
    roomId: RoomId,
    draft: Readonly<ProposalDraft>,
  ): Promise<McpBridgeResult> {
    return this.request("POST", `/api/v1/rooms/${encodeURIComponent(roomId)}/proposals`, draft);
  }

  /**
   * 调用 `POST /api/v1/proposals/:proposalId/votes` 对提案进行结构化表态投票。
   *
   * @param proposalId - 提案 ID
   * @param vote - 经 `CastProposalVoteBodySchema` 校验的投票请求体
   * @returns 更新后的提案卡片结果
   */
  public async voteProposal(
    proposalId: ProposalId,
    vote: Readonly<CastProposalVoteBody>,
  ): Promise<McpBridgeResult> {
    return this.request("POST", `/api/v1/proposals/${encodeURIComponent(proposalId)}/votes`, vote);
  }

  /**
   * 执行底层带鉴权的 JSON 请求，并将业务拦截信封格式化为对 LLM 友好的多行诊断。
   *
   * @param method - HTTP 方法
   * @param pathWithQuery - 相对 API 路径
   * @param body - 可选 JSON 请求体
   * @returns `McpBridgeResult`
   */
  private async request(
    method: "GET" | "POST" | "PATCH",
    pathWithQuery: string,
    body?: unknown,
  ): Promise<McpBridgeResult> {
    const url = `${this.baseUrl}${pathWithQuery}`;
    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: `Bearer ${this.agentToken}`,
    };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    let response: Response;
    try {
      response = await this.fetchFn(url, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        status: 0,
        formattedError: `Network error calling ${method} ${pathWithQuery}: ${detail}`,
        rawError: error,
      };
    }

    const rawText = await response.text();
    let parsed: unknown;
    try {
      parsed = rawText.length > 0 ? JSON.parse(rawText) : undefined;
    } catch {
      return {
        ok: false,
        status: response.status,
        formattedError: `Non-JSON HTTP ${response.status} response from ${method} ${pathWithQuery}: ${rawText.slice(0, 240)}`,
      };
    }

    if (!response.ok) {
      const envParsed = ApiErrorEnvelopeSchema.safeParse(parsed);
      if (envParsed.success) {
        const { code, message, requestId, details } = envParsed.data.error;
        if (code === "CONFLICT_UNREAD_MESSAGES") {
          const conflictParsed = UnreadConflictDetailsSchema.safeParse(details);
          if (conflictParsed.success) {
            const c = conflictParsed.data;
            const missedLines = c.missedMessages.map(
              (m) =>
                `  - [#${m.seq}] ${m.author.displayName} (${m.author.kind}, trustLevel=${m.author.trustLevel}): ${m.content}`,
            );
            return {
              ok: false,
              status: response.status,
              rawError: envParsed.data,
              formattedError: [
                `OpenHuddle API Error (409 ${code}) [requestId=${requestId}]: ${message}`,
                `Your cursor (${c.yourLastReadSeq}) is behind latestSeq (${c.latestSeq}). Missed messages:`,
                ...missedLines,
                "Call openhuddle_read_room first to advance your cursor and review context before retrying openhuddle_send_message.",
              ].join("\n"),
            };
          }
        }

        return {
          ok: false,
          status: response.status,
          rawError: envParsed.data,
          formattedError: `OpenHuddle API Error (${response.status} ${code}) [requestId=${requestId}]: ${message}`,
        };
      }

      return {
        ok: false,
        status: response.status,
        rawError: parsed,
        formattedError: `OpenHuddle HTTP ${response.status} error from ${method} ${pathWithQuery}.`,
      };
    }

    return {
      ok: true,
      data: parsed,
    };
  }
}
