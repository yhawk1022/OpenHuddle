/**
 * @module web/lib/i18n/resolve-locale
 * @description 纯函数语言偏好解析器（Rule L）：BCP 47 语言优先、地区与时区兜底、非浏览器环境确定性回落 `"en"`。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 语言优先于地区与时区：例如 `["en-US", "zh-CN"]` 或 `en-CN` 必须稳定解析为 `"en"`，绝不被中国时区劫持。
 * 2. 扩展段免疫：解析 BCP 47 地区子标时遇到 `-u-` / `-x-` 等单字符扩展段立即停止，避免将扩展令牌误判为地区代码。
 * 3. 非浏览器环境确定性：Node / SSR 下不读取 `globalThis.navigator`，避免 CI 与本机语言/时区配置引发漂移。
 */
import type { LanguagePreference, SupportedLocale } from "@openhuddle/protocol";

/** 可注入的运行时语言环境快照（缺省时在浏览器内自动采样）。 */
export interface LocaleEnvironment {
  /** 是否按浏览器环境解析；传入 `false` 直接返回 `"en"` */
  readonly isBrowser?: boolean | undefined;
  /** 对应 `navigator.languages` */
  readonly languages?: ReadonlyArray<string> | undefined;
  /** 对应 `navigator.language` */
  readonly language?: string | undefined;
  /** 对应 `Intl.DateTimeFormat().resolvedOptions().locale` */
  readonly intlLocale?: string | undefined;
  /** 对应 `Intl.DateTimeFormat().resolvedOptions().timeZone` */
  readonly timeZone?: string | undefined;
}

const CHINESE_PRIMARY_LANGUAGES: ReadonlySet<string> = new Set([
  "zh",
  "cmn",
  "yue",
  "wuu",
  "nan",
  "hak",
  "hsn",
  "gan",
]);

const CHINESE_REGIONS: ReadonlySet<string> = new Set(["CN", "HK", "MO", "TW"]);

const CHINESE_TIMEZONES: ReadonlySet<string> = new Set([
  "Asia/Shanghai",
  "Asia/Chongqing",
  "Asia/Harbin",
  "Asia/Urumqi",
  "Asia/Kashgar",
  "Asia/Hong_Kong",
  "Asia/Macau",
  "Asia/Taipei",
  "PRC",
  "ROC",
  "Hongkong",
  "Asia/Macao",
  "Asia/Chungking",
]);

interface ParsedBcp47Tag {
  readonly primary: string;
  readonly region: string | null;
}

function parseBcp47Tag(rawTag: string): ParsedBcp47Tag | null {
  const normalized = rawTag.trim().replace(/_/gu, "-");
  if (normalized.length === 0) {
    return null;
  }
  const subtags = normalized.split("-").filter((part) => part.length > 0);
  const primary = subtags[0]?.toLowerCase() ?? "";
  if (primary.length === 0) {
    return null;
  }

  let region: string | null = null;
  for (let i = 1; i < subtags.length; i += 1) {
    const subtag = subtags[i];
    if (subtag === undefined) {
      continue;
    }
    // 单字符子标表示 BCP 47 扩展段（-u- / -t-）或私用段（-x-）开始，后续均非地区子标
    if (subtag.length === 1) {
      break;
    }
    if (/^[a-z]{2}$/iu.test(subtag)) {
      region = subtag.toUpperCase();
      break;
    }
  }

  return { primary, region };
}

function matchSupportedPrimary(primary: string): SupportedLocale | null {
  if (CHINESE_PRIMARY_LANGUAGES.has(primary)) {
    return "zh-CN";
  }
  if (primary === "en") {
    return "en";
  }
  return null;
}

function readBrowserEnvironment(): LocaleEnvironment {
  let languages: ReadonlyArray<string> | undefined;
  let language: string | undefined;
  if (typeof navigator !== "undefined") {
    if (Array.isArray(navigator.languages)) {
      languages = navigator.languages;
    }
    if (typeof navigator.language === "string") {
      language = navigator.language;
    }
  }

  let intlLocale: string | undefined;
  let timeZone: string | undefined;
  try {
    const resolved = Intl.DateTimeFormat().resolvedOptions();
    if (typeof resolved.locale === "string") {
      intlLocale = resolved.locale;
    }
    if (typeof resolved.timeZone === "string") {
      timeZone = resolved.timeZone;
    }
  } catch {
    // 某些受限运行环境不支持 Intl.DateTimeFormat，安全回退至空
  }

  return {
    isBrowser: true,
    languages,
    language,
    intlLocale,
    timeZone,
  };
}

/**
 * 按 Rule L 将账号或访客语言偏好解析为最终生效的 `SupportedLocale`（`"zh-CN"` | `"en"`）。
 *
 * @param preference - 显式偏好（`"zh-CN"` / `"en"`）或 `"auto"`
 * @param env - 可选注入环境（单测时显式传入，避免读取宿主环境）
 * @returns 确定性生效语种
 */
export function resolveLocale(
  preference: LanguagePreference,
  env?: LocaleEnvironment,
): SupportedLocale {
  if (preference === "zh-CN" || preference === "en") {
    return preference;
  }

  if ((env === undefined && typeof window === "undefined") || env?.isBrowser === false) {
    return "en";
  }

  const effectiveEnv = env ?? readBrowserEnvironment();
  const candidateTags: ReadonlyArray<string> =
    effectiveEnv.languages !== undefined && effectiveEnv.languages.length > 0
      ? effectiveEnv.languages
      : effectiveEnv.language !== undefined && effectiveEnv.language.trim().length > 0
        ? [effectiveEnv.language]
        : [];

  let sawChineseRegion = false;

  // 1. 按浏览器首选语言列表顺序优先匹配受支持语种，同时记录其他语种的中文地区子标
  for (const tag of candidateTags) {
    const parsed = parseBcp47Tag(tag);
    if (parsed === null) {
      continue;
    }
    const matched = matchSupportedPrimary(parsed.primary);
    if (matched !== null) {
      return matched;
    }
    if (parsed.region !== null && CHINESE_REGIONS.has(parsed.region)) {
      sawChineseRegion = true;
    }
  }

  // 2. 首选语言均未命中受支持语种时，检查 Intl 默认 locale
  if (effectiveEnv.intlLocale !== undefined) {
    const parsedIntl = parseBcp47Tag(effectiveEnv.intlLocale);
    if (parsedIntl !== null) {
      const matchedIntl = matchSupportedPrimary(parsedIntl.primary);
      if (matchedIntl !== null) {
        return matchedIntl;
      }
      if (parsedIntl.region !== null && CHINESE_REGIONS.has(parsedIntl.region)) {
        sawChineseRegion = true;
      }
    }
  }

  // 3. 地区子标或中国区时区兜底
  if (sawChineseRegion) {
    return "zh-CN";
  }
  if (effectiveEnv.timeZone !== undefined && CHINESE_TIMEZONES.has(effectiveEnv.timeZone)) {
    return "zh-CN";
  }

  return "en";
}
