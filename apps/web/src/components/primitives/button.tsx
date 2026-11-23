/**
 * @module web/components/primitives/button
 * @description Atelier Daylight & Obsidian Studio 胶囊几何按钮原语（`AppButton` 与 `IconButton`）。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 精致胶囊几何（`rounded-full`）与微立体明暗层级：日光主按钮 `#181B22`（悬停 `#252A35`），暗夜主按钮 `#EAEEF6`（悬停 `#FFFFFF`），辅以细腻内微光与柔和阴影，摒弃廉价渐变。
 * 2. 默认显式注入 `type="button"` 与 `.app-no-drag`：既杜绝表单内误触提交，又确保按钮嵌入 Electron/Tauri 自定义拖拽标题栏时点击事件不被窗口拖拽吞没。
 * 3. 原生触感微交互：内置 `active:scale-[0.97]` 按压回弹与 `isLoading` 旋转指示态，禁用或加载期间自动锁死按压形变与重复点击。
 */
import { cva } from "class-variance-authority";
import { Loader2 } from "lucide-react";
import { type ButtonHTMLAttributes, type ReactNode, forwardRef } from "react";
import { cn } from "../../lib/cn.js";

/** `AppButton` 与 `IconButton` 共享的视觉变体枚举 */
export type AppButtonVariant = "primary" | "secondary" | "soft" | "ghost" | "danger" | "dangerSoft";

/** 按钮尺寸枚举 */
export type AppButtonSize = "xs" | "sm" | "md" | "lg";

/**
 * 标准胶囊文字/图文按钮的 CVA 样式生成器。
 *
 * @remarks
 * 导出供需要把链接（`<a>`）渲染为同款胶囊按钮外观的特殊场景复用。
 */
export const appButtonVariants = cva(
  [
    "app-no-drag relative inline-flex shrink-0 select-none items-center justify-center rounded-full font-medium tracking-[-0.01em]",
    "cursor-pointer transition-all duration-150 ease-out",
    "active:scale-[0.97] disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-45 disabled:active:scale-100",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black/[0.15] focus-visible:ring-offset-1 focus-visible:ring-offset-transparent dark:focus-visible:ring-white/[0.22]",
  ],
  {
    variants: {
      variant: {
        primary: [
          "bg-[#181B22] text-white shadow-[0_1px_2px_rgba(15,23,42,0.14),inset_0_1px_0_rgba(255,255,255,0.12)]",
          "hover:bg-[#252A35]",
          "dark:bg-[#EAEEF6] dark:text-[#111318] dark:shadow-[0_1px_4px_rgba(0,0,0,0.4),inset_0_1px_0_rgba(255,255,255,0.75)] dark:hover:bg-white",
        ],
        secondary: [
          "border border-black/[0.06] bg-im-surface text-[#111318] shadow-[0_1px_2px_rgba(15,23,42,0.03),inset_0_1px_0_rgba(255,255,255,0.35)]",
          "hover:bg-im-surface-muted hover:border-black/[0.10]",
          "dark:border-white/[0.09] dark:bg-white/[0.055] dark:text-[#ECEFF6] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] dark:hover:bg-white/[0.095] dark:hover:border-white/[0.14]",
        ],
        soft: [
          "bg-black/[0.045] text-[#111318]",
          "hover:bg-black/[0.08]",
          "dark:bg-white/[0.07] dark:text-[#ECEFF6] dark:hover:bg-white/[0.12]",
        ],
        ghost: [
          "bg-transparent text-[#687082]",
          "hover:bg-black/[0.045] hover:text-[#111318]",
          "dark:text-[#8E96AB] dark:hover:bg-white/[0.07] dark:hover:text-[#ECEFF6]",
        ],
        danger: [
          "bg-[#E5484D] text-white shadow-[0_1px_2px_rgba(229,72,77,0.22)]",
          "hover:bg-[#DC3B40]",
          "dark:bg-[#F05252] dark:text-white dark:hover:bg-[#F46464]",
        ],
        dangerSoft: [
          "bg-[#E5484D]/10 text-[#C6282E]",
          "hover:bg-[#E5484D]/16",
          "dark:bg-[#F05252]/14 dark:text-[#F88B8B] dark:hover:bg-[#F05252]/22",
        ],
      },
      size: {
        xs: "h-7 gap-1 px-3 text-xs",
        sm: "h-8 gap-1.5 px-3.5 text-xs",
        md: "h-9 gap-1.5 px-4 text-[13px]",
        lg: "h-10 gap-2 px-5 text-sm",
      },
      fullWidth: {
        true: "w-full",
        false: "",
      },
    },
    defaultVariants: {
      variant: "primary",
      size: "md",
      fullWidth: false,
    },
  },
);

/**
 * 纯图标圆形按钮的 CVA 样式生成器。
 */
export const iconButtonVariants = cva(
  [
    "app-no-drag relative inline-flex shrink-0 select-none items-center justify-center rounded-full",
    "cursor-pointer transition-all duration-150 ease-out",
    "active:scale-[0.95] disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-45 disabled:active:scale-100",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black/[0.15] dark:focus-visible:ring-white/[0.22]",
  ],
  {
    variants: {
      variant: {
        primary: [
          "bg-[#181B22] text-white shadow-[0_1px_2px_rgba(15,23,42,0.14)]",
          "hover:bg-[#252A35]",
          "dark:bg-[#EAEEF6] dark:text-[#111318] dark:hover:bg-white",
        ],
        secondary: [
          "border border-black/[0.10] bg-im-surface text-[#111318] shadow-[0_1px_2px_rgba(15,23,42,0.04)]",
          "hover:bg-im-surface-muted hover:border-black/[0.16]",
          "dark:border-white/[0.10] dark:bg-white/[0.05] dark:text-[#ECEFF6] dark:hover:bg-white/[0.09]",
        ],
        soft: [
          "bg-black/[0.045] text-[#111318]",
          "hover:bg-black/[0.08]",
          "dark:bg-white/[0.07] dark:text-[#ECEFF6] dark:hover:bg-white/[0.12]",
        ],
        ghost: [
          "bg-transparent text-[#687082]",
          "hover:bg-black/[0.05] hover:text-[#111318]",
          "dark:text-[#8E96AB] dark:hover:bg-white/[0.07] dark:hover:text-[#ECEFF6]",
        ],
        danger: [
          "bg-[#E5484D] text-white",
          "hover:bg-[#DC3B40]",
          "dark:bg-[#F05252] dark:hover:bg-[#F46464]",
        ],
        dangerSoft: [
          "bg-[#E5484D]/10 text-[#C6282E]",
          "hover:bg-[#E5484D]/16",
          "dark:bg-[#F05252]/14 dark:text-[#F88B8B] dark:hover:bg-[#F05252]/22",
        ],
      },
      size: {
        xs: "h-6 w-6",
        sm: "h-7 w-7",
        md: "h-8 w-8",
        lg: "h-9 w-9",
      },
    },
    defaultVariants: {
      variant: "ghost",
      size: "md",
    },
  },
);

/** `AppButton` 入参属性 */
export interface AppButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** 视觉层级变体（默认 `"primary"` = `#141414` 胶囊按钮） */
  readonly variant?: AppButtonVariant | undefined;
  /** 尺寸档位（默认 `"md"`） */
  readonly size?: AppButtonSize | undefined;
  /** 是否处于异步加载态；开启后展示旋转图标并自动禁止重复点击 */
  readonly isLoading?: boolean | undefined;
  /** 文本左侧前置图标槽位（加载态时自动替换为旋转指示器） */
  readonly leadingIcon?: ReactNode | undefined;
  /** 文本右侧后置图标槽位 */
  readonly trailingIcon?: ReactNode | undefined;
  /** 是否撑满父容器宽度 */
  readonly fullWidth?: boolean | undefined;
}

/**
 * 渲染 Pachat 极简胶囊风格的通用按钮。
 *
 * @remarks
 * 支持 `forwardRef` 以无缝作为 Radix `Tooltip.Trigger asChild`、`Popover.Trigger asChild` 或 `DropdownMenu.Trigger asChild` 的宿主元素。
 *
 * @param props - 按钮变体、尺寸、加载态与原生按钮事件属性
 * @returns 可直接聚焦与按压反馈的 `<button>` 节点
 */
export const AppButton = forwardRef<HTMLButtonElement, AppButtonProps>(
  function AppButton(props, ref) {
    const {
      variant = "primary",
      size = "md",
      isLoading = false,
      leadingIcon,
      trailingIcon,
      fullWidth = false,
      disabled,
      type,
      className,
      children,
      ...rest
    } = props;

    const isDisabled = Boolean(disabled) || isLoading;

    return (
      <button
        ref={ref}
        type={type ?? "button"}
        disabled={isDisabled}
        aria-busy={isLoading || undefined}
        className={cn(appButtonVariants({ variant, size, fullWidth }), className)}
        {...rest}
      >
        {isLoading ? (
          <Loader2 aria-hidden="true" className="h-3.5 w-3.5 shrink-0 animate-spin" />
        ) : (
          leadingIcon
        )}
        {children}
        {trailingIcon}
      </button>
    );
  },
);

/** `IconButton` 入参属性 */
export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** 无障碍读屏标签（纯图标按钮强烈建议传入，也可通过原生 `aria-label` 传入） */
  readonly label?: string | undefined;
  /** 视觉变体（默认 `"ghost"`，适配侧导轨、顶栏与消息操作区） */
  readonly variant?: AppButtonVariant | undefined;
  /** 圆形尺寸（默认 `"md"` = 32x32px） */
  readonly size?: AppButtonSize | undefined;
  /** 是否处于异步加载态 */
  readonly isLoading?: boolean | undefined;
}

/**
 * 渲染圆形纯图标按钮（用于侧边导轨、顶栏、代码块复制及消息工具条）。
 *
 * @remarks
 * 支持 `forwardRef` 与 Radix `asChild` 触发器组合，可直接包裹在 `<AppTooltip>` 内部。
 *
 * @param props - 图标子节点、读屏标签、尺寸与变体
 * @returns 无障碍友好的纯图标 `<button>` 节点
 */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  function IconButton(props, ref) {
    const {
      label,
      variant = "ghost",
      size = "md",
      isLoading = false,
      disabled,
      type,
      className,
      children,
      "aria-label": ariaLabelProp,
      ...rest
    } = props;

    const resolvedAriaLabel = ariaLabelProp ?? label;
    const isDisabled = Boolean(disabled) || isLoading;

    return (
      <button
        ref={ref}
        type={type ?? "button"}
        disabled={isDisabled}
        aria-busy={isLoading || undefined}
        {...(resolvedAriaLabel !== undefined ? { "aria-label": resolvedAriaLabel } : {})}
        className={cn(iconButtonVariants({ variant, size }), className)}
        {...rest}
      >
        {isLoading ? (
          <Loader2 aria-hidden="true" className="h-3.5 w-3.5 shrink-0 animate-spin" />
        ) : (
          children
        )}
      </button>
    );
  },
);
