/**
 * @module web/features/pwa-install/i18n/zh-CN
 * @description PWA「添加到手机主屏幕」跨平台特征识别与分步图文指引简体中文词典。
 */
export const pwaInstallZhCN = {
  // Banner & Modal UI
  "banner.aria": "添加到手机主屏幕提示",
  "banner.title": "添加到手机主屏幕",
  "banner.subtitleInApp": "从{host}用浏览器打开并固定桌面",
  "banner.subtitleDefault": "像原生 App 一样全屏秒开",
  "banner.ctaInstall": "立即添加",
  "banner.ctaGuide": "添加",
  "banner.dismissAria": "暂时关闭主屏幕提示",
  "toast.installed": "已添加到手机主屏幕",
  "toast.urlCopied": "已复制网址，请粘贴到系统浏览器打开",
  "toast.urlCopyFailed": "复制失败，请点击右上角菜单在浏览器打开",
  "toast.markedInstalled": "已记录，后续不再提示添加",
  "modal.title": "添加到手机主屏幕",
  "modal.subtitle": "已识别当前环境：{browser}",
  "modal.alreadyAdded": "我已添加，不再提示",
  "modal.done": "知道了",
  "modal.previewDesc": "独立全屏窗口运行，隐藏浏览器地址栏，从桌面一键直达群聊与工作台。",
  "modal.nativeInstallCta": "立即添加到主屏幕",
  "modal.copyUrlHeading": "备选方式：复制网址到浏览器",
  "modal.copied": "已复制",
  "modal.copyUrl": "复制网址",
  "modal.notePrefixPermission": "权限提示：",
  "modal.notePrefixTip": "提示：",

  // Platform Detect — Host & Browser Names
  "host.wecom": "企业微信",
  "host.wechat": "微信",
  "host.feishu": "飞书",
  "host.dingtalk": "钉钉",
  "host.alipay": "支付宝",
  "host.weibo": "微博",
  "browser.quark": "夸克浏览器",
  "browser.uc": "UC 浏览器",
  "browser.qq": "QQ 浏览器",
  "browser.baiduApp": "百度 App",
  "browser.miui": "小米浏览器",
  "browser.huawei": "华为浏览器",
  "browser.oppo": "OPPO 浏览器",
  "browser.vivo": "vivo 浏览器",
  "browser.baidu": "百度浏览器",
  "browser.sogou": "搜狗浏览器",
  "browser.meizu": "魅族浏览器",
  "browser.standalone": "独立应用模式",
  "browser.inAppFormat": "{host}内置浏览器",
  "browser.desktop": "桌面浏览器",

  // Platform Detect — Secondary Notes
  "note.androidRomShortcut":
    "若点击添加后手机桌面未出现图标，请前往系统「设置 → 应用管理/权限 → 桌面快捷方式」，开启当前浏览器的「创建桌面快捷方式」权限（澎湃 OS / 鸿蒙 / ColorOS / OriginOS 常见默认拦截）。",
  "note.iosThirdPartyFallback":
    "若当前版本的 {browser} 菜单中未显示「添加到主屏幕」，可复制当前网址并在系统自带 Safari 浏览器中打开。",

  // Platform Detect — Steps: In-App WebView
  "step.inApp.menu.title": "点击右上角「···」菜单",
  "step.inApp.menu.detail": "在{host}顶栏右侧打开更多操作菜单。",
  "step.inApp.iosOpen.title": "选择「在默认浏览器 / Safari 中打开」",
  "step.inApp.iosOpen.detail": "{host}内置窗口不支持直接创建主屏幕图标，需先跳转系统浏览器。",
  "step.inApp.iosAdd.title": "点击「分享」→「添加到主屏幕」",
  "step.inApp.iosAdd.detail": "在 Safari 打开后，点击工具栏分享按钮并选择「添加到主屏幕」即可。",
  "step.inApp.androidOpen.title": "选择「在浏览器打开」",
  "step.inApp.androidOpen.detail":
    "{host}内置窗口不支持直接安装桌面图标，请先用手机系统浏览器打开。",
  "step.inApp.androidAdd.title": "点击「安装应用 / 添加到主屏幕」",
  "step.inApp.androidAdd.detail":
    "在系统浏览器中打开后，即可一键安装或通过浏览器菜单添加到手机桌面。",

  // Platform Detect — Steps: iOS Third-Party
  "step.iosThirdParty.share.title": "点击地址栏右侧「分享」图标",
  "step.iosThirdParty.share.detail": "在 {browser} 顶部（或底部）地址栏旁找到向上箭头的分享按钮。",
  "step.iosThirdParty.addToHome.title": "向下滑动，点击「添加到主屏幕」",
  "step.iosThirdParty.addToHome.detail": "在系统分享菜单列表中找到带加号的「添加到主屏幕」选项。",
  "step.iosThirdParty.confirm.title": "点击右上角「添加」完成",
  "step.iosThirdParty.confirm.detail": "返回主屏幕即可点击 OpenHuddle 图标以独立全屏模式启动。",

  // Platform Detect — Steps: iOS / iPadOS Safari
  "step.ipadosSafari.share.title": "点击顶部地址栏右侧「分享」按钮",
  "step.ipadosSafari.share.detail": "在 Safari 顶栏右侧找到带向上箭头的方形分享图标。",
  "step.iosSafari.share.title": "点击底部工具栏「分享」按钮",
  "step.iosSafari.share.detail":
    "在 Safari 屏幕底部（若开启顶部地址栏则在上方）点击带向上箭头的方形分享图标。",
  "step.safari.addToHome.title": "下滑菜单，点击「添加到主屏幕」",
  "step.safari.addToHome.detail": "在弹出的面板中向下滑动，找到「添加到主屏幕」并轻触。",
  "step.safari.confirm.title": "点击右上角「添加」",
  "step.safari.confirm.detail": "添加后从主屏幕图标进入，即可隐藏浏览器地址栏获得原生全屏体验。",

  // Platform Detect — Steps: Android Native Prompt
  "step.androidNative.tap.title": "点击下方「立即添加到主屏幕」",
  "step.androidNative.tap.detail": "直接唤起系统原生安装确认框，无需手动查找菜单。",
  "step.androidNative.confirm.title": "在系统弹窗中点击「安装 / 添加」",
  "step.androidNative.confirm.detail": "安装完成后即可在手机桌面与最近任务中独立全屏运行。",

  // Platform Detect — Steps: Android Samsung Internet
  "step.samsung.menu.title": "点击底部工具栏右下角「≡」菜单",
  "step.samsung.menu.detail": "打开三星浏览器底部功能面板。",
  "step.samsung.addPage.title": "点击「将页面添加至」→「主屏幕」",
  "step.samsung.addPage.detail": "在添加目标中选择手机「主屏幕」。",
  "step.samsung.confirm.title": "确认「添加」完成",
  "step.samsung.confirm.detail": "从手机桌面点击图标即可全屏启动 OpenHuddle。",

  // Platform Detect — Steps: Android Firefox
  "step.firefox.menu.title": "点击地址栏右侧「⋮」菜单",
  "step.firefox.menu.detail": "在 Firefox 地址栏旁打开三点浏览器菜单。",
  "step.firefox.install.title": "选择「安装」或「添加到主屏幕」",
  "step.firefox.install.detail": "点击菜单中的「安装（Install）」或「添加到主屏幕」。",
  "step.firefox.confirm.title": "点击「添加」确认创建图标",
  "step.firefox.confirm.detail": "添加后即可从桌面直接独立打开。",

  // Platform Detect — Steps: Android Domestic Browsers
  "step.domestic.menu.title": "打开{browser}工具栏菜单（「≡」或「⋮」）",
  "step.domestic.menu.detail": "在屏幕底部中间/右侧或右上角点击浏览器菜单按钮。",
  "step.domestic.add.title": "选择「添加到桌面 / 添加至主屏幕」",
  "step.domestic.add.detail":
    "部分浏览器位于「工具箱」或「收藏/书签」选项旁，选择「手机桌面 / 主屏幕」。",
  "step.domestic.confirm.title": "确认添加并检查桌面快捷方式权限",
  "step.domestic.confirm.detail": "点击确认后返回手机桌面即可看到 OpenHuddle 图标。",

  // Platform Detect — Steps: Android Chromium Manual
  "step.chromium.menu.title": "点击右上角「⋮」浏览器菜单",
  "step.chromium.menu.detail": "在 {browser} 地址栏右侧打开更多菜单。",
  "step.chromium.install.title": "选择「添加到主屏幕」或「安装应用」",
  "step.chromium.install.detail": "在菜单列表中点击「安装应用」或「添加到主屏幕」。",
  "step.chromium.confirm.title": "在确认框中点击「安装 / 添加」",
  "step.chromium.confirm.detail": "完成后即可从手机桌面以独立 App 窗口秒开 OpenHuddle。",

  // Platform Detect — Steps: Desktop Fallback
  "step.desktop.title": "在手机浏览器中打开当前地址，或使用桌面浏览器地址栏右侧安装图标",
  "step.desktop.detail": "支持 iOS Safari「分享 → 添加到主屏幕」与 Android 浏览器一键安装到桌面。",
} as const;
