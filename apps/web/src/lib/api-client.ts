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
  type AcceptFriendRequestResponse,
  type AgentId,
  type AnswerWorkAttentionBody,
  type ApiErrorEnvelope,
  ApiErrorEnvelopeSchema,
  type AttentionPayload,
  type AuthCodeSentResponse,
  type AuthPublicConfigResponse,
  type AuthSessionResponse,
  type BindRoomWorkspaceBody,
  type BindRoomWorkspaceResponse,
  type CastProposalVoteBody,
  type ChangePasswordBody,
  type ConfirmPasswordResetBody,
  type ConnectLocalAgentBody,
  type ConnectLocalAgentResponse,
  type ControlWorkItemBody,
  type CreateAgentConnectionBody,
  type CreateAgentConnectionResponse,
  type CreatePairingCodeResponse,
  type CreateWorkItemBody,
  type CreateWorkspaceBody,
  type DecideProposalBody,
  type DecideWorkReviewBody,
  type DeleteOwnedAgentResponse,
  type DeleteRoomResponse,
  type DeleteWorkspaceResponse,
  type DirectoryUserSearchResponse,
  type ErrorCode,
  type FriendsOverviewResponse,
  type FriendshipId,
  type HumanUserDto,
  type JoinRoomBody,
  type LanguagePreference,
  type ListWorkItemsResponse,
  type ListWorkspacesResponse,
  type LocalAgentsStatusResponse,
  type LoginWithPasswordBody,
  type MessageAttachmentUpload,
  type MessageDto,
  type MessageMention,
  type MessageSeq,
  type OpenDirectRoomResponse,
  type OperationKey,
  type OwnedAgentSummaryDto,
  type ProposalCardDto,
  type ProposalDraft,
  type ProposalId,
  type ReadCursorSeq,
  type RegisterWithPasswordBody,
  type RemoveFriendshipResponse,
  type RequestOtpBody,
  type RequestOtpResponse,
  type RequestPasswordResetCodeBody,
  type RequestRegisterCodeBody,
  type RoomDetailDto,
  type RoomGovernanceConfig,
  type RoomGovernanceState,
  type RoomId,
  type RoomSummaryDto,
  type RoomVisibility,
  type RoomWorkspacesResponse,
  type SendFriendRequestBody,
  type SendFriendRequestResponse,
  type SingleWorkItemResponse,
  type SingleWorkspaceResponse,
  type SteerWorkItemBody,
  type ThemePreference,
  type UpdateFriendRemarkBody,
  type UpdateFriendRemarkResponse,
  type UpdateGovernanceBody,
  type UpdateMeBody,
  type UpdateOwnRoomRemarkBody,
  type UpdateOwnRoomRemarkResponse,
  type UpdateOwnedAgentBody,
  type UpdateOwnedAgentResponse,
  type UpdateWorkspaceBody,
  type UserId,
  type VerifyOtpBody,
  type VerifyOtpResponse,
  type WorkItemId,
  type WorkStage,
  type WorkspaceId,
} from "@openhuddle/protocol";
import {
  formatBackendUnavailableMessage,
  formatHttpFailedMessage,
  formatNetworkFailedMessage,
  formatNetworkTimeoutMessage,
  getActiveLocale,
} from "./i18n/index.js";
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
  readonly themePreference?: ThemePreference;
  readonly languagePreference?: LanguagePreference;
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
  /** 建群时直拉入群的本人 Agent（服务端逐个校验归属） */
  readonly initialAgentIds?: readonly AgentId[];
  /** 建群时直拉入群的已添加好友（服务端逐个校验 accepted 好友关系） */
  readonly initialUserIds?: readonly UserId[];
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
  readonly attachment?: MessageAttachmentUpload;
  readonly replyToSeq?: MessageSeq;
  readonly mentions?: ReadonlyArray<MessageMention>;
  readonly opKey?: OperationKey;
  readonly lastReadSeq?: ReadCursorSeq;
  readonly ignoreUnread?: boolean;
  /** ADR-0002：携带时以 attention 消息发送（服务端强制仅人类可用） */
  readonly attention?: AttentionPayload;
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

export interface RequestOptions {
  readonly method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly body?: unknown;
  readonly skipAuthTokenClearOn401?: boolean;
  /** 请求超时毫秒数（默认 20s）。超时后以 TIMEOUT 错误落地，防止乐观 UI（如"发送中"气泡）永久悬挂 */
  readonly timeoutMs?: number;
}

/**
 * 向同源 `/api/v1` 网关发送强类型 JSON 请求并自动附加认证凭证与 401 自愈处理。
 *
 * @param path - 请求路径与查询字符串
 * @param options - HTTP 方法、请求体与超时设置
 * @returns 解析后的强类型 JSON 响应
 */
export async function requestApiJson<TResponse>(
  path: string,
  options: RequestOptions = {},
): Promise<TResponse> {
  const method = options.method ?? "GET";
  const timeoutMs = options.timeoutMs ?? 20_000;
  const token = getStoredSessionToken();

  const headers: Record<string, string> = {
    Accept: "application/json",
    "Accept-Language": getActiveLocale(),
  };
  if (token !== null) {
    headers.Authorization = `Bearer ${token}`;
  }
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers,
      credentials: "include",
      signal: AbortSignal.timeout(timeoutMs),
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
  } catch (err) {
    // 连接中断/超时必须显式落地为 ApiClientError，让乐观更新（发送中气泡等）进入失败态而非无限 pending
    if (err instanceof DOMException && err.name === "TimeoutError") {
      throw new ApiClientError({
        code: "INTERNAL_SERVER_ERROR",
        message: formatNetworkTimeoutMessage(timeoutMs / 1_000),
        statusCode: 504,
        requestId: "timeout",
      });
    }
    throw new ApiClientError({
      code: "INTERNAL_SERVER_ERROR",
      message:
        err instanceof Error && err.message.trim().length > 0
          ? err.message
          : formatNetworkFailedMessage(),
      statusCode: 0,
      requestId: "network",
    });
  }

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
    const isGatewayOrBackendDown = response.status >= 500 && rawPayload === null;
    throw new ApiClientError({
      code: response.status === 401 ? "UNAUTHORIZED" : "INTERNAL_SERVER_ERROR",
      message: isGatewayOrBackendDown
        ? formatBackendUnavailableMessage(response.status)
        : formatHttpFailedMessage(response.status),
      statusCode: response.status,
      requestId: isGatewayOrBackendDown ? "gateway" : "unknown",
    });
  }

  return rawPayload as TResponse;
}

const requestJson = requestApiJson;

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
 * 获取面向未登录前端的认证与注册策略公开配置（注册开关、域名白名单、邮件投递模式与冷却参数）。
 *
 * @returns 公开认证能力配置
 */
export async function fetchAuthConfig(): Promise<AuthPublicConfigResponse> {
  return requestJson<AuthPublicConfigResponse>("/api/v1/auth/config", {
    skipAuthTokenClearOn401: true,
  });
}

/**
 * 注册前向指定邮箱发送 6 位邮箱激活验证码。
 *
 * @param body - 规范化待注册邮箱
 * @returns 验证码有效期、重发冷却秒数与投递通道信息
 */
export async function requestRegisterCode(
  body: Readonly<RequestRegisterCodeBody>,
): Promise<AuthCodeSentResponse> {
  return requestJson<AuthCodeSentResponse>("/api/v1/auth/register/request-code", {
    method: "POST",
    body,
    skipAuthTokenClearOn401: true,
  });
}

/**
 * 校验 6 位邮箱激活验证码，使用邮箱与密码完成新账号注册并自动签发登录会话。
 *
 * @param body - 邮箱、6 位验证码、昵称与密码
 * @returns 新建人类用户档案与会话令牌
 */
export async function registerWithPassword(
  body: Readonly<RegisterWithPasswordBody>,
): Promise<AuthSessionResponse> {
  return requestJson<AuthSessionResponse>("/api/v1/auth/register", {
    method: "POST",
    body,
    skipAuthTokenClearOn401: true,
  });
}

/**
 * 使用邮箱与密码登录并建立人类登录会话。
 *
 * @param body - 邮箱与登录密码
 * @returns 已认证人类资料与备份 `sessionToken`
 */
export async function loginWithPassword(
  body: Readonly<LoginWithPasswordBody>,
): Promise<AuthSessionResponse> {
  return requestJson<AuthSessionResponse>("/api/v1/auth/login", {
    method: "POST",
    body,
    skipAuthTokenClearOn401: true,
  });
}

/**
 * 忘记密码时请求向注册邮箱发送 6 位重置验证码。
 *
 * @param body - 目标邮箱
 * @returns 标准发送回执与冷却秒数
 */
export async function requestPasswordResetCode(
  body: Readonly<RequestPasswordResetCodeBody>,
): Promise<AuthCodeSentResponse> {
  return requestJson<AuthCodeSentResponse>("/api/v1/auth/password-reset/request-code", {
    method: "POST",
    body,
    skipAuthTokenClearOn401: true,
  });
}

/**
 * 校验 6 位邮箱重置验证码并更新登录密码，同时自动登录并下线其余设备会话。
 *
 * @param body - 邮箱、6 位重置码与新密码
 * @returns 更新后的用户资料与新会话令牌
 */
export async function confirmPasswordReset(
  body: Readonly<ConfirmPasswordResetBody>,
): Promise<AuthSessionResponse> {
  return requestJson<AuthSessionResponse>("/api/v1/auth/password-reset/confirm", {
    method: "POST",
    body,
    skipAuthTokenClearOn401: true,
  });
}

/**
 * 已登录人类修改密码（或无密码历史用户补设初始密码），同步轮换当前会话令牌。
 *
 * @param body - 可选旧密码与新密码
 * @returns 更新后的用户资料与新会话令牌
 */
export async function changePassword(
  body: Readonly<ChangePasswordBody>,
): Promise<AuthSessionResponse> {
  return requestJson<AuthSessionResponse>("/api/v1/auth/password/change", {
    method: "POST",
    body,
    skipAuthTokenClearOn401: true,
  });
}

/**
 * [兼容旧版 OTP 路由] 请求向指定邮箱发送 6 位一次性登录验证码（开发模式可选附带 `devOtpCode`）。
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
 * [兼容旧版 OTP 路由] 校验 6 位邮箱验证码并建立人类登录会话。
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
 * 更新当前已登录人类用户的展示昵称或账号外观偏好。
 *
 * @param body - 待保存的账号资料字段
 * @returns 更新后的 `HumanMeResponseDto`
 */
export async function updateCurrentMe(body: Readonly<UpdateMeBody>): Promise<HumanMeResponseDto> {
  return requestJson<HumanMeResponseDto>("/api/v1/me", {
    method: "PATCH",
    body,
  });
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
 * 为当前身份签发一次性接入链接。
 *
 * @param body - 主人选中的群聊或待恢复 Agent
 * @returns 单次可用的安装接入链接
 */
export async function createAgentConnection(
  body: Readonly<CreateAgentConnectionBody>,
): Promise<CreateAgentConnectionResponse> {
  return requestJson<CreateAgentConnectionResponse>("/api/v1/agent-connections", {
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
 * 更新当前人类主人名下的指定个人 Agent 设置（展示名称、简介或「允许其他用户私聊」开关）。
 *
 * @param agentId - 目标个人 Agent ID
 * @param body - 待更新的设置字段
 * @returns 更新后的 `UpdateOwnedAgentResponse`
 */
export async function updateOwnedAgentSettings(
  agentId: AgentId,
  body: Readonly<UpdateOwnedAgentBody>,
): Promise<UpdateOwnedAgentResponse> {
  return requestJson<UpdateOwnedAgentResponse>(`/api/v1/agents/${encodeURIComponent(agentId)}`, {
    method: "PATCH",
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
 * 获取当前人类用户的完整通讯录（好友列表、收发好友申请与全站开放私聊的外部 Agent）。
 *
 * @returns `FriendsOverviewResponse`
 */
export async function fetchFriendsOverview(): Promise<FriendsOverviewResponse> {
  return requestJson<FriendsOverviewResponse>("/api/v1/friends");
}

/**
 * 按昵称或邮箱检索站内活跃人类用户及其与本人的好友关系状态。
 *
 * @param query - 搜索关键词
 * @returns `DirectoryUserSearchResponse`
 */
export async function searchPlatformUsers(query: string): Promise<DirectoryUserSearchResponse> {
  const params = new URLSearchParams({ q: query });
  return requestJson<DirectoryUserSearchResponse>(`/api/v1/users/search?${params.toString()}`);
}

/**
 * 向指定用户（按 `targetUserId` 或 `email`）发送好友申请。
 *
 * @param body - 目标用户标识与可选验证附言
 * @returns `SendFriendRequestResponse`
 */
export async function sendFriendRequest(
  body: Readonly<SendFriendRequestBody>,
): Promise<SendFriendRequestResponse> {
  return requestJson<SendFriendRequestResponse>("/api/v1/friends/requests", {
    method: "POST",
    body,
  });
}

/**
 * 同意收到的待处理好友申请。
 *
 * @param friendshipId - 好友申请 ID
 * @returns `AcceptFriendRequestResponse`
 */
export async function acceptFriendRequest(
  friendshipId: FriendshipId,
): Promise<AcceptFriendRequestResponse> {
  return requestJson<AcceptFriendRequestResponse>(
    `/api/v1/friends/requests/${encodeURIComponent(friendshipId)}/accept`,
    {
      method: "POST",
    },
  );
}

/**
 * 拒绝收到的好友申请或撤回本人发出的待处理申请。
 *
 * @param friendshipId - 好友申请 ID
 * @returns `RemoveFriendshipResponse`
 */
export async function declineFriendRequest(
  friendshipId: FriendshipId,
): Promise<RemoveFriendshipResponse> {
  return requestJson<RemoveFriendshipResponse>(
    `/api/v1/friends/requests/${encodeURIComponent(friendshipId)}/decline`,
    {
      method: "POST",
    },
  );
}

/**
 * 保存或清空当前登录用户为好友设置的私有备注。
 *
 * @param friendshipId - 当前好友关系 ID
 * @param body - 备注文本，空字符串表示清除
 * @returns 保存后的备注
 */
export async function updateFriendRemark(
  friendshipId: FriendshipId,
  body: Readonly<UpdateFriendRemarkBody>,
): Promise<UpdateFriendRemarkResponse> {
  return requestJson<UpdateFriendRemarkResponse>(
    `/api/v1/friends/${encodeURIComponent(friendshipId)}/remark`,
    { method: "PATCH", body },
  );
}

/**
 * 解除与指定人类用户的好友关系。
 *
 * @param friendUserId - 目标好友用户 ID
 * @returns `RemoveFriendshipResponse`
 */
export async function removeFriend(friendUserId: UserId): Promise<RemoveFriendshipResponse> {
  return requestJson<RemoveFriendshipResponse>(
    `/api/v1/friends/${encodeURIComponent(friendUserId)}`,
    {
      method: "DELETE",
    },
  );
}

/**
 * 打开或幂等复用与指定个人 Agent（或已开启 `allowExternalDm` 的外部 Agent）的 1v1 单聊房间。
 *
 * @param agentId - 目标 Agent ID
 * @returns `OpenDirectRoomResponse`
 */
export async function openDirectAgentRoom(agentId: AgentId): Promise<OpenDirectRoomResponse> {
  return requestJson<OpenDirectRoomResponse>("/api/v1/rooms/direct/agent", {
    method: "POST",
    body: { agentId },
  });
}

/**
 * 打开或幂等复用与已添加人类好友的 1v1 私聊房间。
 *
 * @param targetUserId - 目标好友用户 ID
 * @returns `OpenDirectRoomResponse`
 */
export async function openDirectHumanRoom(targetUserId: UserId): Promise<OpenDirectRoomResponse> {
  return requestJson<OpenDirectRoomResponse>("/api/v1/rooms/direct/human", {
    method: "POST",
    body: { targetUserId },
  });
}

/**
 * 向现有群聊房间直接拉入已添加的人类好友或本人名下 Agent。
 *
 * @param roomId - 目标群聊房间 ID
 * @param body - 待拉入的 `userIds` 与 `agentIds`
 * @returns 更新成员后的房间详情
 */
export async function addMembersToGroupRoom(
  roomId: RoomId,
  body: Readonly<{
    readonly userIds?: readonly UserId[];
    readonly agentIds?: readonly AgentId[];
  }>,
): Promise<{ readonly ok: true; readonly room: RoomDetailDto }> {
  return requestJson<{ readonly ok: true; readonly room: RoomDetailDto }>(
    `/api/v1/rooms/${encodeURIComponent(roomId)}/members`,
    {
      method: "POST",
      body: {
        userIds: body.userIds ?? [],
        agentIds: body.agentIds ?? [],
      },
    },
  );
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
 * 保存当前登录成员的群备注。
 * @param roomId - 目标群聊主键
 * @param body - 新备注，空字符串表示清除
 * @returns 服务端确认的备注
 */
export async function updateOwnRoomRemark(
  roomId: RoomId,
  body: Readonly<UpdateOwnRoomRemarkBody>,
): Promise<UpdateOwnRoomRemarkResponse> {
  return requestJson<UpdateOwnRoomRemarkResponse>(
    `/api/v1/rooms/${encodeURIComponent(roomId)}/members/me/remark`,
    { method: "PATCH", body },
  );
}

/**
 * 人类群主彻底删除指定群聊房间（级联清理消息、成员、提案与投票；名下个人 Agent 保持不受影响）。
 *
 * @param roomId - 待删除的房间品牌 ID
 * @returns 删除确认与被删除房间 ID
 */
export async function deleteHuddleRoom(roomId: RoomId): Promise<DeleteRoomResponse> {
  return requestJson<DeleteRoomResponse>(`/api/v1/rooms/${encodeURIComponent(roomId)}`, {
    method: "DELETE",
  });
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
 * 主动退出当前已加入的 Huddle 房间（非群主成员退群入口）。
 *
 * @param roomId - 目标房间品牌 ID
 * @returns 标准 `{ ok: true }` 确认响应
 */
export async function leaveHuddleRoom(roomId: RoomId): Promise<{ readonly ok: true }> {
  return requestJson<{ readonly ok: true }>(`/api/v1/rooms/${encodeURIComponent(roomId)}/leave`, {
    method: "POST",
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
      ...(body.attachment !== undefined ? { timeoutMs: 120_000 } : {}),
    },
  );
}

/**
 * 生成原生图片与音频控件可访问的同源附件路径，签入时设置的会话 Cookie 由浏览器自动携带。
 * @param roomId - 房间品牌 ID
 * @param seq - 已确认的消息序号
 * @returns 仍需通过房间成员鉴权的资源路径
 */
export function roomMessageAttachmentPath(roomId: RoomId, seq: MessageSeq): string {
  return `/api/v1/rooms/${encodeURIComponent(roomId)}/messages/${String(seq)}/attachment`;
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

/**
 * 拉取当前登录用户拥有的全部五维工作区与房间挂载关系。
 */
export async function fetchOwnedWorkspaces(): Promise<ListWorkspacesResponse> {
  return requestJson<ListWorkspacesResponse>("/api/v1/workspaces");
}

/**
 * 创建新的受控工作区。
 */
export async function createWorkspaceApi(
  body: Readonly<CreateWorkspaceBody>,
): Promise<SingleWorkspaceResponse> {
  return requestJson<SingleWorkspaceResponse>("/api/v1/workspaces", {
    method: "POST",
    body,
  });
}

/**
 * 更新受控工作区配置。
 */
export async function updateWorkspaceApi(
  workspaceId: WorkspaceId,
  body: Readonly<UpdateWorkspaceBody>,
): Promise<SingleWorkspaceResponse> {
  return requestJson<SingleWorkspaceResponse>(
    `/api/v1/workspaces/${encodeURIComponent(workspaceId)}`,
    {
      method: "PATCH",
      body,
    },
  );
}

/**
 * 删除受控工作区。
 */
export async function deleteWorkspaceApi(
  workspaceId: WorkspaceId,
): Promise<DeleteWorkspaceResponse> {
  return requestJson<DeleteWorkspaceResponse>(
    `/api/v1/workspaces/${encodeURIComponent(workspaceId)}`,
    {
      method: "DELETE",
    },
  );
}

/**
 * 绑定或解绑房间工作区。
 */
export async function bindRoomWorkspaceApi(
  roomId: RoomId,
  body: Readonly<BindRoomWorkspaceBody>,
): Promise<BindRoomWorkspaceResponse> {
  return requestJson<BindRoomWorkspaceResponse>(
    `/api/v1/rooms/${encodeURIComponent(roomId)}/workspace-binding`,
    {
      method: "PUT",
      body,
    },
  );
}

/**
 * 拉取房间内已挂载工作区列表（对非主人自动剥离本机路径）。
 */
export async function fetchRoomWorkspaces(roomId: RoomId): Promise<RoomWorkspacesResponse> {
  return requestJson<RoomWorkspacesResponse>(
    `/api/v1/rooms/${encodeURIComponent(roomId)}/workspaces`,
  );
}

/**
 * 拉取多 Agent 协作工单列表。
 */
export async function fetchWorkItems(query?: {
  readonly workspaceId?: WorkspaceId;
  readonly roomId?: RoomId;
  readonly stage?: WorkStage;
}): Promise<ListWorkItemsResponse> {
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
  const qs = search.toString();
  return requestJson<ListWorkItemsResponse>(`/api/v1/work-items${qs.length > 0 ? `?${qs}` : ""}`);
}

/**
 * 派发新的多 Agent 协作工单。
 */
export async function createWorkItemApi(
  body: Readonly<CreateWorkItemBody>,
): Promise<SingleWorkItemResponse> {
  return requestJson<SingleWorkItemResponse>("/api/v1/work-items", {
    method: "POST",
    body,
  });
}

/**
 * 向运行中的工单分片注入人类纠偏指令。
 */
export async function steerWorkItemApi(
  workItemId: WorkItemId,
  body: Readonly<SteerWorkItemBody>,
): Promise<SingleWorkItemResponse> {
  return requestJson<SingleWorkItemResponse>(
    `/api/v1/work-items/${encodeURIComponent(workItemId)}/steer`,
    {
      method: "POST",
      body,
    },
  );
}

/**
 * 回答暂停中 Worker 的澄清提问。
 */
export async function answerWorkAttentionApi(
  workItemId: WorkItemId,
  body: Readonly<AnswerWorkAttentionBody>,
): Promise<SingleWorkItemResponse> {
  return requestJson<SingleWorkItemResponse>(
    `/api/v1/work-items/${encodeURIComponent(workItemId)}/attention/answer`,
    {
      method: "POST",
      body,
    },
  );
}

/**
 * 人类主人对工单交付物执行最终签收或打回重做。
 */
export async function decideWorkReviewApi(
  workItemId: WorkItemId,
  body: Readonly<DecideWorkReviewBody>,
): Promise<SingleWorkItemResponse> {
  return requestJson<SingleWorkItemResponse>(
    `/api/v1/work-items/${encodeURIComponent(workItemId)}/review`,
    {
      method: "POST",
      body,
    },
  );
}

/**
 * 对工单执行急停、重试或升级挂载至群聊房间。
 */
export async function controlWorkItemApi(
  workItemId: WorkItemId,
  body: Readonly<ControlWorkItemBody>,
): Promise<SingleWorkItemResponse> {
  return requestJson<SingleWorkItemResponse>(
    `/api/v1/work-items/${encodeURIComponent(workItemId)}/control`,
    {
      method: "POST",
      body,
    },
  );
}
