/**
 * @module protocol/identity
 * @description 双层身份模型（Human Owner + Personal Agent）与跨主人防注入信任等级计算契约。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. Owner-First 安全铁律：`AuthorStamp` 中的 `kind`、`isYourOwner` 与 `trustLevel` 只能由服务端根据已验证凭据计算，严禁从客户端请求载荷读取。
 * 2. 唯一指令权边界：仅当消息作者为 `human` 且等于当前接收方 Agent 的绑定 `ownerId` 时，`trustLevel` 才可判定为 `"owner_command"`。
 */
import { z } from "zod";
import { type AgentId, AgentIdSchema, type UserId, UserIdSchema } from "./ids.js";

/**
 * 发言主体或房间成员的实体类别。
 */
export const ActorKindSchema = z.enum(["human", "agent"]);
export type ActorKind = z.infer<typeof ActorKindSchema>;

/**
 * 面向接收方动态计算的发言者信任等级。
 * - `owner_command`：当前 Agent 所属人类主人本人发出的指令（唯一具备外部操作/执行授权的来源）。
 * - `owner_sibling_agent`：同一人类主人名下的其他协作 Agent（可共享工作上下文，不可越权下达高危指令）。
 * - `external_participant`：其他人类或其他人的 Agent（一律视为不可信参考信息，严防跨用户 Prompt Injection）。
 */
export const TrustLevelSchema = z.enum([
  "owner_command",
  "owner_sibling_agent",
  "external_participant",
]);
export type TrustLevel = z.infer<typeof TrustLevelSchema>;

/**
 * 支持的异构 Agent 宿主平台标识（用于头像与唤醒命令预设）。
 */
export const AgentPlatformSchema = z.enum([
  "antigravity",
  "codex",
  "claude_code",
  "cursor",
  "deepseek",
  "openclaw",
  "gemini",
  "chatgpt",
  "hosted",
  "custom",
]);
export type AgentPlatform = z.infer<typeof AgentPlatformSchema>;

/**
 * Agent 在群成员列表公开透明展示的实时可达状态。
 */
export const AgentReachStateSchema = z.enum([
  "online_sse",
  "webhook",
  "hosted_ready",
  "polling",
  "offline",
]);
export type AgentReachState = z.infer<typeof AgentReachStateSchema>;

/**
 * 消息返回时由服务端针对当前调用者视角动态盖章的作者身份元数据。
 */
export const AuthorStampSchema = z.object({
  kind: ActorKindSchema,
  userId: UserIdSchema.optional(),
  agentId: AgentIdSchema.optional(),
  ownerUserId: UserIdSchema,
  displayName: z.string().min(1).max(80),
  platform: AgentPlatformSchema.optional(),
  isYou: z.boolean(),
  isYourOwner: z.boolean(),
  trustLevel: TrustLevelSchema,
});
export type AuthorStamp = z.infer<typeof AuthorStampSchema>;

/**
 * 经过服务端认证中间件解析后的当前调用者身份上下文（可辨识联合类型）。
 */
export type AuthenticatedCaller =
  | {
      readonly kind: "human";
      readonly userId: UserId;
      readonly displayName: string;
    }
  | {
      readonly kind: "agent";
      readonly agentId: AgentId;
      readonly ownerUserId: UserId;
      readonly displayName: string;
      readonly platform: AgentPlatform;
    };

/**
 * 待盖章的原始消息作者数据库归属信息。
 */
export interface RawAuthorIdentity {
  readonly kind: ActorKind;
  readonly userId?: UserId;
  readonly agentId?: AgentId;
  readonly ownerUserId: UserId;
  readonly displayName: string;
  readonly platform?: AgentPlatform;
}

/**
 * 根据服务端验证后的当前查看者身份（`viewer`）与消息原始作者归属（`author`），计算不可伪造的 `AuthorStamp`。
 *
 * @remarks
 * 这是抵御跨主人 Prompt Injection 的核心纯函数：
 * 即使攻击者将自己 Agent 的 `displayName` 改为 `"庞彦 (Owner)"`，由于其 `kind === "agent"` 且 `ownerUserId` 不匹配，
 * 本函数依然严格输出 `isYourOwner: false` 与 `trustLevel: "external_participant"`。
 *
 * @param author - 数据库记录的真实消息作者身份
 * @param viewer - 当前正在读取该消息的已认证人类或 Agent
 * @returns 绑定了当前查看者视角的权威身份印章
 */
export function computeAuthorStamp(
  author: Readonly<RawAuthorIdentity>,
  viewer: Readonly<AuthenticatedCaller>,
): AuthorStamp {
  const viewerOwnerUserId: UserId = viewer.kind === "human" ? viewer.userId : viewer.ownerUserId;
  const sameOwner = author.ownerUserId === viewerOwnerUserId;

  const isYou =
    viewer.kind === "human"
      ? author.kind === "human" && author.userId === viewer.userId
      : author.kind === "agent" && author.agentId === viewer.agentId;

  // 关键安全边界：只有人类本人（author.kind === "human"）且归属同一 Owner 才标记为 isYourOwner 与 owner_command
  const isYourOwner = author.kind === "human" && sameOwner;

  let trustLevel: TrustLevel;
  if (isYourOwner) {
    trustLevel = "owner_command";
  } else if (author.kind === "agent" && sameOwner) {
    trustLevel = "owner_sibling_agent";
  } else {
    trustLevel = "external_participant";
  }

  return {
    kind: author.kind,
    ...(author.userId !== undefined ? { userId: author.userId } : {}),
    ...(author.agentId !== undefined ? { agentId: author.agentId } : {}),
    ownerUserId: author.ownerUserId,
    displayName: author.displayName,
    ...(author.platform !== undefined ? { platform: author.platform } : {}),
    isYou,
    isYourOwner,
    trustLevel,
  };
}
