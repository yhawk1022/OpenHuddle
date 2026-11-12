/**
 * @module web/features/huddle-room/workspace-shell
 * @description OpenHuddle 人类实时协作与拍板三栏工作台主壳层（融合 Pachat 的秒级配对体验与超越 Pachat 的裁判治理栏、Markdown 代码表格与提案拍板闭环）。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 严格单向边界：仅通过 `../../auth-pairing/index.js` 公共门面访问兄弟特性，绝不跨特性深层私引内部实现。
 * 2. 单一状态源：所有服务端读取由 `TanStack Query` 托管，全局单一 SSE 连接（`useRealtimeSseSync`）仅向 `QueryClient` 执行按 `seq` 幂等补丁更新。
 * 3. 四态完备与响应式抽屉：桌面端完整呈现三栏布局（房间列表 / 治理栏+消息流+编辑器 / 成员与提案督导栏），平板与移动端平滑折叠为抽屉。
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
  Bot,
  Loader2,
  LogIn,
  Menu,
  MessageSquarePlus,
  Plus,
  RefreshCw,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { BrandMark } from "../../../components/brand-mark.js";
import {
  AgentProfileDialog,
  type InspectedAgentProfile,
} from "../../../components/ui/agent-profile-dialog.js";
import { MessageBubble } from "../../../components/ui/message-bubble.js";
import type { OptimisticMessageItem } from "../../../lib/query-keys.js";
import { navigateTo, useBrowserLocation, useSessionToken } from "../../../lib/session-store.js";
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

function parseSelectedRoomIdFromSearch(search: string): RoomId | null {
  const params = new URLSearchParams(search);
  const raw = params.get("room")?.trim();
  return raw && raw.length > 0 ? (raw as RoomId) : null;
}

interface ActiveRoomStageProps {
  readonly roomId: RoomId;
  readonly currentUser: HumanUserDto;
  readonly onOpenAddAgentModal: (tab?: OnboardingModalTab) => void;
  readonly onOpenMobileSidebar: () => void;
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

  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("members");
  const [mobileInspectorOpen, setMobileInspectorOpen] = useState<boolean>(false);
  const [focusedProposalId, setFocusedProposalId] = useState<ProposalId | null>(null);
  const [replyTarget, setReplyTarget] = useState<MessageDto | null>(null);
  const [pendingQuickMention, setPendingQuickMention] = useState<MessageMention | null>(null);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  const timelineEndRef = useRef<HTMLDivElement | null>(null);
  const lastRenderedCountRef = useRef<number>(0);

  // 每 15 秒刷新一次本地相对时钟，用于准确判断 2 分钟自助撤回窗口过期态
  useEffect(() => {
    const timer = window.setInterval(() => {
      setNowMs(Date.now());
    }, 15_000);
    return () => window.clearInterval(timer);
  }, []);

  const messages: ReadonlyArray<OptimisticMessageItem> = messagesQuery.data?.messages ?? [];
  const proposals: ReadonlyArray<ProposalCardDto> = proposalsQuery.data?.proposals ?? [];

  // 当收到新消息或发出乐观气泡时平滑滚动到底部锚点
  useEffect(() => {
    if (messages.length > lastRenderedCountRef.current) {
      timelineEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    }
    lastRenderedCountRef.current = messages.length;
  }, [messages.length]);

  const messageBySeq = useMemo(() => {
    const map = new Map<number, MessageDto>();
    for (const msg of messages) {
      if (!msg._optimisticPending) {
        map.set(msg.seq, msg);
      }
    }
    return map;
  }, [messages]);

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
      <div className="flex flex-1 flex-col gap-4 p-6">
        <div className="h-20 animate-pulse rounded-2xl bg-slate-200/70 dark:bg-white/[0.04]" />
        <div className="flex-1 space-y-3">
          {[1, 2, 3].map((sk) => (
            <div
              key={`stage-sk-${String(sk)}`}
              className="h-24 animate-pulse rounded-2xl bg-slate-200/65 dark:bg-white/[0.035]"
            />
          ))}
        </div>
      </div>
    );
  }

  if (detailQuery.isError || !detailQuery.data) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center p-8 text-center">
        <div className="max-w-md rounded-2xl border border-rose-500/30 bg-white p-6 shadow-xs dark:bg-[#111520]">
          <AlertCircle className="mx-auto h-7 w-7 text-rose-500" />
          <h2 className="mt-2 text-sm font-bold text-slate-900 dark:text-white">
            无法加载当前 Huddle 房间详情
          </h2>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            请确认你仍是该房间成员，或点击重试同步最新状态。
          </p>
          <button
            type="button"
            onClick={() => void detailQuery.refetch()}
            className="mt-4 inline-flex items-center gap-1.5 rounded-xl bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-500"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            <span>重新加载房间</span>
          </button>
        </div>
      </div>
    );
  }

  const room = detailQuery.data.room;
  const liveGovernance = messagesQuery.data?.governance ?? room.governance;
  const openProposalsCount = proposals.filter((p) => p.status === "open").length;

  const handleOpenProposalInInspector = (proposalId: ProposalId): void => {
    setFocusedProposalId(proposalId);
    setInspectorTab("proposals");
    setMobileInspectorOpen(true);
  };

  const inspectorNode = (
    <RoomInspector
      room={room}
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
      onCastVote={(proposalId, body) => castVoteMutation.mutate({ proposalId, body })}
      onDecideProposal={(proposalId, body) => decideMutation.mutate({ proposalId, body })}
      onUpdateGovernance={(patch) => governanceMutation.mutate(patch)}
      onInspectAgent={props.onInspectAgent}
      onQuickMention={(mention) => {
        setPendingQuickMention(mention);
        setMobileInspectorOpen(false);
      }}
      onOpenAddAgentModal={() => props.onOpenAddAgentModal("pair_agent")}
      onCloseMobileInspector={mobileInspectorOpen ? () => setMobileInspectorOpen(false) : undefined}
    />
  );

  return (
    <div className="relative flex min-w-0 flex-1 overflow-hidden">
      {/* 中央主栏：治理条 + 消息流 + 输入编辑器 */}
      <div className="flex min-w-0 flex-1 flex-col bg-slate-50/40 dark:bg-[#090b10]">
        <GovernanceBar
          room={room}
          governance={liveGovernance}
          proposalsCount={proposals.length}
          openProposalsCount={openProposalsCount}
          isUpdatingGovernance={governanceMutation.isPending}
          onUpdateGovernance={(patch) => governanceMutation.mutate(patch)}
          onOpenAddAgentModal={() => props.onOpenAddAgentModal("pair_agent")}
          onOpenMobileSidebar={props.onOpenMobileSidebar}
          onToggleMobileInspector={() => setMobileInspectorOpen((prev) => !prev)}
        />

        {/* 中央可滚动讨论流 */}
        <div className="flex-1 overflow-y-auto px-4 py-5 sm:px-6">
          <div className="mx-auto max-w-4xl space-y-3.5">
            {messagesQuery.isPending ? (
              <div className="space-y-3">
                {[1, 2, 3].map((id) => (
                  <div
                    key={`msg-sk-${String(id)}`}
                    className="h-24 animate-pulse rounded-2xl bg-slate-200/70 dark:bg-white/[0.04]"
                  />
                ))}
              </div>
            ) : messagesQuery.isError ? (
              <div className="rounded-2xl border border-rose-500/30 bg-rose-500/10 p-4 text-xs text-rose-700 dark:text-rose-300">
                <div className="flex items-center justify-between gap-2">
                  <span>拉取讨论消息流失败，请检查网络连接。</span>
                  <button
                    type="button"
                    onClick={() => void messagesQuery.refetch()}
                    className="rounded-lg bg-rose-600 px-3 py-1 font-semibold text-white"
                  >
                    重试
                  </button>
                </div>
              </div>
            ) : messages.length === 0 ? (
              <div className="my-8 rounded-3xl border border-dashed border-slate-300/90 bg-white/90 p-7 text-center shadow-2xs dark:border-white/10 dark:bg-[#10141e]">
                <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-indigo-500/12 text-indigo-600 dark:text-indigo-400">
                  <MessageSquarePlus className="h-6 w-6" />
                </div>
                <h2 className="mt-3 text-base font-bold text-slate-900 dark:text-white">
                  #{room.name} 已就绪，开启多智能体头脑风暴
                </h2>
                <p className="mx-auto mt-1.5 max-w-md text-xs leading-relaxed text-slate-500 dark:text-slate-400">
                  先点击下方按钮一键复制配对引导词拉入你的个人 Agent（Antigravity / Codex / Claude
                  Code），再在底部输入框 `@全体 Agents` 抛出问题，最终用右侧「AI
                  自动提炼提案卡」一键拍板！
                </p>
                <div className="mt-5 flex flex-wrap items-center justify-center gap-2.5">
                  <button
                    type="button"
                    onClick={() => props.onOpenAddAgentModal("pair_agent")}
                    className="inline-flex items-center gap-1.5 rounded-xl bg-indigo-600 px-4 py-2 text-xs font-semibold text-white shadow-xs transition hover:bg-indigo-500"
                  >
                    <Bot className="h-4 w-4" />
                    <span>+ 10 秒配对拉入我的 Agent</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setInspectorTab("proposals");
                      setMobileInspectorOpen(true);
                    }}
                    className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 dark:border-white/10 dark:bg-white/[0.04] dark:text-slate-200"
                  >
                    <Sparkles className="h-3.5 w-3.5 text-indigo-500" />
                    <span>查看提案决策面板</span>
                  </button>
                </div>
              </div>
            ) : (
              messages.map((message) => {
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
                    repliedMessage={replied}
                    linkedProposal={linkedProposal}
                    authorOwnerName={agentMember?.ownerDisplayName}
                    authorReach={agentMember?.reach}
                    nowMs={nowMs}
                    isRecalling={recallMutation.isPending}
                    onReply={(msg) => setReplyTarget(msg)}
                    onQuickMention={(mention) => setPendingQuickMention(mention)}
                    onRecall={(seq) => recallMutation.mutate(seq)}
                    onOpenProposal={handleOpenProposalInInspector}
                    onInspectAgent={props.onInspectAgent}
                  />
                );
              })
            )}
            <div ref={timelineEndRef} />
          </div>
        </div>

        <MessageComposer
          roomName={room.name}
          members={room.members}
          replyTarget={replyTarget}
          pendingQuickMention={pendingQuickMention}
          onConsumeQuickMention={() => setPendingQuickMention(null)}
          onClearReplyTarget={() => setReplyTarget(null)}
          isSending={sendMessageMutation.isPending}
          sendError={sendMessageMutation.error}
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

      {/* 桌面端常驻右栏（xl 及以上） */}
      <div className="hidden xl:flex">{inspectorNode}</div>

      {/* 平板与移动端右侧抽屉遮罩 */}
      {mobileInspectorOpen ? (
        <div className="fixed inset-0 z-40 flex justify-end bg-slate-950/55 backdrop-blur-xs xl:hidden">
          {inspectorNode}
        </div>
      ) : null}
    </div>
  );
}

interface AuthenticatedWorkspaceViewProps {
  readonly currentUser: HumanUserDto;
  readonly ownedAgents: ReadonlyArray<OwnedAgentSummaryDto>;
}

function AuthenticatedWorkspaceView(props: AuthenticatedWorkspaceViewProps) {
  const location = useBrowserLocation();
  const sessionToken = useSessionToken();
  const roomsQuery = useQuery(joinedRoomsQueryOptions());
  const logoutMutation = useLogoutMutation();

  const [createRoomOpen, setCreateRoomOpen] = useState<boolean>(false);
  const [joinRoomOpen, setJoinRoomOpen] = useState<boolean>(false);
  const [onboardingModalOpen, setOnboardingModalOpen] = useState<boolean>(false);
  const [onboardingInitialTab, setOnboardingInitialTab] =
    useState<OnboardingModalTab>("pair_agent");
  const [reclaimAgentId, setReclaimAgentId] = useState<AgentId | null>(null);
  const [inspectedAgent, setInspectedAgent] = useState<InspectedAgentProfile | null>(null);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState<boolean>(false);

  const rooms = roomsQuery.data?.rooms ?? [];
  const urlRoomId = parseSelectedRoomIdFromSearch(location.search);

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

  const sseTelemetry = useRealtimeSseSync(true, sessionToken, activeRoomId);

  const handleSelectRoom = (nextRoomId: RoomId): void => {
    navigateTo(`/?room=${encodeURIComponent(nextRoomId)}`);
  };

  const openOnboarding = (tab: OnboardingModalTab = "pair_agent", reclaimId?: AgentId): void => {
    setOnboardingInitialTab(tab);
    setReclaimAgentId(reclaimId ?? null);
    setOnboardingModalOpen(true);
  };

  const sidebarNode = (
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
      onLogout={() => logoutMutation.mutate()}
      onCloseMobileDrawer={mobileSidebarOpen ? () => setMobileSidebarOpen(false) : undefined}
    />
  );

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-slate-50 text-slate-900 dark:bg-[#090b10] dark:text-slate-100">
      {/* 桌面端常驻左栏 */}
      <div className="hidden lg:flex">{sidebarNode}</div>

      {/* 移动端左栏抽屉 */}
      {mobileSidebarOpen ? (
        <div className="fixed inset-0 z-40 flex bg-slate-950/55 backdrop-blur-xs lg:hidden">
          {sidebarNode}
        </div>
      ) : null}

      {/* 右侧主画布：激活房间 vs 首次无房间空态欢迎舱 */}
      {activeRoomId !== null ? (
        <ActiveRoomStage
          key={activeRoomId}
          roomId={activeRoomId}
          currentUser={props.currentUser}
          onOpenAddAgentModal={(tab) => openOnboarding(tab ?? "pair_agent")}
          onOpenMobileSidebar={() => setMobileSidebarOpen(true)}
          onInspectAgent={(profile) => setInspectedAgent(profile)}
        />
      ) : (
        <main className="flex flex-1 flex-col overflow-y-auto p-6">
          <div className="flex items-center lg:hidden">
            <button
              type="button"
              onClick={() => setMobileSidebarOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 dark:border-white/10 dark:bg-white/[0.04] dark:text-slate-200"
            >
              <Menu className="h-4 w-4" />
              <span>展开导航</span>
            </button>
          </div>

          <div className="m-auto max-w-xl rounded-3xl border border-slate-200/90 bg-white p-8 text-center shadow-sm dark:border-white/[0.08] dark:bg-[#10141e]">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow-md shadow-indigo-500/25">
              <Sparkles className="h-7 w-7" />
            </div>
            <h1 className="mt-4 text-xl font-bold tracking-tight text-slate-900 dark:text-white">
              欢迎来到 OpenHuddle 多智能体决策工作台
            </h1>
            <p className="mt-2 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
              把散落在终端与 IDE 里的个人智能体（Antigravity、Codex、Claude
              Code、Cursor、DeepSeek）拉进同一个受控群聊，在防死循环轮次预算与防抢话读锁保护下交叉辩论，最终提炼为结构化提案供你一键拍板。
            </p>

            <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
              <button
                type="button"
                onClick={() => setCreateRoomOpen(true)}
                className="inline-flex items-center gap-1.5 rounded-xl bg-indigo-600 px-5 py-2.5 text-xs font-semibold text-white shadow-xs transition hover:bg-indigo-500"
              >
                <Plus className="h-4 w-4" />
                <span>新建第一个 Huddle 房间</span>
              </button>

              <button
                type="button"
                onClick={() => openOnboarding("pair_agent")}
                className="inline-flex items-center gap-1.5 rounded-xl border border-indigo-500/35 bg-indigo-500/10 px-4 py-2.5 text-xs font-semibold text-indigo-700 transition hover:bg-indigo-500/18 dark:text-indigo-300"
              >
                <Bot className="h-4 w-4" />
                <span>配对我的个人 Agent</span>
              </button>

              <button
                type="button"
                onClick={() => setJoinRoomOpen(true)}
                className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-slate-50 px-4 py-2.5 text-xs font-semibold text-slate-700 transition hover:bg-slate-100 dark:border-white/10 dark:bg-white/[0.04] dark:text-slate-200"
              >
                <LogIn className="h-4 w-4" />
                <span>凭邀请码入群</span>
              </button>
            </div>

            <div className="mt-6 inline-flex items-center gap-1.5 rounded-full border border-emerald-500/25 bg-emerald-500/[0.07] px-3 py-1 text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
              <ShieldCheck className="h-3.5 w-3.5" />
              <span>Owner-First 签名保护 · 零 Redis 2C4G 自托管就绪</span>
            </div>
          </div>
        </main>
      )}

      {/* 全局模态弹窗组 */}
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
 * OpenHuddle 协作舱顶层入口壳组件：自动完成登录态自省并在认证门户与三栏工作台间无闪烁切换。
 *
 * @returns 登录视图或完整三栏实时工作台
 */
export function WorkspaceShell() {
  const meQuery = useQuery(currentMeQueryOptions());

  if (meQuery.isPending) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-3 bg-slate-50 text-slate-700 dark:bg-[#090b10] dark:text-slate-300">
        <BrandMark className="h-11 w-11 rounded-2xl shadow-md" />
        <div className="inline-flex items-center gap-2 text-xs font-medium text-slate-500 dark:text-slate-400">
          <Loader2 className="h-4 w-4 animate-spin text-indigo-500" />
          <span>正在连接 OpenHuddle 协作舱...</span>
        </div>
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
