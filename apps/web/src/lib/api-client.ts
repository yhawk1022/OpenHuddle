/**
 * @module web/lib/api-client
 * @description 同源 `/api/v1` 强类型 HTTP 客户端（自动注入备份会话令牌、统一解析 `ApiErrorEnvelope` 信封）。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 双重凭证透传：所有请求携带 `credentials: "include"`（发送 `oh_session` Cookie），并在存在本地 `sessionToken` 时附加 `Authorization: Bearer <token>` 头。
 * 2. 零 `any` 错误收敛：任何非 2xx 响应均通过 `ApiErrorEnvelopeSchema.safeParse` 提取稳定业务错误码（如 `GOVERNANCE_BUDGET_PAUSED`、`CONFLICT_UNREAD_MESSAGES`）与 `requestId`。
 * 3. 401 自愈清理：当已持有本地备份令牌却收到服务端 `401 UNAUTHORIZED` 时，自动清理失效本地令牌以驱动视图平滑回退至登录门禁。
 */
import {
  type AgentId,
  type ApiErrorEnvelope,
  ApiErrorEnvelopeSchema,
  type CastProposalVoteBody,
  type ConnectLocalAgentBody,
  type ConnectLocalAgentResponse,
  type CreatePairingCodeResponse,
  type DecideProposalBody,
  type DeleteOwnedAgentResponse,
  type ErrorCode,
  type HumanUserDto,
  type JoinRoomBody,
  type LocalAgentsStatusResponse,
  type MessageDto,
  type MessageMention,
  type MessageSeq,
  type OperationKey,
  type OwnedAgentSummaryDto,
  type ProposalCardDto,
  type ProposalDraft,
  type ProposalId,
  type ReadCursorSeq,
  type RequestOtpBody,
  type RequestOtpResponse,
  type RoomDetailDto,
  type RoomGovernanceConfig,
  type RoomGovernanceState,
  type RoomId,
  type RoomSummaryDto,
  type RoomVisibility,
  type UpdateGovernanceBody,
  type VerifyOtpBody,
  type VerifyOtpResponse,
} from "@openhuddle/protocol";
import { getStoredSessionToken, setStoredSessionToken } from "./session-store.js";

/**
 * 封装后端标准错误信封的强类型客户端异常。
 */
export class ApiClientError extends Error {
  public readonly code: ErrorCode;
  public readonly statusCode: number;
  public readonly requestId: string;
  public readonly details: unknown;

  public constructor(params: {
    readonly code: ErrorCode;
    readonly message: string;
    readonly statusCode: number;
    readonly requestId: string;
    readonly details?: unknown;
  }) {
    super(params.message);
    this.name = "ApiClientError";
    this.code = params.code;
    this.statusCode = params.statusCode;
    this.requestId = params.requestId;
    this.details = params.details;
  }
}

/** 系统健康探针返回数据结构 */
export interface SystemHealthDto {
  readonly ok: true;
  readonly service: string;
  readonly version: string;
  readonly databaseDriver: "pglite" | "postgres";
  readonly realtimeBusDriver: "memory" | "postgres";
  readonly serverTimeIso: string;
}

/** 人类端 `/api/v1/me` 响应数据结构 */
export interface HumanMeResponseDto {
  readonly ok: true;
  readonly callerKind: "human";
  readonly user: HumanUserDto;
  readonly agents: ReadonlyArray<OwnedAgentSummaryDto>;
}

/** 创建配对码入参结构（兼容 `exactOptionalPropertyTypes`） */
export interface CreatePairingCodeInput {
  readonly autoJoinRoomId?: RoomId;
  readonly reclaimAgentId?: AgentId;
  readonly expiresInHours?: number;
}

/** 创建新 Huddle 房间入参结构 */
export interface CreateRoomInput {
  readonly name: string;
  readonly topic: string;
  readonly rules: string;
  readonly visibility: RoomVisibility;
  readonly governance?: Partial<RoomGovernanceConfig>;
}

/** 房间消息增量拉取响应结构 */
export interface RoomMessagesResponseDto {
  readonly ok: true;
  readonly messages: ReadonlyArray<MessageDto>;
  readonly latestSeq: number;
  readonly governance: RoomGovernanceState;
}

/** 发送消息入参结构（兼容只读数组与可选幂等键） */
export interface SendRoomMessageInput {
  readonly content: string;
  readonly replyToSeq?: MessageSeq;
  readonly mentions?: ReadonlyArray<MessageMention>;
  readonly opKey?: OperationKey;
  readonly lastReadSeq?: ReadCursorSeq;
  readonly ignoreUnread?: boolean;
}

/** 发送消息成功响应结构 */
export interface SendRoomMessageResponseDto {
  readonly ok: true;
  readonly message: MessageDto;
  readonly governance: RoomGovernanceState;
}

/** AI 自动提炼提案卡片入参结构 */
export interface SynthesizeProposalInput {
  readonly messageWindowLimit?: number;
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly model?: string;
}

/** 公开只读分享回放响应结构 */
export interface PublicShareReplayDto {
  readonly ok: true;
  readonly room: RoomDetailDto;
  readonly messages: ReadonlyArray<MessageDto>;
  readonly proposals: ReadonlyArray<ProposalCardDto>;
}

interface RequestOptions {
  readonly method?: "GET" | "POST" | "PATCH" | "DELETE";
  readonly body?: unknown;
  readonly skipAuthTokenClearOn401?: boolean;
}

async function requestJson<TResponse>(
  path: string,
  options: RequestOptions = {},
): Promise<TResponse> {
  const method = options.method ?? "GET";
  const token = getStoredSessionToken();

  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (token !== null) {
    headers.Authorization = `Bearer ${token}`;
  }
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(path, {
    method,
    headers,
    credentials: "include",
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });

  const rawPayload: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const parsedError = ApiErrorEnvelopeSchema.safeParse(rawPayload);
    if (response.status === 401 && !options.skipAuthTokenClearOn401 && token !== null) {
      // 安全自愈：服务端明确判定令牌过期或吊销时，立即擦除本地残留备份避免无限重试 401
      setStoredSessionToken(null);
    }
    if (parsedError.success) {
      const env: ApiErrorEnvelope = parsedError.data;
      throw new ApiClientError({
        code: env.error.code,
        message: env.error.message,
        statusCode: response.status,
        requestId: env.error.requestId,
        ...(env.error.details !== undefined ? { details: env.error.details } : {}),
      });
    }
    throw new ApiClientError({
      code: response.status === 401 ? "UNAUTHORIZED" : "INTERNAL_SERVER_ERROR",
      message: `Request failed with HTTP ${response.status}`,
      statusCode: response.status,
      requestId: "unknown",
    });
  }

  return rawPayload as TResponse;
}

/**
 * 探测后端网关、数据库驱动与实时总线健康状态。
 *
 * @returns 系统健康探针负载
 */
export async function fetchSystemHealth(): Promise<SystemHealthDto> {
  return requestJson<SystemHealthDto>("/api/v1/health", {
    skipAuthTokenClearOn401: true,
  });
}

/**
 * 请求向指定邮箱发送 6 位一次性登录验证码（开发模式可选附带 `devOtpCode`）。
 *
 * @param body - 邮箱地址与可选首次注册展示昵称
 * @returns 验证码有效期与开发快捷码（如有）
 */
export async function requestEmailOtp(body: Readonly<RequestOtpBody>): Promise<RequestOtpResponse> {
  return requestJson<RequestOtpResponse>("/api/v1/auth/otp/request", {
    method: "POST",
    body,
    skipAuthTokenClearOn401: true,
  });
}

/**
 * 校验 6 位邮箱验证码并建立人类登录会话。
 *
 * @param body - 邮箱、6 位数字验证码与可选展示昵称
 * @returns 已认证人类资料与备份 `sessionToken`
 */
export async function verifyEmailOtp(body: Readonly<VerifyOtpBody>): Promise<VerifyOtpResponse> {
  return requestJson<VerifyOtpResponse>("/api/v1/auth/otp/verify", {
    method: "POST",
    body,
    skipAuthTokenClearOn401: true,
  });
}

/**
 * 注销当前人类登录会话并吊销服务端 Session。
 *
 * @returns 标准 `{ ok: true }` 确认响应
 */
export async function logoutSession(): Promise<{ readonly ok: true }> {
  return requestJson<{ readonly ok: true }>("/api/v1/auth/logout", {
    method: "POST",
  });
}

/**
 * 查询当前已登录的人类身份及名下绑定的全部个人 Agent 列表。
 *
 * @returns 包含 `user` 与 `agents` 的自省结果
 */
export async function fetchCurrentMe(): Promise<HumanMeResponseDto> {
  return requestJson<HumanMeResponseDto>("/api/v1/me");
}

/**
 * 签发一次性 Agent 配对码（支持自动拉入指定房间或 `--reclaim` 恢复失联 Agent）。
 *
 * @param body - 可选绑定的目标房间 ID、待恢复 Agent ID 与过期小时数
 * @returns 配对短码 `HUDDLE-XXXX-XXXX` 与一键粘贴引导词 `onboardingPrompt`
 */
export async function createPairingCode(
  body: Readonly<CreatePairingCodeInput>,
): Promise<CreatePairingCodeResponse> {
  return requestJson<CreatePairingCodeResponse>("/api/v1/pairing-codes", {
    method: "POST",
    body,
  });
}

/**
 * 探测同机部署环境下本机已安装的预设 Agent CLI（`claude`、`codex`、`agy`、`gemini`）。
 *
 * @returns 是否允许本机直连及各预设 CLI 的安装状态列表
 */
export async function fetchLocalAgentsStatus(): Promise<LocalAgentsStatusResponse> {
  return requestJson<LocalAgentsStatusResponse>("/api/v1/local-agents/status");
}

/**
 * 一键直连同机安装的预设 Agent CLI（服务端内聚完成配对、写入 `0600` 令牌、发送进群问候并启动后台 SSE 守护）。
 *
 * @param body - 预设平台、群内昵称及可选自动入群房间 / 待恢复身份 ID
 * @returns 绑定后的 Agent 摘要、自动加入的房间 ID 与守护进程运行状态
 */
export async function connectLocalAgent(
  body: Readonly<ConnectLocalAgentBody>,
): Promise<ConnectLocalAgentResponse> {
  return requestJson<ConnectLocalAgentResponse>("/api/v1/local-agents/connect", {
    method: "POST",
    body,
  });
}

/**
 * 彻底删除当前人类主人名下的指定个人 Agent（吊销 `oh_agt_` 令牌、移出全部群聊，并在本机回环模式下自动卸载对应后台守护进程）。
 *
 * @param agentId - 待删除的个人 Agent ID
 * @returns 删除确认与是否同步停止了本机守护进程
 */
export async function deleteOwnedAgent(agentId: AgentId): Promise<DeleteOwnedAgentResponse> {
  return requestJson<DeleteOwnedAgentResponse>(`/api/v1/agents/${encodeURIComponent(agentId)}`, {
    method: "DELETE",
  });
}

/**
 * 拉取当前用户已加入的所有 Huddle 房间概览列表。
 *
 * @returns 按活跃度排列的房间摘要列表
 */
export async function fetchJoinedRooms(): Promise<{
  readonly ok: true;
  readonly rooms: ReadonlyArray<RoomSummaryDto>;
}> {
  return requestJson<{
    readonly ok: true;
    readonly rooms: ReadonlyArray<RoomSummaryDto>;
  }>("/api/v1/rooms");
}

/**
 * 创建新的多 Agent 协作 Huddle 房间。
 *
 * @param body - 房间名称、主题、群规、可见性与初始治理配置
 * @returns 新建房间的完整详情 DTO
 */
export async function createHuddleRoom(
  body: Readonly<CreateRoomInput>,
): Promise<{ readonly ok: true; readonly room: RoomDetailDto }> {
  return requestJson<{ readonly ok: true; readonly room: RoomDetailDto }>("/api/v1/rooms", {
    method: "POST",
    body,
  });
}

/**
 * 获取指定房间的完整详情（含群规、`inviteToken` 及实时成员 `reach` 列表）。
 *
 * @param roomId - 目标房间品牌 ID
 * @returns 房间完整详情 DTO
 */
export async function fetchRoomDetail(
  roomId: RoomId,
): Promise<{ readonly ok: true; readonly room: RoomDetailDto }> {
  return requestJson<{ readonly ok: true; readonly room: RoomDetailDto }>(
    `/api/v1/rooms/${encodeURIComponent(roomId)}`,
  );
}

/**
 * 凭房间邀请令牌加入现有 Huddle 房间。
 *
 * @param body - 包含 `inviteToken` 的入群载荷
 * @returns 加入成功后的房间完整详情 DTO
 */
export async function joinRoomByInvite(
  body: Readonly<JoinRoomBody>,
): Promise<{ readonly ok: true; readonly room: RoomDetailDto }> {
  return requestJson<{ readonly ok: true; readonly room: RoomDetailDto }>("/api/v1/join", {
    method: "POST",
    body,
  });
}

/**
 * 人类裁判热更新房间治理参数（切换模式、互 @ 熔断、调整轮次上限、续期挂起预算或开启公开分享）。
 *
 * @param roomId - 目标房间品牌 ID
 * @param body - 待热更新的治理字段补丁
 * @returns 更新后的房间详情 DTO
 */
export async function updateRoomGovernance(
  roomId: RoomId,
  body: Readonly<UpdateGovernanceBody>,
): Promise<{ readonly ok: true; readonly room: RoomDetailDto }> {
  return requestJson<{ readonly ok: true; readonly room: RoomDetailDto }>(
    `/api/v1/rooms/${encodeURIComponent(roomId)}/governance`,
    {
      method: "PATCH",
      body,
    },
  );
}

/**
 * 按游标拉取房间消息列表并推进当前用户的 `lastReadSeq`。
 *
 * @param roomId - 目标房间品牌 ID
 * @param params - 可选起始序号 `afterSeq`（默认 0）与条数上限 `limit`（默认 100）
 * @returns 消息数组、最新 `latestSeq` 与实时治理状态快照
 */
export async function fetchRoomMessages(
  roomId: RoomId,
  params?: { readonly afterSeq?: number; readonly limit?: number },
): Promise<RoomMessagesResponseDto> {
  const afterSeq = params?.afterSeq ?? 0;
  const limit = params?.limit ?? 100;
  const search = new URLSearchParams({
    afterSeq: String(afterSeq),
    limit: String(limit),
  });
  return requestJson<RoomMessagesResponseDto>(
    `/api/v1/rooms/${encodeURIComponent(roomId)}/messages?${search.toString()}`,
  );
}

/**
 * 在指定房间发送人类消息（自动重置 `paused_budget` 轮次预算并根据 `@mention` 唤醒目标 Agent）。
 *
 * @param roomId - 目标房间品牌 ID
 * @param body - 消息正文、引用序号、显式提及列表与幂等键 `opKey`
 * @returns 落库后的权威 `MessageDto` 与最新房间治理快照
 */
export async function sendRoomMessage(
  roomId: RoomId,
  body: Readonly<SendRoomMessageInput>,
): Promise<SendRoomMessageResponseDto> {
  return requestJson<SendRoomMessageResponseDto>(
    `/api/v1/rooms/${encodeURIComponent(roomId)}/messages`,
    {
      method: "POST",
      body,
    },
  );
}

/**
 * 在 2 分钟窗口内撤回本人发送的指定序号消息。
 *
 * @param roomId - 目标房间品牌 ID
 * @param seq - 待撤回的消息序号
 * @returns 标记了 `recalledAtIso` 的消息 DTO
 */
export async function recallRoomMessage(
  roomId: RoomId,
  seq: MessageSeq,
): Promise<{ readonly ok: true; readonly message: MessageDto }> {
  return requestJson<{ readonly ok: true; readonly message: MessageDto }>(
    `/api/v1/rooms/${encodeURIComponent(roomId)}/messages/${encodeURIComponent(String(seq))}`,
    {
      method: "DELETE",
    },
  );
}

/**
 * 拉取指定房间内的全部结构化提案与决策卡片。
 *
 * @param roomId - 目标房间品牌 ID
 * @returns 提案卡片列表（含备选方案对比、各方投票及人类拍板结论）
 */
export async function fetchRoomProposals(
  roomId: RoomId,
): Promise<{ readonly ok: true; readonly proposals: ReadonlyArray<ProposalCardDto> }> {
  return requestJson<{
    readonly ok: true;
    readonly proposals: ReadonlyArray<ProposalCardDto>;
  }>(`/api/v1/rooms/${encodeURIComponent(roomId)}/proposals`);
}

/**
 * 手动提交一张结构化多方案对比提案卡片。
 *
 * @param roomId - 目标房间品牌 ID
 * @param draft - 提案标题、背景摘要与备选方案利弊分析列表
 * @returns 创建成功的提案卡片 DTO
 */
export async function createRoomProposal(
  roomId: RoomId,
  draft: Readonly<ProposalDraft>,
): Promise<{ readonly ok: true; readonly proposal: ProposalCardDto }> {
  return requestJson<{ readonly ok: true; readonly proposal: ProposalCardDto }>(
    `/api/v1/rooms/${encodeURIComponent(roomId)}/proposals`,
    {
      method: "POST",
      body: draft,
    },
  );
}

/**
 * 调用服务端 AI 主持人从最近讨论上下文自动提炼生成结构化提案卡（支持可选 BYOK 密钥覆盖）。
 *
 * @param roomId - 目标房间品牌 ID
 * @param body - 消息窗口条数与可选自定义模型/API Key/Base URL
 * @returns AI 自动提炼落库的提案卡片 DTO
 */
export async function synthesizeRoomProposal(
  roomId: RoomId,
  body: Readonly<SynthesizeProposalInput>,
): Promise<{ readonly ok: true; readonly proposal: ProposalCardDto }> {
  return requestJson<{ readonly ok: true; readonly proposal: ProposalCardDto }>(
    `/api/v1/rooms/${encodeURIComponent(roomId)}/proposals/synthesize`,
    {
      method: "POST",
      body,
    },
  );
}

/**
 * 对开放中的提案提交赞同（`endorse`）、质疑（`challenge`）或弃权（`abstain`）结构化表态。
 *
 * @param proposalId - 目标提案品牌 ID
 * @param body - 立场、倾向方案键与理由陈述
 * @returns 更新投票列表后的提案卡片 DTO
 */
export async function castProposalVote(
  proposalId: ProposalId,
  body: Readonly<CastProposalVoteBody>,
): Promise<{ readonly ok: true; readonly proposal: ProposalCardDto }> {
  return requestJson<{ readonly ok: true; readonly proposal: ProposalCardDto }>(
    `/api/v1/proposals/${encodeURIComponent(proposalId)}/votes`,
    {
      method: "POST",
      body,
    },
  );
}

/**
 * 人类裁判对提案做出最终拍板采纳（`approved`）或驳回重议（`rejected`）决定。
 *
 * @param proposalId - 目标提案品牌 ID
 * @param body - 拍板结论、最终选定方案键与决策批注
 * @returns 固化决策记录后的提案卡片 DTO
 */
export async function decideProposal(
  proposalId: ProposalId,
  body: Readonly<DecideProposalBody>,
): Promise<{ readonly ok: true; readonly proposal: ProposalCardDto }> {
  return requestJson<{ readonly ok: true; readonly proposal: ProposalCardDto }>(
    `/api/v1/proposals/${encodeURIComponent(proposalId)}/decide`,
    {
      method: "POST",
      body,
    },
  );
}

/**
 * 无需登录拉取公开分享房间（`/share/:inviteToken`）的完整讨论与拍板决策回放。
 *
 * @param inviteToken - 房间公开分享邀请令牌
 * @returns 包含房间信息、历史消息流与提案拍板卡的只读回放包
 */
export async function fetchPublicShareReplay(inviteToken: string): Promise<PublicShareReplayDto> {
  return requestJson<PublicShareReplayDto>(`/api/v1/share/${encodeURIComponent(inviteToken)}`, {
    skipAuthTokenClearOn401: true,
  });
}
