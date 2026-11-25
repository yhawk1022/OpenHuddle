/**
 * @module web/features/huddle-room/mobile-main-tab-bar
 * @description 移动端（`< md`）iOS 26 风格悬浮液态玻璃底部主导航胶囊（`聊天 · 通讯录 · 工作台`）。
 *
 * 交互与光学特性：
 * 1. 轻点直接切页；长按后横拖预览目标，松手确认。普通滑动、纵向滚动和系统取消均保留当前页。
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

const HOLD_TO_SCRUB_MS = 250;
const TAP_SLOP_PX = 8;

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
    startY: number;
    startedAt: number;
    mode: "pending" | "scrubbing" | "cancelled";
  } | null>(null);
  const ignorePointerClick = useRef(false);

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
    if (!event.isPrimary || event.button !== 0) return;
    ignorePointerClick.current = false;
    pointerStateRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startedAt: event.timeStamp,
      mode: "pending",
    };
  };

  const resetPill = (): void => {
    targetSlot.set(activeIndex);
    if (reducedMotion) smoothSlot.jump(activeIndex);
    setIsScrubbing(false);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const state = pointerStateRef.current;
    if (!state || state.pointerId !== event.pointerId || state.mode === "cancelled") return;
    const dx = Math.abs(event.clientX - state.startX);
    const dy = Math.abs(event.clientY - state.startY);
    if (state.mode === "pending") {
      if (Math.max(dx, dy) <= TAP_SLOP_PX) return;
      ignorePointerClick.current = true;
      if (dy >= dx || event.timeStamp - state.startedAt < HOLD_TO_SCRUB_MS) {
        state.mode = "cancelled";
        return;
      }
      state.mode = "scrubbing";
      setIsScrubbing(true);
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    const { clampedSlot, nearestIndex } = resolveSlotFromClientX(event.clientX);
    targetSlot.set(clampedSlot);
    if (reducedMotion) smoothSlot.jump(nearestIndex);
  };

  const finishPointerInteraction = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const state = pointerStateRef.current;
    if (!state || state.pointerId !== event.pointerId) return;
    pointerStateRef.current = null;
    resetPill();
    if (event.type !== "pointerup") {
      ignorePointerClick.current = true;
      return;
    }
    if (
      Math.max(Math.abs(event.clientX - state.startX), Math.abs(event.clientY - state.startY)) >
      TAP_SLOP_PX
    ) {
      ignorePointerClick.current = true;
    }
    if (state.mode !== "scrubbing") return;
    const bounds = event.currentTarget.getBoundingClientRect();
    if (
      event.clientY < bounds.top ||
      event.clientY > bounds.bottom ||
      event.clientX < bounds.left ||
      event.clientX > bounds.right
    )
      return;
    const tab = TAB_ORDER[resolveSlotFromClientX(event.clientX).nearestIndex];
    if (tab && tab !== props.activeTab) props.onSelectTab(tab);
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
    <div className="oh-mobile-main-nav relative z-30 flex shrink-0 justify-center bg-sidebar-surface px-5 pt-1.5 md:hidden">
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
          onLostPointerCapture={(event) => {
            if (event.target === event.currentTarget) finishPointerInteraction(event);
          }}
          className="relative grid grid-cols-3 touch-pan-y touch-pinch-zoom items-center"
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
                onClick={(event) => {
                  if (event.detail !== 0 && ignorePointerClick.current) {
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
