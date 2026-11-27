/**
 * @module web/lib/i18n/types
 * @description 零依赖强类型国际化词典类型系统：编译期双向强制 `zh-CN` 与 `en` 键集合及 `{param}` 占位符集合完全一致。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 编译期漏键/多键/错占位符阻断：`defineCatalog` 与 `definePluralCatalog` 利用模板字面量类型在 `tsc` 阶段拦截一切中英文词典漂移。
 * 2. 零 `any`、兼容 `exactOptionalPropertyTypes` 与 `noUncheckedIndexedAccess`。
 */
import type { LanguagePreference, SupportedLocale } from "@openhuddle/protocol";

export type { LanguagePreference, SupportedLocale };

/** 插值参数允许的基础类型。 */
export type InterpolationValue = string | number;

/**
 * 从模板字面量字符串中提取所有 `{param}` 占位符键名联合类型。
 *
 * @example
 * type Keys = ExtractPlaceholders<"你好 {name}，共 {count} 条">; // "name" | "count"
 */
export type ExtractPlaceholders<S extends string> = S extends `${string}{${infer Key}}${infer Rest}`
  ? Key | ExtractPlaceholders<Rest>
  : never;

type EqualSet<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/**
 * 编译期双向校验 `Zh` 与 `En` 词典的键集合及每个键的 `{param}` 占位符集合完全一致。
 */
export type AssertMatchingCatalog<
  Zh extends Readonly<Record<string, string>>,
  En extends Readonly<Record<string, string>>,
> = {
  readonly [K in keyof Zh]: K extends keyof En
    ? EqualSet<ExtractPlaceholders<Zh[K]>, ExtractPlaceholders<En[K]>> extends true
      ? En[K]
      : {
          readonly __i18nPlaceholderMismatch: {
            readonly key: K;
            readonly zhPlaceholders: ExtractPlaceholders<Zh[K]>;
            readonly enPlaceholders: ExtractPlaceholders<En[K]>;
          };
        }
    : { readonly __i18nMissingKeyInEn: K };
} & {
  readonly [K in Exclude<keyof En, keyof Zh>]: { readonly __i18nExtraKeyInEn: K };
};

/** 强类型双语平铺消息词典结构。 */
export interface MessageCatalog<Zh extends Readonly<Record<string, string>>> {
  readonly "zh-CN": Zh;
  readonly en: Readonly<Record<keyof Zh, string>>;
}

/** 中文复数条目（仅需 `other` 形态）。 */
export interface ZhPluralEntry<Other extends string = string> {
  readonly other: Other;
}

/** 英文复数条目（需提供 `one` 与 `other` 形态）。 */
export interface EnPluralEntry<One extends string = string, Other extends string = string> {
  readonly one: One;
  readonly other: Other;
}

/** 通用复数词典条目联合类型。 */
export type PluralEntry = ZhPluralEntry | EnPluralEntry;

/**
 * 编译期双向校验复数词典的键集合与占位符兼容性：
 * - `en.other` 占位符集合必须与 `zh.other` 完全一致；
 * - `en.one` 占位符集合必须是 `zh.other` 占位符集合的子集（允许省略 `{count}` 写 `"1 item"`，禁止引入未知占位符）。
 */
export type AssertMatchingPluralCatalog<
  Zh extends Readonly<Record<string, ZhPluralEntry>>,
  En extends Readonly<Record<string, EnPluralEntry>>,
> = {
  readonly [K in keyof Zh]: K extends keyof En
    ? [ExtractPlaceholders<En[K]["one"]>] extends [ExtractPlaceholders<Zh[K]["other"]>]
      ? EqualSet<
          ExtractPlaceholders<Zh[K]["other"]>,
          ExtractPlaceholders<En[K]["other"]>
        > extends true
        ? En[K]
        : {
            readonly __i18nPluralOtherPlaceholderMismatch: {
              readonly key: K;
              readonly zhPlaceholders: ExtractPlaceholders<Zh[K]["other"]>;
              readonly enOtherPlaceholders: ExtractPlaceholders<En[K]["other"]>;
            };
          }
      : {
          readonly __i18nPluralOnePlaceholderMismatch: {
            readonly key: K;
            readonly zhPlaceholders: ExtractPlaceholders<Zh[K]["other"]>;
            readonly enOnePlaceholders: ExtractPlaceholders<En[K]["one"]>;
          };
        }
    : { readonly __i18nMissingPluralKeyInEn: K };
} & {
  readonly [K in Exclude<keyof En, keyof Zh>]: { readonly __i18nExtraPluralKeyInEn: K };
};

/** 强类型双语复数消息词典结构。 */
export interface PluralCatalog<Zh extends Readonly<Record<string, ZhPluralEntry>>> {
  readonly "zh-CN": Zh;
  readonly en: Readonly<Record<keyof Zh, EnPluralEntry>>;
}

/** 空复数词典占位类型（供不含复数条目的作用域使用）。 */
export type EmptyPluralCatalog = Readonly<Record<never, ZhPluralEntry>>;

/**
 * 定义并编译期校验一份双语平铺消息词典。
 *
 * @param zhCN - 简体中文词典对象
 * @param en - 英文词典对象（编译期校验与 `zhCN` 键集合及占位符完全一致）
 * @returns 合并后的强类型双语词典
 */
export function defineCatalog<
  const Zh extends Readonly<Record<string, string>>,
  const En extends Readonly<Record<string, string>>,
>(zhCN: Zh, en: En & AssertMatchingCatalog<Zh, En>): MessageCatalog<Zh> {
  return {
    "zh-CN": zhCN,
    en: en as unknown as Readonly<Record<keyof Zh, string>>,
  };
}

/**
 * 定义并编译期校验一份双语复数消息词典。
 *
 * @param zhCN - 简体中文复数词典（`{ other }`）
 * @param en - 英文复数词典（`{ one, other }`，编译期校验键集合与占位符完备性）
 * @returns 合并后的强类型双语复数词典
 */
export function definePluralCatalog<
  const Zh extends Readonly<Record<string, ZhPluralEntry>>,
  const En extends Readonly<Record<string, EnPluralEntry>>,
>(zhCN: Zh, en: En & AssertMatchingPluralCatalog<Zh, En>): PluralCatalog<Zh> {
  return {
    "zh-CN": zhCN,
    en: en as unknown as Readonly<Record<keyof Zh, EnPluralEntry>>,
  };
}
