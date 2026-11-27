/**
 * @module web/features/auth-pairing/portal-showcase-sections
 * @description OpenHuddle 首页门户展示模块集合：
 * 包含首屏双模实景预览器（多 Agent 群聊 ⇄ 工作台协作与审阅）、MIT 开源自托管与联系作者分区、
 * 页脚及全页右键菜单纯函数构建器。核心能力与性能多端两个分区见 portal-feature-sections，
 * 滚动剧场见 portal-story-section。
 *
 * 光学与性能不变量：
 * 1. 首屏预览器外框挂载单层 `relative liquid-glass-modal`，内部严禁任何嵌套 `backdrop-blur`。
 * 2. 首屏下方所有内容卡片均采用无 `backdrop-blur` 的清晰分层表面（`PORTAL_SURFACE_CARD_CLASS`），确保 120Hz 顺滑滚动。
 * 3. 暗夜模式下代码井、命令槽、迷你导航示意框与作者邮箱框恒定使用深中性烟熏石墨 `#141417`，杜绝刺眼白块。
 * 4. 首屏以下分区经 `portal-reveal` 滚动渐进显现（眉标划线 → 标题遮罩上浮 → 卡片与条目错峰级联）：
 *    仅驱动 `transform` / `opacity`、进入视口一次性触发，并遵循系统「减少动态效果」直接渲染终态。
 */
import type { AgentPlatform, LanguagePreference, SupportedLocale } from "@openhuddle/protocol";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Check,
  CheckCircle2,
  Compass,
  Copy,
  ExternalLink,
  GitBranch,
  Globe,
  KeyRound,
  Languages,
  Layers,
  Link2,
  Mail,
  Moon,
  Sun,
  Terminal,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { BrandMark } from "../../../components/brand-mark.js";
import {
  AnimatePresence,
  AppButton,
  type AppContextMenuEntry,
  INSTANT_TRANSITION,
  NATIVE_VIEW_SWAP,
  type SegmentedTabItem,
  SegmentedTabs,
  appButtonVariants,
  cn,
  motion,
  toast,
  usePrefersReducedMotion,
} from "../../../components/primitives/index.js";
import { PlatformAvatar } from "../../../components/ui/identity-badges.js";
import { PlatformGlyph } from "../../../components/ui/platform-icons.js";
import {
  getCommonTranslator,
  readGuestLanguagePreference,
  setGuestLanguagePreference,
} from "../../../lib/i18n/index.js";
import { getPortalTranslator, usePortalI18n } from "../i18n/index.js";
import { LOCALE_PREFERENCE_ORDER } from "./locale-switcher-menu.js";
import {
  PortalEyebrow,
  PortalTitleReveal,
  portalRevealItem,
  portalRevealTrigger,
} from "./portal-reveal.js";
import { PORTAL_DIFF_ROWS } from "./portal-visuals.js";

/** 作者公开联系邮箱 */
export const AUTHOR_CONTACT_EMAIL = "impangyan@outlook.com";

/** OpenHuddle GitHub 开源仓库地址 */
export const OPENHUDDLE_GITHUB_URL = "https://github.com/yhawk1022/OpenHuddle";

/** 本地快速体验启动命令 */
export const PORTAL_QUICK_START_COMMAND = [
  "git clone https://github.com/yhawk1022/OpenHuddle.git",
  "cd OpenHuddle && pnpm install && pnpm dev",
].join("\n");

/** 首屏下方无 `backdrop-blur` 的高帧率分层表面卡片类名 */
export const PORTAL_SURFACE_CARD_CLASS =
  "rounded-[24px] border border-black/[0.06] bg-white/78 shadow-[0_8px_28px_-12px_rgba(15,23,42,0.06)] dark:border-white/[0.07] dark:bg-[#18181C]/90 dark:shadow-[0_16px_40px_-14px_rgba(0,0,0,0.55)]";

/** 首屏双模实景预览器标签枚举 */
export type PortalPreviewTab = "huddle" | "workbench";

/**
 * 复制文本至系统剪贴板（兼容非 HTTPS 局域网自托管环境的隐藏文本域回退）。
 */
export async function copyPortalText(text: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // 继续尝试传统选区回退
    }
  }
  if (typeof document === "undefined") {
    return false;
  }
  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "true");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    textarea.style.pointerEvents = "none";
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}

/* ─────────────────────────────────────────────────────────────
 * 1. 门户全页右键菜单命中解析与声明式条目纯函数构建器
 * ───────────────────────────────────────────────────────────── */

/** 右键菜单命中上下文快照 */
export interface PortalContextHitInfo {
  /** 是否命中原生输入/编辑控件（命中时必须放行浏览器原生编辑与密码填充菜单） */
  readonly isEditableInput: boolean;
  /** 当前页面非空选中文本 */
  readonly selectedText: string;
  /** 是否命中作者邮箱卡片区域 */
  readonly hitAuthorEmail: boolean;
  /** 命中的外部 HTTP(S) 链接地址 */
  readonly externalLinkHref: string | null;
  /** 命中的可复制命令或代码片段 */
  readonly codeSnippet: string | null;
}

/** 默认空白处命中快照 */
export const DEFAULT_PORTAL_CONTEXT_HIT: PortalContextHitInfo = {
  isEditableInput: false,
  selectedText: "",
  hitAuthorEmail: false,
  externalLinkHref: null,
  codeSnippet: null,
};

function resolveElementFromTarget(target: EventTarget | null): Element | null {
  if (target === null || typeof target !== "object") {
    return null;
  }
  if (typeof Element !== "undefined" && target instanceof Element) {
    return target;
  }
  if ("parentElement" in target) {
    const parent = (target as { readonly parentElement?: unknown }).parentElement;
    if (typeof Element !== "undefined" && parent instanceof Element) {
      return parent;
    }
  }
  return null;
}

/**
 * 解析右键触发目标与当前文本选区，提取最具体的上下文语义。
 */
export function inspectPortalContextTarget(
  target: EventTarget | null,
  explicitSelectionText?: string | undefined,
): PortalContextHitInfo {
  const rawSelection =
    explicitSelectionText !== undefined
      ? explicitSelectionText
      : typeof window !== "undefined" && typeof window.getSelection === "function"
        ? (window.getSelection()?.toString() ?? "")
        : "";
  const selectedText = rawSelection.trim();

  const el = resolveElementFromTarget(target);
  if (el === null) {
    return {
      ...DEFAULT_PORTAL_CONTEXT_HIT,
      selectedText,
    };
  }

  const isEditableInput =
    el.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""]') !== null;
  if (isEditableInput) {
    return {
      isEditableInput: true,
      selectedText,
      hitAuthorEmail: false,
      externalLinkHref: null,
      codeSnippet: null,
    };
  }

  const hitAuthorEmail = el.closest('[data-context-kind="author-email"]') !== null;

  const anchorEl = el.closest("a[href]");
  const rawHref = anchorEl?.getAttribute("href")?.trim() ?? "";
  const externalLinkHref = /^https?:\/\//i.test(rawHref) ? rawHref : null;

  const codeEl = el.closest("[data-context-code]");
  const rawCode = codeEl?.getAttribute("data-context-code")?.trim() ?? "";
  const codeSnippet = rawCode.length > 0 ? rawCode : null;

  return {
    isEditableInput: false,
    selectedText,
    hitAuthorEmail,
    externalLinkHref,
    codeSnippet,
  };
}

/** 构建门户右键菜单所需的动作回调集合 */
export interface PortalContextMenuActions {
  readonly isAuthenticatedWelcome: boolean;
  readonly isDarkTheme: boolean;
  /** 当前界面语言偏好（缺省读取访客存储槽） */
  readonly languagePreference?: LanguagePreference | undefined;
  /** 可选显式语种（缺省取全局生效语种） */
  readonly locale?: SupportedLocale | undefined;
  /** 切换界面语言偏好回调（缺省调用 `setGuestLanguagePreference`） */
  readonly onSelectLanguage?: ((preference: LanguagePreference) => void) | undefined;
  readonly onCopyText: (
    text: string,
    successTitle: string,
    description?: string | undefined,
  ) => void;
  readonly onOpenMailClient: (email: string) => void;
  readonly onOpenExternalLink: (href: string) => void;
  readonly onPrimaryAuthOrReturn: () => void;
  readonly onScrollToPreview: () => void;
  readonly onScrollToCapabilities: () => void;
  readonly onToggleTheme: () => void;
  readonly onCopySiteUrl: () => void;
}

function renderPortalLanguageIcon(value: LanguagePreference, isSelected: boolean) {
  if (isSelected) {
    return <Check className="h-3.5 w-3.5" />;
  }
  if (value === "auto") {
    return <Globe className="h-3.5 w-3.5" />;
  }
  return (
    <span className="inline-flex h-3.5 w-3.5 items-center justify-center text-[10px] font-semibold leading-none opacity-80">
      {value === "zh-CN" ? /* i18n-ignore */ "中" : "EN"}
    </span>
  );
}

/**
 * 根据命中快照纯函数生成门户 `AppContextMenu` 条目列表。
 */
export function buildPortalContextMenuEntries(
  hit: PortalContextHitInfo,
  actions: PortalContextMenuActions,
): ReadonlyArray<AppContextMenuEntry> {
  if (hit.isEditableInput) {
    return [];
  }

  const { t } = getPortalTranslator(actions.locale);
  const { t: tCommon } = getCommonTranslator(actions.locale);
  const currentLanguagePreference = actions.languagePreference ?? readGuestLanguagePreference();
  const handleSelectLanguage = actions.onSelectLanguage ?? setGuestLanguagePreference;

  const items: AppContextMenuEntry[] = [];

  if (hit.selectedText.length > 0) {
    items.push({
      id: "ctx-portal-copy-selection",
      label: t("context.copySelection"),
      icon: <Copy className="h-3.5 w-3.5" />,
      onSelect: () => actions.onCopyText(hit.selectedText, t("context.copiedSelection")),
    });
    items.push({ kind: "separator", id: "ctx-portal-sep-selection" });
  }

  if (hit.hitAuthorEmail) {
    items.push({
      id: "ctx-portal-mail-author",
      label: t("context.mailAuthor", { email: AUTHOR_CONTACT_EMAIL }),
      icon: <Mail className="h-3.5 w-3.5" />,
      onSelect: () => actions.onOpenMailClient(AUTHOR_CONTACT_EMAIL),
    });
    items.push({
      id: "ctx-portal-copy-author-email",
      label: t("context.copyAuthorEmail"),
      icon: <Copy className="h-3.5 w-3.5" />,
      onSelect: () =>
        actions.onCopyText(
          AUTHOR_CONTACT_EMAIL,
          t("context.copiedAuthorEmail"),
          AUTHOR_CONTACT_EMAIL,
        ),
    });
    items.push({ kind: "separator", id: "ctx-portal-sep-author" });
  }

  if (hit.externalLinkHref !== null) {
    const href = hit.externalLinkHref;
    items.push({
      id: "ctx-portal-open-link",
      label: t("context.openLink"),
      icon: <ExternalLink className="h-3.5 w-3.5" />,
      onSelect: () => actions.onOpenExternalLink(href),
    });
    items.push({
      id: "ctx-portal-copy-link",
      label: t("context.copyLink"),
      icon: <Copy className="h-3.5 w-3.5" />,
      onSelect: () => actions.onCopyText(href, t("context.copiedLink"), href),
    });
    items.push({ kind: "separator", id: "ctx-portal-sep-link" });
  }

  if (hit.codeSnippet !== null) {
    const snippet = hit.codeSnippet;
    items.push({
      id: "ctx-portal-copy-code",
      label: t("context.copyQuickStart"),
      icon: <Terminal className="h-3.5 w-3.5" />,
      onSelect: () => actions.onCopyText(snippet, t("context.copiedQuickStart")),
    });
    items.push({ kind: "separator", id: "ctx-portal-sep-code" });
  }

  items.push({
    id: "ctx-portal-primary-nav",
    label: actions.isAuthenticatedWelcome ? t("context.backToApp") : t("context.jumpToAuth"),
    icon: actions.isAuthenticatedWelcome ? (
      <ArrowLeft className="h-3.5 w-3.5" />
    ) : (
      <KeyRound className="h-3.5 w-3.5" />
    ),
    onSelect: actions.onPrimaryAuthOrReturn,
  });

  items.push({
    id: "ctx-portal-jump-preview",
    label: t("context.scrollToPreview"),
    icon: <Layers className="h-3.5 w-3.5" />,
    onSelect: actions.onScrollToPreview,
  });

  items.push({
    id: "ctx-portal-jump-capabilities",
    label: t("context.scrollToCapabilities"),
    icon: <Compass className="h-3.5 w-3.5" />,
    onSelect: actions.onScrollToCapabilities,
  });

  items.push({ kind: "separator", id: "ctx-portal-sep-utilities" });

  if (!hit.hitAuthorEmail) {
    items.push({
      id: "ctx-portal-contact-copy",
      label: t("context.contactAuthorCopy"),
      icon: <Mail className="h-3.5 w-3.5" />,
      onSelect: () =>
        actions.onCopyText(
          AUTHOR_CONTACT_EMAIL,
          t("context.copiedAuthorEmail"),
          AUTHOR_CONTACT_EMAIL,
        ),
    });
  }

  items.push({
    kind: "submenu",
    id: "ctx-portal-language",
    label: t("context.languageSubmenu"),
    icon: <Languages className="h-3.5 w-3.5" />,
    items: LOCALE_PREFERENCE_ORDER.map((value) => {
      const isSelected = currentLanguagePreference === value;
      const label =
        value === "auto"
          ? tCommon("locale.option.auto")
          : value === "zh-CN"
            ? tCommon("locale.autonym.zhCN")
            : tCommon("locale.autonym.en");
      return {
        id: `ctx-portal-lang-${value}`,
        label,
        icon: renderPortalLanguageIcon(value, isSelected),
        onSelect: () => handleSelectLanguage(value),
      };
    }),
  });

  items.push({
    id: "ctx-portal-toggle-theme",
    label: actions.isDarkTheme ? t("context.switchToLight") : t("context.switchToDark"),
    icon: actions.isDarkTheme ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />,
    onSelect: actions.onToggleTheme,
  });

  items.push({
    id: "ctx-portal-copy-site",
    label: t("context.copySiteUrl"),
    icon: <Link2 className="h-3.5 w-3.5" />,
    onSelect: actions.onCopySiteUrl,
  });

  return items;
}

/* ─────────────────────────────────────────────────────────────
 * 2. 首屏快捷导览胶囊条（< lg 可见）与双模实景预览器（Block C）
 * ───────────────────────────────────────────────────────────── */

const HERO_MINI_PLATFORMS: ReadonlyArray<{
  readonly platform: AgentPlatform;
  readonly surfaceClass: string;
}> = [
  {
    platform: "claude_code",
    surfaceClass: "bg-[#F4ECDD] text-[#5C4528] dark:bg-[#2F261C] dark:text-[#F3CFA2]",
  },
  {
    platform: "codex",
    surfaceClass: "bg-[#E1ECFF] text-[#244375] dark:bg-[#1A273D] dark:text-[#9FC5FF]",
  },
  {
    platform: "cursor",
    surfaceClass: "bg-[#FFF1C2] text-[#5C4813] dark:bg-[#2F2816] dark:text-[#F5D687]",
  },
  {
    platform: "gemini",
    surfaceClass: "bg-[#EFEAFF] text-[#3F3368] dark:bg-[#25213A] dark:text-[#C9BEFF]",
  },
];

export interface PortalMobileQuickGuideProps {
  readonly onScrollToPreview: () => void;
  readonly onScrollToContact: () => void;
}

/**
 * 窄屏（`< lg`）首屏标题下方的快捷导览胶囊行。
 */
export function PortalMobileQuickGuide(props: PortalMobileQuickGuideProps) {
  const { t } = usePortalI18n();
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 lg:hidden">
      <button
        type="button"
        onClick={props.onScrollToPreview}
        className="im-press inline-flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-full border border-black/[0.07] bg-white/80 pl-2 pr-3 text-[12px] font-medium text-[#1F2430] shadow-[0_1px_3px_rgba(15,23,42,0.04)] hover:bg-white dark:border-white/[0.09] dark:bg-[#1A1B20] dark:text-[#E6E8EE] dark:hover:bg-[#22232A]"
      >
        <span aria-hidden="true" className="flex items-center -space-x-1.5">
          {HERO_MINI_PLATFORMS.map((item) => (
            <span
              key={item.platform}
              className={cn(
                "inline-flex h-[18px] w-[18px] items-center justify-center rounded-full ring-1 ring-white dark:ring-[#16171C]",
                item.surfaceClass,
              )}
            >
              <PlatformGlyph platform={item.platform} className="h-2.5 w-2.5" />
            </span>
          ))}
        </span>
        <span>{t("mobileGuide.previewAndFeatures")}</span>
        <ArrowDown aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-[#687082]" />
      </button>

      <button
        type="button"
        onClick={props.onScrollToContact}
        className="im-press inline-flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-full border border-black/[0.07] bg-white/75 px-3 text-[12px] font-medium text-[#3B414E] shadow-[0_1px_3px_rgba(15,23,42,0.03)] hover:bg-white hover:text-[#111318] dark:border-white/[0.09] dark:bg-[#1A1B20] dark:text-[#C4C4CA] dark:hover:bg-[#22232A] dark:hover:text-white"
      >
        <Mail aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
        <span>{t("mobileGuide.contactAuthor")}</span>
      </button>
    </div>
  );
}

interface PreviewBubbleItem {
  readonly key: string;
  readonly platform: AgentPlatform;
  readonly name: string;
  readonly ownerNote: string;
  readonly time: string;
  readonly text: string;
}

/**
 * 首屏块 C：双模实景预览器（`多 Agent 群聊` ⇄ `工作台协作与审阅`）。
 *
 * @remarks
 * 外框使用单层 `relative liquid-glass-modal`，内部所有子面板保持零 `backdrop-blur`。
 */
export function PortalHeroPreview() {
  const { t } = usePortalI18n();
  const [previewTab, setPreviewTab] = useState<PortalPreviewTab>("huddle");
  const reducedMotion = usePrefersReducedMotion();

  const previewTabItems: ReadonlyArray<SegmentedTabItem<PortalPreviewTab>> = [
    { value: "huddle", label: t("preview.tab.huddle") },
    { value: "workbench", label: t("preview.tab.workbench") },
  ];

  const previewHuddleBubbles: ReadonlyArray<PreviewBubbleItem> = [
    {
      key: "claude",
      platform: "claude_code",
      name: "Claude Code",
      ownerNote: t("preview.huddle.claudeOwner"),
      time: "10:42",
      text: t("preview.huddle.claudeText"),
    },
    {
      key: "codex",
      platform: "codex",
      name: "Codex",
      ownerNote: t("preview.huddle.codexOwner"),
      time: "10:43",
      text: t("preview.huddle.codexText"),
    },
  ];

  return (
    <div className="relative liquid-glass-modal select-none overflow-hidden rounded-[24px] sm:rounded-[28px] dark:bg-[#16171C]/[0.76]">
      {/* 顶部模式切换栏 */}
      <div className="flex flex-wrap items-center justify-between gap-2.5 border-b border-black/[0.06] px-3.5 py-2.5 sm:px-5 sm:py-3 dark:border-white/[0.07]">
        <SegmentedTabs<PortalPreviewTab>
          value={previewTab}
          onValueChange={setPreviewTab}
          items={previewTabItems}
          size="sm"
          layoutId="oh-portal-hero-preview-tabs"
          ariaLabel={t("preview.tabsAria")}
        />

        <span className="hidden items-center gap-1.5 text-[11.5px] font-medium text-[#5A6272] sm:inline-flex dark:text-[#9898A2]">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#16A34A] dark:bg-[#34D399]" />
          <span>
            {previewTab === "huddle" ? t("preview.status.huddle") : t("preview.status.workbench")}
          </span>
        </span>
      </div>

      <AnimatePresence mode="wait" initial={false}>
        {previewTab === "huddle" ? (
          <motion.div
            key="portal-preview-huddle"
            initial={reducedMotion ? false : { opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reducedMotion ? { opacity: 0 } : { opacity: 0, y: -4 }}
            transition={reducedMotion ? INSTANT_TRANSITION : NATIVE_VIEW_SWAP}
          >
            {/* 群聊会话信息条 */}
            <div className="flex items-center justify-between gap-3 border-b border-black/[0.05] px-4 py-3 sm:px-5 dark:border-white/[0.06]">
              <div className="flex min-w-0 items-center gap-2.5">
                <div
                  aria-hidden="true"
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[11px] bg-[#DCE8FC] text-[13px] font-semibold text-[#1D3E78] ring-1 ring-inset ring-white/80 dark:bg-[#222938] dark:text-[#B8D0FA] dark:ring-white/[0.08]"
                >
                  {t("preview.huddle.avatarMonogram")}
                </div>
                <div className="min-w-0">
                  <p className="truncate text-[13.5px] font-semibold tracking-[-0.01em] text-[#111318] dark:text-[#F2F2F4]">
                    {t("preview.huddle.roomTitle")}
                  </p>
                  <p className="truncate text-[11px] text-[#687082] dark:text-[#8E8E96]">
                    {t("preview.huddle.roomMeta")}
                  </p>
                </div>
              </div>
              <span className="shrink-0 rounded-full bg-black/[0.05] px-2.5 py-0.5 text-[11px] font-medium text-[#4B5565] dark:bg-white/[0.07] dark:text-[#C4C4CA]">
                {t("preview.huddle.liveBadge")}
              </span>
            </div>

            {/* 三角色对话流 */}
            <div className="space-y-3 bg-im-canvas/70 px-4 py-4 sm:px-5 sm:py-4.5 dark:bg-black/[0.18]">
              <div className="flex justify-end">
                <div className="max-w-[86%] sm:max-w-[82%]">
                  <div className="rounded-[18px_6px_18px_18px] bg-im-self px-3.5 py-2.5 text-[13px] leading-[1.52] text-im-self-fg ring-1 ring-inset ring-black/[0.05] dark:ring-white/[0.10]">
                    <span className="font-medium text-[#157347] dark:text-[#6EE7B7]">
                      @Claude Code @Codex
                    </span>{" "}
                    {t("preview.huddle.humanPrompt")}
                  </div>
                  <p className="mt-1 text-right text-[10.5px] text-[#8E96A6] dark:text-[#8E8E96]">
                    {t("preview.huddle.humanMeta")}
                  </p>
                </div>
              </div>

              {previewHuddleBubbles.map((bubble) => (
                <div key={bubble.key} className="flex items-start gap-2.5">
                  <PlatformAvatar
                    kind="agent"
                    displayName={bubble.name}
                    platform={bubble.platform}
                    size="md"
                    className="mt-0.5"
                  />
                  <div className="min-w-0 max-w-[86%] sm:max-w-[82%]">
                    <p className="mb-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11.5px]">
                      <span className="font-medium text-[#111318] dark:text-[#F2F2F4]">
                        {bubble.name}
                      </span>
                      <span className="text-[#687082] dark:text-[#8E8E96]">{bubble.ownerNote}</span>
                      <span className="text-[#939BAD] dark:text-[#63636B]">{bubble.time}</span>
                    </p>
                    <div className="rounded-[6px_18px_18px_18px] bg-im-peer px-3.5 py-2.5 text-[13px] leading-[1.52] text-im-peer-fg shadow-[0_1px_2px_rgba(15,23,42,0.04)] ring-1 ring-inset ring-black/[0.05] dark:ring-white/[0.07]">
                      {bubble.text}
                    </div>
                  </div>
                </div>
              ))}

              {/* 鼠尾草绿提案决议卡 */}
              <div className="rounded-[18px] bg-im-human px-3.5 py-3 text-im-human-fg ring-1 ring-inset ring-emerald-900/[0.08] sm:ml-11 sm:px-4 dark:ring-emerald-400/[0.14]">
                <div className="flex items-center justify-between gap-2">
                  <span className="inline-flex items-center gap-1.5 text-[11.5px] font-semibold text-[#145335] dark:text-[#6EE7B7]">
                    <CheckCircle2 aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
                    <span>{t("preview.huddle.decisionBadge")}</span>
                  </span>
                  <span className="shrink-0 text-[11px] text-[#2F6849] dark:text-[#9ACBB0]">
                    {t("preview.huddle.decisionVotes")}
                  </span>
                </div>
                <p className="mt-1 text-[13px] font-medium leading-snug">
                  {t("preview.huddle.decisionSummary")}
                </p>
                <p className="mt-0.5 text-[11.5px] text-[#3B6E52] dark:text-[#A4C9B4]">
                  {t("preview.huddle.decisionFootnote")}
                </p>
              </div>
            </div>
          </motion.div>
        ) : (
          <motion.div
            key="portal-preview-workbench"
            initial={reducedMotion ? false : { opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reducedMotion ? { opacity: 0 } : { opacity: 0, y: -4 }}
            transition={reducedMotion ? INSTANT_TRANSITION : NATIVE_VIEW_SWAP}
            className="bg-im-canvas/70 dark:bg-black/[0.18]"
          >
            {/* 工作台任务头 */}
            <div className="flex items-start justify-between gap-3 border-b border-black/[0.05] px-4 py-3 sm:px-5 dark:border-white/[0.06]">
              <div className="min-w-0">
                <p className="text-[13.5px] font-semibold leading-snug tracking-[-0.01em] text-[#111318] dark:text-[#F2F2F4]">
                  {t("preview.workbench.taskTitle")}
                </p>
                <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 font-mono text-[11px] text-[#687082] dark:text-[#8E8E96]">
                  <span>openhuddle</span>
                  <span aria-hidden="true">·</span>
                  <span className="inline-flex items-center gap-1">
                    <GitBranch aria-hidden="true" className="h-3 w-3 shrink-0" />
                    <span>fix/payment-dedupe</span>
                  </span>
                  <span aria-hidden="true">·</span>
                  <span className="font-sans">{t("preview.workbench.filesChanged")}</span>
                </p>
              </div>
              <span className="shrink-0 rounded-full bg-black/[0.055] px-2.5 py-0.5 text-[11px] font-medium text-[#3B414E] dark:bg-white/[0.08] dark:text-[#D4D4D8]">
                {t("preview.workbench.topologyBadge")}
              </span>
            </div>

            <div className="space-y-3 px-4 py-3.5 sm:px-5 sm:py-4">
              {/* 双 Agent 分工留痕列表 */}
              <div className="divide-y divide-black/[0.05] overflow-hidden rounded-[14px] border border-black/[0.06] bg-white/80 dark:divide-white/[0.06] dark:border-white/[0.07] dark:bg-[#1A1B20]">
                <div className="flex items-center justify-between gap-2 px-3 py-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <PlatformAvatar
                      kind="agent"
                      displayName="Claude Code"
                      platform="claude_code"
                      size="sm"
                    />
                    <span className="truncate text-[12.5px] font-medium text-[#111318] dark:text-[#F2F2F4]">
                      Claude Code
                    </span>
                    <span className="shrink-0 text-[11px] text-[#687082] dark:text-[#8E8E96]">
                      {t("preview.workbench.roleLead")}
                    </span>
                  </div>
                  <span className="shrink-0 font-mono text-[11.5px] font-semibold tabular-nums">
                    <span className="text-[#15803D] dark:text-[#4ADE80]">+38</span>{" "}
                    <span className="text-[#B91C1C] dark:text-[#F87171]">-9</span>
                  </span>
                </div>

                <div className="flex items-center justify-between gap-2 px-3 py-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <PlatformAvatar kind="agent" displayName="Codex" platform="codex" size="sm" />
                    <span className="truncate text-[12.5px] font-medium text-[#111318] dark:text-[#F2F2F4]">
                      Codex
                    </span>
                    <span className="shrink-0 text-[11px] text-[#687082] dark:text-[#8E8E96]">
                      {t("preview.workbench.roleReviewer")}
                    </span>
                  </div>
                  <span className="inline-flex shrink-0 items-center gap-1 text-[11.5px] font-medium text-[#15803D] dark:text-[#4ADE80]">
                    <CheckCircle2 aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
                    <span className="font-mono">pnpm verify</span>
                    <span>{t("preview.workbench.verifyPassed")}</span>
                  </span>
                </div>
              </div>

              {/* 单问澄清回执条 */}
              <div className="rounded-[13px] border border-black/[0.05] bg-black/[0.025] px-3 py-2 text-[11.5px] leading-relaxed dark:border-white/[0.06] dark:bg-white/[0.03]">
                <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
                  <span className="font-semibold text-[#3B414E] dark:text-[#C4C4CA]">
                    {t("preview.workbench.clarifyLabel")}
                  </span>
                  <span className="text-[#5A6272] dark:text-[#9898A2]">
                    {t("preview.workbench.clarifyQuestion")}
                  </span>
                  <span className="font-medium text-[#111318] dark:text-[#F2F2F4]">
                    {t("preview.workbench.clarifyAnswer")}
                  </span>
                </div>
              </div>

              {/* 深色/浅色凹陷 Unified Diff 代码井（暗色底严格 #141417） */}
              <div className="overflow-hidden rounded-[14px] border border-black/[0.07] bg-[#EFF1F4] dark:border-white/[0.08] dark:bg-[#141417]">
                <div className="flex items-center justify-between gap-2 border-b border-black/[0.06] px-3 py-1.5 font-mono text-[11px] dark:border-white/[0.07]">
                  <span className="truncate font-medium text-[#3B414E] dark:text-[#C4C4CA]">
                    server/payment/callback.ts
                  </span>
                  <span className="shrink-0 text-[#687082] dark:text-[#71717A]">
                    @@ -41,2 +41,3 @@
                  </span>
                </div>
                <div className="overflow-x-auto py-1 font-mono text-[11.5px] leading-[1.6]">
                  <div className="min-w-fit">
                    {PORTAL_DIFF_ROWS.map((row) => {
                      const isAdd = row.kind === "add";
                      const isDel = row.kind === "del";
                      return (
                        <div
                          key={row.id}
                          className={cn(
                            "flex items-baseline px-2.5",
                            isAdd && "bg-[#DCFCE7]/60 dark:bg-[#132C1F]/80",
                            isDel && "bg-[#FEE2E2]/65 dark:bg-[#31171B]/80",
                          )}
                        >
                          <span className="w-6 shrink-0 select-none pr-1.5 text-right text-[10px] text-[#8E96A6] dark:text-[#63636B]">
                            {row.oldNum}
                          </span>
                          <span className="w-6 shrink-0 select-none pr-1.5 text-right text-[10px] text-[#8E96A6] dark:text-[#63636B]">
                            {row.newNum}
                          </span>
                          <span
                            className={cn(
                              "w-3.5 shrink-0 select-none font-semibold",
                              isAdd
                                ? "text-[#15803D] dark:text-[#4ADE80]"
                                : isDel
                                  ? "text-[#B91C1C] dark:text-[#F87171]"
                                  : "text-transparent",
                            )}
                          >
                            {isAdd ? "+" : isDel ? "-" : "·"}
                          </span>
                          <span
                            className={cn(
                              "whitespace-pre pr-3",
                              isAdd
                                ? "text-[#14532D] dark:text-[#D1FAE5]"
                                : isDel
                                  ? "text-[#7F1D1D] dark:text-[#FEE2E2]"
                                  : "text-[#3B414E] dark:text-[#D4D4D8]",
                            )}
                          >
                            {row.code}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>

              {/* 底部纯静态状态栏 */}
              <div className="flex flex-wrap items-center justify-between gap-2 pt-0.5">
                <span className="inline-flex items-center gap-1.5 text-[12px] font-medium text-[#2F6849] dark:text-[#86E0A6]">
                  <CheckCircle2 aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
                  <span>{t("preview.workbench.gatePassed")}</span>
                </span>

                <div aria-hidden="true" className="flex shrink-0 items-center gap-1.5">
                  <span className="rounded-full border border-black/[0.08] bg-white/80 px-2.5 py-1 text-[11px] font-medium text-[#3B414E] dark:border-white/[0.10] dark:bg-white/[0.06] dark:text-[#D4D4D8]">
                    {t("preview.workbench.actionConsult")}
                  </span>
                  <span className="rounded-full bg-[#181B22] px-2.5 py-1 text-[11px] font-medium text-white dark:bg-[#EAEEF6] dark:text-[#111318]">
                    {t("preview.workbench.actionApprove")}
                  </span>
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────
 * 4. 开源自托管与联系作者（#portal-open-source & #portal-contact）+ 页脚
 * ───────────────────────────────────────────────────────────── */

export interface PortalOpenSourceContactSectionProps {
  readonly isAuthenticatedWelcome: boolean;
  readonly onPrimaryAuthOrReturn: () => void;
}

/**
 * 开源自托管与联系作者分区（`#portal-open-source` & `#portal-contact`）。
 */
export function PortalOpenSourceContactSection(props: PortalOpenSourceContactSectionProps) {
  const { t } = usePortalI18n();
  const [copiedCmd, setCopiedCmd] = useState<boolean>(false);
  const [copiedEmail, setCopiedEmail] = useState<boolean>(false);
  const cmdTimerRef = useRef<number | null>(null);
  const emailTimerRef = useRef<number | null>(null);
  const reducedMotion = usePrefersReducedMotion();

  useEffect(() => {
    return () => {
      if (cmdTimerRef.current !== null) {
        window.clearTimeout(cmdTimerRef.current);
      }
      if (emailTimerRef.current !== null) {
        window.clearTimeout(emailTimerRef.current);
      }
    };
  }, []);

  const handleCopyCommand = async (): Promise<void> => {
    const ok = await copyPortalText(PORTAL_QUICK_START_COMMAND);
    if (!ok) {
      toast.error(t("openSource.copyCommandError"));
      return;
    }
    setCopiedCmd(true);
    toast.success(t("openSource.copyCommandSuccess"));
    if (cmdTimerRef.current !== null) {
      window.clearTimeout(cmdTimerRef.current);
    }
    cmdTimerRef.current = window.setTimeout(() => {
      setCopiedCmd(false);
    }, 2_000);
  };

  const handleCopyAuthorEmail = async (): Promise<void> => {
    const ok = await copyPortalText(AUTHOR_CONTACT_EMAIL);
    if (!ok) {
      toast.error(t("contact.copyEmailError"));
      return;
    }
    setCopiedEmail(true);
    toast.success(t("contact.copyEmailSuccess"), { description: AUTHOR_CONTACT_EMAIL });
    if (emailTimerRef.current !== null) {
      window.clearTimeout(emailTimerRef.current);
    }
    emailTimerRef.current = window.setTimeout(() => {
      setCopiedEmail(false);
    }, 2_000);
  };

  return (
    <section
      id="portal-open-source"
      className="shrink-0 scroll-mt-20 grid grid-cols-1 gap-4 sm:gap-5 lg:grid-cols-12"
    >
      {/* 左卡（7 列）：MIT 开源协议，几分钟内私有化部署 */}
      <motion.article
        {...portalRevealTrigger(reducedMotion)}
        className={cn(
          PORTAL_SURFACE_CARD_CLASS,
          "flex min-w-0 flex-col justify-between p-5 sm:p-6 lg:col-span-7",
        )}
      >
        <div>
          <PortalEyebrow>{t("openSource.eyebrow")}</PortalEyebrow>
          <PortalTitleReveal>
            <h2 className="mt-1.5 text-balance text-[24px] font-semibold leading-snug tracking-[-0.025em] text-[#111318] sm:text-[27px] dark:text-[#F2F2F4]">
              {t("openSource.title")}
            </h2>
          </PortalTitleReveal>
          <motion.p
            {...portalRevealItem(0.16)}
            className="mt-2 text-[13.5px] leading-relaxed text-[#525A6B] dark:text-[#A0A2AC]"
          >
            {t("openSource.description")}
          </motion.p>

          {/* 带一键复制的快速启动命令槽（暗色底严格 #141417） */}
          <motion.div
            {...portalRevealItem(0.2)}
            data-context-code={PORTAL_QUICK_START_COMMAND}
            className="mt-4 overflow-hidden rounded-[16px] border border-black/[0.07] bg-[#EFF1F4] dark:border-white/[0.08] dark:bg-[#141417]"
          >
            <div className="flex items-center justify-between gap-2 border-b border-black/[0.06] px-3.5 py-2 dark:border-white/[0.07]">
              <span className="inline-flex items-center gap-1.5 text-[11.5px] font-medium text-[#4B5565] dark:text-[#A1A1AA]">
                <Terminal aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
                <span>{t("openSource.quickStartHeader")}</span>
              </span>
              <button
                type="button"
                onClick={() => void handleCopyCommand()}
                className="im-press inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-full bg-white/85 px-2.5 py-1 text-[11px] font-medium text-[#1F2430] ring-1 ring-black/[0.06] hover:bg-white dark:bg-white/[0.08] dark:text-[#E4E4E7] dark:ring-white/[0.10] dark:hover:bg-white/[0.13]"
              >
                {copiedCmd ? (
                  <Check
                    aria-hidden="true"
                    className="h-3 w-3 shrink-0 text-[#15803D] dark:text-[#4ADE80]"
                  />
                ) : (
                  <Copy aria-hidden="true" className="h-3 w-3 shrink-0" />
                )}
                <span>{copiedCmd ? t("openSource.copied") : t("openSource.copyCommand")}</span>
              </button>
            </div>
            <pre className="overflow-x-auto px-3.5 py-3 font-mono text-[12px] leading-[1.65] text-[#181B22] dark:text-[#E4E4E7]">
              <code>{PORTAL_QUICK_START_COMMAND}</code>
            </pre>
          </motion.div>
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-2.5">
          <a
            href={OPENHUDDLE_GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
            className={cn(appButtonVariants({ variant: "primary", size: "md" }))}
          >
            <span>{t("openSource.viewGithub")}</span>
            <ExternalLink aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
          </a>

          <AppButton
            variant="secondary"
            size="md"
            leadingIcon={
              props.isAuthenticatedWelcome ? (
                <ArrowLeft aria-hidden="true" className="h-3.5 w-3.5" />
              ) : (
                <ArrowUp aria-hidden="true" className="h-3.5 w-3.5" />
              )
            }
            onClick={props.onPrimaryAuthOrReturn}
          >
            {props.isAuthenticatedWelcome
              ? t("openSource.backToApp")
              : t("openSource.backToTopAuth")}
          </AppButton>
        </div>
      </motion.article>

      {/* 右卡（5 列）：联系作者与问题反馈 */}
      <motion.article
        id="portal-contact"
        {...portalRevealTrigger(reducedMotion, 0.08)}
        className={cn(
          PORTAL_SURFACE_CARD_CLASS,
          "flex min-w-0 scroll-mt-20 flex-col justify-between p-5 sm:p-6 lg:col-span-5",
        )}
      >
        <div>
          <PortalEyebrow>{t("contact.eyebrow")}</PortalEyebrow>
          <PortalTitleReveal>
            <h2 className="mt-1.5 text-balance text-[24px] font-semibold leading-snug tracking-[-0.025em] text-[#111318] sm:text-[27px] dark:text-[#F2F2F4]">
              {t("contact.title")}
            </h2>
          </PortalTitleReveal>
          <motion.p
            {...portalRevealItem(0.16)}
            className="mt-2 text-[13.5px] leading-relaxed text-[#525A6B] dark:text-[#A0A2AC]"
          >
            {t("contact.description")}
          </motion.p>
        </div>

        {/* 作者邮箱专属交互卡（暗色底严格 #141417，支持右键菜单定向识别） */}
        <div
          data-context-kind="author-email"
          className="mt-5 rounded-[18px] border border-black/[0.07] bg-[#EFF1F4] p-4 dark:border-white/[0.08] dark:bg-[#141417]"
        >
          <p className="text-[11.5px] font-medium text-[#5A6272] dark:text-[#9898A2]">
            {t("contact.emailLabel")}
          </p>
          <p className="mt-1 select-all break-all font-mono text-[15px] font-semibold tracking-tight text-[#111318] sm:text-[16px] dark:text-[#F2F2F4]">
            {AUTHOR_CONTACT_EMAIL}
          </p>

          <div className="mt-3.5 flex flex-wrap items-center gap-2">
            <a
              href={`mailto:${AUTHOR_CONTACT_EMAIL}`}
              className={cn(appButtonVariants({ variant: "primary", size: "sm" }))}
            >
              <Mail aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
              <span>{t("contact.sendEmail")}</span>
            </a>

            <AppButton
              variant="secondary"
              size="sm"
              leadingIcon={
                copiedEmail ? (
                  <Check
                    aria-hidden="true"
                    className="h-3.5 w-3.5 text-[#15803D] dark:text-[#4ADE80]"
                  />
                ) : (
                  <Copy aria-hidden="true" className="h-3.5 w-3.5" />
                )
              }
              onClick={() => void handleCopyAuthorEmail()}
            >
              {copiedEmail ? t("openSource.copied") : t("contact.copyEmail")}
            </AppButton>
          </div>
        </div>
      </motion.article>
    </section>
  );
}

export interface PortalFooterProps {
  readonly onScrollToTop: () => void;
}

/**
 * 门户页脚。
 */
export function PortalFooter(props: PortalFooterProps) {
  const { t } = usePortalI18n();
  return (
    <footer className="shrink-0 border-t border-black/[0.06] pt-6 pb-4 dark:border-white/[0.07]">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
        <div className="flex items-center gap-2 text-[12.5px] text-[#5A6272] dark:text-[#8E8E96]">
          <BrandMark className="h-5 w-5 shrink-0" />
          <span>{t("footer.license")}</span>
        </div>

        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[12.5px] font-medium text-[#4B5565] dark:text-[#A1A1AA]">
          <a
            href={`mailto:${AUTHOR_CONTACT_EMAIL}`}
            data-context-kind="author-email"
            className="transition-colors hover:text-[#111318] dark:hover:text-white"
          >
            {AUTHOR_CONTACT_EMAIL}
          </a>
          <a
            href={OPENHUDDLE_GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 transition-colors hover:text-[#111318] dark:hover:text-white"
          >
            <span>GitHub</span>
            <ExternalLink aria-hidden="true" className="h-3 w-3 shrink-0" />
          </a>
          <button
            type="button"
            onClick={props.onScrollToTop}
            className="inline-flex cursor-pointer items-center gap-1 transition-colors hover:text-[#111318] dark:hover:text-white"
          >
            <span>{t("footer.backToTop")}</span>
            <ArrowUp aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
          </button>
        </div>
      </div>
    </footer>
  );
}
