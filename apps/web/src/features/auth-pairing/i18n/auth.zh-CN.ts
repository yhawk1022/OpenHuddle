/**
 * @module web/features/auth-pairing/i18n/auth.zh-CN
 * @description 首页门户顶栏、认证表单（登录/注册/重置密码）、密码强度、错误提示与已登录空间卡简体中文词典。
 */
export const authZhCN = {
  // 顶栏导览与动作
  "header.scrollToTopAria": "回到 OpenHuddle 页面顶部",
  "header.navAria": "门户分区导览",
  "header.nav.capabilities": "核心能力",
  "header.nav.architecture": "性能与多端",
  "header.nav.openSource": "开源与联系",
  "header.installPwaDesktop": "添加到主屏幕",
  "header.installPwaShort": "主屏幕",
  "header.installPwaAria": "添加到主屏幕",
  "header.backToApp": "返回工作台",
  "header.signInCta": "去登录",
  "header.switchToLight": "切换为白天模式",
  "header.switchToDark": "切换为夜间模式",

  // 首屏主副标题
  "hero.title": "和你的多路 Agent 一起讨论、改码、拍板。",
  "hero.subtitle":
    "一键连通 Claude Code、Codex、Cursor 等个人 Agent：受控群聊里交叉求证，隔离工作台里并行改码。",

  // 已登录空间卡（/welcome）
  "spaceCard.signedInBadge": "已登录",
  "spaceCard.boundAgentsLabel": "已绑定个人 Agent",
  "spaceCard.agentsSummary": "{total} 个已接入 · {online} 个在线",
  "spaceCard.agentsEmptyCount": "暂未接入 Agent",
  "spaceCard.agentsEmptyHint":
    "进入工作台后点击左侧导轨「接入 agent」，即可连通 Claude Code、Codex 或任意 MCP 客户端。",
  "spaceCard.openChats": "进入聊天会话",
  "spaceCard.openWorkbench": "打开个人工作台",

  // 认证分段与公共控件
  "tabs.login": "登录",
  "tabs.register": "注册账号",
  "tabs.ariaLabel": "选择登录或注册",
  "field.email": "邮箱地址",
  "field.registeredEmail": "注册邮箱",
  "field.password": "登录密码",
  "field.setPassword": "设置密码",
  "field.newPassword": "新密码",
  "field.confirmPassword": "确认密码",
  "field.confirmNewPassword": "确认新密码",
  "field.emailCode": "6 位邮箱验证码",
  "field.displayName": "你的名字",
  "field.passwordPlaceholder": "请输入登录密码",
  "field.minLengthPlaceholder": "至少 {min} 位字符",
  "field.confirmPasswordPlaceholder": "再次输入密码",
  "field.confirmNewPasswordPlaceholder": "再次输入新密码",
  "field.displayNamePlaceholder": "例如：庞彦 / Alex",
  "field.showPassword": "显示密码",
  "field.hidePassword": "隐藏密码",
  "field.showConfirmPassword": "显示确认密码",
  "field.hideConfirmPassword": "隐藏确认密码",

  // 密码强度
  "strength.tooShort": "至少 {min} 位",
  "strength.strong": "强度：强",
  "strength.medium": "强度：中",
  "strength.weak": "强度：弱（建议混合字母与数字）",

  // 发码按钮
  "code.send": "发送验证码",
  "code.resend": "重新发送",
  "code.resendCountdown": "{sec}s 后重发",
  "code.spamHint": "如果收不到验证码，请检查邮箱的垃圾邮件文件夹。",
  "code.devRegisterLabel": "开发模式验证码",
  "code.devResetLabel": "开发模式重置码",
  "code.devAutofill": "一键填入",
  "code.resetSentNotice": "如果该邮箱已注册，6 位重置验证码已发往你的收件箱。",

  // 登录视图
  "login.title": "欢迎回来",
  "login.subtitle": "使用你的注册邮箱与密码登录 OpenHuddle 协作空间。",
  "login.signupDisabledBanner": "当前实例已关闭自助注册，仅限已有账号登录。",
  "login.forgotPassword": "忘记密码？",
  "login.submit": "登录",
  "login.submitting": "正在登录...",
  "login.footerBadge": "开源 · 可私有化部署",
  "login.noAccountCta": "还没有账号？去注册",

  // 注册视图
  "register.title": "创建你的账号",
  "register.subtitle": "先验证邮箱收到的 6 位激活码，再设置登录密码即可开启协作。",
  "register.allowedDomains": "仅允许使用 {domains} 邮箱注册",
  "register.domainSeparator": "、",
  "register.smtpUnavailable":
    "当前服务器尚未配置 SMTP 发信服务，暂无法下发注册验证邮件，请联系管理员。",
  "register.switchToLoginCta": "直接用该邮箱登录",
  "register.submit": "完成注册并进入",
  "register.submitting": "正在创建账号...",

  // 重置密码视图
  "reset.backToLogin": "返回登录",
  "reset.title": "重置登录密码",
  "reset.subtitle": "通过邮箱接收 6 位验证码重设密码；早期无密码老用户也可在此直接设置登录密码。",
  "reset.smtpUnavailable": "当前服务器尚未配置 SMTP 发信服务，暂无法发送重置邮件。",
  "reset.submit": "重置密码并登录",
  "reset.submitting": "正在更新密码...",

  // 客户端表单校验提示
  "validation.loginRequired": "请输入有效的邮箱地址和登录密码。",
  "validation.emailFirst": "请先输入格式正确的邮箱地址。",
  "validation.registeredEmailFirst": "请先输入你的注册邮箱地址。",
  "validation.invalidEmail": "请输入有效的邮箱地址。",
  "validation.registerCodeRequired": "请输入邮件中收到的 6 位数字验证码。",
  "validation.resetCodeRequired": "请输入 6 位数字重置验证码。",
  "validation.displayNameRequired": "请输入你的展示昵称。",
  "validation.passwordTooShort": "登录密码至少需要 {min} 位有效字符。",
  "validation.newPasswordTooShort": "新密码至少需要 {min} 位有效字符。",
  "validation.passwordMismatch": "两次输入的密码不一致，请重新核对。",
  "validation.newPasswordMismatch": "两次输入的新密码不一致，请重新核对。",
  "validation.passwordSameAsEmail": "为保障账号安全，密码不能与邮箱地址相同。",
  "validation.newPasswordSameAsEmail": "新密码不能与邮箱地址相同。",

  // 服务端认证错误提示
  "error.invalidCredentials":
    "邮箱或密码不正确。如果你是早期无密码老用户，请点击「忘记密码」设置登录密码。",
  "error.emailAlreadyRegistered": "该邮箱已注册 OpenHuddle 账号，请直接登录或使用忘记密码。",
  "error.signupDisabled": "当前实例已关闭自助注册，请联系站点管理员开通账号。",
  "error.emailDomainNotAllowed": "该邮箱域名不在允许注册的白名单范围内，请更换受支持的邮箱。",
  "error.otpInvalidOrExpired": "验证码不正确或已过期，请核对后重试或重新获取。",
  "error.otpAttemptsExceeded": "该验证码连续输错次数过多已作废，请重新点击发送验证码。",
  "error.rateLimitedRetryAfter": "操作过于频繁，请 {sec} 秒后再试。",
  "error.rateLimited": "操作过于频繁，请稍后再试。",
  "error.accountSuspended": "该账号已被管理员停用，无法继续登录。",
  "error.emailDeliveryFailed": "验证邮件发送失败，请检查邮箱地址是否正确或稍后重试。",
  "error.emailDeliveryUnavailable":
    "服务器尚未配置 SMTP 发信服务，暂无法发送邮箱验证码，请联系管理员。",
  "error.internalWithRequestId": "服务器内部处理异常，请稍后重试（请求编号：{requestId}）。",
  "error.internalGeneric": "后端服务暂未就绪或内部异常，请稍后重试。",
  "error.requestFailed": "请求失败，请稍后重试。",

  // Toast 反馈
  "toast.welcomeBack": "欢迎回来，{name}",
  "toast.devRegisterCodeTitle": "开发模式注册验证码已生成",
  "toast.registerCodeSentTitle": "6 位注册验证码已发送",
  "toast.devCodeDesc": "可直接点击一键填入验证码 {code}",
  "toast.registerCodeSentDesc": "请前往 {email} 收件箱查收（10 分钟内有效）",
  "toast.registerSuccess": "注册成功，欢迎加入 OpenHuddle，{name}！",
  "toast.devResetCodeTitle": "开发模式重置验证码已生成",
  "toast.resetCodeSentTitle": "重置邮件请求已受理",
  "toast.resetCodeSentDesc": "如果该邮箱已注册，6 位重置验证码已发送至你的收件箱",
  "toast.resetSuccessTitle": "密码已重置并为你登录",
  "toast.resetSuccessDesc": "该账号在其余设备上的历史会话已全部安全下线",
  "toast.copyFailed": "复制失败，请手动选中复制",
  "toast.siteUrlCopied": "已复制本站链接",
} as const;

export const authPluralZhCN = {
  "error.otpRemainingAttempts": {
    other: "验证码不正确或已过期（本码还可重试 {count} 次）。",
  },
  "code.registerSentNotice": {
    other: "验证码已发往 {email}（{count} 分钟内有效）",
  },
} as const;
