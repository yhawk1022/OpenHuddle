/**
 * @module web/components/ui/huddle-constellation-background
 * @description OpenHuddle 首页原创「围炉星座」动态背景（`HuddleConstellationBackground`）：
 * 以产品隐喻为灵感——每一颗柔光小星代表一位 Agent，它们在淡淡的极光雾里缓慢漂流；
 * 彼此靠近时会牵起一缕若隐若现的弧线（开始对话），偶尔有一粒光点沿弧线从一颗星传到另一颗（递话），
 * 收到消息的星会轻轻亮一下。鼠标就是「你」：星星会好奇地向你靠拢，点一下，你的话便化作光点送到身边几位 Agent。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 克制稀疏：星点数量按视口面积自适应限定在 9–18 颗，连线只在近距离出现且透明度随距离平滑衰减，留出大量呼吸留白。
 * 2. 绝对柔和：所有运动均为帧率无关的指数平滑（无弹簧过冲、无硬反弹），边界采用柔性转向而非碰撞反射；
 *    光晕使用离屏预渲染的高斯羽化精灵，弧线使用两端渐变色，避免任何生硬线段与硬边。
 * 3. 零交互阻塞：画布固定 `pointer-events-none` + `aria-hidden`，通过 `window` 被动监听指针事件，绝不拦截上层表单与按钮。
 * 4. 环境自适应：标签页隐藏时挂起渲染；`prefers-reduced-motion: reduce` 时仅绘制单帧静态构图；主题切换时重建调色板。
 */
import { useEffect, useRef } from "react";
import { cn } from "../../lib/cn.js";
import { useThemeMode } from "../../lib/theme-store.js";

type Rgb = readonly [number, number, number];

/** 日光模式星点调色板：温暖琥珀、柔玫瑰、薰衣草紫、晴空蓝、青瓷绿 */
const LIGHT_PALETTE: ReadonlyArray<Rgb> = [
  [226, 156, 52],
  [222, 96, 122],
  [132, 104, 226],
  [58, 136, 230],
  [32, 164, 150],
];

/** 暗夜模式星点调色板：同色相提高明度，营造晶莹微光 */
const DARK_PALETTE: ReadonlyArray<Rgb> = [
  [250, 196, 96],
  [248, 136, 158],
  [176, 152, 255],
  [110, 176, 255],
  [92, 214, 196],
];

/** 极光雾团定义（位置与半径均为视口相对比例） */
interface AuroraBlob {
  readonly bx: number;
  readonly by: number;
  readonly radiusFactor: number;
  readonly colorIndex: number;
  readonly freqX: number;
  readonly freqY: number;
  readonly phase: number;
}

const AURORA_BLOBS: ReadonlyArray<AuroraBlob> = [
  { bx: 0.78, by: 0.22, radiusFactor: 0.42, colorIndex: 0, freqX: 0.031, freqY: 0.023, phase: 0 },
  { bx: 0.18, by: 0.82, radiusFactor: 0.46, colorIndex: 3, freqX: 0.027, freqY: 0.035, phase: 1.7 },
  { bx: 0.62, by: 0.86, radiusFactor: 0.36, colorIndex: 2, freqX: 0.022, freqY: 0.029, phase: 3.1 },
  { bx: 0.92, by: 0.62, radiusFactor: 0.3, colorIndex: 1, freqX: 0.034, freqY: 0.019, phase: 4.4 },
];

/** 指针静止后「你」的影响力柔和退场时长（毫秒） */
const POINTER_PRESENCE_MS = 4_000;

/** 同时在途的递话光点上限 */
const MAX_PULSES = 5;

/** 光晕精灵纹理尺寸 */
const HALO_SPRITE_SIZE = 96;

/**
 * 根据视口面积计算星点数量（稀疏克制，限定 9–18 颗）。
 *
 * @param width - 视口宽度（CSS 像素）
 * @param height - 视口高度（CSS 像素）
 * @returns 星点数量
 */
export function resolveConstellationNodeCount(width: number, height: number): number {
  const area = Math.max(0, width) * Math.max(0, height);
  return Math.min(18, Math.max(9, Math.round(area / 92_000)));
}

/**
 * 计算两颗星之间弧线的透明度系数（距离越近越清晰，采用 smoothstep 平滑衰减，超出阈值归零）。
 *
 * @param distance - 两点距离
 * @param maxDistance - 连线出现的最大距离
 * @returns `[0, 1]` 透明度系数
 */
export function computeThreadAlpha(distance: number, maxDistance: number): number {
  if (maxDistance <= 0 || distance >= maxDistance) {
    return 0;
  }
  const t = 1 - Math.max(0, distance) / maxDistance;
  return t * t * (3 - 2 * t);
}

/**
 * 三次缓入缓出曲线（递话光点沿弧线起步轻柔、到达轻柔）。
 *
 * @param t - 线性进度
 * @returns 平滑进度 `[0, 1]`
 */
export function easeInOutCubic(t: number): number {
  const c = Math.min(1, Math.max(0, t));
  return c < 0.5 ? 4 * c * c * c : 1 - (-2 * c + 2) ** 3 / 2;
}

/** 确定性哈希伪随机数 `[0, 1)`，保证首屏构图稳定可复现 */
function hashUnit(index: number, salt: number): number {
  let x = Math.imul(index + 1, 0x9e3779b1) ^ Math.imul(salt + 1, 0x85ebca6b);
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return (x >>> 0) / 0xffffffff;
}

/** 弧线弯曲方向：保证同一对星点的连线与递话光点轨迹完全一致 */
function curveSign(a: number, b: number): number {
  return (a + b) % 2 === 0 ? 1 : -1;
}

/** 单颗 Agent 星点状态 */
interface ConstellationNode {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  colorIndex: number;
  phase: number;
  speed: number;
  glow: number;
}

/** 沿弧线传递的消息光点（`from === -1` 表示由「你」发出） */
interface MessagePulse {
  readonly from: number;
  readonly to: number;
  readonly originX: number;
  readonly originY: number;
  readonly bornAt: number;
  readonly duration: number;
}

function createNode(
  index: number,
  width: number,
  height: number,
  count: number,
): ConstellationNode {
  // 抖动栅格初始布点，避免随机扎堆，让首屏分布疏朗均衡
  const cols = Math.max(3, Math.round(Math.sqrt((count * width) / Math.max(1, height))));
  const rows = Math.max(2, Math.ceil(count / cols));
  const cellW = width / cols;
  const cellH = height / rows;
  const col = index % cols;
  const row = Math.floor(index / cols) % rows;

  return {
    x: (col + 0.2 + hashUnit(index, 1) * 0.6) * cellW,
    y: (row + 0.2 + hashUnit(index, 2) * 0.6) * cellH,
    vx: 0,
    vy: 0,
    radius: 2.2 + hashUnit(index, 3) * 2,
    colorIndex: Math.floor(hashUnit(index, 4) * 5) % 5,
    phase: hashUnit(index, 5) * Math.PI * 2,
    speed: 7 + hashUnit(index, 6) * 9,
    glow: 0,
  };
}

function buildHaloSprite(rgb: Rgb): HTMLCanvasElement {
  const sprite = document.createElement("canvas");
  sprite.width = HALO_SPRITE_SIZE;
  sprite.height = HALO_SPRITE_SIZE;
  const sctx = sprite.getContext("2d");
  if (sctx) {
    const half = HALO_SPRITE_SIZE / 2;
    const [r, g, b] = rgb;
    const grad = sctx.createRadialGradient(half, half, 0, half, half, half);
    grad.addColorStop(0, `rgba(${r}, ${g}, ${b}, 0.55)`);
    grad.addColorStop(0.28, `rgba(${r}, ${g}, ${b}, 0.2)`);
    grad.addColorStop(0.62, `rgba(${r}, ${g}, ${b}, 0.05)`);
    grad.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);
    sctx.fillStyle = grad;
    sctx.fillRect(0, 0, HALO_SPRITE_SIZE, HALO_SPRITE_SIZE);
  }
  return sprite;
}

function rgba(rgb: Rgb, alpha: number): string {
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha.toFixed(3)})`;
}

/** `HuddleConstellationBackground` 组件入参属性 */
export interface HuddleConstellationBackgroundProps {
  /** 附加外层容器类名 */
  readonly className?: string | undefined;
}

/**
 * 渲染 OpenHuddle 首页原创「围炉星座」动态背景。
 *
 * @param props - 可选容器样式类名
 * @returns 无障碍静默、零点击拦截的全屏动态背景层
 */
export function HuddleConstellationBackground(props: HuddleConstellationBackgroundProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const themeMode = useThemeMode();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || typeof window === "undefined") {
      return undefined;
    }
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) {
      return undefined;
    }

    const isDark = themeMode === "dark";
    const palette = isDark ? DARK_PALETTE : LIGHT_PALETTE;
    const haloSprites = palette.map(buildHaloSprite);
    const auroraAlpha = isDark ? 0.11 : 0.085;
    const threadAlphaBase = isDark ? 0.34 : 0.3;
    const haloAlphaBase = isDark ? 0.62 : 0.5;
    const youRgb: Rgb = isDark ? [236, 238, 244] : [24, 27, 34];

    const reducedMotionQuery =
      typeof window.matchMedia === "function"
        ? window.matchMedia("(prefers-reduced-motion: reduce)")
        : null;
    let prefersReducedMotion = reducedMotionQuery?.matches === true;

    let viewportW = Math.max(1, window.innerWidth);
    let viewportH = Math.max(1, window.innerHeight);
    let dpr = Math.min(window.devicePixelRatio || 1, 2);

    const nodes: ConstellationNode[] = [];
    const initialCount = resolveConstellationNodeCount(viewportW, viewportH);
    for (let i = 0; i < initialCount; i += 1) {
      nodes.push(createNode(i, viewportW, viewportH, initialCount));
    }

    const pulses: MessagePulse[] = [];
    // 本帧可递话的星对（扁平存储 i, j），复用数组避免帧内分配
    const linkedPairs: number[] = [];

    let pointerX = viewportW / 2;
    let pointerY = viewportH / 2;
    let lastPointerAtMs = Number.NEGATIVE_INFINITY;

    const resolveThreadDistance = (): number =>
      Math.min(260, Math.max(170, Math.min(viewportW, viewportH) * 0.27));

    const syncCanvasMetrics = (): void => {
      const prevW = viewportW;
      const prevH = viewportH;
      viewportW = Math.max(1, window.innerWidth);
      viewportH = Math.max(1, window.innerHeight);
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(viewportW * dpr);
      canvas.height = Math.round(viewportH * dpr);

      // 视口变化时按比例平移星点而非重建，避免整屏星空突然跳变
      const sx = viewportW / prevW;
      const sy = viewportH / prevH;
      for (const node of nodes) {
        node.x *= sx;
        node.y *= sy;
      }
      const targetCount = resolveConstellationNodeCount(viewportW, viewportH);
      while (nodes.length > targetCount) {
        nodes.pop();
      }
      while (nodes.length < targetCount) {
        nodes.push(createNode(nodes.length, viewportW, viewportH, targetCount));
      }
      pulses.length = 0;
    };

    canvas.width = Math.round(viewportW * dpr);
    canvas.height = Math.round(viewportH * dpr);

    const point = { x: 0, y: 0 };
    /** 计算二次贝塞尔弧线上的点（控制点沿两端连线法向偏移，形成自然柔弧） */
    const sampleArc = (
      ax: number,
      ay: number,
      bx: number,
      by: number,
      sign: number,
      t: number,
    ): void => {
      const dx = bx - ax;
      const dy = by - ay;
      const cx = (ax + bx) / 2 - dy * 0.14 * sign;
      const cy = (ay + by) / 2 + dx * 0.14 * sign;
      const u = 1 - t;
      point.x = u * u * ax + 2 * u * t * cx + t * t * bx;
      point.y = u * u * ay + 2 * u * t * cy + t * t * by;
    };

    const drawArc = (
      ax: number,
      ay: number,
      bx: number,
      by: number,
      sign: number,
      fromRgb: Rgb,
      toRgb: Rgb,
      alpha: number,
    ): void => {
      const dx = bx - ax;
      const dy = by - ay;
      const cx = (ax + bx) / 2 - dy * 0.14 * sign;
      const cy = (ay + by) / 2 + dx * 0.14 * sign;
      const grad = ctx.createLinearGradient(ax, ay, bx, by);
      grad.addColorStop(0, rgba(fromRgb, alpha));
      grad.addColorStop(0.5, rgba(fromRgb, alpha * 0.55));
      grad.addColorStop(1, rgba(toRgb, alpha));
      ctx.strokeStyle = grad;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.quadraticCurveTo(cx, cy, bx, by);
      ctx.stroke();
    };

    let rafId = 0;
    const startMs = performance.now();
    let prevFrameMs = startMs;
    let nextPulseAtSec = 1.2;

    const renderFrame = (nowMs: number): void => {
      const dt = Math.min(0.05, Math.max(0.001, (nowMs - prevFrameMs) / 1000));
      prevFrameMs = nowMs;
      const t = (nowMs - startMs) / 1000;
      const animate = !prefersReducedMotion;

      const presenceAge = nowMs - lastPointerAtMs;
      const presence =
        !animate || presenceAge >= POINTER_PRESENCE_MS
          ? 0
          : 0.5 * (1 + Math.cos((presenceAge / POINTER_PRESENCE_MS) * Math.PI));

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, viewportW, viewportH);

      // ── 1. 极光雾：几团极淡的色彩缓慢游移，给空间一点温度 ──
      const maxSide = Math.max(viewportW, viewportH);
      for (const blob of AURORA_BLOBS) {
        const rgb = palette[blob.colorIndex] ?? palette[0];
        if (rgb === undefined) {
          continue;
        }
        const bx =
          viewportW * (blob.bx + (animate ? Math.sin(t * blob.freqX * 6 + blob.phase) * 0.05 : 0));
        const by =
          viewportH * (blob.by + (animate ? Math.cos(t * blob.freqY * 6 + blob.phase) * 0.05 : 0));
        const radius = maxSide * blob.radiusFactor;
        const grad = ctx.createRadialGradient(bx, by, 0, bx, by, radius);
        grad.addColorStop(0, rgba(rgb, auroraAlpha));
        grad.addColorStop(0.55, rgba(rgb, auroraAlpha * 0.35));
        grad.addColorStop(1, rgba(rgb, 0));
        ctx.fillStyle = grad;
        ctx.fillRect(bx - radius, by - radius, radius * 2, radius * 2);
      }

      // ── 2. 星点漂流：缓慢的流向场 + 柔性边界转向 + 对「你」的好奇靠拢 ──
      if (animate) {
        const ease = 1 - Math.exp(-dt * 1.4);
        const edge = 80;
        for (const node of nodes) {
          const heading = node.phase + Math.sin(t * 0.07 + node.phase * 2.3) * 1.4 + t * 0.012;
          let tvx = Math.cos(heading) * node.speed;
          let tvy = Math.sin(heading) * node.speed;

          if (node.x < edge) tvx += (edge - node.x) * 0.3;
          if (node.x > viewportW - edge) tvx -= (node.x - (viewportW - edge)) * 0.3;
          if (node.y < edge) tvy += (edge - node.y) * 0.3;
          if (node.y > viewportH - edge) tvy -= (node.y - (viewportH - edge)) * 0.3;

          if (presence > 0.01) {
            const dx = pointerX - node.x;
            const dy = pointerY - node.y;
            const d = Math.hypot(dx, dy);
            if (d < 320 && d > 1) {
              // 靠拢到你身边约 130px 的舒适距离后便不再贴近，像围坐在一起
              const falloff = 1 - d / 320;
              const pull = (d - 130) * 0.3 * falloff * presence;
              tvx += (dx / d) * pull;
              tvy += (dy / d) * pull;
            }
          }

          node.vx += (tvx - node.vx) * ease;
          node.vy += (tvy - node.vy) * ease;
          node.x += node.vx * dt;
          node.y += node.vy * dt;
          node.glow = Math.max(0, node.glow - dt * 1.1);
        }
      }

      // ── 3. 对话弧线：靠近的星之间牵起若隐若现的渐变弧 ──
      const threadDistance = resolveThreadDistance();
      linkedPairs.length = 0;
      ctx.lineWidth = 1;
      ctx.lineCap = "round";
      for (let i = 0; i < nodes.length; i += 1) {
        const a = nodes[i];
        if (a === undefined) continue;
        for (let j = i + 1; j < nodes.length; j += 1) {
          const b = nodes[j];
          if (b === undefined) continue;
          const d = Math.hypot(b.x - a.x, b.y - a.y);
          const strength = computeThreadAlpha(d, threadDistance);
          if (strength < 0.02) continue;
          if (strength > 0.3) {
            linkedPairs.push(i, j);
          }
          const fromRgb = palette[a.colorIndex] ?? youRgb;
          const toRgb = palette[b.colorIndex] ?? youRgb;
          drawArc(a.x, a.y, b.x, b.y, curveSign(i, j), fromRgb, toRgb, strength * threadAlphaBase);
        }
      }

      // 你与附近星点之间的细弧（随你的停留与离开柔和显隐）
      if (presence > 0.02) {
        for (let j = 0; j < nodes.length; j += 1) {
          const b = nodes[j];
          if (b === undefined) continue;
          const d = Math.hypot(b.x - pointerX, b.y - pointerY);
          const strength = computeThreadAlpha(d, threadDistance * 1.15) * presence;
          if (strength < 0.02) continue;
          const toRgb = palette[b.colorIndex] ?? youRgb;
          drawArc(
            pointerX,
            pointerY,
            b.x,
            b.y,
            curveSign(-1, j),
            youRgb,
            toRgb,
            strength * threadAlphaBase * 0.8,
          );
        }
      }

      // ── 4. 递话光点：偶尔有一句话沿弧线从一颗星传到另一颗 ──
      if (animate && t >= nextPulseAtSec) {
        const pairCount = linkedPairs.length / 2;
        if (pairCount > 0 && pulses.length < MAX_PULSES) {
          const pick = Math.floor(Math.random() * pairCount);
          const i = linkedPairs[pick * 2];
          const j = linkedPairs[pick * 2 + 1];
          if (i !== undefined && j !== undefined) {
            const forward = Math.random() < 0.5;
            pulses.push({
              from: forward ? i : j,
              to: forward ? j : i,
              originX: 0,
              originY: 0,
              bornAt: t,
              duration: 1.5 + Math.random() * 0.8,
            });
          }
        }
        nextPulseAtSec = t + 1.1 + Math.random() * 1.8;
      }

      for (let p = pulses.length - 1; p >= 0; p -= 1) {
        const pulse = pulses[p];
        if (pulse === undefined) continue;
        const target = nodes[pulse.to];
        const source = pulse.from >= 0 ? nodes[pulse.from] : undefined;
        if (target === undefined || (pulse.from >= 0 && source === undefined)) {
          pulses.splice(p, 1);
          continue;
        }
        const ax = source?.x ?? pulse.originX;
        const ay = source?.y ?? pulse.originY;
        const progress = (t - pulse.bornAt) / pulse.duration;
        if (progress >= 1) {
          target.glow = 1;
          pulses.splice(p, 1);
          continue;
        }

        // 两颗星若在递话途中漂远，光点随弧线一同淡出，而不是突兀消失
        const span = Math.hypot(target.x - ax, target.y - ay);
        const keep = Math.min(1, computeThreadAlpha(span, threadDistance * 1.3) * 2.5);
        const fadeInOut = Math.sin(Math.min(1, progress) * Math.PI) ** 0.6;
        const pulseRgb = palette[source?.colorIndex ?? target.colorIndex] ?? palette[0] ?? youRgb;
        const sprite = haloSprites[source?.colorIndex ?? target.colorIndex] ?? haloSprites[0];
        const sign = curveSign(pulse.from, pulse.to);

        // 拖尾：沿弧线向后采样几个渐隐的小光点
        for (let k = 4; k >= 0; k -= 1) {
          const tp = easeInOutCubic(progress - k * 0.028);
          if (tp <= 0) continue;
          sampleArc(ax, ay, target.x, target.y, sign, tp);
          const tailFade = 1 - k / 5;
          ctx.globalAlpha = 0.85 * keep * fadeInOut * tailFade;
          if (k === 0 && sprite !== undefined) {
            ctx.drawImage(sprite, point.x - 9, point.y - 9, 18, 18);
          }
          ctx.fillStyle = rgba(pulseRgb, 0.95);
          ctx.beginPath();
          ctx.arc(point.x, point.y, 1.7 * (0.55 + tailFade * 0.45), 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
      }

      // ── 5. 星点本体：柔光晕 + 实心小核，收到消息时轻轻亮起 ──
      for (const node of nodes) {
        const rgb = palette[node.colorIndex] ?? youRgb;
        const sprite = haloSprites[node.colorIndex];
        const breathe = animate ? 1 + 0.08 * Math.sin(t * 1.1 + node.phase) : 1;
        const coreRadius = node.radius * breathe * (1 + node.glow * 0.3);
        const haloSize = node.radius * 10 * (1 + node.glow * 0.7);

        if (sprite !== undefined) {
          ctx.globalAlpha = haloAlphaBase * (0.75 + node.glow * 0.5);
          ctx.drawImage(sprite, node.x - haloSize / 2, node.y - haloSize / 2, haloSize, haloSize);
        }
        ctx.globalAlpha = 1;
        ctx.fillStyle = rgba(rgb, 0.92);
        ctx.beginPath();
        ctx.arc(node.x, node.y, coreRadius, 0, Math.PI * 2);
        ctx.fill();
      }

      // 你所在的位置：一圈极淡的柔光，提示「你也在这个群里」
      if (presence > 0.02) {
        const youGrad = ctx.createRadialGradient(pointerX, pointerY, 0, pointerX, pointerY, 26);
        youGrad.addColorStop(0, rgba(youRgb, 0.12 * presence));
        youGrad.addColorStop(1, rgba(youRgb, 0));
        ctx.fillStyle = youGrad;
        ctx.fillRect(pointerX - 26, pointerY - 26, 52, 52);
      }

      if (animate && !document.hidden) {
        rafId = window.requestAnimationFrame(renderFrame);
      }
    };

    const startLoopIfAllowed = (): void => {
      window.cancelAnimationFrame(rafId);
      if (document.hidden) {
        return;
      }
      prevFrameMs = performance.now();
      if (prefersReducedMotion) {
        renderFrame(prevFrameMs);
      } else {
        rafId = window.requestAnimationFrame(renderFrame);
      }
    };

    const handlePointerMove = (event: PointerEvent): void => {
      pointerX = event.clientX;
      pointerY = event.clientY;
      lastPointerAtMs = performance.now();
    };

    const handlePointerLeave = (): void => {
      lastPointerAtMs = Number.NEGATIVE_INFINITY;
    };

    const handlePointerDown = (event: PointerEvent): void => {
      if (prefersReducedMotion) {
        return;
      }
      pointerX = event.clientX;
      pointerY = event.clientY;
      lastPointerAtMs = performance.now();

      // 你开口说话：话语化作光点，送到离你最近的几位 Agent
      const reach = resolveThreadDistance() * 1.25;
      const nearby: Array<{ readonly index: number; readonly distance: number }> = [];
      nodes.forEach((node, index) => {
        const d = Math.hypot(node.x - event.clientX, node.y - event.clientY);
        if (d < reach) {
          nearby.push({ index, distance: d });
        }
      });
      nearby.sort((a, b) => a.distance - b.distance);
      const nowSec = (performance.now() - startMs) / 1000;
      for (const [order, item] of nearby.slice(0, 3).entries()) {
        if (pulses.length >= MAX_PULSES + 3) {
          break;
        }
        pulses.push({
          from: -1,
          to: item.index,
          originX: event.clientX,
          originY: event.clientY,
          bornAt: nowSec + order * 0.08,
          duration: 1 + item.distance / 400,
        });
      }
    };

    const handleResize = (): void => {
      syncCanvasMetrics();
      if (prefersReducedMotion) {
        renderFrame(performance.now());
      }
    };

    const handleVisibilityChange = (): void => {
      startLoopIfAllowed();
    };

    const handleReducedMotionChange = (event: MediaQueryListEvent): void => {
      prefersReducedMotion = event.matches;
      startLoopIfAllowed();
    };

    window.addEventListener("pointermove", handlePointerMove, { passive: true });
    window.addEventListener("pointerleave", handlePointerLeave, { passive: true });
    window.addEventListener("pointerdown", handlePointerDown, { passive: true });
    window.addEventListener("resize", handleResize, { passive: true });
    document.addEventListener("visibilitychange", handleVisibilityChange);
    reducedMotionQuery?.addEventListener("change", handleReducedMotionChange);

    startLoopIfAllowed();

    return () => {
      window.cancelAnimationFrame(rafId);
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerleave", handlePointerLeave);
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("resize", handleResize);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      reducedMotionQuery?.removeEventListener("change", handleReducedMotionChange);
    };
  }, [themeMode]);

  return (
    <div
      aria-hidden="true"
      className={cn(
        "pointer-events-none fixed inset-0 z-0 overflow-hidden select-none",
        "bg-app-frame dark:bg-[#0E0F13]",
        props.className,
      )}
    >
      <canvas ref={canvasRef} className="block h-full w-full" />
      {/* 左上标题区阅读保护：轻柔雾化，避免星点与弧线穿过大标题时干扰阅读 */}
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(36rem_20rem_at_27%_27%,var(--oh-app-frame),transparent_80%)] dark:bg-[radial-gradient(36rem_20rem_at_27%_27%,rgba(14,15,19,0.84),transparent_80%)]" />
    </div>
  );
}
