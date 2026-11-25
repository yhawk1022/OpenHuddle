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

const ANDROID_ROM_SHORTCUT_TIP =
  "若点击添加后手机桌面未出现图标，请前往系统「设置 → 应用管理/权限 → 桌面快捷方式」，开启当前浏览器的「创建桌面快捷方式」权限（澎湃 OS / 鸿蒙 / ColorOS / OriginOS 常见默认拦截）。";

function detectInAppWebView(ua: string): {
  readonly kind: InAppWebViewKind;
  readonly label: string;
} | null {
  if (/wxwork/i.test(ua)) {
    return { kind: "wecom", label: "企业微信" };
  }
  if (/MicroMessenger/i.test(ua)) {
    return { kind: "wechat", label: "微信" };
  }
  if (/Feishu|Lark/i.test(ua)) {
    return { kind: "feishu", label: "飞书" };
  }
  if (/DingTalk/i.test(ua)) {
    return { kind: "dingtalk", label: "钉钉" };
  }
  if (/AlipayClient|AliApp/i.test(ua)) {
    return { kind: "alipay", label: "支付宝" };
  }
  if (/Weibo/i.test(ua)) {
    return { kind: "weibo", label: "微博" };
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

function detectIosThirdPartyBrowserLabel(ua: string): string | null {
  if (/CriOS/i.test(ua)) return "Chrome";
  if (/EdgiOS/i.test(ua)) return "Edge";
  if (/FxiOS/i.test(ua)) return "Firefox";
  if (/OPiOS/i.test(ua)) return "Opera";
  if (/Quark/i.test(ua)) return "夸克浏览器";
  if (/UCBrowser/i.test(ua)) return "UC 浏览器";
  if (/MQQBrowser/i.test(ua)) return "QQ 浏览器";
  if (/baiduboxapp/i.test(ua)) return "百度 App";
  return null;
}

function detectAndroidDomesticBrowserLabel(ua: string): string | null {
  if (/Quark/i.test(ua)) return "夸克浏览器";
  if (/UCBrowser|UCWEB/i.test(ua)) return "UC 浏览器";
  if (/MiuiBrowser|XiaoMi/i.test(ua) && /MiuiBrowser/i.test(ua)) return "小米浏览器";
  if (/HuaweiBrowser|HBPC/i.test(ua)) return "华为浏览器";
  if (/HeyTapBrowser|OppoBrowser/i.test(ua)) return "OPPO 浏览器";
  if (/VivoBrowser/i.test(ua)) return "vivo 浏览器";
  if (/MQQBrowser/i.test(ua)) return "QQ 浏览器";
  if (/baiduboxapp|baidubrowser/i.test(ua)) return "百度浏览器";
  if (/SogouMobileBrowser/i.test(ua)) return "搜狗浏览器";
  if (/MZBrowser/i.test(ua)) return "魅族浏览器";
  return null;
}

/**
 * 根据运行环境快照解析精准的「添加到手机主屏幕」平台策略与分步说明。
 */
export function detectPwaPlatformProfile(input: PwaPlatformEnvironmentInput): PwaPlatformProfile {
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
      browserLabel: "独立应用模式",
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

  const inApp = detectInAppWebView(ua);
  if (inApp !== null && isMobileOrTablet) {
    const isApple = os === "ios" || os === "ipados";
    return {
      os,
      mode: isApple ? "ios-in-app-webview" : "android-in-app-webview",
      browserLabel: `${inApp.label}内置浏览器`,
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
              title: "点击右上角「···」菜单",
              detail: `在${inApp.label}顶栏右侧打开更多操作菜单。`,
              glyph: "more-horizontal",
            },
            {
              title: "选择「在默认浏览器 / Safari 中打开」",
              detail: `${inApp.label}内置窗口不支持直接创建主屏幕图标，需先跳转系统浏览器。`,
              glyph: "browser-compass",
            },
            {
              title: "点击「分享」→「添加到主屏幕」",
              detail: "在 Safari 打开后，点击工具栏分享按钮并选择「添加到主屏幕」即可。",
              glyph: "ios-share",
            },
          ]
        : [
            {
              title: "点击右上角「···」菜单",
              detail: `在${inApp.label}顶栏右侧打开更多操作菜单。`,
              glyph: "more-horizontal",
            },
            {
              title: "选择「在浏览器打开」",
              detail: `${inApp.label}内置窗口不支持直接安装桌面图标，请先用手机系统浏览器打开。`,
              glyph: "browser-compass",
            },
            {
              title: "点击「安装应用 / 添加到主屏幕」",
              detail: "在系统浏览器中打开后，即可一键安装或通过浏览器菜单添加到手机桌面。",
              glyph: "plus-square",
            },
          ],
      secondaryNote: isApple ? null : ANDROID_ROM_SHORTCUT_TIP,
    };
  }

  // iOS / iPadOS 分支
  if (os === "ios" || os === "ipados") {
    const thirdPartyLabel = detectIosThirdPartyBrowserLabel(ua);
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
            title: "点击地址栏右侧「分享」图标",
            detail: `在 ${thirdPartyLabel} 顶部（或底部）地址栏旁找到向上箭头的分享按钮。`,
            glyph: "ios-share",
          },
          {
            title: "向下滑动，点击「添加到主屏幕」",
            detail: "在系统分享菜单列表中找到带加号的「添加到主屏幕」选项。",
            glyph: "plus-square",
          },
          {
            title: "点击右上角「添加」完成",
            detail: "返回主屏幕即可点击 OpenHuddle 图标以独立全屏模式启动。",
            glyph: "check-confirm",
          },
        ],
        secondaryNote: `若当前版本的 ${thirdPartyLabel} 菜单中未显示「添加到主屏幕」，可复制当前网址并在系统自带 Safari 浏览器中打开。`,
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
          title: isIpad ? "点击顶部地址栏右侧「分享」按钮" : "点击底部工具栏「分享」按钮",
          detail: isIpad
            ? "在 Safari 顶栏右侧找到带向上箭头的方形分享图标。"
            : "在 Safari 屏幕底部（若开启顶部地址栏则在上方）点击带向上箭头的方形分享图标。",
          glyph: "ios-share",
        },
        {
          title: "下滑菜单，点击「添加到主屏幕」",
          detail: "在弹出的面板中向下滑动，找到「添加到主屏幕」并轻触。",
          glyph: "plus-square",
        },
        {
          title: "点击右上角「添加」",
          detail: "添加后从主屏幕图标进入，即可隐藏浏览器地址栏获得原生全屏体验。",
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
    const domesticLabel = detectAndroidDomesticBrowserLabel(ua);
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
            title: "点击下方「立即添加到主屏幕」",
            detail: "直接唤起系统原生安装确认框，无需手动查找菜单。",
            glyph: "plus-square",
          },
          {
            title: "在系统弹窗中点击「安装 / 添加」",
            detail: "安装完成后即可在手机桌面与最近任务中独立全屏运行。",
            glyph: "check-confirm",
          },
        ],
        secondaryNote: ANDROID_ROM_SHORTCUT_TIP,
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
            title: "点击底部工具栏右下角「≡」菜单",
            detail: "打开三星浏览器底部功能面板。",
            glyph: "hamburger-menu",
          },
          {
            title: "点击「将页面添加至」→「主屏幕」",
            detail: "在添加目标中选择手机「主屏幕」。",
            glyph: "plus-square",
          },
          {
            title: "确认「添加」完成",
            detail: "从手机桌面点击图标即可全屏启动 OpenHuddle。",
            glyph: "check-confirm",
          },
        ],
        secondaryNote: ANDROID_ROM_SHORTCUT_TIP,
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
            title: "点击地址栏右侧「⋮」菜单",
            detail: "在 Firefox 地址栏旁打开三点浏览器菜单。",
            glyph: "more-vertical",
          },
          {
            title: "选择「安装」或「添加到主屏幕」",
            detail: "点击菜单中的「安装（Install）」或「添加到主屏幕」。",
            glyph: "plus-square",
          },
          {
            title: "点击「添加」确认创建图标",
            detail: "添加后即可从桌面直接独立打开。",
            glyph: "check-confirm",
          },
        ],
        secondaryNote: ANDROID_ROM_SHORTCUT_TIP,
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
            title: `打开${domesticLabel}工具栏菜单（「≡」或「⋮」）`,
            detail: "在屏幕底部中间/右侧或右上角点击浏览器菜单按钮。",
            glyph: "hamburger-menu",
          },
          {
            title: "选择「添加到桌面 / 添加至主屏幕」",
            detail: "部分浏览器位于「工具箱」或「收藏/书签」选项旁，选择「手机桌面 / 主屏幕」。",
            glyph: "plus-square",
          },
          {
            title: "确认添加并检查桌面快捷方式权限",
            detail: "点击确认后返回手机桌面即可看到 OpenHuddle 图标。",
            glyph: "check-confirm",
          },
        ],
        secondaryNote: ANDROID_ROM_SHORTCUT_TIP,
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
          title: "点击右上角「⋮」浏览器菜单",
          detail: `在 ${chromiumLabel} 地址栏右侧打开更多菜单。`,
          glyph: "more-vertical",
        },
        {
          title: "选择「添加到主屏幕」或「安装应用」",
          detail: "在菜单列表中点击「安装应用」或「添加到主屏幕」。",
          glyph: "plus-square",
        },
        {
          title: "在确认框中点击「安装 / 添加」",
          detail: "完成后即可从手机桌面以独立 App 窗口秒开 OpenHuddle。",
          glyph: "check-confirm",
        },
      ],
      secondaryNote: ANDROID_ROM_SHORTCUT_TIP,
    };
  }

  // Desktop 兜底（仅当用户从命令面板等主动打开说明时呈现，不在桌面端弹手机横幅）
  return {
    os: "desktop",
    mode: "desktop-browser",
    browserLabel: "桌面浏览器",
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
        title: "在手机浏览器中打开当前地址，或使用桌面浏览器地址栏右侧安装图标",
        detail: "支持 iOS Safari「分享 → 添加到主屏幕」与 Android 浏览器一键安装到桌面。",
        glyph: "plus-square",
      },
    ],
    secondaryNote: null,
  };
}
