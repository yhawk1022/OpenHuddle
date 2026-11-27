/**
 * @module web/lib/i18n/messages/errors.en
 * @description English error catalog covering all protocol `ErrorCode` values and client transport errors.
 */
export const errorsEn = {
  "code.VALIDATION_ERROR": "Invalid input. Please check your entries and try again.",
  "code.UNAUTHORIZED": "Your session has expired. Please sign in again.",
  "code.INVALID_CREDENTIALS": "Incorrect email or password. Please try again.",
  "code.EMAIL_ALREADY_REGISTERED":
    "This email is already registered. Sign in or reset your password instead.",
  "code.SIGNUP_DISABLED": "Public registration is currently disabled on this instance.",
  "code.EMAIL_DOMAIN_NOT_ALLOWED": "This email domain is not permitted for registration.",
  "code.OTP_INVALID_OR_EXPIRED":
    "Verification code is invalid or expired. Please request a new one.",
  "code.OTP_ATTEMPTS_EXCEEDED": "Too many verification attempts. Please request a new code.",
  "code.AUTH_RATE_LIMITED": "Too many requests. Please wait a moment and try again.",
  "code.EMAIL_DELIVERY_FAILED": "Failed to send verification email. Please try again shortly.",
  "code.EMAIL_DELIVERY_UNAVAILABLE":
    "Email delivery is not configured on this server and cannot send verification codes.",
  "code.FORBIDDEN_NOT_OWNER": "Only the owner can perform this action.",
  "code.FORBIDDEN_NOT_ROOM_MEMBER": "You are not a member of this room.",
  "code.FORBIDDEN_NOT_FRIENDS": "You need to be friends before performing this action.",
  "code.FORBIDDEN_EXTERNAL_AGENT_DM_DISABLED":
    "This agent does not allow external direct messages.",
  "code.FORBIDDEN_ADMIN_ONLY": "Administrator permissions are required for this action.",
  "code.ACCOUNT_SUSPENDED": "Your account has been suspended. Please contact an administrator.",
  "code.ADMIN_GUARDRAIL_VIOLATION": "This action was blocked by an administrator safety guardrail.",
  "code.CANNOT_FRIEND_SELF": "You cannot add yourself as a friend.",
  "code.DIRECT_ROOM_IMMUTABLE_ROSTER": "Direct chat membership cannot be modified.",
  "code.NOT_FOUND": "The requested resource was not found or has been removed.",
  "code.PAIRING_CODE_INVALID_OR_EXPIRED":
    "Pairing code is invalid or expired. Please generate a new one.",
  "code.AGENT_ALREADY_ACTIVE": "This agent is already connected and active.",
  "code.CONFLICT_UNREAD_MESSAGES":
    "There are new unread messages in this room. Review them before sending.",
  "code.GOVERNANCE_BUDGET_PAUSED":
    "Consecutive agent turns are paused. A human message is needed to resume.",
  "code.GOVERNANCE_COOLDOWN_ACTIVE": "Cooldown is active. Please wait before trying again.",
  "code.GOVERNANCE_ROUND_TABLE_WAIT": "Round-table mode is waiting for other participants first.",
  "code.MESSAGE_RECALL_WINDOW_EXPIRED": "Messages can only be recalled within 2 minutes.",
  "code.ATTENTION_HUMAN_ONLY": "Only human participants can send or resolve attention messages.",
  "code.FORBIDDEN_WORKSPACE_ACCESS": "You do not have permission to access this workspace.",
  "code.WORK_PATH_CONFLICT":
    "Target paths conflict with another active work slice. Adjust the scope and retry.",
  "code.WORK_LEASE_EXPIRED": "Execution lease expired; this slice may have been reassigned.",
  "code.WORK_INVALID_TRANSITION": "This transition is not allowed from the current task state.",
  "code.INTERNAL_SERVER_ERROR": "An unexpected server error occurred. Please try again later.",

  "network.timeout":
    "Request timed out after {seconds}s. Please check your connection and try again.",
  "network.failed": "Network request failed. Please check your connection.",
  "network.backendUnavailable":
    "Service is starting up or temporarily unavailable (HTTP {status}). Please try again shortly.",
  "network.httpFailed": "Request failed (HTTP {status}).",
} as const;
