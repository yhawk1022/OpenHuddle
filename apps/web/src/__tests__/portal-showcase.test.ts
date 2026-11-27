/**
 * @module web/tests/portal-showcase
 * @description 验证首页产品门户（`/` 与 `/welcome`）在中英双语下的双态渲染、作者联系方式、
 * 全页单实例右键菜单（含语言切换子菜单）目标分流、Liquid Glass 单层模糊光学不变量与零 Emoji 桌面软件品味门禁。
 */
import type { AgentId, SupportedLocale, UserId } from "@openhuddle/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppTooltipProvider, normalizeContextMenuEntries } from "../components/primitives/index.js";
import { AuthScreen } from "../features/auth-pairing/components/otp-sign-in-screen.js";
import {
  PortalArchitectureSection,
  PortalCapabilitiesSection,
} from "../features/auth-pairing/components/portal-feature-sections.js";
import { splitTitleTokens } from "../features/auth-pairing/components/portal-reveal.js";
import {
  AUTHOR_CONTACT_EMAIL,
  DEFAULT_PORTAL_CONTEXT_HIT,
  OPENHUDDLE_GITHUB_URL,
  PORTAL_QUICK_START_COMMAND,
  type PortalContextMenuActions,
  PortalHeroPreview,
  buildPortalContextMenuEntries,
  copyPortalText,
  inspectPortalContextTarget,
} from "../features/auth-pairing/components/portal-showcase-sections.js";
import { PortalStorySection } from "../features/auth-pairing/components/portal-story-section.js";
import type { HumanMeResponseDto } from "../lib/api-client.js";
import { withLocale } from "../lib/i18n/index.js";
import { huddleQueryKeys } from "../lib/query-keys.js";

function createMockActions(
  overrides?: Partial<PortalContextMenuActions>,
): PortalContextMenuActions {
  return {
    isAuthenticatedWelcome: false,
    isDarkTheme: true,
    onCopyText: vi.fn(),
    onOpenMailClient: vi.fn(),
    onOpenExternalLink: vi.fn(),
    onPrimaryAuthOrReturn: vi.fn(),
    onScrollToPreview: vi.fn(),
    onScrollToCapabilities: vi.fn(),
    onToggleTheme: vi.fn(),
    onCopySiteUrl: vi.fn(),
    ...overrides,
  };
}

function createMockMe(displayName: string): HumanMeResponseDto {
  return {
    ok: true,
    callerKind: "human",
    user: {
      id: "usr_demo01" as UserId,
      email: "pangyan@example.com",
      displayName,
      role: "admin",
      status: "active",
      emailVerified: true,
      hasPassword: true,
      createdAtIso: "2026-11-25T00:00:00.000Z",
    },
    themePreference: "dark",
    agents: [
      {
        id: "agt_cc01" as AgentId,
        ownerUserId: "usr_demo01" as UserId,
        slug: "claude-code",
        displayName: "Claude Code",
        platform: "claude_code",
        reach: "online_sse",
        allowExternalDm: false,
        createdAtIso: "2026-11-25T00:00:00.000Z",
      },
      {
        id: "agt_cx02" as AgentId,
        ownerUserId: "usr_demo01" as UserId,
        slug: "codex",
        displayName: "Codex",
        platform: "codex",
        reach: "offline",
        allowExternalDm: false,
        createdAtIso: "2026-11-25T00:00:00.000Z",
      },
    ],
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("@openhuddle/web — portal context menu & target inspection", () => {
  it("pins the exact author contact email literal without typo", () => {
    expect(AUTHOR_CONTACT_EMAIL).toBe("impangyan@outlook.com");
  });

  it("returns empty entries on editable inputs so native browser editing & autofill menus are preserved", () => {
    const actions = createMockActions();
    const entries = buildPortalContextMenuEntries(
      {
        ...DEFAULT_PORTAL_CONTEXT_HIT,
        isEditableInput: true,
        selectedText: "secret",
      },
      actions,
    );
    expect(entries).toEqual([]);
  });

  it.each([
    { locale: "zh-CN" as SupportedLocale, expectedCopied: "已复制选中文字" },
    { locale: "en" as SupportedLocale, expectedCopied: "Selected text copied" },
  ])(
    "places selected text copy action at the very top when non-empty selection exists ($locale)",
    ({ locale, expectedCopied }) => {
      const onCopyText = vi.fn();
      const entries = normalizeContextMenuEntries(
        buildPortalContextMenuEntries(
          {
            ...DEFAULT_PORTAL_CONTEXT_HIT,
            selectedText: "PostgreSQL LISTEN/NOTIFY",
          },
          createMockActions({ locale, onCopyText }),
        ),
      );

      const first = entries[0];
      expect(first?.id).toBe("ctx-portal-copy-selection");
      if (
        first &&
        first.kind !== "separator" &&
        first.kind !== "label" &&
        first.kind !== "submenu"
      ) {
        first.onSelect();
      }
      expect(onCopyText).toHaveBeenCalledWith("PostgreSQL LISTEN/NOTIFY", expectedCopied);
    },
  );

  it.each([
    { locale: "zh-CN" as SupportedLocale, expectedCopied: "已复制作者邮箱" },
    { locale: "en" as SupportedLocale, expectedCopied: "Author email copied" },
  ])(
    "exposes dedicated mailto & copy actions when right-clicking author email card without duplicate utility item ($locale)",
    ({ locale, expectedCopied }) => {
      const onOpenMailClient = vi.fn();
      const onCopyText = vi.fn();
      const entries = normalizeContextMenuEntries(
        buildPortalContextMenuEntries(
          {
            ...DEFAULT_PORTAL_CONTEXT_HIT,
            hitAuthorEmail: true,
          },
          createMockActions({ locale, onOpenMailClient, onCopyText }),
        ),
      );

      const ids = entries.map((e) => e.id);
      expect(ids).toContain("ctx-portal-mail-author");
      expect(ids).toContain("ctx-portal-copy-author-email");
      expect(ids).not.toContain("ctx-portal-contact-copy");

      const mailItem = entries.find((e) => e.id === "ctx-portal-mail-author");
      if (
        mailItem &&
        mailItem.kind !== "separator" &&
        mailItem.kind !== "label" &&
        mailItem.kind !== "submenu"
      ) {
        mailItem.onSelect();
      }
      expect(onOpenMailClient).toHaveBeenCalledWith(AUTHOR_CONTACT_EMAIL);

      const copyItem = entries.find((e) => e.id === "ctx-portal-copy-author-email");
      if (
        copyItem &&
        copyItem.kind !== "separator" &&
        copyItem.kind !== "label" &&
        copyItem.kind !== "submenu"
      ) {
        copyItem.onSelect();
      }
      expect(onCopyText).toHaveBeenCalledWith(
        AUTHOR_CONTACT_EMAIL,
        expectedCopied,
        AUTHOR_CONTACT_EMAIL,
      );
    },
  );

  it.each([
    { locale: "zh-CN" as SupportedLocale, expectedCopied: "已复制快速启动命令" },
    { locale: "en" as SupportedLocale, expectedCopied: "Quick-start command copied" },
  ])(
    "exposes external link and quick-start command actions when hitting corresponding targets ($locale)",
    ({ locale, expectedCopied }) => {
      const onOpenExternalLink = vi.fn();
      const onCopyText = vi.fn();
      const entries = normalizeContextMenuEntries(
        buildPortalContextMenuEntries(
          {
            ...DEFAULT_PORTAL_CONTEXT_HIT,
            externalLinkHref: OPENHUDDLE_GITHUB_URL,
            codeSnippet: PORTAL_QUICK_START_COMMAND,
          },
          createMockActions({ locale, onOpenExternalLink, onCopyText }),
        ),
      );

      const ids = entries.map((e) => e.id);
      expect(ids).toContain("ctx-portal-open-link");
      expect(ids).toContain("ctx-portal-copy-link");
      expect(ids).toContain("ctx-portal-copy-code");

      const codeItem = entries.find((e) => e.id === "ctx-portal-copy-code");
      if (
        codeItem &&
        codeItem.kind !== "separator" &&
        codeItem.kind !== "label" &&
        codeItem.kind !== "submenu"
      ) {
        codeItem.onSelect();
      }
      expect(onCopyText).toHaveBeenCalledWith(PORTAL_QUICK_START_COMMAND, expectedCopied);
    },
  );

  it.each([
    {
      locale: "zh-CN" as SupportedLocale,
      expectedNav: "返回工作台",
      expectedTheme: "切换为夜间模式",
    },
    {
      locale: "en" as SupportedLocale,
      expectedNav: "Back to App",
      expectedTheme: "Switch to dark mode",
    },
  ])(
    "adapts primary navigation & theme labels for authenticated /welcome mode ($locale)",
    ({ locale, expectedNav, expectedTheme }) => {
      const entries = normalizeContextMenuEntries(
        buildPortalContextMenuEntries(
          DEFAULT_PORTAL_CONTEXT_HIT,
          createMockActions({ locale, isAuthenticatedWelcome: true, isDarkTheme: false }),
        ),
      );

      const primaryNav = entries.find((e) => e.id === "ctx-portal-primary-nav");
      const themeToggle = entries.find((e) => e.id === "ctx-portal-toggle-theme");
      expect(primaryNav && "label" in primaryNav ? primaryNav.label : null).toBe(expectedNav);
      expect(themeToggle && "label" in themeToggle ? themeToggle.label : null).toBe(expectedTheme);
    },
  );

  it.each([
    {
      locale: "zh-CN" as SupportedLocale,
      submenuLabel: "语言",
      autoLabel: "自动",
    },
    {
      locale: "en" as SupportedLocale,
      submenuLabel: "Language",
      autoLabel: "Auto",
    },
  ])(
    "exposes a Language submenu with Auto and native autonyms ($locale)",
    ({ locale, submenuLabel, autoLabel }) => {
      const onSelectLanguage = vi.fn();
      const entries = normalizeContextMenuEntries(
        buildPortalContextMenuEntries(
          DEFAULT_PORTAL_CONTEXT_HIT,
          createMockActions({
            locale,
            languagePreference: "auto",
            onSelectLanguage,
          }),
        ),
      );

      const langSubmenu = entries.find((e) => e.id === "ctx-portal-language");
      expect(langSubmenu?.kind).toBe("submenu");
      if (langSubmenu?.kind !== "submenu") {
        throw new Error("Expected language submenu");
      }
      expect(langSubmenu.label).toBe(submenuLabel);
      expect(langSubmenu.items.map((item) => ("label" in item ? item.label : null))).toEqual([
        autoLabel,
        "简体中文",
        "English",
      ]);

      const enItem = langSubmenu.items.find((item) => item.id === "ctx-portal-lang-en");
      if (
        enItem &&
        enItem.kind !== "separator" &&
        enItem.kind !== "label" &&
        enItem.kind !== "submenu"
      ) {
        enItem.onSelect();
      }
      expect(onSelectLanguage).toHaveBeenCalledWith("en");
    },
  );

  it("handles null EventTarget safely with explicit selection text", () => {
    const hit = inspectPortalContextTarget(null, "  OpenHuddle  ");
    expect(hit).toEqual({
      isEditableInput: false,
      selectedText: "OpenHuddle",
      hitAuthorEmail: false,
      externalLinkHref: null,
      codeSnippet: null,
    });
  });

  it("short-circuits editable controls and resolves Element/TextNode context targets accurately", () => {
    class MockElement extends EventTarget {
      readonly matchedSelectors: Record<string, MockElement | null>;
      readonly attrs: Record<string, string>;

      constructor(
        matchedSelectors: Record<string, MockElement | null> = {},
        attrs: Record<string, string> = {},
      ) {
        super();
        this.matchedSelectors = matchedSelectors;
        this.attrs = attrs;
      }

      closest(selector: string): MockElement | null {
        return this.matchedSelectors[selector] ?? null;
      }

      getAttribute(name: string): string | null {
        return this.attrs[name] ?? null;
      }
    }
    vi.stubGlobal("Element", MockElement);

    const inputEl = new MockElement({
      'input, textarea, select, [contenteditable="true"], [contenteditable=""]': new MockElement(),
      '[data-context-kind="author-email"]': new MockElement(),
    });
    expect(inspectPortalContextTarget(inputEl, "otp-123456")).toEqual({
      isEditableInput: true,
      selectedText: "otp-123456",
      hitAuthorEmail: false,
      externalLinkHref: null,
      codeSnippet: null,
    });

    const anchorEl = new MockElement({}, { href: OPENHUDDLE_GITHUB_URL });
    const codeEl = new MockElement({}, { "data-context-code": PORTAL_QUICK_START_COMMAND });
    const emailCardEl = new MockElement({
      '[data-context-kind="author-email"]': new MockElement(),
      "a[href]": anchorEl,
      "[data-context-code]": codeEl,
    });
    const textNodeLike = Object.assign(new EventTarget(), { parentElement: emailCardEl });
    expect(inspectPortalContextTarget(textNodeLike, "")).toEqual({
      isEditableInput: false,
      selectedText: "",
      hitAuthorEmail: true,
      externalLinkHref: OPENHUDDLE_GITHUB_URL,
      codeSnippet: PORTAL_QUICK_START_COMMAND,
    });
  });

  it("copies text via Clipboard API and falls back cleanly when clipboard rejects or is unavailable", async () => {
    const writeTextOk = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText: writeTextOk } });
    await expect(copyPortalText("impangyan@outlook.com")).resolves.toBe(true);
    expect(writeTextOk).toHaveBeenCalledWith("impangyan@outlook.com");

    const writeTextFail = vi.fn().mockRejectedValue(new Error("NotAllowedError"));
    let appendedCount = 0;
    let removedCount = 0;
    const mockTextarea = {
      value: "",
      style: {} as Record<string, string>,
      setAttribute: vi.fn(),
      select: vi.fn(),
    };
    vi.stubGlobal("navigator", { clipboard: { writeText: writeTextFail } });
    vi.stubGlobal("document", {
      createElement: () => mockTextarea,
      body: {
        appendChild: () => {
          appendedCount += 1;
        },
        removeChild: () => {
          removedCount += 1;
        },
      },
      execCommand: (cmd: string) => cmd === "copy",
    });
    await expect(copyPortalText("impangyan@outlook.com")).resolves.toBe(true);
    expect(appendedCount).toBe(1);
    expect(removedCount).toBe(1);

    vi.unstubAllGlobals();
    vi.stubGlobal("navigator", {});
    await expect(copyPortalText("impangyan@outlook.com")).resolves.toBe(false);
  });
});

describe("@openhuddle/web — portal SSR rendering & optical invariants (zh-CN & en)", () => {
  it("renders guest AuthScreen in zh-CN with all sections, 8 platforms, LocaleSwitcherMenu, author email, and zero emojis", () => {
    const queryClient = new QueryClient();
    const html = withLocale("zh-CN", () =>
      renderToStaticMarkup(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(
            AppTooltipProvider,
            null,
            createElement(AuthScreen, { portalMode: "auth" }),
          ),
        ),
      ),
    );

    expect(html).toContain("和你的多路 Agent 一起讨论、改码、拍板。");
    expect(html).toContain("多 Agent 群聊");
    expect(html).toContain("工作台协作与审阅");
    expect(html).toContain("也支持与 Agent 单聊、与好友私聊，Agent 能看图也能发图。");
    expect(html).toContain("欢迎回来");
    expect(html).toContain("切换界面语言");

    for (const platformName of [
      "Claude Code",
      "Codex",
      "Cursor",
      "Antigravity",
      "Gemini",
      "OpenClaw",
      "DeepSeek",
      "ChatGPT",
    ]) {
      expect(html).toContain(platformName);
    }

    for (const topo of ["单人执行", "双人复核", "多路并行"]) {
      expect(html).toContain(topo);
    }

    expect(html).toContain(AUTHOR_CONTACT_EMAIL);
    expect(html).toContain(`mailto:${AUTHOR_CONTACT_EMAIL}`);
    expect(html).toContain(OPENHUDDLE_GITHUB_URL);
    expect(html).toContain('id="portal-hero"');
    expect(html).toContain('id="portal-preview"');
    expect(html).toContain('id="portal-story"');
    expect(html).toContain('id="portal-capabilities"');
    expect(html).toContain('id="portal-architecture"');
    expect(html).toContain('id="portal-open-source"');
    expect(html).toContain('id="portal-contact"');

    // 顶栏内部禁止挂载任何 liquid-glass-* 类名
    const headerMatch = /<header[^>]*>([\s\S]*?)<\/header>/.exec(html);
    expect(headerMatch?.[1]).toBeDefined();
    expect(headerMatch?.[1]).not.toContain("liquid-glass-");

    // 去 AI 味品味门禁：零 Emoji 表情字符
    expect(/\p{Extended_Pictographic}/u.test(html)).toBe(false);
  });

  it("renders guest AuthScreen in English with concise terminology, zero CJK leaks, author email, and zero emojis", () => {
    const queryClient = new QueryClient();
    const html = withLocale("en", () =>
      renderToStaticMarkup(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(
            AppTooltipProvider,
            null,
            createElement(AuthScreen, { portalMode: "auth" }),
          ),
        ),
      ),
    );

    expect(html).toContain("Discuss, ship code, and decide—with all your agents.");
    expect(html).toContain("Features");
    expect(html).toContain("Performance");
    expect(html).toContain("Open Source");
    expect(html).toContain("Agent Huddle");
    expect(html).toContain("Workbench");
    expect(html).toContain("Welcome back");
    expect(html).toContain("Sign in");
    expect(html).toContain("Sign up");
    expect(html).toContain("Switch interface language");

    for (const topo of ["Solo run", "Dual review", "Parallel"]) {
      expect(html).toContain(topo);
    }

    expect(html).toContain(AUTHOR_CONTACT_EMAIL);
    expect(html).toContain(`mailto:${AUTHOR_CONTACT_EMAIL}`);
    expect(html).toContain(OPENHUDDLE_GITHUB_URL);

    // 英文模式下零残留汉字
    expect(/\p{Script=Han}/u.test(html)).toBe(false);

    // 顶栏内部禁止挂载任何 liquid-glass-* 类名
    const headerMatch = /<header[^>]*>([\s\S]*?)<\/header>/.exec(html);
    expect(headerMatch?.[1]).toBeDefined();
    expect(headerMatch?.[1]).not.toContain("liquid-glass-");

    // 去 AI 味品味门禁：零 Emoji 表情字符
    expect(/\p{Extended_Pictographic}/u.test(html)).toBe(false);
  });

  it("renders authenticated space card and return CTA when visiting /welcome while signed in (zh-CN & en)", () => {
    const zhClient = new QueryClient();
    zhClient.setQueryData(huddleQueryKeys.me(), createMockMe("庞彦"));
    const zhHtml = withLocale("zh-CN", () =>
      renderToStaticMarkup(
        createElement(
          QueryClientProvider,
          { client: zhClient },
          createElement(
            AppTooltipProvider,
            null,
            createElement(AuthScreen, { portalMode: "welcome" }),
          ),
        ),
      ),
    );

    expect(zhHtml).toContain("返回工作台");
    expect(zhHtml).toContain("庞彦");
    expect(zhHtml).toContain("pangyan@example.com");
    expect(zhHtml).toContain("2 个已接入 · 1 个在线");
    expect(zhHtml).toContain("进入聊天会话");
    expect(zhHtml).toContain("打开个人工作台");
    expect(zhHtml).toContain("外观、语言与显示设置");
    expect(zhHtml).not.toContain("切换界面语言");
    expect(zhHtml).not.toContain("使用你的注册邮箱与密码登录 OpenHuddle 协作空间。");

    const enClient = new QueryClient();
    enClient.setQueryData(huddleQueryKeys.me(), createMockMe("Alex"));
    const enHtml = withLocale("en", () =>
      renderToStaticMarkup(
        createElement(
          QueryClientProvider,
          { client: enClient },
          createElement(
            AppTooltipProvider,
            null,
            createElement(AuthScreen, { portalMode: "welcome" }),
          ),
        ),
      ),
    );

    expect(enHtml).toContain("Back to App");
    expect(enHtml).toContain("Alex");
    expect(enHtml).toContain("pangyan@example.com");
    expect(enHtml).toContain("2 connected · 1 online");
    expect(enHtml).toContain("Open Chats");
    expect(enHtml).toContain("Open Workbench");
    expect(enHtml).toContain("Appearance, language &amp; display");
    expect(enHtml).not.toContain("Switch interface language");
    expect(/\p{Script=Han}/u.test(enHtml)).toBe(false);
  });

  it("keeps PortalHeroPreview free of nested backdrop-blur inside liquid-glass-modal (zh-CN & en)", () => {
    for (const locale of ["zh-CN", "en"] as const) {
      const html = withLocale(locale, () => renderToStaticMarkup(createElement(PortalHeroPreview)));
      expect(html).toContain("relative liquid-glass-modal");
      expect(html).not.toContain("backdrop-blur");
    }
  });
});

describe("@openhuddle/web — portal scrollytelling & visual cards", () => {
  it("renders the story stage in zh-CN and en with four beats, a single liquid-glass layer, and zero Han leaks in en", () => {
    const zhHtml = withLocale("zh-CN", () =>
      renderToStaticMarkup(createElement(PortalStorySection)),
    );

    expect(zhHtml).toContain('id="portal-story"');
    for (const title of [
      "一句指令，进群。",
      "各抒己见，不抢话。",
      "越聊，越清楚。",
      "最后，你说了算。",
    ]) {
      expect(zhHtml).toContain(title);
    }
    expect(zhHtml.match(/liquid-glass-modal/g)).toHaveLength(1);
    expect(zhHtml).not.toContain("backdrop-blur");
    expect(zhHtml).toMatch(/aria-hidden="true" class="[^"]*relative liquid-glass-modal/);
    expect(zhHtml).not.toMatch(/animate-(bounce|spin|pulse|ping)/);

    const enHtml = withLocale("en", () => renderToStaticMarkup(createElement(PortalStorySection)));

    expect(enHtml).toContain('id="portal-story"');
    for (const title of [
      "One prompt, into the room.",
      "Every voice heard, in order.",
      "Noise turns into clear options.",
      "In the end, you decide.",
    ]) {
      expect(enHtml).toContain(title);
    }
    expect(enHtml.match(/liquid-glass-modal/g)).toHaveLength(1);
    expect(enHtml).not.toContain("backdrop-blur");
    expect(/\p{Script=Han}/u.test(enHtml)).toBe(false);
  });

  it("splits titles into tokens that keep Latin words whole and attach punctuation to the previous token", () => {
    expect(splitTitleTokens("从连通 Agent 到群聊拍板，该干的干。")).toEqual([
      "从",
      "连",
      "通",
      " ",
      "Agent",
      " ",
      "到",
      "群",
      "聊",
      "拍",
      "板，",
      "该",
      "干",
      "的",
      "干。",
    ]);
    // 还原后必须与原文逐字一致（逐字上浮不能吞掉或改写任何字符）
    const zhTitle = "快，而且稳。120 Hz 高刷适配。";
    expect(splitTitleTokens(zhTitle).join("")).toBe(zhTitle);
    const enTitle = "Fast, and resilient. 120 Hz motion.";
    expect(splitTitleTokens(enTitle).join("")).toBe(enTitle);
  });

  it("renders ten illustrated capability cards and four stat tiles in zh-CN and en without nested backdrop-blur or Han leaks", () => {
    const zhCapabilities = withLocale("zh-CN", () =>
      renderToStaticMarkup(createElement(PortalCapabilitiesSection)),
    );

    expect(zhCapabilities).toContain('id="portal-capabilities"');
    expect(zhCapabilities.match(/<article/g)).toHaveLength(10);
    // 每张卡片顶部都有一幅对读屏器隐藏的示意图
    expect(zhCapabilities.match(/aria-hidden="true" class="[^"]*h-40/g)).toHaveLength(10);
    expect(zhCapabilities).not.toContain("backdrop-blur");
    for (const topo of ["单人执行", "双人复核", "多路并行"]) {
      expect(zhCapabilities).toContain(topo);
    }

    const zhArchitecture = withLocale("zh-CN", () =>
      renderToStaticMarkup(createElement(PortalArchitectureSection, { onOpenPwaGuide: vi.fn() })),
    );
    expect(zhArchitecture).toContain('id="portal-architecture"');
    expect(zhArchitecture.match(/<article/g)).toHaveLength(2);
    expect(zhArchitecture).not.toContain("backdrop-blur");
    for (const stat of ["秒级", "分钟", "Hz", "遗漏"]) {
      expect(zhArchitecture).toContain(stat);
    }

    const enCapabilities = withLocale("en", () =>
      renderToStaticMarkup(createElement(PortalCapabilitiesSection)),
    );
    expect(enCapabilities.match(/<article/g)).toHaveLength(10);
    expect(enCapabilities).not.toContain("backdrop-blur");
    for (const topo of ["Solo run", "Dual review", "Parallel"]) {
      expect(enCapabilities).toContain(topo);
    }
    expect(/\p{Script=Han}/u.test(enCapabilities)).toBe(false);

    const enArchitecture = withLocale("en", () =>
      renderToStaticMarkup(createElement(PortalArchitectureSection, { onOpenPwaGuide: vi.fn() })),
    );
    expect(enArchitecture.match(/<article/g)).toHaveLength(2);
    expect(enArchitecture).not.toContain("backdrop-blur");
    for (const stat of ["&lt;1s", "min", "Hz", "lost"]) {
      expect(enArchitecture).toContain(stat);
    }
    expect(/\p{Script=Han}/u.test(enArchitecture)).toBe(false);
  });
});
