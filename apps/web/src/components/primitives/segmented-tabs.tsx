/**
 * @module web/components/primitives/segmented-tabs
 * @description 基于 `motion` 弹簧物理（`layoutId` 共享布局动画）的 Apple Liquid Glass 分段滑块控制器（`SegmentedTabs`）。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 通透玻璃凹槽与晶面滑块：轨道采用半透玻璃凹槽（日光 `bg-black/[0.045]` / 暗夜 `dark:bg-white/[0.05]` + 细内环），激活态滑块使用主题表面色与柔影，消除生硬框线。
 * 2. 实例隔离安全：未显式传入 `layoutId` 时自动通过 React 19 `useId()` 生成唯一布局命名空间，确保同一页面并存多个 `SegmentedTabs` 时滑块绝不跨组件乱飞。
 * 3. 无障碍语义与键盘导航：完整支持 `role="tablist"` / `role="tab"`、`aria-selected` 以及左右方向键（`ArrowLeft` / `ArrowRight`）循环切换。
 */
import { motion } from "motion/react";
import { type KeyboardEvent, type ReactNode, useId } from "react";
import { cn } from "../../lib/cn.js";

/** 单个分段标签项定义 */
export interface SegmentedTabItem<T extends string = string> {
  /** 标签唯一值 */
  readonly value: T;
  /** 标签展示文本或富节点 */
  readonly label: ReactNode;
  /** 标签前置图标 */
  readonly icon?: ReactNode | undefined;
  /** 标签右侧紧凑计数或状态徽章 */
  readonly badge?: ReactNode | undefined;
  /** 是否禁用该分段 */
  readonly disabled?: boolean | undefined;
}

/** `SegmentedTabs` 尺寸档位 */
export type SegmentedTabsSize = "xs" | "sm" | "md";

const TRACK_SIZE_CLASS: Record<SegmentedTabsSize, string> = {
  xs: "rounded-full p-0.5",
  sm: "rounded-full p-1",
  md: "rounded-full p-1",
};

const TAB_SIZE_CLASS: Record<SegmentedTabsSize, string> = {
  xs: "h-6 rounded-full px-2.5 text-[11px] gap-1",
  sm: "h-7 rounded-full px-3 text-xs gap-1.5",
  md: "h-8 rounded-full px-3.5 text-[13px] gap-1.5",
};

const PILL_RADIUS_CLASS: Record<SegmentedTabsSize, string> = {
  xs: "rounded-full",
  sm: "rounded-full",
  md: "rounded-full",
};

/** `SegmentedTabs` 入参属性 */
export interface SegmentedTabsProps<T extends string = string> {
  /** 当前激活分段值 */
  readonly value: T;
  /** 切换分段回调 */
  readonly onValueChange: (value: T) => void;
  /** 分段列表 */
  readonly items: ReadonlyArray<SegmentedTabItem<T>>;
  /** 尺寸档位（默认 `"sm"`） */
  readonly size?: SegmentedTabsSize | undefined;
  /** 是否等宽撑满整行（适合侧栏「聊天 | 通讯录」、抽屉分栏、三态表决器） */
  readonly fullWidth?: boolean | undefined;
  /** 可选自定义 `motion` 共享布局 ID；缺省自动隔离生成 */
  readonly layoutId?: string | undefined;
  /** 无障碍分组标签 */
  readonly ariaLabel?: string | undefined;
  /** 附加外层类名 */
  readonly className?: string | undefined;
}

/**
 * 渲染带 `motion` 弹簧滑动纯白胶囊的 Pachat 分段控制器。
 *
 * @param props - 当前值、分段配置列表、尺寸与等宽策略
 * @returns 具备物理滑动高亮与键盘可达性的 `tablist` 组件
 */
export function SegmentedTabs<T extends string = string>(props: SegmentedTabsProps<T>) {
  const {
    value,
    onValueChange,
    items,
    size = "sm",
    fullWidth = false,
    layoutId,
    ariaLabel,
    className,
  } = props;

  const reactId = useId();
  const resolvedLayoutId = layoutId ?? `oh-seg-pill-${reactId}`;

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
      return;
    }
    const enabledItems = items.filter((item) => !item.disabled);
    if (enabledItems.length <= 1) {
      return;
    }
    const currentIndex = enabledItems.findIndex((item) => item.value === value);
    if (currentIndex < 0) {
      return;
    }
    event.preventDefault();
    const delta = event.key === "ArrowRight" ? 1 : -1;
    const nextIndex = (currentIndex + delta + enabledItems.length) % enabledItems.length;
    const nextItem = enabledItems[nextIndex];
    if (nextItem !== undefined) {
      onValueChange(nextItem.value);
    }
  };

  return (
    <div
      role="tablist"
      onKeyDown={handleKeyDown}
      {...(ariaLabel !== undefined ? { "aria-label": ariaLabel } : {})}
      className={cn(
        "app-no-drag inline-flex select-none items-center",
        "bg-black/[0.048] dark:bg-white/[0.055]",
        TRACK_SIZE_CLASS[size],
        fullWidth && "flex w-full",
        className,
      )}
    >
      {items.map((item) => {
        const isActive = item.value === value;
        const isDisabled = Boolean(item.disabled);

        return (
          <button
            key={item.value}
            type="button"
            role="tab"
            aria-selected={isActive}
            tabIndex={isActive ? 0 : -1}
            disabled={isDisabled}
            onClick={() => {
              if (!isDisabled && item.value !== value) {
                onValueChange(item.value);
              }
            }}
            className={cn(
              "relative z-0 inline-flex cursor-pointer items-center justify-center font-medium tracking-[-0.01em] outline-none transition-colors duration-150",
              "focus-visible:ring-2 focus-visible:ring-black/[0.15] dark:focus-visible:ring-white/[0.22]",
              "disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-45",
              TAB_SIZE_CLASS[size],
              fullWidth && "min-w-0 flex-1",
              isActive
                ? "font-semibold text-[#111318] dark:text-[#F2F2F4]"
                : "text-[#687082] hover:text-[#111318] dark:text-[#8E8E96] dark:hover:text-[#F2F2F4]",
            )}
          >
            {isActive ? (
              <motion.span
                layoutId={resolvedLayoutId}
                aria-hidden="true"
                transition={{ type: "spring", stiffness: 520, damping: 36 }}
                className={cn(
                  "pointer-events-none absolute inset-0 -z-10",
                  "bg-im-surface shadow-[0_1px_4px_rgba(15,23,42,0.07),0_1px_2px_rgba(15,23,42,0.03)]",
                  "dark:bg-white/[0.13] dark:shadow-[0_2px_8px_rgba(0,0,0,0.34),inset_0_1px_0_rgba(255,255,255,0.14)]",
                  PILL_RADIUS_CLASS[size],
                )}
              />
            ) : null}

            {item.icon !== undefined ? (
              <span aria-hidden="true" className="inline-flex shrink-0 items-center">
                {item.icon}
              </span>
            ) : null}
            <span className="truncate">{item.label}</span>
            {item.badge !== undefined ? (
              <span
                className={cn(
                  "inline-flex shrink-0 items-center justify-center rounded-full px-1.5 py-0.2 text-[10px] font-semibold leading-4 tabular-nums",
                  isActive
                    ? "bg-[#181B22]/10 text-[#111318] dark:bg-white/[0.15] dark:text-[#F2F2F4]"
                    : "bg-black/[0.05] text-[#687082] dark:bg-white/[0.07] dark:text-[#8E8E96]",
                )}
              >
                {item.badge}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
