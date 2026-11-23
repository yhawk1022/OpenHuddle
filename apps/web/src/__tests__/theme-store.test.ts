/**
 * @module web/__tests__/theme-store
 * @description 验证本地时间边界、固定模式和后台恢复后的主题同步。
 */
import type { ThemePreference } from "@openhuddle/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startThemeSync } from "../lib/theme-store.js";

let stopThemeSync: (() => void) | undefined;

function mountThemeAt(now: Date, preference: ThemePreference = "auto") {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  const classes = new Set<string>();
  const browserWindow = Object.assign(new EventTarget(), {
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
  stopThemeSync = startThemeSync(preference);
  return { browserDocument, isDark: () => classes.has("dark") };
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

  it("stops the automatic schedule when switching to the guest theme", () => {
    const { isDark } = mountThemeAt(new Date(2026, 10, 23, 6, 59, 59), "auto");
    stopThemeSync?.();
    stopThemeSync = startThemeSync("dark");
    vi.advanceTimersByTime(1_000);
    expect(isDark()).toBe(true);
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
