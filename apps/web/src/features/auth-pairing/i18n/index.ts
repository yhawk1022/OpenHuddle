/**
 * @module web/features/auth-pairing/i18n
 * @description `auth-pairing` 业务域强类型双语词典与作用域翻译器导出入口（拆分 `auth`、`portal`、`onboarding` 三组以维持编译性能）。
 */
import {
  createScopedTranslator,
  defineCatalog,
  definePluralCatalog,
} from "../../../lib/i18n/index.js";
import { authEn, authPluralEn } from "./auth.en.js";
import { authPluralZhCN, authZhCN } from "./auth.zh-CN.js";
import { onboardingEn } from "./onboarding.en.js";
import { onboardingZhCN } from "./onboarding.zh-CN.js";
import { portalEn } from "./portal.en.js";
import { portalZhCN } from "./portal.zh-CN.js";

/** 首页门户顶栏、认证表单与已登录空间卡双语词典。 */
export const authCatalog = defineCatalog(authZhCN, authEn);
export const authPluralCatalog = definePluralCatalog(authPluralZhCN, authPluralEn);
const authScoped = createScopedTranslator(authCatalog, authPluralCatalog);
export const getAuthTranslator = authScoped.getTranslator;
export const useAuthI18n = authScoped.useI18n;

/** 门户展示区块、双模预览器与右键菜单双语词典。 */
export const portalCatalog = defineCatalog(portalZhCN, portalEn);
const portalScoped = createScopedTranslator(portalCatalog);
export const getPortalTranslator = portalScoped.getTranslator;
export const usePortalI18n = portalScoped.useI18n;

/** Agent 接入弹窗、邀请进群与接入指令生成器双语词典。 */
export const onboardingCatalog = defineCatalog(onboardingZhCN, onboardingEn);
const onboardingScoped = createScopedTranslator(onboardingCatalog);
export const getOnboardingTranslator = onboardingScoped.getTranslator;
export const useOnboardingI18n = onboardingScoped.useI18n;
