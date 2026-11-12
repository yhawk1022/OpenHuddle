/**
 * @module web/components/ui/message-bubble
 * @description 纯 Props 驱动的消息流气泡与内联提案/拍板卡组件（同时服务实时聊天舱与公开只读分享页）。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 安全徽章显性化：每条消息强制渲染服务端验签的 `SecurityTrustBadge`（`OWNER COMMAND` / `YOUR AGENT` / `EXTERNAL`）及 `#seq` 严格序号。
 * 2. 结构化消息一等渲染：`proposal`、`vote`、`decision` 消息在时间线内直接展示富语义卡片与右侧提案面板联动入口，告别枯燥纯文本日志。
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
  CornerUpLeft,
  ExternalLink,
  FileText,
  Loader2,
  Reply,
  RotateCcw,
} from "lucide-react";
import { canViewerRecallMessage, formatMessageTimestamp } from "../../lib/format.js";
import type { OptimisticMessageItem } from "../../lib/query-keys.js";
import type { InspectedAgentProfile } from "./agent-profile-dialog.js";
import {
  MessageSemanticBadge,
  PlatformAvatar,
  PlatformTagPill,
  SecurityTrustBadge,
} from "./identity-badges.js";
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
  readonly onReply?: ((message: MessageDto) => void) | undefined;
  readonly onQuickMention?: ((mention: MessageMention) => void) | undefined;
  readonly onRecall?: ((seq: MessageSeq) => void) | undefined;
  readonly onOpenProposal?: ((proposalId: ProposalId) => void) | undefined;
  readonly onInspectAgent?: ((profile: InspectedAgentProfile) => void) | undefined;
}

/**
 * 渲染单条群聊消息（含平台头像、主人归属、安全印章、Markdown 表格代码块、2 分钟撤回及内联决策卡）。
 *
 * @param props - 消息视图模型与交互回调
 * @returns 单条消息时间线节点
 */
export function MessageBubble(props: MessageBubbleProps) {
  const { message } = props;
  const isRecalled = message.recalledAtIso !== undefined;
  const isPending = message._optimisticPending === true;
  const canRecall = !props.readOnly && !isPending && canViewerRecallMessage(message, props.nowMs);

  // 根据消息语义计算容器边框与渐变底色（让提案与最终拍板在聊天流中一眼可见）
  const containerClass =
    message.type === "decision"
      ? "border-amber-500/45 bg-gradient-to-r from-amber-500/[0.09] via-amber-500/[0.04] to-transparent dark:from-amber-500/[0.12]"
      : message.type === "proposal"
        ? "border-indigo-500/35 bg-indigo-500/[0.04] dark:bg-indigo-500/[0.07]"
        : message.type === "vote"
          ? "border-violet-500/25 bg-violet-500/[0.03] dark:bg-violet-500/[0.05]"
          : message.author.trustLevel === "owner_command"
            ? "border-emerald-500/20 bg-white hover:border-emerald-500/35 dark:border-emerald-500/15 dark:bg-[#10141e]"
            : "border-slate-200/80 bg-white hover:border-slate-300/90 dark:border-white/[0.07] dark:bg-[#0e121b] dark:hover:border-white/14";

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
        props.authorOwnerName ?? (message.author.isYourOwner ? "你本人" : "已认证主理人"),
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

  return (
    <article
      id={`msg-seq-${String(message.seq)}`}
      className={`group relative rounded-2xl border px-4 py-3.5 transition ${containerClass} ${
        isPending ? "opacity-75" : ""
      }`}
    >
      {/* 悬浮快捷操作胶囊（回复 / @提及 / 2 分钟撤回） */}
      {!props.readOnly && !isRecalled && !isPending ? (
        <div className="pointer-events-none absolute -top-3 right-3 flex items-center gap-1 rounded-xl border border-slate-200/90 bg-white/95 px-1.5 py-1 opacity-0 shadow-md backdrop-blur-xs transition group-hover:pointer-events-auto group-hover:opacity-100 dark:border-white/12 dark:bg-[#161b26]/95">
          {props.onReply ? (
            <button
              type="button"
              onClick={() => props.onReply?.(message)}
              title="引用回复此消息"
              className="inline-flex items-center gap-1 rounded-lg px-2 py-0.5 text-[11px] font-medium text-slate-600 transition hover:bg-slate-100 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-white/10 dark:hover:text-white"
            >
              <Reply className="h-3 w-3" />
              <span>回复</span>
            </button>
          ) : null}

          {props.onQuickMention ? (
            <button
              type="button"
              onClick={handleMentionClick}
              title={`在输入框 @${message.author.displayName}`}
              className="inline-flex items-center gap-1 rounded-lg px-2 py-0.5 text-[11px] font-medium text-slate-600 transition hover:bg-slate-100 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-white/10 dark:hover:text-white"
            >
              <AtSign className="h-3 w-3" />
              <span>提及</span>
            </button>
          ) : null}

          {canRecall && props.onRecall ? (
            <button
              type="button"
              disabled={Boolean(props.isRecalling)}
              onClick={() => props.onRecall?.(message.seq)}
              title="发送后 2 分钟内可撤回"
              className="inline-flex items-center gap-1 rounded-lg px-2 py-0.5 text-[11px] font-medium text-rose-600 transition hover:bg-rose-500/10 dark:text-rose-400"
            >
              <RotateCcw className="h-3 w-3" />
              <span>撤回</span>
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="flex items-start gap-3">
        {/* 左侧头像（Agent 可点击打开身份名片） */}
        {message.author.kind === "agent" && props.onInspectAgent ? (
          <button
            type="button"
            onClick={handleAgentInspect}
            title="点击查看 Agent 归属档案与在线状态"
            className="mt-0.5 shrink-0 transition hover:scale-105"
          >
            <PlatformAvatar
              kind="agent"
              displayName={message.author.displayName}
              platform={message.author.platform}
              reach={props.authorReach}
            />
          </button>
        ) : (
          <div className="mt-0.5 shrink-0">
            <PlatformAvatar
              kind={message.author.kind}
              displayName={message.author.displayName}
              platform={message.author.platform}
              reach={props.authorReach}
            />
          </div>
        )}

        <div className="min-w-0 flex-1 space-y-1.5">
          {/* 头部：作者昵称、宿主平台、Owner 血统、权威安全印章、#seq 与时间戳 */}
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {message.author.kind === "agent" && props.onInspectAgent ? (
              <button
                type="button"
                onClick={handleAgentInspect}
                className="text-sm font-semibold text-slate-900 hover:text-indigo-600 dark:text-white dark:hover:text-indigo-400"
              >
                {message.author.displayName}
              </button>
            ) : (
              <span className="text-sm font-semibold text-slate-900 dark:text-white">
                {message.author.displayName}
              </span>
            )}

            {message.author.platform ? (
              <PlatformTagPill platform={message.author.platform} />
            ) : null}

            {message.author.kind === "agent" && props.authorOwnerName ? (
              <span className="text-[11px] text-slate-500 dark:text-slate-400">
                Owner: {props.authorOwnerName}
              </span>
            ) : null}

            <SecurityTrustBadge
              trustLevel={message.author.trustLevel}
              isYou={message.author.isYou}
            />

            <MessageSemanticBadge type={message.type} />

            <span className="ml-auto inline-flex items-center gap-1.5 font-mono text-[11px] text-slate-400 dark:text-slate-500">
              {isPending ? (
                <span className="inline-flex items-center gap-1 text-indigo-500 dark:text-indigo-400">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  <span>发送中</span>
                </span>
              ) : (
                <span>#{message.seq}</span>
              )}
              <span>·</span>
              <time dateTime={message.createdAtIso}>
                {formatMessageTimestamp(message.createdAtIso)}
              </time>
            </span>
          </div>

          {/* 引用回复锚点条（Reply-To Quote Bar） */}
          {message.replyToSeq !== undefined ? (
            <div className="flex items-center gap-1.5 rounded-lg border border-slate-200/80 bg-slate-100/70 px-2.5 py-1 text-xs text-slate-600 dark:border-white/[0.07] dark:bg-white/[0.03] dark:text-slate-400">
              <CornerUpLeft className="h-3 w-3 shrink-0 text-indigo-500" />
              <span className="font-mono font-semibold text-indigo-600 dark:text-indigo-400">
                #{message.replyToSeq}
              </span>
              {props.repliedMessage ? (
                <span className="truncate">
                  <strong className="font-medium">
                    {props.repliedMessage.author.displayName}:
                  </strong>{" "}
                  {props.repliedMessage.recalledAtIso
                    ? "（已撤回消息）"
                    : props.repliedMessage.content.slice(0, 90)}
                </span>
              ) : (
                <span>引用前序发言</span>
              )}
            </div>
          ) : null}

          {/* 消息主体内容或撤回墓碑 */}
          {isRecalled ? (
            <p className="rounded-lg bg-slate-100/80 px-3 py-1.5 text-xs italic text-slate-400 dark:bg-white/[0.03] dark:text-slate-500">
              此消息已由发送者在 2 分钟窗口内撤回。
            </p>
          ) : (
            <div className="text-slate-800 dark:text-slate-100">
              <MarkdownContent content={message.content} />
            </div>
          )}

          {/* 内联提案或拍板结论联动卡片 */}
          {!isRecalled && props.linkedProposal !== undefined
            ? (() => {
                const linked = props.linkedProposal;
                return (
                  <div
                    className={`mt-2 flex flex-wrap items-center justify-between gap-3 rounded-xl border p-3 ${
                      linked.status === "approved"
                        ? "border-amber-500/40 bg-amber-500/10"
                        : "border-indigo-500/30 bg-indigo-500/[0.08]"
                    }`}
                  >
                    <div className="min-w-0 flex-1 space-y-0.5">
                      <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-900 dark:text-white">
                        {linked.status === "approved" ? (
                          <Award className="h-4 w-4 shrink-0 text-amber-500" />
                        ) : (
                          <FileText className="h-4 w-4 shrink-0 text-indigo-500" />
                        )}
                        <span className="truncate">{linked.draft.title}</span>
                      </div>
                      <p className="text-[11.5px] text-slate-600 dark:text-slate-300">
                        共 {linked.draft.options.length} 个备选方案 · 已收集 {linked.votes.length}{" "}
                        票评议
                        {linked.decidedOptionKey ? ` · 最终采纳 ${linked.decidedOptionKey}` : ""}
                      </p>
                    </div>
                    {props.onOpenProposal ? (
                      <button
                        type="button"
                        onClick={() => props.onOpenProposal?.(linked.id)}
                        className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white shadow-2xs transition hover:bg-indigo-500"
                      >
                        <span>打开决策卡对比 / 拍板</span>
                        <ExternalLink className="h-3 w-3" />
                      </button>
                    ) : null}
                  </div>
                );
              })()
            : null}
        </div>
      </div>
    </article>
  );
}
