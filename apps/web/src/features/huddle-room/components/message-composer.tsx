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
  SupportedLocale,
  UserId,
} from "@openhuddle/protocol";
import {
  ArrowUp,
  AtSign,
  Check,
  CornerUpLeft,
  FileText,
  FolderGit2,
  Hand,
  ListTodo,
  Loader2,
  Mic,
  Paperclip,
  Plus,
  Square,
  User,
  Users,
  X,
} from "lucide-react";
import {
  type ClipboardEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  AnimatePresence,
  AppPopover,
  AppTooltip,
  type SegmentedTabItem,
  SegmentedTabs,
  cn,
  motion,
  toast,
} from "../../../components/primitives/index.js";
import { PlatformAvatar } from "../../../components/ui/identity-badges.js";
import { ImageLightboxDialog } from "../../../components/ui/message-attachment.js";
import {
  type AgentExecutionTier,
  getExecutionTierMeta,
  useAgentCapabilityPrefs,
} from "../../../lib/agent-capability-prefs.js";
import { ApiClientError, roomMessageAttachmentPath } from "../../../lib/api-client.js";
import {
  createClientOperationKey,
  formatAttachmentSize,
  getMessageSnippet,
  getReachVisualMeta,
} from "../../../lib/format.js";
import {
  type DraftMessageAttachment,
  formatDraftAttachmentDisplayName,
} from "../../../lib/message-media.js";
import { isCoarsePointerDevice, isImeComposing } from "../../../lib/viewport-sync.js";
import {
  getChatDetailTranslator,
  resolveChatDetailErrorMessage,
  useChatDetailI18n,
} from "../i18n/chat-detail.js";
import type { AgentWorkspace } from "../work/solo-workbench-store.js";
import type {
  DispatchWorkPayload,
  RoomOrchestrationDefaults,
  WorkTopology,
} from "../work/work-types.js";
import { workspaceSupportsSwarm } from "../work/work-utils.js";
import "./mobile-chat-composer.css";
import { StickerPicker } from "./sticker-picker.js";
import { useMessageMediaDraft } from "./use-message-media-draft.js";

/** 输入框自适应高度上限（像素），超出后框内滚动，保持聊天舞台比例克制 */
const TEXTAREA_MAX_HEIGHT_PX = 168;

/** 行内 `@` 键盘联想浮层最多展示的候选人数 */
const MAX_MENTION_SUGGESTIONS = 8;

const MEDIA_BUTTON_CLASS =
  "im-press app-no-drag inline-flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full text-[#687082] hover:bg-black/[0.05] hover:text-[#111318] disabled:cursor-not-allowed disabled:opacity-40 dark:text-[#8E8E96] dark:hover:bg-white/[0.08] dark:hover:text-[#F2F2F4]";

const TIER_CYCLE_ORDER: ReadonlyArray<AgentExecutionTier> = [
  "chat_only",
  "workspace_read",
  "worktree_write",
];

/** `MessageComposer` 入参属性 */
export interface MessageComposerProps {
  readonly roomName: string;
  readonly roomKind?: RoomKind | undefined;
  readonly members: ReadonlyArray<RoomMemberDto>;
  readonly currentUserId: UserId;
  /** 当前登录用户的展示昵称（用于渲染输入舱内本人发言身份提示） */
  readonly currentUserDisplayName?: string | undefined;
  /** 当前房间关联的受控工作区（用于动态决定是否启用「多路并行」） */
  readonly boundWorkspace?: AgentWorkspace | null | undefined;
  readonly orchestrationDefaults?: RoomOrchestrationDefaults | undefined;
  /** 从右侧任务面板、消息右键菜单或已拍板提案卡传入的快捷派活预填意图 */
  readonly pendingDispatchSeed?:
    | {
        readonly nonce: number;
        readonly text?: string | undefined;
        readonly topology?: WorkTopology | undefined;
      }
    | null
    | undefined;
  readonly onConsumeDispatchSeed?: (() => void) | undefined;
  readonly replyTarget: MessageDto | null;
  readonly pendingQuickMention: MessageMention | null;
  readonly onConsumeQuickMention: () => void;
  readonly onClearReplyTarget: () => void;
  /** 从聊天主舞台拖放进来的文件列表信号 */
  readonly droppedFilesSignal?:
    | {
        readonly nonce: number;
        readonly files: ReadonlyArray<File>;
      }
    | null
    | undefined;
  readonly onConsumeDroppedFiles?: (() => void) | undefined;
  /** 全局「直接打字即聚焦输入框（Type-to-Chat）」信号 */
  readonly focusComposerSignal?:
    | {
        readonly nonce: number;
        readonly appendText?: string | undefined;
      }
    | null
    | undefined;
  readonly onConsumeFocusSignal?: (() => void) | undefined;
  readonly isSending: boolean;
  readonly sendError: Error | null;
  readonly onReconnectOfflineAgent?: ((agentId: AgentId) => void) | undefined;
  readonly onSendMessage: (params: {
    readonly content: string;
    readonly opKey: OperationKey;
    readonly replyToSeq?: MessageSeq;
    readonly mentions: ReadonlyArray<MessageMention>;
    readonly attachment?: DraftMessageAttachment;
    readonly onConfirmed: () => void;
    /** 网络或治理拦截报错时的回调，用于无损回填刚被瞬时清空的纯文本草稿 */
    readonly onFailed?: (() => void) | undefined;
    /** ADR-0002：提问模式开启时以 attention 消息发出（等人类作答，默认 24h 过期） */
    readonly attention?: { readonly question: string; readonly addresseeUserIds: UserId[] };
    /** 开启 `[⚡派活]` 模式时随消息一并创建的多 Agent 编排工单参数 */
    readonly workDispatch?: DispatchWorkPayload | undefined;
  }) => void;
}

/**
 * 根据房间形态、待发图片状态与交办/提问模式计算动态输入框占位文案。
 */
export function resolveComposerPlaceholder(params: {
  readonly roomName: string;
  readonly roomKind: RoomKind;
  readonly dispatchMode: boolean;
  readonly askMode: boolean;
  readonly hasDraftImage: boolean;
  readonly locale?: SupportedLocale | undefined;
}): string {
  const { t } = getChatDetailTranslator(params.locale);
  if (params.dispatchMode) {
    return params.hasDraftImage
      ? t("composer.placeholder.dispatchWithImage")
      : t("composer.placeholder.dispatch");
  }
  if (params.askMode) {
    return params.hasDraftImage
      ? t("composer.placeholder.askWithImage")
      : t("composer.placeholder.ask");
  }
  if (params.hasDraftImage) {
    if (params.roomKind === "group") {
      return t("composer.placeholder.imageGroup");
    }
    if (params.roomKind === "direct_agent") {
      return t("composer.placeholder.imageDirectAgent", { roomName: params.roomName });
    }
    return t("composer.placeholder.imageDefault");
  }
  if (params.roomKind === "direct_agent") {
    return t("composer.placeholder.directAgent", { roomName: params.roomName });
  }
  if (params.roomKind === "direct_human") {
    return t("composer.placeholder.directHuman", { roomName: params.roomName });
  }
  return t("composer.placeholder.group", { roomName: params.roomName });
}

function AttachmentPreview(props: {
  readonly attachment: DraftMessageAttachment;
  readonly disabled: boolean;
  readonly onRemove: () => void;
}) {
  const { locale, t } = useChatDetailI18n();
  const [url, setUrl] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const previewTriggerRef = useRef<HTMLButtonElement | null>(null);
  const { blob, mimeType, stickerName, width, height } = props.attachment;
  const isFile = mimeType === "application/octet-stream";
  const isImage = mimeType.startsWith("image/");
  const displayName = formatDraftAttachmentDisplayName(props.attachment, locale);
  const sizeLabel =
    props.attachment.wasCompressed === true
      ? t("composer.attachment.compressedSize", { size: formatAttachmentSize(blob.size) })
      : formatAttachmentSize(blob.size);

  useEffect(() => {
    if (isFile) {
      setUrl(null);
      return;
    }
    const source = blob.type === mimeType ? blob : blob.slice(0, blob.size, mimeType);
    const objectUrl = URL.createObjectURL(source);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [blob, isFile, mimeType]);

  return (
    <>
      <div className="mb-2 flex min-w-0 items-center gap-2.5 rounded-xl bg-black/[0.04] px-2 py-1.5 dark:bg-white/[0.07]">
        {isFile ? (
          <FileText
            aria-hidden="true"
            className="ml-1 h-5 w-5 shrink-0 text-[#687082] dark:text-[#C4C4CA]"
          />
        ) : isImage ? (
          url !== null ? (
            <button
              ref={previewTriggerRef}
              type="button"
              onClick={() => setPreviewOpen(true)}
              aria-label={t("composer.attachment.previewImageAria", { name: displayName })}
              title={t("composer.attachment.previewImageTitle")}
              className="app-no-drag relative h-12 w-12 shrink-0 cursor-zoom-in overflow-hidden rounded-md ring-1 ring-inset ring-black/[0.06] focus-visible:ring-2 dark:ring-white/[0.08]"
            >
              <img
                src={url}
                alt={
                  stickerName !== undefined
                    ? t("composer.attachment.pendingStickerAlt", { name: stickerName })
                    : t("composer.attachment.pendingImageAlt")
                }
                className={cn(
                  "block h-full w-full",
                  stickerName !== undefined ? "object-contain" : "object-cover",
                )}
              />
            </button>
          ) : null
        ) : url !== null ? (
          // biome-ignore lint/a11y/useMediaCaption: 用户的音频草稿没有字幕轨，原生控件支持键盘播放与暂停。
          <audio
            src={url}
            controls
            preload="metadata"
            aria-label={t("composer.attachment.previewVoiceAria")}
            className="h-9 w-48 min-w-0 max-w-[65%]"
          />
        ) : null}

        <div className="min-w-0 flex-1">
          <span className="block truncate text-xs font-medium text-[#111318] dark:text-[#ECECEF]">
            {displayName}
          </span>
          <span className="block truncate text-[11px] tabular-nums text-[#687082] dark:text-[#8E8E96]">
            {sizeLabel}
          </span>
        </div>

        <button
          type="button"
          aria-label={t("composer.attachment.remove")}
          title={t("composer.attachment.remove")}
          disabled={props.disabled}
          onClick={props.onRemove}
          className={MEDIA_BUTTON_CLASS}
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {isImage && url !== null ? (
        <ImageLightboxDialog
          open={previewOpen}
          onOpenChange={setPreviewOpen}
          src={url}
          title={displayName}
          downloadName={displayName}
          width={width}
          height={height}
          isSticker={stickerName !== undefined}
          returnFocusRef={previewTriggerRef}
        />
      ) : null}
    </>
  );
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
  const { locale, t, tp } = useChatDetailI18n();
  const [draft, setDraft] = useState<string>("");
  const [selectedMentions, setSelectedMentions] = useState<ReadonlyArray<MessageMention>>([]);
  const [caretIndex, setCaretIndex] = useState<number>(0);
  const [suggestDismissed, setSuggestDismissed] = useState<boolean>(false);
  const [activeSuggestIndex, setActiveSuggestIndex] = useState<number>(0);
  // ADR-0002：提问模式——开启后本条消息以 attention（等人类作答）形式发出
  const [askMode, setAskMode] = useState<boolean>(false);
  // 多 Agent 派活编排模式（与提问模式互斥，支持 `/task` `/verify` `/swarm` 自动点亮）
  const [dispatchMode, setDispatchMode] = useState<boolean>(false);
  const [dispatchTopology, setDispatchTopology] = useState<WorkTopology>("verify_loop");
  const [dispatchTier, setDispatchTier] = useState<AgentExecutionTier>("worktree_write");
  const [selectedExecutorId, setSelectedExecutorId] = useState<AgentId | null>(null);
  const touchKeyboard = isCoarsePointerDevice();
  const [editing, setEditing] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const composerRef = useRef<HTMLElement>(null);
  const toolstripId = useId();
  const [pickerOpen, setPickerOpen] = useState<boolean>(false);
  const { getPref } = useAgentCapabilityPrefs();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const draftRef = useRef<string>(draft);
  draftRef.current = draft;
  const [failedTextSnapshot, setFailedTextSnapshot] = useState<{
    readonly content: string;
    readonly mentions: ReadonlyArray<MessageMention>;
    readonly askMode: boolean;
    readonly dispatchMode: boolean;
    readonly dispatchTopology: WorkTopology;
    readonly replySeq?: MessageSeq | undefined;
    readonly attachment?: DraftMessageAttachment | undefined;
    readonly opKey: OperationKey;
    readonly attention?:
      | { readonly question: string; readonly addresseeUserIds: UserId[] }
      | undefined;
    readonly workDispatch?: DispatchWorkPayload | undefined;
  } | null>(null);
  const [failedReplyChipKey, setFailedReplyChipKey] = useState<string | null>(null);
  const retryRef = useRef<{
    readonly attachment: DraftMessageAttachment | null;
    readonly fingerprint: string;
    readonly opKey: OperationKey;
  } | null>(null);
  const media = useMessageMediaDraft();
  const mediaAttachmentRef = useRef<DraftMessageAttachment | null>(media.attachment);
  mediaAttachmentRef.current = media.attachment;
  const expanded =
    editing ||
    toolsOpen ||
    media.phase !== "idle" ||
    media.attachment !== null ||
    media.isPreparingImage;

  useEffect(() => {
    if (!toolsOpen) return;
    const closeOnOutsidePress = (event: PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Element &&
        !composerRef.current?.contains(target) &&
        !target.closest('[data-radix-popper-content-wrapper], [role="dialog"]')
      ) {
        setToolsOpen(false);
      }
    };
    document.addEventListener("pointerdown", closeOnOutsidePress);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePress);
  }, [toolsOpen]);

  // Some mobile keyboards dismiss without blurring their textarea (e.g. Android Back).
  useEffect(() => {
    if (!editing || !touchKeyboard) return;
    const root = document.documentElement;
    let keyboardWasOpen = root.dataset.keyboardOpen === "true";
    const observer = new MutationObserver(() => {
      const open = root.dataset.keyboardOpen === "true";
      if (keyboardWasOpen && !open && document.activeElement === textareaRef.current) {
        textareaRef.current?.blur();
      }
      keyboardWasOpen = open;
    });
    observer.observe(root, { attributes: true, attributeFilter: ["data-keyboard-open"] });
    return () => observer.disconnect();
  }, [editing, touchKeyboard]);

  const senderDisplayName =
    props.currentUserDisplayName !== undefined && props.currentUserDisplayName.trim().length > 0
      ? props.currentUserDisplayName.trim()
      : t("composer.selfFallbackName");

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

  // 解析当前派活阵型下的默认主力执行 Agent、统筹 Agent 与异构审查员
  const resolvedExecutor = useMemo(() => {
    if (selectedExecutorId !== null) {
      const explicit = agentMembers.find((m) => m.agentId === selectedExecutorId);
      if (explicit !== undefined) {
        return explicit;
      }
    }
    return (
      agentMembers.find((m) => m.ownerUserId === props.currentUserId && isReachableNow(m)) ??
      agentMembers.find((m) => m.ownerUserId === props.currentUserId) ??
      agentMembers[0]
    );
  }, [agentMembers, props.currentUserId, selectedExecutorId]);

  const resolvedVerifier = useMemo(() => {
    const preferredId = props.orchestrationDefaults?.verifierAgentId ?? null;
    if (preferredId !== null) {
      const explicit = agentMembers.find((m) => m.agentId === preferredId);
      if (explicit !== undefined) {
        return explicit;
      }
    }
    return (
      agentMembers.find((m) => m.agentId !== resolvedExecutor?.agentId && isReachableNow(m)) ??
      agentMembers.find((m) => m.agentId !== resolvedExecutor?.agentId) ??
      resolvedExecutor
    );
  }, [agentMembers, props.orchestrationDefaults?.verifierAgentId, resolvedExecutor]);

  const resolvedCoordinator = useMemo(() => {
    const preferredId = props.orchestrationDefaults?.coordinatorAgentId ?? null;
    if (preferredId !== null) {
      const explicit = agentMembers.find((m) => m.agentId === preferredId);
      if (explicit !== undefined) {
        return explicit;
      }
    }
    return (
      agentMembers.find((m) => m.platform === "antigravity") ?? agentMembers[0] ?? resolvedExecutor
    );
  }, [agentMembers, props.orchestrationDefaults?.coordinatorAgentId, resolvedExecutor]);

  const isExecutorOwnedByMe =
    resolvedExecutor === undefined || resolvedExecutor.ownerUserId === props.currentUserId;
  const effectiveDispatchTier: AgentExecutionTier = isExecutorOwnedByMe
    ? dispatchTier
    : "chat_only";

  const hasEnoughAgentsForSwarm = agentMembers.length >= 2;
  const workspaceBlocksSwarm =
    props.boundWorkspace != null && !workspaceSupportsSwarm(props.boundWorkspace);
  const supportsSwarm = hasEnoughAgentsForSwarm && !workspaceBlocksSwarm;
  const swarmDisabledReason = !hasEnoughAgentsForSwarm
    ? t("composer.dispatch.swarmNeedsTwoAgents")
    : workspaceBlocksSwarm
      ? t("composer.dispatch.swarmWorkspaceUnsupported")
      : undefined;
  const fallbackNonSwarmTopology: WorkTopology =
    agentMembers.length >= 2 && props.boundWorkspace?.kind !== "folder" ? "verify_loop" : "direct";
  const effectiveDispatchTopology: WorkTopology =
    dispatchTopology === "swarm" && !supportsSwarm ? fallbackNonSwarmTopology : dispatchTopology;

  const topologyTabItems = useMemo<ReadonlyArray<SegmentedTabItem<WorkTopology>>>(
    () => [
      { value: "direct", label: t("composer.topology.direct") },
      { value: "verify_loop", label: t("composer.topology.verify") },
      {
        value: "swarm",
        label: t("composer.topology.swarm"),
        ...(!supportsSwarm
          ? {
              disabled: true,
              ...(swarmDisabledReason !== undefined ? { title: swarmDisabledReason } : {}),
            }
          : {}),
      },
    ],
    [supportsSwarm, swarmDisabledReason, t],
  );

  useEffect(() => {
    if (dispatchTopology === "swarm" && !supportsSwarm) {
      setDispatchTopology(fallbackNonSwarmTopology);
    }
  }, [dispatchTopology, fallbackNonSwarmTopology, supportsSwarm]);

  // 响应从「去派活」「提案派发执行」或「消息转为执行任务」传来的预填意图
  useEffect(() => {
    const seed = props.pendingDispatchSeed;
    if (!seed) {
      return;
    }
    setAskMode(false);
    setDispatchMode(true);
    if (seed.topology !== undefined) {
      setDispatchTopology(
        seed.topology === "swarm" && !supportsSwarm ? fallbackNonSwarmTopology : seed.topology,
      );
    } else if (agentMembers.length >= 3 && supportsSwarm) {
      setDispatchTopology("swarm");
    } else if (agentMembers.length >= 2) {
      setDispatchTopology("verify_loop");
    } else {
      setDispatchTopology("direct");
    }
    if (seed.text !== undefined && seed.text.trim().length > 0) {
      setDraft(seed.text.trim());
    }
    if (resolvedExecutor?.agentId !== undefined) {
      const pref = getPref(resolvedExecutor.agentId, resolvedExecutor.platform);
      if (pref.tier !== "chat_only") {
        setDispatchTier(pref.tier);
      }
    }
    props.onConsumeDispatchSeed?.();
    window.requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      }
    });
  }, [
    agentMembers.length,
    fallbackNonSwarmTopology,
    getPref,
    props.onConsumeDispatchSeed,
    props.pendingDispatchSeed,
    resolvedExecutor,
    supportsSwarm,
  ]);

  const resizeDraft = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const contentHeight = el.scrollHeight;
    el.style.height = `${Math.min(contentHeight, TEXTAREA_MAX_HEIGHT_PX)}px`;
    el.style.overflowY = contentHeight > TEXTAREA_MAX_HEIGHT_PX ? "auto" : "hidden";
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: both text and editing width affect line wrapping
  useLayoutEffect(resizeDraft, [resizeDraft, draft, expanded]);
  useEffect(() => {
    const el = textareaRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let width = el.clientWidth;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      resizeDraft();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [resizeDraft]);

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

  // 点击任意气泡「回复」后立即将输入焦点移入文本框，无需用户二次鼠标点击输入区
  const replySeqForFocus = props.replyTarget?.seq;
  useEffect(() => {
    if (replySeqForFocus === undefined) {
      return;
    }
    window.requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      }
    });
  }, [replySeqForFocus]);

  // 响应全舞台拖放文件信号
  useEffect(() => {
    const dropped = props.droppedFilesSignal;
    if (!dropped || dropped.files.length === 0) {
      return;
    }
    props.onConsumeDroppedFiles?.();
    if (!props.isSending && !media.isPreparingImage && media.phase === "idle") {
      void media.chooseFiles([...dropped.files]);
    }
    window.requestAnimationFrame(() => textareaRef.current?.focus());
  }, [media, props.droppedFilesSignal, props.isSending, props.onConsumeDroppedFiles]);

  // 响应全局「直接打字聚焦输入框（Type-to-Chat）」信号
  useEffect(() => {
    const sig = props.focusComposerSignal;
    if (!sig) {
      return;
    }
    const ch = sig.appendText ?? "";
    if (ch.length > 0) {
      setDraft((prev) => `${prev}${ch}`);
    }
    props.onConsumeFocusSignal?.();
    window.requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
        setCaretIndex(el.value.length);
      }
    });
  }, [props.focusComposerSignal, props.onConsumeFocusSignal]);

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
    const allLabel = t("composer.mention.allLabel");
    if (
      agentMembers.length >= 2 &&
      (allLabel.toLowerCase().includes(q) || "all".includes(q) || q.length === 0)
    ) {
      list.push({
        key: "all-agents",
        kind: "all",
        label: allLabel,
        sublabel: tp("composer.mention.wakeAllAgents", agentMembers.length),
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
      const reachMeta = isAgent ? getReachVisualMeta(member.reach, locale) : null;
      list.push({
        key: mentionIdentityKey(mention),
        kind: isAgent ? "agent" : "human",
        label: member.displayName,
        sublabel: isAgent
          ? t("composer.mention.agentSublabel", {
              owner: member.ownerDisplayName,
              reach: reachMeta?.shortLabel ?? "",
            })
          : t("composer.mention.memberSublabel"),
        dotClass: reachMeta?.dotClass ?? null,
        mention,
      });
    }
    return list.slice(0, MAX_MENTION_SUGGESTIONS);
  }, [mentionTrigger, agentMembers, humanMembers, locale, t, tp]);

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
      // 移除胶囊时按 Unicode 词字符边界剥离独立 `@昵称`，防止删 `@庞彦` 时误截断 `@庞彦助理` 或 `@庞彦-Codex`
      setSelectedMentions((prev) => prev.filter((m) => mentionIdentityKey(m) !== targetKey));
      const escaped = target.displayName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const tokenRegex = new RegExp(`@${escaped}(?![\\p{L}\\p{N}_·—-])\\s?`, "giu");
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

  const trimmed = draft.trim();
  const canChooseMedia = !props.isSending && !media.isPreparingImage && media.phase === "idle";
  const requiresAccompanyingText = askMode || dispatchMode;
  // 原生 IM 体验不变量：纯文本发送支持 0ms 连续回车抢发；携带图片时也允许开启交办任务或提问模式（需填写非空说明文字）
  const canSend =
    media.attachment !== null
      ? canChooseMedia && (!requiresAccompanyingText || trimmed.length > 0)
      : !media.isPreparingImage && media.phase === "idle" && trimmed.length > 0;

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
    const { files, items } = event.clipboardData;
    // 部分浏览器只在 items 中公开粘贴的图片。普通文字仍交给输入框原生处理。
    const attachments =
      files.length > 0
        ? Array.from(files)
        : Array.from(items).flatMap((item) => {
            const file = item.kind === "file" ? item.getAsFile() : null;
            return file === null ? [] : [file];
          });
    if (attachments.length > 0) {
      event.preventDefault();
      if (canChooseMedia) {
        void media.chooseFiles(attachments);
      }
    }
  };

  const submitMessage = (): void => {
    if (!canSend) {
      return;
    }

    // 最终提及集合严格与正文中保留的 `@昵称` 求交集，防止幽灵唤醒或前缀误命中
    const presentMentions = extractPresentRoomMentions(trimmed, props.members);
    const presentKeys = new Set(presentMentions.map(mentionIdentityKey));
    const finalMentions = mergeMentions(selectedMentions, presentMentions).filter((m) =>
      presentKeys.has(mentionIdentityKey(m)),
    );

    const replySeq = props.replyTarget?.seq;

    // ADR-0002 提问模式：以结构化 attention 消息发出，收件人默认为房间内全部人类成员
    const humanMemberIds = props.members
      .filter((m) => m.memberKind === "human" && m.userId !== undefined)
      .map((m) => m.userId as UserId);
    const attention =
      askMode && !dispatchMode && humanMemberIds.length > 0
        ? { question: trimmed, addresseeUserIds: humanMemberIds }
        : undefined;
    const workDispatch: DispatchWorkPayload | undefined = dispatchMode
      ? {
          topology: effectiveDispatchTopology,
          tier: effectiveDispatchTier,
          ...(resolvedCoordinator?.agentId !== undefined
            ? { coordinatorAgentId: resolvedCoordinator.agentId }
            : {}),
          ...(resolvedExecutor?.agentId !== undefined
            ? { executorAgentId: resolvedExecutor.agentId }
            : {}),
          ...(effectiveDispatchTopology !== "direct" && resolvedVerifier?.agentId !== undefined
            ? { verifierAgentId: resolvedVerifier.agentId }
            : {}),
        }
      : undefined;
    const { attachment } = media;
    const fingerprint = JSON.stringify([trimmed, replySeq, finalMentions, attention, workDispatch]);
    const previousAttempt = retryRef.current;
    // 超时可能发生在落库后，原样重试须复用幂等键以免重复发出。
    const opKey =
      previousAttempt?.attachment === attachment && previousAttempt.fingerprint === fingerprint
        ? previousAttempt.opKey
        : createClientOperationKey();
    retryRef.current = { attachment, fingerprint, opKey };
    setFailedTextSnapshot(null);

    // 统一 0ms 瞬时清空策略：无论纯文本还是带图消息，按下发送当帧立即清空输入舱文本与附件预览槽，由时间线乐观气泡直接渲染本地真实缩略图；若失败且输入舱为空则自动无损回填
    const savedDraft = draft;
    const savedMentions = selectedMentions;
    const savedAsk = askMode;
    const savedDispatch = dispatchMode;
    const savedTopology = effectiveDispatchTopology;
    const savedAttachment = attachment;

    setDraft("");
    setAskMode(false);
    setDispatchMode(false);
    setSelectedMentions([]);
    setCaretIndex(0);
    if (savedAttachment !== null) {
      media.clearAttachment(savedAttachment);
    }
    if (replySeq !== undefined) {
      props.onClearReplyTarget();
    }
    window.requestAnimationFrame(() => textareaRef.current?.focus());

    props.onSendMessage({
      content: trimmed,
      opKey,
      ...(replySeq !== undefined ? { replyToSeq: replySeq } : {}),
      mentions: finalMentions,
      ...(attention !== undefined ? { attention } : {}),
      ...(workDispatch !== undefined ? { workDispatch } : {}),
      ...(savedAttachment !== null ? { attachment: savedAttachment } : {}),
      onConfirmed: () => {
        retryRef.current = null;
        setFailedTextSnapshot(null);
      },
      onFailed: () => {
        const isComposerCurrentlyEmpty =
          draftRef.current.trim().length === 0 && mediaAttachmentRef.current === null;
        if (isComposerCurrentlyEmpty) {
          setDraft(savedDraft);
          setSelectedMentions(savedMentions);
          setAskMode(savedAsk);
          setDispatchMode(savedDispatch);
          setDispatchTopology(savedTopology);
          if (savedAttachment !== null) {
            media.restoreAttachment(savedAttachment);
          }
          focusAt(savedDraft.length);
        } else {
          // 用户已在请求期间继续输入新内容或选定新附件，绝不覆盖新草稿，而在错误条提供一键重发入口
          setFailedTextSnapshot({
            content: trimmed,
            mentions: finalMentions,
            askMode: savedAsk,
            dispatchMode: savedDispatch,
            dispatchTopology: savedTopology,
            ...(replySeq !== undefined ? { replySeq } : {}),
            ...(savedAttachment !== null ? { attachment: savedAttachment } : {}),
            opKey,
            ...(attention !== undefined ? { attention } : {}),
            ...(workDispatch !== undefined ? { workDispatch } : {}),
          });
        }
      },
    });
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    // 中文等输入法候选词上屏过程中按 Enter（含 Android keyCode 229）不触发误发送或误选联想项
    if (isImeComposing(event)) {
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
    // 原生分层 Escape 响应链：优先依次取消引用回复、派活模式、提问模式或待发附件
    if (event.key === "Escape") {
      if (props.replyTarget !== null) {
        event.preventDefault();
        props.onClearReplyTarget();
        return;
      }
      if (dispatchMode) {
        event.preventDefault();
        setDispatchMode(false);
        return;
      }
      if (askMode) {
        event.preventDefault();
        setAskMode(false);
        return;
      }
      if (media.attachment !== null && !props.isSending) {
        event.preventDefault();
        media.clearAttachment();
        return;
      }
    }
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      (!touchKeyboard || event.metaKey || event.ctrlKey)
    ) {
      event.preventDefault();
      submitMessage();
    }
  };

  const resolvedSendErr = resolveChatDetailErrorMessage(props.sendError, locale);
  const errorText =
    props.sendError instanceof ApiClientError && resolvedSendErr !== null
      ? `${resolvedSendErr} (${props.sendError.code})`
      : resolvedSendErr;

  const effectiveKind: RoomKind = props.roomKind ?? "group";
  const hasAnyTeammate =
    effectiveKind === "group" && (agentMembers.length > 0 || humanMembers.length > 0);
  const hasContextChips = props.replyTarget !== null || activeChipMentions.length > 0;
  const hasDraftImage =
    media.attachment?.mimeType.startsWith("image/") === true &&
    media.attachment.stickerName === undefined;
  const composerPlaceholder = resolveComposerPlaceholder({
    roomName: props.roomName,
    roomKind: effectiveKind,
    dispatchMode,
    askMode,
    hasDraftImage,
    locale,
  });
  const sendButtonTooltip =
    media.attachment !== null && dispatchMode && trimmed.length === 0
      ? t("composer.send.needDispatchText")
      : media.attachment !== null && askMode && trimmed.length === 0
        ? t("composer.send.needAskText")
        : t("composer.send.tooltip");

  return (
    <footer
      ref={composerRef}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setEditing(false);
      }}
      className="oh-chat-footer app-no-drag pointer-events-none relative z-10 shrink-0 bg-gradient-to-t from-[var(--oh-stage-scrim)] via-[var(--oh-stage-scrim-mid)] to-transparent px-3 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-5"
    >
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
              <div className="flex flex-wrap items-center justify-between gap-2 bg-[#E5484D]/[0.10] px-3.5 py-2 text-xs font-medium text-[#C81E1E] dark:bg-[#F05252]/[0.14] dark:text-[#FCA5A5]">
                <span>
                  {failedTextSnapshot !== null
                    ? t("composer.error.failedWithRetry", { error: errorText })
                    : t("composer.error.failedRestored", { error: errorText })}
                </span>
                {failedTextSnapshot !== null ? (
                  <button
                    type="button"
                    onClick={() => {
                      const snap = failedTextSnapshot;
                      setFailedTextSnapshot(null);
                      props.onSendMessage({
                        content: snap.content,
                        opKey: snap.opKey,
                        ...(snap.replySeq !== undefined ? { replyToSeq: snap.replySeq } : {}),
                        mentions: snap.mentions,
                        ...(snap.attention !== undefined ? { attention: snap.attention } : {}),
                        ...(snap.workDispatch !== undefined
                          ? { workDispatch: snap.workDispatch }
                          : {}),
                        ...(snap.attachment !== undefined ? { attachment: snap.attachment } : {}),
                        onConfirmed: () => {
                          retryRef.current = null;
                        },
                        onFailed: () => {
                          setFailedTextSnapshot(snap);
                        },
                      });
                    }}
                    className="im-press shrink-0 cursor-pointer rounded-full bg-[#C81E1E] px-2.5 py-0.5 text-[11px] font-medium text-white hover:bg-[#B91C1C] dark:bg-[#F87171] dark:text-[#111318]"
                  >
                    {failedTextSnapshot.attachment?.mimeType.startsWith("image/") === true &&
                    failedTextSnapshot.attachment.stickerName === undefined
                      ? t("composer.error.retryImage")
                      : failedTextSnapshot.attachment !== undefined
                        ? t("composer.error.retryAttachment")
                        : t("composer.error.retryMessage")}
                  </button>
                ) : null}
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
                  {tp("composer.offlineHint.text", offlineMentionedAgents.length, {
                    agents: offlineMentionedAgents
                      .map((m) => `@${m.displayName}`)
                      .join(t("common.listSeparator")),
                  })}
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
                      {t("composer.offlineHint.reconnect")}
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
              aria-label={t("composer.mention.popoverAria")}
              initial={{ opacity: 0, y: 6, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 4, scale: 0.98 }}
              transition={{ type: "spring", stiffness: 520, damping: 36 }}
              className="pointer-events-auto absolute right-0 bottom-full left-0 z-30 mb-2 flex max-h-[min(14rem,calc(var(--oh-vvh,100dvh)-8.5rem))] max-w-sm flex-col overflow-hidden rounded-[20px] p-1.5 liquid-glass-modal"
            >
              <div className="shrink-0 px-2.5 pt-1 pb-1.5 text-[11px] font-medium text-[#687082] dark:text-[#8E8E96]">
                <span>{t("composer.mention.popoverTitle")}</span>
                <span className="hidden sm:inline">{t("composer.mention.popoverKeyHint")}</span>
              </div>
              <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto overscroll-contain">
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
        <div
          data-expanded={expanded}
          data-tools-open={toolsOpen}
          className="@container oh-chat-capsule pointer-events-auto relative liquid-glass-composer rounded-[22px] sm:rounded-[24px] px-3.5 pt-2.5 pb-2 sm:px-4 sm:pt-3 sm:pb-2.5"
        >
          <div className="oh-chat-context">
            {/* 3.0 派活编排微胶囊条（仅开启交办任务时浮现，窄屏单行滑轨紧凑排布以释放软键盘消息区） */}
            <AnimatePresence initial={false}>
              {dispatchMode && effectiveKind !== "direct_human" ? (
                <motion.div
                  key="composer-dispatch-bar"
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.16, ease: "easeOut" }}
                  className="overflow-hidden"
                >
                  <div className="mb-1.5 flex items-center justify-between gap-1.5 border-b border-black/[0.06] pb-1.5 text-[11.5px] sm:mb-2 sm:pb-2 dark:border-white/[0.07]">
                    <div className="no-scrollbar flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto overscroll-x-contain sm:flex-wrap">
                      <span className="hidden sm:inline-flex shrink-0 items-center gap-1 px-1 text-[11.5px] font-medium text-[#4B5565] dark:text-[#A1A1AA]">
                        <ListTodo className="h-3.5 w-3.5 text-[#687082] dark:text-[#8E8E96]" />
                        <span>{t("composer.dispatch.label")}</span>
                      </span>

                      {effectiveKind === "group" ? (
                        <div className="shrink-0">
                          <SegmentedTabs
                            value={effectiveDispatchTopology}
                            onValueChange={(nextTopology) => {
                              if (nextTopology === "swarm" && !supportsSwarm) {
                                setDispatchTopology(fallbackNonSwarmTopology);
                                return;
                              }
                              setDispatchTopology(nextTopology);
                            }}
                            items={topologyTabItems}
                            size="xs"
                            ariaLabel={t("composer.dispatch.topologyAria")}
                          />
                        </div>
                      ) : null}

                      {/* 责任人与点击轮换 */}
                      {agentMembers.length > 0 ? (
                        <button
                          type="button"
                          title={t("composer.dispatch.cycleExecutorTitle")}
                          onClick={() => {
                            if (agentMembers.length < 2) {
                              return;
                            }
                            const curIdx = agentMembers.findIndex(
                              (m) => m.agentId === resolvedExecutor?.agentId,
                            );
                            const next = agentMembers[(curIdx + 1) % agentMembers.length];
                            if (next?.agentId !== undefined) {
                              setSelectedExecutorId(next.agentId);
                            }
                          }}
                          className="inline-flex max-w-full min-w-0 cursor-pointer items-center gap-1 rounded-full bg-black/[0.045] px-2.5 py-0.5 text-[#3B414E] transition hover:bg-black/[0.08] dark:bg-white/[0.07] dark:text-[#D4D4D8] dark:hover:bg-white/[0.12]"
                        >
                          {effectiveDispatchTopology === "swarm" ? (
                            <span className="truncate">
                              {t("composer.dispatch.swarmSummary", {
                                lead: resolvedCoordinator?.displayName ?? "Agent",
                                count: Math.max(2, agentMembers.length),
                              })}
                            </span>
                          ) : effectiveDispatchTopology === "verify_loop" ? (
                            <span className="truncate">
                              {t("composer.dispatch.verifySummary", {
                                executor: resolvedExecutor?.displayName ?? "Agent",
                                verifier: resolvedVerifier?.displayName ?? "Agent",
                              })}
                            </span>
                          ) : (
                            <span className="truncate">
                              @{resolvedExecutor?.displayName ?? "Agent"}
                            </span>
                          )}
                        </button>
                      ) : null}

                      <button
                        type="button"
                        disabled={!isExecutorOwnedByMe}
                        title={
                          isExecutorOwnedByMe
                            ? t("composer.dispatch.tierToggleTitle")
                            : t("composer.dispatch.tierExternalDisabledTitle")
                        }
                        onClick={() => {
                          const idx = TIER_CYCLE_ORDER.indexOf(dispatchTier);
                          const nextTier =
                            TIER_CYCLE_ORDER[(idx + 1) % TIER_CYCLE_ORDER.length] ?? "chat_only";
                          setDispatchTier(nextTier);
                        }}
                        className={cn(
                          "inline-flex items-center gap-1 rounded-full bg-black/[0.045] px-2 py-0.5 text-[11px] text-[#4B5565] transition dark:bg-white/[0.07] dark:text-[#C4C4CA]",
                          isExecutorOwnedByMe
                            ? "cursor-pointer hover:bg-black/[0.08] dark:hover:bg-white/[0.12]"
                            : "cursor-not-allowed opacity-70",
                        )}
                      >
                        <FolderGit2 className="h-3 w-3 text-[#687082] dark:text-[#8E8E96]" />
                        <span>
                          {isExecutorOwnedByMe
                            ? getExecutionTierMeta(effectiveDispatchTier, locale).shortLabel
                            : getExecutionTierMeta("chat_only", locale).shortLabel}
                        </span>
                      </button>
                    </div>

                    <button
                      type="button"
                      aria-label={t("composer.dispatch.exitAria")}
                      onClick={() => setDispatchMode(false)}
                      className="relative inline-flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-full text-[#687082] transition hover:bg-black/10 hover:text-[#111318] after:absolute after:-inset-1.5 dark:text-[#8E8E96] dark:hover:bg-white/15 dark:hover:text-white"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </motion.div>
              ) : null}
            </AnimatePresence>

            {/* 舱内顶部上下文微胶囊条（引用回复 & 已点名成员，平滑展开收起，无内容时完全零占位） */}
            <AnimatePresence initial={false}>
              {hasContextChips ? (
                <motion.div
                  key="composer-context-chips"
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.15, ease: [0.22, 1, 0.36, 1] }}
                  className="overflow-hidden"
                >
                  <div className="mb-2 flex min-w-0 flex-wrap items-center gap-1.5 border-b border-black/[0.06] pb-2 dark:border-white/[0.07]">
                    {props.replyTarget !== null ? (
                      <span className="inline-flex max-w-[18rem] items-center gap-1.5 rounded-full bg-black/[0.05] py-0.5 pr-1 pl-2.5 text-[11.5px] text-[#111318] dark:bg-white/[0.08] dark:text-[#ECECEF]">
                        <CornerUpLeft className="h-3 w-3 shrink-0 text-[#687082] dark:text-[#8E8E96]" />
                        {(() => {
                          const target = props.replyTarget;
                          const chipKey = `${target.roomId}:${String(target.seq)}`;
                          const showThumb =
                            target.recalledAtIso === undefined &&
                            target.attachment !== undefined &&
                            target.attachment.mimeType.startsWith("image/") &&
                            failedReplyChipKey !== chipKey;
                          return showThumb ? (
                            <img
                              src={roomMessageAttachmentPath(target.roomId, target.seq)}
                              alt=""
                              aria-hidden="true"
                              decoding="async"
                              onError={() => setFailedReplyChipKey(chipKey)}
                              className="h-[18px] w-[18px] shrink-0 rounded-[4px] object-cover ring-1 ring-inset ring-black/[0.06] dark:ring-white/[0.08]"
                            />
                          ) : null;
                        })()}
                        <span className="truncate">
                          {t("composer.reply.prefix")}
                          <strong>{props.replyTarget.author.displayName}</strong>
                          {t("composer.reply.colon")}
                          {getMessageSnippet(props.replyTarget, 42, locale)}
                        </span>
                        <button
                          type="button"
                          aria-label={t("composer.reply.cancelAria")}
                          onClick={props.onClearReplyTarget}
                          className="relative inline-flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded-full text-[#687082] transition hover:bg-black/10 hover:text-[#111318] after:absolute after:-inset-1.5 dark:text-[#8E8E96] dark:hover:bg-white/15 dark:hover:text-white"
                        >
                          <X className="h-3 w-3" />
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
                            aria-label={t("composer.mention.removeChipAria", {
                              name: mention.displayName,
                            })}
                            onClick={() => toggleMention(mention)}
                            className="relative inline-flex h-5 w-5 cursor-pointer items-center justify-center rounded-full transition hover:bg-black/10 after:absolute after:-inset-1.5 dark:hover:bg-white/15"
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </span>
                      );
                    })}
                  </div>
                </motion.div>
              ) : null}
            </AnimatePresence>

            {media.attachment !== null ? (
              <AttachmentPreview
                attachment={media.attachment}
                disabled={props.isSending || media.isPreparingImage}
                onRemove={() => {
                  retryRef.current = null;
                  media.clearAttachment();
                }}
              />
            ) : null}
            {media.isPreparingImage ? (
              <output className="mb-1 block text-xs text-[#687082] dark:text-[#C4C4CA]">
                {t("composer.attachment.compressingImage")}
              </output>
            ) : null}
            {media.error !== null ? (
              <p role="alert" className="mb-1 text-xs text-[#C81E1E] dark:text-[#FCA5A5]">
                {media.error}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            className={cn(MEDIA_BUTTON_CLASS, "oh-chat-more hidden")}
            aria-expanded={toolsOpen}
            aria-controls={toolstripId}
            aria-label={
              toolsOpen ? t("composer.tools.collapseAria") : t("composer.tools.expandAria")
            }
            onPointerDown={(event) => {
              if (document.activeElement === textareaRef.current) event.preventDefault();
            }}
            onClick={() => setToolsOpen((open) => !open)}
          >
            {toolsOpen ? <X className="h-5 w-5" /> : <Plus className="h-5 w-5" />}
          </button>
          <textarea
            ref={textareaRef}
            rows={1}
            maxLength={16_000}
            value={draft}
            onChange={(e) => {
              const rawVal = e.target.value;
              // 斜杠快捷触发：输入 `/swarm `、`/verify ` 或 `/task ` 时自动点亮派活胶囊并剥离命令前缀
              if (effectiveKind !== "direct_human") {
                const slashMatch = /^\/(swarm|verify|task)\s+([\s\S]*)$/iu.exec(rawVal);
                if (slashMatch) {
                  const cmd = (slashMatch[1] ?? "").toLowerCase();
                  const rest = slashMatch[2] ?? "";
                  setAskMode(false);
                  setDispatchMode(true);
                  if (cmd === "swarm") {
                    if (supportsSwarm) {
                      setDispatchTopology("swarm");
                    } else {
                      setDispatchTopology(fallbackNonSwarmTopology);
                      toast.info(
                        fallbackNonSwarmTopology === "verify_loop"
                          ? t("composer.dispatch.swarmFallbackVerify")
                          : t("composer.dispatch.swarmFallbackDirect"),
                        ...(swarmDisabledReason !== undefined
                          ? [{ description: swarmDisabledReason }]
                          : []),
                      );
                    }
                  } else {
                    setDispatchTopology(cmd === "verify" ? "verify_loop" : "direct");
                  }
                  setDraft(rest);
                  setCaretIndex(rest.length);
                  return;
                }
              }
              setDraft(rawVal);
              setCaretIndex(e.target.selectionStart);
              setSuggestDismissed(false);
              setActiveSuggestIndex(0);
            }}
            onSelect={(e) => setCaretIndex(e.currentTarget.selectionStart)}
            onBlur={() => setSuggestDismissed(true)}
            onFocus={() => {
              setSuggestDismissed(false);
              setEditing(true);
            }}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            enterKeyHint={touchKeyboard ? "enter" : "send"}
            aria-label={t("composer.textareaAria", { roomName: props.roomName })}
            placeholder={composerPlaceholder}
            className={cn(
              "oh-chat-draft block max-h-[168px] min-h-[26px] w-full resize-none border-0 bg-transparent p-0 text-[16px] md:text-[14.5px] leading-[1.5] text-[#111318] caret-[#111318] outline-none placeholder:text-im-placeholder dark:text-[#F2F2F4] dark:caret-[#F2F2F4] dark:placeholder:text-[#63636B]",
              draft.length === 0 && "overflow-hidden whitespace-nowrap text-ellipsis",
            )}
          />

          {/* 舱内底部工具栏：窄屏严格保持单行不折行（`@全体` 在窄屏合并于 `@` 菜单首项），释放聊天舞台高度 */}
          <div className="oh-chat-actions mt-1.5 sm:mt-2 flex select-none items-center justify-between gap-1.5">
            <div
              id={toolstripId}
              className="oh-chat-tools flex min-w-0 items-center gap-0.5 sm:gap-1.5"
            >
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
                      title={t("composer.mention.triggerLabel")}
                      aria-label={t("composer.mention.triggerLabel")}
                      className={cn(
                        "oh-chat-extra app-no-drag inline-flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full transition-colors active:scale-[0.95] disabled:cursor-not-allowed disabled:opacity-40",
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
                        {t("composer.mention.pickerTitle")}
                      </span>
                      <span className="text-[11px] font-medium text-[#16A34A] dark:text-[#34D399]">
                        {t("composer.mention.agentsOnline", {
                          online: onlineAgentCount,
                          total: agentMembers.length,
                        })}
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
                          <span className="block truncate font-semibold">
                            {t("composer.mention.allAgentsTitle")}
                          </span>
                          <span className="block text-[10.5px] text-[#687082] dark:text-[#8E8E96]">
                            {tp("composer.mention.allAgentsDesc", agentMembers.length)}
                          </span>
                        </span>
                      </button>
                    ) : null}

                    <div className="max-h-[min(14rem,calc(var(--oh-vvh,100dvh)-10rem))] space-y-0.5 overflow-y-auto overscroll-contain pt-0.5">
                      {agentMembers.map((member) => {
                        const mentionObj = memberToMention(member);
                        if (mentionObj === null) {
                          return null;
                        }
                        const checked = draft.includes(`@${member.displayName}`);
                        const reachMeta = getReachVisualMeta(member.reach, locale);
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
                                {t("composer.mention.agentSublabel", {
                                  owner: member.ownerDisplayName,
                                  reach: reachMeta.shortLabel,
                                })}
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
                                {t("composer.mention.memberSublabel")}
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

              <input
                ref={fileInputRef}
                type="file"
                hidden
                onChange={(event) => {
                  const files = Array.from(event.currentTarget.files ?? []);
                  event.currentTarget.value = "";
                  if (files.length > 0) {
                    setToolsOpen(false);
                  }
                  void media.chooseFiles(files);
                }}
              />
              <button
                type="button"
                aria-label={t("composer.media.attachAria")}
                title={t("composer.media.attachTitle")}
                onClick={() => fileInputRef.current?.click()}
                disabled={!canChooseMedia}
                className={cn(MEDIA_BUTTON_CLASS, "oh-chat-extra")}
              >
                <Paperclip className="h-[17px] w-[17px]" />
              </button>
              <StickerPicker
                userId={props.currentUserId}
                disabled={!canChooseMedia}
                triggerClassName={cn(MEDIA_BUTTON_CLASS, "oh-chat-extra")}
                onSelect={(sticker) => {
                  setToolsOpen(false);
                  media.chooseSticker(sticker);
                }}
              />
              {media.phase === "idle" ? (
                <button
                  type="button"
                  aria-label={t("composer.media.recordAria")}
                  title={
                    media.canRecord
                      ? t("composer.media.recordAria")
                      : t("composer.media.recordUnsupported")
                  }
                  disabled={!canChooseMedia || !media.canRecord}
                  onClick={() => void media.startRecording()}
                  className={cn(MEDIA_BUTTON_CLASS, "oh-chat-voice")}
                >
                  <Mic className="h-[17px] w-[17px]" />
                </button>
              ) : (
                <div className="flex items-center gap-0.5">
                  <output className="sr-only">
                    {media.phase === "requesting"
                      ? t("composer.media.statusRequesting")
                      : media.phase === "recording"
                        ? t("composer.media.statusRecording")
                        : t("composer.media.statusFinishing")}
                  </output>
                  <button
                    type="button"
                    aria-label={t("composer.media.stopRecording")}
                    title={t("composer.media.stopRecording")}
                    disabled={media.phase !== "recording"}
                    onClick={media.finishRecording}
                    className={cn(
                      MEDIA_BUTTON_CLASS,
                      "bg-red-500/10 text-red-700 dark:text-red-300",
                    )}
                  >
                    {media.phase === "recording" ? (
                      <Square className="h-3.5 w-3.5 fill-current" />
                    ) : (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    )}
                  </button>
                  <button
                    type="button"
                    aria-label={t("composer.media.cancelRecording")}
                    title={t("composer.media.cancelRecording")}
                    onClick={media.cancelRecording}
                    className={MEDIA_BUTTON_CLASS}
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              )}

              {/* ADR-0002 提问模式开关：开启后本条消息以 attention 形式发出，等待人类作答 */}
              <button
                type="button"
                aria-label={t("composer.ask.label")}
                title={askMode ? t("composer.ask.activeTitle") : t("composer.ask.inactiveTitle")}
                aria-pressed={askMode}
                onClick={() => {
                  setAskMode((v) => {
                    const next = !v;
                    if (next) {
                      setDispatchMode(false);
                    }
                    return next;
                  });
                }}
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
                <span className="hidden select-none rounded-full bg-amber-500/12 px-2 py-0.5 text-[10.5px] font-medium text-amber-700 @[420px]:inline dark:text-amber-300">
                  {t("composer.ask.label")}
                </span>
              ) : null}

              {/* 交办任务开关（与相邻工具按钮保持一致的 32px 原生圆形图标规范） */}
              {effectiveKind !== "direct_human" ? (
                <button
                  type="button"
                  title={
                    dispatchMode
                      ? t("composer.dispatch.activeTitle")
                      : t("composer.dispatch.toggleTitle")
                  }
                  aria-label={t("composer.dispatch.toggleTitle")}
                  aria-pressed={dispatchMode}
                  onClick={() => {
                    setDispatchMode((v) => {
                      const next = !v;
                      if (next) {
                        setAskMode(false);
                      }
                      return next;
                    });
                    window.requestAnimationFrame(() => textareaRef.current?.focus());
                  }}
                  className={cn(
                    "app-no-drag inline-flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full transition-colors active:scale-[0.95]",
                    dispatchMode
                      ? "bg-black/[0.08] text-[#111318] dark:bg-white/[0.14] dark:text-white"
                      : "text-[#687082] hover:bg-black/[0.05] hover:text-[#111318] dark:text-[#8E8E96] dark:hover:bg-white/[0.08] dark:hover:text-[#F2F2F4]",
                  )}
                >
                  <ListTodo className="h-[17px] w-[17px] stroke-[1.9]" />
                </button>
              ) : null}

              {agentMembers.length >= 2 ? (
                <button
                  type="button"
                  onClick={handleMentionAllAgents}
                  title={t("composer.mention.allPillTitle")}
                  className="hidden @[390px]:inline-flex h-7 shrink-0 cursor-pointer items-center gap-1 whitespace-nowrap rounded-full bg-black/[0.05] px-2.5 text-[12px] font-medium text-[#181B22] transition-colors hover:bg-black/[0.09] active:scale-[0.97] dark:bg-white/[0.07] dark:text-[#ECECEF] dark:hover:bg-white/[0.12]"
                >
                  <span>{t("composer.mention.allPillLabel")}</span>
                </button>
              ) : null}

              {/* 安静的本人发言身份微标（按容器实际可用宽度展示，避免分屏或 175% 缩放窄舞台下挤压发送键） */}
              <div className="ml-1 hidden min-w-0 items-center gap-1.5 border-l border-black/[0.07] pl-2.5 @[470px]:flex dark:border-white/[0.08]">
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

            <AppTooltip
              side="top"
              content={sendButtonTooltip}
              shortcut={touchKeyboard || !canSend ? undefined : "Enter"}
            >
              <span className="inline-flex shrink-0">
                <motion.button
                  type="button"
                  disabled={!canSend}
                  onClick={submitMessage}
                  {...(canSend ? { whileTap: { scale: 0.92 } } : {})}
                  transition={{ type: "spring", stiffness: 560, damping: 30 }}
                  aria-label={sendButtonTooltip}
                  title={sendButtonTooltip}
                  className={cn(
                    "oh-chat-send inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-colors focus-visible:ring-2 focus-visible:ring-black/25 focus-visible:outline-none dark:focus-visible:ring-white/35",
                    canSend
                      ? "cursor-pointer bg-[#181B22] text-white shadow-xs hover:bg-[#252A35] dark:bg-[#EAEEF6] dark:text-[#111318] dark:hover:bg-white"
                      : "cursor-not-allowed bg-black/[0.08] text-black/30 dark:bg-white/[0.08] dark:text-white/25",
                  )}
                >
                  {props.isSending && media.attachment !== null ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <ArrowUp className="h-4 w-4 stroke-[2.4]" />
                  )}
                </motion.button>
              </span>
            </AppTooltip>
          </div>
        </div>
      </div>
    </footer>
  );
}
