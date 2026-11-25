/**
 * @module web/components/primitives/command-palette
 * @description 基于 `cmdk` + Radix `Dialog` + `motion` 构建的 Apple Liquid Glass 全局命令面板（`AppCommandPalette`）。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 全局快捷键唤醒：默认监听 `⌘K`（macOS）与 `Ctrl+K`（Windows/Linux），一键呼出或收起群聊切换、创建/加入群、接入 Agent、触发提案归纳与主题切换。
 * 2. 晶莹浮层与 135° 高光边框：采用 `liquid-glass-modal` 液态玻璃表面与柔和聚焦选中态，彻底免疫暗黑模式白底白字与廉价紫光污染。
 * 3. 无障碍与键盘优先：内置 `cmdk` 模糊检索评分、上下方向键循环导航、`Enter` 立即执行与 `Escape` 关闭。
 */
import { Command } from "cmdk";
import { CornerDownLeft, Search, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { Dialog } from "radix-ui";
import { type ReactNode, useEffect } from "react";
import { cn } from "../../lib/cn.js";
import {
  INSTANT_TRANSITION,
  NATIVE_BACKDROP_ENTER,
  NATIVE_BACKDROP_EXIT,
  NATIVE_MODAL_EXIT,
  NATIVE_MODAL_SPRING,
  usePrefersReducedMotion,
} from "../../lib/motion-physics.js";
import { useMobileOverlayBackGuard } from "../../lib/session-store.js";
import { useIsMobileViewport } from "./sheet-modal.js";

/** 命令面板单条可执行动作 */
export interface CommandPaletteActionItem {
  /** 全局唯一动作 ID */
  readonly id: string;
  /** 主展示标题 */
  readonly label: string;
  /** 标题右侧或下方的辅助说明（如群聊议题、Agent 宿主类型） */
  readonly subtitle?: string | undefined;
  /** 左侧图标节点 */
  readonly icon?: ReactNode | undefined;
  /** 右侧快捷键提示（如 `"⌘N"`、`"⌘J"`） */
  readonly shortcut?: string | undefined;
  /** 右侧状态微标（如在线小绿点或未读数） */
  readonly badge?: ReactNode | undefined;
  /** 额外检索关键词（支持拼音/英文别名检索） */
  readonly keywords?: ReadonlyArray<string> | undefined;
  /** 是否禁用该动作 */
  readonly disabled?: boolean | undefined;
  /** 选中执行回调（组件会在调用后自动关闭命令面板） */
  readonly onSelect: () => void;
}

/** 命令面板分组结构 */
export interface CommandPaletteGroup {
  /** 分组唯一 ID */
  readonly id: string;
  /** 分组标题文案 */
  readonly heading: string;
  /** 组内动作列表 */
  readonly items: ReadonlyArray<CommandPaletteActionItem>;
}

/** `AppCommandPalette` 入参属性 */
export interface AppCommandPaletteProps {
  /** 是否打开面板 */
  readonly open: boolean;
  /** 开关状态回调 */
  readonly onOpenChange: (open: boolean) => void;
  /** 分组动作集合 */
  readonly groups: ReadonlyArray<CommandPaletteGroup>;
  /** 搜索框占位提示 */
  readonly placeholder?: string | undefined;
  /** 无匹配结果时的空状态文案 */
  readonly emptyText?: string | undefined;
  /** 是否注册全局 `⌘K` / `Ctrl+K` 快捷键（默认 `true`） */
  readonly enableGlobalShortcut?: boolean | undefined;
  /** 底部左侧可选状态说明 */
  readonly footerHint?: ReactNode | undefined;
}

/**
 * 渲染纯净墨黑/暖白极简质感的全局 `⌘K` 命令面板。
 *
 * @param props - 开关控制、分组动作列表、占位提示与快捷键开关
 * @returns `cmdk` + Radix `Dialog` 封装组件
 */
export function AppCommandPalette(props: AppCommandPaletteProps) {
  const {
    open,
    onOpenChange,
    groups,
    placeholder = "搜索群聊、Agent 或快捷操作…",
    emptyText = "没有找到匹配的群聊或操作",
    enableGlobalShortcut = true,
    footerHint,
  } = props;

  useEffect(() => {
    if (!enableGlobalShortcut) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        onOpenChange(!open);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [enableGlobalShortcut, open, onOpenChange]);

  const reducedMotion = usePrefersReducedMotion();
  const isMobile = useIsMobileViewport();
  useMobileOverlayBackGuard(open && isMobile, () => {
    onOpenChange(false);
  });

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <AnimatePresence>
        {open ? (
          <Dialog.Portal key="cmd-palette-portal" forceMount>
            <Dialog.Overlay forceMount asChild>
              <motion.div
                initial={{ opacity: 0 }}
                animate={{
                  opacity: 1,
                  transition: reducedMotion ? INSTANT_TRANSITION : NATIVE_BACKDROP_ENTER,
                }}
                exit={{
                  opacity: 0,
                  pointerEvents: "none",
                  transition: reducedMotion ? INSTANT_TRANSITION : NATIVE_BACKDROP_EXIT,
                }}
                className="app-no-drag fixed inset-0 z-[98] bg-[#090A0E]/30 will-change-[opacity] dark:bg-[#050609]/60"
              />
            </Dialog.Overlay>
            <Dialog.Content forceMount asChild>
              <motion.div
                initial={reducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.965, y: -8 }}
                animate={{
                  opacity: 1,
                  scale: 1,
                  y: 0,
                  transition: reducedMotion ? INSTANT_TRANSITION : NATIVE_MODAL_SPRING,
                }}
                exit={
                  reducedMotion
                    ? { opacity: 0, pointerEvents: "none", transition: INSTANT_TRANSITION }
                    : {
                        opacity: 0,
                        scale: 0.975,
                        y: -5,
                        pointerEvents: "none",
                        transition: NATIVE_MODAL_EXIT,
                      }
                }
                className={cn(
                  "liquid-glass-modal app-no-drag fixed inset-x-0 top-[max(0.75rem,env(safe-area-inset-top,0px))] sm:top-[13vh] z-[99] mx-auto flex max-h-[calc(var(--oh-vvh,100dvh)-1.5rem)] w-[calc(100%-1.25rem)] sm:w-[calc(100%-1.5rem)] max-w-[560px] flex-col overflow-hidden rounded-[22px] outline-none will-change-[transform,opacity]",
                  "text-[#111318]",
                  "dark:text-[#ECEFF6]",
                )}
              >
                <div className="sr-only">
                  <Dialog.Title>全局快捷搜索</Dialog.Title>
                  <Dialog.Description>快速切换群聊、查看我的 Agent 或执行操作</Dialog.Description>
                </div>

                <Command
                  label="OpenHuddle 全局命令面板"
                  loop={true}
                  className="flex min-h-0 flex-1 flex-col overflow-hidden"
                >
                  {/* 顶部搜索栏 */}
                  <div className="flex shrink-0 items-center gap-2.5 border-b border-black/[0.06] px-3.5 py-2.5 sm:px-4 sm:py-3 dark:border-white/[0.07]">
                    <Search
                      aria-hidden="true"
                      className="h-4 w-4 shrink-0 text-[#939BAD] dark:text-[#7D869C]"
                    />
                    <Command.Input
                      placeholder={placeholder}
                      enterKeyHint="search"
                      className="h-7 w-full min-w-0 flex-1 border-0 bg-transparent p-0 text-[16px] md:text-[14px] font-medium text-[#111318] caret-[#181B22] outline-none placeholder:text-[#939BAD] dark:text-[#ECEFF6] dark:caret-[#ECEFF6] dark:placeholder:text-[#586075]"
                    />
                    <Dialog.Close asChild>
                      <button
                        type="button"
                        aria-label="关闭搜索面板"
                        className="inline-flex h-8 w-8 sm:h-auto sm:w-auto shrink-0 cursor-pointer items-center justify-center rounded-full bg-black/[0.05] sm:px-2 sm:py-0.5 font-mono text-[10.5px] font-semibold text-[#687082] transition hover:bg-black/[0.09] hover:text-[#111318] dark:bg-white/[0.08] dark:text-[#7D869C] dark:hover:bg-white/[0.14] dark:hover:text-[#ECEFF6]"
                      >
                        <X aria-hidden="true" className="h-4 w-4 sm:hidden" />
                        <span className="hidden sm:inline">ESC</span>
                      </button>
                    </Dialog.Close>
                  </div>

                  {/* 检索候选列表 */}
                  <Command.List className="min-h-0 flex-1 max-h-[calc(var(--oh-vvh,100dvh)-5rem)] sm:max-h-[340px] overflow-y-auto overscroll-contain p-2">
                    <Command.Empty className="py-10 text-center text-xs text-[#939BAD] dark:text-[#7D869C]">
                      {emptyText}
                    </Command.Empty>

                    {groups.map((group) =>
                      group.items.length === 0 ? null : (
                        <Command.Group
                          key={group.id}
                          heading={group.heading}
                          className="[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-[#939BAD] [&_[cmdk-group-heading]]:uppercase dark:[&_[cmdk-group-heading]]:text-[#586075]"
                        >
                          {group.items.map((item) => {
                            const keywordList = item.keywords ? [...item.keywords] : undefined;
                            return (
                              <Command.Item
                                key={item.id}
                                value={`${item.label} ${item.subtitle ?? ""} ${item.id}`}
                                {...(keywordList !== undefined ? { keywords: keywordList } : {})}
                                disabled={Boolean(item.disabled)}
                                onSelect={() => {
                                  onOpenChange(false);
                                  item.onSelect();
                                }}
                                className={cn(
                                  "group flex cursor-pointer select-none items-center gap-3 rounded-xl px-2.5 py-2.5 sm:py-2 text-[13.5px] sm:text-[13px] outline-none transition-colors",
                                  "text-[#3B414E] data-[selected=true]:bg-black/[0.045] data-[selected=true]:text-[#111318]",
                                  "dark:text-[#B4BCD0] dark:data-[selected=true]:bg-white/[0.07] dark:data-[selected=true]:text-[#ECEFF6]",
                                  "data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-45",
                                )}
                              >
                                {item.icon !== undefined ? (
                                  <span
                                    aria-hidden="true"
                                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-black/[0.045] text-[#687082] transition-colors group-data-[selected=true]:bg-[#181B22] group-data-[selected=true]:text-white dark:bg-white/[0.06] dark:text-[#7D869C] dark:group-data-[selected=true]:bg-[#EAEEF6] dark:group-data-[selected=true]:text-[#111318]"
                                  >
                                    {item.icon}
                                  </span>
                                ) : null}

                                <div className="min-w-0 flex-1">
                                  <div className="flex flex-col sm:flex-row sm:items-center sm:gap-2">
                                    <span className="truncate font-medium">{item.label}</span>
                                    {item.subtitle !== undefined ? (
                                      <span className="truncate text-xs text-[#939BAD] group-data-[selected=true]:text-[#687082] dark:text-[#586075] dark:group-data-[selected=true]:text-[#B4BCD0]">
                                        {item.subtitle}
                                      </span>
                                    ) : null}
                                  </div>
                                </div>

                                {item.badge !== undefined ? (
                                  <span className="shrink-0">{item.badge}</span>
                                ) : null}

                                {item.shortcut !== undefined ? (
                                  <kbd className="hidden sm:inline-block shrink-0 rounded-full bg-black/[0.05] px-2 py-0.5 font-mono text-[10.5px] font-medium text-[#687082] group-data-[selected=true]:bg-black/[0.09] group-data-[selected=true]:text-[#111318] dark:bg-white/[0.07] dark:text-[#7D869C] dark:group-data-[selected=true]:bg-white/[0.14] dark:group-data-[selected=true]:text-[#ECEFF6]">
                                    {item.shortcut}
                                  </kbd>
                                ) : null}
                              </Command.Item>
                            );
                          })}
                        </Command.Group>
                      ),
                    )}
                  </Command.List>

                  {/* 底部键盘操作提示栏（仅桌面端显示，为手机软键盘态释放宝贵纵向空间） */}
                  <div className="hidden sm:flex shrink-0 select-none items-center justify-between border-t border-black/[0.06] bg-black/[0.025] px-4 py-2 text-[11px] text-[#939BAD] dark:border-white/[0.07] dark:bg-white/[0.03] dark:text-[#586075]">
                    <div className="truncate">{footerHint ?? "快速跳转与操作"}</div>
                    <div className="flex items-center gap-3">
                      <span className="inline-flex items-center gap-1">
                        <kbd className="rounded bg-black/[0.06] px-1 py-0.2 font-mono text-[10px] dark:bg-white/10">
                          ↑↓
                        </kbd>
                        <span>选择</span>
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <CornerDownLeft aria-hidden="true" className="h-3 w-3" />
                        <span>打开</span>
                      </span>
                    </div>
                  </div>
                </Command>
              </motion.div>
            </Dialog.Content>
          </Dialog.Portal>
        ) : null}
      </AnimatePresence>
    </Dialog.Root>
  );
}
