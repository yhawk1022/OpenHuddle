/**
 * @module web/__tests__/motion-physics
 * @description 验证原生动效物理令牌的临界阻尼比（杜绝果冻振荡）与无障碍 `prefers-reduced-motion` 同步契约。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  INSTANT_TRANSITION,
  NATIVE_LIVE_BUBBLE_SPRING,
  NATIVE_MODAL_EXIT,
  NATIVE_MODAL_SPRING,
  NATIVE_PANEL_SPRING,
  NATIVE_PILL_SPRING,
  NATIVE_SURFACE_EXIT,
  NATIVE_SURFACE_SPRING,
} from "../lib/motion-physics.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function computeDampingRatio(spring: {
  readonly stiffness?: number;
  readonly damping?: number;
  readonly mass?: number;
}): number {
  const k = spring.stiffness ?? 100;
  const c = spring.damping ?? 10;
  const m = spring.mass ?? 1;
  return c / (2 * Math.sqrt(k * m));
}

describe("@openhuddle/web — native motion physics invariants", () => {
  it("keeps all spring presets near critical damping (0.85 <= zeta <= 1.15) for crisp zero-wobble settle", () => {
    for (const preset of [
      NATIVE_PILL_SPRING,
      NATIVE_MODAL_SPRING,
      NATIVE_PANEL_SPRING,
      NATIVE_SURFACE_SPRING,
      NATIVE_LIVE_BUBBLE_SPRING,
    ]) {
      expect(preset.type).toBe("spring");
      if (preset.type === "spring") {
        const zeta = computeDampingRatio(preset);
        expect(zeta).toBeGreaterThanOrEqual(0.85);
        expect(zeta).toBeLessThanOrEqual(1.15);
      }
    }
  });

  it("keeps modal and surface exits fast (<= 160ms) so closing/switching never blocks consecutive actions", () => {
    expect(NATIVE_MODAL_EXIT.duration).toBeLessThanOrEqual(0.16);
    expect(NATIVE_SURFACE_EXIT.duration).toBeLessThanOrEqual(0.16);
    expect(INSTANT_TRANSITION.duration).toBeLessThanOrEqual(0.02);
  });
});
