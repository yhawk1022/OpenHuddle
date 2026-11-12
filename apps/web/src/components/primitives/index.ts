/**
 * @module web/components/primitives
 * @description OpenHuddle Pachat 暖白/墨黑极简主义基础组件原语统一导出桶（Barrel）。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 聚合胶囊按钮（`rounded-full`）、高对比无白底缺陷输入框、Radix 无障碍浮层、`motion` 弹簧分段滑块、`vaul` 物理抽屉、`sonner` 轻提示与 `cmdk` 命令面板，向业务层提供零 `any`、零廉价紫光渐变的统一原语。
 * 2. 严格遵守全工作区仅使用具名导出（Named Exports）规范。
 */
export { AnimatePresence, motion } from "motion/react";
export { cn, type ClassValue } from "../../lib/cn.js";

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
  AppDropdownMenu,
  AppDropdownMenuItem,
  AppDropdownMenuLabel,
  AppDropdownMenuSeparator,
  AppPopover,
  AppPopoverClose,
  AppTooltip,
  AppTooltipProvider,
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
