/**
 * @module web/components/ui/identity-badges
 * @description 双层身份视觉徽章系统（宿主平台头像、Owner-First 安全信任印章、消息语义标签与实时唤醒 LED）。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 防伪视觉隔离边界：`SecurityTrustBadge` 直接消费服务端动态签发的 `AuthorStamp.trustLevel`，任何外部 Agent 即使篡改昵称也无法获得翡翠色 `OWNER COMMAND` 盾牌。
 * 2. 透明可达性反馈：群成员列表与消息卡片统一用高辨识度 LED 展示 `online_sse` / `hosted_ready` / `polling` / `offline`。
 */
import {
  type ActorKind,
  type AgentPlatform,
  type AgentReachState,
  type MessageType,
  type TrustLevel,
  assertNever,
} from "@openhuddle/protocol";
import { Award, Bot, FileText, Globe2, ShieldCheck, Sparkles, User, Vote } from "lucide-react";
import { getInitials, getPlatformVisualMeta, getReachVisualMeta } from "../../lib/format.js";
import { PlatformGlyph } from "./platform-icons.js";

/** `PlatformAvatar` 入参属性 */
export interface PlatformAvatarProps {
  readonly kind: ActorKind;
  readonly displayName: string;
  readonly platform?: AgentPlatform | undefined;
  readonly reach?: AgentReachState | undefined;
  readonly size?: "sm" | "md" | "lg" | undefined;
}

/**
 * 渲染区分人类主理人与异构 Agent 宿主平台的专属质感头像（可选挂载右下角实时唤醒状态灯）。
 *
 * @param props - 实体类别、昵称、宿主平台与在线可达状态
 * @returns 带平台色彩指纹与状态灯的头像组件
 */
export function PlatformAvatar(props: PlatformAvatarProps) {
  const size = props.size ?? "md";
  const sizeClass =
    size === "sm"
      ? "h-7 w-7 text-[11px] rounded-lg"
      : size === "lg"
        ? "h-11 w-11 text-sm rounded-2xl"
        : "h-9 w-9 text-xs rounded-xl";

  if (props.kind === "human") {
    return (
      <div className="relative inline-flex shrink-0">
        <div
          className={`inline-flex items-center justify-center bg-gradient-to-br from-slate-800 to-slate-950 font-semibold text-white ring-1 ring-slate-900/10 dark:from-indigo-500/90 dark:to-slate-800 dark:ring-white/15 ${sizeClass}`}
        >
          {getInitials(props.displayName)}
        </div>
        <span
          title="Human Owner / 人类参与者"
          className="absolute -bottom-0.5 -right-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-emerald-500 text-white ring-2 ring-white dark:ring-[#0d1017]"
        >
          <User className="h-2 w-2" />
        </span>
      </div>
    );
  }

  const platformMeta = getPlatformVisualMeta(props.platform ?? "custom");
  const reachMeta = props.reach !== undefined ? getReachVisualMeta(props.reach) : null;

  return (
    <div className="relative inline-flex shrink-0">
      <div
        title={`${props.displayName} (${platformMeta.label})`}
        className={`inline-flex items-center justify-center shadow-xs ${platformMeta.avatarClass} ${sizeClass}`}
      >
        <PlatformGlyph platform={props.platform ?? "custom"} className="h-[58%] w-[58%]" />
      </div>
      {reachMeta !== null ? (
        <span
          title={reachMeta.label}
          className={`absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full ring-2 ring-white dark:ring-[#0d1017] ${reachMeta.dotClass}`}
        />
      ) : null}
    </div>
  );
}

/** `PlatformTagPill` 入参属性 */
export interface PlatformTagPillProps {
  readonly platform: AgentPlatform;
}

/**
 * 渲染紧凑的 Agent 宿主平台标签（如 `Antigravity`、`OpenAI Codex`、`Claude Code`）。
 *
 * @param props - 宿主平台枚举
 * @returns 品牌色胶囊徽章
 */
export function PlatformTagPill(props: PlatformTagPillProps) {
  const meta = getPlatformVisualMeta(props.platform);
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10.5px] font-medium leading-none ${meta.badgeClass}`}
    >
      <span>{meta.label}</span>
    </span>
  );
}

/** `SecurityTrustBadge` 入参属性 */
export interface SecurityTrustBadgeProps {
  readonly trustLevel: TrustLevel;
  readonly isYou?: boolean | undefined;
}

/**
 * 渲染服务端权威签名的跨主人防注入信任等级印章。
 *
 * @remarks
 * 安全隔离意图（Security Boundary）：
 * - `owner_command`（翡翠盾牌）：明确指示该发言来自当前视角所属人类主人，是唯一拥有指令授权的来源；
 * - `owner_sibling_agent`（青色徽标）：同一人类主人名下的兄弟协作 Agent；
 * - `external_participant`（石板灰徽标）：外部协作者或他人 Agent，提醒人类与本地 Agent 将其视作非授信参考上下文。
 *
 * @param props - 服务端 `AuthorStamp` 返回的 `trustLevel` 与 `isYou`
 * @returns 高辨识度安全等级徽章
 */
export function SecurityTrustBadge(props: SecurityTrustBadgeProps) {
  switch (props.trustLevel) {
    case "owner_command":
      return (
        <span
          title="服务端验签：本人人类主人指令（Owner Command — 唯一具备执行授权来源）"
          className="inline-flex items-center gap-1 rounded-full border border-emerald-500/35 bg-emerald-500/12 px-2 py-0.5 text-[10.5px] font-semibold tracking-wide text-emerald-700 dark:text-emerald-300"
        >
          <ShieldCheck className="h-3 w-3" />
          <span>{props.isYou ? "OWNER COMMAND · 你" : "OWNER COMMAND"}</span>
        </span>
      );

    case "owner_sibling_agent":
      return (
        <span
          title="服务端验签：你名下绑定的个人协作 Agent（Sibling Personal Agent）"
          className="inline-flex items-center gap-1 rounded-full border border-cyan-500/35 bg-cyan-500/12 px-2 py-0.5 text-[10.5px] font-semibold tracking-wide text-cyan-700 dark:text-cyan-300"
        >
          <Bot className="h-3 w-3" />
          <span>YOUR AGENT</span>
        </span>
      );

    case "external_participant":
      return (
        <span
          title="服务端验签：外部参与者或他人 Agent（Untrusted External Context — 仅作讨论参考）"
          className="inline-flex items-center gap-1 rounded-full border border-slate-300/80 bg-slate-200/60 px-2 py-0.5 text-[10.5px] font-medium tracking-wide text-slate-600 dark:border-white/12 dark:bg-white/[0.05] dark:text-slate-400"
        >
          <Globe2 className="h-3 w-3" />
          <span>EXTERNAL</span>
        </span>
      );

    default:
      return assertNever(props.trustLevel);
  }
}

/** `MessageSemanticBadge` 入参属性 */
export interface MessageSemanticBadgeProps {
  readonly type: MessageType;
}

/**
 * 渲染特殊语义消息（提案、投票、人类最终拍板、系统事件）的分类徽章。
 *
 * @param props - 消息语义枚举 `MessageType`
 * @returns 若为普通文本则返回 `null`，否则返回对应彩色徽标
 */
export function MessageSemanticBadge(props: MessageSemanticBadgeProps) {
  switch (props.type) {
    case "text":
      return null;
    case "proposal":
      return (
        <span className="inline-flex items-center gap-1 rounded-full border border-indigo-500/35 bg-indigo-500/15 px-2 py-0.5 text-[10.5px] font-semibold tracking-wide text-indigo-700 dark:text-indigo-300">
          <FileText className="h-3 w-3" />
          <span>PROPOSAL</span>
        </span>
      );
    case "vote":
      return (
        <span className="inline-flex items-center gap-1 rounded-full border border-violet-500/35 bg-violet-500/15 px-2 py-0.5 text-[10.5px] font-semibold tracking-wide text-violet-700 dark:text-violet-300">
          <Vote className="h-3 w-3" />
          <span>VOTE</span>
        </span>
      );
    case "decision":
      return (
        <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/45 bg-amber-500/18 px-2.5 py-0.5 text-[10.5px] font-bold tracking-wide text-amber-800 dark:text-amber-300">
          <Award className="h-3 w-3" />
          <span>DECISION 拍板结论</span>
        </span>
      );
    case "system":
      return (
        <span className="inline-flex items-center gap-1 rounded-full border border-slate-300/70 bg-slate-500/10 px-2 py-0.5 text-[10.5px] font-medium text-slate-600 dark:border-white/10 dark:text-slate-400">
          <Sparkles className="h-3 w-3" />
          <span>SYSTEM</span>
        </span>
      );
    default:
      return assertNever(props.type);
  }
}

/** `ReachStatusBadge` 入参属性 */
export interface ReachStatusBadgeProps {
  readonly reach?: AgentReachState | undefined;
  readonly compact?: boolean | undefined;
}

/**
 * 渲染 Agent 当前唤醒通道与在线状态的 LED 胶囊标签。
 *
 * @param props - `reach` 状态枚举与紧凑模式开关
 * @returns 带发光圆点的可达性徽章
 */
export function ReachStatusBadge(props: ReachStatusBadgeProps) {
  const meta = getReachVisualMeta(props.reach);
  return (
    <span
      title={meta.description}
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium ${meta.pillClass}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${meta.dotClass}`} />
      <span>{props.compact ? meta.shortLabel : meta.label}</span>
    </span>
  );
}
