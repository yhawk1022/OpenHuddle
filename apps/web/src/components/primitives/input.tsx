/**
 * @module web/components/primitives/input
 * @description Pachat 暖中性高对比度文本输入原语（`AppInput` 与 `AppTextarea`）。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 双主题对比度铁律：日光模式下为纯白底 + `border-black/[0.12]` 聚焦纯墨黑 `#141414`；暗色模式下恒定为 `#18181B` -> 聚焦 `#1F1F23` 暖深灰表面，彻底杜绝暗黑模式白底白字缺陷。
 * 2. 稳定 DOM 结构：`AppInput` 恒定采用外层容器承载可选 `leadingIcon` 与 `trailingSlot`，槽位动态显隐时 `<input>` 节点永不卸载失焦。
 * 3. Electron/Tauri 拖拽免疫：输入容器默认标记 `.app-no-drag`，在桌面端标题栏或工具条内始终可聚焦输入。
 */
import {
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
  forwardRef,
} from "react";
import { cn } from "../../lib/cn.js";

/** `AppInput` 高度尺寸档位 */
export type AppInputSize = "sm" | "md" | "lg";

const INPUT_SHELL_SIZE_CLASS: Record<AppInputSize, string> = {
  sm: "h-8 rounded-xl px-2.5 text-xs gap-1.5",
  md: "h-9 rounded-xl px-3 text-[13px] gap-2",
  lg: "h-10 rounded-xl px-3.5 text-sm gap-2.5",
};

const SURFACE_BASE_CLASS = [
  "app-no-drag transition-all duration-150",
  "border border-black/[0.12] bg-white text-[#141414]",
  "hover:border-black/[0.20]",
  "focus-within:border-[#141414] focus-within:ring-4 focus-within:ring-black/[0.06]",
  "dark:border-white/[0.12] dark:bg-[#18181B] dark:text-zinc-100",
  "dark:hover:border-white/[0.20]",
  "dark:focus-within:bg-[#1F1F23] dark:focus-within:border-white/35 dark:focus-within:ring-white/[0.07]",
].join(" ");

const INVALID_BORDER_CLASS =
  "border-[#FF3B30]/65 focus-within:border-[#FF3B30] focus-within:ring-[#FF3B30]/12 dark:border-[#FF453A]/65 dark:focus-within:border-[#FF453A] dark:focus-within:ring-[#FF453A]/15";

/** `AppInput` 入参属性 */
export interface AppInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "size"> {
  /** 输入框高度档位（默认 `"md"` = 36px） */
  readonly size?: AppInputSize | undefined;
  /** 输入框左侧内嵌图标（如搜索放大镜、邮箱或密钥图标） */
  readonly leadingIcon?: ReactNode | undefined;
  /** 输入框右侧内嵌槽位（如 `⌘K` 触发徽章、清空按钮或单位文本） */
  readonly trailingSlot?: ReactNode | undefined;
  /** 外层边框壳的附加类名 */
  readonly containerClassName?: string | undefined;
  /** 是否处于表单校验错误态 */
  readonly invalid?: boolean | undefined;
}

/**
 * 渲染支持前置图标与后置交互槽位的单行输入框。
 *
 * @param props - 尺寸、前后槽位、校验状态及原生 `<input>` 属性
 * @returns 双主题对比度安全的单行输入组件
 */
export const AppInput = forwardRef<HTMLInputElement, AppInputProps>(function AppInput(props, ref) {
  const {
    size = "md",
    leadingIcon,
    trailingSlot,
    containerClassName,
    invalid = false,
    disabled,
    className,
    ...rest
  } = props;

  return (
    <div
      className={cn(
        "flex w-full min-w-0 items-center",
        SURFACE_BASE_CLASS,
        INPUT_SHELL_SIZE_CLASS[size],
        invalid && INVALID_BORDER_CLASS,
        Boolean(disabled) && "cursor-not-allowed opacity-60",
        containerClassName,
      )}
    >
      {leadingIcon !== undefined ? (
        <span
          aria-hidden="true"
          className="inline-flex shrink-0 items-center text-[#8E8E93] dark:text-zinc-500"
        >
          {leadingIcon}
        </span>
      ) : null}
      <input
        ref={ref}
        disabled={disabled}
        aria-invalid={invalid || undefined}
        className={cn(
          "h-full w-full min-w-0 flex-1 border-0 bg-transparent p-0 text-inherit caret-[#141414] outline-none placeholder:text-[#8E8E93] disabled:cursor-not-allowed dark:caret-zinc-100 dark:placeholder:text-zinc-500",
          className,
        )}
        {...rest}
      />
      {trailingSlot !== undefined ? (
        <div className="inline-flex shrink-0 items-center">{trailingSlot}</div>
      ) : null}
    </div>
  );
});

/** `AppTextarea` 入参属性 */
export interface AppTextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  /** 是否处于表单校验错误态 */
  readonly invalid?: boolean | undefined;
}

/**
 * 渲染双主题高对比度的多行文本域（用于创建群聊议题、提案正文、附言等场景）。
 *
 * @param props - 校验状态与原生 `<textarea>` 属性
 * @returns 双主题对比度安全的 `<textarea>` 节点
 */
export const AppTextarea = forwardRef<HTMLTextAreaElement, AppTextareaProps>(
  function AppTextarea(props, ref) {
    const { invalid = false, disabled, rows = 3, className, ...rest } = props;

    return (
      <textarea
        ref={ref}
        rows={rows}
        disabled={disabled}
        aria-invalid={invalid || undefined}
        className={cn(
          "app-no-drag block w-full min-w-0 resize-y rounded-xl px-3 py-2.5 text-[13px] leading-relaxed outline-none transition-all duration-150",
          "border border-black/[0.12] bg-white text-[#141414] placeholder:text-[#8E8E93]",
          "hover:border-black/[0.20] focus:border-[#141414] focus:ring-4 focus:ring-black/[0.06]",
          "dark:border-white/[0.12] dark:bg-[#18181B] dark:text-zinc-100 dark:placeholder:text-zinc-500",
          "dark:hover:border-white/[0.20] dark:focus:bg-[#1F1F23] dark:focus:border-white/35 dark:focus:ring-white/[0.07]",
          "caret-[#141414] dark:caret-zinc-100",
          invalid &&
            "border-[#FF3B30]/65 focus:border-[#FF3B30] focus:ring-[#FF3B30]/12 dark:border-[#FF453A]/65 dark:focus:border-[#FF453A] dark:focus:ring-[#FF453A]/15",
          Boolean(disabled) && "cursor-not-allowed opacity-60",
          className,
        )}
        {...rest}
      />
    );
  },
);
