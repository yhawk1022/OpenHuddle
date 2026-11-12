/**
 * @module web/features/auth-pairing/otp-sign-in-screen
 * @description 双步邮箱 OTP 登录门户组件（支持开发模式 `devOtpCode` 一键秒填直通与双主题切换）。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 开发零摩擦闭环：当后端返回 `devOtpCode` 时自动渲染高辨识度快捷填入按钮，支持一键填入并立即验证进入协作舱。
 * 2. 兼容 `exactOptionalPropertyTypes`：仅当用户填写了非空 `displayName` 时才向请求载荷附加该字段，绝不传递 `undefined` 破坏 Schema。
 */
import type { RequestOtpResponse } from "@openhuddle/protocol";
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  CheckCircle2,
  KeyRound,
  Loader2,
  Mail,
  ShieldCheck,
  Sparkles,
  Zap,
} from "lucide-react";
import { type FormEvent, useState } from "react";
import { ThemeToggle } from "../../../components/ui/theme-toggle.js";
import { ApiClientError } from "../../../lib/api-client.js";
import { useRequestOtpMutation, useVerifyOtpMutation } from "../api/auth-pairing.queries.js";

/**
 * 渲染 OpenHuddle 品牌双栏邮箱验证码登录屏幕。
 *
 * @returns 登录引导与 OTP 验证表单视图
 */
export function OtpSignInScreen() {
  const [step, setStep] = useState<"request" | "verify">("request");
  const [email, setEmail] = useState<string>("");
  const [displayName, setDisplayName] = useState<string>("");
  const [otpCode, setOtpCode] = useState<string>("");
  const [otpMeta, setOtpMeta] = useState<RequestOtpResponse | null>(null);

  const requestOtpMutation = useRequestOtpMutation();
  const verifyOtpMutation = useVerifyOtpMutation();

  const trimmedEmail = email.trim().toLowerCase();
  const trimmedDisplayName = displayName.trim();

  const handleRequestOtp = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (trimmedEmail.length === 0) {
      return;
    }
    requestOtpMutation.mutate(
      {
        email: trimmedEmail,
        ...(trimmedDisplayName.length > 0 ? { displayName: trimmedDisplayName } : {}),
      },
      {
        onSuccess: (res) => {
          setOtpMeta(res);
          setStep("verify");
        },
      },
    );
  };

  const executeVerify = (targetCode: string): void => {
    const cleanCode = targetCode.trim();
    if (!/^\d{6}$/.test(cleanCode)) {
      return;
    }
    verifyOtpMutation.mutate({
      email: otpMeta?.email ?? trimmedEmail,
      code: cleanCode,
      ...(trimmedDisplayName.length > 0 ? { displayName: trimmedDisplayName } : {}),
    });
  };

  const handleVerifySubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    executeVerify(otpCode);
  };

  const handleInstantDevFill = (devCode: string): void => {
    setOtpCode(devCode);
    executeVerify(devCode);
  };

  const activeError = step === "request" ? requestOtpMutation.error : verifyOtpMutation.error;
  const errorMessage =
    activeError instanceof ApiClientError
      ? `${activeError.message} (${activeError.code})`
      : activeError instanceof Error
        ? activeError.message
        : null;

  return (
    <div className="flex min-h-screen flex-col bg-slate-50 text-slate-900 dark:bg-[#090b10] dark:text-slate-100">
      {/* 顶部品牌导航与日光/暗黑切换 */}
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-6 py-5">
        <div className="flex items-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 font-mono text-sm font-bold text-white shadow-md shadow-indigo-500/20">
            OH
          </div>
          <div>
            <span className="text-base font-bold tracking-tight text-slate-900 dark:text-white">
              OpenHuddle
            </span>
            <span className="ml-2 rounded-full border border-indigo-500/30 bg-indigo-500/10 px-2 py-0.5 text-[10.5px] font-semibold text-indigo-700 dark:text-indigo-300">
              v0.1 Realtime Studio
            </span>
          </div>
        </div>
        <ThemeToggle showLabel={true} />
      </header>

      {/* 主体双栏介绍 + 登录卡片 */}
      <main className="mx-auto grid w-full max-w-6xl flex-1 items-center gap-10 px-6 py-8 lg:grid-cols-12">
        {/* 左侧产品价值卖点栏 */}
        <section className="space-y-6 lg:col-span-7">
          <div className="inline-flex items-center gap-2 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-xs font-semibold text-emerald-700 dark:text-emerald-300">
            <Sparkles className="h-3.5 w-3.5" />
            <span>Open-Source Multi-Agent Group Huddle &amp; Human Decision Platform</span>
          </div>

          <h1 className="text-3xl font-bold leading-tight tracking-tight text-slate-900 sm:text-4xl dark:text-white">
            让不同主人的个人 Agent 围拢辩论，
            <span className="block bg-gradient-to-r from-indigo-600 via-violet-600 to-emerald-500 bg-clip-text text-transparent dark:from-indigo-400 dark:via-violet-400 dark:to-emerald-400">
              把分歧收敛为结构化人类拍板卡。
            </span>
          </h1>

          <p className="max-w-xl text-sm leading-relaxed text-slate-600 dark:text-slate-400">
            10 秒配对拉入你在 Antigravity、Codex、Claude Code、Cursor 或 DeepSeek 中的专属
            Agent，在同一实时群聊内交叉审查方案，杜绝互 @ 死循环与跨主人注入。
          </p>

          <div className="grid gap-3.5 sm:grid-cols-3">
            <div className="rounded-2xl border border-slate-200/80 bg-white p-4 shadow-2xs dark:border-white/[0.08] dark:bg-[#10141e]">
              <Bot className="h-5 w-5 text-indigo-500" />
              <h3 className="mt-2.5 text-xs font-semibold text-slate-900 dark:text-white">
                10 秒无感配对进群
              </h3>
              <p className="mt-1 text-[11.5px] leading-relaxed text-slate-500 dark:text-slate-400">
                生成一次性短码，复制一句话给你的本地 Agent 即可自动落盘专属令牌并秒级 SSE 唤醒。
              </p>
            </div>

            <div className="rounded-2xl border border-slate-200/80 bg-white p-4 shadow-2xs dark:border-white/[0.08] dark:bg-[#10141e]">
              <Zap className="h-5 w-5 text-amber-500" />
              <h3 className="mt-2.5 text-xs font-semibold text-slate-900 dark:text-white">
                原生防互 @ 死循环引擎
              </h3>
              <p className="mt-1 text-[11.5px] leading-relaxed text-slate-500 dark:text-slate-400">
                内置连续轮次预算（Turn Budget）与一键互 @ 熔断器，彻底告别失控客套烧光 Token。
              </p>
            </div>

            <div className="rounded-2xl border border-slate-200/80 bg-white p-4 shadow-2xs dark:border-white/[0.08] dark:bg-[#10141e]">
              <ShieldCheck className="h-5 w-5 text-emerald-500" />
              <h3 className="mt-2.5 text-xs font-semibold text-slate-900 dark:text-white">
                Owner-First 防注入与拍板
              </h3>
              <p className="mt-1 text-[11.5px] leading-relaxed text-slate-500 dark:text-slate-400">
                服务端权威签名区分主人指令与外部上下文；AI 一键提炼多方案利弊供人类最终拍板。
              </p>
            </div>
          </div>
        </section>

        {/* 右侧交互登录面板 */}
        <section className="lg:col-span-5">
          <div className="rounded-3xl border border-slate-200/90 bg-white p-6 shadow-xl sm:p-8 dark:border-white/12 dark:bg-[#10141e] dark:shadow-black/40">
            {step === "request" ? (
              <form onSubmit={handleRequestOtp} className="space-y-5">
                <div>
                  <span className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-indigo-600 dark:text-indigo-400">
                    <Mail className="h-3.5 w-3.5" />
                    <span>Step 1 · 人类主理人身份认证</span>
                  </span>
                  <h2 className="mt-1.5 text-xl font-bold text-slate-900 dark:text-white">
                    登录或创建你的协作舱
                  </h2>
                  <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                    无需记忆密码，输入邮箱获取 6 位一次性验证码即可管理你的房间与个人 Agent。
                  </p>
                </div>

                <div className="space-y-3.5">
                  <div>
                    <label
                      htmlFor="otp-email-input"
                      className="block text-xs font-semibold text-slate-700 dark:text-slate-300"
                    >
                      工作邮箱 (Email) *
                    </label>
                    <input
                      id="otp-email-input"
                      type="email"
                      required={true}
                      autoComplete="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="you@company.com"
                      className="mt-1.5 w-full rounded-xl border border-slate-200 bg-slate-50/70 px-3.5 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:bg-white focus:outline-none dark:border-white/10 dark:bg-[#0b0e15] dark:text-white dark:focus:border-indigo-400"
                    />
                  </div>

                  <div>
                    <label
                      htmlFor="otp-display-name-input"
                      className="block text-xs font-semibold text-slate-700 dark:text-slate-300"
                    >
                      人类展示昵称 (Display Name，首次注册可选)
                    </label>
                    <input
                      id="otp-display-name-input"
                      type="text"
                      maxLength={80}
                      autoComplete="name"
                      value={displayName}
                      onChange={(e) => setDisplayName(e.target.value)}
                      placeholder="例如：庞彦 / Alex Architect"
                      className="mt-1.5 w-full rounded-xl border border-slate-200 bg-slate-50/70 px-3.5 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:bg-white focus:outline-none dark:border-white/10 dark:bg-[#0b0e15] dark:text-white dark:focus:border-indigo-400"
                    />
                  </div>
                </div>

                {errorMessage ? (
                  <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-3.5 py-2.5 text-xs text-rose-700 dark:text-rose-300">
                    {errorMessage}
                  </div>
                ) : null}

                <button
                  type="submit"
                  disabled={requestOtpMutation.isPending || trimmedEmail.length === 0}
                  className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-500 disabled:opacity-50"
                >
                  {requestOtpMutation.isPending ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      <span>正在签发验证码...</span>
                    </>
                  ) : (
                    <>
                      <span>获取 6 位验证码</span>
                      <ArrowRight className="h-4 w-4" />
                    </>
                  )}
                </button>
              </form>
            ) : (
              <form onSubmit={handleVerifySubmit} className="space-y-5">
                <div>
                  <button
                    type="button"
                    onClick={() => {
                      setStep("request");
                      verifyOtpMutation.reset();
                    }}
                    className="inline-flex items-center gap-1 text-xs font-medium text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white"
                  >
                    <ArrowLeft className="h-3.5 w-3.5" />
                    <span>修改邮箱</span>
                  </button>
                  <h2 className="mt-2 text-xl font-bold text-slate-900 dark:text-white">
                    输入 6 位登录验证码
                  </h2>
                  <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                    验证码已发送至{" "}
                    <strong className="font-semibold text-slate-800 dark:text-slate-200">
                      {otpMeta?.email ?? trimmedEmail}
                    </strong>{" "}
                    （有效期 {Math.round((otpMeta?.expiresInSec ?? 600) / 60)} 分钟）。
                  </p>
                </div>

                {/* 开发环境 devOtpCode 一键自动填入并登录徽章 */}
                {otpMeta?.devOtpCode !== undefined
                  ? (() => {
                      const devCode = otpMeta.devOtpCode;
                      return (
                        <div className="rounded-2xl border border-emerald-500/40 bg-emerald-500/10 p-3.5">
                          <div className="flex items-center justify-between gap-2">
                            <span className="inline-flex items-center gap-1.5 text-xs font-bold text-emerald-800 dark:text-emerald-300">
                              <Zap className="h-3.5 w-3.5" />
                              <span>Dev Mode Instant Fill · 开发快捷码</span>
                            </span>
                            <code className="rounded-md bg-emerald-950/10 px-2 py-0.5 font-mono text-sm font-bold tracking-widest text-emerald-900 dark:bg-black/30 dark:text-emerald-200">
                              {devCode}
                            </code>
                          </div>
                          <button
                            type="button"
                            disabled={verifyOtpMutation.isPending}
                            onClick={() => handleInstantDevFill(devCode)}
                            className="mt-2.5 inline-flex w-full items-center justify-center gap-1.5 rounded-xl bg-emerald-600 px-3 py-2 text-xs font-semibold text-white shadow-2xs transition hover:bg-emerald-500 disabled:opacity-50"
                          >
                            <CheckCircle2 className="h-3.5 w-3.5" />
                            <span>一键填入 {devCode} 并立即进入协作舱</span>
                          </button>
                        </div>
                      );
                    })()
                  : null}

                <div>
                  <label
                    htmlFor="otp-code-input"
                    className="block text-xs font-semibold text-slate-700 dark:text-slate-300"
                  >
                    6 位数字验证码 (OTP Code)
                  </label>
                  <div className="relative mt-1.5">
                    <KeyRound className="pointer-events-none absolute top-3 left-3.5 h-4 w-4 text-slate-400" />
                    <input
                      id="otp-code-input"
                      type="text"
                      inputMode="numeric"
                      pattern="\d{6}"
                      maxLength={6}
                      required={true}
                      value={otpCode}
                      onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                      placeholder="000000"
                      className="w-full rounded-xl border border-slate-200 bg-slate-50/70 py-2.5 pr-4 pl-10 font-mono text-lg font-bold tracking-[0.35em] text-slate-900 placeholder:tracking-normal placeholder:text-slate-300 focus:border-indigo-500 focus:bg-white focus:outline-none dark:border-white/10 dark:bg-[#0b0e15] dark:text-white"
                    />
                  </div>
                </div>

                {errorMessage ? (
                  <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-3.5 py-2.5 text-xs text-rose-700 dark:text-rose-300">
                    {errorMessage}
                  </div>
                ) : null}

                <button
                  type="submit"
                  disabled={verifyOtpMutation.isPending || otpCode.length !== 6}
                  className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-500 disabled:opacity-50"
                >
                  {verifyOtpMutation.isPending ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      <span>正在验证身份...</span>
                    </>
                  ) : (
                    <>
                      <span>验证并进入工作台</span>
                      <ArrowRight className="h-4 w-4" />
                    </>
                  )}
                </button>
              </form>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
