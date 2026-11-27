/**
 * @module web/features/auth-pairing/portal-feature-sections
 * @description 门户「核心能力」与「性能与多端」两个功能分区：以带示意图的卡片网格和数字面板
 * 取代文字密集的条目列表。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 短句标题 + 一句准确说明：标题只负责记忆点，信息由说明文字完整承载，示意图不承担唯一信息。
 * 2. 示意图零模糊：卡片内示意图（`Shot`）不使用任何 `backdrop-blur`，卡片本身沿用无模糊分层表面。
 * 3. 文案锚点：被门户测试钉住的字符串（8 个平台名、三种协作拓扑名、群聊卡说明句）必须原样保留。
 * 4. 渐进显现：章节头逐词元浮出，卡片错峰淡入并轻微放大归位，示意图内元素依次级联。
 */
import {
  Keyboard,
  type LucideIcon,
  MessageSquareText,
  MonitorSmartphone,
  PlugZap,
  RotateCcw,
  Smartphone,
  Terminal,
} from "lucide-react";
import { motion } from "motion/react";
import type { ReactNode } from "react";
import { AppButton, cn, usePrefersReducedMotion } from "../../../components/primitives/index.js";
import { PlatformGlyph } from "../../../components/ui/platform-icons.js";
import { usePortalI18n } from "../i18n/index.js";
import {
  PortalCountUp,
  PortalSectionHeader,
  portalRevealItem,
  portalRevealTrigger,
} from "./portal-reveal.js";
import { PORTAL_SURFACE_CARD_CLASS } from "./portal-showcase-sections.js";
import {
  ClarifyShot,
  DiffShot,
  EscalateShot,
  GovernanceShot,
  OwnerShot,
  PhoneShot,
  ReconnectShot,
  SUPPORTED_AGENT_PLATFORMS,
  SandboxShot,
  Shot,
  TopologyShot,
} from "./portal-visuals.js";

/** `VisualCard` 入参属性 */
interface VisualCardProps {
  readonly reducedMotion: boolean;
  readonly delay?: number | undefined;
  /** 网格跨列等布局类 */
  readonly className?: string | undefined;
  /** 标题上方的小标签（如协作拓扑名） */
  readonly tag?: string | undefined;
  readonly title: string;
  readonly caption: ReactNode;
  /** 顶部示意图内容 */
  readonly shot: ReactNode;
  /** 说明文字下方的追加内容 */
  readonly children?: ReactNode | undefined;
  /** 示意图是否撑满卡片剩余高度（与同排内容更多的卡片等高时使用） */
  readonly fillShot?: boolean | undefined;
}

/**
 * 渲染带示意图的功能卡片：顶部取景框 + 短句标题 + 一句说明。
 *
 * @param props - 显现参数、布局类、文案、示意图与追加内容
 * @returns 随滚动错峰显现的功能卡片
 */
function VisualCard(props: VisualCardProps) {
  return (
    <motion.article
      {...portalRevealTrigger(props.reducedMotion, props.delay)}
      className={cn(PORTAL_SURFACE_CARD_CLASS, "flex min-w-0 flex-col p-3 sm:p-4", props.className)}
    >
      <Shot className={cn("rounded-[18px]", props.fillShot && "h-auto min-h-40 flex-1")}>
        {props.shot}
      </Shot>
      <div className="flex flex-1 flex-col px-1 pb-1 pt-4 sm:px-2">
        {props.tag === undefined ? null : (
          <motion.p
            {...portalRevealItem(0.1)}
            className="mb-1.5 text-[11.5px] font-semibold tracking-wider text-[#5A6272] dark:text-[#8E8E96]"
          >
            {props.tag}
          </motion.p>
        )}
        <motion.h3
          {...portalRevealItem(0.14)}
          className="text-[21px] font-semibold leading-[1.2] tracking-[-0.025em] text-[#111318] sm:text-[24px] dark:text-[#F2F2F4]"
        >
          {props.title}
        </motion.h3>
        <motion.p
          {...portalRevealItem(0.2)}
          className="mt-2 text-[13.5px] leading-relaxed text-[#525A6B] sm:text-[14px] dark:text-[#A0A2AC]"
        >
          {props.caption}
        </motion.p>
        {props.children}
      </div>
    </motion.article>
  );
}

/** 连通方式标签文案键 */
const CONNECT_METHOD_TAG_KEYS = [
  "capabilities.connect.tag1",
  "capabilities.connect.tag2",
  "capabilities.connect.tag3",
] as const;

/** 多端体验要点（稳定键 + 图标 + 标题与说明文案键） */
const MULTI_DEVICE_ITEM_KEYS: ReadonlyArray<{
  readonly id: string;
  readonly icon: LucideIcon;
  readonly titleKey:
    | "architecture.mobile.1.title"
    | "architecture.mobile.2.title"
    | "architecture.mobile.3.title"
    | "architecture.mobile.4.title";
  readonly detailKey:
    | "architecture.mobile.1.detail"
    | "architecture.mobile.2.detail"
    | "architecture.mobile.3.detail"
    | "architecture.mobile.4.detail";
}> = [
  {
    id: "keyboard",
    icon: Keyboard,
    titleKey: "architecture.mobile.1.title",
    detailKey: "architecture.mobile.1.detail",
  },
  {
    id: "back-gesture",
    icon: MessageSquareText,
    titleKey: "architecture.mobile.2.title",
    detailKey: "architecture.mobile.2.detail",
  },
  {
    id: "pwa",
    icon: Smartphone,
    titleKey: "architecture.mobile.3.title",
    detailKey: "architecture.mobile.3.detail",
  },
  {
    id: "desktop",
    icon: MonitorSmartphone,
    titleKey: "architecture.mobile.4.title",
    detailKey: "architecture.mobile.4.detail",
  },
];

/** 连接韧性要点（稳定键 + 图标 + 标题与说明文案键） */
const RESILIENCE_ITEM_KEYS: ReadonlyArray<{
  readonly id: string;
  readonly icon: LucideIcon;
  readonly titleKey: "architecture.resilience.1.title" | "architecture.resilience.2.title";
  readonly detailKey: "architecture.resilience.1.detail" | "architecture.resilience.2.detail";
}> = [
  {
    id: "reconnect",
    icon: RotateCcw,
    titleKey: "architecture.resilience.1.title",
    detailKey: "architecture.resilience.1.detail",
  },
  {
    id: "handoff",
    icon: PlugZap,
    titleKey: "architecture.resilience.2.title",
    detailKey: "architecture.resilience.2.detail",
  },
];

/**
 * 核心能力分区（`#portal-capabilities`）：群聊治理与工作台协作的 10 张示意图卡片。
 *
 * @returns 核心能力分区
 */
export function PortalCapabilitiesSection() {
  const { t } = usePortalI18n();
  const reducedMotion = usePrefersReducedMotion();

  return (
    <section id="portal-capabilities" className="shrink-0 scroll-mt-20">
      <PortalSectionHeader
        eyebrow={t("capabilities.eyebrow")}
        title={t("capabilities.title")}
        lead={t("capabilities.lead")}
      />

      <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-5 md:grid-cols-12">
        <VisualCard
          reducedMotion={reducedMotion}
          className="md:col-span-7"
          title={t("capabilities.connect.title")}
          caption={t("capabilities.connect.caption")}
          shot={
            <div className="flex w-full flex-col items-center gap-2.5 px-4">
              <motion.p
                {...portalRevealItem(0.16)}
                className="flex max-w-full items-center gap-2 rounded-full bg-[#111318] py-1.5 pl-3 pr-4 font-mono text-[11.5px] text-white dark:bg-[#F2F2F4] dark:text-[#111318]"
              >
                <Terminal aria-hidden="true" className="h-3.5 w-3.5 shrink-0 opacity-70" />
                <span className="truncate">{t("capabilities.connect.promptPill")}</span>
              </motion.p>
              <motion.div {...portalRevealItem(0.26)} className="grid w-[92%] grid-cols-4 gap-1.5">
                {SUPPORTED_AGENT_PLATFORMS.map((item, index) => (
                  <motion.span
                    key={item.platform}
                    {...portalRevealItem(index * 0.03, 5)}
                    className="flex min-w-0 items-center justify-center gap-1 rounded-[9px] border border-black/[0.05] bg-white px-1 py-1.5 dark:border-white/[0.07] dark:bg-[#1B1C21]"
                  >
                    <span
                      className={cn(
                        "inline-flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded-full ring-1 ring-inset ring-black/[0.06] dark:ring-white/[0.12]",
                        item.chipClass,
                      )}
                    >
                      <PlatformGlyph platform={item.platform} className="h-2.5 w-2.5" />
                    </span>
                    <span className="truncate text-[10.5px] font-medium text-[#1F2430] dark:text-[#E6E8EE]">
                      {item.label}
                    </span>
                  </motion.span>
                ))}
              </motion.div>
            </div>
          }
        >
          <motion.div {...portalRevealItem(0.3)} className="mt-3 flex flex-wrap gap-1.5">
            {CONNECT_METHOD_TAG_KEYS.map((tagKey) => (
              <span
                key={tagKey}
                className="rounded-full border border-black/[0.07] px-2.5 py-1 text-[11.5px] font-medium text-[#3B414E] dark:border-white/[0.1] dark:text-[#D4D4D8]"
              >
                {t(tagKey)}
              </span>
            ))}
          </motion.div>
        </VisualCard>

        <VisualCard
          reducedMotion={reducedMotion}
          delay={0.08}
          className="md:col-span-5"
          title={t("capabilities.huddle.title")}
          caption={t("capabilities.huddle.caption")}
          shot={<GovernanceShot />}
        />

        <VisualCard
          reducedMotion={reducedMotion}
          className="md:col-span-4"
          tag={t("capabilities.topo1.tag")}
          title={t("capabilities.topo1.title")}
          caption={t("capabilities.topo1.caption")}
          shot={<TopologyShot agents={1} />}
        />
        <VisualCard
          reducedMotion={reducedMotion}
          delay={0.08}
          className="md:col-span-4"
          tag={t("capabilities.topo2.tag")}
          title={t("capabilities.topo2.title")}
          caption={t("capabilities.topo2.caption")}
          shot={<TopologyShot agents={2} />}
        />
        <VisualCard
          reducedMotion={reducedMotion}
          delay={0.16}
          className="md:col-span-4"
          tag={t("capabilities.topo3.tag")}
          title={t("capabilities.topo3.title")}
          caption={t("capabilities.topo3.caption")}
          shot={<TopologyShot agents={3} />}
        />

        <VisualCard
          reducedMotion={reducedMotion}
          className="md:col-span-5"
          title={t("capabilities.clarify.title")}
          caption={t("capabilities.clarify.caption")}
          shot={<ClarifyShot />}
        />
        <VisualCard
          reducedMotion={reducedMotion}
          delay={0.08}
          className="md:col-span-7"
          title={t("capabilities.diff.title")}
          caption={t("capabilities.diff.caption")}
          shot={<DiffShot />}
        />

        <VisualCard
          reducedMotion={reducedMotion}
          className="md:col-span-4"
          title={t("capabilities.sandbox.title")}
          caption={t("capabilities.sandbox.caption")}
          shot={<SandboxShot />}
        />
        <VisualCard
          reducedMotion={reducedMotion}
          delay={0.08}
          className="md:col-span-4"
          title={t("capabilities.owner.title")}
          caption={t("capabilities.owner.caption")}
          shot={<OwnerShot />}
        />
        <VisualCard
          reducedMotion={reducedMotion}
          delay={0.16}
          className="md:col-span-4"
          title={t("capabilities.escalate.title")}
          caption={t("capabilities.escalate.caption")}
          shot={<EscalateShot />}
        />
      </div>
    </section>
  );
}

/** `StatTile` 入参属性 */
interface StatTileProps {
  readonly reducedMotion: boolean;
  readonly delay?: number | undefined;
  readonly value: ReactNode;
  readonly unit?: string | undefined;
  readonly label: string;
}

/**
 * 渲染数字面板：大号数字 + 单位 + 一句说明。
 *
 * @param props - 显现参数、数值、单位与说明
 * @returns 数字面板卡片
 */
function StatTile(props: StatTileProps) {
  return (
    <motion.div
      {...portalRevealTrigger(props.reducedMotion, props.delay)}
      className={cn(PORTAL_SURFACE_CARD_CLASS, "flex min-w-0 flex-col justify-between p-5 sm:p-6")}
    >
      <p className="flex items-baseline gap-1.5 text-[44px] font-semibold leading-none tracking-[-0.045em] text-[#111318] sm:text-[56px] dark:text-[#F2F2F4]">
        {props.value}
        {props.unit === undefined ? null : (
          <span className="text-[18px] font-semibold tracking-[-0.01em] text-[#5A6272] sm:text-[22px] dark:text-[#9898A2]">
            {props.unit}
          </span>
        )}
      </p>
      <p className="mt-3 text-[13px] leading-relaxed text-[#525A6B] dark:text-[#A0A2AC]">
        {props.label}
      </p>
    </motion.div>
  );
}

export interface PortalArchitectureSectionProps {
  readonly onOpenPwaGuide: () => void;
}

/**
 * 性能与多端体验分区（`#portal-architecture`）：四块数字面板 + 断线重连与手机端两张示意图卡片。
 *
 * @param props - 打开「添加到主屏幕」指引的回调
 * @returns 性能与多端体验分区
 */
export function PortalArchitectureSection(props: PortalArchitectureSectionProps) {
  const { t } = usePortalI18n();
  const reducedMotion = usePrefersReducedMotion();

  return (
    <section id="portal-architecture" className="shrink-0 scroll-mt-20">
      <PortalSectionHeader
        eyebrow={t("architecture.eyebrow")}
        title={t("architecture.title")}
        lead={t("architecture.lead")}
      />

      <div className="mt-8 grid grid-cols-2 gap-4 sm:gap-5 lg:grid-cols-4">
        <StatTile
          reducedMotion={reducedMotion}
          value={t("architecture.stat1.value")}
          label={t("architecture.stat1.label")}
        />
        <StatTile
          reducedMotion={reducedMotion}
          delay={0.06}
          value={<PortalCountUp to={15} />}
          unit={t("architecture.stat2.unit")}
          label={t("architecture.stat2.label")}
        />
        <StatTile
          reducedMotion={reducedMotion}
          delay={0.12}
          value={<PortalCountUp to={120} />}
          unit={t("architecture.stat3.unit")}
          label={t("architecture.stat3.label")}
        />
        <StatTile
          reducedMotion={reducedMotion}
          delay={0.18}
          value="0"
          unit={t("architecture.stat4.unit")}
          label={t("architecture.stat4.label")}
        />
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 sm:gap-5 md:grid-cols-12">
        <VisualCard
          reducedMotion={reducedMotion}
          className="md:col-span-7"
          title={t("architecture.reconnect.title")}
          fillShot={true}
          caption={t("architecture.reconnect.caption")}
          shot={<ReconnectShot />}
        >
          <motion.dl
            {...portalRevealItem(0.28)}
            className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-x-4"
          >
            {RESILIENCE_ITEM_KEYS.map((item) => (
              <div key={item.id} className="min-w-0">
                <dt className="flex items-center gap-1.5 text-[12.5px] font-semibold text-[#111318] dark:text-[#F2F2F4]">
                  <item.icon
                    aria-hidden="true"
                    className="h-3.5 w-3.5 shrink-0 text-[#5A6272] dark:text-[#9898A2]"
                  />
                  <span className="truncate">{t(item.titleKey)}</span>
                </dt>
                <dd className="mt-0.5 text-[11.5px] leading-snug text-[#5A6272] dark:text-[#9898A2]">
                  {t(item.detailKey)}
                </dd>
              </div>
            ))}
          </motion.dl>
        </VisualCard>
        <VisualCard
          reducedMotion={reducedMotion}
          delay={0.08}
          className="md:col-span-5"
          title={t("architecture.mobile.title")}
          caption={t("architecture.mobile.caption")}
          shot={<PhoneShot />}
        >
          <motion.dl {...portalRevealItem(0.28)} className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3">
            {MULTI_DEVICE_ITEM_KEYS.map((item) => (
              <div key={item.id} className="min-w-0">
                <dt className="flex items-center gap-1.5 text-[12.5px] font-semibold text-[#111318] dark:text-[#F2F2F4]">
                  <item.icon
                    aria-hidden="true"
                    className="h-3.5 w-3.5 shrink-0 text-[#5A6272] dark:text-[#9898A2]"
                  />
                  <span className="truncate">{t(item.titleKey)}</span>
                </dt>
                <dd className="mt-0.5 text-[11.5px] leading-snug text-[#5A6272] dark:text-[#9898A2]">
                  {t(item.detailKey)}
                </dd>
              </div>
            ))}
          </motion.dl>
          <motion.div {...portalRevealItem(0.34)} className="mt-4">
            <AppButton
              variant="secondary"
              size="sm"
              leadingIcon={<Smartphone aria-hidden="true" className="h-3.5 w-3.5" />}
              onClick={props.onOpenPwaGuide}
            >
              {t("architecture.mobile.openPwaGuide")}
            </AppButton>
          </motion.div>
        </VisualCard>
      </div>
    </section>
  );
}
