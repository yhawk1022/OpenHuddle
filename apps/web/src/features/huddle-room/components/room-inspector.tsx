/**
 * @module web/features/huddle-room/room-inspector
 * @description 三栏工作台右侧双标签督导面板（Tab 1: 群成员在线可达性 LED 与分享邀请；Tab 2: AI 自动提炼提案、手动提案器与人类拍板卡）。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 透明血统与状态：每个 Agent 成员显式标注 `Owner: <主人昵称>` 与实时 `reach` LED，点击任意 Agent 打开完整身份名片。
 * 2. AI + 人类决策闭环：支持一键调用服务端主持人模型（或自定义 BYOK 密钥）将杂乱辩论提炼为结构化多方案对比卡，并由人类裁判最终拍板固化。
 */
import type {
  CastProposalVoteBody,
  DecideProposalBody,
  MessageMention,
  ProposalCardDto,
  ProposalDraft,
  ProposalId,
  ProposalOption,
  RoomDetailDto,
  RoomMemberDto,
  UpdateGovernanceBody,
} from "@openhuddle/protocol";
import {
  AlertCircle,
  AtSign,
  Bot,
  Check,
  Copy,
  ExternalLink,
  FilePlus2,
  Globe,
  Loader2,
  Lock,
  Plus,
  RefreshCw,
  Settings2,
  Sparkles,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { type FormEvent, useState } from "react";
import type { InspectedAgentProfile } from "../../../components/ui/agent-profile-dialog.js";
import {
  PlatformAvatar,
  PlatformTagPill,
  ReachStatusBadge,
} from "../../../components/ui/identity-badges.js";
import { ProposalCardView } from "../../../components/ui/proposal-card-view.js";
import { ApiClientError, type SynthesizeProposalInput } from "../../../lib/api-client.js";

/** 右侧督导面板标签页枚举 */
export type InspectorTab = "members" | "proposals";

interface EditableOptionDraft {
  readonly localId: string;
  readonly optionKey: string;
  readonly label: string;
  readonly summary: string;
  readonly prosText: string;
  readonly consText: string;
  readonly risksText: string;
}

/** `RoomInspector` 入参属性 */
export interface RoomInspectorProps {
  readonly room: RoomDetailDto;
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
  readonly onCloseMobileInspector?: (() => void) | undefined;
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
      label: "方案 A（稳健演进）",
      summary: "",
      prosText: "",
      consText: "",
      risksText: "",
    },
    {
      localId: "opt-init-b",
      optionKey: "B",
      label: "方案 B（激进重构）",
      summary: "",
      prosText: "",
      consText: "",
      risksText: "",
    },
  ];
}

/**
 * 渲染右侧「成员与分享」及「提案与人类拍板」双标签面板。
 *
 * @param props - 房间详情、提案列表与全部治理/决策动作回调
 * @returns 右侧督导栏视图
 */
export function RoomInspector(props: RoomInspectorProps) {
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  // AI 自动提炼 BYOK 高级配置抽屉状态
  const [byokOpen, setByokOpen] = useState<boolean>(false);
  const [windowLimit, setWindowLimit] = useState<number>(30);
  const [byokModel, setByokModel] = useState<string>("");
  const [byokBaseUrl, setByokBaseUrl] = useState<string>("");
  const [byokApiKey, setByokApiKey] = useState<string>("");

  // 手动发起结构化提案表单状态
  const [manualFormOpen, setManualFormOpen] = useState<boolean>(false);
  const [draftTitle, setDraftTitle] = useState<string>("");
  const [draftContext, setDraftContext] = useState<string>("");
  const [recommendedKey, setRecommendedKey] = useState<string>("A");
  const [optionDrafts, setOptionDrafts] =
    useState<ReadonlyArray<EditableOptionDraft>>(createInitialOptions);

  const humans = props.room.members.filter((m) => m.memberKind === "human");
  const agents = props.room.members.filter((m) => m.memberKind === "agent");
  const openProposalsCount = props.proposals.filter((p) => p.status === "open").length;

  const shareUrl =
    props.room.inviteToken !== undefined && typeof window !== "undefined"
      ? `${window.location.origin}/share/${encodeURIComponent(props.room.inviteToken)}`
      : null;

  const copyText = (key: string, value: string): void => {
    if (typeof navigator === "undefined" || !navigator.clipboard) {
      return;
    }
    void navigator.clipboard.writeText(value).then(() => {
      setCopiedKey(key);
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
    <aside className="flex h-full w-88 shrink-0 flex-col border-l border-slate-200/85 bg-slate-50/80 sm:w-96 dark:border-white/[0.07] dark:bg-[#0c0f17]">
      {/* 顶部双 Tab 切换头 */}
      <div className="flex items-center justify-between gap-2 border-b border-slate-200/80 px-3.5 py-3 dark:border-white/[0.07]">
        <div className="grid flex-1 grid-cols-2 gap-1 rounded-xl border border-slate-200/80 bg-slate-200/50 p-0.5 dark:border-white/[0.07] dark:bg-white/[0.04]">
          <button
            type="button"
            onClick={() => props.onChangeTab("members")}
            className={`inline-flex items-center justify-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold transition ${
              props.activeTab === "members"
                ? "bg-white text-slate-900 shadow-2xs dark:bg-indigo-600 dark:text-white"
                : "text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white"
            }`}
          >
            <Users className="h-3.5 w-3.5" />
            <span>成员 ({props.room.members.length})</span>
          </button>

          <button
            type="button"
            onClick={() => props.onChangeTab("proposals")}
            className={`inline-flex items-center justify-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold transition ${
              props.activeTab === "proposals"
                ? "bg-white text-slate-900 shadow-2xs dark:bg-indigo-600 dark:text-white"
                : "text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white"
            }`}
          >
            <Sparkles className="h-3.5 w-3.5" />
            <span>提案与拍板</span>
            {openProposalsCount > 0 ? (
              <span className="rounded-full bg-amber-500 px-1.5 py-0.2 text-[10px] font-bold text-slate-950">
                {openProposalsCount}
              </span>
            ) : (
              <span className="opacity-70">({props.proposals.length})</span>
            )}
          </button>
        </div>

        {props.onCloseMobileInspector ? (
          <button
            type="button"
            onClick={props.onCloseMobileInspector}
            aria-label="关闭右侧面板"
            className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-200/70 xl:hidden dark:text-slate-400 dark:hover:bg-white/10"
          >
            <X className="h-4 w-4" />
          </button>
        ) : null}
      </div>

      {/* 主体滚动区 */}
      <div className="flex-1 overflow-y-auto p-3.5">
        {props.activeTab === "members" ? (
          <div className="space-y-5">
            {/* 1. 房间邀请码与一键公开分享链接卡片 */}
            <section className="space-y-2.5 rounded-2xl border border-slate-200/85 bg-white p-3.5 shadow-2xs dark:border-white/[0.08] dark:bg-[#111520]">
              <div className="flex items-center justify-between text-xs">
                <span className="font-semibold text-slate-800 dark:text-slate-200">
                  协作邀请与公开回放页
                </span>
                <button
                  type="button"
                  onClick={() =>
                    props.onUpdateGovernance({
                      visibility:
                        props.room.visibility === "public_shareable"
                          ? "invite_only"
                          : "public_shareable",
                    })
                  }
                  className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10.5px] font-semibold transition ${
                    props.room.visibility === "public_shareable"
                      ? "border-emerald-500/35 bg-emerald-500/12 text-emerald-700 dark:text-emerald-300"
                      : "border-slate-200 bg-slate-100 text-slate-600 dark:border-white/10 dark:bg-white/[0.05] dark:text-slate-400"
                  }`}
                >
                  {props.room.visibility === "public_shareable" ? (
                    <>
                      <Globe className="h-3 w-3" />
                      <span>公开回放：开</span>
                    </>
                  ) : (
                    <>
                      <Lock className="h-3 w-3" />
                      <span>仅受邀可见</span>
                    </>
                  )}
                </button>
              </div>

              {props.room.inviteToken ? (
                <div className="flex items-center gap-1.5">
                  <code className="min-w-0 flex-1 truncate rounded-lg border border-slate-200/80 bg-slate-50 px-2.5 py-1.5 font-mono text-[11px] text-slate-700 dark:border-white/10 dark:bg-[#090c13] dark:text-slate-300">
                    {props.room.inviteToken}
                  </code>
                  <button
                    type="button"
                    onClick={() => copyText("inv", props.room.inviteToken ?? "")}
                    className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1.5 text-[11px] font-medium text-slate-700 hover:bg-slate-100 dark:border-white/10 dark:text-slate-200 dark:hover:bg-white/10"
                  >
                    {copiedKey === "inv" ? (
                      <>
                        <Check className="h-3 w-3 text-emerald-500" />
                        <span>已复制</span>
                      </>
                    ) : (
                      <>
                        <Copy className="h-3 w-3" />
                        <span>邀请码</span>
                      </>
                    )}
                  </button>
                </div>
              ) : null}

              {props.room.visibility === "public_shareable" && shareUrl !== null ? (
                <div className="flex items-center gap-1.5 pt-0.5">
                  <button
                    type="button"
                    onClick={() => copyText("share", shareUrl)}
                    className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-emerald-500"
                  >
                    {copiedKey === "share" ? (
                      <>
                        <Check className="h-3.5 w-3.5" />
                        <span>已复制 /share 公开回放链接</span>
                      </>
                    ) : (
                      <>
                        <Copy className="h-3.5 w-3.5" />
                        <span>复制公开只读回放链接</span>
                      </>
                    )}
                  </button>
                  <a
                    href={shareUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label="在新标签页打开公开回放页"
                    className="inline-flex items-center justify-center rounded-xl border border-slate-200 p-1.5 text-slate-600 hover:bg-slate-100 dark:border-white/10 dark:text-slate-300 dark:hover:bg-white/10"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                </div>
              ) : null}
            </section>

            {/* 2. 个人 Agent 与托管模型列表（支持点击打开身份名片） */}
            <section className="space-y-2">
              <div className="flex items-center justify-between px-1">
                <h3 className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                  Personal &amp; Hosted Agents ({agents.length})
                </h3>
                <button
                  type="button"
                  onClick={props.onOpenAddAgentModal}
                  className="text-[11px] font-semibold text-indigo-600 hover:text-indigo-500 dark:text-indigo-400"
                >
                  + 配对拉入新 Agent
                </button>
              </div>

              {agents.length === 0 ? (
                <button
                  type="button"
                  onClick={props.onOpenAddAgentModal}
                  className="flex w-full flex-col items-center gap-1.5 rounded-2xl border border-dashed border-indigo-500/35 bg-indigo-500/[0.04] p-4 text-center transition hover:bg-indigo-500/[0.09]"
                >
                  <Bot className="h-5 w-5 text-indigo-500" />
                  <span className="text-xs font-semibold text-indigo-700 dark:text-indigo-300">
                    点击 10 秒拉入你的第一个个人 Agent
                  </span>
                  <span className="text-[11px] text-slate-500 dark:text-slate-400">
                    支持 Antigravity / Codex / Claude Code / Cursor / DeepSeek
                  </span>
                </button>
              ) : (
                <div className="space-y-2">
                  {agents.map((agent) => (
                    <div
                      key={`mem-agt-${agent.agentId ?? agent.displayName}`}
                      className="flex items-center justify-between gap-2 rounded-xl border border-slate-200/80 bg-white p-2.5 shadow-2xs transition hover:border-indigo-500/35 dark:border-white/[0.07] dark:bg-[#111520]"
                    >
                      <button
                        type="button"
                        onClick={() => handleInspectMemberAgent(agent)}
                        className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                      >
                        <PlatformAvatar
                          kind="agent"
                          displayName={agent.displayName}
                          platform={agent.platform}
                          reach={agent.reach}
                          size="sm"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="truncate text-xs font-semibold text-slate-900 dark:text-white">
                              {agent.displayName}
                            </span>
                            {agent.platform ? <PlatformTagPill platform={agent.platform} /> : null}
                          </div>
                          <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[10.5px] text-slate-500 dark:text-slate-400">
                            <span>Owner: {agent.ownerDisplayName}</span>
                            <span>·</span>
                            <span>已读 #{agent.lastReadSeq}</span>
                          </div>
                        </div>
                      </button>

                      <div className="flex shrink-0 items-center gap-1">
                        <ReachStatusBadge reach={agent.reach} compact={true} />
                        {agent.agentId !== undefined
                          ? (() => {
                              const agtId = agent.agentId;
                              return (
                                <button
                                  type="button"
                                  onClick={() =>
                                    props.onQuickMention({
                                      kind: "agent",
                                      agentId: agtId,
                                      displayName: agent.displayName,
                                    })
                                  }
                                  title={`@${agent.displayName}`}
                                  className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-indigo-600 dark:hover:bg-white/10 dark:hover:text-indigo-400"
                                >
                                  <AtSign className="h-3.5 w-3.5" />
                                </button>
                              );
                            })()
                          : null}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>

            {/* 3. 人类主理人列表 */}
            <section className="space-y-2">
              <h3 className="px-1 text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                Human Participants ({humans.length})
              </h3>
              <div className="space-y-1.5">
                {humans.map((human) => (
                  <div
                    key={`mem-usr-${human.userId ?? human.displayName}`}
                    className="flex items-center justify-between gap-2 rounded-xl border border-slate-200/80 bg-white px-3 py-2 dark:border-white/[0.07] dark:bg-[#111520]"
                  >
                    <div className="flex min-w-0 items-center gap-2.5">
                      <PlatformAvatar kind="human" displayName={human.displayName} size="sm" />
                      <div className="min-w-0">
                        <p className="truncate text-xs font-semibold text-slate-900 dark:text-white">
                          {human.displayName}
                        </p>
                        <p className="font-mono text-[10.5px] text-slate-400">
                          已读 #{human.lastReadSeq}
                        </p>
                      </div>
                    </div>
                    <span className="rounded-md bg-emerald-500/12 px-2 py-0.5 text-[10px] font-bold uppercase text-emerald-700 dark:text-emerald-300">
                      {human.role}
                    </span>
                  </div>
                ))}
              </div>
            </section>

            {/* 4. 房间讨论群规展示 */}
            {props.room.rules.trim().length > 0 ? (
              <section className="space-y-1.5 rounded-2xl border border-slate-200/80 bg-white p-3.5 dark:border-white/[0.07] dark:bg-[#111520]">
                <h3 className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                  房间讨论公约 (Room Rules)
                </h3>
                <p className="whitespace-pre-wrap text-xs leading-relaxed text-slate-600 dark:text-slate-300">
                  {props.room.rules}
                </p>
              </section>
            ) : null}
          </div>
        ) : (
          /* Tab 2: 结构化提案与人类拍板区 */
          <div className="space-y-4">
            {/* 顶部一键 AI 提炼提案 + BYOK 设置 + 手动新建按钮栏 */}
            <div className="space-y-2.5 rounded-2xl border border-indigo-500/25 bg-indigo-500/[0.06] p-3.5">
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  disabled={props.isSynthesizing}
                  onClick={handleSynthesizeClick}
                  className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-gradient-to-r from-indigo-600 to-violet-600 px-3 py-2 text-xs font-semibold text-white shadow-xs transition hover:from-indigo-500 hover:to-violet-500 disabled:opacity-55"
                >
                  {props.isSynthesizing ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      <span>AI 正在提炼多方分歧...</span>
                    </>
                  ) : (
                    <>
                      <Sparkles className="h-3.5 w-3.5" />
                      <span>✨ AI 自动提炼提案卡</span>
                    </>
                  )}
                </button>

                <button
                  type="button"
                  onClick={() => setByokOpen((prev) => !prev)}
                  title="配置消息窗口或自定义 BYOK 模型密钥"
                  className={`rounded-xl border p-2 transition ${
                    byokOpen
                      ? "border-indigo-500 bg-indigo-500/15 text-indigo-700 dark:text-indigo-300"
                      : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50 dark:border-white/10 dark:bg-white/[0.06] dark:text-slate-300"
                  }`}
                >
                  <Settings2 className="h-3.5 w-3.5" />
                </button>

                <button
                  type="button"
                  onClick={() => setManualFormOpen((prev) => !prev)}
                  title="手动编写结构化提案"
                  className={`inline-flex items-center gap-1 rounded-xl border px-2.5 py-2 text-xs font-semibold transition ${
                    manualFormOpen
                      ? "border-indigo-500 bg-indigo-500/15 text-indigo-700 dark:text-indigo-300"
                      : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50 dark:border-white/10 dark:bg-white/[0.06] dark:text-slate-200"
                  }`}
                >
                  <FilePlus2 className="h-3.5 w-3.5" />
                  <span>手动</span>
                </button>
              </div>

              {/* 可选 BYOK 提炼参数抽屉 */}
              {byokOpen ? (
                <div className="space-y-2 rounded-xl border border-slate-200/80 bg-white p-3 text-xs dark:border-white/10 dark:bg-[#0a0d14]">
                  <p className="font-semibold text-slate-700 dark:text-slate-200">
                    主持人提炼窗口与可选 BYOK 覆盖（留空则使用服务端默认配置）
                  </p>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label
                        htmlFor="synth-window-limit"
                        className="block text-[10.5px] text-slate-500"
                      >
                        读取最近消息条数
                      </label>
                      <input
                        id="synth-window-limit"
                        type="number"
                        min={3}
                        max={100}
                        value={windowLimit}
                        onChange={(e) =>
                          setWindowLimit(Math.min(100, Math.max(3, Number(e.target.value) || 30)))
                        }
                        className="mt-1 w-full rounded-lg border border-slate-200 bg-slate-50 px-2 py-1 text-xs dark:border-white/10 dark:bg-white/[0.04]"
                      />
                    </div>
                    <div>
                      <label htmlFor="synth-model" className="block text-[10.5px] text-slate-500">
                        自定义模型 ID
                      </label>
                      <input
                        id="synth-model"
                        type="text"
                        value={byokModel}
                        onChange={(e) => setByokModel(e.target.value)}
                        placeholder="gpt-4o-mini / deepseek-chat"
                        className="mt-1 w-full rounded-lg border border-slate-200 bg-slate-50 px-2 py-1 text-xs dark:border-white/10 dark:bg-white/[0.04]"
                      />
                    </div>
                  </div>
                  <input
                    type="url"
                    value={byokBaseUrl}
                    onChange={(e) => setByokBaseUrl(e.target.value)}
                    placeholder="可选 OpenAI 兼容 Base URL (https://api.openai.com/v1)"
                    className="w-full rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs dark:border-white/10 dark:bg-white/[0.04]"
                  />
                  <input
                    type="password"
                    value={byokApiKey}
                    onChange={(e) => setByokApiKey(e.target.value)}
                    placeholder="可选 BYOK API Key（仅当次请求透传，前端不落盘）"
                    className="w-full rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs dark:border-white/10 dark:bg-white/[0.04]"
                  />
                </div>
              ) : null}

              {synthErr ? (
                <p className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-2.5 py-1.5 text-[11px] text-rose-700 dark:text-rose-300">
                  AI 提炼失败：{synthErr}
                </p>
              ) : null}
            </div>

            {/* 手动新建结构化提案表单 */}
            {manualFormOpen ? (
              <form
                onSubmit={handleManualSubmit}
                className="space-y-3 rounded-2xl border border-slate-200 bg-white p-3.5 shadow-sm dark:border-white/12 dark:bg-[#111520]"
              >
                <div className="flex items-center justify-between">
                  <h4 className="text-xs font-bold text-slate-900 dark:text-white">
                    新建结构化多方案对比提案
                  </h4>
                  <button
                    type="button"
                    onClick={() => setManualFormOpen(false)}
                    className="text-xs text-slate-400 hover:text-slate-700 dark:hover:text-white"
                  >
                    收起
                  </button>
                </div>

                <input
                  type="text"
                  required={true}
                  maxLength={160}
                  value={draftTitle}
                  onChange={(e) => setDraftTitle(e.target.value)}
                  placeholder="提案标题（例如：实时总线选型：Postgres LISTEN/NOTIFY vs Redis）"
                  className="w-full rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs dark:border-white/10 dark:bg-[#090c13]"
                />

                <textarea
                  rows={2}
                  required={true}
                  maxLength={2000}
                  value={draftContext}
                  onChange={(e) => setDraftContext(e.target.value)}
                  placeholder="决策背景与核心约束摘要..."
                  className="w-full rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs dark:border-white/10 dark:bg-[#090c13]"
                />

                <div className="space-y-2.5">
                  {optionDrafts.map((opt, idx) => (
                    <div
                      key={opt.localId}
                      className="space-y-1.5 rounded-xl border border-slate-200/80 bg-slate-50/70 p-2.5 dark:border-white/[0.07] dark:bg-white/[0.02]"
                    >
                      <div className="flex items-center gap-1.5">
                        <input
                          type="text"
                          required={true}
                          maxLength={16}
                          value={opt.optionKey}
                          onChange={(e) =>
                            setOptionDrafts((prev) =>
                              prev.map((item, i) =>
                                i === idx ? { ...item, optionKey: e.target.value } : item,
                              ),
                            )
                          }
                          placeholder="Key"
                          className="w-14 rounded border border-slate-200 bg-white px-2 py-1 font-mono text-xs font-bold dark:border-white/10 dark:bg-[#090c13]"
                        />
                        <input
                          type="text"
                          required={true}
                          maxLength={120}
                          value={opt.label}
                          onChange={(e) =>
                            setOptionDrafts((prev) =>
                              prev.map((item, i) =>
                                i === idx ? { ...item, label: e.target.value } : item,
                              ),
                            )
                          }
                          placeholder="方案名称"
                          className="flex-1 rounded border border-slate-200 bg-white px-2 py-1 text-xs dark:border-white/10 dark:bg-[#090c13]"
                        />
                        {optionDrafts.length > 1 ? (
                          <button
                            type="button"
                            onClick={() =>
                              setOptionDrafts((prev) => prev.filter((_, i) => i !== idx))
                            }
                            aria-label="删除备选方案"
                            className="p-1 text-slate-400 hover:text-rose-500"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        ) : null}
                      </div>

                      <input
                        type="text"
                        required={true}
                        value={opt.summary}
                        onChange={(e) =>
                          setOptionDrafts((prev) =>
                            prev.map((item, i) =>
                              i === idx ? { ...item, summary: e.target.value } : item,
                            ),
                          )
                        }
                        placeholder="一句话方案核心思路描述 *"
                        className="w-full rounded border border-slate-200 bg-white px-2 py-1 text-xs dark:border-white/10 dark:bg-[#090c13]"
                      />

                      <input
                        type="text"
                        value={opt.prosText}
                        onChange={(e) =>
                          setOptionDrafts((prev) =>
                            prev.map((item, i) =>
                              i === idx ? { ...item, prosText: e.target.value } : item,
                            ),
                          )
                        }
                        placeholder="优势 Pros（多条用逗号分隔）"
                        className="w-full rounded border border-slate-200 bg-white px-2 py-1 text-[11px] dark:border-white/10 dark:bg-[#090c13]"
                      />

                      <input
                        type="text"
                        value={opt.consText}
                        onChange={(e) =>
                          setOptionDrafts((prev) =>
                            prev.map((item, i) =>
                              i === idx ? { ...item, consText: e.target.value } : item,
                            ),
                          )
                        }
                        placeholder="代价 Cons（多条用逗号分隔）"
                        className="w-full rounded border border-slate-200 bg-white px-2 py-1 text-[11px] dark:border-white/10 dark:bg-[#090c13]"
                      />

                      <input
                        type="text"
                        value={opt.risksText}
                        onChange={(e) =>
                          setOptionDrafts((prev) =>
                            prev.map((item, i) =>
                              i === idx ? { ...item, risksText: e.target.value } : item,
                            ),
                          )
                        }
                        placeholder="风险 Risks（多条用逗号分隔）"
                        className="w-full rounded border border-slate-200 bg-white px-2 py-1 text-[11px] dark:border-white/10 dark:bg-[#090c13]"
                      />
                    </div>
                  ))}
                </div>

                <div className="flex items-center justify-between gap-2">
                  {optionDrafts.length < 6 ? (
                    <button
                      type="button"
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
                      className="inline-flex items-center gap-1 text-xs font-medium text-indigo-600 dark:text-indigo-400"
                    >
                      <Plus className="h-3.5 w-3.5" />
                      <span>增加备选方案</span>
                    </button>
                  ) : (
                    <span />
                  )}

                  <div className="flex items-center gap-1.5 text-xs">
                    <span className="text-slate-500">推荐方案 Key:</span>
                    <input
                      type="text"
                      value={recommendedKey}
                      onChange={(e) => setRecommendedKey(e.target.value)}
                      className="w-12 rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 font-mono text-xs dark:border-white/10 dark:bg-[#090c13]"
                    />
                  </div>
                </div>

                {createPropErr ? (
                  <p className="text-xs text-rose-600 dark:text-rose-400">{createPropErr}</p>
                ) : null}

                <button
                  type="submit"
                  disabled={props.isCreatingProposal}
                  className="inline-flex w-full items-center justify-center gap-1.5 rounded-xl bg-indigo-600 px-3 py-2 text-xs font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
                >
                  {props.isCreatingProposal ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : null}
                  <span>发布提案卡至房间</span>
                </button>
              </form>
            ) : null}

            {/* 提案卡片列表（四态完备） */}
            {props.isLoadingProposals ? (
              <div className="space-y-3">
                {[1, 2].map((sk) => (
                  <div
                    key={`prop-sk-${String(sk)}`}
                    className="h-44 animate-pulse rounded-2xl bg-slate-200/70 dark:bg-white/[0.04]"
                  />
                ))}
              </div>
            ) : props.isProposalsError ? (
              <div className="rounded-2xl border border-rose-500/30 bg-rose-500/10 p-4 text-xs text-rose-700 dark:text-rose-300">
                <div className="flex items-center gap-1.5 font-semibold">
                  <AlertCircle className="h-4 w-4" />
                  <span>加载提案列表失败</span>
                </div>
                <button
                  type="button"
                  onClick={props.onRetryProposals}
                  className="mt-2 inline-flex items-center gap-1 rounded-lg bg-rose-600 px-2.5 py-1 text-white"
                >
                  <RefreshCw className="h-3 w-3" />
                  <span>重新加载</span>
                </button>
              </div>
            ) : props.proposals.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-slate-300/80 bg-white/60 p-6 text-center dark:border-white/10 dark:bg-white/[0.02]">
                <Sparkles className="mx-auto h-6 w-6 text-indigo-500" />
                <p className="mt-2 text-xs font-semibold text-slate-800 dark:text-slate-200">
                  暂无结构化提案卡
                </p>
                <p className="mt-1 text-[11.5px] leading-relaxed text-slate-500 dark:text-slate-400">
                  当多个 Agent 在群里展开多轮辩论后，点击上方「✨ AI 自动提炼提案卡」，即可自动生成
                  Pros/Cons/Risks 对比矩阵供你一键拍板！
                </p>
              </div>
            ) : (
              <div className="space-y-3.5">
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
