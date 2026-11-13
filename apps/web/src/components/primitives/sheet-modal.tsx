/**
 * @module web/components/primitives/sheet-modal
 * @description 响应式 Pachat 极简模态窗与抽屉原语（`AppModal` 与 `AppSheetDrawer`）。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 多端物理自适应：在小屏视口（`< 640px`）下自动切换为 `vaul` 原生 iOS 物理阻尼下拉手势底栏（Bottom Sheet）；在桌面视口（`>= 640px`）下渲染为 Radix `Dialog` + `motion` 弹簧居中窗口，统一使用纯净 `#FFFFFF` / `#18181B` 表面。
 * 2. 视口锁定保护：向 `Vaul` 显式传入 `noBodyStyles={true}`，防止其篡改 `body` 样式破坏全局 `100dvh` IM 原生壳锁定。
 * 3. 零 `useEffect` 媒体查询：采用 React 19 `useSyncExternalStore` 订阅 `(max-width: 639px)` 断点，杜绝首帧状态撕裂。
 * 4. 严格 ARIA 合规：无论是否展示可视化头部，始终向 Radix / Vaul 提供 `Title` 与 `Description` 节点，杜绝无障碍读屏警告。
 */
import { X } from "lucide-react";
import { motion } from "motion/react";
import { Dialog } from "radix-ui";
import { type ReactNode, useSyncExternalStore } from "react";
import { Drawer } from "vaul";
import { cn } from "../../lib/cn.js";

const MOBILE_MEDIA_QUERY = "(max-width: 639px)";

function subscribeMobileViewport(listener: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return () => {};
  }
  const mql = window.matchMedia(MOBILE_MEDIA_QUERY);
  mql.addEventListener("change", listener);
  return () => {
    mql.removeEventListener("change", listener);
  };
}

function getMobileViewportSnapshot(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia(MOBILE_MEDIA_QUERY).matches;
}

/**
 * 响应式检测当前视口是否处于移动端断点（`< 640px`）。
 *
 * @returns 小于 `640px` 时返回 `true`，桌面端返回 `false`
 */
export function useIsMobileViewport(): boolean {
  return useSyncExternalStore(subscribeMobileViewport, getMobileViewportSnapshot, () => false);
}

/** `AppModal` 入参属性 */
export interface AppModalProps {
  /** 是否打开弹窗 */
  readonly open: boolean;
  /** 标准受控开关回调 */
  readonly onOpenChange?: ((open: boolean) => void) | undefined;
  /** 关闭简写回调（与 `ModalDialogProps.onClose` 100% 兼容） */
  readonly onClose?: (() => void) | undefined;
  /** 弹窗主标题（同时绑定 ARIA `Dialog.Title`） */
  readonly title: string;
  /** 标题下方的辅助说明（同时绑定 ARIA `Dialog.Description`） */
  readonly subtitle?: string | undefined;
  /** 标题左侧可选品牌/语义图标槽位 */
  readonly icon?: ReactNode | undefined;
  /** 桌面端最大宽度 Tailwind 类名（默认 `"max-w-xl"`） */
  readonly maxWidthClass?: string | undefined;
  /** 可选底部固定操作栏 */
  readonly footer?: ReactNode | undefined;
  /** 是否隐藏默认头部（仍保留屏幕阅读器可识别的隐藏标题） */
  readonly hideHeader?: boolean | undefined;
  /** 弹窗面板附加类名 */
  readonly className?: string | undefined;
  /** 内容滚动区附加类名 */
  readonly bodyClassName?: string | undefined;
  /** 弹窗主体内容 */
  readonly children: ReactNode;
}

/**
 * 渲染桌面端纯净居中窗口 + 移动端 `Vaul` 物理手势下拉抽屉。
 *
 * @param props - 开关控制、标题副标题、图标、宽度及子内容
 * @returns 自适应原生级模态窗组件
 */
export function AppModal(props: AppModalProps) {
  const {
    open,
    onOpenChange,
    onClose,
    title,
    subtitle,
    icon,
    maxWidthClass = "max-w-xl",
    footer,
    hideHeader = false,
    className,
    bodyClassName,
    children,
  } = props;

  const isMobile = useIsMobileViewport();

  const handleOpenChange = (nextOpen: boolean): void => {
    onOpenChange?.(nextOpen);
    if (!nextOpen) {
      onClose?.();
    }
  };

  if (isMobile) {
    return (
      <Drawer.Root open={open} onOpenChange={handleOpenChange} noBodyStyles={true}>
        <Drawer.Portal>
          <Drawer.Overlay className="app-no-drag fixed inset-0 z-[89] bg-black/45 backdrop-blur-[2px] dark:bg-black/75" />
          <Drawer.Content
            className={cn(
              "app-no-drag fixed inset-x-0 bottom-0 z-[90] mt-16 flex max-h-[92dvh] flex-col overflow-hidden rounded-t-[26px] outline-none",
              "glass-modal text-[#141414]",
              "dark:text-zinc-100",
              className,
            )}
          >
            {/* Vaul 物理手势抓手条 */}
            <div aria-hidden="true" className="flex shrink-0 justify-center pt-2.5 pb-1">
              <span className="h-1.5 w-10 rounded-full bg-black/15 dark:bg-white/20" />
            </div>

            {hideHeader ? (
              <div className="sr-only">
                <Drawer.Title>{title}</Drawer.Title>
                <Drawer.Description>{subtitle ?? title}</Drawer.Description>
              </div>
            ) : (
              <header className="flex shrink-0 select-none items-start justify-between gap-3 border-b border-black/[0.07] px-5 pt-2 pb-3.5 dark:border-white/[0.08]">
                <div className="flex min-w-0 items-start gap-3">
                  {icon !== undefined ? (
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#F5F5F7] text-[#141414] ring-1 ring-inset ring-black/[0.06] dark:bg-[#27272A] dark:text-zinc-100 dark:ring-white/[0.10]">
                      {icon}
                    </div>
                  ) : null}
                  <div className="min-w-0">
                    <Drawer.Title className="truncate text-[15.5px] font-semibold tracking-[-0.015em] text-[#141414] dark:text-zinc-100">
                      {title}
                    </Drawer.Title>
                    <Drawer.Description
                      className={cn(
                        "mt-0.5 text-xs leading-relaxed text-[#6E6E73] dark:text-zinc-400",
                        subtitle === undefined && "sr-only",
                      )}
                    >
                      {subtitle ?? title}
                    </Drawer.Description>
                  </div>
                </div>
                <Drawer.Close asChild>
                  <button
                    type="button"
                    aria-label="关闭窗口"
                    className="-mr-1 inline-flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-full text-[#8E8E93] transition hover:bg-black/[0.05] hover:text-[#141414] active:scale-95 dark:text-zinc-400 dark:hover:bg-white/10 dark:hover:text-white"
                  >
                    <X aria-hidden="true" className="h-4 w-4" />
                  </button>
                </Drawer.Close>
              </header>
            )}

            <div
              className={cn("pb-safe overflow-y-auto overscroll-contain px-5 py-4", bodyClassName)}
            >
              {children}
            </div>

            {footer !== undefined ? (
              <footer className="pb-safe shrink-0 border-t border-black/[0.07] bg-[#F8F8FA] px-5 py-3 dark:border-white/[0.08] dark:bg-[#151518]">
                {footer}
              </footer>
            ) : null}
          </Drawer.Content>
        </Drawer.Portal>
      </Drawer.Root>
    );
  }

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay asChild>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.16, ease: "easeOut" }}
            className="app-no-drag fixed inset-0 z-[89] bg-black/45 backdrop-blur-[2px] dark:bg-black/75"
          />
        </Dialog.Overlay>
        {/* 采用 inset-0 + m-auto + h-fit 几何居中，不占用 CSS translate(-50%, -50%)，从而与 motion 弹簧 scale/y 变换零冲突 */}
        <Dialog.Content asChild>
          <motion.div
            initial={{ opacity: 0, scale: 0.96, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            transition={{ type: "spring", stiffness: 480, damping: 34 }}
            className={cn(
              "app-no-drag fixed inset-0 z-[90] m-auto flex h-fit max-h-[90dvh] w-[calc(100%-2rem)] flex-col overflow-hidden rounded-[24px] outline-none",
              "glass-modal text-[#141414]",
              "dark:text-zinc-100",
              maxWidthClass,
              className,
            )}
          >
            {hideHeader ? (
              <div className="sr-only">
                <Dialog.Title>{title}</Dialog.Title>
                <Dialog.Description>{subtitle ?? title}</Dialog.Description>
              </div>
            ) : (
              <header className="flex shrink-0 select-none items-start justify-between gap-4 border-b border-black/[0.07] px-6 py-4 dark:border-white/[0.08]">
                <div className="flex min-w-0 items-start gap-3">
                  {icon !== undefined ? (
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#F5F5F7] text-[#141414] ring-1 ring-inset ring-black/[0.06] dark:bg-[#27272A] dark:text-zinc-100 dark:ring-white/[0.10]">
                      {icon}
                    </div>
                  ) : null}
                  <div className="min-w-0">
                    <Dialog.Title className="truncate text-[16px] font-semibold tracking-[-0.015em] text-[#141414] dark:text-zinc-100">
                      {title}
                    </Dialog.Title>
                    <Dialog.Description
                      className={cn(
                        "mt-0.5 text-xs leading-relaxed text-[#6E6E73] dark:text-zinc-400",
                        subtitle === undefined && "sr-only",
                      )}
                    >
                      {subtitle ?? title}
                    </Dialog.Description>
                  </div>
                </div>
                <Dialog.Close asChild>
                  <button
                    type="button"
                    aria-label="关闭窗口"
                    className="-mr-1 inline-flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-full text-[#8E8E93] transition hover:bg-black/[0.05] hover:text-[#141414] active:scale-95 focus-visible:ring-2 focus-visible:ring-black/20 focus-visible:outline-none dark:text-zinc-400 dark:hover:bg-white/10 dark:hover:text-white dark:focus-visible:ring-white/30"
                  >
                    <X aria-hidden="true" className="h-4 w-4" />
                  </button>
                </Dialog.Close>
              </header>
            )}

            <div className={cn("overflow-y-auto overscroll-contain px-6 py-5", bodyClassName)}>
              {children}
            </div>

            {footer !== undefined ? (
              <footer className="shrink-0 border-t border-black/[0.07] bg-[#F8F8FA] px-6 py-3.5 dark:border-white/[0.08] dark:bg-[#151518]">
                {footer}
              </footer>
            ) : null}
          </motion.div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** `AppSheetDrawer` 入参属性 */
export interface AppSheetDrawerProps {
  /** 是否打开抽屉 */
  readonly open: boolean;
  /** 标准受控开关回调 */
  readonly onOpenChange?: ((open: boolean) => void) | undefined;
  /** 关闭简写回调 */
  readonly onClose?: (() => void) | undefined;
  /** 抽屉标题（同时用于无障碍读屏） */
  readonly title: string;
  /** 可选副标题 */
  readonly subtitle?: string | undefined;
  /** 桌面端滑出方向（默认 `"right"`） */
  readonly side?: "right" | "left" | "bottom" | undefined;
  /** 小屏视口（`< 640px`）下是否自动切换为底部物理抽屉（默认 `true`） */
  readonly mobileAsBottomSheet?: boolean | undefined;
  /** 隐藏默认头部栏（当业务子组件自带顶栏时设为 `true`） */
  readonly hideHeader?: boolean | undefined;
  /** 抽屉宽度或外层附加类名 */
  readonly className?: string | undefined;
  /** 抽屉主体内容 */
  readonly children: ReactNode;
}

/**
 * 渲染支持 `Vaul` 手势拖拽关闭的侧边/底部抽屉（适用于移动端群信息面板、详情侧滑页等）。
 *
 * @param props - 开关控制、滑出方向、小屏自适应策略与内容节点
 * @returns Vaul `Drawer` 封装组件
 */
export function AppSheetDrawer(props: AppSheetDrawerProps) {
  const {
    open,
    onOpenChange,
    onClose,
    title,
    subtitle,
    side = "right",
    mobileAsBottomSheet = true,
    hideHeader = false,
    className,
    children,
  } = props;

  const isMobile = useIsMobileViewport();
  const direction = isMobile && mobileAsBottomSheet ? "bottom" : side;

  const handleOpenChange = (nextOpen: boolean): void => {
    onOpenChange?.(nextOpen);
    if (!nextOpen) {
      onClose?.();
    }
  };

  const positionClass =
    direction === "bottom"
      ? "inset-x-0 bottom-0 mt-14 max-h-[90dvh] w-full rounded-t-[26px]"
      : direction === "left"
        ? "inset-y-0 left-0 h-full w-[min(90vw,360px)] rounded-r-2xl"
        : "inset-y-0 right-0 h-full w-[min(90vw,360px)] rounded-l-2xl";

  return (
    <Drawer.Root
      open={open}
      onOpenChange={handleOpenChange}
      direction={direction}
      noBodyStyles={true}
    >
      <Drawer.Portal>
        <Drawer.Overlay className="app-no-drag fixed inset-0 z-[85] bg-black/45 backdrop-blur-[2px] dark:bg-black/75" />
        <Drawer.Content
          className={cn(
            "app-no-drag fixed z-[86] flex flex-col overflow-hidden outline-none",
            "glass-modal text-[#141414]",
            "dark:text-zinc-100",
            positionClass,
            className,
          )}
        >
          {direction === "bottom" ? (
            <div aria-hidden="true" className="flex shrink-0 justify-center pt-2.5 pb-1">
              <span className="h-1.5 w-10 rounded-full bg-black/15 dark:bg-white/20" />
            </div>
          ) : null}

          {hideHeader ? (
            <div className="sr-only">
              <Drawer.Title>{title}</Drawer.Title>
              <Drawer.Description>{subtitle ?? title}</Drawer.Description>
            </div>
          ) : (
            <header className="flex shrink-0 select-none items-center justify-between gap-3 border-b border-black/[0.07] px-4 py-3.5 dark:border-white/[0.08]">
              <div className="min-w-0">
                <Drawer.Title className="truncate text-sm font-semibold text-[#141414] dark:text-zinc-100">
                  {title}
                </Drawer.Title>
                <Drawer.Description
                  className={cn(
                    "mt-0.5 truncate text-xs text-[#6E6E73] dark:text-zinc-400",
                    subtitle === undefined && "sr-only",
                  )}
                >
                  {subtitle ?? title}
                </Drawer.Description>
              </div>
              <Drawer.Close asChild>
                <button
                  type="button"
                  aria-label="关闭抽屉"
                  className="inline-flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-full text-[#8E8E93] transition hover:bg-black/[0.05] hover:text-[#141414] dark:text-zinc-400 dark:hover:bg-white/10 dark:hover:text-white"
                >
                  <X aria-hidden="true" className="h-4 w-4" />
                </button>
              </Drawer.Close>
            </header>
          )}

          <div className="pb-safe flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain">
            {children}
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}
