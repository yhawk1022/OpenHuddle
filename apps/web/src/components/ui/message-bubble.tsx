/**
 * @module web/components/ui/message-bubble
 * @description 纯 Props 驱动的清晰高对比度聊天气泡组件（本人右侧暖亚麻瓷 `#F4EFE6` / 暗夜中性石墨 `#2E2E34`；同伴鼠尾草 `#E6F5EC` / 暗夜 `#1B2B23`；Agent 清冷瓷白 `bg-white/95` / 暗夜 `#222226`），同时服务实时聊天室与公开只读分享页。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 身份只信服务端签名：左右对齐由 `author.isYou` 决定，同伴/Agent 底色由 `author.kind` 决定，归属灰字由 `author.trustLevel` 决定，绝不从昵称或正文推断。
 * 2. Apple Liquid Glass 严格分层：消息内容气泡本身绝不叠加 `backdrop-blur`，保证长列表 120Hz 滚动锐利流畅；仅悬浮在气泡顶部的快捷操作条采用 `liquid-glass-pill`。
 * 3. 反「机器监控感」极简排版：不在消息流上裸露 `#seq` 序号徽章；外层 `<article id="msg-seq-{seq}">` 保留完整 DOM 锚点以驱动引用平滑滚动高亮，序号仅在时间戳悬停提示中按需可查。
 * 4. 连续分组柔和圆角：首条带方向角，连续分组续条采用全对称 `rounded-[18px]`；内联回复采用 `2px` 细竖线。
 */
import type {
  AgentId,
  AgentReachState,
  MessageDto,
  MessageMention,
  MessageSeq,
  ProposalCardDto,
  ProposalId,
} from "@openhuddle/protocol";
import {
  AtSign,
  Award,
  BookmarkPlus,
  Check,
  ChevronRight,
  Copy,
  FileText,
  Loader2,
  Reply,
  RotateCcw,
  UserRound,
} from "lucide-react";
import { useState } from "react";
import {
  canViewerRecallMessage,
  formatMessageTimestamp,
  getMessageSnippet,
  getPlatformVisualMeta,
} from "../../lib/format.js";
import type { OptimisticMessageItem } from "../../lib/query-keys.js";
import {
  AppContextMenu,
  type AppContextMenuEntry,
  AppTooltip,
  cn,
  motion,
  toast,
} from "../primitives/index.js";
import type { InspectedAgentProfile } from "./agent-profile-dialog.js";
import { AuthorMicroTag, MessageSemanticBadge, PlatformAvatar } from "./identity-badges.js";
import { MarkdownContent } from "./markdown-content.js";
import { MessageAttachment } from "./message-attachment.js";

/** `MessageBubble` 入参属性 */
export interface MessageBubbleProps {
  readonly message: OptimisticMessageItem;
  readonly repliedMessage?: MessageDto | undefined;
  readonly linkedProposal?: ProposalCardDto | undefined;
  readonly authorOwnerName?: string | undefined;
  readonly authorReach?: AgentReachState | undefined;
  readonly nowMs: number;
  readonly readOnly?: boolean | undefined;
  readonly isRecalling?: boolean | undefined;
  /**
   * 是否与上一条消息属于同一发送者的连续分组（同作者、非系统消息、间隔较短）。
   * 为真时隐藏头像与发送者头部，仅保留紧凑气泡。
   */
  readonly isGroupedWithPrevious?: boolean | undefined;
  readonly onReply?: ((message: MessageDto) => void) | undefined;
  readonly onQuickMention?: ((mention: MessageMention) => void) | undefined;
  /** ADR-0002：Attention 选项一键作答回调（携带 replyTo 与选项文本） */
  readonly onAnswerAttention?: ((replyToSeq: MessageSeq, answer: string) => void) | undefined;
  readonly onRecall?: ((seq: MessageSeq) => void) | undefined;
  /** 收藏当前已确认的表情附件。 */
  readonly onSaveSticker?: ((message: MessageDto) => void) | undefined;
  readonly onOpenProposal?: ((proposalId: ProposalId) => void) | undefined;
  readonly onInspectAgent?: ((profile: InspectedAgentProfile) => void) | undefined;
  /** 点击引用块时的跳转回调；缺省时组件自行滚动到 `#msg-seq-{seq}` 并短暂高亮 */
  readonly onJumpToSeq?: ((seq: MessageSeq) => void) | undefined;
}

/** 引用跳转命中后的瞬时高亮工具类（保持完整字面量以便 Tailwind CSS 扫描包含） */
const JUMP_HIGHLIGHT_CLASS = "bg-im-accent-soft";

/** 气泡轻盈弹簧入场物理参数 */
const BUBBLE_SPRING = {
  type: "spring",
  stiffness: 480,
  damping: 35,
  mass: 0.72,
} as const;

/**
 * 默认引用跳转行为：平滑滚动到目标 `#msg-seq-{seq}` 锚点并短暂淡入柔和底色。
 *
 * @remarks
 * 直接操作外层 `<article>` 的类名而非 React 状态，避免瞬时定位触发整条时间线重渲染。
 */
function scrollToMessageSeq(seq: MessageSeq): void {
  if (typeof document === "undefined") {
    return;
  }
  const target = document.getElementById(`msg-seq-${String(seq)}`);
  if (target === null) {
    return;
  }
  target.scrollIntoView({ behavior: "smooth", block: "center" });
  target.classList.add(JUMP_HIGHLIGHT_CLASS);
  window.setTimeout(() => {
    target.classList.remove(JUMP_HIGHLIGHT_CLASS);
  }, 1_400);
}

/**
 * 渲染单条 Pachat 风格群聊消息：
 * - 本人右对齐暖象牙纸气泡（`#F6F2EC` / `dark:#272521`，`rounded-[18px_6px_18px_18px]`）；
 * - 其他人类左对齐 36px 圆形头像 + 鼠尾草绿气泡（`#E3F3EC` / `dark:#16271F`，`rounded-[6px_18px_18px_18px]`）；
 * - Agent 左对齐 36px 圆形粉彩头像 + 柔灰气泡（`#F5F5F7` / `dark:#1C1C1F`，`rounded-[6px_18px_18px_18px]`）；
 * - 系统与撤回事件为安静居中的 `12px text-[#8E8E93]` 文本行。
 *
 * @param props - 消息视图模型、连续分组标记与交互回调
 * @returns 单条消息时间线节点
 */
export function MessageBubble(props: MessageBubbleProps) {
  const { message } = props;
  const [copied, setCopied] = useState(false);
  const [capturedSelection, setCapturedSelection] = useState("");

  const isSelf = message.author.isYou;
  const isGrouped = props.isGroupedWithPrevious === true;
  const isRecalled = message.recalledAtIso !== undefined;
  const isPending = message._optimisticPending === true;
  const hasContent = message.content.length > 0;
  const isSticker = message.attachment?.stickerName !== undefined;
  const isStandaloneSticker =
    isSticker && !hasContent && message.replyToSeq === undefined && message.type === "text";
  const canSaveSticker = isSticker && props.onSaveSticker !== undefined;
  const canRecall = !props.readOnly && !isPending && canViewerRecallMessage(message, props.nowMs);
  const timeLabel = formatMessageTimestamp(message.createdAtIso);
  const anchorId = `msg-seq-${String(message.seq)}`;

  // ── 1. 系统事件：居中安静灰字文本行（无闪光图标、无胶囊框噪音） ──
  if (message.type === "system") {
    return (
      <div
        id={anchorId}
        data-seq={message.seq}
        className="flex select-none justify-center rounded-xl px-4 py-1.5 text-center transition-colors duration-700"
      >
        <p className="max-w-[85%] text-[12px] leading-relaxed text-[#939BAD] dark:text-[#63636B]">
          <span>{message.content}</span>
          <span aria-hidden="true" className="mx-1.5 opacity-60">
            ·
          </span>
          <time dateTime={message.createdAtIso} className="tabular-nums">
            {timeLabel}
          </time>
        </p>
      </div>
    );
  }

  // ── 2. 已撤回消息：居中安静灰字提示 ──
  if (isRecalled) {
    return (
      <div
        id={anchorId}
        data-seq={message.seq}
        className="flex select-none justify-center rounded-xl px-4 py-1.5 text-center transition-colors duration-700"
      >
        <p className="text-[12px] text-[#939BAD] dark:text-[#63636B]">
          {isSelf ? "你撤回了一条消息" : `${message.author.displayName} 撤回了一条消息`}
        </p>
      </div>
    );
  }

  const handleAgentInspect = (): void => {
    if (
      message.author.kind !== "agent" ||
      message.author.agentId === undefined ||
      !props.onInspectAgent
    ) {
      return;
    }
    const agentId: AgentId = message.author.agentId;
    props.onInspectAgent({
      agentId,
      displayName: message.author.displayName,
      platform: message.author.platform ?? "custom",
      ownerUserId: message.author.ownerUserId,
      ownerDisplayName:
        props.authorOwnerName ?? (message.author.isYourOwner ? "你本人" : "群内协作者"),
      reach: props.authorReach,
    });
  };

  const handleMentionClick = (): void => {
    if (!props.onQuickMention) {
      return;
    }
    if (message.author.kind === "agent" && message.author.agentId !== undefined) {
      props.onQuickMention({
        kind: "agent",
        agentId: message.author.agentId,
        displayName: message.author.displayName,
      });
    } else if (message.author.kind === "human" && message.author.userId !== undefined) {
      props.onQuickMention({
        kind: "human",
        userId: message.author.userId,
        displayName: message.author.displayName,
      });
    }
  };

  const handleCopyText = (text: string, toastMessage: string, markCopiedButton = false): void => {
    if (typeof navigator === "undefined" || !navigator.clipboard) {
      return;
    }
    void navigator.clipboard.writeText(text).then(() => {
      if (markCopiedButton) {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1_600);
      }
      toast.success(toastMessage);
    });
  };

  const handleCopy = (): void => {
    handleCopyText(message.content, "已复制消息内容", true);
  };

  const captureBubbleSelection = (): void => {
    const selectedText =
      typeof window !== "undefined" ? (window.getSelection()?.toString().trim() ?? "") : "";
    setCapturedSelection(selectedText);
  };

  const handleJump = (seq: MessageSeq): void => {
    if (props.onJumpToSeq) {
      props.onJumpToSeq(seq);
      return;
    }
    scrollToMessageSeq(seq);
  };

  const isAgentInspectable = message.author.kind === "agent" && props.onInspectAgent !== undefined;
  const agentPlatformLabel =
    message.author.kind === "agent" && message.author.platform !== undefined
      ? getPlatformVisualMeta(message.author.platform).label
      : undefined;

  const isContextMenuDisabled = Boolean(props.readOnly) || isPending;
  const contextMenuItems: ReadonlyArray<AppContextMenuEntry> = isContextMenuDisabled
    ? []
    : [
        ...(capturedSelection.length > 0
          ? [
              {
                id: "ctx-msg-copy-selection",
                label: "复制选中文字",
                icon: <Copy className="h-3.5 w-3.5" />,
                onSelect: () => handleCopyText(capturedSelection, "已复制选中文字"),
              } satisfies AppContextMenuEntry,
            ]
          : []),
        ...(props.onReply !== undefined
          ? [
              {
                id: "ctx-msg-reply",
                label: "回复此消息",
                icon: <Reply className="h-3.5 w-3.5" />,
                onSelect: () => props.onReply?.(message),
              } satisfies AppContextMenuEntry,
            ]
          : []),
        ...(hasContent
          ? [
              {
                id: "ctx-msg-copy-all",
                label: "复制消息内容",
                icon: <Copy className="h-3.5 w-3.5" />,
                onSelect: handleCopy,
              } satisfies AppContextMenuEntry,
            ]
          : []),
        ...(canSaveSticker
          ? [
              {
                id: "ctx-msg-save-sticker",
                label: "收藏表情",
                icon: <BookmarkPlus className="h-3.5 w-3.5" />,
                onSelect: () => props.onSaveSticker?.(message),
              } satisfies AppContextMenuEntry,
            ]
          : []),
        { kind: "separator", id: "ctx-msg-sep-actor" },
        ...(props.onQuickMention !== undefined && !isSelf
          ? [
              {
                id: "ctx-msg-mention",
                label: `@ ${message.author.displayName}`,
                icon: <AtSign className="h-3.5 w-3.5" />,
                onSelect: handleMentionClick,
              } satisfies AppContextMenuEntry,
            ]
          : []),
        ...(isAgentInspectable
          ? [
              {
                id: "ctx-msg-inspect",
                label: `查看 ${message.author.displayName} 名片`,
                icon: <UserRound className="h-3.5 w-3.5" />,
                onSelect: handleAgentInspect,
              } satisfies AppContextMenuEntry,
            ]
          : []),
        ...(props.linkedProposal !== undefined && props.onOpenProposal !== undefined
          ? [
              {
                id: "ctx-msg-proposal",
                label: "查看关联提案",
                icon: <FileText className="h-3.5 w-3.5" />,
                onSelect: () => {
                  if (props.linkedProposal !== undefined) {
                    props.onOpenProposal?.(props.linkedProposal.id);
                  }
                },
              } satisfies AppContextMenuEntry,
            ]
          : []),
        { kind: "separator", id: "ctx-msg-sep-recall" },
        ...(canRecall && props.onRecall !== undefined
          ? [
              {
                id: "ctx-msg-recall",
                label: "撤回消息",
                icon: <RotateCcw className="h-3.5 w-3.5" />,
                danger: true,
                disabled: Boolean(props.isRecalling),
                onSelect: () => props.onRecall?.(message.seq),
              } satisfies AppContextMenuEntry,
            ]
          : []),
      ];

  // ── 悬浮 Liquid Glass 快捷操作条（↩ 回复 · @ · 复制 · 撤回） ──
  const actionBar =
    !props.readOnly && !isPending ? (
      <div
        className={cn(
          "liquid-glass-pill pointer-events-none absolute -top-4 z-10 flex translate-y-0.5 select-none items-center gap-0.5 rounded-full px-1.5 py-0.5 opacity-0 transition-all duration-150",
          "group-focus-within/msg:pointer-events-auto group-focus-within/msg:translate-y-0 group-focus-within/msg:opacity-100",
          "group-hover/msg:pointer-events-auto group-hover/msg:translate-y-0 group-hover/msg:opacity-100",
          isSelf ? "right-1.5" : "left-1.5",
        )}
      >
        {props.onReply ? (
          <button
            type="button"
            onClick={() => props.onReply?.(message)}
            className="app-no-drag inline-flex cursor-pointer items-center gap-1 rounded-full px-2 py-1 text-[11.5px] font-medium text-[#687082] transition-colors hover:bg-black/[0.05] hover:text-[#111318] dark:text-[#C4C4CA] dark:hover:bg-white/[0.10] dark:hover:text-[#F2F2F4]"
          >
            <Reply className="h-3 w-3" />
            <span>回复</span>
          </button>
        ) : null}

        {props.onQuickMention && !isSelf ? (
          <AppTooltip content={`@${message.author.displayName}`} side="top">
            <button
              type="button"
              aria-label={`@${message.author.displayName}`}
              onClick={handleMentionClick}
              className="app-no-drag inline-flex cursor-pointer items-center justify-center rounded-full px-1.5 py-1 text-[11.5px] font-medium text-[#687082] transition-colors hover:bg-black/[0.05] hover:text-[#111318] dark:text-[#C4C4CA] dark:hover:bg-white/[0.10] dark:hover:text-[#F2F2F4]"
            >
              <AtSign className="h-3 w-3" />
            </button>
          </AppTooltip>
        ) : null}

        {hasContent ? (
          <button
            type="button"
            onClick={handleCopy}
            className="app-no-drag inline-flex cursor-pointer items-center gap-1 rounded-full px-2 py-1 text-[11.5px] font-medium text-[#687082] transition-colors hover:bg-black/[0.05] hover:text-[#111318] dark:text-[#C4C4CA] dark:hover:bg-white/[0.10] dark:hover:text-[#F2F2F4]"
          >
            {copied ? (
              <Check className="h-3 w-3 text-[#16A34A] dark:text-[#34D399]" />
            ) : (
              <Copy className="h-3 w-3" />
            )}
            <span>{copied ? "已复制" : "复制"}</span>
          </button>
        ) : null}

        {canSaveSticker ? (
          <AppTooltip content="收藏表情" side="top">
            <button
              type="button"
              aria-label="收藏表情"
              onClick={() => props.onSaveSticker?.(message)}
              className="app-no-drag inline-flex cursor-pointer items-center justify-center rounded-full px-1.5 py-1 text-[#687082] transition-colors hover:bg-black/[0.05] hover:text-[#111318] dark:text-[#C4C4CA] dark:hover:bg-white/[0.10] dark:hover:text-[#F2F2F4]"
            >
              <BookmarkPlus className="h-3.5 w-3.5" />
            </button>
          </AppTooltip>
        ) : null}

        {canRecall && props.onRecall ? (
          <AppTooltip content="撤回（发送后 2 分钟内）" side="top">
            <button
              type="button"
              disabled={Boolean(props.isRecalling)}
              onClick={() => props.onRecall?.(message.seq)}
              className="app-no-drag inline-flex cursor-pointer items-center gap-1 rounded-full px-2 py-1 text-[11.5px] font-medium text-[#C6282E] transition-colors hover:bg-[#E5484D]/10 disabled:opacity-50 dark:text-[#F88B8B] dark:hover:bg-[#F05252]/15"
            >
              {props.isRecalling ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <RotateCcw className="h-3 w-3" />
              )}
              <span>撤回</span>
            </button>
          </AppTooltip>
        ) : null}
      </div>
    ) : null;

  // ── 极简 2px 竖线内联引用（无嵌套背景盒，点击定位源消息） ──
  const replyQuote =
    message.replyToSeq !== undefined
      ? (() => {
          const replySeq = message.replyToSeq;
          const replied = props.repliedMessage;
          const snippet = replied === undefined ? "引用前序发言" : getMessageSnippet(replied, 88);
          return (
            <button
              type="button"
              onClick={() => handleJump(replySeq)}
              className="app-no-drag mb-1.5 block w-full min-w-0 cursor-pointer select-none border-l-2 border-black/15 py-0.5 pl-2.5 text-left text-[13px] leading-snug text-[#687082] transition-opacity hover:opacity-75 dark:border-white/20 dark:text-[#8E8E96]"
            >
              <span className="line-clamp-2 min-w-0">
                {replied !== undefined ? (
                  <span className="mr-1 font-medium text-[#111318]/85 dark:text-[#F2F2F4]/90">
                    {replied.author.displayName}：
                  </span>
                ) : null}
                <span>{snippet}</span>
              </span>
            </button>
          );
        })()
      : null;

  // ── 内嵌共识提案卡入口（清晰层级纸面描边，联动右侧提案面板） ──
  const linkedCard =
    props.linkedProposal !== undefined
      ? (() => {
          const linked = props.linkedProposal;
          const isApproved = linked.status === "approved";
          return (
            <div
              className={cn(
                "mt-2.5 select-none overflow-hidden rounded-2xl ring-1 ring-inset",
                isApproved
                  ? "bg-[#E6F5EC]/85 ring-emerald-900/[0.08] dark:bg-[#1B2B23] dark:ring-emerald-400/[0.15]"
                  : "bg-black/[0.03] ring-black/[0.06] dark:bg-[#18181B]/90 dark:ring-white/[0.08]",
              )}
            >
              <div className="flex items-start gap-2.5 px-3 py-2.5">
                <span
                  className={cn(
                    "mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full",
                    isApproved
                      ? "bg-[#16A34A] text-white dark:bg-[#34D399] dark:text-[#111318]"
                      : "bg-[#181B22] text-white dark:bg-[#EAEEF6] dark:text-[#111318]",
                  )}
                >
                  {isApproved ? (
                    <Award className="h-3.5 w-3.5" />
                  ) : (
                    <FileText className="h-3.5 w-3.5" />
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13.5px] font-semibold text-[#111318] dark:text-[#F2F2F4]">
                    {linked.draft.title}
                  </p>
                  <p className="mt-0.5 text-[12px] tabular-nums text-[#687082] dark:text-[#8E8E96]">
                    {linked.draft.options.length} 个方案 · {linked.votes.length} 人表态
                    {linked.decidedOptionKey ? ` · 已拍板 ${linked.decidedOptionKey}` : ""}
                  </p>
                </div>
              </div>
              {props.onOpenProposal ? (
                <button
                  type="button"
                  onClick={() => props.onOpenProposal?.(linked.id)}
                  className="app-no-drag flex w-full cursor-pointer items-center justify-between border-t border-black/[0.06] px-3 py-2 text-[12px] font-medium text-[#111318] transition-colors hover:bg-black/[0.03] active:scale-[0.99] dark:border-white/[0.07] dark:text-[#F2F2F4] dark:hover:bg-white/[0.05]"
                >
                  <span>{isApproved ? "查看拍板结论" : "查看提案并拍板"}</span>
                  <ChevronRight className="h-3.5 w-3.5 opacity-70" />
                </button>
              ) : null}
            </div>
          );
        })()
      : null;

  const semanticBadge =
    message.type === "text" ? null : (
      <div className="mb-1.5">
        <MessageSemanticBadge type={message.type} tone="default" />
      </div>
    );

  // ADR-0002 Attention 面板：结构化等人问题 + 一键作答（仅 attention 消息渲染；过期仅展示）
  const attention =
    "attention" in message && message.attention !== undefined ? message.attention : undefined;
  const attentionExpired =
    attention !== undefined && props.nowMs >= Date.parse(attention.expiresAtIso);
  const attentionPanel =
    attention !== undefined ? (
      <div className="mt-1.5 w-full min-w-0 select-none rounded-[14px] border border-black/[0.06] bg-white/85 p-2.5 dark:border-white/[0.08] dark:bg-[#18181B]/90">
        <div className="flex items-center gap-1.5 text-[11px] font-medium text-[#687082] dark:text-[#8E8E96]">
          <span aria-hidden="true">🙋</span>
          <span>等待人类作答</span>
          {attentionExpired ? (
            <span className="rounded-full bg-black/[0.06] px-1.5 py-0.5 text-[10px] dark:bg-white/10">
              已过期
            </span>
          ) : null}
        </div>
        {!attentionExpired &&
        props.onAnswerAttention !== undefined &&
        attention.options.length > 0 ? (
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {attention.options.map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => props.onAnswerAttention?.(message.seq, option)}
                className="app-no-drag cursor-pointer rounded-full bg-[#181B22] px-3 py-1 text-[11.5px] font-medium text-white transition hover:bg-[#252A35] active:scale-[0.97] dark:bg-[#EAEEF6] dark:text-[#111318] dark:hover:bg-white"
              >
                {option}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    ) : null;

  const bubbleBody = (
    <>
      {semanticBadge}
      {replyQuote}
      {hasContent ? <MarkdownContent content={message.content} tone="default" /> : null}
      {message.attachment !== undefined ? (
        <MessageAttachment
          message={{ roomId: message.roomId, seq: message.seq, attachment: message.attachment }}
          isPending={isPending}
          readOnly={props.readOnly === true}
        />
      ) : null}
      {linkedCard}
    </>
  );

  const timeNode = isPending ? (
    <span className="inline-flex select-none items-center gap-1 text-[12px] text-[#939BAD] dark:text-[#63636B]">
      <Loader2 className="h-3 w-3 animate-spin" />
      <span>发送中</span>
    </span>
  ) : (
    <AppTooltip content={`消息 #${String(message.seq)} · ${timeLabel}`} side="top">
      <time
        dateTime={message.createdAtIso}
        className="select-none text-[12px] tabular-nums text-[#939BAD] dark:text-[#63636B]"
      >
        {timeLabel}
      </time>
    </AppTooltip>
  );

  // ── 3. 本人发出消息（isSelf）：右对齐暖亚麻瓷 `#F4EFE6` / 暗夜中性石墨 `#2E2E34` ──
  if (isSelf) {
    return (
      <article
        id={anchorId}
        data-seq={message.seq}
        className={cn(
          "group/msg flex justify-end rounded-xl pl-10 pr-1 transition-colors duration-700 sm:pl-16",
          isGrouped ? "mt-1" : "mt-3.5",
          isPending && "opacity-75",
        )}
      >
        <motion.div
          initial={{ opacity: 0, y: 5, scale: 0.99 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={BUBBLE_SPRING}
          className="ml-auto flex min-w-0 max-w-[78%] flex-col items-end"
        >
          {!isGrouped ? (
            <div className="mb-1 flex select-none items-center gap-2 pr-0.5 leading-none">
              {timeNode}
            </div>
          ) : null}

          <div className="relative min-w-0 max-w-full">
            {actionBar}
            <AppContextMenu
              items={contextMenuItems}
              disabled={isContextMenuDisabled}
              onOpenChange={(open) => {
                if (!open) {
                  setCapturedSelection("");
                }
              }}
            >
              <div
                onContextMenuCapture={captureBubbleSelection}
                className={cn(
                  "min-w-0 transition-shadow",
                  isStandaloneSticker
                    ? "rounded-lg p-1"
                    : cn(
                        "px-4 py-2.5",
                        isGrouped ? "rounded-[18px]" : "rounded-[18px_6px_18px_18px]",
                        "bg-[#F4EFE6] text-[#111318] ring-1 ring-inset ring-black/[0.06] shadow-[0_1px_2px_rgba(15,23,42,0.04)]",
                        "dark:bg-[#2E2E34] dark:text-[#F5F5F7] dark:ring-1 dark:ring-inset dark:ring-white/[0.11] dark:shadow-[0_2px_8px_rgba(0,0,0,0.24),inset_0_1px_0_rgba(255,255,255,0.08)]",
                      ),
                  "data-[state=open]:ring-2 data-[state=open]:ring-[#181B22]/25 dark:data-[state=open]:ring-white/30",
                  message.type === "decision" &&
                    "ring-1 ring-[#16A34A]/35 dark:ring-emerald-400/30",
                )}
              >
                {bubbleBody}
              </div>
            </AppContextMenu>
            {attentionPanel}
          </div>

          {isGrouped && isPending ? <div className="mt-0.5 pr-1">{timeNode}</div> : null}
        </motion.div>
      </article>
    );
  }

  // ── 4. 对端消息：36px 圆形头像 + 发送者头部 + 鼠尾草绿（人类）或清冷瓷白/中性石墨（Agent）气泡 ──
  const isHumanPeer = message.author.kind === "human";
  const peerBubbleSurfaceClass = isHumanPeer
    ? "bg-[#E6F5EC] text-[#111318] ring-1 ring-inset ring-emerald-900/[0.08] shadow-[0_1px_2px_rgba(15,23,42,0.03)] dark:bg-[#1B2B23] dark:text-[#E6F4EC] dark:ring-1 dark:ring-inset dark:ring-emerald-400/[0.14] dark:shadow-[0_2px_8px_rgba(0,0,0,0.22)]"
    : "bg-white/95 text-[#111318] ring-1 ring-inset ring-black/[0.06] shadow-[0_1px_3px_rgba(15,23,42,0.04)] dark:bg-[#222226] dark:text-[#ECECEF] dark:ring-1 dark:ring-inset dark:ring-white/[0.07] dark:shadow-[0_2px_8px_rgba(0,0,0,0.22)]";

  const avatar = (
    <PlatformAvatar
      kind={message.author.kind}
      displayName={message.author.displayName}
      platform={message.author.platform}
      reach={props.authorReach}
      size="md"
    />
  );

  return (
    <article
      id={anchorId}
      data-seq={message.seq}
      className={cn(
        "group/msg flex items-start gap-2.5 rounded-xl pl-1 pr-10 transition-colors duration-700 sm:pr-16",
        isGrouped ? "mt-1" : "mt-3.5",
        isPending && "opacity-75",
      )}
    >
      {/* 左侧 36px 圆形头像对齐列：连续分组时隐藏头像，悬停轻显紧凑时刻 */}
      <div className="flex w-9 shrink-0 justify-center">
        {isGrouped ? (
          <time
            dateTime={message.createdAtIso}
            className="mt-2.5 select-none text-[11px] tabular-nums text-[#939BAD] opacity-0 transition-opacity duration-150 group-hover/msg:opacity-100 dark:text-[#63636B]"
          >
            {timeLabel}
          </time>
        ) : isAgentInspectable ? (
          <AppTooltip content={`查看 ${message.author.displayName} 资料`} side="top">
            <button
              type="button"
              onClick={handleAgentInspect}
              className="app-no-drag mt-0.5 cursor-pointer rounded-full outline-none transition-transform duration-150 hover:opacity-90 active:scale-[0.96] focus-visible:ring-2 focus-visible:ring-black/20 dark:focus-visible:ring-white/25"
            >
              {avatar}
            </button>
          </AppTooltip>
        ) : (
          <div className="mt-0.5">{avatar}</div>
        )}
      </div>

      <motion.div
        initial={{ opacity: 0, y: 5, scale: 0.99 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={BUBBLE_SPRING}
        className="flex min-w-0 max-w-[78%] flex-col items-start"
      >
        {/* 发送者头部：13px font-medium 名字 + 12px 灰字时间 + 安静归属说明 */}
        {!isGrouped ? (
          <div className="mb-1 flex max-w-full select-none items-baseline gap-2 overflow-hidden pl-0.5 leading-none">
            {isAgentInspectable ? (
              <button
                type="button"
                onClick={handleAgentInspect}
                className="app-no-drag cursor-pointer truncate text-[13px] font-medium text-[#111318] outline-none transition-opacity hover:opacity-75 focus-visible:underline dark:text-[#F2F2F4]"
              >
                {message.author.displayName}
              </button>
            ) : (
              <span className="truncate text-[13px] font-medium text-[#111318] dark:text-[#F2F2F4]">
                {message.author.displayName}
              </span>
            )}

            <span className="shrink-0">{timeNode}</span>

            <AuthorMicroTag
              kind={message.author.kind}
              trustLevel={message.author.trustLevel}
              ownerName={props.authorOwnerName}
              isYourOwner={message.author.isYourOwner}
              platformLabel={agentPlatformLabel}
            />
          </div>
        ) : null}

        <div className="relative min-w-0 max-w-full">
          {actionBar}
          <AppContextMenu
            items={contextMenuItems}
            disabled={isContextMenuDisabled}
            onOpenChange={(open) => {
              if (!open) {
                setCapturedSelection("");
              }
            }}
          >
            <div
              onContextMenuCapture={captureBubbleSelection}
              className={cn(
                "min-w-0 transition-shadow",
                isStandaloneSticker
                  ? "rounded-lg p-1"
                  : cn(
                      "px-4 py-2.5",
                      isGrouped ? "rounded-[18px]" : "rounded-[6px_18px_18px_18px]",
                      peerBubbleSurfaceClass,
                    ),
                "data-[state=open]:ring-2 data-[state=open]:ring-[#181B22]/25 dark:data-[state=open]:ring-white/30",
                message.type === "decision" && "ring-1 ring-[#16A34A]/35 dark:ring-emerald-400/30",
              )}
            >
              {bubbleBody}
            </div>
          </AppContextMenu>
          {attentionPanel}
        </div>
      </motion.div>
    </article>
  );
}
