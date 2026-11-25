/**
 * @module web/lib/session-store
 * @description 浏览器端会话令牌、轻量 SPA 路由外部状态源与移动端返回栈（`popstate` + 弹窗哨兵）协调器。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 零 `useEffect` 同步外部存储：统一采用 React 19 原生 `useSyncExternalStore` 订阅 `localStorage` 与 `History` 变更，杜绝双状态源撕裂。
 * 2. 双通道鉴权兜底：除服务端签发的 `oh_session` HttpOnly Cookie 外，本地备份 `sessionToken` 供 `Authorization: Bearer` 与 SSE `?token=` 握手使用。
 * 3. Android / iOS 返回手势闭环：
 *    - 维护应用内 `intraAppHistoryDepth`，`navigateBackOr("/")` 在有站内历史时执行 `history.back()`，深链直入时执行 `replaceState("/")`，确保退回列表后刷新不反弹；
 *    - 移动端模态窗/抽屉压入 `{ __ohOverlay: id }` 哨兵，侧滑返回优先关闭顶层浮层；若浮层内触发 `navigateTo(...)`，自动用 `replaceState` 原位覆盖临时哨兵帧，杜绝异步 `history.back()` 竞态。
 */
import { useEffect, useRef, useSyncExternalStore } from "react";

const SESSION_STORAGE_KEY = "oh_session_token";

/** 浏览器当前路由快照 */
export interface BrowserLocationSnapshot {
  readonly pathname: string;
  readonly search: string;
}

interface OverlaySentinelEntry {
  readonly id: string;
  onDismiss: () => void;
  poppedByBrowser: boolean;
}

type StoreListener = () => void;

const sessionListeners = new Set<StoreListener>();
const locationListeners = new Set<StoreListener>();

let cachedLocation: BrowserLocationSnapshot = {
  pathname: typeof window !== "undefined" ? window.location.pathname : "/",
  search: typeof window !== "undefined" ? window.location.search : "",
};

let popstateBound = false;
let boundWindowRef: Window | null = null;
let intraAppHistoryDepth = 0;
let overlaySeq = 0;
let programmaticOverlayBackCount = 0;
const overlayStack: OverlaySentinelEntry[] = [];

function getHistoryOverlayId(): string | null {
  if (typeof window === "undefined") {
    return null;
  }
  const state = window.history?.state;
  if (state && typeof state === "object" && "__ohOverlay" in state) {
    const val = (state as { readonly __ohOverlay?: unknown }).__ohOverlay;
    return typeof val === "string" ? val : null;
  }
  return null;
}

function handleWindowPopstate(): void {
  // 若是点击弹窗 X 按钮主动发起的 cleanup history.back()，静默消化该次 popstate
  if (programmaticOverlayBackCount > 0) {
    programmaticOverlayBackCount -= 1;
    refreshLocationSnapshot();
    return;
  }

  const currentOverlayId = getHistoryOverlayId();
  const topOverlay = overlayStack[overlayStack.length - 1];
  if (topOverlay && currentOverlayId !== topOverlay.id) {
    overlayStack.pop();
    topOverlay.poppedByBrowser = true;
    topOverlay.onDismiss();
    refreshLocationSnapshot();
    return;
  }

  if (intraAppHistoryDepth > 0) {
    intraAppHistoryDepth -= 1;
  }
  refreshLocationSnapshot();
}

function ensurePopstateSubscription(): void {
  if (typeof window === "undefined") {
    return;
  }
  if (popstateBound && boundWindowRef === window) {
    return;
  }
  popstateBound = true;
  boundWindowRef = window;
  cachedLocation = {
    pathname: window.location.pathname,
    search: window.location.search,
  };
  if (typeof window.addEventListener === "function") {
    window.addEventListener("popstate", handleWindowPopstate);
  }
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
 * 若当前顶层历史帧为临时弹窗哨兵（`__ohOverlay`），自动以 `replaceState` 原位覆盖该帧，杜绝与弹窗关闭时的 `history.back()` 发生竞态。
 *
 * @param to - 目标路径（如 `/?room=rom_123` 或 `/share/inv_abc`）
 * @param options - 可选使用 `replaceState` 避免污染返回栈
 */
export function navigateTo(to: string, options?: { readonly replace?: boolean }): void {
  if (typeof window === "undefined") {
    return;
  }
  ensurePopstateSubscription();
  const activeOverlayId = getHistoryOverlayId();
  if (activeOverlayId !== null) {
    // 消耗并清空已被新导航原位覆盖的哨兵记录，后续弹窗卸载时不再回退历史栈
    const idx = overlayStack.findIndex((entry) => entry.id === activeOverlayId);
    if (idx >= 0) {
      const removed = overlayStack.splice(idx);
      for (const item of removed) {
        item.poppedByBrowser = true;
      }
    }
    window.history.replaceState(null, "", to);
    if (!options?.replace) {
      intraAppHistoryDepth += 1;
    }
  } else if (options?.replace) {
    window.history.replaceState(null, "", to);
  } else {
    window.history.pushState(null, "", to);
    intraAppHistoryDepth += 1;
  }
  refreshLocationSnapshot();
}

/**
 * 安全返回上一级视图：
 * - 若当前会话存在应用内 `pushState` 历史（`intraAppHistoryDepth > 0`），直接调用 `window.history.back()` 消费历史帧；
 * - 若是外部分享深链或直接刷新进入子视图（`intraAppHistoryDepth === 0`），调用 `replaceState` 退回兜底路径，防止跳出站点。
 *
 * @param fallbackTo - 无站内返回栈时的兜底目标路径（默认 `"/"`）
 */
export function navigateBackOr(fallbackTo = "/"): void {
  if (typeof window === "undefined") {
    return;
  }
  ensurePopstateSubscription();
  if (intraAppHistoryDepth > 0) {
    window.history.back();
  } else {
    navigateTo(fallbackTo, { replace: true });
  }
}

/**
 * 注册移动端模态窗/抽屉的浏览器返回栈哨兵（供非 React 或底层测试直接调用）。
 *
 * @param onDismiss - 当用户执行 Android 侧滑返回 / 浏览器后退触发 `popstate` 时的关闭回调
 * @returns 浮层主动关闭/卸载时的清理函数
 */
export function registerOverlayBackSentinel(onDismiss: () => void): {
  readonly cleanup: () => void;
  readonly updateDismiss: (next: () => void) => void;
} {
  if (typeof window === "undefined") {
    return { cleanup: () => {}, updateDismiss: () => {} };
  }
  ensurePopstateSubscription();
  overlaySeq += 1;
  const id = `oh_ov_${overlaySeq}`;
  const entry: OverlaySentinelEntry = {
    id,
    onDismiss,
    poppedByBrowser: false,
  };
  overlayStack.push(entry);

  const prevState =
    window.history.state && typeof window.history.state === "object" ? window.history.state : {};
  const currentHref = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  window.history.pushState({ ...prevState, __ohOverlay: id }, "", currentHref);

  return {
    updateDismiss: (next) => {
      entry.onDismiss = next;
    },
    cleanup: () => {
      const idx = overlayStack.indexOf(entry);
      if (idx >= 0) {
        overlayStack.splice(idx, 1);
      }
      if (!entry.poppedByBrowser && getHistoryOverlayId() === id) {
        programmaticOverlayBackCount += 1;
        window.history.back();
      }
    },
  };
}

/**
 * React Hook：当浮层在移动端打开时压入返回栈哨兵，使 Android 边缘侧滑手势关闭当前弹窗/抽屉而非误退底层页面。
 *
 * @param enabled - 当前浮层是否开启且启用返回拦截（如 `open && isMobile`）
 * @param onDismiss - 关闭浮层的回调
 */
export function useMobileOverlayBackGuard(enabled: boolean, onDismiss: () => void): void {
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;

  useEffect(() => {
    if (!enabled) {
      return;
    }
    const sentinel = registerOverlayBackSentinel(() => {
      dismissRef.current();
    });
    return () => {
      sentinel.cleanup();
    };
  }, [enabled]);
}

/** 仅供单元测试重置内部导航计数与浮层栈使用 */
export function __resetNavigationStateForTests(): void {
  intraAppHistoryDepth = 0;
  overlaySeq = 0;
  programmaticOverlayBackCount = 0;
  overlayStack.length = 0;
  if (typeof window !== "undefined") {
    cachedLocation = {
      pathname: window.location.pathname,
      search: window.location.search,
    };
  }
}
