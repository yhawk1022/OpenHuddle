/**
 * @module web/components/ui/proposal-card-view
 * @description 纯 Props 驱动的清晰质感「共识提案与拍板卡」（Consensus Proposal Card），同时服务聊天室右侧抽屉与公开只读分享页。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 容器与展示彻底解耦：组件本身零网络请求副作用，通过受控回调驱动评议表态与主理人拍板，无缝兼容实时讨论态与 `/share/:inviteToken` 只读态。
 * 2. 中性石墨与暖瓷协同美学：摒弃花哨蓝紫渐变头带与闪光图标，统一采用 Daylight 暖瓷白（`bg-white/88`）与 Midnight 中性烟熏石墨（`dark:bg-[#1E1E22]/92` -> `dark:bg-[#26262B]/85`），配合翡翠已拍板卡与全胶囊操作按钮。
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
  ListTodo,
  MessageSquarePlus,
  Scale,
  ThumbsUp,
  XCircle,
} from "lucide-react";
import { useMemo, useState } from "react";
import { formatMessageTimestamp } from "../../lib/format.js";
import { type getComponentsTranslator, useComponentsI18n } from "../i18n/index.js";
import {
  AnimatePresence,
  AppButton,
  AppInput,
  AppTextarea,
  type SegmentedTabItem,
  SegmentedTabs,
  cn,
  motion,
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
  /** 将已拍板或选定的提案方案一键送入底部 `[⚡派活]` 编排舱派发执行 */
  readonly onDispatchFromProposal?: ((promptSeed: string) => void) | undefined;
  readonly highlighted?: boolean | undefined;
}

type ComponentsT = ReturnType<typeof getComponentsTranslator>["t"];

function renderStatusPill(status: ProposalStatus, t: ComponentsT) {
  switch (status) {
    case "open":
      return (
        <span className="inline-flex select-none items-center gap-1 rounded-full bg-black/[0.05] px-2.5 py-0.5 text-[11px] font-medium text-[#111318] dark:bg-white/[0.09] dark:text-[#F2F2F4]">
          <span>{t("proposal.status.open")}</span>
        </span>
      );
    case "approved":
      return (
        <span className="inline-flex select-none items-center gap-1 rounded-full bg-[#E6F5EC] px-2.5 py-0.5 text-[11px] font-semibold text-[#145335] ring-1 ring-inset ring-black/[0.05] dark:bg-[#1B2B23] dark:text-[#6EE7B7] dark:ring-emerald-400/[0.15]">
          <Award className="h-3 w-3" />
          <span>{t("proposal.status.approved")}</span>
        </span>
      );
    case "rejected":
      return (
        <span className="inline-flex select-none items-center gap-1 rounded-full bg-[#FBE3D9] px-2.5 py-0.5 text-[11px] font-medium text-[#6E3420] dark:bg-[#32201E] dark:text-[#F7B6A8]">
          <XCircle className="h-3 w-3" />
          <span>{t("proposal.status.rejected")}</span>
        </span>
      );
    case "superseded":
      return (
        <span className="inline-flex select-none items-center gap-1 rounded-full bg-black/[0.045] px-2.5 py-0.5 text-[11px] font-medium text-[#687082] dark:bg-white/[0.06] dark:text-[#8E8E96]">
          <span>{t("proposal.status.superseded")}</span>
        </span>
      );
    default:
      return assertNever(status);
  }
}

function getStanceMeta(stance: ProposalVoteStance, t: ComponentsT) {
  switch (stance) {
    case "endorse":
      return {
        label: t("proposal.stance.endorse"),
        pillClass: "bg-[#E6F5EC] text-[#145335] dark:bg-[#1B2B23] dark:text-[#6EE7B7]",
      };
    case "challenge":
      return {
        label: t("proposal.stance.challenge"),
        pillClass: "bg-[#FBE3D9] text-[#6E3420] dark:bg-[#32201E] dark:text-[#F7B6A8]",
      };
    case "abstain":
      return {
        label: t("proposal.stance.abstain"),
        pillClass: "bg-black/[0.05] text-[#687082] dark:bg-white/[0.08] dark:text-[#C4C4CA]",
      };
    default:
      return assertNever(stance);
  }
}

/**
 * 渲染结构化提案与协同决策卡片：备选方案利弊对照、投票汇总、分段表态与人工拍板。
 *
 * @param props - 提案 DTO、异步加载态与交互回调
 * @returns 提案决策卡片视图
 */
export function ProposalCardView(props: ProposalCardViewProps) {
  const { locale, t } = useComponentsI18n();
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

  const stanceTabItems = useMemo<ReadonlyArray<SegmentedTabItem<ProposalVoteStance>>>(
    () => [
      {
        value: "endorse",
        label: t("proposal.stance.endorse"),
        icon: <ThumbsUp className="h-3.5 w-3.5 text-[#16A34A] dark:text-[#34D399]" />,
      },
      {
        value: "challenge",
        label: t("proposal.stance.challenge"),
        icon: <AlertTriangle className="h-3.5 w-3.5 text-[#C84B31] dark:text-[#F29B88]" />,
      },
      {
        value: "abstain",
        label: t("proposal.stance.abstain"),
        icon: <HelpCircle className="h-3.5 w-3.5 text-[#939BAD] dark:text-[#8E8E96]" />,
      },
    ],
    [t],
  );

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
      ? "ring-1 ring-[#16A34A]/30 dark:ring-emerald-400/25"
      : props.highlighted
        ? "ring-2 ring-[#181B22] dark:ring-white/40"
        : "ring-1 ring-black/[0.06] dark:ring-white/[0.08]";

  const handleVoteSubmit = (): void => {
    const trimmedRationale = voteRationale.trim();
    if (!props.onCastVote || trimmedRationale.length === 0) {
      return;
    }
    props.onCastVote(proposal.id, {
      stance: voteStance,
      ...(selectedOptionKey.length > 0 ? { preferredOptionKey: selectedOptionKey } : {}),
      rationale: trimmedRationale,
    });
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
  };

  return (
    <article
      className={cn(
        "overflow-hidden rounded-[22px] bg-white/88 text-[#111318] shadow-[0_2px_10px_rgba(15,23,42,0.04)] transition-all dark:bg-[#1E1E22]/92 dark:text-[#F2F2F4] dark:shadow-[0_4px_18px_rgba(0,0,0,0.3)]",
        cardFrameClass,
      )}
    >
      {/* 1. 克制卡头 */}
      <header className="select-none border-b border-black/[0.06] bg-black/[0.025] px-4 pb-3.5 pt-3.5 dark:border-white/[0.07] dark:bg-[#26262B]/85">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="inline-flex items-center gap-1.5 text-[11.5px] font-medium text-[#687082] dark:text-[#8E8E96]">
            <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-[#181B22] text-white dark:bg-[#EAEEF6] dark:text-[#111318]">
              <Scale className="h-3 w-3" />
            </span>
            <span>{t("proposal.headerTitle")}</span>
          </span>
          {renderStatusPill(proposal.status, t)}
        </div>

        <h3 className="mt-2.5 select-text text-[15.5px] font-semibold tracking-tight leading-snug text-[#111318] dark:text-[#F2F2F4]">
          {proposal.draft.title}
        </h3>
        <p className="mt-1 select-text text-[13px] leading-relaxed text-[#3B414E] dark:text-[#C4C4CA]">
          {proposal.draft.contextSummary}
        </p>
        <p className="mt-2 text-[11.5px] tabular-nums text-[#939BAD] dark:text-[#63636B]">
          {t("proposal.createdAt", { time: formatMessageTimestamp(proposal.createdAtIso, locale) })}
        </p>
      </header>

      <div className="space-y-4 px-4 py-4">
        {/* 2. 已拍板最终结论横幅 */}
        {proposal.status === "approved" || proposal.status === "rejected" ? (
          <div
            className={cn(
              "rounded-2xl px-3.5 py-3 text-[12.5px] ring-1 ring-inset",
              proposal.status === "approved"
                ? "bg-[#E6F5EC] text-[#145335] ring-emerald-900/[0.08] dark:bg-[#1B2B23] dark:text-[#D5EFE1] dark:ring-emerald-400/[0.15]"
                : "bg-[#FBE3D9]/80 text-[#5C2B1C] ring-black/[0.05] dark:bg-[#32201E] dark:text-[#F7B6A8] dark:ring-white/[0.08]",
            )}
          >
            <div className="flex flex-wrap items-center justify-between gap-2 font-semibold">
              <span className="inline-flex items-center gap-1.5">
                {proposal.status === "approved" ? (
                  <CheckCircle2 className="h-4 w-4 shrink-0 text-[#16A34A] dark:text-[#34D399]" />
                ) : (
                  <XCircle className="h-4 w-4 shrink-0 text-[#8A3B24] dark:text-[#F29B88]" />
                )}
                <span>
                  {proposal.status === "approved"
                    ? t("proposal.banner.approved", {
                        option: proposal.decidedOptionKey ?? t("proposal.banner.defaultOption"),
                      })
                    : t("proposal.banner.rejected")}
                </span>
              </span>
              {proposal.status === "approved" && props.onDispatchFromProposal !== undefined ? (
                <AppButton
                  variant="secondary"
                  size="xs"
                  leadingIcon={<ListTodo className="h-3 w-3" />}
                  onClick={() => {
                    const chosenOpt = proposal.draft.options.find(
                      (o) => o.optionKey === (proposal.decidedOptionKey ?? selectedOptionKey),
                    );
                    const seed = chosenOpt
                      ? t("proposal.banner.dispatchSeedWithOption", {
                          title: proposal.draft.title,
                          optionLabel: chosenOpt.label,
                          summary: chosenOpt.summary,
                        })
                      : t("proposal.banner.dispatchSeedFallback", {
                          title: proposal.draft.title,
                          summary: proposal.draft.contextSummary,
                        });
                    props.onDispatchFromProposal?.(seed);
                  }}
                >
                  {t("proposal.banner.dispatch")}
                </AppButton>
              ) : proposal.decidedBy ? (
                <span className="text-[11.5px] font-normal tabular-nums opacity-80">
                  {proposal.decidedBy.displayName}
                  {proposal.decidedAtIso
                    ? ` · ${formatMessageTimestamp(proposal.decidedAtIso, locale)}`
                    : ""}
                </span>
              ) : null}
            </div>
            {proposal.decisionNote ? (
              <p className="mt-1.5 select-text leading-relaxed opacity-90">
                {t("proposal.banner.note", { note: proposal.decisionNote })}
              </p>
            ) : null}
            {proposal.mandate ? (
              /* ADR-0002：授权语义（scope/strength/策略版本/批准者）——授权力仅及于批准者名下 Agent */
              <div className="mt-2 rounded-xl bg-black/[0.04] px-2.5 py-2 text-[11.5px] leading-relaxed ring-1 ring-inset ring-black/[0.05] dark:bg-white/[0.05] dark:ring-white/[0.07]">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-medium">
                  <span>{t("proposal.mandate.scope", { scope: proposal.mandate.scope })}</span>
                  <span className="rounded-full bg-black/[0.06] px-1.5 py-0.5 text-[10.5px] dark:bg-white/10">
                    {proposal.mandate.strength === "act"
                      ? t("proposal.mandate.strengthAct")
                      : proposal.mandate.strength === "act_with_review"
                        ? t("proposal.mandate.strengthReview")
                        : t("proposal.mandate.strengthAdvise")}
                  </span>
                  <span className="font-normal opacity-70">
                    {t("proposal.mandate.policyVersion", {
                      version: proposal.mandate.policyVersion,
                    })}
                  </span>
                </div>
                <p className="mt-1 font-normal opacity-75">
                  {t("proposal.mandate.authorityHint", {
                    approver:
                      proposal.decidedBy?.displayName ?? t("proposal.mandate.approverFallback"),
                  })}
                </p>
              </div>
            ) : null}
          </div>
        ) : null}

        {/* 3. 多备选方案 Pros / Cons / Risks 对照 */}
        <section className="space-y-2">
          <div className="flex select-none items-center justify-between text-[12px] font-medium text-[#687082] dark:text-[#8E8E96]">
            <span className="tabular-nums">
              {t("proposal.options.heading", { count: proposal.draft.options.length })}
            </span>
            {isOpenInteractive ? (
              <span className="text-[#111318] dark:text-[#F2F2F4]">
                {t("proposal.options.selectPrompt")}
              </span>
            ) : null}
          </div>

          <div className="grid grid-cols-1 gap-2">
            {proposal.draft.options.map((option) => {
              const isRecommended = proposal.draft.recommendedOptionKey === option.optionKey;
              const isDecidedWinner =
                proposal.status === "approved" && proposal.decidedOptionKey === option.optionKey;
              const isSelected = isOpenInteractive && selectedOptionKey === option.optionKey;

              const optionCardClass = isDecidedWinner
                ? "bg-[#E6F5EC]/70 ring-1 ring-inset ring-[#16A34A]/35 dark:bg-[#1B2B23]/85 dark:ring-emerald-400/30"
                : isSelected
                  ? "bg-white ring-[1.5px] ring-inset ring-[#181B22] shadow-[0_2px_8px_rgba(15,23,42,0.06)] dark:bg-[#2E2E34] dark:ring-white/65"
                  : "bg-[#F3F4F6]/80 ring-1 ring-inset ring-black/[0.06] hover:bg-[#ECEEF2] dark:bg-[#26262B]/85 dark:ring-white/[0.07] dark:hover:bg-[#2C2C32]";

              const cardInner = (
                <div className="w-full text-left">
                  <div className="flex flex-wrap items-center justify-between gap-1.5">
                    <div className="flex min-w-0 items-center gap-2">
                      {isOpenInteractive ? (
                        <span
                          className={cn(
                            "flex h-4 w-4 shrink-0 items-center justify-center rounded-full transition-all",
                            isSelected
                              ? "bg-[#181B22] text-white dark:bg-[#EAEEF6] dark:text-[#111318]"
                              : "bg-white ring-1 ring-inset ring-black/20 dark:bg-[#18181B] dark:ring-white/25",
                          )}
                        >
                          {isSelected ? <Check className="h-2.5 w-2.5 stroke-[3]" /> : null}
                        </span>
                      ) : null}
                      <span className="rounded-full bg-black/[0.06] px-2 py-0.5 font-mono text-[11px] font-semibold text-[#111318] dark:bg-white/[0.10] dark:text-[#F2F2F4]">
                        {option.optionKey}
                      </span>
                      <span className="truncate text-[13.5px] font-semibold text-[#111318] dark:text-[#F2F2F4]">
                        {option.label}
                      </span>
                    </div>

                    <div className="flex items-center gap-1.5">
                      {isRecommended ? (
                        <span className="rounded-full bg-[#F4ECDD] px-2 py-0.5 text-[10.5px] font-medium text-[#5C4528] dark:bg-[#2F261C] dark:text-[#F3CFA2]">
                          {t("proposal.options.recommended")}
                        </span>
                      ) : null}
                      {isDecidedWinner ? (
                        <span className="rounded-full bg-[#E6F5EC] px-2 py-0.5 text-[10.5px] font-semibold text-[#145335] dark:bg-[#1B2B23] dark:text-[#6EE7B7]">
                          {t("proposal.options.adopted")}
                        </span>
                      ) : null}
                    </div>
                  </div>

                  <p className="mt-1.5 text-[12.5px] leading-relaxed text-[#3B414E] dark:text-[#C4C4CA]">
                    {option.summary}
                  </p>

                  {option.pros.length + option.cons.length + option.risks.length > 0 ? (
                    <div className="mt-2.5 grid grid-cols-1 gap-1.5 border-t border-black/[0.06] pt-2.5 text-[12px] dark:border-white/[0.07]">
                      {option.pros.length > 0 ? (
                        <div className="space-y-0.5">
                          <span className="font-medium text-[#145335] dark:text-[#6EE7B7]">
                            {t("proposal.options.pros")}
                          </span>
                          <ul className="space-y-0.5 text-[#3B414E] dark:text-[#C4C4CA]">
                            {option.pros.map((pro, idx) => (
                              <li
                                key={`${option.optionKey}-pro-${String(idx)}`}
                                className="flex gap-1.5"
                              >
                                <span className="text-[#16A34A] dark:text-[#34D399]">•</span>
                                <span>{pro}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      ) : null}

                      {option.cons.length > 0 ? (
                        <div className="space-y-0.5">
                          <span className="font-medium text-[#8A3B24] dark:text-[#F7B6A8]">
                            {t("proposal.options.cons")}
                          </span>
                          <ul className="space-y-0.5 text-[#3B414E] dark:text-[#C4C4CA]">
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
                          <span className="inline-flex items-center gap-1 font-medium text-[#78350F] dark:text-[#FCD34D]">
                            <AlertTriangle className="h-3 w-3" />
                            <span>{t("proposal.options.risks")}</span>
                          </span>
                          <ul className="space-y-0.5 text-[#3B414E] dark:text-[#C4C4CA]">
                            {option.risks.map((risk, idx) => (
                              <li
                                key={`${option.optionKey}-risk-${String(idx)}`}
                                className="flex gap-1.5"
                              >
                                <span className="text-[#D97706] dark:text-[#FBBF24]">•</span>
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
                      "app-no-drag cursor-pointer rounded-2xl p-3 text-left outline-none transition-all duration-150 active:scale-[0.99] focus-visible:ring-2 focus-visible:ring-black/20 dark:focus-visible:ring-white/25",
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
            <span className="font-medium tabular-nums text-[#687082] dark:text-[#8E8E96]">
              {t("proposal.votes.heading", { count: totalVotes })}
              {totalVotes > 0
                ? t("proposal.votes.endorsePct", { percent: Math.round(endorsePct) })
                : ""}
            </span>
            <div className="flex items-center gap-2.5 font-medium tabular-nums">
              <span className="inline-flex items-center gap-1 text-[#145335] dark:text-[#6EE7B7]">
                <ThumbsUp className="h-3 w-3" />
                {endorseCount}
              </span>
              <span className="inline-flex items-center gap-1 text-[#8A3B24] dark:text-[#F7B6A8]">
                <AlertTriangle className="h-3 w-3" />
                {challengeCount}
              </span>
              <span className="inline-flex items-center gap-1 text-[#939BAD] dark:text-[#63636B]">
                <HelpCircle className="h-3 w-3" />
                {abstainCount}
              </span>
            </div>
          </div>

          {totalVotes > 0 ? (
            <>
              <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-black/[0.05] dark:bg-white/[0.08]">
                {endorseCount > 0 ? (
                  <motion.div
                    initial={{ width: 0 }}
                    animate={{ width: `${String(endorsePct)}%` }}
                    transition={{ type: "spring", stiffness: 260, damping: 30 }}
                    className="h-full bg-[#16A34A] first:rounded-l-full last:rounded-r-full dark:bg-[#34D399]"
                  />
                ) : null}
                {challengeCount > 0 ? (
                  <motion.div
                    initial={{ width: 0 }}
                    animate={{ width: `${String(challengePct)}%` }}
                    transition={{ type: "spring", stiffness: 260, damping: 30 }}
                    className="h-full bg-[#E5484D] first:rounded-l-full last:rounded-r-full dark:bg-[#F05252]"
                  />
                ) : null}
                {abstainCount > 0 ? (
                  <motion.div
                    initial={{ width: 0 }}
                    animate={{ width: `${String(abstainPct)}%` }}
                    transition={{ type: "spring", stiffness: 260, damping: 30 }}
                    className="h-full bg-[#CBD2DE] first:rounded-l-full last:rounded-r-full dark:bg-[#52525B]"
                  />
                ) : null}
              </div>

              <ul className="space-y-2.5 pt-1">
                {proposal.votes.map((vote, idx) => {
                  const stanceMeta = getStanceMeta(vote.stance, t);
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
                          <span className="font-medium text-[#111318] dark:text-[#F2F2F4]">
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
                            <span className="rounded-full bg-black/[0.05] px-2 py-[1px] font-mono text-[10.5px] font-medium text-[#687082] dark:bg-white/[0.09] dark:text-[#C4C4CA]">
                              → {vote.preferredOptionKey}
                            </span>
                          ) : null}
                        </div>
                        <p className="mt-1 inline-block max-w-full select-text rounded-[6px_16px_16px_16px] bg-[#F3F4F6] px-3 py-1.5 text-[12.5px] leading-relaxed text-[#3B414E] dark:bg-[#26262B] dark:text-[#C4C4CA]">
                          {vote.rationale}
                        </p>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </>
          ) : (
            <p className="rounded-2xl bg-[#F3F4F6] px-3.5 py-2.5 text-[12px] text-[#687082] dark:bg-[#26262B] dark:text-[#8E8E96]">
              {t("proposal.votes.empty")}
            </p>
          )}
        </section>
      </div>

      {/* 5. 人类交互区：补充表态 + 最终胶囊拍板区 */}
      {isOpenInteractive ? (
        <footer className="space-y-3 border-t border-black/[0.06] bg-black/[0.02] px-4 py-3.5 dark:border-white/[0.07] dark:bg-[#18181B]/88">
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
              {t("proposal.voteForm.toggle")}
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
                  <div className="mt-2.5 space-y-2.5 rounded-2xl bg-white p-3 ring-1 ring-black/[0.06] dark:bg-[#222226] dark:ring-white/[0.08]">
                    <SegmentedTabs
                      value={voteStance}
                      onValueChange={setVoteStance}
                      items={stanceTabItems}
                      size="sm"
                      fullWidth={true}
                      ariaLabel={t("proposal.voteForm.stanceAria")}
                    />

                    <AppTextarea
                      rows={2}
                      value={voteRationale}
                      onChange={(e) => setVoteRationale(e.target.value)}
                      placeholder={t("proposal.voteForm.rationalePlaceholder")}
                      className="resize-none text-[16px] md:text-xs"
                    />

                    <div className="flex justify-end">
                      <AppButton
                        variant="primary"
                        size="sm"
                        isLoading={Boolean(props.isSubmittingVote)}
                        disabled={voteRationale.trim().length === 0}
                        onClick={handleVoteSubmit}
                      >
                        {t("proposal.voteForm.submit")}
                      </AppButton>
                    </div>
                  </div>
                </motion.div>
              ) : null}
            </AnimatePresence>
          </div>

          {/* 最终拍板区 */}
          <div className="space-y-2.5 rounded-2xl bg-[#F3F4F6] p-3 ring-1 ring-inset ring-black/[0.06] dark:bg-[#222226] dark:ring-white/[0.08]">
            <div className="flex select-none flex-wrap items-center justify-between gap-1 text-[12px] font-semibold text-[#111318] dark:text-[#F2F2F4]">
              <span className="inline-flex items-center gap-1.5">
                <Award className="h-3.5 w-3.5" />
                <span>{t("proposal.decisionForm.heading")}</span>
              </span>
              <span className="rounded-full bg-white px-2.5 py-0.5 font-mono text-[11px] font-medium tabular-nums text-[#111318] ring-1 ring-black/[0.06] dark:bg-white/[0.09] dark:text-[#F2F2F4] dark:ring-white/[0.08]">
                {t("proposal.decisionForm.selected", {
                  option: selectedOptionKey || t("proposal.decisionForm.unselected"),
                })}
              </span>
            </div>

            <AppInput
              size="sm"
              type="text"
              value={decisionNote}
              onChange={(e) => setDecisionNote(e.target.value)}
              placeholder={t("proposal.decisionForm.notePlaceholder")}
            />

            <div className="flex flex-wrap items-center gap-2">
              <AppButton
                variant="primary"
                size="md"
                isLoading={Boolean(props.isSubmittingDecision)}
                disabled={selectedOptionKey.length === 0}
                leadingIcon={<CheckCircle2 className="h-4 w-4" />}
                onClick={() => handleDecision("approved")}
                className="min-w-0 flex-1"
              >
                <span className="truncate">
                  {selectedOptionKey.length > 0
                    ? t("proposal.decisionForm.approveOption", { option: selectedOptionKey })
                    : t("proposal.decisionForm.approveFallback")}
                </span>
              </AppButton>

              <AppButton
                variant="secondary"
                size="md"
                disabled={Boolean(props.isSubmittingDecision)}
                leadingIcon={<XCircle className="h-4 w-4" />}
                onClick={() => handleDecision("rejected")}
              >
                {t("proposal.decisionForm.reject")}
              </AppButton>
            </div>
          </div>
        </footer>
      ) : null}
    </article>
  );
}
