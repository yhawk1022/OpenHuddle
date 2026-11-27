/**
 * @module web/features/admin-console/i18n
 * @description OpenHuddle 运营与治理管理后台独立双语翻译门面与枚举标签映射工具。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 分包隔离：本目录仅允许由 `features/admin-console/` 内部模块导入，绝不被 `lib/i18n/` 或主工作台引用，
 *    确保 `LazyAdminConsolePage` 懒加载独立分包体积不被吃入主包。
 * 2. 穷尽映射：所有协议枚举标签（审计动作、审计目标、治理模式、提案状态、消息类型）均通过 `assertNever` 编译期兜底。
 */
import {
  type AdminAuditAction,
  type AdminAuditTargetType,
  type GovernanceMode,
  type MessageType,
  type ProposalStatus,
  type SupportedLocale,
  assertNever,
} from "@openhuddle/protocol";
import { ApiClientError } from "../../../lib/api-client.js";
import {
  type TranslateFn,
  createScopedTranslator,
  defineCatalog,
  definePluralCatalog,
  formatApiErrorMessage,
} from "../../../lib/i18n/index.js";
import { adminConsoleEn, adminConsolePluralsEn } from "./en.js";
import { adminConsolePluralsZhCN, adminConsoleZhCN } from "./zh-CN.js";

/** 管理后台双语平铺消息词典。 */
export const adminConsoleCatalog = defineCatalog(adminConsoleZhCN, adminConsoleEn);

/** 管理后台双语复数消息词典。 */
export const adminConsolePluralCatalog = definePluralCatalog(
  adminConsolePluralsZhCN,
  adminConsolePluralsEn,
);

const adminScoped = createScopedTranslator(adminConsoleCatalog, adminConsolePluralCatalog);

/** 在非 React 回调或纯工具函数中获取管理后台翻译器。 */
export const getAdminI18n = adminScoped.getTranslator;

/** 在 React 组件中订阅全局生效语种并获取稳定引用的管理后台翻译器。 */
export const useAdminI18n = adminScoped.useI18n;

/** 管理后台翻译函数类型。 */
export type AdminTranslateFn = TranslateFn<typeof adminConsoleZhCN>;

const CLIENT_TRANSPORT_REQUEST_IDS: ReadonlySet<string> = new Set([
  "timeout",
  "network",
  "gateway",
  "unknown",
]);

/**
 * 将后台接口异常解析为当前语种可读错误文案（优先走协议 `ErrorCode` 双语映射）。
 */
export function resolveAdminErrorMessage(
  err: unknown,
  fallback: string,
  locale?: SupportedLocale,
): string {
  if (err instanceof ApiClientError) {
    if (CLIENT_TRANSPORT_REQUEST_IDS.has(err.requestId)) {
      return err.message;
    }
    return formatApiErrorMessage(err.code, err.message, locale);
  }
  if (err instanceof Error && err.message.trim().length > 0) {
    return err.message;
  }
  return fallback;
}

/** 获取群聊治理模式的双语短标签。 */
export function getGovernanceModeLabel(mode: GovernanceMode, t: AdminTranslateFn): string {
  switch (mode) {
    case "free":
      return t("common.governance.free");
    case "round_table":
      return t("common.governance.round_table");
    case "proposal":
      return t("common.governance.proposal");
    default:
      return assertNever(mode);
  }
}

/** 获取结构化提案状态的双语短标签。 */
export function getProposalStatusLabel(status: ProposalStatus, t: AdminTranslateFn): string {
  switch (status) {
    case "open":
      return t("common.proposalStatus.open");
    case "approved":
      return t("common.proposalStatus.approved");
    case "rejected":
      return t("common.proposalStatus.rejected");
    case "superseded":
      return t("common.proposalStatus.superseded");
    default:
      return assertNever(status);
  }
}

/** 获取群聊消息类型的双语标签。 */
export function getMessageTypeLabel(type: MessageType, t: AdminTranslateFn): string {
  switch (type) {
    case "text":
      return t("common.messageType.text");
    case "proposal":
      return t("common.messageType.proposal");
    case "vote":
      return t("common.messageType.vote");
    case "decision":
      return t("common.messageType.decision");
    case "attention":
      return t("common.messageType.attention");
    case "system":
      return t("common.messageType.system");
    default:
      return assertNever(type);
  }
}

/** 获取房间成员角色的双语标签。 */
export function getRoomMemberRoleLabel(role: string, t: AdminTranslateFn): string {
  if (role === "owner") {
    return t("common.role.owner");
  }
  if (role === "member") {
    return t("common.role.member");
  }
  if (role === "admin") {
    return t("common.role.admin");
  }
  return role;
}

/** 获取管理员审计目标实体分类的双语短标签。 */
export function getAuditTargetLabel(targetType: AdminAuditTargetType, t: AdminTranslateFn): string {
  switch (targetType) {
    case "user":
      return t("auditLogs.target.user");
    case "session":
      return t("auditLogs.target.session");
    case "room":
      return t("auditLogs.target.room");
    case "message":
      return t("auditLogs.target.message");
    case "agent":
      return t("auditLogs.target.agent");
    case "proposal":
      return t("auditLogs.target.proposal");
    case "pairing_code":
      return t("auditLogs.target.pairing_code");
    case "system":
      return t("auditLogs.target.system");
    default:
      return assertNever(targetType);
  }
}

/** 获取管理员审计操作动作的双语标签。 */
export function getAuditActionLabel(action: AdminAuditAction, t: AdminTranslateFn): string {
  switch (action) {
    case "user.role_updated":
      return t("auditLogs.action.user.role_updated");
    case "user.suspended":
      return t("auditLogs.action.user.suspended");
    case "user.unsuspended":
      return t("auditLogs.action.user.unsuspended");
    case "user.profile_updated":
      return t("auditLogs.action.user.profile_updated");
    case "user.deleted":
      return t("auditLogs.action.user.deleted");
    case "session.revoked":
      return t("auditLogs.action.session.revoked");
    case "user.sessions_revoked_all":
      return t("auditLogs.action.user.sessions_revoked_all");
    case "session.purged_expired":
      return t("auditLogs.action.session.purged_expired");
    case "room.updated":
      return t("auditLogs.action.room.updated");
    case "room.deleted":
      return t("auditLogs.action.room.deleted");
    case "message.recalled":
      return t("auditLogs.action.message.recalled");
    case "agent.deleted":
      return t("auditLogs.action.agent.deleted");
    case "proposal.deleted":
      return t("auditLogs.action.proposal.deleted");
    case "pairing_code.revoked":
      return t("auditLogs.action.pairing_code.revoked");
    case "pairing_code.purged_expired":
      return t("auditLogs.action.pairing_code.purged_expired");
    default:
      return assertNever(action);
  }
}
