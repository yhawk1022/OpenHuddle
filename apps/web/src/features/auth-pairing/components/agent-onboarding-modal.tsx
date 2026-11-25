/**
 * @module web/features/auth-pairing/agent-onboarding-modal
 * @description Apple Liquid Glass 协调风格「接入我的 Agent」与「邀请进群」双标签模态窗。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. Agent 身份、回复执行方式与入群范围分别由用户选择。
 * 2. 跨机接入链接始终与所选群聊、恢复身份范围匹配。
 * 3. 原身份无损重连：接入链接可恢复选定的 `AgentId`，保留群成员身份与消息游标。
 */
import type {
  AgentId,
  AgentPlatform,
  ConnectLocalAgentResponse,
  CreateAgentConnectionResponse,
  HumanUserDto,
  LocalAgentCliEntry,
  OwnedAgentSummaryDto,
  RoomDetailDto,
} from "@openhuddle/protocol";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  Bot,
  Check,
  ChevronDown,
  Copy,
  ExternalLink,
  FolderGit2,
  Globe,
  KeyRound,
  Link2,
  Lock,
  MessageSquareText,
  Plug,
  RefreshCw,
  Share2,
  Terminal,
  Trash2,
  UserPlus,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { HighlightedCodeBlock } from "../../../components/ui/syntax-code.js";
import {
  type AgentExecutionTier,
  formatDaemonCapabilityCliFlags,
  getExecutionTierMeta,
  updateAgentCapabilityPref,
} from "../../../lib/agent-capability-prefs.js";
import { ApiClientError } from "../../../lib/api-client.js";
import { getPlatformVisualMeta } from "../../../lib/format.js";
import { huddleQueryKeys } from "../../../lib/query-keys.js";
import {
  localAgentsStatusQueryOptions,
  useConnectLocalAgentMutation,
  useCreateAgentConnectionMutation,
  useDeleteOwnedAgentMutation,
  useRoomShareVisibilityMutation,
} from "../api/auth-pairing.queries.js";
import {
  type AgentReplyMode,
  CONNECT_RUNNER_PRESETS,
  buildAgentConnectInstructions,
  buildAgentMcpConfigs,
  defaultAgentReplyMode,
  findNewAgentMatchingInstructions,
  resolveAgentConnectEndpoint,
} from "../connect-instructions.js";

const PLATFORM_PRESETS: ReadonlyArray<AgentPlatform> = [
  "claude_code",
  "codex",
  "cursor",
  "antigravity",
  "openclaw",
  "gemini",
  "deepseek",
  "chatgpt",
  "custom",
];

/** Radix `Select` 要求非空字符串值：用哨兵值代表“接入一个全新的 Agent”而非 `--reclaim` */
const NEW_AGENT_SENTINEL = "__new_agent__";

/** 打开接入与邀请弹窗时的初始视图意图 */
export type OnboardingModalTab = "pair_agent" | "invite_share";

/** 接入指令的表现方式 */
type ConnectMethodTab = "prompt" | "cli" | "mcp";

/** 顶栏自然口语分段标签配置 */
const TOP_TAB_ITEMS: ReadonlyArray<SegmentedTabItem<OnboardingModalTab>> = [
  {
    value: "pair_agent",
    label: "接入 Agent",
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
    label: "一句话接入",
    icon: <MessageSquareText className="h-3.5 w-3.5" />,
  },
  {
    value: "cli",
    label: "手动 CLI",
    icon: <Terminal className="h-3.5 w-3.5" />,
  },
  {
    value: "mcp",
    label: "MCP 接入",
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
  readonly connectionRoom?: Pick<RoomDetailDto, "id" | "name"> | undefined;
  readonly connectionRoomPending: boolean;
  readonly onVerifyReply: (agentId: AgentId) => void;
  readonly isOpeningDirectChat: boolean;
  readonly onClose: () => void;
}

/** 只读代码块样式：凹陷暖瓷白 / 暗夜深中性石墨井 */
const CODE_BLOCK_CLASS =
  "select-text overflow-x-auto overscroll-x-contain whitespace-pre rounded-[16px] border border-black/[0.07] bg-[#F6F8FB] p-3.5 font-mono text-[11.5px] leading-relaxed text-[#111318] dark:border-white/[0.08] dark:bg-[#141417] dark:text-[#ECECEF]";

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
          <Check aria-hidden="true" className="h-3.5 w-3.5 text-[#16A34A] dark:text-[#34D399]" />
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
const ONBOARDING_TIER_TABS: ReadonlyArray<SegmentedTabItem<AgentExecutionTier>> = [
  { value: "chat_only", label: "仅群聊讨论" },
  { value: "workspace_read", label: "查看代码" },
  { value: "worktree_write", label: "修改代码" },
];

export function AgentOnboardingModal(props: AgentOnboardingModalProps) {
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<OnboardingModalTab>(props.initialTab ?? "pair_agent");
  const [methodTab, setMethodTab] = useState<ConnectMethodTab>("prompt");
  const [selectedPlatform, setSelectedPlatform] = useState<AgentPlatform>("claude_code");
  const [capabilityOpen, setCapabilityOpen] = useState<boolean>(false);
  const [draftTier, setDraftTier] = useState<AgentExecutionTier>("chat_only");
  const [draftWorkspacePath, setDraftWorkspacePath] = useState<string>("");
  const [draftWarmSession, setDraftWarmSession] = useState<boolean>(true);
  const [draftNativeOrchestrator, setDraftNativeOrchestrator] = useState<boolean>(true);
  const [replyModeOverride, setReplyModeOverride] = useState<AgentReplyMode | null>(null);
  const defaultReplyMode = defaultAgentReplyMode(selectedPlatform);
  const replyMode = replyModeOverride ?? defaultReplyMode;
  const [reclaimAgentId, setReclaimAgentId] = useState<AgentId | null>(
    props.initialReclaimAgentId ?? null,
  );
  const [customAgentName, setCustomAgentName] = useState<string>("");
  const [autoJoinActiveRoom, setAutoJoinActiveRoom] = useState<boolean>(false);
  const [connection, setGeneratedConnection] = useState<{
    readonly scope: string;
    readonly response: CreateAgentConnectionResponse;
    readonly existingAgentIds: ReadonlySet<AgentId>;
  } | null>(null);
  const [showManualConnectFallback, setShowManualConnectFallback] = useState<boolean>(false);
  const [directConnectedResult, setDirectConnectedResult] =
    useState<ConnectLocalAgentResponse | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [copiedIdentity, setCopiedIdentity] = useState<{
    readonly connection: CreateAgentConnectionResponse;
    readonly name: string;
    readonly platform: AgentPlatform;
  } | null>(null);
  const hasUserPickedPlatformRef = useRef<boolean>(false);
  const autoGeneratedScopeRef = useRef<string | null>(null);
  const targetAutoJoinRoomId = autoJoinActiveRoom ? props.connectionRoom?.id : undefined;
  const autoJoinRoomPending = autoJoinActiveRoom && props.connectionRoomPending;
  const connectionScope = `${reclaimAgentId ?? "new"}:${targetAutoJoinRoomId ?? "none"}:${selectedPlatform}`;
  const generatedConnection = connection?.scope === connectionScope ? connection.response : null;

  const localAgentsQuery = useQuery({
    ...localAgentsStatusQueryOptions(),
    enabled: props.open,
  });
  const connectLocalMutation = useConnectLocalAgentMutation();
  const connectionMutation = useCreateAgentConnectionMutation();
  const deleteAgentMutation = useDeleteOwnedAgentMutation();
  const visibilityMutation = useRoomShareVisibilityMutation();
  const [confirmDeleteAgentId, setConfirmDeleteAgentId] = useState<AgentId | null>(null);
  const { mutate: mutateConnection, isPending: isConnectionPending } = connectionMutation;
  const { reset: resetLocalConnectMutation } = connectLocalMutation;

  const localCliByPlatform = useMemo<ReadonlyMap<AgentPlatform, LocalAgentCliEntry>>(() => {
    const map = new Map<AgentPlatform, LocalAgentCliEntry>();
    if (!localAgentsQuery.data?.available) {
      return map;
    }
    for (const cli of localAgentsQuery.data.clis) {
      map.set(cli.platform, cli);
    }
    return map;
  }, [localAgentsQuery.data]);

  // 当外部打开弹窗并传入特定初始标签或待恢复 Agent ID 时，对齐局部交互视图状态（仅在开关或入参意图变化时重置，避免轮询刷新 ownedAgents 时清空刚生成的口令）
  const prevOpenRef = useRef<boolean>(false);
  useEffect(() => {
    const justOpened = props.open && !prevOpenRef.current;
    prevOpenRef.current = props.open;
    if (!justOpened) {
      return;
    }
    setActiveTab(props.initialTab ?? "pair_agent");
    const explicitReclaimId = props.initialReclaimAgentId ?? null;
    if (explicitReclaimId !== null) {
      hasUserPickedPlatformRef.current = true;
      setReclaimAgentId(explicitReclaimId);
      const matched = props.ownedAgents.find((item) => item.id === explicitReclaimId);
      if (matched !== undefined) {
        setSelectedPlatform(matched.platform);
      }
    } else {
      hasUserPickedPlatformRef.current = false;
      setReclaimAgentId(null);
    }
    setAutoJoinActiveRoom(false);
    setCustomAgentName("");
    setReplyModeOverride(null);
    setGeneratedConnection(null);
    setShowManualConnectFallback(false);
    setDirectConnectedResult(null);
    resetLocalConnectMutation();
    setMethodTab("prompt");
    setCopiedIdentity(null);
    autoGeneratedScopeRef.current = null;
  }, [
    props.open,
    props.initialTab,
    props.initialReclaimAgentId,
    props.ownedAgents,
    resetLocalConnectMutation,
  ]);

  // 用户尚未手动选择时优先展示本机可运行的宿主，恢复身份仍由用户明确选择。
  useEffect(() => {
    if (!props.open || hasUserPickedPlatformRef.current || !localAgentsQuery.data?.available) {
      return;
    }
    const installedClis = localAgentsQuery.data.clis.filter((cli) => cli.installed);
    if (installedClis.length === 0) {
      return;
    }
    const unpairedInstalled = installedClis.find(
      (cli) => !props.ownedAgents.some((agent) => agent.platform === cli.platform),
    );
    const chosenCli = unpairedInstalled ?? installedClis[0];
    if (!chosenCli) {
      return;
    }
    if (selectedPlatform !== chosenCli.platform) {
      setSelectedPlatform(chosenCli.platform);
    }
  }, [props.open, localAgentsQuery.data, props.ownedAgents, selectedPlatform]);

  // 只有与当前范围一致且未过期的接入链接才可复制。
  useEffect(() => {
    if (connection === null) {
      return;
    }
    const timer = window.setTimeout(
      () => setGeneratedConnection((current) => (current === connection ? null : current)),
      Math.max(0, Date.parse(connection.response.expiresAtIso) - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [connection]);

  // 生成指令后刷新身份及预期群聊成员，接入成功与监听状态各自由其真实数据驱动。
  const activeRoomId = props.connectionRoom?.id;
  useEffect(() => {
    if (!props.open || (generatedConnection === null && directConnectedResult === null)) {
      return;
    }
    const timer = window.setInterval(() => {
      void queryClient.invalidateQueries({ queryKey: huddleQueryKeys.me() });
      if (activeRoomId !== undefined) {
        void queryClient.invalidateQueries({ queryKey: huddleQueryKeys.roomDetail(activeRoomId) });
      }
    }, 2_000);
    return () => {
      window.clearInterval(timer);
    };
  }, [props.open, generatedConnection, directConnectedResult, activeRoomId, queryClient]);

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
    onCopied?: () => void,
  ): void => {
    if (typeof navigator === "undefined" || !navigator.clipboard) {
      toast.error("当前环境不支持直接写入剪贴板，请手动选中文本复制");
      return;
    }
    void navigator.clipboard
      .writeText(text)
      .then(() => {
        onCopied?.();
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

  const requestNewConnection = useCallback(
    (options?: { readonly silentToast?: boolean }): void => {
      if (autoJoinRoomPending) {
        return;
      }
      const existingAgentIds = new Set(props.ownedAgents.map((agent) => agent.id));
      mutateConnection(
        {
          ...(targetAutoJoinRoomId !== undefined ? { autoJoinRoomId: targetAutoJoinRoomId } : {}),
          ...(reclaimAgentId !== null ? { reclaimAgentId } : {}),
        },
        {
          onSuccess: (res) => {
            setGeneratedConnection({ scope: connectionScope, response: res, existingAgentIds });
            if (!options?.silentToast) {
              toast.success("已生成新的接入指令");
            }
          },
          onError: (err) => {
            const msg =
              err instanceof ApiClientError
                ? err.message
                : err instanceof Error
                  ? err.message
                  : "生成接入指令失败";
            toast.error(msg);
          },
        },
      );
    },
    [
      connectionScope,
      autoJoinRoomPending,
      props.ownedAgents,
      targetAutoJoinRoomId,
      reclaimAgentId,
      mutateConnection,
    ],
  );

  const selectedLocalCli = localCliByPlatform.get(selectedPlatform);
  const isSelectedLocalConnectReady =
    replyMode === selectedPlatform &&
    localAgentsQuery.data?.available === true &&
    selectedLocalCli?.installed === true;
  const needsConnectionLink = !isSelectedLocalConnectReady || showManualConnectFallback;
  // 只有主动选中加群时才等待房间范围，账号接入可直接签发。
  useEffect(() => {
    if (
      !props.open ||
      activeTab !== "pair_agent" ||
      autoJoinRoomPending ||
      localAgentsQuery.isPending ||
      !needsConnectionLink ||
      generatedConnection !== null ||
      isConnectionPending
    ) {
      return;
    }
    if (autoGeneratedScopeRef.current === connectionScope) {
      return;
    }
    autoGeneratedScopeRef.current = connectionScope;
    requestNewConnection({ silentToast: true });
  }, [
    props.open,
    activeTab,
    autoJoinRoomPending,
    localAgentsQuery.isPending,
    needsConnectionLink,
    generatedConnection,
    isConnectionPending,
    connectionScope,
    requestNewConnection,
  ]);

  // 原 Agent 的心跳会继续刷新，只有客户端核验可确认重连。新身份仅按复制时的资料对照账号清单。
  const newlyConnectedAgent =
    reclaimAgentId === null &&
    connection !== null &&
    copiedIdentity !== null &&
    copiedIdentity.connection === generatedConnection
      ? findNewAgentMatchingInstructions(
          props.ownedAgents,
          connection.existingAgentIds,
          copiedIdentity,
        )
      : null;

  const agentNameBase =
    `${props.currentUser.displayName}-${platformMeta.label.replace(/\s+/g, "")}`.slice(0, 54);
  const existingAgentNames = new Set(
    props.ownedAgents.map((agent) => agent.displayName.toLowerCase()),
  );
  let defaultAgentName = agentNameBase;
  for (let suffix = 2; existingAgentNames.has(defaultAgentName.toLowerCase()); suffix += 1) {
    defaultAgentName = `${agentNameBase}-${suffix}`;
  }
  const suggestedAgentName = reclaimTarget
    ? reclaimTarget.displayName
    : customAgentName.trim().length > 0
      ? customAgentName.trim()
      : defaultAgentName;

  const copyConnectInstructions = (
    key: string,
    text: string,
    title: string,
    description?: string,
  ): void => {
    if (generatedConnection === null) {
      return;
    }
    const identity = {
      connection: generatedConnection,
      name: suggestedAgentName,
      platform: selectedPlatform,
    };
    triggerCopy(key, text, title, description, () => setCopiedIdentity(identity));
  };

  const handleInstantLocalConnect = (): void => {
    if (!selectedLocalCli || !selectedLocalCli.installed || autoJoinRoomPending) {
      return;
    }
    setDirectConnectedResult(null);
    connectLocalMutation.mutate(
      {
        platform: selectedLocalCli.platform,
        name: suggestedAgentName,
        ...(targetAutoJoinRoomId !== undefined ? { autoJoinRoomId: targetAutoJoinRoomId } : {}),
        ...(reclaimAgentId !== null ? { reclaimAgentId } : {}),
      },
      {
        onSuccess: (res) => {
          setDirectConnectedResult(res);
          // 成功后同步保存本次选定的本地工作区执行权限与温热加速偏好，并锁定为原身份重连防重复创建
          updateAgentCapabilityPref(
            res.agent.id,
            {
              tier: draftTier,
              workspacePath: draftWorkspacePath,
              warmSessionEnabled: draftWarmSession,
              nativeOrchestratorEnabled: draftNativeOrchestrator,
            },
            res.agent.platform,
          );
          setReclaimAgentId(res.agent.id);
          toast.success(`「${res.agent.displayName}」身份已绑定`);
        },
        onError: (err) => {
          const msg =
            err instanceof ApiClientError
              ? err.message
              : err instanceof Error
                ? err.message
                : "连接本机失败";
          toast.error(msg);
        },
      },
    );
  };

  const connectEndpoint = generatedConnection
    ? resolveAgentConnectEndpoint(
        generatedConnection.connectUrl,
        typeof window !== "undefined" ? window.location.origin : "",
      )
    : null;
  const runnerLabel =
    replyMode === "on_demand" ? undefined : getPlatformVisualMeta(replyMode).label;
  const connectInstructions = connectEndpoint
    ? buildAgentConnectInstructions({
        ...connectEndpoint,
        name: suggestedAgentName,
        platform: selectedPlatform,
        replyMode,
        runnerLabel,
        roomName: targetAutoJoinRoomId !== undefined ? props.connectionRoom?.name : undefined,
      })
    : null;
  const mcpConfigs = connectEndpoint ? buildAgentMcpConfigs(connectEndpoint.serverUrl) : null;

  const shareUrl =
    props.activeRoom?.inviteToken !== undefined && typeof window !== "undefined"
      ? `${window.location.origin}/share/${encodeURIComponent(props.activeRoom.inviteToken)}`
      : null;

  const mutationError =
    connectionMutation.error instanceof ApiClientError
      ? connectionMutation.error.message
      : connectionMutation.error instanceof Error
        ? connectionMutation.error.message
        : null;

  const localConnectError =
    connectLocalMutation.error instanceof ApiClientError
      ? connectLocalMutation.error.message
      : connectLocalMutation.error instanceof Error
        ? connectLocalMutation.error.message
        : null;

  const connectedBannerAgent =
    directConnectedResult === null
      ? newlyConnectedAgent
      : (props.ownedAgents.find((agent) => agent.id === directConnectedResult.agent.id) ??
        directConnectedResult.agent);
  const realtimeListenerConnected = connectedBannerAgent?.reach === "online_sse";

  return (
    <ModalDialog
      open={props.open}
      onClose={props.onClose}
      title={activeTab === "pair_agent" ? "接入我的 Agent" : "邀请进群"}
      subtitle={
        activeTab === "pair_agent"
          ? isSelectedLocalConnectReady
            ? "已检测到本机 CLI，可以直接接入"
            : "选择回复方式，再把接入指令发给你的 Agent"
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

        <AnimatePresence mode="wait" initial={false}>
          {activeTab === "pair_agent" ? (
            <motion.div
              key="onboarding-tab-pair"
              initial={{ opacity: 0, y: 5 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.15, ease: "easeOut" }}
              className="space-y-4"
            >
              {/* 1. 选择 Agent 运行环境 */}
              <div className="space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 text-xs">
                  <span className="font-medium text-[#111318] dark:text-[#ECECEF]">
                    你的 Agent 运行在哪里？
                  </span>
                  <span className="min-w-0 truncate text-[11.5px] text-[#687082] dark:text-[#8E8E96]">
                    {platformMeta.cliHint}
                  </span>
                </div>
                <div className="grid select-none grid-cols-2 gap-1.5 sm:grid-cols-4">
                  {PLATFORM_PRESETS.map((platform) => {
                    const meta = getPlatformVisualMeta(platform);
                    const isSelected = selectedPlatform === platform;
                    const isInstalledLocally = localCliByPlatform.get(platform)?.installed === true;
                    return (
                      <button
                        key={platform}
                        type="button"
                        aria-pressed={isSelected}
                        onClick={() => {
                          hasUserPickedPlatformRef.current = true;
                          setSelectedPlatform(platform);
                          if (!isSelected) {
                            setReclaimAgentId(null);
                            setReplyModeOverride(null);
                          }
                          setGeneratedConnection(null);
                          setDirectConnectedResult(null);
                          resetLocalConnectMutation();
                          setShowManualConnectFallback(false);
                          autoGeneratedScopeRef.current = null;
                        }}
                        className={cn(
                          "app-no-drag flex cursor-pointer items-center gap-2 rounded-full px-2.5 py-1.5 text-left text-xs font-medium transition-all duration-150 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50",
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
                          <PlatformGlyph platform={platform} className="h-3 w-3" />
                        </span>
                        <span className="min-w-0 flex-1 truncate">{meta.label}</span>
                        {isInstalledLocally ? (
                          <span
                            title="已安装，可直接连接"
                            className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#16A34A] dark:bg-[#34D399]"
                          />
                        ) : null}
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
                    className="mb-1.5 block text-xs font-medium text-[#3B414E] dark:text-[#C4C4CA]"
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
                          hasUserPickedPlatformRef.current = true;
                          setSelectedPlatform(chosen.platform);
                        }
                      }
                      setReplyModeOverride(null);
                      setGeneratedConnection(null);
                      setDirectConnectedResult(null);
                      resetLocalConnectMutation();
                      autoGeneratedScopeRef.current = null;
                    }}
                  />
                </div>

                <div>
                  <label
                    htmlFor="agent-nickname-input"
                    className="mb-1.5 block text-xs font-medium text-[#3B414E] dark:text-[#C4C4CA]"
                  >
                    Agent 名称
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

              <div>
                <label
                  htmlFor="agent-reply-mode-select"
                  className="mb-1.5 block text-xs font-medium text-[#3B414E] dark:text-[#C4C4CA]"
                >
                  谁来回复消息？
                </label>
                <AppSelect
                  id="agent-reply-mode-select"
                  value={replyMode}
                  options={[
                    { value: "on_demand", label: "由当前 Agent 按需读写" },
                    ...CONNECT_RUNNER_PRESETS.map((preset) => ({
                      value: preset,
                      label: `由 ${getPlatformVisualMeta(preset).label} CLI 自动回复`,
                    })),
                  ]}
                  size="md"
                  onValueChange={(value) => {
                    const preset = CONNECT_RUNNER_PRESETS.find((entry) => entry === value);
                    if (value === "on_demand" || preset !== undefined) {
                      setReplyModeOverride(preset ?? "on_demand");
                      setCopiedKey(null);
                    }
                  }}
                />
                <p className="mt-1.5 text-xs text-im-muted">
                  {replyMode === "on_demand"
                    ? "在当前 Agent 会话里发起查收，使用 CLI 或 MCP 回复。"
                    : `由接入设备上的 ${runnerLabel} CLI 执行，以「${suggestedAgentName}」身份回复。`}
                </p>
              </div>

              {/* 自动进群拨杆开关 */}
              <div className="flex items-center justify-between gap-3 rounded-[18px] bg-black/[0.035] px-4 py-3 ring-1 ring-inset ring-black/[0.05] dark:bg-white/[0.045] dark:ring-white/[0.08]">
                {props.connectionRoomPending ? (
                  <p className="text-xs text-im-muted">正在确认当前群聊…</p>
                ) : props.connectionRoom ? (
                  <>
                    <label
                      htmlFor="auto-join-active-room-switch"
                      className="min-w-0 flex-1 cursor-pointer select-none text-xs text-[#3B414E] dark:text-[#C4C4CA]"
                    >
                      接入时同时加入群聊{" "}
                      <strong className="font-semibold text-[#111318] dark:text-[#F2F2F4]">
                        {props.connectionRoom.name}
                      </strong>
                    </label>
                    <AppSwitch
                      id="auto-join-active-room-switch"
                      size="sm"
                      checked={autoJoinActiveRoom}
                      onCheckedChange={(checked) => {
                        setAutoJoinActiveRoom(checked);
                        setGeneratedConnection(null);
                        autoGeneratedScopeRef.current = null;
                      }}
                      ariaLabel={`接入后自动加入群聊 ${props.connectionRoom.name}`}
                    />
                  </>
                ) : (
                  <p className="text-xs text-[#687082] dark:text-[#8E8E96]">
                    接入后可以直接发起单聊，或从群聊成员面板添加。
                  </p>
                )}
              </div>

              {/* 可折叠高级配置：本地代码库绑定、Worktree 隔离与温热驻留加速 */}
              {replyMode !== "on_demand" ? (
                <div className="overflow-hidden rounded-[18px] bg-black/[0.035] ring-1 ring-inset ring-black/[0.05] dark:bg-white/[0.045] dark:ring-white/[0.08]">
                  <button
                    type="button"
                    onClick={() => setCapabilityOpen((v) => !v)}
                    aria-expanded={capabilityOpen}
                    className="flex w-full cursor-pointer select-none items-center justify-between gap-2 px-4 py-3 text-left text-xs transition hover:bg-black/[0.025] dark:hover:bg-white/[0.03]"
                  >
                    <span className="inline-flex min-w-0 items-center gap-2">
                      <FolderGit2 className="h-3.5 w-3.5 shrink-0 text-[#111318] dark:text-[#F2F2F4]" />
                      <span className="truncate font-semibold text-[#111318] dark:text-[#F2F2F4]">
                        本地运行设置（可选）
                      </span>
                      <span className="rounded-full bg-black/[0.055] px-2 py-0.5 text-[10.5px] font-medium text-[#3B414E] dark:bg-white/[0.09] dark:text-[#C4C4CA]">
                        {getExecutionTierMeta(draftTier).shortLabel}
                      </span>
                    </span>
                    <ChevronDown
                      className={cn(
                        "h-3.5 w-3.5 shrink-0 text-[#687082] transition-transform dark:text-[#8E8E96]",
                        capabilityOpen && "rotate-180",
                      )}
                    />
                  </button>

                  <AnimatePresence initial={false}>
                    {capabilityOpen ? (
                      <motion.div
                        key="onboarding-cap-panel"
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: "auto", opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.16 }}
                        className="overflow-hidden border-t border-black/[0.06] dark:border-white/[0.08]"
                      >
                        <div className="space-y-3 p-4 text-xs">
                          <div>
                            <p className="mb-1.5 font-medium text-[#3B414E] dark:text-[#C4C4CA]">
                              本地权限（仅用于你批准的任务）
                            </p>
                            <SegmentedTabs
                              value={draftTier}
                              onValueChange={(tier) => {
                                setDraftTier(tier);
                                if (reclaimTarget) {
                                  updateAgentCapabilityPref(
                                    reclaimTarget.id,
                                    { tier },
                                    selectedPlatform,
                                  );
                                }
                              }}
                              items={ONBOARDING_TIER_TABS}
                              size="xs"
                              fullWidth={true}
                              ariaLabel="选择 Agent 本地权限"
                            />
                            <p className="mt-1.5 text-[11px] text-im-muted">
                              {getExecutionTierMeta(draftTier).description}
                            </p>
                          </div>

                          {draftTier !== "chat_only" ? (
                            <div>
                              <label
                                htmlFor="onboarding-workspace-path"
                                className="mb-1 block text-[11.5px] font-medium text-[#3B414E] dark:text-[#C4C4CA]"
                              >
                                本地代码仓库绝对路径
                              </label>
                              <AppInput
                                id="onboarding-workspace-path"
                                size="sm"
                                value={draftWorkspacePath}
                                onChange={(e) => setDraftWorkspacePath(e.target.value)}
                                placeholder="/Users/you/Developer/OpenHuddle"
                                className="font-mono text-[16px] md:text-[11.5px]"
                              />
                            </div>
                          ) : null}

                          <div className="flex items-center justify-between gap-3">
                            <div className="min-w-0">
                              <p className="font-medium text-[#111318] dark:text-[#F2F2F4]">
                                保留会话 15 分钟
                              </p>
                              <p className="text-[11px] text-im-muted">
                                下次运行任务时可以继续使用这个会话。
                              </p>
                            </div>
                            <AppSwitch
                              size="sm"
                              ariaLabel="保留会话 15 分钟"
                              checked={draftWarmSession}
                              onCheckedChange={setDraftWarmSession}
                            />
                          </div>

                          {selectedPlatform === "antigravity" ? (
                            <div className="flex items-center justify-between gap-3 border-t border-black/[0.05] pt-2.5 dark:border-white/[0.07]">
                              <div className="min-w-0">
                                <p className="font-medium text-[#111318] dark:text-[#F2F2F4]">
                                  分开规划和执行
                                </p>
                                <p className="text-[11px] text-im-muted">
                                  Carbon 负责只读规划，Hydrogen 负责执行。
                                </p>
                              </div>
                              <AppSwitch
                                size="sm"
                                ariaLabel="分开规划和执行"
                                checked={draftNativeOrchestrator}
                                onCheckedChange={setDraftNativeOrchestrator}
                              />
                            </div>
                          ) : null}

                          <div className="rounded-xl bg-white/85 px-3 py-2 font-mono text-[11px] text-[#3B414E] ring-1 ring-inset ring-black/[0.05] dark:bg-[#141417] dark:text-[#C4C4CA] dark:ring-white/[0.08]">
                            listen 附加参数：{" "}
                            {formatDaemonCapabilityCliFlags(
                              {
                                tier: draftTier,
                                workspacePath: draftWorkspacePath,
                                warmSessionEnabled: draftWarmSession,
                                nativeOrchestratorEnabled: draftNativeOrchestrator,
                              },
                              selectedPlatform,
                            ) || "(默认纯聊天模式)"}
                          </div>
                        </div>
                      </motion.div>
                    ) : null}
                  </AnimatePresence>
                </div>
              ) : null}

              {connectedBannerAgent ? (
                <div
                  className={cn(
                    "flex flex-wrap items-center justify-between gap-2 rounded-[18px] px-3.5 py-2.5 text-xs ring-1 ring-inset",
                    realtimeListenerConnected
                      ? "bg-[#16A34A]/[0.12] text-[#145335] ring-[#16A34A]/25 dark:bg-[#34D399]/[0.14] dark:text-[#6EE7B7] dark:ring-[#34D399]/30"
                      : "bg-amber-500/10 text-amber-900 ring-amber-500/20 dark:text-amber-200",
                  )}
                >
                  <div className="flex min-w-0 items-center gap-2">
                    {realtimeListenerConnected ? (
                      <Check aria-hidden="true" className="h-4 w-4 shrink-0" />
                    ) : (
                      <Terminal aria-hidden="true" className="h-4 w-4 shrink-0" />
                    )}
                    <span className="truncate font-medium">
                      「{connectedBannerAgent.displayName}」
                      {directConnectedResult === null ? "已出现在账号中" : "身份已绑定"}
                    </span>
                    <span>{realtimeListenerConnected ? "实时监听已连接" : "实时监听未连接"}</span>
                  </div>
                  <AppButton
                    variant="secondary"
                    size="xs"
                    isLoading={props.isOpeningDirectChat}
                    onClick={() => props.onVerifyReply(connectedBannerAgent.id)}
                  >
                    打开单聊验证回复
                  </AppButton>
                </div>
              ) : null}

              {generatedConnection && reclaimTarget && !directConnectedResult ? (
                <p className="text-xs text-im-muted">
                  已为「{reclaimTarget.displayName}」签发重连指令。执行后，在 Agent
                  端核对身份，并用原单聊验证本次回复。
                </p>
              ) : null}

              {/* 3A. 同机已安装预设 CLI：一键秒连主卡片 */}
              {isSelectedLocalConnectReady && selectedLocalCli ? (
                <div className="rounded-[22px] bg-black/[0.035] p-4 ring-1 ring-inset ring-black/[0.06] dark:bg-white/[0.045] dark:ring-white/[0.08]">
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#111318] dark:text-[#F2F2F4]">
                      <span className="h-2 w-2 rounded-full bg-[#16A34A] dark:bg-[#34D399]" />
                      <span>已检测到本机 {platformMeta.label} CLI</span>
                    </span>
                    <span className="rounded-full bg-white/90 px-2.5 py-0.5 font-mono text-[11px] text-[#687082] ring-1 ring-inset ring-black/[0.06] dark:bg-[#141417] dark:text-[#8E8E96] dark:ring-white/[0.08]">
                      {selectedLocalCli.binaryName} · 本机直连
                    </span>
                  </div>

                  {localConnectError ? (
                    <p
                      role="alert"
                      className="mb-3 rounded-2xl border border-[#E5484D]/25 bg-[#E5484D]/[0.08] px-3 py-2 text-xs text-[#C81E1E] dark:bg-[#F05252]/12 dark:text-[#FCA5A5]"
                    >
                      {localConnectError}
                    </p>
                  ) : null}

                  <p className="mb-3 text-xs leading-relaxed text-[#4B5565] dark:text-[#9B9BA3]">
                    点击下方按钮绑定身份，并尝试启动后台监听。
                  </p>

                  <AppButton
                    variant="primary"
                    size="lg"
                    fullWidth={true}
                    isLoading={connectLocalMutation.isPending || autoJoinRoomPending}
                    trailingIcon={
                      !connectLocalMutation.isPending ? (
                        <ArrowRight aria-hidden="true" className="h-4 w-4" />
                      ) : undefined
                    }
                    onClick={handleInstantLocalConnect}
                    className="h-10 rounded-full"
                  >
                    {connectLocalMutation.isPending || autoJoinRoomPending
                      ? "正在直连并启动后台监听..."
                      : reclaimTarget
                        ? `重新连接本机的「${reclaimTarget.displayName}」`
                        : `连接本机的 ${platformMeta.label}`}
                  </AppButton>

                  <div className="mt-2.5 flex items-center justify-center">
                    <button
                      type="button"
                      onClick={() => {
                        const nextVal = !showManualConnectFallback;
                        setShowManualConnectFallback(nextVal);
                      }}
                      className="app-no-drag cursor-pointer text-[11.5px] text-[#687082] underline-offset-4 transition hover:text-[#111318] hover:underline dark:text-[#8E8E96] dark:hover:text-[#F2F2F4]"
                    >
                      {showManualConnectFallback
                        ? "收起跨环境接入提示词与 CLI 安装链接"
                        : "Agent 在云端沙箱或另一台机器上？展开跨环境 CLI 安装链接"}
                    </button>
                  </div>
                </div>
              ) : null}

              {/* 跨设备接入指令在授权范围确认后生成。 */}
              {needsConnectionLink ? (
                <AnimatePresence mode="wait" initial={false}>
                  {connectInstructions === null ? (
                    <motion.div
                      key="generate-cta"
                      initial={{ opacity: 0, y: 4 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -4 }}
                      transition={{ duration: 0.14 }}
                      className="rounded-[22px] bg-black/[0.035] p-4 ring-1 ring-inset ring-black/[0.05] dark:bg-white/[0.045] dark:ring-white/[0.08]"
                    >
                      {mutationError ? (
                        <p
                          role="alert"
                          className="mb-3 rounded-2xl border border-[#E5484D]/25 bg-[#E5484D]/[0.08] px-3 py-2 text-xs text-[#C81E1E] dark:bg-[#F05252]/12 dark:text-[#FCA5A5]"
                        >
                          {mutationError}
                        </p>
                      ) : null}
                      <AppButton
                        variant="primary"
                        size="lg"
                        fullWidth={true}
                        isLoading={connectionMutation.isPending || autoJoinRoomPending}
                        trailingIcon={
                          !connectionMutation.isPending ? (
                            <ArrowRight aria-hidden="true" className="h-4 w-4" />
                          ) : undefined
                        }
                        onClick={() => requestNewConnection()}
                        className="h-10 rounded-full"
                      >
                        {connectionMutation.isPending || autoJoinRoomPending
                          ? "正在准备接入指令…"
                          : reclaimTarget
                            ? `生成「${reclaimTarget.displayName}」的重连话术`
                            : `准备发给 ${platformMeta.label} 的话`}
                      </AppButton>
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
                      {connectEndpoint?.isLoopback ? (
                        <p className="rounded-[14px] bg-amber-500/10 px-3.5 py-2 text-[11.5px] leading-relaxed text-[#6B4E12] ring-1 ring-inset ring-amber-500/20 dark:bg-amber-400/10 dark:text-[#F5DF9D] dark:ring-amber-400/20">
                          当前地址 <code className="font-mono">{connectEndpoint.serverUrl}</code>{" "}
                          仅本机可达。接入云端或其他设备上的 Agent，请从该设备可访问的地址打开本页。
                        </p>
                      ) : null}

                      <SegmentedTabs
                        value={methodTab}
                        onValueChange={setMethodTab}
                        items={CONNECT_METHOD_ITEMS}
                        size="sm"
                        ariaLabel="Agent 接入方式切换"
                      />

                      <AnimatePresence mode="wait" initial={false}>
                        {methodTab === "prompt" ? (
                          <motion.div
                            key="method-prompt"
                            initial={{ opacity: 0, y: 4 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, y: -3 }}
                            transition={{ duration: 0.14, ease: "easeOut" }}
                            className="space-y-3 rounded-[22px] bg-black/[0.035] p-4 ring-1 ring-inset ring-black/[0.06] dark:bg-white/[0.045] dark:ring-white/[0.08]"
                          >
                            <p className="text-xs text-[#687082] dark:text-[#A0A0A8]">
                              复制后，在 {platformMeta.label} 的对话里粘贴发送。
                            </p>
                            <AppButton
                              variant="primary"
                              size="lg"
                              fullWidth={true}
                              className="h-10 rounded-full"
                              leadingIcon={
                                copiedKey === "prompt" ? (
                                  <Check
                                    aria-hidden="true"
                                    className="h-4 w-4 text-[#16A34A] dark:text-[#34D399]"
                                  />
                                ) : (
                                  <Copy aria-hidden="true" className="h-4 w-4" />
                                )
                              }
                              onClick={() =>
                                copyConnectInstructions(
                                  "prompt",
                                  connectInstructions.prompt,
                                  "发给 Agent 的话已复制",
                                  `在 ${platformMeta.label} 的会话里粘贴发送`,
                                )
                              }
                            >
                              {copiedKey === "prompt"
                                ? `已复制，去发给 ${platformMeta.label} 吧`
                                : "复制接入指令"}
                            </AppButton>
                            <details>
                              <summary className="cursor-pointer text-xs text-im-muted">
                                查看接入指令
                              </summary>
                              <pre data-vaul-no-drag="" className={cn(CODE_BLOCK_CLASS, "mt-2")}>
                                {connectInstructions.prompt}
                              </pre>
                            </details>
                          </motion.div>
                        ) : methodTab === "cli" ? (
                          <motion.div
                            key="method-cli"
                            initial={{ opacity: 0, y: 4 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, y: -3 }}
                            transition={{ duration: 0.14, ease: "easeOut" }}
                            className="space-y-3"
                          >
                            <p className="text-xs text-im-muted">
                              需要安装 CLI
                              时，由设备的用户或管理员下载并检查脚本。确认获准后，在同一终端执行第二步。
                            </p>
                            {connectInstructions.installers.map((installer) => (
                              <div key={installer.id} className="space-y-1.5">
                                <h4 className="text-xs font-medium text-[#3B414E] dark:text-[#C4C4CA]">
                                  {installer.title}
                                </h4>
                                <div className="flex justify-end">
                                  <CopyButton
                                    copied={copiedKey === `download-${installer.id}`}
                                    onCopy={() =>
                                      triggerCopy(
                                        `download-${installer.id}`,
                                        installer.download,
                                        "下载安装器的命令已复制",
                                      )
                                    }
                                    label="复制下载命令"
                                    copiedLabel="已复制"
                                    variant="secondary"
                                  />
                                </div>
                                <pre data-vaul-no-drag="" className={CODE_BLOCK_CLASS}>
                                  <HighlightedCodeBlock
                                    code={installer.download}
                                    language="shell"
                                  />
                                </pre>
                                <div className="flex justify-end">
                                  <CopyButton
                                    copied={copiedKey === `install-${installer.id}`}
                                    onCopy={() =>
                                      copyConnectInstructions(
                                        `install-${installer.id}`,
                                        installer.connect,
                                        "安装并接入命令已复制",
                                      )
                                    }
                                    label="复制安装并接入命令"
                                    copiedLabel="已复制"
                                    variant="secondary"
                                  />
                                </div>
                                <pre data-vaul-no-drag="" className={CODE_BLOCK_CLASS}>
                                  <HighlightedCodeBlock code={installer.connect} language="shell" />
                                </pre>
                              </div>
                            ))}
                          </motion.div>
                        ) : mcpConfigs !== null ? (
                          <motion.div
                            key="method-mcp"
                            initial={{ opacity: 0, y: 4 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, y: -3 }}
                            transition={{ duration: 0.14, ease: "easeOut" }}
                            className="space-y-3"
                          >
                            <div className="space-y-1.5">
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <p className="text-xs font-medium text-[#3B414E] dark:text-[#C4C4CA]">
                                  无终端时，先通过 HTTP 兑换 Agent 令牌
                                </p>
                                <CopyButton
                                  copied={copiedKey === "http"}
                                  onCopy={() =>
                                    copyConnectInstructions(
                                      "http",
                                      connectInstructions.http,
                                      "HTTP 兑换请求已复制",
                                    )
                                  }
                                  label="复制 HTTP 请求"
                                  copiedLabel="已复制"
                                  variant="secondary"
                                />
                              </div>
                              <pre data-vaul-no-drag="" className={CODE_BLOCK_CLASS}>
                                <HighlightedCodeBlock
                                  code={connectInstructions.http}
                                  language="shell"
                                />
                              </pre>
                            </div>

                            <div className="space-y-1.5">
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <p className="text-xs font-medium text-[#3B414E] dark:text-[#C4C4CA]">
                                  远程 MCP，使用 Streamable HTTP 与返回的令牌
                                </p>
                                <CopyButton
                                  copied={copiedKey === "mcpRemote"}
                                  onCopy={() =>
                                    triggerCopy(
                                      "mcpRemote",
                                      mcpConfigs.remote,
                                      "远程 HTTP MCP 配置已复制",
                                      "填入连接后获取的 oh_agt_ 令牌",
                                    )
                                  }
                                  label="复制远程配置"
                                  copiedLabel="已复制"
                                  variant="secondary"
                                />
                              </div>
                              <pre data-vaul-no-drag="" className={CODE_BLOCK_CLASS}>
                                <HighlightedCodeBlock code={mcpConfigs.remote} language="json" />
                              </pre>
                              <p className="text-xs text-im-muted">
                                按 MCP 宿主的配置格式填写地址和 Authorization
                                请求头。会话可按需收发。
                              </p>
                            </div>

                            <div className="space-y-1.5">
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <p className="text-xs font-medium text-[#3B414E] dark:text-[#C4C4CA]">
                                  本地 stdio MCP，先执行 CLI 接入，再填写实际路径
                                </p>
                                <CopyButton
                                  copied={copiedKey === "mcp"}
                                  onCopy={() =>
                                    triggerCopy(
                                      "mcp",
                                      mcpConfigs.stdio,
                                      "本地 stdio MCP 配置已复制",
                                      "填写 Node.js、安装目录及本次令牌文件的绝对路径",
                                    )
                                  }
                                  label="复制本地配置"
                                  copiedLabel="已复制"
                                  variant="secondary"
                                />
                              </div>
                              <pre data-vaul-no-drag="" className={CODE_BLOCK_CLASS}>
                                <HighlightedCodeBlock code={mcpConfigs.stdio} language="json" />
                              </pre>
                            </div>
                          </motion.div>
                        ) : null}
                      </AnimatePresence>

                      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-im-muted">
                        <p>接入指令有效期为 10 分钟，可使用一次。请只发给你的 Agent。</p>
                        <AppButton
                          variant="ghost"
                          size="xs"
                          isLoading={connectionMutation.isPending}
                          onClick={() => requestNewConnection()}
                        >
                          重新生成
                        </AppButton>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              ) : null}

              {/* 4. 我已接入的 Agent */}
              <div className="space-y-2 border-t border-black/[0.06] pt-4 dark:border-white/[0.08]">
                <h3 className="select-none text-xs font-medium text-[#687082] dark:text-[#8E8E96]">
                  我已接入的 Agent · {props.ownedAgents.length}
                </h3>

                {props.ownedAgents.length === 0 ? (
                  <p className="rounded-[16px] bg-black/[0.035] px-4 py-3 text-center text-xs text-[#687082] ring-1 ring-inset ring-black/[0.05] dark:bg-white/[0.045] dark:text-[#9B9BA3] dark:ring-white/[0.08]">
                    还没有接入任何 Agent，把上面生成的话发给它就能连上。
                  </p>
                ) : (
                  <div className="max-h-44 space-y-1 overflow-y-auto pr-1">
                    {props.ownedAgents.map((agent) => {
                      const meta = getPlatformVisualMeta(agent.platform);
                      const isConfirmingDelete = confirmDeleteAgentId === agent.id;
                      const isDeletingThis =
                        deleteAgentMutation.isPending && deleteAgentMutation.variables === agent.id;
                      return (
                        <div
                          key={agent.id}
                          className="flex items-center justify-between gap-2 rounded-[14px] px-2.5 py-1.5 transition hover:bg-black/[0.035] dark:hover:bg-white/[0.05]"
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
                              <p className="truncate text-xs font-semibold text-[#111318] dark:text-[#F2F2F4]">
                                {agent.displayName}
                              </p>
                              <p className="truncate text-[11px] text-[#687082] dark:text-[#8E8E96]">
                                {meta.label} · @{agent.slug}
                              </p>
                            </div>
                          </div>

                          <div className="flex shrink-0 items-center gap-1.5">
                            {isConfirmingDelete ? (
                              <>
                                <AppButton
                                  variant="ghost"
                                  size="xs"
                                  disabled={isDeletingThis}
                                  onClick={() => setConfirmDeleteAgentId(null)}
                                >
                                  取消
                                </AppButton>
                                <AppButton
                                  variant="danger"
                                  size="xs"
                                  isLoading={isDeletingThis}
                                  onClick={() => {
                                    deleteAgentMutation.mutate(agent.id, {
                                      onSuccess: (res) => {
                                        setConfirmDeleteAgentId(null);
                                        setReclaimAgentId((prev) =>
                                          prev === agent.id ? null : prev,
                                        );
                                        setDirectConnectedResult((prev) =>
                                          prev?.agent.id === agent.id ? null : prev,
                                        );
                                        toast.success(`已删除 Agent「${agent.displayName}」`, {
                                          description: res.stoppedLocalDaemon
                                            ? "已移出群聊并停止本机监听服务"
                                            : "已移出群聊并吊销访问令牌",
                                        });
                                      },
                                      onError: (err) => {
                                        toast.error(
                                          err instanceof Error ? err.message : "删除 Agent 失败",
                                        );
                                      },
                                    });
                                  }}
                                >
                                  确认删除
                                </AppButton>
                              </>
                            ) : (
                              <>
                                <ReachStatusBadge reach={agent.reach} compact={true} />
                                <IconButton
                                  size="xs"
                                  variant="ghost"
                                  label={`打开与 ${agent.displayName} 的单聊`}
                                  disabled={props.isOpeningDirectChat}
                                  onClick={() => props.onVerifyReply(agent.id)}
                                >
                                  <MessageSquareText aria-hidden="true" className="h-3.5 w-3.5" />
                                </IconButton>
                                <AppButton
                                  variant="secondary"
                                  size="xs"
                                  isLoading={
                                    connectLocalMutation.isPending && reclaimAgentId === agent.id
                                  }
                                  leadingIcon={<RefreshCw aria-hidden="true" className="h-3 w-3" />}
                                  onClick={() => {
                                    hasUserPickedPlatformRef.current = true;
                                    setReclaimAgentId(agent.id);
                                    setSelectedPlatform(agent.platform);
                                    setReplyModeOverride(null);
                                    setGeneratedConnection(null);
                                    setDirectConnectedResult(null);
                                    resetLocalConnectMutation();
                                    autoGeneratedScopeRef.current = null;

                                    const matchingLocalCli = localCliByPlatform.get(agent.platform);
                                    if (
                                      !autoJoinRoomPending &&
                                      localAgentsQuery.data?.available === true &&
                                      matchingLocalCli?.installed === true
                                    ) {
                                      connectLocalMutation.mutate(
                                        {
                                          platform: matchingLocalCli.platform,
                                          name: agent.displayName,
                                          ...(targetAutoJoinRoomId !== undefined
                                            ? { autoJoinRoomId: targetAutoJoinRoomId }
                                            : {}),
                                          reclaimAgentId: agent.id,
                                        },
                                        {
                                          onSuccess: (res) => {
                                            setDirectConnectedResult(res);
                                            setReclaimAgentId(res.agent.id);
                                            toast.success(`「${res.agent.displayName}」身份已恢复`);
                                          },
                                          onError: (err) => {
                                            const msg =
                                              err instanceof ApiClientError
                                                ? err.message
                                                : err instanceof Error
                                                  ? err.message
                                                  : "本机重连失败";
                                            toast.error(msg);
                                          },
                                        },
                                      );
                                      return;
                                    }
                                    toast.info(`已切换到「${agent.displayName}」重连模式`);
                                  }}
                                >
                                  重连
                                </AppButton>
                                <AppTooltip side="top" content="删除该 Agent">
                                  <IconButton
                                    size="xs"
                                    variant="ghost"
                                    label={`删除 ${agent.displayName}`}
                                    onClick={() => setConfirmDeleteAgentId(agent.id)}
                                    className="text-[#8E96A6] hover:text-[#E5484D] dark:text-[#63636B] dark:hover:text-[#F87171]"
                                  >
                                    <Trash2 className="h-3.5 w-3.5" />
                                  </IconButton>
                                </AppTooltip>
                              </>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </motion.div>
          ) : (
            /* Tab 2: 邀请进群与公开只读回放链接 */
            <motion.div
              key="onboarding-tab-invite"
              initial={{ opacity: 0, y: 5 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.15, ease: "easeOut" }}
              className="space-y-4"
            >
              {!props.activeRoom ? (
                <div className="rounded-[20px] bg-black/[0.035] p-6 text-center text-xs text-[#687082] dark:bg-white/[0.045] dark:text-[#8E8E96]">
                  请先在左侧打开或新建一个群聊，再复制它的邀请码或回放链接。
                </div>
              ) : (
                <>
                  {/* 群邀请码卡片 */}
                  <div className="space-y-3 rounded-[20px] bg-black/[0.035] p-4 ring-1 ring-inset ring-black/[0.05] dark:bg-white/[0.045] dark:ring-white/[0.08]">
                    <div className="flex items-center gap-2 text-xs font-semibold text-[#111318] dark:text-[#F2F2F4]">
                      <Link2
                        aria-hidden="true"
                        className="h-4 w-4 text-[#111318] dark:text-[#ECECEF]"
                      />
                      <span>群邀请码 · {props.activeRoom.name}</span>
                    </div>
                    <p className="text-xs leading-relaxed text-[#687082] dark:text-[#8E8E96]">
                      同伴登录后点击「加入群聊」粘贴即可进群；已接入的同伴 Agent 也可以执行{" "}
                      <code className="rounded-md bg-black/[0.06] px-1.5 py-0.5 font-mono text-[11px] text-[#111318] dark:bg-white/[0.10] dark:text-[#ECECEF]">
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
                      <p className="text-xs text-[#687082] dark:text-[#8E8E96]">
                        当前身份暂不可查看原始群邀请码。
                      </p>
                    )}
                  </div>

                  {/* 公开只读回放卡片 */}
                  <div className="space-y-3 rounded-[20px] bg-white/75 p-4 ring-1 ring-inset ring-black/[0.06] dark:bg-white/[0.035] dark:ring-white/[0.09]">
                    <div className="flex items-start justify-between gap-3">
                      <div className="space-y-1">
                        <div className="flex items-center gap-2 text-xs font-semibold text-[#111318] dark:text-[#F2F2F4]">
                          <Share2
                            aria-hidden="true"
                            className="h-4 w-4 text-[#16A34A] dark:text-[#34D399]"
                          />
                          <span>公开只读回放链接</span>
                        </div>
                        <p className="text-xs leading-relaxed text-[#687082] dark:text-[#8E8E96]">
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
                                toast.error(
                                  err instanceof Error ? err.message : "切换可见范围失败",
                                );
                              },
                            },
                          );
                        }}
                      />
                    </div>

                    <p className="flex select-none items-center gap-1.5 text-[11.5px] font-medium text-[#687082] dark:text-[#8E8E96]">
                      {props.activeRoom.visibility === "public_shareable" ? (
                        <>
                          <Globe
                            aria-hidden="true"
                            className="h-3.5 w-3.5 text-[#16A34A] dark:text-[#34D399]"
                          />
                          <span className="text-[#145335] dark:text-[#6EE7B7]">
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
                          leadingIcon={
                            <Globe className="h-3.5 w-3.5 text-[#16A34A] dark:text-[#34D399]" />
                          }
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
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </ModalDialog>
  );
}
