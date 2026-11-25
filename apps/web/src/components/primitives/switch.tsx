/**
 * @module web/components/primitives/switch
 * @description 基于 Radix UI `Switch` 的 Atelier Daylight & Obsidian Studio 原生胶囊拨杆开关（`AppSwitch`）。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 遵循 WAI-ARIA `role="switch"` 规范，内置空格/回车切换及克制的焦点环。
 * 2. 双主题清晰辨识：关闭态采用柔和凹槽轨道，开启态切换为翡翠绿 `#16A34A`（暗夜 `#22C55E`）轨道 + 纯白立体滑块，零蓝紫渐变。
 */
import { Switch } from "radix-ui";
import { forwardRef } from "react";
import { cn } from "../../lib/cn.js";

/** `AppSwitch` 尺寸档位 */
export type AppSwitchSize = "sm" | "md";

/** `AppSwitch` 入参属性 */
export interface AppSwitchProps {
  /** 当前开关布尔状态 */
  readonly checked: boolean;
  /** 状态切换回调 */
  readonly onCheckedChange: (checked: boolean) => void;
  /** 是否禁用 */
  readonly disabled?: boolean | undefined;
  /** 胶囊尺寸（默认 `"md"`；紧凑浮层可选 `"sm"`） */
  readonly size?: AppSwitchSize | undefined;
  /** 关联 `<label htmlFor>` 的 DOM id */
  readonly id?: string | undefined;
  /** 表单字段名 */
  readonly name?: string | undefined;
  /** 无障碍读屏说明 */
  readonly ariaLabel?: string | undefined;
  /** 附加类名 */
  readonly className?: string | undefined;
}

/**
 * 渲染带顺滑滑块位移的 Apple `#34C759` 胶囊开关。
 *
 * @param props - 开关受控布尔值、回调、尺寸及无障碍属性
 * @returns Radix `Switch` 封装节点
 */
export const AppSwitch = forwardRef<HTMLButtonElement, AppSwitchProps>(
  function AppSwitch(props, ref) {
    const {
      checked,
      onCheckedChange,
      disabled = false,
      size = "md",
      id,
      name,
      ariaLabel,
      className,
    } = props;

    const isSmall = size === "sm";

    return (
      <Switch.Root
        ref={ref}
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
        {...(id !== undefined ? { id } : {})}
        {...(name !== undefined ? { name } : {})}
        {...(ariaLabel !== undefined ? { "aria-label": ariaLabel } : {})}
        className={cn(
          "app-no-drag group peer relative inline-flex shrink-0 cursor-pointer items-center rounded-full p-0.5 outline-none touch-manipulation transition-colors duration-200 ease-out",
          "bg-black/[0.11] hover:bg-black/[0.16]",
          "data-[state=checked]:bg-[#16A34A] data-[state=checked]:hover:bg-[#15803D]",
          "dark:bg-white/[0.12] dark:hover:bg-white/[0.18]",
          "dark:data-[state=checked]:bg-[#22C55E] dark:data-[state=checked]:hover:bg-[#34D399]",
          "focus-visible:ring-2 focus-visible:ring-black/[0.15] focus-visible:ring-offset-1 focus-visible:ring-offset-transparent dark:focus-visible:ring-white/[0.22]",
          "disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
          isSmall ? "h-5 w-9" : "h-6 w-11",
          className,
        )}
      >
        <Switch.Thumb
          className={cn(
            "pointer-events-none block rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.24)] ring-1 ring-black/[0.04] transition-transform duration-[220ms] ease-[cubic-bezier(0.22,1,0.36,1)] will-change-transform group-active:scale-x-[1.08]",
            isSmall
              ? "h-4 w-4 data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0"
              : "h-5 w-5 data-[state=checked]:translate-x-5 data-[state=unchecked]:translate-x-0",
          )}
        />
      </Switch.Root>
    );
  },
);
