/**
 * @module mcp/api-bridge
 * @description OpenHuddle MCP Server 底层 HTTP 桥接与会话级乐观读游标（`lastReadSeq`）同步器。
 *
 * 关键不变量：
 * 1. 鉴权零泄露：请求统一携带 `Authorization: Bearer <agentToken>`，错误诊断文本绝不回显原始令牌。
 * 2. 会话内单调游标：按 `roomId` 单调维护 `lastReadSeq`，使 `read_room -> send_message` 默认满足服务端 `requireReadBeforeSend` 乐观锁。
 * 3. 有界请求超时：常规请求默认 15s 超时，长轮询收件箱按 `(waitSec + 10)s` 动态限时，防止半开连接永久挂死宿主工具调用。
 */
import { randomUUID } from "node:crypto";
import {
  ApiErrorEnvelopeSchema,
  type CastProposalVoteBody,
  type ClaimWorkSliceBody,
  type CompleteWorkSliceBody,
  type HeartbeatWorkSliceBody,
  InboxResponseSchema,
  type JoinRoomBody,
  type ListWorkMcpQuery,
  MeResponseSchema,
  type ProposalDraft,
  type ProposalId,
  type PutReviewEvidenceBody,
  type RaiseWorkAttentionBody,
  type ReadCursorSeq,
  type RoomId,
  type SendMessageRequest,
  UnreadConflictDetailsSchema,
  type WorkItemId,
  type WorkSliceId,
} from "@openhuddle/protocol";

/** 常规 REST API 调用默认超时时间（15 秒） */
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

/** 长轮询 `getInbox(waitSec)` 附加的网络往返缓冲窗口（10 秒） */
const INBOX_TIMEOUT_BUFFER_MS = 10_000;

/**
 * 构建 MCP API 桥接器所需的配置项。
 */
export interface McpApiBridgeOptions {
  readonly serverUrl: string;
  readonly agentToken: string;
  readonly fetchImpl?: typeof fetch;
  /** 可选默认单次请求超时毫秒数（缺省 15,000ms） */
  readonly requestTimeoutMs?: number;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function extractSafeSeq(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

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
  private readonly requestTimeoutMs: number;
  private readonly roomReadCursors = new Map<string, number>();

  /**
   * 构造桥接器实例。
   *
   * @param options - 服务端根地址、`oh_agt_` 令牌、可选超时与自定义 `fetch`
   */
  public constructor(options: Readonly<McpApiBridgeOptions>) {
    this.baseUrl = normalizeMcpServerUrl(options.serverUrl);
    this.agentToken = options.agentToken.trim();
    this.fetchFn = options.fetchImpl ?? globalThis.fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
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
    const timeoutMs = Math.max(
      this.requestTimeoutMs,
      clampedWait * 1_000 + INBOX_TIMEOUT_BUFFER_MS,
    );
    const res = await this.request(
      "GET",
      `/api/v1/inbox?waitSec=${clampedWait}`,
      undefined,
      timeoutMs,
    );
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
    if (res.ok && isRecord(res.data) && isRecord(res.data.room)) {
      const roomId = res.data.room.id;
      const readSeq = extractSafeSeq(res.data.room.yourLastReadSeq);
      if (typeof roomId === "string" && readSeq !== undefined) {
        this.advanceRoomCursor(roomId as RoomId, readSeq);
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
    if (res.ok && isRecord(res.data)) {
      const messages = Array.isArray(res.data.messages) ? res.data.messages : [];
      let maxSeenSeq: number | undefined;
      for (const item of messages) {
        const seq = isRecord(item) ? extractSafeSeq(item.seq) : undefined;
        if (seq !== undefined && (maxSeenSeq === undefined || seq > maxSeenSeq)) {
          maxSeenSeq = seq;
        }
      }
      const targetSeq = maxSeenSeq ?? extractSafeSeq(res.data.latestSeq);
      if (targetSeq !== undefined) {
        this.advanceRoomCursor(roomId, targetSeq);
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
    const effectiveLastReadSeq = requestBody.lastReadSeq ?? cachedSeq;
    const bodyWithDefaults = {
      content: requestBody.content,
      ...(requestBody.replyToSeq !== undefined ? { replyToSeq: requestBody.replyToSeq } : {}),
      mentions: requestBody.mentions,
      opKey: requestBody.opKey ?? `op_${randomUUID()}`,
      ...(effectiveLastReadSeq !== undefined ? { lastReadSeq: effectiveLastReadSeq } : {}),
      ignoreUnread: requestBody.ignoreUnread,
    };

    const res = await this.request(
      "POST",
      `/api/v1/rooms/${encodeURIComponent(roomId)}/messages`,
      bodyWithDefaults,
    );

    if (res.ok && isRecord(res.data) && isRecord(res.data.message)) {
      const seq = extractSafeSeq(res.data.message.seq);
      if (seq !== undefined) {
        this.advanceRoomCursor(roomId, seq);
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
   * 列出当前 Agent 所属主人的工作区，或指定房间内已绑定的脱敏工作区。
   */
  public async listWorkspaces(roomId?: RoomId): Promise<McpBridgeResult> {
    if (roomId !== undefined) {
      return this.request("GET", `/api/v1/rooms/${encodeURIComponent(roomId)}/workspaces`);
    }
    return this.request("GET", "/api/v1/workspaces");
  }

  /**
   * 列出可见的多 Agent 协作工单（支持 `claimableOnly` 过滤立即可认领的任务队列）。
   */
  public async listWorkItems(query?: ListWorkMcpQuery): Promise<McpBridgeResult> {
    const search = new URLSearchParams();
    if (query?.workspaceId !== undefined) {
      search.set("workspaceId", query.workspaceId);
    }
    if (query?.roomId !== undefined) {
      search.set("roomId", query.roomId);
    }
    if (query?.stage !== undefined) {
      search.set("stage", query.stage);
    }
    if (query?.claimableOnly !== undefined) {
      search.set("claimableOnly", query.claimableOnly ? "true" : "false");
    }
    const qs = search.toString();
    return this.request("GET", `/api/v1/work-items${qs.length > 0 ? `?${qs}` : ""}`);
  }

  /**
   * 认领待执行分片或接管超时租约，返回单调递增的 `leaseVersion` 防护版本号。
   */
  public async claimWorkSlice(
    workItemId: WorkItemId,
    sliceId: WorkSliceId,
    body: Readonly<ClaimWorkSliceBody>,
  ): Promise<McpBridgeResult> {
    return this.request(
      "POST",
      `/api/v1/work-items/${encodeURIComponent(workItemId)}/slices/${encodeURIComponent(sliceId)}/claim`,
      body,
    );
  }

  /**
   * 携带防护版本号续期活跃分片租约并更新进度摘要。
   */
  public async heartbeatWorkSlice(
    workItemId: WorkItemId,
    sliceId: WorkSliceId,
    body: Readonly<HeartbeatWorkSliceBody>,
  ): Promise<McpBridgeResult> {
    return this.request(
      "POST",
      `/api/v1/work-items/${encodeURIComponent(workItemId)}/slices/${encodeURIComponent(sliceId)}/heartbeat`,
      body,
    );
  }

  /**
   * 暂停当前分片并向人类主人提交单问结构化澄清请求。
   */
  public async raiseWorkAttention(
    workItemId: WorkItemId,
    sliceId: WorkSliceId,
    body: Readonly<RaiseWorkAttentionBody>,
  ): Promise<McpBridgeResult> {
    return this.request(
      "POST",
      `/api/v1/work-items/${encodeURIComponent(workItemId)}/slices/${encodeURIComponent(sliceId)}/attention`,
      body,
    );
  }

  /**
   * 提交分片交付成果或独立核验结论（自动触发蜂群合流或 `write -> verify` 接力）。
   */
  public async completeWorkSlice(
    workItemId: WorkItemId,
    sliceId: WorkSliceId,
    body: Readonly<CompleteWorkSliceBody>,
  ): Promise<McpBridgeResult> {
    return this.request(
      "POST",
      `/api/v1/work-items/${encodeURIComponent(workItemId)}/slices/${encodeURIComponent(sliceId)}/complete`,
      body,
    );
  }

  /**
   * 执行底层带鉴权与有界超时的 JSON 请求，并将业务拦截信封格式化为对 LLM 友好的多行诊断。
   */
  public async putReviewEvidence(
    workItemId: WorkItemId,
    sliceId: WorkSliceId,
    body: PutReviewEvidenceBody,
  ): Promise<McpBridgeResult> {
    return this.request(
      "PUT",
      `/api/v1/work-items/${encodeURIComponent(workItemId)}/slices/${encodeURIComponent(sliceId)}/review-evidence`,
      body,
    );
  }

  public async getReviewEvidence(
    workItemId: WorkItemId,
    sliceId: WorkSliceId,
  ): Promise<McpBridgeResult> {
    return this.request(
      "GET",
      `/api/v1/work-items/${encodeURIComponent(workItemId)}/slices/${encodeURIComponent(sliceId)}/review-evidence`,
    );
  }

  private async request(
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    pathWithQuery: string,
    body?: unknown,
    timeoutMs: number = this.requestTimeoutMs,
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
        signal: AbortSignal.timeout(timeoutMs),
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
                `Call openhuddle_read_room with afterSeq=${c.yourLastReadSeq} first to advance your cursor and review context before retrying openhuddle_send_message.`,
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
