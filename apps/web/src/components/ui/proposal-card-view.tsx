/**
 * @module web/components/ui/proposal-card-view
 * @description 纯 Props 驱动的结构化「提案与人类拍板卡」（Proposal & Decision Card）视图组件。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 容器与展示彻底解耦：不直接耦合任何网络请求 Hook，同时复用于实时工作台右侧决策抽屉与 `/share/:inviteToken` 公开只读回放页。
 * 2. 人类最终裁决权显式呈现：清晰区分多 Agent 的表态投票（`endorse` / `challenge` / `abstain`）与人类裁判的最终拍板（`Approve Selected Option` / `Reject`）。
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
  ChevronUp,
  HelpCircle,
  MessageSquarePlus,
  Sparkles,
  ThumbsUp,
  XCircle,
} from "lucide-react";
import { useState } from "react";
import { formatMessageTimestamp } from "../../lib/format.js";
import { PlatformAvatar, PlatformTagPill, SecurityTrustBadge } from "./identity-badges.js";

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

function renderStatusPill(status: ProposalStatus) {
  switch (status) {
    case "open":
      return (
        <span className="inline-flex items-center gap-1 rounded-full border border-indigo-500/35 bg-indigo-500/15 px-2.5 py-0.5 text-[11px] font-semibold text-indigo-700 dark:text-indigo-300">
          <Sparkles className="h-3 w-3" />
          <span>OPEN 待拍板</span>
        </span>
      );
    case "approved":
      return (
        <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/40 bg-emerald-500/15 px-2.5 py-0.5 text-[11px] font-bold text-emerald-800 dark:text-emerald-300">
          <Award className="h-3 w-3" />
          <span>APPROVED 已拍板采纳</span>
        </span>
      );
    case "rejected":
      return (
        <span className="inline-flex items-center gap-1 rounded-full border border-rose-500/35 bg-rose-500/15 px-2.5 py-0.5 text-[11px] font-semibold text-rose-700 dark:text-rose-300">
          <XCircle className="h-3 w-3" />
          <span>REJECTED 已驳回重议</span>
        </span>
      );
    case "superseded":
      return (
        <span className="inline-flex items-center gap-1 rounded-full border border-slate-400/30 bg-slate-500/10 px-2.5 py-0.5 text-[11px] font-medium text-slate-600 dark:text-slate-400">
          <span>SUPERSEDED 已演进替代</span>
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
        label: "赞同 Endorse",
        pillClass: "border-emerald-500/30 bg-emerald-500/12 text-emerald-700 dark:text-emerald-300",
      };
    case "challenge":
      return {
        label: "质疑 Challenge",
        pillClass: "border-rose-500/30 bg-rose-500/12 text-rose-700 dark:text-rose-300",
      };
    case "abstain":
      return {
        label: "中立/弃权 Abstain",
        pillClass: "border-slate-400/30 bg-slate-500/10 text-slate-600 dark:text-slate-300",
      };
    default:
      return assertNever(stance);
  }
}

/**
 * 渲染结构化多备选方案对比、Agent 分歧投票统计与人类裁判一键拍板组件。
 *
 * @param props - 提案 DTO 与交互回调
 * @returns 结构化提案卡片视图
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

  const isOpenInteractive = Boolean(props.interactive && proposal.status === "open");

  const cardBorderClass =
    proposal.status === "approved"
      ? "border-amber-500/45 bg-gradient-to-b from-amber-500/[0.06] to-white dark:from-amber-500/[0.08] dark:to-[#111520]"
      : props.highlighted
        ? "border-indigo-500/60 bg-white ring-2 ring-indigo-500/20 dark:bg-[#111520]"
        : "border-slate-200/90 bg-white dark:border-white/10 dark:bg-[#111520]";

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
      className={`overflow-hidden rounded-2xl border p-4 shadow-xs transition ${cardBorderClass}`}
    >
      {/* 1. 顶部提案状态栏与标题 */}
      <header className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          {renderStatusPill(proposal.status)}
          <span className="font-mono text-[11px] text-slate-400">
            源于 #{proposal.originMessageSeq} · {formatMessageTimestamp(proposal.createdAtIso)}
          </span>
        </div>
        <h3 className="text-[15px] font-semibold leading-snug text-slate-900 dark:text-white">
          {proposal.draft.title}
        </h3>
        <p className="text-xs leading-relaxed text-slate-600 dark:text-slate-300">
          {proposal.draft.contextSummary}
        </p>
      </header>

      {/* 2. 已拍板最终结论醒目横幅 */}
      {proposal.status === "approved" || proposal.status === "rejected" ? (
        <div
          className={`mt-3.5 rounded-xl border p-3 text-xs ${
            proposal.status === "approved"
              ? "border-emerald-500/35 bg-emerald-500/10 text-emerald-950 dark:text-emerald-100"
              : "border-rose-500/35 bg-rose-500/10 text-rose-950 dark:text-rose-100"
          }`}
        >
          <div className="flex flex-wrap items-center justify-between gap-2 font-semibold">
            <span className="inline-flex items-center gap-1.5">
              {proposal.status === "approved" ? (
                <CheckCircle2 className="h-4 w-4 text-emerald-500" />
              ) : (
                <XCircle className="h-4 w-4 text-rose-500" />
              )}
              <span>
                {proposal.status === "approved"
                  ? `人类最终拍板采纳：${proposal.decidedOptionKey ?? "默认方案"}`
                  : "人类裁判驳回重议"}
              </span>
            </span>
            {proposal.decidedBy ? (
              <span className="text-[11px] opacity-80">
                拍板人：{proposal.decidedBy.displayName}
                {proposal.decidedAtIso ? ` · ${formatMessageTimestamp(proposal.decidedAtIso)}` : ""}
              </span>
            ) : null}
          </div>
          {proposal.decisionNote ? (
            <p className="mt-1.5 leading-relaxed opacity-90">批注：{proposal.decisionNote}</p>
          ) : null}
        </div>
      ) : null}

      {/* 3. 多备选方案 Pros / Cons / Risks 结构化对比矩阵 */}
      <div className="mt-3.5 space-y-2.5">
        <div className="flex items-center justify-between text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
          <span>备选方案对比 ({proposal.draft.options.length})</span>
          {isOpenInteractive ? (
            <span className="text-indigo-600 dark:text-indigo-400">点击卡片选择拟采纳方案</span>
          ) : null}
        </div>

        <div className="grid grid-cols-1 gap-2.5">
          {proposal.draft.options.map((option) => {
            const isRecommended = proposal.draft.recommendedOptionKey === option.optionKey;
            const isDecidedWinner =
              proposal.status === "approved" && proposal.decidedOptionKey === option.optionKey;
            const isSelected = isOpenInteractive && selectedOptionKey === option.optionKey;

            const optionCardClass = isDecidedWinner
              ? "border-emerald-500/50 bg-emerald-500/[0.07]"
              : isSelected
                ? "border-indigo-500 bg-indigo-500/[0.07] ring-1 ring-indigo-500/40"
                : "border-slate-200/80 bg-slate-50/70 hover:border-slate-300 dark:border-white/[0.08] dark:bg-white/[0.025] dark:hover:border-white/15";

            const cardInner = (
              <div className="w-full text-left">
                <div className="flex flex-wrap items-center justify-between gap-1.5">
                  <div className="flex items-center gap-2">
                    {isOpenInteractive ? (
                      <span
                        className={`flex h-4 w-4 items-center justify-center rounded-full border text-[10px] ${
                          isSelected
                            ? "border-indigo-500 bg-indigo-600 text-white"
                            : "border-slate-400 dark:border-slate-500"
                        }`}
                      >
                        {isSelected ? <Check className="h-2.5 w-2.5" /> : null}
                      </span>
                    ) : null}
                    <span className="rounded-md bg-slate-900/8 px-1.5 py-0.5 font-mono text-[11px] font-bold text-slate-700 dark:bg-white/10 dark:text-slate-200">
                      {option.optionKey}
                    </span>
                    <span className="text-xs font-semibold text-slate-900 dark:text-white">
                      {option.label}
                    </span>
                  </div>

                  <div className="flex items-center gap-1.5">
                    {isRecommended ? (
                      <span className="rounded-full bg-indigo-500/15 px-2 py-0.5 text-[10px] font-semibold text-indigo-700 dark:text-indigo-300">
                        ★ 推荐方案
                      </span>
                    ) : null}
                    {isDecidedWinner ? (
                      <span className="rounded-full bg-emerald-500/20 px-2 py-0.5 text-[10px] font-bold text-emerald-800 dark:text-emerald-300">
                        ✓ 已采纳
                      </span>
                    ) : null}
                  </div>
                </div>

                <p className="mt-1.5 text-xs leading-relaxed text-slate-600 dark:text-slate-300">
                  {option.summary}
                </p>

                {/* Pros / Cons / Risks 三栏对照标签 */}
                <div className="mt-2.5 grid grid-cols-1 gap-2 border-t border-slate-200/70 pt-2 text-[11.5px] dark:border-white/[0.06]">
                  {option.pros.length > 0 ? (
                    <div className="space-y-0.5">
                      <span className="font-semibold text-emerald-700 dark:text-emerald-400">
                        + 优势 (Pros)
                      </span>
                      <ul className="space-y-0.5 text-slate-600 dark:text-slate-300">
                        {option.pros.map((pro, idx) => (
                          <li
                            key={`${option.optionKey}-pro-${String(idx)}`}
                            className="flex gap-1.5"
                          >
                            <span className="text-emerald-500">•</span>
                            <span>{pro}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}

                  {option.cons.length > 0 ? (
                    <div className="space-y-0.5">
                      <span className="font-semibold text-rose-700 dark:text-rose-400">
                        − 权衡代价 (Cons)
                      </span>
                      <ul className="space-y-0.5 text-slate-600 dark:text-slate-300">
                        {option.cons.map((con, idx) => (
                          <li
                            key={`${option.optionKey}-con-${String(idx)}`}
                            className="flex gap-1.5"
                          >
                            <span className="text-rose-500">•</span>
                            <span>{con}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}

                  {option.risks.length > 0 ? (
                    <div className="space-y-0.5">
                      <span className="inline-flex items-center gap-1 font-semibold text-amber-700 dark:text-amber-400">
                        <AlertTriangle className="h-3 w-3" />
                        <span>风险提示 (Risks)</span>
                      </span>
                      <ul className="space-y-0.5 text-slate-600 dark:text-slate-300">
                        {option.risks.map((risk, idx) => (
                          <li
                            key={`${option.optionKey}-risk-${String(idx)}`}
                            className="flex gap-1.5"
                          >
                            <span className="text-amber-500">•</span>
                            <span>{risk}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </div>
              </div>
            );

            if (isOpenInteractive) {
              return (
                <button
                  key={option.optionKey}
                  type="button"
                  onClick={() => setSelectedOptionKey(option.optionKey)}
                  className={`rounded-xl border p-3 text-left transition ${optionCardClass}`}
                >
                  {cardInner}
                </button>
              );
            }

            return (
              <div key={option.optionKey} className={`rounded-xl border p-3 ${optionCardClass}`}>
                {cardInner}
              </div>
            );
          })}
        </div>
      </div>

      {/* 4. 各方 Agent 与人类表态分布（Vote Breakdown） */}
      <div className="mt-4 space-y-2.5 border-t border-slate-200/80 pt-3 dark:border-white/[0.08]">
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
          <span className="font-semibold text-slate-700 dark:text-slate-200">
            交叉评议表态 ({totalVotes})
          </span>
          <div className="flex items-center gap-2 text-[11px]">
            <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
              <ThumbsUp className="h-3 w-3" />
              赞同 {endorseCount}
            </span>
            <span className="inline-flex items-center gap-1 text-rose-600 dark:text-rose-400">
              <AlertTriangle className="h-3 w-3" />
              质疑 {challengeCount}
            </span>
            <span className="inline-flex items-center gap-1 text-slate-500 dark:text-slate-400">
              <HelpCircle className="h-3 w-3" />
              弃权 {abstainCount}
            </span>
          </div>
        </div>

        {totalVotes > 0 ? (
          <>
            <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-white/10">
              {endorseCount > 0 ? (
                <div
                  style={{ width: `${String((endorseCount / totalVotes) * 100)}%` }}
                  className="bg-emerald-500"
                />
              ) : null}
              {challengeCount > 0 ? (
                <div
                  style={{ width: `${String((challengeCount / totalVotes) * 100)}%` }}
                  className="bg-rose-500"
                />
              ) : null}
              {abstainCount > 0 ? (
                <div
                  style={{ width: `${String((abstainCount / totalVotes) * 100)}%` }}
                  className="bg-slate-400"
                />
              ) : null}
            </div>

            <div className="space-y-2 pt-1">
              {proposal.votes.map((vote, idx) => {
                const stanceMeta = getStanceMeta(vote.stance);
                const voterKey = `${vote.voter.agentId ?? vote.voter.userId ?? vote.voter.displayName}-${String(idx)}`;
                return (
                  <div
                    key={voterKey}
                    className="rounded-xl border border-slate-200/70 bg-slate-50/60 p-2.5 text-xs dark:border-white/[0.06] dark:bg-white/[0.02]"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-1.5">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <PlatformAvatar
                          kind={vote.voter.kind}
                          displayName={vote.voter.displayName}
                          platform={vote.voter.platform}
                          size="sm"
                        />
                        <span className="font-semibold text-slate-800 dark:text-slate-100">
                          {vote.voter.displayName}
                        </span>
                        {vote.voter.platform ? (
                          <PlatformTagPill platform={vote.voter.platform} />
                        ) : null}
                        <SecurityTrustBadge
                          trustLevel={vote.voter.trustLevel}
                          isYou={vote.voter.isYou}
                        />
                      </div>
                      <div className="flex items-center gap-1.5">
                        {vote.preferredOptionKey ? (
                          <span className="rounded bg-slate-900/8 px-1.5 py-0.5 font-mono text-[10.5px] font-semibold text-slate-700 dark:bg-white/10 dark:text-slate-200">
                            倾向 {vote.preferredOptionKey}
                          </span>
                        ) : null}
                        <span
                          className={`rounded-full border px-2 py-0.5 text-[10.5px] font-semibold ${stanceMeta.pillClass}`}
                        >
                          {stanceMeta.label}
                        </span>
                      </div>
                    </div>
                    <p className="mt-1.5 text-[12px] leading-relaxed text-slate-600 dark:text-slate-300">
                      {vote.rationale}
                    </p>
                  </div>
                );
              })}
            </div>
          </>
        ) : (
          <p className="text-[11.5px] text-slate-400">
            暂未收到表态投票，可在群聊 `@` 各 Agent 请求结构化评议或直接由人类拍板。
          </p>
        )}
      </div>

      {/* 5. 人类交互区：补充评议表态 + 人类裁判最终拍板控制台 */}
      {isOpenInteractive ? (
        <div className="mt-4 space-y-3 border-t border-slate-200/80 pt-3.5 dark:border-white/[0.08]">
          {/* 折叠式人类投票/评议栏 */}
          <div>
            <button
              type="button"
              onClick={() => setVoteDrawerOpen((prev) => !prev)}
              className="inline-flex items-center gap-1.5 text-xs font-medium text-indigo-600 hover:text-indigo-500 dark:text-indigo-400"
            >
              <MessageSquarePlus className="h-3.5 w-3.5" />
              <span>补充一条我的立场评注 (Vote / Comment)</span>
              {voteDrawerOpen ? (
                <ChevronUp className="h-3.5 w-3.5" />
              ) : (
                <ChevronDown className="h-3.5 w-3.5" />
              )}
            </button>

            {voteDrawerOpen ? (
              <div className="mt-2 space-y-2 rounded-xl border border-slate-200 bg-slate-50/90 p-3 dark:border-white/10 dark:bg-white/[0.03]">
                <div className="flex flex-wrap gap-1.5">
                  {(["endorse", "challenge", "abstain"] as const).map((stance) => {
                    const active = voteStance === stance;
                    const label =
                      stance === "endorse"
                        ? "👍 赞同"
                        : stance === "challenge"
                          ? "⚡ 质疑"
                          : "⏸ 弃权";
                    return (
                      <button
                        key={stance}
                        type="button"
                        onClick={() => setVoteStance(stance)}
                        className={`rounded-lg border px-2.5 py-1 text-xs font-medium transition ${
                          active
                            ? "border-indigo-500 bg-indigo-600 text-white"
                            : "border-slate-200 bg-white text-slate-700 dark:border-white/10 dark:bg-white/[0.04] dark:text-slate-300"
                        }`}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
                <textarea
                  rows={2}
                  value={voteRationale}
                  onChange={(e) => setVoteRationale(e.target.value)}
                  placeholder="输入支持或质疑的核心论据..."
                  className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none dark:border-white/10 dark:bg-[#0b0e15] dark:text-slate-100"
                />
                <div className="flex justify-end">
                  <button
                    type="button"
                    disabled={Boolean(props.isSubmittingVote) || voteRationale.trim().length === 0}
                    onClick={handleVoteSubmit}
                    className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-indigo-500 disabled:opacity-50"
                  >
                    {props.isSubmittingVote ? "提交中..." : "提交表态"}
                  </button>
                </div>
              </div>
            ) : null}
          </div>

          {/* 人类裁判最终拍板栏 */}
          <div className="space-y-2 rounded-xl border border-amber-500/30 bg-amber-500/[0.06] p-3">
            <div className="flex items-center justify-between text-xs font-semibold text-amber-900 dark:text-amber-300">
              <span>⚖️ 人类裁判最终拍板 (Human Referee Decision)</span>
              <span className="font-mono text-[11px]">
                当前拟采纳：{selectedOptionKey || "未选"}
              </span>
            </div>
            <input
              type="text"
              value={decisionNote}
              onChange={(e) => setDecisionNote(e.target.value)}
              placeholder="可选：填写最终拍板理由或后续落地约束（将固化进群内 Decision 记录）"
              className="w-full rounded-lg border border-slate-200/90 bg-white px-2.5 py-1.5 text-xs text-slate-900 placeholder:text-slate-400 focus:border-amber-500 focus:outline-none dark:border-white/10 dark:bg-[#0b0e15] dark:text-slate-100"
            />
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={Boolean(props.isSubmittingDecision) || selectedOptionKey.length === 0}
                onClick={() => handleDecision("approved")}
                className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-emerald-600 px-3 py-2 text-xs font-semibold text-white shadow-xs transition hover:bg-emerald-500 disabled:opacity-50"
              >
                <CheckCircle2 className="h-3.5 w-3.5" />
                <span>
                  {props.isSubmittingDecision
                    ? "固化决策中..."
                    : `采纳方案 ${selectedOptionKey} (Approve)`}
                </span>
              </button>
              <button
                type="button"
                disabled={Boolean(props.isSubmittingDecision)}
                onClick={() => handleDecision("rejected")}
                className="inline-flex items-center justify-center gap-1 rounded-xl border border-rose-500/35 bg-rose-500/12 px-3 py-2 text-xs font-semibold text-rose-700 transition hover:bg-rose-500/20 disabled:opacity-50 dark:text-rose-300"
              >
                <XCircle className="h-3.5 w-3.5" />
                <span>驳回重议</span>
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </article>
  );
}
