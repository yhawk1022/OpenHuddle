/**
 * @module web/features/huddle-room/friend-modals
 * @description Apple Liquid Glass 协调风格「添加好友与申请管理（`AddFriendModal`）」及「向现有群聊拉入好友/本人 Agent（`InviteMembersModal`）」模态窗组件（ADR-0005）。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 好友申请制闭环：支持按昵称或邮箱实时搜索站内活跃用户，区分 `friends`、`incoming_pending`、`outgoing_pending`、`none` 与 `self` 五态并内联处理收发申请。
 * 2. 群内直拉防重过滤：`InviteMembersModal` 自动剔除已在当前群内的好友与本人 Agent，一次提交原子入群并实时推送 `room.upserted`。
 */
import {
  type AgentId,
  type FriendContactDto,
  type FriendRequestDto,
  type FriendshipId,
  MAX_FRIEND_REMARK_LENGTH,
  type OwnedAgentSummaryDto,
  type RoomId,
  type RoomMemberDto,
  type UserId,
} from "@openhuddle/protocol";
import { useQuery } from "@tanstack/react-query";
import {
  Check,
  CheckCircle2,
  Clock,
  Mail,
  MessageCircle,
  Pencil,
  Search,
  UserCheck,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import { type FormEvent, useMemo, useState } from "react";
import { AppButton, AppInput, cn, toast } from "../../../components/primitives/index.js";
import { PlatformAvatar } from "../../../components/ui/identity-badges.js";
import { ModalDialog } from "../../../components/ui/modal-dialog.js";
import { PlatformGlyph } from "../../../components/ui/platform-icons.js";
import { ApiClientError } from "../../../lib/api-client.js";
import { getPlatformVisualMeta } from "../../../lib/format.js";
import { isCoarsePointerDevice } from "../../../lib/viewport-sync.js";
import {
  useAcceptFriendRequestMutation,
  useAddRoomMembersMutation,
  useDeclineFriendRequestMutation,
  useSendFriendRequestMutation,
  useUpdateFriendRemarkMutation,
  userSearchQueryOptions,
} from "../api/huddle-room.queries.js";

function formatErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiClientError || err instanceof Error) {
    return err.message;
  }
  return fallback;
}

/** `AddFriendModal` 入参属性 */
export interface AddFriendModalProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly incomingRequests: ReadonlyArray<FriendRequestDto>;
  readonly outgoingRequests: ReadonlyArray<FriendRequestDto>;
  /** 点击已是好友的用户「发消息」时触发打开 1v1 私聊 */
  readonly onOpenDirectHumanChat: (targetUserId: UserId) => void;
}

/**
 * 站内用户搜索、发送好友申请与收发申请集中处理弹窗。
 */
export function AddFriendModal(props: AddFriendModalProps) {
  const [queryText, setQueryText] = useState<string>("");
  const [noteText, setNoteText] = useState<string>("");
  const [pendingTargetId, setPendingTargetId] = useState<UserId | null>(null);
  const [pendingFriendshipId, setPendingFriendshipId] = useState<FriendshipId | null>(null);

  const trimmedQuery = queryText.trim();
  const searchQuery = useQuery(userSearchQueryOptions(trimmedQuery));
  const sendRequestMutation = useSendFriendRequestMutation();
  const acceptMutation = useAcceptFriendRequestMutation();
  const declineMutation = useDeclineFriendRequestMutation();

  const handleSendByUserId = (targetUserId: UserId, displayName: string): void => {
    setPendingTargetId(targetUserId);
    const cleanNote = noteText.trim();
    sendRequestMutation.mutate(
      {
        targetUserId,
        ...(cleanNote.length > 0 ? { note: cleanNote } : {}),
      },
      {
        onSuccess: (res) => {
          setPendingTargetId(null);
          if (res.autoAccepted || res.status === "accepted") {
            toast.success(`你与「${displayName}」已成为好友，现在可以直接私聊`);
          } else {
            toast.success(`已向「${displayName}」发送好友申请`);
          }
        },
        onError: (err) => {
          setPendingTargetId(null);
          toast.error(formatErrorMessage(err, "发送好友申请失败"));
        },
      },
    );
  };

  const handleAccept = (friendshipId: FriendshipId, displayName: string): void => {
    setPendingFriendshipId(friendshipId);
    acceptMutation.mutate(friendshipId, {
      onSuccess: () => {
        setPendingFriendshipId(null);
        toast.success(`已通过「${displayName}」的好友申请`);
      },
      onError: (err) => {
        setPendingFriendshipId(null);
        toast.error(formatErrorMessage(err, "同意申请失败"));
      },
    });
  };

  const handleDeclineOrCancel = (
    friendshipId: FriendshipId,
    label: string,
    isOutgoing: boolean,
  ): void => {
    setPendingFriendshipId(friendshipId);
    declineMutation.mutate(friendshipId, {
      onSuccess: () => {
        setPendingFriendshipId(null);
        toast.success(
          isOutgoing ? `已撤回发给「${label}」的好友申请` : `已忽略「${label}」的好友申请`,
        );
      },
      onError: (err) => {
        setPendingFriendshipId(null);
        toast.error(formatErrorMessage(err, "操作失败"));
      },
    });
  };

  const searchResults = searchQuery.data?.users ?? [];

  return (
    <ModalDialog
      open={props.open}
      onClose={props.onClose}
      title="添加好友"
      subtitle="按昵称或注册邮箱搜索站内同伴，互为好友后即可发起 1v1 私聊与直接拉群"
      maxWidthClass="max-w-lg"
      icon={<UserPlus className="h-4 w-4" />}
      footer={
        <div className="flex justify-end">
          <AppButton variant="secondary" size="md" onClick={props.onClose}>
            完成
          </AppButton>
        </div>
      }
    >
      <div className="space-y-4">
        {/* 1. 搜索输入框与验证附言 */}
        <div className="space-y-2.5">
          <AppInput
            id="add-friend-search-input"
            type="search"
            enterKeyHint="search"
            size="lg"
            autoFocus={!isCoarsePointerDevice()}
            value={queryText}
            onChange={(e) => setQueryText(e.target.value)}
            leadingIcon={<Search className="h-4 w-4" />}
            placeholder="输入对方的昵称或邮箱搜索…"
            trailingSlot={
              queryText.length > 0 ? (
                <button
                  type="button"
                  aria-label="清空搜索词"
                  onClick={() => setQueryText("")}
                  className="inline-flex h-5 w-5 cursor-pointer items-center justify-center rounded-full text-[#8E96A6] hover:bg-black/[0.06] hover:text-[#111318] dark:hover:bg-white/10 dark:hover:text-[#F2F2F4]"
                >
                  <X className="h-3 w-3" />
                </button>
              ) : undefined
            }
          />
          <AppInput
            id="add-friend-note-input"
            type="text"
            size="sm"
            maxLength={240}
            value={noteText}
            onChange={(e) => setNoteText(e.target.value)}
            leadingIcon={<Mail className="h-3.5 w-3.5" />}
            placeholder="可选验证留言（例如：你好，我是同组的王明）"
          />
        </div>

        {/* 2. 搜索命中列表 */}
        {trimmedQuery.length > 0 ? (
          <div className="space-y-1.5">
            <div className="px-1 text-[11.5px] font-medium text-[#687082] dark:text-[#8E8E96]">
              搜索结果
            </div>
            {searchQuery.isPending ? (
              <div className="space-y-1.5">
                {[1, 2].map((sk) => (
                  <div
                    key={`usr-sk-${String(sk)}`}
                    className="flex items-center gap-3 rounded-2xl bg-black/[0.03] px-3 py-2.5 dark:bg-white/[0.04]"
                  >
                    <div className="h-9 w-9 animate-pulse rounded-full bg-black/[0.06] dark:bg-white/[0.08]" />
                    <div className="flex-1 space-y-1.5">
                      <div className="h-3.5 w-28 animate-pulse rounded bg-black/[0.06] dark:bg-white/[0.08]" />
                      <div className="h-2.5 w-40 animate-pulse rounded bg-black/[0.04] dark:bg-white/[0.05]" />
                    </div>
                  </div>
                ))}
              </div>
            ) : searchResults.length === 0 ? (
              <div className="rounded-2xl bg-black/[0.035] px-4 py-5 text-center text-xs text-[#687082] dark:bg-white/[0.04] dark:text-[#8E8E96]">
                未找到匹配「{trimmedQuery}」的活跃用户
              </div>
            ) : (
              <ul className="space-y-1.5 pr-0.5 sm:max-h-60 sm:overflow-y-auto">
                {searchResults.map((item) => {
                  const u = item.user;
                  return (
                    <li
                      key={u.userId}
                      className="flex items-center justify-between gap-3 rounded-2xl bg-black/[0.035] px-3.5 py-2.5 ring-1 ring-inset ring-black/[0.05] dark:bg-white/[0.045] dark:ring-white/[0.07]"
                    >
                      <div className="flex min-w-0 items-center gap-2.5">
                        <PlatformAvatar
                          kind="human"
                          displayName={u.displayName}
                          size="md"
                          className="[&>div]:rounded-full"
                        />
                        <div className="min-w-0">
                          <p className="truncate text-[13.5px] font-semibold text-[#111318] dark:text-[#F2F2F4]">
                            {u.displayName}
                          </p>
                          <p className="truncate text-[11.5px] text-[#687082] dark:text-[#8E8E96]">
                            {u.email}
                            {item.sharedAgentCount > 0
                              ? ` · 开放 ${String(item.sharedAgentCount)} 个私聊 Agent`
                              : ""}
                          </p>
                        </div>
                      </div>

                      <div className="shrink-0">
                        {item.relationship === "self" ? (
                          <span className="rounded-full bg-black/[0.06] px-2.5 py-1 text-[11px] font-medium text-[#687082] dark:bg-white/[0.08] dark:text-[#8E8E96]">
                            我自己
                          </span>
                        ) : item.relationship === "friends" ? (
                          <AppButton
                            variant="secondary"
                            size="xs"
                            leadingIcon={<MessageCircle className="h-3.5 w-3.5" />}
                            onClick={() => {
                              props.onOpenDirectHumanChat(u.userId);
                              props.onClose();
                            }}
                          >
                            发消息
                          </AppButton>
                        ) : item.relationship === "incoming_pending" &&
                          item.friendshipId !== undefined ? (
                          <AppButton
                            variant="primary"
                            size="xs"
                            isLoading={pendingFriendshipId === item.friendshipId}
                            leadingIcon={<Check className="h-3.5 w-3.5" />}
                            onClick={() => {
                              if (item.friendshipId !== undefined) {
                                handleAccept(item.friendshipId, u.displayName);
                              }
                            }}
                          >
                            同意申请
                          </AppButton>
                        ) : item.relationship === "outgoing_pending" ? (
                          <div className="flex items-center gap-1.5">
                            <span className="inline-flex items-center gap-1 text-[11px] text-[#687082] dark:text-[#8E8E96]">
                              <Clock className="h-3 w-3" />
                              等待通过
                            </span>
                            {item.friendshipId !== undefined ? (
                              <AppButton
                                variant="ghost"
                                size="xs"
                                isLoading={pendingFriendshipId === item.friendshipId}
                                onClick={() => {
                                  if (item.friendshipId !== undefined) {
                                    handleDeclineOrCancel(item.friendshipId, u.displayName, true);
                                  }
                                }}
                              >
                                撤回
                              </AppButton>
                            ) : null}
                          </div>
                        ) : (
                          <AppButton
                            variant="primary"
                            size="xs"
                            isLoading={pendingTargetId === u.userId}
                            leadingIcon={<UserPlus className="h-3.5 w-3.5" />}
                            onClick={() => handleSendByUserId(u.userId, u.displayName)}
                          >
                            加好友
                          </AppButton>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        ) : null}

        {/* 3. 收到的待处理好友申请 */}
        {props.incomingRequests.length > 0 ? (
          <div className="space-y-1.5 border-t border-black/[0.06] pt-3 dark:border-white/[0.08]">
            <div className="flex items-center justify-between px-1">
              <span className="text-[11.5px] font-semibold text-[#111318] dark:text-[#F2F2F4]">
                收到的好友申请 · {props.incomingRequests.length}
              </span>
            </div>
            <ul className="space-y-1.5 sm:max-h-48 sm:overflow-y-auto">
              {props.incomingRequests.map((req) => (
                <li
                  key={req.friendshipId}
                  className="flex items-center justify-between gap-3 rounded-2xl bg-black/[0.035] px-3.5 py-2.5 ring-1 ring-inset ring-black/[0.05] dark:bg-white/[0.045] dark:ring-white/[0.07]"
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
                        {req.note !== undefined ? `留言：${req.note}` : req.peer.email}
                      </p>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <AppButton
                      variant="ghost"
                      size="xs"
                      disabled={pendingFriendshipId === req.friendshipId}
                      onClick={() =>
                        handleDeclineOrCancel(req.friendshipId, req.peer.displayName, false)
                      }
                    >
                      忽略
                    </AppButton>
                    <AppButton
                      variant="primary"
                      size="xs"
                      isLoading={pendingFriendshipId === req.friendshipId}
                      leadingIcon={<UserCheck className="h-3.5 w-3.5" />}
                      onClick={() => handleAccept(req.friendshipId, req.peer.displayName)}
                    >
                      同意
                    </AppButton>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {/* 4. 发出的待处理申请 */}
        {trimmedQuery.length === 0 && props.outgoingRequests.length > 0 ? (
          <div className="space-y-1.5 border-t border-black/[0.06] pt-3 dark:border-white/[0.08]">
            <span className="block px-1 text-[11.5px] font-medium text-[#687082] dark:text-[#8E8E96]">
              已发出的申请 · {props.outgoingRequests.length}
            </span>
            <ul className="space-y-1 sm:max-h-36 sm:overflow-y-auto">
              {props.outgoingRequests.map((req) => (
                <li
                  key={req.friendshipId}
                  className="flex items-center justify-between gap-2 rounded-xl bg-black/[0.025] px-3 py-2 text-xs dark:bg-white/[0.035]"
                >
                  <span className="min-w-0 truncate text-[#3B414E] dark:text-[#C4C4CA]">
                    {req.peer.displayName} ({req.peer.email})
                  </span>
                  <AppButton
                    variant="ghost"
                    size="xs"
                    isLoading={pendingFriendshipId === req.friendshipId}
                    onClick={() =>
                      handleDeclineOrCancel(req.friendshipId, req.peer.displayName, true)
                    }
                  >
                    撤回
                  </AppButton>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </ModalDialog>
  );
}

/**
 * 编辑自己的好友备注。保存失败时保留输入，便于重试。
 *
 * @param props - 当前好友与弹窗关闭回调
 * @returns 备注编辑弹窗
 */
export function EditFriendRemarkModal(props: {
  readonly open?: boolean | undefined;
  readonly friend: FriendContactDto;
  readonly onClose: () => void;
}) {
  const { open = true, friend, onClose } = props;
  const [remark, setRemark] = useState(friend.remark ?? "");
  const mutation = useUpdateFriendRemarkMutation();

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (mutation.isPending) {
      return;
    }
    mutation.mutate({ friendshipId: friend.friendshipId, remark }, { onSuccess: onClose });
  };

  return (
    <ModalDialog
      open={open}
      onClose={() => {
        if (!mutation.isPending) {
          onClose();
        }
      }}
      title="编辑好友备注"
      subtitle={`给 ${friend.user.displayName} 设置备注，仅自己可见。`}
      maxWidthClass="max-w-sm"
      icon={<Pencil className="h-4 w-4" />}
    >
      <form onSubmit={handleSubmit} className="space-y-3">
        <label htmlFor="friend-remark" className="text-[13px] font-medium">
          备注名
        </label>
        <AppInput
          id="friend-remark"
          type="text"
          value={remark}
          onChange={(event) => setRemark(event.target.value)}
          placeholder={friend.user.displayName}
          maxLength={MAX_FRIEND_REMARK_LENGTH}
          disabled={mutation.isPending}
          aria-describedby="friend-remark-hint"
        />
        <p id="friend-remark-hint" className="text-xs text-[#687082] dark:text-[#8E8E96]">
          留空并保存可恢复原昵称。
        </p>
        {mutation.isError ? (
          <p role="alert" className="text-xs text-[#C81E1E] dark:text-[#FCA5A5]">
            {formatErrorMessage(mutation.error, "保存备注失败，请重试。")}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <AppButton variant="secondary" disabled={mutation.isPending} onClick={onClose}>
            取消
          </AppButton>
          <AppButton type="submit" isLoading={mutation.isPending}>
            保存
          </AppButton>
        </div>
      </form>
    </ModalDialog>
  );
}

/** `InviteMembersModal` 入参属性 */
export interface InviteMembersModalProps {
  /** 是否打开弹窗（默认 `true`，传入受控布尔值可驱动 135ms 退场动效） */
  readonly open?: boolean | undefined;
  /** 从群成员面板进入时，可仅显示自己名下的 Agent。 */
  readonly mode: "members" | "agents";
  readonly onClose: () => void;
  readonly roomId: RoomId;
  readonly roomName: string;
  readonly existingMembers: ReadonlyArray<RoomMemberDto>;
  readonly friends: ReadonlyArray<FriendContactDto>;
  readonly ownedAgents: ReadonlyArray<OwnedAgentSummaryDto>;
  readonly onOpenAddFriend: () => void;
  readonly onOpenPairAgent: () => void;
}

/**
 * 向当前群聊邀请已添加的好友或自己名下的 Agent。
 *
 * @param props - 目标群聊、当前名单与登录用户可选的成员
 * @returns 群成员选择弹窗
 */
export function InviteMembersModal(props: InviteMembersModalProps) {
  const [selectedUserIds, setSelectedUserIds] = useState<ReadonlySet<UserId>>(new Set());
  const [selectedAgentIds, setSelectedAgentIds] = useState<ReadonlySet<AgentId>>(new Set());
  const [filterText, setFilterText] = useState<string>("");

  const addMembersMutation = useAddRoomMembersMutation(props.roomId);
  const agentsOnly = props.mode === "agents";
  const isSubmitting = addMembersMutation.isPending;

  const existingHumanSet = useMemo(() => {
    const s = new Set<UserId>();
    for (const m of props.existingMembers) {
      if (m.memberKind === "human" && m.userId !== undefined) {
        s.add(m.userId);
      }
    }
    return s;
  }, [props.existingMembers]);

  const existingAgentSet = useMemo(() => {
    const s = new Set<AgentId>();
    for (const m of props.existingMembers) {
      if (m.memberKind === "agent" && m.agentId !== undefined) {
        s.add(m.agentId);
      }
    }
    return s;
  }, [props.existingMembers]);

  const q = filterText.trim().toLowerCase();

  const candidateFriends = useMemo(
    () =>
      props.friends.filter(
        (f) =>
          !existingHumanSet.has(f.user.userId) &&
          (q.length === 0 ||
            f.remark?.toLowerCase().includes(q) ||
            f.user.displayName.toLowerCase().includes(q) ||
            f.user.email.toLowerCase().includes(q)),
      ),
    [props.friends, existingHumanSet, q],
  );

  const candidateAgents = useMemo(
    () =>
      props.ownedAgents.filter(
        (a) =>
          !existingAgentSet.has(a.id) &&
          (q.length === 0 ||
            a.displayName.toLowerCase().includes(q) ||
            a.platform.toLowerCase().includes(q)),
      ),
    [props.ownedAgents, existingAgentSet, q],
  );

  const toggleUser = (uid: UserId): void => {
    setSelectedUserIds((prev) => {
      const next = new Set(prev);
      if (next.has(uid)) {
        next.delete(uid);
      } else {
        next.add(uid);
      }
      return next;
    });
  };

  const toggleAgent = (aid: AgentId): void => {
    setSelectedAgentIds((prev) => {
      const next = new Set(prev);
      if (next.has(aid)) {
        next.delete(aid);
      } else {
        next.add(aid);
      }
      return next;
    });
  };

  const totalSelected = selectedUserIds.size + selectedAgentIds.size;

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (totalSelected === 0 || isSubmitting) {
      return;
    }

    addMembersMutation.mutate(
      {
        userIds: [...selectedUserIds],
        agentIds: [...selectedAgentIds],
      },
      {
        onSuccess: () => {
          toast.success(agentsOnly ? "已添加到群聊" : "已更新群成员");
          props.onClose();
        },
        onError: (err) => {
          toast.error(formatErrorMessage(err, agentsOnly ? "添加 Agent 失败" : "邀请成员失败"));
        },
      },
    );
  };

  return (
    <ModalDialog
      open={props.open ?? true}
      onClose={() => {
        if (!isSubmitting) {
          props.onClose();
        }
      }}
      title={agentsOnly ? "添加我的 Agent" : `邀请加入「${props.roomName}」`}
      subtitle={agentsOnly ? `选择要加入「${props.roomName}」的 Agent。` : undefined}
      maxWidthClass="max-w-lg"
      icon={<Users className="h-4 w-4" />}
      footer={
        <div className="flex items-center justify-end gap-2">
          <AppButton variant="ghost" size="md" disabled={isSubmitting} onClick={props.onClose}>
            取消
          </AppButton>
          <AppButton
            type="submit"
            form="invite-members-form"
            variant="primary"
            size="md"
            disabled={totalSelected === 0}
            isLoading={isSubmitting}
          >
            拉入群聊{totalSelected > 0 ? ` (${String(totalSelected)})` : ""}
          </AppButton>
        </div>
      }
    >
      <form id="invite-members-form" onSubmit={handleSubmit} className="space-y-4">
        <AppInput
          size="sm"
          type="search"
          enterKeyHint="search"
          value={filterText}
          onChange={(e) => setFilterText(e.target.value)}
          leadingIcon={<Search className="h-3.5 w-3.5" />}
          aria-label={agentsOnly ? "筛选我的 Agent" : "筛选好友或我的 Agent"}
          placeholder={agentsOnly ? "筛选我的 Agent…" : "筛选好友或我的 Agent…"}
        />

        {agentsOnly ? null : (
          <div className="space-y-2">
            <div className="flex items-center justify-between px-0.5 text-xs">
              <span className="font-semibold text-[#3B414E] dark:text-[#C4C4CA]">
                我的好友（未在群内 · {candidateFriends.length}）
              </span>
              <button
                type="button"
                disabled={isSubmitting}
                onClick={() => {
                  props.onClose();
                  props.onOpenAddFriend();
                }}
                className="cursor-pointer text-[11.5px] font-medium text-[#2563EB] hover:underline dark:text-[#60A5FA]"
              >
                + 添加新好友
              </button>
            </div>
            {candidateFriends.length === 0 ? (
              <p className="rounded-2xl bg-black/[0.03] px-3.5 py-3 text-xs text-[#687082] dark:bg-white/[0.04] dark:text-[#8E8E96]">
                {props.friends.length === 0
                  ? "暂未添加好友；可点击右上角「+ 添加新好友」或复制群邀请码发给同伴。"
                  : "你的全部好友均已在群内。"}
              </p>
            ) : (
              <div className="flex flex-wrap gap-1.5 sm:max-h-40 sm:overflow-y-auto">
                {candidateFriends.map((friend) => {
                  const isSelected = selectedUserIds.has(friend.user.userId);
                  return (
                    <button
                      key={friend.user.userId}
                      type="button"
                      disabled={isSubmitting}
                      aria-pressed={isSelected}
                      onClick={() => toggleUser(friend.user.userId)}
                      className={cn(
                        "flex cursor-pointer items-center gap-2 rounded-full px-3 py-1.5 text-xs font-medium transition-all active:scale-[0.98]",
                        isSelected
                          ? "bg-[#181B22] text-white ring-1 ring-[#181B22] dark:bg-[#EAEEF6] dark:text-[#111318] dark:ring-[#EAEEF6]"
                          : "bg-black/[0.04] text-[#3B414E] ring-1 ring-inset ring-black/[0.07] hover:bg-black/[0.07] dark:bg-white/[0.05] dark:text-[#C4C4CA] dark:ring-white/[0.09] dark:hover:bg-white/[0.10]",
                      )}
                    >
                      <span className="truncate">{friend.remark ?? friend.user.displayName}</span>
                      {isSelected ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0" /> : null}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}

        <div className="space-y-2">
          <div className="flex items-center justify-between px-0.5 text-xs">
            <span className="font-semibold text-[#3B414E] dark:text-[#C4C4CA]">可添加的 Agent</span>
            <button
              type="button"
              disabled={isSubmitting}
              onClick={() => {
                props.onClose();
                props.onOpenPairAgent();
              }}
              className="cursor-pointer text-[11.5px] font-medium text-[#2563EB] hover:underline dark:text-[#60A5FA]"
            >
              + 配对新 Agent
            </button>
          </div>
          {candidateAgents.length === 0 ? (
            <p className="rounded-2xl bg-black/[0.03] px-3.5 py-3 text-xs text-[#687082] dark:bg-white/[0.04] dark:text-[#8E8E96]">
              {props.ownedAgents.length === 0
                ? "尚未绑定个人 Agent；点击右上角「+ 配对新 Agent」一键接入。"
                : props.ownedAgents.every((agent) => existingAgentSet.has(agent.id))
                  ? "你的 Agent 均已在群内。"
                  : "没有符合筛选条件的 Agent。"}
            </p>
          ) : (
            <div className="flex flex-wrap gap-1.5 sm:max-h-40 sm:overflow-y-auto">
              {candidateAgents.map((agent) => {
                const meta = getPlatformVisualMeta(agent.platform);
                const isSelected = selectedAgentIds.has(agent.id);
                return (
                  <button
                    key={agent.id}
                    type="button"
                    disabled={isSubmitting}
                    aria-pressed={isSelected}
                    onClick={() => toggleAgent(agent.id)}
                    className={cn(
                      "flex cursor-pointer items-center gap-2 rounded-full px-2.5 py-1.5 text-xs font-medium transition-all active:scale-[0.98]",
                      isSelected
                        ? "bg-[#181B22] text-white ring-1 ring-[#181B22] dark:bg-[#EAEEF6] dark:text-[#111318] dark:ring-[#EAEEF6]"
                        : "bg-black/[0.04] text-[#3B414E] ring-1 ring-inset ring-black/[0.07] hover:bg-black/[0.07] dark:bg-white/[0.05] dark:text-[#C4C4CA] dark:ring-white/[0.09] dark:hover:bg-white/[0.10]",
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
                    {isSelected ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0" /> : null}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </form>
    </ModalDialog>
  );
}
