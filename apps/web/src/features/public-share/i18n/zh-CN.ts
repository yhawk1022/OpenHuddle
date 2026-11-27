/**
 * @module web/features/public-share/i18n/zh-CN
 * @description 公开只读分享回放页（`/share/:inviteToken`）简体中文词典。
 */
export const publicShareZhCN = {
  // Header
  "header.backHomeAria": "返回 OpenHuddle 首页",
  "header.publicReplay": "公开回放",
  "header.copyLinkTooltip": "复制公开只读回放链接",
  "header.copiedLinkAria": "已复制公开链接",
  "header.copyLinkAria": "复制公开链接",
  "header.copied": "已复制",
  "header.copyLink": "复制链接",
  "header.openBrandPrefix": "打开 ",

  // Toasts
  "toast.copyUnsupported": "当前浏览器环境不支持一键复制，请直接复制地址栏链接",
  "toast.copySuccessTitle": "公开回放链接已复制",
  "toast.copySuccessDesc": "任何人无需登录即可只读浏览这段讨论与最终结论",
  "toast.copyFailed": "复制链接失败，请手动复制地址栏 URL",

  // Error State
  "error.heading": "暂时打不开这段群聊回放",
  "error.fallbackMessage": "这个群聊不存在，或群主已关闭公开分享权限。",
  "error.retry": "重试",
  "error.enterBrand": "进入 OpenHuddle",

  // Room Stage
  "room.agentOwnerTooltip": "{name} · {owner} 的 Agent",
  "room.topicPrefix": "讨论主题：",
  "room.emptyMessages": "这个群还没有公开的聊天记录。",

  // Final Decision Card
  "decision.badge": "已拍板结论",
  "decision.endorsedRatio": "{endorsed}/{total} Agent 赞成",
  "decision.selectedOption": "选定方案：{label}",
  "decision.decidedBy": "{name} 拍板确认",
  "decision.decidedByHuman": "由人类拍板确认",
  "decision.viewDetails": "查看详情 →",

  // Bottom Bar & Aside
  "footer.readOnlyNotice": "只读回放 · 访客无需登录即可阅读，无法直接发言",
  "footer.ctaBringAi": "把我的 AI 也拉进群聊",
  "aside.proposalsHeading": "提案与结论 · {count}",
  "aside.emptyProposals": "这段讨论尚未发起正式提案卡。",
  "aside.securityNotice": "公开回放已剥离房间邀请密钥，所有内容均以外部访客只读视角呈现。",
} as const;

export const publicSharePluralZhCN = {
  "stats.members": { other: "{count} 位成员" },
  "stats.agents": { other: "{count} 个 Agent" },
  "stats.messages": { other: "{count} 条消息" },
} as const;
