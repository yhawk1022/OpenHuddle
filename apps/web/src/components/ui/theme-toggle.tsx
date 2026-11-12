/**
 * @module web/components/ui/theme-toggle
 * @description 清爽日光模式（Crisp Daylight）与暗黑工作室模式（Studio Dark）一键切换按钮。
 *
 * 架构职责与关键不变量（Invariants）：
 * 直接读写 `session-store` 的外部主题状态源，零闪烁切换全站配色变量。
 */
import { Moon, Sun } from "lucide-react";
import { toggleThemeMode, useThemeMode } from "../../lib/session-store.js";

/** `ThemeToggle` 入参属性 */
export interface ThemeToggleProps {
  readonly showLabel?: boolean | undefined;
}

/**
 * 双主题切换触发器按钮。
 *
 * @param props - 是否在图标旁显示主题文字标签
 * @returns 无障碍友好的主题切换按钮
 */
export function ThemeToggle(props: ThemeToggleProps) {
  const mode = useThemeMode();
  const isDark = mode === "dark";

  return (
    <button
      type="button"
      onClick={toggleThemeMode}
      title={isDark ? "切换至清爽日光模式 (Crisp Daylight)" : "切换至暗黑工作室模式 (Studio Dark)"}
      className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200/90 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 shadow-2xs transition hover:bg-slate-100 dark:border-white/10 dark:bg-white/[0.04] dark:text-slate-300 dark:hover:bg-white/[0.09]"
    >
      {isDark ? (
        <>
          <Sun className="h-3.5 w-3.5 text-amber-400" />
          {props.showLabel ? <span>日光模式</span> : null}
        </>
      ) : (
        <>
          <Moon className="h-3.5 w-3.5 text-indigo-600" />
          {props.showLabel ? <span>暗黑模式</span> : null}
        </>
      )}
    </button>
  );
}
