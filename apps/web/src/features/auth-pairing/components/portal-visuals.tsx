/**
 * @module web/features/auth-pairing/portal-visuals
 * @description 门户卡片示意图：用产品自身的界面语汇手工搭出的缩略场景（迷你对话、协作拓扑、Diff、
 * 手机边框等），作为卡片的「配图」——随主题自适应、任意 DPI 清晰、无外购素材的版权负担，
 * 且与真实产品一一对应。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 纯装饰：示意图整体对读屏器隐藏（`aria-hidden`），等价信息由卡片标题与说明文字承载。
 * 2. 零模糊：示意图内不使用任何 `backdrop-blur`，仅用实色分层表面，保障 120Hz 顺滑滚动。
 * 3. 零 Emoji：只用 Lucide 矢量图标与平台官方图形（平台品牌门户的零 Emoji 品味门禁）。
 * 4. 无时间驱动动画：示意图只声明 variants，入场动效统一由外层卡片的显现容器触发并传播。
 */
import type { AgentPlatform } from "@openhuddle/protocol";
import {
  ArrowDown,
  ArrowRight,
  Check,
  Eye,
  FileDiff,
  Folder,
  GitBranch,
  type LucideIcon,
  MousePointer2,
  Pause,
  Pencil,
  RotateCcw,
  ShieldCheck,
  Terminal,
  User,
  Users,
} from "lucide-react";
import { motion } from "motion/react";
import type { ReactNode } from "react";
import { cn } from "../../../components/primitives/index.js";
import { PlatformGlyph } from "../../../components/ui/platform-icons.js";
import { usePortalI18n } from "../i18n/index.js";
import { portalRevealItem } from "./portal-reveal.js";

/** 门户展示的 8 个个人 Agent 平台及其品牌底色 */
export const SUPPORTED_AGENT_PLATFORMS: ReadonlyArray<{
  readonly platform: AgentPlatform;
  readonly label: string;
  readonly chipClass: string;
}> = [
  {
    platform: "claude_code",
    label: "Claude Code",
    chipClass: "bg-[#F4ECDD] text-[#5C4528] dark:bg-[#2F261C] dark:text-[#F3CFA2]",
  },
  {
    platform: "codex",
    label: "Codex",
    chipClass: "bg-[#E1ECFF] text-[#244375] dark:bg-[#1A273D] dark:text-[#9FC5FF]",
  },
  {
    platform: "cursor",
    label: "Cursor",
    chipClass: "bg-[#FFF1C2] text-[#5C4813] dark:bg-[#2F2816] dark:text-[#F5D687]",
  },
  {
    platform: "antigravity",
    label: "Antigravity",
    chipClass: "bg-[#EFEAFF] text-[#3F3368] dark:bg-[#25213A] dark:text-[#C9BEFF]",
  },
  {
    platform: "chatgpt",
    label: "ChatGPT",
    chipClass: "bg-[#E1ECFF] text-[#244375] dark:bg-[#1A273D] dark:text-[#9FC5FF]",
  },
  {
    platform: "openclaw",
    label: "OpenClaw",
    chipClass: "bg-[#E4F4EA] text-[#215236] dark:bg-[#162C24] dark:text-[#86E5BA]",
  },
  {
    platform: "deepseek",
    label: "DeepSeek",
    chipClass: "bg-[#FBE3D9] text-[#663523] dark:bg-[#32201E] dark:text-[#F7B6A8]",
  },
  {
    platform: "gemini",
    label: "Gemini",
    chipClass: "bg-[#E4F4EA] text-[#215236] dark:bg-[#162C24] dark:text-[#86E5BA]",
  },
];

/** 工作台审阅示意用的 Unified Diff 行（支付回调幂等修复） */
export const PORTAL_DIFF_ROWS: ReadonlyArray<{
  readonly id: string;
  readonly kind: "context" | "del" | "add";
  readonly oldNum: string;
  readonly newNum: string;
  readonly code: string;
}> = [
  {
    id: "ctx-1",
    kind: "context",
    oldNum: "41",
    newNum: "41",
    code: "const order = await findOrder(event.orderId);",
  },
  {
    id: "del-1",
    kind: "del",
    oldNum: "42",
    newNum: "",
    code: "await creditBalance(order.userId, event.amount);",
  },
  {
    id: "add-1",
    kind: "add",
    oldNum: "",
    newNum: "42",
    code: "if (order.paidAt) return order.receipt;",
  },
  {
    id: "add-2",
    kind: "add",
    oldNum: "",
    newNum: "43",
    code: "await creditBalance(order.userId, event.amount, { requestId: event.id });",
  },
];

/**
 * 取某个平台的品牌底色类。
 *
 * @param platform - 平台枚举值
 * @returns 该平台的 Tailwind 底色类（未收录时返回空串）
 */
export function portalAgentChipClass(platform: AgentPlatform): string {
  return SUPPORTED_AGENT_PLATFORMS.find((item) => item.platform === platform)?.chipClass ?? "";
}

/** 示意图内的浮起面板 */
const PANEL =
  "rounded-[12px] border border-black/[0.07] bg-white shadow-[0_10px_24px_-12px_rgba(15,23,42,0.28)] dark:border-white/[0.09] dark:bg-[#1B1C21]";
/** 示意图内的凹陷表面 */
const INSET =
  "rounded-[9px] border border-black/[0.06] bg-[#F1F3F6] dark:border-white/[0.07] dark:bg-[#141417]";
/** 示意图内的次级文字 */
const MUTED = "text-[#687082] dark:text-[#8E8E96]";
/** 示意图内的提醒底色 */
const NOTICE = "bg-[#FEF3C7] text-[#92400E] dark:bg-[#451A03]/70 dark:text-[#FCD34D]";
/** 示意图内的通过底色 */
const PASS = "text-[#15803D] dark:text-[#4ADE80]";
/** 自左向右画出的线条 */
const DRAW = { hidden: { scaleX: 0, opacity: 0 }, visible: { scaleX: 1, opacity: 1 } } as const;

/** `Shot` 入参属性 */
export interface ShotProps {
  readonly children: ReactNode;
  readonly className?: string | undefined;
}

/**
 * 示意图画框：卡片顶部的固定比例「取景框」，内部场景居中。
 *
 * @param props - 场景内容与追加布局类
 * @returns 对读屏器隐藏的取景框
 */
export function Shot(props: ShotProps) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "relative flex h-40 items-center justify-center overflow-hidden bg-[#EFF1F4] dark:bg-[#0F1013]",
        props.className,
      )}
    >
      {props.children}
    </div>
  );
}

/** `AgentDot` 入参属性 */
export interface AgentDotProps {
  readonly platform: AgentPlatform;
  readonly size?: "sm" | "md" | undefined;
  readonly className?: string | undefined;
}

/**
 * 迷你 Agent 头像：平台官方图形叠在品牌底色圆片上。
 *
 * @param props - 平台、尺寸与追加布局类
 * @returns 圆形平台头像
 */
export function AgentDot(props: AgentDotProps) {
  const small = props.size === "sm";
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full ring-1 ring-inset ring-black/[0.06] dark:ring-white/[0.12]",
        small ? "h-5 w-5" : "h-8 w-8",
        portalAgentChipClass(props.platform),
        props.className,
      )}
    >
      <PlatformGlyph platform={props.platform} className={small ? "h-2.5 w-2.5" : "h-4 w-4"} />
    </span>
  );
}

/**
 * 连通场景：把引导语发给 Agent，Agent 自行完成接入并入群。
 *
 * @returns 连通示意图
 */
export function ConnectShot() {
  const { t } = usePortalI18n();
  return (
    <div className="flex flex-col items-center gap-2.5 px-4">
      <motion.p
        {...portalRevealItem(0.16)}
        className="flex max-w-full items-center gap-2 rounded-full bg-[#111318] py-1.5 pl-3 pr-4 font-mono text-[11.5px] text-white dark:bg-[#F2F2F4] dark:text-[#111318]"
      >
        <Terminal aria-hidden="true" className="h-3.5 w-3.5 shrink-0 opacity-70" />
        <span className="truncate">{t("visuals.connect.prompt")}</span>
      </motion.p>
      <motion.span {...portalRevealItem(0.24)} className="text-[#939BAD] dark:text-[#63636B]">
        <ArrowDown aria-hidden="true" className="h-4 w-4" />
      </motion.span>
      <motion.p
        {...portalRevealItem(0.32, 6)}
        className={cn("flex items-center gap-2 py-1.5 pl-1.5 pr-3 text-[12px] font-medium", PANEL)}
      >
        <AgentDot platform="claude_code" />
        Claude Code
        <span className={cn("inline-flex items-center gap-1 text-[11px] font-semibold", PASS)}>
          <Check aria-hidden="true" strokeWidth={3} className="h-3 w-3" />
          {t("visuals.connect.joined")}
        </span>
      </motion.p>
    </div>
  );
}

/**
 * 群聊治理场景：对话有序进行，轮次用量可见，到上限自动暂停等人发话。
 *
 * @returns 群聊治理示意图
 */
export function GovernanceShot() {
  const { t } = usePortalI18n();
  return (
    <div className="flex w-[92%] items-stretch gap-3">
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <motion.span
          {...portalRevealItem(0.16)}
          className="ml-auto h-6 w-[64%] rounded-[12px_4px_12px_12px] bg-[#EBE4D9] dark:bg-[#2E2E34]"
        />
        <motion.span {...portalRevealItem(0.22)} className="flex items-center gap-1.5">
          <AgentDot platform="claude_code" size="sm" />
          <span className="h-6 w-[62%] rounded-[4px_12px_12px_12px] bg-white shadow-sm dark:bg-[#222226]" />
        </motion.span>
        <motion.span {...portalRevealItem(0.28)} className="flex items-center gap-1.5">
          <AgentDot platform="codex" size="sm" />
          <span className="h-6 w-[48%] rounded-[4px_12px_12px_12px] bg-white shadow-sm dark:bg-[#222226]" />
        </motion.span>
      </div>
      <motion.div
        {...portalRevealItem(0.34)}
        className={cn("flex w-[36%] shrink-0 flex-col justify-between p-2.5", PANEL)}
      >
        <div>
          <p className={cn("text-[10.5px] font-semibold", MUTED)}>
            {t("visuals.governance.turns")}
          </p>
          <div aria-hidden="true" className="mt-1.5 flex gap-1">
            {[0, 1, 2, 3, 4, 5].map((index) => (
              <span
                key={String(index)}
                className={cn(
                  "h-1.5 flex-1 rounded-full",
                  index < 4 ? "bg-[#111318] dark:bg-white" : "bg-black/[0.1] dark:bg-white/[0.14]",
                )}
              />
            ))}
          </div>
        </div>
        <p
          className={cn(
            "mt-2 inline-flex items-center gap-1 rounded-full px-2 py-1 text-[10.5px] font-semibold",
            NOTICE,
          )}
        >
          <Pause aria-hidden="true" strokeWidth={3} className="h-3 w-3 shrink-0" />
          {t("visuals.governance.paused")}
        </p>
      </motion.div>
    </div>
  );
}

/** 协作拓扑场景入参属性 */
export interface TopologyShotProps {
  /** 参与协作的 Agent 数：1 单人执行、2 双人复核、3 多路并行 */
  readonly agents: 1 | 2 | 3;
}

/**
 * 工作台协作拓扑场景：若干 Agent 各自的泳道汇入同一份交付物。
 *
 * @param props - 参与协作的 Agent 数
 * @returns 协作拓扑示意图
 */
export function TopologyShot(props: TopologyShotProps) {
  const { t } = usePortalI18n();
  const lanes: ReadonlyArray<{ readonly platform: AgentPlatform; readonly role: string }> =
    props.agents === 1
      ? [{ platform: "claude_code", role: t("visuals.topo.solo") }]
      : props.agents === 2
        ? [
            { platform: "claude_code", role: t("visuals.topo.writer") },
            { platform: "codex", role: t("visuals.topo.verifier") },
          ]
        : [
            { platform: "claude_code", role: t("visuals.topo.slice1") },
            { platform: "codex", role: t("visuals.topo.slice2") },
            { platform: "cursor", role: t("visuals.topo.slice3") },
          ];
  const outcome =
    props.agents === 1
      ? t("visuals.topo.done1")
      : props.agents === 2
        ? t("visuals.topo.done2")
        : t("visuals.topo.done3");

  return (
    <div className="flex w-[90%] items-center gap-2 sm:gap-3">
      <div className="flex flex-col gap-2.5">
        {lanes.map((lane, index) => (
          <motion.span
            key={`${lane.platform}-${String(index)}`}
            {...portalRevealItem(0.14 + index * 0.06, 6)}
            className="flex items-center gap-1.5"
          >
            <AgentDot platform={lane.platform} size="sm" />
            <span className={cn("whitespace-nowrap text-[10.5px] font-medium", MUTED)}>
              {lane.role}
            </span>
          </motion.span>
        ))}
      </div>
      <div aria-hidden="true" className="flex min-w-0 flex-1 flex-col gap-2.5">
        {lanes.map((lane, index) => (
          <motion.span
            key={`${lane.platform}-${String(index)}`}
            variants={DRAW}
            transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1], delay: 0.24 + index * 0.06 }}
            className="h-0.5 origin-left rounded-full bg-[#111318]/70 dark:bg-white/70"
          />
        ))}
      </div>
      <motion.p
        {...portalRevealItem(0.4, 6)}
        className={cn(
          "flex shrink-0 items-center gap-1.5 py-1.5 pl-2 pr-2.5 text-[11px] font-medium",
          PANEL,
        )}
      >
        <FileDiff aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
        callback.ts
        <span className={cn("inline-flex items-center gap-1 text-[10.5px] font-semibold", PASS)}>
          <Check aria-hidden="true" strokeWidth={3} className="h-3 w-3" />
          {outcome}
        </span>
      </motion.p>
    </div>
  );
}

/**
 * 单问澄清场景：任务在关键分歧处挂起，给出备选项等人类点选。
 *
 * @returns 单问澄清示意图
 */
export function ClarifyShot() {
  const { t } = usePortalI18n();
  return (
    <motion.p {...portalRevealItem(0.16)} className={cn("w-[88%] max-w-[300px] p-3", PANEL)}>
      <span
        className={cn("inline-flex rounded-full px-2 py-0.5 text-[10.5px] font-semibold", NOTICE)}
      >
        {t("visuals.clarify.badge")}
      </span>
      <span className="mt-1.5 block text-[12px] font-medium leading-snug">
        {t("visuals.clarify.question")}
      </span>
      <span className="relative mt-2.5 block grid grid-cols-2 gap-1.5">
        <span className="rounded-[9px] bg-[#111318] px-1 py-1.5 text-center text-[11px] font-semibold text-white dark:bg-[#F2F2F4] dark:text-[#111318]">
          {t("visuals.clarify.opt1")}
        </span>
        <span
          className={cn(
            "rounded-[9px] px-1 py-1.5 text-center text-[11px] font-medium",
            INSET,
            MUTED,
          )}
        >
          {t("visuals.clarify.opt2")}
        </span>
        <MousePointer2
          aria-hidden="true"
          className="absolute -bottom-2 left-[38%] h-4 w-4 fill-[#111318] text-[#111318] drop-shadow-sm dark:fill-white dark:text-white"
        />
      </span>
    </motion.p>
  );
}

/**
 * 代码审阅场景：增删对照的 Unified Diff。
 *
 * @returns 代码审阅示意图
 */
export function DiffShot() {
  return (
    <motion.p
      {...portalRevealItem(0.16)}
      className={cn(
        "w-[94%] overflow-hidden rounded-[12px] border border-black/[0.07] dark:border-white/[0.08] dark:bg-[#141417]",
        "bg-[#EFF1F4]",
      )}
    >
      <span className="flex items-center justify-between gap-2 border-b border-black/[0.06] px-3 py-1.5 font-mono text-[10.5px] dark:border-white/[0.07]">
        <span className="truncate font-medium text-[#3B414E] dark:text-[#C4C4CA]">
          server/payment/callback.ts
        </span>
        <span className="shrink-0 font-semibold tabular-nums">
          <span className="text-[#15803D] dark:text-[#4ADE80]">+3</span>{" "}
          <span className="text-[#B91C1C] dark:text-[#F87171]">-1</span>
        </span>
      </span>
      <span className="block py-1 font-mono text-[11px] leading-[1.65]">
        {PORTAL_DIFF_ROWS.map((row) => {
          const isAdd = row.kind === "add";
          const isDel = row.kind === "del";
          return (
            <span
              key={row.id}
              className={cn(
                "flex items-baseline px-2.5",
                isAdd && "bg-[#DCFCE7]/70 dark:bg-[#132C1F]/80",
                isDel && "bg-[#FEE2E2]/70 dark:bg-[#31171B]/80",
              )}
            >
              <span className="w-5 shrink-0 select-none pr-1.5 text-right text-[10px] text-[#8E96A6] dark:text-[#63636B]">
                {row.newNum}
              </span>
              <span
                className={cn(
                  "w-3 shrink-0 select-none font-semibold",
                  isAdd
                    ? "text-[#15803D] dark:text-[#4ADE80]"
                    : isDel
                      ? "text-[#B91C1C] dark:text-[#F87171]"
                      : "text-transparent",
                )}
              >
                {isAdd ? "+" : isDel ? "-" : "."}
              </span>
              <span
                className={cn(
                  "truncate pr-3",
                  isAdd
                    ? "text-[#14532D] dark:text-[#D1FAE5]"
                    : isDel
                      ? "text-[#7F1D1D] dark:text-[#FEE2E2]"
                      : "text-[#3B414E] dark:text-[#D4D4D8]",
                )}
              >
                {row.code}
              </span>
            </span>
          );
        })}
      </span>
    </motion.p>
  );
}

/**
 * 沙箱隔离场景：同一仓库下，多个任务各占一种互不干扰的目录形态。
 *
 * @returns 沙箱隔离示意图
 */
export function SandboxShot() {
  const { t } = usePortalI18n();
  const rows: ReadonlyArray<{
    readonly icon: LucideIcon;
    readonly name: string;
    readonly tag: string;
  }> = [
    { icon: GitBranch, name: "tasks/01", tag: t("visuals.sandbox.worktree") },
    { icon: Pencil, name: "tasks/02", tag: t("visuals.sandbox.inPlace") },
    { icon: Eye, name: "tasks/03", tag: t("visuals.sandbox.readOnly") },
  ];
  return (
    <motion.p {...portalRevealItem(0.16)} className={cn("w-[86%] max-w-[300px] p-2.5", PANEL)}>
      <span className="flex items-center gap-1.5 px-1 font-mono text-[11px] font-medium">
        <Folder aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
        openhuddle/
      </span>
      <span className="mt-1.5 block space-y-1">
        {rows.map((row, index) => (
          <motion.span
            key={row.name}
            {...portalRevealItem(0.26 + index * 0.06, 5)}
            className={cn("flex items-center justify-between px-2 py-1.5 text-[11px]", INSET)}
          >
            <span className="flex items-center gap-1.5 font-mono">
              <row.icon aria-hidden="true" className="h-3 w-3 shrink-0" />
              {row.name}
            </span>
            <span className="rounded-full bg-black/[0.05] px-1.5 py-0.5 text-[10px] font-medium text-[#3B414E] dark:bg-white/[0.08] dark:text-[#D4D4D8]">
              {row.tag}
            </span>
          </motion.span>
        ))}
      </span>
    </motion.p>
  );
}

/**
 * 归属边界场景：Agent 只执行主人的指令，其他人的发言仅作参考。
 *
 * @returns 归属边界示意图
 */
export function OwnerShot() {
  const { t } = usePortalI18n();
  const humanDot =
    "flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#111318] text-white dark:bg-[#F2F2F4] dark:text-[#111318]";
  return (
    <div className="flex w-[92%] flex-col items-center gap-3">
      <motion.span {...portalRevealItem(0.16)} className="flex items-center gap-1.5">
        <span className={humanDot}>
          <User aria-hidden="true" className="h-4 w-4" />
        </span>
        <motion.span
          variants={DRAW}
          transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1], delay: 0.26 }}
          className="h-0.5 w-6 origin-left rounded-full bg-[#15803D] dark:bg-[#4ADE80]"
        />
        <span className="relative">
          <AgentDot platform="claude_code" />
          <span className="absolute -bottom-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full bg-[#15803D] text-white ring-2 ring-[#EFF1F4] dark:ring-[#0F1013]">
            <ShieldCheck aria-hidden="true" className="h-2.5 w-2.5" />
          </span>
        </span>
        <span className={cn("ml-1 text-[11px] font-semibold", PASS)}>
          {t("visuals.owner.direct")}
        </span>
      </motion.span>
      <motion.span {...portalRevealItem(0.3)} className="flex items-center gap-1.5 opacity-75">
        <span
          className={cn(
            humanDot,
            "bg-[#DDE1E7] text-[#5A6272] dark:bg-[#2E2E34] dark:text-[#A1A1AA]",
          )}
        >
          <Users aria-hidden="true" className="h-4 w-4" />
        </span>
        <span className="w-6 border-t border-dashed border-[#939BAD] dark:border-[#63636B]" />
        <span
          className={cn(
            "rounded-full bg-black/[0.05] px-2 py-1 text-[10.5px] font-medium dark:bg-white/[0.08]",
            MUTED,
          )}
        >
          {t("visuals.owner.reference")}
        </span>
      </motion.span>
    </div>
  );
}

/**
 * 拉群会诊场景：工作台里遇到复杂取舍，带着任务上下文一键升级为多 Agent 会诊。
 *
 * @returns 拉群会诊示意图
 */
export function EscalateShot() {
  const { t } = usePortalI18n();
  return (
    <div className="flex w-[94%] items-center gap-2 sm:gap-3">
      <motion.p {...portalRevealItem(0.16)} className={cn("min-w-0 flex-1 p-2.5", PANEL)}>
        <span className="block truncate text-[11.5px] font-semibold">
          {t("visuals.escalate.task")}
        </span>
        <span className={cn("mt-1 flex items-center gap-1 truncate font-mono text-[10px]", MUTED)}>
          <GitBranch aria-hidden="true" className="h-3 w-3 shrink-0" />
          fix/dedupe
        </span>
        <span
          className={cn(
            "mt-2 block truncate rounded-[8px] px-2 py-1 text-[10.5px] font-medium",
            NOTICE,
          )}
        >
          {t("visuals.escalate.status")}
        </span>
      </motion.p>
      <motion.span
        {...portalRevealItem(0.26)}
        className="shrink-0 text-[#939BAD] dark:text-[#63636B]"
      >
        <ArrowRight aria-hidden="true" className="h-4 w-4" />
      </motion.span>
      <motion.p {...portalRevealItem(0.34)} className={cn("min-w-0 flex-1 p-2.5", PANEL)}>
        <span className="flex items-center gap-1.5">
          <span className="flex -space-x-1.5">
            <AgentDot platform="claude_code" size="sm" />
            <AgentDot platform="codex" size="sm" />
            <AgentDot platform="cursor" size="sm" />
          </span>
          <span className="text-[11px] font-semibold">{t("visuals.escalate.room")}</span>
        </span>
        <span className="mt-2 block space-y-1">
          <span className="block h-5 w-[90%] rounded-[4px_10px_10px_10px] bg-[#EFF1F4] dark:bg-[#141417]" />
          <span className="block h-5 w-[64%] rounded-[4px_10px_10px_10px] bg-[#EFF1F4] dark:bg-[#141417]" />
        </span>
      </motion.p>
    </div>
  );
}

/**
 * 断线重连场景：离线一段时间后重新连上，错过的消息立即补齐。
 *
 * @returns 断线重连示意图
 */
export function ReconnectShot() {
  const { t } = usePortalI18n();
  const line = "h-0.5 flex-1 bg-[#111318]/45 dark:bg-white/45";
  const node = "h-2.5 w-2.5 shrink-0 rounded-full bg-[#15803D] dark:bg-[#34D399]";
  return (
    <div className="flex w-[94%] flex-col items-center gap-4">
      <motion.span
        {...portalRevealItem(0.16)}
        aria-hidden="true"
        className="flex w-full items-center"
      >
        <span className={node} />
        <span className={line} />
        <span className="relative h-0.5 w-[24%] border-t-2 border-dashed border-[#939BAD] dark:border-[#63636B]">
          <span
            className={cn(
              "absolute left-1/2 top-1 -translate-x-1/2 rounded-full bg-[#EFF1F4] px-1.5 text-[10px] font-medium dark:bg-[#0F1013]",
              MUTED,
            )}
          >
            {t("visuals.reconnect.offline")}
          </span>
        </span>
        <span className={line} />
        <span className={node} />
      </motion.span>
      <motion.p
        {...portalRevealItem(0.28)}
        className={cn("flex items-center gap-1.5 px-3 py-1.5 text-[11.5px] font-medium", PANEL)}
      >
        <RotateCcw aria-hidden="true" className={cn("h-3.5 w-3.5 shrink-0", PASS)} />
        {t("visuals.reconnect.caughtUp")}
      </motion.p>
    </div>
  );
}

/**
 * 手机端场景：键盘弹起时，输入框稳稳贴在键盘上方。
 *
 * @returns 手机端示意图
 */
export function PhoneShot() {
  const { t } = usePortalI18n();
  return (
    <motion.p
      {...portalRevealItem(0.16, 8)}
      className="relative h-[148px] w-[122px] rounded-[24px] border-[3px] border-[#111318] bg-white p-1.5 pt-4 dark:border-[#4A4A54] dark:bg-[#1B1C21]"
    >
      <span
        aria-hidden="true"
        className="absolute left-1/2 top-1.5 h-1 w-7 -translate-x-1/2 rounded-full bg-[#111318] dark:bg-[#2E2E34]"
      />
      <span className="block space-y-1.5">
        <span className="block h-5 w-[72%] rounded-[10px_3px_10px_10px] bg-[#EBE4D9] dark:bg-[#2E2E34]" />
        <span className="block h-5 w-[58%] rounded-[3px_10px_10px_10px] bg-[#EFF1F4] dark:bg-[#222226]" />
      </span>
      <span className="absolute inset-x-1.5 bottom-[40px] flex h-6 items-center rounded-full border-2 border-[#111318] px-2 text-[9px] text-[#8E96A6] dark:border-white dark:text-[#8E8E96]">
        {t("visuals.phone.placeholder")}
      </span>
      <span
        aria-hidden="true"
        className="absolute inset-x-1.5 bottom-1.5 grid h-[30px] grid-cols-6 gap-[3px] rounded-md bg-[#DDE1E7] p-1 dark:bg-[#26262C]"
      >
        {Array.from({ length: 12 }, (_, index) => (
          <span key={String(index)} className="rounded-[3px] bg-white dark:bg-[#2E2E34]" />
        ))}
      </span>
    </motion.p>
  );
}
