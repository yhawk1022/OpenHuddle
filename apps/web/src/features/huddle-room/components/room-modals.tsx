/**
 * @module web/features/huddle-room/room-modals
 * @description Pachat 极简风格「新建群聊」与「加入群聊」模态窗组件。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 新建即防护：默认预填 `maxConsecutiveAgentTurns = 6` 与防抢话乐观读锁（`requireReadBeforeSend = true`），创建时可一键选择自由聊、轮流聊或提案收敛模式。
 * 2. 智能入群解析：同时兼容粘贴纯邀请码（`inv_xxx`）或完整 `/share/inv_xxx` 回放链接，自动提取并解码纯净 `inviteToken`。
 * 3. Pachat 单色极简与暗色安全：全量采用 `AppInput`、`AppTextarea`、`SegmentedTabs`、`AppSelect` 与 `rounded-full` `AppButton`，零原生下拉框、零蓝紫渐变，暗色输入框恒保持 `#18181B` 深色底面。
 */
import {
  type AgentId,
  DEFAULT_MAX_CONSECUTIVE_AGENT_TURNS,
  type GovernanceMode,
  type OwnedAgentSummaryDto,
  type RoomDetailDto,
  type RoomVisibility,
} from "@openhuddle/protocol";
import { CheckCircle2, Globe, Hash, Link2, Lock, LogIn, MessagesSquare, Plus } from "lucide-react";
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

const LABEL_CLASS = "block text-xs font-medium text-[#3A3A3C] dark:text-zinc-300";

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
}

/**
 * 新建多 Agent 群聊配置模态框。
 *
 * @param props - 打开状态、创建成功跳转回调与已接入 Agent 列表
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

  const createMutation = useCreateRoomMutation();

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
      },
      {
        onSuccess: (res) => {
          toast.success(`群聊「${res.room.name}」已建好`, {
            description:
              selectedAgentIds.size > 0
                ? `已直拉 ${String(selectedAgentIds.size)} 个个人 Agent 入群`
                : "现在可以把自己的 Agent 拉进来，或发邀请码给同伴",
          });
          setName("");
          setTopic("");
          setRules("");
          setSelectedAgentIds(new Set());
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
        {/* 群聊即时预览卡片：纯正 Pachat 暖白/浅灰纸面 + 圆形墨黑头像 */}
        <div className="flex select-none items-center gap-3 rounded-[18px] bg-[#F5F5F7] p-3 ring-1 ring-inset ring-black/[0.05] dark:bg-[#222226] dark:ring-white/[0.07]">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#141414] text-white dark:bg-[#F5F5F7] dark:text-[#141414]">
            <Hash aria-hidden="true" className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <p className="truncate text-sm font-semibold text-[#141414] dark:text-zinc-100">
                {previewName}
              </p>
              <span
                className={cn(
                  "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-medium",
                  visibility === "public_shareable"
                    ? "bg-[#E4F4EA] text-[#215236] dark:bg-[#192920] dark:text-[#86E0A6]"
                    : "bg-black/[0.06] text-[#5F5F64] dark:bg-white/[0.09] dark:text-zinc-300",
                )}
              >
                {visibility === "public_shareable" ? "可公开回放" : "仅受邀"}
              </span>
            </div>
            <p className="mt-0.5 truncate text-[11.5px] text-[#6E6E73] dark:text-zinc-400">
              {topic.trim().length > 0 ? topic.trim() : "写一句群主题，大家进群就知道聊什么"}
            </p>
          </div>
        </div>

        <div>
          <label htmlFor="create-room-name" className={LABEL_CLASS}>
            群名称 <span className="text-[#FF3B30]">*</span>
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

        {/* 建群直拉本人 Agent：服务端按归属校验后直接写入成员，免发提示词 */}
        {props.ownedAgents.length > 0 ? (
          <div>
            <span className={LABEL_CLASS}>
              直接拉入我的 Agent{" "}
              <span className="font-normal text-[#8E8E93] dark:text-zinc-500">
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
                        ? "bg-[#F5F5F7] text-[#141414] ring-[1.5px] ring-[#141414] dark:bg-[#27272A] dark:text-zinc-100 dark:ring-[#F5F5F7]"
                        : "bg-white text-[#3A3A3C] ring-1 ring-inset ring-black/[0.08] hover:bg-[#F8F8FA] dark:bg-[#18181B] dark:text-zinc-300 dark:ring-white/[0.1] dark:hover:bg-[#222226]",
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
            <span className="font-normal text-[#8E8E93] dark:text-zinc-500">
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

        {/* 可见范围：使用 motion 弹簧滑动胶囊 SegmentedTabs */}
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

        {/* 讨论组织模式：纯墨黑选中态三栏卡片 */}
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
                      ? "bg-[#141414] text-white ring-1 ring-[#141414] dark:bg-[#F5F5F7] dark:text-[#141414] dark:ring-[#F5F5F7]"
                      : "bg-[#F5F5F7] text-[#141414] ring-1 ring-inset ring-black/[0.06] hover:bg-[#EFEFF3] dark:bg-[#222226] dark:text-zinc-100 dark:ring-white/[0.08] dark:hover:bg-[#2A2A2F]",
                  )}
                >
                  <span className="block text-xs font-semibold">{option.title}</span>
                  <span
                    className={cn(
                      "mt-0.5 block text-[10.5px]",
                      selected
                        ? "text-white/75 dark:text-[#141414]/70"
                        : "text-[#6E6E73] dark:text-zinc-400",
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
            className="rounded-2xl border border-[#FF3B30]/25 bg-[#FF3B30]/[0.07] px-3.5 py-2.5 text-xs text-[#D70015] dark:bg-[#FF453A]/12 dark:text-[#FF6961]"
          >
            {errMsg}
          </div>
        ) : null}

        <div className="flex select-none items-center justify-end gap-2 border-t border-black/[0.07] pt-3.5 dark:border-white/[0.08]">
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
            邀请码或分享链接 <span className="text-[#FF3B30]">*</span>
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
                className="mt-2 flex items-center gap-1.5 text-[11.5px] font-medium text-[#215236] dark:text-[#86E0A6]"
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
                className="mt-1.5 text-[11.5px] text-[#6E6E73] dark:text-zinc-400"
              >
                直接粘贴完整的 /share/ 链接也可以，会自动提取邀请码。
              </motion.p>
            )}
          </AnimatePresence>
        </div>

        {errMsg ? (
          <div
            role="alert"
            className="rounded-2xl border border-[#FF3B30]/25 bg-[#FF3B30]/[0.07] px-3.5 py-2.5 text-xs text-[#D70015] dark:bg-[#FF453A]/12 dark:text-[#FF6961]"
          >
            {errMsg}
          </div>
        ) : null}

        <div className="flex select-none items-center justify-end gap-2 border-t border-black/[0.07] pt-3.5 dark:border-white/[0.08]">
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
