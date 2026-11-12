/**
 * @module web/features/huddle-room/message-composer
 * @description 房间底部人体工学消息编辑器（支持 `@全体 Agents` 快捷胶囊、成员精准 `@mention`、引用回复条与失败不丢草稿保护）。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 结构化提及对齐：点击上方 `@mention` 胶囊既在文本内插入可读的 `@昵称`，同时维护强类型 `MessageMention[]` 数组确保服务端唤醒调度器 100% 精准派发 `wake` 事件。
 * 2. 乐观防丢字：提交前生成唯一 `OperationKey`；一旦网络异常，草稿保留在输入框并展示明确错误提示。
 */
import type {
  MessageDto,
  MessageMention,
  MessageSeq,
  OperationKey,
  RoomMemberDto,
} from "@openhuddle/protocol";
import { AtSign, CornerUpLeft, Loader2, Send, Sparkles, X } from "lucide-react";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { ApiClientError } from "../../../lib/api-client.js";
import { createClientOperationKey, getReachVisualMeta } from "../../../lib/format.js";

/** `MessageComposer` 入参属性 */
export interface MessageComposerProps {
  readonly roomName: string;
  readonly members: ReadonlyArray<RoomMemberDto>;
  readonly replyTarget: MessageDto | null;
  readonly pendingQuickMention: MessageMention | null;
  readonly onConsumeQuickMention: () => void;
  readonly onClearReplyTarget: () => void;
  readonly isSending: boolean;
  readonly sendError: Error | null;
  readonly onSendMessage: (params: {
    readonly content: string;
    readonly opKey: OperationKey;
    readonly replyToSeq?: MessageSeq;
    readonly mentions: ReadonlyArray<MessageMention>;
    readonly onConfirmedOrQueued: () => void;
  }) => void;
}

function mentionIdentityKey(mention: MessageMention): string {
  return mention.kind === "agent" ? `agent:${mention.agentId}` : `human:${mention.userId}`;
}

function memberToMention(member: RoomMemberDto): MessageMention | null {
  if (member.memberKind === "agent" && member.agentId !== undefined) {
    return {
      kind: "agent",
      agentId: member.agentId,
      displayName: member.displayName,
    };
  }
  if (member.memberKind === "human" && member.userId !== undefined) {
    return {
      kind: "human",
      userId: member.userId,
      displayName: member.displayName,
    };
  }
  return null;
}

/**
 * 渲染底部带 `@mention` 快捷唤醒栏与引用锚点的聊天发送器。
 *
 * @param props - 群成员列表、回复目标与乐观发送回调
 * @returns 聊天输入区组件
 */
export function MessageComposer(props: MessageComposerProps) {
  const [draft, setDraft] = useState<string>("");
  const [selectedMentions, setSelectedMentions] = useState<ReadonlyArray<MessageMention>>([]);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const agentMembers = props.members.filter(
    (m) => m.memberKind === "agent" && m.agentId !== undefined,
  );
  const humanMembers = props.members.filter(
    (m) => m.memberKind === "human" && m.userId !== undefined,
  );

  // 响应消息卡片悬浮栏或 Agent 名片点击传来的快捷 @ 提及意图
  useEffect(() => {
    const incoming = props.pendingQuickMention;
    if (!incoming) {
      return;
    }
    setSelectedMentions((prev) => {
      const exists = prev.some((m) => mentionIdentityKey(m) === mentionIdentityKey(incoming));
      return exists ? prev : [...prev, incoming];
    });
    const tag = `@${incoming.displayName} `;
    setDraft((prev) => (prev.includes(`@${incoming.displayName}`) ? prev : `${prev}${tag}`));
    props.onConsumeQuickMention();
    textareaRef.current?.focus();
  }, [props.pendingQuickMention, props.onConsumeQuickMention]);

  const toggleMention = (target: MessageMention): void => {
    const targetKey = mentionIdentityKey(target);
    const alreadySelected = selectedMentions.some((m) => mentionIdentityKey(m) === targetKey);
    if (alreadySelected) {
      setSelectedMentions((prev) => prev.filter((m) => mentionIdentityKey(m) !== targetKey));
    } else {
      setSelectedMentions((prev) => [...prev, target]);
      const tag = `@${target.displayName} `;
      setDraft((prev) => (prev.includes(`@${target.displayName}`) ? prev : `${prev}${tag}`));
    }
    textareaRef.current?.focus();
  };

  const handleMentionAllAgents = (): void => {
    const allAgentMentions: MessageMention[] = [];
    for (const member of agentMembers) {
      const converted = memberToMention(member);
      if (converted !== null) {
        allAgentMentions.push(converted);
      }
    }
    if (allAgentMentions.length === 0) {
      return;
    }
    setSelectedMentions((prev) => {
      const merged = [...prev];
      for (const item of allAgentMentions) {
        if (!merged.some((existing) => mentionIdentityKey(existing) === mentionIdentityKey(item))) {
          merged.push(item);
        }
      }
      return merged;
    });
    const missingTags = allAgentMentions
      .filter((m) => !draft.includes(`@${m.displayName}`))
      .map((m) => `@${m.displayName}`)
      .join(" ");
    if (missingTags.length > 0) {
      setDraft((prev) => (prev.trim().length > 0 ? `${prev} ${missingTags} ` : `${missingTags} `));
    }
    textareaRef.current?.focus();
  };

  const submitMessage = (): void => {
    const trimmed = draft.trim();
    if (trimmed.length === 0 || props.isSending) {
      return;
    }

    const opKey = createClientOperationKey();
    const replySeq = props.replyTarget?.seq;

    props.onSendMessage({
      content: trimmed,
      opKey,
      ...(replySeq !== undefined ? { replyToSeq: replySeq } : {}),
      mentions: selectedMentions,
      onConfirmedOrQueued: () => {
        setDraft("");
        setSelectedMentions([]);
        props.onClearReplyTarget();
      },
    });
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    // 中文等输入法候选词上屏过程中按 Enter 不触发误发送
    if (event.nativeEvent.isComposing) {
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submitMessage();
    }
  };

  const errorText =
    props.sendError instanceof ApiClientError
      ? `${props.sendError.message} (${props.sendError.code})`
      : props.sendError instanceof Error
        ? props.sendError.message
        : null;

  return (
    <footer className="shrink-0 border-t border-slate-200/85 bg-white px-4 py-3 dark:border-white/[0.07] dark:bg-[#0c1018]">
      <div className="mx-auto max-w-4xl space-y-2">
        {/* 1. 发送错误提示横幅（草稿保留不丢失） */}
        {errorText ? (
          <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-1.5 text-xs text-rose-700 dark:text-rose-300">
            发送失败（草稿已安全保留）：{errorText}
          </div>
        ) : null}

        {/* 2. 引用回复目标提示条 */}
        {props.replyTarget ? (
          <div className="flex items-center justify-between gap-2 rounded-xl border border-indigo-500/30 bg-indigo-500/[0.07] px-3 py-1.5 text-xs">
            <div className="flex min-w-0 items-center gap-1.5 text-indigo-800 dark:text-indigo-200">
              <CornerUpLeft className="h-3.5 w-3.5 shrink-0 text-indigo-500" />
              <span className="font-mono font-bold">回复 #{props.replyTarget.seq}</span>
              <span className="font-semibold">@{props.replyTarget.author.displayName}:</span>
              <span className="truncate opacity-80">{props.replyTarget.content.slice(0, 80)}</span>
            </div>
            <button
              type="button"
              onClick={props.onClearReplyTarget}
              aria-label="取消引用回复"
              className="rounded-md p-0.5 text-slate-500 hover:bg-black/5 dark:text-slate-300 dark:hover:bg-white/10"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : null}

        {/* 3. Pachat 升级版快捷 @Mention 点选唤醒栏（含 @全体 Agents 一键点名与在线 LED 指示） */}
        {agentMembers.length > 0 || humanMembers.length > 0 ? (
          <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5">
            <span className="inline-flex shrink-0 items-center gap-1 text-[11px] font-medium text-slate-400">
              <AtSign className="h-3 w-3" />
              <span>点名唤醒:</span>
            </span>

            {agentMembers.length > 1 ? (
              <button
                type="button"
                onClick={handleMentionAllAgents}
                className="inline-flex shrink-0 items-center gap-1 rounded-full border border-indigo-500/35 bg-indigo-500/10 px-2.5 py-0.5 text-[11px] font-semibold text-indigo-700 transition hover:bg-indigo-500/20 dark:text-indigo-300"
              >
                <Sparkles className="h-3 w-3" />
                <span>@全体 Agents ({agentMembers.length})</span>
              </button>
            ) : null}

            {agentMembers.map((member) => {
              const mentionObj = memberToMention(member);
              if (!mentionObj) {
                return null;
              }
              const isSelected = selectedMentions.some(
                (m) => mentionIdentityKey(m) === mentionIdentityKey(mentionObj),
              );
              const reachMeta = getReachVisualMeta(member.reach);
              return (
                <button
                  key={`chip-agt-${member.agentId ?? member.displayName}`}
                  type="button"
                  onClick={() => toggleMention(mentionObj)}
                  title={`${member.displayName} (${reachMeta.label})`}
                  className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition ${
                    isSelected
                      ? "border-indigo-500 bg-indigo-600 text-white shadow-2xs"
                      : "border-slate-200/90 bg-slate-50 text-slate-700 hover:bg-slate-100 dark:border-white/10 dark:bg-white/[0.04] dark:text-slate-300 dark:hover:bg-white/[0.09]"
                  }`}
                >
                  <span className={`h-1.5 w-1.5 rounded-full ${reachMeta.dotClass}`} />
                  <span>@{member.displayName}</span>
                </button>
              );
            })}

            {humanMembers.map((member) => {
              const mentionObj = memberToMention(member);
              if (!mentionObj) {
                return null;
              }
              const isSelected = selectedMentions.some(
                (m) => mentionIdentityKey(m) === mentionIdentityKey(mentionObj),
              );
              return (
                <button
                  key={`chip-usr-${member.userId ?? member.displayName}`}
                  type="button"
                  onClick={() => toggleMention(mentionObj)}
                  className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition ${
                    isSelected
                      ? "border-emerald-500 bg-emerald-600 text-white"
                      : "border-slate-200/80 bg-white text-slate-600 hover:bg-slate-50 dark:border-white/10 dark:bg-transparent dark:text-slate-400 dark:hover:bg-white/[0.06]"
                  }`}
                >
                  <span>@{member.displayName}</span>
                </button>
              );
            })}
          </div>
        ) : null}

        {/* 4. 主多行输入框与发送按钮 */}
        <div className="flex items-end gap-2 rounded-2xl border border-slate-200/95 bg-slate-50/80 p-2 transition focus-within:border-indigo-500 focus-within:bg-white focus-within:ring-2 focus-within:ring-indigo-500/15 dark:border-white/12 dark:bg-[#080b11] dark:focus-within:border-indigo-400">
          <textarea
            ref={textareaRef}
            rows={2}
            maxLength={16_000}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={`向 #${props.roomName} 发送主人指令或引导议题（支持 Markdown 表格与代码块，Enter 发送 / Shift+Enter 换行）...`}
            className="max-h-44 min-h-[44px] flex-1 resize-y bg-transparent px-2 py-1 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none dark:text-slate-100 dark:placeholder:text-slate-500"
          />

          <button
            type="button"
            disabled={draft.trim().length === 0 || props.isSending}
            onClick={submitMessage}
            className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-xl bg-indigo-600 px-4 text-xs font-semibold text-white shadow-xs transition hover:bg-indigo-500 disabled:opacity-45"
          >
            {props.isSending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-3.5 w-3.5" />
            )}
            <span>发送</span>
          </button>
        </div>
      </div>
    </footer>
  );
}
