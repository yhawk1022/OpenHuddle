/**
 * @module web/features/auth-pairing
 * @description `auth-pairing` 业务特性域统一公共导出入口（遵循单向导入铁律，禁止跨特性深层私引）。
 */
export {
  authConfigQueryOptions,
  currentMeQueryOptions,
  useChangePasswordMutation,
  useConfirmPasswordResetMutation,
  useAccountThemePreference,
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
export { AccountThemeMenu } from "./components/account-theme-menu.js";
export {
  AgentOnboardingModal,
  type AgentOnboardingModalProps,
  type OnboardingModalTab,
} from "./components/agent-onboarding-modal.js";
export {
  AuthScreen,
  type AuthScreenProps,
  OtpSignInScreen,
  type PortalMode,
} from "./components/otp-sign-in-screen.js";
