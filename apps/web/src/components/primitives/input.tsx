/**
 * @module web/components/primitives/input
 * @description Atelier Daylight & Obsidian Studio 凹陷微质感高对比度文本输入原语（`AppInput` 与 `AppTextarea`）。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 双主题对比度铁律：日光模式下为微凹暖瓷表面 `#F6F7FA` -> 聚焦纯白 `#FFFFFF`；暗色模式下恒定为 `#0F1219` -> 聚焦 `#131722` 深凹表面，搭配 3px 柔和聚焦光晕，彻底杜绝暗黑模式白底白字缺陷。
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
  "border border-black/[0.07] bg-black/[0.03] text-[#111318]",
  "hover:bg-black/[0.04] hover:border-black/[0.11]",
  "focus-within:bg-white focus-within:border-[#181B22]/25 focus-within:ring-[3px] focus-within:ring-[#181B22]/[0.06]",
  "dark:border-white/[0.08] dark:bg-[#161619] dark:text-[#F2F2F4]",
  "dark:hover:border-white/[0.14]",
  "dark:focus-within:bg-[#1C1C20] dark:focus-within:border-white/[0.22] dark:focus-within:ring-white/[0.07]",
].join(" ");

const INVALID_BORDER_CLASS =
  "border-[#E5484D]/65 focus-within:border-[#E5484D] focus-within:ring-[#E5484D]/12 dark:border-[#F05252]/65 dark:focus-within:border-[#F05252] dark:focus-within:ring-[#F05252]/15";

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
          className="inline-flex shrink-0 items-center text-[#939BAD] dark:text-[#586075]"
        >
          {leadingIcon}
        </span>
      ) : null}
      <input
        ref={ref}
        disabled={disabled}
        aria-invalid={invalid || undefined}
        className={cn(
          "h-full w-full min-w-0 flex-1 border-0 bg-transparent p-0 text-inherit caret-[#181B22] outline-none placeholder:text-[#939BAD] disabled:cursor-not-allowed dark:caret-[#F2F2F4] dark:placeholder:text-[#63636B]",
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
          "border border-black/[0.10] bg-[#F6F7FA] text-[#111318] placeholder:text-[#939BAD]",
          "hover:border-black/[0.16] focus:bg-white focus:border-[#181B22]/35 focus:ring-[3px] focus:ring-[#181B22]/[0.07]",
          "dark:border-white/[0.09] dark:bg-[#161619] dark:text-[#F2F2F4] dark:placeholder:text-[#63636B]",
          "dark:hover:border-white/[0.16] dark:focus:bg-[#1C1C20] dark:focus:border-white/[0.25] dark:focus:ring-white/[0.08]",
          "caret-[#181B22] dark:caret-[#F2F2F4]",
          invalid &&
            "border-[#E5484D]/65 focus:border-[#E5484D] focus:ring-[#E5484D]/12 dark:border-[#F05252]/65 dark:focus:border-[#F05252] dark:focus:ring-[#F05252]/15",
          Boolean(disabled) && "cursor-not-allowed opacity-60",
          className,
        )}
        {...rest}
      />
    );
  },
);
