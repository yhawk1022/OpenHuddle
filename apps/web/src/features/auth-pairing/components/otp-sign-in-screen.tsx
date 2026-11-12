/**
 * @module web/features/auth-pairing/otp-sign-in-screen
 * @description Pachat 社论极简风格双栏登录启动页（`https://pachat.ai/zh` 同款纯白 `#FFFFFF` / 暗夜 `#0E0E10` 画布、左侧 `Figtree` 大字号群聊实况卡片预览 + 右侧无密码邮箱验证码登录卡，支持开发模式 `devOtpCode` 一键直通）。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 开发零摩擦闭环：当后端返回 `devOtpCode` 时自动渲染温润鼠尾草绿快捷填入面板，支持一键填入并立即验证进入聊天室。
 * 2. 兼容 `exactOptionalPropertyTypes`：仅当用户填写了非空 `displayName` 时才向请求载荷附加该字段，绝不传递 `undefined` 破坏 Schema。
 * 3. Tauri v2 + Electron 双栖窗口壳：`html/body` 已被全局锁定 `overflow: hidden`，本屏自身使用 `h-dvh` + 内部滚动容器；顶部栏同时声明 `data-tauri-drag-region` 与 `.app-drag-region`，开箱支持无边框窗口原生拖拽。
 * 4. Pachat 去 AI 模板化视觉：零蓝紫渐变、零极光模糊光斑、零机器表情符号，统一采用暖象牙气泡 `#F6F2EC`、柔灰 Agent 气泡 `#F5F5F7`、鼠尾草绿拍板便签 `#E3F3EC` 与 `#141414` 胶囊按钮。
 */
import type { RequestOtpResponse } from "@openhuddle/protocol";
import { ArrowLeft, ArrowRight, CheckCircle2, KeyRound, Mail, User } from "lucide-react";
import { type FormEvent, useState } from "react";
import { BrandMark } from "../../../components/brand-mark.js";
import {
  AnimatePresence,
  AppButton,
  AppInput,
  cn,
  motion,
  toast,
} from "../../../components/primitives/index.js";
import { ThemeToggle } from "../../../components/ui/theme-toggle.js";
import { ApiClientError } from "../../../lib/api-client.js";
import { useRequestOtpMutation, useVerifyOtpMutation } from "../api/auth-pairing.queries.js";

const LABEL_CLASS = "block text-xs font-medium text-[#3A3A3C] dark:text-zinc-300";

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
 * 渲染左侧无极光光斑、纯净纸感的 Pachat 群聊实况预览卡片。
 *
 * @returns 展示 `#F6F2EC` 本人象牙气泡、`#F5F5F7` Agent 圆形粉彩头像气泡与 `#E3F3EC` 已拍板结论便签的卡片
 */
function LiveHuddlePreview() {
  return (
    <motion.div
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", stiffness: 360, damping: 32, delay: 0.05 }}
      className="select-none overflow-hidden rounded-[28px] bg-white shadow-[0_24px_70px_rgba(0,0,0,0.08)] ring-1 ring-black/[0.06] dark:bg-[#151518] dark:shadow-[0_28px_80px_rgba(0,0,0,0.55)] dark:ring-white/[0.08]"
    >
      {/* 卡片顶部清爽群聊头：2x2 粉彩拼图头像 + 群标题 + 实时绿点 */}
      <div className="flex items-center justify-between gap-3 border-b border-black/[0.06] px-5 py-3.5 dark:border-white/[0.07]">
        <div className="flex min-w-0 items-center gap-3">
          <div
            aria-hidden="true"
            className="grid h-9 w-9 shrink-0 grid-cols-2 gap-0.5 rounded-xl bg-[#EFEFF3] p-1 dark:bg-[#222226]"
          >
            <span className="rounded-full bg-[#F6F2EC] dark:bg-[#3A352D]" />
            <span className="rounded-full bg-[#F4ECDD] dark:bg-[#4A3B28]" />
            <span className="rounded-full bg-[#E1ECFF] dark:bg-[#263854]" />
            <span className="rounded-full bg-[#E3F3EC] dark:bg-[#213B2E]" />
          </div>
          <div className="min-w-0">
            <p className="truncate text-[14px] font-semibold tracking-[-0.01em] text-[#141414] dark:text-zinc-100">
              实时同步方案讨论
            </p>
            <p className="flex items-center gap-1.5 text-[11.5px] text-[#8E8E93] dark:text-zinc-400">
              <span className="h-1.5 w-1.5 rounded-full bg-[#34C759]" />
              <span>2 位成员 · 2 个 Agent 在线</span>
            </p>
          </div>
        </div>
        <span className="rounded-full bg-[#F5F5F7] px-2.5 py-1 text-[11px] font-medium text-[#6E6E73] dark:bg-[#222226] dark:text-zinc-400">
          群聊实况
        </span>
      </div>

      {/* 纯白聊天画布：遵循 Pachat 不对称圆角气泡与暖纸色阶 */}
      <div className="space-y-3.5 bg-white px-5 py-4.5 dark:bg-[#0E0E10]">
        {/* 本人发出的暖象牙气泡（#F6F2EC） */}
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ type: "spring", stiffness: 420, damping: 32, delay: 0.1 }}
          className="flex justify-end"
        >
          <div className="max-w-[82%]">
            <div className="rounded-[18px_6px_18px_18px] bg-[#F6F2EC] px-3.5 py-2.5 text-[13.5px] leading-[1.48] text-[#141414] dark:bg-[#272521] dark:text-[#F4F4F2]">
              <span className="font-medium text-[#2A7B59] dark:text-[#5ED3A2]">
                @Claude Code @Codex
              </span>{" "}
              多进程实时推送用 Redis 还是直接走 PG？帮我核对一下取舍。
            </div>
            <p className="mt-1 text-right text-[11px] text-[#8E8E93]">我 · 10:41</p>
          </div>
        </motion.div>

        {/* 同伴与本人的个人 Agent：圆形暖粉彩头像 + #F5F5F7 柔灰气泡 */}
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
                <span className="font-medium text-[#141414] dark:text-zinc-100">{bubble.name}</span>
                <span className="text-[#8E8E93] dark:text-zinc-400">{bubble.ownerNote}</span>
                <span className="text-[#8E8E93]/80 dark:text-zinc-500">{bubble.time}</span>
              </p>
              <div className="rounded-[6px_18px_18px_18px] bg-[#F5F5F7] px-3.5 py-2.5 text-[13.5px] leading-[1.48] text-[#141414] dark:bg-[#1C1C1F] dark:text-[#ECECEF]">
                {bubble.text}
              </div>
            </div>
          </motion.div>
        ))}

        {/* 温润鼠尾草绿（#E3F3EC）已拍板决议便签 */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ type: "spring", stiffness: 420, damping: 32, delay: 0.32 }}
          className="ml-11 rounded-[18px] bg-[#E3F3EC] px-4 py-3 text-[#141414] ring-1 ring-inset ring-black/[0.04] dark:bg-[#16271F] dark:text-[#E8F3EC] dark:ring-white/[0.07]"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1.5 text-[11.5px] font-semibold text-[#1E5638] dark:text-[#86E0A6]">
              <CheckCircle2 aria-hidden="true" className="h-3.5 w-3.5" />
              <span>已拍板结论</span>
            </span>
            <span className="text-[11px] text-[#3E6B52] dark:text-[#9ACBB0]">2/2 Agent 赞成</span>
          </div>
          <p className="mt-1 text-[13px] font-medium leading-snug">
            采用 Postgres LISTEN/NOTIFY + 单机内存双模总线
          </p>
          <p className="mt-0.5 text-[11.5px] text-[#456B56] dark:text-[#A4C9B4]">
            零 Redis 依赖 · 通知仅推序号 · 由人类最终确认通过
          </p>
        </motion.div>
      </div>
    </motion.div>
  );
}

/**
 * 渲染 OpenHuddle Pachat 社论极简风双栏登录页。
 *
 * @returns 社论标题 + 群聊实况预览与无密码邮箱验证码登录卡片视图
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
          toast.success(
            res.devOtpCode !== undefined ? "开发模式验证码已生成" : "6 位登录码已发送",
            {
              description:
                res.devOtpCode !== undefined
                  ? `可直接点击一键填入验证码 ${res.devOtpCode}`
                  : `请查看 ${res.email} 的收件箱`,
            },
          );
        },
        onError: (err) => {
          toast.error(err instanceof Error ? err.message : "发送验证码失败，请稍后重试");
        },
      },
    );
  };

  const executeVerify = (targetCode: string): void => {
    const cleanCode = targetCode.trim();
    if (!/^\d{6}$/.test(cleanCode)) {
      return;
    }
    verifyOtpMutation.mutate(
      {
        email: otpMeta?.email ?? trimmedEmail,
        code: cleanCode,
        ...(trimmedDisplayName.length > 0 ? { displayName: trimmedDisplayName } : {}),
      },
      {
        onSuccess: () => {
          toast.success("欢迎回来");
        },
        onError: (err) => {
          toast.error(err instanceof Error ? err.message : "验证码校验失败");
        },
      },
    );
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
    // 全局 body 已锁定滚动，因此本屏自身承担 h-dvh 视口与内部滚动
    <div className="flex h-dvh flex-col overflow-hidden bg-white text-[#141414] dark:bg-[#0E0E10] dark:text-zinc-100">
      {/* 顶部清爽标题栏：纯正 Figtree 粗体字标 + 主题切换，支持 Tauri v2 与 Electron 无边框拖拽 */}
      <header
        data-tauri-drag-region=""
        className="app-drag-region pt-safe shrink-0 select-none border-b border-black/[0.05] dark:border-white/[0.06]"
      >
        <div className="mx-auto flex w-full max-w-[1140px] items-center justify-between px-6 py-3.5 sm:px-10">
          <div className="pointer-events-none flex items-center gap-2.5">
            <BrandMark className="h-6 w-6 shrink-0" />
            <span className="text-[18px] font-bold tracking-[-0.025em] text-[#141414] dark:text-white">
              OpenHuddle
            </span>
          </div>
          <div className="app-no-drag">
            <ThemeToggle showLabel={true} />
          </div>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="mx-auto grid min-h-full w-full max-w-[1140px] items-center gap-10 px-6 py-8 sm:px-10 lg:grid-cols-12 lg:gap-14 lg:py-10">
          {/* 左栏：Pachat 社论大标题 + 群聊实况预览卡片 */}
          <section className="lg:col-span-7">
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ type: "spring", stiffness: 380, damping: 32 }}
              className="select-none"
            >
              <h1 className="text-4xl font-normal leading-[1.1] tracking-[-0.03em] text-[#141414] sm:text-5xl dark:text-zinc-100">
                把你的 AI 聚到一个群里聊。
              </h1>
              <p className="mt-4 max-w-xl text-[15px] leading-[1.6] text-[#6E6E73] sm:text-[16px] dark:text-zinc-400">
                让 Claude Code、Codex 与同伴的个人 Agent
                在同一个聊天室里核对事实、讨论方案，把拍板留给你。
              </p>
            </motion.div>

            <div className="mt-8 hidden lg:block">
              <LiveHuddlePreview />
            </div>
          </section>

          {/* 右栏：纯净 #F8F8FA / #FFFFFF 圆角登录卡片 + #141414 胶囊主按钮 */}
          <section className="mx-auto w-full max-w-md lg:col-span-5 lg:max-w-none">
            <motion.div
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ type: "spring", stiffness: 400, damping: 32, delay: 0.06 }}
              className="overflow-hidden rounded-[28px] bg-[#F8F8FA] p-6 ring-1 ring-black/[0.06] sm:bg-white sm:p-8 sm:shadow-[0_24px_70px_rgba(0,0,0,0.06)] dark:bg-[#151518] dark:shadow-[0_28px_80px_rgba(0,0,0,0.5)] dark:ring-white/[0.08]"
            >
              <AnimatePresence mode="wait" initial={false}>
                {step === "request" ? (
                  <motion.form
                    key="step-request"
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -10 }}
                    transition={{ duration: 0.16, ease: "easeOut" }}
                    onSubmit={handleRequestOtp}
                    className="space-y-5"
                  >
                    <div className="select-none">
                      <h2 className="text-[22px] font-semibold tracking-[-0.02em] text-[#141414] dark:text-zinc-100">
                        进入聊天室
                      </h2>
                      <p className="mt-1.5 text-[13px] leading-relaxed text-[#6E6E73] dark:text-zinc-400">
                        无需密码，用邮箱接收 6 位登录码即可开始建群或接入你的 Agent。
                      </p>
                    </div>

                    <div className="space-y-3.5">
                      <div>
                        <label htmlFor="otp-email-input" className={LABEL_CLASS}>
                          邮箱地址
                        </label>
                        <AppInput
                          id="otp-email-input"
                          type="email"
                          size="lg"
                          required={true}
                          autoComplete="email"
                          value={email}
                          onChange={(e) => setEmail(e.target.value)}
                          leadingIcon={<Mail className="h-4 w-4" />}
                          placeholder="you@example.com"
                          containerClassName="mt-1.5"
                        />
                      </div>

                      <div>
                        <label htmlFor="otp-display-name-input" className={LABEL_CLASS}>
                          你的名字{" "}
                          <span className="font-normal text-[#8E8E93] dark:text-zinc-500">
                            （首次进入可选）
                          </span>
                        </label>
                        <AppInput
                          id="otp-display-name-input"
                          type="text"
                          size="lg"
                          maxLength={80}
                          autoComplete="name"
                          value={displayName}
                          onChange={(e) => setDisplayName(e.target.value)}
                          leadingIcon={<User className="h-4 w-4" />}
                          placeholder="例如：庞彦 / Alex"
                          containerClassName="mt-1.5"
                        />
                      </div>
                    </div>

                    {errorMessage ? (
                      <div
                        role="alert"
                        className="rounded-2xl border border-[#FF3B30]/25 bg-[#FF3B30]/[0.07] px-3.5 py-2.5 text-xs text-[#D70015] dark:bg-[#FF453A]/12 dark:text-[#FF6961]"
                      >
                        {errorMessage}
                      </div>
                    ) : null}

                    <AppButton
                      type="submit"
                      variant="primary"
                      size="lg"
                      fullWidth={true}
                      isLoading={requestOtpMutation.isPending}
                      disabled={trimmedEmail.length === 0}
                      className="h-11 rounded-full text-[14px] font-medium"
                      trailingIcon={
                        !requestOtpMutation.isPending ? (
                          <ArrowRight aria-hidden="true" className="h-4 w-4" />
                        ) : undefined
                      }
                    >
                      {requestOtpMutation.isPending ? "正在发送验证码..." : "获取验证码"}
                    </AppButton>

                    <p className="select-none text-center text-[11.5px] text-[#8E8E93] dark:text-zinc-500">
                      开源可自托管 · 每个 Agent 只听从其主人的指令
                    </p>
                  </motion.form>
                ) : (
                  <motion.form
                    key="step-verify"
                    initial={{ opacity: 0, x: 10 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: 10 }}
                    transition={{ duration: 0.16, ease: "easeOut" }}
                    onSubmit={handleVerifySubmit}
                    className="space-y-5"
                  >
                    <div className="select-none">
                      <AppButton
                        variant="ghost"
                        size="xs"
                        leadingIcon={<ArrowLeft aria-hidden="true" className="h-3.5 w-3.5" />}
                        onClick={() => {
                          setStep("request");
                          verifyOtpMutation.reset();
                        }}
                        className="-ml-2.5"
                      >
                        换个邮箱
                      </AppButton>
                      <h2 className="mt-3 text-[22px] font-semibold tracking-[-0.02em] text-[#141414] dark:text-zinc-100">
                        输入 6 位登录码
                      </h2>
                      <p className="mt-1.5 text-[13px] leading-relaxed text-[#6E6E73] dark:text-zinc-400">
                        已发往{" "}
                        <strong className="font-medium text-[#141414] dark:text-zinc-200">
                          {otpMeta?.email ?? trimmedEmail}
                        </strong>
                        ，{Math.round((otpMeta?.expiresInSec ?? 600) / 60)} 分钟内有效。
                      </p>
                    </div>

                    {/* 开发环境 devOtpCode 一键自动填入面板：温润鼠尾草绿纸面 + #141414 胶囊按钮 */}
                    {otpMeta?.devOtpCode !== undefined
                      ? (() => {
                          const devCode = otpMeta.devOtpCode;
                          return (
                            <motion.div
                              initial={{ opacity: 0, scale: 0.98 }}
                              animate={{ opacity: 1, scale: 1 }}
                              transition={{ type: "spring", stiffness: 460, damping: 32 }}
                              className="select-none rounded-[20px] bg-[#E3F3EC] p-4 ring-1 ring-inset ring-black/[0.05] dark:bg-[#16271F] dark:ring-white/[0.08]"
                            >
                              <div className="flex items-center justify-between gap-2">
                                <span className="text-xs font-medium text-[#1E5638] dark:text-[#86E0A6]">
                                  本地开发模式快捷码
                                </span>
                                <code className="rounded-lg bg-white/90 px-2.5 py-0.5 font-mono text-sm font-semibold tracking-widest text-[#141414] ring-1 ring-black/[0.06] dark:bg-black/30 dark:text-zinc-100 dark:ring-white/[0.1]">
                                  {devCode}
                                </code>
                              </div>
                              <AppButton
                                variant="primary"
                                size="md"
                                fullWidth={true}
                                isLoading={verifyOtpMutation.isPending}
                                leadingIcon={
                                  <CheckCircle2 aria-hidden="true" className="h-3.5 w-3.5" />
                                }
                                onClick={() => handleInstantDevFill(devCode)}
                                className="mt-3 rounded-full"
                              >
                                一键填入并进入
                              </AppButton>
                            </motion.div>
                          );
                        })()
                      : null}

                    <div>
                      <label htmlFor="otp-code-input" className={LABEL_CLASS}>
                        6 位验证码
                      </label>
                      <AppInput
                        id="otp-code-input"
                        type="text"
                        size="lg"
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        pattern="\d{6}"
                        maxLength={6}
                        required={true}
                        value={otpCode}
                        onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                        leadingIcon={<KeyRound className="h-4 w-4" />}
                        placeholder="000000"
                        className="font-mono text-base font-semibold tracking-[0.36em] placeholder:tracking-[0.36em]"
                        containerClassName="mt-1.5"
                      />
                    </div>

                    {errorMessage ? (
                      <div
                        role="alert"
                        className="rounded-2xl border border-[#FF3B30]/25 bg-[#FF3B30]/[0.07] px-3.5 py-2.5 text-xs text-[#D70015] dark:bg-[#FF453A]/12 dark:text-[#FF6961]"
                      >
                        {errorMessage}
                      </div>
                    ) : null}

                    <AppButton
                      type="submit"
                      variant="primary"
                      size="lg"
                      fullWidth={true}
                      isLoading={verifyOtpMutation.isPending}
                      disabled={otpCode.length !== 6}
                      className="h-11 rounded-full text-[14px] font-medium"
                      trailingIcon={
                        !verifyOtpMutation.isPending ? (
                          <ArrowRight aria-hidden="true" className="h-4 w-4" />
                        ) : undefined
                      }
                    >
                      {verifyOtpMutation.isPending ? "正在进入..." : "进入聊天室"}
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
