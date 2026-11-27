/**
 * @module web/__tests__/i18n-store
 * @description Web 端 i18n 运行时全链路单测：
 * 1. `resolveLocale` Rule L 全量 11+ 组真值表与扩展段/非浏览器边界；
 * 2. 双槽 `localStorage` 隔离、登出清理、`<html lang>` / `<title>` 同步与跨标签事件；
 * 3. `withLocale` + `renderToStaticMarkup` 兼容、`defineCatalog`/`definePluralCatalog` 插值与复数；
 * 4. 全部 `ErrorCode` 双语翻译、`Accept-Language` 头透传、`format.ts` 双语输出与 `useAccountLanguagePreference` 乐观更新/竞态守卫。
 */
import {
  type AgentId,
  ErrorCodeSchema,
  HumanUserDtoSchema,
  type MessageDto,
  type RoomId,
  type UserId,
  asMessageSeq,
} from "@openhuddle/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DropdownMenu } from "radix-ui";
import { createElement } from "react";
import { renderToStaticMarkup, renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppTooltipProvider } from "../components/primitives/index.js";
import {
  AccountSecurityModal,
  AccountThemeMenu,
  LocaleMenuGroup,
  LocaleSwitcherMenu,
  currentMeQueryOptions,
  useAccountLanguagePreference,
  useLogoutMutation,
} from "../features/auth-pairing/index.js";
import { type HumanMeResponseDto, requestApiJson } from "../lib/api-client.js";
import {
  formatMessageTimestamp,
  getMessageSnippet,
  getPlatformVisualMeta,
  getReachVisualMeta,
} from "../lib/format.js";
import {
  GUEST_LANGUAGE_STORAGE_KEY,
  LAST_ACCOUNT_LANGUAGE_STORAGE_KEY,
  clearLastAccountLanguagePreference,
  createScopedTranslator,
  defineCatalog,
  definePluralCatalog,
  formatApiErrorMessage,
  formatCompactDuration,
  getActiveLocale,
  interpolate,
  readGuestLanguagePreference,
  readLastAccountLanguagePreference,
  resolveAppRootLanguagePreference,
  resolveLocale,
  setActiveLocaleForTest,
  setGuestLanguagePreference,
  setLastAccountLanguagePreference,
  startLocaleSync,
  syncDocumentTitle,
  useLocale,
  withLocale,
} from "../lib/i18n/index.js";
import { setStoredSessionToken } from "../lib/session-store.js";

let stopLocaleSync: (() => void) | undefined;

function createMockBrowser(options?: {
  readonly pathname?: string;
  readonly languages?: ReadonlyArray<string>;
  readonly language?: string;
}) {
  const storage = new Map<string, string>();
  let pathname = options?.pathname ?? "/";
  const browserWindow = Object.assign(new EventTarget(), {
    location: {
      get pathname() {
        return pathname;
      },
      set pathname(next: string) {
        pathname = next;
      },
      search: "",
      hash: "",
    },
    history: {
      replaceState: vi.fn((_state: unknown, _title: string, to: string) => {
        pathname = to;
      }),
    },
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
      removeItem: (key: string) => {
        storage.delete(key);
      },
    },
  });

  const browserDocument = Object.assign(new EventTarget(), {
    title: "",
    visibilityState: "visible",
    documentElement: {
      lang: "en",
    },
  });

  const browserNavigator = {
    languages: options?.languages ?? ["en-US"],
    language: options?.language ?? options?.languages?.[0] ?? "en-US",
  };

  vi.stubGlobal("window", browserWindow);
  vi.stubGlobal("document", browserDocument);
  vi.stubGlobal("navigator", browserNavigator);

  return { storage, browserWindow, browserDocument, browserNavigator };
}

afterEach(() => {
  stopLocaleSync?.();
  stopLocaleSync = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  setActiveLocaleForTest("en");
});

describe("resolveLocale — Rule L truth table", () => {
  it.each([
    {
      name: "1. explicit zh-CN overrides English browser",
      pref: "zh-CN" as const,
      env: { languages: ["en-US"], timeZone: "America/New_York" },
      expected: "zh-CN" as const,
    },
    {
      name: "2. explicit en overrides Chinese browser",
      pref: "en" as const,
      env: { languages: ["zh-CN"], timeZone: "Asia/Shanghai" },
      expected: "en" as const,
    },
    {
      name: "3. strong counterexample: ['en-US', 'zh-CN'] + Asia/Shanghai resolves to en",
      pref: "auto" as const,
      env: { languages: ["en-US", "zh-CN"], timeZone: "Asia/Shanghai" },
      expected: "en" as const,
    },
    {
      name: "4. en-CN + Asia/Shanghai respects English primary language over CN region",
      pref: "auto" as const,
      env: { languages: ["en-CN"], timeZone: "Asia/Shanghai" },
      expected: "en" as const,
    },
    {
      name: "5. zh-TW resolves to zh-CN",
      pref: "auto" as const,
      env: { languages: ["zh-TW"], timeZone: "UTC" },
      expected: "zh-CN" as const,
    },
    {
      name: "6. zh-SG resolves to zh-CN",
      pref: "auto" as const,
      env: { languages: ["zh-SG"], timeZone: "Asia/Singapore" },
      expected: "zh-CN" as const,
    },
    {
      name: "7. yue-Hant-HK Chinese macrolanguage variant resolves to zh-CN",
      pref: "auto" as const,
      env: { languages: ["yue-Hant-HK"], timeZone: "UTC" },
      expected: "zh-CN" as const,
    },
    {
      name: "8. bo-CN unsupported language falls back to CN region subtag -> zh-CN",
      pref: "auto" as const,
      env: { languages: ["bo-CN"], timeZone: "UTC" },
      expected: "zh-CN" as const,
    },
    {
      name: "9. unsupported language skips -u-/-x- extension subtags before region check",
      pref: "auto" as const,
      env: { languages: ["fr-x-cn", "ja-u-rg-cnzzzz"], timeZone: "UTC" },
      expected: "en" as const,
    },
    {
      name: "10. empty languages + Asia/Shanghai timezone falls back to zh-CN",
      pref: "auto" as const,
      env: { languages: [], timeZone: "Asia/Shanghai" },
      expected: "zh-CN" as const,
    },
    {
      name: "11. empty languages + UTC timezone falls back to en",
      pref: "auto" as const,
      env: { languages: [], timeZone: "UTC" },
      expected: "en" as const,
    },
    {
      name: "12. SSR / Node (isBrowser: false) deterministically resolves to en",
      pref: "auto" as const,
      env: { isBrowser: false, languages: ["zh-CN"], timeZone: "Asia/Shanghai" },
      expected: "en" as const,
    },
    {
      name: "13. unsupported primary continues scanning secondary supported language",
      pref: "auto" as const,
      env: { languages: ["ja-JP", "zh-Hans-CN"], timeZone: "Asia/Tokyo" },
      expected: "zh-CN" as const,
    },
    {
      name: "14. falls back to Intl locale when navigator languages have no supported match",
      pref: "auto" as const,
      env: { languages: ["ko-KR"], intlLocale: "zh-HK", timeZone: "UTC" },
      expected: "zh-CN" as const,
    },
  ])("$name", ({ pref, env, expected }) => {
    expect(resolveLocale(pref, env)).toBe(expected);
  });

  it("returns deterministic 'en' in Node when window is undefined and env is omitted", () => {
    expect(resolveLocale("auto")).toBe("en");
  });
});

describe("dual-slot storage, locale sync, and logout cleanup", () => {
  it("isolates guest preference slot from account cache slot and clears only account slot on logout", async () => {
    const { storage } = createMockBrowser({ languages: ["en-US"] });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ ok: true })));

    setGuestLanguagePreference("en");
    setStoredSessionToken("tok_session_1234567890");
    setLastAccountLanguagePreference("zh-CN");

    expect(storage.get(GUEST_LANGUAGE_STORAGE_KEY)).toBe("en");
    expect(storage.get(LAST_ACCOUNT_LANGUAGE_STORAGE_KEY)).toBe("zh-CN");
    expect(readGuestLanguagePreference()).toBe("en");
    expect(readLastAccountLanguagePreference()).toBe("zh-CN");

    const queryClient = new QueryClient();
    let triggerLogout: ReturnType<typeof useLogoutMutation>["mutateAsync"] | undefined;
    function LogoutProbe() {
      triggerLogout = useLogoutMutation().mutateAsync;
      return null;
    }
    renderToString(
      createElement(QueryClientProvider, { client: queryClient }, createElement(LogoutProbe)),
    );
    await triggerLogout?.();

    expect(readLastAccountLanguagePreference()).toBeNull();
    expect(storage.has(LAST_ACCOUNT_LANGUAGE_STORAGE_KEY)).toBe(false);
    expect(readGuestLanguagePreference()).toBe("en");
    expect(storage.get(GUEST_LANGUAGE_STORAGE_KEY)).toBe("en");

    // Manual clear API keeps guest slot intact
    setLastAccountLanguagePreference("zh-CN");
    clearLastAccountLanguagePreference();
    expect(readLastAccountLanguagePreference()).toBeNull();
    expect(readGuestLanguagePreference()).toBe("en");
  });

  it("synchronizes <html lang> and reacts to languagechange, visibilitychange, pageshow, and cleanup", () => {
    const { browserWindow, browserDocument, browserNavigator } = createMockBrowser({
      languages: ["en-US"],
    });

    stopLocaleSync = startLocaleSync("auto");
    expect(getActiveLocale()).toBe("en");
    expect(browserDocument.documentElement.lang).toBe("en");

    browserNavigator.languages = ["zh-CN"];
    browserWindow.dispatchEvent(new Event("languagechange"));
    expect(getActiveLocale()).toBe("zh-CN");
    expect(browserDocument.documentElement.lang).toBe("zh-CN");

    browserNavigator.languages = ["en-GB"];
    browserDocument.visibilityState = "visible";
    browserDocument.dispatchEvent(new Event("visibilitychange"));
    expect(getActiveLocale()).toBe("en");
    expect(browserDocument.documentElement.lang).toBe("en");

    browserNavigator.languages = ["zh-TW"];
    browserWindow.dispatchEvent(new Event("pageshow"));
    expect(getActiveLocale()).toBe("zh-CN");
    expect(browserDocument.documentElement.lang).toBe("zh-CN");

    // Cleanup detaches all listeners
    stopLocaleSync();
    stopLocaleSync = undefined;
    browserNavigator.languages = ["en-US"];
    browserWindow.dispatchEvent(new Event("languagechange"));
    expect(getActiveLocale()).toBe("zh-CN");
  });

  it("skips overwriting document.title on /share/ routes to protect server OG title", () => {
    const { browserDocument, browserWindow } = createMockBrowser({ pathname: "/" });
    syncDocumentTitle("OpenHuddle — Multi-Agent Huddle & Collaboration Workbench");
    expect(browserDocument.title).toBe("OpenHuddle — Multi-Agent Huddle & Collaboration Workbench");

    browserWindow.location.pathname = "/share/inv_public_room";
    browserDocument.title = "Server Injected Share OG Title";
    syncDocumentTitle("Should Not Overwrite");
    expect(browserDocument.title).toBe("Server Injected Share OG Title");
  });
});

describe("withLocale, renderToStaticMarkup, catalog interpolation, and plurals", () => {
  it("renders locale-aware React components via renderToStaticMarkup and restores locale on error", () => {
    function LocaleProbe() {
      return createElement("span", null, `locale:${useLocale()}`);
    }

    setActiveLocaleForTest("en");
    expect(renderToStaticMarkup(createElement(LocaleProbe))).toBe("<span>locale:en</span>");
    expect(withLocale("zh-CN", () => renderToStaticMarkup(createElement(LocaleProbe)))).toBe(
      "<span>locale:zh-CN</span>",
    );
    expect(getActiveLocale()).toBe("en");

    expect(() =>
      withLocale("zh-CN", () => {
        expect(getActiveLocale()).toBe("zh-CN");
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(getActiveLocale()).toBe("en");
  });

  it("renders LocaleSwitcherMenu, LocaleMenuGroup, AccountThemeMenu, and AccountSecurityModal cleanly in both locales", () => {
    const queryClient = new QueryClient();
    const user = HumanUserDtoSchema.parse({
      id: "usr_i18n_01",
      email: "tester@openhuddle.dev",
      displayName: "Tester",
      role: "admin",
      status: "active",
      emailVerified: true,
      hasPassword: true,
      createdAtIso: "2026-11-26T00:00:00.000Z",
    });
    const me: HumanMeResponseDto = {
      ok: true,
      callerKind: "human",
      user,
      themePreference: "dark",
      languagePreference: "auto",
      agents: [],
    };
    queryClient.setQueryData(currentMeQueryOptions().queryKey, me);

    const renderSettings = (resolved: "zh-CN" | "en") =>
      renderToStaticMarkup(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(
            AppTooltipProvider,
            null,
            createElement(
              "div",
              null,
              createElement(LocaleSwitcherMenu, {}),
              createElement(AccountThemeMenu, { side: "right", align: "end" }),
              createElement(
                DropdownMenu.Root,
                { open: true },
                createElement(
                  DropdownMenu.Content,
                  { forceMount: true },
                  createElement(LocaleMenuGroup, {
                    preference: "auto",
                    resolvedLocale: resolved,
                    onSelect: () => {},
                  }),
                ),
              ),
              createElement(AccountSecurityModal, {
                open: true,
                currentUser: user,
                onClose: () => {},
              }),
            ),
          ),
        ),
      );

    const zhHtml = withLocale("zh-CN", () => renderSettings("zh-CN"));
    expect(zhHtml).toContain("切换界面语言");
    expect(zhHtml).toContain("外观、语言与显示设置");
    expect(zhHtml).toContain("界面语言");
    expect(zhHtml).toContain("自动");
    expect(zhHtml).toContain("当前：简体中文");
    expect(zhHtml).toContain("简体中文");
    expect(zhHtml).toContain("English");
    expect(zhHtml).toContain('role="menuitemradio"');

    const enHtml = withLocale("en", () => renderSettings("en"));
    expect(enHtml).toContain("Switch interface language");
    expect(enHtml).toContain("Appearance, language &amp; display");
    expect(enHtml).toContain("Language");
    expect(enHtml).toContain("Auto");
    expect(enHtml).toContain("Current: English");
    expect(enHtml).toContain("简体中文");
    expect(enHtml).toContain("English");
    expect(enHtml).toContain('role="menuitemradio"');
  });

  it("supports defineCatalog, definePluralCatalog, stable translator references, and safe interpolation", () => {
    const catalog = defineCatalog(
      {
        greeting: "你好，{name}",
        plain: "确定",
      },
      {
        greeting: "Hello, {name}",
        plain: "Confirm",
      },
    );
    const plurals = definePluralCatalog(
      {
        members: { other: "{count} 位成员（{room}）" },
      },
      {
        members: { one: "1 member ({room})", other: "{count} members ({room})" },
      },
    );
    const scoped = createScopedTranslator(catalog, plurals);

    const en1 = scoped.getTranslator("en");
    const en2 = scoped.getTranslator("en");
    expect(en1).toBe(en2);
    expect(en1.t).toBe(en2.t);
    expect(en1.tp).toBe(en2.tp);

    expect(en1.t("greeting", { name: "Ada" })).toBe("Hello, Ada");
    expect(en1.t("plain")).toBe("Confirm");
    expect(en1.tp("members", 1, { room: "Core" })).toBe("1 member (Core)");
    expect(en1.tp("members", 3, { room: "Core" })).toBe("3 members (Core)");

    const zh = scoped.getTranslator("zh-CN");
    expect(zh.t("greeting", { name: "庞彦" })).toBe("你好，庞彦");
    expect(zh.tp("members", 1, { room: "架构组" })).toBe("1 位成员（架构组）");

    // Prototype-safe & missing key preservation
    expect(interpolate("keep {missing} and {toString}", { other: "x" })).toBe(
      "keep {missing} and {toString}",
    );
  });
});

describe("error catalog, Accept-Language header, formatters, and optimistic account language hook", () => {
  it("translates every protocol ErrorCode in both zh-CN and en", () => {
    for (const code of ErrorCodeSchema.options) {
      const zh = formatApiErrorMessage(code, undefined, "zh-CN");
      const en = formatApiErrorMessage(code, undefined, "en");
      expect(zh.length).toBeGreaterThan(0);
      expect(en.length).toBeGreaterThan(0);
      expect(zh).not.toBe(en);
    }
  });

  it("attaches Accept-Language header and localized transport errors in requestApiJson", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await withLocale("zh-CN", () => requestApiJson("/api/v1/health"));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/health",
      expect.objectContaining({
        headers: expect.objectContaining({
          "Accept-Language": "zh-CN",
        }),
      }),
    );

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 503 })));
    setActiveLocaleForTest("en");
    await expect(requestApiJson("/api/v1/health")).rejects.toMatchObject({
      statusCode: 503,
      requestId: "gateway",
      message: expect.stringContaining("temporarily unavailable"),
    });
    setActiveLocaleForTest("zh-CN");
    await expect(requestApiJson("/api/v1/health")).rejects.toMatchObject({
      statusCode: 503,
      requestId: "gateway",
      message: expect.stringContaining("正在重启"),
    });
  });

  it("formats timestamps, snippets, platform hints, reach states, and durations per locale", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 27, 14, 30, 0));

    const sameDayIso = new Date(2026, 10, 27, 9, 5, 0).toISOString();
    expect(formatMessageTimestamp(sameDayIso, "zh-CN")).toBe("09:05");
    expect(formatMessageTimestamp(sameDayIso, "en")).toBe("09:05");

    const priorDayIso = new Date(2026, 10, 20, 8, 15, 0).toISOString();
    expect(formatMessageTimestamp(priorDayIso, "zh-CN")).toBe("11-20 08:15");
    expect(formatMessageTimestamp(priorDayIso, "en")).toBe("Nov 20, 08:15");

    const sampleImageMsg: MessageDto = {
      roomId: "rom_fmt_01" as RoomId,
      seq: asMessageSeq(1),
      type: "text",
      author: {
        kind: "agent",
        agentId: "agt_fmt_01" as AgentId,
        ownerUserId: "usr_fmt_01" as UserId,
        displayName: "Codex",
        platform: "codex",
        isYou: false,
        isYourOwner: true,
        trustLevel: "owner_sibling_agent",
      },
      content: "Check latency",
      attachment: { mimeType: "image/png", byteLength: 1024 },
      mentions: [],
      createdAtIso: sameDayIso,
    };

    expect(getMessageSnippet(sampleImageMsg, 80, "zh-CN")).toBe("[图片] Check latency");
    expect(getMessageSnippet(sampleImageMsg, 80, "en")).toBe("[Image] Check latency");
    expect(getPlatformVisualMeta("codex", "en").cliHint).toContain("Codex");
    expect(getReachVisualMeta("online_sse", "en").label).toBe("Online");
    expect(getReachVisualMeta("online_sse", "zh-CN").label).toBe("在线");
    expect(formatCompactDuration(125_000, "en")).toBe("2m 5s");
    expect(formatCompactDuration(125_000, "zh-CN")).toBe("2 分 5 秒");
  });

  it("performs optimistic updates with seq & userId race guards in useAccountLanguagePreference", async () => {
    const { storage } = createMockBrowser({ languages: ["en-US"] });
    const queryClient = new QueryClient();
    const meKey = currentMeQueryOptions().queryKey;
    const userA = HumanUserDtoSchema.parse({
      id: "usr_race_a",
      email: "a@openhuddle.dev",
      displayName: "User A",
      createdAtIso: "2026-11-26T00:00:00.000Z",
    });
    const initialMe: HumanMeResponseDto = {
      ok: true,
      callerKind: "human",
      user: userA,
      languagePreference: "auto",
      agents: [],
    };
    queryClient.setQueryData(meKey, initialMe);

    const resolvers: Array<{
      readonly resolve: (resp: Response) => void;
      readonly reject: (err: Error) => void;
    }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve, reject) => {
            resolvers.push({ resolve, reject });
          }),
      ),
    );

    let setPref: ((next: "auto" | "zh-CN" | "en") => void) | undefined;
    function HookProbe() {
      setPref = useAccountLanguagePreference().setPreference;
      return null;
    }
    renderToString(
      createElement(QueryClientProvider, { client: queryClient }, createElement(HookProbe)),
    );

    // Trigger rapid A("auto") -> B("zh-CN") -> C("en")
    setPref?.("zh-CN");
    expect(queryClient.getQueryData<HumanMeResponseDto>(meKey)?.languagePreference).toBe("zh-CN");
    expect(storage.get(LAST_ACCOUNT_LANGUAGE_STORAGE_KEY)).toBe("zh-CN");

    setPref?.("en");
    expect(queryClient.getQueryData<HumanMeResponseDto>(meKey)?.languagePreference).toBe("en");
    expect(storage.get(LAST_ACCOUNT_LANGUAGE_STORAGE_KEY)).toBe("en");

    await vi.waitFor(() => {
      expect(resolvers).toHaveLength(2);
    });

    // Stale first mutation fails -> must NOT roll back latest "en"
    resolvers[0]?.reject(new Error("stale network blip"));
    await new Promise((r) => setTimeout(r, 10));
    expect(queryClient.getQueryData<HumanMeResponseDto>(meKey)?.languagePreference).toBe("en");

    // Latest second mutation also fails -> rolls back cleanly to server-confirmed "auto"
    resolvers[1]?.reject(new Error("latest failed"));
    await vi.waitFor(() => {
      expect(queryClient.getQueryData<HumanMeResponseDto>(meKey)?.languagePreference).toBe("auto");
    });
    expect(storage.get(LAST_ACCOUNT_LANGUAGE_STORAGE_KEY)).toBe("auto");

    // Cross-account userId guard: late failure for userA after switching to userB must NOT touch userB
    setPref?.("zh-CN");
    await vi.waitFor(() => {
      expect(resolvers).toHaveLength(3);
    });
    const userB = HumanUserDtoSchema.parse({
      id: "usr_race_b",
      email: "b@openhuddle.dev",
      displayName: "User B",
      createdAtIso: "2026-11-26T00:00:00.000Z",
    });
    queryClient.setQueryData<HumanMeResponseDto>(meKey, {
      ok: true,
      callerKind: "human",
      user: userB,
      languagePreference: "en",
      agents: [],
    });
    setLastAccountLanguagePreference("en");

    resolvers[2]?.reject(new Error("late failure for userA"));
    await new Promise((r) => setTimeout(r, 10));
    expect(queryClient.getQueryData<HumanMeResponseDto>(meKey)?.user.id).toBe(userB.id);
    expect(queryClient.getQueryData<HumanMeResponseDto>(meKey)?.languagePreference).toBe("en");
    expect(storage.get(LAST_ACCOUNT_LANGUAGE_STORAGE_KEY)).toBe("en");

    queryClient.clear();
  });

  it("preserves last account language preference during cold-reload hydration before /me resolves (F1)", () => {
    const { browserDocument, storage } = createMockBrowser({ languages: ["en-US"] });
    storage.set("oh_session_token", "oh_ses_live_token");
    storage.set(LAST_ACCOUNT_LANGUAGE_STORAGE_KEY, "zh-CN");

    // While /api/v1/me is still hydrating (mePending === true), AppRoot must stay on zh-CN
    const hydratingPref = resolveAppRootLanguagePreference({
      isShareRoute: false,
      authenticatedLanguagePreference: null,
      mePending: true,
      sessionToken: "oh_ses_live_token",
      lastAccountLanguagePreference: readLastAccountLanguagePreference(),
      guestLanguagePreference: "auto",
    });
    expect(hydratingPref).toBe("zh-CN");
    stopLocaleSync = startLocaleSync(hydratingPref);
    expect(getActiveLocale()).toBe("zh-CN");
    expect(browserDocument.documentElement.lang).toBe("zh-CN");

    // Once /api/v1/me confirms 401 unauthenticated (mePending === false, authenticated === null),
    // fall back to guest preference ("auto" -> "en")
    stopLocaleSync();
    const unauthPref = resolveAppRootLanguagePreference({
      isShareRoute: false,
      authenticatedLanguagePreference: null,
      mePending: false,
      sessionToken: null,
      lastAccountLanguagePreference: "zh-CN",
      guestLanguagePreference: "auto",
    });
    expect(unauthPref).toBe("auto");
    stopLocaleSync = startLocaleSync(unauthPref);
    expect(getActiveLocale()).toBe("en");
    expect(browserDocument.documentElement.lang).toBe("en");

    // Public share routes always respect guest preference regardless of session cache
    expect(
      resolveAppRootLanguagePreference({
        isShareRoute: true,
        authenticatedLanguagePreference: null,
        mePending: true,
        sessionToken: "oh_ses_live_token",
        lastAccountLanguagePreference: "zh-CN",
        guestLanguagePreference: "en",
      }),
    ).toBe("en");
  });
});
