/**
 * @module web/components/primitives
 * @description OpenHuddle Atelier Daylight & Obsidian Studio 基础组件原语统一导出桶（Barrel）。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 聚合胶囊按钮（`rounded-full`）、凹陷微质感输入框、Radix 无障碍浮层、`motion` 弹簧分段滑块、`vaul` 物理抽屉、`sonner` 轻提示与 `cmdk` 命令面板，向业务层提供零 `any`、零廉价紫光渐变的统一原语。
 * 2. 严格遵守全工作区仅使用具名导出（Named Exports）规范。
 */
export { AnimatePresence, MotionConfig, motion } from "motion/react";
export { cn, type ClassValue } from "../../lib/cn.js";
export {
  DEFAULT_REFRESH_RATE_PREFERENCE,
  acquireHighRefreshBurst,
  getRefreshRatePreference,
  setRefreshRatePreference,
  startDisplayRefreshRuntime,
  useDisplayRefreshState,
  type DisplayRefreshSnapshot,
  type RefreshRatePreference,
} from "../../lib/display-refresh.js";
export {
  INSTANT_TRANSITION,
  NATIVE_BACKDROP_ENTER,
  NATIVE_BACKDROP_EXIT,
  NATIVE_DISCLOSURE_TRANSITION,
  NATIVE_LIVE_BUBBLE_SPRING,
  NATIVE_MODAL_EXIT,
  NATIVE_MODAL_SPRING,
  NATIVE_PANEL_EXIT,
  NATIVE_PANEL_SPRING,
  NATIVE_PILL_SPRING,
  NATIVE_SURFACE_EXIT,
  NATIVE_SURFACE_SPRING,
  NATIVE_VIEW_SWAP,
  usePrefersReducedMotion,
} from "../../lib/motion-physics.js";

export {
  AppButton,
  IconButton,
  appButtonVariants,
  iconButtonVariants,
  type AppButtonProps,
  type AppButtonSize,
  type AppButtonVariant,
  type IconButtonProps,
} from "./button.js";

export {
  AppInput,
  AppTextarea,
  type AppInputProps,
  type AppInputSize,
  type AppTextareaProps,
} from "./input.js";

export {
  AppSelect,
  type AppSelectOption,
  type AppSelectProps,
  type AppSelectSize,
} from "./select.js";

export {
  AppSwitch,
  type AppSwitchProps,
  type AppSwitchSize,
} from "./switch.js";

export {
  SegmentedTabs,
  type SegmentedTabItem,
  type SegmentedTabsProps,
  type SegmentedTabsSize,
} from "./segmented-tabs.js";

export {
  AppContextMenu,
  AppContextMenuItem,
  AppContextMenuLabel,
  AppContextMenuSeparator,
  AppContextMenuSubContent,
  AppContextMenuSubTrigger,
  AppDropdownMenu,
  AppDropdownMenuItem,
  AppDropdownMenuLabel,
  AppDropdownMenuSeparator,
  AppPopover,
  AppPopoverClose,
  AppTooltip,
  AppTooltipProvider,
  normalizeContextMenuEntries,
  type AppContextMenuEntry,
  type AppContextMenuProps,
  type AppDropdownEntry,
  type AppDropdownMenuProps,
  type AppPopoverProps,
  type AppTooltipProps,
  type AppTooltipProviderProps,
} from "./overlays.js";

export {
  AppModal,
  AppSheetDrawer,
  useIsMobileViewport,
  type AppModalProps,
  type AppSheetDrawerProps,
} from "./sheet-modal.js";

export {
  AppToaster,
  toast,
  type AppToasterProps,
  type ExternalToast,
} from "./toaster.js";

export {
  AppCommandPalette,
  type AppCommandPaletteProps,
  type CommandPaletteActionItem,
  type CommandPaletteGroup,
} from "./command-palette.js";
