/**
 * @module web/components/primitives/overlays
 * @description 基于 Radix UI 的无障碍浮层原语族：`AppTooltip`、`AppPopover`、`AppDropdownMenu` 与 Gmail 风格右键菜单 `AppContextMenu`。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. Portal 顶层逃逸：所有浮层统一通过各自的 `*.Portal` 挂载至 `document.body`，彻底规避父级 `overflow-hidden` 或 `backdrop-filter` 导致的裁切与点击遮挡。
 * 2. Apple Liquid Glass 浮层质感：`AppPopover`、`AppDropdownMenu` 与 `AppContextMenu` 统一使用 `relative liquid-glass-modal` 与低干扰中性选中态，明暗双主题均呈现 135° 菲涅尔高光边缘。
 * 3. Electron/Tauri 拖拽免疫：浮层根节点统一附带 `.app-no-drag`，确保位于顶部工具条下方的弹出面板始终可交互。
 */
import { ChevronRight } from "lucide-react";
import { ContextMenu, DropdownMenu, Popover, Tooltip } from "radix-ui";
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
            "oh-tooltip-content pointer-events-none z-[110] inline-flex max-w-xs select-none items-center gap-1.5 rounded-xl px-2.5 py-1 text-[11.5px] font-medium leading-snug",
            "bg-[#181B22]/88 text-white shadow-[0_8px_24px_rgba(15,23,42,0.22)] ring-1 ring-white/15 backdrop-blur-xl saturate-150",
            "dark:bg-[#242428]/92 dark:text-[#F2F2F4] dark:shadow-[0_12px_30px_rgba(0,0,0,0.68)] dark:ring-white/[0.14]",
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
            "relative liquid-glass-modal oh-floating-menu app-no-drag z-[90] w-80 rounded-2xl p-3.5 outline-none",
            "text-[#111318]",
            "dark:text-[#ECEFF6]",
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
          ? "text-[#C6282E] data-[highlighted]:bg-[#E5484D]/10 data-[highlighted]:text-[#B01F25] dark:text-[#F88B8B] dark:data-[highlighted]:bg-[#F05252]/15 dark:data-[highlighted]:text-[#FCA5A5]"
          : "text-[#3B414E] data-[highlighted]:bg-black/[0.04] data-[highlighted]:text-[#111318] dark:text-[#B4BCD0] dark:data-[highlighted]:bg-white/[0.07] dark:data-[highlighted]:text-[#ECEFF6]",
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
        "px-2.5 py-1 text-[11px] font-semibold tracking-wider text-[#939BAD] uppercase dark:text-[#586075]",
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
      className={cn("my-1 h-px bg-black/[0.06] dark:bg-white/[0.07]", className)}
      {...rest}
    />
  );
}

/**
 * 渲染键盘方向键可达、带精致浮层质感的上下文下拉菜单。
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
            "relative liquid-glass-modal oh-floating-menu app-no-drag z-[95] min-w-[11.5rem] overflow-hidden rounded-2xl p-1 outline-none",
            "text-[#111318]",
            "dark:text-[#ECEFF6]",
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
                  <kbd className="ml-3 font-mono text-[11px] text-[#939BAD] dark:text-[#586075]">
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

/** 声明式光标右键菜单条目类型（支持普通操作项、二级子菜单、分组标题与分割线） */
export type AppContextMenuEntry =
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
      readonly kind: "submenu";
      readonly id: string;
      readonly label: ReactNode;
      readonly icon?: ReactNode | undefined;
      readonly disabled?: boolean | undefined;
      readonly items: ReadonlyArray<AppContextMenuEntry>;
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

/** `AppContextMenu` 入参属性 */
export interface AppContextMenuProps {
  /** 挂载右键监听的宿主触发节点（必须为单个可接收原生 DOM 事件的 React 元素） */
  readonly children: ReactElement;
  /** 声明式右键菜单条目列表（自动清洗多余分割线与空分组） */
  readonly items: ReadonlyArray<AppContextMenuEntry>;
  /** 禁用自定义右键菜单并回退至浏览器原生行为（例如只读分享页） */
  readonly disabled?: boolean | undefined;
  /** 右键菜单打开/关闭状态变化回调 */
  readonly onOpenChange?: ((open: boolean) => void) | undefined;
  /** 菜单容器附加类名 */
  readonly className?: string | undefined;
}

/**
 * 规整右键菜单条目列表：递归清洗子菜单，剔除空子菜单、空分组标签以及首尾/连续重复分割线。
 *
 * @param entries - 原始声明式菜单条目数组
 * @returns 规整后可直接渲染的菜单条目数组
 */
export function normalizeContextMenuEntries(
  entries: ReadonlyArray<AppContextMenuEntry>,
): ReadonlyArray<AppContextMenuEntry> {
  // 1. 先递归规整二级子菜单，并丢弃没有任何可执行条目的空子菜单
  const resolved: AppContextMenuEntry[] = [];
  for (const entry of entries) {
    if (entry.kind === "submenu") {
      const normalizedSub = normalizeContextMenuEntries(entry.items);
      if (normalizedSub.length > 0) {
        resolved.push({
          ...entry,
          items: normalizedSub,
        });
      }
      continue;
    }
    resolved.push(entry);
  }

  // 2. 从后向前扫描，剔除下方无任何可操作条目的孤立分组标签（label）
  const withoutOrphanLabelsReversed: AppContextMenuEntry[] = [];
  let seenActionInSection = false;
  for (let i = resolved.length - 1; i >= 0; i -= 1) {
    const entry = resolved[i];
    if (entry === undefined) {
      continue;
    }
    if (entry.kind === "label") {
      if (seenActionInSection) {
        withoutOrphanLabelsReversed.push(entry);
        seenActionInSection = false;
      }
      continue;
    }
    if (entry.kind === "separator") {
      withoutOrphanLabelsReversed.push(entry);
      seenActionInSection = false;
      continue;
    }
    withoutOrphanLabelsReversed.push(entry);
    seenActionInSection = true;
  }
  const withoutOrphanLabels = withoutOrphanLabelsReversed.reverse();

  // 3. 合并连续分割线并去除首尾多余分割线
  const cleaned: AppContextMenuEntry[] = [];
  for (const entry of withoutOrphanLabels) {
    if (entry.kind === "separator") {
      if (cleaned.length === 0 || cleaned[cleaned.length - 1]?.kind === "separator") {
        continue;
      }
    }
    cleaned.push(entry);
  }
  while (cleaned[cleaned.length - 1]?.kind === "separator") {
    cleaned.pop();
  }

  return cleaned;
}

/**
 * 可组合式右键菜单单项原语（Gmail 风格宽松行距与中性高光悬停态）。
 *
 * @param props - Radix `ContextMenu.Item` 属性及可选危险态标记
 * @returns 无障碍键盘与指针可达的菜单项
 */
export function AppContextMenuItem(
  props: ComponentPropsWithoutRef<typeof ContextMenu.Item> & {
    readonly danger?: boolean | undefined;
  },
) {
  const { danger = false, className, ...rest } = props;
  return (
    <ContextMenu.Item
      className={cn(
        "relative flex cursor-pointer select-none items-center gap-2.5 rounded-xl px-2.5 py-2 text-[13px] font-medium outline-none transition-colors",
        danger
          ? "text-[#C6282E] data-[highlighted]:bg-[#E5484D]/10 data-[highlighted]:text-[#B01F25] dark:text-[#F88B8B] dark:data-[highlighted]:bg-[#F05252]/15 dark:data-[highlighted]:text-[#FCA5A5]"
          : "text-[#3B414E] data-[highlighted]:bg-black/[0.04] data-[highlighted]:text-[#111318] dark:text-[#B4BCD0] dark:data-[highlighted]:bg-white/[0.07] dark:data-[highlighted]:text-[#ECEFF6]",
        "data-[disabled]:pointer-events-none data-[disabled]:opacity-45",
        className,
      )}
      {...rest}
    />
  );
}

/**
 * 右键菜单分组标题原语。
 *
 * @param props - Radix `ContextMenu.Label` 属性
 * @returns 紧凑分组标签节点
 */
export function AppContextMenuLabel(props: ComponentPropsWithoutRef<typeof ContextMenu.Label>) {
  const { className, ...rest } = props;
  return (
    <ContextMenu.Label
      className={cn(
        "px-2.5 py-1 text-[11px] font-semibold tracking-wider text-[#939BAD] uppercase dark:text-[#586075]",
        className,
      )}
      {...rest}
    />
  );
}

/**
 * 右键菜单水平分割线原语。
 *
 * @param props - Radix `ContextMenu.Separator` 属性
 * @returns 1px 极细分割线节点
 */
export function AppContextMenuSeparator(
  props: ComponentPropsWithoutRef<typeof ContextMenu.Separator>,
) {
  const { className, ...rest } = props;
  return (
    <ContextMenu.Separator
      className={cn("my-1 h-px bg-black/[0.06] dark:bg-white/[0.07]", className)}
      {...rest}
    />
  );
}

/**
 * 右键菜单二级子菜单触发器原语（自带右箭头指示符）。
 *
 * @param props - Radix `ContextMenu.SubTrigger` 属性
 * @returns 带悬停与展开高亮的二级菜单触发项
 */
export function AppContextMenuSubTrigger(
  props: ComponentPropsWithoutRef<typeof ContextMenu.SubTrigger>,
) {
  const { className, children, ...rest } = props;
  return (
    <ContextMenu.SubTrigger
      className={cn(
        "relative flex cursor-pointer select-none items-center gap-2.5 rounded-xl px-2.5 py-2 text-[13px] font-medium text-[#3B414E] outline-none transition-colors",
        "data-[highlighted]:bg-black/[0.04] data-[highlighted]:text-[#111318] data-[state=open]:bg-black/[0.04] data-[state=open]:text-[#111318]",
        "dark:text-[#B4BCD0] dark:data-[highlighted]:bg-white/[0.07] dark:data-[highlighted]:text-[#ECEFF6] dark:data-[state=open]:bg-white/[0.07] dark:data-[state=open]:text-[#ECEFF6]",
        "data-[disabled]:pointer-events-none data-[disabled]:opacity-45",
        className,
      )}
      {...rest}
    >
      {children}
      <ChevronRight
        aria-hidden="true"
        className="ml-auto h-3.5 w-3.5 shrink-0 text-[#939BAD] dark:text-[#586075]"
      />
    </ContextMenu.SubTrigger>
  );
}

/**
 * 右键菜单二级子菜单浮层容器原语。
 *
 * @param props - Radix `ContextMenu.SubContent` 属性
 * @returns `liquid-glass-modal` 风格的二级子菜单面板
 */
export function AppContextMenuSubContent(
  props: ComponentPropsWithoutRef<typeof ContextMenu.SubContent>,
) {
  const { className, ...rest } = props;
  return (
    <ContextMenu.SubContent
      collisionPadding={10}
      onClick={(event) => event.stopPropagation()}
      className={cn(
        "relative liquid-glass-modal oh-floating-menu app-no-drag z-[96] min-w-[11.5rem] overflow-hidden rounded-2xl p-1.5 text-[#111318] outline-none dark:text-[#ECEFF6]",
        className,
      )}
      {...rest}
    />
  );
}

function renderContextMenuEntries(entries: ReadonlyArray<AppContextMenuEntry>): ReactNode {
  return entries.map((entry) => {
    if (entry.kind === "separator") {
      return <AppContextMenuSeparator key={entry.id} />;
    }
    if (entry.kind === "label") {
      return <AppContextMenuLabel key={entry.id}>{entry.label}</AppContextMenuLabel>;
    }
    if (entry.kind === "submenu") {
      return (
        <ContextMenu.Sub key={entry.id}>
          <AppContextMenuSubTrigger disabled={Boolean(entry.disabled)}>
            {entry.icon !== undefined ? (
              <span aria-hidden="true" className="inline-flex shrink-0 items-center">
                {entry.icon}
              </span>
            ) : null}
            <span className="flex-1 truncate">{entry.label}</span>
          </AppContextMenuSubTrigger>
          <ContextMenu.Portal>
            <AppContextMenuSubContent>
              {renderContextMenuEntries(entry.items)}
            </AppContextMenuSubContent>
          </ContextMenu.Portal>
        </ContextMenu.Sub>
      );
    }
    return (
      <AppContextMenuItem
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
          <kbd className="ml-3 font-mono text-[11px] text-[#939BAD] dark:text-[#586075]">
            {entry.shortcut}
          </kbd>
        ) : null}
      </AppContextMenuItem>
    );
  });
}

/**
 * 渲染模仿 Gmail 体验的光标右键上下文菜单（精准定位指针坐标、自动边界避让、支持二级子菜单与长按触发）。
 *
 * @remarks
 * 当 `disabled === true` 或清洗后无可展示条目时，直接透传 `children` 以保留浏览器默认右键菜单。
 * 触发器会在菜单打开期间获得 `data-state="open"` 属性，供条目卡片呈现类似 Gmail 的持久高亮选中底色。
 *
 * @param props - 触发子节点、声明式菜单条目、禁用开关与面板状态回调
 * @returns Radix `ContextMenu` 封装节点
 */
export function AppContextMenu(props: AppContextMenuProps) {
  const { children, items, disabled = false, onOpenChange, className } = props;
  const normalizedItems = normalizeContextMenuEntries(items);

  if (disabled || normalizedItems.length === 0) {
    return children;
  }

  return (
    <ContextMenu.Root {...(onOpenChange !== undefined ? { onOpenChange } : {})}>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content
          collisionPadding={10}
          onClick={(event) => event.stopPropagation()}
          className={cn(
            "relative liquid-glass-modal oh-floating-menu app-no-drag z-[95] min-w-[13rem] overflow-hidden rounded-2xl p-1.5 text-[#111318] outline-none dark:text-[#ECEFF6]",
            className,
          )}
        >
          {renderContextMenuEntries(normalizedItems)}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
