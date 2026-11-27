/**
 * @module web/features/auth-pairing/otp-sign-in-screen
 * @description OpenHuddle 首页产品门户与认证入口（支持 `/` 未登录认证态与 `/welcome` 已登录/未登录通用介绍态）。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 单一 DOM 树响应式重排：首屏采用 3 块直接子节点的 CSS Grid，窄屏（`< lg`）按「标题导览 → 登录卡片 → 双模预览器」流式排列，保障 `390×844` 首屏免滚直达「登录」按钮；宽屏（`>= lg`）自动归位为左 7（标题 + 预览器）右 5（认证/已登录空间卡）双栏。
 * 2. `/welcome` 双态可达：当 `portalMode === "welcome"` 且当前已登录人类账号时，不强制重定向回 `/`，顶栏展示「返回工作台」，右栏切换为当前已登录空间卡片；未登录完成认证后自动跳转 `/`。
 * 3. 单层模糊光学纪律：顶栏采用轻磨砂 `backdrop-blur-xl`（内部零 `liquid-glass-*`）；首屏认证卡与双模预览器各用单层 `relative liquid-glass-modal`（内部零二次模糊）；首屏下方内容卡片全部采用无模糊分层表面，保障 120Hz 顺滑滚动。
 * 4. 全页单实例 `AppContextMenu`：内容区根据命中目标与选区动态生成菜单；命中原生输入控件时在冒泡阶段 `stopPropagation` 完整放行系统编辑与密码填充菜单。
 */
import {
  type AuthCodeSentResponse,
  type LanguagePreference,
  PASSWORD_MIN_LENGTH,
} from "@openhuddle/protocol";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Eye,
  EyeOff,
  KeyRound,
  ListTodo,
  Lock,
  Mail,
  MessageCircle,
  Moon,
  Send,
  ShieldCheck,
  Smartphone,
  Sun,
  User,
} from "lucide-react";
import {
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
  type UIEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { BrandMark } from "../../../components/brand-mark.js";
import {
  AnimatePresence,
  AppButton,
  AppContextMenu,
  AppInput,
  IconButton,
  type SegmentedTabItem,
  SegmentedTabs,
  cn,
  motion,
  toast,
  usePrefersReducedMotion,
} from "../../../components/primitives/index.js";
import { HuddleConstellationBackground } from "../../../components/ui/huddle-constellation-background.js";
import { PlatformAvatar } from "../../../components/ui/identity-badges.js";
import { ApiClientError, type HumanMeResponseDto } from "../../../lib/api-client.js";
import { isAgentLiveReachable } from "../../../lib/format.js";
import {
  formatApiErrorMessage,
  readGuestLanguagePreference,
  setGuestLanguagePreference,
  useGuestLanguagePreference,
} from "../../../lib/i18n/index.js";
import { navigateBackOr, navigateTo } from "../../../lib/session-store.js";
import { toggleGuestThemePreference, useThemeMode } from "../../../lib/theme-store.js";
import { PwaInstallGuideModal, usePwaInstallState } from "../../pwa-install/index.js";
import {
  authConfigQueryOptions,
  currentMeQueryOptions,
  useAccountLanguagePreference,
  useAccountThemePreference,
  useConfirmPasswordResetMutation,
  useLoginWithPasswordMutation,
  useRegisterWithPasswordMutation,
  useRequestPasswordResetCodeMutation,
  useRequestRegisterCodeMutation,
} from "../api/auth-pairing.queries.js";
import { useAuthI18n } from "../i18n/index.js";
import { AccountThemeMenu } from "./account-theme-menu.js";
import { LocaleSwitcherMenu } from "./locale-switcher-menu.js";
import { PortalArchitectureSection, PortalCapabilitiesSection } from "./portal-feature-sections.js";
import {
  DEFAULT_PORTAL_CONTEXT_HIT,
  type PortalContextHitInfo,
  PortalFooter,
  PortalHeroPreview,
  PortalMobileQuickGuide,
  PortalOpenSourceContactSection,
  buildPortalContextMenuEntries,
  copyPortalText,
  inspectPortalContextTarget,
} from "./portal-showcase-sections.js";
import { PortalStorySection } from "./portal-story-section.js";

const LABEL_CLASS = "block text-xs font-medium text-[#3A3A3C] dark:text-zinc-300";

/** 门户运行模式：`auth` = 未登录入口门禁，`welcome` = 公开/已登录均可浏览的产品介绍页 */
export type PortalMode = "auth" | "welcome";

/** `AuthScreen` 组件入参属性 */
export interface AuthScreenProps {
  readonly portalMode?: PortalMode | undefined;
}

type AuthViewMode = "login" | "register" | "reset";
type PrimaryAuthTab = "login" | "register";
type AuthTranslator = ReturnType<typeof useAuthI18n>;

/**
 * 计算密码强度视觉档位（纯展示提示，不阻塞合规口令）。
 */
function evaluatePasswordStrength(
  password: string,
  t: AuthTranslator["t"],
): {
  readonly level: 0 | 1 | 2 | 3;
  readonly label: string;
  readonly barClass: string;
  readonly textClass: string;
} {
  if (password.length === 0) {
    return { level: 0, label: "", barClass: "", textClass: "" };
  }
  if (password.length < PASSWORD_MIN_LENGTH) {
    return {
      level: 1,
      label: t("strength.tooShort", { min: PASSWORD_MIN_LENGTH }),
      barClass: "bg-[#FF3B30] dark:bg-[#FF453A]",
      textClass: "text-[#D70015] dark:text-[#FF6961]",
    };
  }
  let score = 0;
  if (password.length >= 12) score += 1;
  if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score += 1;
  if (/\d/.test(password)) score += 1;
  if (/[^a-zA-Z0-9\s]/.test(password)) score += 1;

  if (score >= 3) {
    return {
      level: 3,
      label: t("strength.strong"),
      barClass: "bg-[#2A7B59] dark:bg-[#34D399]",
      textClass: "text-[#1E5638] dark:text-[#86E0A6]",
    };
  }
  if (score >= 1) {
    return {
      level: 2,
      label: t("strength.medium"),
      barClass: "bg-[#D97706] dark:bg-[#FBBF24]",
      textClass: "text-[#92400E] dark:text-[#FCD34D]",
    };
  }
  return {
    level: 1,
    label: t("strength.weak"),
    barClass: "bg-[#FF3B30] dark:bg-[#FF453A]",
    textClass: "text-[#D70015] dark:text-[#FF6961]",
  };
}

/**
 * 提取错误详情对象中的指定正整数字段（零 `any` 类型收窄）。
 */
function readNumericDetail(details: unknown, key: string): number | undefined {
  if (typeof details !== "object" || details === null) {
    return undefined;
  }
  const value = (details as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * 将后端标准 `ApiClientError` 错误码翻译为清晰、可行动的双语界面提示。
 */
function formatAuthError(
  error: unknown,
  authI18n: AuthTranslator,
): {
  readonly text: string;
  readonly suggestSwitchToLogin?: boolean;
} | null {
  if (!error) {
    return null;
  }
  const { t, tp, locale } = authI18n;
  if (error instanceof ApiClientError) {
    switch (error.code) {
      case "INVALID_CREDENTIALS":
        return { text: t("error.invalidCredentials") };
      case "EMAIL_ALREADY_REGISTERED":
        return {
          text: t("error.emailAlreadyRegistered"),
          suggestSwitchToLogin: true,
        };
      case "SIGNUP_DISABLED":
        return { text: t("error.signupDisabled") };
      case "EMAIL_DOMAIN_NOT_ALLOWED":
        return { text: t("error.emailDomainNotAllowed") };
      case "OTP_INVALID_OR_EXPIRED": {
        const remaining = readNumericDetail(error.details, "remainingAttempts");
        return {
          text:
            remaining !== undefined && remaining > 0
              ? tp("error.otpRemainingAttempts", remaining)
              : t("error.otpInvalidOrExpired"),
        };
      }
      case "OTP_ATTEMPTS_EXCEEDED":
        return { text: t("error.otpAttemptsExceeded") };
      case "AUTH_RATE_LIMITED": {
        const retryAfter = readNumericDetail(error.details, "retryAfterSec");
        return {
          text:
            retryAfter !== undefined
              ? t("error.rateLimitedRetryAfter", { sec: retryAfter })
              : t("error.rateLimited"),
        };
      }
      case "ACCOUNT_SUSPENDED":
        return { text: t("error.accountSuspended") };
      case "EMAIL_DELIVERY_FAILED":
        return { text: t("error.emailDeliveryFailed") };
      case "EMAIL_DELIVERY_UNAVAILABLE":
        return { text: t("error.emailDeliveryUnavailable") };
      case "INTERNAL_SERVER_ERROR":
        if (
          error.requestId === "gateway" ||
          error.requestId === "network" ||
          error.requestId === "timeout"
        ) {
          return { text: error.message };
        }
        return {
          text:
            error.requestId && error.requestId !== "unknown"
              ? t("error.internalWithRequestId", { requestId: error.requestId })
              : t("error.internalGeneric"),
        };
      default:
        return {
          text: `${formatApiErrorMessage(error.code, error.message, locale)} (${error.code})`,
        };
    }
  }
  return error instanceof Error ? { text: error.message } : { text: t("error.requestFailed") };
}

/**
 * 渲染简洁的 3 格密码强度指示条。
 */
function PasswordStrengthMeter(props: { readonly password: string }) {
  const { t } = useAuthI18n();
  const strength = evaluatePasswordStrength(props.password, t);
  if (strength.level === 0) {
    return null;
  }
  return (
    <div className="mt-1.5 space-y-1">
      <div className="grid grid-cols-3 gap-1.5" aria-hidden="true">
        {[1, 2, 3].map((segment) => (
          <span
            key={segment}
            className={cn(
              "h-1 rounded-full transition-colors duration-200",
              strength.level >= segment
                ? strength.barClass
                : "bg-black/[0.08] dark:bg-white/[0.10]",
            )}
          />
        ))}
      </div>
      <p className={cn("text-[11px] font-medium", strength.textClass)}>{strength.label}</p>
    </div>
  );
}

/**
 * 已登录状态下访问 `/welcome` 时展示的当前协作空间概览卡片。
 */
function AuthenticatedPortalSpaceCard(props: { readonly me: HumanMeResponseDto }) {
  const { t } = useAuthI18n();
  const { user, agents } = props.me;
  const onlineCount = agents.filter((agent) => isAgentLiveReachable(agent.reach)).length;
  const previewAgents = agents.slice(0, 5);

  return (
    <div className="relative liquid-glass-modal overflow-hidden rounded-[24px] p-5 sm:rounded-[28px] sm:p-7 dark:bg-[#16171C]/[0.78]">
      <div className="flex items-center gap-3.5">
        <PlatformAvatar kind="human" displayName={user.displayName} size="lg" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-[18px] font-semibold tracking-[-0.02em] text-[#111318] sm:text-[20px] dark:text-[#F2F2F4]">
              {user.displayName}
            </h2>
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-[#E3F3EC] px-2 py-0.5 text-[11px] font-medium text-[#1E5638] dark:bg-[#16271F] dark:text-[#86E0A6]">
              <span className="h-1.5 w-1.5 rounded-full bg-[#16A34A] dark:bg-[#34D399]" />
              <span>{t("spaceCard.signedInBadge")}</span>
            </span>
          </div>
          <p className="mt-0.5 truncate text-[12.5px] text-[#687082] dark:text-[#8E8E96]">
            {user.email}
          </p>
        </div>
      </div>

      {/* 已连接 Agent 数量摘要槽（暗色底严格 #141417） */}
      <div className="mt-4 rounded-[16px] border border-black/[0.06] bg-[#EFF1F4] px-3.5 py-3 dark:border-white/[0.07] dark:bg-[#141417]">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[12px] font-medium text-[#4B5565] dark:text-[#A1A1AA]">
            {t("spaceCard.boundAgentsLabel")}
          </span>
          <span className="font-mono text-[12px] font-semibold tabular-nums text-[#111318] dark:text-[#F2F2F4]">
            {agents.length > 0
              ? t("spaceCard.agentsSummary", { total: agents.length, online: onlineCount })
              : t("spaceCard.agentsEmptyCount")}
          </span>
        </div>

        {previewAgents.length > 0 ? (
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            {previewAgents.map((agent) => (
              <span
                key={agent.id}
                className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-black/[0.05] bg-white/85 py-0.5 pl-1 pr-2.5 text-[11.5px] font-medium text-[#1F2430] dark:border-white/[0.08] dark:bg-[#1E1F24] dark:text-[#E4E4E7]"
              >
                <PlatformAvatar
                  kind="agent"
                  displayName={agent.displayName}
                  platform={agent.platform}
                  reach={agent.reach}
                  size="xs"
                />
                <span className="truncate">{agent.displayName}</span>
              </span>
            ))}
            {agents.length > previewAgents.length ? (
              <span className="px-1.5 font-mono text-[11px] text-[#687082] dark:text-[#8E8E96]">
                +{String(agents.length - previewAgents.length)}
              </span>
            ) : null}
          </div>
        ) : (
          <p className="mt-1.5 text-[12px] leading-relaxed text-[#5A6272] dark:text-[#8E8E96]">
            {t("spaceCard.agentsEmptyHint")}
          </p>
        )}
      </div>

      <div className="mt-5 space-y-2.5">
        <AppButton
          variant="primary"
          size="lg"
          fullWidth={true}
          leadingIcon={<MessageCircle aria-hidden="true" className="h-4 w-4" />}
          trailingIcon={<ArrowRight aria-hidden="true" className="h-4 w-4" />}
          onClick={() => navigateTo("/")}
          className="h-10.5 rounded-full text-[14px] font-medium sm:h-11"
        >
          {t("spaceCard.openChats")}
        </AppButton>

        <AppButton
          variant="secondary"
          size="lg"
          fullWidth={true}
          leadingIcon={<ListTodo aria-hidden="true" className="h-4 w-4" />}
          onClick={() => navigateTo("/?view=workbench")}
          className="h-10.5 rounded-full text-[13.5px] font-medium sm:h-11"
        >
          {t("spaceCard.openWorkbench")}
        </AppButton>
      </div>
    </div>
  );
}

/**
 * 渲染 OpenHuddle 首页产品门户与三态认证入口。
 *
 * @param props - 可选 `portalMode`（`"auth"` 或 `"welcome"`）
 * @returns 完整响应式门户与认证/已登录空间视图
 */
export function AuthScreen(props: AuthScreenProps) {
  const portalMode: PortalMode = props.portalMode ?? "auth";
  const authI18n = useAuthI18n();
  const { t, tp, locale } = authI18n;

  const authConfigQuery = useQuery(authConfigQueryOptions());
  const welcomeMeQuery = useQuery({
    ...currentMeQueryOptions(),
    enabled: portalMode === "welcome",
  });

  const authenticatedMe: HumanMeResponseDto | null =
    portalMode === "welcome" &&
    !welcomeMeQuery.isError &&
    welcomeMeQuery.data !== null &&
    welcomeMeQuery.data !== undefined &&
    welcomeMeQuery.data.callerKind === "human"
      ? welcomeMeQuery.data
      : null;
  const isAuthenticatedWelcome = authenticatedMe !== null;

  const allowPublicSignup = authConfigQuery.data?.allowPublicSignup ?? true;
  const allowedEmailDomains = authConfigQuery.data?.allowedEmailDomains ?? [];
  const emailDeliveryMode = authConfigQuery.data?.emailDeliveryMode ?? "smtp";

  const [mode, setMode] = useState<AuthViewMode>("login");

  // 共享邮箱字段，在登录 / 注册 / 找回密码间无缝保留输入
  const [email, setEmail] = useState<string>("");
  const [password, setPassword] = useState<string>("");
  const [confirmPassword, setConfirmPassword] = useState<string>("");
  const [displayName, setDisplayName] = useState<string>("");
  const [verificationCode, setVerificationCode] = useState<string>("");

  const [showPassword, setShowPassword] = useState<boolean>(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState<boolean>(false);

  const [registerCodeMeta, setRegisterCodeMeta] = useState<AuthCodeSentResponse | null>(null);
  const [resetCodeMeta, setResetCodeMeta] = useState<AuthCodeSentResponse | null>(null);
  const [registerCooldownSec, setRegisterCooldownSec] = useState<number>(0);
  const [resetCooldownSec, setResetCooldownSec] = useState<number>(0);
  const [localValidationError, setLocalValidationError] = useState<string | null>(null);

  const [showScrollLoginCta, setShowScrollLoginCta] = useState<boolean>(false);
  const [pwaGuideOpen, setPwaGuideOpen] = useState<boolean>(false);
  const [contextHit, setContextHit] = useState<PortalContextHitInfo>(DEFAULT_PORTAL_CONTEXT_HIT);

  const mainScrollRef = useRef<HTMLElement | null>(null);
  const emailInputRef = useRef<HTMLInputElement | null>(null);

  const loginMutation = useLoginWithPasswordMutation();
  const requestRegisterCodeMutation = useRequestRegisterCodeMutation();
  const registerMutation = useRegisterWithPasswordMutation();
  const requestResetCodeMutation = useRequestPasswordResetCodeMutation();
  const confirmResetMutation = useConfirmPasswordResetMutation();

  const themeMode = useThemeMode();
  const accountTheme = useAccountThemePreference();
  const accountLanguage = useAccountLanguagePreference();
  const guestLanguagePreference = useGuestLanguagePreference();
  const activeLanguagePreference = isAuthenticatedWelcome
    ? accountLanguage.preference
    : guestLanguagePreference;
  const pwaState = usePwaInstallState();
  const reducedMotion = usePrefersReducedMotion();

  const authTabItems = useMemo<ReadonlyArray<SegmentedTabItem<PrimaryAuthTab>>>(
    () => [
      { value: "login", label: t("tabs.login") },
      { value: "register", label: t("tabs.register") },
    ],
    [t],
  );

  const headerNavItems = useMemo(
    () =>
      [
        { targetId: "portal-capabilities", label: t("header.nav.capabilities") },
        { targetId: "portal-architecture", label: t("header.nav.architecture") },
        { targetId: "portal-open-source", label: t("header.nav.openSource") },
      ] as const,
    [t],
  );

  // 冷却倒计时器：每秒递减直至归零
  const hasActiveCooldown = registerCooldownSec > 0 || resetCooldownSec > 0;
  useEffect(() => {
    if (!hasActiveCooldown) {
      return undefined;
    }
    const timer = window.setInterval(() => {
      setRegisterCooldownSec((prev) => (prev > 0 ? prev - 1 : 0));
      setResetCooldownSec((prev) => (prev > 0 ? prev - 1 : 0));
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [hasActiveCooldown]);

  // 若管理员配置关闭自助注册且当前恰好停留在注册态，自动切回登录
  useEffect(() => {
    if (!allowPublicSignup && mode === "register") {
      setMode("login");
    }
  }, [allowPublicSignup, mode]);

  const navigateFromWelcomeAfterAuth = (): void => {
    if (typeof window !== "undefined" && /^\/welcome(\/|$)/.test(window.location.pathname)) {
      navigateTo("/", { replace: true });
    }
  };

  const scrollToTop = useCallback((): void => {
    mainScrollRef.current?.scrollTo({
      top: 0,
      behavior: reducedMotion ? "auto" : "smooth",
    });
  }, [reducedMotion]);

  const scrollToSection = useCallback(
    (sectionId: string): void => {
      if (typeof document === "undefined") {
        return;
      }
      const target = document.getElementById(sectionId);
      if (!target) {
        return;
      }
      target.scrollIntoView({
        behavior: reducedMotion ? "auto" : "smooth",
        block: "start",
      });
    },
    [reducedMotion],
  );

  const handleJumpToAuthOrReturn = useCallback((): void => {
    if (isAuthenticatedWelcome) {
      navigateBackOr("/");
      return;
    }
    scrollToTop();
    emailInputRef.current?.focus({ preventScroll: true });
  }, [isAuthenticatedWelcome, scrollToTop]);

  const handleMainScroll = (event: UIEvent<HTMLElement>): void => {
    const scrolledPastHero = event.currentTarget.scrollTop > 420;
    setShowScrollLoginCta((prev) => (prev === scrolledPastHero ? prev : scrolledPastHero));
  };

  const handleTogglePortalTheme = useCallback((): void => {
    if (isAuthenticatedWelcome) {
      accountTheme.setPreference(themeMode === "dark" ? "light" : "dark");
    } else {
      toggleGuestThemePreference();
    }
  }, [accountTheme, isAuthenticatedWelcome, themeMode]);

  const handleSelectPortalLanguage = useCallback(
    (nextPreference: LanguagePreference): void => {
      if (isAuthenticatedWelcome) {
        accountLanguage.setPreference(nextPreference);
      } else {
        setGuestLanguagePreference(nextPreference);
      }
    },
    [accountLanguage, isAuthenticatedWelcome],
  );

  const trimmedEmail = email.trim().toLowerCase();
  const trimmedDisplayName = displayName.trim();
  const isEmailShapeValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail);

  const switchMode = (nextMode: AuthViewMode): void => {
    if (nextMode === "register" && !allowPublicSignup) {
      return;
    }
    setMode(nextMode);
    setLocalValidationError(null);
    setPassword("");
    setConfirmPassword("");
    setVerificationCode("");
    setShowPassword(false);
    setShowConfirmPassword(false);
    loginMutation.reset();
    requestRegisterCodeMutation.reset();
    registerMutation.reset();
    requestResetCodeMutation.reset();
    confirmResetMutation.reset();
  };

  /* ── 1. 登录提交 ── */
  const handleLoginSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setLocalValidationError(null);
    if (!isEmailShapeValid || password.length === 0) {
      setLocalValidationError(t("validation.loginRequired"));
      return;
    }
    loginMutation.mutate(
      { email: trimmedEmail, password },
      {
        onSuccess: (res) => {
          toast.success(t("toast.welcomeBack", { name: res.user.displayName }));
          navigateFromWelcomeAfterAuth();
        },
      },
    );
  };

  /* ── 2. 注册验证码发送 & 注册提交 ── */
  const handleSendRegisterCode = (): void => {
    setLocalValidationError(null);
    registerMutation.reset();
    if (!isEmailShapeValid) {
      setLocalValidationError(t("validation.emailFirst"));
      return;
    }
    requestRegisterCodeMutation.mutate(
      { email: trimmedEmail },
      {
        onSuccess: (res) => {
          setRegisterCodeMeta(res);
          setRegisterCooldownSec(res.resendCooldownSec);
          toast.success(
            res.devOtpCode !== undefined
              ? t("toast.devRegisterCodeTitle")
              : t("toast.registerCodeSentTitle"),
            {
              description:
                res.devOtpCode !== undefined
                  ? t("toast.devCodeDesc", { code: res.devOtpCode })
                  : t("toast.registerCodeSentDesc", { email: res.email }),
            },
          );
        },
        onError: (err) => {
          if (err instanceof ApiClientError && err.code === "AUTH_RATE_LIMITED") {
            const retryAfter = readNumericDetail(err.details, "retryAfterSec");
            if (retryAfter !== undefined && retryAfter > 0) {
              setRegisterCooldownSec(retryAfter);
            }
          }
        },
      },
    );
  };

  const handleRegisterSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setLocalValidationError(null);
    if (!isEmailShapeValid) {
      setLocalValidationError(t("validation.invalidEmail"));
      return;
    }
    if (!/^\d{6}$/.test(verificationCode)) {
      setLocalValidationError(t("validation.registerCodeRequired"));
      return;
    }
    if (trimmedDisplayName.length === 0) {
      setLocalValidationError(t("validation.displayNameRequired"));
      return;
    }
    if (password.length < PASSWORD_MIN_LENGTH || !/\S/.test(password)) {
      setLocalValidationError(t("validation.passwordTooShort", { min: PASSWORD_MIN_LENGTH }));
      return;
    }
    if (password !== confirmPassword) {
      setLocalValidationError(t("validation.passwordMismatch"));
      return;
    }
    if (password.trim().toLowerCase() === trimmedEmail) {
      setLocalValidationError(t("validation.passwordSameAsEmail"));
      return;
    }

    registerMutation.mutate(
      {
        email: trimmedEmail,
        code: verificationCode,
        displayName: trimmedDisplayName,
        password,
        languagePreference: readGuestLanguagePreference(),
      },
      {
        onSuccess: (res) => {
          toast.success(t("toast.registerSuccess", { name: res.user.displayName }));
          navigateFromWelcomeAfterAuth();
        },
      },
    );
  };

  /* ── 3. 重置密码验证码发送 & 确认重置 ── */
  const handleSendResetCode = (): void => {
    setLocalValidationError(null);
    confirmResetMutation.reset();
    if (!isEmailShapeValid) {
      setLocalValidationError(t("validation.registeredEmailFirst"));
      return;
    }
    requestResetCodeMutation.mutate(
      { email: trimmedEmail },
      {
        onSuccess: (res) => {
          setResetCodeMeta(res);
          setResetCooldownSec(res.resendCooldownSec);
          toast.success(
            res.devOtpCode !== undefined
              ? t("toast.devResetCodeTitle")
              : t("toast.resetCodeSentTitle"),
            {
              description:
                res.devOtpCode !== undefined
                  ? t("toast.devCodeDesc", { code: res.devOtpCode })
                  : t("toast.resetCodeSentDesc"),
            },
          );
        },
        onError: (err) => {
          if (err instanceof ApiClientError && err.code === "AUTH_RATE_LIMITED") {
            const retryAfter = readNumericDetail(err.details, "retryAfterSec");
            if (retryAfter !== undefined && retryAfter > 0) {
              setResetCooldownSec(retryAfter);
            }
          }
        },
      },
    );
  };

  const handleResetSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setLocalValidationError(null);
    if (!isEmailShapeValid) {
      setLocalValidationError(t("validation.invalidEmail"));
      return;
    }
    if (!/^\d{6}$/.test(verificationCode)) {
      setLocalValidationError(t("validation.resetCodeRequired"));
      return;
    }
    if (password.length < PASSWORD_MIN_LENGTH || !/\S/.test(password)) {
      setLocalValidationError(t("validation.newPasswordTooShort", { min: PASSWORD_MIN_LENGTH }));
      return;
    }
    if (password !== confirmPassword) {
      setLocalValidationError(t("validation.newPasswordMismatch"));
      return;
    }
    if (password.trim().toLowerCase() === trimmedEmail) {
      setLocalValidationError(t("validation.newPasswordSameAsEmail"));
      return;
    }

    confirmResetMutation.mutate(
      {
        email: trimmedEmail,
        code: verificationCode,
        newPassword: password,
      },
      {
        onSuccess: () => {
          toast.success(t("toast.resetSuccessTitle"), {
            description: t("toast.resetSuccessDesc"),
          });
          navigateFromWelcomeAfterAuth();
        },
      },
    );
  };

  const activeServerError =
    mode === "login"
      ? loginMutation.error
      : mode === "register"
        ? (registerMutation.error ?? requestRegisterCodeMutation.error)
        : (confirmResetMutation.error ?? requestResetCodeMutation.error);

  const formattedError =
    localValidationError !== null
      ? { text: localValidationError }
      : formatAuthError(activeServerError, authI18n);

  const passwordToggleButton = (
    <button
      type="button"
      tabIndex={-1}
      onClick={() => setShowPassword((prev) => !prev)}
      aria-label={showPassword ? t("field.hidePassword") : t("field.showPassword")}
      className="cursor-pointer rounded-md p-1 text-[#8E8E93] transition-colors hover:text-[#141414] dark:text-zinc-500 dark:hover:text-zinc-200"
    >
      {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
    </button>
  );

  const confirmPasswordToggleButton = (
    <button
      type="button"
      tabIndex={-1}
      onClick={() => setShowConfirmPassword((prev) => !prev)}
      aria-label={
        showConfirmPassword ? t("field.hideConfirmPassword") : t("field.showConfirmPassword")
      }
      className="cursor-pointer rounded-md p-1 text-[#8E8E93] transition-colors hover:text-[#141414] dark:text-zinc-500 dark:hover:text-zinc-200"
    >
      {showConfirmPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
    </button>
  );

  const activeDevOtpMeta = mode === "register" ? registerCodeMeta : resetCodeMeta;

  /* ── 全页单实例右键菜单构建 ── */
  const handleCopyFromMenu = useCallback(
    (text: string, successTitle: string, description?: string | undefined): void => {
      void copyPortalText(text).then((ok) => {
        if (ok) {
          toast.success(successTitle, description !== undefined ? { description } : undefined);
        } else {
          toast.error(t("toast.copyFailed"));
        }
      });
    },
    [t],
  );

  const contextMenuEntries = useMemo(
    () =>
      buildPortalContextMenuEntries(
        contextHit.isEditableInput ? DEFAULT_PORTAL_CONTEXT_HIT : contextHit,
        {
          isAuthenticatedWelcome,
          isDarkTheme: themeMode === "dark",
          languagePreference: activeLanguagePreference,
          locale,
          onSelectLanguage: handleSelectPortalLanguage,
          onCopyText: handleCopyFromMenu,
          onOpenMailClient: (targetEmail) => {
            if (typeof window !== "undefined") {
              window.location.href = `mailto:${targetEmail}`;
            }
          },
          onOpenExternalLink: (href) => {
            if (typeof window !== "undefined") {
              window.open(href, "_blank", "noopener,noreferrer");
            }
          },
          onPrimaryAuthOrReturn: handleJumpToAuthOrReturn,
          onScrollToPreview: () => scrollToSection("portal-preview"),
          onScrollToCapabilities: () => scrollToSection("portal-capabilities"),
          onToggleTheme: handleTogglePortalTheme,
          onCopySiteUrl: () => {
            const url = typeof window !== "undefined" ? window.location.origin : "";
            if (url.length > 0) {
              handleCopyFromMenu(url, t("toast.siteUrlCopied"), url);
            }
          },
        },
      ),
    [
      activeLanguagePreference,
      contextHit,
      handleCopyFromMenu,
      handleJumpToAuthOrReturn,
      handleSelectPortalLanguage,
      handleTogglePortalTheme,
      isAuthenticatedWelcome,
      locale,
      scrollToSection,
      t,
      themeMode,
    ],
  );

  const handleContextMenuCapture = (event: ReactMouseEvent<HTMLDivElement>): void => {
    const nextHit = inspectPortalContextTarget(event.target);
    if (!nextHit.isEditableInput) {
      setContextHit(nextHit);
    }
  };

  const handleBubbleEditableGuard = (event: ReactMouseEvent<HTMLElement>): void => {
    const hit = inspectPortalContextTarget(event.target);
    if (hit.isEditableInput) {
      event.stopPropagation();
    }
  };

  const hasSecondaryHeaderCta = isAuthenticatedWelcome || showScrollLoginCta;

  return (
    // 全局 body 已锁定滚动，背景和内部滚动区域均由本屏独立托管（高度随 visualViewport 动态收缩以适配软键盘）。
    <div className="relative isolate flex h-vvh flex-col overflow-hidden bg-app-frame text-im-fg dark:bg-[#0E0F13]">
      <HuddleConstellationBackground />

      {/* 单层轻磨砂顶栏（内部严禁出现任何 liquid-glass-*） */}
      <header
        data-tauri-drag-region=""
        className="app-drag-region pt-safe relative z-20 shrink-0 select-none border-b border-black/[0.05] bg-app-frame/85 backdrop-blur-xl dark:border-white/[0.06] dark:bg-[#0E0F13]/85"
      >
        <div className="mx-auto flex w-full max-w-[1200px] items-center justify-between gap-2 px-4 py-2.5 sm:gap-3 sm:px-6 sm:py-3 lg:px-10">
          <button
            type="button"
            onClick={scrollToTop}
            aria-label={t("header.scrollToTopAria")}
            className="app-no-drag inline-flex shrink-0 cursor-pointer items-center gap-2.5 rounded-xl py-0.5 text-left transition-opacity hover:opacity-85"
          >
            <BrandMark className="h-6 w-6 shrink-0" />
            <span className="text-[17px] font-bold tracking-[-0.025em] text-[#111318] sm:text-[17.5px] dark:text-white">
              OpenHuddle
            </span>
          </button>

          <nav
            aria-label={t("header.navAria")}
            className="app-no-drag hidden items-center gap-1 md:flex"
          >
            {headerNavItems.map((item) => (
              <button
                key={item.targetId}
                type="button"
                onClick={() => scrollToSection(item.targetId)}
                className="shrink-0 cursor-pointer whitespace-nowrap rounded-full px-3 py-1.5 text-[13px] font-medium text-[#4B5565] transition-colors hover:bg-black/[0.045] hover:text-[#111318] dark:text-[#A1A1AA] dark:hover:bg-white/[0.07] dark:hover:text-white"
              >
                {item.label}
              </button>
            ))}
          </nav>

          <div className="app-no-drag flex shrink-0 items-center gap-1.5">
            {pwaState.shouldShowSmartBanner ? (
              <button
                type="button"
                onClick={() => setPwaGuideOpen(true)}
                aria-label={t("header.installPwaAria")}
                title={t("header.installPwaAria")}
                className={cn(
                  "inline-flex shrink-0 cursor-pointer items-center justify-center gap-1 whitespace-nowrap rounded-full bg-black/[0.05] text-xs font-medium text-[#3B414E] transition hover:bg-black/[0.09] dark:bg-white/[0.08] dark:text-[#D4D4D8] dark:hover:bg-white/[0.14]",
                  hasSecondaryHeaderCta ? "h-7 w-7 px-0 sm:h-8 sm:w-auto sm:px-2.5" : "h-8 px-2.5",
                )}
              >
                <Smartphone aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
                {hasSecondaryHeaderCta ? (
                  <span className="hidden sm:inline">{t("header.installPwaDesktop")}</span>
                ) : (
                  <>
                    <span className="hidden sm:inline">{t("header.installPwaDesktop")}</span>
                    <span className="sm:hidden">{t("header.installPwaShort")}</span>
                  </>
                )}
              </button>
            ) : null}

            {isAuthenticatedWelcome ? (
              <AppButton
                variant="primary"
                size="sm"
                leadingIcon={<ArrowLeft aria-hidden="true" className="h-3.5 w-3.5" />}
                onClick={() => navigateBackOr("/")}
              >
                {t("header.backToApp")}
              </AppButton>
            ) : showScrollLoginCta ? (
              <AppButton variant="primary" size="sm" onClick={handleJumpToAuthOrReturn}>
                {t("header.signInCta")}
              </AppButton>
            ) : null}

            {isAuthenticatedWelcome ? (
              <AccountThemeMenu align="end" />
            ) : (
              <>
                <LocaleSwitcherMenu align="end" />
                <IconButton
                  size="sm"
                  variant="ghost"
                  label={
                    themeMode === "dark" ? t("header.switchToLight") : t("header.switchToDark")
                  }
                  onClick={toggleGuestThemePreference}
                >
                  {themeMode === "dark" ? (
                    <Sun aria-hidden="true" className="h-4 w-4" />
                  ) : (
                    <Moon aria-hidden="true" className="h-4 w-4" />
                  )}
                </IconButton>
              </>
            )}
          </div>
        </div>
      </header>

      {/* 全页单实例右键菜单包裹内容主滚动区 */}
      <AppContextMenu items={contextMenuEntries}>
        <main
          ref={mainScrollRef}
          data-portal-scroller=""
          onScroll={handleMainScroll}
          onContextMenuCapture={handleContextMenuCapture}
          className="pb-safe relative z-10 min-h-0 flex-1 overflow-y-auto overscroll-contain"
        >
          {/* 内部冒泡守卫：命中 input / textarea 等控件时阻断事件到达 Radix Trigger，100% 保留浏览器原生编辑与密码填充菜单 */}
          <div
            onContextMenu={handleBubbleEditableGuard}
            className="mx-auto flex w-full max-w-[1200px] flex-col gap-12 px-4 pt-3.5 pb-10 sm:gap-16 sm:px-6 sm:pt-7 sm:pb-14 lg:gap-20 lg:px-10 lg:pt-9"
          >
            {/* 首屏区（#portal-hero）：单一 DOM 树 3 子块响应式重排 */}
            <section
              id="portal-hero"
              className="shrink-0 grid grid-cols-1 gap-4 sm:gap-6 lg:grid-cols-12 lg:items-start lg:gap-x-10 lg:gap-y-7 xl:gap-x-14"
            >
              {/* 块 A：主副标题 + <lg 快捷导览胶囊条 */}
              <div className="min-w-0 lg:col-span-7 lg:col-start-1 lg:row-start-1">
                <motion.div
                  initial={reducedMotion ? false : { opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ type: "spring", stiffness: 380, damping: 32 }}
                >
                  <h1 className="text-balance text-[25px] font-semibold leading-[1.18] tracking-[-0.03em] text-[#111318] sm:text-[40px] sm:leading-[1.14] xl:text-[46px] xl:leading-[1.12] dark:text-[#F2F2F4]">
                    {t("hero.title")}
                  </h1>
                  <p className="mt-2 max-w-xl text-pretty text-[13px] leading-[1.52] text-[#525A6B] sm:mt-3.5 sm:text-[15.5px] sm:leading-[1.62] dark:text-[#A5A7B2]">
                    {t("hero.subtitle")}
                  </p>
                </motion.div>

                <PortalMobileQuickGuide
                  onScrollToPreview={() => scrollToSection("portal-preview")}
                  onScrollToContact={() => scrollToSection("portal-contact")}
                />
              </div>

              {/* 块 B：认证卡片 或 当前已登录空间卡片（移动端紧随标题下方，确保 390×844 首屏直达「登录」主按钮） */}
              <div className="mx-auto w-full max-w-md min-w-0 lg:col-span-5 lg:col-start-8 lg:row-span-2 lg:row-start-1 lg:max-w-none">
                <motion.div
                  initial={reducedMotion ? false : { opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ type: "spring", stiffness: 400, damping: 32, delay: 0.04 }}
                >
                  {authenticatedMe !== null ? (
                    <AuthenticatedPortalSpaceCard me={authenticatedMe} />
                  ) : (
                    <div className="relative liquid-glass-modal overflow-hidden rounded-[24px] p-5 sm:rounded-[28px] sm:p-7 dark:bg-[#16171C]/[0.78]">
                      {/* 登录 / 注册顶部分段切换器（仅非重置密码态且开放注册时展示） */}
                      {mode !== "reset" && allowPublicSignup ? (
                        <div className="mb-4 sm:mb-5">
                          <SegmentedTabs<PrimaryAuthTab>
                            value={mode}
                            onValueChange={(next) => switchMode(next)}
                            items={authTabItems}
                            size="md"
                            fullWidth={true}
                            ariaLabel={t("tabs.ariaLabel")}
                          />
                        </div>
                      ) : null}

                      <AnimatePresence mode="wait" initial={false}>
                        {mode === "login" ? (
                          <motion.form
                            key="auth-login"
                            initial={reducedMotion ? false : { opacity: 0, x: -10 }}
                            animate={{ opacity: 1, x: 0 }}
                            exit={reducedMotion ? { opacity: 0 } : { opacity: 0, x: -10 }}
                            transition={{ duration: 0.16, ease: "easeOut" }}
                            onSubmit={handleLoginSubmit}
                            className="space-y-3.5 sm:space-y-4.5"
                          >
                            <div className="select-none">
                              <h2 className="text-[19px] font-semibold tracking-[-0.02em] text-[#141414] sm:text-[22px] dark:text-zinc-100">
                                {t("login.title")}
                              </h2>
                              <p className="mt-1 text-[12.5px] leading-snug text-[#6E6E73] sm:mt-1.5 sm:text-[13px] sm:leading-relaxed dark:text-zinc-400">
                                {t("login.subtitle")}
                              </p>
                            </div>

                            {!allowPublicSignup ? (
                              <div className="rounded-2xl bg-im-surface-muted px-3.5 py-2.5 text-[12px] leading-relaxed text-im-muted dark:bg-white/[0.05] dark:text-zinc-400">
                                {t("login.signupDisabledBanner")}
                              </div>
                            ) : null}

                            <div className="space-y-3 sm:space-y-3.5">
                              <div>
                                <label htmlFor="auth-login-email" className={LABEL_CLASS}>
                                  {t("field.email")}
                                </label>
                                <AppInput
                                  ref={emailInputRef}
                                  id="auth-login-email"
                                  type="email"
                                  inputMode="email"
                                  enterKeyHint="next"
                                  size="lg"
                                  required={true}
                                  autoComplete="email"
                                  value={email}
                                  onChange={(e) => {
                                    setEmail(e.target.value);
                                    setLocalValidationError(null);
                                  }}
                                  leadingIcon={<Mail className="h-4 w-4" />}
                                  placeholder="you@example.com"
                                  containerClassName="mt-1 sm:mt-1.5"
                                />
                              </div>

                              <div>
                                <div className="flex items-center justify-between gap-2">
                                  <label htmlFor="auth-login-password" className={LABEL_CLASS}>
                                    {t("field.password")}
                                  </label>
                                  <button
                                    type="button"
                                    onClick={() => switchMode("reset")}
                                    className="cursor-pointer text-[12px] font-medium text-[#6E6E73] transition-colors hover:text-[#141414] dark:text-zinc-400 dark:hover:text-zinc-100"
                                  >
                                    {t("login.forgotPassword")}
                                  </button>
                                </div>
                                <AppInput
                                  id="auth-login-password"
                                  type={showPassword ? "text" : "password"}
                                  enterKeyHint="go"
                                  size="lg"
                                  required={true}
                                  autoComplete="current-password"
                                  value={password}
                                  onChange={(e) => {
                                    setPassword(e.target.value);
                                    setLocalValidationError(null);
                                  }}
                                  leadingIcon={<Lock className="h-4 w-4" />}
                                  trailingSlot={passwordToggleButton}
                                  placeholder={t("field.passwordPlaceholder")}
                                  containerClassName="mt-1 sm:mt-1.5"
                                />
                              </div>
                            </div>

                            {formattedError ? (
                              <div
                                role="alert"
                                className="rounded-2xl border border-[#FF3B30]/25 bg-[#FF3B30]/[0.07] px-3.5 py-2.5 text-xs leading-relaxed text-[#D70015] dark:bg-[#FF453A]/12 dark:text-[#FF6961]"
                              >
                                {formattedError.text}
                              </div>
                            ) : null}

                            <AppButton
                              type="submit"
                              variant="primary"
                              size="lg"
                              fullWidth={true}
                              isLoading={loginMutation.isPending}
                              disabled={!isEmailShapeValid || password.length === 0}
                              className="h-10.5 rounded-full text-[14px] font-medium sm:h-11"
                              trailingIcon={
                                !loginMutation.isPending ? (
                                  <ArrowRight aria-hidden="true" className="h-4 w-4" />
                                ) : undefined
                              }
                            >
                              {loginMutation.isPending ? t("login.submitting") : t("login.submit")}
                            </AppButton>

                            <div className="flex select-none items-center justify-between gap-2 pt-0.5 text-[12px] text-[#8E8E93] dark:text-zinc-500">
                              <span>{t("login.footerBadge")}</span>
                              {allowPublicSignup ? (
                                <button
                                  type="button"
                                  onClick={() => switchMode("register")}
                                  className="cursor-pointer font-medium text-[#141414] underline-offset-4 hover:underline dark:text-zinc-200"
                                >
                                  {t("login.noAccountCta")}
                                </button>
                              ) : null}
                            </div>
                          </motion.form>
                        ) : mode === "register" ? (
                          <motion.form
                            key="auth-register"
                            initial={reducedMotion ? false : { opacity: 0, x: 10 }}
                            animate={{ opacity: 1, x: 0 }}
                            exit={reducedMotion ? { opacity: 0 } : { opacity: 0, x: 10 }}
                            transition={{ duration: 0.16, ease: "easeOut" }}
                            onSubmit={handleRegisterSubmit}
                            className="space-y-3.5 sm:space-y-4"
                          >
                            <div className="select-none">
                              <h2 className="text-[19px] font-semibold tracking-[-0.02em] text-[#141414] sm:text-[22px] dark:text-zinc-100">
                                {t("register.title")}
                              </h2>
                              <p className="mt-1 text-[12.5px] leading-relaxed text-[#6E6E73] sm:text-[13px] dark:text-zinc-400">
                                {t("register.subtitle")}
                              </p>
                            </div>

                            {allowedEmailDomains.length > 0 ? (
                              <div className="flex items-start gap-2 rounded-2xl bg-im-surface-muted px-3.5 py-2 text-[12px] leading-relaxed text-[#52525B] dark:bg-white/[0.05] dark:text-zinc-300">
                                <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#2A7B59] dark:text-[#5ED3A2]" />
                                <span>
                                  {t("register.allowedDomains", {
                                    domains: allowedEmailDomains
                                      .map((domain) => `@${domain}`)
                                      .join(t("register.domainSeparator")),
                                  })}
                                </span>
                              </div>
                            ) : null}

                            {emailDeliveryMode === "unavailable" ? (
                              <div className="flex items-start gap-2 rounded-2xl border border-[#D97706]/30 bg-[#FEF3C7]/70 px-3.5 py-2.5 text-[12px] leading-relaxed text-[#92400E] dark:border-[#F59E0B]/25 dark:bg-[#451A03]/35 dark:text-[#FCD34D]">
                                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                                <span>{t("register.smtpUnavailable")}</span>
                              </div>
                            ) : null}

                            <div className="space-y-3">
                              <div>
                                <label htmlFor="auth-reg-email" className={LABEL_CLASS}>
                                  {t("field.email")}
                                </label>
                                <div className="mt-1.5 flex flex-col gap-2 sm:flex-row sm:items-center">
                                  <AppInput
                                    ref={emailInputRef}
                                    id="auth-reg-email"
                                    type="email"
                                    inputMode="email"
                                    enterKeyHint="next"
                                    size="lg"
                                    required={true}
                                    autoComplete="email"
                                    value={email}
                                    onChange={(e) => {
                                      setEmail(e.target.value);
                                      setLocalValidationError(null);
                                    }}
                                    leadingIcon={<Mail className="h-4 w-4" />}
                                    placeholder="you@example.com"
                                    containerClassName="w-full sm:min-w-0 sm:flex-1"
                                  />
                                  <AppButton
                                    type="button"
                                    variant="secondary"
                                    size="lg"
                                    isLoading={requestRegisterCodeMutation.isPending}
                                    disabled={
                                      !isEmailShapeValid ||
                                      registerCooldownSec > 0 ||
                                      emailDeliveryMode === "unavailable"
                                    }
                                    onClick={handleSendRegisterCode}
                                    leadingIcon={
                                      !requestRegisterCodeMutation.isPending &&
                                      registerCooldownSec === 0 ? (
                                        <Send className="h-3.5 w-3.5" />
                                      ) : undefined
                                    }
                                    className="h-10 w-full shrink-0 justify-center rounded-xl px-3.5 text-xs font-medium whitespace-nowrap sm:w-auto"
                                  >
                                    {registerCooldownSec > 0
                                      ? t("code.resendCountdown", { sec: registerCooldownSec })
                                      : registerCodeMeta
                                        ? t("code.resend")
                                        : t("code.send")}
                                  </AppButton>
                                </div>
                                <p
                                  id="auth-reg-code-hint"
                                  className="mt-1.5 text-[12px] leading-relaxed text-[#6E6E73] dark:text-zinc-400"
                                >
                                  {t("code.spamHint")}
                                </p>
                              </div>

                              {/* 发送成功回执（真实 SMTP 或开发模式快捷码） */}
                              {activeDevOtpMeta ? (
                                activeDevOtpMeta.devOtpCode !== undefined ? (
                                  <div className="select-none rounded-2xl bg-[#E3F3EC] px-3.5 py-2.5 ring-1 ring-inset ring-black/[0.05] dark:bg-[#16271F] dark:ring-white/[0.08]">
                                    <div className="flex items-center justify-between gap-2">
                                      <span className="text-[11.5px] font-medium text-[#1E5638] dark:text-[#86E0A6]">
                                        {t("code.devRegisterLabel")}
                                      </span>
                                      <div className="flex items-center gap-2">
                                        <code className="rounded-md bg-white/90 px-2 py-0.5 font-mono text-xs font-semibold tracking-widest text-[#141414] ring-1 ring-black/[0.06] dark:bg-black/30 dark:text-zinc-100 dark:ring-white/[0.1]">
                                          {activeDevOtpMeta.devOtpCode}
                                        </code>
                                        <button
                                          type="button"
                                          onClick={() =>
                                            setVerificationCode(activeDevOtpMeta.devOtpCode ?? "")
                                          }
                                          className="cursor-pointer rounded-full bg-[#141414] px-2.5 py-1 text-[11px] font-medium text-white transition hover:opacity-85 dark:bg-white dark:text-[#141414]"
                                        >
                                          {t("code.devAutofill")}
                                        </button>
                                      </div>
                                    </div>
                                  </div>
                                ) : (
                                  <p className="flex items-center gap-1.5 rounded-xl bg-[#E3F3EC]/80 px-3 py-2 text-[12px] text-[#1E5638] dark:bg-[#16271F] dark:text-[#86E0A6]">
                                    <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                                    <span>
                                      {tp(
                                        "code.registerSentNotice",
                                        Math.max(1, Math.round(activeDevOtpMeta.expiresInSec / 60)),
                                        { email: activeDevOtpMeta.email },
                                      )}
                                    </span>
                                  </p>
                                )
                              ) : null}

                              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                                <div>
                                  <label htmlFor="auth-reg-code" className={LABEL_CLASS}>
                                    {t("field.emailCode")}
                                  </label>
                                  <AppInput
                                    id="auth-reg-code"
                                    aria-describedby="auth-reg-code-hint"
                                    type="text"
                                    size="lg"
                                    inputMode="numeric"
                                    autoComplete="one-time-code"
                                    maxLength={6}
                                    required={true}
                                    value={verificationCode}
                                    onChange={(e) => {
                                      setVerificationCode(
                                        e.target.value.replace(/\D/g, "").slice(0, 6),
                                      );
                                      setLocalValidationError(null);
                                    }}
                                    leadingIcon={<KeyRound className="h-4 w-4" />}
                                    placeholder="000000"
                                    className="font-mono tracking-[0.22em] placeholder:tracking-[0.22em]"
                                    containerClassName="mt-1.5"
                                  />
                                </div>

                                <div>
                                  <label htmlFor="auth-reg-name" className={LABEL_CLASS}>
                                    {t("field.displayName")}
                                  </label>
                                  <AppInput
                                    id="auth-reg-name"
                                    type="text"
                                    size="lg"
                                    maxLength={80}
                                    required={true}
                                    autoComplete="name"
                                    value={displayName}
                                    onChange={(e) => {
                                      setDisplayName(e.target.value);
                                      setLocalValidationError(null);
                                    }}
                                    leadingIcon={<User className="h-4 w-4" />}
                                    placeholder={t("field.displayNamePlaceholder")}
                                    containerClassName="mt-1.5"
                                  />
                                </div>
                              </div>

                              <div>
                                <label htmlFor="auth-reg-password" className={LABEL_CLASS}>
                                  {t("field.setPassword")}
                                </label>
                                <AppInput
                                  id="auth-reg-password"
                                  type={showPassword ? "text" : "password"}
                                  size="lg"
                                  required={true}
                                  minLength={PASSWORD_MIN_LENGTH}
                                  autoComplete="new-password"
                                  value={password}
                                  onChange={(e) => {
                                    setPassword(e.target.value);
                                    setLocalValidationError(null);
                                  }}
                                  leadingIcon={<Lock className="h-4 w-4" />}
                                  trailingSlot={passwordToggleButton}
                                  placeholder={t("field.minLengthPlaceholder", {
                                    min: PASSWORD_MIN_LENGTH,
                                  })}
                                  containerClassName="mt-1.5"
                                />
                                <PasswordStrengthMeter password={password} />
                              </div>

                              <div>
                                <label htmlFor="auth-reg-password-confirm" className={LABEL_CLASS}>
                                  {t("field.confirmPassword")}
                                </label>
                                <AppInput
                                  id="auth-reg-password-confirm"
                                  type={showConfirmPassword ? "text" : "password"}
                                  size="lg"
                                  required={true}
                                  autoComplete="new-password"
                                  value={confirmPassword}
                                  invalid={
                                    confirmPassword.length > 0 && confirmPassword !== password
                                  }
                                  onChange={(e) => {
                                    setConfirmPassword(e.target.value);
                                    setLocalValidationError(null);
                                  }}
                                  leadingIcon={<Lock className="h-4 w-4" />}
                                  trailingSlot={confirmPasswordToggleButton}
                                  placeholder={t("field.confirmPasswordPlaceholder")}
                                  containerClassName="mt-1.5"
                                />
                              </div>
                            </div>

                            {formattedError ? (
                              <div
                                role="alert"
                                className="rounded-2xl border border-[#FF3B30]/25 bg-[#FF3B30]/[0.07] px-3.5 py-2.5 text-xs leading-relaxed text-[#D70015] dark:bg-[#FF453A]/12 dark:text-[#FF6961]"
                              >
                                <p>{formattedError.text}</p>
                                {formattedError.suggestSwitchToLogin ? (
                                  <button
                                    type="button"
                                    onClick={() => switchMode("login")}
                                    className="mt-1.5 inline-flex cursor-pointer items-center gap-1 font-semibold underline underline-offset-2"
                                  >
                                    <span>{t("register.switchToLoginCta")}</span>
                                    <ArrowRight aria-hidden="true" className="h-3 w-3" />
                                  </button>
                                ) : null}
                              </div>
                            ) : null}

                            <AppButton
                              type="submit"
                              variant="primary"
                              size="lg"
                              fullWidth={true}
                              isLoading={registerMutation.isPending}
                              disabled={
                                !isEmailShapeValid ||
                                verificationCode.length !== 6 ||
                                trimmedDisplayName.length === 0 ||
                                password.length < PASSWORD_MIN_LENGTH ||
                                confirmPassword !== password
                              }
                              className="h-10.5 rounded-full text-[14px] font-medium sm:h-11"
                              trailingIcon={
                                !registerMutation.isPending ? (
                                  <ArrowRight aria-hidden="true" className="h-4 w-4" />
                                ) : undefined
                              }
                            >
                              {registerMutation.isPending
                                ? t("register.submitting")
                                : t("register.submit")}
                            </AppButton>
                          </motion.form>
                        ) : (
                          <motion.form
                            key="auth-reset"
                            initial={reducedMotion ? false : { opacity: 0, x: 10 }}
                            animate={{ opacity: 1, x: 0 }}
                            exit={reducedMotion ? { opacity: 0 } : { opacity: 0, x: 10 }}
                            transition={{ duration: 0.16, ease: "easeOut" }}
                            onSubmit={handleResetSubmit}
                            className="space-y-3.5 sm:space-y-4"
                          >
                            <div className="select-none">
                              <AppButton
                                type="button"
                                variant="ghost"
                                size="xs"
                                leadingIcon={
                                  <ArrowLeft aria-hidden="true" className="h-3.5 w-3.5" />
                                }
                                onClick={() => switchMode("login")}
                                className="-ml-2.5"
                              >
                                {t("reset.backToLogin")}
                              </AppButton>
                              <h2 className="mt-2 text-[19px] font-semibold tracking-[-0.02em] text-[#141414] sm:text-[22px] dark:text-zinc-100">
                                {t("reset.title")}
                              </h2>
                              <p className="mt-1 text-[12.5px] leading-relaxed text-[#6E6E73] sm:text-[13px] dark:text-zinc-400">
                                {t("reset.subtitle")}
                              </p>
                            </div>

                            {emailDeliveryMode === "unavailable" ? (
                              <div className="flex items-start gap-2 rounded-2xl border border-[#D97706]/30 bg-[#FEF3C7]/70 px-3.5 py-2.5 text-[12px] leading-relaxed text-[#92400E] dark:border-[#F59E0B]/25 dark:bg-[#451A03]/35 dark:text-[#FCD34D]">
                                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                                <span>{t("reset.smtpUnavailable")}</span>
                              </div>
                            ) : null}

                            <div className="space-y-3">
                              <div>
                                <label htmlFor="auth-reset-email" className={LABEL_CLASS}>
                                  {t("field.registeredEmail")}
                                </label>
                                <div className="mt-1.5 flex flex-col gap-2 sm:flex-row sm:items-center">
                                  <AppInput
                                    ref={emailInputRef}
                                    id="auth-reset-email"
                                    type="email"
                                    inputMode="email"
                                    enterKeyHint="next"
                                    size="lg"
                                    required={true}
                                    autoComplete="email"
                                    value={email}
                                    onChange={(e) => {
                                      setEmail(e.target.value);
                                      setLocalValidationError(null);
                                    }}
                                    leadingIcon={<Mail className="h-4 w-4" />}
                                    placeholder="you@example.com"
                                    containerClassName="w-full sm:min-w-0 sm:flex-1"
                                  />
                                  <AppButton
                                    type="button"
                                    variant="secondary"
                                    size="lg"
                                    isLoading={requestResetCodeMutation.isPending}
                                    disabled={
                                      !isEmailShapeValid ||
                                      resetCooldownSec > 0 ||
                                      emailDeliveryMode === "unavailable"
                                    }
                                    onClick={handleSendResetCode}
                                    leadingIcon={
                                      !requestResetCodeMutation.isPending &&
                                      resetCooldownSec === 0 ? (
                                        <Send className="h-3.5 w-3.5" />
                                      ) : undefined
                                    }
                                    className="h-10 w-full shrink-0 justify-center rounded-xl px-3.5 text-xs font-medium whitespace-nowrap sm:w-auto"
                                  >
                                    {resetCooldownSec > 0
                                      ? t("code.resendCountdown", { sec: resetCooldownSec })
                                      : resetCodeMeta
                                        ? t("code.resend")
                                        : t("code.send")}
                                  </AppButton>
                                </div>
                              </div>

                              {activeDevOtpMeta ? (
                                activeDevOtpMeta.devOtpCode !== undefined ? (
                                  <div className="select-none rounded-2xl bg-[#E3F3EC] px-3.5 py-2.5 ring-1 ring-inset ring-black/[0.05] dark:bg-[#16271F] dark:ring-white/[0.08]">
                                    <div className="flex items-center justify-between gap-2">
                                      <span className="text-[11.5px] font-medium text-[#1E5638] dark:text-[#86E0A6]">
                                        {t("code.devResetLabel")}
                                      </span>
                                      <div className="flex items-center gap-2">
                                        <code className="rounded-md bg-white/90 px-2 py-0.5 font-mono text-xs font-semibold tracking-widest text-[#141414] ring-1 ring-black/[0.06] dark:bg-black/30 dark:text-zinc-100 dark:ring-white/[0.1]">
                                          {activeDevOtpMeta.devOtpCode}
                                        </code>
                                        <button
                                          type="button"
                                          onClick={() =>
                                            setVerificationCode(activeDevOtpMeta.devOtpCode ?? "")
                                          }
                                          className="cursor-pointer rounded-full bg-[#141414] px-2.5 py-1 text-[11px] font-medium text-white transition hover:opacity-85 dark:bg-white dark:text-[#141414]"
                                        >
                                          {t("code.devAutofill")}
                                        </button>
                                      </div>
                                    </div>
                                  </div>
                                ) : (
                                  <p className="flex items-center gap-1.5 rounded-xl bg-[#E3F3EC]/80 px-3 py-2 text-[12px] text-[#1E5638] dark:bg-[#16271F] dark:text-[#86E0A6]">
                                    <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                                    <span>{t("code.resetSentNotice")}</span>
                                  </p>
                                )
                              ) : null}

                              <div>
                                <label htmlFor="auth-reset-code" className={LABEL_CLASS}>
                                  {t("field.emailCode")}
                                </label>
                                <AppInput
                                  id="auth-reset-code"
                                  type="text"
                                  size="lg"
                                  inputMode="numeric"
                                  autoComplete="one-time-code"
                                  maxLength={6}
                                  required={true}
                                  value={verificationCode}
                                  onChange={(e) => {
                                    setVerificationCode(
                                      e.target.value.replace(/\D/g, "").slice(0, 6),
                                    );
                                    setLocalValidationError(null);
                                  }}
                                  leadingIcon={<KeyRound className="h-4 w-4" />}
                                  placeholder="000000"
                                  className="font-mono tracking-[0.28em] placeholder:tracking-[0.28em]"
                                  containerClassName="mt-1.5"
                                />
                              </div>

                              <div>
                                <label htmlFor="auth-reset-password" className={LABEL_CLASS}>
                                  {t("field.newPassword")}
                                </label>
                                <AppInput
                                  id="auth-reset-password"
                                  type={showPassword ? "text" : "password"}
                                  size="lg"
                                  required={true}
                                  minLength={PASSWORD_MIN_LENGTH}
                                  autoComplete="new-password"
                                  value={password}
                                  onChange={(e) => {
                                    setPassword(e.target.value);
                                    setLocalValidationError(null);
                                  }}
                                  leadingIcon={<Lock className="h-4 w-4" />}
                                  trailingSlot={passwordToggleButton}
                                  placeholder={t("field.minLengthPlaceholder", {
                                    min: PASSWORD_MIN_LENGTH,
                                  })}
                                  containerClassName="mt-1.5"
                                />
                                <PasswordStrengthMeter password={password} />
                              </div>

                              <div>
                                <label
                                  htmlFor="auth-reset-password-confirm"
                                  className={LABEL_CLASS}
                                >
                                  {t("field.confirmNewPassword")}
                                </label>
                                <AppInput
                                  id="auth-reset-password-confirm"
                                  type={showConfirmPassword ? "text" : "password"}
                                  size="lg"
                                  required={true}
                                  autoComplete="new-password"
                                  value={confirmPassword}
                                  invalid={
                                    confirmPassword.length > 0 && confirmPassword !== password
                                  }
                                  onChange={(e) => {
                                    setConfirmPassword(e.target.value);
                                    setLocalValidationError(null);
                                  }}
                                  leadingIcon={<Lock className="h-4 w-4" />}
                                  trailingSlot={confirmPasswordToggleButton}
                                  placeholder={t("field.confirmNewPasswordPlaceholder")}
                                  containerClassName="mt-1.5"
                                />
                              </div>
                            </div>

                            {formattedError ? (
                              <div
                                role="alert"
                                className="rounded-2xl border border-[#FF3B30]/25 bg-[#FF3B30]/[0.07] px-3.5 py-2.5 text-xs leading-relaxed text-[#D70015] dark:bg-[#FF453A]/12 dark:text-[#FF6961]"
                              >
                                {formattedError.text}
                              </div>
                            ) : null}

                            <AppButton
                              type="submit"
                              variant="primary"
                              size="lg"
                              fullWidth={true}
                              isLoading={confirmResetMutation.isPending}
                              disabled={
                                !isEmailShapeValid ||
                                verificationCode.length !== 6 ||
                                password.length < PASSWORD_MIN_LENGTH ||
                                confirmPassword !== password
                              }
                              className="h-10.5 rounded-full text-[14px] font-medium sm:h-11"
                              trailingIcon={
                                !confirmResetMutation.isPending ? (
                                  <ArrowRight aria-hidden="true" className="h-4 w-4" />
                                ) : undefined
                              }
                            >
                              {confirmResetMutation.isPending
                                ? t("reset.submitting")
                                : t("reset.submit")}
                            </AppButton>
                          </motion.form>
                        )}
                      </AnimatePresence>
                    </div>
                  )}
                </motion.div>
              </div>

              {/* 块 C：双模实景预览器（全视口断点可达，不再在 <lg 隐藏） */}
              <div
                id="portal-preview"
                className="mx-auto w-full max-w-2xl min-w-0 scroll-mt-4 lg:col-span-7 lg:col-start-1 lg:row-start-2 lg:max-w-none"
              >
                <motion.div
                  initial={reducedMotion ? false : { opacity: 0, y: 14 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ type: "spring", stiffness: 360, damping: 32, delay: 0.06 }}
                >
                  <PortalHeroPreview />
                </motion.div>
              </div>
            </section>

            {/* 滚动剧场：整节钉住，随滚动演绎「连通 → 讨论 → 提案 → 拍板」 */}
            <PortalStorySection />

            {/* 首屏下方三大门户分区 */}
            <PortalCapabilitiesSection />

            <PortalArchitectureSection onOpenPwaGuide={() => setPwaGuideOpen(true)} />

            <PortalOpenSourceContactSection
              isAuthenticatedWelcome={isAuthenticatedWelcome}
              onPrimaryAuthOrReturn={handleJumpToAuthOrReturn}
            />

            <PortalFooter onScrollToTop={scrollToTop} />
          </div>
        </main>
      </AppContextMenu>

      <PwaInstallGuideModal open={pwaGuideOpen} onClose={() => setPwaGuideOpen(false)} />
    </div>
  );
}

/**
 * 向后兼容旧导出名（指向升级后的 `AuthScreen` 首页门户与认证入口）。
 */
export const OtpSignInScreen = AuthScreen;
