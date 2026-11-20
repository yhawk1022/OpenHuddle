/**
 * @module server/infra/mailer
 * @description 零外部依赖原生 Node.js SMTP 邮件投递基础设施（支持隐式 TLS 465 / 阿里云 DirectMail、`STARTTLS` 587、`AUTH PLAIN` / `AUTH LOGIN` 与 `SMTP_CREDENTIALS_FILE` 凭据加载）。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 参考 `/Users/pangyan/ai_workspace/my_server/cyanarch-mail.py` 的阿里云 DirectMail（`smtpdm.aliyun.com:465` SSL + `smtp.json`）模型，以纯 TypeScript `node:tls` / `node:net` 实现，避免 2C4G Node 容器额外依赖 Python 运行时或重型三方库。
 * 2. 凭据解析优先级：显式 `SMTP_*` 环境变量恒高于 `SMTP_CREDENTIALS_FILE` 文件值；使用 `SMTP_CREDENTIALS_FILE` 且未指定主机时默认对齐 `smtpdm.aliyun.com:465`（隐式 TLS）。
 * 3. 安全红线：严禁 SMTP 头部 CR/LF 注入；严禁在日志中输出 `password` 或验证码明文；任意超时或协议异常均强制 `socket.destroy()` 防止文件描述符泄漏。
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import net from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import tls from "node:tls";
import type { Logger } from "pino";
import { z } from "zod";
import type { ServerEnv } from "./env.js";

/** 参考 `cyanarch-mail.py` 的阿里云 DirectMail 默认 SMTP 节点 */
export const DEFAULT_ALIYUN_SMTP_HOST = "smtpdm.aliyun.com";
/** 默认隐式 TLS SMTP 端口 */
export const DEFAULT_SMTP_PORT = 465;
/** 默认 SMTP 套接字超时时间（15 秒，与 `cyanarch-mail.py` 一致） */
export const DEFAULT_SMTP_TIMEOUT_MS = 15_000;

const CredentialsFileSchema = z.object({
  username: z.string().trim().min(1).optional(),
  password: z.string().min(1).optional(),
  host: z.string().trim().min(1).optional(),
  port: z.coerce.number().int().min(1).max(65_535).optional(),
  secure: z.boolean().optional(),
  from: z.string().trim().email().optional(),
  fromName: z.string().trim().min(1).max(80).optional(),
});

/**
 * 解析完成后的只读 SMTP 连接与认证配置。
 */
export interface ResolvedSmtpConfig {
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly username?: string;
  readonly password?: string;
  readonly fromAddress: string;
  readonly fromName?: string;
  readonly timeoutMs: number;
  /** 仅用于本地自签证书单元测试覆盖，生产环境恒为 `true` */
  readonly rejectUnauthorized?: boolean;
}

/**
 * 发送单封电子邮件所需的标准化入参。
 */
export interface EmailMessageInput {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html?: string;
}

/**
 * 统一邮件投递抽象接口（供生产 `SmtpMailer`、未配置 `NoopMailer` 与测试捕获器实现）。
 */
export interface EmailMailer {
  /** 是否已配置真实的外部发信通道 */
  readonly isConfigured: boolean;
  /** 驱动标识（用于日志与健康检查） */
  readonly driver: "smtp" | "noop";
  /** 投递一封邮件 */
  sendEmail(message: Readonly<EmailMessageInput>): Promise<void>;
  /** 可选：校验 TLS 与 SMTP 认证连通性（对齐 `cyanarch-mail.py check`） */
  verifyConnection?(): Promise<{ readonly code: number; readonly tlsProtocol?: string }>;
}

/**
 * 展开配置路径中的开头 `~/` 为当前系统宿主目录。
 */
function expandTildePath(filePath: string): string {
  if (filePath === "~") {
    return homedir();
  }
  if (filePath.startsWith("~/")) {
    return path.join(homedir(), filePath.slice(2));
  }
  return filePath;
}

/**
 * 校验单行邮件头字段，阻断一切 `\r` / `\n` / `\0` SMTP 头部注入攻击。
 */
function assertSafeHeaderValue(fieldName: string, value: string): void {
  if (/[\r\n\0]/.test(value)) {
    throw new Error(`Unsafe control character detected in email header "${fieldName}".`);
  }
}

/**
 * 将包含非 ASCII 字符（如中文）的邮件主题或发件人名称按 RFC 2047 UTF-8 Base64 编码。
 */
function encodeMimeWordUtf8(value: string): string {
  assertSafeHeaderValue("mime-word", value);
  if (/^[\x20-\x7E]+$/.test(value) && !value.includes("=?")) {
    return value;
  }
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

/**
 * 将 Base64 正文按 RFC 2045 每行 76 字符换行（`\r\n`）。
 */
function wrapBase6476(raw: string): string {
  const b64 = Buffer.from(raw, "utf8").toString("base64");
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 76) {
    lines.push(b64.slice(i, i + 76));
  }
  return lines.join("\r\n");
}

/**
 * 按 RFC 5321 §4.5.2 对邮件 `DATA` 正文执行行首点号转义（Dot-Stuffing）。
 */
export function dotStuffSmtpData(rawMessage: string): string {
  const normalized = rawMessage.replace(/\r?\n/g, "\r\n");
  return normalized.replace(/(^|\r\n)\./g, "$1..");
}

/**
 * 构造符合 RFC 5322 + MIME `multipart/alternative` 的完整原始邮件报文。
 *
 * @param params - 发件人、收件人、主题、纯文本与可选 HTML 正文
 * @returns 采用 CRLF 换行的完整 MIME 报文字符串
 */
export function buildRfc5322Message(params: {
  readonly fromAddress: string;
  readonly fromName?: string;
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html?: string;
  readonly now?: Date;
}): string {
  assertSafeHeaderValue("From", params.fromAddress);
  assertSafeHeaderValue("To", params.to);
  assertSafeHeaderValue("Subject", params.subject);
  if (params.fromName !== undefined) {
    assertSafeHeaderValue("FromName", params.fromName);
  }

  const fromDomain = params.fromAddress.split("@")[1] ?? "openhuddle.local";
  const fromHeader =
    params.fromName !== undefined && params.fromName.trim().length > 0
      ? `${encodeMimeWordUtf8(params.fromName.trim())} <${params.fromAddress}>`
      : `<${params.fromAddress}>`;
  const dateHeader = (params.now ?? new Date()).toUTCString();
  const messageId = `<${randomUUID()}@${fromDomain}>`;
  const encodedSubject = encodeMimeWordUtf8(params.subject);

  if (params.html === undefined) {
    return [
      `From: ${fromHeader}`,
      `To: <${params.to}>`,
      `Subject: ${encodedSubject}`,
      `Date: ${dateHeader}`,
      `Message-ID: ${messageId}`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: base64",
      "",
      wrapBase6476(params.text),
      "",
    ].join("\r\n");
  }

  const boundary = `----OpenHuddleBoundary_${randomUUID().replace(/-/g, "")}`;
  return [
    `From: ${fromHeader}`,
    `To: <${params.to}>`,
    `Subject: ${encodedSubject}`,
    `Date: ${dateHeader}`,
    `Message-ID: ${messageId}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    wrapBase6476(params.text),
    "",
    `--${boundary}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    wrapBase6476(params.html),
    "",
    `--${boundary}--`,
    "",
  ].join("\r\n");
}

/**
 * 从环境变量及可选的 `SMTP_CREDENTIALS_FILE`（兼容 `~/.config/cyanarch-mail/smtp.json`）解析最终 SMTP 配置。
 *
 * @remarks
 * - 若同时未配置 `SMTP_HOST` 与 `SMTP_CREDENTIALS_FILE`，返回 `undefined`（进入零配置未启用态）。
 * - 若显式设置了 `SMTP_CREDENTIALS_FILE` 但文件不存在或 JSON 非法，启动期立即抛错（Fail-Fast）。
 *
 * @param env - 已通过校验的只读服务端环境变量
 * @returns 完整 `ResolvedSmtpConfig` 或 `undefined`
 * @throws {Error} 当凭据文件读取失败、JSON 校验失败或缺少必需发件人/认证字段时抛出
 */
export function resolveSmtpConfig(env: Readonly<ServerEnv>): ResolvedSmtpConfig | undefined {
  let fileCreds: z.infer<typeof CredentialsFileSchema> | undefined;

  if (env.SMTP_CREDENTIALS_FILE !== undefined) {
    const resolvedPath = expandTildePath(env.SMTP_CREDENTIALS_FILE);
    let rawText: string;
    try {
      rawText = readFileSync(resolvedPath, "utf8");
    } catch (err) {
      throw new Error(
        `Failed to read SMTP_CREDENTIALS_FILE at "${resolvedPath}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(rawText) as unknown;
    } catch (err) {
      throw new Error(
        `Invalid JSON in SMTP_CREDENTIALS_FILE "${resolvedPath}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    fileCreds = CredentialsFileSchema.parse(parsedJson);
  }

  const hasExplicitHost = env.SMTP_HOST !== undefined;
  const hasCredsFile = fileCreds !== undefined;
  if (!hasExplicitHost && !hasCredsFile) {
    return undefined;
  }

  // 对齐 cyanarch-mail.py：当通过凭据文件配置且未显式覆盖主机时，默认指向阿里云 DirectMail (smtpdm.aliyun.com:465)
  const host = env.SMTP_HOST ?? fileCreds?.host ?? DEFAULT_ALIYUN_SMTP_HOST;
  const port = env.SMTP_PORT ?? fileCreds?.port ?? DEFAULT_SMTP_PORT;
  const secure =
    env.SMTP_SECURE !== undefined
      ? env.SMTP_SECURE === "true"
      : (fileCreds?.secure ?? port === 465);

  const username = env.SMTP_USER ?? fileCreds?.username;
  const password = env.SMTP_PASS ?? fileCreds?.password;
  if (username !== undefined && password === undefined) {
    throw new Error("SMTP password is required when SMTP username is configured.");
  }
  if (password !== undefined && username === undefined) {
    throw new Error("SMTP username is required when SMTP password is configured.");
  }

  const fromAddress = env.SMTP_FROM ?? fileCreds?.from ?? username;
  if (!fromAddress || !fromAddress.includes("@")) {
    throw new Error(
      "SMTP sender address (SMTP_FROM or SMTP_USER email) is required when SMTP is enabled.",
    );
  }

  const fromName = env.SMTP_FROM_NAME ?? fileCreds?.fromName;

  return {
    host,
    port,
    secure,
    ...(username !== undefined ? { username } : {}),
    ...(password !== undefined ? { password } : {}),
    fromAddress,
    ...(fromName !== undefined ? { fromName } : {}),
    timeoutMs: env.SMTP_TIMEOUT_MS,
    rejectUnauthorized: true,
  };
}

interface SmtpResponse {
  readonly code: number;
  readonly lines: readonly string[];
}

/**
 * 封装单次 SMTP TCP/TLS 会话的按行响应解析与命令收发状态机。
 */
class SmtpSession {
  private socket: net.Socket | tls.TLSSocket;
  private readonly timeoutMs: number;
  private buffer = "";
  private readonly lineQueue: string[] = [];
  private readonly waiters: Array<{
    readonly resolve: (line: string) => void;
    readonly reject: (err: Error) => void;
  }> = [];
  private closedError: Error | undefined;

  public constructor(socket: net.Socket | tls.TLSSocket, timeoutMs: number) {
    this.socket = socket;
    this.timeoutMs = timeoutMs;
    this.attachListeners(socket);
  }

  private attachListeners(socket: net.Socket | tls.TLSSocket): void {
    socket.setTimeout(this.timeoutMs);
    socket.on("data", this.onData);
    socket.on("error", this.onError);
    socket.on("timeout", this.onTimeout);
    socket.on("close", this.onClose);
  }

  private detachListeners(socket: net.Socket | tls.TLSSocket): void {
    socket.off("data", this.onData);
    socket.off("error", this.onError);
    socket.off("timeout", this.onTimeout);
    socket.off("close", this.onClose);
  }

  private readonly onData = (chunk: Buffer | string): void => {
    this.buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    while (true) {
      const idx = this.buffer.indexOf("\n");
      if (idx < 0) {
        break;
      }
      const line = this.buffer.slice(0, idx).replace(/\r$/, "");
      this.buffer = this.buffer.slice(idx + 1);

      const waiter = this.waiters.shift();
      if (waiter) {
        waiter.resolve(line);
      } else {
        this.lineQueue.push(line);
      }
    }
  };

  private readonly onError = (err: Error): void => {
    this.failPending(new Error(`SMTP socket error: ${err.message}`));
  };

  private readonly onTimeout = (): void => {
    const err = new Error(`SMTP operation timed out after ${this.timeoutMs}ms.`);
    this.failPending(err);
    this.socket.destroy(err);
  };

  private readonly onClose = (): void => {
    this.failPending(new Error("SMTP connection closed unexpectedly."));
  };

  private failPending(err: Error): void {
    if (this.closedError === undefined) {
      this.closedError = err;
    }
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      waiter?.reject(this.closedError);
    }
  }

  private readLine(): Promise<string> {
    const buffered = this.lineQueue.shift();
    if (buffered !== undefined) {
      return Promise.resolve(buffered);
    }
    if (this.closedError !== undefined) {
      return Promise.reject(this.closedError);
    }
    return new Promise<string>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  /**
   * 读取完整的一组 SMTP 响应（兼容 `250-` 多行延续帧直至 `250 ` 终结行）。
   */
  public async readResponse(): Promise<SmtpResponse> {
    const lines: string[] = [];
    while (true) {
      const line = await this.readLine();
      const match = /^(\d{3})([ -])?(.*)$/.exec(line);
      if (!match) {
        throw new Error(`Malformed SMTP response line: "${line}"`);
      }
      const code = Number(match[1]);
      const sep = match[2] ?? " ";
      const text = match[3] ?? "";
      lines.push(text);
      if (sep !== "-") {
        return { code, lines };
      }
    }
  }

  /**
   * 写入原始字符串载荷至 SMTP 套接字。
   */
  public writeRaw(payload: string): Promise<void> {
    if (this.closedError !== undefined) {
      return Promise.reject(this.closedError);
    }
    return new Promise<void>((resolve, reject) => {
      this.socket.write(payload, "utf8", (err) => {
        if (err) {
          reject(new Error(`Failed writing to SMTP socket: ${err.message}`));
          return;
        }
        resolve();
      });
    });
  }

  /**
   * 发送一条单行 SMTP 命令并读取并校验状态码。
   */
  public async command(cmd: string, expectedCodes: readonly number[]): Promise<SmtpResponse> {
    await this.writeRaw(`${cmd}\r\n`);
    const res = await this.readResponse();
    if (!expectedCodes.includes(res.code)) {
      throw new Error(`SMTP server rejected command with code ${res.code}: ${res.lines.join(" ")}`);
    }
    return res;
  }

  /**
   * 将明文 TCP 套接字就地升级为 TLS（用于端口 587 `STARTTLS` 握手）。
   */
  public async upgradeToTls(servername: string, rejectUnauthorized: boolean): Promise<void> {
    const rawSocket = this.socket;
    this.detachListeners(rawSocket);
    this.buffer = "";
    this.lineQueue.length = 0;

    const tlsSocket = await new Promise<tls.TLSSocket>((resolve, reject) => {
      const upgraded = tls.connect(
        {
          socket: rawSocket,
          servername,
          rejectUnauthorized,
        },
        () => resolve(upgraded),
      );
      upgraded.once("error", (err) => reject(err));
      upgraded.setTimeout(this.timeoutMs, () => {
        const timeoutErr = new Error(
          `SMTP STARTTLS handshake timed out after ${this.timeoutMs}ms.`,
        );
        upgraded.destroy(timeoutErr);
        reject(timeoutErr);
      });
    });

    this.socket = tlsSocket;
    this.attachListeners(tlsSocket);
  }

  /**
   * 读取当前 TLS 协商协议版本（若已加密）。
   */
  public getTlsProtocol(): string | undefined {
    if (this.socket instanceof tls.TLSSocket) {
      return this.socket.getProtocol() ?? undefined;
    }
    return undefined;
  }

  /**
   * 安全关闭底层套接字并释放全部事件监听器。
   */
  public close(): void {
    this.detachListeners(this.socket);
    this.socket.destroy();
  }
}

function connectSocket(config: Readonly<ResolvedSmtpConfig>): Promise<net.Socket | tls.TLSSocket> {
  const rejectUnauthorized = config.rejectUnauthorized ?? true;
  return new Promise((resolve, reject) => {
    const socket = config.secure
      ? tls.connect({
          host: config.host,
          port: config.port,
          servername: config.host,
          rejectUnauthorized,
        })
      : net.connect({
          host: config.host,
          port: config.port,
        });

    const connectEvent = config.secure ? "secureConnect" : "connect";
    const onError = (err: Error): void => {
      socket.destroy();
      reject(new Error(`SMTP connection failed (${config.host}:${config.port}): ${err.message}`));
    };
    const onTimeout = (): void => {
      const err = new Error(
        `SMTP connect timed out after ${config.timeoutMs}ms (${config.host}:${config.port}).`,
      );
      socket.destroy(err);
      reject(err);
    };

    socket.setTimeout(config.timeoutMs);
    socket.once("error", onError);
    socket.once("timeout", onTimeout);
    socket.once(connectEvent, () => {
      socket.off("error", onError);
      socket.off("timeout", onTimeout);
      resolve(socket);
    });
  });
}

function parseAdvertisedAuthMethods(ehloLines: readonly string[]): ReadonlySet<string> {
  const methods = new Set<string>();
  for (const line of ehloLines) {
    const trimmed = line.trim();
    if (/^AUTH(?:[\s=]|$)/i.test(trimmed)) {
      const rest = trimmed.slice(4).replace(/^[=\s]+/, "");
      for (const token of rest.split(/\s+/)) {
        if (token.length > 0) {
          methods.add(token.toUpperCase());
        }
      }
    }
  }
  return methods;
}

function supportsStartTls(ehloLines: readonly string[]): boolean {
  return ehloLines.some((line) => line.trim().toUpperCase() === "STARTTLS");
}

/**
 * 生产级零依赖原生 TLS/STARTTLS SMTP 邮件投递客户端。
 */
export class SmtpMailer implements EmailMailer {
  public readonly isConfigured = true;
  public readonly driver = "smtp" as const;

  private readonly config: ResolvedSmtpConfig;
  private readonly logger: Logger | undefined;

  /**
   * @param config - 已解析的 SMTP 主机、端口、TLS 与认证配置
   * @param logger - 可选 Pino 结构化日志实例（永不记录密码或验证码）
   */
  public constructor(config: Readonly<ResolvedSmtpConfig>, logger?: Logger) {
    this.config = config;
    this.logger = logger;
  }

  private getEhloDomain(): string {
    const domain = this.config.fromAddress.split("@")[1]?.trim();
    if (domain && /^[a-z0-9.-]+$/i.test(domain)) {
      return domain;
    }
    return "openhuddle.local";
  }

  private async openAuthenticatedSession(): Promise<{
    readonly session: SmtpSession;
    readonly authCode: number;
  }> {
    const socket = await connectSocket(this.config);
    const session = new SmtpSession(socket, this.config.timeoutMs);
    try {
      const greeting = await session.readResponse();
      if (greeting.code !== 220) {
        throw new Error(`Unexpected SMTP greeting code ${greeting.code}`);
      }

      const ehloDomain = this.getEhloDomain();
      let ehlo = await session.command(`EHLO ${ehloDomain}`, [250]);

      if (!this.config.secure && supportsStartTls(ehlo.lines)) {
        await session.command("STARTTLS", [220]);
        await session.upgradeToTls(this.config.host, this.config.rejectUnauthorized ?? true);
        ehlo = await session.command(`EHLO ${ehloDomain}`, [250]);
      }

      let authCode = 250;
      if (this.config.username !== undefined && this.config.password !== undefined) {
        const methods = parseAdvertisedAuthMethods(ehlo.lines);
        if (methods.has("PLAIN")) {
          const authToken = Buffer.from(
            `\u0000${this.config.username}\u0000${this.config.password}`,
            "utf8",
          ).toString("base64");
          const authRes = await session.command(`AUTH PLAIN ${authToken}`, [235]);
          authCode = authRes.code;
        } else {
          // 阿里云 DirectMail 与主流企业邮局普遍完整支持 AUTH LOGIN 两步 Base64 认证
          await session.command("AUTH LOGIN", [334]);
          await session.command(
            Buffer.from(this.config.username, "utf8").toString("base64"),
            [334],
          );
          const authRes = await session.command(
            Buffer.from(this.config.password, "utf8").toString("base64"),
            [235],
          );
          authCode = authRes.code;
        }
      }

      return { session, authCode };
    } catch (err) {
      session.close();
      throw err;
    }
  }

  /**
   * 校验与目标 SMTP 服务器的 TLS 握手及认证凭据可用性（对齐 `cyanarch-mail.py check`）。
   *
   * @returns 认证成功状态码及协商的 TLS 协议版本
   */
  public async verifyConnection(): Promise<{
    readonly code: number;
    readonly tlsProtocol?: string;
  }> {
    const { session, authCode } = await this.openAuthenticatedSession();
    try {
      const tlsProtocol = session.getTlsProtocol();
      try {
        await session.command("QUIT", [221]);
      } catch {
        // 忽略 QUIT 阶段对端提前断连
      }
      return {
        code: authCode,
        ...(tlsProtocol !== undefined ? { tlsProtocol } : {}),
      };
    } finally {
      session.close();
    }
  }

  /**
   * 通过 SMTP 通道发送一封含纯文本与可选 HTML 的邮件。
   *
   * @param message - 收件人、主题、纯文本与可选 HTML 正文
   */
  public async sendEmail(message: Readonly<EmailMessageInput>): Promise<void> {
    assertSafeHeaderValue("To", message.to);
    assertSafeHeaderValue("Subject", message.subject);

    const rawMime = buildRfc5322Message({
      fromAddress: this.config.fromAddress,
      ...(this.config.fromName !== undefined ? { fromName: this.config.fromName } : {}),
      to: message.to,
      subject: message.subject,
      text: message.text,
      ...(message.html !== undefined ? { html: message.html } : {}),
    });

    const { session } = await this.openAuthenticatedSession();
    try {
      await session.command(`MAIL FROM:<${this.config.fromAddress}>`, [250]);
      await session.command(`RCPT TO:<${message.to}>`, [250, 251]);
      await session.command("DATA", [354]);
      const stuffed = dotStuffSmtpData(rawMime);
      const dataPayload = stuffed.endsWith("\r\n") ? `${stuffed}.\r\n` : `${stuffed}\r\n.\r\n`;
      await session.writeRaw(dataPayload);
      const accepted = await session.readResponse();
      if (accepted.code !== 250) {
        throw new Error(
          `SMTP relay rejected message body with code ${accepted.code}: ${accepted.lines.join(" ")}`,
        );
      }
      try {
        await session.command("QUIT", [221]);
      } catch {
        // 对端已接受邮件（250），忽略 QUIT 阶段的瞬时断连
      }

      this.logger?.info(
        {
          smtpHost: this.config.host,
          smtpPort: this.config.port,
          recipientDomain: message.to.split("@")[1] ?? "unknown",
        },
        "SMTP verification email accepted by relay",
      );
    } finally {
      session.close();
    }
  }
}

/**
 * 未配置 SMTP 时的空实现（用于零配置本地开发 `dev_echo` 模式或未启用发信的场景）。
 */
export class NoopMailer implements EmailMailer {
  public readonly isConfigured = false;
  public readonly driver = "noop" as const;

  public async sendEmail(_message: Readonly<EmailMessageInput>): Promise<void> {
    throw new Error("SMTP mailer is not configured.");
  }
}

/**
 * 根据服务端环境配置构造对应的 `EmailMailer` 实例。
 *
 * @param env - 已通过校验的只读服务端环境变量
 * @param logger - Pino 结构化日志实例
 * @returns 配置完整时返回 `SmtpMailer`，否则返回 `NoopMailer`
 */
export function createMailerFromEnv(env: Readonly<ServerEnv>, logger: Logger): EmailMailer {
  const smtpConfig = resolveSmtpConfig(env);
  if (!smtpConfig) {
    return new NoopMailer();
  }
  logger.info(
    {
      smtpHost: smtpConfig.host,
      smtpPort: smtpConfig.port,
      smtpSecure: smtpConfig.secure,
      smtpFromDomain: smtpConfig.fromAddress.split("@")[1] ?? "unknown",
    },
    "SMTP email delivery configured",
  );
  return new SmtpMailer(smtpConfig, logger);
}
