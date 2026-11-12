/**
 * @module web/features/huddle-room/room-sidebar
 * @description 三栏协作舱左侧导航栏（品牌状态灯、已加入房间列表与未读徽章、新建/入群入口及人类账号与个人 Agent 底座）。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 四态完备渲染：房间列表显式区分加载骨架、失败重试、空房间引导与正常展示四态。
 * 2. 精确未读与治理透视：直接基于 `lastSeq - yourLastReadSeq` 实时派生未读数，并在挂起预算房间旁点亮琥珀色暂停标记。
 */
import type {
  HumanUserDto,
  OwnedAgentSummaryDto,
  RoomId,
  RoomSummaryDto,
} from "@openhuddle/protocol";
import {
  AlertCircle,
  Bot,
  Globe,
  Hash,
  LogIn,
  LogOut,
  PauseCircle,
  Plus,
  RefreshCw,
  X,
} from "lucide-react";
import { BrandMark } from "../../../components/brand-mark.js";
import { PlatformAvatar } from "../../../components/ui/identity-badges.js";
import { ThemeToggle } from "../../../components/ui/theme-toggle.js";
import type { SseConnectionStatus } from "../../../lib/sse-sync.js";

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
  readonly onCloseMobileDrawer?: (() => void) | undefined;
}

function renderSseTelemetryPill(status: SseConnectionStatus) {
  if (status === "live") {
    return (
      <span
        title="SSE 实时事件流已连接"
        className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10.5px] font-semibold text-emerald-700 dark:text-emerald-300"
      >
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.9)]" />
        <span>LIVE SSE</span>
      </span>
    );
  }
  if (status === "connecting" || status === "reconnecting") {
    return (
      <span
        title="正在建立或重连实时事件流..."
        className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10.5px] font-semibold text-amber-700 dark:text-amber-300"
      >
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" />
        <span>SYNCING</span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-300 bg-slate-200/60 px-2 py-0.5 text-[10.5px] font-medium text-slate-600 dark:border-white/10 dark:bg-white/[0.05] dark:text-slate-400">
      <span className="h-1.5 w-1.5 rounded-full bg-slate-400" />
      <span>OFFLINE</span>
    </span>
  );
}

/**
 * 渲染工作台左栏房间列表与个人 Agent 管理底座。
 *
 * @param props - 房间列表、用户身份与交互动作回调
 * @returns 左侧导航栏视图
 */
export function RoomSidebar(props: RoomSidebarProps) {
  const onlineAgentCount = props.ownedAgents.filter(
    (a) => a.reach === "online_sse" || a.reach === "hosted_ready" || a.reach === "webhook",
  ).length;

  return (
    <aside className="flex h-full w-72 shrink-0 flex-col border-r border-slate-200/85 bg-slate-100/75 dark:border-white/[0.07] dark:bg-[#0c0f16]">
      {/* 1. 品牌与实时状态头 */}
      <div className="flex items-center justify-between gap-2 border-b border-slate-200/80 px-4 py-3.5 dark:border-white/[0.07]">
        <div className="flex items-center gap-2.5">
          <BrandMark className="h-8 w-8 rounded-xl shadow-xs" />
          <div>
            <div className="flex items-center gap-1.5">
              <span className="text-sm font-bold tracking-tight text-slate-900 dark:text-white">
                OpenHuddle
              </span>
            </div>
            <div className="mt-0.5">{renderSseTelemetryPill(props.sseStatus)}</div>
          </div>
        </div>

        <div className="flex items-center gap-1">
          <ThemeToggle />
          {props.onCloseMobileDrawer ? (
            <button
              type="button"
              onClick={props.onCloseMobileDrawer}
              aria-label="收起房间列表"
              className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-200/70 lg:hidden dark:text-slate-400 dark:hover:bg-white/10"
            >
              <X className="h-4 w-4" />
            </button>
          ) : null}
        </div>
      </div>

      {/* 2. 新建房间与邀请码入群双按钮 */}
      <div className="grid grid-cols-2 gap-2 px-3.5 pt-3.5 pb-2">
        <button
          type="button"
          onClick={props.onOpenCreateRoom}
          className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-indigo-600 px-3 py-2 text-xs font-semibold text-white shadow-2xs transition hover:bg-indigo-500"
        >
          <Plus className="h-3.5 w-3.5" />
          <span>新建 Huddle</span>
        </button>

        <button
          type="button"
          onClick={props.onOpenJoinRoom}
          className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-slate-200/90 bg-white px-3 py-2 text-xs font-semibold text-slate-700 shadow-2xs transition hover:bg-slate-50 dark:border-white/10 dark:bg-white/[0.04] dark:text-slate-200 dark:hover:bg-white/[0.08]"
        >
          <LogIn className="h-3.5 w-3.5" />
          <span>凭码入群</span>
        </button>
      </div>

      {/* 3. 已加入房间滚动列表（四态完备） */}
      <div className="flex-1 overflow-y-auto px-2.5 py-2">
        <div className="mb-1.5 flex items-center justify-between px-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">
          <span>Joined Huddles ({props.rooms.length})</span>
        </div>

        {props.isLoadingRooms ? (
          <div className="space-y-2 px-1 py-2">
            {[1, 2, 3].map((skeletonId) => (
              <div
                key={`room-sk-${String(skeletonId)}`}
                className="h-14 animate-pulse rounded-xl bg-slate-200/70 dark:bg-white/[0.04]"
              />
            ))}
          </div>
        ) : props.isRoomsError ? (
          <div className="rounded-xl border border-rose-500/25 bg-rose-500/10 p-3 text-xs text-rose-700 dark:text-rose-300">
            <div className="flex items-center gap-1.5 font-semibold">
              <AlertCircle className="h-3.5 w-3.5" />
              <span>房间列表加载失败</span>
            </div>
            <button
              type="button"
              onClick={props.onRetryRooms}
              className="mt-2 inline-flex items-center gap-1 rounded-lg bg-rose-600 px-2.5 py-1 text-[11px] font-semibold text-white"
            >
              <RefreshCw className="h-3 w-3" />
              <span>重试拉取</span>
            </button>
          </div>
        ) : props.rooms.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-slate-300/80 bg-white/60 p-4 text-center dark:border-white/10 dark:bg-white/[0.02]">
            <p className="text-xs font-medium text-slate-700 dark:text-slate-300">
              尚未加入任何 Huddle 群聊
            </p>
            <p className="mt-1 text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
              点击上方「新建 Huddle」创建第一个讨论室，10 秒拉入你的个人 Agent！
            </p>
          </div>
        ) : (
          <div className="space-y-1">
            {props.rooms.map((room) => {
              const isActive = props.activeRoomId === room.id;
              const unreadCount = Math.max(0, room.lastSeq - room.yourLastReadSeq);
              const isPausedBudget = room.governance.status === "paused_budget";

              return (
                <button
                  key={room.id}
                  type="button"
                  onClick={() => {
                    props.onSelectRoom(room.id);
                    props.onCloseMobileDrawer?.();
                  }}
                  className={`group flex w-full flex-col gap-1 rounded-xl border px-3 py-2.5 text-left transition ${
                    isActive
                      ? "border-indigo-500/40 bg-white shadow-xs dark:border-indigo-500/40 dark:bg-indigo-500/[0.13]"
                      : "border-transparent hover:bg-white/70 dark:hover:bg-white/[0.04]"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <Hash
                        className={`h-3.5 w-3.5 shrink-0 ${
                          isActive
                            ? "text-indigo-600 dark:text-indigo-400"
                            : "text-slate-400 dark:text-slate-500"
                        }`}
                      />
                      <span
                        className={`truncate text-[13px] font-semibold ${
                          isActive
                            ? "text-slate-900 dark:text-white"
                            : unreadCount > 0
                              ? "text-slate-900 dark:text-slate-100"
                              : "text-slate-700 dark:text-slate-300"
                        }`}
                      >
                        {room.name}
                      </span>
                    </div>

                    <div className="flex shrink-0 items-center gap-1.5">
                      {isPausedBudget ? (
                        <span
                          title="连续 Agent 发言已达上限，等待人类裁判续期"
                          className="inline-flex items-center rounded-full bg-amber-500/20 p-0.5 text-amber-600 dark:text-amber-400"
                        >
                          <PauseCircle className="h-3.5 w-3.5" />
                        </span>
                      ) : null}

                      {room.visibility === "public_shareable" ? (
                        <Globe aria-label="已开启公开分享" className="h-3 w-3 text-emerald-500" />
                      ) : null}

                      {unreadCount > 0 ? (
                        <span className="inline-flex min-w-5 items-center justify-center rounded-full bg-indigo-600 px-1.5 py-0.5 font-mono text-[10.5px] font-bold text-white">
                          {unreadCount > 99 ? "99+" : unreadCount}
                        </span>
                      ) : null}
                    </div>
                  </div>

                  <div className="flex items-center justify-between gap-2 text-[11px] text-slate-500 dark:text-slate-400">
                    <span className="truncate">
                      {room.topic.length > 0 ? room.topic : "多智能体协作讨论"}
                    </span>
                    <span className="shrink-0 font-mono text-[10px] opacity-75">
                      #{room.lastSeq}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* 4. 底部个人 Agent 矩阵按钮与人类身份卡片 */}
      <div className="space-y-2.5 border-t border-slate-200/85 bg-white/70 p-3 dark:border-white/[0.07] dark:bg-[#0a0d14]">
        <button
          type="button"
          onClick={props.onOpenMyAgents}
          className="flex w-full items-center justify-between rounded-xl border border-indigo-500/25 bg-indigo-500/[0.07] px-3 py-2 text-xs font-semibold text-indigo-700 transition hover:bg-indigo-500/[0.13] dark:text-indigo-300"
        >
          <span className="inline-flex items-center gap-2">
            <Bot className="h-4 w-4" />
            <span>我的个人 Agents ({props.ownedAgents.length})</span>
          </span>
          <span className="rounded-full bg-emerald-500/20 px-2 py-0.5 text-[10px] font-bold text-emerald-700 dark:text-emerald-300">
            {onlineAgentCount} 在线
          </span>
        </button>

        <div className="flex items-center justify-between gap-2 px-1">
          <div className="flex min-w-0 items-center gap-2.5">
            <PlatformAvatar kind="human" displayName={props.currentUser.displayName} size="sm" />
            <div className="min-w-0">
              <p className="truncate text-xs font-semibold text-slate-900 dark:text-white">
                {props.currentUser.displayName}
              </p>
              <p className="truncate text-[10.5px] text-slate-500 dark:text-slate-400">
                {props.currentUser.email}
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={props.onLogout}
            title="退出当前登录会话"
            className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-200/70 hover:text-rose-600 dark:hover:bg-white/10 dark:hover:text-rose-400"
          >
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </div>
    </aside>
  );
}
