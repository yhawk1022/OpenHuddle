/**
 * @module web/lib/theme-store
 * @description 浏览器外观偏好与配色同步。固定模式复用既有存储值，自动模式按设备时间驱动根节点主题。
 */
import { useSyncExternalStore } from "react";

const THEME_STORAGE_KEY = "oh_theme";
const MINUTE_MS = 60_000;

/** 当前实际应用的配色。 */
export type ThemeMode = "light" | "dark";

/** 外观偏好决定使用定时切换或固定配色。 */
export type ThemePreference = "auto" | ThemeMode;

const listeners = new Set<() => void>();
let preference = readThemePreference();
let refreshTimer: number | undefined;

function readThemePreference(): ThemePreference {
  if (typeof window !== "undefined") {
    try {
      const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
      if (stored === "light" || stored === "dark") {
        return stored;
      }
    } catch {
      // 存储受限时仍能按设备时间自动换肤。
    }
  }
  return "auto";
}

function getThemeMode(): ThemeMode {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

function refreshTheme(nextPreference: ThemePreference = preference): void {
  window.clearTimeout(refreshTimer);
  const now = new Date();
  const hour = now.getHours();
  const scheduledMode = hour >= 7 && hour < 18 ? "light" : "dark";
  const mode = nextPreference === "auto" ? scheduledMode : nextPreference;
  const changed = preference !== nextPreference || getThemeMode() !== mode;
  preference = nextPreference;
  document.documentElement.classList.toggle("dark", mode === "dark");

  if (preference === "auto") {
    // 对齐下一分钟，在切换点准时刷新，也能跟进设备时钟或时区变化。
    refreshTimer = window.setTimeout(refreshTheme, MINUTE_MS - (now.getTime() % MINUTE_MS));
  }
  if (changed) {
    for (const listener of listeners) {
      listener();
    }
  }
}

/**
 * 在应用根节点启动主题同步。页面恢复时重新读取时钟，避免后台计时器限流导致配色滞后。
 *
 * @returns 清理计时器与浏览器事件监听的函数。
 */
export function startThemeSync(): () => void {
  const onResume = () => refreshTheme();
  const onStorage = (event: StorageEvent) => {
    if (event.key === THEME_STORAGE_KEY || event.key === null) {
      refreshTheme(readThemePreference());
    }
  };

  refreshTheme(readThemePreference());
  window.addEventListener("focus", onResume);
  window.addEventListener("pageshow", onResume);
  window.addEventListener("storage", onStorage);
  document.addEventListener("visibilitychange", onResume);

  return () => {
    window.clearTimeout(refreshTimer);
    window.removeEventListener("focus", onResume);
    window.removeEventListener("pageshow", onResume);
    window.removeEventListener("storage", onStorage);
    document.removeEventListener("visibilitychange", onResume);
  };
}

/**
 * 应用外观选择并保存到本地浏览器。
 *
 * @param nextPreference - 自动切换或固定配色。存储受限时在当前页面内生效。
 */
export function setThemePreference(nextPreference: ThemePreference): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, nextPreference);
  } catch {
    // 存储失败时继续更新当前页面的外观。
  }
  refreshTheme(nextPreference);
}

function subscribeTheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * 订阅页面实际应用的配色，供插图等需要感知配色的组件使用。
 *
 * @returns 当前配色。
 */
export function useThemeMode(): ThemeMode {
  return useSyncExternalStore(subscribeTheme, getThemeMode, () => "dark");
}

/**
 * 订阅外观选项，即使切换选项后实际配色相同也能更新勾选状态。
 *
 * @returns 当前外观偏好。
 */
export function useThemePreference(): ThemePreference {
  return useSyncExternalStore(
    subscribeTheme,
    () => preference,
    () => "auto",
  );
}
