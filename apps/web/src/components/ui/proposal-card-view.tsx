/**
 * @module web/components/ui/proposal-card-view
 * @description 纯 Props 驱动的 Pachat 纸感极简「共识提案与拍板卡」（Calm Editorial Consensus Card），同时服务聊天室右侧抽屉与公开只读分享页。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 容器与展示彻底解耦：组件本身零网络请求副作用，通过受控回调驱动评议表态与主理人拍板，无缝兼容实时讨论态与 `/share/:inviteToken` 只读态。
 * 2. Pachat 纯墨黑 + 暖纸编辑部美学：摒弃一切蓝紫渐变头带与闪光图标，统一采用 `#141414` 墨黑主按钮、`#F5F5F7` 柔灰纸面、`#E3F3EC` 拍板鼠尾草绿与 `rounded-full` 胶囊按钮。
 * 3. 原生级控件与暗色对比度安全：100% 采用 `AppButton`、`AppInput`、`AppTextarea`、`SegmentedTabs` 与 `toast` 反馈，暗色模式下输入框恒保深色背景。
 */
import {
  type CastProposalVoteBody,
  type DecideProposalBody,
  type ProposalCardDto,
  type ProposalId,
  type ProposalStatus,
  type ProposalVoteStance,
  assertNever,
} from "@openhuddle/protocol";
import {
  AlertTriangle,
  Award,
  Check,
  CheckCircle2,
  ChevronDown,
  HelpCircle,
  MessageSquarePlus,
  Scale,
  ThumbsUp,
  XCircle,
} from "lucide-react";
import { useState } from "react";
import { formatMessageTimestamp } from "../../lib/format.js";
import {
  AnimatePresence,
  AppButton,
  AppInput,
  AppTextarea,
  type SegmentedTabItem,
  SegmentedTabs,
  cn,
  motion,
  toast,
} from "../primitives/index.js";
import { AuthorMicroTag, PlatformAvatar } from "./identity-badges.js";

/** `ProposalCardView` 入参属性 */
export interface ProposalCardViewProps {
  readonly proposal: ProposalCardDto;
  readonly interactive?: boolean | undefined;
  readonly isSubmittingVote?: boolean | undefined;
  readonly isSubmittingDecision?: boolean | undefined;
  readonly onCastVote?: ((proposalId: ProposalId, body: CastProposalVoteBody) => void) | undefined;
  readonly onDecide?: ((proposalId: ProposalId, body: DecideProposalBody) => void) | undefined;
  readonly highlighted?: boolean | undefined;
}

const STANCE_TAB_ITEMS: ReadonlyArray<SegmentedTabItem<ProposalVoteStance>> = [
  {
    value: "endorse",
    label: "赞成",
    icon: <ThumbsUp className="h-3.5 w-3.5 text-[#2A7B59] dark:text-[#5ED3A2]" />,
  },
  {
    value: "challenge",
    label: "质疑",
    icon: <AlertTriangle className="h-3.5 w-3.5 text-[#C84B31] dark:text-[#F29B88]" />,
  },
  {
    value: "abstain",
    label: "弃权",
    icon: <HelpCircle className="h-3.5 w-3.5 text-[#8E8E93]" />,
  },
];

function renderStatusPill(status: ProposalStatus) {
  switch (status) {
    case "open":
      return (
        <span className="inline-flex select-none items-center gap-1 rounded-full bg-[#EFEFF3] px-2.5 py-0.5 text-[11px] font-medium text-[#141414] dark:bg-white/[0.09] dark:text-zinc-200">
          <span>待拍板</span>
        </span>
      );
    case "approved":
      return (
        <span className="inline-flex select-none items-center gap-1 rounded-full bg-[#E3F3EC] px-2.5 py-0.5 text-[11px] font-semibold text-[#1F5C43] ring-1 ring-inset ring-black/[0.05] dark:bg-[#16271F] dark:text-[#86DAB1] dark:ring-white/[0.08]">
          <Award className="h-3 w-3" />
          <span>已拍板</span>
        </span>
      );
    case "rejected":
      return (
        <span className="inline-flex select-none items-center gap-1 rounded-full bg-[#FBE3D9] px-2.5 py-0.5 text-[11px] font-medium text-[#6E3420] dark:bg-[#2E201B] dark:text-[#F2C7B6]">
          <XCircle className="h-3 w-3" />
          <span>已驳回</span>
        </span>
      );
    case "superseded":
      return (
        <span className="inline-flex select-none items-center gap-1 rounded-full bg-[#F5F5F7] px-2.5 py-0.5 text-[11px] font-medium text-[#8E8E93] dark:bg-white/[0.06] dark:text-zinc-400">
          <span>已被替代</span>
        </span>
      );
    default:
      return assertNever(status);
  }
}

function getStanceMeta(stance: ProposalVoteStance) {
  switch (stance) {
    case "endorse":
      return {
        label: "赞成",
        pillClass: "bg-[#E3F3EC] text-[#1F5C43] dark:bg-[#16271F] dark:text-[#86DAB1]",
      };
    case "challenge":
      return {
        label: "质疑",
        pillClass: "bg-[#FBE3D9] text-[#6E3420] dark:bg-[#2E201B] dark:text-[#F2C7B6]",
      };
    case "abstain":
      return {
        label: "弃权",
        pillClass: "bg-[#EFEFF3] text-[#5F5F64] dark:bg-white/[0.08] dark:text-zinc-300",
      };
    default:
      return assertNever(stance);
  }
}

/**
 * 渲染 Pachat 温润编辑部风格的共识决策卡：备选方案利弊对照、共识进度条、分段评议表态器与胶囊一键拍板。
 *
 * @param props - 提案 DTO、异步加载态与交互回调
 * @returns 结构化共识决策卡片视图
 */
export function ProposalCardView(props: ProposalCardViewProps) {
  const { proposal } = props;
  const defaultOptionKey =
    proposal.decidedOptionKey ??
    proposal.draft.recommendedOptionKey ??
    proposal.draft.options[0]?.optionKey ??
    "";

  const [selectedOptionKey, setSelectedOptionKey] = useState<string>(defaultOptionKey);
  const [decisionNote, setDecisionNote] = useState<string>("");
  const [voteDrawerOpen, setVoteDrawerOpen] = useState<boolean>(false);
  const [voteStance, setVoteStance] = useState<ProposalVoteStance>("endorse");
  const [voteRationale, setVoteRationale] = useState<string>("");

  const endorseCount = proposal.votes.filter((v) => v.stance === "endorse").length;
  const challengeCount = proposal.votes.filter((v) => v.stance === "challenge").length;
  const abstainCount = proposal.votes.filter((v) => v.stance === "abstain").length;
  const totalVotes = proposal.votes.length;

  const endorsePct = totalVotes > 0 ? (endorseCount / totalVotes) * 100 : 0;
  const challengePct = totalVotes > 0 ? (challengeCount / totalVotes) * 100 : 0;
  const abstainPct = totalVotes > 0 ? (abstainCount / totalVotes) * 100 : 0;

  const isOpenInteractive = Boolean(props.interactive && proposal.status === "open");

  const cardFrameClass =
    proposal.status === "approved"
      ? "ring-1 ring-[#2A7B59]/30 dark:ring-[#5ED3A2]/25"
      : props.highlighted
        ? "ring-2 ring-[#141414] dark:ring-white/45"
        : "ring-1 ring-black/[0.07] dark:ring-white/[0.08]";

  const handleVoteSubmit = (): void => {
    const trimmedRationale = voteRationale.trim();
    if (!props.onCastVote || trimmedRationale.length === 0) {
      return;
    }
    const stanceLabel = getStanceMeta(voteStance).label;
    props.onCastVote(proposal.id, {
      stance: voteStance,
      ...(selectedOptionKey.length > 0 ? { preferredOptionKey: selectedOptionKey } : {}),
      rationale: trimmedRationale,
    });
    toast.success(`已提交「${stanceLabel}」表态`);
    setVoteRationale("");
    setVoteDrawerOpen(false);
  };

  const handleDecision = (decision: "approved" | "rejected"): void => {
    if (!props.onDecide) {
      return;
    }
    const trimmedNote = decisionNote.trim();
    props.onDecide(proposal.id, {
      decision,
      ...(decision === "approved" && selectedOptionKey.length > 0
        ? { decidedOptionKey: selectedOptionKey }
        : {}),
      ...(trimmedNote.length > 0 ? { decisionNote: trimmedNote } : {}),
    });
    if (decision === "approved") {
      toast.success(`已拍板采纳方案 ${selectedOptionKey || "默认方案"}`);
    } else {
      toast.success("已驳回提案并请群内重议");
    }
  };

  return (
    <article
      className={cn(
        "overflow-hidden rounded-[22px] bg-white text-[#141414] transition-all dark:bg-[#151518] dark:text-[#F5F5F7]",
        cardFrameClass,
      )}
    >
      {/* 1. Pachat 克制纸面卡头（无花哨渐变条） */}
      <header className="select-none border-b border-black/[0.06] bg-[#F8F8FA] px-4 pb-3.5 pt-3.5 dark:border-white/[0.07] dark:bg-[#1C1C1F]">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="inline-flex items-center gap-1.5 text-[11.5px] font-medium text-[#6E6E73] dark:text-zinc-400">
            <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-[#141414] text-white dark:bg-[#F5F5F7] dark:text-[#141414]">
              <Scale className="h-3 w-3" />
            </span>
            <span>共识提案</span>
          </span>
          {renderStatusPill(proposal.status)}
        </div>

        <h3 className="mt-2.5 select-text text-[15.5px] font-semibold tracking-tight leading-snug text-[#141414] dark:text-white">
          {proposal.draft.title}
        </h3>
        <p className="mt-1 select-text text-[13px] leading-relaxed text-[#5F5F64] dark:text-zinc-300">
          {proposal.draft.contextSummary}
        </p>
        <p className="mt-2 text-[11.5px] tabular-nums text-[#8E8E93] dark:text-zinc-500">
          创建于 {formatMessageTimestamp(proposal.createdAtIso)}
        </p>
      </header>

      <div className="space-y-4 px-4 py-4">
        {/* 2. 已拍板最终结论横幅 */}
        {proposal.status === "approved" || proposal.status === "rejected" ? (
          <div
            className={cn(
              "rounded-2xl px-3.5 py-3 text-[12.5px] ring-1 ring-inset",
              proposal.status === "approved"
                ? "bg-[#E3F3EC] text-[#1B452D] ring-black/[0.05] dark:bg-[#16271F] dark:text-[#CBEBD8] dark:ring-white/[0.08]"
                : "bg-[#FBE3D9]/80 text-[#5C2B1C] ring-black/[0.05] dark:bg-[#2E201B] dark:text-[#F2C7B6] dark:ring-white/[0.08]",
            )}
          >
            <div className="flex flex-wrap items-center justify-between gap-2 font-semibold">
              <span className="inline-flex items-center gap-1.5">
                {proposal.status === "approved" ? (
                  <CheckCircle2 className="h-4 w-4 shrink-0 text-[#1F5C43] dark:text-[#5ED3A2]" />
                ) : (
                  <XCircle className="h-4 w-4 shrink-0 text-[#8A3B24] dark:text-[#F29B88]" />
                )}
                <span>
                  {proposal.status === "approved"
                    ? `已拍板采纳：${proposal.decidedOptionKey ?? "默认方案"}`
                    : "已驳回，继续讨论"}
                </span>
              </span>
              {proposal.decidedBy ? (
                <span className="text-[11.5px] font-normal tabular-nums opacity-80">
                  {proposal.decidedBy.displayName}
                  {proposal.decidedAtIso
                    ? ` · ${formatMessageTimestamp(proposal.decidedAtIso)}`
                    : ""}
                </span>
              ) : null}
            </div>
            {proposal.decisionNote ? (
              <p className="mt-1.5 select-text leading-relaxed opacity-90">
                备注：{proposal.decisionNote}
              </p>
            ) : null}
            {proposal.mandate ? (
              /* ADR-0002：授权语义（scope/strength/策略版本/批准者）——授权力仅及于批准者名下 Agent */
              <div className="mt-2 rounded-xl bg-black/[0.04] px-2.5 py-2 text-[11.5px] leading-relaxed ring-1 ring-inset ring-black/[0.05] dark:bg-white/[0.05] dark:ring-white/[0.07]">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-medium">
                  <span>授权范围：{proposal.mandate.scope}</span>
                  <span className="rounded-full bg-black/[0.06] px-1.5 py-0.5 text-[10.5px] dark:bg-white/10">
                    {proposal.mandate.strength === "act"
                      ? "可执行"
                      : proposal.mandate.strength === "act_with_review"
                        ? "执行后需复盘"
                        : "仅供参考"}
                  </span>
                  <span className="font-normal opacity-70">
                    群规 v{proposal.mandate.policyVersion}
                  </span>
                </div>
                <p className="mt-1 font-normal opacity-75">
                  授权力仅及于批准者（{proposal.decidedBy?.displayName ?? "拍板者"}）名下的
                  Agent，其他成员的 Agent 视为参考信息。
                </p>
              </div>
            ) : null}
          </div>
        ) : null}

        {/* 3. 多备选方案 Pros / Cons / Risks 对照 */}
        <section className="space-y-2">
          <div className="flex select-none items-center justify-between text-[12px] font-medium text-[#6E6E73] dark:text-zinc-400">
            <span className="tabular-nums">备选方案 · {proposal.draft.options.length}</span>
            {isOpenInteractive ? (
              <span className="text-[#141414] dark:text-zinc-200">点选拟采纳方案</span>
            ) : null}
          </div>

          <div className="grid grid-cols-1 gap-2">
            {proposal.draft.options.map((option) => {
              const isRecommended = proposal.draft.recommendedOptionKey === option.optionKey;
              const isDecidedWinner =
                proposal.status === "approved" && proposal.decidedOptionKey === option.optionKey;
              const isSelected = isOpenInteractive && selectedOptionKey === option.optionKey;

              const optionCardClass = isDecidedWinner
                ? "bg-[#E3F3EC]/65 ring-1 ring-inset ring-[#2A7B59]/35 dark:bg-[#16271F]/85 dark:ring-[#5ED3A2]/30"
                : isSelected
                  ? "bg-[#F8F8FA] ring-[1.5px] ring-inset ring-[#141414] dark:bg-[#1F1F23] dark:ring-[#F5F5F7]"
                  : "bg-[#F5F5F7]/75 ring-1 ring-inset ring-black/[0.06] hover:bg-[#F5F5F7] dark:bg-[#1C1C1F] dark:ring-white/[0.07] dark:hover:bg-[#222226]";

              const cardInner = (
                <div className="w-full text-left">
                  <div className="flex flex-wrap items-center justify-between gap-1.5">
                    <div className="flex min-w-0 items-center gap-2">
                      {isOpenInteractive ? (
                        <span
                          className={cn(
                            "flex h-4 w-4 shrink-0 items-center justify-center rounded-full transition-all",
                            isSelected
                              ? "bg-[#141414] text-white dark:bg-[#F5F5F7] dark:text-[#141414]"
                              : "bg-white ring-1 ring-inset ring-black/20 dark:bg-[#151518] dark:ring-white/25",
                          )}
                        >
                          {isSelected ? <Check className="h-2.5 w-2.5 stroke-[3]" /> : null}
                        </span>
                      ) : null}
                      <span className="rounded-full bg-black/[0.06] px-2 py-0.5 font-mono text-[11px] font-semibold text-[#141414] dark:bg-white/[0.10] dark:text-zinc-200">
                        {option.optionKey}
                      </span>
                      <span className="truncate text-[13.5px] font-semibold text-[#141414] dark:text-white">
                        {option.label}
                      </span>
                    </div>

                    <div className="flex items-center gap-1.5">
                      {isRecommended ? (
                        <span className="rounded-full bg-[#F4ECDD] px-2 py-0.5 text-[10.5px] font-medium text-[#5C4528] dark:bg-[#2B251D] dark:text-[#EAD8BC]">
                          推荐
                        </span>
                      ) : null}
                      {isDecidedWinner ? (
                        <span className="rounded-full bg-[#E3F3EC] px-2 py-0.5 text-[10.5px] font-semibold text-[#1F5C43] dark:bg-[#16271F] dark:text-[#86DAB1]">
                          ✓ 已采纳
                        </span>
                      ) : null}
                    </div>
                  </div>

                  <p className="mt-1.5 text-[12.5px] leading-relaxed text-[#5F5F64] dark:text-zinc-300">
                    {option.summary}
                  </p>

                  {option.pros.length + option.cons.length + option.risks.length > 0 ? (
                    <div className="mt-2.5 grid grid-cols-1 gap-1.5 border-t border-black/[0.06] pt-2.5 text-[12px] dark:border-white/[0.07]">
                      {option.pros.length > 0 ? (
                        <div className="space-y-0.5">
                          <span className="font-medium text-[#1F5C43] dark:text-[#86DAB1]">
                            + 优势
                          </span>
                          <ul className="space-y-0.5 text-[#5F5F64] dark:text-zinc-300">
                            {option.pros.map((pro, idx) => (
                              <li
                                key={`${option.optionKey}-pro-${String(idx)}`}
                                className="flex gap-1.5"
                              >
                                <span className="text-[#2A7B59] dark:text-[#5ED3A2]">•</span>
                                <span>{pro}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      ) : null}

                      {option.cons.length > 0 ? (
                        <div className="space-y-0.5">
                          <span className="font-medium text-[#8A3B24] dark:text-[#F29B88]">
                            − 代价
                          </span>
                          <ul className="space-y-0.5 text-[#5F5F64] dark:text-zinc-300">
                            {option.cons.map((con, idx) => (
                              <li
                                key={`${option.optionKey}-con-${String(idx)}`}
                                className="flex gap-1.5"
                              >
                                <span className="text-[#C84B31] dark:text-[#F29B88]">•</span>
                                <span>{con}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      ) : null}

                      {option.risks.length > 0 ? (
                        <div className="space-y-0.5">
                          <span className="inline-flex items-center gap-1 font-medium text-[#6B5016] dark:text-[#EAD08B]">
                            <AlertTriangle className="h-3 w-3" />
                            <span>风险</span>
                          </span>
                          <ul className="space-y-0.5 text-[#5F5F64] dark:text-zinc-300">
                            {option.risks.map((risk, idx) => (
                              <li
                                key={`${option.optionKey}-risk-${String(idx)}`}
                                className="flex gap-1.5"
                              >
                                <span className="text-[#B88924]">•</span>
                                <span>{risk}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              );

              if (isOpenInteractive) {
                return (
                  <button
                    key={option.optionKey}
                    type="button"
                    aria-pressed={isSelected}
                    onClick={() => setSelectedOptionKey(option.optionKey)}
                    className={cn(
                      "app-no-drag cursor-pointer rounded-2xl p-3 text-left outline-none transition-all duration-150 active:scale-[0.99] focus-visible:ring-2 focus-visible:ring-black/25 dark:focus-visible:ring-white/35",
                      optionCardClass,
                    )}
                  >
                    {cardInner}
                  </button>
                );
              }

              return (
                <div key={option.optionKey} className={cn("rounded-2xl p-3", optionCardClass)}>
                  {cardInner}
                </div>
              );
            })}
          </div>
        </section>

        {/* 4. 各方评议表态条与明细 */}
        <section className="space-y-2.5">
          <div className="flex select-none flex-wrap items-center justify-between gap-2 text-[12px]">
            <span className="font-medium tabular-nums text-[#6E6E73] dark:text-zinc-400">
              群内表态 · {totalVotes}
              {totalVotes > 0 ? `（${String(Math.round(endorsePct))}% 赞成）` : ""}
            </span>
            <div className="flex items-center gap-2.5 font-medium tabular-nums">
              <span className="inline-flex items-center gap-1 text-[#1F5C43] dark:text-[#86DAB1]">
                <ThumbsUp className="h-3 w-3" />
                {endorseCount}
              </span>
              <span className="inline-flex items-center gap-1 text-[#8A3B24] dark:text-[#F29B88]">
                <AlertTriangle className="h-3 w-3" />
                {challengeCount}
              </span>
              <span className="inline-flex items-center gap-1 text-[#8E8E93]">
                <HelpCircle className="h-3 w-3" />
                {abstainCount}
              </span>
            </div>
          </div>

          {totalVotes > 0 ? (
            <>
              <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-[#EFEFF3] dark:bg-white/[0.08]">
                {endorseCount > 0 ? (
                  <motion.div
                    initial={{ width: 0 }}
                    animate={{ width: `${String(endorsePct)}%` }}
                    transition={{ type: "spring", stiffness: 260, damping: 30 }}
                    className="h-full bg-[#34C759] first:rounded-l-full last:rounded-r-full"
                  />
                ) : null}
                {challengeCount > 0 ? (
                  <motion.div
                    initial={{ width: 0 }}
                    animate={{ width: `${String(challengePct)}%` }}
                    transition={{ type: "spring", stiffness: 260, damping: 30 }}
                    className="h-full bg-[#D96B52] first:rounded-l-full last:rounded-r-full"
                  />
                ) : null}
                {abstainCount > 0 ? (
                  <motion.div
                    initial={{ width: 0 }}
                    animate={{ width: `${String(abstainPct)}%` }}
                    transition={{ type: "spring", stiffness: 260, damping: 30 }}
                    className="h-full bg-[#C7C7CC] first:rounded-l-full last:rounded-r-full dark:bg-zinc-600"
                  />
                ) : null}
              </div>

              <ul className="space-y-2.5 pt-1">
                {proposal.votes.map((vote, idx) => {
                  const stanceMeta = getStanceMeta(vote.stance);
                  const voterKey = `${vote.voter.agentId ?? vote.voter.userId ?? vote.voter.displayName}-${String(idx)}`;
                  return (
                    <li key={voterKey} className="flex items-start gap-2.5">
                      <PlatformAvatar
                        kind={vote.voter.kind}
                        displayName={vote.voter.displayName}
                        platform={vote.voter.platform}
                        size="sm"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex select-none flex-wrap items-center gap-1.5 text-[12px]">
                          <span className="font-medium text-[#141414] dark:text-zinc-100">
                            {vote.voter.displayName}
                          </span>
                          <AuthorMicroTag
                            kind={vote.voter.kind}
                            trustLevel={vote.voter.trustLevel}
                            isYourOwner={vote.voter.isYourOwner}
                          />
                          <span
                            className={cn(
                              "rounded-full px-2 py-[1px] text-[10.5px] font-medium",
                              stanceMeta.pillClass,
                            )}
                          >
                            {stanceMeta.label}
                          </span>
                          {vote.preferredOptionKey ? (
                            <span className="rounded-full bg-black/[0.05] px-2 py-[1px] font-mono text-[10.5px] font-medium text-[#5F5F64] dark:bg-white/[0.09] dark:text-zinc-300">
                              → {vote.preferredOptionKey}
                            </span>
                          ) : null}
                        </div>
                        <p className="mt-1 inline-block max-w-full select-text rounded-[6px_16px_16px_16px] bg-[#F5F5F7] px-3 py-1.5 text-[12.5px] leading-relaxed text-[#3A3A3C] dark:bg-[#1C1C1F] dark:text-zinc-300">
                          {vote.rationale}
                        </p>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </>
          ) : (
            <p className="rounded-2xl bg-[#F5F5F7] px-3.5 py-2.5 text-[12px] text-[#6E6E73] dark:bg-[#1C1C1F] dark:text-zinc-400">
              还没有成员表态。可以在群里 @ 你的 Agent 听听意见，或直接拍板。
            </p>
          )}
        </section>
      </div>

      {/* 5. 人类交互区：补充表态 + 最终胶囊拍板区 */}
      {isOpenInteractive ? (
        <footer className="space-y-3 border-t border-black/[0.06] bg-[#F8F8FA] px-4 py-3.5 dark:border-white/[0.07] dark:bg-[#18181B]">
          <div>
            <AppButton
              variant="soft"
              size="xs"
              onClick={() => setVoteDrawerOpen((prev) => !prev)}
              aria-expanded={voteDrawerOpen}
              leadingIcon={<MessageSquarePlus className="h-3.5 w-3.5" />}
              trailingIcon={
                <ChevronDown
                  className={cn(
                    "h-3.5 w-3.5 transition-transform duration-200",
                    voteDrawerOpen && "rotate-180",
                  )}
                />
              }
            >
              补充我的看法
            </AppButton>

            <AnimatePresence initial={false}>
              {voteDrawerOpen ? (
                <motion.div
                  key="vote-drawer"
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={{ type: "spring", stiffness: 420, damping: 34 }}
                  className="overflow-hidden"
                >
                  <div className="mt-2.5 space-y-2.5 rounded-2xl bg-white p-3 ring-1 ring-black/[0.07] dark:bg-[#1F1F23] dark:ring-white/[0.08]">
                    <SegmentedTabs
                      value={voteStance}
                      onValueChange={setVoteStance}
                      items={STANCE_TAB_ITEMS}
                      size="sm"
                      fullWidth={true}
                      ariaLabel="选择评议立场"
                    />

                    <AppTextarea
                      rows={2}
                      value={voteRationale}
                      onChange={(e) => setVoteRationale(e.target.value)}
                      placeholder="写下赞成或质疑的理由..."
                      className="resize-none text-xs"
                    />

                    <div className="flex justify-end">
                      <AppButton
                        variant="primary"
                        size="sm"
                        isLoading={Boolean(props.isSubmittingVote)}
                        disabled={voteRationale.trim().length === 0}
                        onClick={handleVoteSubmit}
                      >
                        提交表态
                      </AppButton>
                    </div>
                  </div>
                </motion.div>
              ) : null}
            </AnimatePresence>
          </div>

          {/* 最终拍板区 */}
          <div className="space-y-2.5 rounded-2xl bg-[#F5F5F7] p-3 ring-1 ring-inset ring-black/[0.06] dark:bg-[#1C1C1F] dark:ring-white/[0.08]">
            <div className="flex select-none flex-wrap items-center justify-between gap-1 text-[12px] font-semibold text-[#141414] dark:text-zinc-100">
              <span className="inline-flex items-center gap-1.5">
                <Award className="h-3.5 w-3.5" />
                <span>最终拍板</span>
              </span>
              <span className="rounded-full bg-white px-2.5 py-0.5 font-mono text-[11px] font-medium tabular-nums text-[#141414] ring-1 ring-black/[0.06] dark:bg-white/[0.08] dark:text-zinc-200 dark:ring-white/[0.08]">
                拟选：{selectedOptionKey || "未选"}
              </span>
            </div>

            <AppInput
              size="sm"
              type="text"
              value={decisionNote}
              onChange={(e) => setDecisionNote(e.target.value)}
              placeholder="可选：写一句拍板说明或执行要求"
            />

            <div className="flex flex-wrap items-center gap-2">
              <AppButton
                variant="primary"
                size="md"
                isLoading={Boolean(props.isSubmittingDecision)}
                disabled={selectedOptionKey.length === 0}
                leadingIcon={<CheckCircle2 className="h-4 w-4" />}
                onClick={() => handleDecision("approved")}
                className="flex-1"
              >
                {`拍板采纳 ${selectedOptionKey}`}
              </AppButton>

              <AppButton
                variant="secondary"
                size="md"
                disabled={Boolean(props.isSubmittingDecision)}
                leadingIcon={<XCircle className="h-4 w-4" />}
                onClick={() => handleDecision("rejected")}
              >
                驳回重议
              </AppButton>
            </div>
          </div>
        </footer>
      ) : null}
    </article>
  );
}
