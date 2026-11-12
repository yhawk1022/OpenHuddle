/**
 * @module web/features/huddle-room/room-inspector
 * @description Pachat 极简中性群信息与共识提案抽屉（`#141414` 墨黑 + `#F5F5F7` 暖灰纸感面板）：
 * 顶部 `68px` 标题栏与聊天头对齐，通过 `SegmentedTabs` 在「成员」与「提案」间切换；
 * 成员页按人类主理人树形分组展示个人 Agent（在线状态、平台微标签、一键 `@` 点名）、邀请码分享及折叠治理开关；
 * 提案页承载讨论提炼、手动多方案表单与人类拍板闭环。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 权威归属展示：每个 Agent 严格挂在服务端盖章的 `ownerUserId` 主理人名下展示，绝不依据昵称猜测归属；点击 Agent 打开完整名片。
 * 2. 零原生粗糙控件与零紫色污染：全文件仅使用 Radix `AppSelect`、`AppSwitch`、`SegmentedTabs`、`AppInput` 与 `AppTextarea`，彻底剔除 `#seq` 序号与廉价 AI 图标。
 * 3. 人机决策闭环：支持一键调用服务端主持人模型或当次透传 BYOK 密钥（前端不落盘）整理多方案对比卡，由人类最终拍板。
 */
import {
  type CastProposalVoteBody,
  type DecideProposalBody,
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
  Plus,
  RefreshCw,
  Settings2,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { type FormEvent, useMemo, useState } from "react";
import {
  AnimatePresence,
  AppButton,
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
 * 渲染右侧 Pachat 极简群信息与提案抽屉。
 *
 * @param props - 房间详情、实时治理快照、提案列表与全部治理/决策动作回调
 * @returns 右侧群信息抽屉视图
 */
export function RoomInspector(props: RoomInspectorProps) {
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
        label: "成员",
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
    [openProposalsCount, props.proposals.length, props.room.members.length],
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
      platform: member.platform ?? "custom",
      ownerUserId: member.ownerUserId,
      ownerDisplayName: member.ownerDisplayName,
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
    <aside className="flex h-full min-h-0 w-full flex-1 shrink-0 flex-col border-l border-black/[0.06] bg-white xl:w-[360px] xl:flex-none dark:border-white/[0.06] dark:bg-[#0E0E10]">
      {/* 1. 68px 抽屉顶栏（对齐聊天头高度，兼容 Tauri v2 + Electron 拖拽） */}
      <div
        data-tauri-drag-region=""
        className="app-drag-region flex h-[68px] shrink-0 select-none items-center justify-between gap-2 border-b border-black/[0.06] px-4 dark:border-white/[0.06]"
      >
        <div className="min-w-0">
          <p className="text-[15px] font-semibold tracking-[-0.01em] text-[#141414] dark:text-zinc-100">
            群信息
          </p>
          <p className="mt-0.5 truncate text-[12px] text-[#6E6E73] dark:text-zinc-400">
            {props.room.name}
          </p>
        </div>
        <AppTooltip side="bottom" content="收起面板">
          <IconButton size="md" variant="ghost" label="收起群信息面板" onClick={props.onClose}>
            <X className="h-4 w-4" />
          </IconButton>
        </AppTooltip>
      </div>

      {/* 2. 弹簧滑块分段导航：成员 ⇄ 提案 */}
      <div className="shrink-0 select-none px-4 pt-3 pb-2">
        <SegmentedTabs
          value={props.activeTab}
          onValueChange={props.onChangeTab}
          items={inspectorTabs}
          size="sm"
          fullWidth={true}
          ariaLabel="群信息分栏"
        />
      </div>

      {/* 3. 主体滚动内容区 */}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pt-1 pb-[max(1rem,env(safe-area-inset-bottom))]">
        {props.activeTab === "members" ? (
          <div className="space-y-4">
            {/* 3.1 群成员与挂载的 Agent */}
            <section className="space-y-2.5">
              <div className="flex select-none items-center justify-between px-0.5">
                <h3 className="text-[12px] font-medium text-[#6E6E73] dark:text-zinc-400">
                  {onlineAgentCount}/{agentMembers.length} 个 Agent 在线
                </h3>
                <AppButton
                  variant="soft"
                  size="xs"
                  leadingIcon={<Plus className="h-3 w-3" />}
                  onClick={props.onOpenAddAgentModal}
                >
                  邀请 / 接入 agent
                </AppButton>
              </div>

              {agentMembers.length === 0 ? (
                <button
                  type="button"
                  onClick={props.onOpenAddAgentModal}
                  className="im-press flex w-full cursor-pointer flex-col items-center gap-1 rounded-2xl border border-dashed border-black/20 bg-[#F8F8FA] p-4 text-center transition hover:border-[#141414] hover:bg-[#F5F5F7] dark:border-white/20 dark:bg-[#151518] dark:hover:border-white/40 dark:hover:bg-[#1C1C1F]"
                >
                  <Plus className="h-5 w-5 text-[#141414] dark:text-zinc-200" />
                  <span className="text-[13px] font-medium text-[#141414] dark:text-zinc-100">
                    把你的第一个 Agent 拉进群
                  </span>
                  <span className="text-[11.5px] text-[#6E6E73] dark:text-zinc-400">
                    支持 Claude Code、Codex、Cursor、Antigravity、DeepSeek
                  </span>
                </button>
              ) : null}

              <div className="space-y-2">
                {teamGroups.map((group) => (
                  <div
                    key={`team-${group.ownerUserId}`}
                    className="rounded-2xl bg-[#F5F5F7] p-2 dark:bg-[#18181B]"
                  >
                    {/* 主理人头行 */}
                    <div className="flex items-center justify-between gap-2 px-1.5 py-1">
                      <div className="flex min-w-0 items-center gap-2.5">
                        <PlatformAvatar
                          kind="human"
                          displayName={group.ownerDisplayName}
                          size="sm"
                          className="[&>div]:rounded-full"
                        />
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5">
                            <p className="truncate text-[13px] font-semibold text-[#141414] dark:text-zinc-100">
                              {group.ownerDisplayName}
                            </p>
                            {group.human ? (
                              <span className="shrink-0 rounded-full bg-black/[0.05] px-2 py-0.5 text-[10px] font-medium text-[#5F5F64] dark:bg-white/[0.08] dark:text-zinc-300">
                                {roleLabel(group.human.role)}
                              </span>
                            ) : null}
                          </div>
                          <p className="mt-0.5 text-[11px] text-[#6E6E73] dark:text-zinc-400">
                            {group.human ? "群成员" : "未以本人账号进群"}
                            {group.agents.length > 0
                              ? ` · 接入 ${String(group.agents.length)} 个 Agent`
                              : ""}
                          </p>
                        </div>
                      </div>

                      {group.human?.userId !== undefined && group.human !== null
                        ? (() => {
                            const humanUserId = group.human.userId;
                            const humanName = group.human.displayName;
                            return (
                              <AppTooltip side="left" content={`在输入框 @${humanName}`}>
                                <IconButton
                                  size="sm"
                                  variant="ghost"
                                  label={`点名 @${humanName}`}
                                  onClick={() =>
                                    props.onQuickMention({
                                      kind: "human",
                                      userId: humanUserId,
                                      displayName: humanName,
                                    })
                                  }
                                >
                                  <AtSign className="h-3.5 w-3.5" />
                                </IconButton>
                              </AppTooltip>
                            );
                          })()
                        : null}
                    </div>

                    {/* 名下个人 Agent 列表 */}
                    {group.agents.length > 0 ? (
                      <ul className="mt-1.5 ml-3.5 space-y-1 border-l border-black/[0.08] pl-2.5 dark:border-white/[0.1]">
                        {group.agents.map((agent) => {
                          const reachMeta = getReachVisualMeta(agent.reach);
                          const agentId = agent.agentId;
                          return (
                            <li
                              key={`mem-agt-${agent.agentId ?? agent.displayName}`}
                              className="group flex items-center justify-between gap-1.5 rounded-xl bg-white px-2.5 py-1.5 transition hover:bg-white/90 dark:bg-[#202024] dark:hover:bg-[#27272C]"
                            >
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
                                    <span className="truncate text-[12.5px] font-semibold text-[#141414] dark:text-zinc-100">
                                      {agent.displayName}
                                    </span>
                                    {agent.platform ? (
                                      <PlatformTagPill platform={agent.platform} compact={true} />
                                    ) : null}
                                  </span>
                                  <span
                                    title={reachMeta.description}
                                    className="mt-0.5 flex items-center gap-1 text-[11px] text-[#6E6E73] dark:text-zinc-400"
                                  >
                                    <span
                                      className={cn("h-1.5 w-1.5 rounded-full", reachMeta.dotClass)}
                                    />
                                    <span>{reachMeta.shortLabel}</span>
                                  </span>
                                </span>
                              </button>

                              {agentId !== undefined ? (
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
                          );
                        })}
                      </ul>
                    ) : null}
                  </div>
                ))}
              </div>
            </section>

            {/* 3.2 邀请码与公开只读回放分享 */}
            <section className="space-y-2.5 rounded-2xl bg-[#F5F5F7] p-3.5 dark:bg-[#18181B]">
              <div className="flex items-center justify-between gap-2 text-xs">
                <div className="flex items-center gap-1.5 font-semibold text-[#141414] dark:text-zinc-100">
                  {props.room.visibility === "public_shareable" ? (
                    <Globe className="h-3.5 w-3.5 text-[#34C759]" />
                  ) : (
                    <Lock className="h-3.5 w-3.5 text-[#8E8E93]" />
                  )}
                  <span>邀请与公开分享</span>
                </div>

                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-[#6E6E73] dark:text-zinc-400">
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
                  <code className="min-w-0 flex-1 truncate rounded-xl border border-black/[0.08] bg-white px-2.5 py-1.5 font-mono text-[11.5px] text-[#141414] dark:border-white/[0.1] dark:bg-[#121215] dark:text-zinc-200">
                    {props.room.inviteToken}
                  </code>
                  <AppButton
                    variant="secondary"
                    size="sm"
                    leadingIcon={
                      copiedKey === "inv" ? (
                        <Check className="h-3.5 w-3.5 text-[#34C759]" />
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

            {/* 3.3 可折叠「群设置与讨论规则」（全套 Radix 原语，零原生下拉框） */}
            <section className="overflow-hidden rounded-2xl bg-[#F5F5F7] dark:bg-[#18181B]">
              <button
                type="button"
                onClick={() => setSettingsOpen((prev) => !prev)}
                aria-expanded={settingsOpen}
                className="flex w-full cursor-pointer select-none items-center justify-between px-3.5 py-3 text-xs font-semibold text-[#141414] transition hover:bg-black/[0.03] dark:text-zinc-100 dark:hover:bg-white/[0.04]"
              >
                <span className="inline-flex items-center gap-1.5">
                  <Settings2 className="h-3.5 w-3.5 text-[#6E6E73] dark:text-zinc-400" />
                  <span>群设置与讨论规则</span>
                </span>
                <ChevronDown
                  className={cn(
                    "h-3.5 w-3.5 text-[#6E6E73] transition-transform duration-200 dark:text-zinc-400",
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
                    className="overflow-hidden border-t border-black/[0.06] dark:border-white/[0.06]"
                  >
                    <div className="space-y-3.5 p-3.5 text-xs">
                      <div>
                        <p className="mb-1.5 text-[11.5px] font-medium text-[#6E6E73] dark:text-zinc-400">
                          讨论节奏
                        </p>
                        <SegmentedTabs
                          value={config.mode}
                          onValueChange={(nextMode) => {
                            if (nextMode !== config.mode && !props.isUpdatingGovernance) {
                              const label =
                                MODE_OPTIONS.find((m) => m.value === nextMode)?.label ?? nextMode;
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

                      <div className="flex items-center justify-between gap-3">
                        <label
                          htmlFor="insp-turn-cap"
                          className="font-medium text-[#141414] dark:text-zinc-200"
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

                      <div className="flex items-center justify-between gap-3">
                        <label
                          htmlFor="insp-switch-mentions"
                          className="min-w-0 flex-1 cursor-pointer"
                        >
                          <span className="block font-medium text-[#141414] dark:text-zinc-200">
                            Agent 互相 @ 唤醒
                          </span>
                          <span className="block text-[11px] text-[#6E6E73] dark:text-zinc-400">
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

                      <div className="flex items-center justify-between gap-3">
                        <label
                          htmlFor="insp-switch-readlock"
                          className="min-w-0 flex-1 cursor-pointer"
                        >
                          <span className="block font-medium text-[#141414] dark:text-zinc-200">
                            先读后发保护
                          </span>
                          <span className="block text-[11px] text-[#6E6E73] dark:text-zinc-400">
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
                        <div className="rounded-xl bg-white p-2.5 dark:bg-[#121215]">
                          <p className="mb-1 text-[11px] font-medium text-[#6E6E73] dark:text-zinc-400">
                            群约定
                          </p>
                          <p className="whitespace-pre-wrap text-xs leading-relaxed text-[#3A3A3C] dark:text-zinc-300">
                            {props.room.rules}
                          </p>
                        </div>
                      ) : null}
                    </div>
                  </motion.div>
                ) : null}
              </AnimatePresence>
            </section>
          </div>
        ) : (
          /* Tab 2: 结构化共识提案与人类拍板闭环 */
          <div className="space-y-3.5">
            {/* 自动整理 + BYOK + 手动新建 */}
            <div className="space-y-2.5 rounded-2xl bg-[#F5F5F7] p-3 dark:bg-[#18181B]">
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
                    <div className="space-y-2 rounded-xl border border-black/[0.07] bg-white p-2.5 text-xs dark:border-white/[0.08] dark:bg-[#121215]">
                      <p className="font-medium text-[#141414] dark:text-zinc-200">
                        消息窗口与可选自定义模型（留空使用服务端默认）
                      </p>
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label
                            htmlFor="synth-window-limit"
                            className="mb-1 block text-[10.5px] text-[#6E6E73] dark:text-zinc-400"
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
                            className="mb-1 block text-[10.5px] text-[#6E6E73] dark:text-zinc-400"
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
                <p className="rounded-xl bg-[#FF3B30]/10 px-2.5 py-1.5 text-[11.5px] text-[#D70015] dark:bg-[#FF453A]/15 dark:text-[#FF6961]">
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
                  className="space-y-2.5 rounded-2xl border border-black/[0.08] bg-white p-3.5 dark:border-white/[0.1] dark:bg-[#151518]"
                >
                  <div className="flex items-center justify-between">
                    <h4 className="text-xs font-semibold text-[#141414] dark:text-zinc-100">
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
                        className="space-y-1.5 rounded-xl bg-[#F5F5F7] p-2.5 dark:bg-[#1C1C1F]"
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
                              className="text-[#8E8E93] hover:text-[#FF3B30]"
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
                        className="text-[#6E6E73] dark:text-zinc-400"
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
                    <p className="text-xs text-[#D70015] dark:text-[#FF6961]">{createPropErr}</p>
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
                    className="h-36 animate-pulse rounded-2xl bg-[#F5F5F7] dark:bg-white/[0.05]"
                  />
                ))}
              </div>
            ) : props.isProposalsError ? (
              <div className="rounded-2xl bg-[#FF3B30]/10 p-3.5 text-xs text-[#D70015] dark:bg-[#FF453A]/15 dark:text-[#FF6961]">
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
              <div className="rounded-2xl bg-[#F8F8FA] p-6 text-center dark:bg-[#151518]">
                <FileText className="mx-auto h-5 w-5 text-[#8E8E93] dark:text-zinc-500" />
                <p className="mt-2 text-[13px] font-medium text-[#141414] dark:text-zinc-100">
                  还没有提案
                </p>
                <p className="mt-1 text-[12px] leading-relaxed text-[#6E6E73] dark:text-zinc-400">
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
