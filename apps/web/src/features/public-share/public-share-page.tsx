/**
 * @module web/features/public-share/public-share-page
 * @description 免登录公开只读分享回放页（`/share/:inviteToken`）：以 Pachat 纯净白底聊天室实录 + 温润鼠尾草绿置顶结论便签的形态呈现多 Agent 讨论与人类拍板决议。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 零信任只读视图：复用纯展示型 `MessageBubble`（`readOnly={true}`）与 `ProposalCardView`（`interactive={false}`），不挂载任何写入或治理 Mutation。
 * 2. 四态完备体验：完整覆盖骨架加载态、未开启分享/404 错误态、空讨论态与富回放态。
 * 3. App Shell 与桌面拖拽约束：全局 `html/body/#root` 锁定 `100dvh + overflow: hidden`，本页自带 `h-dvh` 根容器与内部 `overflow-y-auto` 滚动区；顶栏同时声明 `data-tauri-drag-region` 与 `.app-drag-region`。
 * 4. 渲染纯函数化与去模板化视觉：日期分隔与连续消息分组仅基于消息自身的 `createdAtIso` 计算，绝不读取 `Date.now()`；全站统一 Pachat `#FFFFFF` / `#F5F5F7` / `#141414` 极简色阶，零蓝紫渐变。
 */
import type { MessageDto, ProposalCardDto, ProposalId, RoomMemberDto } from "@openhuddle/protocol";
import { queryOptions, useQuery } from "@tanstack/react-query";
import {
  AlertCircle,
  ArrowRight,
  Check,
  CheckCircle2,
  Copy,
  Eye,
  FileCheck2,
  Globe,
  MessagesSquare,
  Pin,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { Fragment, useMemo, useState } from "react";
import { BrandMark } from "../../components/brand-mark.js";
import { AppButton, AppTooltip, motion, toast } from "../../components/primitives/index.js";
import {
  AgentProfileDialog,
  type InspectedAgentProfile,
} from "../../components/ui/agent-profile-dialog.js";
import { PlatformAvatar } from "../../components/ui/identity-badges.js";
import { MessageBubble } from "../../components/ui/message-bubble.js";
import { ProposalCardView } from "../../components/ui/proposal-card-view.js";
import { ThemeToggle } from "../../components/ui/theme-toggle.js";
import { ApiClientError, fetchPublicShareReplay } from "../../lib/api-client.js";
import { formatMessageTimestamp } from "../../lib/format.js";
import { huddleQueryKeys } from "../../lib/query-keys.js";
import { navigateTo } from "../../lib/session-store.js";

/** 连续消息分组的最大时间间隔（毫秒），与 IM 惯例保持一致 */
const GROUPING_WINDOW_MS = 5 * 60_000;

/** 群头像堆叠最多展示的成员数 */
const MAX_STACKED_AVATARS = 6;

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

/**
 * 查找由某条消息发起的结构化提案。
 *
 * @param msg - 时间线消息
 * @param proposals - 快照中的全部提案
 * @returns 关联提案；不存在时为 `undefined`
 */
function findProposalForMessage(
  msg: MessageDto,
  proposals: ReadonlyArray<ProposalCardDto>,
): ProposalCardDto | undefined {
  return proposals.find((p) => p.originMessageSeq === msg.seq);
}

/**
 * 计算消息作者的稳定分组键（Agent 优先使用 `agentId`，人类使用 `userId`）。
 *
 * @param msg - 时间线消息
 * @returns 作者分组键
 */
function resolveAuthorKey(msg: MessageDto): string {
  return msg.author.agentId ?? msg.author.userId ?? `${msg.author.kind}:${msg.author.displayName}`;
}

/**
 * 判断当前消息是否应与上一条消息合并为同一发送者分组（隐藏头像与发送者头部）。
 *
 * @param prev - 上一条消息
 * @param current - 当前消息
 * @returns 是否合并分组
 */
function shouldGroupWithPrevious(prev: MessageDto | undefined, current: MessageDto): boolean {
  if (prev === undefined) {
    return false;
  }
  if (prev.type === "system" || current.type === "system") {
    return false;
  }
  if (prev.recalledAtIso !== undefined || resolveAuthorKey(prev) !== resolveAuthorKey(current)) {
    return false;
  }
  if (toDayKey(prev.createdAtIso) !== toDayKey(current.createdAtIso)) {
    return false;
  }
  const gap = Date.parse(current.createdAtIso) - Date.parse(prev.createdAtIso);
  return Number.isFinite(gap) && gap >= 0 && gap < GROUPING_WINDOW_MS;
}

/**
 * 提取 ISO 时间的本地日期键，用于聊天记录日期分隔行。
 *
 * @param iso - ISO-8601 时间字符串
 * @returns `YYYY-M-D` 形式的本地日期键
 */
function toDayKey(iso: string): string {
  const date = new Date(iso);
  return `${String(date.getFullYear())}-${String(date.getMonth() + 1)}-${String(date.getDate())}`;
}

/**
 * 将 ISO 时间格式化为日期分隔行文案。
 *
 * @param iso - ISO-8601 时间字符串
 * @returns 例如 `11月12日 周四`
 */
function formatDayDivider(iso: string): string {
  return new Date(iso).toLocaleDateString("zh-CN", {
    month: "long",
    day: "numeric",
    weekday: "short",
  });
}

/** `FinalDecisionCard` 入参属性 */
interface FinalDecisionCardProps {
  readonly proposal: ProposalCardDto;
  readonly onFocus: (proposalId: ProposalId) => void;
}

/**
 * 渲染置顶的人类最终拍板决议卡（Pachat 温润鼠尾草绿 `#E3F3EC` 便签形态）。
 *
 * @param props - 已批准的提案与聚焦回调
 * @returns 决议便签卡
 */
function FinalDecisionCard(props: FinalDecisionCardProps) {
  const { proposal } = props;
  const decidedOption = proposal.draft.options.find(
    (option) => option.optionKey === proposal.decidedOptionKey,
  );
  const endorseCount = proposal.votes.filter((vote) => vote.stance === "endorse").length;

  return (
    <motion.button
      type="button"
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", stiffness: 420, damping: 32 }}
      onClick={() => props.onFocus(proposal.id)}
      className="app-no-drag group block w-full cursor-pointer select-none rounded-[20px] bg-[#E3F3EC] p-4 text-left text-[#141414] ring-1 ring-inset ring-black/[0.05] transition hover:ring-black/[0.12] active:scale-[0.99] dark:bg-[#16271F] dark:text-[#E8F3EC] dark:ring-white/[0.08] dark:hover:ring-white/[0.16]"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#1E5638] dark:text-[#86E0A6]">
          <CheckCircle2 aria-hidden="true" className="h-3.5 w-3.5" />
          <span>已拍板结论</span>
        </span>
        <span className="text-[11px] text-[#456B56] dark:text-[#9ACBB0]">
          {endorseCount}/{proposal.votes.length} Agent 赞成
        </span>
      </div>
      <p className="mt-1.5 text-sm font-semibold leading-snug">{proposal.draft.title}</p>
      {decidedOption !== undefined ? (
        <div className="mt-2 rounded-[14px] bg-white/80 px-3 py-2 ring-1 ring-inset ring-black/[0.05] dark:bg-black/25 dark:ring-white/[0.08]">
          <p className="text-xs font-semibold text-[#141414] dark:text-zinc-100">
            选定方案：{decidedOption.label}
          </p>
          <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-[#5F5F64] dark:text-zinc-300">
            {decidedOption.summary}
          </p>
        </div>
      ) : null}
      {proposal.decisionNote !== undefined && proposal.decisionNote.length > 0 ? (
        <p className="mt-2 text-xs leading-relaxed text-[#3E6B52] dark:text-[#B3D8C3]">
          “{proposal.decisionNote}”
        </p>
      ) : null}
      <p className="mt-2 flex items-center gap-1.5 text-[11px] text-[#456B56] dark:text-[#9ACBB0]">
        <ShieldCheck aria-hidden="true" className="h-3.5 w-3.5 text-[#34C759]" />
        <span>
          {proposal.decidedBy !== undefined
            ? `${proposal.decidedBy.displayName} 拍板确认`
            : "由人类拍板确认"}
          {proposal.decidedAtIso !== undefined
            ? ` · ${formatMessageTimestamp(proposal.decidedAtIso)}`
            : ""}
        </span>
        <span className="ml-auto font-medium text-[#1E5638] opacity-0 transition group-hover:opacity-100 dark:text-[#86E0A6]">
          查看详情 →
        </span>
      </p>
    </motion.button>
  );
}

/**
 * 渲染 `/share/:inviteToken` 公开只读群聊回放页。
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
      toast.error("当前浏览器环境不支持一键复制，请直接复制地址栏链接");
      return;
    }
    void navigator.clipboard
      .writeText(window.location.href)
      .then(() => {
        setCopiedLink(true);
        toast.success("公开回放链接已复制", {
          description: "任何人无需登录即可只读浏览这段讨论与最终结论",
        });
        window.setTimeout(() => setCopiedLink(false), 1_800);
      })
      .catch(() => {
        toast.error("复制链接失败，请手动复制地址栏 URL");
      });
  };

  // 聚焦提案：同时高亮右栏卡片并滚动到其锚点（纯瞬时视觉反馈，直接操作 DOM 而不提升状态）
  const focusProposal = (proposalId: ProposalId): void => {
    setFocusedProposalId(proposalId);
    if (typeof document === "undefined") {
      return;
    }
    document
      .getElementById(`share-proposal-${proposalId}`)
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  const approvedProposals = snapshot
    ? snapshot.proposals.filter((p) => p.status === "approved")
    : [];
  const humanCount = snapshot
    ? snapshot.room.members.filter((m) => m.memberKind === "human").length
    : 0;
  const agentCount = snapshot ? snapshot.room.members.length - humanCount : 0;

  const errMsg =
    shareQuery.error instanceof ApiClientError
      ? shareQuery.error.message
      : shareQuery.error instanceof Error
        ? shareQuery.error.message
        : "这个群聊不存在，或群主已关闭公开分享权限。";

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-[#F8F8FA] text-[#141414] dark:bg-[#0E0E10] dark:text-zinc-100">
      {/* 顶部清爽标题栏：纯正 Figtree 粗体字标 + 胶囊按钮，支持 Tauri v2 与 Electron 无边框拖拽 */}
      <header
        data-tauri-drag-region=""
        className="app-drag-region pt-safe z-20 shrink-0 select-none border-b border-black/[0.06] bg-white/95 backdrop-blur-md dark:border-white/[0.07] dark:bg-[#0E0E10]/95"
      >
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <div className="flex min-w-0 items-center gap-2.5">
            <button
              type="button"
              onClick={() => navigateTo("/")}
              aria-label="返回 OpenHuddle 首页"
              className="app-no-drag flex cursor-pointer items-center gap-2 rounded-full px-1 py-0.5 transition hover:opacity-80 active:scale-[0.98]"
            >
              <BrandMark className="h-6 w-6 shrink-0" />
              <span className="text-[17px] font-bold tracking-[-0.025em] text-[#141414] dark:text-white">
                OpenHuddle
              </span>
            </button>
            <span className="pointer-events-none hidden items-center gap-1 rounded-full bg-[#F5F5F7] px-2.5 py-0.5 text-[11px] font-medium text-[#5F5F64] sm:inline-flex dark:bg-[#1C1C1F] dark:text-zinc-300">
              <Globe aria-hidden="true" className="h-3 w-3 text-[#34C759]" />
              <span>公开回放</span>
            </span>
          </div>

          <div className="app-no-drag flex items-center gap-2">
            <ThemeToggle />
            <AppTooltip content="复制公开只读回放链接" side="bottom">
              <AppButton
                variant="secondary"
                size="sm"
                leadingIcon={
                  copiedLink ? (
                    <Check aria-hidden="true" className="h-3.5 w-3.5 text-[#34C759]" />
                  ) : (
                    <Copy aria-hidden="true" className="h-3.5 w-3.5" />
                  )
                }
                onClick={handleCopyShareUrl}
              >
                <span className="hidden sm:inline">{copiedLink ? "已复制" : "复制链接"}</span>
              </AppButton>
            </AppTooltip>
            <AppButton
              variant="primary"
              size="sm"
              trailingIcon={<ArrowRight aria-hidden="true" className="h-3.5 w-3.5" />}
              onClick={() => navigateTo("/")}
            >
              打开 OpenHuddle
            </AppButton>
          </div>
        </div>
      </header>

      {/* 内部滚动区：全局 body 已锁定 100dvh 滚动 */}
      <main className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {shareQuery.isPending ? (
          <div className="mx-auto grid max-w-6xl gap-6 px-4 py-6 sm:px-6 lg:grid-cols-12">
            <div className="space-y-4 lg:col-span-8">
              <div className="h-16 animate-pulse rounded-[24px] bg-black/[0.05] dark:bg-white/[0.05]" />
              {[1, 2, 3, 4].map((sk) => (
                <div
                  key={`share-msg-sk-${String(sk)}`}
                  className={`flex items-start gap-2.5 ${sk % 2 === 0 ? "flex-row-reverse" : ""}`}
                >
                  <div className="h-9 w-9 animate-pulse rounded-full bg-black/[0.06] dark:bg-white/[0.06]" />
                  <div className="h-16 w-2/3 animate-pulse rounded-[18px] bg-black/[0.04] dark:bg-white/[0.04]" />
                </div>
              ))}
            </div>
            <div className="hidden h-72 animate-pulse rounded-[24px] bg-black/[0.04] lg:col-span-4 lg:block dark:bg-white/[0.04]" />
          </div>
        ) : shareQuery.isError || !snapshot ? (
          <div className="mx-auto my-16 max-w-md px-4">
            <motion.div
              initial={{ opacity: 0, y: 12, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              transition={{ type: "spring", stiffness: 420, damping: 32 }}
              className="rounded-[28px] bg-white p-7 text-center shadow-[0_20px_60px_rgba(0,0,0,0.06)] ring-1 ring-black/[0.07] dark:bg-[#151518] dark:ring-white/[0.09]"
            >
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-[#F5F5F7] text-[#141414] dark:bg-[#242428] dark:text-zinc-200">
                <AlertCircle aria-hidden="true" className="h-5 w-5" />
              </div>
              <h1 className="mt-4 text-base font-semibold text-[#141414] dark:text-zinc-100">
                暂时打不开这段群聊回放
              </h1>
              <p className="mt-1.5 text-xs leading-relaxed text-[#6E6E73] dark:text-zinc-400">
                {errMsg}
              </p>
              <div className="mt-6 flex select-none items-center justify-center gap-2.5">
                <AppButton
                  variant="secondary"
                  size="md"
                  leadingIcon={<RefreshCw aria-hidden="true" className="h-3.5 w-3.5" />}
                  onClick={() => void shareQuery.refetch()}
                >
                  重试
                </AppButton>
                <AppButton
                  variant="primary"
                  size="md"
                  trailingIcon={<ArrowRight aria-hidden="true" className="h-3.5 w-3.5" />}
                  onClick={() => navigateTo("/")}
                >
                  进入 OpenHuddle
                </AppButton>
              </div>
            </motion.div>
          </div>
        ) : (
          <div className="mx-auto grid max-w-6xl items-start gap-6 px-0 py-0 sm:px-6 sm:py-6 lg:grid-cols-12">
            {/* 左栏：纯净白底 Pachat 群聊记录主舞台 */}
            <motion.section
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ type: "spring", stiffness: 380, damping: 32 }}
              className="flex min-w-0 flex-col overflow-hidden bg-white sm:rounded-[28px] sm:shadow-[0_18px_50px_rgba(0,0,0,0.05)] sm:ring-1 sm:ring-black/[0.07] lg:col-span-8 dark:bg-[#141416] dark:sm:shadow-[0_22px_60px_rgba(0,0,0,0.5)] dark:sm:ring-white/[0.08]"
            >
              {/* 群头：圆形暖纸图标 + 群标题 + 圆形粉彩成员头像叠放 */}
              <div className="flex select-none items-center gap-3 border-b border-black/[0.06] px-4 py-3.5 sm:px-6 dark:border-white/[0.07]">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#F5F5F7] text-[#141414] ring-1 ring-inset ring-black/[0.05] dark:bg-[#222226] dark:text-zinc-100 dark:ring-white/[0.08]">
                  <MessagesSquare aria-hidden="true" className="h-4.5 w-4.5" />
                </div>
                <div className="min-w-0 flex-1">
                  <h1 className="truncate text-[16px] font-semibold tracking-[-0.015em] text-[#141414] dark:text-zinc-100">
                    {snapshot.room.name}
                  </h1>
                  <p className="truncate text-xs text-[#8E8E93] dark:text-zinc-400">
                    {humanCount} 位成员 · {agentCount} 个 Agent · {snapshot.messages.length} 条消息
                  </p>
                </div>

                <div className="hidden -space-x-2 sm:flex">
                  {snapshot.room.members.slice(0, MAX_STACKED_AVATARS).map((member) => (
                    <AppTooltip
                      key={`share-stack-${member.agentId ?? member.userId ?? member.displayName}`}
                      content={
                        member.ownerDisplayName !== undefined && member.memberKind === "agent"
                          ? `${member.displayName} · ${member.ownerDisplayName} 的 Agent`
                          : member.displayName
                      }
                      side="bottom"
                    >
                      <span className="rounded-full ring-2 ring-white dark:ring-[#141416]">
                        <PlatformAvatar
                          kind={member.memberKind}
                          displayName={member.displayName}
                          platform={member.platform}
                          size="sm"
                        />
                      </span>
                    </AppTooltip>
                  ))}
                  {snapshot.room.members.length > MAX_STACKED_AVATARS ? (
                    <span className="flex h-7 w-7 items-center justify-center rounded-full bg-[#F5F5F7] text-[10.5px] font-medium text-[#5F5F64] ring-2 ring-white dark:bg-[#27272A] dark:text-zinc-300 dark:ring-[#141416]">
                      +{snapshot.room.members.length - MAX_STACKED_AVATARS}
                    </span>
                  ) : null}
                </div>
              </div>

              {/* 讨论主题 + 置顶已拍板结论 */}
              {snapshot.room.topic.length > 0 || approvedProposals.length > 0 ? (
                <div className="space-y-3 border-b border-black/[0.06] bg-[#F8F8FA] px-4 py-3.5 sm:px-6 dark:border-white/[0.07] dark:bg-[#18181B]">
                  {snapshot.room.topic.length > 0 ? (
                    <p className="flex items-start gap-2 text-xs leading-relaxed text-[#5F5F64] dark:text-zinc-300">
                      <Pin
                        aria-hidden="true"
                        className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#8E8E93]"
                      />
                      <span>
                        <span className="font-semibold text-[#141414] dark:text-zinc-100">
                          讨论主题：
                        </span>
                        {snapshot.room.topic}
                      </span>
                    </p>
                  ) : null}
                  {approvedProposals.map((proposal) => (
                    <FinalDecisionCard
                      key={`pinned-${proposal.id}`}
                      proposal={proposal}
                      onFocus={focusProposal}
                    />
                  ))}
                </div>
              ) : null}

              {/* 纯净无网格聊天画布 */}
              <div className="bg-white px-3.5 py-4 sm:px-6 dark:bg-[#0E0E10]">
                {snapshot.messages.length === 0 ? (
                  <div className="py-16 text-center text-xs text-[#8E8E93] dark:text-zinc-500">
                    这个群还没有公开的聊天记录。
                  </div>
                ) : (
                  <div>
                    {snapshot.messages.map((msg, index) => {
                      const prev = index > 0 ? snapshot.messages[index - 1] : undefined;
                      const showDayDivider =
                        prev === undefined ||
                        toDayKey(prev.createdAtIso) !== toDayKey(msg.createdAtIso);
                      const replied =
                        msg.replyToSeq !== undefined ? messageBySeq.get(msg.replyToSeq) : undefined;
                      const linkedProposal = findProposalForMessage(msg, snapshot.proposals);
                      const agentMember =
                        msg.author.agentId !== undefined
                          ? memberByAgentId.get(msg.author.agentId)
                          : undefined;

                      return (
                        <Fragment key={msg.seq}>
                          {showDayDivider ? (
                            <div className="my-4 flex select-none justify-center first:mt-0">
                              <span className="text-xs text-[#8E8E93] dark:text-zinc-500">
                                {formatDayDivider(msg.createdAtIso)}
                              </span>
                            </div>
                          ) : null}
                          <MessageBubble
                            message={msg}
                            repliedMessage={replied}
                            linkedProposal={linkedProposal}
                            authorOwnerName={agentMember?.ownerDisplayName}
                            authorReach={agentMember?.reach}
                            nowMs={0}
                            readOnly={true}
                            isGroupedWithPrevious={
                              !showDayDivider && shouldGroupWithPrevious(prev, msg)
                            }
                            onOpenProposal={focusProposal}
                            onInspectAgent={(profile) => setInspectedAgent(profile)}
                          />
                        </Fragment>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* 底部只读提示与建群引导栏 */}
              <div className="pb-safe flex select-none flex-wrap items-center justify-between gap-3 border-t border-black/[0.06] bg-[#F8F8FA] px-4 py-3 sm:px-6 dark:border-white/[0.07] dark:bg-[#151518]">
                <div className="flex min-w-0 items-center gap-2 rounded-full bg-[#EFEFF3] px-3.5 py-2 text-xs text-[#6E6E73] dark:bg-[#222226] dark:text-zinc-400">
                  <Eye aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">只读回放 · 访客无需登录即可阅读，无法直接发言</span>
                </div>
                <AppButton
                  variant="primary"
                  size="md"
                  trailingIcon={<ArrowRight aria-hidden="true" className="h-3.5 w-3.5" />}
                  onClick={() => navigateTo("/")}
                >
                  把我的 AI 也拉进群聊
                </AppButton>
              </div>
            </motion.section>

            {/* 右栏：提案与结论 */}
            <motion.aside
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ type: "spring", stiffness: 380, damping: 32, delay: 0.06 }}
              className="space-y-3 px-4 pb-8 sm:px-0 lg:sticky lg:top-6 lg:col-span-4 lg:max-h-[calc(100dvh-6rem)] lg:overflow-y-auto lg:pb-0"
            >
              <h2 className="flex select-none items-center gap-1.5 px-1 text-xs font-semibold text-[#5F5F64] dark:text-zinc-400">
                <FileCheck2 aria-hidden="true" className="h-3.5 w-3.5" />
                <span>提案与结论 · {snapshot.proposals.length}</span>
              </h2>
              {snapshot.proposals.length === 0 ? (
                <div className="rounded-[22px] bg-white p-6 text-center text-xs text-[#8E8E93] ring-1 ring-black/[0.06] dark:bg-[#151518] dark:text-zinc-500 dark:ring-white/[0.08]">
                  这段讨论尚未发起正式提案卡。
                </div>
              ) : (
                <div className="space-y-4">
                  {snapshot.proposals.map((proposal, index) => (
                    <motion.div
                      key={proposal.id}
                      id={`share-proposal-${proposal.id}`}
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{
                        type: "spring",
                        stiffness: 400,
                        damping: 32,
                        delay: 0.1 + index * 0.05,
                      }}
                    >
                      <ProposalCardView
                        proposal={proposal}
                        interactive={false}
                        highlighted={focusedProposalId === proposal.id}
                      />
                    </motion.div>
                  ))}
                </div>
              )}
              <p className="flex items-start gap-1.5 px-1 text-[11px] leading-relaxed text-[#8E8E93] dark:text-zinc-500">
                <ShieldCheck
                  aria-hidden="true"
                  className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#34C759]"
                />
                <span>公开回放已剥离房间邀请密钥，所有内容均以外部访客只读视角呈现。</span>
              </p>
            </motion.aside>
          </div>
        )}
      </main>

      <AgentProfileDialog profile={inspectedAgent} onClose={() => setInspectedAgent(null)} />
    </div>
  );
}
