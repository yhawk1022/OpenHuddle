/**
 * @module web/lib/i18n/formatters
 * @description 带 `Map` 缓存的 locale 感知日期、时间、数字与紧凑耗时格式化工具集。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 零热路径 `Intl.*` 重复构造：所有 `Intl.DateTimeFormat` 与 `Intl.NumberFormat` 按 `(intlLocale, options)` 缓存复用。
 * 2. 纯函数可测：所有函数支持可选显式 `locale?: SupportedLocale` 参数，缺省自动读取当前生效语种。
 */
import type { SupportedLocale } from "@openhuddle/protocol";
import { getActiveLocale } from "./store.js";

const dateTimeFormatCache = new Map<string, Intl.DateTimeFormat>();
const numberFormatCache = new Map<string, Intl.NumberFormat>();

function toIntlLocale(locale?: SupportedLocale): "zh-CN" | "en-US" {
  return (locale ?? getActiveLocale()) === "zh-CN" ? "zh-CN" : "en-US";
}

function stableOptionsKey(options?: Readonly<Record<string, unknown>>): string {
  if (options === undefined) {
    return "";
  }
  const entries = Object.entries(options)
    .filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(entries);
}

function getDateTimeFormatter(
  intlLocale: "zh-CN" | "en-US",
  options?: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  const key = `${intlLocale}|${stableOptionsKey(options as Readonly<Record<string, unknown>> | undefined)}`;
  let formatter = dateTimeFormatCache.get(key);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat(intlLocale, options);
    dateTimeFormatCache.set(key, formatter);
  }
  return formatter;
}

function getNumberFormatter(
  intlLocale: "zh-CN" | "en-US",
  options?: Intl.NumberFormatOptions,
): Intl.NumberFormat {
  const key = `${intlLocale}|${stableOptionsKey(options as Readonly<Record<string, unknown>> | undefined)}`;
  let formatter = numberFormatCache.get(key);
  if (formatter === undefined) {
    formatter = new Intl.NumberFormat(intlLocale, options);
    numberFormatCache.set(key, formatter);
  }
  return formatter;
}

function normalizeDate(value: Date | string | number): Date | null {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * 按当前或指定语种格式化日期（默认年-月-日短格式）。
 */
export function formatDate(
  value: Date | string | number,
  options?: Intl.DateTimeFormatOptions,
  locale?: SupportedLocale,
): string {
  const date = normalizeDate(value);
  if (date === null) {
    return typeof value === "string" ? value : "";
  }
  const intlLocale = toIntlLocale(locale);
  const resolvedOptions: Intl.DateTimeFormatOptions = options ?? {
    year: "numeric",
    month: "short",
    day: "numeric",
  };
  return getDateTimeFormatter(intlLocale, resolvedOptions).format(date);
}

/**
 * 按当前或指定语种格式化时刻（默认 24 小时制 `HH:mm`）。
 */
export function formatTime(
  value: Date | string | number,
  options?: Intl.DateTimeFormatOptions,
  locale?: SupportedLocale,
): string {
  const date = normalizeDate(value);
  if (date === null) {
    return typeof value === "string" ? value : "";
  }
  const intlLocale = toIntlLocale(locale);
  const resolvedOptions: Intl.DateTimeFormatOptions = options ?? {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  };
  return getDateTimeFormatter(intlLocale, resolvedOptions).format(date);
}

/**
 * 按当前或指定语种格式化日期与时刻。
 */
export function formatDateTime(
  value: Date | string | number,
  options?: Intl.DateTimeFormatOptions,
  locale?: SupportedLocale,
): string {
  const date = normalizeDate(value);
  if (date === null) {
    return typeof value === "string" ? value : "";
  }
  const intlLocale = toIntlLocale(locale);
  const resolvedOptions: Intl.DateTimeFormatOptions = options ?? {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  };
  return getDateTimeFormatter(intlLocale, resolvedOptions).format(date);
}

/**
 * 按当前或指定语种格式化数字。
 */
export function formatNumber(
  value: number,
  options?: Intl.NumberFormatOptions,
  locale?: SupportedLocale,
): string {
  if (!Number.isFinite(value)) {
    return String(value);
  }
  return getNumberFormatter(toIntlLocale(locale), options).format(value);
}

/**
 * 将毫秒级耗时格式化为面向界面的紧凑可读时长（如 `420ms` / `12s` / `3m 20s` 或 `12 秒` / `3 分 20 秒`）。
 */
export function formatCompactDuration(ms: number, locale?: SupportedLocale): string {
  const effectiveLocale = locale ?? getActiveLocale();
  if (!Number.isFinite(ms) || ms < 0) {
    /* i18n-ignore */
    return effectiveLocale === "zh-CN" ? "0 秒" : "0s";
  }
  if (ms < 1_000) {
    return `${Math.round(ms)}ms`;
  }
  const totalSeconds = Math.round(ms / 1_000);
  if (totalSeconds < 60) {
    /* i18n-ignore */
    return effectiveLocale === "zh-CN" ? `${totalSeconds} 秒` : `${totalSeconds}s`;
  }
  const totalMinutes = Math.floor(totalSeconds / 60);
  const remSeconds = totalSeconds % 60;
  if (totalMinutes < 60) {
    if (remSeconds === 0) {
      /* i18n-ignore */
      return effectiveLocale === "zh-CN" ? `${totalMinutes} 分钟` : `${totalMinutes}m`;
    }
    return effectiveLocale === "zh-CN"
      ? /* i18n-ignore */ `${totalMinutes} 分 ${remSeconds} 秒`
      : `${totalMinutes}m ${remSeconds}s`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const remMinutes = totalMinutes % 60;
  if (remMinutes === 0) {
    /* i18n-ignore */
    return effectiveLocale === "zh-CN" ? `${hours} 小时` : `${hours}h`;
  }
  return effectiveLocale === "zh-CN"
    ? /* i18n-ignore */ `${hours} 小时 ${remMinutes} 分`
    : `${hours}h ${remMinutes}m`;
}
