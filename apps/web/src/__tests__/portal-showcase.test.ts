/**
 * @module web/tests/portal-showcase
 * @description 验证首页产品门户（`/` 与 `/welcome`）的双态渲染、作者联系方式、
 * 全页单实例右键菜单目标分流、Liquid Glass 单层模糊光学不变量与零 Emoji 桌面软件品味门禁。
 */
import type { AgentId, UserId } from "@openhuddle/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppTooltipProvider, normalizeContextMenuEntries } from "../components/primitives/index.js";
import { AuthScreen } from "../features/auth-pairing/components/otp-sign-in-screen.js";
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
import type { HumanMeResponseDto } from "../lib/api-client.js";
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

  it("places selected text copy action at the very top when non-empty selection exists", () => {
    const onCopyText = vi.fn();
    const entries = normalizeContextMenuEntries(
      buildPortalContextMenuEntries(
        {
          ...DEFAULT_PORTAL_CONTEXT_HIT,
          selectedText: "PostgreSQL LISTEN/NOTIFY",
        },
        createMockActions({ onCopyText }),
      ),
    );

    const first = entries[0];
    expect(first?.id).toBe("ctx-portal-copy-selection");
    if (first && first.kind !== "separator" && first.kind !== "label" && first.kind !== "submenu") {
      first.onSelect();
    }
    expect(onCopyText).toHaveBeenCalledWith("PostgreSQL LISTEN/NOTIFY", "已复制选中文字");
  });

  it("exposes dedicated mailto & copy actions when right-clicking author email card without duplicate utility item", () => {
    const onOpenMailClient = vi.fn();
    const onCopyText = vi.fn();
    const entries = normalizeContextMenuEntries(
      buildPortalContextMenuEntries(
        {
          ...DEFAULT_PORTAL_CONTEXT_HIT,
          hitAuthorEmail: true,
        },
        createMockActions({ onOpenMailClient, onCopyText }),
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
      "已复制作者邮箱",
      AUTHOR_CONTACT_EMAIL,
    );
  });

  it("exposes external link and quick-start command actions when hitting corresponding targets", () => {
    const onOpenExternalLink = vi.fn();
    const onCopyText = vi.fn();
    const entries = normalizeContextMenuEntries(
      buildPortalContextMenuEntries(
        {
          ...DEFAULT_PORTAL_CONTEXT_HIT,
          externalLinkHref: OPENHUDDLE_GITHUB_URL,
          codeSnippet: PORTAL_QUICK_START_COMMAND,
        },
        createMockActions({ onOpenExternalLink, onCopyText }),
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
    expect(onCopyText).toHaveBeenCalledWith(PORTAL_QUICK_START_COMMAND, "已复制快速启动命令");
  });

  it("adapts primary navigation & theme labels for authenticated /welcome mode", () => {
    const entries = normalizeContextMenuEntries(
      buildPortalContextMenuEntries(
        DEFAULT_PORTAL_CONTEXT_HIT,
        createMockActions({ isAuthenticatedWelcome: true, isDarkTheme: false }),
      ),
    );

    const primaryNav = entries.find((e) => e.id === "ctx-portal-primary-nav");
    const themeToggle = entries.find((e) => e.id === "ctx-portal-toggle-theme");
    expect(primaryNav && "label" in primaryNav ? primaryNav.label : null).toBe("返回工作台");
    expect(themeToggle && "label" in themeToggle ? themeToggle.label : null).toBe("切换为夜间模式");
  });

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

describe("@openhuddle/web — portal SSR rendering & optical invariants", () => {
  it("renders guest AuthScreen with all 4 sections, 8 agent platforms, author email, and zero emojis", () => {
    const queryClient = new QueryClient();
    const html = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(AppTooltipProvider, null, createElement(AuthScreen, { portalMode: "auth" })),
      ),
    );

    expect(html).toContain("和你的多路 Agent 一起讨论、改码、拍板。");
    expect(html).toContain("多 Agent 群聊");
    expect(html).toContain("工作台协作与审阅");
    expect(html).toContain("也支持与 Agent 单聊、与好友私聊，Agent 能看图也能发图。");
    expect(html).toContain("欢迎回来");

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

  it("renders authenticated space card and return CTA when visiting /welcome while signed in", () => {
    const queryClient = new QueryClient();
    const mockMe: HumanMeResponseDto = {
      ok: true,
      callerKind: "human",
      user: {
        id: "usr_demo01" as UserId,
        email: "pangyan@example.com",
        displayName: "庞彦",
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
    queryClient.setQueryData(huddleQueryKeys.me(), mockMe);

    const html = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(
          AppTooltipProvider,
          null,
          createElement(AuthScreen, { portalMode: "welcome" }),
        ),
      ),
    );

    expect(html).toContain("返回工作台");
    expect(html).toContain("庞彦");
    expect(html).toContain("pangyan@example.com");
    expect(html).toContain("2 个已接入 · 1 个在线");
    expect(html).toContain("进入聊天会话");
    expect(html).toContain("打开个人工作台");
    expect(html).not.toContain("使用你的注册邮箱与密码登录 OpenHuddle 协作空间。");
  });

  it("keeps PortalHeroPreview free of nested backdrop-blur inside liquid-glass-modal", () => {
    const html = renderToStaticMarkup(createElement(PortalHeroPreview));
    expect(html).toContain("relative liquid-glass-modal");
    expect(html).not.toContain("backdrop-blur");
  });
});
