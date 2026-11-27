/**
 * @module web/features/auth-pairing/portal-reveal
 * @description 门户滚动渐进显现原语：章节眉标划线、标题逐词元遮罩上浮、卡片与条目错峰级联、数字滚动。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 一次性触发：所有显现均为 `viewport.once`，回滚后再下滑不重复播放，不打断阅读。
 * 2. 减动效豁免：系统开启「减少动态效果」时不挂隐藏初态而直接渲染终态，杜绝内容滞留不可见。
 * 3. 合成零负担：仅驱动 `transform` / `opacity`（不触发 Layout / Paint），且不改变文档流尺寸，
 *    锚点定位与 120Hz 顺滑滚动不受影响（对齐 portal-showcase-sections 的光学与性能不变量 2）。
 * 4. 遮罩标题的观察目标恒为未变换的裁剪容器：`IntersectionObserver` 会沿祖先裁剪矩形求交，
 *    位移到遮罩之外的词元自身与视口交为空，必须由外层容器触发再经 variants 传播，否则永不显现。
 * 5. 低可见量阈值：窄屏下长卡片可能高于视口，`amount` 固定为 `0.12`，保证超高内容必然触发。
 */
import type { MotionProps } from "motion/react";
import { animate, motion, useInView } from "motion/react";
import type { ReactNode } from "react";
import { useEffect, useRef } from "react";
import {
  PORTAL_REVEAL,
  PORTAL_TITLE_REVEAL,
  cn,
  usePrefersReducedMotion,
} from "../../../components/primitives/index.js";

/** 进入视口 12% 即触发，且仅触发一次 */
const REVEAL_VIEWPORT = { once: true, amount: 0.12 } as const;

/** 标题词元遮罩上浮的起止位移（130% 确保含下伸部字形完全落入遮罩之外） */
const TOKEN_VARIANTS = {
  hidden: { y: "130%" },
  visible: { y: "0%" },
} as const;

/** 相邻词元的上浮错峰间隔（秒） */
const TOKEN_STAGGER = 0.032;

/** 章节标题字号：桌面端放大到 48px，贴近「大字标题 + 短句」的排版节奏 */
const SECTION_TITLE_CLASS =
  "text-balance text-[28px] font-semibold leading-[1.14] tracking-[-0.03em] text-[#111318] sm:text-[40px] sm:leading-[1.1] lg:text-[48px] dark:text-[#F2F2F4]";

/** 「显现容器」可展开到 `motion.*` 根元素的动效属性 */
type RevealTriggerProps = Pick<
  MotionProps,
  "variants" | "initial" | "whileInView" | "viewport" | "transition"
>;

/** 「显现条目」可展开到容器内 `motion.*` 元素的动效属性 */
type RevealItemProps = Pick<MotionProps, "variants" | "transition">;

/**
 * 生成「显现容器」动效属性：进入视口即自身淡入上浮并轻微放大归位，同时把 `visible` 标签
 * 经 variants 传播给内部所有条目与标题（条目各按自身 `transition` 错峰跟随）。
 *
 * @param reducedMotion - 系统是否开启「减少动态效果」
 * @param delay - 容器自身的错峰延迟（秒）
 * @returns 展开到卡片等 `motion.*` 根元素的动效属性
 */
export function portalRevealTrigger(reducedMotion: boolean, delay = 0): RevealTriggerProps {
  return {
    variants: {
      hidden: { opacity: 0, y: 18, scale: 0.97 },
      visible: { opacity: 1, y: 0, scale: 1 },
    },
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

/**
 * 把标题拆成可逐个上浮的词元：拉丁词与数字整体保留、CJK 逐字、标点并入前一词元
 * （避免 inline-block 断行后标点出现在行首），空白原样保留。
 *
 * @param title - 标题全文
 * @returns 词元序列（空白词元用于还原词间距）
 */
export function splitTitleTokens(title: string): readonly string[] {
  const tokens: string[] = [];
  for (const ch of title) {
    const last = tokens[tokens.length - 1];
    const joinsLatin =
      last !== undefined && /[A-Za-z0-9@/+_-]$/.test(last) && /[A-Za-z0-9@/+_-]/.test(ch);
    const joinsPunct =
      last !== undefined && !/\s$/.test(last) && /^[，。、；：？！,.!?:;…]$/.test(ch);
    if (joinsLatin || joinsPunct) {
      tokens[tokens.length - 1] = `${last}${ch}`;
    } else {
      tokens.push(ch);
    }
  }
  return tokens;
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
 * 渲染遮罩上浮标题：传入字符串时逐词元依次浮出（全文经 `aria-label` 完整播报），
 * 传入元素时整块浮出；是各章节滚动显现的主节拍。
 *
 * @param props - 标题文本或元素、错峰延迟与遮罩容器布局类
 * @returns 包裹标题的裁剪遮罩容器
 */
export function PortalTitleReveal(props: PortalTitleRevealProps) {
  const reducedMotion = usePrefersReducedMotion();
  const delay = props.delay ?? 0;
  const child = props.children;

  return (
    <motion.div
      className={cn("-mb-1.5 mt-0.5 overflow-hidden py-1.5", props.className)}
      initial={reducedMotion ? false : "hidden"}
      whileInView="visible"
      viewport={REVEAL_VIEWPORT}
    >
      {typeof child === "string" ? (
        <span aria-label={child}>
          {splitTitleTokens(child).map((token, index) =>
            /^\s+$/.test(token) ? (
              token
            ) : (
              <span
                key={`${String(index)}-${token}`}
                aria-hidden="true"
                className="-my-[0.14em] inline-block overflow-hidden py-[0.14em] align-baseline"
              >
                <motion.span
                  variants={TOKEN_VARIANTS}
                  transition={{ ...PORTAL_TITLE_REVEAL, delay: delay + index * TOKEN_STAGGER }}
                  className="inline-block"
                >
                  {token}
                </motion.span>
              </span>
            ),
          )}
        </span>
      ) : (
        <motion.div variants={TOKEN_VARIANTS} transition={{ ...PORTAL_TITLE_REVEAL, delay }}>
          {child}
        </motion.div>
      )}
    </motion.div>
  );
}

/** `PortalSectionHeader` 入参属性 */
export interface PortalSectionHeaderProps {
  readonly eyebrow: string;
  readonly title: string;
  readonly className?: string | undefined;
  /** 标题下方的一句导语（可选） */
  readonly lead?: string | undefined;
}

/**
 * 渲染门户章节头：眉标划线 → 标题逐词元浮出 →（可选）导语淡入。
 *
 * @param props - 眉标文案、章节标题、容器布局类与可选导语
 * @returns 眉标与逐词元上浮标题组成的章节头
 */
export function PortalSectionHeader(props: PortalSectionHeaderProps) {
  const leadDelay = 0.08 + splitTitleTokens(props.title).length * TOKEN_STAGGER + 0.1;
  return (
    <div className={cn("max-w-3xl", props.className)}>
      <PortalEyebrow>{props.eyebrow}</PortalEyebrow>
      <PortalTitleReveal className="mt-1.5" delay={0.08}>
        <h2 className={SECTION_TITLE_CLASS}>{props.title}</h2>
      </PortalTitleReveal>
      {props.lead !== undefined ? (
        <motion.p
          {...portalRevealItem(leadDelay, 10)}
          className="mt-3 max-w-xl text-pretty text-[14px] leading-relaxed text-[#525A6B] sm:text-[16px] dark:text-[#A0A2AC]"
        >
          {props.lead}
        </motion.p>
      ) : null}
    </div>
  );
}

/** `PortalCountUp` 入参属性 */
export interface PortalCountUpProps {
  /** 目标数值 */
  readonly to: number;
  /** 数值后的单位（如「分钟」「Hz」） */
  readonly suffix?: string | undefined;
  readonly className?: string | undefined;
}

/**
 * 渲染进入视口后从 0 滚动到目标值的数字（只改文本节点，一次性触发；减动效时直接显示终值）。
 *
 * @param props - 目标数值、单位与布局类
 * @returns 大号数字文本节点
 */
export function PortalCountUp(props: PortalCountUpProps) {
  const reducedMotion = usePrefersReducedMotion();
  const ref = useRef<HTMLSpanElement | null>(null);
  const inView = useInView(ref, { once: true, amount: 0.6 });

  useEffect(() => {
    const node = ref.current;
    if (node === null || !inView || reducedMotion) {
      return undefined;
    }
    const controls = animate(0, props.to, {
      duration: 0.9,
      ease: [0.16, 1, 0.3, 1],
      onUpdate: (value) => {
        node.textContent = String(Math.round(value));
      },
    });
    return () => {
      controls.stop();
    };
  }, [inView, props.to, reducedMotion]);

  return (
    <span ref={ref} className={props.className}>
      {reducedMotion ? props.to : 0}
      {props.suffix ?? ""}
    </span>
  );
}
