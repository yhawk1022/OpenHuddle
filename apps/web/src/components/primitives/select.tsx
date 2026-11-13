/**
 * @module web/components/primitives/select
 * @description 基于 Radix UI `Select` 构建的 Pachat 极简浮层下拉选择器（`AppSelect`），彻底替代浏览器原生下拉框元素。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 全平台视觉统一：通过 `Select.Portal` 将弹出菜单挂载至顶层视口，采用纯净 `#FFFFFF` / `#18181B` 暖中性浮层表面与墨黑对勾指示，零蓝紫高亮。
 * 2. 泛型强类型推导：`AppSelect<T extends string>` 直接保持业务字面量联合类型（如 `GovernanceMode` 或 `AgentPlatform`），调用方无需做 `as` 类型强转。
 * 3. Radix 非空值约束：每个选项的 `value` 必须是非空字符串（若需表达“不选/无”，请使用如 `"__none__"` 哨兵值而非 `""`）。
 */
import { Check, ChevronDown } from "lucide-react";
import { Select } from "radix-ui";
import type { ReactNode } from "react";
import { cn } from "../../lib/cn.js";

/** 单个下拉选项的数据结构 */
export interface AppSelectOption<T extends string = string> {
  /** 选项唯一值（必须为非空字符串） */
  readonly value: T;
  /** 触发器与菜单列表展示的主标题 */
  readonly label: ReactNode;
  /** 菜单项内可选的辅助副文案 */
  readonly description?: string | undefined;
  /** 选项左侧可选图标或徽章 */
  readonly icon?: ReactNode | undefined;
  /** 是否禁用该选项 */
  readonly disabled?: boolean | undefined;
}

/** `AppSelect` 尺寸档位 */
export type AppSelectSize = "sm" | "md" | "lg";

const SELECT_TRIGGER_SIZE_CLASS: Record<AppSelectSize, string> = {
  sm: "h-8 rounded-xl px-2.5 text-xs gap-1.5",
  md: "h-9 rounded-xl px-3 text-[13px] gap-2",
  lg: "h-10 rounded-xl px-3.5 text-sm gap-2",
};

/** `AppSelect` 入参属性 */
export interface AppSelectProps<T extends string = string> {
  /** 当前选中的值 */
  readonly value: T;
  /** 选中项变更回调（自动推导为泛型 `T`） */
  readonly onValueChange: (value: T) => void;
  /** 候选列表 */
  readonly options: ReadonlyArray<AppSelectOption<T>>;
  /** 未匹配值时的占位提示 */
  readonly placeholder?: string | undefined;
  /** 是否禁用整个下拉器 */
  readonly disabled?: boolean | undefined;
  /** 触发器高度尺寸（默认 `"md"`） */
  readonly size?: AppSelectSize | undefined;
  /** 触发器无障碍标签（当未绑定外部 `<label htmlFor>` 时使用） */
  readonly ariaLabel?: string | undefined;
  /** 关联外部 `<label htmlFor>` 的 DOM id */
  readonly id?: string | undefined;
  /** 表单字段名 */
  readonly name?: string | undefined;
  /** 触发器最左侧固定图标 */
  readonly leadingIcon?: ReactNode | undefined;
  /** 弹出菜单相对触发器的水平对齐方式（默认 `"start"`） */
  readonly align?: "start" | "center" | "end" | undefined;
  /** 触发器附加类名 */
  readonly className?: string | undefined;
  /** 弹出浮层附加类名 */
  readonly contentClassName?: string | undefined;
}

/**
 * 渲染无障碍键盘可达、带选中对勾指示器与暖中性浮层的下拉选择器。
 *
 * @param props - 泛型选中值、候选数组、尺寸与无障碍属性
 * @returns Radix `Select` 封装组件
 */
export function AppSelect<T extends string = string>(props: AppSelectProps<T>) {
  const {
    value,
    onValueChange,
    options,
    placeholder,
    disabled = false,
    size = "md",
    ariaLabel,
    id,
    name,
    leadingIcon,
    align = "start",
    className,
    contentClassName,
  } = props;

  const handleValueChange = (next: string): void => {
    // 候选值均来自只读泛型数组 `options`，在回调边界安全收窄回 `T`
    const matched = options.find((opt) => opt.value === next);
    if (matched !== undefined) {
      onValueChange(matched.value);
    }
  };

  return (
    <Select.Root
      value={value}
      onValueChange={handleValueChange}
      disabled={disabled}
      {...(name !== undefined ? { name } : {})}
    >
      <Select.Trigger
        {...(id !== undefined ? { id } : {})}
        {...(ariaLabel !== undefined ? { "aria-label": ariaLabel } : {})}
        className={cn(
          "app-no-drag group inline-flex w-full min-w-0 cursor-pointer select-none items-center justify-between text-left font-medium outline-none transition-all duration-150",
          "border border-black/[0.12] bg-white text-[#141414]",
          "hover:bg-black/[0.02] hover:border-black/[0.20]",
          "focus-visible:border-[#141414] focus-visible:ring-4 focus-visible:ring-black/[0.06] data-[state=open]:border-[#141414] data-[state=open]:ring-4 data-[state=open]:ring-black/[0.06]",
          "dark:border-white/[0.12] dark:bg-[#18181B] dark:text-zinc-100",
          "dark:hover:bg-[#1F1F23] dark:hover:border-white/[0.20]",
          "dark:focus-visible:border-white/35 dark:focus-visible:ring-white/[0.07] dark:data-[state=open]:bg-[#1F1F23] dark:data-[state=open]:border-white/35 dark:data-[state=open]:ring-white/[0.07]",
          "data-[placeholder]:text-[#8E8E93] dark:data-[placeholder]:text-zinc-500",
          "disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-55",
          SELECT_TRIGGER_SIZE_CLASS[size],
          className,
        )}
      >
        <span className="flex min-w-0 flex-1 items-center gap-2 truncate">
          {leadingIcon !== undefined ? (
            <span
              aria-hidden="true"
              className="inline-flex shrink-0 items-center text-[#8E8E93] dark:text-zinc-500"
            >
              {leadingIcon}
            </span>
          ) : null}
          <span className="truncate">
            <Select.Value {...(placeholder !== undefined ? { placeholder } : {})} />
          </span>
        </span>
        <Select.Icon asChild>
          <ChevronDown
            aria-hidden="true"
            className="h-3.5 w-3.5 shrink-0 text-[#8E8E93] transition-transform duration-150 group-data-[state=open]:rotate-180 dark:text-zinc-500"
          />
        </Select.Icon>
      </Select.Trigger>

      <Select.Portal>
        <Select.Content
          position="popper"
          align={align}
          sideOffset={6}
          className={cn(
            "glass-modal oh-floating-menu app-no-drag z-[95] max-h-72 min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-2xl p-1",
            "text-[#141414]",
            "dark:text-zinc-100",
            contentClassName,
          )}
        >
          <Select.Viewport className="p-0.5">
            {options.map((option) => (
              <Select.Item
                key={option.value}
                value={option.value}
                disabled={Boolean(option.disabled)}
                className={cn(
                  "relative flex cursor-pointer select-none items-center gap-2 rounded-xl py-1.5 pr-8 pl-2.5 text-[13px] outline-none transition-colors",
                  "text-[#3A3A3C] data-[highlighted]:bg-[#F5F5F7] data-[highlighted]:text-[#141414]",
                  "dark:text-zinc-300 dark:data-[highlighted]:bg-white/[0.08] dark:data-[highlighted]:text-white",
                  "data-[state=checked]:font-semibold data-[state=checked]:text-[#141414] dark:data-[state=checked]:text-white",
                  "data-[disabled]:pointer-events-none data-[disabled]:opacity-45",
                )}
              >
                {option.icon !== undefined ? (
                  <span aria-hidden="true" className="inline-flex shrink-0 items-center">
                    {option.icon}
                  </span>
                ) : null}
                <div className="min-w-0 flex-1">
                  <Select.ItemText>{option.label}</Select.ItemText>
                  {option.description !== undefined ? (
                    <p className="mt-0.5 truncate text-[11px] font-normal text-[#8E8E93] dark:text-zinc-400">
                      {option.description}
                    </p>
                  ) : null}
                </div>
                <Select.ItemIndicator className="absolute right-2.5 inline-flex items-center justify-center text-[#141414] dark:text-zinc-100">
                  <Check aria-hidden="true" className="h-3.5 w-3.5 stroke-[2.5]" />
                </Select.ItemIndicator>
              </Select.Item>
            ))}
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}
