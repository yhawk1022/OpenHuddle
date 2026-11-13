/**
 * @module web/features/huddle-room/room-sidebar
 * @description Pachat 原生三栏工作台第 2 栏（280px 会话与通讯录侧栏，`#F8F8FA` / 暗色 `#151518`）：
 * 顶栏展示 32px 圆形用户头像、粗体昵称、`你的全部群` 副标题与按需展开的极简搜索开关；
 * 主体通过 `SegmentedTabs` 在「聊天」与「通讯录」间丝滑切换，列表底部固定 Pachat 标志性 `+ 建群` 描边胶囊按钮与 `凭邀请码加入群` 入口。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 四态完备渲染：显式区分加载骨架、失败重试、空列表引导、搜索无结果与正常会话列表。
 * 2. 反技术噪音排版：会话行仅展示 2x2 粉彩组合群头像、粗体群名、自然议题/状态副文案与珊瑚红 `#FF3B30` 未读数，严禁暴露 `#lastSeq` 等内部序号。
 * 3. 多端拖拽与安全区就绪：顶栏同时携带 `data-tauri-drag-region` 与 `.app-drag-region`；移动端（`< md`）因隐藏左侧 80px 导轨，在本栏底部补齐个人账号与退出入口。
 */
import type {
  HumanUserDto,
  OwnedAgentSummaryDto,
  RoomId,
  RoomSummaryDto,
} from "@openhuddle/protocol";
import { AlertCircle, LogOut, PauseCircle, Plus, RefreshCw, Search, X } from "lucide-react";
import { useMemo, useState } from "react";
import {
  AnimatePresence,
  AppButton,
  AppInput,
  AppTooltip,
  IconButton,
  type SegmentedTabItem,
  SegmentedTabs,
  cn,
  motion,
} from "../../../components/primitives/index.js";
import { PlatformAvatar } from "../../../components/ui/identity-badges.js";
import { ThemeToggle } from "../../../components/ui/theme-toggle.js";
import { getPlatformVisualMeta, getReachVisualMeta } from "../../../lib/format.js";
import type { SseConnectionStatus } from "../../../lib/sse-sync.js";

/** 侧栏顶部分段标签枚举：`chats` = 聊天会话，`contacts` = 我的 Agent 通讯录 */
export type SidebarSectionTab = "chats" | "contacts";

/** `RoomSidebar` 入参属性 */
export interface RoomSidebarProps {
  readonly currentUser: HumanUserDto;
  readonly ownedAgents: ReadonlyArray<OwnedAgentSummaryDto>;
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
  readonly onLogout: () => void;
  /** 点击通讯录中的个人 Agent 时打开名片详情；缺省回退至配对面板 */
  readonly onInspectOwnedAgent?: ((agent: OwnedAgentSummaryDto) => void) | undefined;
  /** 点击搜索框内 `⌘K` 徽章时打开全局命令面板 */
  readonly onOpenCommandPalette?: (() => void) | undefined;
}

/**
 * Pachat 低饱和暖色粉彩调色板：用于生成 2x2 组合群头像的迷你色块，保证同一群在任何端色彩稳定一致。
 */
const COMPOSITE_TILE_PALETTE: ReadonlyArray<string> = [
  "bg-[#F4ECDD] text-[#4A351B] dark:bg-[#2B251D] dark:text-[#EAD8BC]",
  "bg-[#E1ECFF] text-[#1E3A66] dark:bg-[#1B2433] dark:text-[#CFE1FF]",
  "bg-[#E4F4EA] text-[#1B452D] dark:bg-[#192920] dark:text-[#C7E8D3]",
  "bg-[#FFF1C2] text-[#4F3D0E] dark:bg-[#2C2718] dark:text-[#F5E4AA]",
  "bg-[#FBE3D9] text-[#572B1B] dark:bg-[#2E201B] dark:text-[#F5CEBF]",
  "bg-[#EFEAFF] text-[#352A59] dark:bg-[#242030] dark:text-[#DFD7F7]",
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
 * 从群名称提取最多 4 个短字符以填充 Pachat 风格 2x2 迷你组合群头像。
 */
function buildCompositeGlyphs(name: string): readonly [string, string, string, string] {
  const chars = Array.from(name.replace(/\s+/gu, "").trim());
  const g0 = (chars[0] ?? "群").toUpperCase();
  const g1 = (chars[1] ?? "AI").toUpperCase();
  const g2 = (chars[2] ?? "协").toUpperCase();
  const g3 = (chars[3] ?? "作").toUpperCase();
  return [g0, g1, g2, g3];
}

/**
 * 渲染 Pachat / 微信风格的 40px 圆角方形 2x2 迷你粉彩组合群头像。
 */
function SidebarRoomAvatar(props: {
  readonly roomId: string;
  readonly name: string;
  readonly isPausedBudget: boolean;
}) {
  const baseHash = hashString(props.roomId);
  const glyphs = buildCompositeGlyphs(props.name);

  return (
    <span className="relative grid h-10 w-10 shrink-0 grid-cols-2 gap-[2px] rounded-[12px] bg-[#E8E8ED] p-[3px] ring-1 ring-inset ring-black/[0.05] dark:bg-white/[0.08] dark:ring-white/[0.07]">
      {glyphs.map((glyph, idx) => {
        const paletteClass =
          COMPOSITE_TILE_PALETTE[(baseHash + idx * 2) % COMPOSITE_TILE_PALETTE.length] ??
          COMPOSITE_TILE_PALETTE[0];
        return (
          <span
            key={`${props.roomId}-tile-${String(idx)}`}
            className={cn(
              "flex items-center justify-center rounded-[4px] text-[8.5px] font-semibold leading-none",
              paletteClass,
            )}
          >
            {glyph}
          </span>
        );
      })}
      {props.isPausedBudget ? (
        <span
          title="连续 Agent 发言已达上限，等待你续期"
          className="absolute -right-1 -bottom-1 rounded-full bg-[#F8F8FA] p-px text-[#D99B26] dark:bg-[#151518] dark:text-[#E5B34B]"
        >
          <PauseCircle className="h-3.5 w-3.5 fill-[#FFF1C2] dark:fill-[#2C2718]" />
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
    return { dot: "bg-[#34C759]", label: "实时在线" };
  }
  if (status === "connecting" || status === "reconnecting") {
    return { dot: "animate-pulse bg-[#D99B26]", label: "正在重连…" };
  }
  return { dot: "bg-[#C7C7CC] dark:bg-zinc-600", label: "离线" };
}

/**
 * 渲染 Pachat 280px 侧栏（顶栏用户概览 + 按需展开搜索框 + `聊天 | 通讯录` 分段切换 + `+ 建群` 胶囊按钮）。
 *
 * @param props - 房间列表、已绑定个人 Agent、用户身份、SSE 状态与交互动作回调
 * @returns 会话与通讯录侧栏组件
 */
export function RoomSidebar(props: RoomSidebarProps) {
  const [activeTab, setActiveTab] = useState<SidebarSectionTab>("chats");
  const [searchExpanded, setSearchExpanded] = useState<boolean>(false);
  const [searchText, setSearchText] = useState<string>("");
  const sse = describeSse(props.sseStatus);

  const filteredRooms = useMemo(() => {
    const q = searchText.trim().toLowerCase();
    if (q.length === 0) {
      return props.rooms;
    }
    return props.rooms.filter(
      (r) => r.name.toLowerCase().includes(q) || r.topic.toLowerCase().includes(q),
    );
  }, [props.rooms, searchText]);

  const filteredAgents = useMemo(() => {
    const q = searchText.trim().toLowerCase();
    if (q.length === 0) {
      return props.ownedAgents;
    }
    return props.ownedAgents.filter(
      (a) => a.displayName.toLowerCase().includes(q) || a.platform.toLowerCase().includes(q),
    );
  }, [props.ownedAgents, searchText]);

  const totalUnread = useMemo(
    () => props.rooms.reduce((sum, r) => sum + Math.max(0, r.lastSeq - r.yourLastReadSeq), 0),
    [props.rooms],
  );

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
        ...(props.ownedAgents.length > 0 ? { badge: String(props.ownedAgents.length) } : {}),
      },
    ],
    [props.ownedAgents.length, totalUnread],
  );

  const toggleSearch = (): void => {
    setSearchExpanded((prev) => {
      if (prev) {
        setSearchText("");
      }
      return !prev;
    });
  };

  return (
    <aside className="glass-pane flex h-full w-full shrink-0 select-none flex-col pt-[env(safe-area-inset-top,0px)] md:w-[280px] md:pt-0">
      {/* 1. 68px 顶栏（Tauri v2 + Electron 双端可拖拽区）：32px 头像 + 粗体昵称 + 你的全部群 + 极简搜索开关 */}
      <div
        data-tauri-drag-region=""
        className="app-drag-region flex h-[68px] shrink-0 items-center justify-between gap-2 px-4"
      >
        <div className="flex min-w-0 items-center gap-2.5">
          <PlatformAvatar
            kind="human"
            displayName={props.currentUser.displayName}
            size="sm"
            className="[&>div]:h-8 [&>div]:w-8 [&>div]:rounded-full [&>div]:text-[11px]"
          />
          <div className="min-w-0 leading-tight">
            <h2 className="truncate text-[14.5px] font-semibold tracking-[-0.01em] text-[#141414] dark:text-zinc-100">
              {props.currentUser.displayName}
            </h2>
            <AppTooltip side="bottom" content={`实时通道：${sse.label}`}>
              <p className="app-no-drag mt-0.5 inline-flex cursor-default items-center gap-1.5 text-[11.5px] text-[#6E6E73] dark:text-zinc-400">
                <span className={cn("h-1.5 w-1.5 rounded-full", sse.dot)} />
                <span>你的全部群</span>
              </p>
            </AppTooltip>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <div className="app-no-drag md:hidden">
            <ThemeToggle variant="ghost" />
          </div>
          <AppTooltip side="bottom" content={searchExpanded ? "收起筛选" : "搜索群聊或 Agent"}>
            <IconButton
              size="md"
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

      {/* 2. 按需平滑展开的筛选框（默认收起，拒绝顶部堆砌重型搜索墙） */}
      <AnimatePresence initial={false}>
        {searchExpanded ? (
          <motion.div
            key="sidebar-search-drawer"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.16, ease: "easeOut" }}
            className="overflow-hidden px-3.5"
          >
            <div className="pb-2.5">
              <AppInput
                size="sm"
                type="text"
                autoFocus={true}
                value={searchText}
                onChange={(e) => setSearchText(e.target.value)}
                aria-label={activeTab === "chats" ? "搜索群聊" : "搜索我的 Agent"}
                placeholder={activeTab === "chats" ? "搜索群聊名称或话题…" : "搜索我的 Agent…"}
                leadingIcon={<Search className="h-3.5 w-3.5" />}
                trailingSlot={
                  searchText.length > 0 ? (
                    <button
                      type="button"
                      aria-label="清空搜索"
                      onClick={() => setSearchText("")}
                      className="inline-flex h-5 w-5 cursor-pointer items-center justify-center rounded-full text-[#8E8E93] transition hover:bg-black/[0.06] hover:text-[#141414] dark:hover:bg-white/10 dark:hover:text-zinc-200"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  ) : props.onOpenCommandPalette !== undefined ? (
                    <button
                      type="button"
                      onClick={props.onOpenCommandPalette}
                      aria-label="打开全局命令面板 (⌘K)"
                      className="inline-flex cursor-pointer items-center rounded-md bg-black/[0.05] px-1.5 py-0.5 font-mono text-[10px] font-medium text-[#6E6E73] transition hover:bg-black/[0.09] hover:text-[#141414] dark:bg-white/[0.08] dark:text-zinc-400 dark:hover:text-zinc-100"
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

      {/* 3. `聊天 | 通讯录` 分段滑块（Pachat `#EFEFF3` 轨道 + 纯白弹簧胶囊） */}
      <div className="shrink-0 px-3.5 pb-2.5">
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
        <nav aria-label="群聊列表" className="flex-1 overflow-y-auto px-2.5 pb-3">
          {props.isLoadingRooms ? (
            <div className="space-y-1.5 px-1 py-1">
              {[1, 2, 3].map((skeletonId) => (
                <div
                  key={`room-sk-${String(skeletonId)}`}
                  className="flex items-center gap-3 rounded-2xl px-3 py-2.5"
                >
                  <div className="h-10 w-10 animate-pulse rounded-[12px] bg-black/[0.06] dark:bg-white/[0.06]" />
                  <div className="flex-1 space-y-1.5">
                    <div className="h-3.5 w-2/3 animate-pulse rounded bg-black/[0.06] dark:bg-white/[0.06]" />
                    <div className="h-2.5 w-1/2 animate-pulse rounded bg-black/[0.04] dark:bg-white/[0.04]" />
                  </div>
                </div>
              ))}
            </div>
          ) : props.isRoomsError ? (
            <div className="mx-1 rounded-2xl bg-[#FF3B30]/10 p-3.5 text-xs text-[#D70015] dark:bg-[#FF453A]/15 dark:text-[#FF6961]">
              <div className="flex items-center gap-1.5 font-semibold">
                <AlertCircle className="h-3.5 w-3.5" />
                <span>群聊列表加载失败</span>
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
          ) : (
            <>
              {props.rooms.length === 0 ? (
                <div className="mx-1 mb-3 rounded-2xl bg-[#EFEFF3]/70 px-4 py-5 text-center dark:bg-white/[0.04]">
                  <p className="text-[13px] font-medium text-[#141414] dark:text-zinc-100">
                    还没有群聊
                  </p>
                  <p className="mt-1 text-[12px] leading-relaxed text-[#6E6E73] dark:text-zinc-400">
                    建一个群，把你的 Agent 拉进来开始聊天。
                  </p>
                </div>
              ) : filteredRooms.length === 0 ? (
                <p className="px-3 py-6 text-center text-xs text-[#8E8E93] dark:text-zinc-500">
                  没有找到匹配「{searchText}」的群聊
                </p>
              ) : (
                <ul className="space-y-1">
                  {filteredRooms.map((room) => {
                    const isActive = props.activeRoomId === room.id;
                    const unreadCount = Math.max(0, room.lastSeq - room.yourLastReadSeq);
                    const isPausedBudget = room.governance.status === "paused_budget";
                    const subtitleText = isPausedBudget
                      ? `等待续期${room.topic.length > 0 ? ` · ${room.topic}` : ""}`
                      : room.topic.length > 0
                        ? room.topic
                        : room.visibility === "public_shareable"
                          ? "公开只读可分享"
                          : "仅限邀请加入";

                    return (
                      <li key={room.id} className="relative">
                        <button
                          type="button"
                          onClick={() => props.onSelectRoom(room.id)}
                          aria-current={isActive ? "page" : undefined}
                          className={cn(
                            "relative flex w-full cursor-pointer items-center gap-3 rounded-2xl px-3 py-2.5 text-left transition-colors active:scale-[0.99]",
                            isActive
                              ? "bg-[#EFEFF3] dark:bg-white/[0.08]"
                              : "hover:bg-black/[0.035] dark:hover:bg-white/[0.04]",
                          )}
                        >
                          {/* 激活态左侧 3.5px 纯墨黑竖向胶囊指示条 */}
                          {isActive ? (
                            <span
                              aria-hidden="true"
                              className="absolute top-1/2 left-0.5 h-5 w-[3.5px] -translate-y-1/2 rounded-full bg-[#141414] dark:bg-white"
                            />
                          ) : null}

                          <SidebarRoomAvatar
                            roomId={room.id}
                            name={room.name}
                            isPausedBudget={isPausedBudget}
                          />

                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[14px] font-semibold tracking-[-0.01em] text-[#141414] dark:text-zinc-100">
                              {room.name}
                            </span>
                            <span
                              className={cn(
                                "mt-0.5 block truncate text-[12px]",
                                isPausedBudget
                                  ? "font-medium text-[#9A6700] dark:text-[#F2DF9D]"
                                  : "text-[#6E6E73] dark:text-zinc-400",
                              )}
                            >
                              {subtitleText}
                            </span>
                          </span>

                          {unreadCount > 0 ? (
                            <span className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-[#FF3B30] px-1.5 text-[11px] font-semibold tabular-nums text-white">
                              {unreadCount > 99 ? "99+" : unreadCount}
                            </span>
                          ) : null}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}

              {/* Pachat 标志性列表尾全宽 `+ 建群` 描边胶囊按钮 + 邀请码入群链接 */}
              <div className="mt-3 px-1">
                <button
                  type="button"
                  onClick={props.onOpenCreateRoom}
                  className="app-no-drag flex h-10 w-full cursor-pointer items-center justify-center gap-1.5 rounded-full border border-[#141414] bg-white text-[13.5px] font-medium text-[#141414] transition hover:bg-black/[0.03] active:scale-[0.98] dark:border-white/25 dark:bg-transparent dark:text-zinc-100 dark:hover:bg-white/[0.05]"
                >
                  <Plus className="h-4 w-4 stroke-[2]" />
                  <span>建群</span>
                </button>

                <div className="mt-2.5 text-center">
                  <button
                    type="button"
                    onClick={props.onOpenJoinRoom}
                    className="app-no-drag cursor-pointer text-[12px] text-[#6E6E73] underline-offset-4 transition hover:text-[#141414] hover:underline dark:text-zinc-400 dark:hover:text-zinc-200"
                  >
                    凭邀请码加入群
                  </button>
                </div>
              </div>
            </>
          )}
        </nav>
      ) : (
        /* 通讯录分栏：我的 Agent 列表 + `+ 接入 agent` */
        <div aria-label="我的 Agent 通讯录" className="flex-1 overflow-y-auto px-2.5 pb-3">
          <div className="px-2 pb-1.5 text-[11.5px] font-medium text-[#6E6E73] dark:text-zinc-400">
            我的 agent · {props.ownedAgents.length}
          </div>

          {props.ownedAgents.length === 0 ? (
            <div className="mx-1 mb-3 rounded-2xl bg-[#EFEFF3]/70 px-4 py-5 text-center dark:bg-white/[0.04]">
              <p className="text-[13px] font-medium text-[#141414] dark:text-zinc-100">
                还没有已接入的 agent
              </p>
              <p className="mt-1 text-[12px] leading-relaxed text-[#6E6E73] dark:text-zinc-400">
                把你的 Claude Code、Codex 或 Cursor 接入进来，随时拉进群里讨论。
              </p>
            </div>
          ) : filteredAgents.length === 0 ? (
            <p className="px-3 py-6 text-center text-xs text-[#8E8E93] dark:text-zinc-500">
              没有找到匹配「{searchText}」的 agent
            </p>
          ) : (
            <ul className="space-y-1">
              {filteredAgents.map((agent) => {
                const platformMeta = getPlatformVisualMeta(agent.platform);
                const reachMeta = getReachVisualMeta(agent.reach);
                return (
                  <li key={agent.id}>
                    <button
                      type="button"
                      onClick={() => {
                        if (props.onInspectOwnedAgent !== undefined) {
                          props.onInspectOwnedAgent(agent);
                        } else {
                          props.onOpenMyAgents();
                        }
                      }}
                      className="flex w-full cursor-pointer items-center gap-3 rounded-2xl px-3 py-2.5 text-left transition-colors hover:bg-black/[0.035] active:scale-[0.99] dark:hover:bg-white/[0.04]"
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
                        <span className="block truncate text-[13.5px] font-semibold text-[#141414] dark:text-zinc-100">
                          {agent.displayName}
                        </span>
                        <span className="mt-0.5 flex items-center gap-1.5 text-[11.5px] text-[#6E6E73] dark:text-zinc-400">
                          <span
                            className={cn("h-1.5 w-1.5 shrink-0 rounded-full", reachMeta.dotClass)}
                          />
                          <span className="truncate">
                            {platformMeta.label} · {reachMeta.shortLabel}
                          </span>
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          <div className="mt-3 px-1">
            <button
              type="button"
              onClick={props.onOpenMyAgents}
              className="app-no-drag flex h-10 w-full cursor-pointer items-center justify-center gap-1.5 rounded-full border border-dashed border-black/25 bg-white/80 text-[13px] font-medium text-[#141414] transition hover:border-[#141414] hover:bg-white active:scale-[0.98] dark:border-white/25 dark:bg-transparent dark:text-zinc-100 dark:hover:border-white/50 dark:hover:bg-white/[0.04]"
            >
              <Plus className="h-4 w-4" />
              <span>接入 agent</span>
            </button>
          </div>
        </div>
      )}

      {/* 5. 移动端底栏（桌面端由左侧 80px 导轨承载个人身份、Agent 栏与退出） */}
      <div className="flex items-center justify-between gap-2 border-t border-black/[0.06] px-3.5 pt-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))] md:hidden dark:border-white/[0.06]">
        <button
          type="button"
          onClick={props.onOpenMyAgents}
          className="inline-flex cursor-pointer items-center gap-1.5 rounded-full bg-[#EFEFF3] px-3 py-1.5 text-xs font-medium text-[#141414] dark:bg-white/[0.08] dark:text-zinc-100"
        >
          <Plus className="h-3.5 w-3.5" />
          <span>接入 agent</span>
        </button>

        <IconButton
          size="md"
          variant="ghost"
          label="退出登录"
          onClick={props.onLogout}
          className="text-[#8E8E93] hover:text-[#FF3B30]"
        >
          <LogOut className="h-4 w-4" />
        </IconButton>
      </div>
    </aside>
  );
}
