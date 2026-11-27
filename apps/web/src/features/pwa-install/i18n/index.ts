/**
 * @module web/features/pwa-install/i18n
 * @description PWA 主屏幕安装引导域双语词典与作用域翻译器导出入口。
 */
import { createScopedTranslator, defineCatalog } from "../../../lib/i18n/index.js";
import { pwaInstallEn } from "./en.js";
import { pwaInstallZhCN } from "./zh-CN.js";

/** PWA 安装引导域平铺消息词典 */
export const pwaInstallCatalog = defineCatalog(pwaInstallZhCN, pwaInstallEn);

const pwaInstallScoped = createScopedTranslator(pwaInstallCatalog);

/** 在纯工具函数（如平台识别引擎）中获取 PWA 域翻译器 */
export const getPwaInstallTranslator = pwaInstallScoped.getTranslator;

/** 在 React 组件中订阅语种并获取稳定引用的 PWA 域翻译器 */
export const usePwaInstallI18n = pwaInstallScoped.useI18n;
