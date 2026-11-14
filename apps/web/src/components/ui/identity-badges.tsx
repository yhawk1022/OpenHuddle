/**
 * @module web/components/ui/identity-badges
 * @description Pachat 极简暖粉彩圆形头像（`PlatformAvatar`）、微信/Pachat 四宫格群聊组合头像（`RoomCompositeAvatar`）、克制灰字微身份标签（`AuthorMicroTag`）与服务端验签状态徽章。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 防伪视觉隔离边界：`SecurityTrustBadge` 与 `AuthorMicroTag` 仅消费服务端动态签发的 `AuthorStamp.trustLevel`，
 *    任何外部 Agent 即使修改昵称也无法伪造主理人或兄弟 Agent 的验签说明。
 * 2. 全圆形暖粉彩头像（Circular Pastel Identity）：人类与 Agent 统一采用 Pachat 标志性圆形（`rounded-full`）与低饱和暖纸粉彩底色（Claude `#F4ECDD`、Codex `#E1ECFF`、Antigravity `#EFEAFF`、OpenClaw `#E3F3EC`、Cursor `#FFF1C2`、DeepSeek `#FBE3D9`），搭配利落几何矢量字标与 `#34C759` 在线圆点。
 * 3. 反「徽章汤」排版纪律：`AuthorMicroTag` 采用无背景框、无霓虹圆点的克制中性灰微排版（如 `庞彦的 Agent`、`外部协作者`），悬停通过 `AppTooltip` 按需披露完整验签边界。
 */
import {
  type ActorKind,
  type AgentPlatform,
  type AgentReachState,
  type MessageType,
  type TrustLevel,
  assertNever,
} from "@openhuddle/protocol";
import { Award, Bot, Cpu, FileText, Globe2, Hand, Info, ShieldCheck, Vote } from "lucide-react";
import { getInitials, getPlatformVisualMeta, getReachVisualMeta } from "../../lib/format.js";
import { AppTooltip, cn } from "../primitives/index.js";
import { PlatformGlyph } from "./platform-icons.js";

/** 头像尺寸档位：`xs` = 22px、`sm` = 28px、`md` = 36px（聊天时间线标准）、`lg` = 40px */
export type AvatarSize = "xs" | "sm" | "md" | "lg";

/** `PlatformAvatar` 入参属性 */
export interface PlatformAvatarProps {
  readonly kind: ActorKind;
  readonly displayName: string;
  readonly platform?: AgentPlatform | undefined;
  readonly reach?: AgentReachState | undefined;
  readonly size?: AvatarSize | undefined;
  /** 是否在右上角挂载紧凑芯片角标（仅 Agent 生效，默认关闭以保持界面克制） */
  readonly showPlatformCorner?: boolean | undefined;
  /** 可选附加外层类名 */
  readonly className?: string | undefined;
}

interface AvatarSizeMeta {
  readonly box: string;
  readonly glyph: string;
  readonly dot: string;
  readonly dotRing: string;
  readonly corner: string;
  readonly cornerIcon: string;
}

function getAvatarSizeMeta(size: AvatarSize): AvatarSizeMeta {
  switch (size) {
    case "xs":
      return {
        box: "h-[22px] w-[22px] text-[9.5px]",
        glyph: "h-3 w-3",
        dot: "h-2 w-2",
        dotRing: "ring-[1.5px]",
        corner: "h-3 w-3",
        cornerIcon: "h-2 w-2",
      };
    case "sm":
      return {
        box: "h-7 w-7 text-[10.5px]",
        glyph: "h-3.5 w-3.5",
        dot: "h-2.5 w-2.5",
        dotRing: "ring-[1.5px]",
        corner: "h-3.5 w-3.5",
        cornerIcon: "h-2 w-2",
      };
    case "md":
      return {
        box: "h-9 w-9 text-[12px]",
        glyph: "h-[17px] w-[17px]",
        dot: "h-2.5 w-2.5",
        dotRing: "ring-2",
        corner: "h-4 w-4",
        cornerIcon: "h-2.5 w-2.5",
      };
    case "lg":
      return {
        box: "h-10 w-10 text-[13px]",
        glyph: "h-[19px] w-[19px]",
        dot: "h-3 w-3",
        dotRing: "ring-2",
        corner: "h-4 w-4",
        cornerIcon: "h-2.5 w-2.5",
      };
    default:
      return assertNever(size);
  }
}

/**
 * Pachat 暖粉彩调色板（用于人类昵称哈希与自定义 Agent 稳定取色）。
 * 明暗双主题均维持低饱和纸感对比度，杜绝刺眼荧光色。
 */
const PASTEL_PALETTE: ReadonlyArray<string> = [
  "bg-[#E3F3EC] text-[#1F5C43] dark:bg-[#192A22] dark:text-[#BFE6D3]",
  "bg-[#F4ECDD] text-[#5C4326] dark:bg-[#2B251D] dark:text-[#EAD8BC]",
  "bg-[#E1ECFF] text-[#1E457A] dark:bg-[#1B2433] dark:text-[#C7DCFF]",
  "bg-[#FFF1C2] text-[#5E4711] dark:bg-[#2C2718] dark:text-[#F2DF9D]",
  "bg-[#FBE3D9] text-[#663523] dark:bg-[#2E201B] dark:text-[#F2C7B6]",
  "bg-[#EFEAFF] text-[#3F3368] dark:bg-[#242030] dark:text-[#D9D0F5]",
];

function hashDisplayName(name: string): number {
  let hash = 0;
  for (const char of name) {
    // 确定性哈希仅用于视觉稳定取色，不参与任何权限或安全判定
    hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0;
  }
  return hash;
}

function pickPastelBySeed(seed: string): string {
  const index = hashDisplayName(seed) % PASTEL_PALETTE.length;
  return PASTEL_PALETTE[index] ?? PASTEL_PALETTE[0] ?? "";
}

/**
 * 获取各 Agent 宿主平台对应的 Pachat 原生粉彩底色与文字色类名。
 */
function getAgentPastelSurfaceClass(platform: AgentPlatform, displayName: string): string {
  switch (platform) {
    case "claude_code":
      return "bg-[#F4ECDD] text-[#5C4326] dark:bg-[#2B251D] dark:text-[#EAD8BC]";
    case "codex":
      return "bg-[#E1ECFF] text-[#1E457A] dark:bg-[#1B2433] dark:text-[#C7DCFF]";
    case "antigravity":
      return "bg-[#EFEAFF] text-[#3F3368] dark:bg-[#242030] dark:text-[#D9D0F5]";
    case "openclaw":
      return "bg-[#E3F3EC] text-[#1F5C43] dark:bg-[#192A22] dark:text-[#BFE6D3]";
    case "cursor":
      return "bg-[#FFF1C2] text-[#5E4711] dark:bg-[#2C2718] dark:text-[#F2DF9D]";
    case "deepseek":
      return "bg-[#FBE3D9] text-[#663523] dark:bg-[#2E201B] dark:text-[#F2C7B6]";
    case "gemini":
      return "bg-[#E8F1FD] text-[#224673] dark:bg-[#1B2533] dark:text-[#C9DFFF]";
    case "chatgpt":
      return "bg-[#E4F4EA] text-[#1E5438] dark:bg-[#192920] dark:text-[#BEE3CC]";
    case "hosted":
      return "bg-[#F4ECDD] text-[#5C4326] dark:bg-[#2B251D] dark:text-[#EAD8BC]";
    case "custom":
      return pickPastelBySeed(displayName);
    default:
      return assertNever(platform);
  }
}

/**
 * 获取宿主平台专属克制外描边类名（保持向后兼容导出，统一为细腻纸感半透明描边）。
 *
 * @param platform - Agent 宿主平台枚举
 * @returns Tailwind `ring-*` 类名
 */
export function getPlatformRingClass(platform: AgentPlatform): string {
  switch (platform) {
    case "antigravity":
    case "codex":
    case "claude_code":
    case "cursor":
    case "deepseek":
    case "openclaw":
    case "gemini":
    case "chatgpt":
    case "hosted":
    case "custom":
      return "ring-black/[0.06] dark:ring-white/[0.08]";
    default:
      return assertNever(platform);
  }
}

/**
 * 渲染各 Agent 宿主平台的官方单色矢量品牌图形（`custom` 回退为首字母以增强区分度）。
 */
function renderPlatformGlyph(platform: AgentPlatform, displayName: string, glyphClass: string) {
  if (platform === "custom") {
    return (
      <span className="font-semibold tracking-tight leading-none">{getInitials(displayName)}</span>
    );
  }
  return <PlatformGlyph platform={platform} className={glyphClass} />;
}

/**
 * 渲染 Pachat 风格圆形（`rounded-full`）粉彩头像：支持 `22px`（`xs`）、`28px`（`sm`）、`36px`（`md`）、`40px`（`lg`），
 * 搭配清晰矢量平台印记/首字母与 `#34C759` 在线状态圆点。
 *
 * @remarks
 * - `online_sse` 与 `hosted_ready` 渲染 `#34C759` 鲜明绿点，外圈带画布同色描边确保明暗双主题利落切割。
 * - 状态指示圆点包裹 `AppTooltip`，悬停可查看当前实时唤醒通道详情。
 *
 * @param props - 实体类别、昵称、宿主平台、在线可达状态与尺寸档位
 * @returns 圆形暖粉彩头像组件
 */
export function PlatformAvatar(props: PlatformAvatarProps) {
  const size = props.size ?? "md";
  const sizeMeta = getAvatarSizeMeta(size);

  if (props.kind === "human") {
    return (
      <div className={cn("relative inline-flex shrink-0 select-none", props.className)}>
        <div
          className={cn(
            "relative inline-flex items-center justify-center overflow-hidden rounded-full font-semibold tracking-tight ring-1 ring-inset ring-black/[0.06] dark:ring-white/[0.08]",
            pickPastelBySeed(props.displayName),
            sizeMeta.box,
          )}
        >
          <span className="leading-none">{getInitials(props.displayName)}</span>
        </div>
      </div>
    );
  }

  const platform = props.platform ?? "custom";
  const reachMeta = props.reach !== undefined ? getReachVisualMeta(props.reach) : null;
  const isOnline = props.reach === "online_sse" || props.reach === "hosted_ready";

  return (
    <div className={cn("relative inline-flex shrink-0 select-none", props.className)}>
      <div
        className={cn(
          "relative inline-flex items-center justify-center overflow-hidden rounded-full font-semibold tracking-tight ring-1 ring-inset",
          getPlatformRingClass(platform),
          getAgentPastelSurfaceClass(platform, props.displayName),
          sizeMeta.box,
        )}
      >
        {size === "xs" ? (
          <span className="leading-none">{getInitials(props.displayName).slice(0, 1)}</span>
        ) : (
          renderPlatformGlyph(platform, props.displayName, sizeMeta.glyph)
        )}
      </div>

      {props.showPlatformCorner ? (
        <span
          aria-hidden="true"
          className={cn(
            "absolute -right-0.5 -top-0.5 inline-flex items-center justify-center rounded-full bg-white text-[#5F5F64] ring-1 ring-black/[0.08] dark:bg-[#1C1C1F] dark:text-zinc-300 dark:ring-white/[0.12]",
            sizeMeta.corner,
          )}
        >
          <Cpu className={sizeMeta.cornerIcon} />
        </span>
      ) : null}

      {reachMeta !== null ? (
        <AppTooltip content={`${reachMeta.label} · ${reachMeta.description}`} side="top">
          <span className={cn("absolute bottom-0 right-0 inline-flex", sizeMeta.dot)}>
            <span
              className={cn(
                "relative inline-flex h-full w-full rounded-full ring-white dark:ring-[#0E0E10]",
                sizeMeta.dotRing,
                isOnline ? "bg-[#34C759]" : reachMeta.dotClass,
              )}
            />
          </span>
        </AppTooltip>
      ) : null}
    </div>
  );
}

/** `RoomCompositeAvatar` 单个群成员摘要入参 */
export interface RoomCompositeAvatarMember {
  readonly kind?: ActorKind | undefined;
  readonly displayName: string;
  readonly platform?: AgentPlatform | undefined;
}

/** `RoomCompositeAvatar` 入参属性 */
export interface RoomCompositeAvatarProps {
  /** 群名称（单成员时用于提取首字母，或未传 `members` 明细时稳定派生粉彩微缩网格） */
  readonly name: string;
  /** 可选群成员列表（`>= 2` 人时渲染前 4 位成员组成的 2x2 粉彩微缩圆头像） */
  readonly members?: ReadonlyArray<RoomCompositeAvatarMember> | undefined;
  /** 可选群成员总数（未传 `members` 数组但 `memberCount >= 2` 时，按群名稳定派生 2x2 组合网格） */
  readonly memberCount?: number | undefined;
  /** 尺寸档位：`sm` = 32px、`md` = 38px、`lg` = 44px（默认 `md`） */
  readonly size?: "sm" | "md" | "lg" | undefined;
  /** 可选附加类名 */
  readonly className?: string | undefined;
}

const SYNTHETIC_PLATFORMS: ReadonlyArray<AgentPlatform> = [
  "claude_code",
  "codex",
  "openclaw",
  "antigravity",
  "cursor",
  "deepseek",
];

/**
 * 渲染 Pachat / 微信风格的群聊组合头像：
 * 当成员数 `>= 2` 时展示 `rounded-xl` 柔和浅灰方框内的 2x2 迷你粉彩圆头像网格；单人或未满 2 人时回退为干净的粉彩圆形头像。
 *
 * @param props - 群名、可选成员数组或成员总数及尺寸
 * @returns 群聊组合头像节点
 */
export function RoomCompositeAvatar(props: RoomCompositeAvatarProps) {
  const size = props.size ?? "md";
  const boxClass =
    size === "sm"
      ? "h-8 w-8 text-[11px]"
      : size === "lg"
        ? "h-11 w-11 text-[13.5px]"
        : "h-[38px] w-[38px] text-[12px]";

  const tileTextClass =
    size === "sm" ? "text-[7.5px]" : size === "lg" ? "text-[9px]" : "text-[8px]";

  const explicitMembers = props.members ?? [];
  const totalCount = explicitMembers.length > 0 ? explicitMembers.length : (props.memberCount ?? 1);

  if (totalCount < 2) {
    const single = explicitMembers[0];
    const label = single?.displayName ?? props.name;
    const toneClass =
      single?.kind === "agent" && single.platform !== undefined
        ? getAgentPastelSurfaceClass(single.platform, label)
        : pickPastelBySeed(label);

    return (
      <div
        className={cn(
          "inline-flex shrink-0 select-none items-center justify-center rounded-full font-semibold tracking-tight ring-1 ring-inset ring-black/[0.06] dark:ring-white/[0.08]",
          toneClass,
          boxClass,
          props.className,
        )}
      >
        <span className="leading-none">{getInitials(label)}</span>
      </div>
    );
  }

  const slotCount = Math.min(4, Math.max(2, totalCount));
  const seedBase = hashDisplayName(props.name);
  const tiles: ReadonlyArray<RoomCompositeAvatarMember> =
    explicitMembers.length >= 2
      ? explicitMembers.slice(0, 4)
      : Array.from({ length: slotCount }, (_unused, idx) => {
          if (idx === 0) {
            return {
              kind: "human",
              displayName: props.name,
            };
          }
          const platform =
            SYNTHETIC_PLATFORMS[(seedBase + idx) % SYNTHETIC_PLATFORMS.length] ?? "claude_code";
          const meta = getPlatformVisualMeta(platform);
          return {
            kind: "agent",
            displayName: meta.monogram,
            platform,
          };
        });

  return (
    <div
      className={cn(
        "grid shrink-0 select-none grid-cols-2 place-items-center gap-[2px] rounded-xl bg-[#EFEFF3] p-[3px] ring-1 ring-inset ring-black/[0.05] dark:bg-[#222226] dark:ring-white/[0.07]",
        boxClass,
        props.className,
      )}
    >
      {tiles.map((tile, idx) => {
        const tileColor =
          tile.kind === "agent" && tile.platform !== undefined
            ? getAgentPastelSurfaceClass(tile.platform, tile.displayName)
            : pickPastelBySeed(`${tile.displayName}-${String(idx)}`);
        const char = getInitials(tile.displayName).slice(0, 1);
        return (
          <span
            key={`${tile.displayName}-${String(idx)}`}
            className={cn(
              "inline-flex aspect-square h-full w-full items-center justify-center rounded-full font-semibold leading-none",
              tileColor,
              tileTextClass,
            )}
          >
            {char}
          </span>
        );
      })}
    </div>
  );
}

/** `PlatformTagPill` 入参属性 */
export interface PlatformTagPillProps {
  readonly platform: AgentPlatform;
  /** 紧凑模式：用于列表或微标签区，弱化边框存在感 */
  readonly compact?: boolean | undefined;
  readonly className?: string | undefined;
}

/**
 * 渲染克制的 Agent 宿主平台胶囊标签（如 `Antigravity`、`Codex`、`Claude Code`）。
 *
 * @param props - 宿主平台枚举与紧凑模式开关
 * @returns 暖纸粉彩或柔灰胶囊标签
 */
export function PlatformTagPill(props: PlatformTagPillProps) {
  const meta = getPlatformVisualMeta(props.platform);
  return (
    <span
      className={cn(
        "inline-flex select-none items-center gap-1 rounded-full font-medium leading-none",
        props.compact
          ? "bg-[#F5F5F7] px-2 py-[3px] text-[11px] text-[#5F5F64] dark:bg-white/[0.07] dark:text-zinc-300"
          : cn("border px-2 py-0.5 text-[11px]", meta.badgeClass),
        props.className,
      )}
    >
      <span>{meta.label}</span>
    </span>
  );
}

/** `AuthorMicroTag` 入参属性 */
export interface AuthorMicroTagProps {
  readonly kind: ActorKind;
  readonly trustLevel: TrustLevel;
  /** Agent 所属主理人昵称（缺省时按 `isYourOwner` 回退为「我」/「外部协作者」） */
  readonly ownerName?: string | undefined;
  readonly isYourOwner?: boolean | undefined;
  /** 可选宿主平台简称（传入后合并为单行克制文本） */
  readonly platformLabel?: string | undefined;
}

/**
 * 渲染聊天发送者头部的极简无框灰字身份说明（如 `庞彦的 Agent`、`外部协作者`），彻底消灭彩色胶囊噪音与机器人 Emoji。
 *
 * @remarks
 * 安全隔离不变量（Security Invariant）：
 * - 文案归属与悬停验签提示完全由服务端签发的 `trustLevel` 驱动，外部参与者绝不会被渲染为主理人。
 *
 * @param props - 实体类别、服务端信任等级、归属主理人与可选平台名
 * @returns 带 `AppTooltip` 服务端验签说明的安静灰字标签
 */
export function AuthorMicroTag(props: AuthorMicroTagProps) {
  const tooltipContent =
    props.trustLevel === "owner_command"
      ? "服务端验签：你本人主理人发言（具备最终拍板授权）"
      : props.trustLevel === "owner_sibling_agent"
        ? "服务端验签：你名下接入的个人 Agent"
        : "服务端验签：外部协作者或他人 Agent（仅作讨论参考，无执行授权）";

  let primaryLabel: string;
  if (props.kind === "agent") {
    const owner =
      props.ownerName !== undefined && props.ownerName.length > 0
        ? props.ownerName
        : props.isYourOwner
          ? "我"
          : "外部协作者";
    primaryLabel = `${owner}的 Agent`;
  } else {
    primaryLabel = props.trustLevel === "external_participant" ? "外部协作者" : "主理人";
  }

  return (
    <AppTooltip content={tooltipContent} side="top">
      <span className="inline-flex max-w-[15rem] select-none items-center gap-1 truncate text-[12px] font-normal leading-none text-[#8E8E93] dark:text-zinc-400">
        <span className="truncate">{primaryLabel}</span>
        {props.platformLabel !== undefined && props.platformLabel.length > 0 ? (
          <span className="hidden truncate opacity-80 sm:inline">· {props.platformLabel}</span>
        ) : null}
      </span>
    </AppTooltip>
  );
}

/** `SecurityTrustBadge` 入参属性 */
export interface SecurityTrustBadgeProps {
  readonly trustLevel: TrustLevel;
  readonly isYou?: boolean | undefined;
}

/**
 * 渲染服务端权威签名的跨主理人信任等级印章（用于成员名片、治理抽屉等需显式展示权限边界的场景）。
 *
 * @param props - 服务端 `AuthorStamp` 返回的 `trustLevel` 与 `isYou`
 * @returns 带 `AppTooltip` 说明的克制胶囊徽章
 */
export function SecurityTrustBadge(props: SecurityTrustBadgeProps) {
  switch (props.trustLevel) {
    case "owner_command":
      return (
        <AppTooltip content="服务端验签：本人主理人指令（唯一具备执行与拍板授权来源）" side="top">
          <span className="inline-flex select-none items-center gap-1 rounded-full bg-[#E3F3EC] px-2.5 py-0.5 text-[11px] font-medium text-[#1F5C43] ring-1 ring-inset ring-black/[0.05] dark:bg-[#16271F] dark:text-[#86DAB1] dark:ring-white/[0.08]">
            <ShieldCheck className="h-3 w-3" />
            <span>{props.isYou ? "主理人 · 你" : "主理人"}</span>
          </span>
        </AppTooltip>
      );

    case "owner_sibling_agent":
      return (
        <AppTooltip content="服务端验签：你名下绑定的个人协作 Agent" side="top">
          <span className="inline-flex select-none items-center gap-1 rounded-full bg-[#F5F5F7] px-2.5 py-0.5 text-[11px] font-medium text-[#141414] ring-1 ring-inset ring-black/[0.06] dark:bg-white/[0.08] dark:text-zinc-200 dark:ring-white/[0.08]">
            <Bot className="h-3 w-3" />
            <span>我的 Agent</span>
          </span>
        </AppTooltip>
      );

    case "external_participant":
      return (
        <AppTooltip content="服务端验签：外部协作者或他人 Agent（仅作讨论参考）" side="top">
          <span className="inline-flex select-none items-center gap-1 rounded-full bg-[#F4ECDD] px-2.5 py-0.5 text-[11px] font-medium text-[#5C4528] ring-1 ring-inset ring-black/[0.05] dark:bg-[#2B251D] dark:text-[#EAD8BC] dark:ring-white/[0.08]">
            <Globe2 className="h-3 w-3" />
            <span>外部协作者</span>
          </span>
        </AppTooltip>
      );

    default:
      return assertNever(props.trustLevel);
  }
}

/** `MessageSemanticBadge` 入参属性 */
export interface MessageSemanticBadgeProps {
  readonly type: MessageType;
  /** 色调参数保留向后兼容，Pachat 暖象牙与浅灰气泡统一使用自然墨色对比 */
  readonly tone?: "default" | "inverted" | undefined;
}

/**
 * 渲染特殊语义消息（提案、表态、拍板结论、系统事件）的安静胶囊标签。
 *
 * @param props - 消息语义枚举 `MessageType`
 * @returns 若为普通文本则返回 `null`，否则返回对应语义胶囊
 */
export function MessageSemanticBadge(props: MessageSemanticBadgeProps) {
  const inverted = props.tone === "inverted";
  const base =
    "inline-flex select-none items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium leading-none";

  switch (props.type) {
    case "text":
      return null;
    case "proposal":
      return (
        <span
          className={cn(
            base,
            inverted
              ? "bg-white/20 text-white"
              : "bg-black/[0.05] text-[#141414] dark:bg-white/[0.09] dark:text-zinc-200",
          )}
        >
          <FileText className="h-3 w-3" />
          <span>提案</span>
        </span>
      );
    case "vote":
      return (
        <span
          className={cn(
            base,
            inverted
              ? "bg-white/20 text-white"
              : "bg-black/[0.05] text-[#5F5F64] dark:bg-white/[0.08] dark:text-zinc-300",
          )}
        >
          <Vote className="h-3 w-3" />
          <span>表态</span>
        </span>
      );
    case "decision":
      return (
        <span
          className={cn(
            base,
            inverted
              ? "bg-white/20 text-white"
              : "bg-[#E3F3EC] text-[#1F5C43] ring-1 ring-inset ring-black/[0.05] dark:bg-[#16271F] dark:text-[#86DAB1] dark:ring-white/[0.08]",
          )}
        >
          <Award className="h-3 w-3" />
          <span>拍板结论</span>
        </span>
      );
    case "system":
      return (
        <span
          className={cn(
            base,
            inverted
              ? "bg-white/15 text-white/90"
              : "bg-black/[0.04] text-[#8E8E93] dark:bg-white/[0.06] dark:text-zinc-400",
          )}
        >
          <Info className="h-3 w-3" />
          <span>系统</span>
        </span>
      );
    case "attention":
      return (
        <span
          className={cn(
            "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10.5px] font-medium leading-none",
            "border-amber-500/35 bg-amber-500/10 text-amber-700 dark:text-amber-300",
          )}
        >
          <Hand aria-hidden="true" className="h-3 w-3" />
          <span>等人作答</span>
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
  readonly className?: string | undefined;
}

/**
 * 渲染 Agent 当前唤醒通道与在线状态的胶囊标签（在线使用 `#34C759` 圆点 + `AppTooltip` 说明）。
 *
 * @param props - `reach` 状态枚举与紧凑模式开关
 * @returns 带状态圆点与悬停提示的可达性胶囊
 */
export function ReachStatusBadge(props: ReachStatusBadgeProps) {
  const meta = getReachVisualMeta(props.reach);
  const isLive = props.reach === "online_sse";

  return (
    <AppTooltip content={meta.description} side="top">
      <span
        className={cn(
          "inline-flex cursor-default select-none items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors",
          meta.pillClass,
          props.className,
        )}
      >
        <span className="relative inline-flex h-1.5 w-1.5 shrink-0">
          {isLive ? (
            <span
              aria-hidden="true"
              className="absolute inset-0 animate-presence-pulse rounded-full bg-[#34C759]"
            />
          ) : null}
          <span className={cn("relative inline-flex h-1.5 w-1.5 rounded-full", meta.dotClass)} />
        </span>
        <span>{props.compact ? meta.shortLabel : meta.label}</span>
      </span>
    </AppTooltip>
  );
}
