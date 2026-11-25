/**
 * @module web/features/auth-pairing/account-theme-menu
 * @description 外观设置菜单。菜单选中态反映用户偏好，触发图标反映当前实际配色。
 */
import type { ThemePreference } from "@openhuddle/protocol";
import { Check, Clock3, Gauge, Monitor, Moon, Sun } from "lucide-react";
import {
  AppDropdownMenu,
  AppDropdownMenuItem,
  AppDropdownMenuLabel,
  AppDropdownMenuSeparator,
  IconButton,
  setRefreshRatePreference,
  useDisplayRefreshState,
} from "../../../components/primitives/index.js";
import { useThemeMode } from "../../../lib/theme-store.js";
import { useAccountThemePreference } from "../api/auth-pairing.queries.js";

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
 * 渲染登录后可通过键盘操作的账号外观与显示帧率菜单。
 *
 * @returns 保存到当前人类账号的主题选项与最高刷新率控制菜单。
 */
export function AccountThemeMenu() {
  const { preference, isSaving, setPreference } = useAccountThemePreference();
  const refreshState = useDisplayRefreshState();
  const CurrentModeIcon = useThemeMode() === "dark" ? Moon : Sun;

  return (
    <AppDropdownMenu
      align="start"
      className="min-w-56"
      trigger={
        <IconButton label="外观与显示设置" title="外观与显示设置" isLoading={isSaving}>
          <CurrentModeIcon aria-hidden="true" className="h-4 w-4" />
        </IconButton>
      }
    >
      <AppDropdownMenuLabel className="text-im-muted">外观设置</AppDropdownMenuLabel>
      {THEME_OPTIONS.map(({ value, label, icon: Icon }) => (
        <AppDropdownMenuItem
          key={value}
          role="menuitemradio"
          aria-checked={preference === value}
          onSelect={() => setPreference(value)}
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

      <AppDropdownMenuSeparator />
      <AppDropdownMenuLabel className="text-im-muted">画面刷新率</AppDropdownMenuLabel>
      <AppDropdownMenuItem
        role="menuitemradio"
        aria-checked={refreshState.preference === "max"}
        onSelect={() => setRefreshRatePreference("max")}
      >
        <Gauge aria-hidden="true" className="h-4 w-4 shrink-0" />
        <span className="flex-1">
          最高刷新率
          <span className="block text-[11px] font-normal text-im-muted">
            {refreshState.isSafariWebKit60HzCapped
              ? "当前受 Safari 60fps 开关限制"
              : `自适应屏幕峰值 · 当前 ${refreshState.detectedHz}Hz`}
          </span>
        </span>
        {refreshState.preference === "max" ? (
          <Check aria-hidden="true" className="h-4 w-4 shrink-0" />
        ) : null}
      </AppDropdownMenuItem>
      <AppDropdownMenuItem
        role="menuitemradio"
        aria-checked={refreshState.preference === "standard"}
        onSelect={() => setRefreshRatePreference("standard")}
      >
        <Monitor aria-hidden="true" className="h-4 w-4 shrink-0" />
        <span className="flex-1">
          标准省电帧率
          <span className="block text-[11px] font-normal text-im-muted">允许系统自动降频节能</span>
        </span>
        {refreshState.preference === "standard" ? (
          <Check aria-hidden="true" className="h-4 w-4 shrink-0" />
        ) : null}
      </AppDropdownMenuItem>
    </AppDropdownMenu>
  );
}
