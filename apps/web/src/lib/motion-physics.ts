/**
 * @module web/lib/motion-physics
 * @description 原生客户端级 60–120fps 弹簧与流体曲线令牌库（对齐 Apple SwiftUI / AppKit、Linear 与 Raycast 动效规范）。
 *
 * 关键不变量：
 * 1. 仅驱动 GPU 合成属性（`transform` / `opacity`）：禁止用 JS 弹簧驱动 `width` / `height` / `margin` 等触发每帧 Layout 回流的属性。
 * 2. 进退场非对称时序：入场采用无过冲临界阻尼弹簧（赋予物理质量感），退场采用 120–140ms 快速流体曲线（`[0.32, 0.72, 0, 1]`）并立即释放指针事件，杜绝关窗拖泥带水。
 * 3. 系统无障碍同步：提供零副作用的 `usePrefersReducedMotion()` 外部存储订阅，当系统开启「减少动态效果」时自动回退瞬时过渡。
 */
import type { Transition } from "motion/react";
import { useSyncExternalStore } from "react";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function subscribeReducedMotion(listener: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return () => {};
  }
  const mql = window.matchMedia(REDUCED_MOTION_QUERY);
  mql.addEventListener("change", listener);
  return () => {
    mql.removeEventListener("change", listener);
  };
}

function getReducedMotionSnapshot(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

/**
 * 响应式读取系统「减少动态效果（prefers-reduced-motion）」偏好。
 *
 * @returns 开启减少动态效果时返回 `true`
 */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribeReducedMotion, getReducedMotionSnapshot, () => false);
}

/** 无障碍静态瞬时过渡 */
export const INSTANT_TRANSITION: Transition = {
  duration: 0.01,
};

/**
 * 分段滑块、导轨指示胶囊与列表选中底衬共享布局弹簧（`layoutId` 专用）。
 * 临界阻尼比 ≈ 1.0，120Hz 下迅速贴合且零残影回弹。
 */
export const NATIVE_PILL_SPRING: Transition = {
  type: "spring",
  stiffness: 540,
  damping: 38,
  mass: 0.72,
};

/** 桌面模态窗与命令面板入场弹簧 */
export const NATIVE_MODAL_SPRING: Transition = {
  type: "spring",
  stiffness: 520,
  damping: 36,
  mass: 0.76,
};

/** 桌面模态窗与浮层快速退场曲线（iOS / macOS Sheet 标准流体曲线） */
export const NATIVE_MODAL_EXIT: Transition = {
  duration: 0.135,
  ease: [0.32, 0.72, 0, 1],
};

/** 模态遮罩淡入/淡出过渡 */
export const NATIVE_BACKDROP_ENTER: Transition = {
  duration: 0.16,
  ease: [0.22, 1, 0.36, 1],
};

export const NATIVE_BACKDROP_EXIT: Transition = {
  duration: 0.125,
  ease: [0.32, 0.72, 0, 1],
};

/** 右侧分栏抽屉与浮层面板 GPU 滑入/收起弹簧 */
export const NATIVE_PANEL_SPRING: Transition = {
  type: "spring",
  stiffness: 480,
  damping: 38,
  mass: 0.78,
};

export const NATIVE_PANEL_EXIT: Transition = {
  duration: 0.14,
  ease: [0.32, 0.72, 0, 1],
};

/** 顶层空间切换（会话 ⇄ 工作台）GPU 临界阻尼弹簧与退场曲线（对齐 macOS / Arc Spaces 空间切换质感） */
export const NATIVE_SURFACE_SPRING: Transition = {
  type: "spring",
  stiffness: 460,
  damping: 38,
  mass: 0.78,
};

export const NATIVE_SURFACE_EXIT: Transition = {
  duration: 0.155,
  ease: [0.32, 0.72, 0, 1],
};

/** 实时新消息气泡轻盈入场弹簧（仅用于新发送或实时到达的消息，历史消息零动画挂载） */
export const NATIVE_LIVE_BUBBLE_SPRING: Transition = {
  type: "spring",
  stiffness: 520,
  damping: 36,
  mass: 0.68,
};

/** 视图切页与内容面板轻量过渡（140ms 柔和切入） */
export const NATIVE_VIEW_SWAP: Transition = {
  duration: 0.14,
  ease: [0.22, 1, 0.36, 1],
};

/** 内联折叠区平滑展开/收起曲线 */
export const NATIVE_DISCLOSURE_TRANSITION: Transition = {
  duration: 0.17,
  ease: [0.22, 1, 0.36, 1],
};
