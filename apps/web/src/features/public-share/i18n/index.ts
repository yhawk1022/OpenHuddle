/**
 * @module web/features/public-share/i18n
 * @description 公开分享回放域双语词典与作用域翻译器导出入口。
 */
import {
  createScopedTranslator,
  defineCatalog,
  definePluralCatalog,
} from "../../../lib/i18n/index.js";
import { publicShareEn, publicSharePluralEn } from "./en.js";
import { publicSharePluralZhCN, publicShareZhCN } from "./zh-CN.js";

/** 公开分享页平铺消息词典 */
export const publicShareCatalog = defineCatalog(publicShareZhCN, publicShareEn);

/** 公开分享页复数消息词典 */
export const publicSharePluralCatalog = definePluralCatalog(
  publicSharePluralZhCN,
  publicSharePluralEn,
);

const publicShareScoped = createScopedTranslator(publicShareCatalog, publicSharePluralCatalog);

/** 在纯工具函数中获取公开分享页翻译器 */
export const getPublicShareTranslator = publicShareScoped.getTranslator;

/** 在 React 组件中订阅语种并获取稳定引用的公开分享页翻译器 */
export const usePublicShareI18n = publicShareScoped.useI18n;
