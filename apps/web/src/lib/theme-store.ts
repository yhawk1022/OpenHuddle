/**
 * @module web/lib/theme-store
 * @description 将认证账号的外观偏好解析成根节点配色。匿名页面由根组件选择固定夜间模式。
 */
import type { ThemePreference } from "@openhuddle/protocol";
import { useSyncExternalStore } from "react";

const MINUTE_MS = 60_000;
const listeners = new Set<() => void>();

function getThemeMode(): "light" | "dark" {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

function applyTheme(isDark: boolean): void {
  if (document.documentElement.classList.contains("dark") !== isDark) {
    document.documentElement.classList.toggle("dark", isDark);
    for (const listener of listeners) {
      listener();
    }
  }
}

/**
 * 应用当前页面的外观偏好。自动模式按设备时间切换，页面恢复时补做切换。
 *
 * @param preference - 经过认证的账号偏好，或匿名页面的固定夜间模式。
 * @returns 取消定时器和浏览器事件监听的函数。
 */
export function startThemeSync(preference: ThemePreference): () => void {
  if (preference !== "auto") {
    applyTheme(preference === "dark");
    return () => {};
  }

  let refreshTimer: number | undefined;
  const refreshTheme = () => {
    window.clearTimeout(refreshTimer);
    const now = new Date();
    const hour = now.getHours();
    applyTheme(hour < 7 || hour >= 18);
    // 对齐分钟边界，且能跟进设备时钟或时区变化。
    refreshTimer = window.setTimeout(refreshTheme, MINUTE_MS - (now.getTime() % MINUTE_MS));
  };

  refreshTheme();
  window.addEventListener("focus", refreshTheme);
  window.addEventListener("pageshow", refreshTheme);
  document.addEventListener("visibilitychange", refreshTheme);

  return () => {
    window.clearTimeout(refreshTimer);
    window.removeEventListener("focus", refreshTheme);
    window.removeEventListener("pageshow", refreshTheme);
    document.removeEventListener("visibilitychange", refreshTheme);
  };
}

function subscribeTheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * 订阅根节点实际应用的配色，供插图和主题图标使用。
 *
 * @returns 当前配色。
 */
export function useThemeMode(): "light" | "dark" {
  return useSyncExternalStore(subscribeTheme, getThemeMode, () => "dark");
}
