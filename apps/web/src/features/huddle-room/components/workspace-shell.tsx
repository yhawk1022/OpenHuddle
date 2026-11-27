/**
 * @module web/features/huddle-room/workspace-shell
 * @description 已登录主工作台三栏外壳：左侧个人 Agent 导轨、群聊/通讯录侧栏与当前活动会话舞台（含移动端单栈抽屉适配）。
 *
 * 关键不变量：
 * 1. 单向特性边界：仅通过 `../../auth-pairing/index.js` 公共门面访问兄弟特性，禁止跨特性深层导入。
 * 2. 单一状态源：服务端数据统一由 `TanStack Query` 托管，全局单一 SSE 连接（`useRealtimeSseSync`）按 `seq` 对缓存做单调补丁更新。
 * 3. 粒度化工作台订阅：聊天模式下顶层外壳仅订阅 `useSoloWorkbenchCounts()`，避免个人工作台读秒触发全会话树重渲染。
 */
import type {
  AgentId,
  FriendContactDto,
  FriendshipId,
  HumanUserDto,
  LanguagePreference,
  MessageDto,
  MessageMention,
  OperationKey,
  OwnedAgentSummaryDto,
  ProposalCardDto,
  ProposalId,
  RoomId,
  RoomMemberDto,
  SharedExternalAgentDto,
  UpdateGovernanceBody,
  UserId,
} from "@openhuddle/protocol";
import { asReadCursorSeq } from "@openhuddle/protocol";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  ArrowDown,
  ChevronRight,
  Clock3,
  Command,
  Compass,
  Copy,
  FileText,
  Gauge,
  KeyRound,
  Languages,
  ListTodo,
  LogIn,
  LogOut,
  MessageCircle,
  Moon,
  Paperclip,
  Pin,
  Plus,
  RefreshCw,
  Shield,
  Sun,
  Trash2,
  UserPlus,
  UserRound,
  Users,
  X,
} from "lucide-react";
import {
  type DragEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { BrandMark } from "../../../components/brand-mark.js";
import {
  AnimatePresence,
  AppButton,
  AppCommandPalette,
  AppContextMenu,
  type AppContextMenuEntry,
  AppSheetDrawer,
  AppTooltip,
  type CommandPaletteGroup,
  INSTANT_TRANSITION,
  IconButton,
  NATIVE_PANEL_EXIT,
  NATIVE_PANEL_SPRING,
  NATIVE_PILL_SPRING,
  NATIVE_SURFACE_EXIT,
  NATIVE_SURFACE_SPRING,
  NATIVE_VIEW_SWAP,
  acquireHighRefreshBurst,
  cn,
  motion,
  setRefreshRatePreference,
  toast,
  useDisplayRefreshState,
  usePrefersReducedMotion,
} from "../../../components/primitives/index.js";
import {
  AgentProfileDialog,
  type InspectedAgentProfile,
} from "../../../components/ui/agent-profile-dialog.js";
import { PlatformAvatar } from "../../../components/ui/identity-badges.js";
import { MessageBubble } from "../../../components/ui/message-bubble.js";
import { resetAgentCapabilityPrefsMemory } from "../../../lib/agent-capability-prefs.js";
import { sendRoomMessage } from "../../../lib/api-client.js";
import {
  getPlatformVisualMeta,
  getReachVisualMeta,
  getRoomDisplayName,
  pickLatestIso,
  sortRoomsByLatestActivity,
} from "../../../lib/format.js";
import { resolveLocale, useCommonI18n } from "../../../lib/i18n/index.js";
import type { OptimisticMessageItem } from "../../../lib/query-keys.js";
import {
  navigateBackOr,
  navigateTo,
  useBrowserLocation,
  useSessionToken,
} from "../../../lib/session-store.js";
import { type SseConnectionStatus, useRealtimeSseSync } from "../../../lib/sse-sync.js";
import { useThemeMode } from "../../../lib/theme-store.js";
import {
  AccountSecurityModal,
  AccountThemeMenu,
  AgentOnboardingModal,
  type OnboardingModalTab,
  OtpSignInScreen,
  currentMeQueryOptions,
  useAccountLanguagePreference,
  useAccountThemePreference,
  useDeleteOwnedAgentMutation,
  useLogoutMutation,
  useUpdateOwnedAgentMutation,
} from "../../auth-pairing/index.js";
import { PwaInstallGuideModal } from "../../pwa-install/index.js";
import {
  friendsOverviewQueryOptions,
  joinedRoomsQueryOptions,
  roomDetailQueryOptions,
  roomMessagesQueryOptions,
  roomProposalsQueryOptions,
  systemHealthQueryOptions,
  useAcceptFriendRequestMutation,
  useCastProposalVoteMutation,
  useCreateProposalMutation,
  useCreateRoomMutation,
  useDecideProposalMutation,
  useDeclineFriendRequestMutation,
  useDeleteRoomMutation,
  useLeaveRoomMutation,
  useOpenDirectAgentRoomMutation,
  useOpenDirectHumanRoomMutation,
  useRecallMessageMutation,
  useRemoveFriendMutation,
  useSendFriendRequestMutation,
  useSendMessageMutation,
  useSynthesizeProposalMutation,
  useUpdateAnyRoomGovernanceMutation,
  useUpdateGovernanceMutation,
} from "../api/huddle-room.queries.js";
import {
  CHAT_SHELL_COMMAND_KEYWORDS,
  getChatShellTranslator,
  useChatShellI18n,
} from "../i18n/chat-shell.js";
import { type RoomNotificationState, reconcileRoomNotifications } from "../room-notifications.js";
import { saveRoomSticker } from "../stickers/sticker-library.js";
import {
  bindRoomWorkItemToSoloTask,
  clearRoomWorkItems,
  dispatchRoomWorkItem,
  loadRoomWorkShowcase,
  resetAllRoomWorkBuckets,
  useRoomWorkState,
} from "../work/room-work-store.js";
import {
  type SoloWorkTaskView,
  bindRoomToWorkspace,
  dispatchSoloWorkTask,
  getRoomBoundWorkspace,
  markSoloTaskEscalated,
  resetSoloWorkbenchMemory,
  useSoloWorkbenchCounts,
  useSoloWorkbenchState,
  useWorkspaceDirectory,
} from "../work/solo-workbench-store.js";
import {
  answerWorkAttentionOnServer,
  bindRoomWorkspaceOnServer,
  controlWorkTaskOnServer,
  decideWorkReviewOnServer,
  dispatchWorkbenchTaskOnServer,
  steerWorkTaskOnServer,
  useWorkspaceServerSync,
} from "../work/work-server-sync.js";
import type { WorkTopology } from "../work/work-types.js";
import { stripAgentOwnerPrefix } from "../work/work-utils.js";
import { AddFriendModal, EditFriendRemarkModal, InviteMembersModal } from "./friend-modals.js";
import { GovernanceBar } from "./governance-bar.js";
import { MessageComposer } from "./message-composer.js";
import { MobileMainTabBar } from "./mobile-main-tab-bar.js";
import { type InspectorTab, RoomInspector } from "./room-inspector.js";
import {
  CreateRoomModal,
  DeleteRoomConfirmModal,
  type DeleteRoomTarget,
  JoinRoomModal,
  LeaveRoomConfirmModal,
} from "./room-modals.js";
import { RoomSidebar, type SidebarSectionTab } from "./room-sidebar.js";
import { SoloWorkbench } from "./solo-workbench.js";
import { savedStickerQueryKey } from "./sticker-picker.js";
import { LiveRunFloatingBar, WorkTimelineMilestoneCard } from "./work-timeline-cards.js";

export { systemHealthQueryOptions };

/** 顶层空间工作模式：`chats` = 多人/1v1 聊天会话，`workbench` = 个人极速 AI 工作台 */
type WorkspaceSurfaceMode = "chats" | "workbench";

/** 连续发言分组的最大时间间隔（3 分钟） */
const GROUPING_WINDOW_MS = 3 * 60_000;

/** 距离底部小于该像素即视为「正在看最新消息」，新消息到达时自动跟随滚动 */
const NEAR_BOTTOM_THRESHOLD_PX = 120;

/** 右侧抽屉常驻断点（与 Tailwind `xl` 对齐） */
const WIDE_SCREEN_QUERY = "(min-width: 1280px)";
const DESKTOP_CHAT_QUERY = "(min-width: 48rem)";
const NOTIFICATION_RECOVERY_INTERVAL_MS = 5_000;

function parseSelectedRoomIdFromSearch(search: string): RoomId | null {
  const params = new URLSearchParams(search);
  const raw = params.get("room")?.trim();
  return raw && raw.length > 0 ? (raw as RoomId) : null;
}

function parseWorkspaceSurfaceFromSearch(search: string): WorkspaceSurfaceMode {
  const params = new URLSearchParams(search);
  return params.get("view") === "workbench" ? "workbench" : "chats";
}

function parseSelectedWorkspaceIdFromSearch(search: string): string | null {
  const params = new URLSearchParams(search);
  const raw = params.get("workspace")?.trim();
  return raw && raw.length > 0 ? raw : null;
}

function subscribeScreen(query: string, onChange: () => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) {
    return () => undefined;
  }
  const mql = window.matchMedia(query);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

function readScreen(query: string): boolean {
  return typeof window !== "undefined" && !!window.matchMedia
    ? window.matchMedia(query).matches
    : true;
}

/** 订阅 `xl` 断点：决定抽屉以「右侧悬浮分栏」还是「Vaul 手势抽屉」形式呈现 */
function useIsWideScreen(): boolean {
  return useSyncExternalStore(
    useCallback((onChange) => subscribeScreen(WIDE_SCREEN_QUERY, onChange), []),
    () => readScreen(WIDE_SCREEN_QUERY),
    () => true,
  );
}

function useIsDesktopChat(): boolean {
  return useSyncExternalStore(
    useCallback((onChange) => subscribeScreen(DESKTOP_CHAT_QUERY, onChange), []),
    () => readScreen(DESKTOP_CHAT_QUERY),
    () => true,
  );
}

function authorIdentityKey(message: MessageDto): string {
  return message.author.kind === "agent"
    ? `agent:${message.author.agentId ?? message.author.displayName}`
    : `human:${message.author.userId ?? message.author.displayName}`;
}

/**
 * 判断当前消息是否与上一条合并为同一发言组（隐藏重复头像与昵称）。
 *
 * @remarks 引用回复、撤回、提案/投票/系统消息均打断分组，确保语义节点始终带完整发送者上下文。
 */
function shouldGroupWithPrevious(prev: MessageDto, current: MessageDto): boolean {
  if (prev.type !== "text" || current.type !== "text") {
    return false;
  }
  if (current.replyToSeq !== undefined) {
    return false;
  }
  if (prev.recalledAtIso !== undefined || current.recalledAtIso !== undefined) {
    return false;
  }
  if (authorIdentityKey(prev) !== authorIdentityKey(current)) {
    return false;
  }
  const gap = Date.parse(current.createdAtIso) - Date.parse(prev.createdAtIso);
  return Number.isFinite(gap) && gap >= 0 && gap <= GROUPING_WINDOW_MS;
}

interface ActiveRoomStageProps {
  readonly roomId: RoomId;
  readonly currentUser: HumanUserDto;
  readonly friends: ReadonlyArray<FriendContactDto>;
  readonly friendRemarks: ReadonlyMap<UserId, string>;
  readonly ownedAgents: ReadonlyArray<OwnedAgentSummaryDto>;
  readonly synthesizeSignal: number;
  readonly realtimeLive: boolean;
  readonly onOpenAddAgentModal: (tab?: OnboardingModalTab, reclaimAgentId?: AgentId) => void;
  readonly onOpenAddFriend: () => void;
  readonly onStartDirectHumanChat: (userId: UserId) => void;
  readonly onSendFriendRequest: (userId: UserId, displayName: string) => void;
  readonly onStartDirectAgentChat: (agentId: AgentId) => void;
  readonly onBackToList: () => void;
  readonly onInspectAgent: (profile: InspectedAgentProfile) => void;
  readonly onOpenWorkbench: (workspaceId?: string | undefined) => void;
  readonly onRequestDeleteRoom: (room: DeleteRoomTarget) => void;
  readonly onRequestLeaveRoom: (room: DeleteRoomTarget) => void;
}

function ActiveRoomStage(props: ActiveRoomStageProps) {
  const { t, tp } = useChatShellI18n();
  const { t: commonT } = useCommonI18n();
  const queryClient = useQueryClient();
  const handleSaveSticker = async (message: MessageDto): Promise<void> => {
    const userId = props.currentUser.id;
    try {
      const result = await saveRoomSticker(userId, message);
      await queryClient.invalidateQueries({ queryKey: savedStickerQueryKey(userId) });
      toast.success(
        result === "added" ? t("stage.toast.stickerSaved") : t("stage.toast.stickerAlreadySaved"),
      );
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : t("stage.toast.stickerSaveFailed"));
    }
  };
  const detailQuery = useQuery(roomDetailQueryOptions(props.roomId));
  const messagesQuery = useQuery({
    ...roomMessagesQueryOptions(props.roomId),
    refetchInterval: props.realtimeLive ? false : NOTIFICATION_RECOVERY_INTERVAL_MS,
    refetchOnMount: "always",
    refetchOnReconnect: false,
  });
  const proposalsQuery = useQuery(roomProposalsQueryOptions(props.roomId));

  const governanceMutation = useUpdateGovernanceMutation(props.roomId);
  const sendMessageMutation = useSendMessageMutation(props.roomId, props.currentUser);
  const recallMutation = useRecallMessageMutation(props.roomId);
  const createProposalMutation = useCreateProposalMutation(props.roomId);
  const synthesizeMutation = useSynthesizeProposalMutation(props.roomId);
  const castVoteMutation = useCastProposalVoteMutation(props.roomId);
  const decideMutation = useDecideProposalMutation(props.roomId);

  const isWideScreen = useIsWideScreen();
  const reducedMotion = usePrefersReducedMotion();
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("members");
  // 留白呼吸不变量：桌面端默认收起右侧面板，让聊天舞台保持宽敞与平静；点击顶栏人数或提案胶囊时再按需展开
  const [desktopInspectorOpen, setDesktopInspectorOpen] = useState<boolean>(false);
  const [mobileInspectorOpen, setMobileInspectorOpen] = useState<boolean>(false);
  const [inviteMode, setInviteMode] = useState<"members" | "agents" | null>(null);
  const lastInviteModeRef = useRef<"members" | "agents">("members");
  if (inviteMode !== null) {
    lastInviteModeRef.current = inviteMode;
  }
  const [focusedProposalId, setFocusedProposalId] = useState<ProposalId | null>(null);
  const [focusedWorkItemId, setFocusedWorkItemId] = useState<string | null>(null);
  const [pendingDispatchSeed, setPendingDispatchSeed] = useState<{
    readonly nonce: number;
    readonly text?: string | undefined;
    readonly topology?: WorkTopology | undefined;
  } | null>(null);
  const [replyTarget, setReplyTarget] = useState<MessageDto | null>(null);
  const workState = useRoomWorkState(props.roomId);
  const workspaceDirectory = useWorkspaceDirectory();
  const boundWorkspaceId = workspaceDirectory.roomBindings[props.roomId] ?? null;
  const boundWorkspace = useMemo(
    () =>
      boundWorkspaceId !== null
        ? (workspaceDirectory.workspaces.find((w) => w.id === boundWorkspaceId) ?? null)
        : null,
    [boundWorkspaceId, workspaceDirectory.workspaces],
  );
  const [pendingQuickMention, setPendingQuickMention] = useState<MessageMention | null>(null);
  const [droppedFilesSignal, setDroppedFilesSignal] = useState<{
    readonly nonce: number;
    readonly files: ReadonlyArray<File>;
  } | null>(null);
  const [focusComposerSignal, setFocusComposerSignal] = useState<{
    readonly nonce: number;
    readonly appendText?: string | undefined;
  } | null>(null);
  const [isDraggingFiles, setIsDraggingFiles] = useState<boolean>(false);
  const dragDepthRef = useRef<number>(0);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const [showJumpToBottom, setShowJumpToBottom] = useState<boolean>(false);
  const [unseenCount, setUnseenCount] = useState<number>(0);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const nearBottomRef = useRef<boolean>(true);
  const lastRenderedCountRef = useRef<number>(0);
  const didInitialScrollRef = useRef<boolean>(false);
  const hydratedMaxSeqRef = useRef<number | null>(null);
  const stableKeyBySeqRef = useRef<Map<number, string>>(new Map());
  const pendingSentOpsRef = useRef<Array<{ readonly opKey: string; readonly content: string }>>([]);
  const handledSignalRef = useRef<number>(props.synthesizeSignal);

  // 每 15 秒刷新一次本地相对时钟，用于准确判断 2 分钟自助撤回窗口过期态
  useEffect(() => {
    const timer = window.setInterval(() => {
      setNowMs(Date.now());
    }, 15_000);
    return () => window.clearInterval(timer);
  }, []);

  // 响应全局 `⌘K` 命令面板发来的「整理当前群近期讨论为提案卡」指令
  useEffect(() => {
    if (props.synthesizeSignal === handledSignalRef.current) {
      return;
    }
    handledSignalRef.current = props.synthesizeSignal;
    setInspectorTab("proposals");
    if (isWideScreen) {
      setDesktopInspectorOpen(true);
    } else {
      setMobileInspectorOpen(true);
    }
    toast.info(t("stage.toast.synthesizing"));
    synthesizeMutation.mutate(
      { messageWindowLimit: 30 },
      {
        onSuccess: (res) => {
          setFocusedProposalId(res.proposal.id);
          setInspectorTab("proposals");
          toast.success(t("stage.toast.synthesized"));
        },
        onError: (err) => {
          toast.error(err instanceof Error ? err.message : t("stage.toast.synthesizeFailed"));
        },
      },
    );
  }, [isWideScreen, props.synthesizeSignal, synthesizeMutation, t]);

  const messages: ReadonlyArray<OptimisticMessageItem> = useMemo(
    () => messagesQuery.data?.messages ?? [],
    [messagesQuery.data],
  );
  const latestDisplayedSeq = messages.reduce(
    (latest, message) => (message._optimisticPending ? latest : Math.max(latest, message.seq)),
    0,
  );
  // 首帧数据水合完成后锁定历史消息最大序号：历史消息一律静态零动画挂载（杜绝百条弹簧阻塞主线程），仅此后的实时新消息启用弹簧入场
  if (hydratedMaxSeqRef.current === null && messagesQuery.isFetched) {
    hydratedMaxSeqRef.current = latestDisplayedSeq;
  }
  // 当 SSE 广播比 HTTP 201 响应提前数毫秒抵达时，将乐观 _opKey 继承给对应的确认消息 seq，防止 React key 突变引发二次卸载重弹跳
  for (const msg of messages) {
    if (
      !msg._optimisticPending &&
      msg.author.isYou &&
      !stableKeyBySeqRef.current.has(msg.seq) &&
      pendingSentOpsRef.current.length > 0
    ) {
      const matchIdx = pendingSentOpsRef.current.findIndex(
        (item) => item.content === msg.content.trim(),
      );
      if (matchIdx >= 0) {
        const matched = pendingSentOpsRef.current[matchIdx];
        if (matched !== undefined) {
          stableKeyBySeqRef.current.set(msg.seq, matched.opKey);
          pendingSentOpsRef.current.splice(matchIdx, 1);
        }
      }
    }
  }
  const latestDisplayedMessageAtIso = messages.reduce<string | undefined>(
    (latestIso, message) =>
      message._optimisticPending ? latestIso : pickLatestIso(latestIso, message.createdAtIso),
    undefined,
  );
  useEffect(() => {
    if (
      messagesQuery.dataUpdatedAt === 0 ||
      latestDisplayedSeq === 0 ||
      document.visibilityState !== "visible"
    ) {
      return;
    }
    // 打开会话后同步销掉侧栏红点，并同步可能经由轮询补拉到的最新消息时间与会话排序。
    queryClient.setQueryData(joinedRoomsQueryOptions().queryKey, (previous) => {
      if (!previous) {
        return previous;
      }
      let didUpdateLatestMessageAt = false;
      const updatedRooms = previous.rooms.map((room) => {
        if (room.id !== props.roomId) {
          return room;
        }
        const nextLastMessageAtIso = pickLatestIso(
          room.lastMessageAtIso,
          latestDisplayedMessageAtIso,
        );
        const messageTimeAdvanced = nextLastMessageAtIso !== room.lastMessageAtIso;
        if (latestDisplayedSeq <= room.yourLastReadSeq && !messageTimeAdvanced) {
          return room;
        }
        if (messageTimeAdvanced) {
          didUpdateLatestMessageAt = true;
        }
        return {
          ...room,
          lastSeq: asReadCursorSeq(Math.max(room.lastSeq, latestDisplayedSeq)),
          yourLastReadSeq: asReadCursorSeq(Math.max(room.yourLastReadSeq, latestDisplayedSeq)),
          ...(nextLastMessageAtIso !== undefined ? { lastMessageAtIso: nextLastMessageAtIso } : {}),
        };
      });
      return {
        ...previous,
        rooms: didUpdateLatestMessageAt ? sortRoomsByLatestActivity(updatedRooms) : updatedRooms,
      };
    });
  }, [
    latestDisplayedMessageAtIso,
    latestDisplayedSeq,
    messagesQuery.dataUpdatedAt,
    props.roomId,
    queryClient,
  ]);
  const proposals: ReadonlyArray<ProposalCardDto> = useMemo(
    () => proposalsQuery.data?.proposals ?? [],
    [proposalsQuery.data],
  );

  const scrollToBottom = useCallback((behavior: ScrollBehavior): void => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTo({ top: el.scrollHeight, behavior });
    }
  }, []);

  const handleTimelineScroll = (): void => {
    const el = scrollRef.current;
    if (!el) {
      return;
    }
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    const near = distance < NEAR_BOTTOM_THRESHOLD_PX;
    nearBottomRef.current = near;
    setShowJumpToBottom(!near);
    if (near) {
      setUnseenCount(0);
    }
  };

  const isDetailReady = detailQuery.isSuccess;

  // A resized composer or software keyboard changes the available message area.
  useEffect(() => {
    const timeline = scrollRef.current;
    if (!isDetailReady || !timeline || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (nearBottomRef.current) scrollToBottom("auto");
    });
    observer.observe(timeline);
    return () => observer.disconnect();
  }, [isDetailReady, scrollToBottom]);

  // 原生桌面客户端快捷键与「直接打字聚焦输入框（Type-to-Chat）」响应链
  useEffect(() => {
    const handleStageKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.isComposing) {
        return;
      }
      // ⌘. 或 ⌘\（Windows/Linux Ctrl+\）：一键开合右侧会话信息/任务/提案分栏
      if ((event.metaKey || event.ctrlKey) && (event.key === "." || event.key === "\\")) {
        event.preventDefault();
        if (isWideScreen) {
          setDesktopInspectorOpen((open) => !open);
        } else {
          setMobileInspectorOpen((open) => !open);
        }
        return;
      }

      const hasTopOverlay =
        document.querySelector('[role="dialog"], [data-radix-popper-content-wrapper]') !== null;
      if (hasTopOverlay) {
        return;
      }

      if (event.key === "Escape") {
        if (replyTarget !== null) {
          event.preventDefault();
          setReplyTarget(null);
          return;
        }
        const openNow = isWideScreen ? desktopInspectorOpen : mobileInspectorOpen;
        if (openNow) {
          event.preventDefault();
          if (isWideScreen) {
            setDesktopInspectorOpen(false);
          } else {
            setMobileInspectorOpen(false);
          }
          return;
        }
      }

      // Type-to-Chat：在聊天舞台浏览消息且焦点不在任何可编辑控件内时，按下可打印字符立即聚焦底部输入舱并填入首字符
      if (
        event.key.length === 1 &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        event.key !== " "
      ) {
        const active = document.activeElement as HTMLElement | null;
        const isEditable =
          active !== null &&
          (active.tagName === "INPUT" ||
            active.tagName === "TEXTAREA" ||
            active.tagName === "SELECT" ||
            active.isContentEditable);
        if (!isEditable) {
          event.preventDefault();
          setFocusComposerSignal({ nonce: Date.now(), appendText: event.key });
        }
      }
    };

    window.addEventListener("keydown", handleStageKeyDown);
    return () => window.removeEventListener("keydown", handleStageKeyDown);
  }, [desktopInspectorOpen, isWideScreen, mobileInspectorOpen, replyTarget]);

  const handleStageDragEnter = (event: DragEvent<HTMLDivElement>): void => {
    if (!event.dataTransfer.types.includes("Files")) {
      return;
    }
    event.preventDefault();
    dragDepthRef.current += 1;
    setIsDraggingFiles(true);
  };

  const handleStageDragOver = (event: DragEvent<HTMLDivElement>): void => {
    if (!event.dataTransfer.types.includes("Files")) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };

  const handleStageDragLeave = (event: DragEvent<HTMLDivElement>): void => {
    if (!event.dataTransfer.types.includes("Files")) {
      return;
    }
    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) {
      setIsDraggingFiles(false);
    }
  };

  const handleStageDrop = (event: DragEvent<HTMLDivElement>): void => {
    if (!event.dataTransfer.types.includes("Files")) {
      return;
    }
    event.preventDefault();
    dragDepthRef.current = 0;
    setIsDraggingFiles(false);
    const files = Array.from(event.dataTransfer.files);
    if (files.length > 0) {
      setDroppedFilesSignal({ nonce: Date.now(), files });
    }
  };

  // 新消息滚动策略：首屏瞬时定位到底；之后仅在用户贴底或自己发送时平滑跟随，否则累计未看计数
  useEffect(() => {
    if (!isDetailReady || scrollRef.current === null) {
      return;
    }
    const count = messages.length;
    const prev = lastRenderedCountRef.current;
    lastRenderedCountRef.current = count;
    if (count === 0) {
      return;
    }
    if (!didInitialScrollRef.current) {
      didInitialScrollRef.current = true;
      window.requestAnimationFrame(() => scrollToBottom("auto"));
      return;
    }
    if (count <= prev) {
      return;
    }
    const newest = messages[count - 1];
    if (nearBottomRef.current || newest?.author.isYou === true) {
      window.requestAnimationFrame(() => scrollToBottom("smooth"));
    } else {
      setUnseenCount((c) => c + (count - prev));
    }
  }, [messages, isDetailReady, scrollToBottom]);

  const messageBySeq = useMemo(() => {
    const map = new Map<number, MessageDto>();
    for (const msg of messages) {
      if (!msg._optimisticPending) {
        map.set(msg.seq, msg);
      }
    }
    return map;
  }, [messages]);

  const groupedFlags: ReadonlyArray<boolean> = useMemo(
    () =>
      messages.map((message, index) => {
        const prev = index > 0 ? messages[index - 1] : undefined;
        return prev !== undefined && shouldGroupWithPrevious(prev, message);
      }),
    [messages],
  );

  const proposalByOriginSeq = useMemo(() => {
    const map = new Map<number, ProposalCardDto>();
    for (const prop of proposals) {
      map.set(prop.originMessageSeq, prop);
    }
    return map;
  }, [proposals]);

  const { memberByAgentId, remarkByUserId } = useMemo(() => {
    const memberByAgentId = new Map<AgentId, RoomMemberDto>();
    const remarkByUserId = new Map<UserId, string>();
    for (const member of detailQuery.data?.room.members ?? []) {
      if (member.memberKind === "agent" && member.agentId !== undefined) {
        memberByAgentId.set(member.agentId, member);
      }
      if (
        member.memberKind === "human" &&
        member.userId !== undefined &&
        member.remark !== undefined
      ) {
        remarkByUserId.set(member.userId, member.remark);
      }
    }
    return { memberByAgentId, remarkByUserId };
  }, [detailQuery.data]);

  if (detailQuery.isPending) {
    return (
      <div className="oh-stage-frame relative flex min-w-0 flex-1 flex-col overflow-hidden md:rounded-[22px]">
        <div className="flex items-center justify-between gap-3 px-4 pt-3">
          <div className="h-12 w-48 animate-pulse rounded-full bg-black/[0.05] dark:bg-white/[0.06]" />
          <div className="h-12 w-56 animate-pulse rounded-full bg-black/[0.05] dark:bg-white/[0.06]" />
        </div>
        <div className="mx-auto w-full max-w-3xl flex-1 space-y-4 p-6 pt-8">
          {[1, 2, 3].map((sk) => (
            <div key={`stage-sk-${String(sk)}`} className="flex items-start gap-3">
              <div className="h-9 w-9 animate-pulse rounded-full bg-black/[0.05] dark:bg-white/[0.06]" />
              <div className="h-14 w-2/3 animate-pulse rounded-2xl bg-black/[0.04] dark:bg-white/[0.05]" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (detailQuery.isError || !detailQuery.data) {
    return (
      <div className="oh-stage-frame relative flex min-w-0 flex-1 flex-col items-center justify-center overflow-hidden p-8 text-center md:rounded-[22px]">
        <div className="relative liquid-glass-modal max-w-sm rounded-[24px] p-6">
          <AlertCircle className="mx-auto h-6 w-6 text-[#E5484D] dark:text-[#F87171]" />
          <h2 className="mt-2.5 text-[15px] font-semibold text-[#111318] dark:text-[#F2F2F4]">
            {t("stage.error.loadRoomTitle")}
          </h2>
          <p className="mt-1 text-xs text-[#687082] dark:text-[#8E8E96]">
            {t("stage.error.loadRoomDesc")}
          </p>
          <div className="mt-4 flex items-center justify-center gap-2">
            <AppButton
              variant="secondary"
              size="sm"
              onClick={props.onBackToList}
              className="md:hidden"
            >
              {t("stage.error.backToList")}
            </AppButton>
            <AppButton
              variant="primary"
              size="sm"
              leadingIcon={<RefreshCw className="h-3.5 w-3.5" />}
              onClick={() => void detailQuery.refetch()}
            >
              {t("stage.error.reload")}
            </AppButton>
          </div>
        </div>
      </div>
    );
  }

  const room = detailQuery.data.room;
  const roomDisplayName = getRoomDisplayName(room, props.friendRemarks);
  const liveGovernance = messagesQuery.data?.governance ?? room.governance;
  const openProposals = proposals.filter((p) => p.status === "open");
  const pinnedProposal = openProposals.reduce<ProposalCardDto | null>(
    (latest, proposal) =>
      latest === null || proposal.createdAtIso > latest.createdAtIso ? proposal : latest,
    null,
  );
  const isInspectorOpen = isWideScreen ? desktopInspectorOpen : mobileInspectorOpen;

  // 计算顶部悬浮岛与横幅条数，计入顶部安全区以确保灵动岛/Standalone 下 scrollTop=0 首条消息永不被遮挡
  const hasGovernanceSubBanner = liveGovernance.status === "paused_budget";
  const topTimelinePaddingClass =
    hasGovernanceSubBanner && pinnedProposal !== null
      ? "pt-[calc(162px+env(safe-area-inset-top,0px))]"
      : hasGovernanceSubBanner || pinnedProposal !== null
        ? "pt-[calc(118px+env(safe-area-inset-top,0px))]"
        : "pt-[calc(74px+env(safe-area-inset-top,0px))]";
  const bottomTimelinePaddingClass =
    workState.activeRunningItems.length > 0
      ? "pb-[calc(228px+env(safe-area-inset-bottom,0px))]"
      : replyTarget !== null || workState.items.length > 0 || pendingDispatchSeed !== null
        ? "pb-[calc(196px+env(safe-area-inset-bottom,0px))]"
        : "pb-[calc(148px+env(safe-area-inset-bottom,0px))]";

  // 通过消息中已盖章的用户 ID 匹配群备注，支持重名和历史消息的实时显示。
  const getAuthorRemark = (message: MessageDto | undefined | null): string | undefined => {
    const author = message?.author;
    return author?.kind === "human" && author.userId !== undefined
      ? remarkByUserId.get(author.userId)
      : undefined;
  };
  const replyTargetRemark = getAuthorRemark(replyTarget);

  const setInspectorOpen = (open: boolean): void => {
    if (isWideScreen) {
      setDesktopInspectorOpen(open);
    } else {
      setMobileInspectorOpen(open);
    }
  };

  const openInspectorAt = (tab: InspectorTab): void => {
    setInspectorTab(tab);
    setInspectorOpen(true);
  };

  const handleToggleMembersInspector = (): void => {
    if (isInspectorOpen && inspectorTab === "members") {
      setInspectorOpen(false);
      return;
    }
    setInspectorTab("members");
    setInspectorOpen(true);
  };

  const handleToggleTasksInspector = (): void => {
    if (isInspectorOpen && inspectorTab === "tasks") {
      setInspectorOpen(false);
      return;
    }
    setInspectorTab("tasks");
    setInspectorOpen(true);
  };

  const handleOpenWorkItemInInspector = (workItemId: string): void => {
    setFocusedWorkItemId(workItemId);
    openInspectorAt("tasks");
  };

  const triggerComposerDispatch = (
    seedText?: string | undefined,
    topology?: WorkTopology | undefined,
  ): void => {
    setPendingDispatchSeed({
      nonce: Date.now(),
      ...(seedText !== undefined ? { text: seedText } : {}),
      ...(topology !== undefined ? { topology } : {}),
    });
  };

  const handleOpenProposalInInspector = (proposalId: ProposalId): void => {
    setFocusedProposalId(proposalId);
    openInspectorAt("proposals");
  };

  const inspectorNode = (
    <RoomInspector
      room={room}
      roomDisplayName={roomDisplayName}
      currentUserId={props.currentUser.id}
      governance={liveGovernance}
      isUpdatingGovernance={governanceMutation.isPending}
      activeTab={inspectorTab}
      onChangeTab={setInspectorTab}
      workItems={workState.items}
      activeRunningWorkItems={workState.activeRunningItems}
      needsHumanWorkItems={workState.needsHumanItems}
      workDefaults={workState.defaults}
      observeLogs={workState.observeLogs}
      focusedWorkItemId={focusedWorkItemId}
      onUpdateWorkDefaults={workState.setTopologyDefaults}
      onSteerWorkSlice={(wid, note, sid) => {
        void steerWorkTaskOnServer(wid, sid, note, props.roomId);
      }}
      onStopWorkItem={(wid) =>
        controlWorkTaskOnServer(wid, "stop", { roomId: props.roomId }).then(() => undefined)
      }
      onRetryWorkItem={(wid) => {
        void controlWorkTaskOnServer(wid, "retry", { roomId: props.roomId });
      }}
      onAnswerWorkAttention={(wid, choice) =>
        answerWorkAttentionOnServer(wid, choice, props.roomId)
      }
      onDecideWorkReview={(wid, decision) => {
        void decideWorkReviewOnServer(
          wid,
          decision === "approve" ? "approve" : "request_changes",
          undefined,
          props.roomId,
        );
      }}
      onOpenComposerDispatch={(seedText) => triggerComposerDispatch(seedText)}
      onOpenWorkbench={props.onOpenWorkbench}
      onLoadWorkShowcase={(preset) =>
        loadRoomWorkShowcase({
          roomId: props.roomId,
          preset,
          latestSeq: latestDisplayedSeq,
          members: room.members,
          currentUserId: props.currentUser.id,
        })
      }
      onClearWorkShowcase={() => clearRoomWorkItems(props.roomId)}
      proposals={proposals}
      isLoadingProposals={proposalsQuery.isPending}
      isProposalsError={proposalsQuery.isError}
      onRetryProposals={() => void proposalsQuery.refetch()}
      focusedProposalId={focusedProposalId}
      isSynthesizing={synthesizeMutation.isPending}
      synthesizeError={synthesizeMutation.error}
      onSynthesizeProposal={(input) => {
        synthesizeMutation.mutate(input, {
          onSuccess: (res) => {
            setFocusedProposalId(res.proposal.id);
            setInspectorTab("proposals");
            toast.success(t("stage.toast.proposalSynthesized"));
          },
        });
      }}
      isCreatingProposal={createProposalMutation.isPending}
      createProposalError={createProposalMutation.error}
      onCreateProposal={(draft, onSuccessClear) => {
        createProposalMutation.mutate(draft, {
          onSuccess: (res) => {
            onSuccessClear();
            setFocusedProposalId(res.proposal.id);
            setInspectorTab("proposals");
          },
        });
      }}
      isSubmittingVote={castVoteMutation.isPending}
      isSubmittingDecision={decideMutation.isPending}
      onCastVote={(proposalId, body) =>
        castVoteMutation.mutate(
          { proposalId, body },
          {
            onSuccess: () => toast.success(t("stage.toast.voteSynced")),
            onError: (err) =>
              toast.error(err instanceof Error ? err.message : t("stage.toast.voteFailed")),
          },
        )
      }
      onDecideProposal={(proposalId, body) =>
        decideMutation.mutate(
          { proposalId, body },
          {
            onSuccess: (res) =>
              toast.success(
                res.proposal.status === "approved"
                  ? t("stage.toast.proposalApproved")
                  : t("stage.toast.proposalRejected"),
              ),
            onError: (err) =>
              toast.error(err instanceof Error ? err.message : t("stage.toast.decideFailed")),
          },
        )
      }
      onUpdateGovernance={(patch) =>
        governanceMutation.mutate(patch, {
          onError: (err) =>
            toast.error(err instanceof Error ? err.message : t("stage.toast.governanceFailed")),
        })
      }
      onInspectAgent={props.onInspectAgent}
      friends={props.friends}
      onOpenInviteMembersModal={() => {
        setMobileInspectorOpen(false);
        setInviteMode("members");
      }}
      onOpenInviteAgentsModal={() => {
        setMobileInspectorOpen(false);
        setInviteMode("agents");
      }}
      onStartDirectHumanChat={(uid) => {
        setMobileInspectorOpen(false);
        props.onStartDirectHumanChat(uid);
      }}
      onSendFriendRequest={props.onSendFriendRequest}
      onStartDirectAgentChat={(aid) => {
        setMobileInspectorOpen(false);
        props.onStartDirectAgentChat(aid);
      }}
      onQuickMention={(mention) => {
        setPendingQuickMention(mention);
        // 窄屏抽屉遮罩会挡住输入框，点名后自动收起；宽屏侧栏保持展开
        setMobileInspectorOpen(false);
      }}
      onRequestDeleteRoom={(targetRoom) => {
        setMobileInspectorOpen(false);
        props.onRequestDeleteRoom(targetRoom);
      }}
      onRequestLeaveRoom={(targetRoom) => {
        setMobileInspectorOpen(false);
        props.onRequestLeaveRoom(targetRoom);
      }}
      surfaceMode={isWideScreen ? "panel" : "sheet"}
      onClose={() => setInspectorOpen(false)}
    />
  );

  return (
    <div className="relative flex min-w-0 flex-1 overflow-hidden">
      {/* 中央通透聊天主舞台：全高消息流 + 悬浮双岛液态玻璃顶栏 + 悬浮液态玻璃输入舱 */}
      <div
        onDragEnter={handleStageDragEnter}
        onDragOver={handleStageDragOver}
        onDragLeave={handleStageDragLeave}
        onDrop={handleStageDrop}
        className="oh-stage-frame relative flex min-w-0 flex-1 flex-col overflow-hidden md:rounded-[22px] [--oh-avatar-ring:var(--oh-im-canvas)]"
      >
        {/* 全舞台原生文件拖放投递蒙层（零嵌套毛玻璃，仅在拖入外部文件时浮现） */}
        <AnimatePresence>
          {isDraggingFiles ? (
            <motion.div
              key="stage-file-drop-overlay"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.14 }}
              className="pointer-events-none absolute inset-2.5 z-30 flex items-center justify-center rounded-[20px] border-2 border-dashed border-[#181B22]/25 bg-im-canvas/82 dark:border-white/25 dark:bg-[#18181B]/86"
            >
              <motion.div
                initial={{ scale: 0.95, y: 6 }}
                animate={{ scale: 1, y: 0 }}
                exit={{ scale: 0.97, y: 4 }}
                transition={reducedMotion ? INSTANT_TRANSITION : NATIVE_PANEL_SPRING}
                className="relative liquid-glass-modal flex max-w-xs flex-col items-center gap-2 rounded-[22px] px-6 py-5 text-center"
              >
                <span className="flex h-10 w-10 items-center justify-center rounded-full bg-[#181B22] text-white dark:bg-[#EAEEF6] dark:text-[#111318]">
                  <Paperclip className="h-4 w-4" />
                </span>
                <p className="text-[14px] font-semibold text-[#111318] dark:text-[#F2F2F4]">
                  {t("stage.dropOverlay.title", { name: roomDisplayName })}
                </p>
                <p className="text-xs text-[#687082] dark:text-[#8E8E96]">
                  {room.kind === "direct_human"
                    ? t("stage.dropOverlay.descHuman")
                    : t("stage.dropOverlay.descAgent")}
                </p>
              </motion.div>
            </motion.div>
          ) : null}
        </AnimatePresence>
        {/* 顶部悬浮液态玻璃覆盖层（空白区域 pointer-events-none 允许直接滚动下方消息流） */}
        <div className="pointer-events-none absolute inset-x-0 top-0 z-20 bg-gradient-to-b from-[var(--oh-stage-scrim-mid)] to-transparent px-3 pt-[max(0.75rem,env(safe-area-inset-top,0px))] pb-3 sm:px-4">
          <GovernanceBar
            room={room}
            roomDisplayName={roomDisplayName}
            currentUserId={props.currentUser.id}
            governance={liveGovernance}
            proposalsCount={proposals.length}
            openProposalsCount={openProposals.length}
            tasksCount={workState.items.length}
            runningTasksCount={workState.activeRunningItems.length}
            needsAttentionTasksCount={workState.needsHumanItems.length}
            isTasksInspectorActive={isInspectorOpen && inspectorTab === "tasks"}
            isUpdatingGovernance={governanceMutation.isPending}
            isInspectorOpen={isInspectorOpen}
            onUpdateGovernance={(patch) => governanceMutation.mutate(patch)}
            onOpenInviteModal={() => setInviteMode("members")}
            onOpenTasks={handleToggleTasksInspector}
            onOpenProposals={() => openInspectorAt("proposals")}
            onToggleInspector={handleToggleMembersInspector}
            onBackToList={props.onBackToList}
          />

          {/* 悬浮置顶待拍板提案玻璃胶囊（仅存在 open 提案时出现） */}
          <AnimatePresence initial={false}>
            {pinnedProposal !== null ? (
              <motion.button
                key="pinned-open-proposal"
                type="button"
                initial={{ opacity: 0, y: -6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                transition={{ duration: 0.16, ease: "easeOut" }}
                onClick={() => handleOpenProposalInInspector(pinnedProposal.id)}
                className="pointer-events-auto relative liquid-glass-bar group mx-auto mt-2 flex w-full max-w-3xl cursor-pointer select-none items-center gap-2 overflow-hidden rounded-[16px] px-3.5 py-2 text-left text-xs transition hover:brightness-[1.02]"
              >
                <Pin className="h-3.5 w-3.5 shrink-0 rotate-45 text-[#D97706] dark:text-[#FBBF24]" />
                <span className="shrink-0 font-semibold text-[#78350F] dark:text-[#FCD34D]">
                  {openProposals.length > 1
                    ? t("stage.pinnedProposal.labelCount", { count: openProposals.length })
                    : t("stage.pinnedProposal.label")}
                </span>
                <span className="min-w-0 flex-1 truncate text-[#111318] dark:text-[#ECECEF]">
                  {pinnedProposal.draft.title}
                </span>
                <span className="inline-flex shrink-0 items-center gap-0.5 font-medium text-[#78350F] dark:text-[#FCD34D]">
                  <span className="hidden sm:inline">{t("stage.pinnedProposal.view")}</span>
                  <ChevronRight className="h-3.5 w-3.5 transition group-hover:translate-x-0.5" />
                </span>
              </motion.button>
            ) : null}
          </AnimatePresence>
        </div>

        {/* 通顶通底可滚动消息时间线（滚动至顶栏与底栏下方时自然呈现 Apple Liquid Glass 折射） */}
        <div
          ref={scrollRef}
          onScroll={handleTimelineScroll}
          className="oh-chat-timeline h-full overflow-y-auto overscroll-contain px-4 sm:px-6"
        >
          <div
            className={cn(
              "oh-chat-messages mx-auto flex max-w-3xl flex-col",
              topTimelinePaddingClass,
              bottomTimelinePaddingClass,
            )}
          >
            {messagesQuery.isError && (
              <div className="rounded-2xl bg-[#E5484D]/10 p-4 text-xs text-[#C81E1E] dark:bg-[#F05252]/15 dark:text-[#FCA5A5]">
                <div className="flex items-center justify-between gap-2">
                  <span>{t("stage.error.loadMessages")}</span>
                  <AppButton
                    variant="danger"
                    size="xs"
                    onClick={() => void messagesQuery.refetch()}
                  >
                    {commonT("action.retry")}
                  </AppButton>
                </div>
              </div>
            )}
            {messagesQuery.isPending ? (
              <div className="space-y-4">
                {[1, 2, 3].map((id) => (
                  <div key={`msg-sk-${String(id)}`} className="flex items-start gap-3">
                    <div className="h-9 w-9 animate-pulse rounded-full bg-black/[0.05] dark:bg-white/[0.06]" />
                    <div className="h-14 w-1/2 animate-pulse rounded-2xl bg-black/[0.04] dark:bg-white/[0.05]" />
                  </div>
                ))}
              </div>
            ) : messagesQuery.data === undefined ? null : messages.length === 0 ? (
              <div className="mx-auto my-14 max-w-md select-none px-4 text-center">
                {room.kind === "direct_agent" ? (
                  <PlatformAvatar
                    kind="agent"
                    displayName={room.peer?.displayName ?? room.name}
                    platform={room.peer?.kind === "agent" ? room.peer.platform : undefined}
                    reach={room.peer?.kind === "agent" ? room.peer.reach : undefined}
                    size="lg"
                    className="mx-auto mb-3.5 [&>div]:h-12 [&>div]:w-12 [&>div]:rounded-full [&>div]:text-[16px]"
                  />
                ) : room.kind === "direct_human" ? (
                  <PlatformAvatar
                    kind="human"
                    displayName={room.peer?.displayName ?? room.name}
                    size="lg"
                    className="mx-auto mb-3.5 [&>div]:h-12 [&>div]:w-12 [&>div]:rounded-full [&>div]:text-[16px]"
                  />
                ) : (
                  <BrandMark className="mx-auto mb-3.5 h-11 w-11 rounded-[12px] shadow-xs" />
                )}
                <h2 className="text-[18px] font-semibold tracking-[-0.02em] text-[#111318] dark:text-[#F2F2F4]">
                  {room.kind === "direct_agent"
                    ? t("stage.empty.directTitle", { name: room.name })
                    : room.kind === "direct_human"
                      ? t("stage.empty.directTitle", { name: roomDisplayName })
                      : room.name}
                </h2>
                <p className="mx-auto mt-2 text-[13.5px] leading-relaxed text-[#687082] dark:text-[#8E8E96]">
                  {room.kind === "direct_agent"
                    ? room.peer?.kind === "agent" && room.peer.ownerUserId !== props.currentUser.id
                      ? t("stage.empty.sharedAgentDesc", { owner: room.peer.ownerDisplayName })
                      : t("stage.empty.myAgentDesc")
                    : room.kind === "direct_human"
                      ? t("stage.empty.directHumanDesc")
                      : t("stage.empty.groupDesc")}
                </p>
                <div className="mt-5 flex flex-wrap items-center justify-center gap-2.5">
                  {room.kind === "group" ? (
                    <>
                      <AppButton
                        variant="primary"
                        size="md"
                        leadingIcon={<Users className="h-4 w-4" />}
                        onClick={() => setInviteMode("members")}
                      >
                        {t("stage.empty.inviteMembers")}
                      </AppButton>
                      <AppButton
                        variant="secondary"
                        size="md"
                        onClick={() => openInspectorAt("members")}
                      >
                        {t("stage.empty.viewMembers")}
                      </AppButton>
                    </>
                  ) : (
                    <AppButton
                      variant="secondary"
                      size="md"
                      onClick={() => openInspectorAt("members")}
                    >
                      {t("stage.empty.viewInfo")}
                    </AppButton>
                  )}
                </div>
              </div>
            ) : (
              // MessageBubble 自带间距，此处不再叠加 space-y
              messages.map((message, index) => {
                const replied =
                  message.replyToSeq !== undefined
                    ? messageBySeq.get(message.replyToSeq)
                    : undefined;
                const linkedProposal = proposalByOriginSeq.get(message.seq);
                const agentMember =
                  message.author.agentId !== undefined
                    ? memberByAgentId.get(message.author.agentId)
                    : undefined;
                if (message._optimisticPending !== true && message._opKey !== undefined) {
                  stableKeyBySeqRef.current.set(message.seq, message._opKey);
                }
                const key =
                  message._opKey ??
                  stableKeyBySeqRef.current.get(message.seq) ??
                  `seq-${String(message.seq)}`;
                const isLiveEntrance =
                  message._optimisticPending === true ||
                  (hydratedMaxSeqRef.current !== null && message.seq > hydratedMaxSeqRef.current);

                return (
                  <MessageBubble
                    key={key}
                    message={message}
                    animateEntrance={isLiveEntrance}
                    isGroupedWithPrevious={groupedFlags[index] === true}
                    repliedMessage={replied}
                    authorDisplayName={getAuthorRemark(message)}
                    repliedAuthorDisplayName={getAuthorRemark(replied)}
                    linkedProposal={linkedProposal}
                    authorOwnerName={agentMember?.ownerDisplayName}
                    authorReach={agentMember?.reach}
                    nowMs={nowMs}
                    isRecalling={recallMutation.isPending}
                    onReply={(msg) => setReplyTarget(msg)}
                    onSaveSticker={(msg) => void handleSaveSticker(msg)}
                    onQuickMention={(mention) => setPendingQuickMention(mention)}
                    onAnswerAttention={(replyToSeq, answer) => {
                      if (sendMessageMutation.isPending) {
                        return;
                      }
                      // ADR-0002：Attention 选项一键作答——直接以回复形式落库，免跳输入框
                      sendMessageMutation.mutate({
                        content: answer,
                        opKey:
                          `attn-answer-${String(replyToSeq)}-${Date.now().toString(36)}` as OperationKey,
                        replyToSeq,
                        mentions: [],
                      });
                    }}
                    onRecall={(seq) =>
                      recallMutation.mutate(seq, {
                        onSuccess: () => toast.success(t("stage.toast.messageRecalled")),
                      })
                    }
                    onOpenProposal={handleOpenProposalInInspector}
                    onConvertToWorkTask={(text) => triggerComposerDispatch(text)}
                    onInspectAgent={props.onInspectAgent}
                  />
                );
              })
            )}

            {/* 主时间线多 Agent 执行里程碑卡（无 backdrop-blur，保持 120Hz 顺滑滚动） */}
            {workState.items.length > 0 ? (
              <div className="mt-1">
                {[...workState.items].reverse().map((workItem) => (
                  <WorkTimelineMilestoneCard
                    key={workItem.id}
                    item={workItem}
                    onOpenInInspector={handleOpenWorkItemInInspector}
                    onAnswerAttention={(wid, choice) =>
                      answerWorkAttentionOnServer(wid, choice, props.roomId)
                    }
                    onStop={(wid) =>
                      controlWorkTaskOnServer(wid, "stop", { roomId: props.roomId }).then(
                        () => undefined,
                      )
                    }
                    onDecideReview={(wid, decision, note) => {
                      void decideWorkReviewOnServer(
                        wid,
                        decision === "approve" ? "approve" : "request_changes",
                        note,
                        props.roomId,
                      );
                    }}
                    onRetry={(wid) => {
                      void controlWorkTaskOnServer(wid, "retry", { roomId: props.roomId });
                    }}
                  />
                ))}
              </div>
            ) : null}
          </div>
        </div>

        {/* 底部悬浮弹性栈：「回到底部」玻璃胶囊 + 瞬态实时运行脉冲条 + 液态玻璃输入舱 */}
        <div className="oh-chat-dock pointer-events-none absolute inset-x-0 bottom-0 z-20 flex flex-col">
          <AnimatePresence>
            {showJumpToBottom ? (
              <motion.button
                key="jump-to-bottom-pill"
                type="button"
                initial={{ opacity: 0, y: 10, scale: 0.94 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 8, scale: 0.94 }}
                transition={{ type: "spring", stiffness: 500, damping: 34 }}
                onClick={() => {
                  scrollToBottom("smooth");
                  setUnseenCount(0);
                }}
                className={cn(
                  "oh-chat-jump pointer-events-auto relative mr-4 mb-1.5 inline-flex cursor-pointer select-none items-center gap-1.5 self-end rounded-full px-3.5 py-1.5 text-xs font-medium transition active:scale-[0.96] sm:mr-6",
                  unseenCount > 0
                    ? "bg-[#181B22] text-white shadow-md hover:bg-[#252A35] dark:bg-[#EAEEF6] dark:text-[#111318] dark:hover:bg-white"
                    : "liquid-glass-pill text-[#111318] dark:text-[#ECECEF]",
                )}
              >
                <ArrowDown className="h-3.5 w-3.5" />
                <span>
                  {unseenCount > 0
                    ? tp("stage.jump.newMessages", unseenCount)
                    : t("stage.jump.toBottom")}
                </span>
              </motion.button>
            ) : null}
          </AnimatePresence>

          <AnimatePresence initial={false}>
            {workState.activeRunningItems.length > 0 ? (
              <LiveRunFloatingBar
                key="live-run-floating-bar"
                activeItems={workState.activeRunningItems}
                onSteer={(wid, note) =>
                  void steerWorkTaskOnServer(wid, undefined, note, props.roomId)
                }
                onStop={(wid) =>
                  void controlWorkTaskOnServer(wid, "stop", { roomId: props.roomId })
                }
                onOpenTasksInspector={handleOpenWorkItemInInspector}
              />
            ) : null}
          </AnimatePresence>

          <MessageComposer
            roomName={roomDisplayName}
            roomKind={room.kind}
            members={room.members}
            currentUserId={props.currentUser.id}
            currentUserDisplayName={props.currentUser.displayName}
            boundWorkspace={boundWorkspace}
            orchestrationDefaults={workState.defaults}
            pendingDispatchSeed={pendingDispatchSeed}
            onConsumeDispatchSeed={() => setPendingDispatchSeed(null)}
            replyTarget={
              replyTarget !== null && replyTargetRemark !== undefined
                ? {
                    ...replyTarget,
                    author: { ...replyTarget.author, displayName: replyTargetRemark },
                  }
                : replyTarget
            }
            pendingQuickMention={pendingQuickMention}
            onConsumeQuickMention={() => setPendingQuickMention(null)}
            onClearReplyTarget={() => setReplyTarget(null)}
            droppedFilesSignal={droppedFilesSignal}
            onConsumeDroppedFiles={() => setDroppedFilesSignal(null)}
            focusComposerSignal={focusComposerSignal}
            onConsumeFocusSignal={() => setFocusComposerSignal(null)}
            isSending={sendMessageMutation.isPending}
            sendError={sendMessageMutation.error}
            onReconnectOfflineAgent={(agentId) => props.onOpenAddAgentModal("pair_agent", agentId)}
            onSendMessage={({
              content,
              opKey,
              replyToSeq,
              mentions,
              attachment,
              onConfirmed,
              onFailed,
              attention,
              workDispatch,
            }) => {
              if (attachment === undefined) {
                pendingSentOpsRef.current.push({ opKey, content: content.trim() });
              }
              sendMessageMutation.mutate(
                {
                  content,
                  opKey,
                  ...(replyToSeq !== undefined ? { replyToSeq } : {}),
                  ...(attachment !== undefined ? { attachment } : {}),
                  mentions,
                  ...(attention !== undefined
                    ? {
                        attention: {
                          question: attention.question,
                          options: [],
                          addresseeUserIds: attention.addresseeUserIds,
                          expiresAtIso: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
                        },
                      }
                    : {}),
                },
                {
                  onSuccess: (res) => {
                    stableKeyBySeqRef.current.set(res.message.seq, opKey);
                    pendingSentOpsRef.current = pendingSentOpsRef.current.filter(
                      (item) => item.opKey !== opKey,
                    );
                    onConfirmed();
                    if (workDispatch !== undefined) {
                      const boundWorkspace = getRoomBoundWorkspace(props.roomId);
                      if (boundWorkspace?.id.startsWith("wsp_")) {
                        void dispatchWorkbenchTaskOnServer({
                          rawPrompt: content,
                          topology: workDispatch.topology,
                          workspace: boundWorkspace,
                          ownedAgents: props.ownedAgents.filter((agent) =>
                            memberByAgentId.has(agent.id),
                          ),
                          ...(workDispatch.executorAgentId !== undefined
                            ? { preferredWorkerId: workDispatch.executorAgentId }
                            : {}),
                          ...(workDispatch.verifierAgentId !== undefined
                            ? { preferredVerifierId: workDispatch.verifierAgentId }
                            : {}),
                          roomId: props.roomId,
                        }).catch((err: unknown) => {
                          toast.error(
                            err instanceof Error
                              ? err.message
                              : t("stage.toast.dispatchTaskFailed"),
                          );
                        });
                      } else {
                        const createdRoomWork = dispatchRoomWorkItem({
                          roomId: props.roomId,
                          anchorSeq: res.message.seq,
                          content,
                          members: room.members,
                          currentUserId: props.currentUser.id,
                          payload: workDispatch,
                        });
                        if (
                          boundWorkspace !== null &&
                          createdRoomWork.primaryWorker.isOwnedByViewer
                        ) {
                          const createdSolo = dispatchSoloWorkTask({
                            rawPrompt: content,
                            topology: workDispatch.topology,
                            repoId: boundWorkspace.id,
                            ownedAgents: props.ownedAgents,
                            ownerDisplayName: props.currentUser.displayName,
                            ...(workDispatch.executorAgentId !== undefined
                              ? { preferredWorkerId: workDispatch.executorAgentId }
                              : {}),
                            ...(workDispatch.verifierAgentId !== undefined
                              ? { preferredVerifierId: workDispatch.verifierAgentId }
                              : {}),
                            linkedRoomId: props.roomId,
                            linkedRoomWorkId: createdRoomWork.id,
                          });
                          bindRoomWorkItemToSoloTask(
                            props.roomId,
                            createdRoomWork.id,
                            createdSolo.id,
                          );
                        }
                      }
                    }
                    setReplyTarget((current) => (current?.seq === replyToSeq ? null : current));
                    if (attachment !== undefined) {
                      sendMessageMutation.reset();
                    }
                  },
                  onError: () => {
                    pendingSentOpsRef.current = pendingSentOpsRef.current.filter(
                      (item) => item.opKey !== opKey,
                    );
                    onFailed?.();
                  },
                },
              );
            }}
          />
        </div>
      </div>

      {/* 宽屏（xl+）按需展开的右侧悬浮液态玻璃群信息分栏（GPU transform/opacity 滑入收起，固定内宽零排版重流） */}
      <AnimatePresence initial={false}>
        {isWideScreen && desktopInspectorOpen ? (
          <motion.div
            key="desktop-room-inspector"
            initial={reducedMotion ? { opacity: 0 } : { opacity: 0, x: 16, scale: 0.99 }}
            animate={{
              opacity: 1,
              x: 0,
              scale: 1,
              transition: reducedMotion ? INSTANT_TRANSITION : NATIVE_PANEL_SPRING,
            }}
            exit={
              reducedMotion
                ? { opacity: 0, pointerEvents: "none", transition: INSTANT_TRANSITION }
                : {
                    opacity: 0,
                    x: 12,
                    scale: 0.99,
                    pointerEvents: "none",
                    transition: NATIVE_PANEL_EXIT,
                  }
            }
            className="flex shrink-0 will-change-[transform,opacity] xl:ml-2.5"
          >
            {inspectorNode}
          </motion.div>
        ) : null}
      </AnimatePresence>

      {/* 窄屏（< xl）群信息抽屉：Vaul 物理手势抽屉（由 RoomInspector 独占内部唯一滚动容器） */}
      {!isWideScreen ? (
        <AppSheetDrawer
          open={mobileInspectorOpen}
          onOpenChange={setMobileInspectorOpen}
          title={room.kind === "group" ? t("stage.drawer.groupInfo") : t("stage.drawer.chatInfo")}
          subtitle={roomDisplayName}
          side="right"
          mobileAsBottomSheet={true}
          hideHeader={true}
          disableBodyScroll={true}
          className="p-0"
        >
          {inspectorNode}
        </AppSheetDrawer>
      ) : null}

      {room.kind === "group" ? (
        <InviteMembersModal
          open={inviteMode !== null}
          mode={inviteMode ?? lastInviteModeRef.current}
          onClose={() => setInviteMode(null)}
          roomId={room.id}
          roomName={room.name}
          existingMembers={room.members}
          friends={props.friends}
          ownedAgents={props.ownedAgents}
          onOpenAddFriend={props.onOpenAddFriend}
          onOpenPairAgent={() => props.onOpenAddAgentModal("pair_agent")}
        />
      ) : null}
    </div>
  );
}

/** 左侧 `72px` 个人与 Agent 垂直导轨入参 */
interface PersonalAgentRailProps {
  readonly currentUser: HumanUserDto;
  readonly ownedAgents: ReadonlyArray<OwnedAgentSummaryDto>;
  readonly surfaceMode: WorkspaceSurfaceMode;
  readonly chatUnreadCount: number;
  readonly workbenchNeedsYouCount: number;
  readonly workbenchRunningCount: number;
  readonly onSelectSurface: (mode: WorkspaceSurfaceMode) => void;
  readonly onStartDirectAgentChat: (agentId: AgentId) => void;
  readonly onInspectAgent: (agent: OwnedAgentSummaryDto) => void;
  readonly onReclaimAgent: (agentId: AgentId) => void;
  readonly onRequestDeleteAgent: (agent: OwnedAgentSummaryDto) => void;
  readonly onOpenConnectAgent: () => void;
  readonly onOpenAccountSecurity: () => void;
  readonly onOpenCommandPalette: () => void;
  readonly onOpenAdminConsole: () => void;
  readonly onLogout: () => void;
}

interface ConnectedSoloWorkbenchProps {
  readonly currentUser: HumanUserDto;
  readonly ownedAgents: ReadonlyArray<OwnedAgentSummaryDto>;
  readonly initialWorkspaceId: string | null;
  readonly escalatingTaskId: string | null;
  readonly onEscalateToHuddle: (task: SoloWorkTaskView) => void;
  readonly onOpenEscalatedRoom: (roomId: RoomId) => void;
  readonly onSwitchToChats: () => void;
  readonly onOpenConnectAgent: () => void;
  readonly onInspectOwnedAgent: (agent: OwnedAgentSummaryDto) => void;
  readonly onOpenAccountSecurity: () => void;
}

/**
 * 仅在 `surfaceMode === "workbench"` 激活时挂载完整工作台状态与定时器订阅。
 */
function ConnectedSoloWorkbench(props: ConnectedSoloWorkbenchProps) {
  const soloState = useSoloWorkbenchState(props.ownedAgents, props.currentUser.displayName);
  return (
    <SoloWorkbench
      currentUser={props.currentUser}
      ownedAgents={props.ownedAgents}
      repos={soloState.repos}
      tasks={soloState.tasks}
      counts={soloState.counts}
      initialWorkspaceId={props.initialWorkspaceId}
      escalatingTaskId={props.escalatingTaskId}
      onEscalateToHuddle={props.onEscalateToHuddle}
      onOpenEscalatedRoom={props.onOpenEscalatedRoom}
      onSwitchToChats={props.onSwitchToChats}
      onOpenConnectAgent={props.onOpenConnectAgent}
      onInspectOwnedAgent={props.onInspectOwnedAgent}
      onOpenAccountSecurity={props.onOpenAccountSecurity}
    />
  );
}

/**
 * 左侧 `72px` 个人身份与已绑定 Agent 垂直导航栏。
 */
function PersonalAgentRail(props: PersonalAgentRailProps) {
  const { locale, t } = useChatShellI18n();
  const reducedMotion = usePrefersReducedMotion();

  return (
    <nav
      aria-label={t("rail.ariaLabel")}
      data-tauri-drag-region=""
      className="app-drag-region relative liquid-glass-panel hidden w-[72px] shrink-0 select-none flex-col items-center pt-4 pb-3 md:flex md:rounded-[22px] [--oh-avatar-ring:#F4F6FA] dark:[--oh-avatar-ring:#1E1E22]"
    >
      {/* 1. 顶部个人身份：纯净浮起圆形头像 + `我`（点击打开账号设置弹窗，告别多层灰环套娃） */}
      <AppTooltip
        side="right"
        content={t("rail.profileTooltip", {
          name: props.currentUser.displayName,
          email: props.currentUser.email,
        })}
      >
        <button
          type="button"
          onClick={props.onOpenAccountSecurity}
          aria-label={t("rail.openAccountSettings")}
          className="im-press app-no-drag group relative flex w-full shrink-0 cursor-pointer flex-col items-center"
        >
          <div className="rounded-full shadow-[0_2px_8px_rgba(15,23,42,0.08)] ring-[1.5px] ring-white/95 transition-transform duration-150 group-hover:scale-[1.04] dark:shadow-[0_2px_10px_rgba(0,0,0,0.4)] dark:ring-white/18">
            <PlatformAvatar
              kind="human"
              displayName={props.currentUser.displayName}
              size="lg"
              className="[&>div]:h-[38px] [&>div]:w-[38px] [&>div]:rounded-full [&>div]:text-[14px]"
            />
          </div>
          <span className="mt-1.5 max-w-full truncate px-0.5 text-[11px] font-medium leading-none text-[#3B414E] transition-colors group-hover:text-[#111318] dark:text-[#C4C4CA] dark:group-hover:text-white">
            {t("rail.me")}
          </span>
        </button>
      </AppTooltip>

      {/* 1b. 顶层双模式切换舱：`会话`（多人/多主群聊） vs `工作台`（1 人 + 我的 Agent 舰队极速执行），采用 layoutId 弹簧滑动底衬 */}
      <div
        role="tablist"
        aria-label={t("rail.surfaceTabsAria")}
        className="app-no-drag mt-3 flex w-[56px] shrink-0 flex-col gap-1 rounded-[16px] bg-black/[0.038] p-1 dark:bg-white/[0.05]"
      >
        <AppTooltip side="right" shortcut="⌥1" content={t("rail.chatsTooltip")}>
          <button
            type="button"
            role="tab"
            aria-selected={props.surfaceMode === "chats"}
            onClick={() => props.onSelectSurface("chats")}
            className={cn(
              "im-press relative z-0 flex w-full cursor-pointer flex-col items-center gap-0.5 rounded-[12px] py-1.5",
              props.surfaceMode === "chats"
                ? "text-[#111318] dark:text-[#F4F4F6]"
                : "text-[#5A6272] hover:text-[#111318] dark:text-[#9B9BA3] dark:hover:text-white",
            )}
          >
            {props.surfaceMode === "chats" ? (
              <motion.span
                layoutId="oh-rail-surface-pill"
                aria-hidden="true"
                transition={reducedMotion ? INSTANT_TRANSITION : NATIVE_PILL_SPRING}
                className="pointer-events-none absolute inset-0 -z-10 rounded-[12px] bg-white shadow-[0_1px_4px_rgba(15,23,42,0.08)] ring-1 ring-black/[0.05] will-change-transform dark:bg-[#27272C] dark:ring-white/[0.1]"
              />
            ) : null}
            <MessageCircle className="h-4 w-4" />
            <span className="max-w-full truncate px-0.5 text-[10px] font-medium leading-none">
              {t("rail.chats")}
            </span>
            {props.chatUnreadCount > 0 ? (
              <span className="absolute top-1 right-1.5 h-1.5 w-1.5 rounded-full bg-[#E5484D] dark:bg-[#F05252]" />
            ) : null}
          </button>
        </AppTooltip>

        <AppTooltip side="right" shortcut="⌥2" content={t("rail.workbenchTooltip")}>
          <button
            type="button"
            role="tab"
            aria-selected={props.surfaceMode === "workbench"}
            onClick={() => props.onSelectSurface("workbench")}
            className={cn(
              "im-press relative z-0 flex w-full cursor-pointer flex-col items-center gap-0.5 rounded-[12px] py-1.5",
              props.surfaceMode === "workbench"
                ? "text-[#111318] dark:text-[#F4F4F6]"
                : "text-[#5A6272] hover:text-[#111318] dark:text-[#9B9BA3] dark:hover:text-white",
            )}
          >
            {props.surfaceMode === "workbench" ? (
              <motion.span
                layoutId="oh-rail-surface-pill"
                aria-hidden="true"
                transition={reducedMotion ? INSTANT_TRANSITION : NATIVE_PILL_SPRING}
                className="pointer-events-none absolute inset-0 -z-10 rounded-[12px] bg-white shadow-[0_1px_4px_rgba(15,23,42,0.08)] ring-1 ring-black/[0.05] will-change-transform dark:bg-[#27272C] dark:ring-white/[0.1]"
              />
            ) : null}
            <ListTodo className="h-4 w-4" />
            <span className="max-w-full truncate px-0.5 text-[10px] font-medium leading-none">
              {t("rail.workbench")}
            </span>
            {props.workbenchNeedsYouCount > 0 ? (
              <span className="absolute top-1 right-1.5 h-1.5 w-1.5 rounded-full bg-[#F59E0B]" />
            ) : props.workbenchRunningCount > 0 ? (
              <span className="absolute top-1 right-1.5 h-1.5 w-1.5 rounded-full bg-[#22C55E] animate-pulse" />
            ) : null}
          </button>
        </AppTooltip>
      </div>

      <div
        aria-hidden="true"
        className="mt-2.5 h-px w-7 shrink-0 bg-black/[0.06] dark:bg-white/[0.08]"
      />

      {/* 2. 中部可滚动区：已连接的个人 Agents + 虚线圆形 `+ 接入 Agent`（必须携带 min-h-0 确保高倍率缩放矮视口下可滚动不挤爆顶底） */}
      <div className="my-2.5 flex min-h-0 w-full flex-1 flex-col items-center gap-2.5 overflow-y-auto px-1 [scrollbar-width:none]">
        {props.ownedAgents.map((agent) => {
          const agentHandle = `@${agent.slug}`;
          const compactLabel = stripAgentOwnerPrefix(
            agent.displayName,
            props.currentUser.displayName,
          );
          const platformMeta = getPlatformVisualMeta(agent.platform, locale);
          const reachMeta = getReachVisualMeta(agent.reach, locale);
          const railAgentMenuItems: ReadonlyArray<AppContextMenuEntry> = [
            {
              id: `ctx-rail-dm-${agent.id}`,
              label: t("sidebar.contacts.message"),
              icon: <MessageCircle className="h-3.5 w-3.5" />,
              onSelect: () => props.onStartDirectAgentChat(agent.id),
            },
            {
              id: `ctx-rail-inspect-${agent.id}`,
              label: t("sidebar.agents.viewProfile"),
              icon: <UserRound className="h-3.5 w-3.5" />,
              onSelect: () => props.onInspectAgent(agent),
            },
            {
              id: `ctx-rail-copy-${agent.id}`,
              label: t("sidebar.agents.copyHandle", { handle: agentHandle }),
              icon: <Copy className="h-3.5 w-3.5" />,
              onSelect: () => {
                if (typeof navigator !== "undefined" && navigator.clipboard) {
                  void navigator.clipboard.writeText(agentHandle).then(() => {
                    toast.success(t("sidebar.agents.copiedHandleToast"), {
                      description: agentHandle,
                    });
                  });
                }
              },
            },
            {
              id: `ctx-rail-reclaim-${agent.id}`,
              label: t("sidebar.agents.reconnect"),
              icon: <KeyRound className="h-3.5 w-3.5" />,
              onSelect: () => props.onReclaimAgent(agent.id),
            },
            { kind: "separator", id: `ctx-rail-sep-danger-${agent.id}` },
            {
              id: `ctx-rail-delete-${agent.id}`,
              label: t("sidebar.agents.delete"),
              icon: <Trash2 className="h-3.5 w-3.5" />,
              danger: true,
              onSelect: () => props.onRequestDeleteAgent(agent),
            },
          ];

          return (
            <AppContextMenu key={agent.id} items={railAgentMenuItems}>
              <div className="app-no-drag group relative flex w-full flex-col items-center rounded-2xl py-1 transition-colors hover:bg-white/55 data-[state=open]:bg-white/75 dark:hover:bg-white/[0.045] dark:data-[state=open]:bg-white/[0.08]">
                <AppTooltip
                  side="right"
                  content={`${agent.displayName} · ${platformMeta.label} · ${reachMeta.shortLabel}`}
                >
                  <button
                    type="button"
                    onClick={() => props.onInspectAgent(agent)}
                    aria-label={t("rail.inspectAgentAria", { name: agent.displayName })}
                    className="flex w-full cursor-pointer flex-col items-center gap-1 transition active:scale-[0.96]"
                  >
                    <PlatformAvatar
                      kind="agent"
                      displayName={agent.displayName}
                      platform={agent.platform}
                      reach={agent.reach}
                      size="md"
                      className="transition-transform duration-150 group-hover:scale-[1.04] [&>div]:h-9 [&>div]:w-9 [&>div]:rounded-full"
                    />
                    <span className="block w-[60px] truncate text-center text-[10.5px] font-medium leading-tight text-[#4B5565] transition-colors group-hover:text-[#111318] dark:text-[#9B9BA3] dark:group-hover:text-white">
                      {compactLabel}
                    </span>
                  </button>
                </AppTooltip>
                <AppTooltip
                  side="right"
                  content={t("sidebar.agents.deleteAria", { name: agent.displayName })}
                >
                  <button
                    type="button"
                    aria-label={t("sidebar.agents.deleteAria", { name: agent.displayName })}
                    onClick={(event) => {
                      event.stopPropagation();
                      props.onRequestDeleteAgent(agent);
                    }}
                    className="absolute top-0.5 right-2 flex h-4 w-4 cursor-pointer items-center justify-center rounded-full bg-white text-[#687082] opacity-0 shadow-xs ring-1 ring-black/8 transition hover:bg-[#E5484D] hover:text-white hover:ring-[#E5484D] focus-visible:opacity-100 group-hover:opacity-100 dark:bg-[#27272B] dark:text-[#C4C4CA] dark:ring-white/15 dark:hover:bg-[#F05252] dark:hover:text-white dark:hover:ring-[#F05252]"
                  >
                    <X className="h-2.5 w-2.5 stroke-[2.4]" />
                  </button>
                </AppTooltip>
              </div>
            </AppContextMenu>
          );
        })}

        {/* 轻透虚线圆环 `+` 按钮 + `接入 Agent` */}
        <button
          type="button"
          onClick={props.onOpenConnectAgent}
          aria-label={t("rail.connectAgentAria")}
          className="app-no-drag group flex w-full cursor-pointer flex-col items-center gap-1 transition active:scale-[0.96]"
        >
          <span className="flex h-9 w-9 items-center justify-center rounded-full border border-dashed border-black/20 bg-black/[0.03] text-[#687082] transition group-hover:border-[#181B22]/50 group-hover:bg-white/75 group-hover:text-[#111318] dark:border-white/20 dark:bg-white/[0.04] dark:text-[#8E8E96] dark:group-hover:border-white/45 dark:group-hover:bg-white/[0.10] dark:group-hover:text-white">
            <Plus className="h-4 w-4 stroke-[1.9]" />
          </span>
          <span className="max-w-full truncate px-0.5 text-center text-[10px] leading-[1.24] text-[#687082] transition-colors group-hover:text-[#111318] dark:text-[#8E8E96] dark:group-hover:text-white">
            {t("rail.connectAgent")}
          </span>
        </button>
      </div>

      {/* 3. 底部极简工具列：⌘K 搜索面板、管理后台（仅管理员）、外观/语言/刷新率菜单、退出登录 */}
      <div className="flex shrink-0 flex-col items-center gap-1 pt-1">
        <AppTooltip side="right" content={t("rail.commandPaletteTooltip")} shortcut="⌘K">
          <IconButton
            size="md"
            variant="ghost"
            label={t("rail.commandPaletteAria")}
            onClick={props.onOpenCommandPalette}
          >
            <Command className="h-4 w-4" />
          </IconButton>
        </AppTooltip>

        {props.currentUser.role === "admin" ? (
          <AppTooltip side="right" content={t("rail.adminTooltip")}>
            <IconButton
              size="md"
              variant="ghost"
              label={t("rail.adminAria")}
              onClick={props.onOpenAdminConsole}
            >
              <Shield className="h-4 w-4" />
            </IconButton>
          </AppTooltip>
        ) : null}

        <div className="app-no-drag">
          <AccountThemeMenu side="right" align="end" />
        </div>

        <AppTooltip side="right" content={t("sidebar.accountMenu.logout")}>
          <IconButton
            size="md"
            variant="ghost"
            label={t("sidebar.accountMenu.logout")}
            onClick={props.onLogout}
            className="text-[#8E96A6] hover:text-[#E5484D] dark:text-[#63636B] dark:hover:text-[#F87171]"
          >
            <LogOut className="h-4 w-4" />
          </IconButton>
        </AppTooltip>
      </div>
    </nav>
  );
}

interface AuthenticatedWorkspaceViewProps {
  readonly currentUser: HumanUserDto;
  readonly ownedAgents: ReadonlyArray<OwnedAgentSummaryDto>;
}

interface SurfaceTransitionCustom {
  readonly direction: 1 | -1;
  readonly horizontal: boolean;
  readonly reducedMotion: boolean;
}

const WORKSPACE_SURFACE_VARIANTS = {
  enter: ({ direction, horizontal, reducedMotion }: SurfaceTransitionCustom) =>
    reducedMotion
      ? { opacity: 1, x: 0, y: 0, scale: 1 }
      : {
          opacity: 0,
          x: horizontal ? direction * 20 : 0,
          y: horizontal ? 0 : direction * 18,
          scale: horizontal ? 1 : 0.99,
        },
  center: ({ reducedMotion }: SurfaceTransitionCustom) => ({
    opacity: 1,
    x: 0,
    y: 0,
    scale: 1,
    zIndex: 1,
    transition: reducedMotion ? INSTANT_TRANSITION : NATIVE_SURFACE_SPRING,
  }),
  exit: ({ direction, horizontal, reducedMotion }: SurfaceTransitionCustom) => ({
    opacity: 0,
    x: horizontal ? direction * -16 : 0,
    y: horizontal ? 0 : direction * -14,
    scale: horizontal ? 1 : 0.99,
    zIndex: 0,
    pointerEvents: "none" as const,
    transition: reducedMotion ? INSTANT_TRANSITION : NATIVE_SURFACE_EXIT,
  }),
};

function AuthenticatedWorkspaceView(props: AuthenticatedWorkspaceViewProps) {
  const { locale, t, tp } = useChatShellI18n();
  const { t: commonT } = useCommonI18n();
  const queryClient = useQueryClient();
  const location = useBrowserLocation();
  const sessionToken = useSessionToken();
  const themeMode = useThemeMode();
  const { setPreference: setThemePreference } = useAccountThemePreference();
  const {
    preference: languagePreference,
    resolvedLocale: resolvedLanguageLocale,
    setPreference: setLanguagePreference,
  } = useAccountLanguagePreference();
  const isDesktopChat = useIsDesktopChat();
  const connectionStatusRef = useRef<SseConnectionStatus>("connecting");
  const notificationRefetchInterval = () =>
    connectionStatusRef.current === "live" ? false : NOTIFICATION_RECOVERY_INTERVAL_MS;
  const roomsQuery = useQuery({
    ...joinedRoomsQueryOptions(),
    refetchInterval: notificationRefetchInterval,
  });
  const friendsQuery = useQuery({
    ...friendsOverviewQueryOptions(),
    refetchInterval: notificationRefetchInterval,
  });
  const logoutMutation = useLogoutMutation();
  const createRoomMutation = useCreateRoomMutation();
  const deleteOwnedAgentMutation = useDeleteOwnedAgentMutation();
  const updateOwnedAgentMutation = useUpdateOwnedAgentMutation();
  const deleteRoomMutation = useDeleteRoomMutation();
  const leaveRoomMutation = useLeaveRoomMutation();
  const updateAnyRoomGovernanceMutation = useUpdateAnyRoomGovernanceMutation();
  const openDirectAgentMutation = useOpenDirectAgentRoomMutation();
  const openDirectHumanMutation = useOpenDirectHumanRoomMutation();
  const acceptFriendMutation = useAcceptFriendRequestMutation();
  const declineFriendMutation = useDeclineFriendRequestMutation();
  const removeFriendMutation = useRemoveFriendMutation();
  const sendFriendRequestMutation = useSendFriendRequestMutation();

  const [commandPaletteOpen, setCommandPaletteOpen] = useState<boolean>(false);
  const [accountSecurityOpen, setAccountSecurityOpen] = useState<boolean>(false);
  const [pwaGuideOpen, setPwaGuideOpen] = useState<boolean>(false);
  const [sidebarSectionTab, setSidebarSectionTab] = useState<SidebarSectionTab>("chats");
  const [createRoomOpen, setCreateRoomOpen] = useState<boolean>(false);
  const [joinRoomOpen, setJoinRoomOpen] = useState<boolean>(false);
  const [addFriendOpen, setAddFriendOpen] = useState<boolean>(false);
  const [editingFriend, setEditingFriend] = useState<FriendContactDto | null>(null);
  const lastEditingFriendRef = useRef<FriendContactDto | null>(null);
  if (editingFriend !== null) {
    lastEditingFriendRef.current = editingFriend;
  }
  const [focusSidebarSearchSignal, setFocusSidebarSearchSignal] = useState<number>(0);
  const reducedMotion = usePrefersReducedMotion();
  const refreshState = useDisplayRefreshState();
  const [pendingDeleteRoom, setPendingDeleteRoom] = useState<DeleteRoomTarget | null>(null);
  const [pendingLeaveRoom, setPendingLeaveRoom] = useState<DeleteRoomTarget | null>(null);
  const [onboardingModalOpen, setOnboardingModalOpen] = useState<boolean>(false);
  const [onboardingInitialTab, setOnboardingInitialTab] =
    useState<OnboardingModalTab>("pair_agent");
  const [reclaimAgentId, setReclaimAgentId] = useState<AgentId | null>(null);
  const [inspectedAgent, setInspectedAgent] = useState<InspectedAgentProfile | null>(null);
  const [inspectConfirmDelete, setInspectConfirmDelete] = useState<boolean>(false);
  const [deletingAgentId, setDeletingAgentId] = useState<AgentId | null>(null);
  const [synthesizeSignal, setSynthesizeSignal] = useState<number>(0);
  const [escalatingTaskId, setEscalatingTaskId] = useState<string | null>(null);

  const rooms = roomsQuery.data?.rooms ?? [];
  const friends = friendsQuery.data?.friends ?? [];
  const friendRemarks = useMemo(() => {
    const remarks = new Map<UserId, string>();
    for (const friend of friendsQuery.data?.friends ?? []) {
      if (friend.remark !== undefined) {
        remarks.set(friend.user.userId, friend.remark);
      }
    }
    return remarks;
  }, [friendsQuery.data?.friends]);
  const incomingRequests = friendsQuery.data?.incomingRequests ?? [];
  const outgoingRequests = friendsQuery.data?.outgoingRequests ?? [];
  const discoverableAgents = friendsQuery.data?.discoverableAgents ?? [];
  const urlRoomId = parseSelectedRoomIdFromSearch(location.search);
  const surfaceMode = parseWorkspaceSurfaceFromSearch(location.search);
  const urlWorkspaceId = parseSelectedWorkspaceIdFromSearch(location.search);
  const workbenchCounts = useSoloWorkbenchCounts();

  const lastIncomingRequestsRef = useRef<ReadonlySet<string> | null>(null);
  const incomingRequestSnapshot = friendsQuery.data?.incomingRequests;
  useEffect(() => {
    if (incomingRequestSnapshot === undefined) {
      return;
    }
    const previous = lastIncomingRequestsRef.current;
    lastIncomingRequestsRef.current = new Set(
      incomingRequestSnapshot.map((request) => request.friendshipId),
    );
    // 首屏已有申请由通讯录红点呈现，仅对随后到达的申请弹出提醒。
    if (previous !== null) {
      for (const request of incomingRequestSnapshot) {
        if (!previous.has(request.friendshipId)) {
          toast.info(t("ws.toast.incomingFriendRequest"), {
            id: request.friendshipId,
            description: request.peer.displayName,
          });
        }
      }
    }
  }, [incomingRequestSnapshot, t]);

  // 移动端（< md）严格由 URL 查询参数 `?room=` 驱动是否进入聊天室，保证顶部返回与 Android 侧滑 `popstate` 100% 闭环
  const activeRoomId: RoomId | null = useMemo(() => {
    if (urlRoomId !== null && rooms.some((r) => r.id === urlRoomId)) {
      return urlRoomId;
    }
    if (urlRoomId !== null && roomsQuery.isPending) {
      return urlRoomId;
    }
    return isDesktopChat ? (rooms[0]?.id ?? null) : null;
  }, [isDesktopChat, urlRoomId, rooms, roomsQuery.isPending]);

  // 桌面端（>= md）自动对齐默认房间查询串以便刷新保留现场；移动端处于首页 `/` 时绝不强塞 `?room=`，确保返回列表干净彻底
  useEffect(() => {
    if (surfaceMode === "workbench") {
      return;
    }
    if (isDesktopChat && activeRoomId !== null && urlRoomId !== activeRoomId) {
      navigateTo(`/?room=${encodeURIComponent(activeRoomId)}`, { replace: true });
    } else if (activeRoomId === null && urlRoomId !== null && !roomsQuery.isPending) {
      navigateTo("/", { replace: true });
    }
  }, [activeRoomId, isDesktopChat, surfaceMode, urlRoomId, roomsQuery.isPending]);

  // 若待确认删除/退出的房间在弹窗打开期间被远端 SSE `room.deleted` 移除，则同步关闭确认弹窗
  useEffect(() => {
    if (
      pendingDeleteRoom !== null &&
      !roomsQuery.isPending &&
      !deleteRoomMutation.isPending &&
      !rooms.some((r) => r.id === pendingDeleteRoom.id)
    ) {
      setPendingDeleteRoom(null);
    }
    if (
      pendingLeaveRoom !== null &&
      !roomsQuery.isPending &&
      !leaveRoomMutation.isPending &&
      !rooms.some((r) => r.id === pendingLeaveRoom.id)
    ) {
      setPendingLeaveRoom(null);
    }
  }, [
    pendingDeleteRoom,
    pendingLeaveRoom,
    rooms,
    roomsQuery.isPending,
    deleteRoomMutation.isPending,
    leaveRoomMutation.isPending,
  ]);

  const activeRoomDetailQuery = useQuery({
    ...roomDetailQueryOptions((activeRoomId ?? ("rom_placeholder" as RoomId)) as RoomId),
    enabled: activeRoomId !== null && surfaceMode === "chats",
  });

  const joinedRoomsSignature = useMemo(
    () =>
      rooms
        .map((r) => r.id)
        .sort()
        .join(","),
    [rooms],
  );

  // 移动端选中的会话或切换到单人工作台期间，隐藏的时间线不能读取并清掉聊天未读。
  const mobileShowChat = !isDesktopChat && urlRoomId !== null && activeRoomId !== null;
  const visibleRoomId =
    surfaceMode === "chats" && (isDesktopChat || mobileShowChat) ? activeRoomId : null;
  const sseTelemetry = useRealtimeSseSync(true, sessionToken, visibleRoomId, joinedRoomsSignature);
  useWorkspaceServerSync(true, activeRoomId);
  connectionStatusRef.current = sseTelemetry.status;

  const roomNotificationsRef = useRef<RoomNotificationState | null>(null);
  const roomSnapshot = roomsQuery.data?.rooms;
  useEffect(() => {
    if (roomSnapshot === undefined) {
      return;
    }
    // 时间线可能在本次渲染之后才写入已读进度，弹窗前以当前缓存为准。
    const latestRooms = queryClient.getQueryData(joinedRoomsQueryOptions().queryKey)?.rooms;
    if (latestRooms === undefined) {
      return;
    }
    const { state, changes } = reconcileRoomNotifications(
      roomNotificationsRef.current,
      latestRooms,
      document.visibilityState === "visible" ? visibleRoomId : null,
    );
    roomNotificationsRef.current = state;
    for (const change of changes) {
      const id = `room-notice-${change.roomId}`;
      if (change.type === "show") {
        toast.info(t("ws.toast.newRoomMessage", { roomName: change.roomName }), { id });
      } else {
        toast.dismiss(id);
      }
    }
  }, [queryClient, roomSnapshot, t, visibleRoomId]);

  const onlineAgentCount = useMemo(
    () =>
      props.ownedAgents.filter(
        (a) => a.reach === "online_sse" || a.reach === "hosted_ready" || a.reach === "webhook",
      ).length,
    [props.ownedAgents],
  );

  const totalChatUnread = useMemo(
    () => rooms.reduce((sum, r) => sum + Math.max(0, r.lastSeq - r.yourLastReadSeq), 0),
    [rooms],
  );

  const handleSelectRoom = useCallback((nextRoomId: RoomId): void => {
    acquireHighRefreshBurst();
    navigateTo(`/?room=${encodeURIComponent(nextRoomId)}`);
  }, []);

  const handleBackToRoomList = useCallback((): void => {
    acquireHighRefreshBurst();
    navigateBackOr("/");
  }, []);

  const handleSelectSurface = useCallback(
    (nextMode: WorkspaceSurfaceMode): void => {
      acquireHighRefreshBurst();
      if (nextMode === "workbench") {
        const suffix =
          isDesktopChat && activeRoomId !== null ? `&room=${encodeURIComponent(activeRoomId)}` : "";
        navigateTo(`/?view=workbench${suffix}`);
        return;
      }
      if (!isDesktopChat) {
        navigateBackOr("/");
        return;
      }
      if (activeRoomId !== null) {
        navigateTo(`/?room=${encodeURIComponent(activeRoomId)}`);
      } else {
        navigateTo("/");
      }
    },
    [activeRoomId, isDesktopChat],
  );

  // 原生桌面客户端全局快捷键导航：
  // - Alt+1 / Alt+2：瞬时切换「会话」与「工作台」双空间
  // - Alt+↑ / Alt+↓：在聊天会话列表中上下快速切房（对标 Slack / Telegram macOS / Linear）
  // - ⌘/（Ctrl+/）：展开并聚焦左侧会话与通讯录快速筛选框
  useEffect(() => {
    const handleWorkspaceKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.isComposing) {
        return;
      }
      if (event.altKey && !event.metaKey && !event.ctrlKey && !event.shiftKey) {
        if (event.code === "Digit1") {
          event.preventDefault();
          handleSelectSurface("chats");
          return;
        }
        if (event.code === "Digit2") {
          event.preventDefault();
          handleSelectSurface("workbench");
          return;
        }
        if (
          surfaceMode === "chats" &&
          rooms.length > 1 &&
          (event.key === "ArrowUp" || event.key === "ArrowDown")
        ) {
          event.preventDefault();
          const curIdx = activeRoomId !== null ? rooms.findIndex((r) => r.id === activeRoomId) : -1;
          const delta = event.key === "ArrowDown" ? 1 : -1;
          const nextIdx = curIdx < 0 ? 0 : (curIdx + delta + rooms.length) % rooms.length;
          const nextRoom = rooms[nextIdx];
          if (nextRoom !== undefined) {
            handleSelectRoom(nextRoom.id);
          }
          return;
        }
      }
      if (
        surfaceMode === "chats" &&
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        !event.shiftKey &&
        event.key === "/"
      ) {
        event.preventDefault();
        setFocusSidebarSearchSignal((n) => n + 1);
      }
    };

    window.addEventListener("keydown", handleWorkspaceKeyDown);
    return () => window.removeEventListener("keydown", handleWorkspaceKeyDown);
  }, [activeRoomId, handleSelectRoom, handleSelectSurface, rooms, surfaceMode]);

  const handleOpenWorkbenchForWorkspace = useCallback(
    (workspaceId?: string | undefined): void => {
      const wsParam = workspaceId ? `&workspace=${encodeURIComponent(workspaceId)}` : "";
      const roomParam = activeRoomId !== null ? `&room=${encodeURIComponent(activeRoomId)}` : "";
      navigateTo(`/?view=workbench${wsParam}${roomParam}`);
    },
    [activeRoomId],
  );

  const handleEscalateSoloTaskToHuddle = useCallback(
    async (task: SoloWorkTaskView): Promise<void> => {
      setEscalatingTaskId(task.id);
      try {
        const topologyLabel =
          task.topology === "direct"
            ? t("topology.direct")
            : task.topology === "verify_loop"
              ? t("topology.verify_loop")
              : t("topology.swarm");
        const shortTitle = task.title.length > 26 ? `${task.title.slice(0, 26)}…` : task.title;
        const roomTitle = t("ws.escalate.roomTitle", { title: shortTitle });
        const res = await createRoomMutation.mutateAsync({
          name: roomTitle,
          topic: t("ws.escalate.roomTopic", {
            repo: task.repoName,
            branch: task.worktreeBranch,
            topology: topologyLabel,
          }),
          rules: t("ws.escalate.roomRules"),
          visibility: "invite_only",
          governance: {
            mode: "proposal",
            allowAgentMentions: true,
          },
          ...(props.ownedAgents.length > 0
            ? { initialAgentIds: props.ownedAgents.map((a) => a.id) }
            : {}),
        });

        const blockerLine =
          task.attention !== undefined && task.attention.answeredChoice === undefined
            ? t("ws.escalate.blockerAttention", {
                question: task.attention.question,
                options: task.attention.options.join(" / "),
              })
            : task.review?.verifierNote !== undefined
              ? t("ws.escalate.blockerReview", { note: task.review.verifierNote })
              : "";

        const contextMessage = [
          t("ws.escalate.msgHeading", { title: task.title }),
          t("ws.escalate.msgWorkspace", { repo: task.repoName, branch: task.worktreeBranch }),
          t("ws.escalate.msgTopology", { topology: topologyLabel }),
          t("ws.escalate.msgBrief", { brief: task.brief, blocker: blockerLine }),
        ].join("\n");

        let anchorSeq = 1;
        try {
          const msgRes = await sendRoomMessage(res.room.id, {
            content: contextMessage,
            ignoreUnread: true,
          });
          anchorSeq = msgRes.message.seq;
        } catch {
          // 即使首条背景消息投递波动，仍保证新建会诊群成功跳转
        }

        if (task.id.startsWith("wrk_")) {
          await bindRoomWorkspaceOnServer(res.room.id, task.repoId);
          await controlWorkTaskOnServer(task.id, "escalate_room", {
            targetRoomId: res.room.id,
          });
        } else {
          const createdRoomItem = dispatchRoomWorkItem({
            roomId: res.room.id,
            anchorSeq,
            content: task.title,
            members: res.room.members,
            currentUserId: props.currentUser.id,
            payload: {
              topology: task.topology,
              tier: task.tier,
              linkedSoloTaskId: task.id,
            },
          });
          bindRoomToWorkspace(res.room.id, task.repoId);
          markSoloTaskEscalated(task.id, res.room.id, createdRoomItem.id);
        }
        handleSelectRoom(res.room.id);
        toast.success(
          t("ws.escalate.toastCreated", { roomName: res.room.name, repoName: task.repoName }),
        );
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t("ws.escalate.toastFailed"));
      } finally {
        setEscalatingTaskId(null);
      }
    },
    [createRoomMutation, handleSelectRoom, props.currentUser.id, props.ownedAgents, t],
  );

  const openOnboarding = useCallback(
    (tab: OnboardingModalTab = "pair_agent", reclaimId?: AgentId): void => {
      setOnboardingInitialTab(tab);
      setReclaimAgentId(reclaimId ?? null);
      setOnboardingModalOpen(true);
    },
    [],
  );

  const inspectOwnedAgent = useCallback(
    (agent: OwnedAgentSummaryDto, confirmDelete = false): void => {
      setInspectConfirmDelete(confirmDelete);
      setInspectedAgent({
        agentId: agent.id,
        displayName: agent.displayName,
        slug: agent.slug,
        platform: agent.platform,
        ownerUserId: props.currentUser.id,
        ownerDisplayName: props.currentUser.displayName,
        allowExternalDm: agent.allowExternalDm,
        ...(agent.intro !== undefined ? { intro: agent.intro } : {}),
        reach: agent.reach,
        ...(agent.checkinIntervalMin !== undefined
          ? { checkinIntervalMin: agent.checkinIntervalMin }
          : {}),
        ...(agent.lastSeenAtIso !== undefined ? { lastSeenAtIso: agent.lastSeenAtIso } : {}),
      });
    },
    [props.currentUser.displayName, props.currentUser.id],
  );

  const inspectSharedAgent = useCallback((agent: SharedExternalAgentDto): void => {
    setInspectConfirmDelete(false);
    setInspectedAgent({
      agentId: agent.id,
      displayName: agent.displayName,
      slug: agent.slug,
      platform: agent.platform,
      ownerUserId: agent.ownerUserId,
      ownerDisplayName: agent.ownerDisplayName,
      allowExternalDm: agent.allowExternalDm,
      ...(agent.intro !== undefined ? { intro: agent.intro } : {}),
      reach: agent.reach,
    });
  }, []);

  const handleStartDirectAgentChat = useCallback(
    (agentId: AgentId, onOpened?: () => void): void => {
      openDirectAgentMutation.mutate(agentId, {
        onSuccess: (res) => {
          setInspectedAgent(null);
          setInspectConfirmDelete(false);
          handleSelectRoom(res.room.id);
          onOpened?.();
        },
        onError: (err) => {
          toast.error(err instanceof Error ? err.message : t("ws.toast.openDirectAgentFailed"));
        },
      });
    },
    [handleSelectRoom, openDirectAgentMutation, t],
  );

  const handleStartDirectHumanChat = useCallback(
    (userId: UserId): void => {
      openDirectHumanMutation.mutate(userId, {
        onSuccess: (res) => {
          handleSelectRoom(res.room.id);
        },
        onError: (err) => {
          toast.error(err instanceof Error ? err.message : t("ws.toast.openDirectHumanFailed"));
        },
      });
    },
    [handleSelectRoom, openDirectHumanMutation, t],
  );

  const handleSendQuickFriendRequest = useCallback(
    (userId: UserId, displayName: string): void => {
      sendFriendRequestMutation.mutate(
        { targetUserId: userId },
        {
          onSuccess: (res) => {
            if (res.autoAccepted || res.status === "accepted") {
              toast.success(t("ws.toast.friendAutoAccepted", { name: displayName }));
            } else {
              toast.success(t("ws.toast.friendRequestSent", { name: displayName }));
            }
          },
          onError: (err) => {
            toast.error(err instanceof Error ? err.message : t("ws.toast.friendRequestFailed"));
          },
        },
      );
    },
    [sendFriendRequestMutation, t],
  );

  const handleAcceptFriendRequest = useCallback(
    (friendshipId: FriendshipId, displayName: string): void => {
      acceptFriendMutation.mutate(friendshipId, {
        onSuccess: () => {
          toast.success(t("ws.toast.friendAccepted", { name: displayName }));
        },
        onError: (err) => {
          toast.error(err instanceof Error ? err.message : t("ws.toast.friendAcceptFailed"));
        },
      });
    },
    [acceptFriendMutation, t],
  );

  const handleDeclineFriendRequest = useCallback(
    (friendshipId: FriendshipId, displayName: string): void => {
      declineFriendMutation.mutate(friendshipId, {
        onSuccess: () => {
          toast.success(t("ws.toast.friendDeclined", { name: displayName }));
        },
        onError: (err) => {
          toast.error(err instanceof Error ? err.message : t("ws.toast.actionFailed"));
        },
      });
    },
    [declineFriendMutation, t],
  );

  const handleRemoveFriend = useCallback(
    (userId: UserId, displayName: string): void => {
      removeFriendMutation.mutate(userId, {
        onSuccess: () => {
          toast.success(t("ws.toast.friendRemoved", { name: displayName }));
        },
        onError: (err) => {
          toast.error(err instanceof Error ? err.message : t("ws.toast.friendRemoveFailed"));
        },
      });
    },
    [removeFriendMutation, t],
  );

  const handleToggleAllowExternalDm = useCallback(
    (agentId: AgentId, allowExternalDm: boolean): void => {
      updateOwnedAgentMutation.mutate(
        { agentId, body: { allowExternalDm } },
        {
          onSuccess: (res) => {
            setInspectedAgent((prev) =>
              prev && prev.agentId === agentId
                ? { ...prev, allowExternalDm: res.agent.allowExternalDm }
                : prev,
            );
            toast.success(
              res.agent.allowExternalDm
                ? t("ws.toast.externalDmEnabled")
                : t("ws.toast.externalDmDisabled"),
            );
          },
          onError: (err) => {
            toast.error(err instanceof Error ? err.message : t("ws.toast.updateAgentFailed"));
          },
        },
      );
    },
    [t, updateOwnedAgentMutation],
  );

  const handleDeleteOwnedAgent = useCallback(
    (agentId: AgentId, displayName: string): void => {
      setDeletingAgentId(agentId);
      deleteOwnedAgentMutation.mutate(agentId, {
        onSuccess: (res) => {
          setDeletingAgentId(null);
          setInspectedAgent((prev) => (prev?.agentId === agentId ? null : prev));
          setInspectConfirmDelete(false);
          setReclaimAgentId((prev) => (prev === agentId ? null : prev));
          toast.success(t("ws.toast.agentDeleted", { name: displayName }), {
            description: res.stoppedLocalDaemon
              ? t("ws.toast.agentDeletedLocal")
              : t("ws.toast.agentDeletedRemote"),
          });
        },
        onError: (err) => {
          setDeletingAgentId(null);
          toast.error(err instanceof Error ? err.message : t("ws.toast.deleteAgentFailed"));
        },
      });
    },
    [deleteOwnedAgentMutation, t],
  );

  const handleRequestDeleteRoom = useCallback(
    (room: DeleteRoomTarget): void => {
      deleteRoomMutation.reset();
      setPendingDeleteRoom(room);
    },
    [deleteRoomMutation],
  );

  const handleConfirmDeleteRoom = useCallback(
    (target: DeleteRoomTarget): void => {
      const isDirect = target.kind !== undefined && target.kind !== "group";
      deleteRoomMutation.mutate(target.id, {
        onSuccess: () => {
          setPendingDeleteRoom((prev) => (prev?.id === target.id ? null : prev));
          toast.success(
            isDirect
              ? t("ws.toast.directRoomDeleted", { name: target.name })
              : t("ws.toast.groupRoomDeleted", { name: target.name }),
            {
              description: isDirect
                ? t("ws.toast.directRoomDeletedDesc")
                : t("ws.toast.groupRoomDeletedDesc"),
            },
          );
        },
        onError: (err) => {
          toast.error(err instanceof Error ? err.message : t("ws.toast.deleteRoomFailed"));
        },
      });
    },
    [deleteRoomMutation, t],
  );

  const handleRequestLeaveRoom = useCallback(
    (room: DeleteRoomTarget): void => {
      leaveRoomMutation.reset();
      setPendingLeaveRoom(room);
    },
    [leaveRoomMutation],
  );

  const handleConfirmLeaveRoom = useCallback(
    (target: DeleteRoomTarget): void => {
      leaveRoomMutation.mutate(target.id, {
        onSuccess: () => {
          setPendingLeaveRoom((prev) => (prev?.id === target.id ? null : prev));
          toast.success(t("ws.toast.leftGroup", { name: target.name }));
        },
        onError: (err) => {
          toast.error(err instanceof Error ? err.message : t("ws.toast.leaveGroupFailed"));
        },
      });
    },
    [leaveRoomMutation, t],
  );

  const handleUpdateRoomGovernanceFromMenu = useCallback(
    (roomId: RoomId, patch: UpdateGovernanceBody): void => {
      updateAnyRoomGovernanceMutation.mutate(
        { roomId, patch },
        {
          onSuccess: () => {
            if (patch.renewBudget === true) {
              toast.success(t("ws.toast.menuBudgetRenewed"));
            } else if (patch.mode !== undefined) {
              const modeLabel =
                patch.mode === "free"
                  ? t("mode.free")
                  : patch.mode === "round_table"
                    ? t("mode.round_table")
                    : t("mode.proposal");
              toast.success(t("ws.toast.menuModeChanged", { mode: modeLabel }));
            } else if (patch.allowAgentMentions !== undefined) {
              toast.success(
                patch.allowAgentMentions
                  ? t("ws.toast.menuMentionsEnabled")
                  : t("ws.toast.menuMentionsDisabled"),
              );
            }
          },
          onError: (err) => {
            toast.error(err instanceof Error ? err.message : t("ws.toast.menuUpdateRoomFailed"));
          },
        },
      );
    },
    [t, updateAnyRoomGovernanceMutation],
  );

  const handleLogout = useCallback((): void => {
    logoutMutation.mutate(undefined, {
      onSuccess: () => {
        resetSoloWorkbenchMemory();
        resetAllRoomWorkBuckets();
        resetAgentCapabilityPrefsMemory();
        toast.success(t("ws.toast.signedOut"));
      },
    });
  }, [logoutMutation, t]);

  const handleSwitchLanguageFromPalette = useCallback(
    (nextPreference: LanguagePreference): void => {
      const targetLocale = resolveLocale(nextPreference);
      setLanguagePreference(nextPreference);
      const targetT = getChatShellTranslator(targetLocale).t;
      toast.success(
        nextPreference === "zh-CN"
          ? targetT("cmd.lang.toast.zhCN")
          : nextPreference === "en"
            ? targetT("cmd.lang.toast.en")
            : targetT("cmd.lang.toast.auto"),
      );
    },
    [setLanguagePreference],
  );

  // 构造全局 `⌘K` 命令面板分组动作
  const commandGroups: ReadonlyArray<CommandPaletteGroup> = useMemo(() => {
    const activeRoomSummary =
      activeRoomId !== null ? (rooms.find((r) => r.id === activeRoomId) ?? null) : null;
    const activeRoom = activeRoomDetailQuery.data?.room ?? activeRoomSummary;
    const activeRoomName =
      activeRoom === null ? undefined : getRoomDisplayName(activeRoom, friendRemarks);
    const isActiveRoomOwner =
      activeRoomSummary !== null && activeRoomSummary.ownerUserId === props.currentUser.id;
    const canDeleteActiveRoom =
      activeRoomSummary !== null &&
      (activeRoomSummary.kind === "direct_human" || isActiveRoomOwner);
    const isDark = themeMode === "dark";
    const resolvedLanguageAutonym =
      resolvedLanguageLocale === "zh-CN"
        ? commonT("locale.autonym.zhCN")
        : commonT("locale.autonym.en");
    const activeLanguageBadge = (
      <span className="rounded-full bg-black/[0.06] px-2 py-0.5 text-[10.5px] font-medium text-[#3B414E] dark:bg-white/[0.10] dark:text-[#D4D4DA]">
        {t("cmd.badge.active")}
      </span>
    );

    const quickActions: CommandPaletteGroup = {
      id: "quick-actions",
      heading: t("cmd.group.quickActions"),
      items: [
        {
          id: "act-toggle-workbench-surface",
          label:
            surfaceMode === "workbench" ? t("cmd.workbench.backToChats") : t("cmd.workbench.open"),
          subtitle:
            surfaceMode === "workbench"
              ? t("cmd.workbench.backToChatsSubtitle")
              : tp("cmd.workbench.needsReview", workbenchCounts.needsYou),
          icon:
            surfaceMode === "workbench" ? (
              <MessageCircle className="h-4 w-4" />
            ) : (
              <ListTodo className="h-4 w-4" />
            ),
          keywords: CHAT_SHELL_COMMAND_KEYWORDS.workbench,
          onSelect: () => handleSelectSurface(surfaceMode === "workbench" ? "chats" : "workbench"),
        },
        ...(activeRoomId !== null && activeRoomSummary?.kind !== "direct_human"
          ? [
              {
                id: "act-synthesize-proposal",
                label: t("cmd.synthesize.label"),
                subtitle: activeRoomName ?? t("cmd.synthesize.fallbackSubtitle"),
                icon: <FileText className="h-4 w-4" />,
                keywords: CHAT_SHELL_COMMAND_KEYWORDS.synthesize,
                onSelect: () => {
                  if (activeRoomId !== null && !isDesktopChat && urlRoomId !== activeRoomId) {
                    handleSelectRoom(activeRoomId);
                  }
                  setSynthesizeSignal((s) => s + 1);
                },
              },
            ]
          : []),
        ...(activeRoomId !== null && canDeleteActiveRoom && activeRoomSummary !== null
          ? [
              {
                id: "act-delete-current-room",
                label:
                  activeRoomSummary.kind === "group"
                    ? t("cmd.deleteRoom.group")
                    : t("cmd.deleteRoom.direct"),
                subtitle: activeRoomSummary.name,
                icon: <Trash2 className="h-4 w-4 text-[#C81E1E] dark:text-[#FCA5A5]" />,
                keywords: CHAT_SHELL_COMMAND_KEYWORDS.deleteRoom,
                onSelect: () => handleRequestDeleteRoom(activeRoomSummary),
              },
            ]
          : []),
        {
          id: "act-add-friend",
          label: t("cmd.addFriend.label"),
          subtitle:
            incomingRequests.length > 0
              ? tp("cmd.addFriend.incoming", incomingRequests.length)
              : t("cmd.addFriend.subtitle"),
          icon: <UserPlus className="h-4 w-4" />,
          keywords: CHAT_SHELL_COMMAND_KEYWORDS.addFriend,
          onSelect: () => setAddFriendOpen(true),
        },
        {
          id: "act-connect-agent",
          label: t("cmd.connectAgent.label"),
          subtitle: "Claude Code · Codex · Cursor · Antigravity · DeepSeek",
          icon: <Plus className="h-4 w-4" />,
          keywords: CHAT_SHELL_COMMAND_KEYWORDS.connectAgent,
          onSelect: () => openOnboarding("pair_agent"),
        },
        {
          id: "act-create-room",
          label: t("cmd.createRoom.label"),
          subtitle: t("cmd.createRoom.subtitle"),
          icon: <MessageCircle className="h-4 w-4" />,
          keywords: CHAT_SHELL_COMMAND_KEYWORDS.createRoom,
          onSelect: () => setCreateRoomOpen(true),
        },
        {
          id: "act-join-room",
          label: t("cmd.joinRoom.label"),
          subtitle: t("cmd.joinRoom.subtitle"),
          icon: <LogIn className="h-4 w-4" />,
          keywords: CHAT_SHELL_COMMAND_KEYWORDS.joinRoom,
          onSelect: () => setJoinRoomOpen(true),
        },
        ...(props.currentUser.role === "admin"
          ? [
              {
                id: "act-open-admin-console",
                label: t("cmd.admin.label"),
                subtitle: t("cmd.admin.subtitle"),
                icon: <Shield className="h-4 w-4" />,
                keywords: CHAT_SHELL_COMMAND_KEYWORDS.admin,
                onSelect: () => navigateTo("/admin"),
              },
            ]
          : []),
        {
          id: "act-account-security",
          label: t("cmd.accountSettings.label"),
          subtitle: t("cmd.accountSettings.subtitle", { email: props.currentUser.email }),
          icon: <KeyRound className="h-4 w-4" />,
          keywords: CHAT_SHELL_COMMAND_KEYWORDS.accountSettings,
          onSelect: () => setAccountSecurityOpen(true),
        },
        {
          id: "act-open-welcome-portal",
          label: t("cmd.welcome.label"),
          subtitle: t("cmd.welcome.subtitle"),
          icon: <Compass className="h-4 w-4" />,
          keywords: CHAT_SHELL_COMMAND_KEYWORDS.welcome,
          onSelect: () => navigateTo("/welcome"),
        },
        {
          id: "act-toggle-theme",
          label: isDark ? commonT("displayMenu.theme.light") : commonT("displayMenu.theme.dark"),
          subtitle: t("cmd.theme.toggleSubtitle"),
          icon: isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />,
          keywords: CHAT_SHELL_COMMAND_KEYWORDS.themeToggle,
          onSelect: () => setThemePreference(isDark ? "light" : "dark"),
        },
        {
          id: "act-automatic-theme",
          label: t("cmd.theme.autoLabel"),
          subtitle: commonT("displayMenu.theme.autoHint"),
          icon: <Clock3 className="h-4 w-4" />,
          keywords: CHAT_SHELL_COMMAND_KEYWORDS.themeAuto,
          onSelect: () => setThemePreference("auto"),
        },
        {
          id: "act-refresh-rate-mode",
          label:
            refreshState.preference === "max"
              ? t("cmd.refresh.toStandard")
              : t("cmd.refresh.toMax"),
          subtitle:
            refreshState.preference === "max"
              ? t("cmd.refresh.maxSubtitle", { hz: refreshState.detectedHz })
              : t("cmd.refresh.standardSubtitle"),
          icon: <Gauge className="h-4 w-4" />,
          keywords: CHAT_SHELL_COMMAND_KEYWORDS.refreshRate,
          onSelect: () => {
            const nextPref = refreshState.preference === "max" ? "standard" : "max";
            setRefreshRatePreference(nextPref);
            toast.success(
              nextPref === "max"
                ? t("cmd.refresh.toastMax", { hz: refreshState.detectedHz })
                : t("cmd.refresh.toastStandard"),
            );
          },
        },
        {
          id: "act-lang-auto",
          label: commonT("locale.option.auto"),
          subtitle: t("cmd.lang.auto.subtitle", { language: resolvedLanguageAutonym }),
          icon: <Languages className="h-4 w-4" />,
          ...(languagePreference === "auto" ? { badge: activeLanguageBadge } : {}),
          keywords: CHAT_SHELL_COMMAND_KEYWORDS.language,
          onSelect: () => handleSwitchLanguageFromPalette("auto"),
        },
        {
          id: "act-lang-zh-CN",
          label: commonT("locale.autonym.zhCN"),
          subtitle: t("cmd.lang.zhCN.subtitle"),
          icon: <Languages className="h-4 w-4" />,
          ...(languagePreference === "zh-CN" ? { badge: activeLanguageBadge } : {}),
          keywords: CHAT_SHELL_COMMAND_KEYWORDS.language,
          onSelect: () => handleSwitchLanguageFromPalette("zh-CN"),
        },
        {
          id: "act-lang-en",
          label: commonT("locale.autonym.en"),
          subtitle: t("cmd.lang.en.subtitle"),
          icon: <Languages className="h-4 w-4" />,
          ...(languagePreference === "en" ? { badge: activeLanguageBadge } : {}),
          keywords: CHAT_SHELL_COMMAND_KEYWORDS.language,
          onSelect: () => handleSwitchLanguageFromPalette("en"),
        },
      ],
    };

    const roomItemsGroup: CommandPaletteGroup = {
      id: "switch-rooms",
      heading: t("cmd.group.rooms"),
      items: rooms.map((room) => {
        const unread = Math.max(0, room.lastSeq - room.yourLastReadSeq);
        const kindLabel =
          room.kind === "direct_agent"
            ? t("cmd.roomKind.directAgent")
            : room.kind === "direct_human"
              ? t("cmd.roomKind.directHuman")
              : room.topic.length > 0
                ? room.topic
                : t("cmd.roomKind.group");
        return {
          id: `cmd-room-${room.id}`,
          label: getRoomDisplayName(room, friendRemarks),
          subtitle: kindLabel,
          icon: <MessageCircle className="h-4 w-4" />,
          ...(unread > 0
            ? {
                badge: (
                  <span className="rounded-full bg-[#E5484D] px-1.5 py-0.2 text-[10px] font-semibold tabular-nums text-white dark:bg-[#F05252]">
                    {unread}
                  </span>
                ),
              }
            : {}),
          keywords: [room.name, room.topic, kindLabel, ...CHAT_SHELL_COMMAND_KEYWORDS.room],
          onSelect: () => handleSelectRoom(room.id),
        };
      }),
    };

    const friendsGroup: CommandPaletteGroup = {
      id: "friends-dm",
      heading: t("cmd.group.friends"),
      items: friends.map((f) => ({
        id: `cmd-friend-${f.user.userId}`,
        label: f.remark ?? f.user.displayName,
        subtitle: f.user.email,
        icon: <UserRound className="h-4 w-4" />,
        keywords: [f.user.displayName, f.user.email, ...CHAT_SHELL_COMMAND_KEYWORDS.friend],
        onSelect: () => handleStartDirectHumanChat(f.user.userId),
      })),
    };

    const agentItemsGroup: CommandPaletteGroup = {
      id: "owned-agents",
      heading: t("cmd.group.agents"),
      items: props.ownedAgents.map((agt) => {
        const reachMeta = getReachVisualMeta(agt.reach, locale);
        return {
          id: `cmd-agt-${agt.id}`,
          label: t("cmd.agent.directLabel", { name: agt.displayName }),
          subtitle: `${agt.platform} · ${reachMeta.shortLabel}`,
          icon: (
            <span className={cn("inline-block h-2.5 w-2.5 rounded-full", reachMeta.dotClass)} />
          ),
          keywords: [agt.displayName, agt.platform, ...CHAT_SHELL_COMMAND_KEYWORDS.agent],
          onSelect: () => handleStartDirectAgentChat(agt.id),
        };
      }),
    };

    return [
      quickActions,
      roomItemsGroup,
      ...(friends.length > 0 ? [friendsGroup] : []),
      agentItemsGroup,
    ];
  }, [
    activeRoomDetailQuery.data?.room,
    activeRoomId,
    commonT,
    friendRemarks,
    friends,
    handleRequestDeleteRoom,
    handleSelectRoom,
    handleSelectSurface,
    handleStartDirectAgentChat,
    handleStartDirectHumanChat,
    handleSwitchLanguageFromPalette,
    incomingRequests.length,
    isDesktopChat,
    languagePreference,
    locale,
    openOnboarding,
    props.currentUser.email,
    props.currentUser.id,
    props.currentUser.role,
    props.ownedAgents,
    refreshState.detectedHz,
    refreshState.preference,
    resolvedLanguageLocale,
    rooms,
    setThemePreference,
    surfaceMode,
    t,
    themeMode,
    tp,
    urlRoomId,
    workbenchCounts.needsYou,
  ]);

  const isChatVisibleOnMobile = mobileShowChat;
  const urlWorkbenchTaskId = useMemo(() => {
    const raw = new URLSearchParams(location.search).get("task")?.trim();
    return raw && raw.length > 0 ? raw : null;
  }, [location.search]);
  const showMobileMainTabBar =
    !isDesktopChat &&
    !(surfaceMode === "chats" && isChatVisibleOnMobile) &&
    !(surfaceMode === "workbench" && urlWorkbenchTaskId !== null);
  const activeRoomDetail = activeRoomDetailQuery.data?.room ?? null;
  const onboardingGroup = rooms.find((room) => room.id === visibleRoomId && room.kind === "group");
  const surfaceTransitionCustom: SurfaceTransitionCustom = {
    direction: surfaceMode === "workbench" ? 1 : -1,
    horizontal: !isDesktopChat,
    reducedMotion,
  };

  return (
    <div
      data-mobile-main-nav={showMobileMainTabBar || undefined}
      className="relative flex h-vvh w-full flex-col overflow-hidden text-[#111318] md:flex-row md:gap-2.5 md:p-2.5 dark:text-[#F2F2F4]"
    >
      {/* 第 1 栏：72px 个人身份 + 会话/工作台切换舱 + 我的 Agents + `+ 接入 Agent` 悬浮液态玻璃导轨 */}
      <PersonalAgentRail
        currentUser={props.currentUser}
        ownedAgents={props.ownedAgents}
        surfaceMode={surfaceMode}
        chatUnreadCount={totalChatUnread}
        workbenchNeedsYouCount={workbenchCounts.needsYou}
        workbenchRunningCount={workbenchCounts.running}
        onSelectSurface={handleSelectSurface}
        onStartDirectAgentChat={handleStartDirectAgentChat}
        onInspectAgent={(agent) => inspectOwnedAgent(agent, false)}
        onReclaimAgent={(agentId) => openOnboarding("pair_agent", agentId)}
        onRequestDeleteAgent={(agent) => inspectOwnedAgent(agent, true)}
        onOpenConnectAgent={() => openOnboarding("pair_agent")}
        onOpenAccountSecurity={() => setAccountSecurityOpen(true)}
        onOpenCommandPalette={() => setCommandPaletteOpen(true)}
        onOpenAdminConsole={() => navigateTo("/admin")}
        onLogout={handleLogout}
      />

      {/* 右侧主空间舞台：仅上方内容区执行「会话 ⇄ 工作台」方向感知 GPU 弹簧切换，底部移动端主导航栏常驻不动 */}
      <div className="relative grid min-h-0 min-w-0 flex-1 grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)] overflow-hidden md:h-full md:overflow-visible">
        <AnimatePresence initial={false} custom={surfaceTransitionCustom}>
          {surfaceMode === "workbench" ? (
            <motion.div
              key="surface-workbench"
              data-surface="workbench"
              custom={surfaceTransitionCustom}
              variants={WORKSPACE_SURFACE_VARIANTS}
              initial="enter"
              animate="center"
              exit="exit"
              className="col-start-1 row-start-1 flex h-full min-h-0 w-full min-w-0 will-change-[transform,opacity]"
            >
              <ConnectedSoloWorkbench
                currentUser={props.currentUser}
                ownedAgents={props.ownedAgents}
                initialWorkspaceId={urlWorkspaceId}
                escalatingTaskId={escalatingTaskId}
                onEscalateToHuddle={(task) => void handleEscalateSoloTaskToHuddle(task)}
                onOpenEscalatedRoom={handleSelectRoom}
                onSwitchToChats={() => handleSelectSurface("chats")}
                onOpenConnectAgent={() => openOnboarding("pair_agent")}
                onInspectOwnedAgent={(agent) => inspectOwnedAgent(agent, false)}
                onOpenAccountSecurity={() => setAccountSecurityOpen(true)}
              />
            </motion.div>
          ) : (
            <motion.div
              key="surface-chats"
              data-surface="chats"
              custom={surfaceTransitionCustom}
              variants={WORKSPACE_SURFACE_VARIANTS}
              initial="enter"
              animate="center"
              exit="exit"
              className={cn(
                "col-start-1 row-start-1 h-full min-h-0 w-full min-w-0 will-change-[transform,opacity]",
                isDesktopChat
                  ? "flex md:gap-2.5"
                  : "relative grid grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)] overflow-hidden [&>*]:col-start-1 [&>*]:row-start-1",
              )}
            >
              <AnimatePresence initial={false}>
                {/* 第 2 栏：桌面常驻 276px 侧栏；移动端在会话列表态呈现，进出聊天室具备丝滑水平推拉过渡 */}
                {isDesktopChat || !isChatVisibleOnMobile ? (
                  <motion.div
                    key="pane-room-sidebar"
                    initial={isDesktopChat || reducedMotion ? false : { opacity: 0, x: "-14%" }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={
                      isDesktopChat || reducedMotion
                        ? { opacity: 0 }
                        : { opacity: 0, x: "-14%", pointerEvents: "none" }
                    }
                    transition={
                      reducedMotion
                        ? INSTANT_TRANSITION
                        : { type: "spring", stiffness: 440, damping: 38, mass: 0.85 }
                    }
                    className={cn(
                      "flex min-h-0 min-w-0",
                      isDesktopChat
                        ? "flex-none"
                        : "col-start-1 row-start-1 h-full w-full will-change-[transform,opacity]",
                    )}
                  >
                    <RoomSidebar
                      currentUser={props.currentUser}
                      ownedAgents={props.ownedAgents}
                      friends={friends}
                      friendRemarks={friendRemarks}
                      incomingRequests={incomingRequests}
                      discoverableAgents={discoverableAgents}
                      rooms={rooms}
                      isLoadingRooms={roomsQuery.isPending}
                      isRoomsError={roomsQuery.isError}
                      onRetryRooms={() => void roomsQuery.refetch()}
                      activeRoomId={activeRoomId}
                      sseStatus={sseTelemetry.status}
                      onSelectRoom={handleSelectRoom}
                      onOpenCreateRoom={() => setCreateRoomOpen(true)}
                      onOpenJoinRoom={() => setJoinRoomOpen(true)}
                      onOpenMyAgents={() => openOnboarding("pair_agent")}
                      onOpenAddFriend={() => setAddFriendOpen(true)}
                      onStartDirectAgentChat={handleStartDirectAgentChat}
                      onStartDirectHumanChat={handleStartDirectHumanChat}
                      onAcceptFriendRequest={handleAcceptFriendRequest}
                      onDeclineFriendRequest={handleDeclineFriendRequest}
                      onEditFriendRemark={setEditingFriend}
                      onRemoveFriend={handleRemoveFriend}
                      onInspectSharedAgent={inspectSharedAgent}
                      onInspectOwnedAgent={(agent) => inspectOwnedAgent(agent, false)}
                      onReclaimOwnedAgent={(agentId) => openOnboarding("pair_agent", agentId)}
                      onRequestDeleteOwnedAgent={(agent) => inspectOwnedAgent(agent, true)}
                      onDeleteOwnedAgent={(agent) =>
                        handleDeleteOwnedAgent(agent.id, agent.displayName)
                      }
                      deletingAgentId={deletingAgentId}
                      onRequestDeleteRoom={handleRequestDeleteRoom}
                      onRequestLeaveRoom={handleRequestLeaveRoom}
                      onUpdateRoomGovernance={handleUpdateRoomGovernanceFromMenu}
                      deletingRoomId={
                        deleteRoomMutation.isPending ? (pendingDeleteRoom?.id ?? null) : null
                      }
                      onLogout={handleLogout}
                      onOpenCommandPalette={() => setCommandPaletteOpen(true)}
                      onOpenAccountSecurity={() => setAccountSecurityOpen(true)}
                      onOpenPwaInstallGuide={() => setPwaGuideOpen(true)}
                      onOpenAdminConsole={() => navigateTo("/admin")}
                      onSwitchToWorkbench={() => handleSelectSurface("workbench")}
                      workbenchNeedsYouCount={workbenchCounts.needsYou}
                      sectionTab={sidebarSectionTab}
                      onChangeSectionTab={setSidebarSectionTab}
                      focusSearchSignal={focusSidebarSearchSignal}
                    />
                  </motion.div>
                ) : null}

                {/* 第 3 栏：通透聊天主舞台 vs 无会话极简空态 */}
                {visibleRoomId !== null && (isDesktopChat || isChatVisibleOnMobile) ? (
                  <motion.div
                    key={isDesktopChat ? `room-${visibleRoomId}` : `mobile-room-${visibleRoomId}`}
                    initial={
                      reducedMotion
                        ? false
                        : isDesktopChat
                          ? { opacity: 0, y: 4 }
                          : { opacity: 0, x: "22%" }
                    }
                    animate={{ opacity: 1, x: 0, y: 0 }}
                    exit={
                      reducedMotion
                        ? { opacity: 0 }
                        : isDesktopChat
                          ? { opacity: 0, y: -3, pointerEvents: "none" }
                          : { opacity: 0, x: "22%", pointerEvents: "none" }
                    }
                    transition={
                      reducedMotion
                        ? INSTANT_TRANSITION
                        : isDesktopChat
                          ? NATIVE_VIEW_SWAP
                          : { type: "spring", stiffness: 440, damping: 38, mass: 0.85 }
                    }
                    className={cn(
                      "flex min-h-0 min-w-0 overflow-hidden",
                      isDesktopChat
                        ? "flex-1"
                        : "col-start-1 row-start-1 h-full w-full will-change-[transform,opacity]",
                    )}
                  >
                    <ActiveRoomStage
                      roomId={visibleRoomId}
                      currentUser={props.currentUser}
                      friends={friends}
                      friendRemarks={friendRemarks}
                      ownedAgents={props.ownedAgents}
                      synthesizeSignal={synthesizeSignal}
                      realtimeLive={sseTelemetry.status === "live"}
                      onOpenAddAgentModal={(tab, reclaimId) =>
                        openOnboarding(tab ?? "pair_agent", reclaimId)
                      }
                      onOpenAddFriend={() => setAddFriendOpen(true)}
                      onStartDirectHumanChat={handleStartDirectHumanChat}
                      onSendFriendRequest={handleSendQuickFriendRequest}
                      onStartDirectAgentChat={handleStartDirectAgentChat}
                      onBackToList={handleBackToRoomList}
                      onInspectAgent={(profile) => {
                        setInspectConfirmDelete(false);
                        setInspectedAgent(profile);
                      }}
                      onOpenWorkbench={handleOpenWorkbenchForWorkspace}
                      onRequestDeleteRoom={handleRequestDeleteRoom}
                      onRequestLeaveRoom={handleRequestLeaveRoom}
                    />
                  </motion.div>
                ) : null}
              </AnimatePresence>

              {isDesktopChat && visibleRoomId === null ? (
                <main className="oh-stage-frame relative hidden flex-1 flex-col items-center justify-center overflow-y-auto p-8 md:flex md:rounded-[22px]">
                  <div className="max-w-md select-none text-center">
                    <BrandMark className="mx-auto mb-4 h-12 w-12 rounded-[14px] shadow-xs" />
                    <h1 className="text-[22px] font-semibold tracking-[-0.025em] text-[#111318] dark:text-[#F2F2F4]">
                      {t("sidebar.empty.title")}
                    </h1>
                    <p className="mt-2.5 text-[14px] leading-relaxed text-[#687082] dark:text-[#8E8E96]">
                      {t("sidebar.empty.desc")}
                    </p>

                    <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
                      <AppButton
                        variant="primary"
                        size="lg"
                        leadingIcon={<Plus className="h-4 w-4" />}
                        onClick={() => setCreateRoomOpen(true)}
                      >
                        {t("sidebar.footer.newGroup")}
                      </AppButton>
                      <AppButton
                        variant="secondary"
                        size="lg"
                        leadingIcon={<ListTodo className="h-4 w-4" />}
                        onClick={() => handleSelectSurface("workbench")}
                      >
                        {t("cmd.workbench.open")}
                      </AppButton>
                      <AppButton
                        variant="secondary"
                        size="lg"
                        onClick={() => openOnboarding("pair_agent")}
                      >
                        {t("sidebar.footer.connectAgent")}
                      </AppButton>
                    </div>
                  </div>
                </main>
              ) : null}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* 移动端常驻底部主导航栏：独立于上方过渡容器之外，切换「聊天 · 通讯录 · 工作台」时底栏纹丝不动，仅胶囊滑块与上方内容平滑切换 */}
      {showMobileMainTabBar ? (
        <MobileMainTabBar
          activeTab={surfaceMode === "workbench" ? "workbench" : sidebarSectionTab}
          chatUnreadCount={totalChatUnread}
          contactsBadgeText={
            incomingRequests.length > 0
              ? t("sidebar.contactsBadgeIncoming", { count: incomingRequests.length })
              : undefined
          }
          contactsBadgeTone={incomingRequests.length > 0 ? "alert" : "neutral"}
          workbenchNeedsYouCount={workbenchCounts.needsYou}
          onSelectTab={(tab) => {
            if (tab === "workbench") {
              if (surfaceMode !== "workbench") {
                handleSelectSurface("workbench");
              }
            } else {
              setSidebarSectionTab(tab);
              if (surfaceMode !== "chats") {
                handleSelectSurface("chats");
              }
            }
          }}
        />
      ) : null}

      {/* 全局 `⌘K` / `Ctrl+K` 命令面板 */}
      <AppCommandPalette
        open={commandPaletteOpen}
        onOpenChange={setCommandPaletteOpen}
        groups={commandGroups}
        placeholder={t("cmd.placeholder")}
        emptyText={t("cmd.empty")}
        footerHint={t("cmd.footerHint", {
          name: props.currentUser.displayName,
          agents: tp("cmd.footerAgentsOnline", onlineAgentCount),
          friends: tp("cmd.footerFriendsCount", friends.length),
        })}
      />

      {/* 全局业务模态弹窗组 */}
      <CreateRoomModal
        open={createRoomOpen}
        onClose={() => setCreateRoomOpen(false)}
        onRoomCreated={(room) => handleSelectRoom(room.id)}
        ownedAgents={props.ownedAgents}
        friends={friends}
      />

      <AddFriendModal
        open={addFriendOpen}
        onClose={() => setAddFriendOpen(false)}
        incomingRequests={incomingRequests}
        outgoingRequests={outgoingRequests}
        onOpenDirectHumanChat={handleStartDirectHumanChat}
      />

      {(editingFriend ?? lastEditingFriendRef.current) !== null ? (
        <EditFriendRemarkModal
          key={(editingFriend ?? lastEditingFriendRef.current)?.friendshipId}
          open={editingFriend !== null}
          friend={(editingFriend ?? lastEditingFriendRef.current) as FriendContactDto}
          onClose={() => setEditingFriend(null)}
        />
      ) : null}

      <JoinRoomModal
        open={joinRoomOpen}
        onClose={() => setJoinRoomOpen(false)}
        onRoomJoined={(room) => handleSelectRoom(room.id)}
      />

      <DeleteRoomConfirmModal
        room={pendingDeleteRoom}
        isDeleting={deleteRoomMutation.isPending}
        error={deleteRoomMutation.error}
        onClose={() => {
          deleteRoomMutation.reset();
          setPendingDeleteRoom(null);
        }}
        onConfirm={handleConfirmDeleteRoom}
      />

      <LeaveRoomConfirmModal
        room={pendingLeaveRoom}
        isLeaving={leaveRoomMutation.isPending}
        error={leaveRoomMutation.error}
        onClose={() => {
          leaveRoomMutation.reset();
          setPendingLeaveRoom(null);
        }}
        onConfirm={handleConfirmLeaveRoom}
      />

      <AgentOnboardingModal
        open={onboardingModalOpen}
        initialTab={onboardingInitialTab}
        initialReclaimAgentId={reclaimAgentId}
        currentUser={props.currentUser}
        ownedAgents={props.ownedAgents}
        activeRoom={activeRoomDetail?.kind === "group" ? activeRoomDetail : null}
        connectionRoom={onboardingGroup}
        connectionRoomPending={roomsQuery.isPending}
        isOpeningDirectChat={openDirectAgentMutation.isPending}
        onVerifyReply={(agentId) =>
          handleStartDirectAgentChat(agentId, () => setOnboardingModalOpen(false))
        }
        onClose={() => setOnboardingModalOpen(false)}
      />

      <AgentProfileDialog
        profile={inspectedAgent}
        currentUserId={props.currentUser.id}
        initialConfirmDelete={inspectConfirmDelete}
        isDeletingAgent={inspectedAgent !== null && deletingAgentId === inspectedAgent.agentId}
        isOpeningDirectChat={openDirectAgentMutation.isPending}
        isUpdatingAgent={updateOwnedAgentMutation.isPending}
        onClose={() => {
          setInspectedAgent(null);
          setInspectConfirmDelete(false);
        }}
        onStartDirectChat={handleStartDirectAgentChat}
        onToggleAllowExternalDm={handleToggleAllowExternalDm}
        onReclaimAgent={(agentId) => openOnboarding("pair_agent", agentId)}
        onDeleteAgent={handleDeleteOwnedAgent}
      />

      <AccountSecurityModal
        open={accountSecurityOpen}
        currentUser={props.currentUser}
        onClose={() => setAccountSecurityOpen(false)}
      />

      <PwaInstallGuideModal open={pwaGuideOpen} onClose={() => setPwaGuideOpen(false)} />
    </div>
  );
}

/**
 * OpenHuddle 协作工作台顶层入口组件：自动完成登录态自省，并在认证页与空间多岛工作台间无闪烁切换。
 *
 * @returns 登录视图或完整 Apple Liquid Glass 协作工作台
 */
export function WorkspaceShell() {
  const { t } = useChatShellI18n();
  const meQuery = useQuery(currentMeQueryOptions());

  // 首次鉴权用连接页。网络异常后的重试应保留已打开的认证表单。
  if (meQuery.isPending && !meQuery.isFetched) {
    return (
      <main className="flex h-vvh flex-col items-center justify-center gap-3 bg-app-frame text-im-fg dark:bg-[#0F1014]">
        <BrandMark className="h-10 w-10 rounded-[12px] shadow-xs" />
        <span className="text-[16px] font-semibold tracking-[-0.02em]">OpenHuddle</span>
        <span className="text-xs text-[#687082] dark:text-[#8E8E96]">{t("ws.connecting")}</span>
      </main>
    );
  }

  if (meQuery.isError || !meQuery.data || meQuery.data.callerKind !== "human") {
    return <OtpSignInScreen />;
  }

  return (
    <AuthenticatedWorkspaceView currentUser={meQuery.data.user} ownedAgents={meQuery.data.agents} />
  );
}
