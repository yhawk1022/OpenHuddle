/**
 * @module web/features/huddle-room/mobile-main-tab-bar
 * @description 移动端（`< md`）iOS 26 风格悬浮液态玻璃底部主导航胶囊（`聊天 · 通讯录 · 工作台`）。
 *
 * 交互与光学特性：
 * 1. 按住滑动选择（Press & Scrub）：支持手指按住胶囊任意位置水平连续拖动，液态玻璃滑块微幅浮起放大（`scale` + 镜面高光增强），实时跟随手指并在跨越分栏边界时顺滑切换页面，松手后按物理弹簧精准吸附归位；同时完整兼容普通轻点与键盘无障碍操作。
 * 2. 严守 Liquid Glass 单层模糊铁律：仅外层悬浮导航胶囊挂载 `relative liquid-glass-bar`（折射下方滚过的列表内容），内部滑动水滴采用高透光度晶面高光与柔影，绝不嵌套二次 `backdrop-blur`。
 */
import { ListTodo, MessageCircle, Users } from "lucide-react";
import { useMotionValue, useSpring, useTransform } from "motion/react";
import { type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react";
import {
  INSTANT_TRANSITION,
  cn,
  motion,
  usePrefersReducedMotion,
} from "../../../components/primitives/index.js";

export type MobileMainTabValue = "chats" | "contacts" | "workbench";

const TAB_ORDER: ReadonlyArray<MobileMainTabValue> = ["chats", "contacts", "workbench"];

export interface MobileMainTabBarProps {
  readonly activeTab: MobileMainTabValue;
  readonly onSelectTab: (tab: MobileMainTabValue) => void;
  readonly chatUnreadCount?: number | undefined;
  readonly contactsBadgeText?: string | undefined;
  readonly workbenchNeedsYouCount?: number | undefined;
}

function tabToIndex(tab: MobileMainTabValue): number {
  const idx = TAB_ORDER.indexOf(tab);
  return idx >= 0 ? idx : 0;
}

/** 边缘橡皮筋阻尼：拖出首尾边界时保留细腻的物理拉伸感而不脱轨 */
function clampSlotWithRubberBand(rawSlot: number, maxIndex: number): number {
  if (rawSlot < 0) {
    return Math.max(-0.14, rawSlot * 0.22);
  }
  if (rawSlot > maxIndex) {
    return Math.min(maxIndex + 0.14, maxIndex + (rawSlot - maxIndex) * 0.22);
  }
  return rawSlot;
}

export function MobileMainTabBar(props: MobileMainTabBarProps) {
  const reducedMotion = usePrefersReducedMotion();
  const trackRef = useRef<HTMLDivElement | null>(null);
  const pointerStateRef = useRef<{
    pointerId: number;
    startX: number;
    dragged: boolean;
    lastTriggeredTab: MobileMainTabValue;
  } | null>(null);
  const suppressClickUntilRef = useRef<number>(0);

  const [isScrubbing, setIsScrubbing] = useState<boolean>(false);

  const activeIndex = tabToIndex(props.activeTab);
  const targetSlot = useMotionValue<number>(activeIndex);
  const smoothSlot = useSpring(targetSlot, {
    stiffness: isScrubbing ? 680 : 460,
    damping: isScrubbing ? 40 : 34,
    mass: isScrubbing ? 0.48 : 0.72,
  });
  const pillTranslateX = useTransform(smoothSlot, (slot) => `${String(slot * 100)}%`);

  // 外部路由、Android 返回手势或普通点击改变 activeTab 时，非拖拽态自动同步滑块归位
  useEffect(() => {
    if (pointerStateRef.current === null) {
      targetSlot.set(activeIndex);
      if (reducedMotion) {
        smoothSlot.jump(activeIndex);
      }
    }
  }, [activeIndex, reducedMotion, smoothSlot, targetSlot]);

  const resolveSlotFromClientX = (
    clientX: number,
  ): { clampedSlot: number; nearestIndex: number } => {
    const el = trackRef.current;
    if (!el) {
      return { clampedSlot: activeIndex, nearestIndex: activeIndex };
    }
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) {
      return { clampedSlot: activeIndex, nearestIndex: activeIndex };
    }
    const ratio = (clientX - rect.left) / rect.width;
    const rawSlot = ratio * TAB_ORDER.length - 0.5;
    const clampedSlot = clampSlotWithRubberBand(rawSlot, TAB_ORDER.length - 1);
    const nearestIndex = Math.min(
      TAB_ORDER.length - 1,
      Math.max(0, Math.floor(Math.min(0.9999, Math.max(0, ratio)) * TAB_ORDER.length)),
    );
    return { clampedSlot, nearestIndex };
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    // 仅响应主指针（触控手指或鼠标左键）
    if (event.pointerType === "mouse" && event.button !== 0) {
      return;
    }
    const el = trackRef.current;
    if (!el) {
      return;
    }
    try {
      el.setPointerCapture(event.pointerId);
    } catch {
      // 某些测试环境未实现 setPointerCapture，安全降级
    }
    const { clampedSlot, nearestIndex } = resolveSlotFromClientX(event.clientX);
    const touchedTab = TAB_ORDER[nearestIndex] ?? props.activeTab;
    pointerStateRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      dragged: false,
      lastTriggeredTab: props.activeTab,
    };
    setIsScrubbing(true);
    if (!reducedMotion) {
      targetSlot.set(clampedSlot);
    }
    if (touchedTab !== props.activeTab) {
      pointerStateRef.current.lastTriggeredTab = touchedTab;
      props.onSelectTab(touchedTab);
    }
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const state = pointerStateRef.current;
    if (!state || state.pointerId !== event.pointerId) {
      return;
    }
    if (Math.abs(event.clientX - state.startX) > 4) {
      state.dragged = true;
    }
    const { clampedSlot, nearestIndex } = resolveSlotFromClientX(event.clientX);
    if (!reducedMotion) {
      targetSlot.set(clampedSlot);
    } else {
      smoothSlot.jump(nearestIndex);
    }
    const hoveredTab = TAB_ORDER[nearestIndex];
    if (hoveredTab !== undefined && hoveredTab !== state.lastTriggeredTab) {
      state.lastTriggeredTab = hoveredTab;
      if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
        navigator.vibrate(5);
      }
      props.onSelectTab(hoveredTab);
    }
  };

  const finishPointerInteraction = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const state = pointerStateRef.current;
    if (!state || state.pointerId !== event.pointerId) {
      return;
    }
    const el = trackRef.current;
    if (el) {
      try {
        if (el.hasPointerCapture(event.pointerId)) {
          el.releasePointerCapture(event.pointerId);
        }
      } catch {
        // 忽略释放异常
      }
    }
    const { nearestIndex } = resolveSlotFromClientX(event.clientX);
    const finalTab =
      event.type === "pointercancel"
        ? state.lastTriggeredTab
        : (TAB_ORDER[nearestIndex] ?? state.lastTriggeredTab);
    const finalIndex = tabToIndex(finalTab);

    if (state.dragged) {
      suppressClickUntilRef.current = Date.now() + 260;
    }
    pointerStateRef.current = null;
    setIsScrubbing(false);

    targetSlot.set(finalIndex);
    if (reducedMotion) {
      smoothSlot.jump(finalIndex);
    }
    if (finalTab !== props.activeTab) {
      props.onSelectTab(finalTab);
    }
  };

  const items: ReadonlyArray<{
    readonly value: MobileMainTabValue;
    readonly label: string;
    readonly icon: typeof MessageCircle;
    readonly badge?: string | undefined;
    readonly badgeTone?: "danger" | "warning" | "neutral" | undefined;
  }> = [
    {
      value: "chats",
      label: "聊天",
      icon: MessageCircle,
      badge:
        (props.chatUnreadCount ?? 0) > 0
          ? (props.chatUnreadCount ?? 0) > 99
            ? "99+"
            : String(props.chatUnreadCount)
          : undefined,
      badgeTone: "danger",
    },
    {
      value: "contacts",
      label: "通讯录",
      icon: Users,
      badge: props.contactsBadgeText,
      badgeTone: props.contactsBadgeText?.includes("新") ? "danger" : "neutral",
    },
    {
      value: "workbench",
      label: "工作台",
      icon: ListTodo,
      badge:
        (props.workbenchNeedsYouCount ?? 0) > 0 ? String(props.workbenchNeedsYouCount) : undefined,
      badgeTone: "warning",
    },
  ];

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-30 flex justify-center bg-gradient-to-t from-[var(--oh-stage-scrim)]/80 via-[var(--oh-stage-scrim-mid)]/30 to-transparent px-5 pt-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom,0px))] md:hidden">
      <nav
        aria-label="移动端主导航"
        className="app-no-drag pointer-events-auto relative liquid-glass-bar w-full max-w-[19.5rem] select-none rounded-full p-1"
      >
        <div
          ref={trackRef}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={finishPointerInteraction}
          onPointerCancel={finishPointerInteraction}
          className="relative grid grid-cols-3 touch-none items-center"
        >
          {/* iOS 26 液态玻璃滑动水滴滑块：按住拖动时微幅浮起并增强晶面折射高光（零嵌套 backdrop-blur） */}
          <motion.span
            aria-hidden="true"
            style={{ width: "33.333333%", x: pillTranslateX }}
            animate={
              reducedMotion
                ? { scaleX: 1, scaleY: 1 }
                : isScrubbing
                  ? { scaleX: 1.04, scaleY: 1.065 }
                  : { scaleX: 1, scaleY: 1 }
            }
            transition={
              reducedMotion
                ? INSTANT_TRANSITION
                : { type: "spring", stiffness: 520, damping: 30, mass: 0.6 }
            }
            className={cn(
              "pointer-events-none absolute inset-y-0 left-0 z-0 rounded-full will-change-transform transition-[background-color,box-shadow] duration-150",
              isScrubbing
                ? "bg-white/95 ring-1 ring-inset ring-white shadow-[inset_0_1.5px_1px_rgba(255,255,255,0.95),0_8px_22px_-4px_rgba(15,23,42,0.16),0_2px_6px_rgba(15,23,42,0.08)] dark:bg-white/[0.19] dark:ring-white/[0.32] dark:shadow-[inset_0_1.5px_1px_rgba(255,255,255,0.38),inset_0_-1px_1px_rgba(0,0,0,0.28),0_10px_26px_-4px_rgba(0,0,0,0.58)]"
                : "bg-white/88 ring-1 ring-inset ring-white/85 shadow-[inset_0_1px_0.5px_rgba(255,255,255,0.85),0_3px_10px_-2px_rgba(15,23,42,0.10)] dark:bg-white/[0.13] dark:ring-white/[0.20] dark:shadow-[inset_0_1px_0.5px_rgba(255,255,255,0.24),0_4px_14px_-2px_rgba(0,0,0,0.44)]",
            )}
          />

          {items.map((item) => {
            const Icon = item.icon;
            const active = props.activeTab === item.value;
            return (
              <button
                key={item.value}
                type="button"
                aria-current={active ? "page" : undefined}
                onClick={() => {
                  if (Date.now() < suppressClickUntilRef.current) {
                    return;
                  }
                  if (item.value !== props.activeTab) {
                    props.onSelectTab(item.value);
                  }
                }}
                className={cn(
                  "relative z-10 flex min-h-[44px] cursor-pointer flex-col items-center justify-center gap-0.5 rounded-full py-1 outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-black/20 dark:focus-visible:ring-white/25",
                  active
                    ? "font-semibold text-[#111318] dark:text-[#F8F8FA]"
                    : "font-medium text-[#5E6678] hover:text-[#111318] dark:text-[#9696A0] dark:hover:text-[#ECECEF]",
                )}
              >
                <span className="relative inline-flex items-center justify-center">
                  <Icon
                    className={cn(
                      "h-[18px] w-[18px] transition-transform duration-150",
                      active ? "scale-[1.03] stroke-[2.2]" : "stroke-[1.85]",
                    )}
                  />
                  {item.badge !== undefined ? (
                    <span
                      className={cn(
                        "absolute -top-1.5 -right-3 inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 font-mono text-[10px] font-semibold leading-none tabular-nums shadow-xs",
                        item.badgeTone === "danger"
                          ? "bg-[#E5484D] text-white dark:bg-[#F05252]"
                          : item.badgeTone === "warning"
                            ? "bg-[#D97706] text-white dark:bg-[#F59E0B] dark:text-[#111318]"
                            : "bg-black/[0.09] text-[#3B414E] dark:bg-white/[0.16] dark:text-[#E4E4E7]",
                      )}
                    >
                      {item.badge}
                    </span>
                  ) : null}
                </span>

                <span className="text-[11px] leading-none tracking-[-0.01em]">{item.label}</span>
              </button>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
