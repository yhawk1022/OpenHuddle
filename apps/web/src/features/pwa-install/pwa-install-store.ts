/**
 * @module web/features/pwa-install/pwa-install-store
 * @description PWA `beforeinstallprompt` 事件捕获、已安装状态持久化识别、Service Worker 安全注册与横幅关闭记忆。
 */
import { useSyncExternalStore } from "react";
import { type PwaPlatformProfile, detectPwaPlatformProfile } from "./pwa-platform-detect.js";

const BANNER_DISMISS_STORAGE_KEY = "oh_pwa_banner_dismissed_until";
const INSTALLED_STORAGE_KEY = "oh_pwa_installed";
const SNOOZE_DURATION_MS = 14 * 24 * 60 * 60 * 1000; // 14 天冷却期

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{
    readonly outcome: "accepted" | "dismissed";
    readonly platform: string;
  }>;
}

export interface PwaInstallSnapshot {
  readonly profile: PwaPlatformProfile;
  readonly isBannerDismissed: boolean;
  readonly shouldShowSmartBanner: boolean;
}

type Listener = () => void;

const listeners = new Set<Listener>();
let deferredPrompt: BeforeInstallPromptEvent | null = null;
let installedInSession = false;
let listenersBound = false;
let cachedSnapshot: PwaInstallSnapshot | null = null;

function notify(): void {
  cachedSnapshot = null;
  for (const listener of listeners) {
    listener();
  }
}

function persistPwaInstalledFlag(): void {
  installedInSession = true;
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(INSTALLED_STORAGE_KEY, "1");
  } catch {
    // 忽略无痕模式写入限制
  }
}

function readPersistedInstalledFlag(): boolean {
  if (installedInSession) {
    return true;
  }
  if (typeof window === "undefined") {
    return false;
  }
  try {
    return window.localStorage.getItem(INSTALLED_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function checkAndConsumeSourcePwaQueryParam(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get("source") !== "pwa") {
      return false;
    }
    persistPwaInstalledFlag();
    params.delete("source");
    const rest = params.toString();
    const cleanUrl = `${window.location.pathname}${rest ? `?${rest}` : ""}${window.location.hash}`;
    window.history?.replaceState?.(window.history.state, "", cleanUrl);
    return true;
  } catch {
    return false;
  }
}

function checkDisplayModeInstalled(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    window.matchMedia("(display-mode: fullscreen)").matches ||
    window.matchMedia("(display-mode: minimal-ui)").matches
  );
}

function readIsBannerDismissed(): boolean {
  if (typeof window === "undefined") {
    return true;
  }
  try {
    const raw = window.localStorage.getItem(BANNER_DISMISS_STORAGE_KEY);
    if (!raw) {
      return false;
    }
    if (raw === "forever") {
      return true;
    }
    const untilTs = Number(raw);
    return Number.isFinite(untilTs) && Date.now() < untilTs;
  } catch {
    return false;
  }
}

function ensurePwaListeners(): void {
  if (listenersBound || typeof window === "undefined") {
    return;
  }
  listenersBound = true;

  checkAndConsumeSourcePwaQueryParam();

  if (
    checkDisplayModeInstalled() ||
    Boolean((navigator as Navigator & { readonly standalone?: boolean }).standalone) ||
    (typeof document !== "undefined" && document.referrer.startsWith("android-app://"))
  ) {
    persistPwaInstalledFlag();
  }

  window.addEventListener("beforeinstallprompt", (event: Event) => {
    event.preventDefault();
    deferredPrompt = event as BeforeInstallPromptEvent;
    notify();
  });

  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    persistPwaInstalledFlag();
    notify();
  });

  if (typeof window.matchMedia === "function") {
    for (const query of [
      "(display-mode: standalone)",
      "(display-mode: fullscreen)",
      "(display-mode: minimal-ui)",
    ]) {
      const mq = window.matchMedia(query);
      mq.addEventListener("change", () => {
        if (mq.matches) {
          persistPwaInstalledFlag();
        }
        notify();
      });
    }
  }
}

function computeSnapshot(): PwaInstallSnapshot {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    const serverProfile = detectPwaPlatformProfile({ userAgent: "" });
    return {
      profile: serverProfile,
      isBannerDismissed: true,
      shouldShowSmartBanner: false,
    };
  }

  ensurePwaListeners();
  const hasSourcePwaParam = checkAndConsumeSourcePwaQueryParam();
  const isStandaloneMedia = checkDisplayModeInstalled();
  const navigatorStandalone = Boolean(
    (navigator as Navigator & { readonly standalone?: boolean }).standalone,
  );
  if (isStandaloneMedia || navigatorStandalone) {
    persistPwaInstalledFlag();
  }
  const hasPersistedInstalledFlag = readPersistedInstalledFlag();

  const profile = detectPwaPlatformProfile({
    userAgent: navigator.userAgent || "",
    platform: navigator.platform,
    maxTouchPoints: navigator.maxTouchPoints,
    isStandaloneMedia,
    navigatorStandalone,
    referrer: typeof document !== "undefined" ? document.referrer : "",
    hasSourcePwaParam,
    hasPersistedInstalledFlag,
    hasBeforeInstallPrompt: deferredPrompt !== null,
  });
  const isBannerDismissed = readIsBannerDismissed();

  return {
    profile,
    isBannerDismissed,
    shouldShowSmartBanner: profile.showSmartBannerByDefault && !isBannerDismissed,
  };
}

function getSnapshot(): PwaInstallSnapshot {
  if (cachedSnapshot === null) {
    cachedSnapshot = computeSnapshot();
  }
  return cachedSnapshot;
}

const SERVER_FALLBACK_SNAPSHOT: PwaInstallSnapshot = {
  profile: detectPwaPlatformProfile({ userAgent: "" }),
  isBannerDismissed: true,
  shouldShowSmartBanner: false,
};

function subscribe(listener: Listener): () => void {
  ensurePwaListeners();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * 响应式读取当前设备的 PWA 平台特征与智能引导条展示状态。
 */
export function usePwaInstallState(): PwaInstallSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, () => SERVER_FALLBACK_SNAPSHOT);
}

/**
 * 触发 Android Chromium 原生一键「添加到主屏幕 / 安装应用」系统确认弹窗。
 */
export async function triggerNativePwaInstall(): Promise<"accepted" | "dismissed" | "unavailable"> {
  if (!deferredPrompt) {
    return "unavailable";
  }
  const current = deferredPrompt;
  deferredPrompt = null;
  notify();
  try {
    await current.prompt();
    const choice = await current.userChoice;
    if (choice.outcome === "accepted") {
      persistPwaInstalledFlag();
    }
    notify();
    return choice.outcome;
  } catch {
    notify();
    return "unavailable";
  }
}

/**
 * 标记用户已完成手动添加到主屏幕（永久隐藏所有添加提示）。
 */
export function markPwaInstalled(): void {
  persistPwaInstalledFlag();
  notify();
}

/**
 * 暂时关闭顶部「添加到主屏幕」轻量横幅（14 天内不再弹出）。
 */
export function snoozePwaSmartBanner(): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(
      BANNER_DISMISS_STORAGE_KEY,
      String(Date.now() + SNOOZE_DURATION_MS),
    );
  } catch {
    // 忽略无痕模式写入异常
  }
  notify();
}

/**
 * 永久关闭顶部「添加到主屏幕」提示。
 */
export function dismissPwaSmartBannerPermanently(): void {
  persistPwaInstalledFlag();
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(BANNER_DISMISS_STORAGE_KEY, "forever");
  } catch {
    // 忽略无痕模式写入异常
  }
  notify();
}

/**
 * 在安全上下文（HTTPS 或 localhost）静默注册轻量透传型 Service Worker 以激活移动端 PWA 安装能力。
 */
export function startPwaInstallRuntime(): void {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return;
  }
  ensurePwaListeners();
  if (!("serviceWorker" in navigator)) {
    return;
  }
  const isLocalhost =
    window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";
  if (window.location.protocol !== "https:" && !isLocalhost) {
    return;
  }
  const register = () => {
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {
      // 静默降级：即使 SW 注册受限也不影响手动「添加到主屏幕」步骤指引
    });
  };
  if (document.readyState === "complete") {
    register();
  } else {
    window.addEventListener("load", register, { once: true });
  }
}
