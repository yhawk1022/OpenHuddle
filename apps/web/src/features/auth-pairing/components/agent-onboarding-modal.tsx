/**
 * @module web/features/auth-pairing/agent-onboarding-modal
 * @description Pachat 增强版双标签「10 秒拉入我的 Agent & 邀请协作者/公开分享」核心弹窗组件。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 宿主平台预设定制：支持选择 `Antigravity` / `Codex` / `Claude Code` / `Cursor` / `DeepSeek` 等宿主预设，一键生成绑定当前房间的 `HUDDLE-XXXX-XXXX` 短码与可直接粘贴执行的引导提示词。
 * 2. 原身份无损重连（`--reclaim`）：支持为已绑定的失联 Agent 生成恢复配对码，复用原有 `AgentId`、历史群成员身份与消息游标，杜绝僵尸分身。
 */
import type {
  AgentId,
  AgentPlatform,
  CreatePairingCodeResponse,
  HumanUserDto,
  OwnedAgentSummaryDto,
  RoomDetailDto,
} from "@openhuddle/protocol";
import {
  Bot,
  Check,
  Copy,
  ExternalLink,
  Globe,
  KeyRound,
  Link2,
  Loader2,
  Lock,
  RefreshCw,
  Share2,
  Sparkles,
  Terminal,
  UserPlus,
} from "lucide-react";
import { useEffect, useState } from "react";
import {
  PlatformAvatar,
  PlatformTagPill,
  ReachStatusBadge,
} from "../../../components/ui/identity-badges.js";
import { ModalDialog } from "../../../components/ui/modal-dialog.js";
import { ApiClientError } from "../../../lib/api-client.js";
import { getPlatformVisualMeta } from "../../../lib/format.js";
import {
  useCreatePairingCodeMutation,
  useRoomShareVisibilityMutation,
} from "../api/auth-pairing.queries.js";

const PLATFORM_PRESETS: ReadonlyArray<AgentPlatform> = [
  "antigravity",
  "codex",
  "claude_code",
  "cursor",
  "deepseek",
  "gemini",
  "openclaw",
  "custom",
];

/** 打开配对与邀请弹窗时的初始视图意图 */
export type OnboardingModalTab = "pair_agent" | "invite_share";

/** `AgentOnboardingModal` 入参属性 */
export interface AgentOnboardingModalProps {
  readonly open: boolean;
  readonly initialTab?: OnboardingModalTab | undefined;
  readonly initialReclaimAgentId?: AgentId | null | undefined;
  readonly currentUser: HumanUserDto;
  readonly ownedAgents: ReadonlyArray<OwnedAgentSummaryDto>;
  readonly activeRoom?: RoomDetailDto | null | undefined;
  readonly onClose: () => void;
}

/**
 * 渲染双标签「拉入我的个人 Agent」与「邀请协作者 / 公开分享回放」模态框。
 *
 * @param props - 当前用户、已绑定 Agent 列表、当前激活房间与弹窗控制参数
 * @returns 双标签引导模态框
 */
export function AgentOnboardingModal(props: AgentOnboardingModalProps) {
  const [activeTab, setActiveTab] = useState<OnboardingModalTab>(props.initialTab ?? "pair_agent");
  const [selectedPlatform, setSelectedPlatform] = useState<AgentPlatform>("antigravity");
  const [reclaimAgentId, setReclaimAgentId] = useState<AgentId | null>(
    props.initialReclaimAgentId ?? null,
  );
  const [autoJoinActiveRoom, setAutoJoinActiveRoom] = useState<boolean>(true);
  const [generatedPairing, setGeneratedPairing] = useState<CreatePairingCodeResponse | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const pairingMutation = useCreatePairingCodeMutation();
  const visibilityMutation = useRoomShareVisibilityMutation();

  // 当外部打开弹窗并传入特定初始标签或待恢复 Agent ID 时，对齐局部交互视图状态
  useEffect(() => {
    if (props.open) {
      setActiveTab(props.initialTab ?? "pair_agent");
      setReclaimAgentId(props.initialReclaimAgentId ?? null);
      setGeneratedPairing(null);
    }
  }, [props.open, props.initialTab, props.initialReclaimAgentId]);

  const platformMeta = getPlatformVisualMeta(selectedPlatform);
  const reclaimTarget =
    reclaimAgentId !== null
      ? (props.ownedAgents.find((item) => item.id === reclaimAgentId) ?? null)
      : null;

  const triggerCopy = (key: string, text: string): void => {
    if (typeof navigator === "undefined" || !navigator.clipboard) {
      return;
    }
    void navigator.clipboard.writeText(text).then(() => {
      setCopiedKey(key);
      window.setTimeout(() => {
        setCopiedKey((prev) => (prev === key ? null : prev));
      }, 2_000);
    });
  };

  const handleGenerateCode = (): void => {
    const targetRoomId = autoJoinActiveRoom && props.activeRoom ? props.activeRoom.id : undefined;
    pairingMutation.mutate(
      {
        ...(targetRoomId !== undefined ? { autoJoinRoomId: targetRoomId } : {}),
        ...(reclaimAgentId !== null ? { reclaimAgentId } : {}),
        expiresInHours: 24,
      },
      {
        onSuccess: (res) => {
          setGeneratedPairing(res);
        },
      },
    );
  };

  // 基于服务端权威返回的 onboardingPrompt 拼接宿主平台与建议昵称微调指引，方便一键粘贴
  const suggestedAgentName = reclaimTarget
    ? reclaimTarget.displayName
    : `${props.currentUser.displayName}-${platformMeta.label.replace(/\s+/g, "")}`;

  const readyToPastePrompt = generatedPairing
    ? `${generatedPairing.onboardingPrompt}\n（推荐注册名称："${suggestedAgentName}"，平台标识："${selectedPlatform}"${
        reclaimTarget ? "，请附带 --reclaim 恢复原身份" : ""
      }）`
    : "";

  const shareUrl =
    props.activeRoom?.inviteToken !== undefined && typeof window !== "undefined"
      ? `${window.location.origin}/share/${encodeURIComponent(props.activeRoom.inviteToken)}`
      : null;

  const mutationError =
    pairingMutation.error instanceof ApiClientError
      ? pairingMutation.error.message
      : pairingMutation.error instanceof Error
        ? pairingMutation.error.message
        : null;

  return (
    <ModalDialog
      open={props.open}
      onClose={props.onClose}
      title="连接个人 Agent 与房间协作邀请"
      subtitle="10 秒将你的本地 AI 编程助手拉入当前群聊，或分享只读决策回放链接"
      maxWidthClass="max-w-2xl"
    >
      <div className="space-y-5">
        {/* 顶部双 Tab 切换器 */}
        <div className="grid grid-cols-2 gap-1.5 rounded-xl border border-slate-200/80 bg-slate-100/80 p-1 dark:border-white/[0.08] dark:bg-white/[0.04]">
          <button
            type="button"
            onClick={() => setActiveTab("pair_agent")}
            className={`inline-flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-xs font-semibold transition ${
              activeTab === "pair_agent"
                ? "bg-white text-slate-900 shadow-xs dark:bg-indigo-600 dark:text-white"
                : "text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white"
            }`}
          >
            <Bot className="h-3.5 w-3.5" />
            <span>拉入我的 Agent (10s 配对)</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab("invite_share")}
            className={`inline-flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-xs font-semibold transition ${
              activeTab === "invite_share"
                ? "bg-white text-slate-900 shadow-xs dark:bg-indigo-600 dark:text-white"
                : "text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white"
            }`}
          >
            <UserPlus className="h-3.5 w-3.5" />
            <span>邀请协作者 / 公开分享页</span>
          </button>
        </div>

        {activeTab === "pair_agent" ? (
          <div className="space-y-5">
            {/* 1. 选择宿主平台预设胶囊 */}
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="font-semibold text-slate-800 dark:text-slate-200">
                  1. 选择你的个人 Agent 宿主环境
                </span>
                <span className="text-[11px] text-slate-500 dark:text-slate-400">
                  {platformMeta.cliHint}
                </span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {PLATFORM_PRESETS.map((platform) => {
                  const meta = getPlatformVisualMeta(platform);
                  const isSelected = selectedPlatform === platform;
                  return (
                    <button
                      key={platform}
                      type="button"
                      onClick={() => {
                        setSelectedPlatform(platform);
                      }}
                      className={`inline-flex items-center gap-1.5 rounded-xl border px-2.5 py-1.5 text-xs font-medium transition ${
                        isSelected
                          ? "border-indigo-500 bg-indigo-500/12 text-indigo-700 ring-1 ring-indigo-500/30 dark:text-indigo-300"
                          : "border-slate-200/80 bg-white text-slate-600 hover:bg-slate-50 dark:border-white/10 dark:bg-white/[0.03] dark:text-slate-300 dark:hover:bg-white/[0.07]"
                      }`}
                    >
                      <span
                        className={`inline-flex h-4 w-4 items-center justify-center rounded text-[9px] font-bold ${meta.avatarClass}`}
                      >
                        {meta.monogram}
                      </span>
                      <span>{meta.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* 2. 配对范围与可选 --reclaim 原身份重连设置 */}
            <div className="grid gap-3 rounded-2xl border border-slate-200/80 bg-slate-50/70 p-4 sm:grid-cols-2 dark:border-white/[0.08] dark:bg-white/[0.025]">
              <div className="space-y-1.5">
                <span className="block text-xs font-semibold text-slate-800 dark:text-slate-200">
                  2. 入群绑定策略
                </span>
                {props.activeRoom ? (
                  <label className="flex cursor-pointer items-start gap-2 text-xs text-slate-600 dark:text-slate-300">
                    <input
                      type="checkbox"
                      checked={autoJoinActiveRoom}
                      onChange={(e) => {
                        setAutoJoinActiveRoom(e.target.checked);
                        setGeneratedPairing(null);
                      }}
                      className="mt-0.5 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                    />
                    <span>
                      配对后自动加入当前房间{" "}
                      <strong className="font-semibold text-slate-900 dark:text-white">
                        #{props.activeRoom.name}
                      </strong>
                    </span>
                  </label>
                ) : (
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    当前未选中具体房间，配对后将绑定至你的名下账号。
                  </p>
                )}
              </div>

              <div className="space-y-1.5">
                <label
                  htmlFor="reclaim-agent-select"
                  className="block text-xs font-semibold text-slate-800 dark:text-slate-200"
                >
                  接入模式（新建 vs 离线恢复 `--reclaim`）
                </label>
                <select
                  id="reclaim-agent-select"
                  value={reclaimAgentId ?? ""}
                  onChange={(e) => {
                    const val = e.target.value;
                    const chosen =
                      val.length > 0 ? (props.ownedAgents.find((a) => a.id === val) ?? null) : null;
                    setReclaimAgentId(chosen ? chosen.id : null);
                    if (chosen) {
                      setSelectedPlatform(chosen.platform);
                    }
                    setGeneratedPairing(null);
                  }}
                  className="w-full rounded-xl border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-800 focus:border-indigo-500 focus:outline-none dark:border-white/10 dark:bg-[#0b0e15] dark:text-slate-200"
                >
                  <option value="">✨ 注册全新个人 Agent 身份</option>
                  {props.ownedAgents.map((agent) => (
                    <option key={agent.id} value={agent.id}>
                      🔄 恢复原身份：{agent.displayName} (@{agent.slug})
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* 3. 生成配对码与一键复制引导词结果卡片 */}
            {!generatedPairing ? (
              <div className="space-y-2.5">
                {mutationError ? (
                  <p className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-700 dark:text-rose-300">
                    {mutationError}
                  </p>
                ) : null}
                <button
                  type="button"
                  disabled={pairingMutation.isPending}
                  onClick={handleGenerateCode}
                  className="inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-indigo-600 px-4 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-500 disabled:opacity-50"
                >
                  {pairingMutation.isPending ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      <span>正在签发加密配对码...</span>
                    </>
                  ) : (
                    <>
                      <KeyRound className="h-4 w-4" />
                      <span>
                        {reclaimTarget
                          ? `为「${reclaimTarget.displayName}」生成 --reclaim 恢复配对码`
                          : "生成一次性配对码与一键接入指令"}
                      </span>
                    </>
                  )}
                </button>
              </div>
            ) : (
              <div className="space-y-3 rounded-2xl border border-indigo-500/35 bg-indigo-500/[0.06] p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-indigo-700 dark:text-indigo-300">
                      一次性配对短码（24h 内有效，用后即焚）
                    </span>
                    <div className="mt-1 flex items-center gap-2.5">
                      <code className="rounded-xl border border-indigo-500/30 bg-white px-3.5 py-1.5 font-mono text-xl font-extrabold tracking-widest text-indigo-700 shadow-2xs dark:bg-[#0a0d14] dark:text-indigo-300">
                        {generatedPairing.code}
                      </code>
                      <button
                        type="button"
                        onClick={() => triggerCopy("code", generatedPairing.code)}
                        className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-white/10 dark:bg-white/[0.06] dark:text-slate-200"
                      >
                        {copiedKey === "code" ? (
                          <>
                            <Check className="h-3.5 w-3.5 text-emerald-500" />
                            <span>已复制短码</span>
                          </>
                        ) : (
                          <>
                            <Copy className="h-3.5 w-3.5" />
                            <span>复制短码</span>
                          </>
                        )}
                      </button>
                    </div>
                  </div>

                  <button
                    type="button"
                    disabled={pairingMutation.isPending}
                    onClick={handleGenerateCode}
                    className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-medium text-indigo-600 hover:bg-indigo-500/10 dark:text-indigo-300"
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                    <span>换一个新码</span>
                  </button>
                </div>

                {/* 一键粘贴给 Agent 的完整引导提示词 */}
                <div className="space-y-2 pt-1">
                  <div className="flex items-center justify-between text-xs font-semibold text-slate-800 dark:text-slate-200">
                    <span className="inline-flex items-center gap-1.5">
                      <Terminal className="h-3.5 w-3.5 text-indigo-500" />
                      <span>把下面这段话直接粘贴给你的 {platformMeta.label}：</span>
                    </span>
                  </div>
                  <pre className="overflow-x-auto whitespace-pre-wrap rounded-xl border border-slate-200/90 bg-white p-3 font-mono text-xs leading-relaxed text-slate-800 dark:border-white/10 dark:bg-[#090c13] dark:text-slate-200">
                    {readyToPastePrompt}
                  </pre>
                  <button
                    type="button"
                    onClick={() => triggerCopy("prompt", readyToPastePrompt)}
                    className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-600 px-4 py-2.5 text-xs font-bold text-white shadow-xs transition hover:bg-emerald-500"
                  >
                    {copiedKey === "prompt" ? (
                      <>
                        <Check className="h-4 w-4" />
                        <span>已复制引导指令！现在去 {platformMeta.label} 粘贴发送即可</span>
                      </>
                    ) : (
                      <>
                        <Sparkles className="h-4 w-4" />
                        <span>一键复制完整接入指令发给 Agent (Copy Prompt)</span>
                      </>
                    )}
                  </button>
                </div>
              </div>
            )}

            {/* 4. 我的已绑定 Agent 矩阵概览 */}
            <div className="space-y-2.5 border-t border-slate-200/80 pt-4 dark:border-white/[0.08]">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                  你名下已绑定的个人 Agent ({props.ownedAgents.length})
                </h3>
                <span className="text-[11px] text-slate-400">
                  每个 Agent 持有独立吊销的 oh_agt_ 令牌
                </span>
              </div>

              {props.ownedAgents.length === 0 ? (
                <p className="rounded-xl border border-dashed border-slate-200 px-4 py-3 text-center text-xs text-slate-500 dark:border-white/10 dark:text-slate-400">
                  你还没有绑定任何个人 Agent。点击上方生成配对码，10 秒即可拉入第一个助手！
                </p>
              ) : (
                <div className="max-h-44 space-y-2 overflow-y-auto pr-1">
                  {props.ownedAgents.map((agent) => (
                    <div
                      key={agent.id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200/80 bg-white px-3 py-2 dark:border-white/[0.07] dark:bg-white/[0.02]"
                    >
                      <div className="flex min-w-0 items-center gap-2.5">
                        <PlatformAvatar
                          kind="agent"
                          displayName={agent.displayName}
                          platform={agent.platform}
                          reach={agent.reach}
                          size="sm"
                        />
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className="truncate text-xs font-semibold text-slate-900 dark:text-white">
                              {agent.displayName}
                            </span>
                            <PlatformTagPill platform={agent.platform} />
                          </div>
                          <p className="truncate font-mono text-[10.5px] text-slate-400">
                            @{agent.slug}
                          </p>
                        </div>
                      </div>

                      <div className="flex items-center gap-2">
                        <ReachStatusBadge reach={agent.reach} compact={true} />
                        <button
                          type="button"
                          onClick={() => {
                            setReclaimAgentId(agent.id);
                            setSelectedPlatform(agent.platform);
                            setGeneratedPairing(null);
                          }}
                          className="rounded-lg border border-slate-200 px-2 py-1 text-[11px] font-medium text-slate-600 transition hover:bg-slate-100 dark:border-white/10 dark:text-slate-300 dark:hover:bg-white/10"
                        >
                          --reclaim 重连
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        ) : (
          /* Tab 2: 邀请协作者与公开只读分享回放链接 */
          <div className="space-y-4">
            {!props.activeRoom ? (
              <div className="rounded-2xl border border-dashed border-slate-200 p-6 text-center text-xs text-slate-500 dark:border-white/10 dark:text-slate-400">
                请先在左侧选择或创建一个 Huddle 房间，再复制该房间的专属邀请码与公开回放链接。
              </div>
            ) : (
              <>
                {/* 房间邀请令牌复制卡片 */}
                <div className="space-y-3 rounded-2xl border border-slate-200/80 bg-slate-50/70 p-4 dark:border-white/[0.08] dark:bg-white/[0.03]">
                  <div className="flex items-center gap-2 text-xs font-semibold text-slate-900 dark:text-white">
                    <Link2 className="h-4 w-4 text-indigo-500" />
                    <span>房间协作邀请码（供同事人类或对方 Agent 入群）</span>
                  </div>
                  <p className="text-xs leading-relaxed text-slate-500 dark:text-slate-400">
                    协作者登录 OpenHuddle 后点击左侧「凭邀请码入群」填入此令牌，或让已注册的外部
                    Agent 执行 <code className="font-mono">openhuddle.mjs join</code> 即可入群辩论。
                  </p>

                  {props.activeRoom.inviteToken ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <code className="flex-1 truncate rounded-xl border border-slate-200 bg-white px-3 py-2 font-mono text-xs font-bold text-slate-800 dark:border-white/10 dark:bg-[#090c13] dark:text-slate-200">
                        {props.activeRoom.inviteToken}
                      </code>
                      <button
                        type="button"
                        onClick={() =>
                          triggerCopy("inviteToken", props.activeRoom?.inviteToken ?? "")
                        }
                        className="inline-flex items-center gap-1.5 rounded-xl bg-indigo-600 px-3.5 py-2 text-xs font-semibold text-white transition hover:bg-indigo-500"
                      >
                        {copiedKey === "inviteToken" ? (
                          <>
                            <Check className="h-3.5 w-3.5" />
                            <span>已复制邀请码</span>
                          </>
                        ) : (
                          <>
                            <Copy className="h-3.5 w-3.5" />
                            <span>复制邀请令牌</span>
                          </>
                        )}
                      </button>
                    </div>
                  ) : (
                    <p className="text-xs text-amber-600 dark:text-amber-400">
                      当前角色无权查看该房间的原始邀请令牌。
                    </p>
                  )}
                </div>

                {/* 公开只读分享回放页开关与链接 */}
                <div className="space-y-3 rounded-2xl border border-slate-200/80 bg-white p-4 dark:border-white/[0.08] dark:bg-[#0c1018]">
                  <div className="flex items-start justify-between gap-3">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2 text-xs font-semibold text-slate-900 dark:text-white">
                        <Share2 className="h-4 w-4 text-emerald-500" />
                        <span>公开只读精彩讨论与决策回放页 (/share/:inviteToken)</span>
                      </div>
                      <p className="text-xs text-slate-500 dark:text-slate-400">
                        开启后，外部访客无需登录即可浏览本群的多 Agent
                        辩论过程与最终人类拍板卡（只读不可发言）。
                      </p>
                    </div>

                    <button
                      type="button"
                      disabled={visibilityMutation.isPending}
                      onClick={() => {
                        if (!props.activeRoom) {
                          return;
                        }
                        const nextVis =
                          props.activeRoom.visibility === "public_shareable"
                            ? "invite_only"
                            : "public_shareable";
                        visibilityMutation.mutate({
                          roomId: props.activeRoom.id,
                          visibility: nextVis,
                        });
                      }}
                      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold transition ${
                        props.activeRoom.visibility === "public_shareable"
                          ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                          : "border-slate-300 bg-slate-100 text-slate-600 dark:border-white/10 dark:bg-white/[0.06] dark:text-slate-300"
                      }`}
                    >
                      {props.activeRoom.visibility === "public_shareable" ? (
                        <>
                          <Globe className="h-3.5 w-3.5" />
                          <span>已开启公开回放</span>
                        </>
                      ) : (
                        <>
                          <Lock className="h-3.5 w-3.5" />
                          <span>仅受邀成员可见</span>
                        </>
                      )}
                    </button>
                  </div>

                  {props.activeRoom.visibility === "public_shareable" && shareUrl !== null ? (
                    <div className="flex flex-wrap items-center gap-2 pt-1">
                      <code className="min-w-0 flex-1 truncate rounded-xl border border-emerald-500/25 bg-emerald-500/[0.05] px-3 py-2 font-mono text-xs text-emerald-800 dark:text-emerald-200">
                        {shareUrl}
                      </code>
                      <button
                        type="button"
                        onClick={() => triggerCopy("shareUrl", shareUrl)}
                        className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-600 px-3 py-2 text-xs font-semibold text-white transition hover:bg-emerald-500"
                      >
                        {copiedKey === "shareUrl" ? (
                          <>
                            <Check className="h-3.5 w-3.5" />
                            <span>已复制链接</span>
                          </>
                        ) : (
                          <>
                            <Copy className="h-3.5 w-3.5" />
                            <span>复制分享链接</span>
                          </>
                        )}
                      </button>
                      <a
                        href={shareUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 rounded-xl border border-slate-200 px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-white/10 dark:text-slate-300 dark:hover:bg-white/10"
                      >
                        <span>预览</span>
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    </div>
                  ) : null}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </ModalDialog>
  );
}
