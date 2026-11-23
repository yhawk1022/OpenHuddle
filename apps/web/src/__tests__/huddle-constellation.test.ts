/**
 * @module web/tests/huddle-constellation
 * @description 验证首页「围炉星座」动态背景的纯数学辅助函数：星点数量稀疏上限、弧线透明度平滑衰减与递话光点缓动曲线。
 */
import { describe, expect, it } from "vitest";
import {
  computeThreadAlpha,
  easeInOutCubic,
  resolveConstellationNodeCount,
} from "../components/ui/huddle-constellation-background.js";

describe("@openhuddle/web — HuddleConstellationBackground math invariants", () => {
  it("keeps the constellation sparse across viewports (9–18 nodes)", () => {
    expect(resolveConstellationNodeCount(375, 812)).toBe(9);
    expect(resolveConstellationNodeCount(1440, 900)).toBe(14);
    expect(resolveConstellationNodeCount(3840, 2160)).toBe(18);
    expect(resolveConstellationNodeCount(0, 0)).toBe(9);
  });

  it("fades threads smoothly with distance and hides them beyond the threshold", () => {
    expect(computeThreadAlpha(0, 200)).toBeCloseTo(1, 6);
    expect(computeThreadAlpha(100, 200)).toBeCloseTo(0.5, 6);
    expect(computeThreadAlpha(200, 200)).toBe(0);
    expect(computeThreadAlpha(500, 200)).toBe(0);
    expect(computeThreadAlpha(10, 0)).toBe(0);
    // 单调递减
    expect(computeThreadAlpha(40, 200)).toBeGreaterThan(computeThreadAlpha(120, 200));
  });

  it("eases message pulses in and out with clamped bounds", () => {
    expect(easeInOutCubic(-1)).toBe(0);
    expect(easeInOutCubic(0)).toBe(0);
    expect(easeInOutCubic(0.5)).toBeCloseTo(0.5, 6);
    expect(easeInOutCubic(1)).toBe(1);
    expect(easeInOutCubic(2)).toBe(1);
    expect(easeInOutCubic(0.1)).toBeLessThan(0.1);
    expect(easeInOutCubic(0.9)).toBeGreaterThan(0.9);
  });
});
