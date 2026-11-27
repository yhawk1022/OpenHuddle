/**
 * @module web/features/huddle-room/i18n/chat-detail
 * @description 聊天详情域强类型双语翻译器与共享错误本地化解析。
 */
import type { SupportedLocale } from "@openhuddle/protocol";
import { ApiClientError } from "../../../lib/api-client.js";
import {
  createScopedTranslator,
  defineCatalog,
  definePluralCatalog,
  formatApiErrorMessage,
} from "../../../lib/i18n/index.js";
import { chatDetailEn, chatDetailPluralsEn } from "./chat-detail.en.js";
import { chatDetailPluralsZhCN, chatDetailZhCN } from "./chat-detail.zh-CN.js";

/** 聊天详情域双语消息词典。 */
export const chatDetailCatalog = defineCatalog(chatDetailZhCN, chatDetailEn);

/** 聊天详情域双语复数词典。 */
export const chatDetailPluralCatalog = definePluralCatalog(
  chatDetailPluralsZhCN,
  chatDetailPluralsEn,
);

const chatDetailScoped = createScopedTranslator(chatDetailCatalog, chatDetailPluralCatalog);

/** 在非 React 工具函数中获取聊天详情域翻译器。 */
export const getChatDetailTranslator = chatDetailScoped.getTranslator;

/** 在 React 组件中订阅语种并获取稳定引用的聊天详情域翻译器。 */
export const useChatDetailI18n = chatDetailScoped.useI18n;

/** 聊天详情域翻译器实例类型。 */
export type ChatDetailTranslator = ReturnType<typeof getChatDetailTranslator>;

function isClientTransportRequestId(requestId: string): boolean {
  return requestId === "timeout" || requestId === "network" || requestId === "gateway";
}

/**
 * 将客户端或服务端异常统一解析为当前语种可读文案。
 */
export function resolveChatDetailErrorMessage(
  error: unknown,
  locale?: SupportedLocale,
): string | null {
  if (error instanceof ApiClientError) {
    return isClientTransportRequestId(error.requestId)
      ? error.message
      : formatApiErrorMessage(error.code, error.message, locale);
  }
  if (error instanceof Error) {
    return error.message;
  }
  return null;
}
