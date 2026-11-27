/**
 * @module web/components/ui/message-bubble
 * @description 纯 Props 驱动的清晰高对比度聊天气泡组件（白天按本人暖亚麻、同伴鼠尾草绿、Agent 柔灰区分，夜间使用对应深色语义令牌），同时服务实时聊天室与公开只读分享页。
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
  SupportedLocale,
} from "@openhuddle/protocol";
import {
  AtSign,
  Award,
  BookmarkPlus,
  Check,
  ChevronRight,
  Copy,
  Download,
  FileText,
  Hand,
  Image as ImageIcon,
  ListTodo,
  Loader2,
  Maximize2,
  MoreHorizontal,
  Reply,
  RotateCcw,
  UserRound,
} from "lucide-react";
import { type KeyboardEvent, type MouseEvent, useRef, useState } from "react";
import { roomMessageAttachmentPath } from "../../lib/api-client.js";
import {
  canViewerRecallMessage,
  formatMessageTimestamp,
  getMessageSnippet,
  getPlatformVisualMeta,
} from "../../lib/format.js";
import { canCopyImageToClipboard, copyImageUrlToClipboard } from "../../lib/message-media.js";
import type { OptimisticMessageItem } from "../../lib/query-keys.js";
import { getComponentsTranslator, useComponentsI18n } from "../i18n/index.js";
import {
  AppContextMenu,
  type AppContextMenuEntry,
  AppTooltip,
  INSTANT_TRANSITION,
  NATIVE_LIVE_BUBBLE_SPRING,
  cn,
  motion,
  toast,
  usePrefersReducedMotion,
} from "../primitives/index.js";
import type { InspectedAgentProfile } from "./agent-profile-dialog.js";
import { AuthorMicroTag, MessageSemanticBadge, PlatformAvatar } from "./identity-badges.js";
import { MarkdownContent } from "./markdown-content.js";
import { MessageAttachment } from "./message-attachment.js";

/** `MessageBubble` 入参属性 */
export interface MessageBubbleProps {
  readonly message: OptimisticMessageItem;
  readonly repliedMessage?: MessageDto | undefined;
  /** 仅用于显示群备注，提及仍绑定原消息发送者。 */
  readonly authorDisplayName?: string | undefined;
  readonly repliedAuthorDisplayName?: string | undefined;
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
  /** 将当前消息内容一键填入底部 `[⚡派活]` 编排舱转为执行工单 */
  readonly onConvertToWorkTask?: ((content: string) => void) | undefined;
  readonly onInspectAgent?: ((profile: InspectedAgentProfile) => void) | undefined;
  /** 点击引用块时的跳转回调；缺省时组件自行滚动到 `#msg-seq-{seq}` 并短暂高亮 */
  readonly onJumpToSeq?: ((seq: MessageSeq) => void) | undefined;
  /**
   * 是否启用实时新消息入场弹簧动效（默认 `false`）。
   * 关键性能不变量：历史消息切换会话时保持 `false` 静态直出（零 JS 弹簧实例），仅对新发送或 SSE 实时到达的新消息开启。
   */
  readonly animateEntrance?: boolean | undefined;
}

/** 引用跳转命中后的瞬时高亮工具类（保持完整字面量以便 Tailwind CSS 扫描包含） */
const JUMP_HIGHLIGHT_CLASS = "bg-im-accent-soft";
const JUMP_FLASH_CLASS = "oh-jump-flash";

/** 构建单条消息右键菜单所需的上下文与回调参数 */
export interface BuildMessageContextMenuOptions {
  readonly message: OptimisticMessageItem;
  readonly locale?: SupportedLocale | undefined;
  readonly readOnly?: boolean | undefined;
  readonly isPending: boolean;
  readonly isSelf: boolean;
  readonly canRecall: boolean;
  readonly isRecalling?: boolean | undefined;
  readonly canSaveSticker: boolean;
  readonly canCopyImage: boolean;
  readonly isAgentInspectable: boolean;
  readonly hasLinkedProposal: boolean;
  readonly capturedSelection: string;
  readonly onCopySelection?: ((text: string) => void) | undefined;
  readonly onReply?: ((message: MessageDto) => void) | undefined;
  readonly onOpenLightbox?: (() => void) | undefined;
  readonly onCopyImage?: (() => void) | undefined;
  readonly onDownloadImage?: (() => void) | undefined;
  readonly onCopyMessageContent?: (() => void) | undefined;
  readonly onSaveSticker?: ((message: MessageDto) => void) | undefined;
  readonly onConvertToWorkTask?: ((content: string) => void) | undefined;
  readonly onQuickMention?: (() => void) | undefined;
  readonly onInspectAgent?: (() => void) | undefined;
  readonly onOpenProposal?: (() => void) | undefined;
  readonly onRecall?: ((seq: MessageSeq) => void) | undefined;
}

/**
 * 纯函数生成消息气泡 `AppContextMenu` 条目列表（图片消息按序展示看大图、复制图片、下载图片、复制消息文字与转任务）。
 */
export function buildMessageContextMenuItems(
  opts: BuildMessageContextMenuOptions,
): ReadonlyArray<AppContextMenuEntry> {
  if (Boolean(opts.readOnly) || opts.isPending) {
    return [];
  }
  const { t } = getComponentsTranslator(opts.locale);
  const { message } = opts;
  const hasContent = message.content.length > 0;
  const hasNonStickerImage =
    message.attachment?.mimeType.startsWith("image/") === true &&
    message.attachment.stickerName === undefined;
  const taskSeedText = hasContent
    ? message.content
    : t("messageBubble.ctx.imageTaskSeed", { seq: message.seq });

  return [
    ...(opts.capturedSelection.length > 0 && opts.onCopySelection !== undefined
      ? [
          {
            id: "ctx-msg-copy-selection",
            label: t("messageBubble.ctx.copySelection"),
            icon: <Copy className="h-3.5 w-3.5" />,
            onSelect: () => opts.onCopySelection?.(opts.capturedSelection),
          } satisfies AppContextMenuEntry,
        ]
      : []),
    ...(opts.onReply !== undefined
      ? [
          {
            id: "ctx-msg-reply",
            label: t("messageBubble.ctx.reply"),
            icon: <Reply className="h-3.5 w-3.5" />,
            onSelect: () => opts.onReply?.(message),
          } satisfies AppContextMenuEntry,
        ]
      : []),
    ...(hasNonStickerImage && opts.onOpenLightbox !== undefined
      ? [
          {
            id: "ctx-msg-view-image",
            label: t("messageBubble.ctx.viewImage"),
            icon: <Maximize2 className="h-3.5 w-3.5" />,
            onSelect: () => opts.onOpenLightbox?.(),
          } satisfies AppContextMenuEntry,
        ]
      : []),
    ...(hasNonStickerImage && opts.canCopyImage && opts.onCopyImage !== undefined
      ? [
          {
            id: "ctx-msg-copy-image",
            label: t("messageBubble.ctx.copyImage"),
            icon: <ImageIcon className="h-3.5 w-3.5" />,
            onSelect: () => opts.onCopyImage?.(),
          } satisfies AppContextMenuEntry,
        ]
      : []),
    ...(hasNonStickerImage && opts.onDownloadImage !== undefined
      ? [
          {
            id: "ctx-msg-download-image",
            label: t("messageBubble.ctx.downloadImage"),
            icon: <Download className="h-3.5 w-3.5" />,
            onSelect: () => opts.onDownloadImage?.(),
          } satisfies AppContextMenuEntry,
        ]
      : []),
    ...(hasContent && opts.onCopyMessageContent !== undefined
      ? [
          {
            id: "ctx-msg-copy-all",
            label: hasNonStickerImage
              ? t("messageBubble.ctx.copyMessageText")
              : t("messageBubble.ctx.copyMessageContent"),
            icon: <Copy className="h-3.5 w-3.5" />,
            onSelect: () => opts.onCopyMessageContent?.(),
          } satisfies AppContextMenuEntry,
        ]
      : []),
    ...(opts.canSaveSticker && opts.onSaveSticker !== undefined
      ? [
          {
            id: "ctx-msg-save-sticker",
            label: t("messageBubble.ctx.saveSticker"),
            icon: <BookmarkPlus className="h-3.5 w-3.5" />,
            onSelect: () => opts.onSaveSticker?.(message),
          } satisfies AppContextMenuEntry,
        ]
      : []),
    ...((hasContent || hasNonStickerImage) && opts.onConvertToWorkTask !== undefined
      ? [
          {
            id: "ctx-msg-to-task",
            label: t("messageBubble.ctx.convertToTask"),
            icon: <ListTodo className="h-3.5 w-3.5" />,
            onSelect: () => opts.onConvertToWorkTask?.(taskSeedText),
          } satisfies AppContextMenuEntry,
        ]
      : []),
    { kind: "separator", id: "ctx-msg-sep-actor" },
    ...(opts.onQuickMention !== undefined && !opts.isSelf
      ? [
          {
            id: "ctx-msg-mention",
            label: `@ ${message.author.displayName}`,
            icon: <AtSign className="h-3.5 w-3.5" />,
            onSelect: () => opts.onQuickMention?.(),
          } satisfies AppContextMenuEntry,
        ]
      : []),
    ...(opts.isAgentInspectable && opts.onInspectAgent !== undefined
      ? [
          {
            id: "ctx-msg-inspect",
            label: t("messageBubble.ctx.inspectAgent", { name: message.author.displayName }),
            icon: <UserRound className="h-3.5 w-3.5" />,
            onSelect: () => opts.onInspectAgent?.(),
          } satisfies AppContextMenuEntry,
        ]
      : []),
    ...(opts.hasLinkedProposal && opts.onOpenProposal !== undefined
      ? [
          {
            id: "ctx-msg-proposal",
            label: t("messageBubble.ctx.openProposal"),
            icon: <FileText className="h-3.5 w-3.5" />,
            onSelect: () => opts.onOpenProposal?.(),
          } satisfies AppContextMenuEntry,
        ]
      : []),
    { kind: "separator", id: "ctx-msg-sep-recall" },
    ...(opts.canRecall && opts.onRecall !== undefined
      ? [
          {
            id: "ctx-msg-recall",
            label: t("messageBubble.ctx.recall"),
            icon: <RotateCcw className="h-3.5 w-3.5" />,
            danger: true,
            disabled: Boolean(opts.isRecalling),
            onSelect: () => opts.onRecall?.(message.seq),
          } satisfies AppContextMenuEntry,
        ]
      : []),
  ];
}

function triggerAttachmentDownload(src: string, fileName: string): void {
  if (typeof document === "undefined") {
    return;
  }
  const anchor = document.createElement("a");
  anchor.href = src;
  anchor.download = fileName;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
}

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
  target.classList.remove(JUMP_FLASH_CLASS);
  // 强制读取一次 offsetWidth 以支持连续点击同一引用时重播闪烁关键帧
  void target.offsetWidth;
  target.classList.add(JUMP_HIGHLIGHT_CLASS, JUMP_FLASH_CLASS);
  window.setTimeout(() => {
    target.classList.remove(JUMP_HIGHLIGHT_CLASS, JUMP_FLASH_CLASS);
  }, 1_400);
}

/**
 * 渲染单条群聊消息气泡：
 * - 本人右对齐暖象牙纸气泡（`#F6F2EC` / `dark:#272521`，`rounded-[18px_6px_18px_18px]`）；
 * - 其他人类左对齐 36px 圆形头像 + 鼠尾草绿气泡（`#E3F3EC` / `dark:#16271F`，`rounded-[6px_18px_18px_18px]`）；
 * - Agent 左对齐 36px 圆形粉彩头像 + 柔灰气泡（`#F5F5F7` / `dark:#1C1C1F`，`rounded-[6px_18px_18px_18px]`）；
 * - 系统与撤回事件为安静居中的 `12px text-[#8E8E93]` 文本行。
 *
 * @param props - 消息视图模型、连续分组标记与交互回调
 * @returns 单条消息时间线节点
 */
export function MessageBubble(props: MessageBubbleProps) {
  const { locale, t, tp } = useComponentsI18n();
  const { message } = props;
  const authorDisplayName = props.authorDisplayName ?? message.author.displayName;
  const [copied, setCopied] = useState(false);
  const [capturedSelection, setCapturedSelection] = useState("");
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [failedReplyThumbKey, setFailedReplyThumbKey] = useState<string | null>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const reducedMotion = usePrefersReducedMotion();

  const isSelf = message.author.isYou;
  const isGrouped = props.isGroupedWithPrevious === true;
  const isRecalled = message.recalledAtIso !== undefined;
  const isPending = message._optimisticPending === true;
  const shouldAnimateEntrance = props.animateEntrance === true && !reducedMotion;
  const hasContent = message.content.length > 0;
  const isSticker = message.attachment?.stickerName !== undefined;
  const hasNonStickerImage =
    message.attachment?.mimeType.startsWith("image/") === true && !isSticker;
  const isStandaloneSticker =
    !props.readOnly &&
    isSticker &&
    !hasContent &&
    message.replyToSeq === undefined &&
    props.linkedProposal === undefined &&
    message.type === "text";
  const isStandaloneImage =
    !props.readOnly &&
    hasNonStickerImage &&
    !hasContent &&
    message.replyToSeq === undefined &&
    props.linkedProposal === undefined &&
    message.type === "text";
  const isReadOnlyStandaloneMedia =
    Boolean(props.readOnly) &&
    message.attachment !== undefined &&
    !hasContent &&
    message.replyToSeq === undefined &&
    props.linkedProposal === undefined &&
    message.type === "text";
  const isStandaloneMedia =
    isStandaloneSticker ||
    isStandaloneImage ||
    (!hasContent &&
      message.replyToSeq === undefined &&
      props.linkedProposal === undefined &&
      message.type === "text");
  const canSaveSticker = isSticker && props.onSaveSticker !== undefined;
  const canRecall = !props.readOnly && !isPending && canViewerRecallMessage(message, props.nowMs);
  const timeLabel = formatMessageTimestamp(message.createdAtIso, locale);
  const anchorId = `msg-seq-${String(message.seq)}`;

  // ── 1. 系统事件：居中安静灰字文本行（无闪光图标、无胶囊框噪音） ──
  if (message.type === "system") {
    return (
      <div
        id={anchorId}
        data-seq={message.seq}
        className="flex select-none justify-center rounded-xl px-4 py-1.5 text-center transition-colors duration-700"
      >
        <p className="max-w-[85%] text-[12px] leading-relaxed text-im-subtle">
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
        <p className="text-[12px] text-im-subtle">
          {isSelf
            ? t("messageBubble.recalledSelf")
            : t("messageBubble.recalledOther", { name: authorDisplayName })}
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
        props.authorOwnerName ??
        (message.author.isYourOwner
          ? t("messageBubble.ownerFallbackSelf")
          : t("messageBubble.ownerFallbackOther")),
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
    handleCopyText(
      message.content,
      hasNonStickerImage
        ? t("messageBubble.toastCopiedText")
        : t("messageBubble.toastCopiedContent"),
      true,
    );
  };

  const imageAttachmentSrc = hasNonStickerImage
    ? roomMessageAttachmentPath(message.roomId, message.seq)
    : null;
  const imageDownloadName =
    message.attachment?.fileName ?? `openhuddle-image-${String(message.seq)}`;

  const handleCopyImage = (): void => {
    if (imageAttachmentSrc === null) {
      return;
    }
    void copyImageUrlToClipboard(imageAttachmentSrc, locale)
      .then(() => {
        toast.success(t("messageBubble.toastCopiedImage"));
      })
      .catch(() => {
        toast.error(t("messageBubble.toastCopyImageFailed"));
      });
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

  // 原生桌面 IM 快捷回复交互：支持按住 Alt 单击任意气泡快速引用，或双击行空白/头像侧区域触发引用回复（不干扰双击选中文本或代码）
  const handleRowDoubleClick = (event: MouseEvent<HTMLElement>): void => {
    if (props.readOnly || isPending || !props.onReply) {
      return;
    }
    const target = event.target as HTMLElement | null;
    if (target?.closest("button, a, pre, code, input, textarea")) {
      return;
    }
    const selectedText =
      typeof window !== "undefined" ? (window.getSelection()?.toString().trim() ?? "") : "";
    if (selectedText.length > 0) {
      return;
    }
    props.onReply(message);
  };

  const handleBubbleClick = (event: MouseEvent<HTMLDivElement>): void => {
    if (!event.altKey || props.readOnly || isPending || !props.onReply) {
      return;
    }
    event.preventDefault();
    props.onReply(message);
  };

  const handleBubbleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!event.altKey || event.key !== "Enter" || props.readOnly || isPending || !props.onReply) {
      return;
    }
    event.preventDefault();
    props.onReply(message);
  };

  const isAgentInspectable = message.author.kind === "agent" && props.onInspectAgent !== undefined;
  const agentPlatformLabel =
    message.author.kind === "agent" && message.author.platform !== undefined
      ? getPlatformVisualMeta(message.author.platform, locale).label
      : undefined;

  const isContextMenuDisabled = Boolean(props.readOnly) || isPending;
  const contextMenuItems = buildMessageContextMenuItems({
    message,
    locale,
    readOnly: props.readOnly,
    isPending,
    isSelf,
    canRecall,
    isRecalling: props.isRecalling,
    canSaveSticker,
    canCopyImage: canCopyImageToClipboard(),
    isAgentInspectable,
    hasLinkedProposal: props.linkedProposal !== undefined && props.onOpenProposal !== undefined,
    capturedSelection,
    onCopySelection: (text) => handleCopyText(text, t("messageBubble.toastCopiedSelection")),
    onReply: props.onReply,
    onOpenLightbox: hasNonStickerImage ? () => setLightboxOpen(true) : undefined,
    onCopyImage: hasNonStickerImage ? handleCopyImage : undefined,
    onDownloadImage:
      hasNonStickerImage && imageAttachmentSrc !== null
        ? () => triggerAttachmentDownload(imageAttachmentSrc, imageDownloadName)
        : undefined,
    onCopyMessageContent: hasContent ? handleCopy : undefined,
    onSaveSticker: props.onSaveSticker,
    onConvertToWorkTask: props.onConvertToWorkTask,
    onQuickMention: props.onQuickMention ? handleMentionClick : undefined,
    onInspectAgent: isAgentInspectable ? handleAgentInspect : undefined,
    onOpenProposal:
      props.linkedProposal !== undefined && props.onOpenProposal !== undefined
        ? () => {
            if (props.linkedProposal !== undefined) {
              props.onOpenProposal?.(props.linkedProposal.id);
            }
          }
        : undefined,
    onRecall: props.onRecall,
  });

  const hasMessageActions = contextMenuItems.some(
    (entry) => entry.kind !== "separator" && entry.kind !== "label",
  );
  const mobileQuickTrigger = hasMessageActions ? (
    <button
      type="button"
      aria-label={t("messageBubble.mobileActionsAria")}
      aria-haspopup="menu"
      onClick={(event) => {
        event.stopPropagation();
        const { left, bottom, width } = event.currentTarget.getBoundingClientRect();
        // Radix 用同一个 contextmenu 入口定位长按、右键和按钮打开的菜单。
        bubbleRef.current?.dispatchEvent(
          new window.MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            clientX: left + width / 2,
            clientY: bottom,
          }),
        );
      }}
      className="app-no-drag inline-flex [@media(hover:hover)]:hidden size-11 shrink-0 items-center justify-center self-end rounded-full text-im-subtle/80 transition-colors active:bg-im-hover active:text-im-fg"
    >
      <MoreHorizontal className="h-3.5 w-3.5" />
    </button>
  ) : null;

  const actionBar =
    !props.readOnly && !isPending ? (
      <div
        className={cn(
          "liquid-glass-pill [@media(hover:none)]:hidden pointer-events-none absolute -top-4 z-10 flex translate-y-1 scale-[0.97] select-none items-center gap-0.5 rounded-full px-1.5 py-0.5 opacity-0 transition-[opacity,transform] duration-[140ms] ease-[cubic-bezier(0.16,1,0.3,1)] will-change-[transform,opacity]",
          "group-focus-within/msg:pointer-events-auto group-focus-within/msg:translate-y-0 group-focus-within/msg:scale-100 group-focus-within/msg:opacity-100",
          "group-hover/msg:pointer-events-auto group-hover/msg:translate-y-0 group-hover/msg:scale-100 group-hover/msg:opacity-100",
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
            <span>{t("messageBubble.action.reply")}</span>
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
            <span>
              {copied ? t("messageBubble.action.copied") : t("messageBubble.action.copy")}
            </span>
          </button>
        ) : null}

        {hasNonStickerImage && imageAttachmentSrc !== null ? (
          <AppTooltip content={t("messageBubble.action.downloadImage")} side="top">
            <a
              href={imageAttachmentSrc}
              download={imageDownloadName}
              aria-label={t("messageBubble.action.downloadImage")}
              className="app-no-drag inline-flex cursor-pointer items-center justify-center rounded-full px-1.5 py-1 text-[#687082] transition-colors hover:bg-black/[0.05] hover:text-[#111318] dark:text-[#C4C4CA] dark:hover:bg-white/[0.10] dark:hover:text-[#F2F2F4]"
            >
              <Download className="h-3.5 w-3.5" />
            </a>
          </AppTooltip>
        ) : null}

        {canSaveSticker ? (
          <AppTooltip content={t("messageBubble.action.saveSticker")} side="top">
            <button
              type="button"
              aria-label={t("messageBubble.action.saveSticker")}
              onClick={() => props.onSaveSticker?.(message)}
              className="app-no-drag inline-flex cursor-pointer items-center justify-center rounded-full px-1.5 py-1 text-[#687082] transition-colors hover:bg-black/[0.05] hover:text-[#111318] dark:text-[#C4C4CA] dark:hover:bg-white/[0.10] dark:hover:text-[#F2F2F4]"
            >
              <BookmarkPlus className="h-3.5 w-3.5" />
            </button>
          </AppTooltip>
        ) : null}

        {canRecall && props.onRecall ? (
          <AppTooltip content={t("messageBubble.action.recallTooltip")} side="top">
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
              <span>{t("messageBubble.action.recall")}</span>
            </button>
          </AppTooltip>
        ) : null}
      </div>
    ) : null;

  // ── 极简 2px 竖线内联引用（支持嵌入 28×28px 图片微缩略图，点击定位源消息） ──
  const replyQuote =
    message.replyToSeq !== undefined
      ? (() => {
          const replySeq = message.replyToSeq;
          const replied = props.repliedMessage;
          const snippet =
            replied === undefined
              ? t("messageBubble.replyFallbackSnippet")
              : getMessageSnippet(replied, 88, locale);
          const replyThumbKey =
            replied !== undefined ? `${replied.roomId}:${String(replied.seq)}` : null;
          const showReplyImageThumb =
            !props.readOnly &&
            replied !== undefined &&
            replied.recalledAtIso === undefined &&
            replied.attachment !== undefined &&
            replied.attachment.mimeType.startsWith("image/") &&
            replyThumbKey !== null &&
            failedReplyThumbKey !== replyThumbKey;
          return (
            <button
              type="button"
              onClick={() => handleJump(replySeq)}
              className="app-no-drag mb-1.5 flex w-full min-w-0 cursor-pointer select-none items-center gap-2 border-l-2 border-black/15 py-0.5 pl-2.5 text-left text-[13px] leading-snug text-[#687082] transition-opacity hover:opacity-75 dark:border-white/20 dark:text-[#8E8E96]"
            >
              {showReplyImageThumb && replied !== undefined ? (
                <img
                  src={roomMessageAttachmentPath(replied.roomId, replied.seq)}
                  alt=""
                  aria-hidden="true"
                  loading="lazy"
                  decoding="async"
                  onError={() => {
                    if (replyThumbKey !== null) {
                      setFailedReplyThumbKey(replyThumbKey);
                    }
                  }}
                  className="h-7 w-7 shrink-0 rounded-[6px] object-cover ring-1 ring-inset ring-black/[0.06] dark:ring-white/[0.08]"
                />
              ) : null}
              <span className="line-clamp-2 min-w-0 flex-1">
                {replied !== undefined ? (
                  <span className="mr-1 font-medium text-[#111318]/85 dark:text-[#F2F2F4]/90">
                    {t("messageBubble.replyAuthorPrefix", {
                      author: props.repliedAuthorDisplayName ?? replied.author.displayName,
                    })}
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
                  ? "bg-im-human/85 ring-emerald-900/[0.08] dark:bg-im-human dark:ring-emerald-400/[0.15]"
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
                    {tp("proposal.optionCount", linked.draft.options.length)} ·{" "}
                    {tp("proposal.voteCount", linked.votes.length)}
                    {linked.decidedOptionKey
                      ? ` · ${t("messageBubble.linkedProposalDecided", {
                          optionKey: linked.decidedOptionKey,
                        })}`
                      : ""}
                  </p>
                </div>
              </div>
              {props.onOpenProposal ? (
                <button
                  type="button"
                  onClick={() => props.onOpenProposal?.(linked.id)}
                  className="app-no-drag flex w-full cursor-pointer items-center justify-between border-t border-black/[0.06] px-3 py-2 text-[12px] font-medium text-[#111318] transition-colors hover:bg-black/[0.03] active:scale-[0.99] dark:border-white/[0.07] dark:text-[#F2F2F4] dark:hover:bg-white/[0.05]"
                >
                  <span>
                    {isApproved
                      ? t("messageBubble.linkedProposalViewApproved")
                      : t("messageBubble.linkedProposalReview")}
                  </span>
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
      <div className="mt-1.5 w-full min-w-0 select-none rounded-[14px] border border-black/[0.06] bg-im-surface/85 p-2.5 dark:border-white/[0.08] dark:bg-[#18181B]/90">
        <div className="flex items-center gap-1.5 text-[11px] font-medium text-[#687082] dark:text-[#8E8E96]">
          <Hand
            aria-hidden="true"
            className="h-3 w-3 shrink-0 text-amber-600 dark:text-amber-400"
          />
          <span>{t("messageBubble.attentionWaiting")}</span>
          {attentionExpired ? (
            <span className="rounded-full bg-black/[0.06] px-1.5 py-0.5 text-[10px] dark:bg-white/10">
              {t("messageBubble.attentionExpired")}
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
                className="app-no-drag cursor-pointer whitespace-normal rounded-2xl bg-[#181B22] px-3 py-1.5 text-left text-[11.5px] font-medium leading-snug text-white transition hover:bg-[#252A35] active:scale-[0.97] dark:bg-[#EAEEF6] dark:text-[#111318] dark:hover:bg-white"
              >
                {option}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    ) : null;

  const isFallbackEmptyBody =
    !hasContent &&
    message.attachment === undefined &&
    message.replyToSeq === undefined &&
    props.linkedProposal === undefined &&
    attention === undefined;

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
          standalone={isStandaloneMedia}
          localBlob={message._optimisticBlob}
          lightboxOpen={lightboxOpen}
          onLightboxOpenChange={setLightboxOpen}
        />
      ) : null}
      {isFallbackEmptyBody ? (
        <span className="select-none text-[13px] text-[#687082] dark:text-[#8E8E96]">
          {t("messageBubble.emptyReadOnlyFallback")}
        </span>
      ) : null}
      {linkedCard}
    </>
  );

  const timeNode = isPending ? (
    <span className="inline-flex select-none items-center gap-1 text-[12px] text-im-subtle">
      <Loader2 className="h-3 w-3 animate-spin" />
      <span>{t("messageBubble.sending")}</span>
    </span>
  ) : (
    <AppTooltip
      content={t("messageBubble.timeTooltip", { seq: message.seq, time: timeLabel })}
      side="top"
    >
      <time
        dateTime={message.createdAtIso}
        className="select-none text-[12px] tabular-nums text-im-subtle"
      >
        {timeLabel}
      </time>
    </AppTooltip>
  );

  // ── 3. 本人发出消息（isSelf）：右对齐并使用本人气泡的主题色 ──
  if (isSelf) {
    const selfContent = (
      <>
        {!isGrouped ? (
          <div className="mb-1 flex select-none items-center gap-2 pr-0.5 leading-none">
            {timeNode}
          </div>
        ) : null}

        <div className="relative flex min-w-0 max-w-full items-end gap-1">
          {mobileQuickTrigger}
          <div className="relative min-w-0 max-w-full">
            {actionBar}
            <AppContextMenu
              className="oh-message-actions"
              items={contextMenuItems}
              disabled={isContextMenuDisabled}
              onOpenChange={(open) => {
                if (!open) {
                  setCapturedSelection("");
                }
              }}
            >
              <div
                onClick={handleBubbleClick}
                onKeyDown={handleBubbleKeyDown}
                onContextMenuCapture={captureBubbleSelection}
                ref={bubbleRef}
                className={cn(
                  hasMessageActions && "oh-message-menu-trigger",
                  "min-w-0 transition-shadow duration-150",
                  isStandaloneSticker
                    ? "rounded-lg p-1"
                    : cn(
                        isStandaloneImage
                          ? "p-1"
                          : isReadOnlyStandaloneMedia
                            ? "px-3 py-2"
                            : "px-3.5 py-2.5 sm:px-4",
                        isGrouped ? "rounded-[18px]" : "rounded-[18px_6px_18px_18px]",
                        "bg-im-self text-im-self-fg ring-1 ring-inset ring-black/[0.06] shadow-[0_1px_2px_rgba(15,23,42,0.04)]",
                        "dark:ring-1 dark:ring-inset dark:ring-white/[0.11] dark:shadow-[0_2px_8px_rgba(0,0,0,0.24),inset_0_1px_0_rgba(255,255,255,0.08)]",
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
        </div>

        {isGrouped && isPending ? <div className="mt-0.5 pr-1">{timeNode}</div> : null}
      </>
    );

    return (
      <article
        id={anchorId}
        data-seq={message.seq}
        onDoubleClick={handleRowDoubleClick}
        className={cn(
          "group/msg flex justify-end rounded-xl pl-5 pr-1 transition-[background-color,opacity] duration-200 sm:pl-16",
          isGrouped ? "mt-1" : "mt-3.5",
          isPending && !hasNonStickerImage && "opacity-80",
        )}
      >
        {shouldAnimateEntrance ? (
          <motion.div
            initial={{ opacity: 0, y: 6, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={reducedMotion ? INSTANT_TRANSITION : NATIVE_LIVE_BUBBLE_SPRING}
            className="ml-auto flex min-w-0 max-w-[86%] sm:max-w-[78%] flex-col items-end will-change-[transform,opacity]"
          >
            {selfContent}
          </motion.div>
        ) : (
          <div className="ml-auto flex min-w-0 max-w-[86%] sm:max-w-[78%] flex-col items-end">
            {selfContent}
          </div>
        )}
      </article>
    );
  }

  // ── 4. 对端消息：36px 圆形头像 + 发送者头部 + 鼠尾草绿（人类）或中性灰（Agent）气泡 ──
  const isHumanPeer = message.author.kind === "human";
  const peerBubbleSurfaceClass = isHumanPeer
    ? "bg-im-human text-im-human-fg ring-1 ring-inset ring-emerald-900/[0.08] shadow-[0_1px_2px_rgba(15,23,42,0.03)] dark:ring-1 dark:ring-inset dark:ring-emerald-400/[0.14] dark:shadow-[0_2px_8px_rgba(0,0,0,0.22)]"
    : "bg-im-peer text-im-peer-fg ring-1 ring-inset ring-black/[0.06] shadow-[0_1px_3px_rgba(15,23,42,0.04)] dark:ring-1 dark:ring-inset dark:ring-white/[0.07] dark:shadow-[0_2px_8px_rgba(0,0,0,0.22)]";

  const avatar = (
    <PlatformAvatar
      kind={message.author.kind}
      displayName={authorDisplayName}
      platform={message.author.platform}
      reach={props.authorReach}
      size="md"
    />
  );

  const peerContent = (
    <>
      {/* 发送者头部：13px font-medium 名字 + 12px 灰字时间 + 安静归属说明 */}
      {!isGrouped ? (
        <div className="mb-1 flex max-w-full select-none items-baseline gap-2 overflow-hidden pl-0.5 leading-none">
          {isAgentInspectable ? (
            <button
              type="button"
              onClick={handleAgentInspect}
              className="app-no-drag cursor-pointer truncate text-[13px] font-medium text-[#111318] outline-none transition-opacity hover:opacity-75 focus-visible:underline dark:text-[#F2F2F4]"
            >
              {authorDisplayName}
            </button>
          ) : (
            <span className="truncate text-[13px] font-medium text-[#111318] dark:text-[#F2F2F4]">
              {authorDisplayName}
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

      <div className="relative flex min-w-0 max-w-full items-end gap-1">
        <div className="relative min-w-0 max-w-full">
          {actionBar}
          <AppContextMenu
            className="oh-message-actions"
            items={contextMenuItems}
            disabled={isContextMenuDisabled}
            onOpenChange={(open) => {
              if (!open) {
                setCapturedSelection("");
              }
            }}
          >
            <div
              onClick={handleBubbleClick}
              onKeyDown={handleBubbleKeyDown}
              onContextMenuCapture={captureBubbleSelection}
              ref={bubbleRef}
              className={cn(
                hasMessageActions && "oh-message-menu-trigger",
                "min-w-0 transition-shadow duration-150",
                isStandaloneSticker
                  ? "rounded-lg p-1"
                  : cn(
                      isStandaloneImage
                        ? "p-1"
                        : isReadOnlyStandaloneMedia
                          ? "px-3 py-2"
                          : "px-3.5 py-2.5 sm:px-4",
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
        {mobileQuickTrigger}
      </div>
    </>
  );

  return (
    <article
      id={anchorId}
      data-seq={message.seq}
      onDoubleClick={handleRowDoubleClick}
      className={cn(
        "group/msg flex items-start gap-2 rounded-xl pl-1 pr-2.5 transition-[background-color,opacity] duration-200 sm:gap-2.5 sm:pr-16",
        isGrouped ? "mt-1" : "mt-3.5",
        isPending && !hasNonStickerImage && "opacity-80",
      )}
    >
      {/* 左侧 36px 圆形头像对齐列：连续分组时隐藏头像，悬停轻显紧凑时刻 */}
      <div className="flex w-8 sm:w-9 shrink-0 justify-center">
        {isGrouped ? (
          <time
            dateTime={message.createdAtIso}
            className="mt-2.5 select-none text-[11px] tabular-nums text-im-subtle opacity-0 transition-opacity duration-150 group-hover/msg:opacity-100"
          >
            {timeLabel}
          </time>
        ) : isAgentInspectable ? (
          <AppTooltip
            content={t("messageBubble.inspectAvatarTooltip", { name: message.author.displayName })}
            side="top"
          >
            <button
              type="button"
              onClick={handleAgentInspect}
              className="im-press app-no-drag mt-0.5 cursor-pointer rounded-full outline-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-black/20 dark:focus-visible:ring-white/25"
            >
              {avatar}
            </button>
          </AppTooltip>
        ) : (
          <div className="mt-0.5">{avatar}</div>
        )}
      </div>

      {shouldAnimateEntrance ? (
        <motion.div
          initial={{ opacity: 0, y: 6, scale: 0.985 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={reducedMotion ? INSTANT_TRANSITION : NATIVE_LIVE_BUBBLE_SPRING}
          className="flex min-w-0 max-w-[86%] sm:max-w-[78%] flex-col items-start will-change-[transform,opacity]"
        >
          {peerContent}
        </motion.div>
      ) : (
        <div className="flex min-w-0 max-w-[86%] sm:max-w-[78%] flex-col items-start">
          {peerContent}
        </div>
      )}
    </article>
  );
}
