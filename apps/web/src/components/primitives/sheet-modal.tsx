/**
 * @module web/components/primitives/sheet-modal
 * @description 响应式 Apple Liquid Glass 模态窗与抽屉原语（`AppModal` 与 `AppSheetDrawer`）。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 多端物理自适应：在小屏视口（`< 640px`）下自动切换为 `vaul` 原生 iOS 物理阻尼下拉手势底栏（Bottom Sheet）；在桌面视口（`>= 640px`）下渲染为 Radix `Dialog` + `motion` 弹簧居中窗口，统一采用 `liquid-glass-modal` 晶莹玻璃表面与柔和遮罩。
 * 2. 视口锁定保护：向 `Vaul` 显式传入 `noBodyStyles={true}`，防止其篡改 `body` 样式破坏全局 `100dvh` IM 原生壳锁定。
 * 3. 零 `useEffect` 媒体查询：采用 React 19 `useSyncExternalStore` 订阅 `(max-width: 639px)` 断点，杜绝首帧状态撕裂。
 * 4. 严格 ARIA 合规：无论是否展示可视化头部，始终向 Radix / Vaul 提供 `Title` 与 `Description` 节点，杜绝无障碍读屏警告。
 */
import { X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { Dialog } from "radix-ui";
import { type ReactNode, useSyncExternalStore } from "react";
import { Drawer } from "vaul";
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
import { useComponentsI18n } from "../i18n/index.js";

const MOBILE_MEDIA_QUERY = "(max-width: 767px)";

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
 * 渲染居中悬浮 Apple Liquid Glass 圆角弹窗卡片（桌面端与移动端统一居中弹簧缩放淡入，软键盘弹起时随 `--oh-vvh` 自动在可视区居中上移，同时保留 Android 侧滑返回关闭支持）。
 *
 * @param props - 开关控制、标题副标题、图标、宽度及子内容
 * @returns 自适应原生级居中模态窗组件
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

  const { t } = useComponentsI18n();
  const isMobile = useIsMobileViewport();
  const reducedMotion = usePrefersReducedMotion();

  const handleOpenChange = (nextOpen: boolean): void => {
    onOpenChange?.(nextOpen);
    if (!nextOpen) {
      onClose?.();
    }
  };

  useMobileOverlayBackGuard(open && isMobile, () => {
    handleOpenChange(false);
  });

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <AnimatePresence>
        {open ? (
          <Dialog.Portal key="app-modal-portal" forceMount>
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
                className="app-no-drag fixed inset-0 z-[89] bg-[#090A0E]/36 will-change-[opacity] dark:bg-[#050609]/64"
              />
            </Dialog.Overlay>
            {/* 绑定至 `--oh-vv-offset-top` 与 `--oh-vvh` 可视视口居中：移动端软键盘弹起时卡片自动在键盘上方可视区平滑居中，绝不贴底或被裁切 */}
            <div className="pointer-events-none fixed left-0 right-0 top-[var(--oh-vv-offset-top,0px)] z-[90] flex h-[var(--oh-vvh,100dvh)] items-center justify-center px-3.5 pt-[max(0.75rem,env(safe-area-inset-top,0px))] pb-[max(0.75rem,env(safe-area-inset-bottom,0px))] sm:p-4">
              <Dialog.Content forceMount asChild>
                <motion.div
                  initial={reducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.955, y: 10 }}
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
                          scale: 0.97,
                          y: 6,
                          pointerEvents: "none",
                          transition: NATIVE_MODAL_EXIT,
                        }
                  }
                  className={cn(
                    "pointer-events-auto app-no-drag relative flex max-h-full w-full flex-col overflow-hidden rounded-[24px] outline-none will-change-[transform,opacity]",
                    "liquid-glass-modal text-[#111318]",
                    "dark:text-[#ECEFF6]",
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
                    <header className="flex shrink-0 select-none items-start justify-between gap-3 border-b border-black/[0.06] px-4 py-3.5 sm:gap-4 sm:px-6 sm:py-4 dark:border-white/[0.07]">
                      <div className="flex min-w-0 items-start gap-3">
                        {icon !== undefined ? (
                          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#F3F4F7] text-[#111318] ring-1 ring-inset ring-black/[0.06] dark:bg-[#2A2A2F] dark:text-[#F2F2F4] dark:ring-white/[0.08]">
                            {icon}
                          </div>
                        ) : null}
                        <div className="min-w-0">
                          <Dialog.Title className="truncate text-[15.5px] sm:text-[16px] font-semibold tracking-[-0.015em] text-[#111318] dark:text-[#ECEFF6]">
                            {title}
                          </Dialog.Title>
                          <Dialog.Description
                            className={cn(
                              "mt-0.5 text-xs leading-relaxed text-[#687082] dark:text-[#7D869C]",
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
                          aria-label={t("sheetModal.closeModalAria")}
                          className="im-press -mr-1 inline-flex h-8 w-8 sm:h-7 sm:w-7 shrink-0 cursor-pointer items-center justify-center rounded-full text-[#939BAD] hover:bg-black/[0.05] hover:text-[#111318] focus-visible:ring-2 focus-visible:ring-black/[0.15] focus-visible:outline-none dark:text-[#7D869C] dark:hover:bg-white/[0.08] dark:hover:text-[#ECEFF6] dark:focus-visible:ring-white/[0.22]"
                        >
                          <X aria-hidden="true" className="h-4 w-4" />
                        </button>
                      </Dialog.Close>
                    </header>
                  )}

                  <div
                    className={cn(
                      "min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 sm:px-6 sm:py-5",
                      bodyClassName,
                    )}
                  >
                    {children}
                  </div>

                  {footer !== undefined ? (
                    <footer className="shrink-0 border-t border-black/[0.06] bg-black/[0.025] px-4 py-3 sm:px-6 sm:py-3.5 dark:border-white/[0.07] dark:bg-white/[0.03]">
                      {footer}
                    </footer>
                  ) : null}
                </motion.div>
              </Dialog.Content>
            </div>
          </Dialog.Portal>
        ) : null}
      </AnimatePresence>
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
  /** 当内部子组件已自行承载唯一滚动区与 `pb-safe`（如 `RoomInspector`）时禁用外层重复滚动套娃 */
  readonly disableBodyScroll?: boolean | undefined;
  /** 抽屉宽度或外层附加类名 */
  readonly className?: string | undefined;
  /** 内容容器附加类名 */
  readonly bodyClassName?: string | undefined;
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
    disableBodyScroll = false,
    className,
    bodyClassName,
    children,
  } = props;

  const { t } = useComponentsI18n();
  const isMobile = useIsMobileViewport();
  const direction = isMobile && mobileAsBottomSheet ? "bottom" : side;

  const handleOpenChange = (nextOpen: boolean): void => {
    onOpenChange?.(nextOpen);
    if (!nextOpen) {
      onClose?.();
    }
  };

  useMobileOverlayBackGuard(open && isMobile, () => {
    handleOpenChange(false);
  });

  const positionClass =
    direction === "bottom"
      ? "inset-x-0 bottom-0 mt-3 max-h-[calc(var(--oh-vvh,100dvh)-0.75rem)] w-full rounded-t-[26px]"
      : direction === "left"
        ? "inset-y-0 left-0 h-full w-[min(90vw,360px)] rounded-r-2xl"
        : "inset-y-0 right-0 h-full w-[min(90vw,360px)] rounded-l-2xl";

  return (
    <Drawer.Root
      open={open}
      onOpenChange={handleOpenChange}
      direction={direction}
      noBodyStyles={true}
      repositionInputs={false}
    >
      <Drawer.Portal>
        <Drawer.Overlay className="app-no-drag fixed inset-0 z-[85] bg-[#090A0E]/32 dark:bg-[#050609]/62" />
        <Drawer.Content
          onEscapeKeyDown={(event) => {
            const active = document.activeElement;
            if (
              (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement) &&
              active.closest("[data-attention-card]") !== null
            ) {
              event.preventDefault();
              if (!event.isComposing) {
                active.blur();
              }
            }
          }}
          className={cn(
            "app-no-drag fixed z-[86] flex flex-col overflow-hidden outline-none",
            "liquid-glass-modal text-[#111318]",
            "dark:text-[#ECEFF6]",
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
            <header className="flex shrink-0 select-none items-center justify-between gap-3 border-b border-black/[0.06] px-4 py-3 dark:border-white/[0.07]">
              <div className="min-w-0">
                <Drawer.Title className="truncate text-sm font-semibold text-[#111318] dark:text-[#ECEFF6]">
                  {title}
                </Drawer.Title>
                <Drawer.Description
                  className={cn(
                    "mt-0.5 truncate text-xs text-[#687082] dark:text-[#7D869C]",
                    subtitle === undefined && "sr-only",
                  )}
                >
                  {subtitle ?? title}
                </Drawer.Description>
              </div>
              <Drawer.Close asChild>
                <button
                  type="button"
                  aria-label={t("sheetModal.closeDrawerAria")}
                  className="-mr-1 inline-flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-full text-[#939BAD] transition hover:bg-black/[0.05] hover:text-[#111318] dark:text-[#7D869C] dark:hover:bg-white/[0.08] dark:hover:text-[#ECEFF6]"
                >
                  <X aria-hidden="true" className="h-4 w-4" />
                </button>
              </Drawer.Close>
            </header>
          )}

          <div
            className={cn(
              "flex min-h-0 flex-1 flex-col",
              disableBodyScroll ? "overflow-hidden" : "pb-safe overflow-y-auto overscroll-contain",
              bodyClassName,
            )}
          >
            {children}
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}
