import { describe, expect, it } from "vitest";
import {
  DEFAULT_REFRESH_RATE_PREFERENCE,
  computeMedianFrameDeltaMs,
  getRefreshRatePreference,
  snapRefreshRateHz,
} from "../lib/display-refresh.js";

describe("display-refresh VSync calibration & default policy", () => {
  it("defaults to maximum supported refresh rate ('max') out of the box", () => {
    expect(DEFAULT_REFRESH_RATE_PREFERENCE).toBe("max");
    expect(getRefreshRatePreference()).toBe("max");
  });

  it("accurately snaps measured VSync intervals to 60Hz, 120Hz ProMotion, 144Hz, 165Hz and 240Hz", () => {
    expect(snapRefreshRateHz(16.67)).toBe(60);
    expect(snapRefreshRateHz(11.11)).toBe(90);
    expect(snapRefreshRateHz(8.33)).toBe(120);
    expect(snapRefreshRateHz(6.94)).toBe(144);
    expect(snapRefreshRateHz(6.06)).toBe(165);
    expect(snapRefreshRateHz(4.17)).toBe(240);
    expect(snapRefreshRateHz(2.78)).toBe(360);
  });

  it("computes jitter-resistant trimmed median frame delta while discarding GC spikes", () => {
    // 120Hz stream (~8.33ms) polluted with one 85ms background spike and one 0.3ms duplicate callback
    const timestamps = [
      0,
      8.32,
      16.66,
      25.0,
      33.33,
      33.6, // duplicate sub-frame anomaly -> discarded
      41.93,
      50.26,
      135.26, // 85ms tab/GC stall -> discarded
      143.59,
      151.92,
      160.25,
    ];
    const medianDt = computeMedianFrameDeltaMs(timestamps);
    expect(medianDt).not.toBeNull();
    expect(snapRefreshRateHz(medianDt ?? 16.67)).toBe(120);
  });
});
