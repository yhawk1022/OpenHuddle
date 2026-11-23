/**
 * @module web/features/auth-pairing/otp-sign-in-screen
 * @description Pachat 社论极简风格双栏认证入口（左侧 `Figtree` 大字号群聊实况卡片预览 + 右侧邮箱密码登录 / 邮箱验证码激活注册 / 忘记密码重置三态卡片）。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 服务端能力自发现：挂载时查询 `/api/v1/auth/config`（零密钥），自动适配 `allowPublicSignup` 开关、`allowedEmailDomains` 提示、邮件投递模式与重发冷却秒数。
 * 2. 纯邮箱+密码主流程：注册必须通过邮箱 6 位验证码核验后方可创建账号；日常登录仅需邮箱+密码；忘记密码通过邮箱 6 位验证码安全重设（同时兼容早期无密码老用户首次设密）。
 * 3. 开发零摩擦闭环：当服务端未配置 SMTP 且处于开发/测试回退态返回 `devOtpCode` 时，渲染鼠尾草绿快捷填入卡片，支持一键填入验证码。
 * 4. 全屏星点背景在表单和预览卡下方绘制，支持系统减少动态效果设置，且不会拦截交互。
 * 5. Tauri v2 + Electron 双栖窗口壳：`html/body` 已被全局锁定 `overflow: hidden`，本屏自身使用 `h-dvh` + 内部滚动容器；顶部栏声明 `data-tauri-drag-region` 与 `.app-drag-region`。
 */
import { type AuthCodeSentResponse, PASSWORD_MIN_LENGTH } from "@openhuddle/protocol";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Eye,
  EyeOff,
  KeyRound,
  Lock,
  Mail,
  Send,
  ShieldCheck,
  User,
} from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { BrandMark } from "../../../components/brand-mark.js";
import {
  AnimatePresence,
  AppButton,
  AppInput,
  type SegmentedTabItem,
  SegmentedTabs,
  cn,
  motion,
  toast,
} from "../../../components/primitives/index.js";
import { HuddleConstellationBackground } from "../../../components/ui/huddle-constellation-background.js";
import { ThemeToggle } from "../../../components/ui/theme-toggle.js";
import { ApiClientError } from "../../../lib/api-client.js";
import {
  authConfigQueryOptions,
  useConfirmPasswordResetMutation,
  useLoginWithPasswordMutation,
  useRegisterWithPasswordMutation,
  useRequestPasswordResetCodeMutation,
  useRequestRegisterCodeMutation,
} from "../api/auth-pairing.queries.js";

const LABEL_CLASS = "block text-xs font-medium text-[#3A3A3C] dark:text-zinc-300";

type AuthViewMode = "login" | "register" | "reset";
type PrimaryAuthTab = "login" | "register";

const AUTH_TAB_ITEMS: ReadonlyArray<SegmentedTabItem<PrimaryAuthTab>> = [
  { value: "login", label: "登录" },
  { value: "register", label: "注册账号" },
];

/** 群聊预览中单条 Agent 气泡的静态展示数据 */
interface PreviewAgentBubble {
  readonly key: string;
  readonly monogram: string;
  readonly name: string;
  readonly ownerNote: string;
  readonly avatarClass: string;
  readonly text: string;
  readonly time: string;
}

/** 左侧 Pachat 风格群聊预览中的个人 Agent 发言（纯静态演示数据，零网络请求） */
const PREVIEW_AGENT_BUBBLES: ReadonlyArray<PreviewAgentBubble> = [
  {
    key: "claude",
    monogram: "CC",
    name: "Claude Code",
    ownerNote: "Alex 的 Agent",
    avatarClass:
      "bg-[#F4ECDD] text-[#4A351B] ring-1 ring-inset ring-black/[0.06] dark:bg-[#2B251D] dark:text-[#EAD8BC] dark:ring-white/[0.08]",
    text: "直接用 Postgres LISTEN/NOTIFY 就够了，2C4G 机器可以少维护一个 Redis 实例。",
    time: "10:42",
  },
  {
    key: "codex",
    monogram: "CX",
    name: "Codex",
    ownerNote: "庞彦的 Agent",
    avatarClass:
      "bg-[#E1ECFF] text-[#1E3A66] ring-1 ring-inset ring-black/[0.06] dark:bg-[#1B2433] dark:text-[#CFE1FF] dark:ring-white/[0.08]",
    text: "同意。补充一个边界：NOTIFY 单条上限 8KB，只推最新序号让客户端按需拉取最稳妥。",
    time: "10:43",
  },
];

/**
 * 计算密码强度视觉档位（纯展示提示，不阻塞合规口令）。
 */
function evaluatePasswordStrength(password: string): {
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
      label: `至少 ${PASSWORD_MIN_LENGTH} 位`,
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
      label: "强度：强",
      barClass: "bg-[#2A7B59] dark:bg-[#34D399]",
      textClass: "text-[#1E5638] dark:text-[#86E0A6]",
    };
  }
  if (score >= 1) {
    return {
      level: 2,
      label: "强度：中",
      barClass: "bg-[#D97706] dark:bg-[#FBBF24]",
      textClass: "text-[#92400E] dark:text-[#FCD34D]",
    };
  }
  return {
    level: 1,
    label: "强度：弱（建议混合字母与数字）",
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
 * 将后端标准 `ApiClientError` 错误码翻译为清晰、可行动的中文界面提示。
 */
function formatAuthError(error: unknown): {
  readonly text: string;
  readonly suggestSwitchToLogin?: boolean;
} | null {
  if (!error) {
    return null;
  }
  if (error instanceof ApiClientError) {
    switch (error.code) {
      case "INVALID_CREDENTIALS":
        return {
          text: "邮箱或密码不正确。如果你是早期无密码老用户，请点击「忘记密码」设置登录密码。",
        };
      case "EMAIL_ALREADY_REGISTERED":
        return {
          text: "该邮箱已注册 OpenHuddle 账号，请直接登录或使用忘记密码。",
          suggestSwitchToLogin: true,
        };
      case "SIGNUP_DISABLED":
        return {
          text: "当前实例已关闭自助注册，请联系站点管理员开通账号。",
        };
      case "EMAIL_DOMAIN_NOT_ALLOWED":
        return {
          text: "该邮箱域名不在允许注册的白名单范围内，请更换受支持的邮箱。",
        };
      case "OTP_INVALID_OR_EXPIRED": {
        const remaining = readNumericDetail(error.details, "remainingAttempts");
        return {
          text:
            remaining !== undefined && remaining > 0
              ? `验证码不正确或已过期（本码还可重试 ${remaining} 次）。`
              : "验证码不正确或已过期，请核对后重试或重新获取。",
        };
      }
      case "OTP_ATTEMPTS_EXCEEDED":
        return {
          text: "该验证码连续输错次数过多已作废，请重新点击发送验证码。",
        };
      case "AUTH_RATE_LIMITED": {
        const retryAfter = readNumericDetail(error.details, "retryAfterSec");
        return {
          text:
            retryAfter !== undefined
              ? `操作过于频繁，请 ${retryAfter} 秒后再试。`
              : "操作过于频繁，请稍后再试。",
        };
      }
      case "ACCOUNT_SUSPENDED":
        return {
          text: "该账号已被管理员停用，无法继续登录。",
        };
      case "EMAIL_DELIVERY_FAILED":
        return {
          text: "验证邮件发送失败，请检查邮箱地址是否正确或稍后重试。",
        };
      case "EMAIL_DELIVERY_UNAVAILABLE":
        return {
          text: "服务器尚未配置 SMTP 发信服务，暂无法发送邮箱验证码，请联系管理员。",
        };
      default:
        return { text: `${error.message} (${error.code})` };
    }
  }
  return error instanceof Error ? { text: error.message } : { text: "请求失败，请稍后重试。" };
}

/**
 * 渲染左侧无极光光斑、纯净纸感的 Pachat 群聊实况预览卡片。
 */
function LiveHuddlePreview() {
  return (
    <motion.div
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", stiffness: 360, damping: 32, delay: 0.05 }}
      className="relative liquid-glass-modal select-none overflow-hidden rounded-[28px] bg-white/[0.72] dark:bg-[#16171C]/[0.74]"
    >
      {/* 卡片顶部群聊头：圆角方标 + 群标题 + 实时在线圆点 */}
      <div className="flex items-center justify-between gap-3 border-b border-black/[0.06] px-5 py-3.5 dark:border-white/[0.07]">
        <div className="flex min-w-0 items-center gap-3">
          <div
            aria-hidden="true"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[12px] bg-[#DCE8FC] text-[14px] font-semibold text-[#1D3E78] shadow-[inset_0_1px_0_rgba(255,255,255,0.75)] ring-1 ring-inset ring-white/80 dark:bg-[#222938] dark:text-[#B8D0FA] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.10)] dark:ring-white/[0.08]"
          >
            实
          </div>
          <div className="min-w-0">
            <p className="truncate text-[14px] font-semibold tracking-[-0.01em] text-[#111318] dark:text-[#F2F2F4]">
              实时同步方案讨论
            </p>
            <p className="flex items-center gap-1.5 text-[11.5px] text-[#687082] dark:text-[#8E8E96]">
              <span className="h-1.5 w-1.5 rounded-full bg-[#16A34A] dark:bg-[#34D399]" />
              <span>2 位成员 · 2 个 Agent 在线</span>
            </p>
          </div>
        </div>
        <span className="rounded-full bg-black/[0.05] px-2.5 py-1 text-[11px] font-medium text-[#4B5565] dark:bg-white/[0.07] dark:text-[#C4C4CA]">
          群聊实况
        </span>
      </div>

      {/* 协调半透聊天画布：对齐全站三角色对话气泡色阶，消除顶栏与画布的生硬黑块断层 */}
      <div className="space-y-3.5 bg-white/45 px-5 py-4.5 dark:bg-black/[0.16]">
        {/* 本人发出的暖亚麻/烟熏石墨气泡 */}
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ type: "spring", stiffness: 420, damping: 32, delay: 0.1 }}
          className="flex justify-end"
        >
          <div className="max-w-[82%]">
            <div className="rounded-[18px_6px_18px_18px] bg-[#F4EFE6] px-3.5 py-2.5 text-[13.5px] leading-[1.52] text-[#111318] ring-1 ring-inset ring-black/[0.05] dark:bg-[#2E2E34] dark:text-[#F5F5F7] dark:ring-white/[0.10]">
              <span className="font-medium text-[#157347] dark:text-[#6EE7B7]">
                @Claude Code @Codex
              </span>{" "}
              多进程实时推送用 Redis 还是直接走 PG？帮我核对一下取舍。
            </div>
            <p className="mt-1 text-right text-[11px] text-[#8E96A6] dark:text-[#8E8E96]">
              我 · 10:41
            </p>
          </div>
        </motion.div>

        {/* 同伴与本人的个人 Agent 气泡 */}
        {PREVIEW_AGENT_BUBBLES.map((bubble, idx) => (
          <motion.div
            key={bubble.key}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{
              type: "spring",
              stiffness: 420,
              damping: 32,
              delay: 0.16 + idx * 0.07,
            }}
            className="flex items-start gap-2.5"
          >
            <div
              className={cn(
                "flex h-9 w-9 shrink-0 items-center justify-center rounded-full font-mono text-[11px] font-semibold",
                bubble.avatarClass,
              )}
            >
              {bubble.monogram}
            </div>
            <div className="min-w-0 max-w-[82%]">
              <p className="mb-1 flex items-center gap-1.5 text-[12px]">
                <span className="font-medium text-[#111318] dark:text-[#F2F2F4]">
                  {bubble.name}
                </span>
                <span className="text-[#687082] dark:text-[#8E8E96]">{bubble.ownerNote}</span>
                <span className="text-[#939BAD] dark:text-[#63636B]">{bubble.time}</span>
              </p>
              <div className="rounded-[6px_18px_18px_18px] bg-white/95 px-3.5 py-2.5 text-[13.5px] leading-[1.52] text-[#111318] shadow-[0_1px_2px_rgba(15,23,42,0.04)] ring-1 ring-inset ring-black/[0.05] dark:bg-[#222226] dark:text-[#ECECEF] dark:ring-white/[0.07]">
                {bubble.text}
              </div>
            </div>
          </motion.div>
        ))}

        {/* 温润鼠尾草绿已拍板决议便签 */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ type: "spring", stiffness: 420, damping: 32, delay: 0.32 }}
          className="ml-11 rounded-[18px] bg-[#E6F5EC] px-4 py-3 text-[#111318] ring-1 ring-inset ring-emerald-900/[0.08] dark:bg-[#1B2B23] dark:text-[#E6F4EC] dark:ring-emerald-400/[0.14]"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1.5 text-[11.5px] font-semibold text-[#145335] dark:text-[#6EE7B7]">
              <CheckCircle2 aria-hidden="true" className="h-3.5 w-3.5" />
              <span>已拍板结论</span>
            </span>
            <span className="text-[11px] text-[#2F6849] dark:text-[#9ACBB0]">2/2 Agent 赞成</span>
          </div>
          <p className="mt-1 text-[13px] font-medium leading-snug">
            采用 Postgres LISTEN/NOTIFY + 单机内存双模总线
          </p>
          <p className="mt-0.5 text-[11.5px] text-[#3B6E52] dark:text-[#A4C9B4]">
            零 Redis 依赖 · 通知仅推序号 · 由人类最终确认通过
          </p>
        </motion.div>
      </div>
    </motion.div>
  );
}

/**
 * 渲染简洁的 3 格密码强度指示条。
 */
function PasswordStrengthMeter(props: { readonly password: string }) {
  const strength = evaluatePasswordStrength(props.password);
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
 * 渲染 OpenHuddle 邮箱+密码登录、邮箱验证码注册激活与忘记密码重置双栏入口屏。
 *
 * @returns 社论标题 + 群聊实况预览与三态认证卡片视图
 */
export function AuthScreen() {
  const authConfigQuery = useQuery(authConfigQueryOptions());
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

  const loginMutation = useLoginWithPasswordMutation();
  const requestRegisterCodeMutation = useRequestRegisterCodeMutation();
  const registerMutation = useRegisterWithPasswordMutation();
  const requestResetCodeMutation = useRequestPasswordResetCodeMutation();
  const confirmResetMutation = useConfirmPasswordResetMutation();

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
      setLocalValidationError("请输入有效的邮箱地址和登录密码。");
      return;
    }
    loginMutation.mutate(
      { email: trimmedEmail, password },
      {
        onSuccess: (res) => {
          toast.success(`欢迎回来，${res.user.displayName}`);
        },
      },
    );
  };

  /* ── 2. 注册验证码发送 & 注册提交 ── */
  const handleSendRegisterCode = (): void => {
    setLocalValidationError(null);
    registerMutation.reset();
    if (!isEmailShapeValid) {
      setLocalValidationError("请先输入格式正确的邮箱地址。");
      return;
    }
    requestRegisterCodeMutation.mutate(
      { email: trimmedEmail },
      {
        onSuccess: (res) => {
          setRegisterCodeMeta(res);
          setRegisterCooldownSec(res.resendCooldownSec);
          toast.success(
            res.devOtpCode !== undefined ? "开发模式注册验证码已生成" : "6 位注册验证码已发送",
            {
              description:
                res.devOtpCode !== undefined
                  ? `可直接点击一键填入验证码 ${res.devOtpCode}`
                  : `请前往 ${res.email} 收件箱查收（10 分钟内有效）`,
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
      setLocalValidationError("请输入有效的邮箱地址。");
      return;
    }
    if (!/^\d{6}$/.test(verificationCode)) {
      setLocalValidationError("请输入邮件中收到的 6 位数字验证码。");
      return;
    }
    if (trimmedDisplayName.length === 0) {
      setLocalValidationError("请输入你的展示昵称。");
      return;
    }
    if (password.length < PASSWORD_MIN_LENGTH || !/\S/.test(password)) {
      setLocalValidationError(`登录密码至少需要 ${PASSWORD_MIN_LENGTH} 位有效字符。`);
      return;
    }
    if (password !== confirmPassword) {
      setLocalValidationError("两次输入的密码不一致，请重新核对。");
      return;
    }
    if (password.trim().toLowerCase() === trimmedEmail) {
      setLocalValidationError("为保障账号安全，密码不能与邮箱地址相同。");
      return;
    }

    registerMutation.mutate(
      {
        email: trimmedEmail,
        code: verificationCode,
        displayName: trimmedDisplayName,
        password,
      },
      {
        onSuccess: (res) => {
          toast.success(`注册成功，欢迎加入 OpenHuddle，${res.user.displayName}！`);
        },
      },
    );
  };

  /* ── 3. 重置密码验证码发送 & 确认重置 ── */
  const handleSendResetCode = (): void => {
    setLocalValidationError(null);
    confirmResetMutation.reset();
    if (!isEmailShapeValid) {
      setLocalValidationError("请先输入你的注册邮箱地址。");
      return;
    }
    requestResetCodeMutation.mutate(
      { email: trimmedEmail },
      {
        onSuccess: (res) => {
          setResetCodeMeta(res);
          setResetCooldownSec(res.resendCooldownSec);
          toast.success(
            res.devOtpCode !== undefined ? "开发模式重置验证码已生成" : "重置邮件请求已受理",
            {
              description:
                res.devOtpCode !== undefined
                  ? `可直接点击一键填入验证码 ${res.devOtpCode}`
                  : "如果该邮箱已注册，6 位重置验证码已发送至你的收件箱",
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
      setLocalValidationError("请输入有效的邮箱地址。");
      return;
    }
    if (!/^\d{6}$/.test(verificationCode)) {
      setLocalValidationError("请输入 6 位数字重置验证码。");
      return;
    }
    if (password.length < PASSWORD_MIN_LENGTH || !/\S/.test(password)) {
      setLocalValidationError(`新密码至少需要 ${PASSWORD_MIN_LENGTH} 位有效字符。`);
      return;
    }
    if (password !== confirmPassword) {
      setLocalValidationError("两次输入的新密码不一致，请重新核对。");
      return;
    }
    if (password.trim().toLowerCase() === trimmedEmail) {
      setLocalValidationError("新密码不能与邮箱地址相同。");
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
          toast.success("密码已重置并为你登录", {
            description: "该账号在其余设备上的历史会话已全部安全下线",
          });
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
      : formatAuthError(activeServerError);

  const passwordToggleButton = (
    <button
      type="button"
      tabIndex={-1}
      onClick={() => setShowPassword((prev) => !prev)}
      aria-label={showPassword ? "隐藏密码" : "显示密码"}
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
      aria-label={showConfirmPassword ? "隐藏确认密码" : "显示确认密码"}
      className="cursor-pointer rounded-md p-1 text-[#8E8E93] transition-colors hover:text-[#141414] dark:text-zinc-500 dark:hover:text-zinc-200"
    >
      {showConfirmPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
    </button>
  );

  const activeDevOtpMeta = mode === "register" ? registerCodeMeta : resetCodeMeta;

  return (
    // 全局 body 已锁定滚动，背景和内部滚动区域都由本屏管理。
    <div className="relative isolate flex h-dvh flex-col overflow-hidden bg-[#FCFDFE] text-[#111318] dark:bg-[#0E0F13] dark:text-[#F2F2F4]">
      <HuddleConstellationBackground />

      <header
        data-tauri-drag-region=""
        className="app-drag-region pt-safe relative z-20 shrink-0 select-none"
      >
        <div className="mx-auto flex w-full max-w-[1140px] items-center justify-between px-6 py-4 sm:px-10">
          <div className="pointer-events-none flex items-center gap-2.5">
            <BrandMark className="h-6 w-6 shrink-0" />
            <span className="text-[17.5px] font-bold tracking-[-0.025em] text-[#111318] dark:text-white">
              OpenHuddle
            </span>
          </div>
          <div className="app-no-drag rounded-full bg-white/70 backdrop-blur-md dark:bg-white/[0.06]">
            <ThemeToggle showLabel={true} />
          </div>
        </div>
      </header>

      <main className="relative z-10 min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="mx-auto grid min-h-full w-full max-w-[1140px] items-center gap-10 px-6 py-8 sm:px-10 lg:grid-cols-12 lg:gap-14 lg:py-10">
          {/* 左栏：社论大标题 + 液态玻璃群聊实况预览卡片 */}
          <section className="lg:col-span-7">
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ type: "spring", stiffness: 380, damping: 32 }}
              className="select-none"
            >
              <h1 className="text-balance text-4xl font-semibold leading-[1.12] tracking-[-0.03em] text-[#111318] sm:text-5xl dark:text-[#F2F2F4]">
                有事，<span className="inline-block">和你的 AI</span>{" "}
                <span className="inline-block">一起聊。</span>
              </h1>
              <p className="mt-4 max-w-xl text-pretty text-[15px] leading-[1.62] text-[#525A6B] sm:text-[16px] dark:text-[#A5A7B2]">
                让 Claude Code、Codex 和同伴的 Agent 一起查资料、聊方案，最后由你决定。
              </p>
            </motion.div>

            <div className="mt-8 hidden lg:block">
              <LiveHuddlePreview />
            </div>
          </section>

          {/* 右栏：Apple Liquid Glass 圆角认证卡片（登录 / 注册账号 / 重置密码） */}
          <section className="mx-auto w-full max-w-md lg:col-span-5 lg:max-w-none">
            <motion.div
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ type: "spring", stiffness: 400, damping: 32, delay: 0.06 }}
              className="relative liquid-glass-modal overflow-hidden rounded-[28px] bg-white/[0.76] p-6 sm:p-8 dark:bg-[#16171C]/[0.78]"
            >
              {/* 登录 / 注册顶部分段切换器（仅非重置密码态且开放注册时展示） */}
              {mode !== "reset" && allowPublicSignup ? (
                <div className="mb-6">
                  <SegmentedTabs<PrimaryAuthTab>
                    value={mode}
                    onValueChange={(next) => switchMode(next)}
                    items={AUTH_TAB_ITEMS}
                    size="md"
                    fullWidth={true}
                    ariaLabel="选择登录或注册"
                  />
                </div>
              ) : null}

              <AnimatePresence mode="wait" initial={false}>
                {mode === "login" ? (
                  <motion.form
                    key="auth-login"
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -10 }}
                    transition={{ duration: 0.16, ease: "easeOut" }}
                    onSubmit={handleLoginSubmit}
                    className="space-y-5"
                  >
                    <div className="select-none">
                      <h2 className="text-[22px] font-semibold tracking-[-0.02em] text-[#141414] dark:text-zinc-100">
                        欢迎回来
                      </h2>
                      <p className="mt-1.5 text-[13px] leading-relaxed text-[#6E6E73] dark:text-zinc-400">
                        使用你的注册邮箱与密码登录 OpenHuddle 协作空间。
                      </p>
                    </div>

                    {!allowPublicSignup ? (
                      <div className="rounded-2xl bg-[#F5F5F7] px-3.5 py-2.5 text-[12px] leading-relaxed text-[#6E6E73] dark:bg-white/[0.05] dark:text-zinc-400">
                        当前实例已关闭自助注册，仅限已有账号登录。
                      </div>
                    ) : null}

                    <div className="space-y-3.5">
                      <div>
                        <label htmlFor="auth-login-email" className={LABEL_CLASS}>
                          邮箱地址
                        </label>
                        <AppInput
                          id="auth-login-email"
                          type="email"
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
                          containerClassName="mt-1.5"
                        />
                      </div>

                      <div>
                        <div className="flex items-center justify-between gap-2">
                          <label htmlFor="auth-login-password" className={LABEL_CLASS}>
                            登录密码
                          </label>
                          <button
                            type="button"
                            onClick={() => switchMode("reset")}
                            className="cursor-pointer text-[12px] font-medium text-[#6E6E73] transition-colors hover:text-[#141414] dark:text-zinc-400 dark:hover:text-zinc-100"
                          >
                            忘记密码？
                          </button>
                        </div>
                        <AppInput
                          id="auth-login-password"
                          type={showPassword ? "text" : "password"}
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
                          placeholder="请输入登录密码"
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
                      isLoading={loginMutation.isPending}
                      disabled={!isEmailShapeValid || password.length === 0}
                      className="h-11 rounded-full text-[14px] font-medium"
                      trailingIcon={
                        !loginMutation.isPending ? (
                          <ArrowRight aria-hidden="true" className="h-4 w-4" />
                        ) : undefined
                      }
                    >
                      {loginMutation.isPending ? "正在登录..." : "登录"}
                    </AppButton>

                    <div className="flex select-none items-center justify-between gap-2 pt-0.5 text-[12px] text-[#8E8E93] dark:text-zinc-500">
                      <span>开源可自托管 · Owner-First</span>
                      {allowPublicSignup ? (
                        <button
                          type="button"
                          onClick={() => switchMode("register")}
                          className="cursor-pointer font-medium text-[#141414] underline-offset-4 hover:underline dark:text-zinc-200"
                        >
                          还没有账号？去注册
                        </button>
                      ) : null}
                    </div>
                  </motion.form>
                ) : mode === "register" ? (
                  <motion.form
                    key="auth-register"
                    initial={{ opacity: 0, x: 10 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: 10 }}
                    transition={{ duration: 0.16, ease: "easeOut" }}
                    onSubmit={handleRegisterSubmit}
                    className="space-y-4"
                  >
                    <div className="select-none">
                      <h2 className="text-[22px] font-semibold tracking-[-0.02em] text-[#141414] dark:text-zinc-100">
                        创建你的账号
                      </h2>
                      <p className="mt-1 text-[13px] leading-relaxed text-[#6E6E73] dark:text-zinc-400">
                        先验证邮箱收到的 6 位激活码，再设置登录密码即可开启协作。
                      </p>
                    </div>

                    {allowedEmailDomains.length > 0 ? (
                      <div className="flex items-start gap-2 rounded-2xl bg-[#F5F5F7] px-3.5 py-2 text-[12px] leading-relaxed text-[#52525B] dark:bg-white/[0.05] dark:text-zinc-300">
                        <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#2A7B59] dark:text-[#5ED3A2]" />
                        <span>
                          仅允许使用 {allowedEmailDomains.map((domain) => `@${domain}`).join("、")}{" "}
                          邮箱注册
                        </span>
                      </div>
                    ) : null}

                    {emailDeliveryMode === "unavailable" ? (
                      <div className="flex items-start gap-2 rounded-2xl border border-[#D97706]/30 bg-[#FEF3C7]/70 px-3.5 py-2.5 text-[12px] leading-relaxed text-[#92400E] dark:border-[#F59E0B]/25 dark:bg-[#451A03]/35 dark:text-[#FCD34D]">
                        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        <span>
                          当前服务器尚未配置 SMTP 发信服务，暂无法下发注册验证邮件，请联系管理员。
                        </span>
                      </div>
                    ) : null}

                    <div className="space-y-3">
                      <div>
                        <label htmlFor="auth-reg-email" className={LABEL_CLASS}>
                          邮箱地址
                        </label>
                        <div className="mt-1.5 flex items-center gap-2">
                          <AppInput
                            id="auth-reg-email"
                            type="email"
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
                            containerClassName="flex-1"
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
                            className="h-10 shrink-0 rounded-xl px-3.5 text-xs font-medium whitespace-nowrap"
                          >
                            {registerCooldownSec > 0
                              ? `${registerCooldownSec}s 后重发`
                              : registerCodeMeta
                                ? "重新发送"
                                : "发送验证码"}
                          </AppButton>
                        </div>
                      </div>

                      {/* 发送成功回执（真实 SMTP 或开发模式快捷码） */}
                      {activeDevOtpMeta ? (
                        activeDevOtpMeta.devOtpCode !== undefined ? (
                          <div className="select-none rounded-2xl bg-[#E3F3EC] px-3.5 py-2.5 ring-1 ring-inset ring-black/[0.05] dark:bg-[#16271F] dark:ring-white/[0.08]">
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-[11.5px] font-medium text-[#1E5638] dark:text-[#86E0A6]">
                                开发模式验证码
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
                                  一键填入
                                </button>
                              </div>
                            </div>
                          </div>
                        ) : (
                          <p className="flex items-center gap-1.5 rounded-xl bg-[#E3F3EC]/80 px-3 py-2 text-[12px] text-[#1E5638] dark:bg-[#16271F] dark:text-[#86E0A6]">
                            <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                            <span>
                              验证码已发往 {activeDevOtpMeta.email}（
                              {Math.round(activeDevOtpMeta.expiresInSec / 60)} 分钟内有效）
                            </span>
                          </p>
                        )
                      ) : null}

                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <div>
                          <label htmlFor="auth-reg-code" className={LABEL_CLASS}>
                            6 位邮箱验证码
                          </label>
                          <AppInput
                            id="auth-reg-code"
                            type="text"
                            size="lg"
                            inputMode="numeric"
                            autoComplete="one-time-code"
                            maxLength={6}
                            required={true}
                            value={verificationCode}
                            onChange={(e) => {
                              setVerificationCode(e.target.value.replace(/\D/g, "").slice(0, 6));
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
                            你的名字
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
                            placeholder="例如：庞彦 / Alex"
                            containerClassName="mt-1.5"
                          />
                        </div>
                      </div>

                      <div>
                        <label htmlFor="auth-reg-password" className={LABEL_CLASS}>
                          设置密码
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
                          placeholder={`至少 ${PASSWORD_MIN_LENGTH} 位字符`}
                          containerClassName="mt-1.5"
                        />
                        <PasswordStrengthMeter password={password} />
                      </div>

                      <div>
                        <label htmlFor="auth-reg-password-confirm" className={LABEL_CLASS}>
                          确认密码
                        </label>
                        <AppInput
                          id="auth-reg-password-confirm"
                          type={showConfirmPassword ? "text" : "password"}
                          size="lg"
                          required={true}
                          autoComplete="new-password"
                          value={confirmPassword}
                          invalid={confirmPassword.length > 0 && confirmPassword !== password}
                          onChange={(e) => {
                            setConfirmPassword(e.target.value);
                            setLocalValidationError(null);
                          }}
                          leadingIcon={<Lock className="h-4 w-4" />}
                          trailingSlot={confirmPasswordToggleButton}
                          placeholder="再次输入密码"
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
                            className="mt-1.5 cursor-pointer font-semibold underline underline-offset-2"
                          >
                            直接用该邮箱登录 →
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
                      className="h-11 rounded-full text-[14px] font-medium"
                      trailingIcon={
                        !registerMutation.isPending ? (
                          <ArrowRight aria-hidden="true" className="h-4 w-4" />
                        ) : undefined
                      }
                    >
                      {registerMutation.isPending ? "正在创建账号..." : "完成注册并进入"}
                    </AppButton>
                  </motion.form>
                ) : (
                  <motion.form
                    key="auth-reset"
                    initial={{ opacity: 0, x: 10 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: 10 }}
                    transition={{ duration: 0.16, ease: "easeOut" }}
                    onSubmit={handleResetSubmit}
                    className="space-y-4"
                  >
                    <div className="select-none">
                      <AppButton
                        type="button"
                        variant="ghost"
                        size="xs"
                        leadingIcon={<ArrowLeft aria-hidden="true" className="h-3.5 w-3.5" />}
                        onClick={() => switchMode("login")}
                        className="-ml-2.5"
                      >
                        返回登录
                      </AppButton>
                      <h2 className="mt-2.5 text-[22px] font-semibold tracking-[-0.02em] text-[#141414] dark:text-zinc-100">
                        重置登录密码
                      </h2>
                      <p className="mt-1 text-[13px] leading-relaxed text-[#6E6E73] dark:text-zinc-400">
                        通过邮箱接收 6 位验证码重设密码；早期无密码老用户也可在此直接设置登录密码。
                      </p>
                    </div>

                    {emailDeliveryMode === "unavailable" ? (
                      <div className="flex items-start gap-2 rounded-2xl border border-[#D97706]/30 bg-[#FEF3C7]/70 px-3.5 py-2.5 text-[12px] leading-relaxed text-[#92400E] dark:border-[#F59E0B]/25 dark:bg-[#451A03]/35 dark:text-[#FCD34D]">
                        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        <span>当前服务器尚未配置 SMTP 发信服务，暂无法发送重置邮件。</span>
                      </div>
                    ) : null}

                    <div className="space-y-3">
                      <div>
                        <label htmlFor="auth-reset-email" className={LABEL_CLASS}>
                          注册邮箱
                        </label>
                        <div className="mt-1.5 flex items-center gap-2">
                          <AppInput
                            id="auth-reset-email"
                            type="email"
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
                            containerClassName="flex-1"
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
                              !requestResetCodeMutation.isPending && resetCooldownSec === 0 ? (
                                <Send className="h-3.5 w-3.5" />
                              ) : undefined
                            }
                            className="h-10 shrink-0 rounded-xl px-3.5 text-xs font-medium whitespace-nowrap"
                          >
                            {resetCooldownSec > 0
                              ? `${resetCooldownSec}s 后重发`
                              : resetCodeMeta
                                ? "重新发送"
                                : "发送验证码"}
                          </AppButton>
                        </div>
                      </div>

                      {activeDevOtpMeta ? (
                        activeDevOtpMeta.devOtpCode !== undefined ? (
                          <div className="select-none rounded-2xl bg-[#E3F3EC] px-3.5 py-2.5 ring-1 ring-inset ring-black/[0.05] dark:bg-[#16271F] dark:ring-white/[0.08]">
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-[11.5px] font-medium text-[#1E5638] dark:text-[#86E0A6]">
                                开发模式重置码
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
                                  一键填入
                                </button>
                              </div>
                            </div>
                          </div>
                        ) : (
                          <p className="flex items-center gap-1.5 rounded-xl bg-[#E3F3EC]/80 px-3 py-2 text-[12px] text-[#1E5638] dark:bg-[#16271F] dark:text-[#86E0A6]">
                            <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                            <span>如果该邮箱已注册，6 位重置验证码已发往你的收件箱。</span>
                          </p>
                        )
                      ) : null}

                      <div>
                        <label htmlFor="auth-reset-code" className={LABEL_CLASS}>
                          6 位邮箱验证码
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
                            setVerificationCode(e.target.value.replace(/\D/g, "").slice(0, 6));
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
                          新密码
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
                          placeholder={`至少 ${PASSWORD_MIN_LENGTH} 位字符`}
                          containerClassName="mt-1.5"
                        />
                        <PasswordStrengthMeter password={password} />
                      </div>

                      <div>
                        <label htmlFor="auth-reset-password-confirm" className={LABEL_CLASS}>
                          确认新密码
                        </label>
                        <AppInput
                          id="auth-reset-password-confirm"
                          type={showConfirmPassword ? "text" : "password"}
                          size="lg"
                          required={true}
                          autoComplete="new-password"
                          value={confirmPassword}
                          invalid={confirmPassword.length > 0 && confirmPassword !== password}
                          onChange={(e) => {
                            setConfirmPassword(e.target.value);
                            setLocalValidationError(null);
                          }}
                          leadingIcon={<Lock className="h-4 w-4" />}
                          trailingSlot={confirmPasswordToggleButton}
                          placeholder="再次输入新密码"
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
                      className="h-11 rounded-full text-[14px] font-medium"
                      trailingIcon={
                        !confirmResetMutation.isPending ? (
                          <ArrowRight aria-hidden="true" className="h-4 w-4" />
                        ) : undefined
                      }
                    >
                      {confirmResetMutation.isPending ? "正在更新密码..." : "重置密码并登录"}
                    </AppButton>
                  </motion.form>
                )}
              </AnimatePresence>
            </motion.div>
          </section>
        </div>
      </main>
    </div>
  );
}

/**
 * 向后兼容旧导出名（指向升级后的 `AuthScreen` 完整邮箱+密码注册与登录页）。
 */
export const OtpSignInScreen = AuthScreen;
