/**
 * @module web/lib/cn
 * @description Tailwind CSS v4 原子类名条件拼接与冲突消解工具函数。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 先经 `clsx` 过滤布尔短路、数组与条件字典，再由 `tailwind-merge` 按层消解冲突工具类（如调用方覆盖 `px-*`、`bg-*`、`rounded-*`）。
 * 2. 纯函数无副作用：所有 `primitives/*` 与业务组件统一通过本函数暴露 `className` 扩展点，杜绝字符串手拼导致的样式优先级偶发失效。
 */
import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export type { ClassValue };

/**
 * 合并条件类名并自动消解同维度 Tailwind CSS 冲突工具类。
 *
 * @remarks
 * 当基础原语定义了默认间距或圆角（例如 `rounded-xl px-3`），而业务层传入 `className="rounded-full px-4"` 时，
 * `twMerge` 会精确保留后者，避免双类名并存引发的 CSS 声明顺序不确定性。
 *
 * @param inputs - 任意数量的 `clsx` 兼容类名表达式（字符串、对象、数组或布尔假值）
 * @returns 去重并消解冲突后的类名字符串
 */
export function cn(...inputs: ReadonlyArray<ClassValue>): string {
  return twMerge(clsx(...inputs));
}
