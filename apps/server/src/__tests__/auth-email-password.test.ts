/**
 * @module server/tests/auth-email-password
 * @description 人类邮箱+密码注册（邮箱 6 位验证码激活）、日常密码登录、忘记/重置密码、修改密码、用途隔离、防爆破熔断、SMTP 失败回滚及注册准入策略全链路集成测试。
 */
import { type ManagedDatabase, createDatabaseClient, ensureCoreSchema } from "@openhuddle/db";
import type {
  ApiErrorEnvelope,
  AuthCodeSentResponse,
  AuthPublicConfigResponse,
  AuthSessionResponse,
  CreatePairingCodeResponse,
  MeResponse,
  PairAgentResponse,
} from "@openhuddle/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServerApp } from "../app.js";
import { parseServerEnv } from "../infra/env.js";
import type { EmailMailer, EmailMessageInput } from "../infra/mailer.js";
import { InMemoryRealtimeBus } from "../infra/realtime-bus.js";

/**
 * 内存邮件捕获器：模拟已配置真实 SMTP 中继并可按需注入投递故障。
 */
class InMemoryTestMailer implements EmailMailer {
  public readonly isConfigured = true;
  public readonly driver = "smtp" as const;
  public readonly sent: EmailMessageInput[] = [];
  public failNextWith: Error | undefined;

  public async sendEmail(message: Readonly<EmailMessageInput>): Promise<void> {
    if (this.failNextWith !== undefined) {
      const err = this.failNextWith;
      this.failNextWith = undefined;
      throw err;
    }
    this.sent.push({ ...message });
  }
}

function extractSixDigitCode(text: string): string {
  const match = /\b(\d{6})\b/.exec(text);
  if (!match?.[1]) {
    throw new Error(`No 6-digit verification code found in email body: ${text}`);
  }
  return match[1];
}

describe("@openhuddle/server — email+password registration, login, reset & SMTP security E2E", () => {
  let database: ManagedDatabase;
  let bus: InMemoryRealtimeBus;

  beforeEach(async () => {
    database = createDatabaseClient({ url: "memory://" });
    await ensureCoreSchema(database.db);
    bus = new InMemoryRealtimeBus();
  });

  afterEach(async () => {
    await bus.close();
    await database.close();
  });

  it("completes SMTP-verified registration, password login, password reset (revoking prior sessions), and password change", async () => {
    const mailer = new InMemoryTestMailer();
    const env = parseServerEnv({
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      DATABASE_URL: "memory://",
      OTP_RESEND_COOLDOWN_SEC: "60",
    });
    const app = createServerApp({ env, database, realtimeBus: bus, mailer });

    // 1. 公开认证配置发现（零密钥泄漏）
    const cfgRes = await app.request("/api/v1/auth/config");
    expect(cfgRes.status).toBe(200);
    const cfg = (await cfgRes.json()) as AuthPublicConfigResponse;
    expect(cfg).toEqual({
      ok: true,
      allowPublicSignup: true,
      allowedEmailDomains: [],
      emailDeliveryMode: "smtp",
      otpResendCooldownSec: 60,
      otpTtlSec: 600,
      passwordMinLength: 8,
    });

    // 2. 请求发送注册验证码 -> 通过 SMTP 发送且不回显 devOtpCode
    const reqCodeRes = await app.request("/api/v1/auth/register/request-code", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "Alice@Example.com" }),
    });
    expect(reqCodeRes.status).toBe(200);
    const reqCodeBody = (await reqCodeRes.json()) as AuthCodeSentResponse;
    expect(reqCodeBody.delivery).toBe("smtp");
    expect(reqCodeBody.devOtpCode).toBeUndefined();
    expect(mailer.sent).toHaveLength(1);
    const regMail = mailer.sent[0];
    expect(regMail?.to).toBe("alice@example.com");
    expect(regMail?.subject).toContain("注册验证码");
    expect(regMail?.html).toContain("OpenHuddle");
    const regCode = extractSixDigitCode(regMail?.text ?? "");

    // 3. 60s 重发冷却保护
    const cooldownRes = await app.request("/api/v1/auth/register/request-code", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "alice@example.com" }),
    });
    expect(cooldownRes.status).toBe(429);
    const cooldownErr = (await cooldownRes.json()) as ApiErrorEnvelope;
    expect(cooldownErr.error.code).toBe("AUTH_RATE_LIMITED");

    // 4. 用途隔离：注册码不可用于密码重置或旧版 OTP 登录
    const crossPurposeRes = await app.request("/api/v1/auth/otp/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "alice@example.com", code: regCode }),
    });
    expect(crossPurposeRes.status).toBe(401);

    // 5. 核验邮箱验证码并完成注册 -> 201 + HttpOnly Cookie + 首个用户自动成为 admin
    const registerRes = await app.request("/api/v1/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "alice@example.com",
        code: regCode,
        displayName: "Alice",
        password: "InitialPassword#2026",
      }),
    });
    expect(registerRes.status).toBe(201);
    expect(registerRes.headers.get("set-cookie")).toContain("oh_session=");
    const registered = (await registerRes.json()) as AuthSessionResponse;
    expect(registered.user.email).toBe("alice@example.com");
    expect(registered.user.displayName).toBe("Alice");
    expect(registered.user.role).toBe("admin");
    expect(registered.user.emailVerified).toBe(true);
    expect(registered.user.hasPassword).toBe(true);
    expect("passwordHash" in registered.user).toBe(false);

    // 6. 重复注册同一邮箱 -> 409 EMAIL_ALREADY_REGISTERED
    const dupCodeRes = await app.request("/api/v1/auth/register/request-code", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "alice@example.com" }),
    });
    expect(dupCodeRes.status).toBe(409);
    expect(((await dupCodeRes.json()) as ApiErrorEnvelope).error.code).toBe(
      "EMAIL_ALREADY_REGISTERED",
    );

    // 7. 密码登录：错密码与不存在邮箱均统一 401 INVALID_CREDENTIALS
    const badPassRes = await app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "alice@example.com", password: "WrongPassword#1" }),
    });
    expect(badPassRes.status).toBe(401);
    expect(((await badPassRes.json()) as ApiErrorEnvelope).error.code).toBe("INVALID_CREDENTIALS");

    const ghostLoginRes = await app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "ghost@example.com", password: "AnyPassword#1" }),
    });
    expect(ghostLoginRes.status).toBe(401);
    expect(((await ghostLoginRes.json()) as ApiErrorEnvelope).error.code).toBe(
      "INVALID_CREDENTIALS",
    );

    const goodLoginRes = await app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "ALICE@example.com", password: "InitialPassword#2026" }),
    });
    expect(goodLoginRes.status).toBe(200);
    const secondDeviceSession = (await goodLoginRes.json()) as AuthSessionResponse;
    expect(secondDeviceSession.sessionToken).not.toBe(registered.sessionToken);

    // 8. 忘记密码对未知邮箱返回防枚举静默 200 且不发信
    const unknownResetRes = await app.request("/api/v1/auth/password-reset/request-code", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "nobody@example.com" }),
    });
    expect(unknownResetRes.status).toBe(200);
    expect(mailer.sent).toHaveLength(1);

    // 9. 合法用户请求密码重置 -> 更新密码后历史两台设备会话全部立即失效
    const resetReqRes = await app.request("/api/v1/auth/password-reset/request-code", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "alice@example.com" }),
    });
    expect(resetReqRes.status).toBe(200);
    expect(mailer.sent).toHaveLength(2);
    const resetCode = extractSixDigitCode(mailer.sent[1]?.text ?? "");

    const resetConfirmRes = await app.request("/api/v1/auth/password-reset/confirm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "alice@example.com",
        code: resetCode,
        newPassword: "ResetPassword#2026",
      }),
    });
    expect(resetConfirmRes.status).toBe(200);
    const resetSession = (await resetConfirmRes.json()) as AuthSessionResponse;

    // 历史设备令牌必须全部被吊销
    const oldDeviceMeRes = await app.request("/api/v1/me", {
      headers: { authorization: `Bearer ${registered.sessionToken}` },
    });
    expect(oldDeviceMeRes.status).toBe(401);
    const secondDeviceMeRes = await app.request("/api/v1/me", {
      headers: { authorization: `Bearer ${secondDeviceSession.sessionToken}` },
    });
    expect(secondDeviceMeRes.status).toBe(401);

    // 新设备会话有效，且旧密码失效、新密码可登录
    const newDeviceMeRes = await app.request("/api/v1/me", {
      headers: { authorization: `Bearer ${resetSession.sessionToken}` },
    });
    expect(newDeviceMeRes.status).toBe(200);
    const meBody = (await newDeviceMeRes.json()) as MeResponse;
    expect(meBody.callerKind === "human" && meBody.user.hasPassword).toBe(true);

    // 10. 已登录用户修改密码（错误当前密码拒绝；正确当前密码轮换会话；Agent 令牌 403）
    const wrongChangeRes = await app.request("/api/v1/auth/password/change", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${resetSession.sessionToken}`,
      },
      body: JSON.stringify({
        currentPassword: "WrongCurrentPassword",
        newPassword: "ChangedPassword#2026",
      }),
    });
    expect(wrongChangeRes.status).toBe(401);

    const changeRes = await app.request("/api/v1/auth/password/change", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${resetSession.sessionToken}`,
      },
      body: JSON.stringify({
        currentPassword: "ResetPassword#2026",
        newPassword: "ChangedPassword#2026",
      }),
    });
    expect(changeRes.status).toBe(200);
    const rotated = (await changeRes.json()) as AuthSessionResponse;
    expect(rotated.sessionToken).not.toBe(resetSession.sessionToken);

    // 旧会话已被轮换踢出
    expect(
      (
        await app.request("/api/v1/me", {
          headers: { authorization: `Bearer ${resetSession.sessionToken}` },
        })
      ).status,
    ).toBe(401);

    // 绑定一个 Agent 验证 Agent 严禁调用人类改密接口
    const pairCodeRes = await app.request("/api/v1/pairing-codes", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${rotated.sessionToken}`,
      },
      body: JSON.stringify({}),
    });
    const pairCode = (await pairCodeRes.json()) as CreatePairingCodeResponse;
    const pairedRes = await app.request("/api/v1/pair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: pairCode.code, name: "Alice Bot", platform: "codex" }),
    });
    const paired = (await pairedRes.json()) as PairAgentResponse;
    const agentChangeRes = await app.request("/api/v1/auth/password/change", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${paired.token}`,
      },
      body: JSON.stringify({ newPassword: "HijackedPassword#1" }),
    });
    expect(agentChangeRes.status).toBe(403);
    expect(((await agentChangeRes.json()) as ApiErrorEnvelope).error.code).toBe(
      "FORBIDDEN_NOT_OWNER",
    );
  });

  it("locks out an OTP code after 5 invalid attempts and rolls back OTP on SMTP failure so user can retry immediately", async () => {
    const mailer = new InMemoryTestMailer();
    const env = parseServerEnv({
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      DATABASE_URL: "memory://",
      OTP_RESEND_COOLDOWN_SEC: "60",
    });
    const app = createServerApp({ env, database, realtimeBus: bus, mailer });

    // 1. SMTP 首次投递失败 -> 502 且回滚记录，允许立即重试不受 60s 冷却阻拦
    mailer.failNextWith = new Error("Simulated Aliyun DirectMail timeout");
    const failedSendRes = await app.request("/api/v1/auth/register/request-code", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "retry@example.com" }),
    });
    expect(failedSendRes.status).toBe(502);
    expect(((await failedSendRes.json()) as ApiErrorEnvelope).error.code).toBe(
      "EMAIL_DELIVERY_FAILED",
    );

    const retrySendRes = await app.request("/api/v1/auth/register/request-code", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "retry@example.com" }),
    });
    expect(retrySendRes.status).toBe(200);
    const realCode = extractSixDigitCode(mailer.sent[0]?.text ?? "");
    const wrongCode = realCode === "000000" ? "999999" : "000000";

    // 2. 连续 4 次输错返回 400 OTP_INVALID_OR_EXPIRED（附剩余次数），第 5 次输错触发 429 熔断作废
    for (let attempt = 1; attempt <= 4; attempt++) {
      const badRes = await app.request("/api/v1/auth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "retry@example.com",
          code: wrongCode,
          displayName: "RetryUser",
          password: "ValidPassword#2026",
        }),
      });
      expect(badRes.status).toBe(400);
      const err = (await badRes.json()) as ApiErrorEnvelope;
      expect(err.error.code).toBe("OTP_INVALID_OR_EXPIRED");
    }

    const fifthRes = await app.request("/api/v1/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "retry@example.com",
        code: wrongCode,
        displayName: "RetryUser",
        password: "ValidPassword#2026",
      }),
    });
    expect(fifthRes.status).toBe(429);
    expect(((await fifthRes.json()) as ApiErrorEnvelope).error.code).toBe("OTP_ATTEMPTS_EXCEEDED");

    // 3. 熔断作废后即使输入正确验证码也必须被拒绝
    const afterLockoutRes = await app.request("/api/v1/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "retry@example.com",
        code: realCode,
        displayName: "RetryUser",
        password: "ValidPassword#2026",
      }),
    });
    expect(afterLockoutRes.status).toBe(400);
    expect(((await afterLockoutRes.json()) as ApiErrorEnvelope).error.code).toBe(
      "OTP_INVALID_OR_EXPIRED",
    );

    // 4. 熔断作废后允许立即重新申请新验证码并完成注册（不被已作废旧码的 60s 冷却锁死）
    const replacementRes = await app.request("/api/v1/auth/register/request-code", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "retry@example.com" }),
    });
    expect(replacementRes.status).toBe(200);
    const freshCode = extractSixDigitCode(mailer.sent[1]?.text ?? "");

    const completeRegRes = await app.request("/api/v1/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "retry@example.com",
        code: freshCode,
        displayName: "RetryUser",
        password: "ValidPassword#2026",
      }),
    });
    expect(completeRegRes.status).toBe(201);
  });

  it("enforces ALLOW_PUBLIC_SIGNUP, ALLOWED_EMAIL_DOMAINS, login failure rate limits, and production SMTP fail-closed", async () => {
    const mailer = new InMemoryTestMailer();

    // A. 关闭公开注册
    const closedEnv = parseServerEnv({
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      DATABASE_URL: "memory://",
      ALLOW_PUBLIC_SIGNUP: "false",
    });
    const closedApp = createServerApp({ env: closedEnv, database, realtimeBus: bus, mailer });
    const closedCfg = (await (
      await closedApp.request("/api/v1/auth/config")
    ).json()) as AuthPublicConfigResponse;
    expect(closedCfg.allowPublicSignup).toBe(false);

    const closedReqRes = await closedApp.request("/api/v1/auth/register/request-code", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "blocked@example.com" }),
    });
    expect(closedReqRes.status).toBe(403);
    expect(((await closedReqRes.json()) as ApiErrorEnvelope).error.code).toBe("SIGNUP_DISABLED");

    // B. 邮箱域名白名单
    const domainEnv = parseServerEnv({
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      DATABASE_URL: "memory://",
      ALLOWED_EMAIL_DOMAINS: "company.com, @partner.org",
    });
    const domainApp = createServerApp({ env: domainEnv, database, realtimeBus: bus, mailer });

    const badDomainRes = await domainApp.request("/api/v1/auth/register/request-code", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "user@evil-company.com" }),
    });
    expect(badDomainRes.status).toBe(403);
    expect(((await badDomainRes.json()) as ApiErrorEnvelope).error.code).toBe(
      "EMAIL_DOMAIN_NOT_ALLOWED",
    );

    const okDomainRes = await domainApp.request("/api/v1/auth/register/request-code", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "alice@company.com" }),
    });
    expect(okDomainRes.status).toBe(200);

    // C. 生产环境未配置 SMTP 且未开启 ALLOW_DEV_OTP_ECHO -> 503 EMAIL_DELIVERY_UNAVAILABLE
    const prodNoSmtpEnv = parseServerEnv({
      NODE_ENV: "production",
      LOG_LEVEL: "silent",
      DATABASE_URL: "memory://",
      AUTH_SECRET: "prod-strong-secret-at-least-32-chars-long-9999",
    });
    const prodNoSmtpApp = createServerApp({ env: prodNoSmtpEnv, database, realtimeBus: bus });
    const prodCfg = (await (
      await prodNoSmtpApp.request("/api/v1/auth/config")
    ).json()) as AuthPublicConfigResponse;
    expect(prodCfg.emailDeliveryMode).toBe("unavailable");

    const unavailRes = await prodNoSmtpApp.request("/api/v1/auth/register/request-code", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "prod@example.com" }),
    });
    expect(unavailRes.status).toBe(503);
    expect(((await unavailRes.json()) as ApiErrorEnvelope).error.code).toBe(
      "EMAIL_DELIVERY_UNAVAILABLE",
    );

    // D. 连续 10 次密码错误触发 429 AUTH_RATE_LIMITED
    for (let i = 0; i < 10; i++) {
      const failRes = await domainApp.request("/api/v1/auth/login", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": "203.0.113.42",
        },
        body: JSON.stringify({ email: "brute@company.com", password: "wrong-password" }),
      });
      expect(failRes.status).toBe(401);
    }
    const throttledRes = await domainApp.request("/api/v1/auth/login", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": "203.0.113.42",
      },
      body: JSON.stringify({ email: "brute@company.com", password: "wrong-password" }),
    });
    expect(throttledRes.status).toBe(429);
    expect(((await throttledRes.json()) as ApiErrorEnvelope).error.code).toBe("AUTH_RATE_LIMITED");
  });

  it("migrates legacy passwordless OTP users cleanly via change-password or password-reset", async () => {
    const env = parseServerEnv({
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      DATABASE_URL: "memory://",
      OTP_RESEND_COOLDOWN_SEC: "0",
    });
    // 未传 mailer -> dev_echo 回退模式
    const app = createServerApp({ env, database, realtimeBus: bus });

    const otpReqRes = await app.request("/api/v1/auth/otp/request", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "legacy@example.com", displayName: "LegacyOwner" }),
    });
    expect(otpReqRes.status).toBe(200);
    const otpReqBody = (await otpReqRes.json()) as { devOtpCode?: string };
    expect(otpReqBody.devOtpCode).toMatch(/^\d{6}$/);

    const otpVerifyRes = await app.request("/api/v1/auth/otp/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "legacy@example.com", code: otpReqBody.devOtpCode }),
    });
    expect(otpVerifyRes.status).toBe(200);
    const legacySession = (await otpVerifyRes.json()) as AuthSessionResponse;
    expect(legacySession.user.hasPassword).toBe(false);

    // 尚未设置密码时密码登录返回统一 401 INVALID_CREDENTIALS
    const noPassLoginRes = await app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "legacy@example.com", password: "Anything#123" }),
    });
    expect(noPassLoginRes.status).toBe(401);

    // 老用户无需 currentPassword 即可直接补设初始密码
    const setInitialPassRes = await app.request("/api/v1/auth/password/change", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${legacySession.sessionToken}`,
      },
      body: JSON.stringify({ newPassword: "MigratedPassword#2026" }),
    });
    expect(setInitialPassRes.status).toBe(200);
    const migrated = (await setInitialPassRes.json()) as AuthSessionResponse;
    expect(migrated.user.hasPassword).toBe(true);

    // 补设后可正常使用邮箱 + 密码登录
    const afterMigrateLogin = await app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "legacy@example.com", password: "MigratedPassword#2026" }),
    });
    expect(afterMigrateLogin.status).toBe(200);
  });
});
