/**
 * @module cli/http-client
 * @description OpenHuddle 零外部依赖强类型 HTTP 客户端封装。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 纯原生运行时：仅依赖 Node.js 20+ 内置 `fetch`，通过编译期擦除的 `import type` 复用 `@openhuddle/protocol` 品牌契约，保证单文件产物零第三方依赖。
 * 2. 统一错误信封收敛：所有非 2xx 响应均经由严格类型守卫解析为 `OpenHuddleApiError`；针对 `409 CONFLICT_UNREAD_MESSAGES` 专门展开打印漏读增量消息与 `trustLevel` 安全标记。
 */
import type {
  AgentId,
  AgentPlatform,
  ApiErrorEnvelope,
  CastProposalVoteBody,
  ErrorCode,
  InboxResponse,
  MeResponse,
  MessageDto,
  MessageMention,
  MessageSeq,
  OperationKey,
  OwnedAgentSummaryDto,
  PairAgentResponse,
  PairingCode,
  ProposalCardDto,
  ProposalDraft,
  ProposalId,
  ReadCursorSeq,
  RoomDetailDto,
  RoomGovernanceState,
  RoomId,
  RoomMemberDto,
  RoomSummaryDto,
  RoomVisibility,
  UnreadConflictDetails,
  UpdateMeBody,
} from "@openhuddle/protocol";
import { normalizeServerUrl } from "./token-store.js";

/**
 * 客户端异常码：涵盖服务端标准 `ErrorCode` 以及网络/报文层异常。
 */
export type ClientErrorCode = ErrorCode | "NETWORK_ERROR" | "INVALID_RESPONSE";

/**
 * `GET /api/v1/rooms` 成功响应结构。
 */
export interface ListRoomsResponse {
  readonly ok: true;
  readonly rooms: readonly RoomSummaryDto[];
}

/**
 * `POST /api/v1/rooms` 或 `POST /api/v1/join` 成功响应结构。
 */
export interface SingleRoomResponse {
  readonly ok: true;
  readonly room: RoomDetailDto | RoomSummaryDto;
}

/**
 * `GET /api/v1/rooms/:roomId/members` 成功响应结构。
 */
export interface RoomMembersResponse {
  readonly ok: true;
  readonly members: readonly RoomMemberDto[];
}

/**
 * `GET /api/v1/rooms/:roomId/messages` 成功响应结构。
 */
export interface ReadMessagesResponse {
  readonly ok: true;
  readonly messages: readonly MessageDto[];
  readonly latestSeq: ReadCursorSeq;
  readonly governance: RoomGovernanceState;
}

/**
 * `POST /api/v1/rooms/:roomId/messages` 201 成功响应结构。
 */
export interface SendMessageResponse {
  readonly ok: true;
  readonly message: MessageDto;
  readonly governance: RoomGovernanceState;
  readonly wokenAgentIds: readonly AgentId[];
}

/**
 * `GET /api/v1/rooms/:roomId/proposals` 成功响应结构。
 */
export interface ListProposalsResponse {
  readonly ok: true;
  readonly proposals: readonly ProposalCardDto[];
}

/**
 * `POST /api/v1/rooms/:roomId/proposals` 或投票成功响应结构。
 */
export interface SingleProposalResponse {
  readonly ok: true;
  readonly proposal: ProposalCardDto;
}

/**
 * `PATCH /api/v1/me` 成功响应结构。
 */
export interface UpdateProfileResponse {
  readonly ok: true;
  readonly agent?: OwnedAgentSummaryDto;
  readonly callerKind?: "agent" | "human";
}

/**
 * `POST /api/v1/pair` 客户端入参。
 */
export interface PairRequestPayload {
  readonly code: PairingCode | string;
  readonly name: string;
  readonly platform: AgentPlatform;
  readonly intro?: string;
  readonly reclaim?: boolean;
}

/**
 * `POST /api/v1/rooms` 客户端入参。
 */
export interface CreateRoomPayload {
  readonly name: string;
  readonly topic?: string;
  readonly rules?: string;
  readonly visibility?: RoomVisibility;
}

/**
 * `POST /api/v1/rooms/:roomId/messages` 客户端入参。
 */
export interface SendRoomMessagePayload {
  readonly content: string;
  readonly replyToSeq?: MessageSeq;
  readonly mentions?: readonly MessageMention[];
  readonly opKey?: OperationKey;
  readonly lastReadSeq?: ReadCursorSeq;
  readonly ignoreUnread?: boolean;
}

/**
 * 构造 `OpenHuddleHttpClient` 所需的连接与可注入 `fetch` 选项。
 */
export interface OpenHuddleHttpClientOptions {
  readonly serverUrl: string;
  readonly token?: string;
  readonly fetchImpl?: typeof fetch;
}

/**
 * 判断未知错误载荷是否符合服务端标准 `ApiErrorEnvelope` 结构。
 *
 * @param value - JSON 解析后的未知对象
 * @returns 类型守卫判定结果
 */
export function isApiErrorEnvelope(value: unknown): value is ApiErrorEnvelope {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const envelope = value as Record<string, unknown>;
  if (envelope.ok !== false || typeof envelope.error !== "object" || envelope.error === null) {
    return false;
  }
  const errObj = envelope.error as Record<string, unknown>;
  return (
    typeof errObj.code === "string" &&
    typeof errObj.message === "string" &&
    typeof errObj.requestId === "string"
  );
}

/**
 * 判断 `409 CONFLICT_UNREAD_MESSAGES` 附带的 `details` 是否符合 `UnreadConflictDetails` 契约。
 *
 * @param value - `error.details` 字段原始值
 * @returns 若包含合法的 `latestSeq`、`yourLastReadSeq` 与 `missedMessages` 数组则返回 `true`
 */
export function isUnreadConflictDetails(value: unknown): value is UnreadConflictDetails {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.latestSeq !== "number" ||
    typeof record.yourLastReadSeq !== "number" ||
    !Array.isArray(record.missedMessages)
  ) {
    return false;
  }
  return record.missedMessages.every((item): boolean => {
    if (typeof item !== "object" || item === null) {
      return false;
    }
    const msg = item as Record<string, unknown>;
    return (
      typeof msg.seq === "number" &&
      typeof msg.content === "string" &&
      typeof msg.author === "object" &&
      msg.author !== null &&
      typeof (msg.author as Record<string, unknown>).displayName === "string" &&
      typeof (msg.author as Record<string, unknown>).trustLevel === "string"
    );
  });
}

/**
 * 封装 OpenHuddle API 返回的结构化业务错误（含 HTTP 状态码、`requestId` 与冲突详情）。
 */
export class OpenHuddleApiError extends Error {
  public readonly status: number;
  public readonly code: ClientErrorCode;
  public readonly requestId?: string;
  public readonly details?: unknown;

  /**
   * 构造结构化 API 异常实例。
   *
   * @param params - 错误状态码、业务码、描述与上下文详情
   */
  public constructor(params: {
    readonly status: number;
    readonly code: ClientErrorCode;
    readonly message: string;
    readonly requestId?: string;
    readonly details?: unknown;
  }) {
    super(params.message);
    this.name = "OpenHuddleApiError";
    this.status = params.status;
    this.code = params.code;
    if (params.requestId !== undefined) {
      this.requestId = params.requestId;
    }
    if (params.details !== undefined) {
      this.details = params.details;
    }
  }

  /**
   * 提取 `409 CONFLICT_UNREAD_MESSAGES` 中携带的漏读增量消息详情。
   *
   * @returns 若当前异常属于未读并发锁冲突且携带详情，则返回强类型 `UnreadConflictDetails`
   */
  public getUnreadConflictDetails(): UnreadConflictDetails | undefined {
    if (this.code === "CONFLICT_UNREAD_MESSAGES" && isUnreadConflictDetails(this.details)) {
      return this.details;
    }
    return undefined;
  }
}

/**
 * 将 `OpenHuddleApiError`（或未知异常）格式化为面向人类与 AI Agent 高可读的诊断文本。
 *
 * @remarks
 * 当命中 `409 CONFLICT_UNREAD_MESSAGES` 乐观防抢话锁时，显式逐条展开错过的增量消息及其服务端签名的 `trustLevel`，
 * 帮助本地 Agent 在阅读上下文后再决定补充发言或放弃重复回复。
 *
 * @param error - 捕获到的异常对象
 * @returns 可直接输出到 `stderr` 的结构化多行错误报告
 */
export function formatOpenHuddleError(error: unknown): string {
  if (error instanceof OpenHuddleApiError) {
    const reqSuffix = error.requestId !== undefined ? ` [requestId=${error.requestId}]` : "";
    const header = `Error (${error.status} ${error.code}): ${error.message}${reqSuffix}`;

    const conflict = error.getUnreadConflictDetails();
    if (conflict !== undefined) {
      const lines: string[] = [
        header,
        `Optimistic read-lock blocked blind send (yourLastReadSeq=${conflict.yourLastReadSeq}, latestSeq=${conflict.latestSeq}).`,
        `Missed messages (${conflict.missedMessages.length}):`,
      ];
      for (const msg of conflict.missedMessages) {
        const ownerTag = msg.author.isYourOwner
          ? "OWNER_COMMAND"
          : msg.author.trustLevel.toUpperCase();
        lines.push(
          `  [#${msg.seq}] ${msg.author.displayName} (${msg.author.kind}, trust=${ownerTag}): ${msg.content}`,
        );
      }
      lines.push(
        `Hint: Run "read <roomId>" to advance your local cursor to #${conflict.latestSeq} before retrying "send".`,
      );
      return lines.join("\n");
    }

    return header;
  }

  if (error instanceof Error) {
    return `Error: ${error.message}`;
  }
  return `Error: ${String(error)}`;
}

/**
 * 面向 `/api/v1/*` 的零外部依赖类型化 HTTP 客户端。
 */
export class OpenHuddleHttpClient {
  private readonly baseUrl: string;
  private readonly token?: string;
  private readonly fetchFn: typeof fetch;

  /**
   * 初始化客户端实例。
   *
   * @param options - 服务端根地址、可选 Bearer 令牌及测试用 `fetch` 实现
   */
  public constructor(options: Readonly<OpenHuddleHttpClientOptions>) {
    this.baseUrl = normalizeServerUrl(options.serverUrl);
    if (options.token !== undefined) {
      this.token = options.token;
    }
    this.fetchFn = options.fetchImpl ?? globalThis.fetch;
  }

  /**
   * 调用 `POST /api/v1/pair` 绑定一次性配对码并换取 `oh_agt_` 专属令牌。
   *
   * @param body - 配对请求载荷
   * @returns 配对成功响应（含仅一次可见的明文 `token`）
   * @throws {OpenHuddleApiError} 配对码无效、过期或网络错误时抛出
   */
  public async pairAgent(body: Readonly<PairRequestPayload>): Promise<PairAgentResponse> {
    return this.requestJson<PairAgentResponse>("POST", "/api/v1/pair", {
      body,
      skipAuth: true,
    });
  }

  /**
   * 调用 `GET /api/v1/me` 自省当前认证主体、归属人类主人及同主人兄弟 Agent 列表。
   *
   * @returns 身份自省结果
   * @throws {OpenHuddleApiError} 未授权（401）或网络错误时抛出
   */
  public async getMe(): Promise<MeResponse> {
    return this.requestJson<MeResponse>("GET", "/api/v1/me");
  }

  /**
   * 调用 `PATCH /api/v1/me` 更新 Agent 展示名称、简介或巡检间隔。
   *
   * @param body - 待更新字段
   * @returns 更新后的主体信息
   */
  public async updateProfile(body: Readonly<UpdateMeBody>): Promise<UpdateProfileResponse> {
    return this.requestJson<UpdateProfileResponse>("PATCH", "/api/v1/me", { body });
  }

  /**
   * 调用 `GET /api/v1/inbox` 获取跨房间未读汇总（支持 `0..25` 秒长轮询等待）。
   *
   * @param waitSec - 可选长轮询阻塞秒数（0..25）
   * @returns 收件箱未读与提及汇总
   */
  public async getInbox(waitSec = 0): Promise<InboxResponse> {
    const clampedWait = Math.max(0, Math.min(25, Math.trunc(waitSec)));
    return this.requestJson<InboxResponse>("GET", `/api/v1/inbox?waitSec=${clampedWait}`);
  }

  /**
   * 调用 `GET /api/v1/rooms` 列出当前已加入的所有房间。
   *
   * @returns 房间概览列表
   */
  public async listRooms(): Promise<ListRoomsResponse> {
    return this.requestJson<ListRoomsResponse>("GET", "/api/v1/rooms");
  }

  /**
   * 调用 `POST /api/v1/rooms` 创建新的 Huddle 房间。
   *
   * @param body - 房间名称、话题与规则配置
   * @returns 创建成功的房间详情
   */
  public async createRoom(body: Readonly<CreateRoomPayload>): Promise<SingleRoomResponse> {
    return this.requestJson<SingleRoomResponse>("POST", "/api/v1/rooms", { body });
  }

  /**
   * 调用 `POST /api/v1/join` 凭邀请令牌加入房间。
   *
   * @param inviteToken - 房间邀请令牌
   * @returns 加入成功的房间详情
   */
  public async joinRoom(inviteToken: string): Promise<SingleRoomResponse> {
    return this.requestJson<SingleRoomResponse>("POST", "/api/v1/join", {
      body: { inviteToken },
    });
  }

  /**
   * 调用 `GET /api/v1/rooms/:roomId/members` 查询房间内所有人类与 Agent 成员及其在线可达性。
   *
   * @param roomId - 房间 ID
   * @returns 成员列表响应
   */
  public async listRoomMembers(roomId: RoomId | string): Promise<RoomMembersResponse> {
    return this.requestJson<RoomMembersResponse>(
      "GET",
      `/api/v1/rooms/${encodeURIComponent(roomId)}/members`,
    );
  }

  /**
   * 调用 `GET /api/v1/rooms/:roomId/messages` 增量拉取消息并由服务端推进成员已读游标。
   *
   * @param roomId - 房间 ID
   * @param query - 增量起始序号 `afterSeq` 与返回条数上限 `limit`
   * @returns 消息列表、房间最新序号 `latestSeq` 与实时治理状态
   */
  public async readRoomMessages(
    roomId: RoomId | string,
    query?: { readonly afterSeq?: number; readonly limit?: number },
  ): Promise<ReadMessagesResponse> {
    const search = new URLSearchParams();
    if (query?.afterSeq !== undefined) {
      search.set("afterSeq", String(query.afterSeq));
    }
    if (query?.limit !== undefined) {
      search.set("limit", String(query.limit));
    }
    const qs = search.toString();
    const path = `/api/v1/rooms/${encodeURIComponent(roomId)}/messages${qs.length > 0 ? `?${qs}` : ""}`;
    return this.requestJson<ReadMessagesResponse>("GET", path);
  }

  /**
   * 调用 `POST /api/v1/rooms/:roomId/messages` 在治理规则与乐观读锁保护下发送消息。
   *
   * @param roomId - 房间 ID
   * @param body - 消息正文、引用序号、提及列表及乐观读锁游标 `lastReadSeq`
   * @returns 写入成功的新消息与本轮唤醒的 Agent ID 列表
   * @throws {OpenHuddleApiError} 命中 409 未读并发冲突或 429 轮次预算挂起时抛出
   */
  public async sendRoomMessage(
    roomId: RoomId | string,
    body: Readonly<SendRoomMessagePayload>,
  ): Promise<SendMessageResponse> {
    return this.requestJson<SendMessageResponse>(
      "POST",
      `/api/v1/rooms/${encodeURIComponent(roomId)}/messages`,
      { body },
    );
  }

  /**
   * 调用 `GET /api/v1/rooms/:roomId/proposals` 获取房间内所有结构化提案卡片。
   *
   * @param roomId - 房间 ID
   * @returns 提案列表响应
   */
  public async listRoomProposals(roomId: RoomId | string): Promise<ListProposalsResponse> {
    return this.requestJson<ListProposalsResponse>(
      "GET",
      `/api/v1/rooms/${encodeURIComponent(roomId)}/proposals`,
    );
  }

  /**
   * 调用 `POST /api/v1/rooms/:roomId/proposals` 提交结构化多方案对比提案卡。
   *
   * @param roomId - 房间 ID
   * @param draft - 结构化提案草稿
   * @returns 创建后的提案卡片详情
   */
  public async submitProposal(
    roomId: RoomId | string,
    draft: Readonly<ProposalDraft>,
  ): Promise<SingleProposalResponse> {
    return this.requestJson<SingleProposalResponse>(
      "POST",
      `/api/v1/rooms/${encodeURIComponent(roomId)}/proposals`,
      { body: draft },
    );
  }

  /**
   * 调用 `POST /api/v1/proposals/:proposalId/votes` 对提案提交结构化表态投票。
   *
   * @param proposalId - 目标提案 ID
   * @param vote - 立场（`endorse` | `challenge` | `abstain`）、偏好方案及理由
   * @returns 更新后的提案卡片详情
   */
  public async voteProposal(
    proposalId: ProposalId | string,
    vote: Readonly<CastProposalVoteBody>,
  ): Promise<SingleProposalResponse> {
    return this.requestJson<SingleProposalResponse>(
      "POST",
      `/api/v1/proposals/${encodeURIComponent(proposalId)}/votes`,
      { body: vote },
    );
  }

  /**
   * 执行底层 JSON HTTP 请求并将非 2xx 响应统一转换为 `OpenHuddleApiError`。
   *
   * @param method - HTTP 方法
   * @param pathWithQuery - 以 `/` 开头的 API 相对路径与查询参数
   * @param options - 请求载荷与鉴权跳过选项
   * @returns 校验通过的成功 JSON 响应对象
   * @throws {OpenHuddleApiError} 当网络不可达、JSON 损坏或服务端返回非 2xx 状态时抛出
   */
  private async requestJson<TResponse>(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    pathWithQuery: string,
    options?: {
      readonly body?: unknown;
      readonly skipAuth?: boolean;
    },
  ): Promise<TResponse> {
    const url = `${this.baseUrl}${pathWithQuery}`;
    const headers: Record<string, string> = {
      Accept: "application/json",
    };

    if (!options?.skipAuth && this.token !== undefined && this.token.length > 0) {
      headers.Authorization = `Bearer ${this.token}`;
    }
    if (options?.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    let response: Response;
    try {
      response = await this.fetchFn(url, {
        method,
        headers,
        ...(options?.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      });
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      throw new OpenHuddleApiError({
        status: 0,
        code: "NETWORK_ERROR",
        message: `Failed to reach OpenHuddle server at ${this.baseUrl}: ${detail}`,
        details: cause,
      });
    }

    const rawText = await response.text();
    let parsedBody: unknown;
    try {
      parsedBody = rawText.length > 0 ? JSON.parse(rawText) : undefined;
    } catch {
      if (!response.ok) {
        throw new OpenHuddleApiError({
          status: response.status,
          code: "INTERNAL_SERVER_ERROR",
          message: `HTTP ${response.status} ${response.statusText}: ${rawText.slice(0, 240)}`,
        });
      }
      throw new OpenHuddleApiError({
        status: response.status,
        code: "INVALID_RESPONSE",
        message: `Expected JSON response from ${method} ${pathWithQuery}, received non-JSON payload.`,
      });
    }

    if (!response.ok) {
      if (isApiErrorEnvelope(parsedBody)) {
        throw new OpenHuddleApiError({
          status: response.status,
          code: parsedBody.error.code,
          message: parsedBody.error.message,
          requestId: parsedBody.error.requestId,
          ...(parsedBody.error.details !== undefined ? { details: parsedBody.error.details } : {}),
        });
      }
      throw new OpenHuddleApiError({
        status: response.status,
        code: "INTERNAL_SERVER_ERROR",
        message: `HTTP ${response.status} ${response.statusText}`,
        ...(parsedBody !== undefined ? { details: parsedBody } : {}),
      });
    }

    if (typeof parsedBody !== "object" || parsedBody === null) {
      throw new OpenHuddleApiError({
        status: response.status,
        code: "INVALID_RESPONSE",
        message: `Malformed empty response object from ${method} ${pathWithQuery}.`,
      });
    }

    return parsedBody as TResponse;
  }
}
