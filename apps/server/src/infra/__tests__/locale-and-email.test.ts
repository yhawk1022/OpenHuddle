/**
 * @module server/infra/tests/locale-and-email
 * @description 验证 RFC 9110 §12.5.4 `parseAcceptLanguage` 语言协商边界与双语验证码邮件模板（中文向后兼容 + 英文地道文案、单复数与 XSS 防护）。
 */
import { describe, expect, it } from "vitest";
import { renderVerificationEmail } from "../email-templates.js";
import { parseAcceptLanguage } from "../locale.js";

describe("@openhuddle/server/infra — parseAcceptLanguage (RFC 9110 §12.5.4)", () => {
  it("falls back cleanly when header is missing, empty, wildcard-only, or contains only zero/invalid weights", () => {
    expect(parseAcceptLanguage(undefined)).toBe("zh-CN");
    expect(parseAcceptLanguage("")).toBe("zh-CN");
    expect(parseAcceptLanguage("   ")).toBe("zh-CN");
    expect(parseAcceptLanguage("*")).toBe("zh-CN");
    expect(parseAcceptLanguage("*;q=0.5")).toBe("zh-CN");
    expect(parseAcceptLanguage("en-US;q=0")).toBe("zh-CN");
    expect(parseAcceptLanguage("en-US;q=1.5, fr-FR;q=abc, 123")).toBe("zh-CN");
    expect(parseAcceptLanguage("en-US;q=0.5;q=0.8")).toBe("zh-CN");
    expect(parseAcceptLanguage("en-US;q")).toBe("zh-CN");
    expect(parseAcceptLanguage(undefined, "en")).toBe("en");
    expect(parseAcceptLanguage("*", "en")).toBe("en");
  });

  it("matches primary languages by stable descending quality weight", () => {
    expect(parseAcceptLanguage("en-US")).toBe("en");
    expect(parseAcceptLanguage("zh-CN")).toBe("zh-CN");
    expect(parseAcceptLanguage("en-US,zh-CN;q=0.9")).toBe("en");
    expect(parseAcceptLanguage("zh-CN;q=0.8,en-US;q=0.9")).toBe("en");
    expect(parseAcceptLanguage("fr-FR,zh-TW;q=0.8")).toBe("zh-CN");
    expect(parseAcceptLanguage("en-GB;q=0,zh-CN;q=0.5")).toBe("zh-CN");
    expect(parseAcceptLanguage("en-US;q=invalid,zh-CN;q=0.4")).toBe("zh-CN");

    // 相同权重按原出现顺序稳定排序
    expect(parseAcceptLanguage("zh-CN;q=0.8, en-US;q=0.8")).toBe("zh-CN");
    expect(parseAcceptLanguage("en-US;q=0.8, zh-CN;q=0.8")).toBe("en");

    // 主语言优先于地区子标
    expect(parseAcceptLanguage("en-CN")).toBe("en");
    expect(parseAcceptLanguage("zh-US")).toBe("zh-CN");
  });

  it("supports all Chinese language family primaries and Chinese region subtag fallback, defaulting other locales to en", () => {
    for (const tag of ["zh", "cmn-Hans-SG", "yue-HK", "wuu", "nan-TW", "hak", "hsn", "gan"]) {
      expect(parseAcceptLanguage(tag)).toBe("zh-CN");
    }

    // 主语言未命中中文/英文时，检查中文地区子标（CN/HK/MO/TW）
    expect(parseAcceptLanguage("bo-CN")).toBe("zh-CN");
    expect(parseAcceptLanguage("bo-Tibt-CN")).toBe("zh-CN");
    expect(parseAcceptLanguage("ug-HK")).toBe("zh-CN");
    expect(parseAcceptLanguage("ii-MO")).toBe("zh-CN");
    expect(parseAcceptLanguage("ami-TW")).toBe("zh-CN");

    // 扩展/私用子标内的 -cn 不得误判为地区子标
    expect(parseAcceptLanguage("ja-JP-x-cn")).toBe("en");
    expect(parseAcceptLanguage("ja-JP-u-ca-cn")).toBe("en");

    // 其余语言统一回退英文
    expect(parseAcceptLanguage("ja-JP")).toBe("en");
    expect(parseAcceptLanguage("fr-FR")).toBe("en");
    expect(parseAcceptLanguage("de-DE,es-ES;q=0.9")).toBe("en");
  });
});

describe("@openhuddle/server/infra — bilingual renderVerificationEmail", () => {
  it("preserves exact zh-CN templates as default and explicit locale", () => {
    const defaultReg = renderVerificationEmail({
      purpose: "register",
      code: "482910",
      expiresInMinutes: 10,
      publicBaseUrl: "https://huddle.example.com",
    });
    const explicitZhReg = renderVerificationEmail({
      purpose: "register",
      code: "482910",
      expiresInMinutes: 10,
      publicBaseUrl: "https://huddle.example.com",
      locale: "zh-CN",
    });
    expect(explicitZhReg).toEqual(defaultReg);
    expect(defaultReg.subject).toBe("【OpenHuddle】注册验证码：482910");
    expect(defaultReg.text).toContain("验证你的邮箱并完成注册");
    expect(defaultReg.text).toContain("有效期：10 分钟");
    expect(defaultReg.html).toContain('<html lang="zh-CN">');

    const zhReset = renderVerificationEmail({
      purpose: "password_reset",
      code: "123456",
      expiresInMinutes: 10,
      publicBaseUrl: "https://huddle.example.com",
      locale: "zh-CN",
    });
    expect(zhReset.subject).toBe("【OpenHuddle】重置密码验证码：123456");

    const zhLogin = renderVerificationEmail({
      purpose: "login",
      code: "654321",
      expiresInMinutes: 10,
      publicBaseUrl: "https://huddle.example.com",
      locale: "zh-CN",
    });
    expect(zhLogin.subject).toBe("【OpenHuddle】登录验证码：654321");
  });

  it("renders natural English templates with pluralization and strict HTML escaping", () => {
    const enRegister = renderVerificationEmail({
      purpose: "register",
      code: "482910",
      expiresInMinutes: 1,
      publicBaseUrl: "https://huddle.example.com",
      locale: "en",
    });
    expect(enRegister.subject).toBe("[OpenHuddle] Registration verification code: 482910");
    expect(enRegister.text).toContain("Expires in: 1 minute (single-use, up to 5 attempts)");
    expect(enRegister.text).not.toContain("1 minutes");
    expect(enRegister.html).toContain('<html lang="en">');
    expect(enRegister.html).toContain("<strong>1 minute</strong>");

    const enReset = renderVerificationEmail({
      purpose: "password_reset",
      code: "778899",
      expiresInMinutes: 10,
      publicBaseUrl: "https://huddle.example.com",
      locale: "en",
    });
    expect(enReset.subject).toBe("[OpenHuddle] Password reset code: 778899");
    expect(enReset.text).toContain("Expires in: 10 minutes");
    expect(enReset.html).toContain("<strong>10 minutes</strong>");
    expect(enReset.html).toContain("other devices will be signed out automatically");

    const enLogin = renderVerificationEmail({
      purpose: "login",
      code: "112233",
      expiresInMinutes: 5,
      publicBaseUrl: "https://huddle.example.com",
      locale: "en",
    });
    expect(enLogin.subject).toBe("[OpenHuddle] Sign-in verification code: 112233");
    expect(enLogin.html).toContain('<html lang="en">');

    // XSS 防护：URL 与动态字段中的 HTML 特殊字符必须被严格转义
    const xssMail = renderVerificationEmail({
      purpose: "register",
      code: "<b>123456</b>",
      expiresInMinutes: 10,
      publicBaseUrl: 'https://evil.example/?x="><script>alert(1)</script>',
      locale: "en",
    });
    expect(xssMail.html).not.toContain("<script>");
    expect(xssMail.html).not.toContain("<b>123456</b>");
    expect(xssMail.html).toContain("&lt;b&gt;123456&lt;/b&gt;");
    expect(xssMail.html).toContain("&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;");
  });
});
