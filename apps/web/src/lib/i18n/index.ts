/**
 * @module web/lib/i18n
 * @description OpenHuddle Web 端零依赖强类型国际化基础设施公共导出门面（仅具名导出）。
 */
import { commonEn } from "./messages/common.en.js";
import { commonZhCN } from "./messages/common.zh-CN.js";
import { createScopedTranslator } from "./translator.js";
import { defineCatalog } from "./types.js";

/** 全站共享双语词典（通用操作、外观/语言/刷新率、账号设置、平台描述与可达性状态）。 */
export const commonCatalog = defineCatalog(commonZhCN, commonEn);

const commonScoped = createScopedTranslator(commonCatalog);

/** 在非 React 纯工具函数中获取共享词典翻译器。 */
export const getCommonTranslator = commonScoped.getTranslator;

/** 在 React 组件中订阅语种并获取稳定引用的共享词典翻译器。 */
export const useCommonI18n = commonScoped.useI18n;

export {
  errorsCatalog,
  formatApiErrorMessage,
  formatBackendUnavailableMessage,
  formatHttpFailedMessage,
  formatNetworkFailedMessage,
  formatNetworkTimeoutMessage,
} from "./error-messages.js";
export {
  formatCompactDuration,
  formatDate,
  formatDateTime,
  formatNumber,
  formatTime,
} from "./formatters.js";
export { resolveLocale, type LocaleEnvironment } from "./resolve-locale.js";
export {
  GUEST_LANGUAGE_STORAGE_KEY,
  LAST_ACCOUNT_LANGUAGE_STORAGE_KEY,
  clearLastAccountLanguagePreference,
  getActiveLocale,
  readGuestLanguagePreference,
  readLastAccountLanguagePreference,
  resolveAppRootLanguagePreference,
  setActiveLocaleForTest,
  setGuestLanguagePreference,
  setLastAccountLanguagePreference,
  startLocaleSync,
  syncDocumentTitle,
  useGuestLanguagePreference,
  useLocale,
  withLocale,
} from "./store.js";
export {
  createScopedTranslator,
  interpolate,
  type BoundTranslator,
  type PluralTranslateFn,
  type ScopedTranslator,
  type TranslateFn,
} from "./translator.js";
export {
  defineCatalog,
  definePluralCatalog,
  type AssertMatchingCatalog,
  type AssertMatchingPluralCatalog,
  type EmptyPluralCatalog,
  type EnPluralEntry,
  type ExtractPlaceholders,
  type InterpolationValue,
  type LanguagePreference,
  type MessageCatalog,
  type PluralCatalog,
  type PluralEntry,
  type SupportedLocale,
  type ZhPluralEntry,
} from "./types.js";
