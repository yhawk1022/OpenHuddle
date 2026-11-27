/**
 * @module web/features/auth-pairing/account-theme-menu
 * @description 外观、界面语言与显示刷新率统一设置菜单。菜单选中态反映用户偏好，触发图标反映当前实际配色。
 */
import type { ThemePreference } from "@openhuddle/protocol";
import { Check, Clock3, Gauge, Monitor, Moon, Sun } from "lucide-react";
import {
  AppDropdownMenu,
  AppDropdownMenuGroup,
  AppDropdownMenuItem,
  AppDropdownMenuLabel,
  AppDropdownMenuSeparator,
  IconButton,
  setRefreshRatePreference,
  useDisplayRefreshState,
} from "../../../components/primitives/index.js";
import { useCommonI18n } from "../../../lib/i18n/index.js";
import { useThemeMode } from "../../../lib/theme-store.js";
import {
  useAccountLanguagePreference,
  useAccountThemePreference,
} from "../api/auth-pairing.queries.js";
import { LocaleMenuGroup } from "./locale-switcher-menu.js";

/** `AccountThemeMenu` 入参属性 */
export interface AccountThemeMenuProps {
  /** 弹出方向（默认 `"bottom"`） */
  readonly side?: "top" | "right" | "bottom" | "left" | undefined;
  /** 对齐方式（默认 `"start"`，保持历史调用点向后兼容） */
  readonly align?: "start" | "center" | "end" | undefined;
}

const THEME_OPTIONS = [
  { value: "auto", labelKey: "displayMenu.theme.auto", icon: Clock3 },
  { value: "light", labelKey: "displayMenu.theme.light", icon: Sun },
  { value: "dark", labelKey: "displayMenu.theme.dark", icon: Moon },
] as const satisfies ReadonlyArray<{
  readonly value: ThemePreference;
  readonly labelKey:
    | "displayMenu.theme.auto"
    | "displayMenu.theme.light"
    | "displayMenu.theme.dark";
  readonly icon: typeof Sun;
}>;

/**
 * 渲染登录后可通过键盘操作的账号外观、界面语言与显示刷新率统一菜单。
 *
 * @param props - 可选弹出方向与对齐策略
 * @returns 保存到当前人类账号的外观、语言与画面刷新率控制菜单
 */
export function AccountThemeMenu(props: AccountThemeMenuProps) {
  const { side = "bottom", align = "start" } = props;
  const { t } = useCommonI18n();
  const { preference, isSaving, setPreference } = useAccountThemePreference();
  const accountLanguage = useAccountLanguagePreference();
  const refreshState = useDisplayRefreshState();
  const CurrentModeIcon = useThemeMode() === "dark" ? Moon : Sun;
  const triggerLabel = t("displayMenu.triggerLabel");

  return (
    <AppDropdownMenu
      side={side}
      align={align}
      className="min-w-60"
      trigger={
        <IconButton
          label={triggerLabel}
          title={triggerLabel}
          isLoading={isSaving || accountLanguage.isSaving}
        >
          <CurrentModeIcon aria-hidden="true" className="h-4 w-4 shrink-0" />
        </IconButton>
      }
    >
      <AppDropdownMenuGroup>
        <AppDropdownMenuLabel className="text-im-muted">
          {t("displayMenu.themeSection")}
        </AppDropdownMenuLabel>
        {THEME_OPTIONS.map(({ value, labelKey, icon: Icon }) => (
          <AppDropdownMenuItem
            key={value}
            role="menuitemradio"
            aria-checked={preference === value}
            onSelect={() => setPreference(value)}
          >
            <Icon aria-hidden="true" className="h-4 w-4 shrink-0" />
            <span className="flex-1">
              {t(labelKey)}
              {value === "auto" ? (
                <span className="block text-[11px] font-normal text-im-muted">
                  {t("displayMenu.theme.autoHint")}
                </span>
              ) : null}
            </span>
            {preference === value ? (
              <Check aria-hidden="true" className="h-4 w-4 shrink-0" />
            ) : null}
          </AppDropdownMenuItem>
        ))}
      </AppDropdownMenuGroup>

      <AppDropdownMenuSeparator />

      <LocaleMenuGroup
        preference={accountLanguage.preference}
        resolvedLocale={accountLanguage.resolvedLocale}
        onSelect={accountLanguage.setPreference}
      />

      <AppDropdownMenuSeparator />

      <AppDropdownMenuGroup>
        <AppDropdownMenuLabel className="text-im-muted">
          {t("displayMenu.refreshSection")}
        </AppDropdownMenuLabel>
        <AppDropdownMenuItem
          role="menuitemradio"
          aria-checked={refreshState.preference === "max"}
          onSelect={() => setRefreshRatePreference("max")}
        >
          <Gauge aria-hidden="true" className="h-4 w-4 shrink-0" />
          <span className="flex-1">
            {t("displayMenu.refresh.max")}
            <span className="block text-[11px] font-normal text-im-muted">
              {refreshState.isSafariWebKit60HzCapped
                ? t("displayMenu.refresh.maxSafariCapped")
                : t("displayMenu.refresh.maxAdaptive", { hz: refreshState.detectedHz })}
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
            {t("displayMenu.refresh.standard")}
            <span className="block text-[11px] font-normal text-im-muted">
              {t("displayMenu.refresh.standardHint")}
            </span>
          </span>
          {refreshState.preference === "standard" ? (
            <Check aria-hidden="true" className="h-4 w-4 shrink-0" />
          ) : null}
        </AppDropdownMenuItem>
      </AppDropdownMenuGroup>
    </AppDropdownMenu>
  );
}
