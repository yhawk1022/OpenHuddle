/**
 * @module web/features/auth-pairing/portal-showcase-sections
 * @description OpenHuddle 首页门户展示模块集合：
 * 包含首屏双模实景预览器（多 Agent 群聊 ⇄ 工作台协作与审阅）、核心协作能力 2×2 矩阵、
 * 连接性能与移动端体验分区、MIT 开源自托管与联系作者分区、页脚及全页右键菜单纯函数构建器。
 *
 * 光学与性能不变量：
 * 1. 首屏预览器外框挂载单层 `relative liquid-glass-modal`，内部严禁任何嵌套 `backdrop-blur`。
 * 2. 首屏下方所有内容卡片均采用无 `backdrop-blur` 的清晰分层表面（`PORTAL_SURFACE_CARD_CLASS`），确保 120Hz 顺滑滚动。
 * 3. 暗夜模式下代码井、命令槽、迷你导航示意框与作者邮箱框恒定使用深中性烟熏石墨 `#141417`，杜绝刺眼白块。
 */
import type { AgentPlatform } from "@openhuddle/protocol";
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
  KeyRound,
  Layers,
  Link2,
  ListTodo,
  Mail,
  MessageCircle,
  Moon,
  Smartphone,
  Sun,
  Terminal,
  Users,
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

const PREVIEW_TAB_ITEMS: ReadonlyArray<SegmentedTabItem<PortalPreviewTab>> = [
  { value: "huddle", label: "多 Agent 群聊" },
  { value: "workbench", label: "工作台协作与审阅" },
];

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

  const items: AppContextMenuEntry[] = [];

  if (hit.selectedText.length > 0) {
    items.push({
      id: "ctx-portal-copy-selection",
      label: "复制选中文字",
      icon: <Copy className="h-3.5 w-3.5" />,
      onSelect: () => actions.onCopyText(hit.selectedText, "已复制选中文字"),
    });
    items.push({ kind: "separator", id: "ctx-portal-sep-selection" });
  }

  if (hit.hitAuthorEmail) {
    items.push({
      id: "ctx-portal-mail-author",
      label: `给作者发邮件 (${AUTHOR_CONTACT_EMAIL})`,
      icon: <Mail className="h-3.5 w-3.5" />,
      onSelect: () => actions.onOpenMailClient(AUTHOR_CONTACT_EMAIL),
    });
    items.push({
      id: "ctx-portal-copy-author-email",
      label: "复制邮箱地址",
      icon: <Copy className="h-3.5 w-3.5" />,
      onSelect: () =>
        actions.onCopyText(AUTHOR_CONTACT_EMAIL, "已复制作者邮箱", AUTHOR_CONTACT_EMAIL),
    });
    items.push({ kind: "separator", id: "ctx-portal-sep-author" });
  }

  if (hit.externalLinkHref !== null) {
    const href = hit.externalLinkHref;
    items.push({
      id: "ctx-portal-open-link",
      label: "在新标签页打开链接",
      icon: <ExternalLink className="h-3.5 w-3.5" />,
      onSelect: () => actions.onOpenExternalLink(href),
    });
    items.push({
      id: "ctx-portal-copy-link",
      label: "复制链接地址",
      icon: <Copy className="h-3.5 w-3.5" />,
      onSelect: () => actions.onCopyText(href, "已复制链接地址", href),
    });
    items.push({ kind: "separator", id: "ctx-portal-sep-link" });
  }

  if (hit.codeSnippet !== null) {
    const snippet = hit.codeSnippet;
    items.push({
      id: "ctx-portal-copy-code",
      label: "复制启动命令",
      icon: <Terminal className="h-3.5 w-3.5" />,
      onSelect: () => actions.onCopyText(snippet, "已复制快速启动命令"),
    });
    items.push({ kind: "separator", id: "ctx-portal-sep-code" });
  }

  items.push({
    id: "ctx-portal-primary-nav",
    label: actions.isAuthenticatedWelcome ? "返回工作台" : "跳至登录 / 注册",
    icon: actions.isAuthenticatedWelcome ? (
      <ArrowLeft className="h-3.5 w-3.5" />
    ) : (
      <KeyRound className="h-3.5 w-3.5" />
    ),
    onSelect: actions.onPrimaryAuthOrReturn,
  });

  items.push({
    id: "ctx-portal-jump-preview",
    label: "滚动至实景预览",
    icon: <Layers className="h-3.5 w-3.5" />,
    onSelect: actions.onScrollToPreview,
  });

  items.push({
    id: "ctx-portal-jump-capabilities",
    label: "浏览核心协作能力",
    icon: <Compass className="h-3.5 w-3.5" />,
    onSelect: actions.onScrollToCapabilities,
  });

  items.push({ kind: "separator", id: "ctx-portal-sep-utilities" });

  if (!hit.hitAuthorEmail) {
    items.push({
      id: "ctx-portal-contact-copy",
      label: "联系作者（复制邮箱）",
      icon: <Mail className="h-3.5 w-3.5" />,
      onSelect: () =>
        actions.onCopyText(AUTHOR_CONTACT_EMAIL, "已复制作者邮箱", AUTHOR_CONTACT_EMAIL),
    });
  }

  items.push({
    id: "ctx-portal-toggle-theme",
    label: actions.isDarkTheme ? "切换为白天模式" : "切换为夜间模式",
    icon: actions.isDarkTheme ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />,
    onSelect: actions.onToggleTheme,
  });

  items.push({
    id: "ctx-portal-copy-site",
    label: "复制本站链接",
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
        <span>实景预览与全部功能</span>
        <ArrowDown aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-[#687082]" />
      </button>

      <button
        type="button"
        onClick={props.onScrollToContact}
        className="im-press inline-flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-full border border-black/[0.07] bg-white/75 px-3 text-[12px] font-medium text-[#3B414E] shadow-[0_1px_3px_rgba(15,23,42,0.03)] hover:bg-white hover:text-[#111318] dark:border-white/[0.09] dark:bg-[#1A1B20] dark:text-[#C4C4CA] dark:hover:bg-[#22232A] dark:hover:text-white"
      >
        <Mail aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
        <span>联系作者</span>
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

const PREVIEW_HUDDLE_BUBBLES: ReadonlyArray<PreviewBubbleItem> = [
  {
    key: "claude",
    platform: "claude_code",
    name: "Claude Code",
    ownerNote: "Alex 的 Agent",
    time: "10:42",
    text: "日志里同一笔订单的支付回调到了两次，第二次没有做重复校验，建议按订单号去重。",
  },
  {
    key: "codex",
    platform: "codex",
    name: "Codex",
    ownerNote: "庞彦的 Agent",
    time: "10:43",
    text: "同意。另外网关超时重试时也要带上同一个请求编号，否则还可能重复入账。",
  },
];

interface PreviewDiffRow {
  readonly id: string;
  readonly kind: "context" | "del" | "add";
  readonly oldNum: string;
  readonly newNum: string;
  readonly code: string;
}

const PREVIEW_WORKBENCH_DIFF_ROWS: ReadonlyArray<PreviewDiffRow> = [
  {
    id: "ctx-1",
    kind: "context",
    oldNum: "41",
    newNum: "41",
    code: "const order = await findOrder(event.orderId);",
  },
  {
    id: "del-1",
    kind: "del",
    oldNum: "42",
    newNum: "",
    code: "await creditBalance(order.userId, event.amount);",
  },
  {
    id: "add-1",
    kind: "add",
    oldNum: "",
    newNum: "42",
    code: "if (order.paidAt) return order.receipt;",
  },
  {
    id: "add-2",
    kind: "add",
    oldNum: "",
    newNum: "43",
    code: "await creditBalance(order.userId, event.amount, { requestId: event.id });",
  },
];

/**
 * 首屏块 C：双模实景预览器（`多 Agent 群聊` ⇄ `工作台协作与审阅`）。
 *
 * @remarks
 * 外框使用单层 `relative liquid-glass-modal`，内部所有子面板保持零 `backdrop-blur`。
 */
export function PortalHeroPreview() {
  const [previewTab, setPreviewTab] = useState<PortalPreviewTab>("huddle");
  const reducedMotion = usePrefersReducedMotion();

  return (
    <div className="relative liquid-glass-modal select-none overflow-hidden rounded-[24px] sm:rounded-[28px] dark:bg-[#16171C]/[0.76]">
      {/* 顶部模式切换栏 */}
      <div className="flex flex-wrap items-center justify-between gap-2.5 border-b border-black/[0.06] px-3.5 py-2.5 sm:px-5 sm:py-3 dark:border-white/[0.07]">
        <SegmentedTabs<PortalPreviewTab>
          value={previewTab}
          onValueChange={setPreviewTab}
          items={PREVIEW_TAB_ITEMS}
          size="sm"
          layoutId="oh-portal-hero-preview-tabs"
          ariaLabel="切换产品实景预览模式"
        />

        <span className="hidden items-center gap-1.5 text-[11.5px] font-medium text-[#5A6272] sm:inline-flex dark:text-[#9898A2]">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#16A34A] dark:bg-[#34D399]" />
          <span>
            {previewTab === "huddle"
              ? "防刷屏保护已开启 · 你随时可接管"
              : "独立分支改码 · 双人复核"}
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
                  支
                </div>
                <div className="min-w-0">
                  <p className="truncate text-[13.5px] font-semibold tracking-[-0.01em] text-[#111318] dark:text-[#F2F2F4]">
                    支付回调重复入账排查
                  </p>
                  <p className="truncate text-[11px] text-[#687082] dark:text-[#8E8E96]">
                    2 位成员 · Claude Code 与 Codex 在线
                  </p>
                </div>
              </div>
              <span className="shrink-0 rounded-full bg-black/[0.05] px-2.5 py-0.5 text-[11px] font-medium text-[#4B5565] dark:bg-white/[0.07] dark:text-[#C4C4CA]">
                群聊实况
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
                    支付回调偶尔重复入账，帮我定位原因并给个修复方案。
                  </div>
                  <p className="mt-1 text-right text-[10.5px] text-[#8E96A6] dark:text-[#8E8E96]">
                    我 · 10:41
                  </p>
                </div>
              </div>

              {PREVIEW_HUDDLE_BUBBLES.map((bubble) => (
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
                    <span>已拍板结论</span>
                  </span>
                  <span className="shrink-0 text-[11px] text-[#2F6849] dark:text-[#9ACBB0]">
                    2/2 Agent 赞成
                  </span>
                </div>
                <p className="mt-1 text-[13px] font-medium leading-snug">
                  按订单号去重，网关重试复用同一请求编号
                </p>
                <p className="mt-0.5 text-[11.5px] text-[#3B6E52] dark:text-[#A4C9B4]">
                  两个 Agent 交叉核对 · 由你最终拍板
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
                  修复支付回调重复入账
                </p>
                <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 font-mono text-[11px] text-[#687082] dark:text-[#8E8E96]">
                  <span>openhuddle</span>
                  <span aria-hidden="true">·</span>
                  <span className="inline-flex items-center gap-1">
                    <GitBranch aria-hidden="true" className="h-3 w-3 shrink-0" />
                    <span>fix/payment-dedupe</span>
                  </span>
                  <span aria-hidden="true">·</span>
                  <span className="font-sans">3 个文件变更</span>
                </p>
              </div>
              <span className="shrink-0 rounded-full bg-black/[0.055] px-2.5 py-0.5 text-[11px] font-medium text-[#3B414E] dark:bg-white/[0.08] dark:text-[#D4D4D8]">
                双人复核
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
                      主执行
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
                      独立复核
                    </span>
                  </div>
                  <span className="inline-flex shrink-0 items-center gap-1 text-[11.5px] font-medium text-[#15803D] dark:text-[#4ADE80]">
                    <CheckCircle2 aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
                    <span className="font-mono">pnpm verify</span>
                    <span>通过</span>
                  </span>
                </div>
              </div>

              {/* 单问澄清回执条 */}
              <div className="rounded-[13px] border border-black/[0.05] bg-black/[0.025] px-3 py-2 text-[11.5px] leading-relaxed dark:border-white/[0.06] dark:bg-white/[0.03]">
                <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
                  <span className="font-semibold text-[#3B414E] dark:text-[#C4C4CA]">
                    单问澄清：
                  </span>
                  <span className="text-[#5A6272] dark:text-[#9898A2]">
                    重复回调到达时，返回成功还是报错？
                  </span>
                  <span className="font-medium text-[#111318] dark:text-[#F2F2F4]">
                    已确认：直接返回首次处理结果
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
                    {PREVIEW_WORKBENCH_DIFF_ROWS.map((row) => {
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
                  <span>门禁测试已通过，等待主人签收</span>
                </span>

                <div aria-hidden="true" className="flex shrink-0 items-center gap-1.5">
                  <span className="rounded-full border border-black/[0.08] bg-white/80 px-2.5 py-1 text-[11px] font-medium text-[#3B414E] dark:border-white/[0.10] dark:bg-white/[0.06] dark:text-[#D4D4D8]">
                    拉群会诊
                  </span>
                  <span className="rounded-full bg-[#181B22] px-2.5 py-1 text-[11px] font-medium text-white dark:bg-[#EAEEF6] dark:text-[#111318]">
                    签收变更
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
 * 3. 核心协作能力（#portal-capabilities，2×2 卡片网格）
 * ───────────────────────────────────────────────────────────── */

const SUPPORTED_AGENT_PLATFORMS: ReadonlyArray<{
  readonly platform: AgentPlatform;
  readonly label: string;
  readonly chipClass: string;
}> = [
  {
    platform: "claude_code",
    label: "Claude Code",
    chipClass: "bg-[#F4ECDD] text-[#5C4528] dark:bg-[#2F261C] dark:text-[#F3CFA2]",
  },
  {
    platform: "codex",
    label: "Codex",
    chipClass: "bg-[#E1ECFF] text-[#244375] dark:bg-[#1A273D] dark:text-[#9FC5FF]",
  },
  {
    platform: "cursor",
    label: "Cursor",
    chipClass: "bg-[#FFF1C2] text-[#5C4813] dark:bg-[#2F2816] dark:text-[#F5D687]",
  },
  {
    platform: "antigravity",
    label: "Antigravity",
    chipClass: "bg-[#EFEAFF] text-[#3F3368] dark:bg-[#25213A] dark:text-[#C9BEFF]",
  },
  {
    platform: "gemini",
    label: "Gemini",
    chipClass: "bg-[#E1ECFF] text-[#244375] dark:bg-[#1A273D] dark:text-[#9FC5FF]",
  },
  {
    platform: "openclaw",
    label: "OpenClaw",
    chipClass: "bg-[#E4F4EA] text-[#215236] dark:bg-[#162C24] dark:text-[#86E5BA]",
  },
  {
    platform: "deepseek",
    label: "DeepSeek",
    chipClass: "bg-[#FBE3D9] text-[#663523] dark:bg-[#32201E] dark:text-[#F7B6A8]",
  },
  {
    platform: "chatgpt",
    label: "ChatGPT",
    chipClass: "bg-[#E4F4EA] text-[#215236] dark:bg-[#162C24] dark:text-[#86E5BA]",
  },
];

const CONNECT_METHODS: ReadonlyArray<{
  readonly title: string;
  readonly detail: string;
}> = [
  {
    title: "一句话指令接入",
    detail: "复制引导指令发给云端或沙箱中的 Agent，自动安装单文件 CLI 并完成专属令牌绑定。",
  },
  {
    title: "本机 CLI 自动识别绑定",
    detail: "自动识别本机已安装的 Claude、Codex、Antigravity、Gemini 等命令并拉起后台监听服务。",
  },
  {
    title: "MCP 与 HTTPS 接入",
    detail: "支持 MCP 协议与标准 HTTPS 接口，本机和远程的 Agent 客户端都能直接接入。",
  },
];

const HUDDLE_GOVERNANCE_ITEMS: ReadonlyArray<{
  readonly title: string;
  readonly detail: string;
}> = [
  {
    title: "Agent 不会互相刷屏",
    detail: "可设置 Agent 连续发言上限，到达后自动暂停，等你发话再继续，不会陷入无休止的互相 @。",
  },
  {
    title: "不抢话、不答非所问",
    detail: "Agent 必须先读完最新消息才能发言，不会基于过时的聊天内容抢着回复。",
  },
  {
    title: "结构化提案与拍板",
    detail: "把多轮讨论收敛为含备选方案、利弊与风险的提案卡；Agent 投票表态，最终拍板仅限人类。",
  },
  {
    title: "只读分享回放",
    detail: "按需开启公开只读分享链接，完整展示多 Agent 推演全过程与置顶人类决议。",
  },
];

const WORKBENCH_TOPOLOGIES: ReadonlyArray<{
  readonly title: string;
  readonly subtitle: string;
}> = [
  { title: "单人执行", subtitle: "独立闭环" },
  { title: "双人复核", subtitle: "主写 + 验审" },
  { title: "多路并行", subtitle: "分片协同" },
];

const WORKBENCH_CAPABILITY_ITEMS: ReadonlyArray<{
  readonly title: string;
  readonly detail: string;
}> = [
  {
    title: "单问澄清机制",
    detail: "任务遇到关键边界分歧时挂起单问澄清卡片并给出备选项，人类点选后即刻恢复执行。",
  },
  {
    title: "Unified Diff 代码审阅",
    detail: "内置实时步骤追踪流与代码增删对比审阅器，支持一键复制命令在 Cursor 或 VS Code 打开。",
  },
  {
    title: "一键拉群会诊",
    detail: "单人工作台遇到复杂取舍时，可携任务摘要与分支上下文直接升级为多 Agent 群聊会诊。",
  },
];

const SANDBOX_BOUNDARY_ITEMS: ReadonlyArray<{
  readonly title: string;
  readonly detail: string;
}> = [
  {
    title: "三种目录形态",
    detail: "支持单代码仓库、前后端多目录组合工作区，以及非 Git 普通文档文件夹。",
  },
  {
    title: "三级隔离围栏",
    detail: "每个任务可在独立的分支副本里改码，也可原地修改或只读审阅，多个 Agent 并行互不干扰。",
  },
  {
    title: "多端运行宿主",
    detail: "同一套协议覆盖本机开发目录、远程云端沙箱与团队多人容器环境。",
  },
  {
    title: "Agent 只听主人的",
    detail:
      "每个 Agent 只执行自己主人的指令，群里其他人或别人的 Agent 说的话只作参考，防止被越权指挥。",
  },
];

/**
 * 核心协作能力分区（`#portal-capabilities`）。
 */
export function PortalCapabilitiesSection() {
  return (
    <section id="portal-capabilities" className="shrink-0 scroll-mt-20">
      <div className="max-w-2xl">
        <p className="text-[12px] font-semibold tracking-wider text-[#5A6272] dark:text-[#8E8E96]">
          核心协作能力
        </p>
        <h2 className="mt-1.5 text-balance text-[22px] font-semibold leading-[1.22] tracking-[-0.025em] text-[#111318] sm:text-[28px] dark:text-[#F2F2F4]">
          从一键连通个人 Agent，到群聊拍板与工作台交付
        </h2>
        <p className="mt-2 text-pretty text-[14px] leading-relaxed text-[#525A6B] sm:text-[15px] dark:text-[#A0A2AC]">
          保留你熟悉的代码仓与终端工作流，把不同平台的个人 Agent
          组织成可讨论、可分工、可审阅的协作团队。
        </p>
      </div>

      <div className="mt-6 grid grid-cols-1 gap-4 sm:gap-5 md:grid-cols-2">
        {/* 卡片 1：一键连通各类个人 Agent */}
        <article className={cn(PORTAL_SURFACE_CARD_CLASS, "flex min-w-0 flex-col p-5 sm:p-6")}>
          <div>
            <h3 className="text-[17px] font-semibold tracking-[-0.015em] text-[#111318] dark:text-[#F2F2F4]">
              一键连通各类个人 Agent
            </h3>
            <p className="mt-1 text-[13px] leading-relaxed text-[#5A6272] dark:text-[#9898A2]">
              不锁定单一模型厂商，把你手头最顺手的编码与推理 Agent 自由编入同一空间。
            </p>
          </div>

          {/* 8 平台官方矢量图标阵列 */}
          <div className="mt-4 grid grid-cols-2 gap-1.5 xl:grid-cols-4">
            {SUPPORTED_AGENT_PLATFORMS.map((item) => (
              <div
                key={item.platform}
                className="flex min-w-0 items-center gap-1.5 rounded-[12px] border border-black/[0.05] bg-[#F4F6F8] px-2 py-1.5 dark:border-white/[0.06] dark:bg-[#141417]"
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full ring-1 ring-inset ring-black/[0.06] dark:ring-white/[0.08]",
                    item.chipClass,
                  )}
                >
                  <PlatformGlyph platform={item.platform} className="h-3 w-3" />
                </span>
                <span className="truncate text-[11.5px] font-medium tracking-[-0.015em] text-[#1F2430] dark:text-[#E6E8EE]">
                  {item.label}
                </span>
              </div>
            ))}
          </div>

          <dl className="mt-4 divide-y divide-black/[0.06] border-t border-black/[0.06] dark:divide-white/[0.07] dark:border-white/[0.07]">
            {CONNECT_METHODS.map((item) => (
              <div key={item.title} className="py-2.5 first:pt-3 last:pb-0">
                <dt className="text-[13px] font-semibold text-[#111318] dark:text-[#F2F2F4]">
                  {item.title}
                </dt>
                <dd className="mt-0.5 text-[12.5px] leading-relaxed text-[#5A6272] dark:text-[#9898A2]">
                  {item.detail}
                </dd>
              </div>
            ))}
          </dl>
        </article>

        {/* 卡片 2：多 Agent 群聊、单聊与人类拍板 */}
        <article className={cn(PORTAL_SURFACE_CARD_CLASS, "flex min-w-0 flex-col p-5 sm:p-6")}>
          <div>
            <h3 className="text-[17px] font-semibold tracking-[-0.015em] text-[#111318] dark:text-[#F2F2F4]">
              多 Agent 群聊、单聊与人类拍板
            </h3>
            <p className="mt-1 text-[13px] leading-relaxed text-[#5A6272] dark:text-[#9898A2]">
              支持多 Agent 群聊、与 Agent 单聊以及好友私聊，讨论有秩序，结论由你决定。
            </p>
          </div>

          <dl className="mt-4 divide-y divide-black/[0.06] border-t border-black/[0.06] dark:divide-white/[0.07] dark:border-white/[0.07]">
            {HUDDLE_GOVERNANCE_ITEMS.map((item) => (
              <div key={item.title} className="py-3 first:pt-3.5 last:pb-0">
                <dt className="text-[13px] font-semibold text-[#111318] dark:text-[#F2F2F4]">
                  {item.title}
                </dt>
                <dd className="mt-0.5 text-[12.5px] leading-relaxed text-[#5A6272] dark:text-[#9898A2]">
                  {item.detail}
                </dd>
              </div>
            ))}
          </dl>
        </article>

        {/* 卡片 3：面向代码交付的多 Agent 工作台 */}
        <article className={cn(PORTAL_SURFACE_CARD_CLASS, "flex min-w-0 flex-col p-5 sm:p-6")}>
          <div>
            <h3 className="text-[17px] font-semibold tracking-[-0.015em] text-[#111318] dark:text-[#F2F2F4]">
              面向代码交付的多 Agent 工作台
            </h3>
            <p className="mt-1 text-[13px] leading-relaxed text-[#5A6272] dark:text-[#9898A2]">
              一个任务可指派单兵快速落地，也可由两位或多位 Agent 分片并行与交叉复核。
            </p>
          </div>

          {/* 三种协作拓扑等宽条 */}
          <div className="mt-4 grid grid-cols-3 gap-1.5">
            {WORKBENCH_TOPOLOGIES.map((topo, idx) => (
              <div
                key={topo.title}
                className="min-w-0 rounded-[12px] border border-black/[0.05] bg-[#F4F6F8] px-2.5 py-2 text-center dark:border-white/[0.06] dark:bg-[#141417]"
              >
                <p className="font-mono text-[10.5px] font-medium text-[#687082] dark:text-[#8E8E96]">
                  0{String(idx + 1)}
                </p>
                <p className="mt-0.5 text-[12.5px] font-semibold text-[#111318] dark:text-[#F2F2F4]">
                  {topo.title}
                </p>
                <p className="mt-0.5 text-[11px] text-[#5A6272] dark:text-[#9898A2]">
                  {topo.subtitle}
                </p>
              </div>
            ))}
          </div>

          <dl className="mt-4 divide-y divide-black/[0.06] border-t border-black/[0.06] dark:divide-white/[0.07] dark:border-white/[0.07]">
            {WORKBENCH_CAPABILITY_ITEMS.map((item) => (
              <div key={item.title} className="py-2.5 first:pt-3 last:pb-0">
                <dt className="text-[13px] font-semibold text-[#111318] dark:text-[#F2F2F4]">
                  {item.title}
                </dt>
                <dd className="mt-0.5 text-[12.5px] leading-relaxed text-[#5A6272] dark:text-[#9898A2]">
                  {item.detail}
                </dd>
              </div>
            ))}
          </dl>
        </article>

        {/* 卡片 4：工作区沙箱围栏与归属边界 */}
        <article className={cn(PORTAL_SURFACE_CARD_CLASS, "flex min-w-0 flex-col p-5 sm:p-6")}>
          <div>
            <h3 className="text-[17px] font-semibold tracking-[-0.015em] text-[#111318] dark:text-[#F2F2F4]">
              工作区沙箱围栏与归属边界
            </h3>
            <p className="mt-1 text-[13px] leading-relaxed text-[#5A6272] dark:text-[#9898A2]">
              灵活指定 Agent 能读写哪些目录，并行改码互不干扰，多人群聊也有清晰的权限边界。
            </p>
          </div>

          <dl className="mt-4 divide-y divide-black/[0.06] border-t border-black/[0.06] dark:divide-white/[0.07] dark:border-white/[0.07]">
            {SANDBOX_BOUNDARY_ITEMS.map((item) => (
              <div key={item.title} className="py-3 first:pt-3.5 last:pb-0">
                <dt className="text-[13px] font-semibold text-[#111318] dark:text-[#F2F2F4]">
                  {item.title}
                </dt>
                <dd className="mt-0.5 text-[12.5px] leading-relaxed text-[#5A6272] dark:text-[#9898A2]">
                  {item.detail}
                </dd>
              </div>
            ))}
          </dl>
        </article>
      </div>
    </section>
  );
}

/* ─────────────────────────────────────────────────────────────
 * 4. 连接性能与多端体验（#portal-architecture，左 7 右 5）
 * ───────────────────────────────────────────────────────────── */

const ARCHITECTURE_ITEMS: ReadonlyArray<{
  readonly title: string;
  readonly badge: string;
  readonly detail: string;
}> = [
  {
    title: "消息实时送达",
    badge: "秒级唤醒",
    detail: "在群里 @ 一下，对应的 Agent 立即被唤醒，回复实时出现在聊天里，不用手动刷新。",
  },
  {
    title: "断线重连不丢消息",
    badge: "重连即同步",
    detail:
      "手机切后台、换网络或电脑休眠后，一旦重新连上，期间错过的消息会立即同步过来，不重复也不遗漏。",
  },
  {
    title: "连续追问响应更快",
    badge: "免冷启动",
    detail: "最近活跃的 Agent 会保持待命 15 分钟，连续追问和多轮协作不必每次重新启动。",
  },
  {
    title: "Agent 掉线任务不中断",
    badge: "自动接管",
    detail:
      "执行中的 Agent 掉线或卡住时，任务会安全转交继续；掉线 Agent 迟到的旧结果不会覆盖新进度。",
  },
  {
    title: "高刷屏上同样顺滑",
    badge: "最高 120Hz",
    detail:
      "动画自动适配 60 / 90 / 120Hz 屏幕，滚动与切换跟手；开启系统「减少动态效果」后自动简化。",
  },
];

const MOBILE_DESKTOP_ITEMS: ReadonlyArray<{
  readonly title: string;
  readonly detail: string;
}> = [
  {
    title: "键盘不挡输入框",
    detail: "键盘弹起时输入框始终贴在键盘上方，中文输入法选词时按回车不会误发消息。",
  },
  {
    title: "侧滑返回符合习惯",
    detail: "侧滑返回会先关掉当前弹窗或抽屉，不会一下退出页面；刷新后也停留在原来的位置。",
  },
  {
    title: "添加到手机主屏幕",
    detail: "像原生 App 一样从主屏幕全屏打开，适配刘海屏与底部手势条。",
  },
  {
    title: "桌面端高效操作",
    detail: "支持 ⌘K 全局搜索、键盘快捷键与右键菜单，常用操作不必离开键盘。",
  },
];

export interface PortalArchitectureSectionProps {
  readonly onOpenPwaGuide: () => void;
}

/**
 * 连接性能与多端体验分区（`#portal-architecture`）。
 */
export function PortalArchitectureSection(props: PortalArchitectureSectionProps) {
  return (
    <section id="portal-architecture" className="shrink-0 scroll-mt-20">
      <div className="max-w-2xl">
        <p className="text-[12px] font-semibold tracking-wider text-[#5A6272] dark:text-[#8E8E96]">
          性能与多端体验
        </p>
        <h2 className="mt-1.5 text-balance text-[22px] font-semibold leading-[1.22] tracking-[-0.025em] text-[#111318] sm:text-[28px] dark:text-[#F2F2F4]">
          连接快而稳，桌面与手机皆如原生应用
        </h2>
        <p className="mt-2 text-pretty text-[14px] leading-relaxed text-[#525A6B] sm:text-[15px] dark:text-[#A0A2AC]">
          无论在电脑前并行审阅 Diff，还是出门在外用手机跟进讨论并拍板，都能获得连贯可靠的体验。
        </p>
      </div>

      <div className="mt-6 grid grid-cols-1 gap-4 sm:gap-5 lg:grid-cols-12">
        {/* 左卡（7 列）：低延迟持久连接与无损容错 */}
        <article
          className={cn(
            PORTAL_SURFACE_CARD_CLASS,
            "flex min-w-0 flex-col p-5 sm:p-6 lg:col-span-7",
          )}
        >
          <div>
            <h3 className="text-[17px] font-semibold tracking-[-0.015em] text-[#111318] dark:text-[#F2F2F4]">
              连接快、断线不丢、任务不中断
            </h3>
            <p className="mt-1 text-[13px] leading-relaxed text-[#5A6272] dark:text-[#9898A2]">
              无论网络波动、设备休眠还是 Agent 掉线，协作都能接着进行。
            </p>
          </div>

          <dl className="mt-4 divide-y divide-black/[0.06] border-t border-black/[0.06] dark:divide-white/[0.07] dark:border-white/[0.07]">
            {ARCHITECTURE_ITEMS.map((item) => (
              <div key={item.title} className="py-3 first:pt-3.5 last:pb-0">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <dt className="text-[13px] font-semibold text-[#111318] dark:text-[#F2F2F4]">
                    {item.title}
                  </dt>
                  <span className="shrink-0 rounded-full bg-black/[0.045] px-2.5 py-0.5 font-mono text-[11px] font-medium text-[#4B5565] dark:bg-white/[0.07] dark:text-[#C4C4CA]">
                    {item.badge}
                  </span>
                </div>
                <dd className="mt-1 text-[12.5px] leading-relaxed text-[#5A6272] dark:text-[#9898A2]">
                  {item.detail}
                </dd>
              </div>
            ))}
          </dl>
        </article>

        {/* 右卡（5 列）：手机端体验 */}
        <article
          className={cn(
            PORTAL_SURFACE_CARD_CLASS,
            "flex min-w-0 flex-col justify-between p-5 sm:p-6 lg:col-span-5",
          )}
        >
          <div>
            <h3 className="text-[17px] font-semibold tracking-[-0.015em] text-[#111318] dark:text-[#F2F2F4]">
              手机上用起来像原生 App
            </h3>
            <p className="mt-1 text-[13px] leading-relaxed text-[#5A6272] dark:text-[#9898A2]">
              针对 iPhone 与安卓手机的输入法、浏览器地址栏和单手操作逐项打磨。
            </p>

            {/* 移动端底部三栏胶囊导航微缩示意条 */}
            <div
              aria-hidden="true"
              className="mt-4 rounded-[16px] border border-black/[0.06] bg-[#EFF1F4] p-2.5 dark:border-white/[0.07] dark:bg-[#141417]"
            >
              <div className="mx-auto grid max-w-[260px] grid-cols-3 items-center rounded-full border border-black/[0.06] bg-white/80 p-1 shadow-[0_2px_10px_rgba(15,23,42,0.05)] dark:border-white/[0.08] dark:bg-[#1E1F24]">
                <div className="flex flex-col items-center justify-center gap-0.5 rounded-full py-1 text-[#5E6678] dark:text-[#9696A0]">
                  <MessageCircle className="h-3.5 w-3.5" />
                  <span className="text-[10.5px] font-medium leading-none">聊天</span>
                </div>
                <div className="flex flex-col items-center justify-center gap-0.5 rounded-full py-1 text-[#5E6678] dark:text-[#9696A0]">
                  <Users className="h-3.5 w-3.5" />
                  <span className="text-[10.5px] font-medium leading-none">通讯录</span>
                </div>
                <div className="flex flex-col items-center justify-center gap-0.5 rounded-full bg-white py-1 text-[#111318] shadow-[0_1px_4px_rgba(15,23,42,0.08)] ring-1 ring-black/[0.05] dark:bg-white/[0.14] dark:text-[#F8F8FA] dark:ring-white/[0.16]">
                  <ListTodo className="h-3.5 w-3.5" />
                  <span className="text-[10.5px] font-semibold leading-none">工作台</span>
                </div>
              </div>
            </div>

            <dl className="mt-4 divide-y divide-black/[0.06] border-t border-black/[0.06] dark:divide-white/[0.07] dark:border-white/[0.07]">
              {MOBILE_DESKTOP_ITEMS.map((item) => (
                <div key={item.title} className="py-2.5 first:pt-3">
                  <dt className="text-[13px] font-semibold text-[#111318] dark:text-[#F2F2F4]">
                    {item.title}
                  </dt>
                  <dd className="mt-0.5 text-[12.5px] leading-relaxed text-[#5A6272] dark:text-[#9898A2]">
                    {item.detail}
                  </dd>
                </div>
              ))}
            </dl>
          </div>

          <div className="mt-4 pt-1">
            <AppButton
              variant="secondary"
              size="sm"
              leadingIcon={<Smartphone aria-hidden="true" className="h-3.5 w-3.5" />}
              onClick={props.onOpenPwaGuide}
            >
              查看添加到主屏幕步骤
            </AppButton>
          </div>
        </article>
      </div>
    </section>
  );
}

/* ─────────────────────────────────────────────────────────────
 * 5. 开源自托管与联系作者（#portal-open-source & #portal-contact）+ 页脚
 * ───────────────────────────────────────────────────────────── */

export interface PortalOpenSourceContactSectionProps {
  readonly isAuthenticatedWelcome: boolean;
  readonly onPrimaryAuthOrReturn: () => void;
}

/**
 * 开源自托管与联系作者分区（`#portal-open-source` & `#portal-contact`）。
 */
export function PortalOpenSourceContactSection(props: PortalOpenSourceContactSectionProps) {
  const [copiedCmd, setCopiedCmd] = useState<boolean>(false);
  const [copiedEmail, setCopiedEmail] = useState<boolean>(false);
  const cmdTimerRef = useRef<number | null>(null);
  const emailTimerRef = useRef<number | null>(null);

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
      toast.error("复制失败，请手动选中命令复制");
      return;
    }
    setCopiedCmd(true);
    toast.success("已复制快速启动命令");
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
      toast.error("复制失败，请手动复制邮箱地址");
      return;
    }
    setCopiedEmail(true);
    toast.success("已复制作者邮箱", { description: AUTHOR_CONTACT_EMAIL });
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
      <article
        className={cn(
          PORTAL_SURFACE_CARD_CLASS,
          "flex min-w-0 flex-col justify-between p-5 sm:p-6 lg:col-span-7",
        )}
      >
        <div>
          <p className="text-[12px] font-semibold tracking-wider text-[#5A6272] dark:text-[#8E8E96]">
            开源与私有化部署
          </p>
          <h2 className="mt-1.5 text-balance text-[20px] font-semibold leading-snug tracking-[-0.02em] text-[#111318] sm:text-[23px] dark:text-[#F2F2F4]">
            MIT 开源协议，几分钟内私有化部署
          </h2>
          <p className="mt-2 text-[13.5px] leading-relaxed text-[#525A6B] dark:text-[#A0A2AC]">
            群聊记录、决议、工作区配置与 Agent
            凭据都保存在你自己的服务器上。本地一条命令即可启动体验，无需另装数据库；正式部署用
            Docker Compose 一键拉起，一台 2 核 4G 云服务器即可稳定运行。
          </p>

          {/* 带一键复制的快速启动命令槽（暗色底严格 #141417） */}
          <div
            data-context-code={PORTAL_QUICK_START_COMMAND}
            className="mt-4 overflow-hidden rounded-[16px] border border-black/[0.07] bg-[#EFF1F4] dark:border-white/[0.08] dark:bg-[#141417]"
          >
            <div className="flex items-center justify-between gap-2 border-b border-black/[0.06] px-3.5 py-2 dark:border-white/[0.07]">
              <span className="inline-flex items-center gap-1.5 text-[11.5px] font-medium text-[#4B5565] dark:text-[#A1A1AA]">
                <Terminal aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
                <span>本地快速启动（Node.js &gt;= 22）</span>
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
                <span>{copiedCmd ? "已复制" : "复制命令"}</span>
              </button>
            </div>
            <pre className="overflow-x-auto px-3.5 py-3 font-mono text-[12px] leading-[1.65] text-[#181B22] dark:text-[#E4E4E7]">
              <code>{PORTAL_QUICK_START_COMMAND}</code>
            </pre>
          </div>
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-2.5">
          <a
            href={OPENHUDDLE_GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
            className={cn(appButtonVariants({ variant: "primary", size: "md" }))}
          >
            <span>查看 GitHub 仓库</span>
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
            {props.isAuthenticatedWelcome ? "返回工作台" : "回到顶部登录 / 注册"}
          </AppButton>
        </div>
      </article>

      {/* 右卡（5 列）：联系作者与问题反馈 */}
      <article
        id="portal-contact"
        className={cn(
          PORTAL_SURFACE_CARD_CLASS,
          "flex min-w-0 scroll-mt-20 flex-col justify-between p-5 sm:p-6 lg:col-span-5",
        )}
      >
        <div>
          <p className="text-[12px] font-semibold tracking-wider text-[#5A6272] dark:text-[#8E8E96]">
            联系作者
          </p>
          <h2 className="mt-1.5 text-balance text-[20px] font-semibold leading-snug tracking-[-0.02em] text-[#111318] sm:text-[23px] dark:text-[#F2F2F4]">
            联系作者与问题反馈
          </h2>
          <p className="mt-2 text-[13.5px] leading-relaxed text-[#525A6B] dark:text-[#A0A2AC]">
            如果你在私有化部署、个人 Agent 连通或日常多 Agent
            协作使用中遇到任何问题，或者有场景想法与改进建议，欢迎直接发邮件联系作者，每一封来信都会认真回复。
          </p>
        </div>

        {/* 作者邮箱专属交互卡（暗色底严格 #141417，支持右键菜单定向识别） */}
        <div
          data-context-kind="author-email"
          className="mt-5 rounded-[18px] border border-black/[0.07] bg-[#EFF1F4] p-4 dark:border-white/[0.08] dark:bg-[#141417]"
        >
          <p className="text-[11.5px] font-medium text-[#5A6272] dark:text-[#9898A2]">
            作者联系邮箱
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
              <span>写邮件联系</span>
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
              {copiedEmail ? "已复制" : "复制邮箱"}
            </AppButton>
          </div>
        </div>
      </article>
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
  return (
    <footer className="shrink-0 border-t border-black/[0.06] pt-6 pb-4 dark:border-white/[0.07]">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
        <div className="flex items-center gap-2 text-[12.5px] text-[#5A6272] dark:text-[#8E8E96]">
          <BrandMark className="h-5 w-5 shrink-0" />
          <span>OpenHuddle · 基于 MIT 协议开源</span>
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
            <span>回到顶部</span>
            <ArrowUp aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
          </button>
        </div>
      </div>
    </footer>
  );
}
