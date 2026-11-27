/**
 * @module web/lib/i18n/error-messages
 * @description 对 `@openhuddle/protocol` 全部 `ErrorCode` 执行编译期穷尽翻译（`switch` + `assertNever`），并提供网络层本地化提示。
 */
import { type ErrorCode, type SupportedLocale, assertNever } from "@openhuddle/protocol";
import { errorsEn } from "./messages/errors.en.js";
import { errorsZhCN } from "./messages/errors.zh-CN.js";
import { createScopedTranslator } from "./translator.js";
import { defineCatalog } from "./types.js";

/** 全站 API 错误码与网络层双语词典。 */
export const errorsCatalog = defineCatalog(errorsZhCN, errorsEn);

const errorsI18n = createScopedTranslator(errorsCatalog);

type ErrorCodeCatalogKey = Extract<keyof typeof errorsZhCN, `code.${string}`>;

function resolveErrorCodeKey(code: ErrorCode): ErrorCodeCatalogKey {
  switch (code) {
    case "VALIDATION_ERROR":
      return "code.VALIDATION_ERROR";
    case "UNAUTHORIZED":
      return "code.UNAUTHORIZED";
    case "INVALID_CREDENTIALS":
      return "code.INVALID_CREDENTIALS";
    case "EMAIL_ALREADY_REGISTERED":
      return "code.EMAIL_ALREADY_REGISTERED";
    case "SIGNUP_DISABLED":
      return "code.SIGNUP_DISABLED";
    case "EMAIL_DOMAIN_NOT_ALLOWED":
      return "code.EMAIL_DOMAIN_NOT_ALLOWED";
    case "OTP_INVALID_OR_EXPIRED":
      return "code.OTP_INVALID_OR_EXPIRED";
    case "OTP_ATTEMPTS_EXCEEDED":
      return "code.OTP_ATTEMPTS_EXCEEDED";
    case "AUTH_RATE_LIMITED":
      return "code.AUTH_RATE_LIMITED";
    case "EMAIL_DELIVERY_FAILED":
      return "code.EMAIL_DELIVERY_FAILED";
    case "EMAIL_DELIVERY_UNAVAILABLE":
      return "code.EMAIL_DELIVERY_UNAVAILABLE";
    case "FORBIDDEN_NOT_OWNER":
      return "code.FORBIDDEN_NOT_OWNER";
    case "FORBIDDEN_NOT_ROOM_MEMBER":
      return "code.FORBIDDEN_NOT_ROOM_MEMBER";
    case "FORBIDDEN_NOT_FRIENDS":
      return "code.FORBIDDEN_NOT_FRIENDS";
    case "FORBIDDEN_EXTERNAL_AGENT_DM_DISABLED":
      return "code.FORBIDDEN_EXTERNAL_AGENT_DM_DISABLED";
    case "FORBIDDEN_ADMIN_ONLY":
      return "code.FORBIDDEN_ADMIN_ONLY";
    case "ACCOUNT_SUSPENDED":
      return "code.ACCOUNT_SUSPENDED";
    case "ADMIN_GUARDRAIL_VIOLATION":
      return "code.ADMIN_GUARDRAIL_VIOLATION";
    case "CANNOT_FRIEND_SELF":
      return "code.CANNOT_FRIEND_SELF";
    case "DIRECT_ROOM_IMMUTABLE_ROSTER":
      return "code.DIRECT_ROOM_IMMUTABLE_ROSTER";
    case "NOT_FOUND":
      return "code.NOT_FOUND";
    case "PAIRING_CODE_INVALID_OR_EXPIRED":
      return "code.PAIRING_CODE_INVALID_OR_EXPIRED";
    case "AGENT_ALREADY_ACTIVE":
      return "code.AGENT_ALREADY_ACTIVE";
    case "CONFLICT_UNREAD_MESSAGES":
      return "code.CONFLICT_UNREAD_MESSAGES";
    case "GOVERNANCE_BUDGET_PAUSED":
      return "code.GOVERNANCE_BUDGET_PAUSED";
    case "GOVERNANCE_COOLDOWN_ACTIVE":
      return "code.GOVERNANCE_COOLDOWN_ACTIVE";
    case "GOVERNANCE_ROUND_TABLE_WAIT":
      return "code.GOVERNANCE_ROUND_TABLE_WAIT";
    case "MESSAGE_RECALL_WINDOW_EXPIRED":
      return "code.MESSAGE_RECALL_WINDOW_EXPIRED";
    case "ATTENTION_HUMAN_ONLY":
      return "code.ATTENTION_HUMAN_ONLY";
    case "FORBIDDEN_WORKSPACE_ACCESS":
      return "code.FORBIDDEN_WORKSPACE_ACCESS";
    case "WORK_PATH_CONFLICT":
      return "code.WORK_PATH_CONFLICT";
    case "WORK_LEASE_EXPIRED":
      return "code.WORK_LEASE_EXPIRED";
    case "WORK_INVALID_TRANSITION":
      return "code.WORK_INVALID_TRANSITION";
    case "INTERNAL_SERVER_ERROR":
      return "code.INTERNAL_SERVER_ERROR";
    default:
      return assertNever(code);
  }
}

/**
 * 将协议标准 `ErrorCode` 翻译为当前或指定语种的用户可读提示。
 *
 * @param code - 平台标准 `ErrorCode`
 * @param fallbackMessage - 兜底错误消息（当翻译不可用时回退）
 * @param locale - 可选显式语种（缺省取全局生效语种）
 * @returns 本地化错误提示文案
 */
export function formatApiErrorMessage(
  code: ErrorCode,
  fallbackMessage?: string,
  locale?: SupportedLocale,
): string {
  const key = resolveErrorCodeKey(code);
  const translated = errorsI18n.getTranslator(locale).t(key);
  if (translated.length > 0) {
    return translated;
  }
  return fallbackMessage ?? code;
}

/** 格式化客户端请求超时提示。 */
export function formatNetworkTimeoutMessage(seconds: number, locale?: SupportedLocale): string {
  return errorsI18n.getTranslator(locale).t("network.timeout", { seconds });
}

/** 格式化客户端网络连接失败提示。 */
export function formatNetworkFailedMessage(locale?: SupportedLocale): string {
  return errorsI18n.getTranslator(locale).t("network.failed");
}

/** 格式化网关/后端重启 5xx 无响应体提示。 */
export function formatBackendUnavailableMessage(status: number, locale?: SupportedLocale): string {
  return errorsI18n.getTranslator(locale).t("network.backendUnavailable", { status });
}

/** 格式化通用非 2xx HTTP 状态错误提示。 */
export function formatHttpFailedMessage(status: number, locale?: SupportedLocale): string {
  return errorsI18n.getTranslator(locale).t("network.httpFailed", { status });
}
