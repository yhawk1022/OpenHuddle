/**
 * @module web/components/ui/message-bubble
 * @description 忠实复刻 `pachat.ai` 温润纸感对话几何的纯 Props 驱动聊天气泡组件（本人右侧象牙暖白 `#F6F2EC` / 其他人类鼠尾草绿 `#E3F3EC` / Agent 柔灰 `#F5F5F7` / 居中安静系统提示），同时服务实时聊天室与公开只读分享页。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 身份只信服务端签名：左右对齐由 `author.isYou` 决定，同伴/Agent 底色由 `author.kind` 决定，归属灰字由 `author.trustLevel` 决定，绝不从昵称或正文推断。
 * 2. 反「机器监控感」极简排版：不在消息流上裸露 `#seq` 序号徽章；外层 `<article id="msg-seq-{seq}">` 保留完整 DOM 锚点以驱动引用平滑滚动高亮，序号仅在时间戳悬停提示中按需可查。
 * 3. 非对称气泡几何与统一墨色阅读：本人气泡采用 `rounded-[18px_6px_18px_18px]` 暖象牙底色（`#F6F2EC` / 暗夜 `#272521`），对端采用 `rounded-[6px_18px_18px_18px]`，全部正文统一传递 `tone="default"` 保证自然黑/白墨水对比。
 * 4. 极简竖线引用：内联回复采用 `2px` 细竖线（`border-l-2 border-black/20`），摒弃笨重的嵌套框中框。
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
  Check,
  ChevronRight,
  Copy,
  FileText,
  Loader2,
  Reply,
  RotateCcw,
} from "lucide-react";
import { useState } from "react";
import {
  canViewerRecallMessage,
  formatMessageTimestamp,
  getPlatformVisualMeta,
} from "../../lib/format.js";
import type { OptimisticMessageItem } from "../../lib/query-keys.js";
import { AppTooltip, cn, motion, toast } from "../primitives/index.js";
import type { InspectedAgentProfile } from "./agent-profile-dialog.js";
import { AuthorMicroTag, MessageSemanticBadge, PlatformAvatar } from "./identity-badges.js";
import { MarkdownContent } from "./markdown-content.js";

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
  readonly onRecall?: ((seq: MessageSeq) => void) | undefined;
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

  const isSelf = message.author.isYou;
  const isGrouped = props.isGroupedWithPrevious === true;
  const isRecalled = message.recalledAtIso !== undefined;
  const isPending = message._optimisticPending === true;
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
        <p className="max-w-[85%] text-[12px] leading-relaxed text-[#8E8E93] dark:text-zinc-500">
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
        <p className="text-[12px] text-[#8E8E93] dark:text-zinc-500">
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

  const handleCopy = (): void => {
    if (typeof navigator === "undefined" || !navigator.clipboard) {
      return;
    }
    void navigator.clipboard.writeText(message.content).then(() => {
      setCopied(true);
      toast.success("已复制消息内容");
      window.setTimeout(() => setCopied(false), 1_600);
    });
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

  // ── Pachat 轻量操作条（↩ 回复 · @ · 复制 · 撤回） ──
  const actionBar =
    !props.readOnly && !isPending ? (
      <div
        className={cn(
          "pointer-events-none absolute -top-3.5 z-10 flex translate-y-0.5 select-none items-center gap-0.5 rounded-full px-1.5 py-0.5 opacity-0 transition-all duration-150",
          "bg-white/96 shadow-[0_4px_16px_rgba(0,0,0,0.08)] ring-1 ring-black/[0.07] backdrop-blur-md",
          "dark:bg-[#1C1C1F]/96 dark:shadow-[0_6px_20px_rgba(0,0,0,0.5)] dark:ring-white/[0.10]",
          "group-focus-within/msg:pointer-events-auto group-focus-within/msg:translate-y-0 group-focus-within/msg:opacity-100",
          "group-hover/msg:pointer-events-auto group-hover/msg:translate-y-0 group-hover/msg:opacity-100",
          isSelf ? "right-1.5" : "left-1.5",
        )}
      >
        {props.onReply ? (
          <button
            type="button"
            onClick={() => props.onReply?.(message)}
            className="app-no-drag inline-flex cursor-pointer items-center gap-1 rounded-full px-2 py-1 text-[11.5px] font-medium text-[#5F5F64] transition-colors hover:bg-black/[0.05] hover:text-[#141414] dark:text-zinc-400 dark:hover:bg-white/[0.08] dark:hover:text-zinc-100"
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
              className="app-no-drag inline-flex cursor-pointer items-center justify-center rounded-full px-1.5 py-1 text-[11.5px] font-medium text-[#5F5F64] transition-colors hover:bg-black/[0.05] hover:text-[#141414] dark:text-zinc-400 dark:hover:bg-white/[0.08] dark:hover:text-zinc-100"
            >
              <AtSign className="h-3 w-3" />
            </button>
          </AppTooltip>
        ) : null}

        <button
          type="button"
          onClick={handleCopy}
          className="app-no-drag inline-flex cursor-pointer items-center gap-1 rounded-full px-2 py-1 text-[11.5px] font-medium text-[#5F5F64] transition-colors hover:bg-black/[0.05] hover:text-[#141414] dark:text-zinc-400 dark:hover:bg-white/[0.08] dark:hover:text-zinc-100"
        >
          {copied ? <Check className="h-3 w-3 text-[#34C759]" /> : <Copy className="h-3 w-3" />}
          <span>{copied ? "已复制" : "复制"}</span>
        </button>

        {canRecall && props.onRecall ? (
          <AppTooltip content="撤回（发送后 2 分钟内）" side="top">
            <button
              type="button"
              disabled={Boolean(props.isRecalling)}
              onClick={() => props.onRecall?.(message.seq)}
              className="app-no-drag inline-flex cursor-pointer items-center gap-1 rounded-full px-2 py-1 text-[11.5px] font-medium text-[#D70015] transition-colors hover:bg-[#FF3B30]/10 disabled:opacity-50 dark:text-[#FF6961] dark:hover:bg-[#FF453A]/15"
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

  // ── Pachat 极简 2px 竖线内联引用（无嵌套背景盒，点击定位源消息） ──
  const replyQuote =
    message.replyToSeq !== undefined
      ? (() => {
          const replySeq = message.replyToSeq;
          const replied = props.repliedMessage;
          const snippet =
            replied === undefined
              ? "引用前序发言"
              : replied.recalledAtIso !== undefined
                ? "该消息已撤回"
                : replied.content.replace(/\s+/g, " ").slice(0, 88);
          return (
            <button
              type="button"
              onClick={() => handleJump(replySeq)}
              className="app-no-drag mb-1.5 block w-full min-w-0 cursor-pointer select-none border-l-2 border-black/20 py-0.5 pl-2.5 text-left text-[13px] leading-snug text-[#5F5F64] transition-opacity hover:opacity-75 dark:border-white/25 dark:text-zinc-400"
            >
              <span className="line-clamp-2 min-w-0">
                {replied !== undefined ? (
                  <span className="mr-1 font-medium text-[#141414]/80 dark:text-zinc-200">
                    {replied.author.displayName}：
                  </span>
                ) : null}
                <span>{snippet}</span>
              </span>
            </button>
          );
        })()
      : null;

  // ── 内嵌共识提案卡入口（温润纸面描边，联动右侧提案面板） ──
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
                  ? "bg-[#E3F3EC]/80 ring-black/[0.06] dark:bg-[#16271F] dark:ring-white/[0.08]"
                  : "bg-white/85 ring-black/[0.07] dark:bg-[#151518]/90 dark:ring-white/[0.08]",
              )}
            >
              <div className="flex items-start gap-2.5 px-3 py-2.5">
                <span
                  className={cn(
                    "mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full",
                    isApproved
                      ? "bg-[#1F5C43] text-white dark:bg-[#34C759] dark:text-[#141414]"
                      : "bg-[#141414] text-white dark:bg-[#F5F5F7] dark:text-[#141414]",
                  )}
                >
                  {isApproved ? (
                    <Award className="h-3.5 w-3.5" />
                  ) : (
                    <FileText className="h-3.5 w-3.5" />
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13.5px] font-semibold text-[#141414] dark:text-zinc-100">
                    {linked.draft.title}
                  </p>
                  <p className="mt-0.5 text-[12px] tabular-nums text-[#6E6E73] dark:text-zinc-400">
                    {linked.draft.options.length} 个方案 · {linked.votes.length} 人表态
                    {linked.decidedOptionKey ? ` · 已拍板 ${linked.decidedOptionKey}` : ""}
                  </p>
                </div>
              </div>
              {props.onOpenProposal ? (
                <button
                  type="button"
                  onClick={() => props.onOpenProposal?.(linked.id)}
                  className="app-no-drag flex w-full cursor-pointer items-center justify-between border-t border-black/[0.06] px-3 py-2 text-[12px] font-medium text-[#141414] transition-colors hover:bg-black/[0.03] active:scale-[0.99] dark:border-white/[0.07] dark:text-zinc-100 dark:hover:bg-white/[0.05]"
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

  // 统一传 tone="default"：无论是 #F6F2EC 暖象牙还是 #E3F3EC / #F5F5F7 纸感气泡均采用自然深浅墨水字色
  const bubbleBody = (
    <>
      {semanticBadge}
      {replyQuote}
      <MarkdownContent content={message.content} tone="default" />
      {linkedCard}
    </>
  );

  const timeNode = isPending ? (
    <span className="inline-flex select-none items-center gap-1 text-[12px] text-[#8E8E93] dark:text-zinc-500">
      <Loader2 className="h-3 w-3 animate-spin" />
      <span>发送中</span>
    </span>
  ) : (
    <AppTooltip content={`消息 #${String(message.seq)} · ${timeLabel}`} side="top">
      <time
        dateTime={message.createdAtIso}
        className="select-none text-[12px] tabular-nums text-[#8E8E93] dark:text-zinc-500"
      >
        {timeLabel}
      </time>
    </AppTooltip>
  );

  // ── 3. 本人发出消息（isSelf）：右对齐暖象牙纸气泡 `#F6F2EC` + `rounded-[18px_6px_18px_18px]` ──
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
            <div
              className={cn(
                "min-w-0 rounded-[18px_6px_18px_18px] bg-[#F6F2EC]/72 px-3.5 py-2.5 text-[#141414] ring-1 ring-inset ring-black/[0.04] backdrop-blur-md dark:bg-[#272521]/60 dark:text-[#F4F4F2] dark:ring-white/[0.06]",
                message.type === "decision" && "ring-1 ring-[#2A7B59]/30 dark:ring-[#5ED3A2]/25",
              )}
            >
              {bubbleBody}
            </div>
          </div>

          {isGrouped && isPending ? <div className="mt-0.5 pr-1">{timeNode}</div> : null}
        </motion.div>
      </article>
    );
  }

  // ── 4. 对端消息：36px 圆形头像 + 发送者头部 + 鼠尾草绿（人类 `#E3F3EC`）或柔灰（Agent `#F5F5F7`）气泡 ──
  const isHumanPeer = message.author.kind === "human";
  const peerBubbleSurfaceClass = isHumanPeer
    ? "bg-[#E3F3EC]/68 text-[#141414] ring-1 ring-inset ring-black/[0.04] backdrop-blur-md dark:bg-[#16271F]/60 dark:text-[#E8F3EC] dark:ring-white/[0.06]"
    : "bg-[#F5F5F7]/68 text-[#141414] ring-1 ring-inset ring-black/[0.04] backdrop-blur-md dark:bg-[#1C1C1F]/55 dark:text-[#ECECEF] dark:ring-white/[0.06]";

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
            className="mt-2.5 select-none text-[11px] tabular-nums text-[#8E8E93] opacity-0 transition-opacity duration-150 group-hover/msg:opacity-100 dark:text-zinc-500"
          >
            {timeLabel}
          </time>
        ) : isAgentInspectable ? (
          <AppTooltip content={`查看 ${message.author.displayName} 资料`} side="top">
            <button
              type="button"
              onClick={handleAgentInspect}
              className="app-no-drag mt-0.5 cursor-pointer rounded-full outline-none transition-transform duration-150 hover:opacity-90 active:scale-[0.96] focus-visible:ring-2 focus-visible:ring-black/25 dark:focus-visible:ring-white/30"
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
        {/* Pachat 发送者头部：13px font-medium 名字 + 12px 灰字时间 + 安静归属说明 */}
        {!isGrouped ? (
          <div className="mb-1 flex max-w-full select-none items-baseline gap-2 overflow-hidden pl-0.5 leading-none">
            {isAgentInspectable ? (
              <button
                type="button"
                onClick={handleAgentInspect}
                className="app-no-drag cursor-pointer truncate text-[13px] font-medium text-[#141414] outline-none transition-opacity hover:opacity-75 focus-visible:underline dark:text-zinc-100"
              >
                {message.author.displayName}
              </button>
            ) : (
              <span className="truncate text-[13px] font-medium text-[#141414] dark:text-zinc-100">
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
          <div
            className={cn(
              "min-w-0 rounded-[6px_18px_18px_18px] px-3.5 py-2.5",
              peerBubbleSurfaceClass,
              message.type === "decision" && "ring-1 ring-[#2A7B59]/30 dark:ring-[#5ED3A2]/25",
            )}
          >
            {bubbleBody}
          </div>
        </div>
      </motion.div>
    </article>
  );
}
