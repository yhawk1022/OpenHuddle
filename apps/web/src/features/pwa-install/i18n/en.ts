/**
 * @module web/features/pwa-install/i18n/en
 * @description English catalog for PWA Add-to-Home-Screen platform detection and installation guides.
 */
export const pwaInstallEn = {
  // Banner & Modal UI
  "banner.aria": "Add to Home Screen prompt",
  "banner.title": "Add to Home Screen",
  "banner.subtitleInApp": "Open from {host} in your browser to pin",
  "banner.subtitleDefault": "Launch full-screen like a native app",
  "banner.ctaInstall": "Install",
  "banner.ctaGuide": "Guide",
  "banner.dismissAria": "Dismiss Home Screen prompt",
  "toast.installed": "Added to Home Screen",
  "toast.urlCopied": "URL copied. Paste it into your system browser.",
  "toast.urlCopyFailed": "Failed to copy. Use the top-right menu to open in browser.",
  "toast.markedInstalled": "Got it — we won't show this prompt again",
  "modal.title": "Add to Home Screen",
  "modal.subtitle": "Detected environment: {browser}",
  "modal.alreadyAdded": "Already added",
  "modal.done": "Done",
  "modal.previewDesc":
    "Runs full-screen without the browser address bar for one-tap access from your Home Screen.",
  "modal.nativeInstallCta": "Add to Home Screen",
  "modal.copyUrlHeading": "Or copy the URL into your browser",
  "modal.copied": "Copied",
  "modal.copyUrl": "Copy URL",
  "modal.notePrefixPermission": "Permission tip: ",
  "modal.notePrefixTip": "Tip: ",

  // Platform Detect — Host & Browser Names
  "host.wecom": "WeCom",
  "host.wechat": "WeChat",
  "host.feishu": "Feishu",
  "host.dingtalk": "DingTalk",
  "host.alipay": "Alipay",
  "host.weibo": "Weibo",
  "browser.quark": "Quark Browser",
  "browser.uc": "UC Browser",
  "browser.qq": "QQ Browser",
  "browser.baiduApp": "Baidu App",
  "browser.miui": "Mi Browser",
  "browser.huawei": "Huawei Browser",
  "browser.oppo": "OPPO Browser",
  "browser.vivo": "vivo Browser",
  "browser.baidu": "Baidu Browser",
  "browser.sogou": "Sogou Browser",
  "browser.meizu": "Meizu Browser",
  "browser.standalone": "Standalone App",
  "browser.inAppFormat": "{host} in-app browser",
  "browser.desktop": "Desktop Browser",

  // Platform Detect — Secondary Notes
  "note.androidRomShortcut":
    "If no icon appears on your Home Screen after adding, open Settings → Apps / Permissions → Home screen shortcuts and allow this browser to create shortcuts (often blocked by default on HyperOS, HarmonyOS, ColorOS, and OriginOS).",
  "note.iosThirdPartyFallback":
    'If "Add to Home Screen" isn\'t shown in this version of {browser}, copy the URL and open it in Safari.',

  // Platform Detect — Steps: In-App WebView
  "step.inApp.menu.title": 'Tap the "···" menu in the top right',
  "step.inApp.menu.detail": "Open the more actions menu at the top right of {host}.",
  "step.inApp.iosOpen.title": 'Select "Open in Default Browser / Safari"',
  "step.inApp.iosOpen.detail":
    "{host}'s in-app browser can't add Home Screen icons directly. Open this page in Safari first.",
  "step.inApp.iosAdd.title": 'Tap "Share" → "Add to Home Screen"',
  "step.inApp.iosAdd.detail":
    'Once opened in Safari, tap the Share button in the toolbar and choose "Add to Home Screen".',
  "step.inApp.androidOpen.title": 'Select "Open in Browser"',
  "step.inApp.androidOpen.detail":
    "{host}'s in-app browser can't install Home Screen icons directly. Open this page in your system browser first.",
  "step.inApp.androidAdd.title": 'Tap "Install app" or "Add to Home Screen"',
  "step.inApp.androidAdd.detail":
    "Once opened in your system browser, install with one tap or add to Home Screen from the browser menu.",

  // Platform Detect — Steps: iOS Third-Party
  "step.iosThirdParty.share.title": 'Tap the "Share" icon next to the address bar',
  "step.iosThirdParty.share.detail":
    "Find the Share icon (square with upward arrow) next to the address bar in {browser}.",
  "step.iosThirdParty.addToHome.title": 'Scroll down and tap "Add to Home Screen"',
  "step.iosThirdParty.addToHome.detail":
    'In the share sheet, select "Add to Home Screen" with the plus icon.',
  "step.iosThirdParty.confirm.title": 'Tap "Add" in the top right',
  "step.iosThirdParty.confirm.detail":
    "Return to your Home Screen and tap the OpenHuddle icon to launch full-screen.",

  // Platform Detect — Steps: iOS / iPadOS Safari
  "step.ipadosSafari.share.title": 'Tap "Share" on the right of the top address bar',
  "step.ipadosSafari.share.detail":
    "Find the Share icon (square with upward arrow) at the top right of Safari.",
  "step.iosSafari.share.title": 'Tap "Share" in the bottom toolbar',
  "step.iosSafari.share.detail":
    "Tap the Share icon (square with upward arrow) at the bottom of Safari (or top if using the top address bar).",
  "step.safari.addToHome.title": 'Scroll down and tap "Add to Home Screen"',
  "step.safari.addToHome.detail": 'Scroll the share sheet and tap "Add to Home Screen".',
  "step.safari.confirm.title": 'Tap "Add" in the top right',
  "step.safari.confirm.detail":
    "Launch OpenHuddle from the Home Screen icon for a full-screen, app-like experience.",

  // Platform Detect — Steps: Android Native Prompt
  "step.androidNative.tap.title": 'Tap "Add to Home Screen" below',
  "step.androidNative.tap.detail":
    "Opens the native system install dialog directly without digging through menus.",
  "step.androidNative.confirm.title": 'Tap "Install" or "Add" in the system dialog',
  "step.androidNative.confirm.detail":
    "Once installed, OpenHuddle runs full-screen from your Home Screen and recent apps.",

  // Platform Detect — Steps: Android Samsung Internet
  "step.samsung.menu.title": 'Tap the "≡" menu at the bottom right',
  "step.samsung.menu.detail": "Open the Samsung Internet bottom menu.",
  "step.samsung.addPage.title": 'Tap "Add page to" → "Home screen"',
  "step.samsung.addPage.detail": 'Choose "Home screen" as the destination.',
  "step.samsung.confirm.title": 'Tap "Add" to confirm',
  "step.samsung.confirm.detail":
    "Tap the icon on your Home Screen to launch OpenHuddle full-screen.",

  // Platform Detect — Steps: Android Firefox
  "step.firefox.menu.title": 'Tap the "⋮" menu next to the address bar',
  "step.firefox.menu.detail": "Open the three-dot menu beside the Firefox address bar.",
  "step.firefox.install.title": 'Select "Install" or "Add to Home screen"',
  "step.firefox.install.detail": 'Tap "Install" or "Add to Home screen" from the menu.',
  "step.firefox.confirm.title": 'Tap "Add" to confirm',
  "step.firefox.confirm.detail": "Once added, launch OpenHuddle directly from your Home Screen.",

  // Platform Detect — Steps: Android Domestic Browsers
  "step.domestic.menu.title": 'Open the {browser} menu ("≡" or "⋮")',
  "step.domestic.menu.detail": "Tap the menu button at the bottom or top right of the browser.",
  "step.domestic.add.title": 'Select "Add to Home screen"',
  "step.domestic.add.detail":
    "In some browsers this is under Toolbox or Bookmarks — choose Home screen.",
  "step.domestic.confirm.title": "Confirm and check shortcut permission",
  "step.domestic.confirm.detail": "Confirm to place the OpenHuddle icon on your Home Screen.",

  // Platform Detect — Steps: Android Chromium Manual
  "step.chromium.menu.title": 'Tap the "⋮" menu in the top right',
  "step.chromium.menu.detail": "Open the menu next to the {browser} address bar.",
  "step.chromium.install.title": 'Select "Add to Home screen" or "Install app"',
  "step.chromium.install.detail": 'Tap "Install app" or "Add to Home screen" in the menu.',
  "step.chromium.confirm.title": 'Tap "Install" or "Add" to confirm',
  "step.chromium.confirm.detail":
    "Once added, launch OpenHuddle full-screen from your Home Screen.",

  // Platform Detect — Steps: Desktop Fallback
  "step.desktop.title":
    "Open this URL on your phone, or click the install icon in your desktop address bar",
  "step.desktop.detail":
    "Supports iOS Safari (Share → Add to Home Screen) and one-tap install on Android browsers.",
} as const;
