/**
 * @module web/features/huddle-room/room-inspector
 * @description Apple Liquid Glass 群信息与共识提案面板（Neutral Smoked Graphite & Porcelain Inspector）：
 * 顶部 `60px` 标题栏与侧栏对齐，通过全胶囊 `SegmentedTabs` 在「成员」与「提案」间切换；
 * 成员页按人类主理人树形分组展示个人 Agent（在线状态、平台微标签、一键 `@` 点名）、邀请码分享、折叠治理开关与群主管理区；
 * 提案页承载讨论提炼、手动多方案表单与人类拍板闭环。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 权威归属展示：每个 Agent 严格挂在服务端盖章的 `ownerUserId` 主理人名下展示，绝不依据昵称猜测归属；点击 Agent 打开完整名片。
 * 2. 防多层模糊叠加：桌面端独立分栏（`surfaceMode="panel"`）挂载 `relative liquid-glass-panel`；窄屏嵌入 `AppSheetDrawer`（`surfaceMode="sheet"`）时回落透明底色以直接复用抽屉自身的 `liquid-glass-modal`。
 * 3. 人机决策闭环：支持一键调用服务端主持人模型或当次透传 BYOK 密钥（前端不落盘）整理多方案对比卡，由人类最终拍板。
 */
import {
  type AgentId,
  type CastProposalVoteBody,
  type DecideProposalBody,
  type FriendContactDto,
  type GovernanceMode,
  type MessageMention,
  type ProposalCardDto,
  type ProposalDraft,
  type ProposalId,
  type ProposalOption,
  type RoomDetailDto,
  type RoomGovernanceState,
  type RoomMemberDto,
  type UpdateGovernanceBody,
  type UserId,
  assertNever,
} from "@openhuddle/protocol";
import {
  AlertCircle,
  AtSign,
  Check,
  ChevronDown,
  Copy,
  ExternalLink,
  FilePlus2,
  FileText,
  Globe,
  Lock,
  LogOut,
  MessageCircle,
  Plus,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Trash2,
  UserPlus,
  UserRound,
  Users,
  X,
} from "lucide-react";
import { type FormEvent, useMemo, useState } from "react";
import {
  AnimatePresence,
  AppButton,
  AppContextMenu,
  type AppContextMenuEntry,
  AppInput,
  AppSelect,
  type AppSelectOption,
  AppSwitch,
  AppTextarea,
  AppTooltip,
  IconButton,
  type SegmentedTabItem,
  SegmentedTabs,
  appButtonVariants,
  cn,
  motion,
  toast,
} from "../../../components/primitives/index.js";
import type { InspectedAgentProfile } from "../../../components/ui/agent-profile-dialog.js";
import { PlatformAvatar, PlatformTagPill } from "../../../components/ui/identity-badges.js";
import { ProposalCardView } from "../../../components/ui/proposal-card-view.js";
import { ApiClientError, type SynthesizeProposalInput } from "../../../lib/api-client.js";
import { getReachVisualMeta } from "../../../lib/format.js";

/** 右侧群信息抽屉标签页枚举 */
export type InspectorTab = "members" | "proposals";

const MODE_OPTIONS: ReadonlyArray<SegmentedTabItem<GovernanceMode>> = [
  { value: "free", label: "自由讨论" },
  { value: "round_table", label: "圆桌轮流" },
  { value: "proposal", label: "提案收敛" },
];

const BASE_TURN_CAPS: ReadonlyArray<number> = [3, 4, 6, 8, 10, 15, 25];

/** 面板内分区卡片的统一半透表面类名 */
const SECTION_CARD_CLASS =
  "rounded-[18px] bg-white/65 ring-1 ring-inset ring-black/[0.05] dark:bg-white/[0.045] dark:ring-white/[0.07]";

interface EditableOptionDraft {
  readonly localId: string;
  readonly optionKey: string;
  readonly label: string;
  readonly summary: string;
  readonly prosText: string;
  readonly consText: string;
  readonly risksText: string;
}

/** 按人类主理人聚合的成员分组（主理人可能未以人类身份入群，仅其 Agent 在群内） */
interface OwnerTeamGroup {
  readonly ownerUserId: UserId;
  readonly ownerDisplayName: string;
  readonly human: RoomMemberDto | null;
  readonly agents: ReadonlyArray<RoomMemberDto>;
}

/** `RoomInspector` 入参属性 */
export interface RoomInspectorProps {
  readonly room: RoomDetailDto;
  readonly currentUserId: UserId;
  readonly governance: RoomGovernanceState;
  readonly isUpdatingGovernance: boolean;
  readonly activeTab: InspectorTab;
  readonly onChangeTab: (tab: InspectorTab) => void;
  readonly proposals: ReadonlyArray<ProposalCardDto>;
  readonly isLoadingProposals: boolean;
  readonly isProposalsError: boolean;
  readonly onRetryProposals: () => void;
  readonly focusedProposalId: ProposalId | null;
  readonly isSynthesizing: boolean;
  readonly synthesizeError: Error | null;
  readonly onSynthesizeProposal: (input: SynthesizeProposalInput) => void;
  readonly isCreatingProposal: boolean;
  readonly createProposalError: Error | null;
  readonly onCreateProposal: (draft: ProposalDraft, onSuccessClear: () => void) => void;
  readonly isSubmittingVote: boolean;
  readonly isSubmittingDecision: boolean;
  readonly onCastVote: (proposalId: ProposalId, body: CastProposalVoteBody) => void;
  readonly onDecideProposal: (proposalId: ProposalId, body: DecideProposalBody) => void;
  readonly onUpdateGovernance: (patch: UpdateGovernanceBody) => void;
  readonly onInspectAgent: (profile: InspectedAgentProfile) => void;
  readonly onQuickMention: (mention: MessageMention) => void;
  readonly onOpenAddAgentModal: () => void;
  /** 已通过的好友列表（用于群成员行识别是否已为好友并展示「私聊 / 加好友」） */
  readonly friends?: ReadonlyArray<FriendContactDto> | undefined;
  /** 打开「向现有群聊拉入好友或本人 Agent」模态窗 */
  readonly onOpenInviteMembersModal?: (() => void) | undefined;
  /** 从群成员行直接打开与好友的 1v1 私聊 */
  readonly onStartDirectHumanChat?: ((userId: UserId) => void) | undefined;
  /** 从群成员行向非好友发送好友申请 */
  readonly onSendFriendRequest?: ((userId: UserId, displayName: string) => void) | undefined;
  /** 从成员行右键快捷发起与 Agent 的 1v1 单聊 */
  readonly onStartDirectAgentChat?: ((agentId: AgentId) => void) | undefined;
  /** 仅群主或单聊人类参与方可见的「删除会话」回调 */
  readonly onRequestDeleteRoom?: ((room: RoomDetailDto) => void) | undefined;
  /** 非群主成员可见的「退出群聊」回调 */
  readonly onRequestLeaveRoom?: ((room: RoomDetailDto) => void) | undefined;
  /** 宿主承载模式：`panel` 为桌面独立悬浮玻璃岛，`sheet` 为嵌入 Vaul 抽屉内部（免重复叠加模糊） */
  readonly surfaceMode?: "panel" | "sheet" | undefined;
  /** 关闭抽屉（桌面端收起侧栏 / 窄屏关闭 Vaul 抽屉） */
  readonly onClose: () => void;
}

function splitLinesToItems(raw: string): string[] {
  return raw
    .split(/\n|,|；|;/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .slice(0, 8);
}

function createInitialOptions(): ReadonlyArray<EditableOptionDraft> {
  return [
    {
      localId: "opt-init-a",
      optionKey: "A",
      label: "方案 A（稳健渐进）",
      summary: "",
      prosText: "",
      consText: "",
      risksText: "",
    },
    {
      localId: "opt-init-b",
      optionKey: "B",
      label: "方案 B（一步到位）",
      summary: "",
      prosText: "",
      consText: "",
      risksText: "",
    },
  ];
}

function isReachableNow(member: RoomMemberDto): boolean {
  return (
    member.reach === "online_sse" || member.reach === "hosted_ready" || member.reach === "webhook"
  );
}

/**
 * 按 `ownerUserId` 将群成员聚合为「人类主理人 → 名下个人 Agent」卡片分组。
 *
 * @remarks 分组键只信任服务端返回的 `ownerUserId`，在线 Agent 数量多的队伍优先置顶。
 */
function groupMembersByOwner(members: ReadonlyArray<RoomMemberDto>): ReadonlyArray<OwnerTeamGroup> {
  const order: UserId[] = [];
  const humans = new Map<UserId, RoomMemberDto>();
  const agentsByOwner = new Map<UserId, RoomMemberDto[]>();
  const ownerNames = new Map<UserId, string>();

  for (const member of members) {
    const ownerId = member.ownerUserId;
    if (!ownerNames.has(ownerId)) {
      order.push(ownerId);
      ownerNames.set(ownerId, member.ownerDisplayName);
    }
    if (member.memberKind === "human") {
      humans.set(ownerId, member);
      ownerNames.set(ownerId, member.displayName);
    } else {
      const list = agentsByOwner.get(ownerId) ?? [];
      list.push(member);
      agentsByOwner.set(ownerId, list);
    }
  }

  return order
    .map((ownerUserId) => ({
      ownerUserId,
      ownerDisplayName: ownerNames.get(ownerUserId) ?? "未知成员",
      human: humans.get(ownerUserId) ?? null,
      agents: agentsByOwner.get(ownerUserId) ?? [],
    }))
    .sort(
      (a, b) => b.agents.filter(isReachableNow).length - a.agents.filter(isReachableNow).length,
    );
}

function roleLabel(role: RoomMemberDto["role"]): string {
  switch (role) {
    case "owner":
      return "群主";
    case "moderator":
      return "管理员";
    case "member":
      return "成员";
    default:
      return assertNever(role);
  }
}

/**
 * 渲染右侧 Apple Liquid Glass 群信息与提案面板。
 *
 * @param props - 房间详情、实时治理快照、提案列表与全部治理/决策动作回调
 * @returns 右侧群信息与提案面板视图
 */
export function RoomInspector(props: RoomInspectorProps) {
  const surfaceMode = props.surfaceMode ?? "panel";
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState<boolean>(false);

  // 自动整理提案的窗口与可选 BYOK 配置折叠态
  const [byokOpen, setByokOpen] = useState<boolean>(false);
  const [windowLimit, setWindowLimit] = useState<number>(30);
  const [byokModel, setByokModel] = useState<string>("");
  const [byokBaseUrl, setByokBaseUrl] = useState<string>("");
  const [byokApiKey, setByokApiKey] = useState<string>("");

  // 手动发起结构化提案表单折叠态
  const [manualFormOpen, setManualFormOpen] = useState<boolean>(false);
  const [draftTitle, setDraftTitle] = useState<string>("");
  const [draftContext, setDraftContext] = useState<string>("");
  const [recommendedKey, setRecommendedKey] = useState<string>("A");
  const [optionDrafts, setOptionDrafts] =
    useState<ReadonlyArray<EditableOptionDraft>>(createInitialOptions);

  const teamGroups = useMemo(() => groupMembersByOwner(props.room.members), [props.room.members]);
  const agentMembers = useMemo(
    () => props.room.members.filter((m) => m.memberKind === "agent"),
    [props.room.members],
  );
  const onlineAgentCount = useMemo(
    () => agentMembers.filter(isReachableNow).length,
    [agentMembers],
  );
  const openProposalsCount = useMemo(
    () => props.proposals.filter((p) => p.status === "open").length,
    [props.proposals],
  );
  const { config } = props.governance;
  const isGroupRoom = props.room.kind === "group";
  const isDirectHuman = props.room.kind === "direct_human";
  const isDirectAgent = props.room.kind === "direct_agent";
  const isRoomOwner = props.room.ownerUserId === props.currentUserId;
  const canDeleteRoom = (isDirectHuman || isRoomOwner) && props.onRequestDeleteRoom !== undefined;

  const friendUserIds = useMemo(() => {
    const s = new Set<UserId>();
    for (const f of props.friends ?? []) {
      s.add(f.user.userId);
    }
    return s;
  }, [props.friends]);

  const turnCapOptions: ReadonlyArray<AppSelectOption<string>> = useMemo(() => {
    const current = config.maxConsecutiveAgentTurns;
    const merged = BASE_TURN_CAPS.includes(current)
      ? BASE_TURN_CAPS
      : [...BASE_TURN_CAPS, current].sort((a, b) => a - b);
    return merged.map((cap) => ({
      value: String(cap),
      label: `${String(cap)} 轮`,
    }));
  }, [config.maxConsecutiveAgentTurns]);

  const inspectorTabs: ReadonlyArray<SegmentedTabItem<InspectorTab>> = useMemo(
    () => [
      {
        value: "members",
        label: isGroupRoom ? "成员" : "参与方",
        icon: <Users className="h-3.5 w-3.5" />,
        badge: String(props.room.members.length),
      },
      {
        value: "proposals",
        label: "提案",
        icon: <FileText className="h-3.5 w-3.5" />,
        badge: openProposalsCount > 0 ? String(openProposalsCount) : String(props.proposals.length),
      },
    ],
    [isGroupRoom, openProposalsCount, props.proposals.length, props.room.members.length],
  );

  const shareUrl =
    props.room.inviteToken !== undefined && typeof window !== "undefined"
      ? `${window.location.origin}/share/${encodeURIComponent(props.room.inviteToken)}`
      : null;

  const copyText = (key: "inv" | "share", value: string): void => {
    if (typeof navigator === "undefined" || !navigator.clipboard) {
      return;
    }
    void navigator.clipboard.writeText(value).then(() => {
      setCopiedKey(key);
      toast.success(key === "share" ? "已复制公开只读回放链接" : "已复制群邀请码");
      window.setTimeout(() => {
        setCopiedKey((prev) => (prev === key ? null : prev));
      }, 1_800);
    });
  };

  const copyPlainText = (text: string, toastMessage: string, description?: string): void => {
    if (typeof navigator === "undefined" || !navigator.clipboard) {
      return;
    }
    void navigator.clipboard.writeText(text).then(() => {
      toast.success(toastMessage, description !== undefined ? { description } : undefined);
    });
  };

  const handleSynthesizeClick = (): void => {
    const cleanKey = byokApiKey.trim();
    const cleanBase = byokBaseUrl.trim();
    const cleanModel = byokModel.trim();

    props.onSynthesizeProposal({
      messageWindowLimit: windowLimit,
      ...(cleanKey.length >= 8 ? { apiKey: cleanKey } : {}),
      ...(cleanBase.length > 0 ? { baseUrl: cleanBase } : {}),
      ...(cleanModel.length > 0 ? { model: cleanModel } : {}),
    });
  };

  const handleManualSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const validOptions: ProposalOption[] = optionDrafts
      .filter(
        (opt) =>
          opt.optionKey.trim().length > 0 &&
          opt.label.trim().length > 0 &&
          opt.summary.trim().length > 0,
      )
      .map((opt) => ({
        optionKey: opt.optionKey.trim(),
        label: opt.label.trim(),
        summary: opt.summary.trim(),
        pros: splitLinesToItems(opt.prosText),
        cons: splitLinesToItems(opt.consText),
        risks: splitLinesToItems(opt.risksText),
      }));

    if (
      draftTitle.trim().length < 2 ||
      draftContext.trim().length < 2 ||
      validOptions.length === 0
    ) {
      toast.error("请至少填写提案标题、背景说明及 1 个有效方案");
      return;
    }

    const cleanRecommended = recommendedKey.trim();
    props.onCreateProposal(
      {
        title: draftTitle.trim(),
        contextSummary: draftContext.trim(),
        ...(cleanRecommended.length > 0 ? { recommendedOptionKey: cleanRecommended } : {}),
        options: validOptions,
      },
      () => {
        setDraftTitle("");
        setDraftContext("");
        setOptionDrafts(createInitialOptions());
        setManualFormOpen(false);
        toast.success("提案卡已发布到群聊");
      },
    );
  };

  const handleInspectMemberAgent = (member: RoomMemberDto): void => {
    if (member.memberKind !== "agent" || member.agentId === undefined) {
      return;
    }
    props.onInspectAgent({
      agentId: member.agentId,
      displayName: member.displayName,
      ...(member.slug !== undefined ? { slug: member.slug } : {}),
      platform: member.platform ?? "custom",
      ownerUserId: member.ownerUserId,
      ownerDisplayName: member.ownerDisplayName,
      ...(member.intro !== undefined ? { intro: member.intro } : {}),
      ...(member.allowExternalDm !== undefined ? { allowExternalDm: member.allowExternalDm } : {}),
      reach: member.reach,
    });
  };

  const updateOptionDraft = (idx: number, patch: Partial<EditableOptionDraft>): void => {
    setOptionDrafts((prev) => prev.map((item, i) => (i === idx ? { ...item, ...patch } : item)));
  };

  const synthErr =
    props.synthesizeError instanceof ApiClientError
      ? props.synthesizeError.message
      : props.synthesizeError instanceof Error
        ? props.synthesizeError.message
        : null;

  const createPropErr =
    props.createProposalError instanceof ApiClientError
      ? props.createProposalError.message
      : props.createProposalError instanceof Error
        ? props.createProposalError.message
        : null;

  return (
    <aside
      className={cn(
        "relative flex h-full min-h-0 w-full flex-1 shrink-0 flex-col overflow-hidden [--oh-avatar-ring:#F4F5F8] dark:[--oh-avatar-ring:#1E1E22]",
        surfaceMode === "panel"
          ? "liquid-glass-panel xl:w-[356px] xl:flex-none xl:rounded-[22px]"
          : "bg-transparent",
      )}
    >
      {/* 1. 60px 面板顶栏（兼容 Tauri v2 + Electron 拖拽） */}
      <div
        data-tauri-drag-region=""
        className="app-drag-region flex h-[60px] shrink-0 select-none items-center justify-between gap-2 border-b border-black/[0.06] px-4 dark:border-white/[0.07]"
      >
        <div className="min-w-0">
          <p className="text-[14.5px] font-semibold tracking-[-0.01em] text-[#111318] dark:text-[#F2F2F4]">
            {isGroupRoom ? "群信息" : "会话信息"}
          </p>
          <p className="mt-0.5 truncate text-[11.5px] text-[#687082] dark:text-[#8E8E96]">
            {props.room.name}
          </p>
        </div>
        <AppTooltip side="bottom" content="收起面板">
          <IconButton size="sm" variant="ghost" label="收起会话信息面板" onClick={props.onClose}>
            <X className="h-4 w-4" />
          </IconButton>
        </AppTooltip>
      </div>

      {/* 2. 全胶囊弹簧滑块分段导航：成员/参与方 ⇄ 提案（纯人类 1v1 私聊不展示提案页） */}
      {!isDirectHuman ? (
        <div className="shrink-0 select-none px-4 pt-3 pb-2.5">
          <SegmentedTabs
            value={props.activeTab}
            onValueChange={props.onChangeTab}
            items={inspectorTabs}
            size="sm"
            fullWidth={true}
            ariaLabel="会话信息分栏"
          />
        </div>
      ) : (
        <div className="h-3 shrink-0" />
      )}

      {/* 3. 主体滚动内容区 */}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pt-0.5 pb-[max(1rem,env(safe-area-inset-bottom))]">
        {isDirectHuman || props.activeTab === "members" ? (
          <div className="space-y-3.5">
            {/* 跨主人 Agent 单聊安全隔离提示卡 */}
            {isDirectAgent &&
            props.room.peer?.kind === "agent" &&
            props.room.peer.ownerUserId !== props.currentUserId ? (
              <div className="flex items-start gap-2.5 rounded-[18px] bg-[#E6F5EC]/75 p-3 text-xs text-[#145335] ring-1 ring-inset ring-[#16A34A]/18 dark:bg-[#1B2B23]/75 dark:text-[#A7F3D0] dark:ring-[#34D399]/20">
                <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-[#16A34A] dark:text-[#34D399]" />
                <div className="leading-relaxed">
                  <p className="font-semibold">外部共享 Agent 咨询模式</p>
                  <p className="mt-0.5 opacity-90">
                    该 Agent 归属于 {props.room.peer.ownerDisplayName}
                    。你的发言在服务端强制标记为外部参考，不会触发对方宿主机的本机命令授权。
                  </p>
                </div>
              </div>
            ) : null}

            {/* 3.1 群成员与挂载的 Agent */}
            <section className="space-y-2.5">
              <div className="flex select-none items-center justify-between gap-2 px-0.5">
                <h3 className="text-[12px] font-medium text-[#687082] dark:text-[#8E8E96]">
                  {isGroupRoom
                    ? `${String(onlineAgentCount)}/${String(agentMembers.length)} 个 Agent 在线`
                    : "会话参与方"}
                </h3>
                {isGroupRoom ? (
                  <div className="flex items-center gap-1">
                    {props.onOpenInviteMembersModal !== undefined ? (
                      <AppButton
                        variant="soft"
                        size="xs"
                        leadingIcon={<UserPlus className="h-3 w-3" />}
                        onClick={props.onOpenInviteMembersModal}
                      >
                        拉好友 / Agent
                      </AppButton>
                    ) : null}
                    <AppButton
                      variant="secondary"
                      size="xs"
                      leadingIcon={<Plus className="h-3 w-3" />}
                      onClick={props.onOpenAddAgentModal}
                    >
                      配对新 agent
                    </AppButton>
                  </div>
                ) : null}
              </div>

              {isGroupRoom && agentMembers.length === 0 ? (
                <button
                  type="button"
                  onClick={props.onOpenInviteMembersModal ?? props.onOpenAddAgentModal}
                  className="im-press flex w-full cursor-pointer flex-col items-center gap-1 rounded-[18px] border border-dashed border-black/18 bg-white/50 p-4 text-center transition hover:border-black/35 hover:bg-white/80 dark:border-white/18 dark:bg-white/[0.035] dark:hover:border-white/35 dark:hover:bg-white/[0.07]"
                >
                  <Plus className="h-5 w-5 text-[#111318] dark:text-[#ECECEF]" />
                  <span className="text-[13px] font-medium text-[#111318] dark:text-[#F2F2F4]">
                    把你的 Agent 或好友拉进群
                  </span>
                  <span className="text-[11.5px] text-[#687082] dark:text-[#8E8E96]">
                    支持直拉已添加好友与 Claude Code、Codex、Cursor、Antigravity
                  </span>
                </button>
              ) : null}

              <div className="space-y-2">
                {teamGroups.map((group) => {
                  const humanMember = group.human;
                  const humanUserId = humanMember?.userId;
                  const isOtherHuman =
                    humanUserId !== undefined && humanUserId !== props.currentUserId;
                  const isAlreadyFriend =
                    humanUserId !== undefined && friendUserIds.has(humanUserId);
                  const humanMenuItems: ReadonlyArray<AppContextMenuEntry> =
                    humanMember?.userId !== undefined
                      ? (() => {
                          const targetUserId = humanMember.userId;
                          const targetName = humanMember.displayName;
                          return [
                            ...(isGroupRoom
                              ? [
                                  {
                                    id: `ctx-insp-human-mention-${targetUserId}`,
                                    label: `@ ${targetName}`,
                                    icon: <AtSign className="h-3.5 w-3.5" />,
                                    onSelect: () =>
                                      props.onQuickMention({
                                        kind: "human",
                                        userId: targetUserId,
                                        displayName: targetName,
                                      }),
                                  } satisfies AppContextMenuEntry,
                                ]
                              : []),
                            ...(isGroupRoom &&
                            isOtherHuman &&
                            isAlreadyFriend &&
                            props.onStartDirectHumanChat !== undefined
                              ? [
                                  {
                                    id: `ctx-insp-human-dm-${targetUserId}`,
                                    label: "发私聊消息",
                                    icon: <MessageCircle className="h-3.5 w-3.5" />,
                                    onSelect: () => props.onStartDirectHumanChat?.(targetUserId),
                                  } satisfies AppContextMenuEntry,
                                ]
                              : []),
                            ...(isGroupRoom &&
                            isOtherHuman &&
                            !isAlreadyFriend &&
                            props.onSendFriendRequest !== undefined
                              ? [
                                  {
                                    id: `ctx-insp-human-friend-${targetUserId}`,
                                    label: "添加好友",
                                    icon: <UserPlus className="h-3.5 w-3.5" />,
                                    onSelect: () =>
                                      props.onSendFriendRequest?.(targetUserId, targetName),
                                  } satisfies AppContextMenuEntry,
                                ]
                              : []),
                            {
                              id: `ctx-insp-human-copy-${targetUserId}`,
                              label: "复制昵称",
                              icon: <Copy className="h-3.5 w-3.5" />,
                              onSelect: () =>
                                copyPlainText(targetName, "已复制成员昵称", targetName),
                            },
                          ];
                        })()
                      : [];

                  return (
                    <div
                      key={`team-${group.ownerUserId}`}
                      className={cn(SECTION_CARD_CLASS, "p-2.5")}
                    >
                      {/* 主理人头行 */}
                      <AppContextMenu items={humanMenuItems}>
                        <div className="flex items-center justify-between gap-2 rounded-xl px-1.5 py-1 transition-colors data-[state=open]:bg-black/[0.06] dark:data-[state=open]:bg-white/[0.09]">
                          <div className="flex min-w-0 items-center gap-2.5">
                            <PlatformAvatar
                              kind="human"
                              displayName={group.ownerDisplayName}
                              size="sm"
                              className="[&>div]:rounded-full"
                            />
                            <div className="min-w-0">
                              <div className="flex items-center gap-1.5">
                                <p className="truncate text-[13px] font-semibold text-[#111318] dark:text-[#F2F2F4]">
                                  {group.ownerDisplayName}
                                </p>
                                {group.human && isGroupRoom ? (
                                  <span className="shrink-0 rounded-full bg-black/[0.05] px-2 py-0.5 text-[10px] font-medium text-[#4B5565] dark:bg-white/[0.08] dark:text-[#C4C4CA]">
                                    {roleLabel(group.human.role)}
                                  </span>
                                ) : null}
                              </div>
                              <p className="mt-0.5 text-[11px] text-[#687082] dark:text-[#8E8E96]">
                                {group.human
                                  ? isGroupRoom
                                    ? "群成员"
                                    : "会话成员"
                                  : "未以本人账号进会话"}
                                {group.agents.length > 0
                                  ? ` · 接入 ${String(group.agents.length)} 个 Agent`
                                  : ""}
                              </p>
                            </div>
                          </div>

                          {group.human?.userId !== undefined && group.human !== null
                            ? (() => {
                                const targetUid = group.human.userId;
                                const humanName = group.human.displayName;
                                return (
                                  <div className="flex shrink-0 items-center gap-1">
                                    {isGroupRoom && isOtherHuman ? (
                                      isAlreadyFriend &&
                                      props.onStartDirectHumanChat !== undefined ? (
                                        <AppButton
                                          variant="soft"
                                          size="xs"
                                          onClick={() => props.onStartDirectHumanChat?.(targetUid)}
                                          className="h-6 px-2 text-[11px]"
                                        >
                                          私聊
                                        </AppButton>
                                      ) : !isAlreadyFriend &&
                                        props.onSendFriendRequest !== undefined ? (
                                        <AppButton
                                          variant="secondary"
                                          size="xs"
                                          onClick={() =>
                                            props.onSendFriendRequest?.(targetUid, humanName)
                                          }
                                          className="h-6 px-2 text-[11px]"
                                        >
                                          加好友
                                        </AppButton>
                                      ) : null
                                    ) : null}
                                    {isGroupRoom ? (
                                      <AppTooltip side="left" content={`在输入框 @${humanName}`}>
                                        <IconButton
                                          size="sm"
                                          variant="ghost"
                                          label={`点名 @${humanName}`}
                                          onClick={() =>
                                            props.onQuickMention({
                                              kind: "human",
                                              userId: targetUid,
                                              displayName: humanName,
                                            })
                                          }
                                        >
                                          <AtSign className="h-3.5 w-3.5" />
                                        </IconButton>
                                      </AppTooltip>
                                    ) : null}
                                  </div>
                                );
                              })()
                            : null}
                        </div>
                      </AppContextMenu>

                      {/* 名下个人 Agent 列表 */}
                      {group.agents.length > 0 ? (
                        <ul className="mt-1.5 ml-3.5 space-y-1 border-l border-black/[0.08] pl-2.5 dark:border-white/[0.10]">
                          {group.agents.map((agent) => {
                            const reachMeta = getReachVisualMeta(agent.reach);
                            const agentId = agent.agentId;
                            const agentMentionText = `@${agent.displayName}`;
                            const canDirectChatAgent =
                              agentId !== undefined &&
                              props.onStartDirectAgentChat !== undefined &&
                              (agent.ownerUserId === props.currentUserId ||
                                agent.allowExternalDm === true);
                            const agentMemberMenuItems: ReadonlyArray<AppContextMenuEntry> = [
                              ...(isGroupRoom && agentId !== undefined
                                ? [
                                    {
                                      id: `ctx-insp-agt-mention-${agentId}`,
                                      label: `@ ${agent.displayName}`,
                                      icon: <AtSign className="h-3.5 w-3.5" />,
                                      onSelect: () =>
                                        props.onQuickMention({
                                          kind: "agent",
                                          agentId,
                                          displayName: agent.displayName,
                                        }),
                                    } satisfies AppContextMenuEntry,
                                  ]
                                : []),
                              ...(isGroupRoom && canDirectChatAgent && agentId !== undefined
                                ? [
                                    {
                                      id: `ctx-insp-agt-dm-${agentId}`,
                                      label: "发消息（1v1 单聊）",
                                      icon: <MessageCircle className="h-3.5 w-3.5" />,
                                      onSelect: () => props.onStartDirectAgentChat?.(agentId),
                                    } satisfies AppContextMenuEntry,
                                  ]
                                : []),
                              {
                                id: `ctx-insp-agt-inspect-${agentId ?? agent.displayName}`,
                                label: "查看 Agent 名片",
                                icon: <UserRound className="h-3.5 w-3.5" />,
                                onSelect: () => handleInspectMemberAgent(agent),
                              },
                              {
                                id: `ctx-insp-agt-copy-${agentId ?? agent.displayName}`,
                                label: `复制 ${agentMentionText}`,
                                icon: <Copy className="h-3.5 w-3.5" />,
                                onSelect: () =>
                                  copyPlainText(
                                    agentMentionText,
                                    "已复制提及标识",
                                    agentMentionText,
                                  ),
                              },
                            ];

                            return (
                              <AppContextMenu
                                key={`mem-agt-${agent.agentId ?? agent.displayName}`}
                                items={agentMemberMenuItems}
                              >
                                <li className="group flex items-center justify-between gap-1.5 rounded-xl bg-white/85 px-2.5 py-1.5 ring-1 ring-inset ring-black/[0.04] transition hover:bg-white data-[state=open]:bg-black/[0.06] data-[state=open]:ring-black/15 dark:bg-white/[0.05] dark:ring-white/[0.06] dark:hover:bg-white/[0.09] dark:data-[state=open]:bg-white/[0.11] dark:data-[state=open]:ring-white/20">
                                  <button
                                    type="button"
                                    onClick={() => handleInspectMemberAgent(agent)}
                                    className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 text-left"
                                  >
                                    <PlatformAvatar
                                      kind="agent"
                                      displayName={agent.displayName}
                                      platform={agent.platform}
                                      reach={agent.reach}
                                      size="sm"
                                      className="[&>div]:rounded-full"
                                    />
                                    <span className="min-w-0 flex-1">
                                      <span className="flex items-center gap-1.5">
                                        <span className="truncate text-[12.5px] font-semibold text-[#111318] dark:text-[#F2F2F4]">
                                          {agent.displayName}
                                        </span>
                                        {agent.platform ? (
                                          <PlatformTagPill
                                            platform={agent.platform}
                                            compact={true}
                                          />
                                        ) : null}
                                      </span>
                                      <span
                                        title={reachMeta.description}
                                        className="mt-0.5 flex items-center gap-1 text-[11px] text-[#687082] dark:text-[#8E8E96]"
                                      >
                                        <span
                                          className={cn(
                                            "h-1.5 w-1.5 rounded-full",
                                            reachMeta.dotClass,
                                          )}
                                        />
                                        <span>{reachMeta.shortLabel}</span>
                                      </span>
                                    </span>
                                  </button>

                                  {isGroupRoom && agentId !== undefined ? (
                                    <AppButton
                                      variant="soft"
                                      size="xs"
                                      onClick={() =>
                                        props.onQuickMention({
                                          kind: "agent",
                                          agentId,
                                          displayName: agent.displayName,
                                        })
                                      }
                                      className="h-6 px-2.5 text-[11px]"
                                    >
                                      @TA
                                    </AppButton>
                                  ) : null}
                                </li>
                              </AppContextMenu>
                            );
                          })}
                        </ul>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </section>

            {/* 3.2 邀请码与公开只读回放分享（仅群聊展示） */}
            {isGroupRoom ? (
              <section className={cn(SECTION_CARD_CLASS, "space-y-2.5 p-3.5")}>
                <div className="flex items-center justify-between gap-2 text-xs">
                  <div className="flex items-center gap-1.5 font-semibold text-[#111318] dark:text-[#F2F2F4]">
                    {props.room.visibility === "public_shareable" ? (
                      <Globe className="h-3.5 w-3.5 text-[#16A34A] dark:text-[#34D399]" />
                    ) : (
                      <Lock className="h-3.5 w-3.5 text-[#8E96A6] dark:text-[#8E8E96]" />
                    )}
                    <span>邀请与公开分享</span>
                  </div>

                  <div className="flex items-center gap-2">
                    <span className="text-[11px] text-[#687082] dark:text-[#8E8E96]">
                      {props.room.visibility === "public_shareable" ? "公开可分享" : "仅限邀请"}
                    </span>
                    <AppSwitch
                      size="sm"
                      ariaLabel="切换公开只读回放权限"
                      checked={props.room.visibility === "public_shareable"}
                      disabled={props.isUpdatingGovernance}
                      onCheckedChange={(checked) => {
                        const nextVis = checked ? "public_shareable" : "invite_only";
                        props.onUpdateGovernance({ visibility: nextVis });
                        toast.success(
                          checked ? "已开启公开只读分享链接" : "已关闭公开分享，恢复仅限邀请加入",
                        );
                      }}
                    />
                  </div>
                </div>

                {props.room.inviteToken ? (
                  <div className="flex items-center gap-1.5">
                    <code className="min-w-0 flex-1 truncate rounded-xl border border-black/[0.07] bg-white/90 px-2.5 py-1.5 font-mono text-[11.5px] text-[#111318] dark:border-white/[0.09] dark:bg-[#141417] dark:text-[#ECECEF]">
                      {props.room.inviteToken}
                    </code>
                    <AppButton
                      variant="secondary"
                      size="sm"
                      leadingIcon={
                        copiedKey === "inv" ? (
                          <Check className="h-3.5 w-3.5 text-[#16A34A] dark:text-[#34D399]" />
                        ) : (
                          <Copy className="h-3.5 w-3.5" />
                        )
                      }
                      onClick={() => copyText("inv", props.room.inviteToken ?? "")}
                    >
                      {copiedKey === "inv" ? "已复制" : "复制邀请码"}
                    </AppButton>
                  </div>
                ) : null}

                {props.room.visibility === "public_shareable" && shareUrl !== null ? (
                  <div className="flex items-center gap-1.5">
                    <AppButton
                      variant="primary"
                      size="sm"
                      fullWidth={true}
                      leadingIcon={
                        copiedKey === "share" ? (
                          <Check className="h-3.5 w-3.5" />
                        ) : (
                          <Copy className="h-3.5 w-3.5" />
                        )
                      }
                      onClick={() => copyText("share", shareUrl)}
                    >
                      {copiedKey === "share" ? "已复制公开链接" : "复制公开只读链接"}
                    </AppButton>
                    <AppTooltip side="top" content="在新标签页打开公开回放页">
                      <a
                        href={shareUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label="在新标签页打开公开回放页"
                        className={cn(
                          appButtonVariants({ variant: "secondary", size: "sm" }),
                          "w-8 px-0",
                        )}
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                      </a>
                    </AppTooltip>
                  </div>
                ) : null}
              </section>
            ) : null}

            {/* 3.3 可折叠「群设置与讨论规则」（群聊与 Agent 单聊展示；人类私聊隐藏） */}
            {!isDirectHuman ? (
              <section className={cn(SECTION_CARD_CLASS, "overflow-hidden")}>
                <button
                  type="button"
                  onClick={() => setSettingsOpen((prev) => !prev)}
                  aria-expanded={settingsOpen}
                  className="flex w-full cursor-pointer select-none items-center justify-between px-3.5 py-3 text-xs font-semibold text-[#111318] transition hover:bg-black/[0.03] dark:text-[#F2F2F4] dark:hover:bg-white/[0.04]"
                >
                  <span className="inline-flex items-center gap-1.5">
                    <Settings2 className="h-3.5 w-3.5 text-[#687082] dark:text-[#8E8E96]" />
                    <span>{isGroupRoom ? "群设置与讨论规则" : "单聊轮次与护栏规则"}</span>
                  </span>
                  <ChevronDown
                    className={cn(
                      "h-3.5 w-3.5 text-[#687082] transition-transform duration-200 dark:text-[#8E8E96]",
                      settingsOpen && "rotate-180",
                    )}
                  />
                </button>

                <AnimatePresence initial={false}>
                  {settingsOpen ? (
                    <motion.div
                      key="inspector-gov-body"
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: "auto", opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.18, ease: "easeOut" }}
                      className="overflow-hidden border-t border-black/[0.06] dark:border-white/[0.07]"
                    >
                      <div className="space-y-3.5 p-3.5 text-xs">
                        {isGroupRoom ? (
                          <div>
                            <p className="mb-1.5 text-[11.5px] font-medium text-[#687082] dark:text-[#8E8E96]">
                              讨论节奏
                            </p>
                            <SegmentedTabs
                              value={config.mode}
                              onValueChange={(nextMode) => {
                                if (nextMode !== config.mode && !props.isUpdatingGovernance) {
                                  const label =
                                    MODE_OPTIONS.find((m) => m.value === nextMode)?.label ??
                                    nextMode;
                                  props.onUpdateGovernance({ mode: nextMode });
                                  toast.success(`讨论节奏已切换为「${String(label)}」`);
                                }
                              }}
                              items={MODE_OPTIONS}
                              size="xs"
                              fullWidth={true}
                              ariaLabel="讨论节奏"
                            />
                          </div>
                        ) : null}

                        <div className="flex items-center justify-between gap-3">
                          <label
                            htmlFor="insp-turn-cap"
                            className="font-medium text-[#111318] dark:text-[#ECECEF]"
                          >
                            连续 Agent 发言上限
                          </label>
                          <div className="w-28 shrink-0">
                            <AppSelect
                              id="insp-turn-cap"
                              ariaLabel="连续 Agent 发言上限"
                              size="sm"
                              align="end"
                              disabled={props.isUpdatingGovernance}
                              value={String(config.maxConsecutiveAgentTurns)}
                              onValueChange={(val) => {
                                const parsed = Number(val);
                                if (
                                  Number.isFinite(parsed) &&
                                  parsed !== config.maxConsecutiveAgentTurns
                                ) {
                                  props.onUpdateGovernance({ maxConsecutiveAgentTurns: parsed });
                                  toast.success(`连续发言上限已设为 ${String(parsed)} 轮`);
                                }
                              }}
                              options={turnCapOptions}
                            />
                          </div>
                        </div>

                        {isGroupRoom ? (
                          <div className="flex items-center justify-between gap-3">
                            <label
                              htmlFor="insp-switch-mentions"
                              className="min-w-0 flex-1 cursor-pointer"
                            >
                              <span className="block font-medium text-[#111318] dark:text-[#ECECEF]">
                                Agent 互相 @ 唤醒
                              </span>
                              <span className="block text-[11px] text-[#687082] dark:text-[#8E8E96]">
                                关闭后仅人类发言可唤醒 Agent
                              </span>
                            </label>
                            <AppSwitch
                              id="insp-switch-mentions"
                              size="sm"
                              checked={config.allowAgentMentions}
                              disabled={props.isUpdatingGovernance}
                              onCheckedChange={(checked) => {
                                props.onUpdateGovernance({ allowAgentMentions: checked });
                                toast.success(
                                  checked ? "已允许 Agent 互相 @ 唤醒" : "已关闭 Agent 互相 @ 唤醒",
                                );
                              }}
                            />
                          </div>
                        ) : null}

                        <div className="flex items-center justify-between gap-3">
                          <label
                            htmlFor="insp-switch-readlock"
                            className="min-w-0 flex-1 cursor-pointer"
                          >
                            <span className="block font-medium text-[#111318] dark:text-[#ECECEF]">
                              先读后发保护
                            </span>
                            <span className="block text-[11px] text-[#687082] dark:text-[#8E8E96]">
                              拦截未读最新消息的盲目抢答
                            </span>
                          </label>
                          <AppSwitch
                            id="insp-switch-readlock"
                            size="sm"
                            checked={config.requireReadBeforeSend}
                            disabled={props.isUpdatingGovernance}
                            onCheckedChange={(checked) => {
                              props.onUpdateGovernance({ requireReadBeforeSend: checked });
                              toast.success(checked ? "已开启先读后发保护" : "已关闭先读后发保护");
                            }}
                          />
                        </div>

                        {props.room.rules.trim().length > 0 ? (
                          <div className="rounded-xl bg-white/85 p-2.5 ring-1 ring-inset ring-black/[0.05] dark:bg-[#141417] dark:ring-white/[0.07]">
                            <p className="mb-1 text-[11px] font-medium text-[#687082] dark:text-[#8E8E96]">
                              群约定
                            </p>
                            <p className="whitespace-pre-wrap text-xs leading-relaxed text-[#3B414E] dark:text-[#C4C4CA]">
                              {props.room.rules}
                            </p>
                          </div>
                        ) : null}
                      </div>
                    </motion.div>
                  ) : null}
                </AnimatePresence>
              </section>
            ) : null}

            {/* 3.4 群主/单聊删除 或 群成员退出操作区 */}
            {canDeleteRoom ? (
              <section className={cn(SECTION_CARD_CLASS, "space-y-2.5 p-3.5")}>
                <div>
                  <h3 className="text-xs font-semibold text-[#111318] dark:text-[#F2F2F4]">
                    {isGroupRoom ? "群主管理" : "会话管理"}
                  </h3>
                  <p className="mt-0.5 text-[11px] leading-relaxed text-[#687082] dark:text-[#8E8E96]">
                    {isGroupRoom
                      ? "永久删除当前群聊及其全部消息与提案，此操作不可撤销。"
                      : "删除当前一对一单聊会话及其历史消息记录（个人 Agent 与好友关系不受影响）。"}
                  </p>
                </div>
                <AppButton
                  variant="dangerSoft"
                  size="sm"
                  fullWidth={true}
                  leadingIcon={<Trash2 className="h-3.5 w-3.5" />}
                  onClick={() => props.onRequestDeleteRoom?.(props.room)}
                >
                  {isGroupRoom ? "删除群聊" : "删除单聊会话"}
                </AppButton>
              </section>
            ) : isGroupRoom && !isRoomOwner && props.onRequestLeaveRoom !== undefined ? (
              <section className={cn(SECTION_CARD_CLASS, "space-y-2.5 p-3.5")}>
                <div>
                  <h3 className="text-xs font-semibold text-[#111318] dark:text-[#F2F2F4]">
                    成员操作
                  </h3>
                  <p className="mt-0.5 text-[11px] leading-relaxed text-[#687082] dark:text-[#8E8E96]">
                    退出当前群聊后需凭邀请码重新加入，群内历史消息会保留。
                  </p>
                </div>
                <AppButton
                  variant="dangerSoft"
                  size="sm"
                  fullWidth={true}
                  leadingIcon={<LogOut className="h-3.5 w-3.5" />}
                  onClick={() => props.onRequestLeaveRoom?.(props.room)}
                >
                  退出群聊
                </AppButton>
              </section>
            ) : null}
          </div>
        ) : (
          /* Tab 2: 结构化共识提案与人类拍板闭环 */
          <div className="space-y-3.5">
            {/* 自动整理 + BYOK + 手动新建 */}
            <div className={cn(SECTION_CARD_CLASS, "space-y-2.5 p-3")}>
              <div className="flex items-center gap-1.5">
                <AppButton
                  variant="primary"
                  size="sm"
                  isLoading={props.isSynthesizing}
                  leadingIcon={<FileText className="h-3.5 w-3.5" />}
                  onClick={handleSynthesizeClick}
                  className="flex-1"
                >
                  {props.isSynthesizing ? "正在整理讨论要点…" : "整理近期讨论为提案"}
                </AppButton>

                <AppTooltip side="bottom" content="调整整理窗口或填写临时模型密钥">
                  <IconButton
                    size="md"
                    variant={byokOpen ? "soft" : "secondary"}
                    label="提案整理选项"
                    aria-pressed={byokOpen}
                    onClick={() => setByokOpen((prev) => !prev)}
                  >
                    <Settings2 className="h-3.5 w-3.5" />
                  </IconButton>
                </AppTooltip>

                <AppButton
                  variant={manualFormOpen ? "soft" : "secondary"}
                  size="sm"
                  aria-pressed={manualFormOpen}
                  leadingIcon={<FilePlus2 className="h-3.5 w-3.5" />}
                  onClick={() => setManualFormOpen((prev) => !prev)}
                >
                  手写
                </AppButton>
              </div>

              <AnimatePresence initial={false}>
                {byokOpen ? (
                  <motion.div
                    key="byok-panel"
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.16 }}
                    className="overflow-hidden"
                  >
                    <div className="space-y-2 rounded-xl border border-black/[0.06] bg-white/90 p-2.5 text-xs dark:border-white/[0.08] dark:bg-[#141417]">
                      <p className="font-medium text-[#111318] dark:text-[#ECECEF]">
                        消息窗口与可选自定义模型（留空使用服务端默认）
                      </p>
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label
                            htmlFor="synth-window-limit"
                            className="mb-1 block text-[10.5px] text-[#687082] dark:text-[#8E8E96]"
                          >
                            读取最近消息条数
                          </label>
                          <AppInput
                            id="synth-window-limit"
                            size="sm"
                            type="number"
                            min={3}
                            max={100}
                            value={windowLimit}
                            onChange={(e) =>
                              setWindowLimit(
                                Math.min(100, Math.max(3, Number(e.target.value) || 30)),
                              )
                            }
                          />
                        </div>
                        <div>
                          <label
                            htmlFor="synth-model"
                            className="mb-1 block text-[10.5px] text-[#687082] dark:text-[#8E8E96]"
                          >
                            自定义模型 ID
                          </label>
                          <AppInput
                            id="synth-model"
                            size="sm"
                            type="text"
                            value={byokModel}
                            onChange={(e) => setByokModel(e.target.value)}
                            placeholder="gpt-4o-mini / deepseek-chat"
                          />
                        </div>
                      </div>
                      <AppInput
                        size="sm"
                        type="url"
                        aria-label="OpenAI 兼容 Base URL"
                        value={byokBaseUrl}
                        onChange={(e) => setByokBaseUrl(e.target.value)}
                        placeholder="可选 OpenAI 兼容 Base URL"
                      />
                      <AppInput
                        size="sm"
                        type="password"
                        aria-label="BYOK API Key"
                        value={byokApiKey}
                        onChange={(e) => setByokApiKey(e.target.value)}
                        placeholder="可选临时 API Key（仅当次透传，不保存）"
                      />
                    </div>
                  </motion.div>
                ) : null}
              </AnimatePresence>

              {synthErr ? (
                <p className="rounded-xl bg-[#E5484D]/10 px-2.5 py-1.5 text-[11.5px] text-[#C81E1E] dark:bg-[#F05252]/15 dark:text-[#FCA5A5]">
                  整理失败：{synthErr}
                </p>
              ) : null}
            </div>

            {/* 手动新建结构化提案表单 */}
            <AnimatePresence initial={false}>
              {manualFormOpen ? (
                <motion.form
                  key="manual-proposal-form"
                  onSubmit={handleManualSubmit}
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  transition={{ duration: 0.16 }}
                  className={cn(SECTION_CARD_CLASS, "space-y-2.5 p-3.5")}
                >
                  <div className="flex items-center justify-between">
                    <h4 className="text-xs font-semibold text-[#111318] dark:text-[#F2F2F4]">
                      手写对比提案
                    </h4>
                    <AppButton variant="ghost" size="xs" onClick={() => setManualFormOpen(false)}>
                      收起
                    </AppButton>
                  </div>

                  <AppInput
                    size="sm"
                    type="text"
                    required={true}
                    maxLength={160}
                    aria-label="提案标题"
                    value={draftTitle}
                    onChange={(e) => setDraftTitle(e.target.value)}
                    placeholder="提案标题（例如：通知同步采用 LISTEN/NOTIFY 还是 Redis）"
                  />

                  <AppTextarea
                    rows={2}
                    required={true}
                    maxLength={2000}
                    aria-label="决策背景"
                    value={draftContext}
                    onChange={(e) => setDraftContext(e.target.value)}
                    placeholder="决策背景与关键约束…"
                    className="resize-none py-2 text-xs"
                  />

                  <div className="space-y-2">
                    {optionDrafts.map((opt, idx) => (
                      <div
                        key={opt.localId}
                        className="space-y-1.5 rounded-xl bg-white/80 p-2.5 ring-1 ring-inset ring-black/[0.05] dark:bg-white/[0.04] dark:ring-white/[0.07]"
                      >
                        <div className="flex items-center gap-1.5">
                          <AppInput
                            size="sm"
                            type="text"
                            required={true}
                            maxLength={16}
                            aria-label="方案 Key"
                            value={opt.optionKey}
                            onChange={(e) => updateOptionDraft(idx, { optionKey: e.target.value })}
                            placeholder="Key"
                            containerClassName="w-16 shrink-0"
                            className="font-mono font-semibold"
                          />
                          <AppInput
                            size="sm"
                            type="text"
                            required={true}
                            maxLength={120}
                            aria-label="方案名称"
                            value={opt.label}
                            onChange={(e) => updateOptionDraft(idx, { label: e.target.value })}
                            placeholder="方案名称"
                            containerClassName="min-w-0 flex-1"
                          />
                          {optionDrafts.length > 1 ? (
                            <IconButton
                              size="sm"
                              variant="ghost"
                              label="删除备选方案"
                              onClick={() =>
                                setOptionDrafts((prev) => prev.filter((_, i) => i !== idx))
                              }
                              className="text-[#8E96A6] hover:text-[#E5484D]"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </IconButton>
                          ) : null}
                        </div>

                        <AppInput
                          size="sm"
                          type="text"
                          required={true}
                          aria-label="方案核心思路"
                          value={opt.summary}
                          onChange={(e) => updateOptionDraft(idx, { summary: e.target.value })}
                          placeholder="一句话方案思路 *"
                        />
                        <AppInput
                          size="sm"
                          type="text"
                          aria-label="优势"
                          value={opt.prosText}
                          onChange={(e) => updateOptionDraft(idx, { prosText: e.target.value })}
                          placeholder="优势（逗号分隔）"
                        />
                        <AppInput
                          size="sm"
                          type="text"
                          aria-label="代价"
                          value={opt.consText}
                          onChange={(e) => updateOptionDraft(idx, { consText: e.target.value })}
                          placeholder="代价（逗号分隔）"
                        />
                        <AppInput
                          size="sm"
                          type="text"
                          aria-label="风险"
                          value={opt.risksText}
                          onChange={(e) => updateOptionDraft(idx, { risksText: e.target.value })}
                          placeholder="风险（逗号分隔）"
                        />
                      </div>
                    ))}
                  </div>

                  <div className="flex items-center justify-between gap-2">
                    {optionDrafts.length < 6 ? (
                      <AppButton
                        variant="ghost"
                        size="xs"
                        leadingIcon={<Plus className="h-3.5 w-3.5" />}
                        onClick={() => {
                          const nextLetter = String.fromCharCode(65 + optionDrafts.length);
                          setOptionDrafts((prev) => [
                            ...prev,
                            {
                              localId: `opt-${Date.now().toString(36)}`,
                              optionKey: nextLetter,
                              label: `方案 ${nextLetter}`,
                              summary: "",
                              prosText: "",
                              consText: "",
                              risksText: "",
                            },
                          ]);
                        }}
                      >
                        增加方案
                      </AppButton>
                    ) : (
                      <span />
                    )}

                    <div className="flex items-center gap-1.5 text-xs">
                      <label
                        htmlFor="manual-recommended-key"
                        className="text-[#687082] dark:text-[#8E8E96]"
                      >
                        推荐方案
                      </label>
                      <AppInput
                        id="manual-recommended-key"
                        size="sm"
                        type="text"
                        value={recommendedKey}
                        onChange={(e) => setRecommendedKey(e.target.value)}
                        containerClassName="w-14"
                        className="font-mono"
                      />
                    </div>
                  </div>

                  {createPropErr ? (
                    <p className="text-xs text-[#C81E1E] dark:text-[#FCA5A5]">{createPropErr}</p>
                  ) : null}

                  <AppButton
                    type="submit"
                    variant="primary"
                    size="sm"
                    fullWidth={true}
                    isLoading={props.isCreatingProposal}
                  >
                    发布提案到群聊
                  </AppButton>
                </motion.form>
              ) : null}
            </AnimatePresence>

            {/* 提案卡片列表（四态完备） */}
            {props.isLoadingProposals ? (
              <div className="space-y-3">
                {[1, 2].map((sk) => (
                  <div
                    key={`prop-sk-${String(sk)}`}
                    className="h-36 animate-pulse rounded-[18px] bg-black/[0.05] dark:bg-white/[0.05]"
                  />
                ))}
              </div>
            ) : props.isProposalsError ? (
              <div className="rounded-[18px] bg-[#E5484D]/10 p-3.5 text-xs text-[#C81E1E] dark:bg-[#F05252]/15 dark:text-[#FCA5A5]">
                <div className="flex items-center gap-1.5 font-semibold">
                  <AlertCircle className="h-4 w-4" />
                  <span>加载提案列表失败</span>
                </div>
                <AppButton
                  variant="danger"
                  size="xs"
                  leadingIcon={<RefreshCw className="h-3 w-3" />}
                  onClick={props.onRetryProposals}
                  className="mt-2"
                >
                  重新加载
                </AppButton>
              </div>
            ) : props.proposals.length === 0 ? (
              <div className={cn(SECTION_CARD_CLASS, "p-6 text-center")}>
                <FileText className="mx-auto h-5 w-5 text-[#8E96A6] dark:text-[#63636B]" />
                <p className="mt-2 text-[13px] font-medium text-[#111318] dark:text-[#F2F2F4]">
                  还没有提案
                </p>
                <p className="mt-1 text-[12px] leading-relaxed text-[#687082] dark:text-[#8E8E96]">
                  等群里的讨论差不多有了眉目，点击上方「整理近期讨论为提案」对比优劣再拍板。
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                {props.proposals.map((proposal) => (
                  <ProposalCardView
                    key={proposal.id}
                    proposal={proposal}
                    interactive={true}
                    highlighted={props.focusedProposalId === proposal.id}
                    isSubmittingVote={props.isSubmittingVote}
                    isSubmittingDecision={props.isSubmittingDecision}
                    onCastVote={props.onCastVote}
                    onDecide={props.onDecideProposal}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}
