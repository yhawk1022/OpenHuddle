/**
 * @module web/features/auth-pairing
 * @description `auth-pairing` 业务特性域统一公共导出入口（遵循单向导入铁律，禁止跨特性深层私引）。
 */
export {
  currentMeQueryOptions,
  useCreatePairingCodeMutation,
  useLogoutMutation,
  useRequestOtpMutation,
  useRoomShareVisibilityMutation,
  useVerifyOtpMutation,
} from "./api/auth-pairing.queries.js";
export {
  AgentOnboardingModal,
  type AgentOnboardingModalProps,
  type OnboardingModalTab,
} from "./components/agent-onboarding-modal.js";
export { OtpSignInScreen } from "./components/otp-sign-in-screen.js";
