/**
 * @module web/features/auth-pairing/locale-switcher-menu
 * @description 面向未登录门户、欢迎页与公开分享页的轻量界面语言切换下拉菜单，以及供登录态统一菜单复用的语言分组组件。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. Native Script Autonyms：中文与英文选项恒使用原生文字（`简体中文` / `English`），避免用户在误切陌生语种后迷失。
 * 2. 语义分组与无障碍键盘流：复用 `AppDropdownMenu` + `AppDropdownMenuGroup` + `menuitemradio`，确保 `ArrowUp/Down`、`Enter` 与 `Esc` 焦点回归。
 * 3. 无国旗 Emoji、固定图标尺寸，符合 Apple Liquid Glass 与原生桌面软件品味规范。
 */
import type { LanguagePreference, SupportedLocale } from "@openhuddle/protocol";
import { Check, Globe, Languages } from "lucide-react";
import {
  AppDropdownMenu,
  AppDropdownMenuGroup,
  AppDropdownMenuItem,
  AppDropdownMenuLabel,
  IconButton,
} from "../../../components/primitives/index.js";
import {
  setGuestLanguagePreference,
  useCommonI18n,
  useGuestLanguagePreference,
  useLocale,
} from "../../../lib/i18n/index.js";

/** `LocaleMenuGroup` 入参属性 */
export interface LocaleMenuGroupProps {
  /** 当前保存的语言偏好（`auto` | `zh-CN` | `en`） */
  readonly preference: LanguagePreference;
  /** 当前实际解析生效的语种，供 `auto` 副标展示 */
  readonly resolvedLocale: SupportedLocale;
  /** 选择新语言偏好回调 */
  readonly onSelect: (nextPreference: LanguagePreference) => void;
  /** 是否禁用选项交互 */
  readonly disabled?: boolean | undefined;
}

/** `LocaleSwitcherMenu` 入参属性 */
export interface LocaleSwitcherMenuProps {
  /** 弹出方向（默认 `"bottom"`） */
  readonly side?: "top" | "right" | "bottom" | "left" | undefined;
  /** 对齐方式（默认 `"end"`） */
  readonly align?: "start" | "center" | "end" | undefined;
  /** 触发按钮附加类名 */
  readonly className?: string | undefined;
}

/** 语言选项声明表（供下拉菜单与分段控件共享一致顺序）。 */
export const LOCALE_PREFERENCE_ORDER: ReadonlyArray<LanguagePreference> = [
  "auto",
  "zh-CN",
  "en",
] as const;

/**
 * 渲染可复用的界面语言单选分组（`自动` / `简体中文` / `English`）。
 *
 * @param props - 当前偏好、实际解析语种及选择回调
 * @returns 带 ARIA 分组语义的 `AppDropdownMenuGroup`
 */
export function LocaleMenuGroup(props: LocaleMenuGroupProps) {
  const { preference, resolvedLocale, onSelect, disabled = false } = props;
  const { t } = useCommonI18n();
  const resolvedAutonym =
    resolvedLocale === "zh-CN" ? t("locale.autonym.zhCN") : t("locale.autonym.en");

  return (
    <AppDropdownMenuGroup>
      <AppDropdownMenuLabel className="text-im-muted">{t("locale.menuLabel")}</AppDropdownMenuLabel>
      {LOCALE_PREFERENCE_ORDER.map((value) => {
        const isSelected = preference === value;
        const primaryLabel =
          value === "auto"
            ? t("locale.option.auto")
            : value === "zh-CN"
              ? t("locale.autonym.zhCN")
              : t("locale.autonym.en");
        const secondaryLabel =
          value === "auto" ? t("locale.option.autoResolved", { language: resolvedAutonym }) : null;

        return (
          <AppDropdownMenuItem
            key={value}
            role="menuitemradio"
            aria-checked={isSelected}
            disabled={disabled}
            onSelect={() => onSelect(value)}
          >
            {value === "auto" ? (
              <Globe aria-hidden="true" className="h-4 w-4 shrink-0" />
            ) : (
              <span
                aria-hidden="true"
                className="inline-flex h-4 w-4 shrink-0 items-center justify-center text-[11px] font-semibold leading-none tracking-tight opacity-80"
              >
                {value === "zh-CN" ? /* i18n-ignore */ "中" : "EN"}
              </span>
            )}
            <span className="flex-1">
              {primaryLabel}
              {secondaryLabel !== null ? (
                <span className="block text-[11px] font-normal text-im-muted">
                  {secondaryLabel}
                </span>
              ) : null}
            </span>
            {isSelected ? <Check aria-hidden="true" className="h-4 w-4 shrink-0" /> : null}
          </AppDropdownMenuItem>
        );
      })}
    </AppDropdownMenuGroup>
  );
}

/**
 * 渲染未登录门户、欢迎页与公开分享页的独立界面语言切换下拉菜单。
 *
 * @param props - 弹出方向、对齐方式与按钮附加类名
 * @returns 写入 `oh_guest_lang` 并无刷新生效的语言切换器
 */
export function LocaleSwitcherMenu(props: LocaleSwitcherMenuProps) {
  const { side = "bottom", align = "end", className } = props;
  const preference = useGuestLanguagePreference();
  const resolvedLocale = useLocale();
  const { t } = useCommonI18n();
  const triggerLabel = t("locale.switcherTriggerLabel");

  return (
    <AppDropdownMenu
      side={side}
      align={align}
      className="min-w-48"
      trigger={
        <IconButton
          size="sm"
          variant="ghost"
          label={triggerLabel}
          title={triggerLabel}
          className={className}
        >
          <Languages aria-hidden="true" className="h-4 w-4" />
        </IconButton>
      }
    >
      <LocaleMenuGroup
        preference={preference}
        resolvedLocale={resolvedLocale}
        onSelect={setGuestLanguagePreference}
      />
    </AppDropdownMenu>
  );
}
