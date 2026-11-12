/**
 * @module web/features/auth-pairing/agent-onboarding-modal
 * @description Pachat 自然对话风格「接入我的 Agent」与「邀请进群」双标签模态窗。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 一句话接入优先：生成 `HUDDLE-XXXX-XXXX` 一次性口令后，在干净的 `#F5F5F7`（暗色 `#1C1C1F`）纸感卡片中突出展示可直接复制发给 Agent 的话，配以 `#141414` `rounded-full`「复制发给 Agent 的话」胶囊主按钮；CLI 终端与 MCP 作为进阶分段提供。
 * 2. 指令以服务端为准：发给 Agent 的正文基于服务端权威返回的 `onboardingPrompt` 拼接推荐名字与平台标识，前端绝不自行伪造配对码或令牌。
 * 3. 原身份无损重连（`--reclaim`）：支持为已绑定的断连 Agent 生成恢复口令，复用原有 `AgentId`、群成员身份与消息游标，杜绝重复分身。
 * 4. 零 AI 模板感控件：全量采用 `SegmentedTabs`、`AppSelect`、`AppSwitch`、`AppInput`、`AppButton` 与圆形暖粉彩平台徽章，零蓝紫渐变、零闪烁星标图标。
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
  ArrowRight,
  Bot,
  Check,
  Copy,
  ExternalLink,
  Globe,
  KeyRound,
  Link2,
  Lock,
  MessageSquareText,
  Plug,
  RefreshCw,
  Share2,
  Terminal,
  UserPlus,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  AnimatePresence,
  AppButton,
  AppInput,
  AppSelect,
  type AppSelectOption,
  AppSwitch,
  AppTooltip,
  IconButton,
  type SegmentedTabItem,
  SegmentedTabs,
  appButtonVariants,
  cn,
  motion,
  toast,
} from "../../../components/primitives/index.js";
import { ReachStatusBadge } from "../../../components/ui/identity-badges.js";
import { ModalDialog } from "../../../components/ui/modal-dialog.js";
import { PlatformGlyph } from "../../../components/ui/platform-icons.js";
import { ApiClientError } from "../../../lib/api-client.js";
import { getPlatformVisualMeta } from "../../../lib/format.js";
import {
  useCreatePairingCodeMutation,
  useRoomShareVisibilityMutation,
} from "../api/auth-pairing.queries.js";

const PLATFORM_PRESETS: ReadonlyArray<AgentPlatform> = [
  "claude_code",
  "codex",
  "cursor",
  "antigravity",
  "openclaw",
  "gemini",
  "deepseek",
  "custom",
];

/** Radix `Select` 要求非空字符串值：用哨兵值代表“接入一个全新的 Agent”而非 `--reclaim` */
const NEW_AGENT_SENTINEL = "__new_agent__";

/** 打开接入与邀请弹窗时的初始视图意图 */
export type OnboardingModalTab = "pair_agent" | "invite_share";

/** 生成配对口令后的接入方式标签 */
type ConnectMethodTab = "prompt" | "cli" | "mcp";

/** 顶栏自然口语分段标签配置 */
const TOP_TAB_ITEMS: ReadonlyArray<SegmentedTabItem<OnboardingModalTab>> = [
  {
    value: "pair_agent",
    label: "接入我的 Agent",
    icon: <Bot className="h-3.5 w-3.5" />,
  },
  {
    value: "invite_share",
    label: "邀请进群",
    icon: <UserPlus className="h-3.5 w-3.5" />,
  },
];

/** 接入方式分段标签配置 */
const CONNECT_METHOD_ITEMS: ReadonlyArray<SegmentedTabItem<ConnectMethodTab>> = [
  {
    value: "prompt",
    label: "发一句话接入",
    icon: <MessageSquareText className="h-3.5 w-3.5" />,
  },
  {
    value: "cli",
    label: "终端命令行",
    icon: <Terminal className="h-3.5 w-3.5" />,
  },
  {
    value: "mcp",
    label: "MCP 配置",
    icon: <Plug className="h-3.5 w-3.5" />,
  },
];

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

/** 只读代码块样式：Pachat 暖灰/深黑高对比纸面 */
const CODE_BLOCK_CLASS =
  "select-text overflow-x-auto whitespace-pre rounded-[16px] border border-black/[0.07] bg-[#F5F5F7] p-3.5 font-mono text-[11.5px] leading-relaxed text-[#141414] dark:border-white/[0.08] dark:bg-[#141417] dark:text-zinc-200";

/**
 * 将平台枚举转换为本地凭证文件 slug（`claude_code` → `claude-code`）。
 *
 * @param platform - Agent 宿主平台
 * @returns 适合作为文件名的 slug
 */
function toTokenSlug(platform: AgentPlatform): string {
  return platform.replace(/_/g, "-");
}

/**
 * 转义命令行双引号参数中的特殊字符，避免昵称中的引号或 `$` 破坏 shell 语句。
 *
 * @param value - 原始参数值
 * @returns 可安全放入双引号内的字符串
 */
function escapeShellDoubleQuoted(value: string): string {
  return value.replace(/(["\\$`])/g, "\\$1");
}

/** `CopyButton` 入参属性 */
interface CopyButtonProps {
  readonly copied: boolean;
  readonly onCopy: () => void;
  readonly label: string;
  readonly copiedLabel: string;
  readonly variant: "primary" | "secondary";
}

/**
 * 统一的胶囊复制操作按钮（基于 `AppButton` 原语，复制成功后 2 秒内展示对勾状态）。
 *
 * @param props - 复制状态、回调、文案与视觉变体
 * @returns 胶囊复制按钮
 */
function CopyButton(props: CopyButtonProps) {
  return (
    <AppButton
      variant={props.variant}
      size="sm"
      onClick={props.onCopy}
      leadingIcon={
        props.copied ? (
          <Check aria-hidden="true" className="h-3.5 w-3.5 text-[#34C759]" />
        ) : (
          <Copy aria-hidden="true" className="h-3.5 w-3.5" />
        )
      }
    >
      {props.copied ? props.copiedLabel : props.label}
    </AppButton>
  );
}

/**
 * 渲染双标签「接入我的 Agent」与「邀请进群」模态框。
 *
 * @param props - 当前用户、已绑定 Agent 列表、当前激活房间与弹窗控制参数
 * @returns 双标签引导模态框
 */
export function AgentOnboardingModal(props: AgentOnboardingModalProps) {
  const [activeTab, setActiveTab] = useState<OnboardingModalTab>(props.initialTab ?? "pair_agent");
  const [methodTab, setMethodTab] = useState<ConnectMethodTab>("prompt");
  const [selectedPlatform, setSelectedPlatform] = useState<AgentPlatform>("claude_code");
  const [reclaimAgentId, setReclaimAgentId] = useState<AgentId | null>(
    props.initialReclaimAgentId ?? null,
  );
  const [customAgentName, setCustomAgentName] = useState<string>("");
  const [autoJoinActiveRoom, setAutoJoinActiveRoom] = useState<boolean>(true);
  const [generatedPairing, setGeneratedPairing] = useState<CreatePairingCodeResponse | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const pairingMutation = useCreatePairingCodeMutation();
  const visibilityMutation = useRoomShareVisibilityMutation();

  // 当外部打开弹窗并传入特定初始标签或待恢复 Agent ID 时，对齐局部交互视图状态
  useEffect(() => {
    if (props.open) {
      setActiveTab(props.initialTab ?? "pair_agent");
      const nextReclaimId = props.initialReclaimAgentId ?? null;
      setReclaimAgentId(nextReclaimId);
      if (nextReclaimId !== null) {
        const matched = props.ownedAgents.find((item) => item.id === nextReclaimId);
        if (matched !== undefined) {
          setSelectedPlatform(matched.platform);
        }
      }
      setCustomAgentName("");
      setGeneratedPairing(null);
      setMethodTab("prompt");
    }
  }, [props.open, props.initialTab, props.initialReclaimAgentId, props.ownedAgents]);

  const platformMeta = getPlatformVisualMeta(selectedPlatform);
  const reclaimTarget =
    reclaimAgentId !== null
      ? (props.ownedAgents.find((item) => item.id === reclaimAgentId) ?? null)
      : null;

  const reclaimSelectOptions = useMemo<ReadonlyArray<AppSelectOption<string>>>(() => {
    const base: AppSelectOption<string> = {
      value: NEW_AGENT_SENTINEL,
      label: "接入一个新的 Agent",
      description: "签发独立可吊销的 oh_agt_ 身份令牌",
    };
    const agentOptions = props.ownedAgents.map(
      (agent): AppSelectOption<string> => ({
        value: agent.id,
        label: `恢复原身份：${agent.displayName} (@${agent.slug})`,
        description: "保留原 AgentId、群成员记录与消息已读游标",
      }),
    );
    return [base, ...agentOptions];
  }, [props.ownedAgents]);

  const triggerCopy = (
    key: string,
    text: string,
    toastTitle: string,
    toastDescription?: string,
  ): void => {
    if (typeof navigator === "undefined" || !navigator.clipboard) {
      toast.error("当前环境不支持直接写入剪贴板，请手动选中文本复制");
      return;
    }
    void navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopiedKey(key);
        toast.success(
          toastTitle,
          toastDescription !== undefined ? { description: toastDescription } : undefined,
        );
        window.setTimeout(() => {
          setCopiedKey((prev) => (prev === key ? null : prev));
        }, 2_000);
      })
      .catch(() => {
        toast.error("复制失败，请手动选中复制");
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
          toast.success("接入话术已准备好", {
            description: `一次性口令 ${res.code} · 24 小时内有效`,
          });
        },
        onError: (err) => {
          const msg =
            err instanceof ApiClientError
              ? err.message
              : err instanceof Error
                ? err.message
                : "生成接入口令失败";
          toast.error(msg);
        },
      },
    );
  };

  const defaultAgentName = `${props.currentUser.displayName}-${platformMeta.label.replace(/\s+/g, "")}`;
  // 基于服务端权威返回的 onboardingPrompt 拼接宿主平台与建议昵称，方便直接发给 Agent
  const suggestedAgentName = reclaimTarget
    ? reclaimTarget.displayName
    : customAgentName.trim().length > 0
      ? customAgentName.trim()
      : defaultAgentName;

  const readyToPastePrompt = generatedPairing
    ? `${generatedPairing.onboardingPrompt}\n（推荐注册名称："${suggestedAgentName}"，平台标识："${selectedPlatform}"${
        reclaimTarget ? "，请附带 --reclaim 恢复原身份" : ""
      }）`
    : "";

  const serverOrigin = typeof window !== "undefined" ? window.location.origin : "";
  const tokenFile = `~/.openhuddle/tokens/${toTokenSlug(selectedPlatform)}.token`;

  // CLI 命令与 /install.md 保持一致：下载单文件 CLI → pair → 可选 listen 守护
  const cliCommands = generatedPairing
    ? [
        "mkdir -p ~/.openhuddle/tokens",
        `curl -fsSL ${serverOrigin}/openhuddle.mjs -o ~/.openhuddle/openhuddle.mjs`,
        `node ~/.openhuddle/openhuddle.mjs pair ${generatedPairing.code} \\`,
        `  --name "${escapeShellDoubleQuoted(suggestedAgentName)}" \\`,
        `  --platform ${selectedPlatform}${reclaimTarget ? " --reclaim" : ""} \\`,
        `  --server ${serverOrigin} \\`,
        `  --token-file ${tokenFile}`,
        "",
        "# 可选：安装后台守护，群里 @ 时即时唤醒",
        `node ~/.openhuddle/openhuddle.mjs listen install --server ${serverOrigin} --token-file ${tokenFile}`,
      ].join("\n")
    : "";

  // MCP 配置需先完成 pair 获取本地令牌文件，再由 CLI 的 stdio MCP 子命令桥接
  const mcpConfig = JSON.stringify(
    {
      mcpServers: {
        openhuddle: {
          command: "node",
          args: [
            "~/.openhuddle/openhuddle.mjs",
            "mcp",
            "--server",
            serverOrigin,
            "--token-file",
            tokenFile,
          ],
        },
      },
    },
    null,
    2,
  );

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
      title={activeTab === "pair_agent" ? "接入我的 Agent" : "邀请进群"}
      subtitle={
        activeTab === "pair_agent"
          ? "复制一段话发给你的 Agent，它会自己完成绑定并进群"
          : "发邀请码把同伴拉进群，或生成公开只读回放链接"
      }
      maxWidthClass="max-w-2xl"
      icon={
        activeTab === "pair_agent" ? <Bot className="h-4 w-4" /> : <UserPlus className="h-4 w-4" />
      }
    >
      <div className="space-y-5">
        {/* 顶部分段切换：接入我的 Agent | 邀请进群 */}
        <SegmentedTabs
          value={activeTab}
          onValueChange={setActiveTab}
          items={TOP_TAB_ITEMS}
          size="md"
          fullWidth={true}
          ariaLabel="接入我的 Agent 或邀请进群切换"
        />

        {activeTab === "pair_agent" ? (
          <div className="space-y-4">
            {/* 1. 选择 Agent 运行环境（圆形暖粉彩图标 + 纯墨黑选中描边） */}
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3 text-xs">
                <span className="font-medium text-[#141414] dark:text-zinc-200">
                  你的 Agent 运行在哪里？
                </span>
                <span className="truncate text-[11.5px] text-[#6E6E73] dark:text-zinc-400">
                  {platformMeta.cliHint}
                </span>
              </div>
              <div className="grid select-none grid-cols-2 gap-1.5 sm:grid-cols-4">
                {PLATFORM_PRESETS.map((platform) => {
                  const meta = getPlatformVisualMeta(platform);
                  const isSelected = selectedPlatform === platform;
                  return (
                    <button
                      key={platform}
                      type="button"
                      aria-pressed={isSelected}
                      disabled={reclaimTarget !== null}
                      onClick={() => {
                        setSelectedPlatform(platform);
                        setGeneratedPairing(null);
                      }}
                      className={cn(
                        "app-no-drag flex cursor-pointer items-center gap-2 rounded-full px-2.5 py-1.5 text-left text-xs font-medium transition-all duration-150 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50",
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
                        <PlatformGlyph platform={platform} className="h-3 w-3" />
                      </span>
                      <span className="truncate">{meta.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* 2. 接入模式（新接入 vs 恢复原身份）与群内名字 */}
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label
                  htmlFor="reclaim-agent-select"
                  className="mb-1.5 block text-xs font-medium text-[#3A3A3C] dark:text-zinc-300"
                >
                  接入方式
                </label>
                <AppSelect
                  id="reclaim-agent-select"
                  value={reclaimAgentId ?? NEW_AGENT_SENTINEL}
                  options={reclaimSelectOptions}
                  size="md"
                  ariaLabel="选择接入新 Agent 或恢复已有身份"
                  onValueChange={(val) => {
                    if (val === NEW_AGENT_SENTINEL) {
                      setReclaimAgentId(null);
                    } else {
                      const chosen = props.ownedAgents.find((a) => a.id === val) ?? null;
                      setReclaimAgentId(chosen ? chosen.id : null);
                      if (chosen) {
                        setSelectedPlatform(chosen.platform);
                      }
                    }
                    setGeneratedPairing(null);
                  }}
                />
              </div>

              <div>
                <label
                  htmlFor="agent-nickname-input"
                  className="mb-1.5 block text-xs font-medium text-[#3A3A3C] dark:text-zinc-300"
                >
                  它在群里的名字
                </label>
                <AppInput
                  id="agent-nickname-input"
                  type="text"
                  size="md"
                  maxLength={60}
                  disabled={reclaimTarget !== null}
                  value={reclaimTarget ? reclaimTarget.displayName : customAgentName}
                  onChange={(e) => setCustomAgentName(e.target.value)}
                  leadingIcon={<Bot className="h-3.5 w-3.5" />}
                  placeholder={defaultAgentName}
                />
              </div>
            </div>

            {/* 自动进群拨杆开关 */}
            <div className="flex items-center justify-between gap-3 rounded-[18px] bg-[#F5F5F7] px-4 py-3 ring-1 ring-inset ring-black/[0.05] dark:bg-[#1C1C1F] dark:ring-white/[0.07]">
              {props.activeRoom ? (
                <>
                  <label
                    htmlFor="auto-join-active-room-switch"
                    className="min-w-0 flex-1 cursor-pointer select-none text-xs text-[#3A3A3C] dark:text-zinc-300"
                  >
                    连上后直接拉进当前群聊{" "}
                    <strong className="font-semibold text-[#141414] dark:text-zinc-100">
                      {props.activeRoom.name}
                    </strong>
                  </label>
                  <AppSwitch
                    id="auto-join-active-room-switch"
                    size="sm"
                    checked={autoJoinActiveRoom}
                    onCheckedChange={(checked) => {
                      setAutoJoinActiveRoom(checked);
                      setGeneratedPairing(null);
                    }}
                    ariaLabel={`配对后自动加入群聊 ${props.activeRoom.name}`}
                  />
                </>
              ) : (
                <p className="text-xs text-[#6E6E73] dark:text-zinc-400">
                  当前未打开具体群聊，接入后会先添加到你的名下，随时可拉进任意群。
                </p>
              )}
            </div>

            {/* 3. 一步式生成与「复制发给 Agent 的话」纸感卡片 */}
            <AnimatePresence mode="wait" initial={false}>
              {!generatedPairing ? (
                <motion.div
                  key="generate-cta"
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  transition={{ duration: 0.14 }}
                  className="rounded-[22px] bg-[#F5F5F7] p-4 ring-1 ring-inset ring-black/[0.05] dark:bg-[#1C1C1F] dark:ring-white/[0.08]"
                >
                  {mutationError ? (
                    <p
                      role="alert"
                      className="mb-3 rounded-2xl border border-[#FF3B30]/25 bg-[#FF3B30]/[0.07] px-3 py-2 text-xs text-[#D70015] dark:bg-[#FF453A]/12 dark:text-[#FF6961]"
                    >
                      {mutationError}
                    </p>
                  ) : null}
                  <p className="mb-3 text-xs leading-relaxed text-[#5F5F64] dark:text-zinc-400">
                    点击下方按钮生成一段一次性接入话术，把它发给{" "}
                    <strong className="font-medium text-[#141414] dark:text-zinc-200">
                      {platformMeta.label}
                    </strong>{" "}
                    就能自动连进来。
                  </p>
                  <AppButton
                    variant="primary"
                    size="lg"
                    fullWidth={true}
                    isLoading={pairingMutation.isPending}
                    trailingIcon={
                      !pairingMutation.isPending ? (
                        <ArrowRight aria-hidden="true" className="h-4 w-4" />
                      ) : undefined
                    }
                    onClick={handleGenerateCode}
                    className="h-10 rounded-full"
                  >
                    {pairingMutation.isPending
                      ? "正在准备发给 Agent 的话..."
                      : reclaimTarget
                        ? `生成「${reclaimTarget.displayName}」的重连话术`
                        : `准备发给 ${platformMeta.label} 的话`}
                  </AppButton>
                  <p className="mt-2.5 text-center text-[11px] text-[#8E8E93] dark:text-zinc-500">
                    口令 24 小时内有效、用过即焚；每个 Agent 拥有独立可随时撤回的令牌。
                  </p>
                </motion.div>
              ) : (
                <motion.div
                  key="generated-panel"
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  transition={{ type: "spring", stiffness: 460, damping: 34 }}
                  className="space-y-3"
                >
                  {/* 接入方式切换 + 一次性口令胶囊 */}
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <SegmentedTabs
                      value={methodTab}
                      onValueChange={setMethodTab}
                      items={CONNECT_METHOD_ITEMS}
                      size="sm"
                      ariaLabel="Agent 接入方式切换"
                    />
                    <div className="flex items-center gap-1">
                      <AppTooltip content="点击复制一次性接入口令" side="top">
                        <button
                          type="button"
                          onClick={() =>
                            triggerCopy(
                              "pairingCode",
                              generatedPairing.code,
                              "接入口令已复制",
                              generatedPairing.code,
                            )
                          }
                          className="app-no-drag inline-flex cursor-pointer items-center gap-1.5 rounded-full bg-[#F5F5F7] px-3 py-1 font-mono text-[11.5px] font-semibold tracking-wider text-[#141414] ring-1 ring-inset ring-black/[0.08] transition hover:bg-[#EFEFF3] active:scale-95 dark:bg-[#27272A] dark:text-zinc-100 dark:ring-white/[0.1] dark:hover:bg-[#323236]"
                        >
                          <span>{generatedPairing.code}</span>
                          {copiedKey === "pairingCode" ? (
                            <Check aria-hidden="true" className="h-3 w-3 text-[#34C759]" />
                          ) : (
                            <Copy aria-hidden="true" className="h-3 w-3 opacity-65" />
                          )}
                        </button>
                      </AppTooltip>
                      <AppTooltip content="换一个新口令" side="top">
                        <IconButton
                          size="sm"
                          variant="ghost"
                          label="重新生成口令"
                          isLoading={pairingMutation.isPending}
                          onClick={handleGenerateCode}
                        >
                          <RefreshCw aria-hidden="true" className="h-3.5 w-3.5" />
                        </IconButton>
                      </AppTooltip>
                    </div>
                  </div>

                  {methodTab === "prompt" ? (
                    <div className="rounded-[22px] bg-[#F5F5F7] p-4 ring-1 ring-inset ring-black/[0.06] dark:bg-[#1C1C1F] dark:ring-white/[0.08]">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-semibold text-[#141414] dark:text-zinc-100">
                          把下面这段话直接发给你的 Agent
                        </span>
                        <span className="text-[11px] text-[#6E6E73] dark:text-zinc-400">
                          在 {platformMeta.label} 里粘贴发送即可
                        </span>
                      </div>
                      <div className="my-3 rounded-[16px] bg-white px-3.5 py-3 ring-1 ring-inset ring-black/[0.06] dark:bg-[#141417] dark:ring-white/[0.08]">
                        <p className="select-text whitespace-pre-wrap text-[13px] leading-relaxed text-[#141414] dark:text-zinc-100">
                          {readyToPastePrompt}
                        </p>
                      </div>
                      <AppButton
                        variant="primary"
                        size="lg"
                        fullWidth={true}
                        className="h-10 rounded-full"
                        leadingIcon={
                          copiedKey === "prompt" ? (
                            <Check aria-hidden="true" className="h-4 w-4 text-[#34C759]" />
                          ) : (
                            <Copy aria-hidden="true" className="h-4 w-4" />
                          )
                        }
                        onClick={() =>
                          triggerCopy(
                            "prompt",
                            readyToPastePrompt,
                            "发给 Agent 的话已复制",
                            `去 ${platformMeta.label} 粘贴发送即可自动进群`,
                          )
                        }
                      >
                        {copiedKey === "prompt"
                          ? `已复制，去发给 ${platformMeta.label} 吧`
                          : "复制发给 Agent 的话"}
                      </AppButton>
                    </div>
                  ) : null}

                  {methodTab === "cli" ? (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-xs text-[#6E6E73] dark:text-zinc-400">
                          在 Agent 所在机器的终端执行（零依赖单文件脚本，令牌独立存放）：
                        </p>
                        <CopyButton
                          copied={copiedKey === "cli"}
                          onCopy={() =>
                            triggerCopy(
                              "cli",
                              cliCommands,
                              "终端命令已复制",
                              "在终端粘贴运行即可完成绑定与后台监听",
                            )
                          }
                          label="复制命令"
                          copiedLabel="已复制"
                          variant="secondary"
                        />
                      </div>
                      <pre className={CODE_BLOCK_CLASS}>{cliCommands}</pre>
                    </div>
                  ) : null}

                  {methodTab === "mcp" ? (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-xs text-[#6E6E73] dark:text-zinc-400">
                          先发一句话或运行终端命令完成绑定，再把下面配置加进宿主的 MCP 设置：
                        </p>
                        <CopyButton
                          copied={copiedKey === "mcp"}
                          onCopy={() =>
                            triggerCopy(
                              "mcp",
                              mcpConfig,
                              "MCP 配置已复制",
                              "粘贴到宿主的 mcpServers 配置文件即可",
                            )
                          }
                          label="复制配置"
                          copiedLabel="已复制"
                          variant="secondary"
                        />
                      </div>
                      <pre className={CODE_BLOCK_CLASS}>{mcpConfig}</pre>
                      <p className="rounded-[14px] bg-[#FFF1C2]/70 px-3.5 py-2.5 text-[11.5px] leading-relaxed text-[#5C4813] ring-1 ring-inset ring-black/[0.05] dark:bg-[#2C2718] dark:text-[#F2DF9D] dark:ring-white/[0.08]">
                        说明：stdio MCP 子命令（openhuddle.mjs mcp）正随新版 CLI
                        逐步开放；若当前环境暂不可用，直接用「发一句话接入」即可。
                      </p>
                    </div>
                  ) : null}
                </motion.div>
              )}
            </AnimatePresence>

            {/* 4. 我已接入的 Agent */}
            <div className="space-y-2 border-t border-black/[0.07] pt-4 dark:border-white/[0.08]">
              <h3 className="select-none text-xs font-medium text-[#8E8E93] dark:text-zinc-400">
                我已接入的 Agent · {props.ownedAgents.length}
              </h3>

              {props.ownedAgents.length === 0 ? (
                <p className="rounded-[16px] bg-[#F5F5F7] px-4 py-3 text-center text-xs text-[#6E6E73] dark:bg-[#1C1C1F] dark:text-zinc-400">
                  还没有接入任何 Agent，把上面生成的话发给它就能连上。
                </p>
              ) : (
                <div className="max-h-44 space-y-1 overflow-y-auto pr-1">
                  {props.ownedAgents.map((agent) => {
                    const meta = getPlatformVisualMeta(agent.platform);
                    return (
                      <div
                        key={agent.id}
                        className="flex items-center justify-between gap-2 rounded-[14px] px-2.5 py-1.5 transition hover:bg-[#F5F5F7] dark:hover:bg-[#1C1C1F]"
                      >
                        <div className="flex min-w-0 items-center gap-2.5">
                          <span
                            className={cn(
                              "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full font-mono text-[10px] font-bold",
                              meta.avatarClass,
                            )}
                          >
                            {meta.monogram}
                          </span>
                          <div className="min-w-0">
                            <p className="truncate text-xs font-semibold text-[#141414] dark:text-zinc-100">
                              {agent.displayName}
                            </p>
                            <p className="truncate text-[11px] text-[#8E8E93] dark:text-zinc-400">
                              {meta.label} · @{agent.slug}
                            </p>
                          </div>
                        </div>

                        <div className="flex shrink-0 items-center gap-2">
                          <ReachStatusBadge reach={agent.reach} compact={true} />
                          <AppButton
                            variant="secondary"
                            size="xs"
                            leadingIcon={<KeyRound aria-hidden="true" className="h-3 w-3" />}
                            onClick={() => {
                              setReclaimAgentId(agent.id);
                              setSelectedPlatform(agent.platform);
                              setGeneratedPairing(null);
                              toast.info(`已切换到「${agent.displayName}」重连模式`);
                            }}
                          >
                            重连
                          </AppButton>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        ) : (
          /* Tab 2: 邀请进群与公开只读回放链接 */
          <div className="space-y-4">
            {!props.activeRoom ? (
              <div className="rounded-[20px] bg-[#F5F5F7] p-6 text-center text-xs text-[#6E6E73] dark:bg-[#1C1C1F] dark:text-zinc-400">
                请先在左侧打开或新建一个群聊，再复制它的邀请码或回放链接。
              </div>
            ) : (
              <>
                {/* 群邀请码卡片 */}
                <div className="space-y-3 rounded-[20px] bg-[#F5F5F7] p-4 ring-1 ring-inset ring-black/[0.05] dark:bg-[#1C1C1F] dark:ring-white/[0.08]">
                  <div className="flex items-center gap-2 text-xs font-semibold text-[#141414] dark:text-zinc-100">
                    <Link2
                      aria-hidden="true"
                      className="h-4 w-4 text-[#141414] dark:text-zinc-200"
                    />
                    <span>群邀请码 · {props.activeRoom.name}</span>
                  </div>
                  <p className="text-xs leading-relaxed text-[#6E6E73] dark:text-zinc-400">
                    同伴登录后点击「加入群聊」粘贴即可进群；已接入的同伴 Agent 也可以执行{" "}
                    <code className="rounded-md bg-black/[0.06] px-1.5 py-0.5 font-mono text-[11px] text-[#141414] dark:bg-white/[0.1] dark:text-zinc-200">
                      openhuddle.mjs join
                    </code>{" "}
                    直接入群。
                  </p>

                  {props.activeRoom.inviteToken ? (
                    <div className="flex items-center gap-2">
                      <AppInput
                        readOnly={true}
                        size="md"
                        aria-label="群邀请码"
                        value={props.activeRoom.inviteToken}
                        leadingIcon={<KeyRound className="h-3.5 w-3.5" />}
                        className="select-all font-mono text-xs font-semibold"
                        containerClassName="flex-1"
                      />
                      <CopyButton
                        copied={copiedKey === "inviteToken"}
                        onCopy={() =>
                          triggerCopy(
                            "inviteToken",
                            props.activeRoom?.inviteToken ?? "",
                            "群邀请码已复制",
                            `发给同伴即可加入「${props.activeRoom?.name ?? ""}」`,
                          )
                        }
                        label="复制邀请码"
                        copiedLabel="已复制"
                        variant="primary"
                      />
                    </div>
                  ) : (
                    <p className="text-xs text-[#6E6E73] dark:text-zinc-400">
                      当前身份暂不可查看原始群邀请码。
                    </p>
                  )}
                </div>

                {/* 公开只读回放卡片 */}
                <div className="space-y-3 rounded-[20px] bg-white p-4 ring-1 ring-inset ring-black/[0.08] dark:bg-[#151518] dark:ring-white/[0.1]">
                  <div className="flex items-start justify-between gap-3">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2 text-xs font-semibold text-[#141414] dark:text-zinc-100">
                        <Share2 aria-hidden="true" className="h-4 w-4 text-[#34C759]" />
                        <span>公开只读回放链接</span>
                      </div>
                      <p className="text-xs leading-relaxed text-[#6E6E73] dark:text-zinc-400">
                        打开后，拿到链接的人无需登录就能阅读群内讨论过程与最终拍板结论（只读、已剥离凭证）。
                      </p>
                    </div>

                    <AppSwitch
                      size="md"
                      ariaLabel="切换公开只读回放"
                      disabled={visibilityMutation.isPending}
                      checked={props.activeRoom.visibility === "public_shareable"}
                      onCheckedChange={(checked) => {
                        if (!props.activeRoom) {
                          return;
                        }
                        const nextVis = checked ? "public_shareable" : "invite_only";
                        visibilityMutation.mutate(
                          {
                            roomId: props.activeRoom.id,
                            visibility: nextVis,
                          },
                          {
                            onSuccess: () => {
                              toast.success(
                                checked ? "已开启公开只读回放" : "已切回仅受邀成员可见",
                              );
                            },
                            onError: (err) => {
                              toast.error(err instanceof Error ? err.message : "切换可见范围失败");
                            },
                          },
                        );
                      }}
                    />
                  </div>

                  <p className="flex select-none items-center gap-1.5 text-[11.5px] font-medium text-[#6E6E73] dark:text-zinc-400">
                    {props.activeRoom.visibility === "public_shareable" ? (
                      <>
                        <Globe aria-hidden="true" className="h-3.5 w-3.5 text-[#34C759]" />
                        <span className="text-[#215236] dark:text-[#86E0A6]">
                          已开启 · 持链接者可免登录只读浏览
                        </span>
                      </>
                    ) : (
                      <>
                        <Lock aria-hidden="true" className="h-3.5 w-3.5" />
                        <span>当前仅群内成员可见</span>
                      </>
                    )}
                  </p>

                  {props.activeRoom.visibility === "public_shareable" && shareUrl !== null ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <AppInput
                        readOnly={true}
                        size="md"
                        aria-label="公开只读回放链接"
                        value={shareUrl}
                        leadingIcon={<Globe className="h-3.5 w-3.5 text-[#34C759]" />}
                        className="select-all font-mono text-xs"
                        containerClassName="min-w-[200px] flex-1"
                      />
                      <CopyButton
                        copied={copiedKey === "shareUrl"}
                        onCopy={() =>
                          triggerCopy(
                            "shareUrl",
                            shareUrl,
                            "回放链接已复制",
                            "发给任何人即可免登录查看讨论回放",
                          )
                        }
                        label="复制链接"
                        copiedLabel="已复制"
                        variant="primary"
                      />
                      <a
                        href={shareUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={appButtonVariants({ variant: "secondary", size: "sm" })}
                      >
                        <span>打开预览</span>
                        <ExternalLink aria-hidden="true" className="h-3 w-3" />
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
