/**
 * @module web/lib/display-refresh
 * @description 显示器最高刷新率自适应校准与 VRR（ProMotion / LTPO / Windows DRR）按需峰值唤醒引擎。
 *
 * 关键不变量：
 * 1. 默认满血最高刷新率：出厂默认偏好恒为 `"max"`，自动对齐当前屏幕硬件支持的最高刷新率（120Hz / 144Hz / 165Hz / 240Hz+）。
 * 2. 零闲置功耗（0% Idle GPU）：VRR 合成器唤醒信标仅在交互窗口（指针、滚轮、触控、键盘）内短暂激活 650ms，静置阅读时立即挂起 `pause()`，不空转耗电。
 * 3. 跨屏热迁移自校准：当窗口在笔记本内屏（如 120Hz ProMotion）与外接显示器（60Hz / 144Hz / 240Hz）间拖移导致 DPR 或尺寸变化时，自动重新采样 VSync 周期。
 */
import { useSyncExternalStore } from "react";
import { createExternalStore } from "./external-store.js";

/** 刷新率调度策略：`"max"` 默认开启屏幕支持的最高刷新率；`"standard"` 允许系统降频至 60Hz 省电 */
export type RefreshRatePreference = "max" | "standard";

/** 默认即开启设备支持的最高刷新率 */
export const DEFAULT_REFRESH_RATE_PREFERENCE: RefreshRatePreference = "max";

const STORAGE_KEY = "oh_refresh_rate_pref";
const VRR_LEASE_DURATION_MS = 650;
const POINTER_MOVE_REARM_INTERVAL_MS = 240;
const CALIBRATION_FRAME_COUNT = 22;

/** 常见物理面板标称刷新率阶梯（用于吸附微小的浏览器时钟抖动） */
const CANONICAL_REFRESH_TIERS: ReadonlyArray<number> = [
  60, 75, 90, 100, 120, 144, 165, 180, 240, 300, 360, 480,
];

/** 原生桌面/移动宿主壳（Tauri WKWebView / Electron / Native Host）可选帧率桥接协议 */
export interface OpenHuddleNativeHostBridge {
  readonly setPreferredRefreshRate?: (payload: {
    readonly mode: RefreshRatePreference;
    readonly minHz: number;
    readonly maxHz: number;
    readonly preferMaxRefreshRate: boolean;
  }) => void;
}

declare global {
  interface Window {
    __OPENHUDDLE_HOST__?: OpenHuddleNativeHostBridge;
  }
}

/** 实时显示刷新率状态快照 */
export interface DisplayRefreshSnapshot {
  readonly preference: RefreshRatePreference;
  readonly detectedHz: number;
  readonly peakHz: number;
  readonly vsyncIntervalMs: number;
  readonly isCalibrating: boolean;
  readonly isSafariWebKit60HzCapped: boolean;
}

/**
 * 从连续 `requestAnimationFrame` 时间戳序列计算抗毛刺的截尾中位帧间隔（毫秒）。
 *
 * @param timestamps - 单调递增的 `DOMHighResTimeStamp` 数组
 * @returns 有效帧间隔毫秒数；样本不足时返回 `null`
 */
export function computeMedianFrameDeltaMs(timestamps: ReadonlyArray<number>): number | null {
  if (timestamps.length < 7) {
    return null;
  }
  const deltas: number[] = [];
  for (let i = 1; i < timestamps.length; i += 1) {
    const prev = timestamps[i - 1];
    const curr = timestamps[i];
    if (prev === undefined || curr === undefined) {
      continue;
    }
    const dt = curr - prev;
    // 剔除后台切页（>= 50ms）或同帧重复回调（<= 1.2ms）的异常值
    if (Number.isFinite(dt) && dt > 1.2 && dt < 50) {
      deltas.push(dt);
    }
  }
  if (deltas.length < 6) {
    return null;
  }
  deltas.sort((a, b) => a - b);
  const trim = Math.max(1, Math.floor(deltas.length * 0.2));
  const core = deltas.slice(trim, deltas.length - trim);
  if (core.length === 0) {
    return deltas[Math.floor(deltas.length / 2)] ?? null;
  }
  const sum = core.reduce((acc, v) => acc + v, 0);
  return sum / core.length;
}

/**
 * 将实测 VSync 帧间隔吸附至物理面板标称刷新率（Hz）。
 *
 * @param medianDeltaMs - 截尾均值帧间隔（ms）
 * @returns 标称整数刷新率（如 `60`、`120`、`144`、`165`、`240`）
 */
export function snapRefreshRateHz(medianDeltaMs: number): number {
  if (!Number.isFinite(medianDeltaMs) || medianDeltaMs <= 0) {
    return 60;
  }
  const rawHz = 1000 / medianDeltaMs;
  const clampedHz = Math.min(500, Math.max(30, rawHz));
  let bestTier: number | null = null;
  let bestRelativeError = Number.POSITIVE_INFINITY;

  for (const tier of CANONICAL_REFRESH_TIERS) {
    const relErr = Math.abs(clampedHz - tier) / tier;
    if (relErr <= 0.065 && relErr < bestRelativeError) {
      bestRelativeError = relErr;
      bestTier = tier;
    }
  }
  return bestTier ?? Math.round(clampedHz);
}

function readStoredPreference(): RefreshRatePreference {
  if (typeof window === "undefined") {
    return DEFAULT_REFRESH_RATE_PREFERENCE;
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === "standard" || raw === "max") {
      return raw;
    }
  } catch {
    // 隐私沙盒禁用 localStorage 时直接采用默认最高刷新率
  }
  return DEFAULT_REFRESH_RATE_PREFERENCE;
}

function detectWebKitEngine(): boolean {
  if (typeof navigator === "undefined") {
    return false;
  }
  const ua = navigator.userAgent;
  return /AppleWebKit\//.test(ua) && !/(?:Chrome|Chromium|CriOS|Edg|OPR)\//.test(ua);
}

function detectLikelyProMotionAppleDevice(): boolean {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return false;
  }
  const dpr = window.devicePixelRatio || 1;
  if (dpr < 2) {
    return false;
  }
  return /Macintosh|iPhone|iPad/.test(navigator.userAgent);
}

const initialPreference = readStoredPreference();

const INITIAL_SNAPSHOT: DisplayRefreshSnapshot = {
  preference: initialPreference,
  detectedHz: 120,
  peakHz: 120,
  vsyncIntervalMs: Number((1000 / 120).toFixed(2)),
  isCalibrating: false,
  isSafariWebKit60HzCapped: false,
};

const refreshStore = createExternalStore<DisplayRefreshSnapshot>(INITIAL_SNAPSHOT);

let activeAcquireBurst: ((durationMs?: number) => void) | null = null;

function syncDomDataset(snapshot: DisplayRefreshSnapshot): void {
  if (typeof document === "undefined") {
    return;
  }
  const root = document.documentElement;
  if (root.dataset) {
    root.dataset.refreshRate = snapshot.preference;
    root.dataset.detectedHz = String(snapshot.detectedHz);
  }
  root.style?.setProperty("--oh-vsync-ms", `${snapshot.vsyncIntervalMs}ms`);
}

function notifyNativeHost(preference: RefreshRatePreference): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.__OPENHUDDLE_HOST__?.setPreferredRefreshRate?.(
      preference === "max"
        ? { mode: "max", minHz: 120, maxHz: 240, preferMaxRefreshRate: true }
        : { mode: "standard", minHz: 30, maxHz: 60, preferMaxRefreshRate: false },
    );
  } catch {
    // 忽略宿主桥接异常，不影响 Web 渲染管线
  }
}

/**
 * 读取当前刷新率策略偏好（默认 `"max"`）。
 */
export function getRefreshRatePreference(): RefreshRatePreference {
  return refreshStore.getSnapshot().preference;
}

/**
 * 切换刷新率策略（`"max"` 最高刷新率 / `"standard"` 60Hz 省电模式），立即生效并持久化。
 */
export function setRefreshRatePreference(next: RefreshRatePreference): void {
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // 忽略存储配额限制
    }
  }
  refreshStore.setSnapshot((prev) =>
    prev.preference === next ? prev : { ...prev, preference: next },
  );
  syncDomDataset(refreshStore.getSnapshot());
  notifyNativeHost(next);
  if (next === "max") {
    activeAcquireBurst?.(VRR_LEASE_DURATION_MS);
  }
}

/**
 * 主动申请一段高刷新率 VRR 合成器唤醒租约（供路由切换、弹窗开合等程序化动画在首帧拉满面板峰值刷新率）。
 */
export function acquireHighRefreshBurst(durationMs: number = VRR_LEASE_DURATION_MS): void {
  activeAcquireBurst?.(durationMs);
}

/**
 * 响应式订阅当前显示刷新率状态快照。
 */
export function useDisplayRefreshState(): DisplayRefreshSnapshot {
  return useSyncExternalStore(
    refreshStore.subscribe,
    refreshStore.getSnapshot,
    refreshStore.getServerSnapshot,
  );
}

/**
 * 启动全局最高刷新率自适应校准与按需 VRR 峰值唤醒守护。
 *
 * @returns 卸载清理函数
 */
export function startDisplayRefreshRuntime(): () => void {
  if (
    typeof window === "undefined" ||
    typeof document === "undefined" ||
    typeof window.addEventListener !== "function"
  ) {
    return () => {};
  }

  let disposed = false;
  let calibrationRafId = 0;
  let leaseTimerId = 0;
  let resizeDebounceId = 0;
  let lastPointerArmAt = 0;
  let hasMeasuredPostInteraction = false;

  const reducedMotionMql =
    typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-reduced-motion: reduce)")
      : null;

  // 创建 1x1 零布局合成层信标：仅在交互租约期内运行 WAAPI 变换，引导 ProMotion / VRR 立即跃迁至面板最高 Hz
  let beaconEl: HTMLDivElement | null = null;
  let beaconAnim: Animation | null = null;

  const ensureBeaconAnimation = (): Animation | null => {
    if (beaconAnim !== null) {
      return beaconAnim;
    }
    if (typeof document.body?.appendChild !== "function") {
      return null;
    }
    const el = document.createElement("div");
    el.setAttribute("aria-hidden", "true");
    el.dataset.ohVrrBeacon = "true";
    el.style.cssText =
      "position:fixed;left:0;top:0;width:1px;height:1px;opacity:0.001;pointer-events:none;z-index:-1;contain:strict;will-change:transform;backface-visibility:hidden;";
    document.body.appendChild(el);
    beaconEl = el;

    if (typeof el.animate === "function") {
      try {
        beaconAnim = el.animate(
          [{ transform: "translate3d(0, 0, 0)" }, { transform: "translate3d(0.01px, 0, 0)" }],
          { duration: 1_000, iterations: Number.POSITIVE_INFINITY, direction: "alternate" },
        );
        beaconAnim.pause();
      } catch {
        beaconAnim = null;
      }
    }
    return beaconAnim;
  };

  const pauseBeacon = (): void => {
    if (leaseTimerId !== 0) {
      window.clearTimeout(leaseTimerId);
      leaseTimerId = 0;
    }
    try {
      beaconAnim?.pause();
    } catch {
      // 忽略部分测试环境下的空实现异常
    }
  };

  const runCalibration = (resetPeak: boolean): void => {
    if (disposed || document.visibilityState === "hidden") {
      return;
    }
    if (calibrationRafId !== 0) {
      window.cancelAnimationFrame(calibrationRafId);
      calibrationRafId = 0;
    }

    const timestamps: number[] = [];
    refreshStore.setSnapshot((prev) =>
      prev.isCalibrating ? prev : { ...prev, isCalibrating: true },
    );

    const step = (now: number): void => {
      if (disposed) {
        return;
      }
      timestamps.push(now);
      if (timestamps.length < CALIBRATION_FRAME_COUNT) {
        calibrationRafId = window.requestAnimationFrame(step);
        return;
      }
      calibrationRafId = 0;
      const medianDt = computeMedianFrameDeltaMs(timestamps);
      if (medianDt === null) {
        refreshStore.setSnapshot((prev) => ({ ...prev, isCalibrating: false }));
        return;
      }
      const measuredHz = snapRefreshRateHz(medianDt);
      const isWebKit = detectWebKitEngine();
      const likelyProMotion = detectLikelyProMotionAppleDevice();

      refreshStore.setSnapshot((prev) => {
        const nextPeakHz = resetPeak
          ? measuredHz
          : Math.max(
              prev.peakHz === 120 && prev.isCalibrating ? measuredHz : prev.peakHz,
              measuredHz,
            );
        const effectiveHz = resetPeak ? measuredHz : Math.max(measuredHz, nextPeakHz);
        const vsyncIntervalMs = Number((1000 / effectiveHz).toFixed(2));
        return {
          preference: prev.preference,
          detectedHz: effectiveHz,
          peakHz: nextPeakHz,
          vsyncIntervalMs,
          isCalibrating: false,
          isSafariWebKit60HzCapped: isWebKit && likelyProMotion && effectiveHz <= 60,
        };
      });
      syncDomDataset(refreshStore.getSnapshot());
    };

    calibrationRafId = window.requestAnimationFrame(step);
  };

  const armHighRefreshBurst = (durationMs: number = VRR_LEASE_DURATION_MS): void => {
    if (disposed) {
      return;
    }
    const snap = refreshStore.getSnapshot();
    if (snap.preference !== "max" || reducedMotionMql?.matches) {
      pauseBeacon();
      return;
    }
    const anim = ensureBeaconAnimation();
    if (anim !== null && anim.playState !== "running") {
      try {
        anim.play();
      } catch {
        // 忽略兼容异常
      }
    }
    if (leaseTimerId !== 0) {
      window.clearTimeout(leaseTimerId);
    }
    leaseTimerId = window.setTimeout(() => {
      leaseTimerId = 0;
      pauseBeacon();
    }, durationMs);

    // VRR / ProMotion 屏幕首次冷启动静置时可能回报 60Hz，首次真实交互唤醒后再采样一次以锁定真实峰值 Hz
    if (!hasMeasuredPostInteraction && snap.detectedHz <= 60 && calibrationRafId === 0) {
      hasMeasuredPostInteraction = true;
      runCalibration(false);
    }
  };

  activeAcquireBurst = armHighRefreshBurst;

  const handleDiscreteInput = (): void => {
    armHighRefreshBurst(VRR_LEASE_DURATION_MS);
  };

  const handlePointerMove = (): void => {
    const now = performance.now();
    if (now - lastPointerArmAt < POINTER_MOVE_REARM_INTERVAL_MS) {
      return;
    }
    lastPointerArmAt = now;
    armHighRefreshBurst(VRR_LEASE_DURATION_MS);
  };

  let dprMqlCleanup: (() => void) | null = null;
  const watchDevicePixelRatioChange = (): void => {
    dprMqlCleanup?.();
    if (typeof window.matchMedia !== "function") {
      return;
    }
    const mql = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    const onDprChange = (): void => {
      hasMeasuredPostInteraction = false;
      armHighRefreshBurst(900);
      runCalibration(true);
      watchDevicePixelRatioChange();
    };
    mql.addEventListener("change", onDprChange);
    dprMqlCleanup = () => mql.removeEventListener("change", onDprChange);
  };

  const handleWindowResize = (): void => {
    if (resizeDebounceId !== 0) {
      window.clearTimeout(resizeDebounceId);
    }
    resizeDebounceId = window.setTimeout(() => {
      resizeDebounceId = 0;
      runCalibration(false);
    }, 320);
  };

  const handleVisibilityChange = (): void => {
    if (document.visibilityState === "hidden") {
      pauseBeacon();
      return;
    }
    armHighRefreshBurst(VRR_LEASE_DURATION_MS);
    runCalibration(false);
  };

  const unsubscribeStore = refreshStore.subscribe(() => {
    if (refreshStore.getSnapshot().preference !== "max") {
      pauseBeacon();
    }
  });

  // 初始化同步 DOM 标记、宿主最高帧率请求，并立即唤醒首轮峰值校准
  syncDomDataset(refreshStore.getSnapshot());
  notifyNativeHost(refreshStore.getSnapshot().preference);
  armHighRefreshBurst(900);
  runCalibration(true);
  watchDevicePixelRatioChange();

  window.addEventListener("pointerdown", handleDiscreteInput, { passive: true });
  window.addEventListener("pointermove", handlePointerMove, { passive: true });
  window.addEventListener("wheel", handleDiscreteInput, { passive: true });
  window.addEventListener("touchstart", handleDiscreteInput, { passive: true });
  window.addEventListener("keydown", handleDiscreteInput, { passive: true });
  window.addEventListener("resize", handleWindowResize, { passive: true });
  document.addEventListener("visibilitychange", handleVisibilityChange);

  return () => {
    disposed = true;
    activeAcquireBurst = null;
    unsubscribeStore();
    dprMqlCleanup?.();
    if (calibrationRafId !== 0) {
      window.cancelAnimationFrame(calibrationRafId);
    }
    if (resizeDebounceId !== 0) {
      window.clearTimeout(resizeDebounceId);
    }
    pauseBeacon();
    try {
      beaconAnim?.cancel();
    } catch {
      // ignore
    }
    beaconEl?.remove();
    window.removeEventListener("pointerdown", handleDiscreteInput);
    window.removeEventListener("pointermove", handlePointerMove);
    window.removeEventListener("wheel", handleDiscreteInput);
    window.removeEventListener("touchstart", handleDiscreteInput);
    window.removeEventListener("keydown", handleDiscreteInput);
    window.removeEventListener("resize", handleWindowResize);
    document.removeEventListener("visibilitychange", handleVisibilityChange);
  };
}
