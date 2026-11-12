/**
 * @module web/lib/session-store
 * @description 浏览器端会话令牌、双主题模式（Crisp Daylight / Studio Dark）与轻量 SPA 路由外部状态源。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 零 `useEffect` 同步外部存储：统一采用 React 19 原生 `useSyncExternalStore` 订阅 `localStorage` 与 `History` 变更，杜绝双状态源撕裂。
 * 2. 双通道鉴权兜底：除服务端签发的 `oh_session` HttpOnly Cookie 外，本地备份 `sessionToken` 供 `Authorization: Bearer` 与 SSE `?token=` 握手使用。
 * 3. 无闪烁主题切换：同步维护 `<html>` 节点的 `.dark` 类名与 `localStorage`，支持 Pachat 清爽日光模式与 Linear 暗黑工作室模式即时切换。
 */
import { useSyncExternalStore } from "react";

const SESSION_STORAGE_KEY = "oh_session_token";
const THEME_STORAGE_KEY = "oh_theme";

/** 支持的界面视觉主题模式 */
export type ThemeMode = "light" | "dark";

/** 浏览器当前路由快照 */
export interface BrowserLocationSnapshot {
  readonly pathname: string;
  readonly search: string;
}

type StoreListener = () => void;

const sessionListeners = new Set<StoreListener>();
const themeListeners = new Set<StoreListener>();
const locationListeners = new Set<StoreListener>();

let cachedLocation: BrowserLocationSnapshot = {
  pathname: typeof window !== "undefined" ? window.location.pathname : "/",
  search: typeof window !== "undefined" ? window.location.search : "",
};

let popstateBound = false;

function ensurePopstateSubscription(): void {
  if (popstateBound || typeof window === "undefined") {
    return;
  }
  popstateBound = true;
  window.addEventListener("popstate", () => {
    refreshLocationSnapshot();
  });
}

function refreshLocationSnapshot(): void {
  if (typeof window === "undefined") {
    return;
  }
  const nextPathname = window.location.pathname;
  const nextSearch = window.location.search;
  // 引用相等性守卫：仅当 URL 实际发生变化时替换快照对象，避免 useSyncExternalStore 死循环重渲染
  if (cachedLocation.pathname === nextPathname && cachedLocation.search === nextSearch) {
    return;
  }
  cachedLocation = {
    pathname: nextPathname,
    search: nextSearch,
  };
  for (const listener of locationListeners) {
    listener();
  }
}

/**
 * 读取本地持久化的备份人类会话令牌。
 *
 * @returns 若已登录则返回令牌字符串，否则返回 `null`
 */
export function getStoredSessionToken(): string | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(SESSION_STORAGE_KEY);
    return raw && raw.trim().length > 0 ? raw.trim() : null;
  } catch {
    return null;
  }
}

/**
 * 写入或清除本地备份的人类会话令牌，并广播通知所有订阅组件。
 *
 * @param token - 新签发的 `sessionToken`；传入 `null` 表示退出登录或令牌失效清理
 */
export function setStoredSessionToken(token: string | null): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    if (token && token.trim().length > 0) {
      window.localStorage.setItem(SESSION_STORAGE_KEY, token.trim());
    } else {
      window.localStorage.removeItem(SESSION_STORAGE_KEY);
    }
  } catch {
    // 隐私无痕模式下 localStorage 可能受限，静默降级至同源 Cookie 鉴权
  }
  for (const listener of sessionListeners) {
    listener();
  }
}

function subscribeSession(listener: StoreListener): () => void {
  sessionListeners.add(listener);
  return () => {
    sessionListeners.delete(listener);
  };
}

/**
 * 响应式订阅当前浏览器保存的 `sessionToken`。
 *
 * @returns 当前会话令牌或 `null`
 */
export function useSessionToken(): string | null {
  return useSyncExternalStore(subscribeSession, getStoredSessionToken, () => null);
}

/**
 * 读取当前激活的主题模式（默认暗黑工作室模式 `"dark"`）。
 *
 * @returns `"light"` 或 `"dark"`
 */
export function getThemeMode(): ThemeMode {
  if (typeof document !== "undefined") {
    return document.documentElement.classList.contains("dark") ? "dark" : "light";
  }
  return "dark";
}

/**
 * 切换并持久化界面视觉主题。
 *
 * @param mode - 目标主题（`"light"` 清爽日光 | `"dark"` 暗黑工作室）
 */
export function setThemeMode(mode: ThemeMode): void {
  if (typeof document !== "undefined") {
    document.documentElement.classList.toggle("dark", mode === "dark");
  }
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, mode);
    } catch {
      // 忽略存储配额或沙箱限制异常
    }
  }
  for (const listener of themeListeners) {
    listener();
  }
}

/**
 * 在清爽日光模式与暗黑工作室模式之间一键翻转。
 */
export function toggleThemeMode(): void {
  setThemeMode(getThemeMode() === "dark" ? "light" : "dark");
}

function subscribeTheme(listener: StoreListener): () => void {
  themeListeners.add(listener);
  return () => {
    themeListeners.delete(listener);
  };
}

/**
 * 响应式订阅当前界面视觉主题。
 *
 * @returns 当前主题模式（`"light"` | `"dark"`）
 */
export function useThemeMode(): ThemeMode {
  return useSyncExternalStore(subscribeTheme, getThemeMode, () => "dark");
}

function subscribeLocation(listener: StoreListener): () => void {
  ensurePopstateSubscription();
  locationListeners.add(listener);
  return () => {
    locationListeners.delete(listener);
  };
}

function getLocationSnapshot(): BrowserLocationSnapshot {
  ensurePopstateSubscription();
  return cachedLocation;
}

const SERVER_LOCATION_FALLBACK: BrowserLocationSnapshot = {
  pathname: "/",
  search: "",
};

/**
 * 响应式读取当前浏览器 URL 路径与查询参数。
 *
 * @returns 包含 `pathname` 与 `search` 的只读快照
 */
export function useBrowserLocation(): BrowserLocationSnapshot {
  return useSyncExternalStore(
    subscribeLocation,
    getLocationSnapshot,
    () => SERVER_LOCATION_FALLBACK,
  );
}

/**
 * 执行无刷新的客户端路由跳转或 URL 查询参数同步。
 *
 * @param to - 目标路径（如 `/?room=rom_123` 或 `/share/inv_abc`）
 * @param options - 可选使用 `replaceState` 避免污染返回栈
 */
export function navigateTo(to: string, options?: { readonly replace?: boolean }): void {
  if (typeof window === "undefined") {
    return;
  }
  if (options?.replace) {
    window.history.replaceState(null, "", to);
  } else {
    window.history.pushState(null, "", to);
  }
  refreshLocationSnapshot();
}
