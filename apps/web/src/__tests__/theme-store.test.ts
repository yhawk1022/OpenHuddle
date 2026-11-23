/**
 * @module web/__tests__/theme-store
 * @description 验证本地时间边界、固定模式和后台恢复后的主题同步。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { setThemePreference, startThemeSync } from "../lib/theme-store.js";

let stopThemeSync: (() => void) | undefined;

function mountThemeAt(now: Date, savedPreference?: string) {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  const storage = new Map<string, string>();
  if (savedPreference !== undefined) {
    storage.set("oh_theme", savedPreference);
  }
  const classes = new Set<string>();
  const browserWindow = Object.assign(new EventTarget(), {
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
    setTimeout,
    clearTimeout,
  });
  const browserDocument = Object.assign(new EventTarget(), {
    documentElement: {
      classList: {
        contains: (name: string) => classes.has(name),
        toggle: (name: string, enabled: boolean) => {
          if (enabled) {
            classes.add(name);
          } else {
            classes.delete(name);
          }
        },
      },
    },
  });
  vi.stubGlobal("window", browserWindow);
  vi.stubGlobal("document", browserDocument);
  stopThemeSync = startThemeSync();
  return { browserDocument, storage, isDark: () => classes.has("dark") };
}

afterEach(() => {
  stopThemeSync?.();
  stopThemeSync = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("theme schedule", () => {
  it.each([
    { hour: 6, before: true, after: false },
    { hour: 17, before: false, after: true },
  ])("switches at the next local hour after $hour:59", ({ hour, before, after }) => {
    const { isDark } = mountThemeAt(new Date(2026, 10, 23, hour, 59, 59, 900));
    expect(isDark()).toBe(before);
    vi.advanceTimersByTime(99);
    expect(isDark()).toBe(before);
    vi.advanceTimersByTime(1);
    expect(isDark()).toBe(after);
  });

  it("keeps a saved fixed mode until the user re-enables automatic switching", () => {
    const { isDark, storage } = mountThemeAt(new Date(2026, 10, 23, 17, 59, 59), "light");
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(1_000);
    expect(isDark()).toBe(false);

    setThemePreference("auto");
    expect(storage.get("oh_theme")).toBe("auto");
    expect(isDark()).toBe(true);

    setThemePreference("light");
    expect(storage.get("oh_theme")).toBe("light");
    expect(isDark()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reconciles missed timer ticks when the page becomes visible", () => {
    const { isDark, browserDocument } = mountThemeAt(new Date(2026, 10, 23, 17, 0));
    expect(isDark()).toBe(false);
    vi.setSystemTime(new Date(2026, 10, 23, 19, 0));
    browserDocument.dispatchEvent(new Event("visibilitychange"));
    expect(isDark()).toBe(true);
  });
});
