/**
 * @module web/lib/i18n/translator
 * @description 作用域翻译器工厂、占位符插值与基于 `WeakMap` 缓存的稳定引用翻译器实例。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 引用稳定性：同一 `(catalog, locale)` 始终返回相同引用的 `{ locale, t, tp }` 对象，避免触发下游 `React.memo` 无效重渲染。
 * 2. 复数规则缓存：按 `SupportedLocale` 缓存 `Intl.PluralRules` 实例，零热路径对象分配。
 * 3. 原型安全插值：通过 `Object.prototype.hasOwnProperty` 严格匹配 `{key}`，杜绝原型链属性意外泄漏。
 */
import type { SupportedLocale } from "@openhuddle/protocol";
import { getActiveLocale, useLocale } from "./store.js";
import type {
  EmptyPluralCatalog,
  ExtractPlaceholders,
  InterpolationValue,
  MessageCatalog,
  PluralCatalog,
  ZhPluralEntry,
} from "./types.js";

const pluralRulesCache = new Map<SupportedLocale, Intl.PluralRules>();

function getPluralRules(locale: SupportedLocale): Intl.PluralRules {
  let rules = pluralRulesCache.get(locale);
  if (rules === undefined) {
    rules = new Intl.PluralRules(locale === "zh-CN" ? "zh-CN" : "en-US");
    pluralRulesCache.set(locale, rules);
  }
  return rules;
}

/**
 * 将模板字符串中的 `{key}` 占位符替换为对应参数值；未提供或缺失键保持原样。
 *
 * @param template - 含 `{key}` 占位符的文案模板
 * @param params - 插值参数字典
 * @returns 插值完成后的最终字符串
 */
export function interpolate(
  template: string,
  params?: Readonly<Record<string, InterpolationValue>>,
): string {
  if (params === undefined) {
    return template;
  }
  return template.replace(/\{([a-zA-Z0-9_]+)\}/gu, (match, key: string) => {
    if (!Object.prototype.hasOwnProperty.call(params, key)) {
      return match;
    }
    const value = params[key];
    return value === undefined ? match : String(value);
  });
}

/** 强类型普通翻译函数签名：有占位符的键必传参数，无占位符的键无需传参。 */
export type TranslateFn<Zh extends Readonly<Record<string, string>>> = <
  K extends keyof Zh & string,
>(
  ...args: [ExtractPlaceholders<Zh[K]>] extends [never]
    ? [key: K]
    : [key: K, params: Readonly<Record<ExtractPlaceholders<Zh[K]>, InterpolationValue>>]
) => string;

/** 强类型复数翻译函数签名：自动注入 `{count}`，额外占位符编译期强制传参。 */
export type PluralTranslateFn<P extends Readonly<Record<string, ZhPluralEntry>>> = <
  K extends keyof P & string,
>(
  ...args: Exclude<ExtractPlaceholders<P[K]["other"]>, "count"> extends never
    ? [key: K, count: number, params?: Readonly<Record<string, InterpolationValue>>]
    : [
        key: K,
        count: number,
        params: Readonly<
          Record<Exclude<ExtractPlaceholders<P[K]["other"]>, "count">, InterpolationValue>
        >,
      ]
) => string;

/** 绑定到具体 `SupportedLocale` 的翻译器快照。 */
export interface BoundTranslator<
  Zh extends Readonly<Record<string, string>>,
  P extends Readonly<Record<string, ZhPluralEntry>> = EmptyPluralCatalog,
> {
  readonly locale: SupportedLocale;
  readonly t: TranslateFn<Zh>;
  readonly tp: PluralTranslateFn<P>;
}

/** 作用域翻译器门面（同时服务纯工具函数与 React 组件）。 */
export interface ScopedTranslator<
  Zh extends Readonly<Record<string, string>>,
  P extends Readonly<Record<string, ZhPluralEntry>> = EmptyPluralCatalog,
> {
  /** 获取绑定到指定 `locale`（缺省取当前生效语种）的缓存翻译器实例。 */
  readonly getTranslator: (locale?: SupportedLocale) => BoundTranslator<Zh, P>;
  /** 订阅全局生效语种并返回对应稳定引用的翻译器实例。 */
  readonly useI18n: () => BoundTranslator<Zh, P>;
}

const NO_PLURAL_SENTINEL = {} as const;
const scopedTranslatorCache = new WeakMap<
  object,
  WeakMap<object, Map<SupportedLocale, BoundTranslator<Readonly<Record<string, string>>, never>>>
>();

function getOrCreateLocaleMap(
  catalogKey: object,
  pluralKey: object,
): Map<SupportedLocale, BoundTranslator<Readonly<Record<string, string>>, never>> {
  let byPlural = scopedTranslatorCache.get(catalogKey);
  if (byPlural === undefined) {
    byPlural = new WeakMap();
    scopedTranslatorCache.set(catalogKey, byPlural);
  }
  let byLocale = byPlural.get(pluralKey);
  if (byLocale === undefined) {
    byLocale = new Map();
    byPlural.set(pluralKey, byLocale);
  }
  return byLocale;
}

/**
 * 为指定双语词典（及可选复数词典）创建带 `WeakMap` 实例缓存的作用域翻译器。
 *
 * @param catalog - 通过 `defineCatalog` 定义的双语词典
 * @param pluralCatalog - 可选通过 `definePluralCatalog` 定义的双语复数词典
 * @returns `{ getTranslator, useI18n }` 翻译门面
 */
export function createScopedTranslator<
  Zh extends Readonly<Record<string, string>>,
  P extends Readonly<Record<string, ZhPluralEntry>> = EmptyPluralCatalog,
>(catalog: MessageCatalog<Zh>, pluralCatalog?: PluralCatalog<P>): ScopedTranslator<Zh, P> {
  const localeMap = getOrCreateLocaleMap(catalog, pluralCatalog ?? NO_PLURAL_SENTINEL);

  const getTranslator = (locale?: SupportedLocale): BoundTranslator<Zh, P> => {
    const resolvedLocale = locale ?? getActiveLocale();
    const cached = localeMap.get(resolvedLocale);
    if (cached !== undefined) {
      return cached as unknown as BoundTranslator<Zh, P>;
    }

    const messages: Readonly<Record<string, string>> = catalog[resolvedLocale];
    const t = ((key: string, params?: Readonly<Record<string, InterpolationValue>>): string => {
      const template = messages[key] ?? key;
      return interpolate(template, params);
    }) as TranslateFn<Zh>;

    const tp = ((
      key: string,
      count: number,
      extraParams?: Readonly<Record<string, InterpolationValue>>,
    ): string => {
      if (pluralCatalog === undefined) {
        return key;
      }
      const mergedParams: Readonly<Record<string, InterpolationValue>> =
        extraParams !== undefined ? { ...extraParams, count } : { count };
      if (resolvedLocale === "zh-CN") {
        const zhEntry = (pluralCatalog["zh-CN"] as Readonly<Record<string, ZhPluralEntry>>)[key];
        const template = zhEntry?.other ?? key;
        return interpolate(template, mergedParams);
      }
      const enEntry = (
        pluralCatalog.en as Readonly<
          Record<string, { readonly one: string; readonly other: string }>
        >
      )[key];
      if (enEntry === undefined) {
        return key;
      }
      const category = getPluralRules("en").select(count);
      const template = category === "one" ? enEntry.one : enEntry.other;
      return interpolate(template, mergedParams);
    }) as PluralTranslateFn<P>;

    const bound: BoundTranslator<Zh, P> = {
      locale: resolvedLocale,
      t,
      tp,
    };
    localeMap.set(
      resolvedLocale,
      bound as unknown as BoundTranslator<Readonly<Record<string, string>>, never>,
    );
    return bound;
  };

  const useI18n = (): BoundTranslator<Zh, P> => {
    const locale = useLocale();
    return getTranslator(locale);
  };

  return {
    getTranslator,
    useI18n,
  };
}
