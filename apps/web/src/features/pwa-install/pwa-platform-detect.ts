/**
 * @module web/features/pwa-install/pwa-platform-detect
 * @description 跨操作系统、多浏览器与国内超级 App 内置 WebView 的纯函数特征识别引擎。
 *
 * 覆盖矩阵：
 * 1. Standalone 已安装独立运行态（`display-mode: standalone` / `navigator.standalone` / `android-app://`）
 * 2. App 内置 WebView（微信、企业微信、飞书、钉钉、QQ、微博、支付宝）— 严格区分 iOS vs Android 文案
 * 3. iOS Safari（底部工具栏分享）vs iPadOS Safari（顶部地址栏右侧分享）
 * 4. iOS Chrome (`CriOS`) / Edge (`EdgiOS`) / Firefox (`FxiOS`) 及第三方浏览器
 * 5. Android 原生 `beforeinstallprompt` 一键安装（Chrome / Edge / Brave / Samsung）
 * 6. Android Samsung Internet（底部 `≡` → 将页面添加至 → 主屏幕）
 * 7. Android Firefox（`⋮` → 安装 / 添加到主屏幕）
 * 8. 国产 Android 浏览器（夸克、UC、小米、华为、OPPO、vivo、QQ浏览器、百度）+ 国产 ROM 桌面快捷方式权限指引
 */

import type { SupportedLocale } from "@openhuddle/protocol";
import { getPwaInstallTranslator } from "./i18n/index.js";

export type PwaOsKind = "ios" | "ipados" | "android" | "desktop";

export type PwaInstallMode =
  | "standalone-installed"
  | "ios-in-app-webview"
  | "android-in-app-webview"
  | "ios-safari"
  | "ipados-safari"
  | "ios-third-party"
  | "android-native-prompt"
  | "android-samsung"
  | "android-firefox"
  | "android-domestic"
  | "android-chromium-manual"
  | "desktop-browser";

export type InAppWebViewKind =
  | "wechat"
  | "wecom"
  | "feishu"
  | "dingtalk"
  | "qq"
  | "weibo"
  | "alipay";

export type StepGlyphKind =
  | "ios-share"
  | "more-horizontal"
  | "more-vertical"
  | "hamburger-menu"
  | "plus-square"
  | "browser-compass"
  | "check-confirm";

export interface PwaGuideStep {
  readonly title: string;
  readonly detail: string;
  readonly glyph: StepGlyphKind;
}

export interface PwaPlatformEnvironmentInput {
  readonly userAgent: string;
  readonly platform?: string | undefined;
  readonly maxTouchPoints?: number | undefined;
  readonly isStandaloneMedia?: boolean | undefined;
  readonly navigatorStandalone?: boolean | undefined;
  readonly referrer?: string | undefined;
  readonly hasSourcePwaParam?: boolean | undefined;
  readonly hasPersistedInstalledFlag?: boolean | undefined;
  readonly hasBeforeInstallPrompt?: boolean | undefined;
}

export interface PwaPlatformProfile {
  readonly os: PwaOsKind;
  readonly mode: PwaInstallMode;
  readonly browserLabel: string;
  readonly inAppHost: InAppWebViewKind | null;
  readonly inAppHostLabel: string | null;
  readonly isStandalone: boolean;
  readonly isMobileOrTablet: boolean;
  readonly canTriggerNativePrompt: boolean;
  readonly showEntryInMenu: boolean;
  readonly showSmartBannerByDefault: boolean;
  readonly needsAndroidRomShortcutTip: boolean;
  readonly steps: readonly PwaGuideStep[];
  readonly secondaryNote: string | null;
}

type PwaTranslateFn = ReturnType<typeof getPwaInstallTranslator>["t"];

function detectInAppWebView(
  ua: string,
  t: PwaTranslateFn,
): {
  readonly kind: InAppWebViewKind;
  readonly label: string;
} | null {
  if (/wxwork/i.test(ua)) {
    return { kind: "wecom", label: t("host.wecom") };
  }
  if (/MicroMessenger/i.test(ua)) {
    return { kind: "wechat", label: t("host.wechat") };
  }
  if (/Feishu|Lark/i.test(ua)) {
    return { kind: "feishu", label: t("host.feishu") };
  }
  if (/DingTalk/i.test(ua)) {
    return { kind: "dingtalk", label: t("host.dingtalk") };
  }
  if (/AlipayClient|AliApp/i.test(ua)) {
    return { kind: "alipay", label: t("host.alipay") };
  }
  if (/Weibo/i.test(ua)) {
    return { kind: "weibo", label: t("host.weibo") };
  }
  // 注意排除 MQQBrowser（手机 QQ 独立浏览器），仅匹配手机 QQ / TIM 内置 WebView (`QQ/` 或 `TIM/`)
  if (/(?:\bQQ\/|\bTIM\/)/i.test(ua) && !/MQQBrowser\/.*TBS/i.test(ua)) {
    return { kind: "qq", label: "QQ" };
  }
  if (/\bV1_AND_SQ_|\bIPadQQ|\bIPhoneQQ|\bPA QQ/i.test(ua)) {
    return { kind: "qq", label: "QQ" };
  }
  return null;
}

function detectOs(ua: string, platform?: string, maxTouchPoints?: number): PwaOsKind {
  if (/iPad/i.test(ua)) {
    return "ipados";
  }
  // iPadOS 13+ Safari 默认桌面级 UA：`Macintosh` + `maxTouchPoints > 1`
  if (
    (/Macintosh/i.test(ua) || platform === "MacIntel") &&
    typeof maxTouchPoints === "number" &&
    maxTouchPoints > 1 &&
    !/iPhone|Android/i.test(ua)
  ) {
    return "ipados";
  }
  if (/iPhone|iPod/i.test(ua)) {
    return "ios";
  }
  if (/Android/i.test(ua)) {
    return "android";
  }
  return "desktop";
}

function detectIosThirdPartyBrowserLabel(ua: string, t: PwaTranslateFn): string | null {
  if (/CriOS/i.test(ua)) return "Chrome";
  if (/EdgiOS/i.test(ua)) return "Edge";
  if (/FxiOS/i.test(ua)) return "Firefox";
  if (/OPiOS/i.test(ua)) return "Opera";
  if (/Quark/i.test(ua)) return t("browser.quark");
  if (/UCBrowser/i.test(ua)) return t("browser.uc");
  if (/MQQBrowser/i.test(ua)) return t("browser.qq");
  if (/baiduboxapp/i.test(ua)) return t("browser.baiduApp");
  return null;
}

function detectAndroidDomesticBrowserLabel(ua: string, t: PwaTranslateFn): string | null {
  if (/Quark/i.test(ua)) return t("browser.quark");
  if (/UCBrowser|UCWEB/i.test(ua)) return t("browser.uc");
  if (/MiuiBrowser|XiaoMi/i.test(ua) && /MiuiBrowser/i.test(ua)) return t("browser.miui");
  if (/HuaweiBrowser|HBPC/i.test(ua)) return t("browser.huawei");
  if (/HeyTapBrowser|OppoBrowser/i.test(ua)) return t("browser.oppo");
  if (/VivoBrowser/i.test(ua)) return t("browser.vivo");
  if (/MQQBrowser/i.test(ua)) return t("browser.qq");
  if (/baiduboxapp|baidubrowser/i.test(ua)) return t("browser.baidu");
  if (/SogouMobileBrowser/i.test(ua)) return t("browser.sogou");
  if (/MZBrowser/i.test(ua)) return t("browser.meizu");
  return null;
}

/**
 * 根据运行环境快照解析精准的「添加到手机主屏幕」平台策略与分步说明。
 *
 * @param input - 浏览器环境特征快照
 * @param locale - 可选显式语种（缺省取全局生效语种）
 */
export function detectPwaPlatformProfile(
  input: PwaPlatformEnvironmentInput,
  locale?: SupportedLocale,
): PwaPlatformProfile {
  const { t } = getPwaInstallTranslator(locale);
  const androidRomShortcutTip = t("note.androidRomShortcut");
  const ua = input.userAgent || "";
  const isStandalone = Boolean(
    input.isStandaloneMedia ||
      input.navigatorStandalone ||
      input.hasSourcePwaParam ||
      input.hasPersistedInstalledFlag ||
      input.referrer?.startsWith("android-app://"),
  );
  const os = detectOs(ua, input.platform, input.maxTouchPoints);
  const isMobileOrTablet = os === "ios" || os === "ipados" || os === "android";

  if (isStandalone) {
    return {
      os,
      mode: "standalone-installed",
      browserLabel: t("browser.standalone"),
      inAppHost: null,
      inAppHostLabel: null,
      isStandalone: true,
      isMobileOrTablet,
      canTriggerNativePrompt: false,
      showEntryInMenu: false,
      showSmartBannerByDefault: false,
      needsAndroidRomShortcutTip: false,
      steps: [],
      secondaryNote: null,
    };
  }

  const inApp = detectInAppWebView(ua, t);
  if (inApp !== null && isMobileOrTablet) {
    const isApple = os === "ios" || os === "ipados";
    return {
      os,
      mode: isApple ? "ios-in-app-webview" : "android-in-app-webview",
      browserLabel: t("browser.inAppFormat", { host: inApp.label }),
      inAppHost: inApp.kind,
      inAppHostLabel: inApp.label,
      isStandalone: false,
      isMobileOrTablet: true,
      canTriggerNativePrompt: false,
      showEntryInMenu: true,
      showSmartBannerByDefault: true,
      needsAndroidRomShortcutTip: !isApple,
      steps: isApple
        ? [
            {
              title: t("step.inApp.menu.title"),
              detail: t("step.inApp.menu.detail", { host: inApp.label }),
              glyph: "more-horizontal",
            },
            {
              title: t("step.inApp.iosOpen.title"),
              detail: t("step.inApp.iosOpen.detail", { host: inApp.label }),
              glyph: "browser-compass",
            },
            {
              title: t("step.inApp.iosAdd.title"),
              detail: t("step.inApp.iosAdd.detail"),
              glyph: "ios-share",
            },
          ]
        : [
            {
              title: t("step.inApp.menu.title"),
              detail: t("step.inApp.menu.detail", { host: inApp.label }),
              glyph: "more-horizontal",
            },
            {
              title: t("step.inApp.androidOpen.title"),
              detail: t("step.inApp.androidOpen.detail", { host: inApp.label }),
              glyph: "browser-compass",
            },
            {
              title: t("step.inApp.androidAdd.title"),
              detail: t("step.inApp.androidAdd.detail"),
              glyph: "plus-square",
            },
          ],
      secondaryNote: isApple ? null : androidRomShortcutTip,
    };
  }

  // iOS / iPadOS 分支
  if (os === "ios" || os === "ipados") {
    const thirdPartyLabel = detectIosThirdPartyBrowserLabel(ua, t);
    if (thirdPartyLabel !== null) {
      return {
        os,
        mode: "ios-third-party",
        browserLabel: `${os === "ipados" ? "iPadOS" : "iOS"} ${thirdPartyLabel}`,
        inAppHost: null,
        inAppHostLabel: null,
        isStandalone: false,
        isMobileOrTablet: true,
        canTriggerNativePrompt: false,
        showEntryInMenu: true,
        showSmartBannerByDefault: true,
        needsAndroidRomShortcutTip: false,
        steps: [
          {
            title: t("step.iosThirdParty.share.title"),
            detail: t("step.iosThirdParty.share.detail", { browser: thirdPartyLabel }),
            glyph: "ios-share",
          },
          {
            title: t("step.iosThirdParty.addToHome.title"),
            detail: t("step.iosThirdParty.addToHome.detail"),
            glyph: "plus-square",
          },
          {
            title: t("step.iosThirdParty.confirm.title"),
            detail: t("step.iosThirdParty.confirm.detail"),
            glyph: "check-confirm",
          },
        ],
        secondaryNote: t("note.iosThirdPartyFallback", { browser: thirdPartyLabel }),
      };
    }

    const isIpad = os === "ipados";
    return {
      os,
      mode: isIpad ? "ipados-safari" : "ios-safari",
      browserLabel: isIpad ? "iPadOS Safari" : "iOS Safari",
      inAppHost: null,
      inAppHostLabel: null,
      isStandalone: false,
      isMobileOrTablet: true,
      canTriggerNativePrompt: false,
      showEntryInMenu: true,
      showSmartBannerByDefault: true,
      needsAndroidRomShortcutTip: false,
      steps: [
        {
          title: isIpad ? t("step.ipadosSafari.share.title") : t("step.iosSafari.share.title"),
          detail: isIpad ? t("step.ipadosSafari.share.detail") : t("step.iosSafari.share.detail"),
          glyph: "ios-share",
        },
        {
          title: t("step.safari.addToHome.title"),
          detail: t("step.safari.addToHome.detail"),
          glyph: "plus-square",
        },
        {
          title: t("step.safari.confirm.title"),
          detail: t("step.safari.confirm.detail"),
          glyph: "check-confirm",
        },
      ],
      secondaryNote: null,
    };
  }

  // Android 分支
  if (os === "android") {
    const isSamsung = /SamsungBrowser/i.test(ua);
    const isFirefox = /Firefox|FxiOS/i.test(ua);
    const domesticLabel = detectAndroidDomesticBrowserLabel(ua, t);
    const chromiumLabel = /EdgA/i.test(ua)
      ? "Edge"
      : /Brave/i.test(ua)
        ? "Brave"
        : isSamsung
          ? "Samsung Internet"
          : "Chrome";

    if (input.hasBeforeInstallPrompt) {
      return {
        os: "android",
        mode: "android-native-prompt",
        browserLabel: `Android ${chromiumLabel}`,
        inAppHost: null,
        inAppHostLabel: null,
        isStandalone: false,
        isMobileOrTablet: true,
        canTriggerNativePrompt: true,
        showEntryInMenu: true,
        showSmartBannerByDefault: true,
        needsAndroidRomShortcutTip: true,
        steps: [
          {
            title: t("step.androidNative.tap.title"),
            detail: t("step.androidNative.tap.detail"),
            glyph: "plus-square",
          },
          {
            title: t("step.androidNative.confirm.title"),
            detail: t("step.androidNative.confirm.detail"),
            glyph: "check-confirm",
          },
        ],
        secondaryNote: androidRomShortcutTip,
      };
    }

    if (isSamsung) {
      return {
        os: "android",
        mode: "android-samsung",
        browserLabel: "Samsung Internet",
        inAppHost: null,
        inAppHostLabel: null,
        isStandalone: false,
        isMobileOrTablet: true,
        canTriggerNativePrompt: false,
        showEntryInMenu: true,
        showSmartBannerByDefault: true,
        needsAndroidRomShortcutTip: true,
        steps: [
          {
            title: t("step.samsung.menu.title"),
            detail: t("step.samsung.menu.detail"),
            glyph: "hamburger-menu",
          },
          {
            title: t("step.samsung.addPage.title"),
            detail: t("step.samsung.addPage.detail"),
            glyph: "plus-square",
          },
          {
            title: t("step.samsung.confirm.title"),
            detail: t("step.samsung.confirm.detail"),
            glyph: "check-confirm",
          },
        ],
        secondaryNote: androidRomShortcutTip,
      };
    }

    if (isFirefox) {
      return {
        os: "android",
        mode: "android-firefox",
        browserLabel: "Android Firefox",
        inAppHost: null,
        inAppHostLabel: null,
        isStandalone: false,
        isMobileOrTablet: true,
        canTriggerNativePrompt: false,
        showEntryInMenu: true,
        showSmartBannerByDefault: true,
        needsAndroidRomShortcutTip: true,
        steps: [
          {
            title: t("step.firefox.menu.title"),
            detail: t("step.firefox.menu.detail"),
            glyph: "more-vertical",
          },
          {
            title: t("step.firefox.install.title"),
            detail: t("step.firefox.install.detail"),
            glyph: "plus-square",
          },
          {
            title: t("step.firefox.confirm.title"),
            detail: t("step.firefox.confirm.detail"),
            glyph: "check-confirm",
          },
        ],
        secondaryNote: androidRomShortcutTip,
      };
    }

    if (domesticLabel !== null) {
      return {
        os: "android",
        mode: "android-domestic",
        browserLabel: domesticLabel,
        inAppHost: null,
        inAppHostLabel: null,
        isStandalone: false,
        isMobileOrTablet: true,
        canTriggerNativePrompt: false,
        showEntryInMenu: true,
        showSmartBannerByDefault: true,
        needsAndroidRomShortcutTip: true,
        steps: [
          {
            title: t("step.domestic.menu.title", { browser: domesticLabel }),
            detail: t("step.domestic.menu.detail"),
            glyph: "hamburger-menu",
          },
          {
            title: t("step.domestic.add.title"),
            detail: t("step.domestic.add.detail"),
            glyph: "plus-square",
          },
          {
            title: t("step.domestic.confirm.title"),
            detail: t("step.domestic.confirm.detail"),
            glyph: "check-confirm",
          },
        ],
        secondaryNote: androidRomShortcutTip,
      };
    }

    return {
      os: "android",
      mode: "android-chromium-manual",
      browserLabel: `Android ${chromiumLabel}`,
      inAppHost: null,
      inAppHostLabel: null,
      isStandalone: false,
      isMobileOrTablet: true,
      canTriggerNativePrompt: false,
      showEntryInMenu: true,
      showSmartBannerByDefault: true,
      needsAndroidRomShortcutTip: true,
      steps: [
        {
          title: t("step.chromium.menu.title"),
          detail: t("step.chromium.menu.detail", { browser: chromiumLabel }),
          glyph: "more-vertical",
        },
        {
          title: t("step.chromium.install.title"),
          detail: t("step.chromium.install.detail"),
          glyph: "plus-square",
        },
        {
          title: t("step.chromium.confirm.title"),
          detail: t("step.chromium.confirm.detail"),
          glyph: "check-confirm",
        },
      ],
      secondaryNote: androidRomShortcutTip,
    };
  }

  // Desktop 兜底（仅当用户从命令面板等主动打开说明时呈现，不在桌面端弹手机横幅）
  return {
    os: "desktop",
    mode: "desktop-browser",
    browserLabel: t("browser.desktop"),
    inAppHost: null,
    inAppHostLabel: null,
    isStandalone: false,
    isMobileOrTablet: false,
    canTriggerNativePrompt: Boolean(input.hasBeforeInstallPrompt),
    showEntryInMenu: false,
    showSmartBannerByDefault: false,
    needsAndroidRomShortcutTip: false,
    steps: [
      {
        title: t("step.desktop.title"),
        detail: t("step.desktop.detail"),
        glyph: "plus-square",
      },
    ],
    secondaryNote: null,
  };
}
