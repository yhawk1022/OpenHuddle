/**
 * @module server/infra/tests/mailer
 * @description 验证原生零依赖 SMTP 客户端（`AUTH PLAIN` / `AUTH LOGIN` / 报文编码 / 防头部注入 / 凭据文件解析）、`scrypt` 密码哈希与滑动窗口限流器核心不变量。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hashPasswordScrypt, verifyPasswordScrypt } from "../crypto.js";
import { parseAllowedEmailDomainSet, parseServerEnv } from "../env.js";
import {
  DEFAULT_ALIYUN_SMTP_HOST,
  SmtpMailer,
  buildRfc5322Message,
  dotStuffSmtpData,
  resolveSmtpConfig,
} from "../mailer.js";
import { SlidingWindowRateLimiter } from "../rate-limiter.js";

interface MockSmtpCapturedMessage {
  readonly commands: readonly string[];
  readonly data: string;
}

/**
 * 在本地回环随机端口启动轻量级真实 TCP SMTP 模拟服务端，用于验证底层协议帧与认证握手。
 */
async function startMockSmtpServer(options: {
  readonly authAdvertised: string;
  readonly expectedUser: string;
  readonly expectedPass: string;
  readonly rejectAuth?: boolean;
}): Promise<{
  readonly port: number;
  readonly captured: MockSmtpCapturedMessage[];
  readonly close: () => Promise<void>;
}> {
  const captured: MockSmtpCapturedMessage[] = [];

  const server = net.createServer((socket) => {
    const commands: string[] = [];
    let buffer = "";
    let state: "cmd" | "auth_login_user" | "auth_login_pass" | "data" = "cmd";
    let loginUser = "";
    let dataLines: string[] = [];

    socket.write("220 mock-smtp.local ESMTP Ready\r\n");

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      while (true) {
        const idx = buffer.indexOf("\n");
        if (idx < 0) {
          break;
        }
        const line = buffer.slice(0, idx).replace(/\r$/, "");
        buffer = buffer.slice(idx + 1);

        if (state === "data") {
          if (line === ".") {
            captured.push({ commands: [...commands], data: dataLines.join("\r\n") });
            dataLines = [];
            state = "cmd";
            socket.write("250 2.0.0 OK queued\r\n");
          } else {
            dataLines.push(line);
          }
          continue;
        }

        if (state === "auth_login_user") {
          loginUser = Buffer.from(line, "base64").toString("utf8");
          state = "auth_login_pass";
          socket.write("334 UGFzc3dvcmQ6\r\n");
          continue;
        }

        if (state === "auth_login_pass") {
          const loginPass = Buffer.from(line, "base64").toString("utf8");
          state = "cmd";
          if (
            !options.rejectAuth &&
            loginUser === options.expectedUser &&
            loginPass === options.expectedPass
          ) {
            socket.write("235 2.7.0 Authentication successful\r\n");
          } else {
            socket.write("535 5.7.8 Authentication credentials invalid\r\n");
          }
          continue;
        }

        commands.push(line);
        const upper = line.toUpperCase();

        if (upper.startsWith("EHLO ")) {
          socket.write(
            `250-mock-smtp.local Hello\r\n250-${options.authAdvertised}\r\n250 8BITMIME\r\n`,
          );
        } else if (upper.startsWith("AUTH PLAIN ")) {
          const raw = Buffer.from(line.slice(11).trim(), "base64").toString("utf8");
          const parts = raw.split("\u0000");
          if (
            !options.rejectAuth &&
            parts[1] === options.expectedUser &&
            parts[2] === options.expectedPass
          ) {
            socket.write("235 2.7.0 Authentication successful\r\n");
          } else {
            socket.write("535 5.7.8 Authentication failed\r\n");
          }
        } else if (upper === "AUTH LOGIN") {
          state = "auth_login_user";
          socket.write("334 VXNlcm5hbWU6\r\n");
        } else if (upper.startsWith("MAIL FROM:")) {
          socket.write("250 2.1.0 Sender OK\r\n");
        } else if (upper.startsWith("RCPT TO:")) {
          socket.write("250 2.1.5 Recipient OK\r\n");
        } else if (upper === "DATA") {
          state = "data";
          socket.write("354 End data with <CR><LF>.<CR><LF>\r\n");
        } else if (upper === "QUIT") {
          socket.write("221 2.0.0 Bye\r\n");
          socket.end();
        } else {
          socket.write("502 Command not implemented\r\n");
        }
      }
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind mock SMTP server port");
  }

  return {
    port: address.port,
    captured,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

describe("@openhuddle/server/infra — SMTP mailer, credentials, scrypt & rate limiter", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("resolves SMTP config from cyanarch-mail style credentials file with Aliyun defaults and env overrides", () => {
    const emptyEnv = parseServerEnv({ NODE_ENV: "test", LOG_LEVEL: "silent" });
    expect(resolveSmtpConfig(emptyEnv)).toBeUndefined();

    const dir = mkdtempSync(path.join(tmpdir(), "openhuddle-smtp-"));
    tempDirs.push(dir);
    const credsPath = path.join(dir, "smtp.json");
    writeFileSync(
      credsPath,
      JSON.stringify({ username: "noreply@cyanarch.com", password: "secret-password-123" }),
      "utf8",
    );

    const fileOnlyEnv = parseServerEnv({
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      SMTP_CREDENTIALS_FILE: credsPath,
    });
    const resolvedFromFile = resolveSmtpConfig(fileOnlyEnv);
    expect(resolvedFromFile).toMatchObject({
      host: DEFAULT_ALIYUN_SMTP_HOST,
      port: 465,
      secure: true,
      username: "noreply@cyanarch.com",
      password: "secret-password-123",
      fromAddress: "noreply@cyanarch.com",
      fromName: "OpenHuddle",
      timeoutMs: 15_000,
    });

    // 环境变量优先级高于凭据文件
    const overriddenEnv = parseServerEnv({
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      SMTP_CREDENTIALS_FILE: credsPath,
      SMTP_HOST: "smtp.custom.example",
      SMTP_PORT: "587",
      SMTP_SECURE: "false",
      SMTP_FROM: "auth@custom.example",
    });
    const overridden = resolveSmtpConfig(overriddenEnv);
    expect(overridden).toMatchObject({
      host: "smtp.custom.example",
      port: 587,
      secure: false,
      username: "noreply@cyanarch.com",
      password: "secret-password-123",
      fromAddress: "auth@custom.example",
    });

    // 凭据文件缺失时启动期快速失败
    const missingFileEnv = parseServerEnv({
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      SMTP_CREDENTIALS_FILE: path.join(dir, "does-not-exist.json"),
    });
    expect(() => resolveSmtpConfig(missingFileEnv)).toThrow(/SMTP_CREDENTIALS_FILE/);
  });

  it("encodes UTF-8 Chinese subjects, blocks header injection, and dot-stuffs DATA lines", () => {
    const raw = buildRfc5322Message({
      fromAddress: "noreply@cyanarch.com",
      fromName: "OpenHuddle 协作舱",
      to: "alice@example.com",
      subject: "【OpenHuddle】注册验证码：482910",
      text: "验证码：482910",
      html: "<p>验证码：<strong>482910</strong></p>",
    });
    expect(raw).toContain("Subject: =?UTF-8?B?");
    expect(raw).toContain("Content-Type: multipart/alternative;");
    expect(raw).toContain("Content-Type: text/plain; charset=UTF-8");
    expect(raw).toContain("Content-Type: text/html; charset=UTF-8");

    expect(() =>
      buildRfc5322Message({
        fromAddress: "noreply@cyanarch.com",
        to: "alice@example.com\r\nBcc: attacker@evil.com",
        subject: "Test",
        text: "Hello",
      }),
    ).toThrow(/Unsafe control character/);

    expect(dotStuffSmtpData("line1\n.leading-dot\r\n..two-dots")).toBe(
      "line1\r\n..leading-dot\r\n...two-dots",
    );
  });

  it("completes real SMTP wire exchange with AUTH PLAIN and AUTH LOGIN and surfaces relay auth rejections", async () => {
    const plainServer = await startMockSmtpServer({
      authAdvertised: "AUTH PLAIN LOGIN",
      expectedUser: "noreply@cyanarch.com",
      expectedPass: "pass-plain-1",
    });
    try {
      const mailer = new SmtpMailer({
        host: "127.0.0.1",
        port: plainServer.port,
        secure: false,
        username: "noreply@cyanarch.com",
        password: "pass-plain-1",
        fromAddress: "noreply@cyanarch.com",
        fromName: "OpenHuddle",
        timeoutMs: 5_000,
      });

      const verifyRes = await mailer.verifyConnection();
      expect(verifyRes.code).toBe(235);

      await mailer.sendEmail({
        to: "user@example.com",
        subject: "【OpenHuddle】注册验证码：654321",
        text: "你的验证码是 654321",
        html: "<p>654321</p>",
      });

      expect(plainServer.captured).toHaveLength(1);
      expect(plainServer.captured[0]?.commands.some((cmd) => cmd.startsWith("AUTH PLAIN "))).toBe(
        true,
      );
      expect(plainServer.captured[0]?.commands).toContain("MAIL FROM:<noreply@cyanarch.com>");
      expect(plainServer.captured[0]?.commands).toContain("RCPT TO:<user@example.com>");
      expect(plainServer.captured[0]?.data).toContain("To: <user@example.com>");
    } finally {
      await plainServer.close();
    }

    const loginServer = await startMockSmtpServer({
      authAdvertised: "AUTH LOGIN",
      expectedUser: "noreply@cyanarch.com",
      expectedPass: "pass-login-2",
    });
    try {
      const mailer = new SmtpMailer({
        host: "127.0.0.1",
        port: loginServer.port,
        secure: false,
        username: "noreply@cyanarch.com",
        password: "pass-login-2",
        fromAddress: "noreply@cyanarch.com",
        timeoutMs: 5_000,
      });

      await mailer.sendEmail({
        to: "bob@example.com",
        subject: "Reset Password",
        text: "Code: 112233",
      });
      expect(loginServer.captured).toHaveLength(1);
      expect(loginServer.captured[0]?.commands).toContain("AUTH LOGIN");

      const badPassMailer = new SmtpMailer({
        host: "127.0.0.1",
        port: loginServer.port,
        secure: false,
        username: "noreply@cyanarch.com",
        password: "wrong-password",
        fromAddress: "noreply@cyanarch.com",
        timeoutMs: 5_000,
      });
      await expect(
        badPassMailer.sendEmail({
          to: "bob@example.com",
          subject: "Should fail",
          text: "nope",
        }),
      ).rejects.toThrow(/535/);
    } finally {
      await loginServer.close();
    }
  });

  it("hashes and verifies passwords with scrypt, parses allowed email domains, and enforces sliding-window rate limits", async () => {
    const hash = await hashPasswordScrypt("CorrectHorseBatteryStaple!");
    expect(hash.startsWith("scrypt$16384$8$1$")).toBe(true);
    expect(await verifyPasswordScrypt("CorrectHorseBatteryStaple!", hash)).toBe(true);
    expect(await verifyPasswordScrypt("WrongPassword!", hash)).toBe(false);
    expect(await verifyPasswordScrypt("anything", "corrupted-hash")).toBe(false);

    const domains = parseAllowedEmailDomainSet("Example.COM, @partner.org; team.dev");
    expect([...domains].sort()).toEqual(["example.com", "partner.org", "team.dev"]);

    const limiter = new SlidingWindowRateLimiter({ maxKeys: 3 });
    expect(limiter.checkAndConsume("ip:1", 2, 10_000, 1_000).allowed).toBe(true);
    expect(limiter.checkAndConsume("ip:1", 2, 10_000, 2_000).allowed).toBe(true);
    const blocked = limiter.checkAndConsume("ip:1", 2, 10_000, 3_000);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSec).toBe(8);
    // 窗口过期后恢复放行
    expect(limiter.checkAndConsume("ip:1", 2, 10_000, 11_001).allowed).toBe(true);
    limiter.reset("ip:1");
    expect(limiter.checkOnly("ip:1", 2, 10_000, 11_002).remaining).toBe(2);
  });
});
