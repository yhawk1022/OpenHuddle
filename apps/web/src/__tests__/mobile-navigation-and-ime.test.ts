/**
 * @module web/__tests__/mobile-navigation-and-ime
 * @description 验证 Android/iOS 浏览器返回栈（`navigateTo` / `navigateBackOr` / 弹窗 `__ohOverlay` 哨兵防竞态）与中日韩输入法 IME 229 防误触守卫。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetNavigationStateForTests,
  navigateBackOr,
  navigateTo,
  registerOverlayBackSentinel,
} from "../lib/session-store.js";
import {
  isEditableElement,
  isImeComposing,
  startVisualViewportSync,
} from "../lib/viewport-sync.js";

interface HistoryEntry {
  state: unknown;
  url: string;
}

function createStubBrowserWindow(initialUrl = "/") {
  const stack: HistoryEntry[] = [{ state: null, url: initialUrl }];
  let cursor = 0;

  const parseUrl = (rawUrl: string) => {
    const parsed = new URL(rawUrl, "https://huddle.example.com");
    return {
      pathname: parsed.pathname,
      search: parsed.search,
      hash: parsed.hash,
    };
  };

  const target = new EventTarget();
  const locationState = parseUrl(initialUrl);

  const syncLocationFromCursor = () => {
    const current = stack[cursor] ?? { state: null, url: "/" };
    const next = parseUrl(current.url);
    locationState.pathname = next.pathname;
    locationState.search = next.search;
    locationState.hash = next.hash;
  };

  const history = {
    get length() {
      return stack.length;
    },
    get state() {
      return stack[cursor]?.state ?? null;
    },
    pushState(state: unknown, _unused: string, url?: string | URL | null) {
      stack.splice(cursor + 1);
      const resolvedUrl = url ? String(url) : `${locationState.pathname}${locationState.search}`;
      stack.push({ state, url: resolvedUrl });
      cursor = stack.length - 1;
      syncLocationFromCursor();
    },
    replaceState(state: unknown, _unused: string, url?: string | URL | null) {
      const resolvedUrl = url ? String(url) : `${locationState.pathname}${locationState.search}`;
      stack[cursor] = { state, url: resolvedUrl };
      syncLocationFromCursor();
    },
    back() {
      if (cursor > 0) {
        cursor -= 1;
        syncLocationFromCursor();
        target.dispatchEvent(new Event("popstate"));
      }
    },
  };

  const win = Object.assign(target, {
    location: locationState,
    history,
    innerHeight: 844,
    scrollX: 0,
    scrollY: 0,
    scrollTo: vi.fn((x: number, y: number) => {
      win.scrollX = x;
      win.scrollY = y;
    }),
    setTimeout,
    clearTimeout,
  });

  return { win, stack, getCursor: () => cursor };
}

afterEach(() => {
  __resetNavigationStateForTests();
  vi.unstubAllGlobals();
});

describe("IME composition & editable element guards", () => {
  it("blocks Enter submission during standard composition, Android keyCode 229, and Process key", () => {
    expect(isImeComposing({ key: "Enter", isComposing: false, keyCode: 13 })).toBe(false);
    expect(isImeComposing({ key: "Enter", isComposing: true, keyCode: 13 })).toBe(true);
    expect(isImeComposing({ key: "Enter", isComposing: false, keyCode: 229 })).toBe(true);
    expect(
      isImeComposing({
        key: "Enter",
        isComposing: false,
        nativeEvent: { isComposing: false, keyCode: 229 },
      }),
    ).toBe(true);
    expect(isImeComposing({ key: "Process", isComposing: false })).toBe(true);
  });

  it("accurately distinguishes soft-keyboard editable controls from buttons/checkboxes", () => {
    expect(isEditableElement({ tagName: "TEXTAREA", disabled: false } as unknown as Element)).toBe(
      true,
    );
    expect(
      isEditableElement({
        tagName: "INPUT",
        type: "email",
        disabled: false,
        readOnly: false,
      } as unknown as Element),
    ).toBe(true);
    expect(
      isEditableElement({
        tagName: "INPUT",
        type: "checkbox",
        disabled: false,
        readOnly: false,
      } as unknown as Element),
    ).toBe(false);
    expect(
      isEditableElement({
        tagName: "DIV",
        isContentEditable: true,
      } as unknown as Element),
    ).toBe(true);
    expect(isEditableElement(null)).toBe(false);
  });

  it.each([false, true])("fits the viewport and keyboard (standalone: %s)", (standalone) => {
    const { win } = createStubBrowserWindow("/");
    const vvTarget = new EventTarget();
    const vv = Object.assign(vvTarget, {
      height: 844,
      offsetTop: 0,
      scale: 1,
    });
    Object.assign(win, { visualViewport: vv, scrollY: 48, navigator: { standalone } });

    const cssVars = new Map<string, string>();
    const viewport = {
      content: "width=device-width, viewport-fit=cover, interactive-widget=resizes-content",
    };
    const dataset: Record<string, string> = {};
    const doc = Object.assign(new EventTarget(), {
      querySelector: (selector: string) => (selector === 'meta[name="viewport"]' ? viewport : null),
      activeElement: null as unknown,
      documentElement: {
        style: {
          setProperty: (k: string, v: string) => {
            cssVars.set(k, v);
          },
        },
        dataset,
      },
    });

    vi.stubGlobal("window", win);
    vi.stubGlobal("document", doc);

    const stop = startVisualViewportSync();
    expect(dataset.iosStandalone).toBe(standalone ? "true" : undefined);
    expect(viewport.content).toBe(
      `width=device-width, viewport-fit=${standalone ? "contain" : "cover"}, interactive-widget=resizes-content`,
    );
    expect(cssVars.get("--oh-vvh")).toBe("844px");
    expect(dataset.keyboardOpen).toBe("false");

    // 模拟聚焦输入框 + 软键盘弹起推高 iOS Safari visualViewport
    doc.activeElement = { tagName: "TEXTAREA", disabled: false };
    vv.height = 510;
    vv.offsetTop = 48;
    vv.dispatchEvent(new Event("resize"));

    expect(cssVars.get("--oh-vvh")).toBe("510px");
    expect(cssVars.get("--oh-vv-offset-top")).toBe("48px");
    expect(dataset.keyboardOpen).toBe("true");
    expect(win.scrollTo).toHaveBeenCalledWith(0, 0);

    vv.height = 844;
    vv.offsetTop = 0;
    vv.dispatchEvent(new Event("resize"));
    expect(cssVars.get("--oh-vvh")).toBe("844px");
    expect(cssVars.get("--oh-vv-offset-top")).toBe("0px");
    expect(dataset.keyboardOpen).toBe("false");

    stop();
  });
});

describe("mobile history back-stack & overlay sentinel coordination", () => {
  it("steps cleanly back through intra-app routes and replaces cleanly on direct deep-link entry", () => {
    const { win } = createStubBrowserWindow("/");
    vi.stubGlobal("window", win);
    __resetNavigationStateForTests();

    navigateTo("/?room=rom_alpha");
    expect(win.location.search).toBe("?room=rom_alpha");

    navigateBackOr("/");
    expect(win.location.pathname).toBe("/");
    expect(win.location.search).toBe("");

    // 模拟用户从外部分享深链直接打开 /?room=rom_deep（intraAppHistoryDepth === 0）
    const deep = createStubBrowserWindow("/?room=rom_deep");
    vi.stubGlobal("window", deep.win);
    __resetNavigationStateForTests();

    navigateBackOr("/");
    expect(deep.win.location.pathname).toBe("/");
    expect(deep.win.location.search).toBe("");
    expect(deep.stack).toHaveLength(1);
  });

  it("intercepts Android swipe-back (popstate) to dismiss the topmost modal/sheet without popping underlying route", () => {
    const { win } = createStubBrowserWindow("/?room=rom_alpha");
    vi.stubGlobal("window", win);
    __resetNavigationStateForTests();

    let modalOpen = true;
    const sentinel = registerOverlayBackSentinel(() => {
      modalOpen = false;
    });

    // 模拟 Android 侧滑返回手势触发浏览器后退
    win.history.back();
    expect(modalOpen).toBe(false);
    expect(win.location.search).toBe("?room=rom_alpha");

    // 弹窗卸载调用 cleanup 时不应再次回退底层路由
    sentinel.cleanup();
    expect(win.location.search).toBe("?room=rom_alpha");
  });

  it("prevents history.back() race when an overlay action calls navigateTo before closing", () => {
    const { win } = createStubBrowserWindow("/");
    vi.stubGlobal("window", win);
    __resetNavigationStateForTests();

    const sentinel = registerOverlayBackSentinel(() => {});

    // 模拟在命令面板/创建群聊弹窗内直接跳转到新房间并关闭弹窗
    navigateTo("/?room=rom_created");
    sentinel.cleanup();

    expect(win.location.search).toBe("?room=rom_created");
  });
});
