/**
 * @module server/infra/crypto
 * @description 密码学哈希、恒定时间摘要校验与全平台实体令牌/配对码安全生成工具。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 密钥绝不落明文：人类会话令牌（`oh_ses_`）、Agent 令牌（`oh_agt_`）及邮箱 OTP 一律经过 `sha256Hex` 摘要后再存入数据库。
 * 2. 防计时侧信道（Timing Attack）：验证码哈希与敏感摘要比对强制通过 `timingSafeEqual` 执行恒定时间比较。
 * 3. 高熵随机源：全部凭据基于 Node.js `node:crypto` CSPRNG 生成，严禁使用 `Math.random()`。
 */
import {
  createHash,
  randomBytes,
  randomInt,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import type {
  AgentId,
  AuditLogId,
  FriendshipId,
  PairingCode,
  ProposalId,
  RoomId,
  UserId,
  WorkItemId,
  WorkSliceId,
  WorkspaceId,
} from "@openhuddle/protocol";

/** 剔除易混淆字符（0/O/1/I）的大写配对码字母表 */
const PAIRING_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

/** scrypt 密码哈希基线参数（N=16384, r=8, p=1 约占 16MB 临时内存，适配 2C4G 容器并发安全） */
const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEY_LEN = 64;
const SCRYPT_SALT_BYTES = 16;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

function deriveScryptKey(
  password: string,
  salt: Buffer,
  keylen: number,
  options: { readonly N: number; readonly r: number; readonly p: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(
      password,
      salt,
      keylen,
      { N: options.N, r: options.r, p: options.p, maxmem: SCRYPT_MAXMEM },
      (err, derivedKey) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(derivedKey);
      },
    );
  });
}

/**
 * 使用 RFC 7914 `scrypt` 内存困难 KDF 与 128-bit 随机盐值对用户明文密码进行不可逆单向哈希。
 *
 * @remarks
 * 异步投递至 Node.js libuv 线程池执行，绝不阻塞 HTTP/SSE 主事件循环；
 * 输出格式固定为 `scrypt$<N>$<r>$<p>$<saltHex>$<derivedKeyHex>`，支持未来无痛升级工作因子。
 *
 * @param password - 已通过协议层长度校验的原始密码字符串
 * @returns 可安全持久化至 `users.password_hash` 的编码哈希字符串
 */
export async function hashPasswordScrypt(password: string): Promise<string> {
  const salt = randomBytes(SCRYPT_SALT_BYTES);
  const derived = await deriveScryptKey(password, salt, SCRYPT_KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("hex")}$${derived.toString("hex")}`;
}

/**
 * 校验用户提交的明文密码是否与存储的 `scrypt` 编码哈希匹配（恒定时间比对）。
 *
 * @remarks
 * 任何格式损坏或非法参数均静默返回 `false`，绝不向上游抛出内部解析异常。
 *
 * @param password - 待校验的明文密码
 * @param storedHash - 数据库中存储的 `scrypt$...` 编码哈希
 * @returns 密码匹配返回 `true`，否则返回 `false`
 */
export async function verifyPasswordScrypt(password: string, storedHash: string): Promise<boolean> {
  const parts = storedHash.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") {
    return false;
  }
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const saltHex = parts[4];
  const keyHex = parts[5];

  if (
    !Number.isInteger(n) ||
    !Number.isInteger(r) ||
    !Number.isInteger(p) ||
    n < 1024 ||
    n > 131_072 ||
    r < 1 ||
    r > 32 ||
    p < 1 ||
    p > 8 ||
    !saltHex ||
    !keyHex
  ) {
    return false;
  }

  const salt = Buffer.from(saltHex, "hex");
  const expectedKey = Buffer.from(keyHex, "hex");
  if (salt.byteLength < 8 || expectedKey.byteLength < 32) {
    return false;
  }

  const actualKey = await deriveScryptKey(password, salt, expectedKey.byteLength, {
    N: n,
    r,
    p,
  });
  if (actualKey.byteLength !== expectedKey.byteLength) {
    return false;
  }
  return timingSafeEqual(actualKey, expectedKey);
}

let cachedDummyPasswordHash: Promise<string> | undefined;

/**
 * 获取进程级缓存的虚拟 `scrypt` 哈希，用于在登录邮箱不存在或未设密码时执行等耗时的防枚举兜底校验。
 *
 * @returns 合法格式的虚拟 `scrypt` 编码哈希
 */
export function getDummyPasswordHash(): Promise<string> {
  if (cachedDummyPasswordHash === undefined) {
    cachedDummyPasswordHash = hashPasswordScrypt("openhuddle-dummy-timing-guard-2026");
  }
  return cachedDummyPasswordHash;
}

/**
 * 计算输入字符串的 SHA-256 十六进制小写摘要。
 *
 * @remarks
 * 用于对 `oh_agt_`、`oh_ses_` Bearer 令牌及 6 位 OTP 验证码做不可逆单向存储哈希。
 *
 * @param input - 待哈希的原始明文字符串
 * @returns 64 位小写十六进制 SHA-256 摘要
 */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * 以恒定时间（Constant-Time）比较两个十六进制哈希摘要是否完全一致。
 *
 * @remarks
 * 防止攻击者通过微秒级响应耗时差异逐字节猜解 OTP 验证码或会话摘要。
 *
 * @param expectedHex - 数据库存储的期望十六进制哈希
 * @param actualHex - 客户端提交值计算出的十六进制哈希
 * @returns 摘要完全相等返回 `true`，否则返回 `false`
 */
export function constantTimeEqualHex(expectedHex: string, actualHex: string): boolean {
  // 安全边界：timingSafeEqual 要求两侧 Buffer 字节长度严格相等，长度不一致时提前拒绝
  const expectedBuf = Buffer.from(expectedHex, "utf8");
  const actualBuf = Buffer.from(actualHex, "utf8");
  if (expectedBuf.byteLength !== actualBuf.byteLength) {
    return false;
  }
  return timingSafeEqual(expectedBuf, actualBuf);
}

/**
 * 生成带业务语义前缀的高熵实体主键字符串。
 *
 * @param prefix - 实体域前缀（如 `usr`, `agt`, `rom`, `prp`, `ses`, `otp`, `aud`, `frd`）
 * @returns 形如 `<prefix>_<24位hex>` 的唯一标识符
 */
export function generatePrefixedId(
  prefix: "usr" | "ses" | "otp" | "agt" | "rom" | "prp" | "aud" | "frd" | "wsp" | "wrk" | "slc",
): string {
  return `${prefix}_${randomBytes(12).toString("hex")}`;
}

/**
 * 生成品牌化的工作区主键 `WorkspaceId`。
 */
export function generateWorkspaceId(): WorkspaceId {
  return generatePrefixedId("wsp") as WorkspaceId;
}

/**
 * 生成品牌化的协作工单主键 `WorkItemId`。
 */
export function generateWorkItemId(): WorkItemId {
  return generatePrefixedId("wrk") as WorkItemId;
}

/**
 * 生成品牌化的协作分片主键 `WorkSliceId`。
 */
export function generateWorkSliceId(): WorkSliceId {
  return generatePrefixedId("slc") as WorkSliceId;
}

/**
 * 生成品牌化的好友关系/好友申请主键 `FriendshipId`。
 *
 * @returns 新生成的 `FriendshipId`
 */
export function generateFriendshipId(): FriendshipId {
  return generatePrefixedId("frd") as FriendshipId;
}

/**
 * 生成品牌化的后台审计日志主键 `AuditLogId`。
 *
 * @returns 新生成的 `AuditLogId`
 */
export function generateAuditLogId(): AuditLogId {
  return generatePrefixedId("aud") as AuditLogId;
}

/**
 * 生成品牌化的人类用户主键 `UserId`。
 *
 * @returns 新生成的 `UserId`
 */
export function generateUserId(): UserId {
  return generatePrefixedId("usr") as UserId;
}

/**
 * 生成品牌化的智能体主键 `AgentId`。
 *
 * @returns 新生成的 `AgentId`
 */
export function generateAgentId(): AgentId {
  return generatePrefixedId("agt") as AgentId;
}

/**
 * 生成品牌化的房间主键 `RoomId`。
 *
 * @returns 新生成的 `RoomId`
 */
export function generateRoomId(): RoomId {
  return generatePrefixedId("rom") as RoomId;
}

/**
 * 生成品牌化的提案主键 `ProposalId`。
 *
 * @returns 新生成的 `ProposalId`
 */
export function generateProposalId(): ProposalId {
  return generatePrefixedId("prp") as ProposalId;
}

/**
 * 生成 192-bit 熵的人类会话令牌（前缀 `oh_ses_`）。
 *
 * @returns 仅在签发时返回客户端的明文会话令牌
 */
export function generateSessionToken(): string {
  return `oh_ses_${randomBytes(24).toString("base64url")}`;
}

/**
 * 生成 192-bit 熵的独立 Agent 访问令牌（前缀 `oh_agt_`）。
 *
 * @returns 仅在配对成功时返回一次的明文 Agent Bearer 令牌
 */
export function generateAgentToken(): string {
  return `oh_agt_${randomBytes(24).toString("base64url")}`;
}

/**
 * 生成形如 `HUDDLE-XXXX-XXXX` 的一次性人类可读短配对码。
 *
 * @returns 品牌化的大写 `PairingCode`
 */
export function generatePairingCode(): PairingCode {
  const pickSegment = (len: number): string => {
    let out = "";
    for (let i = 0; i < len; i++) {
      const idx = randomInt(0, PAIRING_CODE_ALPHABET.length);
      out += PAIRING_CODE_ALPHABET[idx] ?? "A";
    }
    return out;
  };
  return `HUDDLE-${pickSegment(4)}-${pickSegment(4)}` as PairingCode;
}

/**
 * 生成房间邀请与公开分享短令牌（前缀 `inv_`）。
 *
 * @returns URL 安全的邀请令牌字符串
 */
export function generateInviteToken(): string {
  return `inv_${randomBytes(12).toString("base64url")}`;
}

/**
 * 生成密码学安全的 6 位纯数字一次性邮箱验证码（`000000` - `999999`）。
 *
 * @returns 固定 6 位的数字字符串
 */
export function generateOtpCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

/**
 * 将任意 Agent 展示名称确定性地规范化为 URL 与文件名安全的 `slug`。
 *
 * @remarks
 * 同一人类主人名下以 `(ownerUserId, slug)` 作为唯一键，以便掉线后通过 `--reclaim` 按原名称无损找回历史房间与已读游标；
 * 若名称全为中文/非 ASCII 字符，则退回基于名称哈希的确定性后缀，保证相同名称始终产出相同 `slug`。
 *
 * @param displayName - Agent 原始展示名称
 * @returns 长度不超过 64 的小写 `slug`
 */
export function slugifyAgentName(displayName: string): string {
  const ascii = displayName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);

  if (ascii.length > 0) {
    return ascii;
  }

  return `agent-${sha256Hex(displayName.trim().toLowerCase()).slice(0, 12)}`;
}
