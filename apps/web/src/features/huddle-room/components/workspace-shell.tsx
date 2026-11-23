/**
 * @module web/features/huddle-room/workspace-shell
 * @description Apple Liquid Glass 空间多岛协作工作台外壳（macOS Tahoe / iOS 26 Spatial Floating App Shell）：
 * 桌面端以 `10px` 空间间隙自然陈列悬浮液态玻璃岛，移动端自适应为无边框全屏原生导航与底部手势抽屉：
 * 1. 第 1 栏（`72px`）：个人身份与已绑定 Agent 垂直液态玻璃导轨（`liquid-glass-panel`）；
 * 2. 第 2 栏（`276px`）：「聊天 | 通讯录」液态玻璃侧栏（`liquid-glass-panel`）；
 * 3. 第 3 栏（`flex-1`）：轻透聊天主舞台（`oh-stage-frame`），全高消息时间线在顶部悬浮双岛顶栏（`GovernanceBar`）
 *    与底部悬浮输入舱（`MessageComposer`）下方自由滑过，触发真实动态折射；
 * 4. 第 4 栏（`356px`，按需展开）：群信息与提案液态玻璃面板（宽屏独立悬浮岛 / 窄屏 Vaul 抽屉）。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 严格单向边界：仅通过 `../../auth-pairing/index.js` 公共门面访问兄弟特性，绝不跨特性深层私引内部实现。
 * 2. 单一状态源：服务端读取全部由 `TanStack Query` 托管，全局单一 SSE 连接（`useRealtimeSseSync`）只向 `QueryClient`
 *    做按 `seq` 幂等补丁；本壳层仅持有纯 UI 状态（抽屉开合、`⌘K` 面板、滚动位置、移动端当前页）。
 * 3. 不打断阅读与防遮挡：消息时间线按顶栏横幅数动态留出首屏安全上边距，且「回到底部」胶囊与底部输入舱同处弹性底栈，
 *    输入多行或弹出提示条时自动上移永不重叠；上翻历史时新消息累计到浮钮，自己发出的消息始终平滑滚到底。
 * 4. 连续发言分组：同一作者、均为未撤回的 `text`、间隔 ≤ 3 分钟且非引用回复的相邻消息视为一组，
 *    传 `isGroupedWithPrevious` 给 `MessageBubble` 隐藏重复头像与昵称。
 */
import type {
  AgentId,
  FriendContactDto,
  FriendshipId,
  HumanUserDto,
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
  Command,
  Copy,
  FileText,
  KeyRound,
  LogIn,
  LogOut,
  MessageCircle,
  Moon,
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
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
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
  IconButton,
  cn,
  motion,
  toast,
} from "../../../components/primitives/index.js";
import {
  AgentProfileDialog,
  type InspectedAgentProfile,
} from "../../../components/ui/agent-profile-dialog.js";
import { PlatformAvatar } from "../../../components/ui/identity-badges.js";
import { MessageBubble } from "../../../components/ui/message-bubble.js";
import { ThemeToggle } from "../../../components/ui/theme-toggle.js";
import {
  getPlatformVisualMeta,
  getReachVisualMeta,
  getRoomDisplayName,
} from "../../../lib/format.js";
import type { OptimisticMessageItem } from "../../../lib/query-keys.js";
import {
  navigateTo,
  toggleThemeMode,
  useBrowserLocation,
  useSessionToken,
  useThemeMode,
} from "../../../lib/session-store.js";
import { type SseConnectionStatus, useRealtimeSseSync } from "../../../lib/sse-sync.js";
import {
  AccountSecurityModal,
  AgentOnboardingModal,
  type OnboardingModalTab,
  OtpSignInScreen,
  currentMeQueryOptions,
  useDeleteOwnedAgentMutation,
  useLogoutMutation,
  useUpdateOwnedAgentMutation,
} from "../../auth-pairing/index.js";
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
import { saveRoomSticker } from "../stickers/sticker-library.js";
import { AddFriendModal, EditFriendRemarkModal, InviteMembersModal } from "./friend-modals.js";
import { GovernanceBar } from "./governance-bar.js";
import { MessageComposer } from "./message-composer.js";
import { type InspectorTab, RoomInspector } from "./room-inspector.js";
import {
  CreateRoomModal,
  DeleteRoomConfirmModal,
  type DeleteRoomTarget,
  JoinRoomModal,
  LeaveRoomConfirmModal,
} from "./room-modals.js";
import { RoomSidebar } from "./room-sidebar.js";
import { savedStickerQueryKey } from "./sticker-picker.js";

export { systemHealthQueryOptions };

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

function pickLatestProposal(
  proposals: ReadonlyArray<ProposalCardDto>,
  predicate: (p: ProposalCardDto) => boolean,
  timeOf: (p: ProposalCardDto) => string,
): ProposalCardDto | null {
  let latest: ProposalCardDto | null = null;
  for (const p of proposals) {
    if (predicate(p) && (latest === null || timeOf(p) > timeOf(latest))) {
      latest = p;
    }
  }
  return latest;
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
  readonly onRequestDeleteRoom: (room: DeleteRoomTarget) => void;
  readonly onRequestLeaveRoom: (room: DeleteRoomTarget) => void;
}

function ActiveRoomStage(props: ActiveRoomStageProps) {
  const queryClient = useQueryClient();
  const handleSaveSticker = async (message: MessageDto): Promise<void> => {
    const userId = props.currentUser.id;
    try {
      const result = await saveRoomSticker(userId, message);
      await queryClient.invalidateQueries({ queryKey: savedStickerQueryKey(userId) });
      toast.success(result === "added" ? "已收藏表情" : "这条表情已收藏");
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "无法收藏表情，请稍后重试");
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
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("members");
  // 留白呼吸不变量：桌面端默认收起右侧面板，让聊天舞台保持宽敞与平静；点击顶栏人数或提案胶囊时再按需展开
  const [desktopInspectorOpen, setDesktopInspectorOpen] = useState<boolean>(false);
  const [mobileInspectorOpen, setMobileInspectorOpen] = useState<boolean>(false);
  const [inviteMode, setInviteMode] = useState<"members" | "agents" | null>(null);
  const [focusedProposalId, setFocusedProposalId] = useState<ProposalId | null>(null);
  const [replyTarget, setReplyTarget] = useState<MessageDto | null>(null);
  const [pendingQuickMention, setPendingQuickMention] = useState<MessageMention | null>(null);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const [showJumpToBottom, setShowJumpToBottom] = useState<boolean>(false);
  const [unseenCount, setUnseenCount] = useState<number>(0);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const nearBottomRef = useRef<boolean>(true);
  const lastRenderedCountRef = useRef<number>(0);
  const didInitialScrollRef = useRef<boolean>(false);
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
    toast.info("正在从近期讨论整理对比提案…");
    synthesizeMutation.mutate(
      { messageWindowLimit: 30 },
      {
        onSuccess: (res) => {
          setFocusedProposalId(res.proposal.id);
          setInspectorTab("proposals");
          toast.success("已生成提案卡");
        },
        onError: (err) => {
          toast.error(err instanceof Error ? err.message : "整理提案失败");
        },
      },
    );
  }, [isWideScreen, props.synthesizeSignal, synthesizeMutation]);

  const messages: ReadonlyArray<OptimisticMessageItem> = useMemo(
    () => messagesQuery.data?.messages ?? [],
    [messagesQuery.data],
  );
  const latestDisplayedSeq = messages.reduce(
    (latest, message) => (message._optimisticPending ? latest : Math.max(latest, message.seq)),
    0,
  );
  useEffect(() => {
    if (
      messagesQuery.dataUpdatedAt === 0 ||
      latestDisplayedSeq === 0 ||
      document.visibilityState !== "visible"
    ) {
      return;
    }
    // 打开会话后同步销掉侧栏红点，保留比当前时间线更新的未读。
    queryClient.setQueryData(
      joinedRoomsQueryOptions().queryKey,
      (previous) =>
        previous && {
          ...previous,
          rooms: previous.rooms.map((room) =>
            room.id === props.roomId && latestDisplayedSeq > room.yourLastReadSeq
              ? {
                  ...room,
                  lastSeq: asReadCursorSeq(Math.max(room.lastSeq, latestDisplayedSeq)),
                  yourLastReadSeq: asReadCursorSeq(latestDisplayedSeq),
                }
              : room,
          ),
        },
    );
  }, [latestDisplayedSeq, messagesQuery.dataUpdatedAt, props.roomId, queryClient]);
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

  const memberByAgentId = useMemo(() => {
    const map = new Map<string, RoomMemberDto>();
    if (detailQuery.data) {
      for (const member of detailQuery.data.room.members) {
        if (member.memberKind === "agent" && member.agentId !== undefined) {
          map.set(member.agentId, member);
        }
      }
    }
    return map;
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
            无法加载当前群聊
          </h2>
          <p className="mt-1 text-xs text-[#687082] dark:text-[#8E8E96]">
            请确认你仍是该群成员，或点击重新加载。
          </p>
          <div className="mt-4 flex items-center justify-center gap-2">
            <AppButton
              variant="secondary"
              size="sm"
              onClick={props.onBackToList}
              className="md:hidden"
            >
              返回列表
            </AppButton>
            <AppButton
              variant="primary"
              size="sm"
              leadingIcon={<RefreshCw className="h-3.5 w-3.5" />}
              onClick={() => void detailQuery.refetch()}
            >
              重新加载
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
  const pinnedProposal = pickLatestProposal(
    proposals,
    (p) => p.status === "open",
    (p) => p.createdAtIso,
  );
  const latestDecided = pickLatestProposal(
    proposals,
    (p) => p.status === "approved",
    (p) => p.decidedAtIso ?? p.createdAtIso,
  );
  const isInspectorOpen = isWideScreen ? desktopInspectorOpen : mobileInspectorOpen;

  // 计算顶部悬浮岛与横幅条数，确保 scrollTop=0 时首条消息永不被遮挡，同时滚动时消息流自然穿过液态玻璃下方
  const hasGovernanceSubBanner =
    liveGovernance.status === "paused_budget" ||
    (latestDecided !== null && openProposals.length === 0);
  const topTimelinePaddingClass =
    hasGovernanceSubBanner && pinnedProposal !== null
      ? "pt-[162px]"
      : hasGovernanceSubBanner || pinnedProposal !== null
        ? "pt-[118px]"
        : "pt-[74px]";
  const bottomTimelinePaddingClass = replyTarget !== null ? "pb-[184px]" : "pb-[148px]";

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
            toast.success("已整理生成对比提案卡");
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
            onSuccess: () => toast.success("你的意见已同步到群里"),
          },
        )
      }
      onDecideProposal={(proposalId, body) =>
        decideMutation.mutate(
          { proposalId, body },
          {
            onSuccess: (res) =>
              toast.success(
                res.proposal.status === "approved" ? "已拍板通过该方案" : "已驳回该提案",
              ),
          },
        )
      }
      onUpdateGovernance={(patch) => governanceMutation.mutate(patch)}
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
      <div className="oh-stage-frame relative flex min-w-0 flex-1 flex-col overflow-hidden md:rounded-[22px] [--oh-avatar-ring:#FFFFFF] dark:[--oh-avatar-ring:#1C1C1F]">
        {/* 顶部悬浮液态玻璃覆盖层（空白区域 pointer-events-none 允许直接滚动下方消息流） */}
        <div className="pointer-events-none absolute inset-x-0 top-0 z-20 bg-gradient-to-b from-[var(--oh-stage-scrim-mid)] to-transparent px-3 pt-[max(0.75rem,env(safe-area-inset-top,0px))] pb-3 sm:px-4">
          <GovernanceBar
            room={room}
            roomDisplayName={roomDisplayName}
            currentUserId={props.currentUser.id}
            governance={liveGovernance}
            proposalsCount={proposals.length}
            openProposalsCount={openProposals.length}
            decidedProposalTitle={latestDecided?.draft.title ?? null}
            isUpdatingGovernance={governanceMutation.isPending}
            isInspectorOpen={isInspectorOpen}
            onUpdateGovernance={(patch) => governanceMutation.mutate(patch)}
            onOpenInviteModal={() => setInviteMode("members")}
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
                  待拍板{openProposals.length > 1 ? ` · ${String(openProposals.length)}` : ""}
                </span>
                <span className="min-w-0 flex-1 truncate text-[#111318] dark:text-[#ECECEF]">
                  {pinnedProposal.draft.title}
                </span>
                <span className="inline-flex shrink-0 items-center gap-0.5 font-medium text-[#78350F] dark:text-[#FCD34D]">
                  <span className="hidden sm:inline">查看方案</span>
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
          className="h-full overflow-y-auto overscroll-contain px-4 sm:px-6"
        >
          <div
            className={cn(
              "mx-auto flex max-w-3xl flex-col",
              topTimelinePaddingClass,
              bottomTimelinePaddingClass,
            )}
          >
            {messagesQuery.isError && (
              <div className="rounded-2xl bg-[#E5484D]/10 p-4 text-xs text-[#C81E1E] dark:bg-[#F05252]/15 dark:text-[#FCA5A5]">
                <div className="flex items-center justify-between gap-2">
                  <span>拉取消息失败，请检查网络连接。</span>
                  <AppButton
                    variant="danger"
                    size="xs"
                    onClick={() => void messagesQuery.refetch()}
                  >
                    重试
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
                    ? `与 ${room.name} 的 1v1 单聊`
                    : room.kind === "direct_human"
                      ? `与 ${roomDisplayName} 的好友私聊`
                      : room.name}
                </h2>
                <p className="mx-auto mt-2 text-[13.5px] leading-relaxed text-[#687082] dark:text-[#8E8E96]">
                  {room.kind === "direct_agent"
                    ? room.peer?.kind === "agent" && room.peer.ownerUserId !== props.currentUser.id
                      ? `对方是由 ${room.peer.ownerDisplayName} 开放私聊的个人 Agent。直接在下方发送消息即可交流（你的发言将以参考信息身份送达）。`
                      : "这是你与个人 Agent 的专属一对一对话，在下方直接输入消息即可自动唤醒，无需加 @。"
                    : room.kind === "direct_human"
                      ? "你们已成为站内好友，在下方输入消息即可开始一对一实时沟通。"
                      : "把你的 Agent 或好友拉进群，直接在下方输入舱说话，或输入 `@` 点名一起讨论。"}
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
                        拉好友 / Agent 进群
                      </AppButton>
                      <AppButton
                        variant="secondary"
                        size="md"
                        onClick={() => openInspectorAt("members")}
                      >
                        查看群成员
                      </AppButton>
                    </>
                  ) : (
                    <AppButton
                      variant="secondary"
                      size="md"
                      onClick={() => openInspectorAt("members")}
                    >
                      查看会话信息
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
                const key = message._opKey ?? `seq-${String(message.seq)}`;

                return (
                  <MessageBubble
                    key={key}
                    message={message}
                    isGroupedWithPrevious={groupedFlags[index] === true}
                    repliedMessage={replied}
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
                        onSuccess: () => toast.success("消息已撤回"),
                      })
                    }
                    onOpenProposal={handleOpenProposalInInspector}
                    onInspectAgent={props.onInspectAgent}
                  />
                );
              })
            )}
          </div>
        </div>

        {/* 底部悬浮弹性栈：「回到底部」玻璃胶囊 + 液态玻璃输入舱（输入舱增高时浮钮自动上推防碰撞） */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex flex-col">
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
                  "pointer-events-auto relative mr-4 mb-1.5 inline-flex cursor-pointer select-none items-center gap-1.5 self-end rounded-full px-3.5 py-1.5 text-xs font-medium transition active:scale-[0.96] sm:mr-6",
                  unseenCount > 0
                    ? "bg-[#181B22] text-white shadow-md hover:bg-[#252A35] dark:bg-[#EAEEF6] dark:text-[#111318] dark:hover:bg-white"
                    : "liquid-glass-pill text-[#111318] dark:text-[#ECECEF]",
                )}
              >
                <ArrowDown className="h-3.5 w-3.5" />
                <span>{unseenCount > 0 ? `${String(unseenCount)} 条新消息` : "回到底部"}</span>
              </motion.button>
            ) : null}
          </AnimatePresence>

          <MessageComposer
            roomName={roomDisplayName}
            roomKind={room.kind}
            members={room.members}
            currentUserId={props.currentUser.id}
            currentUserDisplayName={props.currentUser.displayName}
            replyTarget={replyTarget}
            pendingQuickMention={pendingQuickMention}
            onConsumeQuickMention={() => setPendingQuickMention(null)}
            onClearReplyTarget={() => setReplyTarget(null)}
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
              attention,
            }) => {
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
                  onSuccess: () => {
                    onConfirmed();
                    setReplyTarget((current) => (current?.seq === replyToSeq ? null : current));
                    if (attachment !== undefined) {
                      sendMessageMutation.reset();
                    }
                  },
                },
              );
            }}
          />
        </div>
      </div>

      {/* 宽屏（xl+）按需展开的右侧悬浮液态玻璃群信息分栏 */}
      {isWideScreen && desktopInspectorOpen ? (
        <div className="flex xl:ml-2.5">{inspectorNode}</div>
      ) : null}

      {/* 窄屏（< xl）群信息抽屉：Vaul 物理手势抽屉 */}
      {!isWideScreen ? (
        <AppSheetDrawer
          open={mobileInspectorOpen}
          onOpenChange={setMobileInspectorOpen}
          title="群信息"
          subtitle={roomDisplayName}
          side="right"
          mobileAsBottomSheet={true}
          hideHeader={true}
          className="p-0"
        >
          {inspectorNode}
        </AppSheetDrawer>
      ) : null}

      {room.kind === "group" && inviteMode !== null ? (
        <InviteMembersModal
          mode={inviteMode}
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

/**
 * 裁剪左侧「我的 Agent」导轨下的紧凑短标签：若 Agent 名称以本人昵称做前缀（如 `庞彦-OpenAICodex`），
 * 在专属个人导轨中自动省去冗余前缀，避免窄栏截断无省略号。
 */
function formatCompactRailAgentLabel(agentDisplayName: string, ownerDisplayName: string): string {
  const trimmedAgent = agentDisplayName.trim();
  const trimmedOwner = ownerDisplayName.trim();
  if (trimmedOwner.length > 0) {
    for (const sep of ["-", "—", "_", "·", " "]) {
      const prefix = `${trimmedOwner}${sep}`;
      if (trimmedAgent.startsWith(prefix) && trimmedAgent.length > prefix.length) {
        return trimmedAgent.slice(prefix.length).trim();
      }
    }
  }
  return trimmedAgent;
}

/**
 * 空间工作台第 1 栏（`72px` 个人身份与已接入个人 Agent 垂直液态玻璃导轨）：
 * - 顶部：晶亮微浮起的 `38px` 圆形本人头像 + `我` 标签（点击打开账号与密码安全弹窗）；
 * - 中部滚动区：竖向排列当前用户已绑定的全部个人 Agent（`36px` 圆形粉彩头像 + 精致在线点 + 单行省略短名），
 *   紧随其后展示轻透虚线圆环 `+` 按钮与 `接入 agent` 标签；
 * - 底部：`⌘K` 搜索面板图标、`ThemeToggle` 与退出按钮。
 */
function PersonalAgentRail(props: PersonalAgentRailProps) {
  return (
    <nav
      aria-label="我与我的 Agent"
      data-tauri-drag-region=""
      className="app-drag-region relative liquid-glass-panel hidden w-[72px] shrink-0 select-none flex-col items-center pt-4 pb-3 md:flex md:rounded-[22px] [--oh-avatar-ring:#F4F6FA] dark:[--oh-avatar-ring:#1E1E22]"
    >
      {/* 1. 顶部个人身份：纯净浮起圆形头像 + `我`（点击打开账号与密码安全弹窗，告别多层灰环套娃） */}
      <AppTooltip
        side="right"
        content={`${props.currentUser.displayName} · ${props.currentUser.email}（点击管理账号与密码）`}
      >
        <button
          type="button"
          onClick={props.onOpenAccountSecurity}
          aria-label="打开账号与密码安全设置"
          className="app-no-drag group relative flex w-full cursor-pointer flex-col items-center transition active:scale-[0.96]"
        >
          <div className="rounded-full shadow-[0_2px_8px_rgba(15,23,42,0.08)] ring-[1.5px] ring-white/95 transition-transform duration-150 group-hover:scale-[1.04] dark:shadow-[0_2px_10px_rgba(0,0,0,0.4)] dark:ring-white/18">
            <PlatformAvatar
              kind="human"
              displayName={props.currentUser.displayName}
              size="lg"
              className="[&>div]:h-[38px] [&>div]:w-[38px] [&>div]:rounded-full [&>div]:text-[14px]"
            />
          </div>
          <span className="mt-1.5 text-[11px] font-medium leading-none text-[#3B414E] transition-colors group-hover:text-[#111318] dark:text-[#C4C4CA] dark:group-hover:text-white">
            我
          </span>
        </button>
      </AppTooltip>

      <div
        aria-hidden="true"
        className="mt-3.5 h-px w-7 shrink-0 bg-black/[0.06] dark:bg-white/[0.08]"
      />

      {/* 2. 中部可滚动区：已连接的个人 Agents + 虚线圆形 `+ 接入 agent` */}
      <div className="my-3 flex w-full flex-1 flex-col items-center gap-2.5 overflow-y-auto px-1 [scrollbar-width:none]">
        {props.ownedAgents.map((agent) => {
          const agentHandle = `@${agent.slug}`;
          const compactLabel = formatCompactRailAgentLabel(
            agent.displayName,
            props.currentUser.displayName,
          );
          const platformMeta = getPlatformVisualMeta(agent.platform);
          const reachMeta = getReachVisualMeta(agent.reach);
          const railAgentMenuItems: ReadonlyArray<AppContextMenuEntry> = [
            {
              id: `ctx-rail-dm-${agent.id}`,
              label: "发消息（1v1 单聊）",
              icon: <MessageCircle className="h-3.5 w-3.5" />,
              onSelect: () => props.onStartDirectAgentChat(agent.id),
            },
            {
              id: `ctx-rail-inspect-${agent.id}`,
              label: "查看 Agent 名片",
              icon: <UserRound className="h-3.5 w-3.5" />,
              onSelect: () => props.onInspectAgent(agent),
            },
            {
              id: `ctx-rail-copy-${agent.id}`,
              label: `复制 ${agentHandle}`,
              icon: <Copy className="h-3.5 w-3.5" />,
              onSelect: () => {
                if (typeof navigator !== "undefined" && navigator.clipboard) {
                  void navigator.clipboard.writeText(agentHandle).then(() => {
                    toast.success("已复制提及标识", { description: agentHandle });
                  });
                }
              },
            },
            {
              id: `ctx-rail-reclaim-${agent.id}`,
              label: "恢复原身份重连",
              icon: <KeyRound className="h-3.5 w-3.5" />,
              onSelect: () => props.onReclaimAgent(agent.id),
            },
            { kind: "separator", id: `ctx-rail-sep-danger-${agent.id}` },
            {
              id: `ctx-rail-delete-${agent.id}`,
              label: "删除该 Agent",
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
                    aria-label={`查看 ${agent.displayName} 名片`}
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
                <AppTooltip side="right" content={`删除 ${agent.displayName}`}>
                  <button
                    type="button"
                    aria-label={`删除 ${agent.displayName}`}
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

        {/* 轻透虚线圆环 `+` 按钮 + `接入 agent` */}
        <button
          type="button"
          onClick={props.onOpenConnectAgent}
          aria-label="接入新的个人 Agent"
          className="app-no-drag group flex w-full cursor-pointer flex-col items-center gap-1 transition active:scale-[0.96]"
        >
          <span className="flex h-9 w-9 items-center justify-center rounded-full border border-dashed border-black/20 bg-black/[0.03] text-[#687082] transition group-hover:border-[#181B22]/50 group-hover:bg-white/75 group-hover:text-[#111318] dark:border-white/20 dark:bg-white/[0.04] dark:text-[#8E8E96] dark:group-hover:border-white/45 dark:group-hover:bg-white/[0.10] dark:group-hover:text-white">
            <Plus className="h-4 w-4 stroke-[1.9]" />
          </span>
          <span className="text-center text-[10px] leading-[1.24] text-[#687082] transition-colors group-hover:text-[#111318] dark:text-[#8E8E96] dark:group-hover:text-white">
            接入 agent
          </span>
        </button>
      </div>

      {/* 3. 底部极简工具列：⌘K 搜索面板、管理后台（仅管理员）、主题切换、退出登录 */}
      <div className="flex flex-col items-center gap-1 pt-1">
        <AppTooltip side="right" content="快速搜索与跳转" shortcut="⌘K">
          <IconButton
            size="md"
            variant="ghost"
            label="打开快速搜索与命令面板 (⌘K)"
            onClick={props.onOpenCommandPalette}
          >
            <Command className="h-4 w-4" />
          </IconButton>
        </AppTooltip>

        {props.currentUser.role === "admin" ? (
          <AppTooltip side="right" content="运营与治理管理后台">
            <IconButton
              size="md"
              variant="ghost"
              label="打开运营管理后台"
              onClick={props.onOpenAdminConsole}
            >
              <Shield className="h-4 w-4" />
            </IconButton>
          </AppTooltip>
        ) : null}

        <div className="app-no-drag">
          <ThemeToggle variant="ghost" />
        </div>

        <AppTooltip side="right" content="退出登录">
          <IconButton
            size="md"
            variant="ghost"
            label="退出登录"
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

function AuthenticatedWorkspaceView(props: AuthenticatedWorkspaceViewProps) {
  const location = useBrowserLocation();
  const sessionToken = useSessionToken();
  const themeMode = useThemeMode();
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
  const [createRoomOpen, setCreateRoomOpen] = useState<boolean>(false);
  const [joinRoomOpen, setJoinRoomOpen] = useState<boolean>(false);
  const [addFriendOpen, setAddFriendOpen] = useState<boolean>(false);
  const [editingFriend, setEditingFriend] = useState<FriendContactDto | null>(null);
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
          toast.info("收到好友申请", {
            id: request.friendshipId,
            description: request.peer.displayName,
          });
        }
      }
    }
  }, [incomingRequestSnapshot]);

  // 移动端（< md）当前页：深链携带 ?room= 时直接进入聊天，否则停留在会话列表首页
  const [mobileShowChat, setMobileShowChat] = useState<boolean>(() => urlRoomId !== null);

  const activeRoomId: RoomId | null = useMemo(() => {
    if (urlRoomId !== null && rooms.some((r) => r.id === urlRoomId)) {
      return urlRoomId;
    }
    if (urlRoomId !== null && roomsQuery.isPending) {
      return urlRoomId;
    }
    return rooms[0]?.id ?? null;
  }, [urlRoomId, rooms, roomsQuery.isPending]);

  // 当列表加载完成且 URL 尚未携带有效 room 参数时，静默对齐 URL 查询串以便刷新保留现场；若最后一个群已被删除则清理 URL 参数
  useEffect(() => {
    if (activeRoomId !== null && urlRoomId !== activeRoomId) {
      navigateTo(`/?room=${encodeURIComponent(activeRoomId)}`, { replace: true });
    } else if (activeRoomId === null && urlRoomId !== null && !roomsQuery.isPending) {
      navigateTo("/", { replace: true });
      setMobileShowChat(false);
    }
  }, [activeRoomId, urlRoomId, roomsQuery.isPending]);

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
    enabled: activeRoomId !== null,
  });

  const joinedRoomsSignature = useMemo(
    () =>
      rooms
        .map((r) => r.id)
        .sort()
        .join(","),
    [rooms],
  );

  // 移动端选中的会话可能仍藏在列表之后，隐藏的时间线不能读取并清掉未读。
  const visibleRoomId = isDesktopChat || mobileShowChat ? activeRoomId : null;
  const sseTelemetry = useRealtimeSseSync(true, sessionToken, visibleRoomId, joinedRoomsSignature);
  connectionStatusRef.current = sseTelemetry.status;

  const lastRoomSequencesRef = useRef<ReadonlyMap<RoomId, number> | null>(null);
  const roomSnapshot = roomsQuery.data?.rooms;
  useEffect(() => {
    if (roomSnapshot === undefined) {
      return;
    }
    const previous = lastRoomSequencesRef.current;
    const current = new Map<RoomId, number>();
    for (const room of roomSnapshot) {
      const priorSeq = previous?.get(room.id) ?? 0;
      current.set(room.id, Math.max(priorSeq, room.lastSeq));
      const isViewing = room.id === visibleRoomId && document.visibilityState === "visible";
      if (
        previous !== null &&
        !isViewing &&
        room.lastSeq > Math.max(priorSeq, room.yourLastReadSeq)
      ) {
        // SSE 与补拉共享会话缓存，按已观察的序号去重。
        toast.info(`${room.name} 有新消息`, { id: `room-notice-${room.id}` });
      }
    }
    lastRoomSequencesRef.current = current;
  }, [roomSnapshot, visibleRoomId]);

  const onlineAgentCount = useMemo(
    () =>
      props.ownedAgents.filter(
        (a) => a.reach === "online_sse" || a.reach === "hosted_ready" || a.reach === "webhook",
      ).length,
    [props.ownedAgents],
  );

  const handleSelectRoom = useCallback((nextRoomId: RoomId): void => {
    navigateTo(`/?room=${encodeURIComponent(nextRoomId)}`);
    setMobileShowChat(true);
  }, []);

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
    (agentId: AgentId): void => {
      openDirectAgentMutation.mutate(agentId, {
        onSuccess: (res) => {
          setInspectedAgent(null);
          setInspectConfirmDelete(false);
          handleSelectRoom(res.room.id);
        },
        onError: (err) => {
          toast.error(err instanceof Error ? err.message : "无法打开与该 Agent 的单聊");
        },
      });
    },
    [handleSelectRoom, openDirectAgentMutation],
  );

  const handleStartDirectHumanChat = useCallback(
    (userId: UserId): void => {
      openDirectHumanMutation.mutate(userId, {
        onSuccess: (res) => {
          handleSelectRoom(res.room.id);
        },
        onError: (err) => {
          toast.error(err instanceof Error ? err.message : "无法打开好友私聊");
        },
      });
    },
    [handleSelectRoom, openDirectHumanMutation],
  );

  const handleSendQuickFriendRequest = useCallback(
    (userId: UserId, displayName: string): void => {
      sendFriendRequestMutation.mutate(
        { targetUserId: userId },
        {
          onSuccess: (res) => {
            if (res.autoAccepted || res.status === "accepted") {
              toast.success(`已与「${displayName}」成为好友，现在可以直接私聊`);
            } else {
              toast.success(`已向「${displayName}」发送好友申请`);
            }
          },
          onError: (err) => {
            toast.error(err instanceof Error ? err.message : "发送好友申请失败");
          },
        },
      );
    },
    [sendFriendRequestMutation],
  );

  const handleAcceptFriendRequest = useCallback(
    (friendshipId: FriendshipId, displayName: string): void => {
      acceptFriendMutation.mutate(friendshipId, {
        onSuccess: () => {
          toast.success(`已添加「${displayName}」为好友`);
        },
        onError: (err) => {
          toast.error(err instanceof Error ? err.message : "同意申请失败");
        },
      });
    },
    [acceptFriendMutation],
  );

  const handleDeclineFriendRequest = useCallback(
    (friendshipId: FriendshipId, displayName: string): void => {
      declineFriendMutation.mutate(friendshipId, {
        onSuccess: () => {
          toast.success(`已忽略「${displayName}」的好友申请`);
        },
        onError: (err) => {
          toast.error(err instanceof Error ? err.message : "操作失败");
        },
      });
    },
    [declineFriendMutation],
  );

  const handleRemoveFriend = useCallback(
    (userId: UserId, displayName: string): void => {
      removeFriendMutation.mutate(userId, {
        onSuccess: () => {
          toast.success(`已解除与「${displayName}」的好友关系`);
        },
        onError: (err) => {
          toast.error(err instanceof Error ? err.message : "解除好友失败");
        },
      });
    },
    [removeFriendMutation],
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
                ? "已开放站内其他用户私聊此 Agent"
                : "已关闭外部用户私聊此 Agent",
            );
          },
          onError: (err) => {
            toast.error(err instanceof Error ? err.message : "更新 Agent 设置失败");
          },
        },
      );
    },
    [updateOwnedAgentMutation],
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
          toast.success(`已删除 Agent「${displayName}」`, {
            description: res.stoppedLocalDaemon
              ? "已同步移出全部群聊并停止本机后台监听服务"
              : "已移出全部群聊并吊销其访问令牌",
          });
        },
        onError: (err) => {
          setDeletingAgentId(null);
          toast.error(err instanceof Error ? err.message : "删除 Agent 失败");
        },
      });
    },
    [deleteOwnedAgentMutation],
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
            isDirect ? `已删除单聊会话「${target.name}」` : `已删除群聊「${target.name}」`,
            {
              description: isDirect
                ? "会话消息已清理，个人 Agent 与好友关系不受影响"
                : "群内消息与提案已清理，你的个人 Agent 不受影响",
            },
          );
        },
        onError: (err) => {
          toast.error(err instanceof Error ? err.message : "删除会话失败，请稍后重试");
        },
      });
    },
    [deleteRoomMutation],
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
          toast.success(`已退出群聊「${target.name}」`);
        },
        onError: (err) => {
          toast.error(err instanceof Error ? err.message : "退出群聊失败，请稍后重试");
        },
      });
    },
    [leaveRoomMutation],
  );

  const handleUpdateRoomGovernanceFromMenu = useCallback(
    (roomId: RoomId, patch: UpdateGovernanceBody): void => {
      updateAnyRoomGovernanceMutation.mutate(
        { roomId, patch },
        {
          onSuccess: () => {
            if (patch.renewBudget === true) {
              toast.success("已续期讨论轮次");
            } else if (patch.mode !== undefined) {
              const modeLabel =
                patch.mode === "free"
                  ? "自由讨论"
                  : patch.mode === "round_table"
                    ? "圆桌轮流"
                    : "提案收敛";
              toast.success(`讨论节奏已切换为「${modeLabel}」`);
            } else if (patch.allowAgentMentions !== undefined) {
              toast.success(
                patch.allowAgentMentions ? "已允许 Agent 互相 @" : "已关闭 Agent 互相 @",
              );
            }
          },
          onError: (err) => {
            toast.error(err instanceof Error ? err.message : "更新群设置失败");
          },
        },
      );
    },
    [updateAnyRoomGovernanceMutation],
  );

  const handleLogout = useCallback((): void => {
    logoutMutation.mutate(undefined, {
      onSuccess: () => toast.success("已退出当前账号"),
    });
  }, [logoutMutation]);

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

    const quickActions: CommandPaletteGroup = {
      id: "quick-actions",
      heading: "快捷操作",
      items: [
        ...(activeRoomId !== null && activeRoomSummary?.kind !== "direct_human"
          ? [
              {
                id: "act-synthesize-proposal",
                label: "整理当前会话近期讨论为提案卡",
                subtitle: activeRoomName ?? "对比多方案优劣与风险",
                icon: <FileText className="h-4 w-4" />,
                keywords: ["synthesize", "proposal", "提案", "总结", "整理"],
                onSelect: () => {
                  setMobileShowChat(true);
                  setSynthesizeSignal((s) => s + 1);
                },
              },
            ]
          : []),
        ...(activeRoomId !== null && canDeleteActiveRoom && activeRoomSummary !== null
          ? [
              {
                id: "act-delete-current-room",
                label: activeRoomSummary.kind === "group" ? "删除当前群聊" : "删除当前单聊会话",
                subtitle: activeRoomSummary.name,
                icon: <Trash2 className="h-4 w-4 text-[#C81E1E] dark:text-[#FCA5A5]" />,
                keywords: ["delete", "remove", "room", "删除", "解散", "群聊", "单聊"],
                onSelect: () => handleRequestDeleteRoom(activeRoomSummary),
              },
            ]
          : []),
        {
          id: "act-add-friend",
          label: "添加好友 / 处理好友申请",
          subtitle:
            incomingRequests.length > 0
              ? `收到 ${String(incomingRequests.length)} 条新的好友申请`
              : "按昵称或邮箱搜索站内用户并发起 1v1 私聊",
          icon: <UserPlus className="h-4 w-4" />,
          keywords: ["friend", "dm", "user", "search", "好友", "私聊", "单聊", "添加"],
          onSelect: () => setAddFriendOpen(true),
        },
        {
          id: "act-connect-agent",
          label: "接入我的个人 Agent",
          subtitle: "Claude Code · Codex · Cursor · Antigravity · DeepSeek",
          icon: <Plus className="h-4 w-4" />,
          keywords: ["agent", "connect", "pair", "cli", "mcp", "配对", "接入"],
          onSelect: () => openOnboarding("pair_agent"),
        },
        {
          id: "act-create-room",
          label: "建群",
          subtitle: "创建群聊并直接拉入好友或你的 Agent",
          icon: <MessageCircle className="h-4 w-4" />,
          keywords: ["create", "new", "room", "新建", "建群", "群聊"],
          onSelect: () => setCreateRoomOpen(true),
        },
        {
          id: "act-join-room",
          label: "凭邀请码加入群",
          subtitle: "输入朋友分享的群聊邀请码",
          icon: <LogIn className="h-4 w-4" />,
          keywords: ["join", "invite", "token", "加入", "邀请码"],
          onSelect: () => setJoinRoomOpen(true),
        },
        ...(props.currentUser.role === "admin"
          ? [
              {
                id: "act-open-admin-console",
                label: "打开运营管理后台",
                subtitle: "用户、会话、群聊内容监管与数据统计大盘",
                icon: <Shield className="h-4 w-4" />,
                keywords: ["admin", "console", "stats", "users", "后台", "管理", "统计"],
                onSelect: () => navigateTo("/admin"),
              },
            ]
          : []),
        {
          id: "act-account-security",
          label: "账号与密码安全",
          subtitle: `${props.currentUser.email} · 修改昵称或登录密码`,
          icon: <KeyRound className="h-4 w-4" />,
          keywords: ["account", "password", "security", "profile", "账号", "密码", "安全", "昵称"],
          onSelect: () => setAccountSecurityOpen(true),
        },
        {
          id: "act-toggle-theme",
          label: isDark ? "切换至浅色外观" : "切换至深色外观",
          subtitle: "即时切换明暗界面配色",
          icon: isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />,
          keywords: ["theme", "dark", "light", "mode", "主题", "深色", "浅色"],
          onSelect: () => {
            toggleThemeMode();
            toast.success(isDark ? "已切换为浅色外观" : "已切换为深色外观");
          },
        },
      ],
    };

    const roomItemsGroup: CommandPaletteGroup = {
      id: "switch-rooms",
      heading: "聊天会话",
      items: rooms.map((room) => {
        const unread = Math.max(0, room.lastSeq - room.yourLastReadSeq);
        const kindLabel =
          room.kind === "direct_agent"
            ? "Agent 单聊"
            : room.kind === "direct_human"
              ? "好友私聊"
              : room.topic.length > 0
                ? room.topic
                : "群聊";
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
          keywords: [room.name, room.topic, kindLabel, "room", "群聊", "单聊"],
          onSelect: () => handleSelectRoom(room.id),
        };
      }),
    };

    const friendsGroup: CommandPaletteGroup = {
      id: "friends-dm",
      heading: "我的好友（点击发起私聊）",
      items: friends.map((f) => ({
        id: `cmd-friend-${f.user.userId}`,
        label: f.remark ?? f.user.displayName,
        subtitle: f.user.email,
        icon: <UserRound className="h-4 w-4" />,
        keywords: [f.user.displayName, f.user.email, "friend", "dm", "好友", "私聊"],
        onSelect: () => handleStartDirectHumanChat(f.user.userId),
      })),
    };

    const agentItemsGroup: CommandPaletteGroup = {
      id: "owned-agents",
      heading: "我的 agent（点击发起 1v1 单聊）",
      items: props.ownedAgents.map((agt) => {
        const reachMeta = getReachVisualMeta(agt.reach);
        return {
          id: `cmd-agt-${agt.id}`,
          label: `单聊 ${agt.displayName}`,
          subtitle: `${agt.platform} · ${reachMeta.shortLabel}`,
          icon: (
            <span className={cn("inline-block h-2.5 w-2.5 rounded-full", reachMeta.dotClass)} />
          ),
          keywords: [agt.displayName, agt.platform, "agent", "单聊", "dm"],
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
    friendRemarks,
    friends,
    handleRequestDeleteRoom,
    handleSelectRoom,
    handleStartDirectAgentChat,
    handleStartDirectHumanChat,
    incomingRequests.length,
    openOnboarding,
    props.currentUser.email,
    props.currentUser.id,
    props.currentUser.role,
    props.ownedAgents,
    rooms,
    themeMode,
  ]);

  const isChatVisibleOnMobile = mobileShowChat && activeRoomId !== null;
  const activeRoomDetail = activeRoomDetailQuery.data?.room ?? null;

  return (
    <div className="flex h-dvh w-screen overflow-hidden text-[#111318] md:gap-2.5 md:p-2.5 dark:text-[#F2F2F4]">
      {/* 第 1 栏：72px 个人身份 + 我的 Agents + `+ 接入 agent` 悬浮液态玻璃导轨 */}
      <PersonalAgentRail
        currentUser={props.currentUser}
        ownedAgents={props.ownedAgents}
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

      {/* 第 2 栏：276px `聊天 | 通讯录` 悬浮液态玻璃侧栏 */}
      <div
        className={cn(
          isChatVisibleOnMobile ? "hidden" : "flex",
          "min-w-0 flex-1 md:flex md:flex-none",
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
          onDeleteOwnedAgent={(agent) => handleDeleteOwnedAgent(agent.id, agent.displayName)}
          deletingAgentId={deletingAgentId}
          onRequestDeleteRoom={handleRequestDeleteRoom}
          onRequestLeaveRoom={handleRequestLeaveRoom}
          onUpdateRoomGovernance={handleUpdateRoomGovernanceFromMenu}
          deletingRoomId={deleteRoomMutation.isPending ? (pendingDeleteRoom?.id ?? null) : null}
          onLogout={handleLogout}
          onOpenCommandPalette={() => setCommandPaletteOpen(true)}
          onOpenAdminConsole={() => navigateTo("/admin")}
        />
      </div>

      {/* 第 3 栏：通透聊天主舞台 vs 无会话极简空态 */}
      {visibleRoomId !== null ? (
        <div
          className={cn(
            isChatVisibleOnMobile ? "flex" : "hidden",
            "min-w-0 flex-1 overflow-hidden md:flex",
          )}
        >
          <ActiveRoomStage
            key={visibleRoomId}
            roomId={visibleRoomId}
            currentUser={props.currentUser}
            friends={friends}
            friendRemarks={friendRemarks}
            ownedAgents={props.ownedAgents}
            synthesizeSignal={synthesizeSignal}
            realtimeLive={sseTelemetry.status === "live"}
            onOpenAddAgentModal={(tab, reclaimId) => openOnboarding(tab ?? "pair_agent", reclaimId)}
            onOpenAddFriend={() => setAddFriendOpen(true)}
            onStartDirectHumanChat={handleStartDirectHumanChat}
            onSendFriendRequest={handleSendQuickFriendRequest}
            onStartDirectAgentChat={handleStartDirectAgentChat}
            onBackToList={() => setMobileShowChat(false)}
            onInspectAgent={(profile) => {
              setInspectConfirmDelete(false);
              setInspectedAgent(profile);
            }}
            onRequestDeleteRoom={handleRequestDeleteRoom}
            onRequestLeaveRoom={handleRequestLeaveRoom}
          />
        </div>
      ) : (
        <main className="oh-stage-frame relative hidden flex-1 flex-col items-center justify-center overflow-y-auto p-8 md:flex md:rounded-[22px]">
          <div className="max-w-md select-none text-center">
            <BrandMark className="mx-auto mb-4 h-12 w-12 rounded-[14px] shadow-xs" />
            <h1 className="text-[22px] font-semibold tracking-[-0.025em] text-[#111318] dark:text-[#F2F2F4]">
              还没有聊天会话
            </h1>
            <p className="mt-2.5 text-[14px] leading-relaxed text-[#687082] dark:text-[#8E8E96]">
              支持与你的 Claude Code、Codex 开启 1v1 单聊，添加站内好友私聊，或建群拉大家一起讨论。
            </p>

            <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
              <AppButton
                variant="primary"
                size="lg"
                leadingIcon={<Plus className="h-4 w-4" />}
                onClick={() => setCreateRoomOpen(true)}
              >
                建群
              </AppButton>
              <AppButton
                variant="secondary"
                size="lg"
                leadingIcon={<UserPlus className="h-4 w-4" />}
                onClick={() => setAddFriendOpen(true)}
              >
                添加好友
              </AppButton>
              <AppButton variant="secondary" size="lg" onClick={() => openOnboarding("pair_agent")}>
                接入 agent
              </AppButton>
            </div>
          </div>
        </main>
      )}

      {/* 全局 `⌘K` / `Ctrl+K` 命令面板 */}
      <AppCommandPalette
        open={commandPaletteOpen}
        onOpenChange={setCommandPaletteOpen}
        groups={commandGroups}
        footerHint={`${props.currentUser.displayName} · ${String(onlineAgentCount)} 个个人 Agent 在线 · ${String(friends.length)} 位好友`}
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

      {editingFriend !== null ? (
        <EditFriendRemarkModal
          key={editingFriend.friendshipId}
          friend={editingFriend}
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
    </div>
  );
}

/**
 * OpenHuddle 协作工作台顶层入口组件：自动完成登录态自省，并在认证页与空间多岛工作台间无闪烁切换。
 *
 * @returns 登录视图或完整 Apple Liquid Glass 协作工作台
 */
export function WorkspaceShell() {
  const meQuery = useQuery(currentMeQueryOptions());

  // 首次鉴权用连接页。网络异常后的重试应保留已打开的认证表单。
  if (meQuery.isPending && !meQuery.isFetched) {
    return (
      <main className="flex h-dvh flex-col items-center justify-center gap-3 bg-[#FFFFFF] text-[#111318] dark:bg-[#0F1014] dark:text-[#F2F2F4]">
        <BrandMark className="h-10 w-10 rounded-[12px] shadow-xs" />
        <span className="text-[16px] font-semibold tracking-[-0.02em]">OpenHuddle</span>
        <span className="text-xs text-[#687082] dark:text-[#8E8E96]">正在连接…</span>
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
