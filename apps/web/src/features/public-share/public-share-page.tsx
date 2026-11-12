/**
 * @module web/features/public-share/public-share-page
 * @description 免登录公开只读分享回放页（`/share/:inviteToken`），呈现完整多 Agent 辩论时间线、结构化方案对比与人类最终拍板结论。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 零信任只读视图：复用纯展示型 `MessageBubble`（`readOnly={true}`）与 `ProposalCardView`（`interactive={false}`），不挂载任何写入或治理 Mutation。
 * 2. 四态完备体验：完整覆盖骨架加载态、未开启分享/404 错误态、空讨论态与双栏富回放态。
 */
import type { MessageDto, ProposalCardDto, ProposalId, RoomMemberDto } from "@openhuddle/protocol";
import { queryOptions, useQuery } from "@tanstack/react-query";
import {
  AlertCircle,
  ArrowRight,
  Award,
  Check,
  Copy,
  Globe,
  Hash,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Users,
} from "lucide-react";
import { useMemo, useState } from "react";
import { BrandMark } from "../../components/brand-mark.js";
import {
  AgentProfileDialog,
  type InspectedAgentProfile,
} from "../../components/ui/agent-profile-dialog.js";
import { PlatformAvatar, PlatformTagPill } from "../../components/ui/identity-badges.js";
import { MessageBubble } from "../../components/ui/message-bubble.js";
import { ProposalCardView } from "../../components/ui/proposal-card-view.js";
import { ThemeToggle } from "../../components/ui/theme-toggle.js";
import { ApiClientError, fetchPublicShareReplay } from "../../lib/api-client.js";
import { huddleQueryKeys } from "../../lib/query-keys.js";
import { navigateTo } from "../../lib/session-store.js";

/**
 * 构造公开只读回放数据的标准化 `queryOptions`。
 *
 * @param inviteToken - 分享链接中的房间邀请令牌
 * @returns TanStack Query 查询配置
 */
export function publicShareReplayQueryOptions(inviteToken: string) {
  return queryOptions({
    queryKey: huddleQueryKeys.publicShare(inviteToken),
    queryFn: () => fetchPublicShareReplay(inviteToken),
    retry: false,
  });
}

/** `PublicSharePage` 入参属性 */
export interface PublicSharePageProps {
  readonly inviteToken: string;
}

function extractProposalIdFromMessage(
  msg: MessageDto,
  proposals: ReadonlyArray<ProposalCardDto>,
): ProposalCardDto | undefined {
  return proposals.find((p) => p.originMessageSeq === msg.seq);
}

/**
 * 渲染 `/share/:inviteToken` 公开只读 Huddle 决策档案回放页。
 *
 * @param props - 包含 `inviteToken` 的页面属性
 * @returns 公开分享回放视图
 */
export function PublicSharePage(props: PublicSharePageProps) {
  const shareQuery = useQuery(publicShareReplayQueryOptions(props.inviteToken));
  const [copiedLink, setCopiedLink] = useState<boolean>(false);
  const [focusedProposalId, setFocusedProposalId] = useState<ProposalId | null>(null);
  const [inspectedAgent, setInspectedAgent] = useState<InspectedAgentProfile | null>(null);

  const snapshot = shareQuery.data;

  const messageBySeq = useMemo(() => {
    const map = new Map<number, MessageDto>();
    if (snapshot) {
      for (const msg of snapshot.messages) {
        map.set(msg.seq, msg);
      }
    }
    return map;
  }, [snapshot]);

  const memberByAgentId = useMemo(() => {
    const map = new Map<string, RoomMemberDto>();
    if (snapshot) {
      for (const member of snapshot.room.members) {
        if (member.memberKind === "agent" && member.agentId !== undefined) {
          map.set(member.agentId, member);
        }
      }
    }
    return map;
  }, [snapshot]);

  const handleCopyShareUrl = (): void => {
    if (typeof window === "undefined" || !navigator.clipboard) {
      return;
    }
    void navigator.clipboard.writeText(window.location.href).then(() => {
      setCopiedLink(true);
      window.setTimeout(() => setCopiedLink(false), 1_800);
    });
  };

  const approvedProposals = snapshot
    ? snapshot.proposals.filter((p) => p.status === "approved")
    : [];

  const errMsg =
    shareQuery.error instanceof ApiClientError
      ? shareQuery.error.message
      : shareQuery.error instanceof Error
        ? shareQuery.error.message
        : "该协作房间不存在或群主已关闭公开分享权限。";

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 dark:bg-[#090b10] dark:text-slate-100">
      {/* 顶部公开档案横幅 */}
      <header className="sticky top-0 z-20 border-b border-slate-200/85 bg-white/90 backdrop-blur-md dark:border-white/[0.08] dark:bg-[#0c0f17]/90">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={() => navigateTo("/")}
              className="flex h-8 w-8 items-center justify-center rounded-xl shadow-xs"
            >
              <BrandMark className="h-8 w-8 rounded-xl" />
            </button>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-sm font-bold tracking-tight text-slate-900 dark:text-white">
                  OpenHuddle
                </span>
                <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/35 bg-emerald-500/12 px-2 py-0.5 text-[10.5px] font-semibold text-emerald-700 dark:text-emerald-300">
                  <Globe className="h-3 w-3" />
                  <span>Public Read-Only Replay</span>
                </span>
              </div>
              <p className="text-[11px] text-slate-500 dark:text-slate-400">
                多智能体交叉辩论与人类最终拍板公开档案
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <ThemeToggle />
            <button
              type="button"
              onClick={handleCopyShareUrl}
              className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 transition hover:bg-slate-50 dark:border-white/10 dark:bg-white/[0.04] dark:text-slate-200 dark:hover:bg-white/[0.08]"
            >
              {copiedLink ? (
                <>
                  <Check className="h-3.5 w-3.5 text-emerald-500" />
                  <span>已复制链接</span>
                </>
              ) : (
                <>
                  <Copy className="h-3.5 w-3.5" />
                  <span>分享此回放</span>
                </>
              )}
            </button>

            <button
              type="button"
              onClick={() => navigateTo("/")}
              className="inline-flex items-center gap-1.5 rounded-xl bg-indigo-600 px-3.5 py-1.5 text-xs font-semibold text-white shadow-xs transition hover:bg-indigo-500"
            >
              <span>打开我的协作舱</span>
              <ArrowRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
        {shareQuery.isPending ? (
          <div className="space-y-4">
            <div className="h-28 animate-pulse rounded-2xl bg-slate-200/75 dark:bg-white/[0.04]" />
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
              <div className="space-y-3 lg:col-span-7">
                {[1, 2, 3].map((sk) => (
                  <div
                    key={`share-msg-sk-${String(sk)}`}
                    className="h-24 animate-pulse rounded-2xl bg-slate-200/70 dark:bg-white/[0.04]"
                  />
                ))}
              </div>
              <div className="h-72 animate-pulse rounded-2xl bg-slate-200/70 lg:col-span-5 dark:bg-white/[0.04]" />
            </div>
          </div>
        ) : shareQuery.isError || !snapshot ? (
          <div className="mx-auto my-16 max-w-lg rounded-2xl border border-rose-500/30 bg-white p-6 text-center shadow-sm dark:bg-[#111520]">
            <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-2xl bg-rose-500/12 text-rose-600 dark:text-rose-400">
              <AlertCircle className="h-6 w-6" />
            </div>
            <h1 className="mt-3 text-base font-bold text-slate-900 dark:text-white">
              无法访问该公开回放档案
            </h1>
            <p className="mt-1.5 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
              {errMsg}
            </p>
            <div className="mt-5 flex items-center justify-center gap-2.5">
              <button
                type="button"
                onClick={() => void shareQuery.refetch()}
                className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 px-3.5 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 dark:border-white/10 dark:text-slate-200"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                <span>重试加载</span>
              </button>
              <button
                type="button"
                onClick={() => navigateTo("/")}
                className="inline-flex items-center gap-1.5 rounded-xl bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-500"
              >
                <span>前往登录协作舱</span>
                <ArrowRight className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-6">
            {/* 房间概览头与参会阵容卡片 */}
            <section className="rounded-2xl border border-slate-200/90 bg-white p-5 shadow-2xs dark:border-white/[0.08] dark:bg-[#10141e]">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="space-y-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <Hash className="h-5 w-5 text-indigo-500" />
                    <h1 className="text-xl font-bold tracking-tight text-slate-900 dark:text-white">
                      {snapshot.room.name}
                    </h1>
                    <span className="rounded-lg bg-slate-100 px-2 py-0.5 font-mono text-xs text-slate-600 dark:bg-white/[0.06] dark:text-slate-300">
                      共 {snapshot.messages.length} 条记录 · {snapshot.proposals.length} 份提案
                    </span>
                  </div>
                  {snapshot.room.topic.length > 0 ? (
                    <p className="text-sm text-slate-600 dark:text-slate-300">
                      {snapshot.room.topic}
                    </p>
                  ) : null}
                </div>

                {approvedProposals.length > 0 ? (
                  <div className="inline-flex items-center gap-2 rounded-xl border border-emerald-500/35 bg-emerald-500/10 px-3.5 py-2 text-xs font-semibold text-emerald-800 dark:text-emerald-300">
                    <Award className="h-4 w-4 text-emerald-500" />
                    <span>已固化 {approvedProposals.length} 项人类拍板决议</span>
                  </div>
                ) : null}
              </div>

              {/* 参会人类与个人 Agent 徽章列 */}
              <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3.5 dark:border-white/[0.06]">
                <span className="inline-flex items-center gap-1 text-xs font-medium text-slate-500 dark:text-slate-400">
                  <Users className="h-3.5 w-3.5" />
                  <span>参会阵容 ({snapshot.room.members.length}):</span>
                </span>
                {snapshot.room.members.map((member) => (
                  <span
                    key={`share-mem-${member.agentId ?? member.userId ?? member.displayName}`}
                    className="inline-flex items-center gap-1.5 rounded-full border border-slate-200/80 bg-slate-50 px-2.5 py-1 text-xs dark:border-white/10 dark:bg-white/[0.03]"
                  >
                    <PlatformAvatar
                      kind={member.memberKind}
                      displayName={member.displayName}
                      platform={member.platform}
                      size="sm"
                    />
                    <span className="font-medium text-slate-800 dark:text-slate-200">
                      {member.displayName}
                    </span>
                    {member.platform ? <PlatformTagPill platform={member.platform} /> : null}
                  </span>
                ))}
              </div>

              <p className="mt-3 flex items-center gap-1.5 text-[11px] text-slate-400 dark:text-slate-500">
                <ShieldCheck className="h-3.5 w-3.5 text-emerald-500" />
                <span>
                  零信任脱敏保护已开启：公开快照已剥离房间邀请密钥，并将全部发言重盖章为外部观察者只读视角。
                </span>
              </p>
            </section>

            {/* 双栏布局：左栏完整讨论时间线，右栏结构化提案与人类拍板卡 */}
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
              <section className="space-y-3 lg:col-span-7">
                <h2 className="px-1 text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                  Discussion Timeline ({snapshot.messages.length})
                </h2>
                {snapshot.messages.length === 0 ? (
                  <div className="rounded-2xl border border-dashed border-slate-300 bg-white/60 p-8 text-center text-xs text-slate-500 dark:border-white/10 dark:bg-white/[0.02]">
                    该房间尚无公开讨论消息。
                  </div>
                ) : (
                  <div className="space-y-3">
                    {snapshot.messages.map((msg) => {
                      const replied =
                        msg.replyToSeq !== undefined ? messageBySeq.get(msg.replyToSeq) : undefined;
                      const linkedProposal = extractProposalIdFromMessage(msg, snapshot.proposals);
                      const agentMember =
                        msg.author.agentId !== undefined
                          ? memberByAgentId.get(msg.author.agentId)
                          : undefined;

                      return (
                        <MessageBubble
                          key={msg.seq}
                          message={msg}
                          repliedMessage={replied}
                          linkedProposal={linkedProposal}
                          authorOwnerName={agentMember?.ownerDisplayName}
                          authorReach={agentMember?.reach}
                          nowMs={0}
                          readOnly={true}
                          onOpenProposal={(pid) => setFocusedProposalId(pid)}
                          onInspectAgent={(profile) => setInspectedAgent(profile)}
                        />
                      );
                    })}
                  </div>
                )}
              </section>

              <aside className="space-y-3 lg:col-span-5">
                <h2 className="flex items-center gap-1.5 px-1 text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                  <Sparkles className="h-3.5 w-3.5 text-indigo-500" />
                  <span>Proposals &amp; Human Decisions ({snapshot.proposals.length})</span>
                </h2>
                {snapshot.proposals.length === 0 ? (
                  <div className="rounded-2xl border border-dashed border-slate-300 bg-white/60 p-6 text-center text-xs text-slate-500 dark:border-white/10 dark:bg-white/[0.02]">
                    该房间暂未发起结构化提案卡片。
                  </div>
                ) : (
                  <div className="space-y-4">
                    {snapshot.proposals.map((proposal) => (
                      <ProposalCardView
                        key={proposal.id}
                        proposal={proposal}
                        interactive={false}
                        highlighted={focusedProposalId === proposal.id}
                      />
                    ))}
                  </div>
                )}
              </aside>
            </div>
          </div>
        )}
      </main>

      <AgentProfileDialog profile={inspectedAgent} onClose={() => setInspectedAgent(null)} />
    </div>
  );
}
