/**
 * @module server/infra/locale
 * @description 遵循 RFC 9110 §12.5.4 的 HTTP `Accept-Language` 语言协商纯函数解析器。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 纯函数零副作用：仅依赖入参请求头与回退语言，返回协议支持的 `"zh-CN"` 或 `"en"`。
 * 2. 兼容老客户端与测试基线：当请求头缺失、为空或全部项无效/`*` 时，默认回退 `"zh-CN"`。
 * 3. 两阶段匹配策略：按权重稳定降序优先匹配中文语族或英文主语言；均未命中时再检查 BCP 47 中文地区子标（`CN`/`HK`/`MO`/`TW`），其余语种统一回退 `"en"`。
 */
import type { SupportedLocale } from "@openhuddle/protocol";

const LANGUAGE_TAG_REGEX = /^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/i;
const QVALUE_REGEX = /^(?:0(?:\.\d*)?|1(?:\.0*)?)$/;

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

const CHINESE_REGION_SUBTAGS: ReadonlySet<string> = new Set(["cn", "hk", "mo", "tw"]);

interface ParsedLanguageRange {
  readonly primary: string;
  readonly subtags: readonly string[];
  readonly q: number;
  readonly index: number;
}

function parseLanguageEntry(rawItem: string, index: number): ParsedLanguageRange | undefined {
  const parts = rawItem.split(";");
  const rawTag = parts[0]?.trim() ?? "";
  if (rawTag.length === 0 || rawTag === "*" || !LANGUAGE_TAG_REGEX.test(rawTag)) {
    return undefined;
  }

  let q = 1;
  let seenQ = false;

  for (let i = 1; i < parts.length; i += 1) {
    const param = parts[i]?.trim() ?? "";
    if (param.length === 0) {
      continue;
    }
    const eqIdx = param.indexOf("=");
    if (eqIdx < 0) {
      if (param.toLowerCase() === "q") {
        return undefined;
      }
      continue;
    }
    const key = param.slice(0, eqIdx).trim().toLowerCase();
    const value = param.slice(eqIdx + 1).trim();
    if (key === "q") {
      if (seenQ || !QVALUE_REGEX.test(value)) {
        return undefined;
      }
      seenQ = true;
      q = Number(value);
    }
  }

  if (!Number.isFinite(q) || q <= 0 || q > 1) {
    return undefined;
  }

  const subtags = rawTag.toLowerCase().split("-");
  const primary = subtags[0];
  if (primary === undefined) {
    return undefined;
  }

  return { primary, subtags, q, index };
}

function hasChineseRegionSubtag(subtags: readonly string[]): boolean {
  // BCP 47 语法中，位于主语言之后且在单字符扩展/私用子标（如 -u- / -x-）之前的 2 字母子标恒为地区子标
  for (let i = 1; i < subtags.length; i += 1) {
    const subtag = subtags[i];
    if (subtag === undefined) {
      continue;
    }
    if (subtag.length === 1) {
      break;
    }
    if (subtag.length === 2 && CHINESE_REGION_SUBTAGS.has(subtag)) {
      return true;
    }
  }
  return false;
}

/**
 * 解析 HTTP `Accept-Language` 请求头并协商为 OpenHuddle 支持的语言（`"zh-CN"` 或 `"en"`）。
 *
 * @param headerValue - 原始 `Accept-Language` 请求头字符串
 * @param fallback - 当请求头缺失、为空或仅包含无效/`*` 项时的回退语言（默认 `"zh-CN"`）
 * @returns 协商后的支持语言标识
 */
export function parseAcceptLanguage(
  headerValue: string | undefined,
  fallback: SupportedLocale = "zh-CN",
): SupportedLocale {
  if (headerValue === undefined || headerValue.trim().length === 0) {
    return fallback;
  }

  const entries: ParsedLanguageRange[] = [];
  const rawItems = headerValue.split(",");
  for (let i = 0; i < rawItems.length; i += 1) {
    const rawItem = rawItems[i];
    if (rawItem === undefined) {
      continue;
    }
    const parsed = parseLanguageEntry(rawItem, i);
    if (parsed !== undefined) {
      entries.push(parsed);
    }
  }

  if (entries.length === 0) {
    return fallback;
  }

  entries.sort((a, b) => (b.q !== a.q ? b.q - a.q : a.index - b.index));

  for (const entry of entries) {
    if (CHINESE_PRIMARY_LANGUAGES.has(entry.primary)) {
      return "zh-CN";
    }
    if (entry.primary === "en") {
      return "en";
    }
  }

  for (const entry of entries) {
    if (hasChineseRegionSubtag(entry.subtags)) {
      return "zh-CN";
    }
  }

  return "en";
}
