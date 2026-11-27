/**
 * @module web/components/i18n
 * @description 基础原语与通用 UI 组件双语词典与作用域翻译器导出入口。
 */
import {
  createScopedTranslator,
  defineCatalog,
  definePluralCatalog,
} from "../../lib/i18n/index.js";
import { componentsEn, componentsPluralEn } from "./en.js";
import { componentsPluralZhCN, componentsZhCN } from "./zh-CN.js";

/** 基础组件域平铺消息词典 */
export const componentsCatalog = defineCatalog(componentsZhCN, componentsEn);

/** 基础组件域复数消息词典 */
export const componentsPluralCatalog = definePluralCatalog(
  componentsPluralZhCN,
  componentsPluralEn,
);

const componentsScoped = createScopedTranslator(componentsCatalog, componentsPluralCatalog);

/** 在纯工具函数中获取基础组件域翻译器 */
export const getComponentsTranslator = componentsScoped.getTranslator;

/** 在 React 组件中订阅语种并获取稳定引用的基础组件域翻译器 */
export const useComponentsI18n = componentsScoped.useI18n;
