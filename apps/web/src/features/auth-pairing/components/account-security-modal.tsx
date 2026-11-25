/**
 * @module web/features/auth-pairing/account-security-modal
 * @description 登录后人类账号资料与密码安全管理弹窗（编辑昵称、修改登录密码或为早期无密码老用户首次补设密码）。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 无密码老用户平滑迁移：根据 `currentUser.hasPassword` 自动切换「修改登录密码（需核验当前密码）」与「首次设置登录密码」表单。
 * 2. 改密即轮换会话：成功后 `useChangePasswordMutation` 自动替换本地备份令牌，并提示其余设备已安全下线。
 */
import { type HumanUserDto, PASSWORD_MIN_LENGTH } from "@openhuddle/protocol";
import { CheckCircle2, Eye, EyeOff, Lock, ShieldCheck, User } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { AppButton, AppInput, toast } from "../../../components/primitives/index.js";
import { ModalDialog } from "../../../components/ui/modal-dialog.js";
import { ApiClientError } from "../../../lib/api-client.js";
import { useChangePasswordMutation, useUpdateMeMutation } from "../api/auth-pairing.queries.js";

/** `AccountSecurityModal` 入参属性 */
export interface AccountSecurityModalProps {
  readonly open: boolean;
  readonly currentUser: HumanUserDto;
  readonly onClose: () => void;
}

const LABEL_CLASS = "block text-xs font-medium text-[#3A3A3C] dark:text-zinc-300";

/**
 * 渲染当前登录人类账号的个人资料与登录密码安全管理弹窗。
 *
 * @param props - 开关状态、当前登录用户 DTO 与关闭回调
 * @returns 无障碍响应式账户安全模态窗
 */
export function AccountSecurityModal(props: AccountSecurityModalProps) {
  const { open, currentUser, onClose } = props;

  const [displayName, setDisplayName] = useState<string>(currentUser.displayName);
  const [currentPassword, setCurrentPassword] = useState<string>("");
  const [newPassword, setNewPassword] = useState<string>("");
  const [confirmNewPassword, setConfirmNewPassword] = useState<string>("");
  const [showPasswords, setShowPasswords] = useState<boolean>(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const updateMeMutation = useUpdateMeMutation();
  const changePasswordMutation = useChangePasswordMutation();

  const { reset: resetUpdateMe } = updateMeMutation;
  const { reset: resetChangePassword } = changePasswordMutation;

  useEffect(() => {
    if (open) {
      setDisplayName(currentUser.displayName);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmNewPassword("");
      setShowPasswords(false);
      setLocalError(null);
      resetUpdateMe();
      resetChangePassword();
    }
  }, [open, currentUser.displayName, resetUpdateMe, resetChangePassword]);

  const trimmedName = displayName.trim();
  const hasNameChanged = trimmedName.length > 0 && trimmedName !== currentUser.displayName;

  const handleSaveDisplayName = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!hasNameChanged) {
      return;
    }
    updateMeMutation.mutate(
      { displayName: trimmedName },
      {
        onSuccess: () => {
          toast.success("昵称已更新");
        },
        onError: (err) => {
          toast.error(err instanceof Error ? err.message : "更新昵称失败");
        },
      },
    );
  };

  const handleChangePassword = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setLocalError(null);
    if (currentUser.hasPassword && currentPassword.length === 0) {
      setLocalError("请输入当前密码。");
      return;
    }
    if (newPassword.length < PASSWORD_MIN_LENGTH || !/\S/.test(newPassword)) {
      setLocalError(`新密码至少需要 ${PASSWORD_MIN_LENGTH} 个字符。`);
      return;
    }
    if (newPassword !== confirmNewPassword) {
      setLocalError("两次输入的新密码不一致。");
      return;
    }
    if (newPassword.trim().toLowerCase() === currentUser.email.toLowerCase()) {
      setLocalError("新密码不能与邮箱地址相同。");
      return;
    }

    changePasswordMutation.mutate(
      {
        ...(currentUser.hasPassword ? { currentPassword } : {}),
        newPassword,
      },
      {
        onSuccess: () => {
          setCurrentPassword("");
          setNewPassword("");
          setConfirmNewPassword("");
          toast.success(currentUser.hasPassword ? "登录密码已修改" : "登录密码已设置", {
            description: "其他设备需要重新登录",
          });
        },
      },
    );
  };

  const passwordServerError =
    changePasswordMutation.error instanceof ApiClientError
      ? changePasswordMutation.error.code === "INVALID_CREDENTIALS"
        ? "当前密码不正确，请重新输入。"
        : changePasswordMutation.error.message
      : changePasswordMutation.error instanceof Error
        ? changePasswordMutation.error.message
        : null;

  const visiblePasswordError = localError ?? passwordServerError;

  return (
    <ModalDialog
      open={open}
      onClose={onClose}
      title="账号安全"
      subtitle={`${currentUser.email} · ${currentUser.role === "admin" ? "平台管理员" : "成员"}`}
      maxWidthClass="max-w-md"
      icon={<ShieldCheck className="h-4 w-4" />}
    >
      <div className="space-y-6">
        {/* 账号状态概览条 */}
        <div className="flex flex-wrap items-center gap-2 rounded-2xl bg-[#F5F5F7] px-3.5 py-2.5 text-xs text-[#52525B] dark:bg-white/[0.05] dark:text-zinc-300">
          <span className="inline-flex items-center gap-1 text-[#1E5638] dark:text-[#86E0A6]">
            <CheckCircle2 className="h-3.5 w-3.5" />
            {currentUser.emailVerified ? "邮箱已验证" : "邮箱未验证"}
          </span>
          <span aria-hidden="true" className="opacity-35">
            ·
          </span>
          <span>{currentUser.hasPassword ? "已设置登录密码" : "未设置登录密码"}</span>
        </div>

        {/* 1. 昵称设置 */}
        <form onSubmit={handleSaveDisplayName} className="space-y-3">
          <label htmlFor="account-display-name" className={LABEL_CLASS}>
            昵称
          </label>
          <div className="flex items-center gap-2">
            <AppInput
              id="account-display-name"
              type="text"
              size="md"
              maxLength={80}
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              leadingIcon={<User className="h-4 w-4" />}
              containerClassName="flex-1"
            />
            <AppButton
              type="submit"
              variant="secondary"
              size="md"
              disabled={!hasNameChanged}
              isLoading={updateMeMutation.isPending}
              className="shrink-0"
            >
              保存
            </AppButton>
          </div>
        </form>

        <div className="h-px bg-black/[0.06] dark:bg-white/[0.08]" />

        {/* 2. 修改 / 首次设置密码 */}
        <form onSubmit={handleChangePassword} className="space-y-3.5">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-[13px] font-semibold text-[#141414] dark:text-zinc-100">
              {currentUser.hasPassword ? "修改登录密码" : "设置登录密码"}
            </h3>
            <button
              type="button"
              onClick={() => setShowPasswords((prev) => !prev)}
              className="inline-flex cursor-pointer items-center gap-1 text-[11.5px] text-[#6E6E73] transition hover:text-[#141414] dark:text-zinc-400 dark:hover:text-zinc-100"
            >
              {showPasswords ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              <span>{showPasswords ? "隐藏密码" : "显示密码"}</span>
            </button>
          </div>

          {currentUser.hasPassword ? (
            <div>
              <label htmlFor="account-current-password" className={LABEL_CLASS}>
                当前密码
              </label>
              <AppInput
                id="account-current-password"
                type={showPasswords ? "text" : "password"}
                enterKeyHint="next"
                size="md"
                autoComplete="current-password"
                value={currentPassword}
                onChange={(e) => {
                  setCurrentPassword(e.target.value);
                  setLocalError(null);
                }}
                leadingIcon={<Lock className="h-4 w-4" />}
                placeholder="输入当前密码"
                containerClassName="mt-1.5"
              />
            </div>
          ) : null}

          <div>
            <label htmlFor="account-new-password" className={LABEL_CLASS}>
              新密码
            </label>
            <AppInput
              id="account-new-password"
              type={showPasswords ? "text" : "password"}
              enterKeyHint="next"
              size="md"
              minLength={PASSWORD_MIN_LENGTH}
              autoComplete="new-password"
              value={newPassword}
              onChange={(e) => {
                setNewPassword(e.target.value);
                setLocalError(null);
              }}
              leadingIcon={<Lock className="h-4 w-4" />}
              placeholder={`至少 ${PASSWORD_MIN_LENGTH} 个字符`}
              containerClassName="mt-1.5"
            />
          </div>

          <div>
            <label htmlFor="account-confirm-new-password" className={LABEL_CLASS}>
              确认新密码
            </label>
            <AppInput
              id="account-confirm-new-password"
              type={showPasswords ? "text" : "password"}
              enterKeyHint="done"
              size="md"
              autoComplete="new-password"
              value={confirmNewPassword}
              invalid={confirmNewPassword.length > 0 && confirmNewPassword !== newPassword}
              onChange={(e) => {
                setConfirmNewPassword(e.target.value);
                setLocalError(null);
              }}
              leadingIcon={<Lock className="h-4 w-4" />}
              placeholder="再次输入新密码"
              containerClassName="mt-1.5"
            />
          </div>

          {visiblePasswordError ? (
            <div
              role="alert"
              className="rounded-xl border border-[#FF3B30]/25 bg-[#FF3B30]/[0.07] px-3 py-2 text-xs text-[#D70015] dark:bg-[#FF453A]/12 dark:text-[#FF6961]"
            >
              {visiblePasswordError}
            </div>
          ) : null}

          <AppButton
            type="submit"
            variant="primary"
            size="md"
            fullWidth={true}
            isLoading={changePasswordMutation.isPending}
            disabled={
              (currentUser.hasPassword && currentPassword.length === 0) ||
              newPassword.length < PASSWORD_MIN_LENGTH ||
              confirmNewPassword !== newPassword
            }
            className="rounded-full"
          >
            {changePasswordMutation.isPending
              ? "正在保存..."
              : currentUser.hasPassword
                ? "保存新密码"
                : "保存登录密码"}
          </AppButton>
        </form>
      </div>
    </ModalDialog>
  );
}
