/**
 * @module web/__tests__/pwa-platform-detect
 * @description 验证跨操作系统、多浏览器与超级 App 内置 WebView 的「添加到手机主屏幕」策略识别矩阵及安装后静默守卫。
 */
import { describe, expect, it } from "vitest";
import { detectPwaPlatformProfile } from "../features/pwa-install/pwa-platform-detect.js";
import { withLocale } from "../lib/i18n/index.js";

describe("detectPwaPlatformProfile", () => {
  it.each([
    {
      label: "display-mode: standalone",
      input: {
        userAgent:
          "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
        isStandaloneMedia: true,
      },
    },
    {
      label: "iOS navigator.standalone",
      input: {
        userAgent:
          "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
        navigatorStandalone: true,
      },
    },
    {
      label: "Android TWA referrer",
      input: {
        userAgent:
          "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
        referrer: "android-app://com.android.chrome/",
      },
    },
    {
      label: "manifest start_url ?source=pwa",
      input: {
        userAgent:
          "Mozilla/5.0 (Linux; Android 14; 23127PN0CC) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.0.0 Mobile Safari/537.36 MiuiBrowser/18.6",
        hasSourcePwaParam: true,
      },
    },
    {
      label: "persisted oh_pwa_installed flag",
      input: {
        userAgent:
          "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
        hasPersistedInstalledFlag: true,
      },
    },
  ])("permanently silences prompts when already installed ($label)", ({ input }) => {
    const zhProfile = detectPwaPlatformProfile(input, "zh-CN");
    expect(zhProfile.mode).toBe("standalone-installed");
    expect(zhProfile.browserLabel).toBe("独立应用模式");
    expect(zhProfile.isStandalone).toBe(true);
    expect(zhProfile.showSmartBannerByDefault).toBe(false);
    expect(zhProfile.showEntryInMenu).toBe(false);
    expect(zhProfile.steps).toHaveLength(0);

    const enProfile = detectPwaPlatformProfile(input, "en");
    expect(enProfile.mode).toBe("standalone-installed");
    expect(enProfile.browserLabel).toBe("Standalone App");
    expect(enProfile.steps).toHaveLength(0);
  });

  it("distinguishes iPhone Safari from iPadOS Safari (including iPadOS 13+ desktop MacIntel UA) in zh-CN and en", () => {
    const iphoneInput = {
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Mobile/15E148 Safari/604.1",
      platform: "iPhone",
      maxTouchPoints: 5,
    };
    const ipadInput = {
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15",
      platform: "MacIntel",
      maxTouchPoints: 5,
    };

    withLocale("zh-CN", () => {
      const iphoneSafari = detectPwaPlatformProfile(iphoneInput);
      expect(iphoneSafari.os).toBe("ios");
      expect(iphoneSafari.mode).toBe("ios-safari");
      expect(iphoneSafari.steps[0]?.title).toContain("底部工具栏");
      expect(iphoneSafari.needsAndroidRomShortcutTip).toBe(false);

      const ipadDesktopUa = detectPwaPlatformProfile(ipadInput);
      expect(ipadDesktopUa.os).toBe("ipados");
      expect(ipadDesktopUa.mode).toBe("ipados-safari");
      expect(ipadDesktopUa.steps[0]?.title).toContain("顶部地址栏");
    });

    withLocale("en", () => {
      const iphoneSafari = detectPwaPlatformProfile(iphoneInput);
      expect(iphoneSafari.mode).toBe("ios-safari");
      expect(iphoneSafari.steps[0]?.title).toContain("bottom toolbar");

      const ipadDesktopUa = detectPwaPlatformProfile(ipadInput);
      expect(ipadDesktopUa.mode).toBe("ipados-safari");
      expect(ipadDesktopUa.steps[0]?.title).toContain("top address bar");
    });
  });

  it("detects iOS third-party browsers (Chrome CriOS / Edge EdgiOS / Firefox FxiOS) in zh-CN and en", () => {
    const input = {
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.6778.73 Mobile/15E148 Safari/604.1",
    };

    const iosChromeZh = detectPwaPlatformProfile(input, "zh-CN");
    expect(iosChromeZh.mode).toBe("ios-third-party");
    expect(iosChromeZh.browserLabel).toBe("iOS Chrome");
    expect(iosChromeZh.secondaryNote).toContain("Safari");
    expect(iosChromeZh.secondaryNote).toContain("添加到主屏幕");

    const iosChromeEn = detectPwaPlatformProfile(input, "en");
    expect(iosChromeEn.mode).toBe("ios-third-party");
    expect(iosChromeEn.browserLabel).toBe("iOS Chrome");
    expect(iosChromeEn.secondaryNote).toContain("Safari");
    expect(iosChromeEn.secondaryNote).toContain("Add to Home Screen");
  });

  it.each([
    {
      name: "iOS 微信 WebView",
      ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.54(0x1800362a) NetType/WIFI",
      expectedMode: "ios-in-app-webview",
      expectedHost: "wechat",
      expectedZhHostLabel: "微信",
      expectedEnHostLabel: "WeChat",
      expectedRomTip: false,
    },
    {
      name: "Android 微信 XWEB",
      ua: "Mozilla/5.0 (Linux; Android 14; PKG110 Build/UKQ1) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.6478.188 Mobile Safari/537.36 XWEB/1260117 MMWEBSDK/20240802 MicroMessenger/8.0.53.2740",
      expectedMode: "android-in-app-webview",
      expectedHost: "wechat",
      expectedZhHostLabel: "微信",
      expectedEnHostLabel: "WeChat",
      expectedRomTip: true,
    },
    {
      name: "Android 企业微信",
      ua: "Mozilla/5.0 (Linux; Android 14; ALN-AL00) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/116.0.0.0 Mobile Safari/537.36 wxwork/4.1.32 MicroMessenger/7.0.1",
      expectedMode: "android-in-app-webview",
      expectedHost: "wecom",
      expectedZhHostLabel: "企业微信",
      expectedEnHostLabel: "WeCom",
      expectedRomTip: true,
    },
    {
      name: "iOS 飞书",
      ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Lark/7.30.0 Feishu/7.30.0",
      expectedMode: "ios-in-app-webview",
      expectedHost: "feishu",
      expectedZhHostLabel: "飞书",
      expectedEnHostLabel: "Feishu",
      expectedRomTip: false,
    },
    {
      name: "Android 钉钉",
      ua: "Mozilla/5.0 (Linux; Android 14; Vivo V2309A) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Mobile Safari/537.36 AliApp(DingTalk/7.6.15)",
      expectedMode: "android-in-app-webview",
      expectedHost: "dingtalk",
      expectedZhHostLabel: "钉钉",
      expectedEnHostLabel: "DingTalk",
      expectedRomTip: true,
    },
  ])(
    "identifies $name and separates iOS vs Android jump instructions in zh-CN and en",
    ({
      ua,
      expectedMode,
      expectedHost,
      expectedZhHostLabel,
      expectedEnHostLabel,
      expectedRomTip,
    }) => {
      const zhProfile = detectPwaPlatformProfile({ userAgent: ua }, "zh-CN");
      expect(zhProfile.mode).toBe(expectedMode);
      expect(zhProfile.inAppHost).toBe(expectedHost);
      expect(zhProfile.inAppHostLabel).toBe(expectedZhHostLabel);
      expect(zhProfile.needsAndroidRomShortcutTip).toBe(expectedRomTip);
      if (expectedMode === "android-in-app-webview") {
        expect(zhProfile.steps[1]?.title).not.toContain("Safari");
      } else {
        expect(zhProfile.steps[1]?.title).toContain("Safari");
      }

      const enProfile = detectPwaPlatformProfile({ userAgent: ua }, "en");
      expect(enProfile.mode).toBe(expectedMode);
      expect(enProfile.inAppHost).toBe(expectedHost);
      expect(enProfile.inAppHostLabel).toBe(expectedEnHostLabel);
      expect(enProfile.browserLabel).toBe(`${expectedEnHostLabel} in-app browser`);
      if (expectedMode === "android-in-app-webview") {
        expect(enProfile.steps[1]?.title).toContain("Open in Browser");
        expect(enProfile.steps[1]?.title).not.toContain("Safari");
      } else {
        expect(enProfile.steps[1]?.title).toContain("Safari");
      }
    },
  );

  it("supports Android native beforeinstallprompt and falls back cleanly across Samsung, Firefox, and domestic browsers in zh-CN and en", () => {
    const androidNative = detectPwaPlatformProfile(
      {
        userAgent:
          "Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
        hasBeforeInstallPrompt: true,
      },
      "en",
    );
    expect(androidNative.mode).toBe("android-native-prompt");
    expect(androidNative.canTriggerNativePrompt).toBe(true);
    expect(androidNative.needsAndroidRomShortcutTip).toBe(true);
    expect(androidNative.steps[0]?.title).toContain("Add to Home Screen");

    const samsungManual = detectPwaPlatformProfile(
      {
        userAgent:
          "Mozilla/5.0 (Linux; Android 14; SM-S9280) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36",
      },
      "en",
    );
    expect(samsungManual.mode).toBe("android-samsung");
    expect(samsungManual.steps[0]?.glyph).toBe("hamburger-menu");
    expect(samsungManual.steps[1]?.title).toContain("Home screen");

    const firefoxAndroid = detectPwaPlatformProfile(
      {
        userAgent: "Mozilla/5.0 (Android 14; Mobile; rv:132.0) Gecko/132.0 Firefox/132.0",
      },
      "en",
    );
    expect(firefoxAndroid.mode).toBe("android-firefox");
    expect(firefoxAndroid.steps[1]?.title).toContain("Install");

    const quarkInput = {
      userAgent:
        "Mozilla/5.0 (Linux; U; Android 14; zh-CN; 23116PN5BC) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/100.0.4896.58 Quark/7.4.5.650 Mobile Safari/537.36",
    };
    const quarkZh = detectPwaPlatformProfile(quarkInput, "zh-CN");
    expect(quarkZh.mode).toBe("android-domestic");
    expect(quarkZh.browserLabel).toContain("夸克浏览器");
    expect(quarkZh.needsAndroidRomShortcutTip).toBe(true);
    expect(quarkZh.secondaryNote).toContain("创建桌面快捷方式");

    const quarkEn = detectPwaPlatformProfile(quarkInput, "en");
    expect(quarkEn.mode).toBe("android-domestic");
    expect(quarkEn.browserLabel).toBe("Quark Browser");
    expect(quarkEn.secondaryNote).toContain("Home screen shortcuts");
  });

  it("does not show mobile smart banner on desktop browsers (macOS / Windows) in zh-CN and en", () => {
    const input = {
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      platform: "MacIntel",
      maxTouchPoints: 0,
    };

    const macDesktopZh = detectPwaPlatformProfile(input, "zh-CN");
    expect(macDesktopZh.os).toBe("desktop");
    expect(macDesktopZh.mode).toBe("desktop-browser");
    expect(macDesktopZh.browserLabel).toBe("桌面浏览器");
    expect(macDesktopZh.isMobileOrTablet).toBe(false);
    expect(macDesktopZh.showSmartBannerByDefault).toBe(false);

    const macDesktopEn = detectPwaPlatformProfile(input, "en");
    expect(macDesktopEn.browserLabel).toBe("Desktop Browser");
    expect(macDesktopEn.steps[0]?.detail).toContain("Add to Home Screen");
  });
});
