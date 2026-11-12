/**
 * @module web/features/huddle-room/room-modals
 * @description 新建 Huddle 协作房间弹窗与凭邀请码/分享链接一键入群弹窗组件。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 新建即防护：默认预填 `maxConsecutiveAgentTurns = 6` 与防抢话读锁，允许创建时直接定制自由讨论或圆桌轮流表态模式。
 * 2. 智能入群解析：同时兼容粘贴纯邀请码（`inv_xxx`）或完整 `/share/inv_xxx` URL，自动提取纯净 `inviteToken`。
 */
import {
  DEFAULT_MAX_CONSECUTIVE_AGENT_TURNS,
  type GovernanceMode,
  type RoomDetailDto,
  type RoomVisibility,
} from "@openhuddle/protocol";
import { Loader2, LogIn, PlusCircle } from "lucide-react";
import { type FormEvent, useState } from "react";
import { ModalDialog } from "../../../components/ui/modal-dialog.js";
import { ApiClientError } from "../../../lib/api-client.js";
import { useCreateRoomMutation, useJoinRoomMutation } from "../api/huddle-room.queries.js";

/** `CreateRoomModal` 入参属性 */
export interface CreateRoomModalProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onRoomCreated: (room: RoomDetailDto) => void;
}

/**
 * 新建多 Agent 协作 Huddle 房间配置模态框。
 *
 * @param props - 打开状态与创建成功跳转回调
 * @returns 新建房间弹窗
 */
export function CreateRoomModal(props: CreateRoomModalProps) {
  const [name, setName] = useState<string>("");
  const [topic, setTopic] = useState<string>("");
  const [rules, setRules] = useState<string>("");
  const [visibility, setVisibility] = useState<RoomVisibility>("invite_only");
  const [mode, setMode] = useState<GovernanceMode>("free");
  const [maxTurns, setMaxTurns] = useState<number>(DEFAULT_MAX_CONSECUTIVE_AGENT_TURNS);

  const createMutation = useCreateRoomMutation();

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
          maxConsecutiveAgentTurns: maxTurns,
          allowAgentMentions: true,
          requireReadBeforeSend: true,
        },
      },
      {
        onSuccess: (res) => {
          setName("");
          setTopic("");
          setRules("");
          props.onRoomCreated(res.room);
          props.onClose();
        },
      },
    );
  };

  const errMsg =
    createMutation.error instanceof ApiClientError
      ? createMutation.error.message
      : createMutation.error instanceof Error
        ? createMutation.error.message
        : null;

  return (
    <ModalDialog
      open={props.open}
      onClose={props.onClose}
      title="创建新 Huddle 协作房间"
      subtitle="配置讨论议题、群规与初始防死循环轮次预算"
      maxWidthClass="max-w-lg"
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label
            htmlFor="create-room-name"
            className="block text-xs font-semibold text-slate-700 dark:text-slate-300"
          >
            房间名称 (Room Name) *
          </label>
          <input
            id="create-room-name"
            type="text"
            required={true}
            maxLength={100}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如：v0.2 实时同步引擎架构评审"
            className="mt-1.5 w-full rounded-xl border border-slate-200 bg-slate-50/70 px-3.5 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:bg-white focus:outline-none dark:border-white/10 dark:bg-[#0b0e15] dark:text-white"
          />
        </div>

        <div>
          <label
            htmlFor="create-room-topic"
            className="block text-xs font-semibold text-slate-700 dark:text-slate-300"
          >
            核心议题摘要 (Topic)
          </label>
          <input
            id="create-room-topic"
            type="text"
            maxLength={500}
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder="需要各 Agent 交叉审查并收敛的目标问题..."
            className="mt-1.5 w-full rounded-xl border border-slate-200 bg-slate-50/70 px-3.5 py-2 text-xs text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:bg-white focus:outline-none dark:border-white/10 dark:bg-[#0b0e15] dark:text-white"
          />
        </div>

        <div>
          <label
            htmlFor="create-room-rules"
            className="block text-xs font-semibold text-slate-700 dark:text-slate-300"
          >
            房间讨论公约 (Rules，展示给所有入群 Agent)
          </label>
          <textarea
            id="create-room-rules"
            rows={2}
            maxLength={2000}
            value={rules}
            onChange={(e) => setRules(e.target.value)}
            placeholder="例如：请优先给定量数据与权衡对比表，避免空洞复读同意。"
            className="mt-1.5 w-full rounded-xl border border-slate-200 bg-slate-50/70 px-3.5 py-2 text-xs text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:bg-white focus:outline-none dark:border-white/10 dark:bg-[#0b0e15] dark:text-white"
          />
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div>
            <label
              htmlFor="create-room-mode"
              className="block text-xs font-semibold text-slate-700 dark:text-slate-300"
            >
              讨论组织模式
            </label>
            <select
              id="create-room-mode"
              value={mode}
              onChange={(e) => setMode(e.target.value as GovernanceMode)}
              className="mt-1.5 w-full rounded-xl border border-slate-200 bg-white px-2.5 py-2 text-xs text-slate-800 dark:border-white/10 dark:bg-[#0b0e15] dark:text-slate-200"
            >
              <option value="free">Free · 自由讨论</option>
              <option value="round_table">Round Table · 圆桌轮流</option>
              <option value="proposal">Proposal · 提案收敛</option>
            </select>
          </div>

          <div>
            <label
              htmlFor="create-room-budget"
              className="block text-xs font-semibold text-slate-700 dark:text-slate-300"
            >
              连续 Agent 轮次上限
            </label>
            <select
              id="create-room-budget"
              value={String(maxTurns)}
              onChange={(e) => setMaxTurns(Number(e.target.value))}
              className="mt-1.5 w-full rounded-xl border border-slate-200 bg-white px-2.5 py-2 text-xs text-slate-800 dark:border-white/10 dark:bg-[#0b0e15] dark:text-slate-200"
            >
              <option value="4">4 轮（严格节流）</option>
              <option value="6">6 轮（推荐默认）</option>
              <option value="10">10 轮（深度辩论）</option>
              <option value="16">16 轮（宽松探索）</option>
            </select>
          </div>

          <div>
            <label
              htmlFor="create-room-visibility"
              className="block text-xs font-semibold text-slate-700 dark:text-slate-300"
            >
              可见性策略
            </label>
            <select
              id="create-room-visibility"
              value={visibility}
              onChange={(e) => setVisibility(e.target.value as RoomVisibility)}
              className="mt-1.5 w-full rounded-xl border border-slate-200 bg-white px-2.5 py-2 text-xs text-slate-800 dark:border-white/10 dark:bg-[#0b0e15] dark:text-slate-200"
            >
              <option value="invite_only">仅受邀成员可见</option>
              <option value="public_shareable">允许公开只读回放</option>
            </select>
          </div>
        </div>

        {errMsg ? (
          <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-700 dark:text-rose-300">
            {errMsg}
          </div>
        ) : null}

        <div className="flex items-center justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={props.onClose}
            className="rounded-xl border border-slate-200 px-3.5 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50 dark:border-white/10 dark:text-slate-300 dark:hover:bg-white/10"
          >
            取消
          </button>
          <button
            type="submit"
            disabled={createMutation.isPending || name.trim().length === 0}
            className="inline-flex items-center gap-1.5 rounded-xl bg-indigo-600 px-4 py-2 text-xs font-semibold text-white shadow-xs transition hover:bg-indigo-500 disabled:opacity-50"
          >
            {createMutation.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <PlusCircle className="h-3.5 w-3.5" />
            )}
            <span>立即创建房间</span>
          </button>
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

function extractInviteTokenFromRawInput(raw: string): string {
  const trimmed = raw.trim();
  const shareMatch = /\/share\/([^/?#\s]+)/.exec(trimmed);
  if (shareMatch?.[1] !== undefined) {
    return decodeURIComponent(shareMatch[1]);
  }
  return trimmed;
}

/**
 * 凭房间邀请码或分享链接一键加入协作群聊的弹窗。
 *
 * @param props - 弹窗开关与入群成功跳转回调
 * @returns 入群弹窗
 */
export function JoinRoomModal(props: JoinRoomModalProps) {
  const [rawInput, setRawInput] = useState<string>("");
  const joinMutation = useJoinRoomMutation();

  const parsedToken = extractInviteTokenFromRawInput(rawInput);

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (parsedToken.length < 4) {
      return;
    }
    joinMutation.mutate(
      { inviteToken: parsedToken },
      {
        onSuccess: (res) => {
          setRawInput("");
          props.onRoomJoined(res.room);
          props.onClose();
        },
      },
    );
  };

  const errMsg =
    joinMutation.error instanceof ApiClientError
      ? joinMutation.error.message
      : joinMutation.error instanceof Error
        ? joinMutation.error.message
        : null;

  return (
    <ModalDialog
      open={props.open}
      onClose={props.onClose}
      title="凭邀请令牌加入 Huddle 房间"
      subtitle="粘贴同事分享的房间 Invite Token 或公开回放链接即可加入"
      maxWidthClass="max-w-md"
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label
            htmlFor="join-room-token-input"
            className="block text-xs font-semibold text-slate-700 dark:text-slate-300"
          >
            房间邀请令牌 (Invite Token) *
          </label>
          <input
            id="join-room-token-input"
            type="text"
            required={true}
            value={rawInput}
            onChange={(e) => setRawInput(e.target.value)}
            placeholder="例如：inv_01jk9x... 或 https://.../share/inv_..."
            className="mt-1.5 w-full rounded-xl border border-slate-200 bg-slate-50/70 px-3.5 py-2.5 font-mono text-xs text-slate-900 placeholder:font-sans placeholder:text-slate-400 focus:border-indigo-500 focus:bg-white focus:outline-none dark:border-white/10 dark:bg-[#0b0e15] dark:text-white"
          />
        </div>

        {errMsg ? (
          <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-700 dark:text-rose-300">
            {errMsg}
          </div>
        ) : null}

        <div className="flex items-center justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={props.onClose}
            className="rounded-xl border border-slate-200 px-3.5 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50 dark:border-white/10 dark:text-slate-300 dark:hover:bg-white/10"
          >
            取消
          </button>
          <button
            type="submit"
            disabled={joinMutation.isPending || parsedToken.length < 4}
            className="inline-flex items-center gap-1.5 rounded-xl bg-indigo-600 px-4 py-2 text-xs font-semibold text-white shadow-xs transition hover:bg-indigo-500 disabled:opacity-50"
          >
            {joinMutation.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <LogIn className="h-3.5 w-3.5" />
            )}
            <span>加入房间</span>
          </button>
        </div>
      </form>
    </ModalDialog>
  );
}
