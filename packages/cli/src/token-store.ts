/**
 * @module cli/token-store
 * @description 同机多 Agent 独立凭据存储、Token 覆盖防撞卫士与本地房间已读游标（`lastReadSeq`）持久化模块。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 最小权限隔离：所有落盘的 `.token`、元数据 `.json` 与游标文件强制使用 `0o600` 权限，目录使用 `0o700`，防止多用户系统下同机窃取 `oh_agt_` 密钥。
 * 2. 配对前防误覆写（Token Collision Guard）：当目标 Token 文件已存在时，必须在消耗一次性配对码前先调用 `GET /api/v1/me` 自省身份；若该 Token 归属于另一个仍处于活跃状态的 Agent，坚决拒绝覆盖并输出带 `--token-file` 的精确重试命令。
 * 3. 单调递增游标缓存：本地按 `(agentId, roomId)` 持久化已读 `lastReadSeq`，只增不减，供 `send` 命令自动挂载乐观并发防抢话读锁。
 */
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type {
  AgentId,
  AgentPlatform,
  MeResponse,
  ReadCursorSeq,
  RoomId,
} from "@openhuddle/protocol";

/**
 * 与独立 `.token` 文件伴随存储的本地 Agent 元数据快照。
 */
export interface StoredAgentMetadata {
  readonly serverUrl: string;
  readonly agentId: AgentId;
  readonly slug: string;
  /** 同机守护进程标识随凭据保存，避免服务器 slug 在不同实例或主人间重复。 */
  readonly daemonSlug?: string;
  readonly displayName: string;
  readonly platform: AgentPlatform;
  readonly defaultRoomId?: RoomId;
  readonly updatedAtIso: string;
}

/**
 * 当前宿主或云端沙箱最近一次 `connect` / `pair` 激活的默认 CLI 身份上下文（`~/.openhuddle/active-profile.json`）。
 *
 * @remarks
 * 让云端/容器 Agent 在执行 `openhuddle connect` 后可直接运行 `openhuddle read`、`openhuddle reply "..."`、`openhuddle wait`，
 * 无需每次重复拼写 `--server`、`--token-file` 与 `<roomId>`；当显式传入 `--token-file` 时始终以显式参数为准。
 */
export interface ActiveCliProfile {
  readonly tokenFilePath: string;
  readonly serverUrl: string;
  readonly agentId: AgentId;
  readonly slug: string;
  readonly displayName: string;
  readonly platform: AgentPlatform;
  readonly defaultRoomId?: RoomId;
  readonly updatedAtIso: string;
}

/**
 * 读取本地凭据文件后的聚合结构。
 */
export interface LoadedAgentCredentials {
  readonly token: string;
  readonly tokenFilePath: string;
  readonly metadata?: StoredAgentMetadata;
}

/**
 * 本地持久化的单 Agent 各房间 `lastReadSeq` 游标表。
 */
export interface StoredAgentCursors {
  readonly agentId: AgentId;
  readonly rooms: Readonly<Record<string, number>>;
  readonly updatedAtIso: string;
}

/**
 * 配对前 Token 冲突检测入参。
 */
export interface TokenCollisionCheckOptions {
  readonly tokenFilePath: string;
  readonly serverUrl: string;
  readonly pairingCode?: string;
  readonly requestedName: string;
  readonly requestedPlatform: AgentPlatform;
  readonly reclaim: boolean;
  readonly homeDir?: string;
  readonly inspectExistingToken: (
    serverUrl: string,
    existingToken: string,
  ) => Promise<MeResponse | undefined>;
}

/**
 * 配对前 Token 冲突检测结果（可辨识联合类型）。
 */
export type TokenCollisionCheckResult =
  | {
      readonly status: "clear";
      readonly existingAgentId?: AgentId;
    }
  | {
      readonly status: "collision";
      readonly existingAgentId?: AgentId;
      readonly existingDisplayName?: string;
      readonly suggestedTokenFilePath: string;
      readonly suggestedDisplayPath: string;
      readonly suggestedCommand: string;
      readonly message: string;
    };

/**
 * 规范化服务端根地址，去除末尾多余斜杠以确保跨配置比对稳定。
 *
 * @param url - 原始服务端 URL
 * @returns 无尾随斜杠的规范化 URL
 */
export function normalizeServerUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/**
 * 将任意 Agent 名称或文件名片段清洗为跨平台安全的短横线标识符（slug）。
 *
 * @remarks
 * 该 slug 同时用于推荐 `--token-file ~/.openhuddle/tokens/<slug>.token` 路径、
 * macOS `launchd` Label、Linux `systemd` 服务单元名以及 Windows 计划任务名。
 *
 * @param rawValue - 原始展示名称或标识文本
 * @returns 仅包含小写字母、数字与连字符的安全标识符
 */
export function sanitizeTokenSlug(rawValue: string): string {
  const cleaned = rawValue
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return cleaned.length > 0 ? cleaned : "agent";
}

/**
 * 获取默认的本地 Token 文件路径（`~/.openhuddle/tokens/default.token`）。
 *
 * @param customHomeDir - 可选的主目录覆盖路径（用于沙箱单测隔离）
 * @returns 默认 Token 文件绝对路径
 */
export function getDefaultTokenFilePath(customHomeDir?: string): string {
  const baseHome = customHomeDir ?? homedir();
  return join(baseHome, ".openhuddle", "tokens", "default.token");
}

/**
 * 根据 Token 文件路径推导伴随元数据 JSON 文件路径。
 *
 * @param tokenFilePath - Token 文件路径
 * @returns 伴随元数据 JSON 绝对路径
 */
export function getMetadataFilePath(tokenFilePath: string): string {
  return `${resolve(tokenFilePath)}.json`;
}

/**
 * 从 Token 文件路径提取用于守护进程命名的安全 `slug`。
 *
 * @param tokenFilePath - Token 文件路径
 * @returns 规范化后的守护进程标识 slug
 */
export function deriveSlugFromTokenPath(tokenFilePath: string): string {
  const rawBase = basename(tokenFilePath).replace(/\.token$/i, "");
  return sanitizeTokenSlug(rawBase);
}

/**
 * 为新凭据生成同机守护标识。
 * @param tokenFilePath - 已分配的凭据路径
 * @param homeDir - 当前宿主的用户主目录
 * @param forcePathSuffix - 当规范名称已被旧监听器占用时强制追加路径摘要
 * @returns 标准目录中的规范文件名，或包含完整路径摘要的隔离标识
 */
export function deriveDaemonSlug(
  tokenFilePath: string,
  homeDir: string,
  forcePathSuffix = false,
): string {
  const tokenPath = resolve(tokenFilePath);
  const slug = deriveSlugFromTokenPath(tokenPath);
  if (
    !forcePathSuffix &&
    tokenPath === resolve(homeDir, ".openhuddle", "tokens", `${slug}.token`)
  ) {
    return slug;
  }
  const suffix = createHash("sha256").update(tokenPath).digest("hex").slice(0, 12);
  return `${slug.slice(0, 35)}-${suffix}`;
}

/**
 * 找到没有凭据的相邻路径，提前为递增后缀保留守护标识长度。
 * @param tokenFilePath - 第一个候选路径
 * @returns 未占用的 `.token` 路径
 */
export function findUnusedTokenFilePath(tokenFilePath: string): string {
  let candidatePath = resolve(tokenFilePath);
  const parentPath = dirname(candidatePath);
  const baseSlug = deriveSlugFromTokenPath(candidatePath);
  for (
    let index = 2;
    existsSync(candidatePath) || existsSync(getMetadataFilePath(candidatePath));
    index += 1
  ) {
    const suffix = `-${index}`;
    candidatePath = join(parentPath, `${baseSlug.slice(0, 48 - suffix.length)}${suffix}.token`);
  }
  return candidatePath;
}

/**
 * 按服务端确认的身份寻找已有本地凭据，包括之前因同名冲突分配的带后缀路径。
 * @param homeDir - 当前宿主用户主目录
 * @param serverUrl - 配对响应所属服务端
 * @param agentId - 配对响应确认的 Agent ID
 * @returns 对应凭据路径（如有）
 */
export function findTokenFileForAgent(
  homeDir: string,
  serverUrl: string,
  agentId: AgentId,
): string | undefined {
  const tokensDir = join(homeDir, ".openhuddle", "tokens");
  if (!existsSync(tokensDir)) return undefined;
  for (const entry of readdirSync(tokensDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".token.json")) continue;
    const tokenFilePath = join(tokensDir, entry.name.slice(0, -".json".length));
    const metadata = readStoredCredentials(tokenFilePath)?.metadata;
    if (
      metadata?.agentId === agentId &&
      normalizeServerUrl(metadata.serverUrl) === normalizeServerUrl(serverUrl)
    ) {
      return tokenFilePath;
    }
  }
  return undefined;
}

/**
 * 以严格权限（目录 `0o700`、文件 `0o600`）原子写入敏感凭据或游标文件。
 *
 * @param filePath - 目标文件绝对路径
 * @param content - UTF-8 文本内容
 */
function writeProtectedFile(filePath: string, content: string): void {
  const parentDir = dirname(filePath);
  mkdirSync(parentDir, { recursive: true, mode: 0o700 });
  writeFileSync(filePath, content, { encoding: "utf8", mode: 0o600 });
  // 关键安全边界：Node.js writeFileSync 的 mode 仅在文件首次创建时生效且受进程 umask 掩码削弱；
  // 显式追加 chmodSync(0o600) 确保覆盖旧文件或跨 umask 环境下依然严格收紧为仅当前用户可读写（Windows 下为安全空操作）。
  try {
    chmodSync(filePath, 0o600);
  } catch {
    // Windows NTFS 不支持 POSIX 八进制权限位时安全忽略
  }
}

/**
 * 运行时校验未知 JSON 对象是否为合法的 `StoredAgentMetadata`。
 *
 * @param value - JSON 反序列化后的未知值
 * @returns 类型守卫判定布尔值
 */
function isStoredAgentMetadata(value: unknown): value is StoredAgentMetadata {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.serverUrl === "string" &&
    record.serverUrl.length > 0 &&
    typeof record.agentId === "string" &&
    record.agentId.length > 0 &&
    typeof record.slug === "string" &&
    (record.daemonSlug === undefined || typeof record.daemonSlug === "string") &&
    typeof record.displayName === "string" &&
    typeof record.platform === "string" &&
    typeof record.updatedAtIso === "string"
  );
}

/**
 * 读取指定路径的本地 Agent Token 及其伴随元数据。
 *
 * @param tokenFilePath - Token 文件路径
 * @returns 若文件存在且非空则返回凭据与可选元数据，否则返回 `undefined`
 */
export function readStoredCredentials(tokenFilePath: string): LoadedAgentCredentials | undefined {
  const resolvedTokenPath = resolve(tokenFilePath);
  if (!existsSync(resolvedTokenPath)) {
    return undefined;
  }
  const rawToken = readFileSync(resolvedTokenPath, "utf8").trim();
  if (rawToken.length === 0) {
    return undefined;
  }

  const metaPath = getMetadataFilePath(resolvedTokenPath);
  let metadata: StoredAgentMetadata | undefined;
  if (existsSync(metaPath)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(metaPath, "utf8"));
      if (isStoredAgentMetadata(parsed)) {
        metadata = parsed;
      }
    } catch {
      // 元数据损坏不阻断核心 Bearer Token 读取，后续 whoami 可自愈
    }
  }

  return {
    token: rawToken,
    tokenFilePath: resolvedTokenPath,
    ...(metadata !== undefined ? { metadata } : {}),
  };
}

/**
 * 将配对签发的 `oh_agt_` Token 与绑定元数据以 `0o600` 权限落盘保存。
 *
 * @param tokenFilePath - 目标 Token 文件路径
 * @param token - 服务端一次性返回的明文 `oh_agt_...` 令牌
 * @param metadata - 绑定的服务端地址与 Agent 身份摘要
 */
export function writeStoredCredentials(
  tokenFilePath: string,
  token: string,
  metadata: StoredAgentMetadata,
): void {
  const resolvedTokenPath = resolve(tokenFilePath);
  writeProtectedFile(resolvedTokenPath, `${token.trim()}\n`);
  writeStoredMetadata(resolvedTokenPath, metadata);
}

/**
 * 更新已配对身份的伴随元数据，保持现有 Token 内容及作用域。
 * @param tokenFilePath - 已有的凭据路径
 * @param metadata - 待保存的 Agent 元数据
 */
export function writeStoredMetadata(
  tokenFilePath: string,
  metadata: Readonly<StoredAgentMetadata>,
): void {
  writeProtectedFile(getMetadataFilePath(tokenFilePath), `${JSON.stringify(metadata, null, 2)}\n`);
}

/**
 * 在执行 `POST /api/v1/pair` 前校验目标 Token 路径是否已被另一个活跃 Agent 占用。
 *
 * @remarks
 * 关键时序不变量：此检查必须在向服务端提交一次性配对码（`POST /api/v1/pair`）**之前**执行。
 * 否则一旦配对码被服务端核销却因本地文件冲突拒绝写入，用户手头的配对码与新签发的明文 Token 将双双作废。
 *
 * @param options - 待配对参数与现有 Token 自省回调
 * @returns 无冲突返回 `clear`，检测到异构活跃 Agent 占用时返回带精确 `--token-file` 引导命令的 `collision`
 */
export async function checkTokenFileCollision(
  options: Readonly<TokenCollisionCheckOptions>,
): Promise<TokenCollisionCheckResult> {
  const existing = readStoredCredentials(options.tokenFilePath);
  if (existing === undefined) {
    return { status: "clear" };
  }

  // 优先向旧凭据记录的归属服务端发起 GET /api/v1/me 自省，兼容跨实例防撞场景
  const probeServerUrl = existing.metadata?.serverUrl ?? options.serverUrl;
  const requestedSlug = sanitizeTokenSlug(options.requestedName);
  const sameServer = normalizeServerUrl(probeServerUrl) === normalizeServerUrl(options.serverUrl);
  let existingAgentId = existing.metadata?.agentId;
  let existingDisplayName = existing.metadata?.displayName;
  if (sameServer) {
    try {
      const meResponse = await options.inspectExistingToken(probeServerUrl, existing.token);
      if (meResponse === undefined) {
        return { status: "clear" };
      }
      if (meResponse.callerKind === "agent") {
        existingAgentId = meResponse.agent.id;
        existingDisplayName = meResponse.agent.displayName;
        if (
          meResponse.agent.slug === requestedSlug ||
          existingDisplayName.trim().toLowerCase() === options.requestedName.trim().toLowerCase()
        ) {
          return { status: "clear", existingAgentId };
        }
      }
    } catch {
      // 连接失败时旧 Agent 仍可能有效，保留凭据并引导分配独立路径。
    }
  }

  const baseHome = options.homeDir ?? homedir();
  const suggestedTokenFilePath = findUnusedTokenFilePath(
    join(baseHome, ".openhuddle", "tokens", `${requestedSlug}.token`),
  );
  const suggestedDisplayPath = `~/.openhuddle/tokens/${basename(suggestedTokenFilePath)}`;
  const reclaimFlag = options.reclaim ? " --reclaim" : "";
  const escapedName = JSON.stringify(options.requestedName);
  const suggestedCommand =
    options.pairingCode !== undefined
      ? `node openhuddle.mjs pair ${options.pairingCode} --name ${escapedName} --platform ${options.requestedPlatform}${reclaimFlag} --server ${normalizeServerUrl(options.serverUrl)} --token-file ${suggestedDisplayPath}`
      : `openhuddle connect '<connection-link>' --name ${escapedName} --platform ${options.requestedPlatform} --token-file ${suggestedDisplayPath}`;

  const message = [
    `Refusing to overwrite an existing agent token at ${options.tokenFilePath}.`,
    ...(existingDisplayName !== undefined ? [`Existing agent: "${existingDisplayName}".`] : []),
    "To isolate multiple agents on the same machine, re-run with a dedicated --token-file:",
    `  ${suggestedCommand}`,
  ].join("\n");

  return {
    status: "collision",
    ...(existingAgentId !== undefined ? { existingAgentId } : {}),
    ...(existingDisplayName !== undefined ? { existingDisplayName } : {}),
    suggestedTokenFilePath,
    suggestedDisplayPath,
    suggestedCommand,
    message,
  };
}

/**
 * 计算某个 Agent 的本地游标缓存文件路径（`~/.openhuddle/cursors/<agentId>.json`）。
 *
 * @param agentId - 已认证 Agent ID
 * @param customHomeDir - 可选的主目录覆盖路径
 * @returns 游标 JSON 文件绝对路径
 */
export function getAgentCursorFilePath(agentId: AgentId, customHomeDir?: string): string {
  const baseHome = customHomeDir ?? homedir();
  const safeFileKey = agentId.replace(/[^a-zA-Z0-9_-]+/g, "_");
  return join(baseHome, ".openhuddle", "cursors", `${safeFileKey}.json`);
}

/**
 * 读取本地缓存的指定房间已读游标 `lastReadSeq`。
 *
 * @param agentId - 当前 Agent ID
 * @param roomId - 目标房间 ID
 * @param customHomeDir - 可选的主目录覆盖路径
 * @returns 若曾读取过该房间则返回非负游标 `ReadCursorSeq`，否则返回 `undefined`
 */
export function getRoomLastReadSeq(
  agentId: AgentId,
  roomId: RoomId,
  customHomeDir?: string,
): ReadCursorSeq | undefined {
  const cursorPath = getAgentCursorFilePath(agentId, customHomeDir);
  if (!existsSync(cursorPath)) {
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(readFileSync(cursorPath, "utf8"));
    if (typeof parsed !== "object" || parsed === null) {
      return undefined;
    }
    const rooms = (parsed as Record<string, unknown>).rooms;
    if (typeof rooms !== "object" || rooms === null) {
      return undefined;
    }
    const rawSeq = (rooms as Record<string, unknown>)[roomId];
    if (typeof rawSeq === "number" && Number.isSafeInteger(rawSeq) && rawSeq >= 0) {
      return rawSeq as ReadCursorSeq;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * 单调推进并持久化某个 Agent 在指定房间的本地已读游标 `lastReadSeq`。
 *
 * @remarks
 * 采用 `Math.max(previous, next)` 保证单调性，防止并发或乱序读取响应把本地游标回退到旧序号。
 *
 * @param agentId - 当前 Agent ID
 * @param roomId - 目标房间 ID
 * @param nextSeq - 本次确认已读到的最大序号
 * @param customHomeDir - 可选的主目录覆盖路径
 * @returns 落盘后的最新单调游标值
 */
export function updateRoomLastReadSeq(
  agentId: AgentId,
  roomId: RoomId,
  nextSeq: ReadCursorSeq,
  customHomeDir?: string,
): ReadCursorSeq {
  const cursorPath = getAgentCursorFilePath(agentId, customHomeDir);
  let existingRooms: Record<string, number> = {};

  if (existsSync(cursorPath)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(cursorPath, "utf8"));
      if (typeof parsed === "object" && parsed !== null) {
        const candidate = (parsed as Record<string, unknown>).rooms;
        if (typeof candidate === "object" && candidate !== null) {
          for (const [key, val] of Object.entries(candidate as Record<string, unknown>)) {
            if (typeof val === "number" && Number.isSafeInteger(val) && val >= 0) {
              existingRooms[key] = val;
            }
          }
        }
      }
    } catch {
      existingRooms = {};
    }
  }

  const prevSeq = existingRooms[roomId] ?? 0;
  const mergedSeq = Math.max(prevSeq, nextSeq) as ReadCursorSeq;
  const nextPayload: StoredAgentCursors = {
    agentId,
    rooms: {
      ...existingRooms,
      [roomId]: mergedSeq,
    },
    updatedAtIso: new Date().toISOString(),
  };

  writeProtectedFile(cursorPath, `${JSON.stringify(nextPayload, null, 2)}\n`);
  return mergedSeq;
}

/**
 * 获取当前活跃 CLI 身份上下文文件路径（`~/.openhuddle/active-profile.json`）。
 *
 * @param customHomeDir - 可选的主目录覆盖路径
 * @returns 绝对文件路径
 */
export function getActiveCliProfilePath(customHomeDir?: string): string {
  const baseHome = customHomeDir ?? homedir();
  return join(baseHome, ".openhuddle", "active-profile.json");
}

/**
 * 读取当前活跃 CLI 身份上下文（若文件不存在、损坏或引用的 `.token` 文件已被清理则返回 `undefined`）。
 *
 * @param customHomeDir - 可选的主目录覆盖路径
 * @returns 校验通过的 `ActiveCliProfile` 或 `undefined`
 */
export function readActiveCliProfile(customHomeDir?: string): ActiveCliProfile | undefined {
  const profilePath = getActiveCliProfilePath(customHomeDir);
  if (!existsSync(profilePath)) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(profilePath, "utf8"));
    if (typeof parsed !== "object" || parsed === null) {
      return undefined;
    }
    const rec = parsed as Record<string, unknown>;
    if (
      typeof rec.tokenFilePath !== "string" ||
      rec.tokenFilePath.trim().length === 0 ||
      typeof rec.serverUrl !== "string" ||
      rec.serverUrl.trim().length === 0 ||
      typeof rec.agentId !== "string" ||
      typeof rec.slug !== "string" ||
      typeof rec.displayName !== "string" ||
      typeof rec.platform !== "string" ||
      typeof rec.updatedAtIso !== "string"
    ) {
      return undefined;
    }
    if (!existsSync(resolve(rec.tokenFilePath))) {
      return undefined;
    }
    return {
      tokenFilePath: resolve(rec.tokenFilePath),
      serverUrl: normalizeServerUrl(rec.serverUrl),
      agentId: rec.agentId as AgentId,
      slug: rec.slug,
      displayName: rec.displayName,
      platform: rec.platform as AgentPlatform,
      ...(typeof rec.defaultRoomId === "string" && rec.defaultRoomId.trim().length > 0
        ? { defaultRoomId: rec.defaultRoomId.trim() as RoomId }
        : {}),
      updatedAtIso: rec.updatedAtIso,
    };
  } catch {
    return undefined;
  }
}

/**
 * 以 `0o600` 权限写入最新活跃 CLI 身份上下文。
 *
 * @param profile - 待激活的 CLI 身份上下文
 * @param customHomeDir - 可选的主目录覆盖路径
 */
export function writeActiveCliProfile(
  profile: Readonly<ActiveCliProfile>,
  customHomeDir?: string,
): void {
  const profilePath = getActiveCliProfilePath(customHomeDir);
  writeProtectedFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`);
}

/**
 * 同步更新伴随元数据与活跃上下文中的默认房间 `defaultRoomId`（如执行 `join` 或 `create` 后）。
 *
 * @param tokenFilePath - 当前使用的 Token 文件路径
 * @param roomId - 最新进入或选中的房间 ID
 * @param customHomeDir - 可选的主目录覆盖路径
 */
export function rememberDefaultRoomId(
  tokenFilePath: string,
  roomId: RoomId,
  customHomeDir?: string,
): void {
  const existing = readStoredCredentials(tokenFilePath);
  if (existing?.metadata !== undefined) {
    const nextMeta: StoredAgentMetadata = {
      ...existing.metadata,
      defaultRoomId: roomId,
      updatedAtIso: new Date().toISOString(),
    };
    writeProtectedFile(
      getMetadataFilePath(existing.tokenFilePath),
      `${JSON.stringify(nextMeta, null, 2)}\n`,
    );
  }
  const active = readActiveCliProfile(customHomeDir);
  if (active !== undefined && resolve(active.tokenFilePath) === resolve(tokenFilePath)) {
    writeActiveCliProfile(
      {
        ...active,
        defaultRoomId: roomId,
        updatedAtIso: new Date().toISOString(),
      },
      customHomeDir,
    );
  }
}
