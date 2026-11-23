/**
 * @module web/components/ui/theme-toggle
 * @description 外观设置菜单。菜单选中态反映用户偏好，触发图标反映当前实际配色。
 */
import { Check, Clock3, Moon, Sun } from "lucide-react";
import {
  type ThemePreference,
  setThemePreference,
  useThemeMode,
  useThemePreference,
} from "../../lib/theme-store.js";
import {
  AppButton,
  AppDropdownMenu,
  AppDropdownMenuItem,
  AppDropdownMenuLabel,
  IconButton,
} from "../primitives/index.js";

/** `ThemeToggle` 入参属性。 */
export interface ThemeToggleProps {
  /** 是否在图标旁显示「外观」文字。 */
  readonly showLabel?: boolean | undefined;
  /** 导轨和顶栏用幽灵按钮，默认使用胶囊按钮。 */
  readonly variant?: "pill" | "ghost" | undefined;
  /** 附加到触发按钮的样式。 */
  readonly className?: string | undefined;
}

const THEME_OPTIONS = [
  { value: "auto", label: "自动切换", icon: Clock3 },
  { value: "light", label: "始终使用白天模式", icon: Sun },
  { value: "dark", label: "始终使用夜间模式", icon: Moon },
] as const satisfies ReadonlyArray<{
  readonly value: ThemePreference;
  readonly label: string;
  readonly icon: typeof Sun;
}>;

/**
 * 渲染可用键盘操作的外观设置菜单。
 *
 * @param props - 触发按钮的文字、变体及附加样式。
 * @returns 可选择定时切换或固定配色的菜单。
 */
export function ThemeToggle(props: ThemeToggleProps) {
  const preference = useThemePreference();
  const CurrentModeIcon = useThemeMode() === "dark" ? Moon : Sun;
  const glyph = <CurrentModeIcon aria-hidden="true" className="h-4 w-4" />;
  const variant = props.variant === "ghost" ? "ghost" : "secondary";
  const label = "外观设置";

  return (
    <AppDropdownMenu
      align={props.showLabel ? "end" : "start"}
      className="min-w-52"
      trigger={
        props.showLabel ? (
          <AppButton
            variant={variant}
            size="sm"
            aria-label={label}
            leadingIcon={glyph}
            className={props.className}
          >
            外观
          </AppButton>
        ) : (
          <IconButton label={label} title={label} variant={variant} className={props.className}>
            {glyph}
          </IconButton>
        )
      }
    >
      <AppDropdownMenuLabel className="text-im-muted">外观设置</AppDropdownMenuLabel>
      {THEME_OPTIONS.map(({ value, label, icon: Icon }) => (
        <AppDropdownMenuItem
          key={value}
          role="menuitemradio"
          aria-checked={preference === value}
          onSelect={() => setThemePreference(value)}
        >
          <Icon aria-hidden="true" className="h-4 w-4 shrink-0" />
          <span className="flex-1">
            {label}
            {value === "auto" ? (
              <span className="block text-[11px] font-normal text-im-muted">
                07:00 白天 · 18:00 夜间
              </span>
            ) : null}
          </span>
          {preference === value ? <Check aria-hidden="true" className="h-4 w-4 shrink-0" /> : null}
        </AppDropdownMenuItem>
      ))}
    </AppDropdownMenu>
  );
}
