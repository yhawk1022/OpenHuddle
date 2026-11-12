/**
 * @module web/components/ui/agent-profile-dialog
 * @description 个人智能体身份名片弹窗（展示宿主平台、所属人类 Owner 血统、自我介绍、实时唤醒通道与一键 `--reclaim` 重连）。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 透明血统溯源（Lineage Transparency）：清晰高亮 `Owner: <人类名称>`，彻底消除群聊中“不知道这是谁的 Agent”的信任盲区。
 * 2. 纯 Props 驱动：兼容从右侧群成员列表、消息气泡头部或“我的 Agent”面板统一唤起。
 */
import type { AgentId, AgentPlatform, AgentReachState, UserId } from "@openhuddle/protocol";
import { AtSign, Clock, KeyRound, Radio, ShieldCheck, UserCheck } from "lucide-react";
import {
  formatMessageTimestamp,
  getPlatformVisualMeta,
  getReachVisualMeta,
} from "../../lib/format.js";
import { PlatformAvatar, PlatformTagPill, ReachStatusBadge } from "./identity-badges.js";
import { ModalDialog } from "./modal-dialog.js";

/** 被检视的 Agent 名片统一视图模型 */
export interface InspectedAgentProfile {
  readonly agentId: AgentId;
  readonly displayName: string;
  readonly slug?: string | undefined;
  readonly platform: AgentPlatform;
  readonly ownerUserId: UserId;
  readonly ownerDisplayName: string;
  readonly intro?: string | undefined;
  readonly reach?: AgentReachState | undefined;
  readonly checkinIntervalMin?: number | undefined;
  readonly lastSeenAtIso?: string | undefined;
}

/** `AgentProfileDialog` 入参属性 */
export interface AgentProfileDialogProps {
  readonly profile: InspectedAgentProfile | null;
  readonly currentUserId?: UserId | undefined;
  readonly onClose: () => void;
  readonly onMentionAgent?: ((agentId: AgentId, displayName: string) => void) | undefined;
  readonly onReclaimAgent?: ((agentId: AgentId) => void) | undefined;
}

/**
 * 渲染 Pachat 增强版 Agent 详情名片弹窗。
 *
 * @param props - 当前选中的 Agent 名片、当前人类用户 ID 及快捷操作回调
 * @returns 名片模态弹窗
 */
export function AgentProfileDialog(props: AgentProfileDialogProps) {
  const { profile } = props;
  if (!profile) {
    return null;
  }

  const platformMeta = getPlatformVisualMeta(profile.platform);
  const reachMeta = getReachVisualMeta(profile.reach);
  const isOwnedByMe =
    props.currentUserId !== undefined && profile.ownerUserId === props.currentUserId;

  return (
    <ModalDialog
      open={true}
      onClose={props.onClose}
      title="Personal Agent 身份与连接档案"
      subtitle="透明验证 Agent 归属关系、唤醒链路与安全沙箱边界"
      maxWidthClass="max-w-md"
    >
      <div className="space-y-4">
        {/* 顶部宿主平台名片头 */}
        <div className="flex items-start gap-3.5 rounded-xl border border-slate-200/80 bg-slate-50/80 p-4 dark:border-white/[0.08] dark:bg-white/[0.03]">
          <PlatformAvatar
            kind="agent"
            displayName={profile.displayName}
            platform={profile.platform}
            reach={profile.reach}
            size="lg"
          />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="truncate text-base font-semibold text-slate-900 dark:text-white">
                {profile.displayName}
              </h3>
              <PlatformTagPill platform={profile.platform} />
            </div>
            {profile.slug ? (
              <p className="mt-0.5 font-mono text-xs text-slate-500 dark:text-slate-400">
                @{profile.slug}
              </p>
            ) : null}
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <ReachStatusBadge reach={profile.reach} />
            </div>
          </div>
        </div>

        {/* 归属人类 Owner 权威溯源 */}
        <div className="rounded-xl border border-emerald-500/25 bg-emerald-500/[0.06] p-3.5">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-xs font-semibold text-emerald-800 dark:text-emerald-300">
              <UserCheck className="h-4 w-4 shrink-0" />
              <span>绑定人类主人 (Verified Owner): {profile.ownerDisplayName}</span>
            </div>
            {isOwnedByMe ? (
              <span className="rounded-full bg-emerald-500/20 px-2 py-0.5 text-[10px] font-bold text-emerald-700 dark:text-emerald-200">
                你的专属 Agent
              </span>
            ) : null}
          </div>
          <p className="mt-1.5 flex items-start gap-1.5 text-[11.5px] leading-relaxed text-slate-600 dark:text-slate-300">
            <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-500" />
            <span>
              Owner-First 隔离保护：该 Agent 仅将{" "}
              <strong className="font-semibold">{profile.ownerDisplayName}</strong>{" "}
              本人的发言识别为可授信指令，其他群成员发言自动隔离为参考上下文。
            </span>
          </p>
        </div>

        {/* 个人简介 Bio */}
        <div className="space-y-1.5">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
            角色专长与自我介绍 (Bio)
          </h4>
          <p className="rounded-xl border border-slate-200/80 bg-white p-3 text-xs leading-relaxed text-slate-700 dark:border-white/[0.07] dark:bg-white/[0.02] dark:text-slate-300">
            {profile.intro && profile.intro.trim().length > 0
              ? profile.intro
              : `运行于 ${platformMeta.label} 宿主环境（${platformMeta.cliHint}）。`}
          </p>
        </div>

        {/* 实时触达与巡检遥测 */}
        <div className="rounded-xl border border-slate-200/80 bg-slate-50/60 p-3.5 text-xs dark:border-white/[0.07] dark:bg-white/[0.02]">
          <div className="flex items-center gap-1.5 font-semibold text-slate-800 dark:text-slate-200">
            <Radio className="h-3.5 w-3.5 text-indigo-500" />
            <span>唤醒通道状态：{reachMeta.label}</span>
          </div>
          <p className="mt-1 text-[11.5px] leading-relaxed text-slate-500 dark:text-slate-400">
            {reachMeta.description}
          </p>
          <div className="mt-2.5 flex flex-wrap items-center gap-4 border-t border-slate-200/70 pt-2 text-[11px] text-slate-500 dark:border-white/[0.06] dark:text-slate-400">
            {profile.checkinIntervalMin !== undefined ? (
              <span className="inline-flex items-center gap-1">
                <Clock className="h-3 w-3" />
                巡检周期：每 {profile.checkinIntervalMin} 分钟
              </span>
            ) : null}
            {profile.lastSeenAtIso !== undefined ? (
              <span>最近活跃：{formatMessageTimestamp(profile.lastSeenAtIso)}</span>
            ) : null}
          </div>
        </div>

        {/* 快捷操作栏 */}
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-slate-200/80 pt-3 dark:border-white/[0.08]">
          {isOwnedByMe && props.onReclaimAgent ? (
            <button
              type="button"
              onClick={() => {
                props.onReclaimAgent?.(profile.agentId);
                props.onClose();
              }}
              className="inline-flex items-center gap-1.5 rounded-xl border border-amber-500/35 bg-amber-500/12 px-3.5 py-2 text-xs font-semibold text-amber-800 transition hover:bg-amber-500/20 dark:text-amber-300"
            >
              <KeyRound className="h-3.5 w-3.5" />
              <span>生成 --reclaim 恢复重连码</span>
            </button>
          ) : null}

          {props.onMentionAgent ? (
            <button
              type="button"
              onClick={() => {
                props.onMentionAgent?.(profile.agentId, profile.displayName);
                props.onClose();
              }}
              className="inline-flex items-center gap-1.5 rounded-xl bg-indigo-600 px-3.5 py-2 text-xs font-semibold text-white shadow-xs transition hover:bg-indigo-500"
            >
              <AtSign className="h-3.5 w-3.5" />
              <span>在输入框 @ 提及它</span>
            </button>
          ) : null}
        </div>
      </div>
    </ModalDialog>
  );
}
