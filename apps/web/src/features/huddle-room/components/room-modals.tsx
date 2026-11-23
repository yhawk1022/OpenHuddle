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
import { type FormEvent, useState } from "react";
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
import { ApiClientError } from "../../../lib/api-client.js";
import { getPlatformVisualMeta } from "../../../lib/format.js";
import { useCreateRoomMutation, useJoinRoomMutation } from "../api/huddle-room.queries.js";

const LABEL_CLASS = "block text-xs font-medium text-[#3B414E] dark:text-[#C4C4CA]";

/** 房间讨论组织模式候选项 */
const GOVERNANCE_MODE_OPTIONS: ReadonlyArray<{
  readonly value: GovernanceMode;
  readonly title: string;
  readonly hint: string;
}> = [
  { value: "free", title: "自由讨论", hint: "谁有想法谁先说" },
  { value: "round_table", title: "圆桌轮流", hint: "按顺序逐个发言" },
  { value: "proposal", title: "提案收敛", hint: "聚焦方案与拍板" },
];

/** 房间可见范围分段控制器选项 */
const VISIBILITY_TABS: ReadonlyArray<SegmentedTabItem<RoomVisibility>> = [
  {
    value: "invite_only",
    label: "仅受邀进群",
    icon: <Lock className="h-3.5 w-3.5" />,
  },
  {
    value: "public_shareable",
    label: "允许公开只读回放",
    icon: <Globe className="h-3.5 w-3.5" />,
  },
];

/** Agent 连续发言预算字符串字面量枚举（适配 Radix `AppSelect` 非空字符串泛型） */
type TurnBudgetValue = "4" | "6" | "10" | "16";

const TURN_BUDGET_OPTIONS: ReadonlyArray<AppSelectOption<TurnBudgetValue>> = [
  { value: "4", label: "4 轮（紧凑节流）", description: "每 4 条 AI 发言后等待人类表态" },
  { value: "6", label: "6 轮（推荐默认）", description: "兼顾多方核对事实与讨论节奏" },
  { value: "10", label: "10 轮（深入讨论）", description: "适合复杂方案对比与多轮追问" },
  { value: "16", label: "16 轮（充分展开）", description: "允许更多 Agent 连续发散推演" },
];

/**
 * 统一解析 TanStack Mutation 错误为可读文案。
 *
 * @param error - Mutation 抛出的未知错误
 * @returns 用户可读的错误信息；无错误时返回 `null`
 */
function resolveMutationErrorMessage(error: unknown): string | null {
  if (error instanceof ApiClientError) {
    return error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return null;
}

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
            pulledParts.push(`${String(selectedUserIds.size)} 位好友`);
          }
          if (selectedAgentIds.size > 0) {
            pulledParts.push(`${String(selectedAgentIds.size)} 个个人 Agent`);
          }
          toast.success(`群聊「${res.room.name}」已建好`, {
            description:
              pulledParts.length > 0
                ? `已直拉 ${pulledParts.join("、")} 入群`
                : "现在可以把自己的 Agent 拉进来，或发邀请码给同伴",
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
          toast.error(resolveMutationErrorMessage(err) ?? "新建群聊失败，请稍后重试");
        },
      },
    );
  };

  const errMsg = resolveMutationErrorMessage(createMutation.error);
  const previewName = name.trim().length > 0 ? name.trim() : "未命名群聊";

  return (
    <ModalDialog
      open={props.open}
      onClose={props.onClose}
      title="新建群聊"
      subtitle="拉上同伴和各自的 Agent，在一个群里核对事实、把方案聊透"
      maxWidthClass="max-w-lg"
      icon={<MessagesSquare className="h-4 w-4" />}
    >
      <form onSubmit={handleSubmit} className="space-y-4">
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
                {visibility === "public_shareable" ? "可公开回放" : "仅受邀"}
              </span>
            </div>
            <p className="mt-0.5 truncate text-[11.5px] text-[#687082] dark:text-[#8E8E96]">
              {topic.trim().length > 0 ? topic.trim() : "写一句群主题，大家进群就知道聊什么"}
            </p>
          </div>
        </div>

        <div>
          <label htmlFor="create-room-name" className={LABEL_CLASS}>
            群名称 <span className="text-[#E5484D]">*</span>
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
            placeholder="例如：v0.2 实时同步方案评审"
            containerClassName="mt-1.5"
          />
        </div>

        {/* 建群直拉好友：已添加的好友可直接勾选入群，免发邀请码 */}
        {availableFriends.length > 0 ? (
          <div>
            <span className={LABEL_CLASS}>
              直接拉入我的好友{" "}
              <span className="font-normal text-[#8E96A6] dark:text-[#63636B]">
                （建群即入群，可选）
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
              直接拉入我的 Agent{" "}
              <span className="font-normal text-[#8E96A6] dark:text-[#63636B]">
                （建群即入群，可选）
              </span>
            </span>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {props.ownedAgents.map((agent) => {
                const meta = getPlatformVisualMeta(agent.platform);
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
            讨论主题
          </label>
          <AppInput
            id="create-room-topic"
            type="text"
            size="md"
            maxLength={500}
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder="想让群里的 Agent 帮你一起搞清楚什么问题？"
            containerClassName="mt-1.5"
          />
        </div>

        <div>
          <label htmlFor="create-room-rules" className={LABEL_CLASS}>
            群内约定{" "}
            <span className="font-normal text-[#8E96A6] dark:text-[#63636B]">
              （所有进群的 Agent 都会先读一遍）
            </span>
          </label>
          <AppTextarea
            id="create-room-rules"
            rows={2}
            maxLength={2000}
            value={rules}
            onChange={(e) => setRules(e.target.value)}
            placeholder="例如：发言尽量简短，给具体事实与取舍依据，不要客套附和。"
            className="mt-1.5 resize-none"
          />
        </div>

        {/* 可见范围：使用全胶囊 SegmentedTabs */}
        <div>
          <span className={LABEL_CLASS}>谁能看到这个群</span>
          <SegmentedTabs
            value={visibility}
            onValueChange={setVisibility}
            items={VISIBILITY_TABS}
            size="md"
            fullWidth={true}
            ariaLabel="房间可见范围"
            className="mt-1.5"
          />
        </div>

        {/* 讨论组织模式：高对比三栏卡片 */}
        <fieldset>
          <legend className={LABEL_CLASS}>聊天节奏</legend>
          <div className="mt-1.5 grid grid-cols-3 gap-2">
            {GOVERNANCE_MODE_OPTIONS.map((option) => {
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
            Agent 连续发言上限
          </label>
          <AppSelect
            id="create-room-budget"
            value={maxTurns}
            onValueChange={setMaxTurns}
            options={TURN_BUDGET_OPTIONS}
            size="md"
            ariaLabel="Agent 连续发言上限"
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

        <div className="flex select-none items-center justify-end gap-2 border-t border-black/[0.06] pt-3.5 dark:border-white/[0.08]">
          <AppButton variant="ghost" size="md" onClick={props.onClose}>
            取消
          </AppButton>
          <AppButton
            type="submit"
            variant="primary"
            size="md"
            isLoading={createMutation.isPending}
            disabled={name.trim().length === 0}
            leadingIcon={<Plus aria-hidden="true" className="h-3.5 w-3.5" />}
          >
            创建群聊
          </AppButton>
        </div>
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
    return decodeURIComponent(shareMatch[1]);
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
          toast.success(`已加入群聊「${res.room.name}」`);
          setRawInput("");
          props.onRoomJoined(res.room);
          props.onClose();
        },
        onError: (err) => {
          toast.error(resolveMutationErrorMessage(err) ?? "进群失败，请确认邀请码是否正确");
        },
      },
    );
  };

  const errMsg = resolveMutationErrorMessage(joinMutation.error);

  return (
    <ModalDialog
      open={props.open}
      onClose={props.onClose}
      title="加入群聊"
      subtitle="粘贴同伴发来的群邀请码或回放链接即可进群"
      maxWidthClass="max-w-md"
      icon={<LogIn className="h-4 w-4" />}
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label htmlFor="join-room-token-input" className={LABEL_CLASS}>
            邀请码或分享链接 <span className="text-[#E5484D]">*</span>
          </label>
          <AppInput
            id="join-room-token-input"
            type="text"
            size="lg"
            required={true}
            value={rawInput}
            onChange={(e) => setRawInput(e.target.value)}
            leadingIcon={<Link2 className="h-4 w-4" />}
            placeholder="inv_01jk9x... 或 https://.../share/inv_..."
            className="font-mono text-xs placeholder:font-sans"
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
                  已从链接提取邀请码：<code className="font-mono font-semibold">{parsedToken}</code>
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
                直接粘贴完整的 /share/ 链接也可以，会自动提取邀请码。
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

        <div className="flex select-none items-center justify-end gap-2 border-t border-black/[0.06] pt-3.5 dark:border-white/[0.08]">
          <AppButton variant="ghost" size="md" onClick={props.onClose}>
            取消
          </AppButton>
          <AppButton
            type="submit"
            variant="primary"
            size="md"
            isLoading={joinMutation.isPending}
            disabled={parsedToken.length < 4}
            leadingIcon={<LogIn aria-hidden="true" className="h-3.5 w-3.5" />}
          >
            加入群聊
          </AppButton>
        </div>
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
  const targetRoom = props.room;
  const errMsg = resolveMutationErrorMessage(props.error);
  const isDirect =
    targetRoom !== null && targetRoom.kind !== undefined && targetRoom.kind !== "group";

  return (
    <ModalDialog
      open={targetRoom !== null}
      onClose={props.isDeleting ? () => undefined : props.onClose}
      title={isDirect ? "删除单聊会话" : "删除群聊"}
      subtitle="此操作不可撤销，请确认后继续"
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
                {targetRoom.topic.trim().length > 0 ? targetRoom.topic : "未设置讨论主题"}
              </p>
            </div>
          </div>

          {/* 影响范围与不可逆提示 */}
          <div className="space-y-2 rounded-2xl bg-[#E5484D]/[0.08] p-3.5 text-xs leading-relaxed text-[#7F1D1D] ring-1 ring-inset ring-[#E5484D]/20 dark:bg-[#F05252]/[0.12] dark:text-[#FECACA] dark:ring-[#F05252]/25">
            <div className="flex items-center gap-1.5 font-semibold text-[#C81E1E] dark:text-[#FCA5A5]">
              <AlertTriangle aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
              <span>确定永久删除「{targetRoom.name}」吗？</span>
            </div>
            <ul className="list-disc space-y-1 pl-4">
              <li>永久删除群聊及全部消息、提案卡片与投票记录；</li>
              <li>所有群成员与 Agent 将同步移出该群，邀请码与公开只读分享链接立即失效；</li>
              <li>你名下已绑定的个人 Agent 不会被删除，仍可在其他群聊中继续使用。</li>
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
              取消
            </AppButton>
            <AppButton
              variant="danger"
              size="md"
              isLoading={props.isDeleting}
              leadingIcon={<Trash2 aria-hidden="true" className="h-3.5 w-3.5" />}
              onClick={() => props.onConfirm(targetRoom)}
            >
              确认永久删除
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
  const targetRoom = props.room;
  const errMsg = resolveMutationErrorMessage(props.error);

  return (
    <ModalDialog
      open={targetRoom !== null}
      onClose={props.isLeaving ? () => undefined : props.onClose}
      title="退出群聊"
      subtitle="退出后需要重新使用邀请码才能再次加入"
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
                {targetRoom.topic.trim().length > 0 ? targetRoom.topic : "未设置讨论主题"}
              </p>
            </div>
          </div>

          <p className="rounded-2xl bg-black/[0.03] px-3.5 py-3 text-xs leading-relaxed text-[#3B414E] ring-1 ring-inset ring-black/[0.05] dark:bg-white/[0.045] dark:text-[#C4C4CA] dark:ring-white/[0.07]">
            确定退出「{targetRoom.name}
            」吗？历史讨论记录与其他成员不受影响；若你此前已拉入自己的
            Agent，它们仍保留在群内直到你单独移出或删除。
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
              取消
            </AppButton>
            <AppButton
              variant="danger"
              size="md"
              isLoading={props.isLeaving}
              leadingIcon={<LogOut aria-hidden="true" className="h-3.5 w-3.5" />}
              onClick={() => props.onConfirm(targetRoom)}
            >
              确认退出群聊
            </AppButton>
          </div>
        </div>
      ) : null}
    </ModalDialog>
  );
}
