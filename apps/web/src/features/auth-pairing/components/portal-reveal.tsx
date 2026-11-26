/**
 * @module web/features/auth-pairing/portal-reveal
 * @description 门户滚动渐进显现原语：章节眉标划线、标题遮罩上浮、卡片与条目错峰级联。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 一次性触发：所有显现均为 `viewport.once`，回滚后再下滑不重复播放，不打断阅读。
 * 2. 减动效豁免：系统开启「减少动态效果」时不挂隐藏初态而直接渲染终态，杜绝内容滞留不可见。
 * 3. 合成零负担：仅驱动 `transform` / `opacity`（不触发 Layout / Paint），且不改变文档流尺寸，
 *    锚点定位与 120Hz 顺滑滚动不受影响（对齐 portal-showcase-sections 的光学与性能不变量 2）。
 * 4. 遮罩标题的观察目标恒为未变换的裁剪容器：`IntersectionObserver` 会沿祖先裁剪矩形求交，
 *    位移到 130% 的标题自身与视口交为空，必须由外层容器触发再经 variants 传播，否则永不显现。
 * 5. 低可见量阈值：窄屏下长卡片可能高于视口，`amount` 固定为 `0.12`，保证超高内容必然触发。
 */
import type { MotionProps } from "motion/react";
import type { ReactNode } from "react";
import {
  PORTAL_REVEAL,
  PORTAL_TITLE_REVEAL,
  cn,
  motion,
  usePrefersReducedMotion,
} from "../../../components/primitives/index.js";

/** 进入视口 12% 即触发，且仅触发一次 */
const REVEAL_VIEWPORT = { once: true, amount: 0.12 } as const;

/** 标题遮罩上浮的起止位移（130% 确保含下伸部字形完全落入遮罩之外） */
const TITLE_VARIANTS = {
  hidden: { y: "130%" },
  visible: { y: "0%" },
} as const;

/** 「显现容器」可展开到 `motion.*` 根元素的动效属性 */
type RevealTriggerProps = Pick<
  MotionProps,
  "variants" | "initial" | "whileInView" | "viewport" | "transition"
>;

/** 「显现条目」可展开到容器内 `motion.*` 元素的动效属性 */
type RevealItemProps = Pick<MotionProps, "variants" | "transition">;

/**
 * 生成「显现容器」动效属性：进入视口即自身淡入上浮，并把 `visible` 标签经 variants
 * 传播给内部所有条目与标题（条目各按自身 `transition` 错峰跟随）。
 *
 * @param reducedMotion - 系统是否开启「减少动态效果」
 * @param delay - 容器自身的错峰延迟（秒）
 * @returns 展开到卡片等 `motion.*` 根元素的动效属性
 */
export function portalRevealTrigger(reducedMotion: boolean, delay = 0): RevealTriggerProps {
  return {
    variants: { hidden: { opacity: 0, y: 14 }, visible: { opacity: 1, y: 0 } },
    initial: reducedMotion ? false : "hidden",
    whileInView: "visible",
    viewport: REVEAL_VIEWPORT,
    transition: { ...PORTAL_REVEAL, delay },
  };
}

/**
 * 生成「显现条目」动效属性（需位于某个显现容器之内，随容器的 `visible` 传播而播放）。
 *
 * @param delay - 相对容器触发的错峰延迟（秒）
 * @param distance - 上浮起始位移（像素）
 * @returns 展开到行、标题内层等 `motion.*` 元素的动效属性
 */
export function portalRevealItem(delay = 0, distance = 8): RevealItemProps {
  return {
    variants: { hidden: { opacity: 0, y: distance }, visible: { opacity: 1, y: 0 } },
    transition: { ...PORTAL_REVEAL, delay },
  };
}

/** `PortalEyebrow` 入参属性 */
export interface PortalEyebrowProps {
  readonly children: ReactNode;
  readonly delay?: number | undefined;
}

/**
 * 渲染章节眉标：左侧 20px 墨线自左向右划出，文字同步淡入。
 *
 * @param props - 眉标文案与错峰延迟
 * @returns 带划线动效的眉标段落
 */
export function PortalEyebrow(props: PortalEyebrowProps) {
  const reducedMotion = usePrefersReducedMotion();
  const delay = props.delay ?? 0;
  return (
    <motion.p
      {...portalRevealTrigger(reducedMotion, delay)}
      className="flex items-center gap-2 text-[12px] font-semibold tracking-wider text-[#5A6272] dark:text-[#8E8E96]"
    >
      <motion.span
        aria-hidden="true"
        variants={{ hidden: { scaleX: 0 }, visible: { scaleX: 1 } }}
        transition={{ ...PORTAL_REVEAL, duration: 0.45, delay: delay + 0.05 }}
        className="h-px w-5 shrink-0 origin-left bg-current"
      />
      {props.children}
    </motion.p>
  );
}

/** `PortalTitleReveal` 入参属性 */
export interface PortalTitleRevealProps {
  readonly children: ReactNode;
  readonly delay?: number | undefined;
  /** 追加到遮罩容器上的布局类（如卡片内首元素时传 `mt-0` 抵消默认上间距） */
  readonly className?: string | undefined;
}

/**
 * 渲染遮罩上浮标题：标题从下方裁剪遮罩中浮出，是各章节滚动显现的主节拍。
 *
 * @param props - 标题元素、错峰延迟与遮罩容器布局类
 * @returns 包裹标题的裁剪遮罩容器
 */
export function PortalTitleReveal(props: PortalTitleRevealProps) {
  const reducedMotion = usePrefersReducedMotion();
  return (
    <motion.div
      className={cn("-mb-1 mt-0.5 overflow-hidden py-1", props.className)}
      initial={reducedMotion ? false : "hidden"}
      whileInView="visible"
      viewport={REVEAL_VIEWPORT}
    >
      <motion.div
        variants={TITLE_VARIANTS}
        transition={{ ...PORTAL_TITLE_REVEAL, delay: props.delay ?? 0 }}
      >
        {props.children}
      </motion.div>
    </motion.div>
  );
}

/** `PortalSectionHeader` 入参属性 */
export interface PortalSectionHeaderProps {
  readonly eyebrow: string;
  readonly title: ReactNode;
  readonly className?: string | undefined;
}

/**
 * 渲染门户章节头：眉标划线 → 标题浮出，两拍渐进。
 *
 * @param props - 眉标文案、章节标题与容器布局类
 * @returns 眉标与遮罩上浮标题组成的章节头
 */
export function PortalSectionHeader(props: PortalSectionHeaderProps) {
  return (
    <div className={cn("max-w-2xl", props.className)}>
      <PortalEyebrow>{props.eyebrow}</PortalEyebrow>
      <PortalTitleReveal delay={0.08}>
        <h2 className="text-balance text-[22px] font-semibold leading-[1.22] tracking-[-0.025em] text-[#111318] sm:text-[28px] dark:text-[#F2F2F4]">
          {props.title}
        </h2>
      </PortalTitleReveal>
    </div>
  );
}
