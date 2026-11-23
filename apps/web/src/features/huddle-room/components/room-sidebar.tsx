/**
 * @module web/features/huddle-room/room-sidebar
 * @description Apple Liquid Glass 空间工作台第 2 栏（`276px` 悬浮烟熏玻璃会话与通讯录侧栏）：
 * 顶栏展示圆形本人头像、昵称、实时在线状态与快捷新建/搜索入口；
 * 主体通过圆胶囊 `SegmentedTabs` 在「聊天」与「通讯录」间丝滑切换，会话行采用温润粉彩圆角方标与高通透浮起选中态，
 * 底部停靠统一的操作栏（彻底消除旧版粗黑线框按钮与机械四字截断头像）。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 四态完备渲染：显式区分加载骨架、失败重试、空列表引导、搜索无结果与正常会话列表。
 * 2. 反技术噪音排版：会话行仅展示圆角方标首字母头像、粗体群名、自然议题/状态副文案与珊瑚红未读数，严禁暴露 `#lastSeq` 等内部序号。
 * 3. 多端拖拽与安全区就绪：挂载 `relative liquid-glass-panel`，顶栏携带 `data-tauri-drag-region` 与 `.app-drag-region`；移动端（`< md`）在底部操作栏自然补齐接入 Agent 与退出入口。
 */
import type {
  AgentId,
  FriendContactDto,
  FriendRequestDto,
  FriendshipId,
  GovernanceMode,
  HumanUserDto,
  OwnedAgentSummaryDto,
  RoomId,
  RoomSummaryDto,
  SharedExternalAgentDto,
  UpdateGovernanceBody,
  UserId,
} from "@openhuddle/protocol";
import {
  AlertCircle,
  AtSign,
  Bot,
  Check,
  Copy,
  ExternalLink,
  Globe,
  KeyRound,
  Link2,
  LogIn,
  LogOut,
  MessageCircle,
  PauseCircle,
  Play,
  Plus,
  RefreshCw,
  Search,
  Shield,
  ShieldAlert,
  SlidersHorizontal,
  Trash2,
  UserCheck,
  UserMinus,
  UserPlus,
  UserRound,
  Users,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";
import {
  AnimatePresence,
  AppButton,
  AppContextMenu,
  type AppContextMenuEntry,
  AppInput,
  AppPopover,
  AppTooltip,
  IconButton,
  type SegmentedTabItem,
  SegmentedTabs,
  cn,
  motion,
  toast,
} from "../../../components/primitives/index.js";
import { PlatformAvatar } from "../../../components/ui/identity-badges.js";
import { ThemeToggle } from "../../../components/ui/theme-toggle.js";
import { getInitials, getPlatformVisualMeta, getReachVisualMeta } from "../../../lib/format.js";
import type { SseConnectionStatus } from "../../../lib/sse-sync.js";

/** 侧栏顶部分段标签枚举：`chats` = 聊天会话，`contacts` = 好友与 Agent 通讯录 */
export type SidebarSectionTab = "chats" | "contacts";

/** 聊天列表二级快捷过滤标签 */
type ChatListFilter = "all" | "group" | "direct";

/** `RoomSidebar` 入参属性 */
export interface RoomSidebarProps {
  readonly currentUser: HumanUserDto;
  readonly ownedAgents: ReadonlyArray<OwnedAgentSummaryDto>;
  readonly friends?: ReadonlyArray<FriendContactDto> | undefined;
  readonly incomingRequests?: ReadonlyArray<FriendRequestDto> | undefined;
  readonly discoverableAgents?: ReadonlyArray<SharedExternalAgentDto> | undefined;
  readonly rooms: ReadonlyArray<RoomSummaryDto>;
  readonly isLoadingRooms: boolean;
  readonly isRoomsError: boolean;
  readonly onRetryRooms: () => void;
  readonly activeRoomId: RoomId | null;
  readonly sseStatus: SseConnectionStatus;
  readonly onSelectRoom: (roomId: RoomId) => void;
  readonly onOpenCreateRoom: () => void;
  readonly onOpenJoinRoom: () => void;
  readonly onOpenMyAgents: () => void;
  readonly onOpenAddFriend?: (() => void) | undefined;
  readonly onStartDirectAgentChat?: ((agentId: AgentId) => void) | undefined;
  readonly onStartDirectHumanChat?: ((userId: UserId) => void) | undefined;
  readonly onAcceptFriendRequest?:
    | ((friendshipId: FriendshipId, displayName: string) => void)
    | undefined;
  readonly onDeclineFriendRequest?:
    | ((friendshipId: FriendshipId, displayName: string) => void)
    | undefined;
  readonly onRemoveFriend?: ((userId: UserId, displayName: string) => void) | undefined;
  readonly onInspectSharedAgent?: ((agent: SharedExternalAgentDto) => void) | undefined;
  readonly onLogout: () => void;
  /** 点击通讯录中的个人 Agent 时打开名片详情；缺省回退至配对面板 */
  readonly onInspectOwnedAgent?: ((agent: OwnedAgentSummaryDto) => void) | undefined;
  /** 在通讯录「我的 agent」列表中彻底删除指定个人 Agent */
  readonly onDeleteOwnedAgent?: ((agent: OwnedAgentSummaryDto) => void) | undefined;
  /** 当前正在执行删除请求的 Agent ID（用于行内按钮加载态） */
  readonly deletingAgentId?: AgentId | null | undefined;
  /** 在会话列表中触发「删除群聊 / 删除单聊」确认弹窗 */
  readonly onRequestDeleteRoom?: ((room: RoomSummaryDto) => void) | undefined;
  /** 在群聊列表中触发「退出群聊」确认弹窗（仅对群聊非群主成员展示） */
  readonly onRequestLeaveRoom?: ((room: RoomSummaryDto) => void) | undefined;
  /** 从群聊列表右键菜单快捷调整群聊治理配置（仅对群主展示） */
  readonly onUpdateRoomGovernance?:
    | ((roomId: RoomId, patch: UpdateGovernanceBody) => void)
    | undefined;
  /** 从通讯录右键菜单触发恢复原身份重连（`--reclaim`） */
  readonly onReclaimOwnedAgent?: ((agentId: AgentId) => void) | undefined;
  /** 从通讯录右键菜单唤起 Agent 名片并直接展开删除确认 */
  readonly onRequestDeleteOwnedAgent?: ((agent: OwnedAgentSummaryDto) => void) | undefined;
  /** 当前正在执行删除请求的会话 ID（用于行内按钮加载态） */
  readonly deletingRoomId?: RoomId | null | undefined;
  /** 点击搜索框内 `⌘K` 徽章时打开全局命令面板 */
  readonly onOpenCommandPalette?: (() => void) | undefined;
  /** 点击移动端管理后台入口（仅当 `currentUser.role === "admin"` 时展示） */
  readonly onOpenAdminConsole?: (() => void) | undefined;
}

const ROOM_MODE_ITEMS: ReadonlyArray<{ readonly value: GovernanceMode; readonly label: string }> = [
  { value: "free", label: "自由讨论" },
  { value: "round_table", label: "圆桌轮流" },
  { value: "proposal", label: "提案收敛" },
];

function copySidebarText(text: string, successTitle: string, description?: string): void {
  if (typeof navigator === "undefined" || !navigator.clipboard) {
    return;
  }
  void navigator.clipboard.writeText(text).then(() => {
    toast.success(successTitle, description !== undefined ? { description } : undefined);
  });
}

/**
 * 日光暖瓷 & 暗夜中性烟熏石墨协调的 6 色群聊圆角方标调色板（按 `roomId` 确定性映射）。
 */
const ROOM_MONOGRAM_PALETTE: ReadonlyArray<string> = [
  "bg-[#DCE8FC] text-[#1D3E78] dark:bg-[#222938] dark:text-[#B8D0FA]",
  "bg-[#DCF4E6] text-[#165232] dark:bg-[#1C2E24] dark:text-[#A4E8C0]",
  "bg-[#F5E8D3] text-[#5C3D18] dark:bg-[#2F271E] dark:text-[#F0D5AD]",
  "bg-[#EAE3FE] text-[#3B2A6E] dark:bg-[#282338] dark:text-[#D3C8FA]",
  "bg-[#FCE2D8] text-[#662D1B] dark:bg-[#32221F] dark:text-[#F5C2B3]",
  "bg-[#DDEFF4] text-[#1E4754] dark:bg-[#1F2B30] dark:text-[#B3DCE8]",
];

function hashString(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    // 确定性哈希仅用于 UI 色彩稳定选取，不涉及任何权限或安全判定
    hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

/**
 * 渲染温润现代的 `40px` Apple 圆角方标（Squircle）群聊首字头像（浅色采用高光白内边，杜绝脏灰框线）。
 */
function SidebarRoomAvatar(props: {
  readonly roomId: string;
  readonly name: string;
  readonly isPausedBudget: boolean;
}) {
  const paletteClass =
    ROOM_MONOGRAM_PALETTE[hashString(props.roomId) % ROOM_MONOGRAM_PALETTE.length] ??
    ROOM_MONOGRAM_PALETTE[0];
  const monogram = getInitials(props.name);

  return (
    <span
      className={cn(
        "relative inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-[12px] text-[15px] font-semibold tracking-[-0.02em] shadow-[inset_0_1px_0_rgba(255,255,255,0.75)] ring-1 ring-inset ring-white/80 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.10)] dark:ring-white/[0.08]",
        paletteClass,
      )}
    >
      <span className="leading-none">{monogram}</span>
      {props.isPausedBudget ? (
        <span
          title="连续 Agent 发言已达上限，等待你续期"
          className="absolute -right-1 -bottom-1 rounded-full bg-white p-px text-[#D97706] shadow-xs dark:bg-[#1E1E22] dark:text-[#FBBF24]"
        >
          <PauseCircle className="h-3.5 w-3.5 fill-amber-100 dark:fill-[#2E2516]" />
        </span>
      ) : null}
    </span>
  );
}

/** SSE 连接状态 → 柔和圆点与自然说明 */
function describeSse(status: SseConnectionStatus): {
  readonly dot: string;
  readonly label: string;
} {
  if (status === "live") {
    return { dot: "bg-[#16A34A] dark:bg-[#34D399]", label: "实时在线" };
  }
  if (status === "connecting" || status === "reconnecting") {
    return { dot: "animate-pulse bg-[#D97706] dark:bg-[#FBBF24]", label: "正在重连…" };
  }
  return { dot: "bg-[#CBD2DE] dark:bg-[#63636B]", label: "离线" };
}

/**
 * 渲染悬浮 Apple Liquid Glass 侧栏（顶栏用户概览 + 按需搜索框 + `聊天 | 通讯录` 胶囊分段 + 底部操作栏）。
 *
 * @param props - 房间列表、已绑定个人 Agent、用户身份、SSE 状态与交互动作回调
 * @returns 会话与通讯录液态玻璃侧栏组件
 */
export function RoomSidebar(props: RoomSidebarProps) {
  const [activeTab, setActiveTab] = useState<SidebarSectionTab>("chats");
  const [chatFilter, setChatFilter] = useState<ChatListFilter>("all");
  const [quickMenuOpen, setQuickMenuOpen] = useState<boolean>(false);
  const [searchExpanded, setSearchExpanded] = useState<boolean>(false);
  const [searchText, setSearchText] = useState<string>("");
  const sse = describeSse(props.sseStatus);

  const friends = props.friends ?? [];
  const incomingRequests = props.incomingRequests ?? [];
  const discoverableAgents = props.discoverableAgents ?? [];

  const filteredRooms = useMemo(() => {
    const q = searchText.trim().toLowerCase();
    return props.rooms.filter((r) => {
      if (chatFilter === "group" && r.kind !== "group") {
        return false;
      }
      if (chatFilter === "direct" && r.kind === "group") {
        return false;
      }
      if (q.length === 0) {
        return true;
      }
      const peerMatch =
        r.peer !== undefined &&
        (r.peer.displayName.toLowerCase().includes(q) ||
          (r.peer.kind === "human" &&
            r.peer.email !== undefined &&
            r.peer.email.toLowerCase().includes(q)) ||
          (r.peer.kind === "agent" && r.peer.ownerDisplayName.toLowerCase().includes(q)));
      return r.name.toLowerCase().includes(q) || r.topic.toLowerCase().includes(q) || peerMatch;
    });
  }, [chatFilter, props.rooms, searchText]);

  const filteredFriends = useMemo(() => {
    const q = searchText.trim().toLowerCase();
    if (q.length === 0) {
      return friends;
    }
    return friends.filter(
      (f) => f.user.displayName.toLowerCase().includes(q) || f.user.email.toLowerCase().includes(q),
    );
  }, [friends, searchText]);

  const filteredAgents = useMemo(() => {
    const q = searchText.trim().toLowerCase();
    if (q.length === 0) {
      return props.ownedAgents;
    }
    return props.ownedAgents.filter(
      (a) => a.displayName.toLowerCase().includes(q) || a.platform.toLowerCase().includes(q),
    );
  }, [props.ownedAgents, searchText]);

  const filteredDiscoverableAgents = useMemo(() => {
    const q = searchText.trim().toLowerCase();
    if (q.length === 0) {
      return discoverableAgents;
    }
    return discoverableAgents.filter(
      (a) =>
        a.displayName.toLowerCase().includes(q) ||
        a.ownerDisplayName.toLowerCase().includes(q) ||
        a.platform.toLowerCase().includes(q),
    );
  }, [discoverableAgents, searchText]);

  const totalUnread = useMemo(
    () => props.rooms.reduce((sum, r) => sum + Math.max(0, r.lastSeq - r.yourLastReadSeq), 0),
    [props.rooms],
  );

  const contactsCount = friends.length + props.ownedAgents.length;

  const tabItems: ReadonlyArray<SegmentedTabItem<SidebarSectionTab>> = useMemo(
    () => [
      {
        value: "chats",
        label: "聊天",
        ...(totalUnread > 0 ? { badge: totalUnread > 99 ? "99+" : String(totalUnread) } : {}),
      },
      {
        value: "contacts",
        label: "通讯录",
        ...(incomingRequests.length > 0
          ? { badge: `${String(incomingRequests.length)} 新` }
          : contactsCount > 0
            ? { badge: String(contactsCount) }
            : {}),
      },
    ],
    [contactsCount, incomingRequests.length, totalUnread],
  );

  const toggleSearch = (): void => {
    setSearchExpanded((prev) => {
      if (prev) {
        setSearchText("");
      }
      return !prev;
    });
  };
  const [confirmDeleteAgentId, setConfirmDeleteAgentId] = useState<AgentId | null>(null);

  return (
    <aside className="relative liquid-glass-panel flex h-full w-full shrink-0 select-none flex-col overflow-hidden pt-[env(safe-area-inset-top,0px)] md:w-[276px] md:rounded-[22px] md:pt-0 [--oh-avatar-ring:#F4F5F8] dark:[--oh-avatar-ring:#1E1E22]">
      {/* 1. 60px 顶栏（Tauri v2 + Electron 双端可拖拽区）：本人头像 + 昵称 + 实时状态 + 快捷新建菜单与搜索 */}
      <div
        data-tauri-drag-region=""
        className="app-drag-region flex h-[60px] shrink-0 items-center justify-between gap-2 px-3.5"
      >
        <div className="flex min-w-0 items-center gap-2.5">
          <PlatformAvatar
            kind="human"
            displayName={props.currentUser.displayName}
            size="sm"
            className="[&>div]:h-8 [&>div]:w-8 [&>div]:rounded-full [&>div]:text-[13px]"
          />
          <div className="min-w-0 leading-tight">
            <h2 className="truncate text-[14px] font-semibold tracking-[-0.01em] text-[#111318] dark:text-[#F2F2F4]">
              {props.currentUser.displayName}
            </h2>
            <AppTooltip side="bottom" content={`实时通道：${sse.label}`}>
              <p className="app-no-drag mt-0.5 inline-flex cursor-default items-center gap-1.5 text-[11px] text-[#687082] dark:text-[#8E8E96]">
                <span className={cn("h-1.5 w-1.5 rounded-full", sse.dot)} />
                <span>{sse.label}</span>
              </p>
            </AppTooltip>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
          <div className="app-no-drag md:hidden">
            <ThemeToggle variant="ghost" />
          </div>
          <AppPopover
            open={quickMenuOpen}
            onOpenChange={setQuickMenuOpen}
            side="bottom"
            align="end"
            className="w-44 space-y-0.5 p-1.5 text-xs"
            trigger={
              <IconButton
                size="sm"
                variant={quickMenuOpen ? "soft" : "ghost"}
                label="发起聊天或添加好友"
              >
                <Plus className="h-4 w-4" />
              </IconButton>
            }
          >
            <button
              type="button"
              onClick={() => {
                setQuickMenuOpen(false);
                props.onOpenCreateRoom();
              }}
              className="flex w-full cursor-pointer items-center gap-2 rounded-xl px-2.5 py-2 text-left font-medium text-[#111318] transition hover:bg-black/[0.05] dark:text-[#F2F2F4] dark:hover:bg-white/[0.08]"
            >
              <Users className="h-3.5 w-3.5 text-[#687082] dark:text-[#9B9BA3]" />
              <span>发起群聊</span>
            </button>
            {props.onOpenAddFriend !== undefined ? (
              <button
                type="button"
                onClick={() => {
                  setQuickMenuOpen(false);
                  props.onOpenAddFriend?.();
                }}
                className="flex w-full cursor-pointer items-center gap-2 rounded-xl px-2.5 py-2 text-left font-medium text-[#111318] transition hover:bg-black/[0.05] dark:text-[#F2F2F4] dark:hover:bg-white/[0.08]"
              >
                <UserPlus className="h-3.5 w-3.5 text-[#687082] dark:text-[#9B9BA3]" />
                <span>添加好友</span>
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => {
                setQuickMenuOpen(false);
                props.onOpenMyAgents();
              }}
              className="flex w-full cursor-pointer items-center gap-2 rounded-xl px-2.5 py-2 text-left font-medium text-[#111318] transition hover:bg-black/[0.05] dark:text-[#F2F2F4] dark:hover:bg-white/[0.08]"
            >
              <Bot className="h-3.5 w-3.5 text-[#687082] dark:text-[#9B9BA3]" />
              <span>接入个人 Agent</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setQuickMenuOpen(false);
                props.onOpenJoinRoom();
              }}
              className="flex w-full cursor-pointer items-center gap-2 rounded-xl px-2.5 py-2 text-left font-medium text-[#111318] transition hover:bg-black/[0.05] dark:text-[#F2F2F4] dark:hover:bg-white/[0.08]"
            >
              <LogIn className="h-3.5 w-3.5 text-[#687082] dark:text-[#9B9BA3]" />
              <span>凭邀请码进群</span>
            </button>
          </AppPopover>

          <AppTooltip
            side="bottom"
            content={searchExpanded ? "收起筛选" : "搜索会话、好友或 Agent"}
          >
            <IconButton
              size="sm"
              variant={searchExpanded ? "soft" : "ghost"}
              label={searchExpanded ? "收起搜索" : "展开搜索"}
              aria-expanded={searchExpanded}
              onClick={toggleSearch}
            >
              {searchExpanded ? <X className="h-4 w-4" /> : <Search className="h-4 w-4" />}
            </IconButton>
          </AppTooltip>
        </div>
      </div>

      {/* 2. 按需平滑展开的筛选框（严格对齐 12px 垂直基准线） */}
      <AnimatePresence initial={false}>
        {searchExpanded ? (
          <motion.div
            key="sidebar-search-drawer"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.16, ease: "easeOut" }}
            className="overflow-hidden px-3"
          >
            <div className="pb-2.5">
              <AppInput
                size="sm"
                type="text"
                autoFocus={true}
                value={searchText}
                onChange={(e) => setSearchText(e.target.value)}
                aria-label={activeTab === "chats" ? "搜索会话" : "搜索好友或 Agent"}
                placeholder={
                  activeTab === "chats" ? "搜索群聊或单聊对象…" : "搜索好友昵称或我的 Agent…"
                }
                leadingIcon={<Search className="h-3.5 w-3.5" />}
                trailingSlot={
                  searchText.length > 0 ? (
                    <button
                      type="button"
                      aria-label="清空搜索"
                      onClick={() => setSearchText("")}
                      className="inline-flex h-5 w-5 cursor-pointer items-center justify-center rounded-full text-[#8E96A6] transition hover:bg-black/[0.06] hover:text-[#111318] dark:hover:bg-white/10 dark:hover:text-[#F2F2F4]"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  ) : props.onOpenCommandPalette !== undefined ? (
                    <button
                      type="button"
                      onClick={props.onOpenCommandPalette}
                      aria-label="打开全局命令面板 (⌘K)"
                      className="inline-flex cursor-pointer items-center rounded-md bg-black/[0.05] px-1.5 py-0.5 font-mono text-[10px] font-medium text-[#687082] transition hover:bg-black/[0.09] hover:text-[#111318] dark:bg-white/[0.08] dark:text-[#8E8E96] dark:hover:text-[#F2F2F4]"
                    >
                      ⌘K
                    </button>
                  ) : undefined
                }
              />
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      {/* 3. `聊天 | 通讯录` 全胶囊分段滑块（与下方列表卡片左右严格同宽对齐） */}
      <div className="shrink-0 px-3 pb-2">
        <SegmentedTabs
          value={activeTab}
          onValueChange={setActiveTab}
          items={tabItems}
          size="md"
          fullWidth={true}
          ariaLabel="切换聊天与通讯录"
        />
      </div>

      {/* 4. 主列表滚动区 */}
      {activeTab === "chats" ? (
        <nav aria-label="会话列表" className="flex-1 overflow-y-auto px-3 pb-3">
          {props.rooms.length > 0 ? (
            <div className="mb-2 flex items-center gap-1 px-0.5">
              {(
                [
                  { id: "all", label: "全部" },
                  { id: "group", label: "群聊" },
                  { id: "direct", label: "单聊" },
                ] as const
              ).map((pill) => {
                const selected = chatFilter === pill.id;
                return (
                  <button
                    key={pill.id}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => setChatFilter(pill.id)}
                    className={cn(
                      "cursor-pointer rounded-full px-2.5 py-0.5 text-[11px] font-medium transition-colors",
                      selected
                        ? "bg-[#181B22] text-white dark:bg-[#EAEEF6] dark:text-[#111318]"
                        : "text-[#687082] hover:bg-black/[0.045] hover:text-[#111318] dark:text-[#8E8E96] dark:hover:bg-white/[0.07] dark:hover:text-[#F2F2F4]",
                    )}
                  >
                    {pill.label}
                  </button>
                );
              })}
            </div>
          ) : null}

          {props.isLoadingRooms ? (
            <div className="space-y-1.5 px-1 py-1">
              {[1, 2, 3].map((skeletonId) => (
                <div
                  key={`room-sk-${String(skeletonId)}`}
                  className="flex items-center gap-3 rounded-2xl px-3 py-2.5"
                >
                  <div className="h-10 w-10 animate-pulse rounded-[13px] bg-black/[0.06] dark:bg-white/[0.06]" />
                  <div className="flex-1 space-y-1.5">
                    <div className="h-3.5 w-2/3 animate-pulse rounded bg-black/[0.06] dark:bg-white/[0.06]" />
                    <div className="h-2.5 w-1/2 animate-pulse rounded bg-black/[0.04] dark:bg-white/[0.04]" />
                  </div>
                </div>
              ))}
            </div>
          ) : props.isRoomsError ? (
            <div className="mx-1 rounded-2xl bg-[#E5484D]/10 p-3.5 text-xs text-[#C81E1E] dark:bg-[#F05252]/15 dark:text-[#FCA5A5]">
              <div className="flex items-center gap-1.5 font-semibold">
                <AlertCircle className="h-3.5 w-3.5" />
                <span>会话列表加载失败</span>
              </div>
              <AppButton
                variant="danger"
                size="xs"
                onClick={props.onRetryRooms}
                leadingIcon={<RefreshCw className="h-3 w-3" />}
                className="mt-2.5"
              >
                重试
              </AppButton>
            </div>
          ) : props.rooms.length === 0 ? (
            <div className="mx-1 my-2 rounded-2xl bg-black/[0.035] px-4 py-6 text-center ring-1 ring-inset ring-black/[0.04] dark:bg-white/[0.04] dark:ring-white/[0.06]">
              <p className="text-[13px] font-semibold text-[#111318] dark:text-[#F2F2F4]">
                还没有聊天会话
              </p>
              <p className="mt-1 text-[12px] leading-relaxed text-[#687082] dark:text-[#8E8E96]">
                支持与你的个人 Agent 开启 1v1 单聊、加好友私聊，或建群拉大家一起讨论。
              </p>
            </div>
          ) : filteredRooms.length === 0 ? (
            <p className="px-3 py-6 text-center text-xs text-[#8E96A6] dark:text-[#63636B]">
              {searchText.trim().length > 0
                ? `没有找到匹配「${searchText}」的会话`
                : chatFilter === "direct"
                  ? "暂无 1v1 单聊会话，去「通讯录」点击好友或 Agent 即可发起"
                  : "暂无群聊会话"}
            </p>
          ) : (
            <ul className="space-y-1">
              {filteredRooms.map((room) => {
                const isActive = props.activeRoomId === room.id;
                const isGroup = room.kind === "group";
                const unreadCount = Math.max(0, room.lastSeq - room.yourLastReadSeq);
                const isPausedBudget = room.governance.status === "paused_budget";
                const isRoomOwner = room.ownerUserId === props.currentUser.id;
                const canDeleteRoom =
                  (room.kind === "direct_human" || isRoomOwner) &&
                  props.onRequestDeleteRoom !== undefined;
                const isDeletingThis = props.deletingRoomId === room.id;
                const deleteLabel = isGroup ? "删除群聊" : "删除单聊会话";

                const subtitleText = (() => {
                  if (isPausedBudget) {
                    return `等待续期${room.topic.length > 0 ? ` · ${room.topic}` : ""}`;
                  }
                  if (room.kind === "direct_agent") {
                    if (room.peer?.kind === "agent") {
                      const reachLabel = getReachVisualMeta(room.peer.reach).shortLabel;
                      return room.peer.ownerUserId === props.currentUser.id
                        ? `我的 Agent · ${reachLabel}`
                        : `${room.peer.ownerDisplayName} 的 Agent · ${reachLabel}`;
                    }
                    return "Agent 单聊";
                  }
                  if (room.kind === "direct_human") {
                    return room.peer?.kind === "human" &&
                      room.peer.email !== undefined &&
                      room.peer.email.length > 0
                      ? `好友私聊 · ${room.peer.email}`
                      : "好友私聊";
                  }
                  if (room.topic.length > 0) {
                    return room.topic;
                  }
                  return room.visibility === "public_shareable" ? "公开只读可分享" : "仅限邀请加入";
                })();

                const roomMenuItems: ReadonlyArray<AppContextMenuEntry> = [
                  {
                    id: `ctx-room-open-${room.id}`,
                    label: isGroup ? "打开群聊" : "打开会话",
                    icon: <MessageCircle className="h-3.5 w-3.5" />,
                    onSelect: () => props.onSelectRoom(room.id),
                  },
                  {
                    id: `ctx-room-newtab-${room.id}`,
                    label: "在新标签页打开",
                    icon: <ExternalLink className="h-3.5 w-3.5" />,
                    onSelect: () => {
                      if (typeof window !== "undefined") {
                        window.open(
                          `/?room=${encodeURIComponent(room.id)}`,
                          "_blank",
                          "noopener,noreferrer",
                        );
                      }
                    },
                  },
                  {
                    id: `ctx-room-copylink-${room.id}`,
                    label: isGroup ? "复制群聊链接" : "复制会话链接",
                    icon: <Link2 className="h-3.5 w-3.5" />,
                    onSelect: () => {
                      if (typeof window !== "undefined") {
                        copySidebarText(
                          `${window.location.origin}/?room=${encodeURIComponent(room.id)}`,
                          "已复制会话链接",
                          room.name,
                        );
                      }
                    },
                  },
                  ...(isRoomOwner &&
                  props.onUpdateRoomGovernance !== undefined &&
                  (isGroup || isPausedBudget)
                    ? [
                        { kind: "separator" as const, id: `ctx-room-sep-gov-${room.id}` },
                        ...(isPausedBudget
                          ? [
                              {
                                id: `ctx-room-renew-${room.id}`,
                                label: "继续讨论（续期轮次）",
                                icon: <Play className="h-3.5 w-3.5" />,
                                onSelect: () =>
                                  props.onUpdateRoomGovernance?.(room.id, { renewBudget: true }),
                              } satisfies AppContextMenuEntry,
                            ]
                          : []),
                        ...(isGroup
                          ? [
                              {
                                kind: "submenu" as const,
                                id: `ctx-room-mode-${room.id}`,
                                label: "讨论节奏",
                                icon: <SlidersHorizontal className="h-3.5 w-3.5" />,
                                items: ROOM_MODE_ITEMS.map((opt) => ({
                                  id: `ctx-room-mode-${room.id}-${opt.value}`,
                                  label: opt.label,
                                  icon:
                                    room.governance.config.mode === opt.value ? (
                                      <Check className="h-3.5 w-3.5" />
                                    ) : (
                                      <span className="inline-block h-3.5 w-3.5" />
                                    ),
                                  onSelect: () => {
                                    if (room.governance.config.mode !== opt.value) {
                                      props.onUpdateRoomGovernance?.(room.id, { mode: opt.value });
                                    }
                                  },
                                })),
                              } satisfies AppContextMenuEntry,
                              {
                                id: `ctx-room-mentions-${room.id}`,
                                label: room.governance.config.allowAgentMentions
                                  ? "关闭 Agent 互相 @"
                                  : "允许 Agent 互相 @",
                                icon: room.governance.config.allowAgentMentions ? (
                                  <ShieldAlert className="h-3.5 w-3.5" />
                                ) : (
                                  <AtSign className="h-3.5 w-3.5" />
                                ),
                                onSelect: () =>
                                  props.onUpdateRoomGovernance?.(room.id, {
                                    allowAgentMentions: !room.governance.config.allowAgentMentions,
                                  }),
                              } satisfies AppContextMenuEntry,
                            ]
                          : []),
                      ]
                    : []),
                  ...(canDeleteRoom ||
                  (isGroup && !isRoomOwner && props.onRequestLeaveRoom !== undefined)
                    ? [{ kind: "separator" as const, id: `ctx-room-sep-danger-${room.id}` }]
                    : []),
                  ...(canDeleteRoom
                    ? [
                        {
                          id: `ctx-room-delete-${room.id}`,
                          label: deleteLabel,
                          icon: <Trash2 className="h-3.5 w-3.5" />,
                          danger: true,
                          onSelect: () => props.onRequestDeleteRoom?.(room),
                        } satisfies AppContextMenuEntry,
                      ]
                    : isGroup && !isRoomOwner && props.onRequestLeaveRoom !== undefined
                      ? [
                          {
                            id: `ctx-room-leave-${room.id}`,
                            label: "退出群聊",
                            icon: <LogOut className="h-3.5 w-3.5" />,
                            danger: true,
                            onSelect: () => props.onRequestLeaveRoom?.(room),
                          } satisfies AppContextMenuEntry,
                        ]
                      : []),
                ];

                return (
                  <li key={room.id} className="relative">
                    <AppContextMenu items={roomMenuItems}>
                      <div
                        className={cn(
                          "group relative z-0 flex items-center gap-1 rounded-[16px] transition-colors duration-150",
                          "data-[state=open]:bg-white/75 dark:data-[state=open]:bg-white/[0.08]",
                          canDeleteRoom && "pr-1.5",
                          !isActive && "hover:bg-white/60 dark:hover:bg-white/[0.045]",
                        )}
                      >
                        {/* 液态弹簧滑动选中底衬：纯白高光柔影（暗夜烟熏微光），彻底剔除深灰外圈描边 */}
                        {isActive ? (
                          <motion.span
                            layoutId="oh-sidebar-active-room"
                            aria-hidden="true"
                            transition={{ type: "spring", stiffness: 520, damping: 38 }}
                            className="pointer-events-none absolute inset-0 -z-10 rounded-[16px] bg-white/95 shadow-[0_3px_12px_-3px_rgba(15,23,42,0.06),0_1px_2px_rgba(15,23,42,0.025),inset_0_1px_0_#FFFFFF] dark:bg-white/[0.095] dark:shadow-[0_4px_14px_-4px_rgba(0,0,0,0.36),inset_0_1px_0_rgba(255,255,255,0.11)]"
                          />
                        ) : null}

                        <button
                          type="button"
                          onClick={() => props.onSelectRoom(room.id)}
                          aria-current={isActive ? "page" : undefined}
                          className={cn(
                            "flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-[16px] py-2.5 pl-2.5 text-left transition-transform duration-150 active:scale-[0.99]",
                            canDeleteRoom ? "pr-1" : "pr-2.5",
                          )}
                        >
                          {room.kind === "direct_agent" ? (
                            <PlatformAvatar
                              kind="agent"
                              displayName={room.peer?.displayName ?? room.name}
                              platform={
                                room.peer?.kind === "agent" ? room.peer.platform : undefined
                              }
                              reach={room.peer?.kind === "agent" ? room.peer.reach : undefined}
                              size="md"
                              className="[&>div]:rounded-full"
                            />
                          ) : room.kind === "direct_human" ? (
                            <PlatformAvatar
                              kind="human"
                              displayName={room.peer?.displayName ?? room.name}
                              size="md"
                              className="[&>div]:rounded-full"
                            />
                          ) : (
                            <SidebarRoomAvatar
                              roomId={room.id}
                              name={room.name}
                              isPausedBudget={isPausedBudget}
                            />
                          )}

                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[13.5px] font-semibold tracking-[-0.01em] text-[#111318] dark:text-[#F2F2F4]">
                              {room.name}
                            </span>
                            <span
                              className={cn(
                                "mt-0.5 block truncate text-[12px]",
                                isPausedBudget
                                  ? "font-medium text-[#9A6700] dark:text-[#FCD34D]"
                                  : isActive
                                    ? "text-[#4B5565] dark:text-[#B4B4BC]"
                                    : "text-[#687082] dark:text-[#8E8E96]",
                              )}
                            >
                              {subtitleText}
                            </span>
                          </span>

                          {unreadCount > 0 ? (
                            <span
                              aria-label={`${unreadCount} 条未读消息`}
                              className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-[#E5484D] px-1.5 text-[11px] font-semibold tabular-nums text-white dark:bg-[#F05252]"
                            >
                              {unreadCount > 99 ? "99+" : unreadCount}
                            </span>
                          ) : null}
                        </button>

                        {canDeleteRoom ? (
                          <AppTooltip side="top" content={deleteLabel}>
                            <IconButton
                              size="xs"
                              variant="ghost"
                              isLoading={isDeletingThis}
                              label={`${deleteLabel} ${room.name}`}
                              onClick={(event) => {
                                event.stopPropagation();
                                props.onRequestDeleteRoom?.(room);
                              }}
                              className={cn(
                                "shrink-0 text-[#8E96A6] transition hover:bg-[#E5484D]/10 hover:text-[#E5484D] dark:text-[#63636B] dark:hover:bg-[#F05252]/15 dark:hover:text-[#F87171]",
                                isDeletingThis
                                  ? "opacity-100"
                                  : "opacity-100 md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100",
                              )}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </IconButton>
                          </AppTooltip>
                        ) : null}
                      </div>
                    </AppContextMenu>
                  </li>
                );
              })}
            </ul>
          )}
        </nav>
      ) : (
        /* 通讯录分栏：新的朋友 + 我的好友 + 我的 Agent + 开放私聊的外部 Agent */
        <div
          aria-label="好友与 Agent 通讯录"
          className="flex-1 space-y-4 overflow-y-auto px-3 pb-3"
        >
          {/* A. 新的朋友（收到的待处理申请） */}
          {incomingRequests.length > 0 ? (
            <section className="space-y-1.5">
              <div className="flex items-center justify-between px-2">
                <span className="text-[11.5px] font-semibold text-[#E5484D] dark:text-[#F87171]">
                  新的朋友 · {incomingRequests.length}
                </span>
              </div>
              <ul className="space-y-1">
                {incomingRequests.map((req) => (
                  <li
                    key={req.friendshipId}
                    className="flex items-center justify-between gap-2 rounded-[16px] bg-white/75 p-2.5 ring-1 ring-inset ring-black/[0.05] dark:bg-white/[0.06] dark:ring-white/[0.08]"
                  >
                    <div className="flex min-w-0 items-center gap-2.5">
                      <PlatformAvatar
                        kind="human"
                        displayName={req.peer.displayName}
                        size="sm"
                        className="[&>div]:rounded-full"
                      />
                      <div className="min-w-0">
                        <p className="truncate text-[13px] font-semibold text-[#111318] dark:text-[#F2F2F4]">
                          {req.peer.displayName}
                        </p>
                        <p className="truncate text-[11px] text-[#687082] dark:text-[#8E8E96]">
                          {req.note !== undefined ? req.note : req.peer.email}
                        </p>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      {props.onDeclineFriendRequest !== undefined ? (
                        <AppButton
                          variant="ghost"
                          size="xs"
                          onClick={() =>
                            props.onDeclineFriendRequest?.(req.friendshipId, req.peer.displayName)
                          }
                        >
                          忽略
                        </AppButton>
                      ) : null}
                      {props.onAcceptFriendRequest !== undefined ? (
                        <AppButton
                          variant="primary"
                          size="xs"
                          leadingIcon={<UserCheck className="h-3 w-3" />}
                          onClick={() =>
                            props.onAcceptFriendRequest?.(req.friendshipId, req.peer.displayName)
                          }
                        >
                          同意
                        </AppButton>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {/* B. 我的好友 */}
          <section className="space-y-1">
            <div className="flex items-center justify-between px-2 pb-0.5">
              <span className="text-[11.5px] font-medium text-[#687082] dark:text-[#8E8E96]">
                我的好友 · {friends.length}
              </span>
              {props.onOpenAddFriend !== undefined ? (
                <button
                  type="button"
                  onClick={props.onOpenAddFriend}
                  className="cursor-pointer text-[11px] font-medium text-[#2563EB] hover:underline dark:text-[#60A5FA]"
                >
                  + 添加
                </button>
              ) : null}
            </div>

            {friends.length === 0 ? (
              <div className="mx-1 rounded-2xl bg-black/[0.03] px-3.5 py-3.5 text-center ring-1 ring-inset ring-black/[0.04] dark:bg-white/[0.035] dark:ring-white/[0.06]">
                <p className="text-[12px] text-[#687082] dark:text-[#8E8E96]">
                  添加站内同伴为好友，即可直接 1v1 私聊或一键拉进群聊
                </p>
              </div>
            ) : filteredFriends.length === 0 ? (
              <p className="px-3 py-2 text-center text-xs text-[#8E96A6] dark:text-[#63636B]">
                没有匹配的好友
              </p>
            ) : (
              <ul className="space-y-1">
                {filteredFriends.map((friend) => {
                  const u = friend.user;
                  const friendMenuItems: ReadonlyArray<AppContextMenuEntry> = [
                    ...(props.onStartDirectHumanChat !== undefined
                      ? [
                          {
                            id: `ctx-frd-dm-${u.userId}`,
                            label: "发私聊消息",
                            icon: <MessageCircle className="h-3.5 w-3.5" />,
                            onSelect: () => props.onStartDirectHumanChat?.(u.userId),
                          } satisfies AppContextMenuEntry,
                        ]
                      : []),
                    {
                      id: `ctx-frd-copy-${u.userId}`,
                      label: "复制邮箱",
                      icon: <Copy className="h-3.5 w-3.5" />,
                      onSelect: () => copySidebarText(u.email, "已复制好友邮箱", u.email),
                    },
                    ...(props.onRemoveFriend !== undefined
                      ? [
                          { kind: "separator" as const, id: `ctx-frd-sep-${u.userId}` },
                          {
                            id: `ctx-frd-remove-${u.userId}`,
                            label: "解除好友关系",
                            icon: <UserMinus className="h-3.5 w-3.5" />,
                            danger: true,
                            onSelect: () => props.onRemoveFriend?.(u.userId, u.displayName),
                          } satisfies AppContextMenuEntry,
                        ]
                      : []),
                  ];

                  return (
                    <li key={friend.friendshipId}>
                      <AppContextMenu items={friendMenuItems}>
                        <div className="group flex items-center gap-1.5 rounded-[16px] pr-2 transition-colors hover:bg-white/60 data-[state=open]:bg-white/75 dark:hover:bg-white/[0.045] dark:data-[state=open]:bg-white/[0.08]">
                          <button
                            type="button"
                            onClick={() => props.onStartDirectHumanChat?.(u.userId)}
                            className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-[16px] py-2 pl-2.5 pr-1 text-left active:scale-[0.99]"
                          >
                            <PlatformAvatar
                              kind="human"
                              displayName={u.displayName}
                              size="md"
                              className="[&>div]:rounded-full"
                            />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-[13.5px] font-semibold text-[#111318] dark:text-[#F2F2F4]">
                                {u.displayName}
                              </span>
                              <span className="mt-0.5 block truncate text-[11.5px] text-[#687082] dark:text-[#8E8E96]">
                                {u.email}
                              </span>
                            </span>
                          </button>

                          {props.onStartDirectHumanChat !== undefined ? (
                            <AppTooltip side="top" content="发起 1v1 私聊">
                              <IconButton
                                size="xs"
                                variant="ghost"
                                label={`给 ${u.displayName} 发私聊`}
                                onClick={() => props.onStartDirectHumanChat?.(u.userId)}
                                className="shrink-0 text-[#687082] opacity-100 transition hover:text-[#111318] md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100 dark:text-[#8E8E96] dark:hover:text-[#F2F2F4]"
                              >
                                <MessageCircle className="h-3.5 w-3.5" />
                              </IconButton>
                            </AppTooltip>
                          ) : null}
                        </div>
                      </AppContextMenu>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {/* C. 我的个人 Agent */}
          <section className="space-y-1">
            <div className="px-2 pb-0.5 text-[11.5px] font-medium text-[#687082] dark:text-[#8E8E96]">
              我的 agent · {props.ownedAgents.length}
            </div>

            {props.ownedAgents.length === 0 ? (
              <div className="mx-1 rounded-2xl bg-black/[0.03] px-3.5 py-4 text-center ring-1 ring-inset ring-black/[0.04] dark:bg-white/[0.035] dark:ring-white/[0.06]">
                <p className="text-[12.5px] font-semibold text-[#111318] dark:text-[#F2F2F4]">
                  还没有已接入的 agent
                </p>
                <p className="mt-1 text-[11.5px] leading-relaxed text-[#687082] dark:text-[#8E8E96]">
                  把你的 Claude Code、Codex 或 Cursor 接入进来，支持随时 1v1 单聊或拉进群聊。
                </p>
              </div>
            ) : filteredAgents.length === 0 ? (
              <p className="px-3 py-2 text-center text-xs text-[#8E96A6] dark:text-[#63636B]">
                没有匹配的个人 agent
              </p>
            ) : (
              <ul className="space-y-1">
                {filteredAgents.map((agent) => {
                  const platformMeta = getPlatformVisualMeta(agent.platform);
                  const reachMeta = getReachVisualMeta(agent.reach);
                  const isConfirming = confirmDeleteAgentId === agent.id;
                  const isDeletingThis = props.deletingAgentId === agent.id;
                  const agentHandle = `@${agent.slug}`;
                  const canDeleteAgent =
                    props.onRequestDeleteOwnedAgent !== undefined ||
                    props.onDeleteOwnedAgent !== undefined;
                  const agentMenuItems: ReadonlyArray<AppContextMenuEntry> = [
                    ...(props.onStartDirectAgentChat !== undefined
                      ? [
                          {
                            id: `ctx-agt-dm-${agent.id}`,
                            label: "发消息（1v1 单聊）",
                            icon: <MessageCircle className="h-3.5 w-3.5" />,
                            onSelect: () => props.onStartDirectAgentChat?.(agent.id),
                          } satisfies AppContextMenuEntry,
                        ]
                      : []),
                    {
                      id: `ctx-agt-inspect-${agent.id}`,
                      label: "查看 Agent 名片与私聊设置",
                      icon: <UserRound className="h-3.5 w-3.5" />,
                      onSelect: () => {
                        setConfirmDeleteAgentId(null);
                        if (props.onInspectOwnedAgent !== undefined) {
                          props.onInspectOwnedAgent(agent);
                        } else {
                          props.onOpenMyAgents();
                        }
                      },
                    },
                    {
                      id: `ctx-agt-copy-${agent.id}`,
                      label: `复制 ${agentHandle}`,
                      icon: <Copy className="h-3.5 w-3.5" />,
                      onSelect: () => copySidebarText(agentHandle, "已复制提及标识", agentHandle),
                    },
                    ...(props.onReclaimOwnedAgent !== undefined
                      ? [
                          {
                            id: `ctx-agt-reclaim-${agent.id}`,
                            label: "恢复原身份重连",
                            icon: <KeyRound className="h-3.5 w-3.5" />,
                            onSelect: () => props.onReclaimOwnedAgent?.(agent.id),
                          } satisfies AppContextMenuEntry,
                        ]
                      : []),
                    { kind: "separator", id: `ctx-agt-sep-danger-${agent.id}` },
                    ...(canDeleteAgent
                      ? [
                          {
                            id: `ctx-agt-delete-${agent.id}`,
                            label: "删除该 Agent",
                            icon: <Trash2 className="h-3.5 w-3.5" />,
                            danger: true,
                            disabled: isDeletingThis,
                            onSelect: () => {
                              if (props.onRequestDeleteOwnedAgent !== undefined) {
                                props.onRequestDeleteOwnedAgent(agent);
                              } else {
                                setConfirmDeleteAgentId(agent.id);
                              }
                            },
                          } satisfies AppContextMenuEntry,
                        ]
                      : []),
                  ];

                  return (
                    <li key={agent.id}>
                      <AppContextMenu items={agentMenuItems}>
                        <div className="group flex items-center gap-1 rounded-[16px] pr-2 transition-colors hover:bg-white/60 data-[state=open]:bg-white/75 dark:hover:bg-white/[0.045] dark:data-[state=open]:bg-white/[0.08]">
                          <button
                            type="button"
                            onClick={() => {
                              setConfirmDeleteAgentId(null);
                              if (props.onInspectOwnedAgent !== undefined) {
                                props.onInspectOwnedAgent(agent);
                              } else {
                                props.onOpenMyAgents();
                              }
                            }}
                            className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-[16px] py-2 pl-2.5 pr-1 text-left active:scale-[0.99]"
                          >
                            <PlatformAvatar
                              kind="agent"
                              displayName={agent.displayName}
                              platform={agent.platform}
                              reach={agent.reach}
                              size="md"
                              className="[&>div]:rounded-full"
                            />
                            <span className="min-w-0 flex-1">
                              <span className="flex items-center gap-1.5">
                                <span className="truncate text-[13.5px] font-semibold text-[#111318] dark:text-[#F2F2F4]">
                                  {agent.displayName}
                                </span>
                                {agent.allowExternalDm ? (
                                  <span
                                    title="已开放站内其他用户 1v1 私聊"
                                    className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-[#E6F5EC] px-1.5 py-0.2 text-[10px] font-medium text-[#145335] dark:bg-[#1B2B23] dark:text-[#6EE7B7]"
                                  >
                                    <Globe className="h-2.5 w-2.5" />
                                    公开
                                  </span>
                                ) : null}
                              </span>
                              <span className="mt-0.5 flex items-center gap-1.5 text-[11.5px] text-[#687082] dark:text-[#8E8E96]">
                                <span
                                  className={cn(
                                    "h-1.5 w-1.5 shrink-0 rounded-full",
                                    reachMeta.dotClass,
                                  )}
                                />
                                <span className="truncate">
                                  {platformMeta.label} · {reachMeta.shortLabel}
                                </span>
                              </span>
                            </span>
                          </button>

                          {!isConfirming && props.onStartDirectAgentChat !== undefined ? (
                            <AppTooltip side="top" content="1v1 单聊">
                              <IconButton
                                size="xs"
                                variant="ghost"
                                label={`单聊 ${agent.displayName}`}
                                onClick={() => props.onStartDirectAgentChat?.(agent.id)}
                                className="shrink-0 text-[#687082] opacity-100 transition hover:text-[#111318] md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100 dark:text-[#8E8E96] dark:hover:text-[#F2F2F4]"
                              >
                                <MessageCircle className="h-3.5 w-3.5" />
                              </IconButton>
                            </AppTooltip>
                          ) : null}

                          {props.onDeleteOwnedAgent !== undefined ? (
                            isConfirming ? (
                              <div className="flex shrink-0 items-center gap-1">
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
                                    props.onDeleteOwnedAgent?.(agent);
                                    setConfirmDeleteAgentId(null);
                                  }}
                                >
                                  删除
                                </AppButton>
                              </div>
                            ) : (
                              <AppTooltip side="top" content="删除该 Agent">
                                <IconButton
                                  size="xs"
                                  variant="ghost"
                                  label={`删除 ${agent.displayName}`}
                                  onClick={() => setConfirmDeleteAgentId(agent.id)}
                                  className="shrink-0 text-[#8E96A6] opacity-100 transition hover:text-[#E5484D] md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100 dark:text-[#63636B] dark:hover:text-[#F87171]"
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </IconButton>
                              </AppTooltip>
                            )
                          ) : null}
                        </div>
                      </AppContextMenu>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {/* D. 站内开放私聊的外部共享 Agent */}
          {filteredDiscoverableAgents.length > 0 ? (
            <section className="space-y-1">
              <div className="px-2 pb-0.5 text-[11.5px] font-medium text-[#687082] dark:text-[#8E8E96]">
                开放私聊的外部 agent · {filteredDiscoverableAgents.length}
              </div>
              <ul className="space-y-1">
                {filteredDiscoverableAgents.map((extAgent) => {
                  const reachMeta = getReachVisualMeta(extAgent.reach);
                  return (
                    <li key={extAgent.id}>
                      <div className="group flex items-center gap-1.5 rounded-[16px] pr-2 transition-colors hover:bg-white/60 dark:hover:bg-white/[0.045]">
                        <button
                          type="button"
                          onClick={() => {
                            if (props.onInspectSharedAgent !== undefined) {
                              props.onInspectSharedAgent(extAgent);
                            } else {
                              props.onStartDirectAgentChat?.(extAgent.id);
                            }
                          }}
                          className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-[16px] py-2 pl-2.5 pr-1 text-left active:scale-[0.99]"
                        >
                          <PlatformAvatar
                            kind="agent"
                            displayName={extAgent.displayName}
                            platform={extAgent.platform}
                            reach={extAgent.reach}
                            size="md"
                            className="[&>div]:rounded-full"
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[13.5px] font-semibold text-[#111318] dark:text-[#F2F2F4]">
                              {extAgent.displayName}
                            </span>
                            <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-[#687082] dark:text-[#8E8E96]">
                              <span
                                className={cn(
                                  "h-1.5 w-1.5 shrink-0 rounded-full",
                                  reachMeta.dotClass,
                                )}
                              />
                              <span className="truncate">
                                {extAgent.ownerDisplayName} 共享 · {reachMeta.shortLabel}
                              </span>
                            </span>
                          </span>
                        </button>

                        {props.onStartDirectAgentChat !== undefined ? (
                          <AppButton
                            variant="soft"
                            size="xs"
                            onClick={() => props.onStartDirectAgentChat?.(extAgent.id)}
                            className="h-6 shrink-0 px-2 text-[11px]"
                          >
                            私聊
                          </AppButton>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          ) : null}
        </div>
      )}

      {/* 5. 统一底部操作停靠栏（轻柔微分割，移动端自然合并接入 Agent 与退出入口） */}
      <div className="shrink-0 border-t border-black/[0.045] px-3 pt-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))] md:pb-3 dark:border-white/[0.06]">
        {activeTab === "chats" ? (
          <div className="flex items-center gap-1.5">
            <AppButton
              variant="primary"
              size="sm"
              leadingIcon={<Plus className="h-3.5 w-3.5" />}
              onClick={props.onOpenCreateRoom}
              className="flex-1"
            >
              建群
            </AppButton>
            {props.onOpenAddFriend !== undefined ? (
              <AppButton
                variant="secondary"
                size="sm"
                leadingIcon={<UserPlus className="h-3.5 w-3.5" />}
                onClick={props.onOpenAddFriend}
              >
                加好友
              </AppButton>
            ) : null}
            <AppTooltip side="top" content="凭邀请码进群">
              <IconButton
                size="sm"
                variant="secondary"
                label="凭邀请码进群"
                onClick={props.onOpenJoinRoom}
              >
                <LogIn className="h-3.5 w-3.5" />
              </IconButton>
            </AppTooltip>
            <AppTooltip side="top" content="接入我的 Agent">
              <IconButton
                size="sm"
                variant="secondary"
                label="接入我的 Agent"
                onClick={props.onOpenMyAgents}
                className="md:hidden"
              >
                <Bot className="h-3.5 w-3.5" />
              </IconButton>
            </AppTooltip>
            {props.currentUser.role === "admin" && props.onOpenAdminConsole !== undefined ? (
              <AppTooltip side="top" content="运营管理后台">
                <IconButton
                  size="sm"
                  variant="secondary"
                  label="打开运营管理后台"
                  onClick={props.onOpenAdminConsole}
                  className="md:hidden"
                >
                  <Shield className="h-3.5 w-3.5" />
                </IconButton>
              </AppTooltip>
            ) : null}
            <IconButton
              size="sm"
              variant="ghost"
              label="退出登录"
              onClick={props.onLogout}
              className="text-[#8E96A6] hover:text-[#E5484D] md:hidden dark:text-[#63636B] dark:hover:text-[#F87171]"
            >
              <LogOut className="h-4 w-4" />
            </IconButton>
          </div>
        ) : (
          <div className="flex items-center gap-1.5">
            {props.onOpenAddFriend !== undefined ? (
              <AppButton
                variant="primary"
                size="sm"
                leadingIcon={<UserPlus className="h-3.5 w-3.5" />}
                onClick={props.onOpenAddFriend}
                className="flex-1"
              >
                添加好友
              </AppButton>
            ) : null}
            <AppButton
              variant={props.onOpenAddFriend !== undefined ? "secondary" : "primary"}
              size="sm"
              leadingIcon={<Plus className="h-3.5 w-3.5" />}
              onClick={props.onOpenMyAgents}
              className={props.onOpenAddFriend !== undefined ? undefined : "flex-1"}
            >
              接入 agent
            </AppButton>
            {props.currentUser.role === "admin" && props.onOpenAdminConsole !== undefined ? (
              <AppTooltip side="top" content="运营管理后台">
                <IconButton
                  size="sm"
                  variant="secondary"
                  label="打开运营管理后台"
                  onClick={props.onOpenAdminConsole}
                  className="md:hidden"
                >
                  <Shield className="h-3.5 w-3.5" />
                </IconButton>
              </AppTooltip>
            ) : null}
            <IconButton
              size="sm"
              variant="ghost"
              label="退出登录"
              onClick={props.onLogout}
              className="text-[#8E96A6] hover:text-[#E5484D] md:hidden dark:text-[#63636B] dark:hover:text-[#F87171]"
            >
              <LogOut className="h-4 w-4" />
            </IconButton>
          </div>
        )}
      </div>
    </aside>
  );
}
