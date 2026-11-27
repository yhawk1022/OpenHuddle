/**
 * @module web/lib/i18n/store
 * @description Web 端国际化外部状态源：双槽 `localStorage` 隔离、首帧零闪烁初始化、`<html lang>` / `<title>` 同步、跨标签广播与 Vitest `renderToStaticMarkup` 测试辅助。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 双槽严格隔离：访客偏好存 `oh_guest_lang`，已登录账号缓存镜像存 `oh_last_account_lang`；登出仅清理账号槽，绝不覆盖访客选择。
 * 2. 首帧零闪烁：模块加载期按 `oh_session_token` 是否存在同步确定初始 `activeLocale`，与 `index.html` 内联脚本保持同构。
 * 3. `renderToStaticMarkup` 兼容：`useLocale()` 将 `getActiveLocale` 同时传入 `getSnapshot` 与 `getServerSnapshot`，使 `withLocale` 在 SSR/Vitest 中即时生效。
 */
import type { LanguagePreference, SupportedLocale } from "@openhuddle/protocol";
import { useSyncExternalStore } from "react";
import { getStoredSessionToken } from "../session-store.js";
import { resolveLocale } from "./resolve-locale.js";

/** 未登录访客及公开分享页的本地语言偏好存储键。 */
export const GUEST_LANGUAGE_STORAGE_KEY = "oh_guest_lang";

/** 已登录人类账号最近一次确认的语言偏好缓存镜像键（供首帧防闪烁读取，登出时清除）。 */
export const LAST_ACCOUNT_LANGUAGE_STORAGE_KEY = "oh_last_account_lang";

type StoreListener = () => void;

const localeListeners = new Set<StoreListener>();
const guestPrefListeners = new Set<StoreListener>();

function parseLanguagePreference(raw: string | null): LanguagePreference | null {
  if (raw === "auto" || raw === "zh-CN" || raw === "en") {
    return raw;
  }
  return null;
}

function readStorageItem(key: string): string | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    return window.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeStorageItem(key: string, value: string): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage?.setItem(key, value);
  } catch {
    // 忽略无痕/受限环境 localStorage 异常
  }
}

function removeStorageItem(key: string): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage?.removeItem(key);
  } catch {
    // 忽略无痕/受限环境 localStorage 异常
  }
}

/**
 * 读取访客语言偏好槽（`oh_guest_lang`），缺省或非法值回退为 `"auto"`。
 */
export function readGuestLanguagePreference(): LanguagePreference {
  return parseLanguagePreference(readStorageItem(GUEST_LANGUAGE_STORAGE_KEY)) ?? "auto";
}

/**
 * 读取已登录账号语言偏好缓存镜像槽（`oh_last_account_lang`），缺省或非法值返回 `null`。
 */
export function readLastAccountLanguagePreference(): LanguagePreference | null {
  return parseLanguagePreference(readStorageItem(LAST_ACCOUNT_LANGUAGE_STORAGE_KEY));
}

function applyLocaleToDocument(locale: SupportedLocale): void {
  if (typeof document === "undefined" || !document.documentElement) {
    return;
  }
  if (document.documentElement.lang !== locale) {
    document.documentElement.lang = locale;
  }
}

function computeInitialLocale(): SupportedLocale {
  if (typeof window === "undefined") {
    return "en";
  }
  const hasSession = getStoredSessionToken() !== null;
  const pref: LanguagePreference = hasSession
    ? (readLastAccountLanguagePreference() ?? readGuestLanguagePreference())
    : readGuestLanguagePreference();
  return resolveLocale(pref);
}

let activeLocale: SupportedLocale = computeInitialLocale();
if (typeof window !== "undefined") {
  applyLocaleToDocument(activeLocale);
}

function notifyLocaleListeners(): void {
  for (const listener of localeListeners) {
    listener();
  }
}

function notifyGuestPrefListeners(): void {
  for (const listener of guestPrefListeners) {
    listener();
  }
}

function setActiveLocaleInternal(next: SupportedLocale, syncDom: boolean): void {
  if (syncDom) {
    applyLocaleToDocument(next);
  }
  if (activeLocale !== next) {
    activeLocale = next;
    notifyLocaleListeners();
  }
}

/**
 * 获取当前全局生效的界面语种（`"zh-CN"` | `"en"`）。
 */
export function getActiveLocale(): SupportedLocale {
  return activeLocale;
}

function subscribeLocale(listener: StoreListener): () => void {
  localeListeners.add(listener);
  return () => {
    localeListeners.delete(listener);
  };
}

/**
 * React Hook：响应式订阅当前全局生效语种。
 * 同时将 `getActiveLocale` 作为 `getSnapshot` 与 `getServerSnapshot`，以完整支持 Vitest `renderToStaticMarkup`。
 */
export function useLocale(): SupportedLocale {
  return useSyncExternalStore(subscribeLocale, getActiveLocale, getActiveLocale);
}

/**
 * 写入访客语言偏好（`oh_guest_lang`）并通知订阅方。
 * 未持有已登录会话时同步刷新当前生效语种，实现未登录门户与公开分享页零延迟切换。
 */
export function setGuestLanguagePreference(preference: LanguagePreference): void {
  writeStorageItem(GUEST_LANGUAGE_STORAGE_KEY, preference);
  if (typeof window !== "undefined" && getStoredSessionToken() === null) {
    setActiveLocaleInternal(resolveLocale(preference), true);
  }
  notifyGuestPrefListeners();
}

function subscribeGuestPref(listener: StoreListener): () => void {
  guestPrefListeners.add(listener);
  return () => {
    guestPrefListeners.delete(listener);
  };
}

/**
 * React Hook：订阅访客语言偏好槽（`oh_guest_lang`）。
 */
export function useGuestLanguagePreference(): LanguagePreference {
  return useSyncExternalStore(subscribeGuestPref, readGuestLanguagePreference, () => "auto");
}

/**
 * 将已登录账号的语言偏好同步写入本地缓存镜像槽（`oh_last_account_lang`），供下次首帧防闪烁读取。
 */
export function setLastAccountLanguagePreference(preference: LanguagePreference): void {
  writeStorageItem(LAST_ACCOUNT_LANGUAGE_STORAGE_KEY, preference);
}

/**
 * 登出时清理已登录账号的本地语言缓存镜像槽（保留访客偏好槽 `oh_guest_lang` 不受影响）。
 */
export function clearLastAccountLanguagePreference(): void {
  removeStorageItem(LAST_ACCOUNT_LANGUAGE_STORAGE_KEY);
}

/**
 * 启动全局语种同步器：按当前偏好同步 `<html lang>` 与 `activeLocale`，并监听浏览器语言变更、BFCache 恢复、可见性切换及跨标签页 `storage` 同步。
 *
 * @param preference - 当前生效的账号或访客语言偏好
 * @returns 取消全部浏览器事件监听的清理函数
 */
export function startLocaleSync(preference: LanguagePreference): () => void {
  const refresh = (): void => {
    setActiveLocaleInternal(resolveLocale(preference), true);
  };

  refresh();

  if (typeof window === "undefined") {
    return () => {};
  }

  const handleVisibilityChange = (): void => {
    if (typeof document === "undefined" || document.visibilityState !== "hidden") {
      refresh();
    }
  };

  const handleStorage = (event: Event): void => {
    const key = "key" in event ? (event as StorageEvent).key : null;
    if (key === null || key === GUEST_LANGUAGE_STORAGE_KEY) {
      notifyGuestPrefListeners();
      refresh();
    } else if (key === LAST_ACCOUNT_LANGUAGE_STORAGE_KEY) {
      refresh();
    }
  };

  const hasWindowEvents =
    typeof window.addEventListener === "function" &&
    typeof window.removeEventListener === "function";
  const hasDocumentEvents =
    typeof document !== "undefined" &&
    typeof document.addEventListener === "function" &&
    typeof document.removeEventListener === "function";

  if (hasWindowEvents) {
    window.addEventListener("languagechange", refresh);
    window.addEventListener("pageshow", refresh);
    window.addEventListener("storage", handleStorage);
  }
  if (hasDocumentEvents) {
    document.addEventListener("visibilitychange", handleVisibilityChange);
  }

  return () => {
    if (hasWindowEvents) {
      window.removeEventListener("languagechange", refresh);
      window.removeEventListener("pageshow", refresh);
      window.removeEventListener("storage", handleStorage);
    }
    if (hasDocumentEvents) {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    }
  };
}

/**
 * 同步浏览器页面标题；位于 `/share/*` 公开分享路径时主动跳过，保护服务端注入的 OG 标题。
 */
export function syncDocumentTitle(title: string): void {
  if (typeof document === "undefined") {
    return;
  }
  if (typeof window !== "undefined" && window.location?.pathname?.startsWith("/share/")) {
    return;
  }
  if (document.title !== title) {
    document.title = title;
  }
}

/**
 * 解析顶层 `AppRoot` 当前应生效的语言偏好，确保已登录账号冷刷新在 `/api/v1/me` 水合完成前不闪回访客语种。
 */
export function resolveAppRootLanguagePreference(params: {
  readonly isShareRoute: boolean;
  readonly authenticatedLanguagePreference: LanguagePreference | null;
  readonly mePending: boolean;
  readonly sessionToken: string | null;
  readonly lastAccountLanguagePreference: LanguagePreference | null;
  readonly guestLanguagePreference: LanguagePreference;
}): LanguagePreference {
  if (params.isShareRoute) {
    return params.guestLanguagePreference;
  }
  if (params.authenticatedLanguagePreference !== null) {
    return params.authenticatedLanguagePreference;
  }
  if (params.mePending && params.sessionToken !== null) {
    return params.lastAccountLanguagePreference ?? params.guestLanguagePreference;
  }
  return params.guestLanguagePreference;
}

/**
 * 仅供单元测试显式设置当前生效语种。
 */
export function setActiveLocaleForTest(locale: SupportedLocale): void {
  setActiveLocaleInternal(locale, true);
}

/**
 * 仅供单元测试在指定语种上下文内执行同步回调，并在返回或抛异常后无条件恢复原语种。
 */
export function withLocale<T>(locale: SupportedLocale, fn: () => T): T {
  const previous = activeLocale;
  setActiveLocaleInternal(locale, false);
  try {
    return fn();
  } finally {
    setActiveLocaleInternal(previous, false);
  }
}
