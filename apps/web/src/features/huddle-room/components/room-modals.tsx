/**
 * @module web/features/huddle-room/room-modals
 * @description Apple Liquid Glass 协调风格「新建群聊」、「加入群聊」、「删除群聊确认」与「退出群聊确认」模态窗组件。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 新建即防护：默认预填 `maxConsecutiveAgentTurns = 6` 与防抢话乐观读锁（`requireReadBeforeSend = true`），创建时可一键选择自由聊、轮流聊或提案收敛模式。
 * 2. 智能入群解析：同时兼容粘贴纯邀请码（`inv_xxx`）或完整 `/share/inv_xxx` 回放链接，自动提取并解码纯净 `inviteToken`。
 * 3. 中性烟熏石墨与暖瓷协调表面：宿主 `ModalDialog` 承载 `liquid-glass-modal`，内部卡片与芯片采用轻透协调分层，零原生下拉框、暗色输入框恒保持深中性石墨底面。
 */
import {
  type AgentId,
  DEFAULT_MAX_CONSECUTIVE_AGENT_TURNS,
  type FriendContactDto,
  type GovernanceMode,
  type OwnedAgentSummaryDto,
  type RoomDetailDto,
  type RoomId,
  type RoomKind,
  type RoomVisibility,
  type UserId,
} from "@openhuddle/protocol";
import {
  AlertTriangle,
  CheckCircle2,
  Globe,
  Hash,
  Link2,
  Lock,
  LogIn,
  LogOut,
  MessagesSquare,
  Plus,
  Trash2,
} from "lucide-react";
import { type FormEvent, useMemo, useRef, useState } from "react";
import {
  AnimatePresence,
  AppButton,
  AppInput,
  AppSelect,
  type AppSelectOption,
  AppTextarea,
  type SegmentedTabItem,
  SegmentedTabs,
  cn,
  motion,
  toast,
} from "../../../components/primitives/index.js";
import { ModalDialog } from "../../../components/ui/modal-dialog.js";
import { PlatformGlyph } from "../../../components/ui/platform-icons.js";
import { getPlatformVisualMeta } from "../../../lib/format.js";
import { useCommonI18n } from "../../../lib/i18n/index.js";
import { useCreateRoomMutation, useJoinRoomMutation } from "../api/huddle-room.queries.js";
import { resolveChatDetailErrorMessage, useChatDetailI18n } from "../i18n/chat-detail.js";

const LABEL_CLASS = "block text-xs font-medium text-[#3B414E] dark:text-[#C4C4CA]";

/** Agent 连续发言预算字符串字面量枚举（适配 Radix `AppSelect` 非空字符串泛型） */
type TurnBudgetValue = "4" | "6" | "10" | "16";

/** `CreateRoomModal` 入参属性 */
export interface CreateRoomModalProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onRoomCreated: (room: RoomDetailDto) => void;
  /** 当前用户已接入的个人 Agent（建群时可勾选直拉入群，免发提示词） */
  readonly ownedAgents: ReadonlyArray<OwnedAgentSummaryDto>;
  /** 当前用户已添加的好友列表（建群时可直接勾选拉入群聊） */
  readonly friends?: ReadonlyArray<FriendContactDto> | undefined;
}

/**
 * 新建多 Agent 群聊配置模态框。
 *
 * @param props - 打开状态、创建成功跳转回调、已接入 Agent 列表与好友列表
 * @returns 新建群聊弹窗
 */
export function CreateRoomModal(props: CreateRoomModalProps) {
  const { locale, t, tp } = useChatDetailI18n();
  const { t: commonT } = useCommonI18n();
  const [name, setName] = useState<string>("");
  const [topic, setTopic] = useState<string>("");
  const [rules, setRules] = useState<string>("");
  const [visibility, setVisibility] = useState<RoomVisibility>("invite_only");
  const [mode, setMode] = useState<GovernanceMode>("free");
  const [maxTurns, setMaxTurns] = useState<TurnBudgetValue>(
    String(DEFAULT_MAX_CONSECUTIVE_AGENT_TURNS) as TurnBudgetValue,
  );
  const [selectedAgentIds, setSelectedAgentIds] = useState<ReadonlySet<AgentId>>(new Set());
  const [selectedUserIds, setSelectedUserIds] = useState<ReadonlySet<UserId>>(new Set());

  const createMutation = useCreateRoomMutation();
  const availableFriends = props.friends ?? [];

  const governanceModeOptions = useMemo<
    ReadonlyArray<{
      readonly value: GovernanceMode;
      readonly title: string;
      readonly hint: string;
    }>
  >(
    () => [
      {
        value: "free",
        title: t("roomModal.mode.free.title"),
        hint: t("roomModal.mode.free.hint"),
      },
      {
        value: "round_table",
        title: t("roomModal.mode.roundTable.title"),
        hint: t("roomModal.mode.roundTable.hint"),
      },
      {
        value: "proposal",
        title: t("roomModal.mode.proposal.title"),
        hint: t("roomModal.mode.proposal.hint"),
      },
    ],
    [t],
  );

  const visibilityTabs = useMemo<ReadonlyArray<SegmentedTabItem<RoomVisibility>>>(
    () => [
      {
        value: "invite_only",
        label: t("roomModal.visibility.inviteOnly"),
        icon: <Lock className="h-3.5 w-3.5" />,
      },
      {
        value: "public_shareable",
        label: t("roomModal.visibility.publicShareable"),
        icon: <Globe className="h-3.5 w-3.5" />,
      },
    ],
    [t],
  );

  const turnBudgetOptions = useMemo<ReadonlyArray<AppSelectOption<TurnBudgetValue>>>(
    () => [
      {
        value: "4",
        label: t("roomModal.turnBudget.4.label"),
        description: t("roomModal.turnBudget.4.desc"),
      },
      {
        value: "6",
        label: t("roomModal.turnBudget.6.label"),
        description: t("roomModal.turnBudget.6.desc"),
      },
      {
        value: "10",
        label: t("roomModal.turnBudget.10.label"),
        description: t("roomModal.turnBudget.10.desc"),
      },
      {
        value: "16",
        label: t("roomModal.turnBudget.16.label"),
        description: t("roomModal.turnBudget.16.desc"),
      },
    ],
    [t],
  );

  const toggleAgent = (agentId: AgentId): void => {
    setSelectedAgentIds((prev) => {
      const next = new Set(prev);
      if (next.has(agentId)) {
        next.delete(agentId);
      } else {
        next.add(agentId);
      }
      return next;
    });
  };

  const toggleFriend = (userId: UserId): void => {
    setSelectedUserIds((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) {
        next.delete(userId);
      } else {
        next.add(userId);
      }
      return next;
    });
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const trimmedName = name.trim();
    if (trimmedName.length === 0) {
      return;
    }

    createMutation.mutate(
      {
        name: trimmedName,
        topic: topic.trim(),
        rules: rules.trim(),
        visibility,
        governance: {
          mode,
          maxConsecutiveAgentTurns: Number(maxTurns),
          allowAgentMentions: true,
          requireReadBeforeSend: true,
        },
        initialAgentIds: [...selectedAgentIds],
        initialUserIds: [...selectedUserIds],
      },
      {
        onSuccess: (res) => {
          const pulledParts: string[] = [];
          if (selectedUserIds.size > 0) {
            pulledParts.push(tp("roomModal.create.pulledFriends", selectedUserIds.size));
          }
          if (selectedAgentIds.size > 0) {
            pulledParts.push(tp("roomModal.create.pulledAgents", selectedAgentIds.size));
          }
          toast.success(t("roomModal.create.successTitle", { name: res.room.name }), {
            description:
              pulledParts.length > 0
                ? t("roomModal.create.successDescPulled", {
                    items: pulledParts.join(t("common.listSeparator")),
                  })
                : t("roomModal.create.successDescEmpty"),
          });
          setName("");
          setTopic("");
          setRules("");
          setSelectedAgentIds(new Set());
          setSelectedUserIds(new Set());
          props.onRoomCreated(res.room);
          props.onClose();
        },
        onError: (err) => {
          toast.error(
            resolveChatDetailErrorMessage(err, locale) ?? t("roomModal.create.failedFallback"),
          );
        },
      },
    );
  };

  const errMsg = resolveChatDetailErrorMessage(createMutation.error, locale);
  const previewName = name.trim().length > 0 ? name.trim() : t("roomModal.create.unnamedPreview");

  return (
    <ModalDialog
      open={props.open}
      onClose={props.onClose}
      title={t("roomModal.create.title")}
      subtitle={t("roomModal.create.subtitle")}
      maxWidthClass="max-w-lg"
      icon={<MessagesSquare className="h-4 w-4" />}
      footer={
        <div className="flex select-none items-center justify-end gap-2">
          <AppButton variant="ghost" size="md" onClick={props.onClose}>
            {commonT("action.cancel")}
          </AppButton>
          <AppButton
            type="submit"
            form="create-room-form"
            variant="primary"
            size="md"
            isLoading={createMutation.isPending}
            disabled={name.trim().length === 0}
            leadingIcon={<Plus aria-hidden="true" className="h-3.5 w-3.5" />}
          >
            {t("roomModal.create.submitButton")}
          </AppButton>
        </div>
      }
    >
      <form id="create-room-form" onSubmit={handleSubmit} className="space-y-4">
        {/* 群聊即时预览卡片 */}
        <div className="flex select-none items-center gap-3 rounded-[18px] bg-black/[0.035] p-3 ring-1 ring-inset ring-black/[0.05] dark:bg-white/[0.05] dark:ring-white/[0.08]">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[13px] bg-[#181B22] text-white dark:bg-[#EAEEF6] dark:text-[#111318]">
            <Hash aria-hidden="true" className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <p className="truncate text-sm font-semibold text-[#111318] dark:text-[#F2F2F4]">
                {previewName}
              </p>
              <span
                className={cn(
                  "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-medium",
                  visibility === "public_shareable"
                    ? "bg-[#E6F5EC] text-[#145335] dark:bg-[#1B2B23] dark:text-[#A7F3D0]"
                    : "bg-black/[0.06] text-[#4B5565] dark:bg-white/[0.09] dark:text-[#C4C4CA]",
                )}
              >
                {visibility === "public_shareable"
                  ? t("roomModal.create.badgePublic")
                  : t("roomModal.create.badgeInviteOnly")}
              </span>
            </div>
            <p className="mt-0.5 truncate text-[11.5px] text-[#687082] dark:text-[#8E8E96]">
              {topic.trim().length > 0
                ? topic.trim()
                : t("roomModal.create.topicPreviewPlaceholder")}
            </p>
          </div>
        </div>

        <div>
          <label htmlFor="create-room-name" className={LABEL_CLASS}>
            {t("roomModal.create.nameLabel")} <span className="text-[#E5484D]">*</span>
          </label>
          <AppInput
            id="create-room-name"
            type="text"
            size="lg"
            required={true}
            maxLength={100}
            value={name}
            onChange={(e) => setName(e.target.value)}
            leadingIcon={<Hash className="h-4 w-4" />}
            placeholder={t("roomModal.create.namePlaceholder")}
            containerClassName="mt-1.5"
          />
        </div>

        {/* 建群直拉好友：已添加的好友可直接勾选入群，免发邀请码 */}
        {availableFriends.length > 0 ? (
          <div>
            <span className={LABEL_CLASS}>
              {t("roomModal.create.friendsLabel")}{" "}
              <span className="font-normal text-[#8E96A6] dark:text-[#63636B]">
                {t("roomModal.create.optionalJoinHint")}
              </span>
            </span>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {availableFriends.map((friend) => {
                const isSelected = selectedUserIds.has(friend.user.userId);
                return (
                  <button
                    key={friend.user.userId}
                    type="button"
                    aria-pressed={isSelected}
                    onClick={() => toggleFriend(friend.user.userId)}
                    className={cn(
                      "app-no-drag flex cursor-pointer items-center gap-2 rounded-full px-3 py-1.5 text-left text-xs font-medium transition-all duration-150 active:scale-[0.98]",
                      isSelected
                        ? "bg-[#181B22]/8 text-[#111318] ring-[1.5px] ring-[#181B22] dark:bg-white/[0.11] dark:text-[#F2F2F4] dark:ring-[#EAEEF6]"
                        : "bg-white/80 text-[#3B414E] ring-1 ring-inset ring-black/[0.08] hover:bg-white dark:bg-white/[0.04] dark:text-[#C4C4CA] dark:ring-white/[0.09] dark:hover:bg-white/[0.08]",
                    )}
                  >
                    <span className="max-w-[10rem] truncate">
                      {friend.remark ?? friend.user.displayName}
                    </span>
                    {isSelected ? (
                      <CheckCircle2 aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
                    ) : null}
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}

        {/* 建群直拉本人 Agent：服务端按归属校验后直接写入成员，免发提示词 */}
        {props.ownedAgents.length > 0 ? (
          <div>
            <span className={LABEL_CLASS}>
              {t("roomModal.create.agentsLabel")}{" "}
              <span className="font-normal text-[#8E96A6] dark:text-[#63636B]">
                {t("roomModal.create.optionalJoinHint")}
              </span>
            </span>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {props.ownedAgents.map((agent) => {
                const meta = getPlatformVisualMeta(agent.platform, locale);
                const isSelected = selectedAgentIds.has(agent.id);
                return (
                  <button
                    key={agent.id}
                    type="button"
                    aria-pressed={isSelected}
                    onClick={() => toggleAgent(agent.id)}
                    className={cn(
                      "app-no-drag flex cursor-pointer items-center gap-2 rounded-full px-2.5 py-1.5 text-left text-xs font-medium transition-all duration-150 active:scale-[0.98]",
                      isSelected
                        ? "bg-[#181B22]/8 text-[#111318] ring-[1.5px] ring-[#181B22] dark:bg-white/[0.11] dark:text-[#F2F2F4] dark:ring-[#EAEEF6]"
                        : "bg-white/80 text-[#3B414E] ring-1 ring-inset ring-black/[0.08] hover:bg-white dark:bg-white/[0.04] dark:text-[#C4C4CA] dark:ring-white/[0.09] dark:hover:bg-white/[0.08]",
                    )}
                  >
                    <span
                      className={cn(
                        "inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full",
                        meta.avatarClass,
                      )}
                    >
                      <PlatformGlyph platform={agent.platform} className="h-3 w-3" />
                    </span>
                    <span className="max-w-[10rem] truncate">{agent.displayName}</span>
                    {isSelected ? (
                      <CheckCircle2 aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
                    ) : null}
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}

        <div>
          <label htmlFor="create-room-topic" className={LABEL_CLASS}>
            {t("roomModal.create.topicLabel")}
          </label>
          <AppInput
            id="create-room-topic"
            type="text"
            size="md"
            maxLength={500}
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder={t("roomModal.create.topicPlaceholder")}
            containerClassName="mt-1.5"
          />
        </div>

        <div>
          <label htmlFor="create-room-rules" className={LABEL_CLASS}>
            {t("roomModal.create.rulesLabel")}{" "}
            <span className="font-normal text-[#8E96A6] dark:text-[#63636B]">
              {t("roomModal.create.rulesHint")}
            </span>
          </label>
          <AppTextarea
            id="create-room-rules"
            rows={2}
            maxLength={2000}
            value={rules}
            onChange={(e) => setRules(e.target.value)}
            placeholder={t("roomModal.create.rulesPlaceholder")}
            className="mt-1.5 resize-none"
          />
        </div>

        {/* 可见范围：使用全胶囊 SegmentedTabs */}
        <div>
          <span className={LABEL_CLASS}>{t("roomModal.create.visibilityLabel")}</span>
          <SegmentedTabs
            value={visibility}
            onValueChange={setVisibility}
            items={visibilityTabs}
            size="md"
            fullWidth={true}
            ariaLabel={t("roomModal.create.visibilityAria")}
            className="mt-1.5"
          />
        </div>

        {/* 讨论组织模式：桌面三栏卡片，移动端单列紧凑选项防 320px/360px 挤爆 */}
        <fieldset>
          <legend className={LABEL_CLASS}>{t("roomModal.create.modeLabel")}</legend>
          <div className="mt-1.5 grid grid-cols-1 gap-2 sm:grid-cols-3">
            {governanceModeOptions.map((option) => {
              const selected = mode === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => setMode(option.value)}
                  className={cn(
                    "app-no-drag cursor-pointer select-none rounded-[14px] px-3 py-2.5 text-left transition-all duration-150 active:scale-[0.98]",
                    selected
                      ? "bg-[#181B22] text-white ring-1 ring-[#181B22] dark:bg-[#EAEEF6] dark:text-[#111318] dark:ring-[#EAEEF6]"
                      : "bg-black/[0.035] text-[#111318] ring-1 ring-inset ring-black/[0.06] hover:bg-black/[0.06] dark:bg-white/[0.05] dark:text-[#F2F2F4] dark:ring-white/[0.08] dark:hover:bg-white/[0.09]",
                  )}
                >
                  <span className="block text-xs font-semibold">{option.title}</span>
                  <span
                    className={cn(
                      "mt-0.5 block text-[10.5px]",
                      selected
                        ? "text-white/75 dark:text-[#111318]/70"
                        : "text-[#687082] dark:text-[#8E8E96]",
                    )}
                  >
                    {option.hint}
                  </span>
                </button>
              );
            })}
          </div>
        </fieldset>

        {/* Agent 连续发言轮次预算：使用 Radix 浮层 AppSelect */}
        <div>
          <label htmlFor="create-room-budget" className={LABEL_CLASS}>
            {t("roomModal.create.turnBudgetLabel")}
          </label>
          <AppSelect
            id="create-room-budget"
            value={maxTurns}
            onValueChange={setMaxTurns}
            options={turnBudgetOptions}
            size="md"
            ariaLabel={t("roomModal.create.turnBudgetLabel")}
            className="mt-1.5"
          />
        </div>

        {errMsg ? (
          <div
            role="alert"
            className="rounded-2xl border border-[#E5484D]/25 bg-[#E5484D]/[0.08] px-3.5 py-2.5 text-xs text-[#C81E1E] dark:bg-[#F05252]/12 dark:text-[#FCA5A5]"
          >
            {errMsg}
          </div>
        ) : null}
      </form>
    </ModalDialog>
  );
}

/** `JoinRoomModal` 入参属性 */
export interface JoinRoomModalProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onRoomJoined: (room: RoomDetailDto) => void;
}

/**
 * 从用户粘贴的原始文本中提取纯净邀请令牌。
 *
 * @param raw - 纯邀请码或包含 `/share/<token>` 的完整链接
 * @returns 解码后的邀请令牌
 */
function extractInviteTokenFromRawInput(raw: string): string {
  const trimmed = raw.trim();
  const shareMatch = /\/share\/([^/?#\s]+)/.exec(trimmed);
  if (shareMatch?.[1] !== undefined) {
    try {
      return decodeURIComponent(shareMatch[1]);
    } catch {
      return shareMatch[1];
    }
  }
  return trimmed;
}

/**
 * 凭房间邀请码或分享链接一键加入群聊的弹窗。
 *
 * @param props - 弹窗开关与入群成功跳转回调
 * @returns 入群弹窗
 */
export function JoinRoomModal(props: JoinRoomModalProps) {
  const { locale, t } = useChatDetailI18n();
  const { t: commonT } = useCommonI18n();
  const [rawInput, setRawInput] = useState<string>("");
  const joinMutation = useJoinRoomMutation();

  const parsedToken = extractInviteTokenFromRawInput(rawInput);
  const isLinkInput = rawInput.trim() !== parsedToken && parsedToken.length > 0;

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (parsedToken.length < 4) {
      return;
    }
    joinMutation.mutate(
      { inviteToken: parsedToken },
      {
        onSuccess: (res) => {
          toast.success(t("roomModal.join.successToast", { name: res.room.name }));
          setRawInput("");
          props.onRoomJoined(res.room);
          props.onClose();
        },
        onError: (err) => {
          toast.error(
            resolveChatDetailErrorMessage(err, locale) ?? t("roomModal.join.failedFallback"),
          );
        },
      },
    );
  };

  const errMsg = resolveChatDetailErrorMessage(joinMutation.error, locale);

  return (
    <ModalDialog
      open={props.open}
      onClose={props.onClose}
      title={t("roomModal.join.title")}
      subtitle={t("roomModal.join.subtitle")}
      maxWidthClass="max-w-md"
      icon={<LogIn className="h-4 w-4" />}
      footer={
        <div className="flex select-none items-center justify-end gap-2">
          <AppButton variant="ghost" size="md" onClick={props.onClose}>
            {commonT("action.cancel")}
          </AppButton>
          <AppButton
            type="submit"
            form="join-room-form"
            variant="primary"
            size="md"
            isLoading={joinMutation.isPending}
            disabled={parsedToken.length < 4}
            leadingIcon={<LogIn aria-hidden="true" className="h-3.5 w-3.5" />}
          >
            {t("roomModal.join.submitButton")}
          </AppButton>
        </div>
      }
    >
      <form id="join-room-form" onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label htmlFor="join-room-token-input" className={LABEL_CLASS}>
            {t("roomModal.join.inputLabel")} <span className="text-[#E5484D]">*</span>
          </label>
          <AppInput
            id="join-room-token-input"
            type="text"
            enterKeyHint="done"
            size="lg"
            required={true}
            value={rawInput}
            onChange={(e) => setRawInput(e.target.value)}
            leadingIcon={<Link2 className="h-4 w-4" />}
            placeholder={t("roomModal.join.inputPlaceholder")}
            className="font-mono text-[16px] md:text-xs placeholder:font-sans"
            containerClassName="mt-1.5"
          />
          <AnimatePresence mode="wait" initial={false}>
            {isLinkInput ? (
              <motion.p
                key="parsed-link"
                initial={{ opacity: 0, y: -3 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -3 }}
                transition={{ duration: 0.14 }}
                className="mt-2 flex items-center gap-1.5 text-[11.5px] font-medium text-[#145335] dark:text-[#6EE7B7]"
              >
                <CheckCircle2 aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">
                  {t("roomModal.join.extractedPrefix")}
                  <code className="font-mono font-semibold">{parsedToken}</code>
                </span>
              </motion.p>
            ) : (
              <motion.p
                key="plain-hint"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.12 }}
                className="mt-1.5 text-[11.5px] text-[#687082] dark:text-[#8E8E96]"
              >
                {t("roomModal.join.plainHint")}
              </motion.p>
            )}
          </AnimatePresence>
        </div>

        {errMsg ? (
          <div
            role="alert"
            className="rounded-2xl border border-[#E5484D]/25 bg-[#E5484D]/[0.08] px-3.5 py-2.5 text-xs text-[#C81E1E] dark:bg-[#F05252]/12 dark:text-[#FCA5A5]"
          >
            {errMsg}
          </div>
        ) : null}
      </form>
    </ModalDialog>
  );
}

/** 待删除会话弹窗所需的最小房间投影 */
export interface DeleteRoomTarget {
  readonly id: RoomId;
  readonly kind?: RoomKind | undefined;
  readonly name: string;
  readonly topic: string;
}

/** `DeleteRoomConfirmModal` 入参属性 */
export interface DeleteRoomConfirmModalProps {
  readonly room: DeleteRoomTarget | null;
  readonly isDeleting: boolean;
  readonly error?: unknown;
  readonly onClose: () => void;
  readonly onConfirm: (room: DeleteRoomTarget) => void;
}

/**
 * 人类群主永久删除群聊前的二次危险确认模态窗。
 *
 * @param props - 待删除群聊目标、删除请求加载状态与取消/确认回调
 * @returns 删除群聊确认弹窗
 */
export function DeleteRoomConfirmModal(props: DeleteRoomConfirmModalProps) {
  const { locale, t } = useChatDetailI18n();
  const { t: commonT } = useCommonI18n();
  const lastRoomRef = useRef<DeleteRoomTarget | null>(props.room);
  if (props.room !== null) {
    lastRoomRef.current = props.room;
  }
  const targetRoom = props.room ?? lastRoomRef.current;
  const errMsg = resolveChatDetailErrorMessage(props.error, locale);
  const isDirect =
    targetRoom !== null && targetRoom.kind !== undefined && targetRoom.kind !== "group";

  return (
    <ModalDialog
      open={props.room !== null}
      onClose={props.isDeleting ? () => undefined : props.onClose}
      title={isDirect ? t("roomModal.delete.titleDirect") : t("roomModal.delete.titleGroup")}
      subtitle={t("roomModal.delete.subtitle")}
      maxWidthClass="max-w-md"
      icon={<Trash2 aria-hidden="true" className="h-4 w-4 text-[#C81E1E] dark:text-[#FCA5A5]" />}
    >
      {targetRoom !== null ? (
        <div className="space-y-4">
          {/* 目标群聊预览卡 */}
          <div className="flex select-none items-center gap-3 rounded-[18px] bg-black/[0.035] p-3 ring-1 ring-inset ring-black/[0.05] dark:bg-white/[0.05] dark:ring-white/[0.08]">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[13px] bg-[#181B22] text-white dark:bg-[#EAEEF6] dark:text-[#111318]">
              <Hash aria-hidden="true" className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-[#111318] dark:text-[#F2F2F4]">
                {targetRoom.name}
              </p>
              <p className="mt-0.5 truncate text-[11.5px] text-[#687082] dark:text-[#8E8E96]">
                {targetRoom.topic.trim().length > 0 ? targetRoom.topic : t("roomModal.noTopic")}
              </p>
            </div>
          </div>

          {/* 影响范围与不可逆提示 */}
          <div className="space-y-2 rounded-2xl bg-[#E5484D]/[0.08] p-3.5 text-xs leading-relaxed text-[#7F1D1D] ring-1 ring-inset ring-[#E5484D]/20 dark:bg-[#F05252]/[0.12] dark:text-[#FECACA] dark:ring-[#F05252]/25">
            <div className="flex items-center gap-1.5 font-semibold text-[#C81E1E] dark:text-[#FCA5A5]">
              <AlertTriangle aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
              <span>{t("roomModal.delete.confirmQuestion", { name: targetRoom.name })}</span>
            </div>
            <ul className="list-disc space-y-1 pl-4">
              <li>{t("roomModal.delete.bulletHistory")}</li>
              <li>{t("roomModal.delete.bulletMembers")}</li>
              <li>{t("roomModal.delete.bulletAgentsSafe")}</li>
            </ul>
          </div>

          {errMsg ? (
            <div
              role="alert"
              className="rounded-2xl border border-[#E5484D]/25 bg-[#E5484D]/[0.08] px-3.5 py-2.5 text-xs text-[#C81E1E] dark:bg-[#F05252]/12 dark:text-[#FCA5A5]"
            >
              {errMsg}
            </div>
          ) : null}

          <div className="flex select-none items-center justify-end gap-2 border-t border-black/[0.06] pt-3.5 dark:border-white/[0.08]">
            <AppButton
              variant="ghost"
              size="md"
              disabled={props.isDeleting}
              onClick={props.onClose}
            >
              {commonT("action.cancel")}
            </AppButton>
            <AppButton
              variant="danger"
              size="md"
              isLoading={props.isDeleting}
              leadingIcon={<Trash2 aria-hidden="true" className="h-3.5 w-3.5" />}
              onClick={() => props.onConfirm(targetRoom)}
            >
              {t("roomModal.delete.confirmButton")}
            </AppButton>
          </div>
        </div>
      ) : null}
    </ModalDialog>
  );
}

/** `LeaveRoomConfirmModal` 入参属性 */
export interface LeaveRoomConfirmModalProps {
  readonly room: DeleteRoomTarget | null;
  readonly isLeaving: boolean;
  readonly error?: unknown;
  readonly onClose: () => void;
  readonly onConfirm: (room: DeleteRoomTarget) => void;
}

/**
 * 非群主成员退出群聊前的二次确认模态窗。
 *
 * @param props - 待退出群聊目标、退出请求加载状态与取消/确认回调
 * @returns 退出群聊确认弹窗
 */
export function LeaveRoomConfirmModal(props: LeaveRoomConfirmModalProps) {
  const { locale, t } = useChatDetailI18n();
  const { t: commonT } = useCommonI18n();
  const lastRoomRef = useRef<DeleteRoomTarget | null>(props.room);
  if (props.room !== null) {
    lastRoomRef.current = props.room;
  }
  const targetRoom = props.room ?? lastRoomRef.current;
  const errMsg = resolveChatDetailErrorMessage(props.error, locale);

  return (
    <ModalDialog
      open={props.room !== null}
      onClose={props.isLeaving ? () => undefined : props.onClose}
      title={t("roomModal.leave.title")}
      subtitle={t("roomModal.leave.subtitle")}
      maxWidthClass="max-w-md"
      icon={<LogOut aria-hidden="true" className="h-4 w-4 text-[#C81E1E] dark:text-[#FCA5A5]" />}
    >
      {targetRoom !== null ? (
        <div className="space-y-4">
          {/* 目标群聊预览卡 */}
          <div className="flex select-none items-center gap-3 rounded-[18px] bg-black/[0.035] p-3 ring-1 ring-inset ring-black/[0.05] dark:bg-white/[0.05] dark:ring-white/[0.08]">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[13px] bg-[#181B22] text-white dark:bg-[#EAEEF6] dark:text-[#111318]">
              <Hash aria-hidden="true" className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-[#111318] dark:text-[#F2F2F4]">
                {targetRoom.name}
              </p>
              <p className="mt-0.5 truncate text-[11.5px] text-[#687082] dark:text-[#8E8E96]">
                {targetRoom.topic.trim().length > 0 ? targetRoom.topic : t("roomModal.noTopic")}
              </p>
            </div>
          </div>

          <p className="rounded-2xl bg-black/[0.03] px-3.5 py-3 text-xs leading-relaxed text-[#3B414E] ring-1 ring-inset ring-black/[0.05] dark:bg-white/[0.045] dark:text-[#C4C4CA] dark:ring-white/[0.07]">
            {t("roomModal.leave.confirmBody", { name: targetRoom.name })}
          </p>

          {errMsg ? (
            <div
              role="alert"
              className="rounded-2xl border border-[#E5484D]/25 bg-[#E5484D]/[0.08] px-3.5 py-2.5 text-xs text-[#C81E1E] dark:bg-[#F05252]/12 dark:text-[#FCA5A5]"
            >
              {errMsg}
            </div>
          ) : null}

          <div className="flex select-none items-center justify-end gap-2 border-t border-black/[0.06] pt-3.5 dark:border-white/[0.08]">
            <AppButton variant="ghost" size="md" disabled={props.isLeaving} onClick={props.onClose}>
              {commonT("action.cancel")}
            </AppButton>
            <AppButton
              variant="danger"
              size="md"
              isLoading={props.isLeaving}
              leadingIcon={<LogOut aria-hidden="true" className="h-3.5 w-3.5" />}
              onClick={() => props.onConfirm(targetRoom)}
            >
              {t("roomModal.leave.confirmButton")}
            </AppButton>
          </div>
        </div>
      ) : null}
    </ModalDialog>
  );
}
