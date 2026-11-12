/**
 * @module web/components/primitives/overlays
 * @description 基于 Radix UI 的无障碍浮层原语族：`AppTooltip`、`AppPopover` 与 `AppDropdownMenu`。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. Portal 顶层逃逸：所有浮层统一通过各自的 `*.Portal` 挂载至 `document.body`，彻底规避父级 `overflow-hidden` 或 `backdrop-filter` 导致的裁切与点击遮挡。
 * 2. Pachat 暖白/墨黑极简表面：`AppPopover` 与 `AppDropdownMenu` 采用纯净 `#FFFFFF` / `#18181B` 卡片表面与 `#F5F5F7` 柔和选中态，零紫蓝高亮。
 * 3. Electron/Tauri 拖拽免疫：浮层根节点统一附带 `.app-no-drag`，确保位于顶部工具条下方的弹出面板始终可交互。
 */
import { DropdownMenu, Popover, Tooltip } from "radix-ui";
import type { ComponentPropsWithoutRef, ReactElement, ReactNode } from "react";
import { cn } from "../../lib/cn.js";

/** 全局 `AppTooltipProvider` 入参属性 */
export interface AppTooltipProviderProps {
  /** 悬停触发延迟毫秒数（默认 `150`） */
  readonly delayDuration?: number | undefined;
  /** 连续扫过相邻按钮时的跳过延迟窗口毫秒数（默认 `250`） */
  readonly skipDelayDuration?: number | undefined;
  /** 应用子树 */
  readonly children: ReactNode;
}

/**
 * 全局 Tooltip 上下文提供者（在 `main.tsx` 顶层挂载一次即可）。
 *
 * @param props - 悬停延迟配置与子组件树
 * @returns Radix `Tooltip.Provider` 包装节点
 */
export function AppTooltipProvider(props: AppTooltipProviderProps) {
  const { delayDuration = 150, skipDelayDuration = 250, children } = props;
  return (
    <Tooltip.Provider delayDuration={delayDuration} skipDelayDuration={skipDelayDuration}>
      {children}
    </Tooltip.Provider>
  );
}

/** `AppTooltip` 入参属性 */
export interface AppTooltipProps {
  /** 气泡提示文案或富节点；为空或 `disabled` 时直接透传 `children` */
  readonly content: ReactNode;
  /** 可选右侧快捷键胶囊（如 `"⌘K"`、`"Enter"`） */
  readonly shortcut?: string | undefined;
  /** 弹出方向（默认 `"top"`） */
  readonly side?: "top" | "right" | "bottom" | "left" | undefined;
  /** 对齐方式（默认 `"center"`） */
  readonly align?: "start" | "center" | "end" | undefined;
  /** 与触发元素的间距像素（默认 `6`） */
  readonly sideOffset?: number | undefined;
  /** 单独覆盖悬停延迟毫秒数 */
  readonly delayDuration?: number | undefined;
  /** 是否禁用提示气泡 */
  readonly disabled?: boolean | undefined;
  /** 单个可聚焦触发元素（内部通过 `asChild` 注入引用与 ARIA 属性） */
  readonly children: ReactElement;
}

/**
 * 渲染紧凑纯墨黑高对比度悬浮提示胶囊（支持快捷键徽章展示）。
 *
 * @param props - 提示文案、快捷键、弹出方位与触发子节点
 * @returns Radix `Tooltip` 封装节点
 */
export function AppTooltip(props: AppTooltipProps) {
  const {
    content,
    shortcut,
    side = "top",
    align = "center",
    sideOffset = 6,
    delayDuration,
    disabled = false,
    children,
  } = props;

  if (disabled || content === null || content === undefined || content === "") {
    return children;
  }

  return (
    <Tooltip.Root {...(delayDuration !== undefined ? { delayDuration } : {})}>
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          side={side}
          align={align}
          sideOffset={sideOffset}
          collisionPadding={8}
          className={cn(
            "oh-tooltip-content pointer-events-none z-[110] inline-flex max-w-xs select-none items-center gap-1.5 rounded-lg px-2.5 py-1 text-[11.5px] font-medium leading-snug",
            "bg-[#141414]/95 text-white shadow-lg ring-1 ring-black/10 backdrop-blur-md",
            "dark:bg-[#27272A]/96 dark:text-zinc-100 dark:shadow-black/60 dark:ring-white/12",
          )}
        >
          <span>{content}</span>
          {shortcut !== undefined ? (
            <kbd className="rounded bg-white/15 px-1 py-0.2 font-mono text-[10px] font-semibold text-white/90 dark:bg-white/12">
              {shortcut}
            </kbd>
          ) : null}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

/** `AppPopover` 入参属性 */
export interface AppPopoverProps {
  /** 触发浮层的按钮或元素（内部通过 `Popover.Trigger asChild` 绑定） */
  readonly trigger: ReactElement;
  /** 浮层面板主体内容 */
  readonly children: ReactNode;
  /** 受控打开状态 */
  readonly open?: boolean | undefined;
  /** 受控开关变更回调 */
  readonly onOpenChange?: ((open: boolean) => void) | undefined;
  /** 弹出方向（默认 `"bottom"`） */
  readonly side?: "top" | "right" | "bottom" | "left" | undefined;
  /** 水平/垂直对齐基准（默认 `"end"`） */
  readonly align?: "start" | "center" | "end" | undefined;
  /** 距离触发器的像素偏移（默认 `8`） */
  readonly sideOffset?: number | undefined;
  /** 是否启用模态焦点锁定 */
  readonly modal?: boolean | undefined;
  /** 浮层卡片附加类名（可覆盖默认宽度或内边距） */
  readonly className?: string | undefined;
}

/** 关闭当前所属 `AppPopover` 的辅助触发器（等同 `Popover.Close`） */
export const AppPopoverClose = Popover.Close;

/**
 * 渲染纯净暖白/深灰悬浮交互卡片（用于顶栏轮次治理面板、输入框 `@` 点名选择器等场景）。
 *
 * @param props - 触发节点、受控开关、对齐策略与面板内容
 * @returns Radix `Popover` 封装组件
 */
export function AppPopover(props: AppPopoverProps) {
  const {
    trigger,
    children,
    open,
    onOpenChange,
    side = "bottom",
    align = "end",
    sideOffset = 8,
    modal,
    className,
  } = props;

  return (
    <Popover.Root
      {...(open !== undefined ? { open } : {})}
      {...(onOpenChange !== undefined ? { onOpenChange } : {})}
      {...(modal !== undefined ? { modal } : {})}
    >
      <Popover.Trigger asChild>{trigger}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side={side}
          align={align}
          sideOffset={sideOffset}
          collisionPadding={12}
          className={cn(
            "oh-floating-menu app-no-drag z-[90] w-80 rounded-2xl p-3.5 outline-none",
            "bg-white/98 text-[#141414] backdrop-blur-xl",
            "shadow-[0_18px_50px_-12px_rgba(0,0,0,0.16)] ring-1 ring-black/[0.08]",
            "dark:bg-[#18181B]/98 dark:text-zinc-100 dark:shadow-[0_22px_56px_-12px_rgba(0,0,0,0.76)] dark:ring-white/[0.11]",
            className,
          )}
        >
          {children}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** 声明式下拉菜单条目类型 */
export type AppDropdownEntry =
  | {
      readonly kind?: "item" | undefined;
      readonly id: string;
      readonly label: ReactNode;
      readonly icon?: ReactNode | undefined;
      readonly shortcut?: string | undefined;
      readonly danger?: boolean | undefined;
      readonly disabled?: boolean | undefined;
      readonly onSelect: () => void;
    }
  | {
      readonly kind: "separator";
      readonly id: string;
    }
  | {
      readonly kind: "label";
      readonly id: string;
      readonly label: ReactNode;
    };

/** `AppDropdownMenu` 入参属性 */
export interface AppDropdownMenuProps {
  /** 菜单触发按钮（通过 `DropdownMenu.Trigger asChild` 绑定） */
  readonly trigger: ReactElement;
  /** 声明式菜单项数组（与自定义 `children` 二选一或组合使用） */
  readonly items?: ReadonlyArray<AppDropdownEntry> | undefined;
  /** 自定义 `AppDropdownMenuItem` 等组合子节点 */
  readonly children?: ReactNode | undefined;
  /** 弹出方向（默认 `"bottom"`） */
  readonly side?: "top" | "right" | "bottom" | "left" | undefined;
  /** 对齐方式（默认 `"end"`） */
  readonly align?: "start" | "center" | "end" | undefined;
  /** 距离触发器偏移像素（默认 `6`） */
  readonly sideOffset?: number | undefined;
  /** 菜单容器附加类名 */
  readonly className?: string | undefined;
}

/**
 * 可组合式下拉菜单单项原语。
 *
 * @param props - Radix `DropdownMenu.Item` 属性及可选危险态标记
 * @returns 带柔和中性高亮背景与无障碍键盘支持的菜单项
 */
export function AppDropdownMenuItem(
  props: ComponentPropsWithoutRef<typeof DropdownMenu.Item> & {
    readonly danger?: boolean | undefined;
  },
) {
  const { danger = false, className, ...rest } = props;
  return (
    <DropdownMenu.Item
      className={cn(
        "relative flex cursor-pointer select-none items-center gap-2 rounded-xl px-2.5 py-1.5 text-[13px] font-medium outline-none transition-colors",
        danger
          ? "text-[#D70015] data-[highlighted]:bg-[#FF3B30]/10 data-[highlighted]:text-[#B80012] dark:text-[#FF6961] dark:data-[highlighted]:bg-[#FF453A]/15 dark:data-[highlighted]:text-[#FF8A84]"
          : "text-[#3A3A3C] data-[highlighted]:bg-[#F5F5F7] data-[highlighted]:text-[#141414] dark:text-zinc-200 dark:data-[highlighted]:bg-white/[0.08] dark:data-[highlighted]:text-white",
        "data-[disabled]:pointer-events-none data-[disabled]:opacity-45",
        className,
      )}
      {...rest}
    />
  );
}

/**
 * 下拉菜单分组标题原语。
 *
 * @param props - Radix `DropdownMenu.Label` 属性
 * @returns 紧凑分组标签节点
 */
export function AppDropdownMenuLabel(props: ComponentPropsWithoutRef<typeof DropdownMenu.Label>) {
  const { className, ...rest } = props;
  return (
    <DropdownMenu.Label
      className={cn(
        "px-2.5 py-1 text-[11px] font-semibold tracking-wider text-[#8E8E93] uppercase dark:text-zinc-500",
        className,
      )}
      {...rest}
    />
  );
}

/**
 * 下拉菜单水平分割线原语。
 *
 * @param props - Radix `DropdownMenu.Separator` 属性
 * @returns 1px 极细分割线节点
 */
export function AppDropdownMenuSeparator(
  props: ComponentPropsWithoutRef<typeof DropdownMenu.Separator>,
) {
  const { className, ...rest } = props;
  return (
    <DropdownMenu.Separator
      className={cn("my-1 h-px bg-black/[0.07] dark:bg-white/[0.08]", className)}
      {...rest}
    />
  );
}

/**
 * 渲染键盘方向键可达、带纯净暖白/墨黑浮层的上下文下拉菜单。
 *
 * @param props - 触发器、声明式条目或自定义菜单项子节点
 * @returns Radix `DropdownMenu` 封装组件
 */
export function AppDropdownMenu(props: AppDropdownMenuProps) {
  const {
    trigger,
    items,
    children,
    side = "bottom",
    align = "end",
    sideOffset = 6,
    className,
  } = props;

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>{trigger}</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side={side}
          align={align}
          sideOffset={sideOffset}
          collisionPadding={10}
          className={cn(
            "oh-floating-menu app-no-drag z-[95] min-w-[11.5rem] overflow-hidden rounded-2xl p-1 outline-none",
            "bg-white/98 text-[#141414] backdrop-blur-xl",
            "shadow-[0_16px_42px_-10px_rgba(0,0,0,0.15)] ring-1 ring-black/[0.08]",
            "dark:bg-[#18181B]/98 dark:text-zinc-100 dark:shadow-[0_20px_50px_-10px_rgba(0,0,0,0.75)] dark:ring-white/[0.12]",
            className,
          )}
        >
          {items?.map((entry) => {
            if (entry.kind === "separator") {
              return <AppDropdownMenuSeparator key={entry.id} />;
            }
            if (entry.kind === "label") {
              return <AppDropdownMenuLabel key={entry.id}>{entry.label}</AppDropdownMenuLabel>;
            }
            return (
              <AppDropdownMenuItem
                key={entry.id}
                danger={entry.danger}
                disabled={Boolean(entry.disabled)}
                onSelect={() => {
                  entry.onSelect();
                }}
              >
                {entry.icon !== undefined ? (
                  <span aria-hidden="true" className="inline-flex shrink-0 items-center">
                    {entry.icon}
                  </span>
                ) : null}
                <span className="flex-1 truncate">{entry.label}</span>
                {entry.shortcut !== undefined ? (
                  <kbd className="ml-3 font-mono text-[11px] text-[#8E8E93] dark:text-zinc-500">
                    {entry.shortcut}
                  </kbd>
                ) : null}
              </AppDropdownMenuItem>
            );
          })}
          {children}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
