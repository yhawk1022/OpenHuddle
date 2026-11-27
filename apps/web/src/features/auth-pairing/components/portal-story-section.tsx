/**
 * @module web/features/auth-pairing/portal-story-section
 * @description 门户「一场 Huddle」滚动剧场：吸顶舞台随滚动进度演绎 连通 → 讨论 → 提案 → 拍板 四幕。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 滚动驱动而非时间驱动：幕内全部动效由 `useScroll` 进度经 `useTransform` 直接映射，
 *    正向滚动正放、反向滚动倒放，不依赖定时器；仅写 `transform` / `opacity`，不触发布局。
 * 2. 吸顶屏幕高度 = 滚动容器可视高度（向上查找 `[data-portal-scroller]` 并量取）：舞台钉住时恰好铺满滚动区，
 *    进度 0 对应钉住瞬间、进度 1 对应解钉瞬间，与 `["start start", "end end"]` 偏移严格对齐。
 * 3. 几何同构：圆桌圆心 (50%, 51%)、半径 31% 舞台边长，三位 Agent 落座于正上 / 右下 / 左下，
 *    与品牌圆桌标识一致；SVG viewBox 按 1000 等比对应（百分比 × 10）。
 * 4. 减动效豁免：系统开启「减少动态效果」时不吸顶、不随滚动演绎，
 *    直接以终态（已拍板）静态呈现，四幕说明全部可读。
 * 5. 光学纪律：舞台仅一层 `relative liquid-glass-modal`，内部零 `backdrop-blur`；
 *    舞台内尺寸一律用容器查询单位 `cqw`，随舞台边长等比缩放。舞台本身对读屏器隐藏，
 *    等价信息由右侧四幕文字承载。
 */
import type { AgentPlatform } from "@openhuddle/protocol";
import { Check, ChevronDown, User } from "lucide-react";
import type { MotionStyle, MotionValue } from "motion/react";
import { motion, useScroll, useSpring, useTransform } from "motion/react";
import type { CSSProperties, ReactNode } from "react";
import { useLayoutEffect, useRef, useState } from "react";
import { cn, usePrefersReducedMotion } from "../../../components/primitives/index.js";
import { PlatformGlyph } from "../../../components/ui/platform-icons.js";
import { usePortalI18n } from "../i18n/index.js";

/** 四幕文案键：短句标题 + 一句准确说明 */
const STORY_BEAT_KEYS = [
  {
    id: "beat-1",
    titleKey: "story.beat1.title",
    captionKey: "story.beat1.caption",
  },
  {
    id: "beat-2",
    titleKey: "story.beat2.title",
    captionKey: "story.beat2.caption",
  },
  {
    id: "beat-3",
    titleKey: "story.beat3.title",
    captionKey: "story.beat3.caption",
  },
  {
    id: "beat-4",
    titleKey: "story.beat4.title",
    captionKey: "story.beat4.caption",
  },
] as const;

/** 圆桌周长（SVG viewBox 1000，半径 310） */
const RING_LENGTH = 2 * Math.PI * 310;

type Point = readonly [number, number];

/** 空样式：减动效时不挂任何动效值（项目 `exactOptionalPropertyTypes` 禁止向可选属性传 `undefined`） */
const NO_MOTION: MotionStyle = {};

/** 三个座位（舞台边长百分比）：正上、右下、左下 */
const SEAT_TOP: Point = [50, 20];
const SEAT_RIGHT: Point = [76.8, 66.5];
const SEAT_LEFT: Point = [23.2, 66.5];

/**
 * 三个 Agent 的落座位与动效时刻（坐标均为舞台边长百分比）。
 */
const AGENTS: ReadonlyArray<{
  readonly platform: AgentPlatform;
  readonly name: string;
  readonly ownerKey: "story.owner.alex" | "story.owner.pangyan" | "story.owner.xiaolin";
  readonly chipClass: string;
  /** 落座位 */
  readonly seat: Point;
  /** 飞入起点位移 */
  readonly flyFrom: Point;
  /** 飞入进度区间 */
  readonly flyAt: readonly [number, number];
  /** 发言瞬间 */
  readonly speakAt: number;
  /** 发言气泡位置 */
  readonly bubbleAt: Point;
  /** 投票胶囊位置 */
  readonly voteAt: Point;
}> = [
  {
    platform: "claude_code",
    name: "Claude Code",
    ownerKey: "story.owner.alex",
    chipClass: "bg-[#F4ECDD] text-[#5C4528] dark:bg-[#2F261C] dark:text-[#F3CFA2]",
    seat: SEAT_TOP,
    flyFrom: [0, -46],
    flyAt: [0.03, 0.09],
    speakAt: 0.3,
    bubbleAt: [69.5, 10.5],
    voteAt: [34.5, 11],
  },
  {
    platform: "codex",
    name: "Codex",
    ownerKey: "story.owner.pangyan",
    chipClass: "bg-[#E1ECFF] text-[#244375] dark:bg-[#1A273D] dark:text-[#9FC5FF]",
    seat: SEAT_RIGHT,
    flyFrom: [46, 46],
    flyAt: [0.07, 0.13],
    speakAt: 0.36,
    bubbleAt: [85, 44],
    voteAt: [92.5, 57.5],
  },
  {
    platform: "cursor",
    name: "Cursor",
    ownerKey: "story.owner.xiaolin",
    chipClass: "bg-[#FFF1C2] text-[#5C4813] dark:bg-[#2F2816] dark:text-[#F5D687]",
    seat: SEAT_LEFT,
    flyFrom: [-46, 46],
    flyAt: [0.11, 0.17],
    speakAt: 0.42,
    bubbleAt: [15, 44],
    voteAt: [7.5, 57.5],
  },
];

/** 相邻 Agent 之间的传话：出发位 → 到达位 → 飞行区间 */
const PULSES: ReadonlyArray<{
  readonly from: Point;
  readonly to: Point;
  readonly at: readonly [number, number];
}> = [
  { from: SEAT_TOP, to: SEAT_RIGHT, at: [0.345, 0.385] },
  { from: SEAT_RIGHT, to: SEAT_LEFT, at: [0.405, 0.445] },
  { from: SEAT_LEFT, to: SEAT_TOP, at: [0.465, 0.5] },
];

/** 舞台内凹表面类 */
const INSET_CLASS =
  "border border-black/[0.06] bg-[#EFF1F4] dark:border-white/[0.08] dark:bg-[#141417]";

/** 非当前幕的说明淡化到的不透明度 */
const STEP_DIM = 0.34;

/** 碎屏文案类 */
const STAGE_LABEL_CLASS =
  "text-[11.5px] font-semibold tracking-wider text-[#5A6272] dark:text-[#8E8E96]";

/**
 * 生成随舞台边长缩放的字号样式（小舞台下有像素下限兜底）。
 * 必须走内联样式：Tailwind 只为源码中逐字出现的类名生成样式，运行时拼接的字号类不会生效。
 *
 * @param size - 相对舞台边长的字号（cqw）
 * @param min - 像素下限
 * @returns 仅含 `fontSize` 的样式对象
 */
function stageText(size: number, min = 8): CSSProperties {
  return { fontSize: `clamp(${String(min)}px, ${String(size)}cqw, 18px)` };
}

interface ScrubProps {
  readonly progress: MotionValue<number>;
  readonly reducedMotion: boolean;
  /** 入场进度区间 */
  readonly at: readonly [number, number];
  /** 退场进度区间（可选） */
  readonly out?: readonly [number, number] | undefined;
  /** 退场后的不透明度（默认 0） */
  readonly outOpacity?: number | undefined;
  /** 入场起始位移（舞台边长百分比），默认自下方 5% 浮入 */
  readonly from?: Point | undefined;
  /** 退场终止位移（舞台边长百分比） */
  readonly to?: Point | undefined;
  /** 入场起始缩放（默认 1） */
  readonly scale?: number | undefined;
  /** 缩放原点（舞台边长百分比，默认舞台中心）；传入后元素从自身位置弹出而非从圆心飞出 */
  readonly scaleOrigin?: Point | undefined;
  readonly className?: string | undefined;
  readonly children: ReactNode;
}

/**
 * 滚动驱动的「浮现」层：入场区间内淡入并位移归位，可选退场区间内淡出并位移离开。
 * 百分比位移与缩放均以本层自身为基准，故本层须铺满舞台（`absolute inset-0`）。
 *
 * @param props - 进度、入场/退场区间与位移参数
 * @returns 随进度浮现或退场的容器
 */
function Scrub(props: ScrubProps) {
  const { progress, at, out } = props;
  const [i0, i1] = at;
  const [o0, o1] = out ?? [2, 3];
  const from: Point = props.from ?? [0, 5];
  const to: Point = props.to ?? [0, -5];
  const outOpacity = props.outOpacity ?? 0;
  const opacity = useTransform(progress, [i0, i1, o0, o1], [0, 1, 1, outOpacity]);
  const x = useTransform(
    progress,
    [i0, i1, o0, o1],
    [`${String(from[0])}%`, "0%", "0%", `${String(to[0])}%`],
  );
  const y = useTransform(
    progress,
    [i0, i1, o0, o1],
    [`${String(from[1])}%`, "0%", "0%", `${String(to[1])}%`],
  );
  const scale = useTransform(progress, [i0, i1], [props.scale ?? 1, 1]);
  const scaleOrigin = props.scaleOrigin;

  if (props.reducedMotion) {
    return (
      <div className={props.className} style={{ opacity: out === undefined ? 1 : outOpacity }}>
        {props.children}
      </div>
    );
  }
  return (
    <motion.div
      className={props.className}
      style={{
        opacity,
        x,
        y,
        scale,
        ...(scaleOrigin === undefined
          ? {}
          : { transformOrigin: `${String(scaleOrigin[0])}% ${String(scaleOrigin[1])}%` }),
      }}
    >
      {props.children}
    </motion.div>
  );
}

interface TravelProps {
  readonly progress: MotionValue<number>;
  readonly from: Point;
  readonly to: Point;
  readonly at: readonly [number, number];
}

/**
 * 滚动驱动的「传话」光点：在两个舞台坐标之间随进度直线飞行，首尾各淡入淡出。
 * 位移挂在铺满舞台的外层上，故百分比以舞台边长为基准。
 *
 * @param props - 进度、起止坐标与飞行区间
 * @returns 沿弦线飞行的光点
 */
function Travel(props: TravelProps) {
  const [a, b] = props.at;
  const [x0, y0] = props.from;
  const [x1, y1] = props.to;
  const x = useTransform(props.progress, [a, b], ["0%", `${String(x1 - x0)}%`]);
  const y = useTransform(props.progress, [a, b], ["0%", `${String(y1 - y0)}%`]);
  const opacity = useTransform(props.progress, [a, a + 0.012, b - 0.012, b], [0, 1, 1, 0]);

  return (
    <div className="pointer-events-none absolute inset-0">
      <motion.div className="absolute inset-0" style={{ x, y, opacity }}>
        <span
          className="absolute h-[2.4cqw] w-[2.4cqw] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#111318] shadow-[0_0_0_4px_rgba(17,19,24,0.12)] dark:bg-white dark:shadow-[0_0_0_4px_rgba(255,255,255,0.14)]"
          style={{ left: `${String(x0)}%`, top: `${String(y0)}%` }}
        />
      </motion.div>
    </div>
  );
}

interface StageStatusProps {
  readonly progress: MotionValue<number>;
  readonly reducedMotion: boolean;
  readonly shown: readonly [number, number];
  readonly children: ReactNode;
}

/**
 * 舞台右上角的状态胶囊：仅在 `shown` 进度区间内可见（三枚胶囊首尾相接形成状态切换）。
 *
 * @param props - 进度、可见区间与胶囊文案
 * @returns 状态胶囊
 */
function StageStatus(props: StageStatusProps) {
  const [a, b] = props.shown;
  const opacity = useTransform(props.progress, [a, a + 0.015, b - 0.015, b], [0, 1, 1, 0]);

  if (props.reducedMotion) {
    return b >= 1 ? (
      <span className="absolute right-0 top-0 inline-flex items-center gap-1.5 rounded-full bg-black/[0.05] px-2.5 py-1 text-[11.5px] font-medium text-[#4B5565] dark:bg-white/[0.07] dark:text-[#C4C4CA]">
        {props.children}
      </span>
    ) : null;
  }
  return (
    <motion.span
      className="absolute right-0 top-0 inline-flex items-center gap-1.5 rounded-full bg-black/[0.05] px-2.5 py-1 text-[11.5px] font-medium text-[#4B5565] dark:bg-white/[0.07] dark:text-[#C4C4CA]"
      style={{ opacity }}
    >
      {props.children}
    </motion.span>
  );
}

interface SpokeProps {
  readonly progress: MotionValue<number>;
  readonly reducedMotion: boolean;
  readonly seat: Point;
  readonly at: readonly [number, number];
}

/**
 * 圆心到某个座位的连线：Agent 落座后自圆心向外画出；减动效时直接完整显示。
 *
 * @param props - 进度、减动效标记、座位坐标与画出区间
 * @returns 自圆心画向座位的连线
 */
function Spoke(props: SpokeProps) {
  const [a, b] = props.at;
  const offset = useTransform(props.progress, [a, b], [100, 0]);
  return (
    <motion.line
      x1="500"
      y1="510"
      x2={props.seat[0] * 10}
      y2={props.seat[1] * 10}
      pathLength={100}
      strokeDasharray="100"
      className="fill-none stroke-[1.5]"
      style={props.reducedMotion ? NO_MOTION : { strokeDashoffset: offset }}
    />
  );
}

interface StoryStageProps {
  readonly progress: MotionValue<number>;
  readonly reducedMotion: boolean;
  readonly className?: string | undefined;
}

/**
 * 渲染圆桌舞台：品牌圆桌标识的放大演绎——Agent 飞入落座并连线、沿圆桌传话、轮次环走满、
 * 气泡汇聚成提案卡、最终由居中的人类批准。
 *
 * @param props - 滚动进度、减动效标记与布局类
 * @returns 圆桌舞台
 */
function StoryStage(props: StoryStageProps) {
  const { progress, reducedMotion } = props;
  const { t } = usePortalI18n();
  const live = <T extends object>(value: T): T | MotionStyle => (reducedMotion ? NO_MOTION : value);

  // 圆桌：第一幕自顶点画出
  const ringOffset = useTransform(progress, [0.02, 0.16], [RING_LENGTH, 0]);
  // 轮次环：第二幕随发言逐段走满，拍板时让位于绿色完成环
  const budgetFill = useTransform(progress, [0.28, 0.35, 0.43, 0.51], [0, 2 / 6, 4 / 6, 1]);
  const budgetOffset = useTransform(budgetFill, (value) => RING_LENGTH * (1 - value));
  const budgetOpacity = useTransform(progress, [0.8, 0.85], [1, 0]);
  const amberOpacity = useTransform(progress, [0.5, 0.54, 0.8, 0.85], [0, 1, 1, 0]);
  const doneOpacity = useTransform(progress, [0.81, 0.86], [0, 1]);
  const innerGuideOpacity = useTransform(progress, [0.5, 0.56], [1, 0]);
  const spokeOpacity = useTransform(progress, [0.26, 0.3, 0.49, 0.53], [0.4, 0.16, 0.16, 0]);
  // 拍板涟漪
  const rippleScale = useTransform(progress, [0.84, 0.99], [0.42, 1]);
  const rippleOpacity = useTransform(progress, [0.84, 0.9, 0.99], [0, 0.75, 0]);
  const hidden = { opacity: 0 } as const;

  return (
    <div
      aria-hidden="true"
      className={cn(
        "relative liquid-glass-modal [container-type:size] select-none overflow-hidden rounded-[24px] text-[#111318] sm:rounded-[32px] dark:bg-[#16171C]/[0.76] dark:text-[#F2F2F4]",
        props.className,
      )}
    >
      {/* 角标：左上固定名，右上状态胶囊三段切换 */}
      <div className="absolute inset-x-0 top-0 flex items-start justify-between px-[2.6cqw] pt-[2.4cqw]">
        <span className={cn("inline-flex items-center gap-2", STAGE_LABEL_CLASS)}>
          <span className="h-px w-4 bg-current" />
          {t("story.stage.label")}
        </span>
        <span className="relative h-6 w-[108px]">
          <StageStatus progress={progress} reducedMotion={reducedMotion} shown={[-0.1, 0.15]}>
            <span className="h-1.5 w-1.5 rounded-full bg-[#939BAD] dark:bg-[#63636B]" />
            {t("story.stage.waiting")}
          </StageStatus>
          <StageStatus progress={progress} reducedMotion={reducedMotion} shown={[0.15, 0.81]}>
            <span className="h-1.5 w-1.5 rounded-full bg-[#16A34A] dark:bg-[#34D399]" />
            {t("story.stage.discussing")}
          </StageStatus>
          <StageStatus progress={progress} reducedMotion={reducedMotion} shown={[0.81, 1.1]}>
            <span className="h-1.5 w-1.5 rounded-full bg-[#16A34A] dark:bg-[#34D399]" />
            {t("story.stage.approved")}
          </StageStatus>
        </span>
      </div>

      {/* 圆桌、连线与轮次环 */}
      <svg aria-hidden="true" viewBox="0 0 1000 1000" className="absolute inset-0 h-full w-full">
        <circle
          cx="500"
          cy="510"
          r="385"
          className="fill-none stroke-[#111318] stroke-[1.5] opacity-[0.14] dark:stroke-white dark:opacity-[0.12]"
        />
        <motion.circle
          cx="500"
          cy="510"
          r="185"
          className="fill-none stroke-[#111318] stroke-[1.5] opacity-[0.2] dark:stroke-white dark:opacity-[0.14]"
          style={reducedMotion ? NO_MOTION : { opacity: innerGuideOpacity }}
        />
        <motion.g
          className="stroke-[#111318] opacity-20 dark:stroke-white"
          style={reducedMotion ? NO_MOTION : { opacity: spokeOpacity }}
        >
          {AGENTS.map((agent) => (
            <Spoke
              key={`spoke-${agent.name}`}
              progress={progress}
              reducedMotion={reducedMotion}
              seat={agent.seat}
              at={[agent.flyAt[1], agent.flyAt[1] + 0.05]}
            />
          ))}
        </motion.g>
        <g transform="rotate(-90 500 510)">
          <motion.circle
            cx="500"
            cy="510"
            r="310"
            className="fill-none stroke-[#111318] stroke-[3] dark:stroke-white"
            strokeDasharray={RING_LENGTH}
            strokeLinecap="round"
            style={live({ strokeDashoffset: ringOffset })}
          />
          <motion.circle
            cx="500"
            cy="510"
            r="310"
            className="fill-none stroke-[#111318] stroke-[7] dark:stroke-white"
            strokeDasharray={RING_LENGTH}
            strokeLinecap="round"
            style={
              reducedMotion ? NO_MOTION : { strokeDashoffset: budgetOffset, opacity: budgetOpacity }
            }
          />
          <motion.circle
            cx="500"
            cy="510"
            r="310"
            className="fill-none stroke-[#D97706] stroke-[7] dark:stroke-[#F59E0B]"
            strokeLinecap="round"
            style={reducedMotion ? hidden : { opacity: amberOpacity }}
          />
          <motion.circle
            cx="500"
            cy="510"
            r="310"
            className="fill-none stroke-[#15803D] stroke-[7] dark:stroke-[#4ADE80]"
            strokeLinecap="round"
            style={reducedMotion ? NO_MOTION : { opacity: doneOpacity }}
          />
        </g>
      </svg>

      {/* 三位 Agent：飞入落座 */}
      {AGENTS.map((agent) => (
        <Scrub
          key={agent.name}
          progress={progress}
          reducedMotion={reducedMotion}
          at={agent.flyAt}
          from={agent.flyFrom}
          className="absolute inset-0"
        >
          <div
            className="absolute -translate-x-1/2 -translate-y-1/2"
            style={{ left: `${String(agent.seat[0])}%`, top: `${String(agent.seat[1])}%` }}
          >
            <div
              className={cn(
                "flex h-[13cqw] w-[13cqw] items-center justify-center rounded-full shadow-[0_10px_28px_-10px_rgba(15,23,42,0.45)] ring-1 ring-black/[0.06] dark:ring-white/[0.12]",
                agent.chipClass,
              )}
            >
              <PlatformGlyph platform={agent.platform} className="h-[7cqw] w-[7cqw]" />
            </div>
            <p
              className="mt-[1cqw] whitespace-nowrap text-center font-semibold"
              style={stageText(2.2, 8)}
            >
              {agent.name}
            </p>
            <p
              className="whitespace-nowrap text-center text-[#687082] dark:text-[#8E8E96]"
              style={stageText(1.8, 7)}
            >
              {t(agent.ownerKey)}
            </p>
            <Scrub
              progress={progress}
              reducedMotion={reducedMotion}
              at={[agent.flyAt[1], agent.flyAt[1] + 0.03]}
              out={[0.27, 0.3]}
              className="relative mt-[0.8cqw] flex justify-center"
            >
              <span
                className="inline-flex items-center gap-[0.6cqw] whitespace-nowrap rounded-full bg-[#DCFCE7] px-[1.3cqw] py-[0.5cqw] font-semibold text-[#14532D] ring-1 ring-inset ring-[#15803D]/25 dark:bg-[#132C1F] dark:text-[#D1FAE5] dark:ring-[#4ADE80]/25"
                style={stageText(1.7, 7)}
              >
                <span className="h-[1.1cqw] w-[1.1cqw] rounded-full bg-[#15803D] dark:bg-[#4ADE80]" />
                {t("story.stage.joined")}
              </span>
            </Scrub>
          </div>
        </Scrub>
      ))}

      {/* 第二幕：发言气泡依次出现；第三幕汇聚向圆心 */}
      {AGENTS.map((agent, index) => {
        const speak = agent.speakAt;
        const leave = 0.5 + index * 0.018;
        return (
          <Scrub
            key={`bubble-${agent.name}`}
            progress={progress}
            reducedMotion={reducedMotion}
            at={[speak, speak + 0.035]}
            out={[leave, leave + 0.045]}
            from={[0, 4]}
            to={[50 - agent.bubbleAt[0], 51 - agent.bubbleAt[1]]}
            scale={0.82}
            scaleOrigin={agent.bubbleAt}
            className="absolute inset-0"
          >
            <div
              className={cn(
                "absolute w-[19cqw] -translate-x-1/2 -translate-y-1/2 space-y-[1.1cqw] rounded-[2.4cqw] p-[2cqw] shadow-[0_8px_22px_-10px_rgba(15,23,42,0.35)]",
                INSET_CLASS,
              )}
              style={{
                left: `${String(agent.bubbleAt[0])}%`,
                top: `${String(agent.bubbleAt[1])}%`,
              }}
            >
              <span className="block h-[1.1cqw] w-[88%] rounded-full bg-[#111318]/35 dark:bg-white/40" />
              <span className="block h-[1.1cqw] w-[62%] rounded-full bg-[#111318]/20 dark:bg-white/25" />
            </div>
          </Scrub>
        );
      })}
      {reducedMotion
        ? null
        : PULSES.map((pulse) => (
            <Travel
              key={`pulse-${String(pulse.from[0])}-${String(pulse.from[1])}`}
              progress={progress}
              from={pulse.from}
              to={pulse.to}
              at={pulse.at}
            />
          ))}

      {/* 圆心：人类（第三幕让位给提案卡） */}
      <Scrub
        progress={progress}
        reducedMotion={reducedMotion}
        at={[-0.04, 0]}
        out={[0.5, 0.545]}
        scale={0.6}
        className="absolute inset-0"
      >
        <div className="absolute left-[50%] top-[51%] -translate-x-1/2 -translate-y-1/2">
          <div className="flex h-[12cqw] w-[12cqw] items-center justify-center rounded-full bg-[#111318] text-white shadow-[0_14px_36px_-12px_rgba(17,19,24,0.7)] dark:bg-[#F2F2F4] dark:text-[#111318]">
            <User aria-hidden="true" className="h-[5.5cqw] w-[5.5cqw]" />
          </div>
          <p className="mt-[1cqw] text-center font-semibold" style={stageText(2.2, 8)}>
            {t("story.stage.you")}
          </p>
        </div>
      </Scrub>

      {/* 第三幕：提案卡在圆心展开 */}
      <Scrub
        progress={progress}
        reducedMotion={reducedMotion}
        at={[0.545, 0.6]}
        from={[0, 7]}
        scale={0.74}
        className="absolute inset-0"
      >
        <div
          className={cn(
            "absolute left-[50%] top-[51%] w-[47cqw] -translate-x-1/2 -translate-y-1/2 rounded-[3.2cqw] border border-black/[0.07] bg-white p-[2.6cqw] shadow-[0_28px_60px_-18px_rgba(15,23,42,0.5)] dark:border-white/[0.1] dark:bg-[#1B1C21]",
          )}
        >
          <p className="font-semibold tracking-[-0.01em]" style={stageText(2.4, 9)}>
            {t("story.stage.proposalTitle")}
          </p>
          <div className="mt-[1.6cqw] space-y-[1.2cqw]">
            <div
              className="flex items-center gap-[1.4cqw] rounded-[1.8cqw] bg-[#DCFCE7] px-[1.8cqw] py-[1.3cqw] font-medium leading-snug text-[#14532D] ring-1 ring-inset ring-[#15803D]/30 dark:bg-[#132C1F] dark:text-[#D1FAE5] dark:ring-[#4ADE80]/30"
              style={stageText(1.9, 8)}
            >
              <Check aria-hidden="true" className="h-[1.9cqw] w-[1.9cqw] shrink-0" />
              {t("story.stage.option1")}
            </div>
            <div
              className="rounded-[1.8cqw] px-[1.8cqw] py-[1.3cqw] leading-snug text-[#5A6272] dark:text-[#9898A2]"
              style={stageText(1.9, 8)}
            >
              {t("story.stage.option2")}
            </div>
          </div>
          <div className="mt-[2cqw] flex items-center justify-between gap-[1.6cqw]">
            <span className="text-[#5A6272] dark:text-[#9898A2]" style={stageText(1.8, 7.5)}>
              {t("story.stage.votes")}
            </span>
            <span className="relative inline-flex overflow-hidden rounded-full bg-[#111318] font-semibold text-white dark:bg-[#F2F2F4] dark:text-[#111318]">
              <span className="whitespace-nowrap px-[2.4cqw] py-[1.2cqw]" style={stageText(1.9, 8)}>
                {t("story.stage.approveAction")}
              </span>
              <motion.span
                className="absolute inset-0 inline-flex items-center justify-center bg-[#15803D] text-white"
                style={reducedMotion ? NO_MOTION : { opacity: doneOpacity }}
              >
                <span
                  className="whitespace-nowrap px-[2.4cqw] py-[1.2cqw]"
                  style={stageText(1.9, 8)}
                >
                  {t("story.stage.approvedAction")}
                </span>
              </motion.span>
            </span>
          </div>
          {/* 拍板角标 */}
          <motion.span
            className="absolute -right-[1.6cqw] -top-[1.6cqw] flex h-[6.4cqw] w-[6.4cqw] items-center justify-center rounded-full bg-[#15803D] text-white shadow-[0_8px_20px_-6px_rgba(21,128,61,0.7)]"
            style={live({ scale: doneOpacity })}
          >
            <Check aria-hidden="true" strokeWidth={3} className="h-[3.6cqw] w-[3.6cqw]" />
          </motion.span>
        </div>
      </Scrub>

      {/* 投票胶囊 */}
      {AGENTS.map((agent) => (
        <Scrub
          key={`vote-${agent.name}`}
          progress={progress}
          reducedMotion={reducedMotion}
          at={[agent.speakAt + 0.32, agent.speakAt + 0.35]}
          scale={0.6}
          scaleOrigin={agent.voteAt}
          className="absolute inset-0"
        >
          <span
            className="absolute inline-flex -translate-x-1/2 -translate-y-1/2 items-center gap-[0.7cqw] whitespace-nowrap rounded-full bg-[#DCFCE7] px-[1.5cqw] py-[0.7cqw] font-semibold text-[#14532D] ring-1 ring-inset ring-[#15803D]/25 dark:bg-[#132C1F] dark:text-[#D1FAE5] dark:ring-[#4ADE80]/25"
            style={{ left: `${String(agent.voteAt[0])}%`, top: `${String(agent.voteAt[1])}%` }}
          >
            <Check aria-hidden="true" strokeWidth={3} className="h-[1.8cqw] w-[1.8cqw]" />
            <span style={stageText(1.8, 7.5)}>{t("story.stage.voteEndorse")}</span>
          </span>
        </Scrub>
      ))}

      {/* 第四幕：拍板涟漪 */}
      <motion.div
        className="pointer-events-none absolute left-[50%] top-[51%] h-[62cqw] w-[62cqw] -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-[#15803D] dark:ring-[#4ADE80]"
        style={reducedMotion ? hidden : { scale: rippleScale, opacity: rippleOpacity }}
      />

      {/* 滚动提示：钉住初期可见，开始演绎后淡出 */}
      {reducedMotion ? null : (
        <Scrub
          progress={progress}
          reducedMotion={reducedMotion}
          at={[-2, -1]}
          out={[0, 0.05]}
          to={[0, 0]}
          className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center pb-[2.4cqw]"
        >
          <span className="inline-flex items-center gap-1.5 text-[11.5px] font-medium text-[#5A6272] dark:text-[#9898A2]">
            {t("story.stage.scrollHint")}
            <ChevronDown aria-hidden="true" className="h-3.5 w-3.5" />
          </span>
        </Scrub>
      )}
    </div>
  );
}

interface StoryStepProps {
  readonly progress: MotionValue<number>;
  readonly reducedMotion: boolean;
  readonly index: number;
  readonly title: string;
  readonly caption: string;
}

/**
 * 渲染单幕说明：当前幕内完全点亮，左侧进度条随幕内进度走满；前后幕淡化。
 *
 * @param props - 进度、减动效标记、幕序号与文案
 * @returns 带进度条的一幕说明
 */
function StoryStep(props: StoryStepProps) {
  const count = STORY_BEAT_KEYS.length;
  const start = props.index / count;
  const end = (props.index + 1) / count;
  const isFirst = props.index === 0;
  const isLast = props.index === count - 1;
  const opacity = useTransform(
    props.progress,
    isFirst
      ? [end - 0.012, end]
      : isLast
        ? [start - 0.012, start]
        : [start - 0.012, start, end - 0.012, end],
    isFirst ? [1, STEP_DIM] : isLast ? [STEP_DIM, 1] : [STEP_DIM, 1, 1, STEP_DIM],
  );
  const fill = useTransform(props.progress, [start, end], [0, 1]);

  return (
    <motion.li
      className="relative list-none pl-5 sm:pl-8"
      style={props.reducedMotion ? NO_MOTION : { opacity }}
    >
      <span
        aria-hidden="true"
        className="absolute bottom-0 left-0 top-0 w-[2px] rounded-full bg-black/[0.07] dark:bg-white/[0.09]"
      />
      <motion.span
        aria-hidden="true"
        className="absolute bottom-0 left-0 top-0 w-[2px] origin-top rounded-full bg-[#111318] dark:bg-white"
        style={props.reducedMotion ? NO_MOTION : { scaleY: fill }}
      />
      <p className="font-mono text-[12px] font-semibold tracking-wider text-[#5A6272] dark:text-[#8E8E96]">
        0{String(props.index + 1)}
      </p>
      <p className="mt-1 text-[20px] font-semibold leading-[1.2] tracking-[-0.025em] text-[#111318] sm:text-[27px] dark:text-[#F2F2F4]">
        {props.title}
      </p>
      <p className="mt-1.5 hidden max-w-sm text-pretty text-[14px] leading-relaxed text-[#525A6B] sm:block dark:text-[#A0A2AC]">
        {props.caption}
      </p>
    </motion.li>
  );
}

/** 钉住期间滚过的屏幕数（桌面 2.8 屏 / 窄屏 2.2 屏，平均每幕约 0.6 屏） */
const TRAVEL_DESKTOP = 2.8;
const TRAVEL_MOBILE = 2.2;
/** 窄屏布局断点（与 Tailwind `lg` 一致） */
const DESKTOP_MIN_WIDTH = 1024;

/**
 * 渲染「一场 Huddle」滚动剧场：整节钉在滚动区，向下滚动依次演绎四幕；回滚即倒放。
 *
 * @returns 吸顶滚动剧场分节
 */
export function PortalStorySection() {
  const { t } = usePortalI18n();
  const reducedMotion = usePrefersReducedMotion();
  const sectionRef = useRef<HTMLElement | null>(null);
  const scrollerRef = useRef<HTMLElement | null>(null);
  const [screen, setScreen] = useState<{ readonly height: number; readonly width: number }>({
    height: 0,
    width: 0,
  });

  // 吸顶屏幕高度必须等于滚动容器可视高度：钉住瞬间恰好铺满，进度 0/1 与钉住/解钉严格对齐。
  // 滚动容器由本节向上查找而非由父级传入：祖先元素的 ref 要等子组件布局副作用跑完才挂上，
  // 传入的 ref 在此恒为 null；本布局副作用先于 `useScroll` 的监听注册执行，故同时充作其容器。
  useLayoutEffect(() => {
    const container = sectionRef.current?.closest<HTMLElement>("[data-portal-scroller]") ?? null;
    scrollerRef.current = container;
    if (container === null) {
      return undefined;
    }
    const measure = (): void => {
      setScreen((prev) => {
        const height = container.clientHeight;
        const width = container.clientWidth;
        return prev.height === height && prev.width === width ? prev : { height, width };
      });
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      return undefined;
    }
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => {
      observer.disconnect();
    };
  }, []);

  const { scrollYProgress } = useScroll({
    container: scrollerRef,
    target: sectionRef,
    offset: ["start start", "end end"],
  });
  // 轻度弹簧跟随：滚轮分步滚动时幕间过渡更连贯，倒滚时略带惯性
  const progress = useSpring(scrollYProgress, {
    stiffness: 190,
    damping: 34,
    mass: 0.5,
    restDelta: 0.0004,
  });

  const travel = screen.width >= DESKTOP_MIN_WIDTH ? TRAVEL_DESKTOP : TRAVEL_MOBILE;
  const pinnedHeight: number | string = screen.height > 0 ? screen.height : "100dvh";
  // 分节高度：量得滚动区高度后为数值（React 自动补 px）；未量得时回退到 100dvh 的 CSS calc
  const sectionHeight: number | string =
    screen.height > 0 ? screen.height * (1 + travel) : `calc(100dvh * ${String(1 + travel)})`;

  const captions = (
    <ol className="m-0 flex shrink-0 flex-col gap-4 p-0 sm:gap-7 lg:col-span-5 lg:justify-center lg:py-8">
      {STORY_BEAT_KEYS.map((beat, index) => (
        <StoryStep
          key={beat.id}
          progress={progress}
          reducedMotion={reducedMotion}
          index={index}
          title={t(beat.titleKey)}
          caption={t(beat.captionKey)}
        />
      ))}
    </ol>
  );

  if (reducedMotion) {
    return (
      <section id="portal-story" ref={sectionRef} className="shrink-0 py-2">
        <div className="flex flex-col gap-6 lg:grid lg:grid-cols-12 lg:items-center lg:gap-10">
          <div className="lg:col-span-7">
            <StoryStage
              progress={progress}
              reducedMotion={reducedMotion}
              className="mx-auto aspect-square w-full max-w-[560px]"
            />
          </div>
          {captions}
        </div>
      </section>
    );
  }

  return (
    <section
      id="portal-story"
      ref={sectionRef}
      className="relative shrink-0"
      style={{ height: sectionHeight }}
    >
      <div
        className="sticky top-0 flex min-h-0 flex-col gap-4 py-3 sm:py-5 lg:grid lg:grid-cols-12 lg:grid-rows-1 lg:gap-10"
        style={{ height: pinnedHeight }}
      >
        <div className="relative flex min-h-0 min-w-0 flex-1 items-center justify-center [container-type:size] lg:col-span-7">
          <StoryStage
            progress={progress}
            reducedMotion={reducedMotion}
            className="aspect-square h-[min(100cqh,100cqw)] w-[min(100cqh,100cqw)]"
          />
        </div>
        {captions}
      </div>
    </section>
  );
}
