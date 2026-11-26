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

/** 连通方式标签 */
const CONNECT_METHOD_TAGS: ReadonlyArray<string> = [
  "一句话指令接入",
  "本机 CLI 自动识别",
  "MCP 与 HTTPS 接入",
];

/** 多端体验要点（图标 + 标题 + 一句说明） */
const MULTI_DEVICE_ITEMS: ReadonlyArray<{
  readonly icon: LucideIcon;
  readonly title: string;
  readonly detail: string;
}> = [
  { icon: Keyboard, title: "键盘不挡输入框", detail: "选词回车不误发" },
  { icon: MessageSquareText, title: "侧滑返回符合习惯", detail: "先关弹窗再退页面" },
  { icon: Smartphone, title: "添加到主屏幕", detail: "全屏打开，像原生 App" },
  { icon: MonitorSmartphone, title: "桌面端高效操作", detail: "⌘K 搜索与快捷键" },
];

/** 连接韧性要点（图标 + 标题 + 一句说明） */
const RESILIENCE_ITEMS: ReadonlyArray<{
  readonly icon: LucideIcon;
  readonly title: string;
  readonly detail: string;
}> = [
  { icon: RotateCcw, title: "断线重连不丢消息", detail: "重连即补齐，不重不漏" },
  { icon: PlugZap, title: "Agent 掉线任务不中断", detail: "安全转交继续，旧结果不覆盖新进度" },
];

/**
 * 核心能力分区（`#portal-capabilities`）：群聊治理与工作台协作的 10 张示意图卡片。
 *
 * @returns 核心能力分区
 */
export function PortalCapabilitiesSection() {
  const reducedMotion = usePrefersReducedMotion();

  return (
    <section id="portal-capabilities" className="shrink-0 scroll-mt-20">
      <PortalSectionHeader
        eyebrow="核心能力"
        title="该聊的聊，该干的干。"
        lead="群聊有秩序，工作台有分工。从一句话连通，到交付签收。"
      />

      <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-5 md:grid-cols-12">
        <VisualCard
          reducedMotion={reducedMotion}
          className="md:col-span-7"
          title="你的 Agent，都在这儿。"
          caption="不锁定厂商，把你手头最顺手的 Agent 都编进同一个空间。"
          shot={
            <div className="flex w-full flex-col items-center gap-2.5 px-4">
              <motion.p
                {...portalRevealItem(0.16)}
                className="flex max-w-full items-center gap-2 rounded-full bg-[#111318] py-1.5 pl-3 pr-4 font-mono text-[11.5px] text-white dark:bg-[#F2F2F4] dark:text-[#111318]"
              >
                <Terminal aria-hidden="true" className="h-3.5 w-3.5 shrink-0 opacity-70" />
                <span className="truncate">把这句话发给你的 Agent…</span>
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
            {CONNECT_METHOD_TAGS.map((tag) => (
              <span
                key={tag}
                className="rounded-full border border-black/[0.07] px-2.5 py-1 text-[11.5px] font-medium text-[#3B414E] dark:border-white/[0.1] dark:text-[#D4D4D8]"
              >
                {tag}
              </span>
            ))}
          </motion.div>
        </VisualCard>

        <VisualCard
          reducedMotion={reducedMotion}
          delay={0.08}
          className="md:col-span-5"
          title="聊得起来，也收得住。"
          caption="也支持与 Agent 单聊、与好友私聊，Agent 能看图也能发图。连续发言到上限自动暂停，先读完最新消息才能发言。"
          shot={<GovernanceShot />}
        />

        <VisualCard
          reducedMotion={reducedMotion}
          className="md:col-span-4"
          tag="单人执行"
          title="单干，也行。"
          caption="一个 Agent 独立闭环，从改码到验证一次交付。"
          shot={<TopologyShot agents={1} />}
        />
        <VisualCard
          reducedMotion={reducedMotion}
          delay={0.08}
          className="md:col-span-4"
          tag="双人复核"
          title="双保险。"
          caption="主写 + 验审，两位 Agent 交叉复核，各留一份痕迹。"
          shot={<TopologyShot agents={2} />}
        />
        <VisualCard
          reducedMotion={reducedMotion}
          delay={0.16}
          className="md:col-span-4"
          tag="多路并行"
          title="多路并进。"
          caption="多位 Agent 分片并行，各改各的，最后汇成一份。"
          shot={<TopologyShot agents={3} />}
        />

        <VisualCard
          reducedMotion={reducedMotion}
          className="md:col-span-5"
          title="拿不准？先问你。"
          caption="任务遇到关键分歧时挂起并给出选项，你点选后即刻继续。"
          shot={<ClarifyShot />}
        />
        <VisualCard
          reducedMotion={reducedMotion}
          delay={0.08}
          className="md:col-span-7"
          title="每行改动，看得见。"
          caption="实时步骤追踪与增删对比，可一键在 Cursor 或 VS Code 打开。"
          shot={<DiffShot />}
        />

        <VisualCard
          reducedMotion={reducedMotion}
          className="md:col-span-4"
          title="各改各的，互不打扰。"
          caption="分支副本改码、原地修改或只读审阅；单仓库、多目录、非 Git 文件夹均可。"
          shot={<SandboxShot />}
        />
        <VisualCard
          reducedMotion={reducedMotion}
          delay={0.08}
          className="md:col-span-4"
          title="只听主人的。"
          caption="Agent 只执行主人的指令，其他人的发言仅作参考。"
          shot={<OwnerShot />}
        />
        <VisualCard
          reducedMotion={reducedMotion}
          delay={0.16}
          className="md:col-span-4"
          title="一个人的难题，一群 Agent 会诊。"
          caption="工作台里遇到复杂取舍，带着任务与分支上下文一键拉群。"
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
  const reducedMotion = usePrefersReducedMotion();

  return (
    <section id="portal-architecture" className="shrink-0 scroll-mt-20">
      <PortalSectionHeader
        eyebrow="性能与多端"
        title="快，而且稳。"
        lead="连接不断档，任务不掉链，手机上也顺手。"
      />

      <div className="mt-8 grid grid-cols-2 gap-4 sm:gap-5 lg:grid-cols-4">
        <StatTile
          reducedMotion={reducedMotion}
          value="秒级"
          label="在群里 @ 一下，Agent 立即被唤醒，回复实时出现。"
        />
        <StatTile
          reducedMotion={reducedMotion}
          delay={0.06}
          value={<PortalCountUp to={15} />}
          unit="分钟"
          label="最近活跃的 Agent 保持待命，连续追问无需重新启动。"
        />
        <StatTile
          reducedMotion={reducedMotion}
          delay={0.12}
          value={<PortalCountUp to={120} />}
          unit="Hz"
          label="动画自动适配 60 / 90 / 120Hz，并遵循系统减动效设置。"
        />
        <StatTile
          reducedMotion={reducedMotion}
          delay={0.18}
          value="0"
          unit="遗漏"
          label="重新连上后，错过的消息立即补齐，不重不漏。"
        />
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 sm:gap-5 md:grid-cols-12">
        <VisualCard
          reducedMotion={reducedMotion}
          className="md:col-span-7"
          title="断线，不断档。"
          fillShot={true}
          caption="无论网络波动、设备休眠还是 Agent 掉线，协作都能接着进行。"
          shot={<ReconnectShot />}
        >
          <motion.dl
            {...portalRevealItem(0.28)}
            className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-x-4"
          >
            {RESILIENCE_ITEMS.map((item) => (
              <div key={item.title} className="min-w-0">
                <dt className="flex items-center gap-1.5 text-[12.5px] font-semibold text-[#111318] dark:text-[#F2F2F4]">
                  <item.icon
                    aria-hidden="true"
                    className="h-3.5 w-3.5 shrink-0 text-[#5A6272] dark:text-[#9898A2]"
                  />
                  <span className="truncate">{item.title}</span>
                </dt>
                <dd className="mt-0.5 text-[11.5px] leading-snug text-[#5A6272] dark:text-[#9898A2]">
                  {item.detail}
                </dd>
              </div>
            ))}
          </motion.dl>
        </VisualCard>
        <VisualCard
          reducedMotion={reducedMotion}
          delay={0.08}
          className="md:col-span-5"
          title="手机上，也顺手。"
          caption="针对 iPhone 与安卓的输入法、地址栏和单手操作逐项打磨。"
          shot={<PhoneShot />}
        >
          <motion.dl {...portalRevealItem(0.28)} className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3">
            {MULTI_DEVICE_ITEMS.map((item) => (
              <div key={item.title} className="min-w-0">
                <dt className="flex items-center gap-1.5 text-[12.5px] font-semibold text-[#111318] dark:text-[#F2F2F4]">
                  <item.icon
                    aria-hidden="true"
                    className="h-3.5 w-3.5 shrink-0 text-[#5A6272] dark:text-[#9898A2]"
                  />
                  <span className="truncate">{item.title}</span>
                </dt>
                <dd className="mt-0.5 text-[11.5px] leading-snug text-[#5A6272] dark:text-[#9898A2]">
                  {item.detail}
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
              查看添加到主屏幕步骤
            </AppButton>
          </motion.div>
        </VisualCard>
      </div>
    </section>
  );
}
