/**
 * @module web/features/huddle-room/message-composer
 * @description Pachat 原生消息输入区（Speaking-As Header + Rounded-20px Paper Input Card）：
 * 输入卡上方呈现 `20px` 迷你圆形本人头像与 `以 <名字> 的身份发言` 提示，以及行内可清除的引用回复与 `@提及` 胶囊；
 * 输入卡主体采用 `rounded-[20px]` 干净白纸边框与墨黑聚焦光晕（暗色恒为 `#18181B`），内置自适应高度文本域、
 * 行内 `@` 键盘联想浮层、底部 `18px` `@` 队友点名面板与右侧 `32px` 墨黑圆形 `ArrowUp` 发送键。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 结构化提及严格对齐：无论通过 `@` 浮层点选、`@全体` 胶囊、行内键盘联想还是手打精确昵称，
 *    最终提交的 `MessageMention[]` 只包含正文中仍真实保留 `@昵称` 的成员，杜绝删字后派发幽灵 `wake` 事件。
 * 2. 乐观防丢字：提交前生成唯一幂等 `OperationKey`；网络或治理拦截异常时草稿完整保留并展示错误提示。
 * 3. 双主题高对比度安全：暗色下输入卡固定为 `dark:bg-[#18181B]`，绝不触发白底白字缺陷。
 */
import type {
  AgentId,
  MessageDto,
  MessageMention,
  MessageSeq,
  OperationKey,
  RoomMemberDto,
  UserId,
} from "@openhuddle/protocol";
import { ArrowUp, AtSign, Check, CornerUpLeft, Loader2, User, Users, X } from "lucide-react";
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  AnimatePresence,
  AppPopover,
  AppTooltip,
  cn,
  motion,
} from "../../../components/primitives/index.js";
import { PlatformAvatar } from "../../../components/ui/identity-badges.js";
import { ApiClientError } from "../../../lib/api-client.js";
import { createClientOperationKey, getReachVisualMeta } from "../../../lib/format.js";

/** 输入框自适应高度上限（像素），超出后框内滚动，保持聊天舞台比例克制 */
const TEXTAREA_MAX_HEIGHT_PX = 168;

/** 行内 `@` 键盘联想浮层最多展示的候选人数 */
const MAX_MENTION_SUGGESTIONS = 8;

/** `MessageComposer` 入参属性 */
export interface MessageComposerProps {
  readonly roomName: string;
  readonly members: ReadonlyArray<RoomMemberDto>;
  readonly currentUserId?: UserId | undefined;
  /** 当前登录用户的展示昵称（用于渲染输入卡上方「以 <名字> 的身份发言」） */
  readonly currentUserDisplayName?: string | undefined;
  readonly replyTarget: MessageDto | null;
  readonly pendingQuickMention: MessageMention | null;
  readonly onConsumeQuickMention: () => void;
  readonly onClearReplyTarget: () => void;
  readonly isSending: boolean;
  readonly sendError: Error | null;
  readonly onReconnectOfflineAgent?: ((agentId: AgentId) => void) | undefined;
  readonly onSendMessage: (params: {
    readonly content: string;
    readonly opKey: OperationKey;
    readonly replyToSeq?: MessageSeq;
    readonly mentions: ReadonlyArray<MessageMention>;
    readonly onConfirmedOrQueued: () => void;
  }) => void;
}

/** `@` 联想菜单中的单个候选项（`all` 代表一键点名全体 Agent） */
interface MentionCandidate {
  readonly key: string;
  readonly kind: "all" | "agent" | "human";
  readonly label: string;
  readonly sublabel: string;
  readonly dotClass: string | null;
  readonly mention: MessageMention | null;
}

/** 光标前正在输入的 `@查询词` 片段 */
interface MentionTrigger {
  readonly query: string;
  readonly start: number;
  readonly end: number;
}

function mentionIdentityKey(mention: MessageMention): string {
  return mention.kind === "agent" ? `agent:${mention.agentId}` : `human:${mention.userId}`;
}

function memberToMention(member: RoomMemberDto): MessageMention | null {
  if (member.memberKind === "agent" && member.agentId !== undefined) {
    return { kind: "agent", agentId: member.agentId, displayName: member.displayName };
  }
  if (member.memberKind === "human" && member.userId !== undefined) {
    return { kind: "human", userId: member.userId, displayName: member.displayName };
  }
  return null;
}

function mergeMentions(
  base: ReadonlyArray<MessageMention>,
  extra: ReadonlyArray<MessageMention>,
): ReadonlyArray<MessageMention> {
  const merged = [...base];
  for (const item of extra) {
    if (!merged.some((existing) => mentionIdentityKey(existing) === mentionIdentityKey(item))) {
      merged.push(item);
    }
  }
  return merged;
}

/** 判断 Agent 是否处于可即时唤醒的在线通道 */
function isReachableNow(member: RoomMemberDto): boolean {
  return (
    member.reach === "online_sse" || member.reach === "hosted_ready" || member.reach === "webhook"
  );
}

/** 判断正文是否包含对某位成员的不区分大小写 `@昵称` 点名 */
function containsMemberMention(text: string, displayName: string): boolean {
  const normalized = displayName.trim().toLowerCase();
  return normalized.length > 0 && text.toLowerCase().includes(`@${normalized}`);
}

/**
 * 从光标前文本解析正在输入的 `@查询词`。
 *
 * @remarks 允许在行首、空白或中文/标点后直接输入 `@` 唤起联想（如 `你好@庞彦-OpenAICodex`），同时排除邮箱地址 `a@b.com`。
 */
function detectMentionTrigger(draft: string, caret: number): MentionTrigger | null {
  const before = draft.slice(0, caret);
  const match = /(?<![A-Za-z0-9._%+-])@([^\s@]{0,32})$/u.exec(before);
  if (!match) {
    return null;
  }
  const query = match[1] ?? "";
  return { query, start: caret - query.length - 1, end: caret };
}

/**
 * 渲染 Pachat 原生底部消息输入器（上方身份行 + 行内回复/提及胶囊 + `rounded-[20px]` 输入卡 + 圆形发送键）。
 *
 * @param props - 群成员列表、当前用户昵称、回复目标与乐观发送回调
 * @returns 底部聊天输入区组件
 */
export function MessageComposer(props: MessageComposerProps) {
  const [draft, setDraft] = useState<string>("");
  const [selectedMentions, setSelectedMentions] = useState<ReadonlyArray<MessageMention>>([]);
  const [caretIndex, setCaretIndex] = useState<number>(0);
  const [suggestDismissed, setSuggestDismissed] = useState<boolean>(false);
  const [activeSuggestIndex, setActiveSuggestIndex] = useState<number>(0);
  const [pickerOpen, setPickerOpen] = useState<boolean>(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const senderDisplayName =
    props.currentUserDisplayName !== undefined && props.currentUserDisplayName.trim().length > 0
      ? props.currentUserDisplayName.trim()
      : "你";

  const agentMembers = useMemo(
    () => props.members.filter((m) => m.memberKind === "agent" && m.agentId !== undefined),
    [props.members],
  );
  const humanMembers = useMemo(
    () => props.members.filter((m) => m.memberKind === "human" && m.userId !== undefined),
    [props.members],
  );
  const onlineAgentCount = useMemo(
    () => agentMembers.filter(isReachableNow).length,
    [agentMembers],
  );

  // 自适应高度：先归零再按 scrollHeight 撑开，useLayoutEffect 保证绘制前完成，杜绝输入高度闪烁
  // biome-ignore lint/correctness/useExhaustiveDependencies: draft 变化是重新测量高度的唯一触发源
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) {
      return;
    }
    el.style.height = "auto";
    const next = Math.min(el.scrollHeight, TEXTAREA_MAX_HEIGHT_PX);
    el.style.height = `${String(next)}px`;
    el.style.overflowY = el.scrollHeight > TEXTAREA_MAX_HEIGHT_PX ? "auto" : "hidden";
  }, [draft]);

  /** 在下一帧将光标定位至指定偏移（等待 React 提交受控 value 更新后执行） */
  const focusAt = useCallback((position: number): void => {
    window.requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) {
        return;
      }
      el.focus();
      el.setSelectionRange(position, position);
      setCaretIndex(position);
    });
  }, []);

  // 响应消息气泡悬浮条或右侧抽屉「@点名」传来的快捷提及意图
  useEffect(() => {
    const incoming = props.pendingQuickMention;
    if (!incoming) {
      return;
    }
    setSelectedMentions((prev) => mergeMentions(prev, [incoming]));
    setDraft((prev) => {
      if (prev.includes(`@${incoming.displayName}`)) {
        return prev;
      }
      const spacer = prev.length > 0 && !/\s$/u.test(prev) ? " " : "";
      return `${prev}${spacer}@${incoming.displayName} `;
    });
    props.onConsumeQuickMention();
    window.requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      }
    });
  }, [props.pendingQuickMention, props.onConsumeQuickMention]);

  // 与正文实时对齐微胶囊显示：若用户在输入框内手删了 `@昵称`，仅展示仍存在于正文中的被点名队友
  const activeChipMentions = useMemo(() => {
    const typed: MessageMention[] = [];
    for (const member of props.members) {
      const converted = memberToMention(member);
      if (converted !== null && containsMemberMention(draft, member.displayName)) {
        typed.push(converted);
      }
    }
    return mergeMentions(selectedMentions, typed).filter((m) =>
      containsMemberMention(draft, m.displayName),
    );
  }, [draft, props.members, selectedMentions]);

  const offlineMentionedAgents = useMemo(() => {
    const result: RoomMemberDto[] = [];
    for (const mention of activeChipMentions) {
      if (mention.kind !== "agent") {
        continue;
      }
      const member = agentMembers.find((m) => m.agentId === mention.agentId);
      if (member !== undefined && !isReachableNow(member)) {
        result.push(member);
      }
    }
    return result;
  }, [activeChipMentions, agentMembers]);

  const mentionTrigger = useMemo(
    () => (suggestDismissed ? null : detectMentionTrigger(draft, caretIndex)),
    [draft, caretIndex, suggestDismissed],
  );

  const suggestions: ReadonlyArray<MentionCandidate> = useMemo(() => {
    if (mentionTrigger === null) {
      return [];
    }
    const q = mentionTrigger.query.toLowerCase();
    const list: MentionCandidate[] = [];
    if (agentMembers.length >= 2 && ("全体".includes(q) || "all".includes(q) || q.length === 0)) {
      list.push({
        key: "all-agents",
        kind: "all",
        label: "全体",
        sublabel: `同时叫醒群内 ${String(agentMembers.length)} 个 Agent`,
        dotClass: null,
        mention: null,
      });
    }
    for (const member of [...agentMembers, ...humanMembers]) {
      if (!member.displayName.toLowerCase().includes(q)) {
        continue;
      }
      const mention = memberToMention(member);
      if (mention === null) {
        continue;
      }
      const isAgent = member.memberKind === "agent";
      list.push({
        key: mentionIdentityKey(mention),
        kind: isAgent ? "agent" : "human",
        label: member.displayName,
        sublabel: isAgent
          ? `${member.ownerDisplayName} 的 Agent · ${getReachVisualMeta(member.reach).shortLabel}`
          : "群成员",
        dotClass: isAgent ? getReachVisualMeta(member.reach).dotClass : null,
        mention,
      });
    }
    return list.slice(0, MAX_MENTION_SUGGESTIONS);
  }, [mentionTrigger, agentMembers, humanMembers]);

  const isSuggestOpen = mentionTrigger !== null && suggestions.length > 0 && !pickerOpen;
  const safeActiveIndex = Math.min(activeSuggestIndex, Math.max(0, suggestions.length - 1));

  const allAgentMentions = useCallback((): ReadonlyArray<MessageMention> => {
    const result: MessageMention[] = [];
    for (const member of agentMembers) {
      const converted = memberToMention(member);
      if (converted !== null) {
        result.push(converted);
      }
    }
    return result;
  }, [agentMembers]);

  /** 用联想候选项替换光标前的 `@查询词` 并登记结构化提及 */
  const applySuggestion = (candidate: MentionCandidate): void => {
    if (mentionTrigger === null) {
      return;
    }
    const targets =
      candidate.kind === "all"
        ? allAgentMentions()
        : candidate.mention !== null
          ? [candidate.mention]
          : [];
    if (targets.length === 0) {
      return;
    }
    const tagsToInsert =
      candidate.kind === "all"
        ? targets.filter((t) => !draft.includes(`@${t.displayName}`))
        : targets;
    const insertText =
      tagsToInsert.length > 0 ? `${tagsToInsert.map((t) => `@${t.displayName}`).join(" ")} ` : "";
    const nextDraft =
      draft.slice(0, mentionTrigger.start) + insertText + draft.slice(mentionTrigger.end);
    setDraft(nextDraft);
    setSelectedMentions((prev) => mergeMentions(prev, targets));
    setActiveSuggestIndex(0);
    focusAt(mentionTrigger.start + insertText.length);
  };

  const toggleMention = (target: MessageMention): void => {
    const targetKey = mentionIdentityKey(target);
    const inDraft = draft.includes(`@${target.displayName}`);
    if (inDraft) {
      // 移除胶囊时同步剥离正文中的 `@昵称`，维持「所见即所派发」不变量
      setSelectedMentions((prev) => prev.filter((m) => mentionIdentityKey(m) !== targetKey));
      setDraft((prev) =>
        prev.replace(`@${target.displayName} `, "").replace(`@${target.displayName}`, ""),
      );
      window.requestAnimationFrame(() => textareaRef.current?.focus());
      return;
    }
    setSelectedMentions((prev) => mergeMentions(prev, [target]));
    setDraft((prev) => {
      const spacer = prev.length > 0 && !/\s$/u.test(prev) ? " " : "";
      return `${prev}${spacer}@${target.displayName} `;
    });
    window.requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      }
    });
  };

  const handleMentionAllAgents = (): void => {
    const targets = allAgentMentions();
    if (targets.length === 0) {
      return;
    }
    setSelectedMentions((prev) => mergeMentions(prev, targets));
    const missingTags = targets
      .filter((m) => !draft.includes(`@${m.displayName}`))
      .map((m) => `@${m.displayName}`)
      .join(" ");
    if (missingTags.length > 0) {
      setDraft((prev) => {
        const spacer = prev.length > 0 && !/\s$/u.test(prev) ? " " : "";
        return `${prev}${spacer}${missingTags} `;
      });
    }
    setPickerOpen(false);
    window.requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      }
    });
  };

  const submitMessage = (): void => {
    const trimmed = draft.trim();
    if (trimmed.length === 0 || props.isSending) {
      return;
    }

    // 最终提及集合严格与正文中保留的 `@昵称` 求交集，防止幽灵唤醒
    const typedMentions: MessageMention[] = [];
    for (const member of props.members) {
      const converted = memberToMention(member);
      if (converted !== null && containsMemberMention(trimmed, member.displayName)) {
        typedMentions.push(converted);
      }
    }
    const finalMentions = mergeMentions(selectedMentions, typedMentions).filter((m) =>
      containsMemberMention(trimmed, m.displayName),
    );

    const opKey = createClientOperationKey();
    const replySeq = props.replyTarget?.seq;

    props.onSendMessage({
      content: trimmed,
      opKey,
      ...(replySeq !== undefined ? { replyToSeq: replySeq } : {}),
      mentions: finalMentions,
      onConfirmedOrQueued: () => {
        setDraft("");
        setSelectedMentions([]);
        setCaretIndex(0);
        props.onClearReplyTarget();
      },
    });
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    // 中文等输入法候选词上屏过程中按 Enter 不触发误发送或误选联想项
    if (event.nativeEvent.isComposing) {
      return;
    }
    if (isSuggestOpen) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveSuggestIndex((safeActiveIndex + 1) % suggestions.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveSuggestIndex((safeActiveIndex - 1 + suggestions.length) % suggestions.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        const candidate = suggestions[safeActiveIndex];
        if (candidate) {
          event.preventDefault();
          applySuggestion(candidate);
          return;
        }
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setSuggestDismissed(true);
        return;
      }
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

  const canSend = draft.trim().length > 0 && !props.isSending;
  const hasAnyTeammate = agentMembers.length > 0 || humanMembers.length > 0;

  return (
    <footer className="glass-bar app-no-drag relative z-10 shrink-0 px-4 pt-2 pb-[max(1rem,env(safe-area-inset-bottom))] sm:px-6">
      <div className="relative mx-auto max-w-3xl">
        {/* 1. 发送异常告警条（草稿完整保留） */}
        <AnimatePresence initial={false}>
          {errorText !== null ? (
            <motion.div
              key="send-error-banner"
              role="alert"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 4 }}
              transition={{ duration: 0.16 }}
              className="mb-2 rounded-2xl bg-[#FF3B30]/10 px-3.5 py-2 text-xs font-medium text-[#D70015] dark:bg-[#FF453A]/15 dark:text-[#FF6961]"
            >
              发送失败（草稿已保留）：{errorText}
            </motion.div>
          ) : null}
          {offlineMentionedAgents.length > 0 ? (
            <motion.div
              key="offline-agent-hint"
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 2 }}
              transition={{ duration: 0.14 }}
              className="mb-2 flex flex-wrap items-center justify-between gap-2 rounded-2xl bg-[#FFF8E6] px-3.5 py-2 text-xs text-[#5C4813] ring-1 ring-inset ring-black/[0.05] dark:bg-[#241F14] dark:text-[#F2DF9D] dark:ring-white/[0.08]"
            >
              <span>
                {offlineMentionedAgents.map((m) => `@${m.displayName}`).join("、")}{" "}
                当前未开启本地监听（离线），发出后会在它上线时自动补回。
              </span>
              {(() => {
                const reconnectableOwn = offlineMentionedAgents.find(
                  (m) =>
                    m.agentId !== undefined &&
                    (props.currentUserId === undefined || m.ownerUserId === props.currentUserId),
                );
                if (
                  props.onReconnectOfflineAgent === undefined ||
                  reconnectableOwn?.agentId === undefined
                ) {
                  return null;
                }
                const targetId = reconnectableOwn.agentId;
                return (
                  <button
                    type="button"
                    onClick={() => props.onReconnectOfflineAgent?.(targetId)}
                    className="shrink-0 cursor-pointer rounded-full bg-[#141414] px-2.5 py-1 text-[11px] font-medium text-white transition hover:bg-black dark:bg-[#F5F5F7] dark:text-[#141414] dark:hover:bg-white"
                  >
                    重连开启监听
                  </button>
                );
              })()}
            </motion.div>
          ) : null}
        </AnimatePresence>

        {/* 2. 行内手打 `@` 触发的键盘联想浮层 */}
        <AnimatePresence>
          {isSuggestOpen ? (
            <motion.div
              key="inline-mention-popover"
              aria-label="选择要 @ 的成员"
              initial={{ opacity: 0, y: 6, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 4, scale: 0.98 }}
              transition={{ type: "spring", stiffness: 520, damping: 36 }}
              className="absolute right-0 bottom-full left-0 z-30 mb-2 max-w-sm overflow-hidden rounded-2xl border border-black/[0.08] bg-white p-1.5 shadow-[0_18px_48px_rgba(0,0,0,0.12)] dark:border-white/[0.1] dark:bg-[#18181B] dark:shadow-[0_20px_52px_rgba(0,0,0,0.65)]"
            >
              <div className="px-2.5 pt-1 pb-1.5 text-[11px] font-medium text-[#8E8E93] dark:text-zinc-500">
                选择要提及的对象 · ↑↓ 切换 · Enter 确认
              </div>
              <div className="space-y-0.5">
                {suggestions.map((candidate, idx) => {
                  const isActive = idx === safeActiveIndex;
                  return (
                    <button
                      key={candidate.key}
                      type="button"
                      aria-current={isActive ? "true" : undefined}
                      onMouseDown={(e) => {
                        // 使用 mousedown + preventDefault，避免 textarea 先失焦导致浮层卸载、点击丢失
                        e.preventDefault();
                        applySuggestion(candidate);
                      }}
                      onMouseEnter={() => setActiveSuggestIndex(idx)}
                      className={cn(
                        "flex w-full cursor-pointer items-center gap-2.5 rounded-xl px-2.5 py-1.5 text-left transition-colors",
                        isActive
                          ? "bg-[#F5F5F7] text-[#141414] dark:bg-white/[0.1] dark:text-zinc-100"
                          : "text-[#3A3A3C] hover:bg-black/[0.03] dark:text-zinc-200 dark:hover:bg-white/[0.05]",
                      )}
                    >
                      <span
                        className={cn(
                          "relative flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold",
                          candidate.kind === "all"
                            ? "bg-[#141414] text-white dark:bg-[#F5F5F7] dark:text-[#141414]"
                            : candidate.kind === "agent"
                              ? "bg-[#EFEFF3] text-[#141414] dark:bg-white/[0.1] dark:text-zinc-200"
                              : "bg-[#E3F3EC] text-[#1B452D] dark:bg-[#16271F] dark:text-[#C7E8D3]",
                        )}
                      >
                        {candidate.kind === "all" ? (
                          <Users className="h-3.5 w-3.5" />
                        ) : (
                          candidate.label.slice(0, 1).toUpperCase()
                        )}
                        {candidate.dotClass !== null ? (
                          <span
                            className={cn(
                              "absolute -right-0.5 -bottom-0.5 h-2 w-2 rounded-full ring-2 ring-white dark:ring-[#18181B]",
                              candidate.dotClass,
                            )}
                          />
                        ) : null}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs font-semibold">
                          @{candidate.label}
                        </span>
                        <span className="block truncate text-[10.5px] text-[#6E6E73] dark:text-zinc-400">
                          {candidate.sublabel}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>

        {/* 3. 输入卡上方：20px 迷你用户头像 + `以 <名字> 的身份发言` + 行内回复/提及胶囊 */}
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2 px-1">
          <div className="flex min-w-0 items-center gap-1.5 select-none">
            <PlatformAvatar
              kind="human"
              displayName={senderDisplayName}
              size="sm"
              className="[&>div]:h-5 [&>div]:w-5 [&>div]:rounded-full [&>div]:text-[9.5px]"
            />
            <span className="truncate text-[12.5px] text-[#5F5F64] dark:text-zinc-400">
              以 {senderDisplayName} 的身份发言
            </span>
          </div>

          {props.replyTarget !== null || activeChipMentions.length > 0 ? (
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              {props.replyTarget !== null ? (
                <span className="inline-flex max-w-[16rem] items-center gap-1.5 rounded-full bg-[#F5F5F7] py-0.5 pr-1 pl-2.5 text-[11.5px] text-[#141414] dark:bg-white/[0.08] dark:text-zinc-200">
                  <CornerUpLeft className="h-3 w-3 shrink-0 text-[#6E6E73] dark:text-zinc-400" />
                  <span className="truncate">
                    回复 <strong>{props.replyTarget.author.displayName}</strong>：
                    {props.replyTarget.content.replace(/\s+/gu, " ").slice(0, 42)}
                  </span>
                  <button
                    type="button"
                    aria-label="取消引用回复"
                    onClick={props.onClearReplyTarget}
                    className="inline-flex h-4 w-4 shrink-0 cursor-pointer items-center justify-center rounded-full text-[#6E6E73] transition hover:bg-black/10 hover:text-[#141414] dark:text-zinc-400 dark:hover:bg-white/15 dark:hover:text-white"
                  >
                    <X className="h-2.5 w-2.5" />
                  </button>
                </span>
              ) : null}

              {activeChipMentions.map((mention) => {
                const isAgent = mention.kind === "agent";
                return (
                  <span
                    key={mentionIdentityKey(mention)}
                    className={cn(
                      "inline-flex items-center gap-1 rounded-full py-0.5 pr-1 pl-2 text-[11.5px] font-medium",
                      isAgent
                        ? "bg-[#F5F5F7] text-[#141414] dark:bg-white/[0.08] dark:text-zinc-200"
                        : "bg-[#E3F3EC] text-[#1B452D] dark:bg-[#16271F] dark:text-[#C7E8D3]",
                    )}
                  >
                    <span className="max-w-[8.5rem] truncate">@{mention.displayName}</span>
                    <button
                      type="button"
                      aria-label={`移除点名 @${mention.displayName}`}
                      onClick={() => toggleMention(mention)}
                      className="inline-flex h-4 w-4 cursor-pointer items-center justify-center rounded-full transition hover:bg-black/10 dark:hover:bg-white/15"
                    >
                      <X className="h-2.5 w-2.5" />
                    </button>
                  </span>
                );
              })}
            </div>
          ) : null}
        </div>

        {/* 4. Pachat `rounded-[20px]` 输入卡主体 */}
        <div className="rounded-[20px] border border-black/[0.13] bg-white px-4 pt-3 pb-2.5 transition focus-within:border-[#141414] focus-within:shadow-[0_0_0_4px_rgba(0,0,0,0.05)] dark:border-white/[0.13] dark:bg-[#18181B] dark:focus-within:border-white/35 dark:focus-within:shadow-[0_0_0_4px_rgba(255,255,255,0.04)]">
          <textarea
            ref={textareaRef}
            rows={1}
            maxLength={16_000}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setCaretIndex(e.target.selectionStart);
              setSuggestDismissed(false);
              setActiveSuggestIndex(0);
            }}
            onSelect={(e) => setCaretIndex(e.currentTarget.selectionStart)}
            onBlur={() => setSuggestDismissed(true)}
            onFocus={() => setSuggestDismissed(false)}
            onKeyDown={handleKeyDown}
            aria-label={`在 ${props.roomName} 发言`}
            placeholder="以你自己的身份说点什么"
            className="block max-h-[168px] min-h-[28px] w-full resize-none border-0 bg-transparent p-0 text-[15px] leading-[1.48] text-[#141414] caret-[#141414] outline-none placeholder:text-[#8E8E93] dark:text-zinc-100 dark:caret-zinc-100 dark:placeholder:text-zinc-500"
          />

          {/* 卡内底部工具行：左 18px `@` 按钮 + 可选 `@全体` 胶囊；右 32px 墨黑圆形发送键 */}
          <div className="mt-2 flex select-none items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-1.5">
              <AppPopover
                open={pickerOpen}
                onOpenChange={setPickerOpen}
                side="top"
                align="start"
                className="w-72 p-2"
                trigger={
                  <button
                    type="button"
                    disabled={!hasAnyTeammate}
                    title="提及群内 Agent 或成员"
                    aria-label="提及群内 Agent 或成员"
                    className={cn(
                      "app-no-drag inline-flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full transition-colors active:scale-[0.95] disabled:cursor-not-allowed disabled:opacity-40",
                      pickerOpen
                        ? "bg-[#EFEFF3] text-[#141414] dark:bg-white/[0.12] dark:text-white"
                        : "text-[#5F5F64] hover:bg-black/[0.05] hover:text-[#141414] dark:text-zinc-400 dark:hover:bg-white/[0.08] dark:hover:text-zinc-100",
                    )}
                  >
                    <AtSign className="h-[18px] w-[18px] stroke-[1.9]" />
                  </button>
                }
              >
                <div className="space-y-1">
                  <div className="flex items-center justify-between px-2 py-1">
                    <span className="text-[11.5px] font-medium text-[#6E6E73] dark:text-zinc-400">
                      提及群成员
                    </span>
                    <span className="text-[11px] font-medium text-[#215236] dark:text-[#86E0A6]">
                      {onlineAgentCount}/{agentMembers.length} 个 Agent 在线
                    </span>
                  </div>

                  {agentMembers.length >= 2 ? (
                    <button
                      type="button"
                      onClick={handleMentionAllAgents}
                      className="flex w-full cursor-pointer items-center gap-2.5 rounded-xl bg-[#F5F5F7] px-2.5 py-2 text-left text-xs font-medium text-[#141414] transition hover:bg-[#EBEBEF] dark:bg-white/[0.07] dark:text-zinc-100 dark:hover:bg-white/[0.12]"
                    >
                      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[#141414] text-white dark:bg-[#F5F5F7] dark:text-[#141414]">
                        <Users className="h-3.5 w-3.5" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-semibold">@全体 Agent</span>
                        <span className="block text-[10.5px] text-[#6E6E73] dark:text-zinc-400">
                          同时叫醒全部 {agentMembers.length} 个 Agent 参与讨论
                        </span>
                      </span>
                    </button>
                  ) : null}

                  <div className="max-h-56 space-y-0.5 overflow-y-auto pt-0.5">
                    {agentMembers.map((member) => {
                      const mentionObj = memberToMention(member);
                      if (mentionObj === null) {
                        return null;
                      }
                      const checked = draft.includes(`@${member.displayName}`);
                      const reachMeta = getReachVisualMeta(member.reach);
                      return (
                        <button
                          key={`pop-agt-${member.agentId ?? member.displayName}`}
                          type="button"
                          onClick={() => toggleMention(mentionObj)}
                          className={cn(
                            "flex w-full cursor-pointer items-center gap-2.5 rounded-xl px-2.5 py-1.5 text-left transition-colors",
                            checked
                              ? "bg-[#F5F5F7] text-[#141414] dark:bg-white/[0.1] dark:text-zinc-100"
                              : "text-[#3A3A3C] hover:bg-black/[0.035] dark:text-zinc-200 dark:hover:bg-white/[0.05]",
                          )}
                        >
                          <span className="relative flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[#EFEFF3] text-[11px] font-semibold text-[#141414] dark:bg-white/[0.1] dark:text-zinc-200">
                            {member.displayName.slice(0, 1).toUpperCase()}
                            <span
                              className={cn(
                                "absolute -right-0.5 -bottom-0.5 h-2 w-2 rounded-full ring-2 ring-white dark:ring-[#18181B]",
                                reachMeta.dotClass,
                              )}
                            />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-xs font-semibold">
                              @{member.displayName}
                            </span>
                            <span className="block truncate text-[10.5px] text-[#6E6E73] dark:text-zinc-400">
                              {member.ownerDisplayName} 的 Agent · {reachMeta.shortLabel}
                            </span>
                          </span>
                          {checked ? (
                            <Check className="h-3.5 w-3.5 shrink-0 text-[#141414] dark:text-zinc-100" />
                          ) : null}
                        </button>
                      );
                    })}

                    {humanMembers.map((member) => {
                      const mentionObj = memberToMention(member);
                      if (mentionObj === null) {
                        return null;
                      }
                      const checked = draft.includes(`@${member.displayName}`);
                      return (
                        <button
                          key={`pop-usr-${member.userId ?? member.displayName}`}
                          type="button"
                          onClick={() => toggleMention(mentionObj)}
                          className={cn(
                            "flex w-full cursor-pointer items-center gap-2.5 rounded-xl px-2.5 py-1.5 text-left transition-colors",
                            checked
                              ? "bg-[#E3F3EC] text-[#1B452D] dark:bg-[#16271F] dark:text-[#C7E8D3]"
                              : "text-[#3A3A3C] hover:bg-black/[0.035] dark:text-zinc-200 dark:hover:bg-white/[0.05]",
                          )}
                        >
                          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[#E3F3EC] text-[#1B452D] dark:bg-[#16271F] dark:text-[#C7E8D3]">
                            <User className="h-3.5 w-3.5" />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-xs font-semibold">
                              @{member.displayName}
                            </span>
                            <span className="block truncate text-[10.5px] text-[#6E6E73] dark:text-zinc-400">
                              群成员
                            </span>
                          </span>
                          {checked ? (
                            <Check className="h-3.5 w-3.5 shrink-0 text-[#215236] dark:text-[#86E0A6]" />
                          ) : null}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </AppPopover>

              {agentMembers.length >= 2 ? (
                <button
                  type="button"
                  onClick={handleMentionAllAgents}
                  title="同时点名群内所有 Agent"
                  className="inline-flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-full bg-[#F5F5F7] px-2.5 text-[12px] font-medium text-[#141414] transition-colors hover:bg-[#EBEBEF] active:scale-[0.97] dark:bg-white/[0.07] dark:text-zinc-200 dark:hover:bg-white/[0.12]"
                >
                  <span>@全体</span>
                </button>
              ) : null}
            </div>

            <AppTooltip side="top" content="发送消息" shortcut="Enter">
              <motion.button
                type="button"
                disabled={!canSend}
                onClick={submitMessage}
                {...(canSend ? { whileTap: { scale: 0.92 } } : {})}
                transition={{ type: "spring", stiffness: 560, damping: 30 }}
                aria-label="发送消息"
                className={cn(
                  "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-colors focus-visible:ring-2 focus-visible:ring-black/25 focus-visible:outline-none dark:focus-visible:ring-white/35",
                  canSend
                    ? "cursor-pointer bg-[#141414] text-white hover:bg-black dark:bg-[#F5F5F7] dark:text-[#141414] dark:hover:bg-white"
                    : "cursor-not-allowed bg-black/15 text-white dark:bg-white/15 dark:text-zinc-500",
                )}
              >
                {props.isSending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <ArrowUp className="h-4 w-4 stroke-[2.4]" />
                )}
              </motion.button>
            </AppTooltip>
          </div>
        </div>
      </div>
    </footer>
  );
}
