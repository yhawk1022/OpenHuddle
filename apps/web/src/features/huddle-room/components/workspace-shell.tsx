/**
 * @module web/features/huddle-room/workspace-shell
 * @description Pachat 原生三栏工作台应用外壳（Authentic Pachat 3-Column App Shell）：
 * 外层统一圆角窗口（`#EFEFF3` / 暗色 `#101012`）由 `1px` 极细发丝分割线自然串联三栏：
 * 1. 左侧 `80px`「我 + 已接入个人 Agent + `+ 接入 agent`」垂直导轨（`#EFEFF3` / 暗色 `#111113`）；
 * 2. 中间 `280px`「聊天 | 通讯录」侧栏（`#F8F8FA` / 暗色 `#151518`）；
 * 3. 右侧通透纯净 `#FFFFFF`（暗色 `#0E0E10`）聊天主舞台（默认收起右侧抽屉，赋予会话留白呼吸感）。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 严格单向边界：仅通过 `../../auth-pairing/index.js` 公共门面访问兄弟特性，绝不跨特性深层私引内部实现。
 * 2. 单一状态源：服务端读取全部由 `TanStack Query` 托管，全局单一 SSE 连接（`useRealtimeSseSync`）只向 `QueryClient`
 *    做按 `seq` 幂等补丁；本壳层仅持有纯 UI 状态（抽屉开合、`⌘K` 面板、滚动位置、移动端当前页）。
 * 3. 不打断阅读：用户上翻历史时新消息不强制滚动，而是累计到「↓ N 条新消息」墨黑胶囊浮钮；自己发送的消息始终滚到底。
 * 4. 连续发言分组：同一作者、均为未撤回的 `text`、间隔 ≤ 3 分钟且非引用回复的相邻消息视为一组，
 *    传 `isGroupedWithPrevious` 给 `MessageBubble` 隐藏重复头像与昵称。
 */
import type {
  AgentId,
  HumanUserDto,
  MessageDto,
  MessageMention,
  OwnedAgentSummaryDto,
  ProposalCardDto,
  ProposalId,
  RoomId,
  RoomMemberDto,
} from "@openhuddle/protocol";
import { useQuery } from "@tanstack/react-query";
import {
  AlertCircle,
  ArrowDown,
  ChevronRight,
  Command,
  FileText,
  LogIn,
  LogOut,
  MessageCircle,
  Moon,
  Pin,
  Plus,
  RefreshCw,
  Sun,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  AnimatePresence,
  AppButton,
  AppCommandPalette,
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
import { getReachVisualMeta } from "../../../lib/format.js";
import type { OptimisticMessageItem } from "../../../lib/query-keys.js";
import {
  navigateTo,
  toggleThemeMode,
  useBrowserLocation,
  useSessionToken,
  useThemeMode,
} from "../../../lib/session-store.js";
import { useRealtimeSseSync } from "../../../lib/sse-sync.js";
import {
  AgentOnboardingModal,
  type OnboardingModalTab,
  OtpSignInScreen,
  currentMeQueryOptions,
  useLogoutMutation,
} from "../../auth-pairing/index.js";
import {
  joinedRoomsQueryOptions,
  roomDetailQueryOptions,
  roomMessagesQueryOptions,
  roomProposalsQueryOptions,
  systemHealthQueryOptions,
  useCastProposalVoteMutation,
  useCreateProposalMutation,
  useDecideProposalMutation,
  useRecallMessageMutation,
  useSendMessageMutation,
  useSynthesizeProposalMutation,
  useUpdateGovernanceMutation,
} from "../api/huddle-room.queries.js";
import { GovernanceBar } from "./governance-bar.js";
import { MessageComposer } from "./message-composer.js";
import { type InspectorTab, RoomInspector } from "./room-inspector.js";
import { CreateRoomModal, JoinRoomModal } from "./room-modals.js";
import { RoomSidebar } from "./room-sidebar.js";

export { systemHealthQueryOptions };

/** 连续发言分组的最大时间间隔（3 分钟） */
const GROUPING_WINDOW_MS = 3 * 60_000;

/** 距离底部小于该像素即视为「正在看最新消息」，新消息到达时自动跟随滚动 */
const NEAR_BOTTOM_THRESHOLD_PX = 120;

/** 右侧抽屉常驻断点（与 Tailwind `xl` 对齐） */
const WIDE_SCREEN_QUERY = "(min-width: 1280px)";

function parseSelectedRoomIdFromSearch(search: string): RoomId | null {
  const params = new URLSearchParams(search);
  const raw = params.get("room")?.trim();
  return raw && raw.length > 0 ? (raw as RoomId) : null;
}

function subscribeWideScreen(onChange: () => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) {
    return () => undefined;
  }
  const mql = window.matchMedia(WIDE_SCREEN_QUERY);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

function readWideScreen(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia
    ? window.matchMedia(WIDE_SCREEN_QUERY).matches
    : true;
}

/** 订阅 `xl` 断点：决定抽屉以「右侧内联分栏」还是「Vaul 手势抽屉」形式呈现 */
function useIsWideScreen(): boolean {
  return useSyncExternalStore(subscribeWideScreen, readWideScreen, () => true);
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
  readonly synthesizeSignal: number;
  readonly onOpenAddAgentModal: (tab?: OnboardingModalTab, reclaimAgentId?: AgentId) => void;
  readonly onBackToList: () => void;
  readonly onInspectAgent: (profile: InspectedAgentProfile) => void;
}

function ActiveRoomStage(props: ActiveRoomStageProps) {
  const detailQuery = useQuery(roomDetailQueryOptions(props.roomId));
  const messagesQuery = useQuery(roomMessagesQueryOptions(props.roomId));
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
  // Pachat 留白不变量：桌面端默认收起右侧抽屉，让聊天舞台保持宽敞与平静；点击顶栏人数或提案胶囊时再按需展开
  const [desktopInspectorOpen, setDesktopInspectorOpen] = useState<boolean>(false);
  const [mobileInspectorOpen, setMobileInspectorOpen] = useState<boolean>(false);
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
      <div className="flex min-w-0 flex-1 flex-col bg-white dark:bg-[#0E0E10]">
        <div className="h-[68px] shrink-0 border-b border-black/[0.06] dark:border-white/[0.06]" />
        <div className="flex-1 space-y-4 p-6">
          {[1, 2, 3].map((sk) => (
            <div key={`stage-sk-${String(sk)}`} className="flex items-start gap-3">
              <div className="h-9 w-9 animate-pulse rounded-full bg-[#F5F5F7] dark:bg-white/[0.06]" />
              <div className="h-14 w-2/3 animate-pulse rounded-2xl bg-[#F5F5F7] dark:bg-white/[0.05]" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (detailQuery.isError || !detailQuery.data) {
    return (
      <div className="flex min-w-0 flex-1 flex-col items-center justify-center bg-white p-8 text-center dark:bg-[#0E0E10]">
        <div className="max-w-sm rounded-3xl bg-[#F8F8FA] p-6 dark:bg-[#151518]">
          <AlertCircle className="mx-auto h-6 w-6 text-[#FF3B30]" />
          <h2 className="mt-2.5 text-[15px] font-semibold text-[#141414] dark:text-zinc-100">
            无法加载当前群聊
          </h2>
          <p className="mt-1 text-xs text-[#6E6E73] dark:text-zinc-400">
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
      onQuickMention={(mention) => {
        setPendingQuickMention(mention);
        // 窄屏抽屉遮罩会挡住输入框，点名后自动收起；宽屏侧栏保持展开
        setMobileInspectorOpen(false);
      }}
      onOpenAddAgentModal={() => props.onOpenAddAgentModal("pair_agent")}
      onClose={() => setInspectorOpen(false)}
    />
  );

  return (
    <div className="relative flex min-w-0 flex-1 overflow-hidden">
      {/* 中央纯净 `#FFFFFF` 聊天舞台：68px 顶栏 + 待拍板提示条 + 无网格时间线 + Pachat 输入卡 */}
      <div className="im-canvas flex min-w-0 flex-1 flex-col pt-[env(safe-area-inset-top,0px)] md:pt-0">
        <GovernanceBar
          room={room}
          governance={liveGovernance}
          proposalsCount={proposals.length}
          openProposalsCount={openProposals.length}
          decidedProposalTitle={latestDecided?.draft.title ?? null}
          isUpdatingGovernance={governanceMutation.isPending}
          isInspectorOpen={isInspectorOpen}
          onUpdateGovernance={(patch) => governanceMutation.mutate(patch)}
          onOpenAddAgentModal={() => props.onOpenAddAgentModal("pair_agent")}
          onOpenProposals={() => openInspectorAt("proposals")}
          onToggleInspector={handleToggleMembersInspector}
          onBackToList={props.onBackToList}
        />

        {/* 置顶待拍板提案条（仅存在 open 提案时出现） */}
        <AnimatePresence initial={false}>
          {pinnedProposal !== null ? (
            <motion.button
              key="pinned-open-proposal"
              type="button"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.16, ease: "easeOut" }}
              onClick={() => handleOpenProposalInInspector(pinnedProposal.id)}
              className="group flex shrink-0 cursor-pointer select-none items-center gap-2 overflow-hidden border-b border-black/[0.05] bg-[#FFF8E6] px-4 py-2 text-left text-xs transition hover:bg-[#FFF1C2]/70 sm:px-6 dark:border-white/[0.06] dark:bg-[#241F14] dark:hover:bg-[#2C2718]"
            >
              <Pin className="h-3.5 w-3.5 shrink-0 rotate-45 text-[#9A6700] dark:text-[#E5B34B]" />
              <span className="shrink-0 font-semibold text-[#5C4813] dark:text-[#F2DF9D]">
                待拍板{openProposals.length > 1 ? ` · ${String(openProposals.length)}` : ""}
              </span>
              <span className="min-w-0 flex-1 truncate text-[#141414] dark:text-zinc-200">
                {pinnedProposal.draft.title}
              </span>
              <span className="inline-flex shrink-0 items-center gap-0.5 font-medium text-[#5C4813] dark:text-[#F2DF9D]">
                <span className="hidden sm:inline">查看方案</span>
                <ChevronRight className="h-3.5 w-3.5 transition group-hover:translate-x-0.5" />
              </span>
            </motion.button>
          ) : null}
        </AnimatePresence>

        {/* 可滚动消息时间线 */}
        <div className="relative min-h-0 flex-1">
          <div
            ref={scrollRef}
            onScroll={handleTimelineScroll}
            className="h-full overflow-y-auto overscroll-contain px-4 pt-5 pb-3 sm:px-6"
          >
            <div className="mx-auto flex max-w-3xl flex-col">
              {messagesQuery.isPending ? (
                <div className="space-y-4">
                  {[1, 2, 3].map((id) => (
                    <div key={`msg-sk-${String(id)}`} className="flex items-start gap-3">
                      <div className="h-9 w-9 animate-pulse rounded-full bg-[#F5F5F7] dark:bg-white/[0.06]" />
                      <div className="h-14 w-1/2 animate-pulse rounded-2xl bg-[#F5F5F7] dark:bg-white/[0.05]" />
                    </div>
                  ))}
                </div>
              ) : messagesQuery.isError ? (
                <div className="rounded-2xl bg-[#FF3B30]/10 p-4 text-xs text-[#D70015] dark:bg-[#FF453A]/15 dark:text-[#FF6961]">
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
              ) : messages.length === 0 ? (
                <div className="mx-auto my-16 max-w-md select-none px-4 text-center">
                  <h2 className="text-[18px] font-semibold tracking-[-0.02em] text-[#141414] dark:text-zinc-100">
                    {room.name}
                  </h2>
                  <p className="mx-auto mt-2 text-[13.5px] leading-relaxed text-[#6E6E73] dark:text-zinc-400">
                    把你的 Agent 或朋友邀请进群，直接在下方输入框说话，或输入 `@` 点名一起讨论。
                  </p>
                  <div className="mt-5 flex flex-wrap items-center justify-center gap-2.5">
                    <AppButton
                      variant="primary"
                      size="md"
                      leadingIcon={<Plus className="h-4 w-4" />}
                      onClick={() => props.onOpenAddAgentModal("pair_agent")}
                    >
                      邀请 / 接入 agent
                    </AppButton>
                    <AppButton
                      variant="secondary"
                      size="md"
                      onClick={() => openInspectorAt("members")}
                    >
                      查看群成员
                    </AppButton>
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
                      onQuickMention={(mention) => setPendingQuickMention(mention)}
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

          {/* 弹簧浮动「↓ 新消息 / 回到底部」按钮 */}
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
                  "absolute right-5 bottom-3 z-10 inline-flex cursor-pointer select-none items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-medium shadow-md transition active:scale-[0.96] sm:right-6",
                  unseenCount > 0
                    ? "bg-[#141414] text-white hover:bg-black dark:bg-[#F5F5F7] dark:text-[#141414] dark:hover:bg-white"
                    : "border border-black/10 bg-white text-[#141414] hover:bg-[#F5F5F7] dark:border-white/15 dark:bg-[#1C1C1F] dark:text-zinc-200 dark:hover:bg-[#27272A]",
                )}
              >
                <ArrowDown className="h-3.5 w-3.5" />
                <span>{unseenCount > 0 ? `${String(unseenCount)} 条新消息` : "回到底部"}</span>
              </motion.button>
            ) : null}
          </AnimatePresence>
        </div>

        <MessageComposer
          roomName={room.name}
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
          onSendMessage={({ content, opKey, replyToSeq, mentions, onConfirmedOrQueued }) => {
            onConfirmedOrQueued();
            sendMessageMutation.mutate({
              content,
              opKey,
              ...(replyToSeq !== undefined ? { replyToSeq } : {}),
              mentions,
            });
          }}
        />
      </div>

      {/* 宽屏（xl+）按需展开的右侧群信息分栏 */}
      {isWideScreen && desktopInspectorOpen ? <div className="flex">{inspectorNode}</div> : null}

      {/* 窄屏（< xl）群信息抽屉：Vaul 物理手势抽屉 */}
      {!isWideScreen ? (
        <AppSheetDrawer
          open={mobileInspectorOpen}
          onOpenChange={setMobileInspectorOpen}
          title="群信息"
          subtitle={room.name}
          side="right"
          mobileAsBottomSheet={true}
          hideHeader={true}
          className="p-0"
        >
          {inspectorNode}
        </AppSheetDrawer>
      ) : null}
    </div>
  );
}

/** 左侧 `80px` 个人与 Agent 垂直导轨入参 */
interface PersonalAgentRailProps {
  readonly currentUser: HumanUserDto;
  readonly ownedAgents: ReadonlyArray<OwnedAgentSummaryDto>;
  readonly onInspectAgent: (agent: OwnedAgentSummaryDto) => void;
  readonly onOpenConnectAgent: () => void;
  readonly onOpenCommandPalette: () => void;
  readonly onLogout: () => void;
}

/**
 * Pachat 原生三栏第 1 栏（`80px` 个人身份与个人 Agent 垂直导轨，`#EFEFF3` / 暗色 `#111113`）：
 * - 顶部：`42px` 圆形用户头像（带 `#141414` 锐利色环与左侧 `4px` 竖向胶囊指示条）+ `11px` `我` 标签；
 * - 中部滚动区：竖向排列当前用户已绑定的全部个人 Agent（`38px` 圆形粉彩头像 + `#34C759` 在线绿点 + 双行居中名称），
 *   紧随其后展示 `38px` 虚线圆环 `+` 按钮与 `接入 agent` 标签；
 * - 底部：`⌘K` 搜索面板图标、`ThemeToggle` 与退出按钮。
 */
function PersonalAgentRail(props: PersonalAgentRailProps) {
  return (
    <nav
      aria-label="我与我的 Agent"
      data-tauri-drag-region=""
      className="app-drag-region glass-pane hidden w-[80px] shrink-0 select-none flex-col items-center border-r border-black/[0.06] pt-4 pb-3 md:flex dark:border-white/[0.06]"
    >
      {/* 1. 顶部个人身份：左侧 4px 墨黑竖条 + 42px 墨黑环圆形头像 + `我` */}
      <AppTooltip
        side="right"
        content={`${props.currentUser.displayName} · ${props.currentUser.email}`}
      >
        <div className="app-no-drag relative flex w-full flex-col items-center">
          <span
            aria-hidden="true"
            className="absolute top-2.5 left-0 h-6 w-[4px] rounded-r-full bg-[#141414] dark:bg-white"
          />
          <div className="rounded-full p-[2px] ring-2 ring-[#141414] dark:ring-white">
            <PlatformAvatar
              kind="human"
              displayName={props.currentUser.displayName}
              size="lg"
              className="[&>div]:h-[42px] [&>div]:w-[42px] [&>div]:rounded-full [&>div]:text-[13px]"
            />
          </div>
          <span className="mt-1.5 text-[11px] font-medium leading-none text-[#141414] dark:text-zinc-100">
            我
          </span>
        </div>
      </AppTooltip>

      <div
        aria-hidden="true"
        className="mt-3.5 h-px w-9 shrink-0 bg-black/[0.08] dark:bg-white/[0.08]"
      />

      {/* 2. 中部可滚动区：已连接的个人 Agents + 虚线圆形 `+ 接入 agent` */}
      <div className="my-3 flex w-full flex-1 flex-col items-center gap-3.5 overflow-y-auto px-1.5 [scrollbar-width:none]">
        {props.ownedAgents.map((agent) => (
          <button
            key={agent.id}
            type="button"
            onClick={() => props.onInspectAgent(agent)}
            aria-label={`查看 ${agent.displayName} 名片`}
            className="app-no-drag group flex w-full cursor-pointer flex-col items-center gap-1 transition active:scale-[0.96]"
          >
            <PlatformAvatar
              kind="agent"
              displayName={agent.displayName}
              platform={agent.platform}
              reach={agent.reach}
              size="md"
              className="transition-transform group-hover:scale-[1.03] [&>div]:h-[38px] [&>div]:w-[38px] [&>div]:rounded-full"
            />
            <span className="line-clamp-2 max-w-[66px] text-center text-[10.5px] leading-[1.24] text-[#3A3A3C] transition-colors group-hover:text-[#141414] dark:text-zinc-300 dark:group-hover:text-white">
              {agent.displayName}
            </span>
          </button>
        ))}

        {/* 虚线圆环 38px `+` 按钮 + `接入 agent` */}
        <button
          type="button"
          onClick={props.onOpenConnectAgent}
          aria-label="接入新的个人 Agent"
          className="app-no-drag group flex w-full cursor-pointer flex-col items-center gap-1 transition active:scale-[0.96]"
        >
          <span className="flex h-[38px] w-[38px] items-center justify-center rounded-full border border-dashed border-black/25 text-[#5F5F64] transition group-hover:border-[#141414] group-hover:bg-white/70 group-hover:text-[#141414] dark:border-white/25 dark:text-zinc-400 dark:group-hover:border-white/60 dark:group-hover:bg-white/[0.06] dark:group-hover:text-white">
            <Plus className="h-4 w-4 stroke-[1.9]" />
          </span>
          <span className="text-center text-[10.5px] leading-[1.24] text-[#5F5F64] transition-colors group-hover:text-[#141414] dark:text-zinc-400 dark:group-hover:text-white">
            接入 agent
          </span>
        </button>
      </div>

      {/* 3. 底部极简工具列：⌘K 搜索面板、主题切换、退出登录 */}
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

        <div className="app-no-drag">
          <ThemeToggle variant="ghost" />
        </div>

        <AppTooltip side="right" content="退出登录">
          <IconButton
            size="md"
            variant="ghost"
            label="退出登录"
            onClick={props.onLogout}
            className="text-[#8E8E93] hover:text-[#FF3B30] dark:text-zinc-500 dark:hover:text-[#FF6961]"
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
  const roomsQuery = useQuery(joinedRoomsQueryOptions());
  const logoutMutation = useLogoutMutation();

  const [commandPaletteOpen, setCommandPaletteOpen] = useState<boolean>(false);
  const [createRoomOpen, setCreateRoomOpen] = useState<boolean>(false);
  const [joinRoomOpen, setJoinRoomOpen] = useState<boolean>(false);
  const [onboardingModalOpen, setOnboardingModalOpen] = useState<boolean>(false);
  const [onboardingInitialTab, setOnboardingInitialTab] =
    useState<OnboardingModalTab>("pair_agent");
  const [reclaimAgentId, setReclaimAgentId] = useState<AgentId | null>(null);
  const [inspectedAgent, setInspectedAgent] = useState<InspectedAgentProfile | null>(null);
  const [synthesizeSignal, setSynthesizeSignal] = useState<number>(0);

  const rooms = roomsQuery.data?.rooms ?? [];
  const urlRoomId = parseSelectedRoomIdFromSearch(location.search);

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

  // 当列表加载完成且 URL 尚未携带有效 room 参数时，静默对齐 URL 查询串以便刷新保留现场
  useEffect(() => {
    if (activeRoomId !== null && urlRoomId !== activeRoomId) {
      navigateTo(`/?room=${encodeURIComponent(activeRoomId)}`, { replace: true });
    }
  }, [activeRoomId, urlRoomId]);

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

  const sseTelemetry = useRealtimeSseSync(true, sessionToken, activeRoomId, joinedRoomsSignature);

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
    (agent: OwnedAgentSummaryDto): void => {
      setInspectedAgent({
        agentId: agent.id,
        displayName: agent.displayName,
        platform: agent.platform,
        ownerUserId: props.currentUser.id,
        ownerDisplayName: props.currentUser.displayName,
        reach: agent.reach,
      });
    },
    [props.currentUser.displayName, props.currentUser.id],
  );

  const handleLogout = useCallback((): void => {
    logoutMutation.mutate(undefined, {
      onSuccess: () => toast.success("已退出当前账号"),
    });
  }, [logoutMutation]);

  // 构造全局 `⌘K` 命令面板分组动作
  const commandGroups: ReadonlyArray<CommandPaletteGroup> = useMemo(() => {
    const activeRoomName = activeRoomDetailQuery.data?.room.name;
    const isDark = themeMode === "dark";

    const quickActions: CommandPaletteGroup = {
      id: "quick-actions",
      heading: "快捷操作",
      items: [
        ...(activeRoomId !== null
          ? [
              {
                id: "act-synthesize-proposal",
                label: "整理当前群近期讨论为提案卡",
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
          subtitle: "创建一个新的群聊并拉入你的 Agent",
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
      heading: "群聊",
      items: rooms.map((room) => {
        const unread = Math.max(0, room.lastSeq - room.yourLastReadSeq);
        return {
          id: `cmd-room-${room.id}`,
          label: room.name,
          subtitle: room.topic.length > 0 ? room.topic : undefined,
          icon: <MessageCircle className="h-4 w-4" />,
          ...(unread > 0
            ? {
                badge: (
                  <span className="rounded-full bg-[#FF3B30] px-1.5 py-0.2 text-[10px] font-semibold tabular-nums text-white">
                    {unread}
                  </span>
                ),
              }
            : {}),
          keywords: [room.name, room.topic, "room", "群聊"],
          onSelect: () => handleSelectRoom(room.id),
        };
      }),
    };

    const agentItemsGroup: CommandPaletteGroup = {
      id: "owned-agents",
      heading: "我的 agent",
      items: props.ownedAgents.map((agt) => {
        const reachMeta = getReachVisualMeta(agt.reach);
        return {
          id: `cmd-agt-${agt.id}`,
          label: agt.displayName,
          subtitle: `${agt.platform} · ${reachMeta.shortLabel}`,
          icon: (
            <span className={cn("inline-block h-2.5 w-2.5 rounded-full", reachMeta.dotClass)} />
          ),
          keywords: [agt.displayName, agt.platform, "agent"],
          onSelect: () => inspectOwnedAgent(agt),
        };
      }),
    };

    return [quickActions, roomItemsGroup, agentItemsGroup];
  }, [
    activeRoomDetailQuery.data?.room.name,
    activeRoomId,
    handleSelectRoom,
    inspectOwnedAgent,
    openOnboarding,
    props.ownedAgents,
    rooms,
    themeMode,
  ]);

  const isChatVisibleOnMobile = mobileShowChat && activeRoomId !== null;

  return (
    <div className="glass-canvas flex h-dvh w-screen overflow-hidden text-[#141414] md:p-2 dark:text-zinc-100">
      {/* 统一圆角三栏玻璃窗口：各栏之间仅以 `1px solid rgba(0,0,0,0.06)` 极细发丝分割，环境光自 body 透入 */}
      <div className="glass-strong flex h-full w-full overflow-hidden md:rounded-[20px] md:border md:border-black/[0.06] dark:md:border-white/[0.06]">
        {/* 第 1 栏：80px 个人头像 + 我的 Agents + `+ 接入 agent` 导轨 */}
        <PersonalAgentRail
          currentUser={props.currentUser}
          ownedAgents={props.ownedAgents}
          onInspectAgent={inspectOwnedAgent}
          onOpenConnectAgent={() => openOnboarding("pair_agent")}
          onOpenCommandPalette={() => setCommandPaletteOpen(true)}
          onLogout={handleLogout}
        />

        {/* 第 2 栏：280px `聊天 | 通讯录` 侧栏 */}
        <div
          className={cn(
            isChatVisibleOnMobile ? "hidden" : "flex",
            "min-w-0 flex-1 md:flex md:flex-none md:border-r md:border-black/[0.06] dark:md:border-white/[0.06]",
          )}
        >
          <RoomSidebar
            currentUser={props.currentUser}
            ownedAgents={props.ownedAgents}
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
            onInspectOwnedAgent={inspectOwnedAgent}
            onLogout={handleLogout}
            onOpenCommandPalette={() => setCommandPaletteOpen(true)}
          />
        </div>

        {/* 第 3 栏：纯净 `#FFFFFF` 宽敞聊天主舞台 vs 无群聊极简空态 */}
        {activeRoomId !== null ? (
          <div
            className={cn(
              isChatVisibleOnMobile ? "flex" : "hidden",
              "min-w-0 flex-1 overflow-hidden md:flex",
            )}
          >
            <ActiveRoomStage
              key={activeRoomId}
              roomId={activeRoomId}
              currentUser={props.currentUser}
              synthesizeSignal={synthesizeSignal}
              onOpenAddAgentModal={(tab, reclaimId) =>
                openOnboarding(tab ?? "pair_agent", reclaimId)
              }
              onBackToList={() => setMobileShowChat(false)}
              onInspectAgent={(profile) => setInspectedAgent(profile)}
            />
          </div>
        ) : (
          <main className="hidden flex-1 flex-col items-center justify-center overflow-y-auto bg-white p-8 md:flex dark:bg-[#0E0E10]">
            <div className="max-w-md select-none text-center">
              <h1 className="text-[22px] font-semibold tracking-[-0.025em] text-[#141414] dark:text-zinc-100">
                还没有群聊
              </h1>
              <p className="mt-2.5 text-[14px] leading-relaxed text-[#6E6E73] dark:text-zinc-400">
                建一个群，把你的 Claude Code、Codex 或朋友的 Agent 拉进来一起讨论。
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
                  onClick={() => openOnboarding("pair_agent")}
                >
                  接入 agent
                </AppButton>
              </div>
            </div>
          </main>
        )}
      </div>

      {/* 全局 `⌘K` / `Ctrl+K` 命令面板 */}
      <AppCommandPalette
        open={commandPaletteOpen}
        onOpenChange={setCommandPaletteOpen}
        groups={commandGroups}
        footerHint={`${props.currentUser.displayName} · ${String(onlineAgentCount)} 个个人 Agent 在线`}
      />

      {/* 全局业务模态弹窗组 */}
      <CreateRoomModal
        open={createRoomOpen}
        onClose={() => setCreateRoomOpen(false)}
        onRoomCreated={(room) => handleSelectRoom(room.id)}
      />

      <JoinRoomModal
        open={joinRoomOpen}
        onClose={() => setJoinRoomOpen(false)}
        onRoomJoined={(room) => handleSelectRoom(room.id)}
      />

      <AgentOnboardingModal
        open={onboardingModalOpen}
        initialTab={onboardingInitialTab}
        initialReclaimAgentId={reclaimAgentId}
        currentUser={props.currentUser}
        ownedAgents={props.ownedAgents}
        activeRoom={activeRoomDetailQuery.data?.room ?? null}
        onClose={() => setOnboardingModalOpen(false)}
      />

      <AgentProfileDialog
        profile={inspectedAgent}
        currentUserId={props.currentUser.id}
        onClose={() => setInspectedAgent(null)}
        onReclaimAgent={(agentId) => openOnboarding("pair_agent", agentId)}
      />
    </div>
  );
}

/**
 * OpenHuddle 协作工作台顶层入口组件：自动完成登录态自省，并在认证页与 Pachat 三栏工作台间无闪烁切换。
 *
 * @returns 登录视图或完整三栏 IM 工作台
 */
export function WorkspaceShell() {
  const meQuery = useQuery(currentMeQueryOptions());

  if (meQuery.isPending) {
    return (
      <main className="flex h-dvh flex-col items-center justify-center gap-2.5 bg-[#EFEFF3] text-[#141414] dark:bg-[#101012] dark:text-zinc-100">
        <span className="text-[17px] font-semibold tracking-[-0.02em]">OpenHuddle</span>
        <span className="text-xs text-[#6E6E73] dark:text-zinc-400">正在连接…</span>
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
