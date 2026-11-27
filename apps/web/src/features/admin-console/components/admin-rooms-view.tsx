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
import { useEffect, useId, useMemo, useState } from "react";
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
import { formatNumber } from "../../../lib/i18n/index.js";
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
  getGovernanceModeLabel,
  getMessageTypeLabel,
  getProposalStatusLabel,
  getRoomMemberRoleLabel,
  resolveAdminErrorMessage,
  useAdminI18n,
} from "../i18n/index.js";
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

/**
 * 房间监管抽屉主体内容。
 */
function AdminRoomDetailDrawerContent(props: {
  readonly roomId: RoomId;
  readonly onDeletedClose: () => void;
}) {
  const { locale, t } = useAdminI18n();
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

  const visibilityEditOptions = useMemo<ReadonlyArray<AppSelectOption<RoomVisibility>>>(
    () => [
      { value: "invite_only", label: t("rooms.governance.visibilityInviteOnly") },
      { value: "public_shareable", label: t("rooms.governance.visibilityPublic") },
    ],
    [t],
  );

  const govModeOptions = useMemo<ReadonlyArray<AppSelectOption<GovernanceMode>>>(
    () => [
      { value: "free", label: t("rooms.governance.modeFree") },
      { value: "round_table", label: t("rooms.governance.modeRoundTable") },
      { value: "proposal", label: t("rooms.governance.modeProposal") },
    ],
    [t],
  );

  const authorFilterOptions = useMemo<ReadonlyArray<AppSelectOption<AuthorFilter>>>(
    () => [
      { value: "__all__", label: t("rooms.messages.authorFilter.all") },
      { value: "human", label: t("rooms.messages.authorFilter.human") },
      { value: "agent", label: t("rooms.messages.authorFilter.agent") },
    ],
    [t],
  );

  const msgTypeFilterOptions = useMemo<ReadonlyArray<AppSelectOption<MsgTypeFilter>>>(
    () => [
      { value: "__all__", label: t("rooms.messages.typeFilter.all") },
      { value: "text", label: t("common.messageType.text") },
      { value: "proposal", label: t("common.messageType.proposal") },
      { value: "vote", label: t("common.messageType.vote") },
      { value: "decision", label: t("common.messageType.decision") },
      { value: "attention", label: t("common.messageType.attention") },
      { value: "system", label: t("common.messageType.system") },
    ],
    [t],
  );

  const drawerTabs = useMemo<ReadonlyArray<SegmentedTabItem<DrawerTab>>>(
    () => [
      { value: "messages", label: t("rooms.drawer.tab.messages") },
      { value: "members_proposals", label: t("rooms.drawer.tab.membersProposals") },
      { value: "governance", label: t("rooms.drawer.tab.governance") },
    ],
    [t],
  );

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
        title={t("rooms.detail.errorTitle")}
        message={resolveAdminErrorMessage(
          detailQuery.error,
          t("shared.error.tryAgainLater"),
          locale,
        )}
        onRetry={() => void detailQuery.refetch()}
      />
    );
  }

  const detail = detailQuery.data;
  const r = detail.room;
  const fmt = (value: number): string => formatNumber(value, undefined, locale);

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
              {t("rooms.detail.ownerLine", { name: r.ownerDisplayName, email: r.ownerEmail })}
            </p>
            <p className="mt-1 font-mono text-[11px] text-[#939BAD] dark:text-[#63636B]">
              {t("rooms.detail.inviteLine", { id: r.id, token: detail.inviteToken })}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <AdminStatusPill tone={r.governance.status === "paused_budget" ? "warning" : "success"}>
              {r.governance.status === "paused_budget"
                ? t("rooms.detail.statusPaused", {
                    turns: r.governance.consecutiveAgentTurns,
                    max: r.governance.config.maxConsecutiveAgentTurns,
                  })
                : t("rooms.detail.statusActive", {
                    turns: r.governance.consecutiveAgentTurns,
                    max: r.governance.config.maxConsecutiveAgentTurns,
                  })}
            </AdminStatusPill>
            <AdminStatusPill tone={r.visibility === "public_shareable" ? "info" : "neutral"}>
              {r.visibility === "public_shareable"
                ? t("rooms.badge.publicShare")
                : t("rooms.badge.inviteOnly")}
            </AdminStatusPill>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-[#687082] dark:text-[#8E96AB]">
          <span className="font-mono tabular-nums">
            {t("rooms.detail.metricsLine", {
              members: fmt(r.memberCount),
              humans: fmt(r.humanMemberCount),
              agents: fmt(r.agentMemberCount),
              messages: fmt(r.messageCount),
              seq: r.lastSeq,
            })}
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
              {t("rooms.detail.renewBudget")}
            </AppButton>
          ) : null}
        </div>
      </div>

      {/* 2. 子页签切换 */}
      <SegmentedTabs
        value={drawerTab}
        onValueChange={setDrawerTab}
        items={drawerTabs}
        size="sm"
        fullWidth={true}
        ariaLabel={t("rooms.drawer.tab.aria")}
      />

      {/* Tab A：内容审查 */}
      {drawerTab === "messages" ? (
        <div className="space-y-3">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <AppInput
              size="sm"
              type="search"
              enterKeyHint="search"
              value={msgSearch}
              onChange={(e) => {
                setMsgSearch(e.target.value);
                setBeforeSeq(undefined);
              }}
              placeholder={t("rooms.messages.searchPlaceholder")}
              aria-label={t("rooms.messages.searchAria")}
              leadingIcon={<Search className="h-3.5 w-3.5" />}
              trailingSlot={
                msgSearch.length > 0 ? (
                  <IconButton
                    size="xs"
                    variant="ghost"
                    label={t("rooms.messages.clearSearch")}
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
              options={authorFilterOptions}
              ariaLabel={t("rooms.messages.authorFilterAria")}
            />
            <AppSelect
              size="sm"
              value={typeFilter}
              onValueChange={(val) => {
                setTypeFilter(val);
                setBeforeSeq(undefined);
              }}
              options={msgTypeFilterOptions}
              ariaLabel={t("rooms.messages.typeFilterAria")}
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
              <span>{t("rooms.messages.includeRecalled")}</span>
            </label>

            {beforeSeq !== undefined ? (
              <AppButton
                variant="ghost"
                size="xs"
                leadingIcon={<RotateCcw className="h-3 w-3" />}
                onClick={() => setBeforeSeq(undefined)}
              >
                {t("rooms.messages.backToLatest")}
              </AppButton>
            ) : null}
          </div>

          {messagesQuery.isPending ? (
            <AdminTableSkeleton rows={5} />
          ) : messagesQuery.isError || !messagesQuery.data ? (
            <AdminErrorState
              message={resolveAdminErrorMessage(
                messagesQuery.error,
                t("rooms.messages.errorLoad"),
                locale,
              )}
              onRetry={() => void messagesQuery.refetch()}
            />
          ) : messagesQuery.data.messages.length === 0 ? (
            <AdminEmptyState
              title={t("rooms.messages.emptyTitle")}
              description={t("rooms.messages.emptyDescription")}
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
                    {t("rooms.messages.loadOlder", {
                      seq: messagesQuery.data.messages[0]?.seq ?? 0,
                    })}
                  </AppButton>
                </div>
              ) : null}

              <ul className="space-y-2">
                {messagesQuery.data.messages.map((msg) => {
                  const isRecalled = msg.recalledAtIso !== undefined;
                  const agentPlatformLabel =
                    msg.author.platform !== undefined
                      ? getPlatformVisualMeta(msg.author.platform, locale).label
                      : "Agent";
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
                              ? t("common.role.human")
                              : agentPlatformLabel}
                          </AdminStatusPill>
                          {msg.type !== "text" ? (
                            <AdminStatusPill tone="neutral">
                              {getMessageTypeLabel(msg.type, t)}
                            </AdminStatusPill>
                          ) : null}
                          {isRecalled ? (
                            <AdminStatusPill tone="danger">
                              {t("rooms.messages.recalled")}
                            </AdminStatusPill>
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
                              {t("rooms.messages.forceRecall")}
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
              <span>{t("rooms.members.heading", { count: fmt(detail.members.length) })}</span>
            </div>
            <ul className="space-y-1.5">
              {detail.members.map((m) => {
                const isAgent = m.memberKind === "agent";
                const rMeta = isAgent ? getReachVisualMeta(m.reach, locale) : null;
                const pMeta =
                  isAgent && m.platform ? getPlatformVisualMeta(m.platform, locale) : null;
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
                          {getRoomMemberRoleLabel(m.role, t)}
                        </AdminStatusPill>
                        {isAgent && pMeta && rMeta ? (
                          <AdminStatusPill dotClass={rMeta.dotClass}>
                            {pMeta.label} · {rMeta.shortLabel}
                          </AdminStatusPill>
                        ) : (
                          <AdminStatusPill tone="success">{t("common.role.human")}</AdminStatusPill>
                        )}
                      </div>
                      <p className="mt-0.5 text-[11px] text-[#687082] dark:text-[#7D869C]">
                        {t("rooms.members.meta", {
                          owner: m.ownerDisplayName,
                          seq: m.lastReadSeq,
                        })}
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
              <span>{t("rooms.proposals.heading", { count: fmt(detail.proposals.length) })}</span>
            </div>
            {detail.proposals.length === 0 ? (
              <p className="rounded-xl bg-black/[0.025] px-3 py-3 text-xs text-[#939BAD] dark:bg-white/[0.03] dark:text-[#63636B]">
                {t("rooms.proposals.empty")}
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
                          {getProposalStatusLabel(prop.status, t)}
                        </AdminStatusPill>
                      </div>
                      <p className="mt-1 line-clamp-2 text-[11.5px] text-[#687082] dark:text-[#7D869C]">
                        {prop.draft.contextSummary}
                      </p>
                      <p className="mt-1 font-mono text-[11px] text-[#939BAD] dark:text-[#63636B]">
                        {prop.decidedOptionKey
                          ? t("rooms.proposals.metaWithDecision", {
                              options: fmt(prop.draft.options.length),
                              votes: fmt(prop.votes.length),
                              optionKey: prop.decidedOptionKey,
                            })
                          : t("rooms.proposals.meta", {
                              options: fmt(prop.draft.options.length),
                              votes: fmt(prop.votes.length),
                            })}
                      </p>
                    </div>
                    <AppButton
                      variant="dangerSoft"
                      size="xs"
                      onClick={() => setPendingDeleteProposalId(prop.id)}
                    >
                      {t("shared.action.delete")}
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
              {t("rooms.governance.basicHeading")}
            </h4>
            <div className="space-y-2">
              <label
                htmlFor={`${idPrefix}-room-name`}
                className="block text-xs font-medium text-[#3B414E] dark:text-[#B4BCD0]"
              >
                {t("rooms.governance.nameLabel")}
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
                {t("rooms.governance.topicLabel")}
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
                {t("rooms.governance.rulesLabel")}
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
                {t("rooms.governance.visibilityLabel")}
              </label>
              <AppSelect
                id={`${idPrefix}-room-visibility`}
                size="sm"
                value={visibilityDraft}
                onValueChange={setVisibilityDraft}
                options={visibilityEditOptions}
                ariaLabel={t("rooms.governance.visibilityAria")}
              />
            </div>
          </div>

          <div className="space-y-3 rounded-2xl border border-black/[0.06] p-4 dark:border-white/[0.07]">
            <h4 className="text-xs font-semibold tracking-wide text-[#687082] uppercase dark:text-[#8E96AB]">
              {t("rooms.governance.engineHeading")}
            </h4>

            <div className="space-y-2">
              <label
                htmlFor={`${idPrefix}-room-mode`}
                className="block text-xs font-medium text-[#3B414E] dark:text-[#B4BCD0]"
              >
                {t("rooms.governance.modeLabel")}
              </label>
              <AppSelect
                id={`${idPrefix}-room-mode`}
                size="sm"
                value={modeDraft}
                onValueChange={setModeDraft}
                options={govModeOptions}
                ariaLabel={t("rooms.governance.modeAria")}
              />
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label
                  htmlFor={`${idPrefix}-max-turns`}
                  className="block text-xs font-medium text-[#3B414E] dark:text-[#B4BCD0]"
                >
                  {t("rooms.governance.maxTurnsLabel")}
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
                  {t("rooms.governance.cooldownLabel")}
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
                {t("rooms.governance.allowMentions")}
              </span>
              <AppSwitch
                size="sm"
                checked={allowMentionsDraft}
                onCheckedChange={setAllowMentionsDraft}
              />
            </div>

            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="text-[#3B414E] dark:text-[#B4BCD0]">
                {t("rooms.governance.requireRead")}
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
                {t("rooms.governance.save")}
              </AppButton>
              <AppButton
                variant="secondary"
                size="sm"
                isLoading={updateRoomMutation.isPending}
                leadingIcon={<PlayCircle className="h-3.5 w-3.5" />}
                onClick={() => handleSaveGovernance(true)}
              >
                {t("rooms.governance.saveAndReset")}
              </AppButton>
            </div>
          </div>

          {/* 危险操作区：解散群聊 */}
          <div className="rounded-2xl border border-[#E5484D]/25 bg-[#E5484D]/5 p-4 dark:border-[#F05252]/30 dark:bg-[#F05252]/8">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h4 className="flex items-center gap-1.5 text-xs font-semibold text-[#C6282E] dark:text-[#F88B8B]">
                  <ShieldAlert className="h-3.5 w-3.5" />
                  {t("rooms.governance.dangerHeading")}
                </h4>
                <p className="mt-0.5 text-xs text-[#687082] dark:text-[#8E96AB]">
                  {t("rooms.governance.dangerDescription")}
                </p>
              </div>
              <AppButton
                variant="danger"
                size="sm"
                leadingIcon={<Trash2 className="h-3.5 w-3.5" />}
                onClick={() => setDeleteRoomConfirmOpen(true)}
              >
                {t("rooms.governance.deleteRoom")}
              </AppButton>
            </div>
          </div>
        </div>
      ) : null}

      {/* 强制撤回消息弹窗 */}
      <AdminConfirmModal
        open={pendingRecallMsg !== null}
        title={
          pendingRecallMsg
            ? t("rooms.modal.recallTitle", { seq: pendingRecallMsg.seq })
            : t("rooms.modal.recallTitleFallback")
        }
        description={t("rooms.modal.recallDescription")}
        confirmLabel={t("rooms.modal.recallConfirm")}
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
              <strong className="font-semibold">
                {t("rooms.modal.recallAuthorPrefix", {
                  name: pendingRecallMsg.author.displayName,
                })}
              </strong>
              {pendingRecallMsg.content.slice(0, 180)}
              {pendingRecallMsg.content.length > 180 ? "…" : ""}
            </div>
          ) : null}
          <AppInput
            size="md"
            value={recallReason}
            onChange={(e) => setRecallReason(e.target.value)}
            placeholder={t("rooms.modal.recallReasonPlaceholder")}
            aria-label={t("rooms.modal.recallReasonAria")}
          />
        </div>
      </AdminConfirmModal>

      {/* 删除提案弹窗 */}
      <AdminConfirmModal
        open={pendingDeleteProposalId !== null}
        title={t("rooms.modal.deleteProposalTitle")}
        description={t("rooms.modal.deleteProposalDescription")}
        confirmLabel={t("shared.action.confirmDelete")}
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
        title={t("rooms.modal.deleteRoomTitle", { name: r.name })}
        description={t("rooms.modal.deleteRoomDescription")}
        confirmLabel={t("rooms.modal.deleteRoomConfirm")}
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
  const { locale, t } = useAdminI18n();
  const [page, setPage] = useState<number>(1);
  const [searchInput, setSearchInput] = useState<string>("");
  const [visibilityFilter, setVisibilityFilter] = useState<VisibilityFilter>("__all__");
  const [govStatusFilter, setGovStatusFilter] = useState<GovStatusFilter>("__all__");
  const [selectedRoomId, setSelectedRoomId] = useState<RoomId | null>(
    props.initialSelectedRoomId ?? null,
  );
  const [pendingQuickDeleteRoom, setPendingQuickDeleteRoom] = useState<AdminRoomItem | null>(null);

  const visibilityFilterOptions = useMemo<ReadonlyArray<AppSelectOption<VisibilityFilter>>>(
    () => [
      { value: "__all__", label: t("rooms.filter.allVisibility") },
      { value: "invite_only", label: t("rooms.filter.inviteOnly") },
      { value: "public_shareable", label: t("rooms.filter.publicShareable") },
    ],
    [t],
  );

  const govStatusOptions = useMemo<ReadonlyArray<AppSelectOption<GovStatusFilter>>>(
    () => [
      { value: "__all__", label: t("rooms.filter.allGovStatus") },
      { value: "active", label: t("common.status.active") },
      { value: "paused_budget", label: t("rooms.filter.pausedBudget") },
    ],
    [t],
  );

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
  const fmt = (value: number): string => formatNumber(value, undefined, locale);

  return (
    <div className="space-y-4">
      <div className="oh-elevated-card flex flex-wrap items-center gap-2.5 rounded-2xl p-3.5">
        <div className="w-full sm:min-w-[220px] sm:flex-1">
          <AppInput
            size="sm"
            type="search"
            enterKeyHint="search"
            value={searchInput}
            onChange={(e) => {
              setSearchInput(e.target.value);
              setPage(1);
            }}
            placeholder={t("rooms.search.placeholder")}
            aria-label={t("rooms.search.aria")}
            leadingIcon={<Search className="h-3.5 w-3.5" />}
            trailingSlot={
              searchInput.length > 0 ? (
                <IconButton
                  size="xs"
                  variant="ghost"
                  label={t("shared.action.clearSearch")}
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

        <div className="w-[calc(50%-0.3125rem)] sm:w-40">
          <AppSelect
            size="sm"
            value={visibilityFilter}
            onValueChange={(val) => {
              setVisibilityFilter(val);
              setPage(1);
            }}
            options={visibilityFilterOptions}
            ariaLabel={t("rooms.filter.visibilityAria")}
          />
        </div>

        <div className="w-[calc(50%-0.3125rem)] sm:w-40">
          <AppSelect
            size="sm"
            value={govStatusFilter}
            onValueChange={(val) => {
              setGovStatusFilter(val);
              setPage(1);
            }}
            options={govStatusOptions}
            ariaLabel={t("rooms.filter.govStatusAria")}
          />
        </div>
      </div>

      <div className="oh-elevated-card overflow-hidden rounded-2xl">
        {roomsQuery.isPending ? (
          <AdminTableSkeleton rows={6} />
        ) : roomsQuery.isError || !roomsQuery.data ? (
          <AdminErrorState
            message={resolveAdminErrorMessage(roomsQuery.error, t("rooms.error.loadList"), locale)}
            onRetry={() => void roomsQuery.refetch()}
          />
        ) : roomsQuery.data.rooms.length === 0 ? (
          <AdminEmptyState
            title={t("rooms.empty.title")}
            description={t("rooms.empty.description")}
          />
        ) : (
          <>
            <div className="overflow-x-auto overscroll-x-contain">
              <table className="w-full min-w-[820px] border-collapse text-left text-[13px]">
                <thead>
                  <tr className="border-b border-black/[0.06] bg-black/[0.02] text-[11.5px] font-semibold text-[#687082] dark:border-white/[0.07] dark:bg-white/[0.02] dark:text-[#8E96AB]">
                    <th className="px-4 py-3">{t("rooms.table.room")}</th>
                    <th className="px-3 py-3">{t("rooms.table.owner")}</th>
                    <th className="px-3 py-3">{t("rooms.table.governance")}</th>
                    <th className="px-3 py-3 text-right">{t("rooms.table.metrics")}</th>
                    <th className="px-3 py-3">{t("rooms.table.lastActive")}</th>
                    <th className="px-4 py-3 text-right">{t("rooms.table.actions")}</th>
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
                                {room.kind === "direct_agent"
                                  ? t("rooms.kind.directAgent")
                                  : t("rooms.kind.directHuman")}
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
                                {t("common.status.paused")}
                              </>
                            ) : (
                              getGovernanceModeLabel(room.governance.config.mode, t)
                            )}
                          </AdminStatusPill>
                          {room.visibility === "public_shareable" ? (
                            <AdminStatusPill tone="info">
                              {t("rooms.badge.publicReadonly")}
                            </AdminStatusPill>
                          ) : null}
                        </div>
                      </td>
                      <td className="px-3 py-3 text-right font-mono text-xs text-[#3B414E] tabular-nums dark:text-[#B4BCD0]">
                        <span className="inline-flex items-center gap-2">
                          <span>
                            {t("rooms.metrics.members", { count: fmt(room.memberCount) })}
                          </span>
                          <span>·</span>
                          <span>
                            {t("rooms.metrics.messages", { count: fmt(room.messageCount) })}
                          </span>
                          {room.openProposalCount > 0 ? (
                            <AdminStatusPill tone="warning">
                              {t("rooms.metrics.openProposals", {
                                count: fmt(room.openProposalCount),
                              })}
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
                            {t("rooms.action.inspect")}
                          </AppButton>
                          <AppButton
                            variant="dangerSoft"
                            size="xs"
                            onClick={() => setPendingQuickDeleteRoom(room)}
                          >
                            {t("rooms.action.delete")}
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
        title={t("rooms.drawer.title")}
        subtitle={t("rooms.drawer.subtitle")}
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
        title={
          pendingQuickDeleteRoom
            ? t("rooms.modal.quickDeleteTitle", { name: pendingQuickDeleteRoom.name })
            : t("rooms.modal.quickDeleteTitleFallback")
        }
        description={t("rooms.modal.quickDeleteDescription")}
        confirmLabel={t("rooms.modal.deleteRoomConfirm")}
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
