/**
 * @module server/infra/email-templates
 * @description 人类注册激活、密码重置与旧版 OTP 验证码的纯函数邮件模板生成器（同时输出 `text/plain` 与 `text/html` 双正文）。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 纯函数零副作用：仅依赖入参生成邮件主题、纯文本与高兼容内联样式 HTML，不触发任何网络或文件 I/O。
 * 2. XSS 与 HTML 注入免疫：所有动态插值均经过严格 HTML 实体转义。
 * 3. 双版本送达保证：`multipart/alternative` 同时包含简洁纯文本与温润编辑部风格 HTML，兼顾终端客户端与 Apple Mail / Gmail / QQ / 网易邮箱。
 */
import type { OtpPurpose } from "@openhuddle/protocol";

/**
 * 已渲染完成的验证邮件内容载体。
 */
export interface RenderedVerificationEmail {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

/**
 * 渲染验证码邮件所需的入参。
 */
export interface VerificationEmailTemplateInput {
  readonly purpose: OtpPurpose;
  readonly code: string;
  readonly expiresInMinutes: number;
  readonly publicBaseUrl: string;
}

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * 按业务用途（`register` / `password_reset` / `login`）生成标准化的 6 位验证码邮件内容。
 *
 * @param input - 邮件用途、6 位验证码、有效分钟数与站点公开地址
 * @returns 包含主题、纯文本与 HTML 正文的不可变邮件对象
 */
export function renderVerificationEmail(
  input: Readonly<VerificationEmailTemplateInput>,
): RenderedVerificationEmail {
  const safeCode = escapeHtml(input.code);
  const safeMinutes = String(Math.max(1, Math.round(input.expiresInMinutes)));
  const safeBaseUrl = escapeHtml(input.publicBaseUrl);

  let actionTitle: string;
  let subjectPrefix: string;
  let leadSentence: string;
  let securityNote: string;

  switch (input.purpose) {
    case "register":
      actionTitle = "验证你的邮箱并完成注册";
      subjectPrefix = "注册验证码";
      leadSentence = "你正在注册 OpenHuddle 账号，请在页面中输入以下 6 位验证码完成邮箱验证：";
      securityNote = "如非本人发起注册，请直接忽略此邮件，你的邮箱不会被创建账号。";
      break;
    case "password_reset":
      actionTitle = "重置你的登录密码";
      subjectPrefix = "重置密码验证码";
      leadSentence = "你正在申请重置 OpenHuddle 登录密码，请在页面中输入以下 6 位验证码：";
      securityNote =
        "密码重置成功后，你名下其余设备的登录会话将自动安全下线。如非本人操作，请忽略此邮件并注意账号安全。";
      break;
    case "login":
      actionTitle = "一次性登录验证码";
      subjectPrefix = "登录验证码";
      leadSentence = "请使用以下 6 位验证码完成 OpenHuddle 身份验证：";
      securityNote = "如非本人操作，请勿将验证码泄露给任何人。";
      break;
  }

  const subject = `【OpenHuddle】${subjectPrefix}：${input.code}`;

  const text = [
    `OpenHuddle · ${actionTitle}`,
    "",
    leadSentence,
    "",
    `验证码：${input.code}`,
    `有效期：${safeMinutes} 分钟（单次有效，最多允许 5 次校验尝试）`,
    "",
    securityNote,
    "",
    `— OpenHuddle (${input.publicBaseUrl})`,
  ].join("\n");

  const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background-color:#F5F5F7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif;color:#141414;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color:#F5F5F7;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:520px;background-color:#FFFFFF;border-radius:20px;border:1px solid #E5E5EA;overflow:hidden;">
          <tr>
            <td style="padding:28px 32px 12px 32px;">
              <div style="font-size:17px;font-weight:700;letter-spacing:-0.02em;color:#141414;">OpenHuddle</div>
              <h1 style="margin:14px 0 0 0;font-size:20px;font-weight:600;line-height:1.35;color:#141414;">${escapeHtml(actionTitle)}</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:8px 32px 20px 32px;font-size:14px;line-height:1.65;color:#52525B;">
              <p style="margin:0 0 18px 0;">${escapeHtml(leadSentence)}</p>
              <div style="margin:0 0 18px 0;padding:18px 20px;background-color:#F6F2EC;border-radius:14px;border:1px solid #E8DFD1;text-align:center;">
                <span style="font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:32px;font-weight:700;letter-spacing:0.28em;color:#141414;">${safeCode}</span>
              </div>
              <p style="margin:0 0 10px 0;font-size:13px;color:#6E6E73;">验证码将在 <strong>${safeMinutes} 分钟</strong>后失效，仅可使用一次。</p>
              <p style="margin:0;font-size:12.5px;color:#8E8E93;line-height:1.6;">${escapeHtml(securityNote)}</p>
            </td>
          </tr>
          <tr>
            <td style="padding:16px 32px 24px 32px;border-top:1px solid #F0F0F4;font-size:12px;color:#8E8E93;">
              此邮件由系统自动发送，请勿直接回复 · <a href="${safeBaseUrl}" style="color:#52525B;text-decoration:none;">${safeBaseUrl}</a>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  return { subject, text, html };
}
