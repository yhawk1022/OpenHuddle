/**
 * @module web/features/auth-pairing/account-security-modal
 * @description 登录后人类账号设置弹窗（编辑昵称、跨端同步界面语言偏好、修改登录密码或为早期无密码老用户首次补设密码）。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 无密码老用户平滑迁移：根据 `currentUser.hasPassword` 自动切换「修改登录密码（需核验当前密码）」与「首次设置登录密码」表单。
 * 2. 界面语言即时乐观切换：点击 `SegmentedTabs` 立即切换并跨端同步，右侧固定状态位零布局抖动（CLS = 0）。
 * 3. 改密即轮换会话：成功后 `useChangePasswordMutation` 自动替换本地备份令牌，并提示其余设备已安全下线。
 */
import {
  type HumanUserDto,
  type LanguagePreference,
  PASSWORD_MIN_LENGTH,
} from "@openhuddle/protocol";
import { CheckCircle2, Eye, EyeOff, Loader2, Lock, ShieldCheck, User } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import {
  AppButton,
  AppInput,
  type SegmentedTabItem,
  SegmentedTabs,
  toast,
} from "../../../components/primitives/index.js";
import { ModalDialog } from "../../../components/ui/modal-dialog.js";
import { ApiClientError } from "../../../lib/api-client.js";
import { formatApiErrorMessage, useCommonI18n } from "../../../lib/i18n/index.js";
import {
  useAccountLanguagePreference,
  useChangePasswordMutation,
  useUpdateMeMutation,
} from "../api/auth-pairing.queries.js";

/** `AccountSecurityModal` 入参属性 */
export interface AccountSecurityModalProps {
  readonly open: boolean;
  readonly currentUser: HumanUserDto;
  readonly onClose: () => void;
}

const LABEL_CLASS = "block text-xs font-medium text-[#3A3A3C] dark:text-zinc-300";

function isClientTransportRequestId(requestId: string): boolean {
  return requestId === "timeout" || requestId === "network" || requestId === "gateway";
}

/**
 * 渲染当前登录人类账号的个人资料、界面语言与登录密码管理弹窗。
 *
 * @param props - 开关状态、当前登录用户 DTO 与关闭回调
 * @returns 无障碍响应式账号设置模态窗
 */
export function AccountSecurityModal(props: AccountSecurityModalProps) {
  const { open, currentUser, onClose } = props;
  const { t } = useCommonI18n();

  const [displayName, setDisplayName] = useState<string>(currentUser.displayName);
  const [currentPassword, setCurrentPassword] = useState<string>("");
  const [newPassword, setNewPassword] = useState<string>("");
  const [confirmNewPassword, setConfirmNewPassword] = useState<string>("");
  const [showPasswords, setShowPasswords] = useState<boolean>(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const updateMeMutation = useUpdateMeMutation();
  const changePasswordMutation = useChangePasswordMutation();
  const accountLanguage = useAccountLanguagePreference();

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

  const languageTabs: ReadonlyArray<SegmentedTabItem<LanguagePreference>> = [
    { value: "auto", label: t("locale.option.auto") },
    { value: "zh-CN", label: t("locale.autonym.zhCN") },
    { value: "en", label: t("locale.autonym.en") },
  ];

  const resolvedLanguageAutonym =
    accountLanguage.resolvedLocale === "zh-CN" ? t("locale.autonym.zhCN") : t("locale.autonym.en");

  const handleSaveDisplayName = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!hasNameChanged) {
      return;
    }
    updateMeMutation.mutate(
      { displayName: trimmedName },
      {
        onSuccess: () => {
          toast.success(t("accountSettings.displayName.updated"));
        },
        onError: (err) => {
          if (err instanceof ApiClientError) {
            toast.error(
              isClientTransportRequestId(err.requestId)
                ? err.message
                : formatApiErrorMessage(err.code, err.message),
            );
            return;
          }
          toast.error(
            err instanceof Error ? err.message : t("accountSettings.displayName.updateFailed"),
          );
        },
      },
    );
  };

  const handleChangePassword = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setLocalError(null);
    if (currentUser.hasPassword && currentPassword.length === 0) {
      setLocalError(t("accountSettings.password.errCurrentRequired"));
      return;
    }
    if (newPassword.length < PASSWORD_MIN_LENGTH || !/\S/.test(newPassword)) {
      setLocalError(t("accountSettings.password.errTooShort", { min: PASSWORD_MIN_LENGTH }));
      return;
    }
    if (newPassword !== confirmNewPassword) {
      setLocalError(t("accountSettings.password.errMismatch"));
      return;
    }
    if (newPassword.trim().toLowerCase() === currentUser.email.toLowerCase()) {
      setLocalError(t("accountSettings.password.errSameAsEmail"));
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
          toast.success(
            currentUser.hasPassword
              ? t("accountSettings.password.toastChanged")
              : t("accountSettings.password.toastSet"),
            {
              description: t("accountSettings.password.toastSignOutOthers"),
            },
          );
        },
      },
    );
  };

  const passwordServerError =
    changePasswordMutation.error instanceof ApiClientError
      ? changePasswordMutation.error.code === "INVALID_CREDENTIALS"
        ? t("accountSettings.password.errInvalidCurrent")
        : isClientTransportRequestId(changePasswordMutation.error.requestId)
          ? changePasswordMutation.error.message
          : formatApiErrorMessage(
              changePasswordMutation.error.code,
              changePasswordMutation.error.message,
            )
      : changePasswordMutation.error instanceof Error
        ? changePasswordMutation.error.message
        : null;

  const visiblePasswordError = localError ?? passwordServerError;

  return (
    <ModalDialog
      open={open}
      onClose={onClose}
      title={t("accountSettings.title")}
      subtitle={`${currentUser.email} · ${currentUser.role === "admin" ? t("accountSettings.role.admin") : t("accountSettings.role.member")}`}
      maxWidthClass="max-w-md"
      icon={<ShieldCheck className="h-4 w-4" />}
    >
      <div className="space-y-6">
        {/* 账号状态概览条 */}
        <div className="flex flex-wrap items-center gap-2 rounded-2xl bg-[#F5F5F7] px-3.5 py-2.5 text-xs text-[#52525B] dark:bg-white/[0.05] dark:text-zinc-300">
          <span className="inline-flex items-center gap-1 text-[#1E5638] dark:text-[#86E0A6]">
            <CheckCircle2 className="h-3.5 w-3.5" />
            {currentUser.emailVerified
              ? t("accountSettings.emailVerified")
              : t("accountSettings.emailUnverified")}
          </span>
          <span aria-hidden="true" className="opacity-35">
            ·
          </span>
          <span>
            {currentUser.hasPassword
              ? t("accountSettings.passwordSet")
              : t("accountSettings.passwordNotSet")}
          </span>
        </div>

        {/* 1. 昵称设置 */}
        <form onSubmit={handleSaveDisplayName} className="space-y-3">
          <label htmlFor="account-display-name" className={LABEL_CLASS}>
            {t("accountSettings.displayName.label")}
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
              {t("action.save")}
            </AppButton>
          </div>
        </form>

        <div className="h-px bg-black/[0.06] dark:bg-white/[0.08]" />

        {/* 2. 界面语言设置（跨端同步，乐观切换，零 CLS 状态位） */}
        <section aria-labelledby="account-language-heading" className="space-y-2.5">
          <div className="flex items-center justify-between gap-2">
            <h3 id="account-language-heading" className={LABEL_CLASS}>
              {t("accountSettings.language.label")}
            </h3>
            <span
              aria-live="polite"
              className="inline-flex h-4 min-w-[5rem] shrink-0 items-center justify-end gap-1 text-[11px] font-medium text-[#6E6E73] dark:text-zinc-400"
            >
              {accountLanguage.isSaving ? (
                <>
                  <Loader2 aria-hidden="true" className="h-3 w-3 shrink-0 animate-spin" />
                  <span>{t("status.saving")}</span>
                </>
              ) : (
                <span>{t("status.synced")}</span>
              )}
            </span>
          </div>
          <SegmentedTabs
            size="sm"
            fullWidth={true}
            value={accountLanguage.preference}
            onValueChange={accountLanguage.setPreference}
            items={languageTabs}
            ariaLabel={t("accountSettings.language.ariaLabel")}
          />
          <p className="text-[11.5px] leading-relaxed text-[#6E6E73] dark:text-zinc-400">
            {accountLanguage.preference === "auto"
              ? t("locale.account.followingSystem", { language: resolvedLanguageAutonym })
              : t("locale.account.pinnedSynced", { language: resolvedLanguageAutonym })}
          </p>
        </section>

        <div className="h-px bg-black/[0.06] dark:bg-white/[0.08]" />

        {/* 3. 修改 / 首次设置密码 */}
        <form onSubmit={handleChangePassword} className="space-y-3.5">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-[13px] font-semibold text-[#141414] dark:text-zinc-100">
              {currentUser.hasPassword
                ? t("accountSettings.password.sectionChange")
                : t("accountSettings.password.sectionSet")}
            </h3>
            <button
              type="button"
              onClick={() => setShowPasswords((prev) => !prev)}
              className="inline-flex cursor-pointer items-center gap-1 text-[11.5px] text-[#6E6E73] transition hover:text-[#141414] dark:text-zinc-400 dark:hover:text-zinc-100"
            >
              {showPasswords ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              <span>
                {showPasswords
                  ? t("accountSettings.password.hide")
                  : t("accountSettings.password.show")}
              </span>
            </button>
          </div>

          {currentUser.hasPassword ? (
            <div>
              <label htmlFor="account-current-password" className={LABEL_CLASS}>
                {t("accountSettings.password.currentLabel")}
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
                placeholder={t("accountSettings.password.currentPlaceholder")}
                containerClassName="mt-1.5"
              />
            </div>
          ) : null}

          <div>
            <label htmlFor="account-new-password" className={LABEL_CLASS}>
              {t("accountSettings.password.newLabel")}
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
              placeholder={t("accountSettings.password.newPlaceholder", {
                min: PASSWORD_MIN_LENGTH,
              })}
              containerClassName="mt-1.5"
            />
          </div>

          <div>
            <label htmlFor="account-confirm-new-password" className={LABEL_CLASS}>
              {t("accountSettings.password.confirmLabel")}
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
              placeholder={t("accountSettings.password.confirmPlaceholder")}
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
              ? t("accountSettings.password.submitting")
              : currentUser.hasPassword
                ? t("accountSettings.password.submitChange")
                : t("accountSettings.password.submitSet")}
          </AppButton>
        </form>
      </div>
    </ModalDialog>
  );
}
