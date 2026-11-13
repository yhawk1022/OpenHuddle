/**
 * @module web/components/ui/agent-profile-dialog
 * @description Pachat 极简联系人名片弹窗：圆形暖粉彩头像 + 实时在线状态胶囊 + 主人归属关系卡 + 连接详情 + 一键胶囊操作按钮。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 透明归属溯源（Lineage Transparency）：始终清晰展示「由 @Owner 绑定」，消除多 Agent 群聊中“不知道这是谁的 AI”的信任盲区；Owner 字段仅源自服务端权威成员视图，绝不从消息正文推断。
 * 2. 纯 Props 驱动：支持从群成员侧栏、消息气泡头像或通讯录面板统一唤起，组件自身零网络请求。
 * 3. Pachat 去模板化克制视觉：摒弃廉价紫色渐变封面横幅，采用纯净 `#FFFFFF` / `#18181B` 纸面、`#F5F5F7` 柔和信息卡、圆形粉彩头像与 `#141414` 胶囊按钮。
 */
import {
  type AgentId,
  type AgentPlatform,
  type AgentReachState,
  type UserId,
  assertNever,
} from "@openhuddle/protocol";
import {
  AtSign,
  BadgeCheck,
  Check,
  Clock,
  Copy,
  KeyRound,
  Radio,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { useEffect, useState } from "react";
import {
  formatMessageTimestamp,
  getInitials,
  getPlatformVisualMeta,
  getReachVisualMeta,
} from "../../lib/format.js";
import {
  AppButton,
  AppModal,
  AppTooltip,
  IconButton,
  cn,
  motion,
  toast,
} from "../primitives/index.js";

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
  /** 是否在打开名片时直接展开删除二次确认卡片（如从左侧 80px 导轨悬停 `×` 触发） */
  readonly initialConfirmDelete?: boolean | undefined;
  /** 删除请求进行中加载状态 */
  readonly isDeletingAgent?: boolean | undefined;
  /** 仅针对当前登录人类本人名下的 Agent 暴露彻底删除回调 */
  readonly onDeleteAgent?: ((agentId: AgentId, displayName: string) => void) | undefined;
}

/** 名片上的可达性胶囊视觉描述 */
interface ReachPillMeta {
  readonly text: string;
  readonly hint: string;
  readonly className: string;
  readonly dotClassName: string;
  readonly pulse: boolean;
}

/**
 * 将五态 `AgentReachState` 折叠为自然克制的三档在线状态胶囊。
 *
 * @param reach - 服务端下发的 Agent 可达状态（缺省视为离线）
 * @param checkinIntervalMin - 定时巡检周期（分钟），仅用于巡检态提示
 * @returns 胶囊文案、提示与双主题配色类名
 */
function resolveReachPill(
  reach: AgentReachState | undefined,
  checkinIntervalMin: number | undefined,
): ReachPillMeta {
  const effective = reach ?? "offline";
  switch (effective) {
    case "online_sse":
      return {
        text: "实时在线",
        hint: "群里 @ 后即刻唤醒",
        className:
          "border-black/[0.06] bg-[#E4F4EA] text-[#215236] dark:border-white/[0.08] dark:bg-[#192920] dark:text-[#86E0A6]",
        dotClassName: "bg-[#34C759]",
        pulse: true,
      };
    case "hosted_ready":
      return {
        text: "云端在线",
        hint: "托管模型已就绪，随时响应",
        className:
          "border-black/[0.06] bg-[#E4F4EA] text-[#215236] dark:border-white/[0.08] dark:bg-[#192920] dark:text-[#86E0A6]",
        dotClassName: "bg-[#34C759]",
        pulse: true,
      };
    case "webhook":
      return {
        text: "实时在线",
        hint: "Webhook 实时推送唤醒",
        className:
          "border-black/[0.06] bg-[#E1ECFF] text-[#244375] dark:border-white/[0.08] dark:bg-[#1B2433] dark:text-[#9EC5FF]",
        dotClassName: "bg-[#2F6FED]",
        pulse: true,
      };
    case "polling":
      return {
        text: "定时巡检",
        hint:
          checkinIntervalMin !== undefined
            ? `约每 ${checkinIntervalMin} 分钟看一次群消息`
            : "下一个巡检窗口回复",
        className:
          "border-black/[0.06] bg-[#FFF1C2] text-[#5C4813] dark:border-white/[0.08] dark:bg-[#2C2718] dark:text-[#F2DF9D]",
        dotClassName: "bg-[#D99B26] dark:bg-[#E5B34B]",
        pulse: false,
      };
    case "offline":
      return {
        text: "暂不在线",
        hint: "等待主人运行 listen 唤醒",
        className:
          "border-black/[0.06] bg-[#F5F5F7] text-[#6E6E73] dark:border-white/[0.08] dark:bg-[#242428] dark:text-zinc-400",
        dotClassName: "bg-[#C7C7CC] dark:bg-zinc-500",
        pulse: false,
      };
    default:
      return assertNever(effective);
  }
}

/**
 * 渲染 Pachat 极简风格的个人 Agent 联系人名片弹窗。
 *
 * @remarks
 * `--reclaim` 恢复入口仅对名片所属 Owner 本人展示（`ownerUserId === currentUserId`），
 * 这属于 UI 层的体验收敛；真正的配对归属权限仍由服务端配对事务强制校验。
 *
 * @param props - 当前选中的 Agent 名片、当前人类用户 ID 及快捷操作回调
 * @returns 名片模态弹窗；`profile` 为空时返回 `null`
 */
export function AgentProfileDialog(props: AgentProfileDialogProps) {
  const { profile } = props;
  const [copiedHandle, setCopiedHandle] = useState<boolean>(false);
  const [confirmingDelete, setConfirmingDelete] = useState<boolean>(false);

  // 切换查看不同 Agent 名片或外部显式请求删除确认时同步局部交互态
  const activeAgentId = profile?.agentId;
  useEffect(() => {
    if (activeAgentId !== undefined) {
      setCopiedHandle(false);
      setConfirmingDelete(props.initialConfirmDelete === true);
    } else {
      setConfirmingDelete(false);
    }
  }, [activeAgentId, props.initialConfirmDelete]);

  if (!profile) {
    return null;
  }

  const platformMeta = getPlatformVisualMeta(profile.platform);
  const reachMeta = getReachVisualMeta(profile.reach);
  const reachPill = resolveReachPill(profile.reach, profile.checkinIntervalMin);
  const isOwnedByMe =
    props.currentUserId !== undefined && profile.ownerUserId === props.currentUserId;
  const handleText = profile.slug ? `@${profile.slug}` : `@${profile.displayName}`;
  const bioText =
    profile.intro !== undefined && profile.intro.trim().length > 0
      ? profile.intro
      : `运行在 ${platformMeta.label} 上的个人 Agent。${platformMeta.cliHint}。`;

  const handleCopyMentionTag = (): void => {
    if (typeof navigator === "undefined" || !navigator.clipboard) {
      return;
    }
    void navigator.clipboard.writeText(handleText).then(() => {
      setCopiedHandle(true);
      toast.success("已复制提及标识", { description: handleText });
      window.setTimeout(() => {
        setCopiedHandle(false);
      }, 1_800);
    });
  };

  return (
    <AppModal
      open={true}
      onClose={props.onClose}
      title="Agent 名片"
      subtitle="身份归属与实时在线状态"
      maxWidthClass="max-w-[400px]"
      bodyClassName="px-6 pt-5 pb-6"
    >
      <div className="select-none space-y-4">
        {/* 顶部圆形粉彩大头像 + 宿主平台胶囊 + 在线状态胶囊（无廉价渐变封面横幅） */}
        <div className="flex items-start justify-between gap-3">
          <motion.div
            initial={{ scale: 0.92, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ type: "spring", stiffness: 460, damping: 30 }}
            className="relative"
          >
            <div
              className={cn(
                "flex h-16 w-16 items-center justify-center rounded-full font-mono text-xl font-bold tracking-tight",
                platformMeta.avatarClass,
              )}
            >
              {platformMeta.monogram}
            </div>
            <AppTooltip content={reachMeta.label} side="right">
              <span
                className={cn(
                  "absolute right-0.5 bottom-0.5 h-3.5 w-3.5 rounded-full ring-[3px] ring-white dark:ring-[#18181B]",
                  reachPill.dotClassName,
                )}
              />
            </AppTooltip>
          </motion.div>

          <div className="flex flex-wrap items-center justify-end gap-1.5 pt-1">
            <span
              className={cn(
                "inline-flex items-center rounded-full border px-2.5 py-0.5 text-[11px] font-medium",
                platformMeta.badgeClass,
              )}
            >
              {platformMeta.label}
            </span>
            <AppTooltip content={reachMeta.description} side="top">
              <span
                className={cn(
                  "inline-flex cursor-default items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium",
                  reachPill.className,
                )}
              >
                <span className="relative flex h-1.5 w-1.5">
                  {reachPill.pulse ? (
                    <span
                      className={cn(
                        "absolute inline-flex h-full w-full animate-ping rounded-full opacity-60",
                        reachPill.dotClassName,
                      )}
                    />
                  ) : null}
                  <span
                    className={cn(
                      "relative inline-flex h-1.5 w-1.5 rounded-full",
                      reachPill.dotClassName,
                    )}
                  />
                </span>
                <span>{reachPill.text}</span>
              </span>
            </AppTooltip>
          </div>
        </div>

        {/* 昵称、@handle 一键复制与唤醒说明 */}
        <div>
          <h3 className="truncate text-[19px] font-semibold tracking-[-0.02em] text-[#141414] dark:text-zinc-100">
            {profile.displayName}
          </h3>
          <div className="mt-1 flex items-center gap-1.5 text-xs text-[#6E6E73] dark:text-zinc-400">
            <span className="truncate font-mono text-[11.5px] text-[#3A3A3C] dark:text-zinc-300">
              {handleText}
            </span>
            <AppTooltip content="复制 @ 标识" side="top">
              <IconButton
                size="xs"
                variant="ghost"
                label="复制 Agent 提及标识"
                onClick={handleCopyMentionTag}
              >
                {copiedHandle ? (
                  <Check aria-hidden="true" className="h-3 w-3 text-[#34C759]" />
                ) : (
                  <Copy aria-hidden="true" className="h-3 w-3" />
                )}
              </IconButton>
            </AppTooltip>
            <span className="text-[#C7C7CC] dark:text-zinc-600">·</span>
            <span className="truncate">{reachPill.hint}</span>
          </div>
        </div>

        {/* Owner 授权血统溯源卡：温润鼠尾草绿 / 浅灰纸面 */}
        <motion.div
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ type: "spring", stiffness: 420, damping: 32, delay: 0.03 }}
          className="flex items-center gap-3 rounded-[18px] bg-[#F5F5F7] px-3.5 py-3 ring-1 ring-inset ring-black/[0.05] dark:bg-[#222226] dark:ring-white/[0.07]"
        >
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#F6F2EC] text-xs font-semibold text-[#141414] ring-1 ring-inset ring-black/[0.06] dark:bg-[#272521] dark:text-[#F4F4F2] dark:ring-white/[0.08]">
            {getInitials(profile.ownerDisplayName)}
          </div>
          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-1 text-[13px] font-semibold text-[#141414] dark:text-zinc-100">
              <span className="truncate">{profile.ownerDisplayName} 的个人 Agent</span>
              <BadgeCheck aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-[#34C759]" />
            </p>
            <p className="mt-0.5 text-[11.5px] leading-snug text-[#6E6E73] dark:text-zinc-400">
              只听从主人的指令，群内其他成员发言仅作参考
            </p>
          </div>
          {isOwnedByMe ? (
            <span className="shrink-0 rounded-full bg-[#141414] px-2.5 py-0.5 text-[10.5px] font-medium text-white dark:bg-[#F5F5F7] dark:text-[#141414]">
              我的
            </span>
          ) : null}
        </motion.div>

        {/* 角色简介 Bio */}
        <div className="rounded-[18px] bg-[#F5F5F7] px-3.5 py-3 ring-1 ring-inset ring-black/[0.05] dark:bg-[#222226] dark:ring-white/[0.07]">
          <h4 className="text-[11px] font-medium text-[#8E8E93] dark:text-zinc-400">简介</h4>
          <p className="mt-1 select-text text-[13px] leading-relaxed text-[#141414] dark:text-zinc-200">
            {bioText}
          </p>
        </div>

        {/* 连接与活跃信息双栏格 */}
        <div className="grid grid-cols-2 gap-2 text-xs">
          <div className="rounded-[16px] bg-[#F5F5F7] px-3 py-2.5 ring-1 ring-inset ring-black/[0.05] dark:bg-[#222226] dark:ring-white/[0.07]">
            <p className="flex items-center gap-1 text-[11px] text-[#8E8E93] dark:text-zinc-400">
              <Radio aria-hidden="true" className="h-3 w-3" />
              <span>连接方式</span>
            </p>
            <p className="mt-1 truncate font-medium text-[#141414] dark:text-zinc-100">
              {reachMeta.label}
            </p>
          </div>
          <div className="rounded-[16px] bg-[#F5F5F7] px-3 py-2.5 ring-1 ring-inset ring-black/[0.05] dark:bg-[#222226] dark:ring-white/[0.07]">
            <p className="flex items-center gap-1 text-[11px] text-[#8E8E93] dark:text-zinc-400">
              <Clock aria-hidden="true" className="h-3 w-3" />
              <span>{profile.checkinIntervalMin !== undefined ? "巡检频率" : "最近在线"}</span>
            </p>
            <p className="mt-1 truncate font-medium text-[#141414] dark:text-zinc-100">
              {profile.checkinIntervalMin !== undefined
                ? `每 ${profile.checkinIntervalMin} 分钟`
                : profile.lastSeenAtIso !== undefined
                  ? formatMessageTimestamp(profile.lastSeenAtIso)
                  : "暂无记录"}
            </p>
          </div>
        </div>

        {profile.checkinIntervalMin !== undefined && profile.lastSeenAtIso !== undefined ? (
          <p className="text-right text-[11px] text-[#8E8E93] dark:text-zinc-500">
            最近在线 {formatMessageTimestamp(profile.lastSeenAtIso)}
          </p>
        ) : null}

        <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-[#8E8E93] dark:text-zinc-500">
          <ShieldCheck aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#34C759]" />
          <span>身份由服务端凭独立 oh_agt_ 令牌核验，改昵称也无法冒充主人归属。</span>
        </p>

        {/* 底部胶囊操作栏 */}
        {props.onMentionAgent || (isOwnedByMe && (props.onReclaimAgent || props.onDeleteAgent)) ? (
          <div className="flex flex-col gap-2 pt-1">
            {props.onMentionAgent ? (
              <AppButton
                variant="primary"
                size="lg"
                fullWidth={true}
                leadingIcon={<AtSign aria-hidden="true" className="h-4 w-4" />}
                onClick={() => {
                  props.onMentionAgent?.(profile.agentId, profile.displayName);
                  props.onClose();
                }}
              >
                在群里 @ TA
              </AppButton>
            ) : null}

            {isOwnedByMe && props.onReclaimAgent && !confirmingDelete ? (
              <AppButton
                variant="secondary"
                size="md"
                fullWidth={true}
                leadingIcon={<KeyRound aria-hidden="true" className="h-3.5 w-3.5" />}
                onClick={() => {
                  props.onReclaimAgent?.(profile.agentId);
                  props.onClose();
                }}
              >
                断连了？恢复原身份重连
              </AppButton>
            ) : null}

            {isOwnedByMe && props.onDeleteAgent ? (
              confirmingDelete ? (
                <div className="space-y-2.5 rounded-[18px] bg-[#FF3B30]/[0.07] px-3.5 py-3 ring-1 ring-inset ring-[#FF3B30]/20 dark:bg-[#FF453A]/[0.12] dark:ring-[#FF453A]/25">
                  <p className="text-[12px] leading-relaxed text-[#8A1C14] dark:text-[#FFB4AE]">
                    确定彻底删除「{profile.displayName}
                    」？将自动移出所有群聊、吊销令牌并停止本机监听（群内历史消息会安全保留）。
                  </p>
                  <div className="flex items-center justify-end gap-2">
                    <AppButton
                      variant="secondary"
                      size="sm"
                      disabled={props.isDeletingAgent === true}
                      onClick={() => setConfirmingDelete(false)}
                    >
                      取消
                    </AppButton>
                    <AppButton
                      variant="danger"
                      size="sm"
                      isLoading={props.isDeletingAgent === true}
                      leadingIcon={<Trash2 aria-hidden="true" className="h-3.5 w-3.5" />}
                      onClick={() => props.onDeleteAgent?.(profile.agentId, profile.displayName)}
                    >
                      确认彻底删除
                    </AppButton>
                  </div>
                </div>
              ) : (
                <AppButton
                  variant="dangerSoft"
                  size="md"
                  fullWidth={true}
                  leadingIcon={<Trash2 aria-hidden="true" className="h-3.5 w-3.5" />}
                  onClick={() => setConfirmingDelete(true)}
                >
                  删除该 Agent
                </AppButton>
              )
            ) : null}
          </div>
        ) : null}
      </div>
    </AppModal>
  );
}
