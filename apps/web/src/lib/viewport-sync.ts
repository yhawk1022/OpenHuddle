/**
 * @module web/lib/viewport-sync
 * @description iOS Safari / Android Chrome / 微信 X5 统一可视视口（`visualViewport`）同步、软键盘状态检测与 Android IME 组合输入守卫。
 *
 * 架构不变量（Invariants）：
 * 1. 零重复扣减高度：配合 `<meta name="viewport" content="..., interactive-widget=resizes-content">`，
 *    页面高度和键盘偏移均跟随可视视口。iOS 主屏幕模式由系统分配状态栏和手势区。
 * 2. 无障碍缩放友好：仅当 `visualViewport.scale <= 1.01`（非用户双指手动放大态）时锁定视口偏移，不干扰无障碍双指放大检视。
 */
import { useSyncExternalStore } from "react";

const NON_TEXT_INPUT_TYPES = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "hidden",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);

/** 键盘事件最小兼容签名（覆盖原生 KeyboardEvent 与 React.KeyboardEvent） */
export interface ImeGuardKeyboardEventLike {
  readonly isComposing?: boolean;
  readonly keyCode?: number;
  readonly key?: string;
  readonly nativeEvent?: {
    readonly isComposing?: boolean;
    readonly keyCode?: number;
    readonly key?: string;
  };
}

/**
 * 判断键盘事件是否处于中日韩输入法（IME）候选词组合上屏阶段。
 * 兼容 Android 搜狗/讯飞/百度/微信输入法选词瞬间 `isComposing=false` 但 `keyCode === 229` 的经典边界情况。
 *
 * @param event - 原生或 React 键盘事件
 * @returns 若处于拼音/候选词组合态则返回 `true`（调用方应跳过回车提交）
 */
export function isImeComposing(event: ImeGuardKeyboardEventLike): boolean {
  const native = event.nativeEvent;
  return Boolean(
    event.isComposing ||
      native?.isComposing ||
      event.keyCode === 229 ||
      native?.keyCode === 229 ||
      event.key === "Process" ||
      native?.key === "Process",
  );
}

/**
 * 判断 DOM 节点是否为会唤起移动端软键盘的可编辑控件。
 */
export function isEditableElement(target: EventTarget | Element | null | undefined): boolean {
  if (!target || typeof target !== "object" || !("tagName" in target)) {
    return false;
  }
  const el = target as HTMLElement;
  const tag = el.tagName?.toUpperCase();
  if (tag === "TEXTAREA" || tag === "SELECT") {
    return !(el as HTMLTextAreaElement | HTMLSelectElement).disabled;
  }
  if (tag === "INPUT") {
    const input = el as HTMLInputElement;
    if (input.disabled || input.readOnly) {
      return false;
    }
    return !NON_TEXT_INPUT_TYPES.has((input.type || "text").toLowerCase());
  }
  return Boolean(el.isContentEditable || el.getAttribute?.("contenteditable") === "true");
}

/**
 * 判断当前设备是否为触屏主指针（手机/平板），用于在弹窗开场动画期间跳过破坏布局的 `autoFocus`。
 */
export function isCoarsePointerDevice(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia("(max-width: 767px), (pointer: coarse)").matches;
}

const MOBILE_MEDIA_QUERY = "(max-width: 767px)";

function subscribeMobileViewport(listener: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return () => {};
  }
  const mq = window.matchMedia(MOBILE_MEDIA_QUERY);
  mq.addEventListener("change", listener);
  return () => {
    mq.removeEventListener("change", listener);
  };
}

function getMobileViewportSnapshot(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia(MOBILE_MEDIA_QUERY).matches;
}

/**
 * 响应式订阅当前是否处于移动端窄视口（`< 768px`，对齐全局 `md` 断点）。
 */
export function useIsMobileViewport(): boolean {
  return useSyncExternalStore(subscribeMobileViewport, getMobileViewportSnapshot, () => false);
}

/**
 * 将可视视口的测量值与软键盘状态同步到根元素。
 *
 * @returns 卸载监听器的清理函数
 */
export function startVisualViewportSync(): () => void {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return () => {};
  }

  const root = document.documentElement;
  if ("standalone" in window.navigator && window.navigator.standalone) {
    // WebKit can clip the bottom of an installed app when cover extends it under the status bar.
    const viewport = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
    if (viewport?.content.includes("viewport-fit=cover")) {
      viewport.content = viewport.content.replace("viewport-fit=cover", "viewport-fit=contain");
    }
  }
  const vv = window.visualViewport;
  let baselineHeight = Math.max(window.innerHeight || 0, Math.round(vv?.height ?? 0));
  let rafId = 0;

  const syncViewport = (): void => {
    const scale = vv?.scale ?? 1;
    // 用户双指手动放大页面时不强改视口锁定，保留无障碍自由平移检视
    if (scale > 1.01) {
      return;
    }

    const rawHeight = vv?.height ?? window.innerHeight;
    const height = Math.max(1, Math.round(rawHeight));
    const offsetTop = Math.max(0, Math.round(vv?.offsetTop ?? 0));
    const activeEditable = isEditableElement(document.activeElement);

    if (!activeEditable || height > baselineHeight) {
      baselineHeight = height;
    }

    const isKeyboardOpen = activeEditable && baselineHeight - height > 130;

    root.style?.setProperty("--oh-vvh", `${height}px`);
    root.style?.setProperty("--oh-vv-offset-top", `${offsetTop}px`);
    if (root.dataset) {
      root.dataset.keyboardOpen = isKeyboardOpen ? "true" : "false";
    }

    // 平抑 iOS Safari 软键盘弹起时对整页 window 产生的异常滚移，杜绝顶栏飞出屏幕
    if (
      (isKeyboardOpen || offsetTop > 0) &&
      typeof window.scrollTo === "function" &&
      (window.scrollY !== 0 || window.scrollX !== 0)
    ) {
      window.scrollTo(0, 0);
    }
  };

  const scheduleSync = (): void => {
    syncViewport();
    if (typeof window.cancelAnimationFrame === "function") {
      window.cancelAnimationFrame(rafId);
    }
    if (typeof window.requestAnimationFrame === "function") {
      rafId = window.requestAnimationFrame(syncViewport);
    }
  };

  const handleOrientationChange = (): void => {
    baselineHeight = 0;
    scheduleSync();
  };

  const handleFocusOut = (): void => {
    // 软键盘收起动画约 220-300ms，延迟二次对齐确保回弹到底
    scheduleSync();
    window.setTimeout(scheduleSync, 260);
  };

  syncViewport();

  vv?.addEventListener("resize", scheduleSync);
  vv?.addEventListener("scroll", scheduleSync);
  window.addEventListener("resize", scheduleSync);
  window.addEventListener("orientationchange", handleOrientationChange);
  window.addEventListener("focusin", scheduleSync);
  window.addEventListener("focusout", handleFocusOut);

  return () => {
    if (typeof window.cancelAnimationFrame === "function") {
      window.cancelAnimationFrame(rafId);
    }
    vv?.removeEventListener("resize", scheduleSync);
    vv?.removeEventListener("scroll", scheduleSync);
    window.removeEventListener("resize", scheduleSync);
    window.removeEventListener("orientationchange", handleOrientationChange);
    window.removeEventListener("focusin", scheduleSync);
    window.removeEventListener("focusout", handleFocusOut);
  };
}
