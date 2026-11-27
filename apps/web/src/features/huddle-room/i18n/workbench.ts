/**
 * @module web/features/huddle-room/i18n/workbench
 * @description 单人工作台与多 Agent 工单协作域强类型双语词典与作用域翻译器。
 */
import {
  createScopedTranslator,
  defineCatalog,
  definePluralCatalog,
} from "../../../lib/i18n/index.js";
import { workbenchEn, workbenchPluralsEn } from "./workbench.en.js";
import { workbenchPluralsZhCN, workbenchZhCN } from "./workbench.zh-CN.js";

/** 工作台与多 Agent 工单双语消息词典。 */
export const workbenchCatalog = defineCatalog(workbenchZhCN, workbenchEn);

/** 工作台与多 Agent 工单双语复数词典。 */
export const workbenchPluralCatalog = definePluralCatalog(workbenchPluralsZhCN, workbenchPluralsEn);

const workbenchScoped = createScopedTranslator(workbenchCatalog, workbenchPluralCatalog);

/** 在纯工具函数与非 React Store 中获取工作台词典翻译器。 */
export const getWorkbenchTranslator = workbenchScoped.getTranslator;

/** 在 React 组件中订阅语种并获取稳定引用的工作台词典翻译器。 */
export const useWorkbenchI18n = workbenchScoped.useI18n;
