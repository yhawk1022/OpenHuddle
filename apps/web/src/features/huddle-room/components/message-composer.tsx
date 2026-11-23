/**
 * @module web/features/huddle-room/message-composer
 * @description Apple Liquid Glass 悬浮液态玻璃消息输入舱（Floating Liquid Glass Composer Capsule）：
 * 摒弃横跨聊天区的生硬白边分割线，以 `rounded-[24px]` `liquid-glass-composer` 悬浮胶囊形态停驻于舞台底部；
 * 内部整合行内可清除的引用回复与 `@提及` 微胶囊、自适应高度文本域、键盘 `@` 联想重玻璃浮层、
 * 底部工具栏（`@` 队友面板、提问模式开关、`@全体` 快捷胶囊、本人发言身份微标）与圆形高对比发送键。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 结构化提及严格对齐：无论通过 `@` 浮层点选、`@全体` 胶囊、行内键盘联想还是手打精确昵称，
 *    最终提交的 `MessageMention[]` 只包含正文中仍真实保留 `@昵称` 的成员，杜绝删字后派发幽灵 `wake` 事件。
 * 2. 乐观防丢字：提交前生成唯一幂等 `OperationKey`；网络或治理拦截异常时草稿完整保留并展示错误提示。
 * 3. 暗色光学协调与点击穿透：外层渐变遮罩设为 `pointer-events-none`，仅悬浮玻璃输入舱与浮层开启 `pointer-events-auto`；暗色下保持中性烟熏石墨半透玻璃，绝不触发白底白字。
 */
import type {
  AgentId,
  MessageDto,
  MessageMention,
  MessageSeq,
  OperationKey,
  RoomKind,
  RoomMemberDto,
  UserId,
} from "@openhuddle/protocol";
import { ArrowUp, AtSign, Check, CornerUpLeft, Hand, Loader2, User, Users, X } from "lucide-react";
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
  readonly roomKind?: RoomKind | undefined;
  readonly members: ReadonlyArray<RoomMemberDto>;
  readonly currentUserId?: UserId | undefined;
  /** 当前登录用户的展示昵称（用于渲染输入舱内本人发言身份提示） */
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
    /** ADR-0002：提问模式开启时以 attention 消息发出（等人类作答，默认 24h 过期） */
    readonly attention?: { readonly question: string; readonly addresseeUserIds: UserId[] };
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

/**
 * 从正文中按成员昵称长度降序做贪心不重叠区间匹配，精确提取真实出现的 `@昵称` 成员集合。
 *
 * @remarks
 * 避免在 `@主人名-Agent名`（如 `@庞彦-OpenAICodex`）场景下，短前缀 `@庞彦` 被误识别为同时提及人类主人。
 */
function extractPresentRoomMentions(
  text: string,
  members: ReadonlyArray<RoomMemberDto>,
): ReadonlyArray<MessageMention> {
  const lower = text.toLowerCase();
  const matched: MessageMention[] = [];
  const claimedSpans: Array<{ readonly start: number; readonly end: number }> = [];

  const sortedMembers = [...members].sort((a, b) => b.displayName.length - a.displayName.length);

  for (const member of sortedMembers) {
    const normalized = member.displayName.trim().toLowerCase();
    if (normalized.length === 0) {
      continue;
    }
    const needle = `@${normalized}`;
    let foundUnclaimed = false;
    let searchFrom = 0;

    while (searchFrom < lower.length) {
      const idx = lower.indexOf(needle, searchFrom);
      if (idx === -1) {
        break;
      }
      const end = idx + needle.length;
      const overlaps = claimedSpans.some((span) => idx < span.end && end > span.start);
      if (!overlaps) {
        claimedSpans.push({ start: idx, end });
        foundUnclaimed = true;
      }
      searchFrom = idx + 1;
    }

    if (foundUnclaimed) {
      const converted = memberToMention(member);
      if (converted !== null) {
        matched.push(converted);
      }
    }
  }

  return matched;
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
 * 渲染悬浮 Apple Liquid Glass 底部消息输入舱。
 *
 * @param props - 群成员列表、当前用户昵称、回复目标与乐观发送回调
 * @returns 底部液态玻璃聊天输入舱组件
 */
export function MessageComposer(props: MessageComposerProps) {
  const [draft, setDraft] = useState<string>("");
  const [selectedMentions, setSelectedMentions] = useState<ReadonlyArray<MessageMention>>([]);
  const [caretIndex, setCaretIndex] = useState<number>(0);
  const [suggestDismissed, setSuggestDismissed] = useState<boolean>(false);
  const [activeSuggestIndex, setActiveSuggestIndex] = useState<number>(0);
  // ADR-0002：提问模式——开启后本条消息以 attention（等人类作答）形式发出
  const [askMode, setAskMode] = useState<boolean>(false);
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
    const presentMentions = extractPresentRoomMentions(draft, props.members);
    const presentKeys = new Set(presentMentions.map(mentionIdentityKey));
    return mergeMentions(selectedMentions, presentMentions).filter((m) =>
      presentKeys.has(mentionIdentityKey(m)),
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
    const inDraft = activeChipMentions.some((m) => mentionIdentityKey(m) === targetKey);
    if (inDraft) {
      // 移除胶囊时仅剥离非更长昵称前缀的独立 `@昵称`，避免删 `@庞彦` 时误截断 `@庞彦-OpenAICodex`
      setSelectedMentions((prev) => prev.filter((m) => mentionIdentityKey(m) !== targetKey));
      const escaped = target.displayName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const tokenRegex = new RegExp(`@${escaped}(?![-\\w])\\s?`, "iu");
      setDraft((prev) => prev.replace(tokenRegex, ""));
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

    // 最终提及集合严格与正文中保留的 `@昵称` 求交集，防止幽灵唤醒或前缀误命中
    const presentMentions = extractPresentRoomMentions(trimmed, props.members);
    const presentKeys = new Set(presentMentions.map(mentionIdentityKey));
    const finalMentions = mergeMentions(selectedMentions, presentMentions).filter((m) =>
      presentKeys.has(mentionIdentityKey(m)),
    );

    const opKey = createClientOperationKey();
    const replySeq = props.replyTarget?.seq;

    // ADR-0002 提问模式：以结构化 attention 消息发出，收件人默认为房间内全部人类成员
    const humanMemberIds = props.members
      .filter((m) => m.memberKind === "human" && m.userId !== undefined)
      .map((m) => m.userId as UserId);

    props.onSendMessage({
      content: trimmed,
      opKey,
      ...(replySeq !== undefined ? { replyToSeq: replySeq } : {}),
      mentions: finalMentions,
      ...(askMode && humanMemberIds.length > 0
        ? { attention: { question: trimmed, addresseeUserIds: humanMemberIds } }
        : {}),
      onConfirmedOrQueued: () => {
        setDraft("");
        setAskMode(false);
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
  const effectiveKind: RoomKind = props.roomKind ?? "group";
  const hasAnyTeammate =
    effectiveKind === "group" && (agentMembers.length > 0 || humanMembers.length > 0);
  const hasContextChips = props.replyTarget !== null || activeChipMentions.length > 0;
  const composerPlaceholder =
    effectiveKind === "direct_agent"
      ? `发消息给 ${props.roomName}…（1v1 单聊直接唤醒，无需输入 @）`
      : effectiveKind === "direct_human"
        ? `发消息给 ${props.roomName}…`
        : `以 ${senderDisplayName} 的身份说点什么…（输入 @ 点名队友）`;

  return (
    <footer className="app-no-drag pointer-events-none relative z-10 shrink-0 bg-gradient-to-t from-[var(--oh-stage-scrim)] via-[var(--oh-stage-scrim-mid)] to-transparent px-3 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-5">
      <div className="relative mx-auto max-w-3xl">
        {/* 1. 发送异常告警或离线 Agent 自动补回提示胶囊（草稿完整保留） */}
        <AnimatePresence initial={false}>
          {errorText !== null ? (
            <motion.div
              key="send-error-banner"
              role="alert"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 4 }}
              transition={{ duration: 0.16 }}
              className="pointer-events-auto relative liquid-glass-bar mb-2 overflow-hidden rounded-[18px]"
            >
              <div className="bg-[#E5484D]/[0.10] px-3.5 py-2 text-xs font-medium text-[#C81E1E] dark:bg-[#F05252]/[0.14] dark:text-[#FCA5A5]">
                发送失败（草稿已保留）：{errorText}
              </div>
            </motion.div>
          ) : null}
          {offlineMentionedAgents.length > 0 ? (
            <motion.div
              key="offline-agent-hint"
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 2 }}
              transition={{ duration: 0.14 }}
              className="pointer-events-auto relative liquid-glass-bar mb-2 overflow-hidden rounded-[18px]"
            >
              <div className="flex flex-wrap items-center justify-between gap-2 bg-amber-500/[0.08] px-3.5 py-2 text-xs text-[#6B4E12] dark:bg-amber-400/[0.08] dark:text-[#F5DF9D]">
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
                      className="shrink-0 cursor-pointer rounded-full bg-[#181B22] px-2.5 py-1 text-[11px] font-medium text-white transition hover:bg-[#252A35] dark:bg-[#EAEEF6] dark:text-[#111318] dark:hover:bg-white"
                    >
                      重连开启监听
                    </button>
                  );
                })()}
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>

        {/* 2. 行内手打 `@` 触发的键盘联想重玻璃浮层 */}
        <AnimatePresence>
          {isSuggestOpen ? (
            <motion.div
              key="inline-mention-popover"
              aria-label="选择要 @ 的成员"
              initial={{ opacity: 0, y: 6, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 4, scale: 0.98 }}
              transition={{ type: "spring", stiffness: 520, damping: 36 }}
              className="pointer-events-auto absolute right-0 bottom-full left-0 z-30 mb-2 max-w-sm overflow-hidden rounded-[20px] p-1.5 liquid-glass-modal"
            >
              <div className="px-2.5 pt-1 pb-1.5 text-[11px] font-medium text-[#687082] dark:text-[#8E8E96]">
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
                          ? "bg-black/[0.06] text-[#111318] dark:bg-white/[0.11] dark:text-[#F2F2F4]"
                          : "text-[#3B414E] hover:bg-black/[0.035] dark:text-[#C4C4CA] dark:hover:bg-white/[0.06]",
                      )}
                    >
                      <span
                        className={cn(
                          "relative flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold",
                          candidate.kind === "all"
                            ? "bg-[#181B22] text-white dark:bg-[#EAEEF6] dark:text-[#111318]"
                            : candidate.kind === "agent"
                              ? "bg-black/[0.06] text-[#111318] dark:bg-white/[0.10] dark:text-[#ECECEF]"
                              : "bg-[#E6F5EC] text-[#145335] dark:bg-[#1B2B23] dark:text-[#A7F3D0]",
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
                              "absolute -right-0.5 -bottom-0.5 h-2 w-2 rounded-full ring-2 ring-white dark:ring-[#1E1E22]",
                              candidate.dotClass,
                            )}
                          />
                        ) : null}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs font-semibold">
                          @{candidate.label}
                        </span>
                        <span className="block truncate text-[10.5px] text-[#687082] dark:text-[#8E8E96]">
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

        {/* 3. Apple Liquid Glass 悬浮输入舱主体 */}
        <div className="pointer-events-auto relative liquid-glass-composer rounded-[24px] px-4 pt-3 pb-2.5">
          {/* 舱内顶部上下文微胶囊条（引用回复 & 已点名成员，无内容时完全不占高度） */}
          {hasContextChips ? (
            <div className="mb-2 flex min-w-0 flex-wrap items-center gap-1.5 border-b border-black/[0.06] pb-2 dark:border-white/[0.07]">
              {props.replyTarget !== null ? (
                <span className="inline-flex max-w-[18rem] items-center gap-1.5 rounded-full bg-black/[0.05] py-0.5 pr-1 pl-2.5 text-[11.5px] text-[#111318] dark:bg-white/[0.08] dark:text-[#ECECEF]">
                  <CornerUpLeft className="h-3 w-3 shrink-0 text-[#687082] dark:text-[#8E8E96]" />
                  <span className="truncate">
                    回复 <strong>{props.replyTarget.author.displayName}</strong>：
                    {props.replyTarget.content.replace(/\s+/gu, " ").slice(0, 42)}
                  </span>
                  <button
                    type="button"
                    aria-label="取消引用回复"
                    onClick={props.onClearReplyTarget}
                    className="inline-flex h-4 w-4 shrink-0 cursor-pointer items-center justify-center rounded-full text-[#687082] transition hover:bg-black/10 hover:text-[#111318] dark:text-[#8E8E96] dark:hover:bg-white/15 dark:hover:text-white"
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
                        ? "bg-black/[0.05] text-[#111318] dark:bg-white/[0.08] dark:text-[#ECECEF]"
                        : "bg-[#E6F5EC] text-[#145335] dark:bg-[#1B2B23] dark:text-[#A7F3D0]",
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
            placeholder={composerPlaceholder}
            className="block max-h-[168px] min-h-[26px] w-full resize-none border-0 bg-transparent p-0 text-[14.5px] leading-[1.5] text-[#111318] caret-[#111318] outline-none placeholder:text-[#8E96A6] dark:text-[#F2F2F4] dark:caret-[#F2F2F4] dark:placeholder:text-[#63636B]"
          />

          {/* 舱内底部工具栏：左侧 `@` 点名、提问模式、`@全体` 与身份微标；右侧圆形发送键 */}
          <div className="mt-2 flex select-none items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-1.5">
              {effectiveKind === "group" ? (
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
                          ? "bg-black/[0.08] text-[#111318] dark:bg-white/[0.14] dark:text-white"
                          : "text-[#687082] hover:bg-black/[0.05] hover:text-[#111318] dark:text-[#8E8E96] dark:hover:bg-white/[0.08] dark:hover:text-[#F2F2F4]",
                      )}
                    >
                      <AtSign className="h-[17px] w-[17px] stroke-[1.9]" />
                    </button>
                  }
                >
                  <div className="space-y-1">
                    <div className="flex items-center justify-between px-2 py-1">
                      <span className="text-[11.5px] font-medium text-[#687082] dark:text-[#8E8E96]">
                        提及群成员
                      </span>
                      <span className="text-[11px] font-medium text-[#16A34A] dark:text-[#34D399]">
                        {onlineAgentCount}/{agentMembers.length} 个 Agent 在线
                      </span>
                    </div>

                    {agentMembers.length >= 2 ? (
                      <button
                        type="button"
                        onClick={handleMentionAllAgents}
                        className="flex w-full cursor-pointer items-center gap-2.5 rounded-xl bg-black/[0.04] px-2.5 py-2 text-left text-xs font-medium text-[#111318] transition hover:bg-black/[0.07] dark:bg-white/[0.06] dark:text-[#F2F2F4] dark:hover:bg-white/[0.11]"
                      >
                        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[#181B22] text-white dark:bg-[#EAEEF6] dark:text-[#111318]">
                          <Users className="h-3.5 w-3.5" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-semibold">@全体 Agent</span>
                          <span className="block text-[10.5px] text-[#687082] dark:text-[#8E8E96]">
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
                                ? "bg-black/[0.06] text-[#111318] dark:bg-white/[0.10] dark:text-[#F2F2F4]"
                                : "text-[#3B414E] hover:bg-black/[0.035] dark:text-[#C4C4CA] dark:hover:bg-white/[0.06]",
                            )}
                          >
                            <span className="relative flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-black/[0.06] text-[11px] font-semibold text-[#111318] dark:bg-white/[0.10] dark:text-[#ECECEF]">
                              {member.displayName.slice(0, 1).toUpperCase()}
                              <span
                                className={cn(
                                  "absolute -right-0.5 -bottom-0.5 h-2 w-2 rounded-full ring-2 ring-white dark:ring-[#1E1E22]",
                                  reachMeta.dotClass,
                                )}
                              />
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-xs font-semibold">
                                @{member.displayName}
                              </span>
                              <span className="block truncate text-[10.5px] text-[#687082] dark:text-[#8E8E96]">
                                {member.ownerDisplayName} 的 Agent · {reachMeta.shortLabel}
                              </span>
                            </span>
                            {checked ? (
                              <Check className="h-3.5 w-3.5 shrink-0 text-[#111318] dark:text-[#F2F2F4]" />
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
                                ? "bg-[#E6F5EC] text-[#145335] dark:bg-[#1B2B23] dark:text-[#A7F3D0]"
                                : "text-[#3B414E] hover:bg-black/[0.035] dark:text-[#C4C4CA] dark:hover:bg-white/[0.06]",
                            )}
                          >
                            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[#E6F5EC] text-[#145335] dark:bg-[#1B2B23] dark:text-[#A7F3D0]">
                              <User className="h-3.5 w-3.5" />
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-xs font-semibold">
                                @{member.displayName}
                              </span>
                              <span className="block truncate text-[10.5px] text-[#687082] dark:text-[#8E8E96]">
                                群成员
                              </span>
                            </span>
                            {checked ? (
                              <Check className="h-3.5 w-3.5 shrink-0 text-[#16A34A] dark:text-[#34D399]" />
                            ) : null}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </AppPopover>
              ) : null}

              {/* ADR-0002 提问模式开关：开启后本条消息以 attention 形式发出，等待人类作答 */}
              <button
                type="button"
                title={
                  askMode
                    ? "提问模式已开启：发送后将等待人类作答"
                    : "以提问形式发送（等待人类作答）"
                }
                aria-pressed={askMode}
                onClick={() => setAskMode((v) => !v)}
                className={cn(
                  "app-no-drag inline-flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full transition-colors active:scale-[0.95]",
                  askMode
                    ? "bg-amber-500/15 text-amber-700 ring-1 ring-amber-500/40 dark:text-amber-300"
                    : "text-[#687082] hover:bg-black/[0.05] hover:text-[#111318] dark:text-[#8E8E96] dark:hover:bg-white/[0.08] dark:hover:text-[#F2F2F4]",
                )}
              >
                <Hand className="h-[17px] w-[17px] stroke-[1.9]" />
              </button>
              {askMode ? (
                <span className="hidden select-none rounded-full bg-amber-500/12 px-2 py-0.5 text-[10.5px] font-medium text-amber-700 sm:inline dark:text-amber-300">
                  提问模式
                </span>
              ) : null}

              {agentMembers.length >= 2 ? (
                <button
                  type="button"
                  onClick={handleMentionAllAgents}
                  title="同时点名群内所有 Agent"
                  className="inline-flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-full bg-black/[0.05] px-2.5 text-[12px] font-medium text-[#181B22] transition-colors hover:bg-black/[0.09] active:scale-[0.97] dark:bg-white/[0.07] dark:text-[#ECECEF] dark:hover:bg-white/[0.12]"
                >
                  <span>@全体</span>
                </button>
              ) : null}

              {/* 安静的本人发言身份微标（宽屏展示，不额外挤占纵向对话空间） */}
              <div className="ml-1 hidden min-w-0 items-center gap-1.5 border-l border-black/[0.07] pl-2.5 sm:flex dark:border-white/[0.08]">
                <PlatformAvatar
                  kind="human"
                  displayName={senderDisplayName}
                  size="sm"
                  className="[&>div]:h-4.5 [&>div]:w-4.5 [&>div]:rounded-full [&>div]:text-[9px]"
                />
                <span className="max-w-[9rem] truncate text-[11.5px] text-[#687082] dark:text-[#8E8E96]">
                  {senderDisplayName}
                </span>
              </div>
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
                    ? "cursor-pointer bg-[#181B22] text-white shadow-xs hover:bg-[#252A35] dark:bg-[#EAEEF6] dark:text-[#111318] dark:hover:bg-white"
                    : "cursor-not-allowed bg-black/[0.08] text-black/30 dark:bg-white/[0.08] dark:text-white/25",
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
