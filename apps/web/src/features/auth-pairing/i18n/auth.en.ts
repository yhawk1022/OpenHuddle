/**
 * @module web/features/auth-pairing/i18n/auth.en
 * @description English catalog for portal header, authentication forms, password strength, auth errors, and authenticated space card.
 */
export const authEn = {
  // Header navigation and actions
  "header.scrollToTopAria": "Scroll to top of OpenHuddle",
  "header.navAria": "Portal sections",
  "header.nav.capabilities": "Features",
  "header.nav.architecture": "Performance",
  "header.nav.openSource": "Open Source",
  "header.installPwaDesktop": "Install",
  "header.installPwaShort": "Install",
  "header.installPwaAria": "Install app to home screen",
  "header.backToApp": "Back to App",
  "header.signInCta": "Sign in",
  "header.switchToLight": "Switch to light mode",
  "header.switchToDark": "Switch to dark mode",

  // Hero heading and subtitle
  "hero.title": "Discuss, ship code, and decide—with all your agents.",
  "hero.subtitle":
    "Connect Claude Code, Codex, Cursor, and more in one step: cross-check ideas in governed huddles and ship code in isolated worktrees.",

  // Authenticated space card (/welcome)
  "spaceCard.signedInBadge": "Signed in",
  "spaceCard.boundAgentsLabel": "Bound personal agents",
  "spaceCard.agentsSummary": "{total} connected · {online} online",
  "spaceCard.agentsEmptyCount": "No agents yet",
  "spaceCard.agentsEmptyHint":
    'Open the workspace and click "Connect Agent" in the left rail to link Claude Code, Codex, or any MCP client.',
  "spaceCard.openChats": "Open Chats",
  "spaceCard.openWorkbench": "Open Workbench",

  // Auth tabs and shared form fields
  "tabs.login": "Sign in",
  "tabs.register": "Sign up",
  "tabs.ariaLabel": "Switch between sign in and sign up",
  "field.email": "Email",
  "field.registeredEmail": "Account email",
  "field.password": "Password",
  "field.setPassword": "Password",
  "field.newPassword": "New password",
  "field.confirmPassword": "Confirm password",
  "field.confirmNewPassword": "Confirm new password",
  "field.emailCode": "6-digit email code",
  "field.displayName": "Display name",
  "field.passwordPlaceholder": "Enter your password",
  "field.minLengthPlaceholder": "At least {min} characters",
  "field.confirmPasswordPlaceholder": "Re-enter password",
  "field.confirmNewPasswordPlaceholder": "Re-enter new password",
  "field.displayNamePlaceholder": "e.g. Alex Chen",
  "field.showPassword": "Show password",
  "field.hidePassword": "Hide password",
  "field.showConfirmPassword": "Show confirm password",
  "field.hideConfirmPassword": "Hide confirm password",

  // Password strength
  "strength.tooShort": "At least {min} chars",
  "strength.strong": "Strength: Strong",
  "strength.medium": "Strength: Medium",
  "strength.weak": "Strength: Weak (mix letters and numbers)",

  // Verification code buttons and notices
  "code.send": "Send code",
  "code.resend": "Resend",
  "code.resendCountdown": "Resend ({sec}s)",
  "code.spamHint": "Didn't receive the code? Check your spam or junk folder.",
  "code.devRegisterLabel": "Dev verification code",
  "code.devResetLabel": "Dev reset code",
  "code.devAutofill": "Autofill",
  "code.resetSentNotice":
    "If this email is registered, a 6-digit reset code has been sent to your inbox.",

  // Sign-in form
  "login.title": "Welcome back",
  "login.subtitle": "Sign in with your email and password to open your OpenHuddle workspace.",
  "login.signupDisabledBanner":
    "Public registration is disabled on this instance. Existing accounts only.",
  "login.forgotPassword": "Forgot password?",
  "login.submit": "Sign in",
  "login.submitting": "Signing in...",
  "login.footerBadge": "Open source · Self-hostable",
  "login.noAccountCta": "New here? Sign up",

  // Sign-up form
  "register.title": "Create your account",
  "register.subtitle": "Verify the 6-digit email code and set a password to get started.",
  "register.allowedDomains": "Registration is restricted to {domains} email addresses",
  "register.domainSeparator": ", ",
  "register.smtpUnavailable":
    "SMTP email delivery is not configured on this server. Verification emails cannot be sent—please contact an administrator.",
  "register.switchToLoginCta": "Sign in with this email",
  "register.submit": "Create account",
  "register.submitting": "Creating account...",

  // Reset-password form
  "reset.backToLogin": "Back to sign in",
  "reset.title": "Reset password",
  "reset.subtitle":
    "Use a 6-digit email code to reset your password—or set one for the first time on legacy accounts.",
  "reset.smtpUnavailable":
    "SMTP email delivery is not configured on this server. Reset emails cannot be sent.",
  "reset.submit": "Reset password & sign in",
  "reset.submitting": "Updating password...",

  // Client-side form validation
  "validation.loginRequired": "Please enter a valid email address and password.",
  "validation.emailFirst": "Please enter a valid email address first.",
  "validation.registeredEmailFirst": "Please enter your registered email address first.",
  "validation.invalidEmail": "Please enter a valid email address.",
  "validation.registerCodeRequired": "Please enter the 6-digit verification code from your email.",
  "validation.resetCodeRequired": "Please enter the 6-digit reset code.",
  "validation.displayNameRequired": "Please enter your display name.",
  "validation.passwordTooShort": "Password must be at least {min} non-whitespace characters.",
  "validation.newPasswordTooShort":
    "New password must be at least {min} non-whitespace characters.",
  "validation.passwordMismatch": "Passwords do not match. Please check again.",
  "validation.newPasswordMismatch": "The two new passwords do not match. Please check again.",
  "validation.passwordSameAsEmail":
    "For security, your password cannot be the same as your email address.",
  "validation.newPasswordSameAsEmail": "New password cannot be the same as your email address.",

  // Server auth errors
  "error.invalidCredentials":
    'Incorrect email or password. For legacy passwordless accounts, click "Forgot password?" to set one.',
  "error.emailAlreadyRegistered":
    "This email is already registered with OpenHuddle. Sign in or reset your password.",
  "error.signupDisabled":
    "Self-registration is disabled on this instance. Contact your administrator for an account.",
  "error.emailDomainNotAllowed":
    "This email domain is not on the allowed list. Please use a supported email address.",
  "error.otpInvalidOrExpired":
    "Verification code is invalid or expired. Check it or request a new one.",
  "error.otpAttemptsExceeded":
    "Too many failed attempts. This code has expired—please request a new one.",
  "error.rateLimitedRetryAfter": "Too many requests. Please try again in {sec}s.",
  "error.rateLimited": "Too many requests. Please try again shortly.",
  "error.accountSuspended": "This account has been suspended by an administrator.",
  "error.emailDeliveryFailed":
    "Failed to send verification email. Check the address or try again shortly.",
  "error.emailDeliveryUnavailable":
    "SMTP email delivery is not configured on this server. Please contact an administrator.",
  "error.internalWithRequestId":
    "Internal server error. Please try again shortly (Request ID: {requestId}).",
  "error.internalGeneric": "Service is temporarily unavailable. Please try again shortly.",
  "error.requestFailed": "Request failed. Please try again.",

  // Toasts
  "toast.welcomeBack": "Welcome back, {name}",
  "toast.devRegisterCodeTitle": "Dev registration code generated",
  "toast.registerCodeSentTitle": "6-digit verification code sent",
  "toast.devCodeDesc": "Click Autofill to insert code {code}",
  "toast.registerCodeSentDesc": "Check {email} (valid for 10 minutes)",
  "toast.registerSuccess": "Account created—welcome to OpenHuddle, {name}!",
  "toast.devResetCodeTitle": "Dev reset code generated",
  "toast.resetCodeSentTitle": "Reset request received",
  "toast.resetCodeSentDesc":
    "If this email is registered, a 6-digit reset code has been sent to your inbox",
  "toast.resetSuccessTitle": "Password reset—you're signed in",
  "toast.resetSuccessDesc": "All other active sessions for this account have been signed out",
  "toast.copyFailed": "Copy failed. Please select and copy manually.",
  "toast.siteUrlCopied": "Site URL copied",
} as const;

export const authPluralEn = {
  "error.otpRemainingAttempts": {
    one: "Verification code is invalid or expired (1 attempt left).",
    other: "Verification code is invalid or expired ({count} attempts left).",
  },
  "code.registerSentNotice": {
    one: "Code sent to {email} (valid for 1 min)",
    other: "Code sent to {email} (valid for {count} mins)",
  },
} as const;
