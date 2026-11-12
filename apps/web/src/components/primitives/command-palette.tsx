/**
 * @module web/components/primitives/command-palette
 * @description 基于 `cmdk` + Radix `Dialog` + `motion` 构建的 Pachat 极简全局命令面板（`AppCommandPalette`）。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 全局快捷键唤醒：默认监听 `⌘K`（macOS）与 `Ctrl+K`（Windows/Linux），一键呼出或收起群聊切换、创建/加入群、接入 Agent、触发提案归纳与主题切换。
 * 2. 双主题纯净表面：采用 `#FFFFFF` / `#18181B` 暖中性面板与 `#F5F5F7` 柔和选中高亮，彻底免疫暗黑模式白底白字与廉价紫光污染。
 * 3. 无障碍与键盘优先：内置 `cmdk` 模糊检索评分、上下方向键循环导航、`Enter` 立即执行与 `Escape` 关闭。
 */
import { Command } from "cmdk";
import { CornerDownLeft, Search } from "lucide-react";
import { motion } from "motion/react";
import { Dialog } from "radix-ui";
import { type ReactNode, useEffect } from "react";
import { cn } from "../../lib/cn.js";

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

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay asChild>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.14 }}
            className="app-no-drag fixed inset-0 z-[98] bg-black/35 backdrop-blur-[3px] dark:bg-black/68"
          />
        </Dialog.Overlay>
        <Dialog.Content asChild>
          <motion.div
            initial={{ opacity: 0, scale: 0.965, y: -8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            transition={{ type: "spring", stiffness: 520, damping: 36 }}
            className={cn(
              "app-no-drag fixed inset-x-0 top-[13vh] z-[99] mx-auto w-[calc(100%-1.5rem)] max-w-[560px] overflow-hidden rounded-[22px] outline-none",
              "bg-white/98 text-[#141414] backdrop-blur-2xl",
              "shadow-[0_26px_80px_-14px_rgba(0,0,0,0.2)] ring-1 ring-black/[0.09]",
              "dark:bg-[#18181B]/98 dark:text-zinc-100 dark:shadow-[0_30px_90px_-12px_rgba(0,0,0,0.85)] dark:ring-white/[0.12]",
            )}
          >
            <div className="sr-only">
              <Dialog.Title>全局快捷搜索</Dialog.Title>
              <Dialog.Description>快速切换群聊、查看我的 Agent 或执行操作</Dialog.Description>
            </div>

            <Command label="OpenHuddle 全局命令面板" loop={true} className="flex flex-col">
              {/* 顶部搜索栏 */}
              <div className="flex items-center gap-2.5 border-b border-black/[0.07] px-4 py-3 dark:border-white/[0.08]">
                <Search
                  aria-hidden="true"
                  className="h-4 w-4 shrink-0 text-[#8E8E93] dark:text-zinc-400"
                />
                <Command.Input
                  placeholder={placeholder}
                  className="h-6 w-full flex-1 border-0 bg-transparent p-0 text-[14px] font-medium text-[#141414] caret-[#141414] outline-none placeholder:text-[#8E8E93] dark:text-zinc-100 dark:caret-zinc-100 dark:placeholder:text-zinc-500"
                />
                <Dialog.Close asChild>
                  <button
                    type="button"
                    aria-label="关闭搜索面板"
                    className="shrink-0 cursor-pointer rounded-full bg-[#F5F5F7] px-2 py-0.5 font-mono text-[10.5px] font-semibold text-[#6E6E73] transition hover:bg-black/[0.08] hover:text-[#141414] dark:bg-white/[0.08] dark:text-zinc-400 dark:hover:bg-white/14 dark:hover:text-zinc-100"
                  >
                    ESC
                  </button>
                </Dialog.Close>
              </div>

              {/* 检索候选列表 */}
              <Command.List className="max-h-[340px] overflow-y-auto overscroll-contain p-2">
                <Command.Empty className="py-10 text-center text-xs text-[#8E8E93] dark:text-zinc-400">
                  {emptyText}
                </Command.Empty>

                {groups.map((group) =>
                  group.items.length === 0 ? null : (
                    <Command.Group
                      key={group.id}
                      heading={group.heading}
                      className="[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-[#8E8E93] [&_[cmdk-group-heading]]:uppercase dark:[&_[cmdk-group-heading]]:text-zinc-500"
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
                              "group flex cursor-pointer select-none items-center gap-3 rounded-xl px-2.5 py-2 text-[13px] outline-none transition-colors",
                              "text-[#3A3A3C] data-[selected=true]:bg-[#F5F5F7] data-[selected=true]:text-[#141414]",
                              "dark:text-zinc-300 dark:data-[selected=true]:bg-white/[0.08] dark:data-[selected=true]:text-white",
                              "data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-45",
                            )}
                          >
                            {item.icon !== undefined ? (
                              <span
                                aria-hidden="true"
                                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#F5F5F7] text-[#5F5F64] transition-colors group-data-[selected=true]:bg-[#141414] group-data-[selected=true]:text-white dark:bg-white/[0.06] dark:text-zinc-400 dark:group-data-[selected=true]:bg-[#F5F5F7] dark:group-data-[selected=true]:text-[#141414]"
                              >
                                {item.icon}
                              </span>
                            ) : null}

                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <span className="truncate font-medium">{item.label}</span>
                                {item.subtitle !== undefined ? (
                                  <span className="truncate text-xs text-[#8E8E93] group-data-[selected=true]:text-[#6E6E73] dark:text-zinc-500 dark:group-data-[selected=true]:text-zinc-300">
                                    {item.subtitle}
                                  </span>
                                ) : null}
                              </div>
                            </div>

                            {item.badge !== undefined ? (
                              <span className="shrink-0">{item.badge}</span>
                            ) : null}

                            {item.shortcut !== undefined ? (
                              <kbd className="shrink-0 rounded-full bg-black/[0.05] px-2 py-0.5 font-mono text-[10.5px] font-medium text-[#6E6E73] group-data-[selected=true]:bg-black/[0.09] group-data-[selected=true]:text-[#141414] dark:bg-white/[0.07] dark:text-zinc-400 dark:group-data-[selected=true]:bg-white/15 dark:group-data-[selected=true]:text-zinc-100">
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

              {/* 底部键盘操作提示栏 */}
              <div className="flex select-none items-center justify-between border-t border-black/[0.07] bg-[#F8F8FA] px-4 py-2 text-[11px] text-[#8E8E93] dark:border-white/[0.08] dark:bg-[#151518] dark:text-zinc-500">
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
    </Dialog.Root>
  );
}
