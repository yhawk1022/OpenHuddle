/**
 * @module web/components/ui/theme-toggle
 * @description 基于 Pachat 纯墨黑/暖纸单色体系（`#141414` / `#F5F5F7`）与 `motion` 弹簧旋转微交互的日光 / 深夜主题切换器。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 单一外部状态源：直接读写 `session-store` 主题模式，切换 `<html>` 上的 `.dark` 类即可零闪烁驱动全站令牌与轻提示换肤。
 * 2. 桌面无边框窗口拖拽安全：`IconButton` 与 `AppButton` 原生携带 `rounded-full` 胶囊几何与 `.app-no-drag`，嵌入 Tauri / Electron 拖拽顶栏时点击始终可靠响应。
 * 3. 纯粹单色图标：摒弃紫色月亮图标，统一使用干净克制的墨黑与柔白线条呈现日月切换。
 */
import { Moon, Sun } from "lucide-react";
import { toggleThemeMode, useThemeMode } from "../../lib/session-store.js";
import { AnimatePresence, AppButton, AppTooltip, IconButton, motion } from "../primitives/index.js";

/** `ThemeToggle` 入参属性 */
export interface ThemeToggleProps {
  /** 是否在图标旁展示主题文字标签 */
  readonly showLabel?: boolean | undefined;
  /** `ghost` = 无边框幽灵圆形按钮（适合 80px 导轨与顶栏）；`pill` = 带细描边的胶囊按钮 */
  readonly variant?: "pill" | "ghost" | undefined;
  /** 可选附加类名 */
  readonly className?: string | undefined;
}

const ICON_SPRING = {
  type: "spring",
  stiffness: 480,
  damping: 28,
} as const;

/**
 * 渲染带 `AppTooltip` 与弹簧旋转日月动画的 Pachat 风格主题切换按钮。
 *
 * @param props - 是否展示文字标签、视觉变体及附加类名
 * @returns 无障碍友好的圆形或胶囊主题切换按钮
 */
export function ThemeToggle(props: ThemeToggleProps) {
  const mode = useThemeMode();
  const isDark = mode === "dark";
  const isGhost = props.variant === "ghost";
  const tooltipLabel = isDark ? "切换至日光模式" : "切换至深夜模式";

  const animatedGlyph = (
    <span className="relative inline-flex h-4 w-4 items-center justify-center overflow-hidden">
      <AnimatePresence mode="wait" initial={false}>
        {isDark ? (
          <motion.span
            key="sun"
            initial={{ opacity: 0, rotate: -75, scale: 0.55 }}
            animate={{ opacity: 1, rotate: 0, scale: 1 }}
            exit={{ opacity: 0, rotate: 75, scale: 0.55 }}
            transition={ICON_SPRING}
            className="inline-flex items-center justify-center"
          >
            <Sun className="h-4 w-4 text-[#F5F5F7]" />
          </motion.span>
        ) : (
          <motion.span
            key="moon"
            initial={{ opacity: 0, rotate: 75, scale: 0.55 }}
            animate={{ opacity: 1, rotate: 0, scale: 1 }}
            exit={{ opacity: 0, rotate: -75, scale: 0.55 }}
            transition={ICON_SPRING}
            className="inline-flex items-center justify-center"
          >
            <Moon className="h-4 w-4 text-[#141414]" />
          </motion.span>
        )}
      </AnimatePresence>
    </span>
  );

  if (props.showLabel) {
    return (
      <AppTooltip content={tooltipLabel} side="bottom">
        <AppButton
          variant={isGhost ? "ghost" : "secondary"}
          size="sm"
          onClick={toggleThemeMode}
          aria-label={tooltipLabel}
          leadingIcon={animatedGlyph}
          className={props.className}
        >
          <span>{isDark ? "日光模式" : "深夜模式"}</span>
        </AppButton>
      </AppTooltip>
    );
  }

  return (
    <AppTooltip content={tooltipLabel} side="right">
      <IconButton
        variant={isGhost ? "ghost" : "secondary"}
        size="md"
        label={tooltipLabel}
        onClick={toggleThemeMode}
        className={props.className}
      >
        {animatedGlyph}
      </IconButton>
    </AppTooltip>
  );
}
