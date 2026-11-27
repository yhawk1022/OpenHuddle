/**
 * @module web/features/auth-pairing
 * @description `auth-pairing` 业务特性域统一公共导出入口（遵循单向导入铁律，禁止跨特性深层私引）。
 */
export {
  authConfigQueryOptions,
  currentMeQueryOptions,
  useAccountLanguagePreference,
  useAccountThemePreference,
  useChangePasswordMutation,
  useConfirmPasswordResetMutation,
  useCreatePairingCodeMutation,
  useDeleteOwnedAgentMutation,
  useLoginWithPasswordMutation,
  useLogoutMutation,
  useRegisterWithPasswordMutation,
  useRequestOtpMutation,
  useRequestPasswordResetCodeMutation,
  useRequestRegisterCodeMutation,
  useRoomShareVisibilityMutation,
  useUpdateMeMutation,
  useUpdateOwnedAgentMutation,
  useVerifyOtpMutation,
} from "./api/auth-pairing.queries.js";
export {
  AccountSecurityModal,
  type AccountSecurityModalProps,
} from "./components/account-security-modal.js";
export {
  AccountThemeMenu,
  type AccountThemeMenuProps,
} from "./components/account-theme-menu.js";
export {
  AgentOnboardingModal,
  type AgentOnboardingModalProps,
  type OnboardingModalTab,
} from "./components/agent-onboarding-modal.js";
export {
  LOCALE_PREFERENCE_ORDER,
  LocaleMenuGroup,
  LocaleSwitcherMenu,
  type LocaleMenuGroupProps,
  type LocaleSwitcherMenuProps,
} from "./components/locale-switcher-menu.js";
export {
  AuthScreen,
  type AuthScreenProps,
  OtpSignInScreen,
  type PortalMode,
} from "./components/otp-sign-in-screen.js";
