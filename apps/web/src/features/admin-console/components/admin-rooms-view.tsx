/**
 * @module web/features/admin-console/rooms-view
 * @description 群聊房间列表与跨房内容审查、成员/提案核查、治理策略热调控及解散控制视图。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 只读审查绝不污染用户游标：查询任意房间消息流直连 `/api/v1/admin/rooms/:roomId/messages`，绝不推进任何成员 `last_read_seq`。
 * 2. 一键强制撤回不受 2 分钟窗口限制：合规监管时可附带原因即时撤回任意历史消息并同步广播给在线前端。
 */
import type {
  ActorKind,
  AdminRoomItem,
  GovernanceMode,
  MessageDto,
  MessageType,
  ProposalId,
  RoomGovernanceStatus,
  RoomId,
  RoomVisibility,
} from "@openhuddle/protocol";
import { useQuery } from "@tanstack/react-query";
import {
  CheckSquare,
  MessageSquare,
  PauseCircle,
  PlayCircle,
  RotateCcw,
  Save,
  Search,
  ShieldAlert,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { useEffect, useId, useState } from "react";
import {
  AppButton,
  AppInput,
  AppSelect,
  type AppSelectOption,
  AppSheetDrawer,
  AppSwitch,
  AppTextarea,
  IconButton,
  type SegmentedTabItem,
  SegmentedTabs,
} from "../../../components/primitives/index.js";
import { getPlatformVisualMeta, getReachVisualMeta } from "../../../lib/format.js";
import {
  adminRoomDetailQueryOptions,
  adminRoomMessagesQueryOptions,
  adminRoomsQueryOptions,
  useAdminDeleteProposalMutation,
  useAdminDeleteRoomMutation,
  useAdminRecallMessageMutation,
  useAdminUpdateRoomMutation,
} from "../api/admin-console.queries.js";
import {
  AdminConfirmModal,
  AdminEmptyState,
  AdminErrorState,
  AdminPaginationBar,
  AdminStatusPill,
  AdminTableSkeleton,
  formatAdminDateTime,
} from "./admin-shared-ui.js";

type VisibilityFilter = "__all__" | RoomVisibility;
type GovStatusFilter = "__all__" | RoomGovernanceStatus;
type AuthorFilter = "__all__" | ActorKind;
type MsgTypeFilter = "__all__" | MessageType;
type DrawerTab = "messages" | "members_proposals" | "governance";

const VISIBILITY_FILTER_OPTIONS: ReadonlyArray<AppSelectOption<VisibilityFilter>> = [
  { value: "__all__", label: "全部可见性" },
  { value: "invite_only", label: "仅邀请加入" },
  { value: "public_shareable", label: "公开可分享" },
];

const VISIBILITY_EDIT_OPTIONS: ReadonlyArray<AppSelectOption<RoomVisibility>> = [
  { value: "invite_only", label: "仅限邀请加入 (invite_only)" },
  { value: "public_shareable", label: "允许公开只读分享 (public_shareable)" },
];

const GOV_STATUS_OPTIONS: ReadonlyArray<AppSelectOption<GovStatusFilter>> = [
  { value: "__all__", label: "全部运行态" },
  { value: "active", label: "正常活跃" },
  { value: "paused_budget", label: "轮次预算挂起" },
];

const GOV_MODE_OPTIONS: ReadonlyArray<AppSelectOption<GovernanceMode>> = [
  { value: "free", label: "自由讨论 (free)" },
  { value: "round_table", label: "圆桌轮流表态 (round_table)" },
  { value: "proposal", label: "提案收敛模式 (proposal)" },
];

const AUTHOR_FILTER_OPTIONS: ReadonlyArray<AppSelectOption<AuthorFilter>> = [
  { value: "__all__", label: "全部发送方" },
  { value: "human", label: "人类成员" },
  { value: "agent", label: "智能体 Agent" },
];

const MSG_TYPE_FILTER_OPTIONS: ReadonlyArray<AppSelectOption<MsgTypeFilter>> = [
  { value: "__all__", label: "全部消息类型" },
  { value: "text", label: "文本消息" },
  { value: "proposal", label: "提案锚点" },
  { value: "vote", label: "表态投票" },
  { value: "decision", label: "人类拍板" },
  { value: "attention", label: "结构化等人" },
  { value: "system", label: "系统事件" },
];

const DRAWER_TABS: ReadonlyArray<SegmentedTabItem<DrawerTab>> = [
  { value: "messages", label: "内容审查" },
  { value: "members_proposals", label: "成员与提案" },
  { value: "governance", label: "治理热调控" },
];

/**
 * 房间监管抽屉主体内容。
 */
function AdminRoomDetailDrawerContent(props: {
  readonly roomId: RoomId;
  readonly onDeletedClose: () => void;
}) {
  const idPrefix = useId();
  const detailQuery = useQuery(adminRoomDetailQueryOptions(props.roomId));
  const updateRoomMutation = useAdminUpdateRoomMutation();
  const recallMutation = useAdminRecallMessageMutation();
  const deleteRoomMutation = useAdminDeleteRoomMutation();
  const deleteProposalMutation = useAdminDeleteProposalMutation();

  const [drawerTab, setDrawerTab] = useState<DrawerTab>("messages");

  // 消息审查筛选状态
  const [msgSearch, setMsgSearch] = useState<string>("");
  const [authorFilter, setAuthorFilter] = useState<AuthorFilter>("__all__");
  const [typeFilter, setTypeFilter] = useState<MsgTypeFilter>("__all__");
  const [includeRecalled, setIncludeRecalled] = useState<boolean>(true);
  const [beforeSeq, setBeforeSeq] = useState<number | undefined>(undefined);
  const [pendingRecallMsg, setPendingRecallMsg] = useState<MessageDto | null>(null);
  const [recallReason, setRecallReason] = useState<string>("");

  // 治理与元信息编辑表单状态
  const [nameDraft, setNameDraft] = useState<string>("");
  const [topicDraft, setTopicDraft] = useState<string>("");
  const [rulesDraft, setRulesDraft] = useState<string>("");
  const [visibilityDraft, setVisibilityDraft] = useState<RoomVisibility>("invite_only");
  const [modeDraft, setModeDraft] = useState<GovernanceMode>("free");
  const [allowMentionsDraft, setAllowMentionsDraft] = useState<boolean>(true);
  const [requireReadDraft, setRequireReadDraft] = useState<boolean>(true);
  const [maxTurnsDraft, setMaxTurnsDraft] = useState<string>("6");
  const [cooldownMsDraft, setCooldownMsDraft] = useState<string>("3000");

  const [pendingDeleteProposalId, setPendingDeleteProposalId] = useState<ProposalId | null>(null);
  const [deleteRoomConfirmOpen, setDeleteRoomConfirmOpen] = useState<boolean>(false);

  const roomMeta = detailQuery.data?.room;
  useEffect(() => {
    if (roomMeta !== undefined) {
      setNameDraft(roomMeta.name);
      setTopicDraft(roomMeta.topic);
      setRulesDraft(roomMeta.rules);
      setVisibilityDraft(roomMeta.visibility);
      setModeDraft(roomMeta.governance.config.mode);
      setAllowMentionsDraft(roomMeta.governance.config.allowAgentMentions);
      setRequireReadDraft(roomMeta.governance.config.requireReadBeforeSend);
      setMaxTurnsDraft(String(roomMeta.governance.config.maxConsecutiveAgentTurns));
      setCooldownMsDraft(String(roomMeta.governance.config.agentCooldownMs));
    }
  }, [roomMeta]);

  const messagesQuery = useQuery(
    adminRoomMessagesQueryOptions(props.roomId, {
      limit: 60,
      ...(beforeSeq !== undefined ? { beforeSeq } : {}),
      ...(msgSearch.trim().length > 0 ? { search: msgSearch.trim() } : {}),
      ...(authorFilter !== "__all__" ? { authorKind: authorFilter } : {}),
      ...(typeFilter !== "__all__" ? { type: typeFilter } : {}),
      includeRecalled,
    }),
  );

  if (detailQuery.isPending) {
    return <AdminTableSkeleton rows={5} />;
  }

  if (detailQuery.isError || !detailQuery.data) {
    return (
      <AdminErrorState
        title="加载群聊监管详情失败"
        message={detailQuery.error instanceof Error ? detailQuery.error.message : "请稍后重试"}
        onRetry={() => void detailQuery.refetch()}
      />
    );
  }

  const detail = detailQuery.data;
  const r = detail.room;

  const handleSaveGovernance = (renewBudget: boolean): void => {
    const parsedTurns = Math.min(50, Math.max(1, Number(maxTurnsDraft) || 6));
    const parsedCooldown = Math.min(60_000, Math.max(0, Number(cooldownMsDraft) || 0));
    updateRoomMutation.mutate({
      roomId: r.id,
      body: {
        name: nameDraft.trim() || r.name,
        topic: topicDraft.trim(),
        rules: rulesDraft.trim(),
        visibility: visibilityDraft,
        mode: modeDraft,
        allowAgentMentions: allowMentionsDraft,
        requireReadBeforeSend: requireReadDraft,
        maxConsecutiveAgentTurns: parsedTurns,
        agentCooldownMs: parsedCooldown,
        ...(renewBudget ? { renewBudget: true } : {}),
      },
    });
  };

  return (
    <div className="space-y-4 p-4 sm:p-5">
      {/* 1. 房间状态摘要卡 */}
      <div className="rounded-2xl border border-black/[0.06] bg-black/[0.02] p-4 dark:border-white/[0.07] dark:bg-white/[0.03]">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <h3 className="truncate text-[15px] font-semibold text-[#111318] dark:text-[#ECEFF6]">
              {r.name}
            </h3>
            <p className="mt-0.5 text-xs text-[#687082] dark:text-[#8E96AB]">
              群主：{r.ownerDisplayName} ({r.ownerEmail})
            </p>
            <p className="mt-1 font-mono text-[11px] text-[#939BAD] dark:text-[#63636B]">
              {r.id} · 邀请码 {detail.inviteToken}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <AdminStatusPill tone={r.governance.status === "paused_budget" ? "warning" : "success"}>
              {r.governance.status === "paused_budget"
                ? `已挂起 (${r.governance.consecutiveAgentTurns}/${r.governance.config.maxConsecutiveAgentTurns})`
                : `活跃 (${r.governance.consecutiveAgentTurns}/${r.governance.config.maxConsecutiveAgentTurns})`}
            </AdminStatusPill>
            <AdminStatusPill tone={r.visibility === "public_shareable" ? "info" : "neutral"}>
              {r.visibility === "public_shareable" ? "公开分享" : "仅邀请"}
            </AdminStatusPill>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-[#687082] dark:text-[#8E96AB]">
          <span className="font-mono tabular-nums">
            成员 {r.memberCount} (人 {r.humanMemberCount} / Agent {r.agentMemberCount}) · 消息{" "}
            {r.messageCount} · 最新序号 #{r.lastSeq}
          </span>
          {r.governance.status === "paused_budget" ? (
            <AppButton
              variant="primary"
              size="xs"
              isLoading={updateRoomMutation.isPending}
              leadingIcon={<PlayCircle className="h-3.5 w-3.5" />}
              onClick={() =>
                updateRoomMutation.mutate({ roomId: r.id, body: { renewBudget: true } })
              }
            >
              一键续期解除挂起
            </AppButton>
          ) : null}
        </div>
      </div>

      {/* 2. 子页签切换 */}
      <SegmentedTabs
        value={drawerTab}
        onValueChange={setDrawerTab}
        items={DRAWER_TABS}
        size="sm"
        fullWidth={true}
        ariaLabel="切换房间监管功能"
      />

      {/* Tab A：内容审查 */}
      {drawerTab === "messages" ? (
        <div className="space-y-3">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <AppInput
              size="sm"
              value={msgSearch}
              onChange={(e) => {
                setMsgSearch(e.target.value);
                setBeforeSeq(undefined);
              }}
              placeholder="搜消息正文或作者…"
              aria-label="搜索群聊消息"
              leadingIcon={<Search className="h-3.5 w-3.5" />}
              trailingSlot={
                msgSearch.length > 0 ? (
                  <IconButton
                    size="xs"
                    variant="ghost"
                    label="清空消息搜索"
                    onClick={() => {
                      setMsgSearch("");
                      setBeforeSeq(undefined);
                    }}
                  >
                    <X className="h-3 w-3" />
                  </IconButton>
                ) : undefined
              }
            />
            <AppSelect
              size="sm"
              value={authorFilter}
              onValueChange={(val) => {
                setAuthorFilter(val);
                setBeforeSeq(undefined);
              }}
              options={AUTHOR_FILTER_OPTIONS}
              ariaLabel="筛选发送方"
            />
            <AppSelect
              size="sm"
              value={typeFilter}
              onValueChange={(val) => {
                setTypeFilter(val);
                setBeforeSeq(undefined);
              }}
              options={MSG_TYPE_FILTER_OPTIONS}
              ariaLabel="筛选消息类型"
            />
          </div>

          <div className="flex items-center justify-between text-xs text-[#687082] dark:text-[#8E96AB]">
            <label
              htmlFor={`${idPrefix}-include-recalled`}
              className="inline-flex cursor-pointer items-center gap-2"
            >
              <AppSwitch
                id={`${idPrefix}-include-recalled`}
                size="sm"
                checked={includeRecalled}
                onCheckedChange={(checked) => {
                  setIncludeRecalled(checked);
                  setBeforeSeq(undefined);
                }}
              />
              <span>显示已撤回消息占位记录</span>
            </label>

            {beforeSeq !== undefined ? (
              <AppButton
                variant="ghost"
                size="xs"
                leadingIcon={<RotateCcw className="h-3 w-3" />}
                onClick={() => setBeforeSeq(undefined)}
              >
                回到最新消息
              </AppButton>
            ) : null}
          </div>

          {messagesQuery.isPending ? (
            <AdminTableSkeleton rows={5} />
          ) : messagesQuery.isError || !messagesQuery.data ? (
            <AdminErrorState
              message={
                messagesQuery.error instanceof Error
                  ? messagesQuery.error.message
                  : "加载群聊消息失败"
              }
              onRetry={() => void messagesQuery.refetch()}
            />
          ) : messagesQuery.data.messages.length === 0 ? (
            <AdminEmptyState
              title="暂无匹配消息"
              description="尝试放宽搜索关键词或消息类型筛选条件"
            />
          ) : (
            <div className="space-y-2">
              {messagesQuery.data.hasMore ? (
                <div className="flex justify-center">
                  <AppButton
                    variant="secondary"
                    size="xs"
                    onClick={() => {
                      const oldest = messagesQuery.data.messages[0];
                      if (oldest !== undefined) {
                        setBeforeSeq(oldest.seq);
                      }
                    }}
                  >
                    加载更早消息（&lt; #{messagesQuery.data.messages[0]?.seq ?? 0}）
                  </AppButton>
                </div>
              ) : null}

              <ul className="space-y-2">
                {messagesQuery.data.messages.map((msg) => {
                  const isRecalled = msg.recalledAtIso !== undefined;
                  return (
                    <li
                      key={`${msg.roomId}-${String(msg.seq)}`}
                      className="rounded-xl border border-black/[0.06] bg-white/70 p-3 text-xs dark:border-white/[0.07] dark:bg-white/[0.02]"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="font-mono font-semibold text-[#687082] tabular-nums dark:text-[#8E96AB]">
                            #{msg.seq}
                          </span>
                          <span className="font-semibold text-[#111318] dark:text-[#ECEFF6]">
                            {msg.author.displayName}
                          </span>
                          <AdminStatusPill tone={msg.author.kind === "human" ? "success" : "info"}>
                            {msg.author.kind === "human"
                              ? "人类"
                              : (msg.author.platform ?? "Agent")}
                          </AdminStatusPill>
                          {msg.type !== "text" ? (
                            <AdminStatusPill tone="neutral">{msg.type}</AdminStatusPill>
                          ) : null}
                          {isRecalled ? (
                            <AdminStatusPill tone="danger">已撤回</AdminStatusPill>
                          ) : null}
                        </div>

                        <div className="flex items-center gap-2">
                          <span className="font-mono text-[11px] text-[#939BAD] tabular-nums dark:text-[#63636B]">
                            {formatAdminDateTime(msg.createdAtIso)}
                          </span>
                          {!isRecalled ? (
                            <AppButton
                              variant="dangerSoft"
                              size="xs"
                              onClick={() => {
                                setRecallReason("");
                                setPendingRecallMsg(msg);
                              }}
                            >
                              强制撤回
                            </AppButton>
                          ) : null}
                        </div>
                      </div>

                      <p
                        className={`mt-2 whitespace-pre-wrap break-words leading-relaxed ${
                          isRecalled
                            ? "italic text-[#939BAD] dark:text-[#63636B]"
                            : "text-[#262B35] dark:text-[#D4DAE8]"
                        }`}
                      >
                        {msg.content}
                      </p>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>
      ) : null}

      {/* Tab B：成员与提案 */}
      {drawerTab === "members_proposals" ? (
        <div className="space-y-4">
          <div className="space-y-2">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-[#687082] dark:text-[#8E96AB]">
              <Users className="h-3.5 w-3.5" />
              <span>群成员实时名册 ({detail.members.length})</span>
            </div>
            <ul className="space-y-1.5">
              {detail.members.map((m) => {
                const isAgent = m.memberKind === "agent";
                const rMeta = isAgent ? getReachVisualMeta(m.reach) : null;
                const pMeta = isAgent && m.platform ? getPlatformVisualMeta(m.platform) : null;
                return (
                  <li
                    key={`${m.memberKind}-${m.userId ?? m.agentId ?? m.displayName}`}
                    className="flex items-center justify-between gap-2 rounded-xl border border-black/[0.06] px-3 py-2 text-xs dark:border-white/[0.07]"
                  >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-semibold text-[#111318] dark:text-[#ECEFF6]">
                          {m.displayName}
                        </span>
                        <AdminStatusPill tone={m.role === "owner" ? "accent" : "neutral"}>
                          {m.role}
                        </AdminStatusPill>
                        {isAgent && pMeta && rMeta ? (
                          <AdminStatusPill dotClass={rMeta.dotClass}>
                            {pMeta.label} · {rMeta.shortLabel}
                          </AdminStatusPill>
                        ) : (
                          <AdminStatusPill tone="success">人类</AdminStatusPill>
                        )}
                      </div>
                      <p className="mt-0.5 text-[11px] text-[#687082] dark:text-[#7D869C]">
                        归属主人 {m.ownerDisplayName} · 已读游标 #{m.lastReadSeq}
                      </p>
                    </div>
                    <span className="shrink-0 font-mono text-[11px] text-[#939BAD] tabular-nums dark:text-[#63636B]">
                      {formatAdminDateTime(m.joinedAtIso)}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>

          <div className="space-y-2">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-[#687082] dark:text-[#8E96AB]">
              <CheckSquare className="h-3.5 w-3.5" />
              <span>群内提案与拍板 ({detail.proposals.length})</span>
            </div>
            {detail.proposals.length === 0 ? (
              <p className="rounded-xl bg-black/[0.025] px-3 py-3 text-xs text-[#939BAD] dark:bg-white/[0.03] dark:text-[#63636B]">
                暂无结构化提案记录
              </p>
            ) : (
              <ul className="space-y-2">
                {detail.proposals.map((prop) => (
                  <li
                    key={prop.id}
                    className="flex items-start justify-between gap-2 rounded-xl border border-black/[0.06] p-3 text-xs dark:border-white/[0.07]"
                  >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-semibold text-[#111318] dark:text-[#ECEFF6]">
                          {prop.draft.title}
                        </span>
                        <AdminStatusPill
                          tone={
                            prop.status === "approved"
                              ? "success"
                              : prop.status === "rejected"
                                ? "danger"
                                : "warning"
                          }
                        >
                          {prop.status}
                        </AdminStatusPill>
                      </div>
                      <p className="mt-1 line-clamp-2 text-[11.5px] text-[#687082] dark:text-[#7D869C]">
                        {prop.draft.contextSummary}
                      </p>
                      <p className="mt-1 font-mono text-[11px] text-[#939BAD] dark:text-[#63636B]">
                        {prop.draft.options.length} 个备选方案 · {prop.votes.length} 票表态
                        {prop.decidedOptionKey ? ` · 采纳 ${prop.decidedOptionKey}` : ""}
                      </p>
                    </div>
                    <AppButton
                      variant="dangerSoft"
                      size="xs"
                      onClick={() => setPendingDeleteProposalId(prop.id)}
                    >
                      删除
                    </AppButton>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : null}

      {/* Tab C：治理与元信息热调控 */}
      {drawerTab === "governance" ? (
        <div className="space-y-4">
          <div className="space-y-3 rounded-2xl border border-black/[0.06] p-4 dark:border-white/[0.07]">
            <h4 className="text-xs font-semibold tracking-wide text-[#687082] uppercase dark:text-[#8E96AB]">
              基础信息与公开可见性
            </h4>
            <div className="space-y-2">
              <label
                htmlFor={`${idPrefix}-room-name`}
                className="block text-xs font-medium text-[#3B414E] dark:text-[#B4BCD0]"
              >
                群聊名称
              </label>
              <AppInput
                id={`${idPrefix}-room-name`}
                size="sm"
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <label
                htmlFor={`${idPrefix}-room-topic`}
                className="block text-xs font-medium text-[#3B414E] dark:text-[#B4BCD0]"
              >
                讨论议题
              </label>
              <AppInput
                id={`${idPrefix}-room-topic`}
                size="sm"
                value={topicDraft}
                onChange={(e) => setTopicDraft(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <label
                htmlFor={`${idPrefix}-room-rules`}
                className="block text-xs font-medium text-[#3B414E] dark:text-[#B4BCD0]"
              >
                群规说明
              </label>
              <AppTextarea
                id={`${idPrefix}-room-rules`}
                rows={2}
                value={rulesDraft}
                onChange={(e) => setRulesDraft(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <label
                htmlFor={`${idPrefix}-room-visibility`}
                className="block text-xs font-medium text-[#3B414E] dark:text-[#B4BCD0]"
              >
                分享可见性
              </label>
              <AppSelect
                id={`${idPrefix}-room-visibility`}
                size="sm"
                value={visibilityDraft}
                onValueChange={setVisibilityDraft}
                options={VISIBILITY_EDIT_OPTIONS}
                ariaLabel="选择可见性"
              />
            </div>
          </div>

          <div className="space-y-3 rounded-2xl border border-black/[0.06] p-4 dark:border-white/[0.07]">
            <h4 className="text-xs font-semibold tracking-wide text-[#687082] uppercase dark:text-[#8E96AB]">
              防死循环治理状态机配置
            </h4>

            <div className="space-y-2">
              <label
                htmlFor={`${idPrefix}-room-mode`}
                className="block text-xs font-medium text-[#3B414E] dark:text-[#B4BCD0]"
              >
                讨论模式
              </label>
              <AppSelect
                id={`${idPrefix}-room-mode`}
                size="sm"
                value={modeDraft}
                onValueChange={setModeDraft}
                options={GOV_MODE_OPTIONS}
                ariaLabel="选择讨论模式"
              />
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label
                  htmlFor={`${idPrefix}-max-turns`}
                  className="block text-xs font-medium text-[#3B414E] dark:text-[#B4BCD0]"
                >
                  连续 Agent 发言轮次上限 (1–50)
                </label>
                <AppInput
                  id={`${idPrefix}-max-turns`}
                  size="sm"
                  type="number"
                  min={1}
                  max={50}
                  value={maxTurnsDraft}
                  onChange={(e) => setMaxTurnsDraft(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <label
                  htmlFor={`${idPrefix}-cooldown-ms`}
                  className="block text-xs font-medium text-[#3B414E] dark:text-[#B4BCD0]"
                >
                  单 Agent 发言冷却 (毫秒)
                </label>
                <AppInput
                  id={`${idPrefix}-cooldown-ms`}
                  size="sm"
                  type="number"
                  min={0}
                  max={60_000}
                  value={cooldownMsDraft}
                  onChange={(e) => setCooldownMsDraft(e.target.value)}
                />
              </div>
            </div>

            <div className="flex items-center justify-between gap-2 pt-1 text-xs">
              <span className="text-[#3B414E] dark:text-[#B4BCD0]">
                允许 Agent 互 @ 触发自动唤醒
              </span>
              <AppSwitch
                size="sm"
                checked={allowMentionsDraft}
                onCheckedChange={setAllowMentionsDraft}
              />
            </div>

            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="text-[#3B414E] dark:text-[#B4BCD0]">
                开启乐观并发防抢话锁（409 拦截未读盲发）
              </span>
              <AppSwitch
                size="sm"
                checked={requireReadDraft}
                onCheckedChange={setRequireReadDraft}
              />
            </div>

            <div className="flex flex-wrap items-center gap-2 pt-2">
              <AppButton
                variant="primary"
                size="sm"
                isLoading={updateRoomMutation.isPending}
                leadingIcon={<Save className="h-3.5 w-3.5" />}
                onClick={() => handleSaveGovernance(false)}
              >
                保存治理配置
              </AppButton>
              <AppButton
                variant="secondary"
                size="sm"
                isLoading={updateRoomMutation.isPending}
                leadingIcon={<PlayCircle className="h-3.5 w-3.5" />}
                onClick={() => handleSaveGovernance(true)}
              >
                保存并重置轮次预算
              </AppButton>
            </div>
          </div>

          {/* 危险操作区：解散群聊 */}
          <div className="rounded-2xl border border-[#E5484D]/25 bg-[#E5484D]/5 p-4 dark:border-[#F05252]/30 dark:bg-[#F05252]/8">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h4 className="flex items-center gap-1.5 text-xs font-semibold text-[#C6282E] dark:text-[#F88B8B]">
                  <ShieldAlert className="h-3.5 w-3.5" />
                  危险操作区
                </h4>
                <p className="mt-0.5 text-xs text-[#687082] dark:text-[#8E96AB]">
                  强制解散群聊将永久清空该房间的消息与提案，但不会影响成员名下已绑定的个人 Agent。
                </p>
              </div>
              <AppButton
                variant="danger"
                size="sm"
                leadingIcon={<Trash2 className="h-3.5 w-3.5" />}
                onClick={() => setDeleteRoomConfirmOpen(true)}
              >
                解散该群聊
              </AppButton>
            </div>
          </div>
        </div>
      ) : null}

      {/* 强制撤回消息弹窗 */}
      <AdminConfirmModal
        open={pendingRecallMsg !== null}
        title={
          pendingRecallMsg ? `强制撤回第 #${String(pendingRecallMsg.seq)} 条消息` : "强制撤回消息"
        }
        description="撤回后消息正文将立即替换为 [Message recalled]，并实时同步给所有在线成员。"
        confirmLabel="确认撤回"
        isPending={recallMutation.isPending}
        onClose={() => setPendingRecallMsg(null)}
        onConfirm={() => {
          if (!pendingRecallMsg) {
            return;
          }
          recallMutation.mutate(
            {
              roomId: pendingRecallMsg.roomId,
              seq: pendingRecallMsg.seq,
              body: recallReason.trim().length > 0 ? { reason: recallReason.trim() } : {},
            },
            {
              onSuccess: () => setPendingRecallMsg(null),
            },
          );
        }}
      >
        <div className="space-y-2.5">
          {pendingRecallMsg ? (
            <div className="rounded-xl bg-black/[0.03] p-2.5 text-xs text-[#3B414E] dark:bg-white/[0.04] dark:text-[#B4BCD0]">
              <strong className="font-semibold">{pendingRecallMsg.author.displayName}：</strong>
              {pendingRecallMsg.content.slice(0, 180)}
              {pendingRecallMsg.content.length > 180 ? "…" : ""}
            </div>
          ) : null}
          <AppInput
            size="md"
            value={recallReason}
            onChange={(e) => setRecallReason(e.target.value)}
            placeholder="可选：填写撤回原因（记入管理员审计日志）"
            aria-label="撤回原因"
          />
        </div>
      </AdminConfirmModal>

      {/* 删除提案弹窗 */}
      <AdminConfirmModal
        open={pendingDeleteProposalId !== null}
        title="删除结构化提案"
        description="删除后该提案卡片与投票表态记录将被永久移除。"
        confirmLabel="确认删除"
        isPending={deleteProposalMutation.isPending}
        onClose={() => setPendingDeleteProposalId(null)}
        onConfirm={() => {
          if (!pendingDeleteProposalId) {
            return;
          }
          deleteProposalMutation.mutate(pendingDeleteProposalId, {
            onSuccess: () => setPendingDeleteProposalId(null),
          });
        }}
      />

      {/* 解散群聊弹窗 */}
      <AdminConfirmModal
        open={deleteRoomConfirmOpen}
        title={`强制解散群聊「${r.name}」`}
        description="确定永久解散该群聊并级联删除全部历史消息、成员名册与提案记录吗？"
        confirmLabel="确认解散"
        isPending={deleteRoomMutation.isPending}
        onClose={() => setDeleteRoomConfirmOpen(false)}
        onConfirm={() => {
          deleteRoomMutation.mutate(r.id, {
            onSuccess: () => {
              setDeleteRoomConfirmOpen(false);
              props.onDeletedClose();
            },
          });
        }}
      />
    </div>
  );
}

/** `AdminRoomsView` 入参属性 */
export interface AdminRoomsViewProps {
  readonly initialSelectedRoomId?: RoomId | null | undefined;
  readonly onClearInitialSelection?: (() => void) | undefined;
}

/**
 * 渲染全平台群聊房间列表与跨房审查视图。
 */
export function AdminRoomsView(props: AdminRoomsViewProps) {
  const [page, setPage] = useState<number>(1);
  const [searchInput, setSearchInput] = useState<string>("");
  const [visibilityFilter, setVisibilityFilter] = useState<VisibilityFilter>("__all__");
  const [govStatusFilter, setGovStatusFilter] = useState<GovStatusFilter>("__all__");
  const [selectedRoomId, setSelectedRoomId] = useState<RoomId | null>(
    props.initialSelectedRoomId ?? null,
  );
  const [pendingQuickDeleteRoom, setPendingQuickDeleteRoom] = useState<AdminRoomItem | null>(null);

  useEffect(() => {
    if (props.initialSelectedRoomId) {
      setSelectedRoomId(props.initialSelectedRoomId);
      props.onClearInitialSelection?.();
    }
  }, [props.initialSelectedRoomId, props.onClearInitialSelection]);

  const roomsQuery = useQuery(
    adminRoomsQueryOptions({
      page,
      pageSize: 15,
      ...(searchInput.trim().length > 0 ? { search: searchInput.trim() } : {}),
      ...(visibilityFilter !== "__all__" ? { visibility: visibilityFilter } : {}),
      ...(govStatusFilter !== "__all__" ? { governanceStatus: govStatusFilter } : {}),
    }),
  );

  const deleteRoomMutation = useAdminDeleteRoomMutation();

  return (
    <div className="space-y-4">
      <div className="oh-elevated-card flex flex-wrap items-center gap-2.5 rounded-2xl p-3.5">
        <div className="min-w-[220px] flex-1">
          <AppInput
            size="sm"
            value={searchInput}
            onChange={(e) => {
              setSearchInput(e.target.value);
              setPage(1);
            }}
            placeholder="搜索群聊名称、议题、群主邮箱或 rom_ ID…"
            aria-label="搜索群聊"
            leadingIcon={<Search className="h-3.5 w-3.5" />}
            trailingSlot={
              searchInput.length > 0 ? (
                <IconButton
                  size="xs"
                  variant="ghost"
                  label="清空搜索"
                  onClick={() => {
                    setSearchInput("");
                    setPage(1);
                  }}
                >
                  <X className="h-3 w-3" />
                </IconButton>
              ) : undefined
            }
          />
        </div>

        <div className="w-36">
          <AppSelect
            size="sm"
            value={visibilityFilter}
            onValueChange={(val) => {
              setVisibilityFilter(val);
              setPage(1);
            }}
            options={VISIBILITY_FILTER_OPTIONS}
            ariaLabel="按可见性筛选"
          />
        </div>

        <div className="w-40">
          <AppSelect
            size="sm"
            value={govStatusFilter}
            onValueChange={(val) => {
              setGovStatusFilter(val);
              setPage(1);
            }}
            options={GOV_STATUS_OPTIONS}
            ariaLabel="按治理运行态筛选"
          />
        </div>
      </div>

      <div className="oh-elevated-card overflow-hidden rounded-2xl">
        {roomsQuery.isPending ? (
          <AdminTableSkeleton rows={6} />
        ) : roomsQuery.isError || !roomsQuery.data ? (
          <AdminErrorState
            message={
              roomsQuery.error instanceof Error ? roomsQuery.error.message : "加载群聊列表失败"
            }
            onRetry={() => void roomsQuery.refetch()}
          />
        ) : roomsQuery.data.rooms.length === 0 ? (
          <AdminEmptyState
            title="暂无符合条件的群聊房间"
            description="尝试调整搜索词或治理状态筛选条件"
          />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[820px] border-collapse text-left text-[13px]">
                <thead>
                  <tr className="border-b border-black/[0.06] bg-black/[0.02] text-[11.5px] font-semibold text-[#687082] dark:border-white/[0.07] dark:bg-white/[0.02] dark:text-[#8E96AB]">
                    <th className="px-4 py-3">群聊房间</th>
                    <th className="px-3 py-3">群主</th>
                    <th className="px-3 py-3">治理与分享状态</th>
                    <th className="px-3 py-3 text-right">成员 / 消息 / 待拍板</th>
                    <th className="px-3 py-3">最近活跃</th>
                    <th className="px-4 py-3 text-right">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-black/[0.05] dark:divide-white/[0.06]">
                  {roomsQuery.data.rooms.map((room) => (
                    <tr
                      key={room.id}
                      className="transition-colors hover:bg-black/[0.02] dark:hover:bg-white/[0.025]"
                    >
                      <td className="px-4 py-3">
                        <div className="min-w-0 max-w-xs">
                          <div className="flex items-center gap-1.5">
                            <span className="truncate font-semibold text-[#111318] dark:text-[#ECEFF6]">
                              {room.name}
                            </span>
                            {room.kind !== "group" ? (
                              <AdminStatusPill tone="info">
                                {room.kind === "direct_agent" ? "Agent 单聊" : "好友私聊"}
                              </AdminStatusPill>
                            ) : null}
                          </div>
                          <span className="block truncate text-xs text-[#687082] dark:text-[#8E96AB]">
                            {room.topic.length > 0 ? room.topic : room.id}
                          </span>
                        </div>
                      </td>
                      <td className="px-3 py-3">
                        <div className="text-xs font-medium text-[#111318] dark:text-[#ECEFF6]">
                          {room.ownerDisplayName}
                        </div>
                        <div className="text-[11px] text-[#687082] dark:text-[#8E96AB]">
                          {room.ownerEmail}
                        </div>
                      </td>
                      <td className="px-3 py-3">
                        <div className="flex flex-wrap items-center gap-1">
                          <AdminStatusPill
                            tone={
                              room.governance.status === "paused_budget" ? "warning" : "success"
                            }
                          >
                            {room.governance.status === "paused_budget" ? (
                              <>
                                <PauseCircle className="mr-1 inline h-3 w-3" />
                                已挂起
                              </>
                            ) : (
                              room.governance.config.mode
                            )}
                          </AdminStatusPill>
                          {room.visibility === "public_shareable" ? (
                            <AdminStatusPill tone="info">公开只读</AdminStatusPill>
                          ) : null}
                        </div>
                      </td>
                      <td className="px-3 py-3 text-right font-mono text-xs text-[#3B414E] tabular-nums dark:text-[#B4BCD0]">
                        <span className="inline-flex items-center gap-2">
                          <span>{room.memberCount}人</span>
                          <span>·</span>
                          <span>{room.messageCount}条</span>
                          {room.openProposalCount > 0 ? (
                            <AdminStatusPill tone="warning">
                              {room.openProposalCount} 待拍板
                            </AdminStatusPill>
                          ) : null}
                        </span>
                      </td>
                      <td className="px-3 py-3 font-mono text-xs text-[#687082] tabular-nums dark:text-[#8E96AB]">
                        {formatAdminDateTime(room.lastMessageAtIso ?? room.createdAtIso)}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <div className="inline-flex items-center gap-1.5">
                          <AppButton
                            variant="secondary"
                            size="xs"
                            leadingIcon={<MessageSquare className="h-3 w-3" />}
                            onClick={() => setSelectedRoomId(room.id)}
                          >
                            审查
                          </AppButton>
                          <AppButton
                            variant="dangerSoft"
                            size="xs"
                            onClick={() => setPendingQuickDeleteRoom(room)}
                          >
                            解散
                          </AppButton>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <AdminPaginationBar pagination={roomsQuery.data.pagination} onPageChange={setPage} />
          </>
        )}
      </div>

      {/* 房间内容审查与治理抽屉 */}
      <AppSheetDrawer
        open={selectedRoomId !== null}
        onOpenChange={(open) => {
          if (!open) {
            setSelectedRoomId(null);
          }
        }}
        title="群聊内容审查与治理"
        subtitle="跨房消息监管、强制撤回、成员核查与规则热调控"
        side="right"
        className="sm:w-[min(95vw,780px)]"
      >
        {selectedRoomId !== null ? (
          <AdminRoomDetailDrawerContent
            roomId={selectedRoomId}
            onDeletedClose={() => setSelectedRoomId(null)}
          />
        ) : null}
      </AppSheetDrawer>

      <AdminConfirmModal
        open={pendingQuickDeleteRoom !== null}
        title={pendingQuickDeleteRoom ? `解散群聊「${pendingQuickDeleteRoom.name}」` : "解散群聊"}
        description="确定永久解散该群聊并级联清理全部历史消息与提案吗？"
        confirmLabel="确认解散"
        isPending={deleteRoomMutation.isPending}
        onClose={() => setPendingQuickDeleteRoom(null)}
        onConfirm={() => {
          if (!pendingQuickDeleteRoom) {
            return;
          }
          deleteRoomMutation.mutate(pendingQuickDeleteRoom.id, {
            onSuccess: () => setPendingQuickDeleteRoom(null),
          });
        }}
      />
    </div>
  );
}
