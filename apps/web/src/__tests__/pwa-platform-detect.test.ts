/**
 * @module web/__tests__/pwa-platform-detect
 * @description 验证跨操作系统、多浏览器与超级 App 内置 WebView 的「添加到手机主屏幕」策略识别矩阵及安装后静默守卫。
 */
import { describe, expect, it } from "vitest";
import { detectPwaPlatformProfile } from "../features/pwa-install/pwa-platform-detect.js";

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
    const profile = detectPwaPlatformProfile(input);
    expect(profile.mode).toBe("standalone-installed");
    expect(profile.isStandalone).toBe(true);
    expect(profile.showSmartBannerByDefault).toBe(false);
    expect(profile.showEntryInMenu).toBe(false);
    expect(profile.steps).toHaveLength(0);
  });

  it("distinguishes iPhone Safari from iPadOS Safari (including iPadOS 13+ desktop MacIntel UA)", () => {
    const iphoneSafari = detectPwaPlatformProfile({
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Mobile/15E148 Safari/604.1",
      platform: "iPhone",
      maxTouchPoints: 5,
    });
    expect(iphoneSafari.os).toBe("ios");
    expect(iphoneSafari.mode).toBe("ios-safari");
    expect(iphoneSafari.steps[0]?.title).toContain("底部工具栏");
    expect(iphoneSafari.needsAndroidRomShortcutTip).toBe(false);

    const ipadDesktopUa = detectPwaPlatformProfile({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15",
      platform: "MacIntel",
      maxTouchPoints: 5,
    });
    expect(ipadDesktopUa.os).toBe("ipados");
    expect(ipadDesktopUa.mode).toBe("ipados-safari");
    expect(ipadDesktopUa.steps[0]?.title).toContain("顶部地址栏");
  });

  it("detects iOS third-party browsers (Chrome CriOS / Edge EdgiOS / Firefox FxiOS)", () => {
    const iosChrome = detectPwaPlatformProfile({
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.6778.73 Mobile/15E148 Safari/604.1",
    });
    expect(iosChrome.mode).toBe("ios-third-party");
    expect(iosChrome.browserLabel).toBe("iOS Chrome");
    expect(iosChrome.secondaryNote).toContain("Safari");
  });

  it.each([
    {
      name: "iOS 微信 WebView",
      ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.54(0x1800362a) NetType/WIFI",
      expectedMode: "ios-in-app-webview",
      expectedHost: "wechat",
      expectedRomTip: false,
    },
    {
      name: "Android 微信 XWEB",
      ua: "Mozilla/5.0 (Linux; Android 14; PKG110 Build/UKQ1) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.6478.188 Mobile Safari/537.36 XWEB/1260117 MMWEBSDK/20240802 MicroMessenger/8.0.53.2740",
      expectedMode: "android-in-app-webview",
      expectedHost: "wechat",
      expectedRomTip: true,
    },
    {
      name: "Android 企业微信",
      ua: "Mozilla/5.0 (Linux; Android 14; ALN-AL00) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/116.0.0.0 Mobile Safari/537.36 wxwork/4.1.32 MicroMessenger/7.0.1",
      expectedMode: "android-in-app-webview",
      expectedHost: "wecom",
      expectedRomTip: true,
    },
    {
      name: "iOS 飞书",
      ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Lark/7.30.0 Feishu/7.30.0",
      expectedMode: "ios-in-app-webview",
      expectedHost: "feishu",
      expectedRomTip: false,
    },
    {
      name: "Android 钉钉",
      ua: "Mozilla/5.0 (Linux; Android 14; Vivo V2309A) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Mobile Safari/537.36 AliApp(DingTalk/7.6.15)",
      expectedMode: "android-in-app-webview",
      expectedHost: "dingtalk",
      expectedRomTip: true,
    },
  ])(
    "identifies $name and separates iOS vs Android jump instructions",
    ({ ua, expectedMode, expectedHost, expectedRomTip }) => {
      const profile = detectPwaPlatformProfile({ userAgent: ua });
      expect(profile.mode).toBe(expectedMode);
      expect(profile.inAppHost).toBe(expectedHost);
      expect(profile.needsAndroidRomShortcutTip).toBe(expectedRomTip);
      if (expectedMode === "android-in-app-webview") {
        expect(profile.steps[1]?.title).not.toContain("Safari");
      } else {
        expect(profile.steps[1]?.title).toContain("Safari");
      }
    },
  );

  it("supports Android native beforeinstallprompt and falls back cleanly across Samsung, Firefox, and domestic browsers", () => {
    const androidNative = detectPwaPlatformProfile({
      userAgent:
        "Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
      hasBeforeInstallPrompt: true,
    });
    expect(androidNative.mode).toBe("android-native-prompt");
    expect(androidNative.canTriggerNativePrompt).toBe(true);
    expect(androidNative.needsAndroidRomShortcutTip).toBe(true);

    const samsungManual = detectPwaPlatformProfile({
      userAgent:
        "Mozilla/5.0 (Linux; Android 14; SM-S9280) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36",
    });
    expect(samsungManual.mode).toBe("android-samsung");
    expect(samsungManual.steps[0]?.glyph).toBe("hamburger-menu");

    const firefoxAndroid = detectPwaPlatformProfile({
      userAgent: "Mozilla/5.0 (Android 14; Mobile; rv:132.0) Gecko/132.0 Firefox/132.0",
    });
    expect(firefoxAndroid.mode).toBe("android-firefox");

    const quarkAndroid = detectPwaPlatformProfile({
      userAgent:
        "Mozilla/5.0 (Linux; U; Android 14; zh-CN; 23116PN5BC) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/100.0.4896.58 Quark/7.4.5.650 Mobile Safari/537.36",
    });
    expect(quarkAndroid.mode).toBe("android-domestic");
    expect(quarkAndroid.browserLabel).toContain("夸克浏览器");
    expect(quarkAndroid.needsAndroidRomShortcutTip).toBe(true);
    expect(quarkAndroid.secondaryNote).toContain("创建桌面快捷方式");
  });

  it("does not show mobile smart banner on desktop browsers (macOS / Windows)", () => {
    const macDesktop = detectPwaPlatformProfile({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      platform: "MacIntel",
      maxTouchPoints: 0,
    });
    expect(macDesktop.os).toBe("desktop");
    expect(macDesktop.mode).toBe("desktop-browser");
    expect(macDesktop.isMobileOrTablet).toBe(false);
    expect(macDesktop.showSmartBannerByDefault).toBe(false);
  });
});
