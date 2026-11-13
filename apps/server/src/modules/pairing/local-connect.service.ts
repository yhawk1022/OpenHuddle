/**
 * @module server/modules/pairing/local-connect
 * @description 本机开发/单机自托管场景下的「一键秒连本机 CLI Agent」探测与原子部署服务。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 严格回环与人类鉴权边界：仅当 `PUBLIC_BASE_URL` 指向本机回环地址（`localhost` / `127.0.0.1` / `::1`）且调用者为已认证人类主人时启用；公网多租户部署一律返回 `available: false` 并以 `403` 拒绝连接请求，严防宿主权限越界。
 * 2. 零 Shell 字符串拼接：所有可执行文件探测仅做文件系统路径存在与可执行位检查；拉起 `listen install` 严格使用 `spawnSync(nodeExecPath, argsArray)`，绝不经过 Shell 解释器。
 * 3. 原身份凭据对齐：在 `--reclaim` 恢复已有 Agent 时自动扫描复用其原 `.token` 文件路径，避免遗留孤儿守护进程或重复令牌。
 */
import { spawnSync } from "node:child_process";
import {
  constants,
  accessSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AgentId,
  AuthenticatedCaller,
  ConnectLocalAgentBody,
  ConnectLocalAgentResponse,
  LocalAgentCliEntry,
  LocalAgentsStatusResponse,
  LocalCliPresetPlatform,
  MessageSeq,
  OperationKey,
  UserId,
} from "@openhuddle/protocol";
import { assertHumanCaller } from "../../infra/auth-middleware.js";
import { slugifyAgentName } from "../../infra/crypto.js";
import type { ServerEnv } from "../../infra/env.js";
import { AppError } from "../../infra/errors.js";
import type { MessagesService } from "../messages/messages.service.js";
import type { PairingService } from "./pairing.service.js";

const DEFAULT_CLI_BUNDLE_PATH = fileURLToPath(
  new URL("../../../public/openhuddle.mjs", import.meta.url),
);

const PRESET_BINARY_MAP: ReadonlyArray<{
  readonly platform: LocalCliPresetPlatform;
  readonly binaryName: string;
}> = [
  { platform: "claude_code", binaryName: "claude" },
  { platform: "codex", binaryName: "codex" },
  { platform: "antigravity", binaryName: "agy" },
  { platform: "gemini", binaryName: "gemini" },
];

/**
 * 可选注入的本地守护安装执行器（供无副作用集成测试覆盖）。
 */
export type LocalDaemonInstallerFn = (params: {
  readonly cliScriptPath: string;
  readonly serverUrl: string;
  readonly tokenFilePath: string;
  readonly slug: string;
}) => { readonly serviceId: string };

/**
 * 可选注入的本地守护停止执行器（供无副作用集成测试覆盖）。
 */
export type LocalDaemonStopperFn = (params: {
  readonly cliScriptPath: string;
  readonly slug: string;
  readonly homeDir: string;
}) => boolean;

/**
 * 构造 `LocalConnectService` 所需的依赖。
 */
export interface LocalConnectServiceDeps {
  readonly env: ServerEnv;
  readonly pairingService: PairingService;
  readonly messagesService: MessagesService;
  readonly cliBundlePath?: string;
  readonly homeDir?: string;
  readonly pathEnv?: string;
  readonly installDaemonFn?: LocalDaemonInstallerFn;
  readonly stopDaemonFn?: LocalDaemonStopperFn;
}

/**
 * 判定给定 `PUBLIC_BASE_URL` 是否为安全的本机回环地址。
 *
 * @param publicBaseUrl - 服务端公开访问根地址
 * @returns 若域名为 `localhost`、`127.0.0.1` 或 `::1` 则返回 `true`
 */
export function isLoopbackServerUrl(publicBaseUrl: string): boolean {
  try {
    const parsed = new URL(publicBaseUrl);
    const host = parsed.hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
}

/**
 * 构建用于探测本机 CLI 二进制的候选搜索目录列表（兼容 `nvm`、`Homebrew` 与 `~/.local/bin`）。
 */
function buildSearchDirectories(homeDir: string, pathEnv: string | undefined): readonly string[] {
  const sep = process.platform === "win32" ? ";" : ":";
  // 测试显式注入 `pathEnv` 时严格限定在注入目录内探测，避免宿主机全局 `/opt/homebrew/bin` 污染沙箱断言
  const rawDirs =
    pathEnv !== undefined
      ? pathEnv.split(sep)
      : [
          path.dirname(process.execPath),
          ...(process.env.PATH ?? "").split(sep),
          path.join(homeDir, ".local", "bin"),
          ...(process.platform === "darwin"
            ? ["/opt/homebrew/bin", "/usr/local/bin"]
            : ["/usr/local/bin"]),
        ];

  const seen = new Set<string>();
  const result: string[] = [];
  for (const dir of rawDirs) {
    const trimmed = dir.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

/**
 * 在候选目录中无子进程探测可执行文件是否存在。
 */
function isBinaryInstalledOnHost(binaryName: string, searchDirs: readonly string[]): boolean {
  const suffixes = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  const accessFlag = process.platform === "win32" ? constants.F_OK : constants.X_OK;

  for (const dir of searchDirs) {
    for (const suffix of suffixes) {
      const candidate = path.join(dir, `${binaryName}${suffix}`);
      try {
        accessSync(candidate, accessFlag);
        return true;
      } catch {
        // 继续尝试下一个候选目录
      }
    }
  }
  return false;
}

/**
 * 以 `0o700` 目录与 `0o600` 文件权限写入敏感本地凭据文件。
 */
function writeProtectedLocalFile(filePath: string, content: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  writeFileSync(filePath, content, { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(filePath, 0o600);
  } catch {
    // Windows NTFS 安全忽略
  }
}

/**
 * 查找或分配与目标 `agentId` 绑定的唯一 `.token` 文件路径。
 */
function resolveAgentTokenFilePath(tokensDir: string, agentId: string, slug: string): string {
  if (existsSync(tokensDir)) {
    try {
      for (const entry of readdirSync(tokensDir)) {
        if (!entry.endsWith(".token.json")) {
          continue;
        }
        const metaPath = path.join(tokensDir, entry);
        const parsed = JSON.parse(readFileSync(metaPath, "utf8")) as Record<string, unknown>;
        if (parsed.agentId === agentId) {
          return metaPath.slice(0, -".json".length);
        }
      }
    } catch {
      // 忽略损坏的伴随元数据文件
    }
  }

  const preferredPath = path.join(tokensDir, `${slug}.token`);
  const preferredMetaPath = `${preferredPath}.json`;
  if (!existsSync(preferredPath)) {
    return preferredPath;
  }

  try {
    if (existsSync(preferredMetaPath)) {
      const parsed = JSON.parse(readFileSync(preferredMetaPath, "utf8")) as Record<string, unknown>;
      if (parsed.agentId === agentId) {
        return preferredPath;
      }
    }
  } catch {
    // 若旧文件无法归属同一 Agent，追加短后缀防覆盖
  }

  return path.join(tokensDir, `${slug}-${agentId.slice(-6)}.token`);
}

/**
 * 判断传入的 Agent 名称是否属于前端默认生成的 `<主人名>-<平台标签>` 模板名（兼容历史 `OpenAICodex` 与新版 `Codex` 等别名）。
 *
 * @param candidateName - 本次请求提交的展示名称
 * @param ownerDisplayName - 人类主人展示名称
 * @param platform - 本机 CLI 平台
 * @returns 若属于默认模板名而非用户手填的专属角色名则返回 `true`
 */
function isDefaultPlatformAgentName(
  candidateName: string,
  ownerDisplayName: string,
  platform: LocalCliPresetPlatform,
): boolean {
  const trimmed = candidateName.trim().toLowerCase();
  const ownerPrefix = `${ownerDisplayName.trim().toLowerCase()}-`;
  if (!trimmed.startsWith(ownerPrefix)) {
    return false;
  }
  const suffix = trimmed.slice(ownerPrefix.length).replace(/[\s_-]+/g, "");
  switch (platform) {
    case "codex":
      return suffix === "codex" || suffix === "openaicodex";
    case "claude_code":
      return suffix === "claude" || suffix === "claudecode";
    case "antigravity":
      return suffix === "antigravity" || suffix === "agy";
    case "gemini":
      return suffix === "gemini" || suffix === "geminicli";
  }
}

/**
 * 本机 CLI 探测与一键秒连编排服务。
 */
export class LocalConnectService {
  private readonly env: ServerEnv;
  private readonly pairingService: PairingService;
  private readonly messagesService: MessagesService;
  private readonly cliBundlePath: string;
  private readonly homeDir: string;
  private readonly pathEnv: string | undefined;
  private readonly installDaemonFn: LocalDaemonInstallerFn;
  private readonly stopDaemonFn: LocalDaemonStopperFn;
  private readonly connectChainByKey = new Map<string, Promise<unknown>>();

  /**
   * @param deps - 配置、配对服务、消息服务与可选测试桩
   */
  public constructor(deps: Readonly<LocalConnectServiceDeps>) {
    this.env = deps.env;
    this.pairingService = deps.pairingService;
    this.messagesService = deps.messagesService;
    this.cliBundlePath = deps.cliBundlePath ?? DEFAULT_CLI_BUNDLE_PATH;
    this.homeDir = deps.homeDir ?? homedir();
    this.pathEnv = deps.pathEnv ?? process.env.PATH;
    this.installDaemonFn =
      deps.installDaemonFn ??
      ((params) => {
        const res = spawnSync(
          process.execPath,
          [
            params.cliScriptPath,
            "listen",
            "install",
            "--json",
            "--slug",
            params.slug,
            "--server",
            params.serverUrl,
            "--token-file",
            params.tokenFilePath,
          ],
          {
            encoding: "utf8",
            windowsHide: true,
            env: { ...process.env, HOME: this.homeDir, USERPROFILE: this.homeDir },
            timeout: 15_000,
          },
        );
        if (res.status !== 0) {
          const detail = (res.stderr || res.stdout || "listen install failed").trim();
          throw new AppError({
            code: "INTERNAL_SERVER_ERROR",
            statusCode: 500,
            message: `Failed to start local SSE listener daemon: ${detail}`,
          });
        }
        try {
          const parsed = JSON.parse(res.stdout) as { readonly serviceId?: unknown };
          if (typeof parsed.serviceId === "string" && parsed.serviceId.length > 0) {
            return { serviceId: parsed.serviceId };
          }
        } catch {
          // 回退使用标准服务标识
        }
        return { serviceId: `openhuddle-listen-${params.slug}` };
      });
    // 测试注入了虚拟 `installDaemonFn` 但未注入 `stopDaemonFn` 时，同步采用无副作用桩，防止沙箱测试误停宿主机真实 LaunchAgent
    this.stopDaemonFn =
      deps.stopDaemonFn ??
      (deps.installDaemonFn !== undefined
        ? () => true
        : (params) => {
            const res = spawnSync(
              process.execPath,
              [params.cliScriptPath, "listen", "stop", "--json", "--slug", params.slug],
              {
                encoding: "utf8",
                windowsHide: true,
                env: { ...process.env, HOME: params.homeDir, USERPROFILE: params.homeDir },
                timeout: 10_000,
              },
            );
            return res.status === 0;
          });
  }

  /**
   * 探测当前服务端是否处于本机回环模式，并返回已安装的本地编程 Agent CLI 清单。
   *
   * @param caller - 当前调用者（必须为已登录人类）
   * @returns 本机可用状态与各平台 CLI 安装情况
   */
  public getStatus(caller: Readonly<AuthenticatedCaller>): LocalAgentsStatusResponse {
    assertHumanCaller(caller);

    const available =
      isLoopbackServerUrl(this.env.PUBLIC_BASE_URL) && existsSync(this.cliBundlePath);
    if (!available) {
      return {
        ok: true,
        available: false,
        hostPlatform: process.platform,
        clis: PRESET_BINARY_MAP.map((item) => ({
          platform: item.platform,
          binaryName: item.binaryName,
          installed: false,
        })),
      };
    }

    const searchDirs = buildSearchDirectories(this.homeDir, this.pathEnv);
    const clis: LocalAgentCliEntry[] = PRESET_BINARY_MAP.map((item) => ({
      platform: item.platform,
      binaryName: item.binaryName,
      installed: isBinaryInstalledOnHost(item.binaryName, searchDirs),
    }));

    return {
      ok: true,
      available: true,
      hostPlatform: process.platform,
      clis,
    };
  }

  /**
   * 一键在本机完成：签发并核销配对码 -> 写入 `0600` 独立凭据 -> 发送入群问候 -> 安装并启动常驻 SSE 守护进程。
   *
   * @param caller - 当前已认证人类主人
   * @param body - 目标本地 CLI 平台、Agent 展示名称、可选自动入群房间与重连目标
   * @returns 秒级接入完成后的 Agent 摘要与守护服务标识
   */
  public async connectLocalAgent(
    caller: Readonly<AuthenticatedCaller>,
    body: Readonly<ConnectLocalAgentBody>,
  ): Promise<ConnectLocalAgentResponse> {
    const human = assertHumanCaller(caller);
    const lockKey = `${human.userId}:${body.platform}`;
    const prevChain = this.connectChainByKey.get(lockKey) ?? Promise.resolve();

    // 同主人同平台串行化：防止前端连续快速点击产生并发配对竞争与双份守护进程
    const task = prevChain
      .catch(() => undefined)
      .then(() => this.executeConnectLocalAgent(caller, human.userId, body));

    this.connectChainByKey.set(lockKey, task);
    try {
      return await task;
    } finally {
      if (this.connectChainByKey.get(lockKey) === task) {
        this.connectChainByKey.delete(lockKey);
      }
    }
  }

  private async executeConnectLocalAgent(
    caller: Readonly<AuthenticatedCaller>,
    ownerUserId: UserId,
    body: Readonly<ConnectLocalAgentBody>,
  ): Promise<ConnectLocalAgentResponse> {
    if (!isLoopbackServerUrl(this.env.PUBLIC_BASE_URL)) {
      throw new AppError({
        code: "FORBIDDEN_NOT_OWNER",
        statusCode: 403,
        message:
          "One-click local CLI connection is only available when OpenHuddle runs on localhost / 127.0.0.1.",
      });
    }

    if (!existsSync(this.cliBundlePath)) {
      throw new AppError({
        code: "NOT_FOUND",
        statusCode: 404,
        message: "CLI bundle openhuddle.mjs has not been built yet.",
      });
    }

    const binarySpec = PRESET_BINARY_MAP.find((item) => item.platform === body.platform);
    const searchDirs = buildSearchDirectories(this.homeDir, this.pathEnv);
    if (!binarySpec || !isBinaryInstalledOnHost(binarySpec.binaryName, searchDirs)) {
      throw new AppError({
        code: "VALIDATION_ERROR",
        statusCode: 400,
        message: `Local CLI "${binarySpec?.binaryName ?? body.platform}" was not found on this machine's PATH.`,
      });
    }

    // 幂等防重保护：若调用方未显式传入 `reclaimAgentId`，但该主人名下已存在同名/同 slug 或同平台默认命名的 Agent
    // （如早期接入的 `庞彦-OpenAICodex` 与新版默认名 `庞彦-Codex`），自动转为原身份无损重连，彻底消除多次点击产生重复分身。
    let effectiveReclaimAgentId: AgentId | undefined = body.reclaimAgentId;
    let effectiveAgentName = body.name.trim();

    if (effectiveReclaimAgentId === undefined) {
      const [existingSamePlatform, ownerDto] = await Promise.all([
        this.pairingService.listOwnedAgentsByPlatform(ownerUserId, body.platform),
        this.pairingService.findOwnerById(ownerUserId),
      ]);
      const requestedSlug = slugifyAgentName(effectiveAgentName);
      const exactMatch = existingSamePlatform.find(
        (item) =>
          item.slug === requestedSlug ||
          item.displayName.trim().toLowerCase() === effectiveAgentName.toLowerCase(),
      );
      if (exactMatch !== undefined) {
        effectiveReclaimAgentId = exactMatch.id;
        effectiveAgentName = exactMatch.displayName;
      } else if (
        existingSamePlatform.length > 0 &&
        ownerDto !== undefined &&
        isDefaultPlatformAgentName(effectiveAgentName, ownerDto.displayName, body.platform)
      ) {
        const primaryExisting = existingSamePlatform[0];
        if (primaryExisting !== undefined) {
          effectiveReclaimAgentId = primaryExisting.id;
          effectiveAgentName = primaryExisting.displayName;
        }
      }
    }

    // 1. 进程内直接签发并消费一次性配对码（零 HTTP 回环开销）
    const issuedCode = await this.pairingService.createPairingCode(caller, {
      ...(body.autoJoinRoomId !== undefined ? { autoJoinRoomId: body.autoJoinRoomId } : {}),
      ...(effectiveReclaimAgentId !== undefined ? { reclaimAgentId: effectiveReclaimAgentId } : {}),
      expiresInHours: 1,
    });

    const isReclaim = effectiveReclaimAgentId !== undefined;
    const paired = await this.pairingService.pairAgent({
      code: issuedCode.code,
      name: effectiveAgentName,
      platform: body.platform,
      reclaim: isReclaim,
    });

    // 2. 同步最新单文件 CLI 与 0600 独立 Token 凭据至 ~/.openhuddle/
    const openhuddleDir = path.join(this.homeDir, ".openhuddle");
    const tokensDir = path.join(openhuddleDir, "tokens");
    const installedCliPath = path.join(openhuddleDir, "openhuddle.mjs");
    mkdirSync(tokensDir, { recursive: true, mode: 0o700 });
    copyFileSync(this.cliBundlePath, installedCliPath);

    const baseUrl = this.env.PUBLIC_BASE_URL.replace(/\/+$/, "");
    const tokenFilePath = resolveAgentTokenFilePath(tokensDir, paired.agent.id, paired.agent.slug);
    writeProtectedLocalFile(tokenFilePath, `${paired.token}\n`);
    writeProtectedLocalFile(
      `${tokenFilePath}.json`,
      `${JSON.stringify(
        {
          serverUrl: baseUrl,
          agentId: paired.agent.id,
          slug: paired.agent.slug,
          displayName: paired.agent.displayName,
          platform: paired.agent.platform,
          updatedAtIso: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
    );

    // 3. 若自动加入了群聊，立即在进程内投递报到问候并同步游标（按分钟桶生成幂等 opKey，连点重连不刷屏）
    let greetedMessageSeq: MessageSeq | undefined;
    if (paired.autoJoinedRoomId !== undefined) {
      try {
        const agentCaller: AuthenticatedCaller = {
          kind: "agent",
          agentId: paired.agent.id,
          ownerUserId,
          displayName: paired.agent.displayName,
          platform: paired.agent.platform,
        };
        const greetingContent = isReclaim
          ? `${paired.agent.displayName} 已重新连回群聊并同步最新本地环境，直接 @ 我即可继续讨论。`
          : `大家好，我是 ${paired.agent.displayName}，已通过本机一键直连接入并开启实时监听，直接 @ 我即可开始讨论。`;
        const minuteBucket = Math.floor(Date.now() / 60_000);

        const sent = await this.messagesService.sendMessage(agentCaller, paired.autoJoinedRoomId, {
          content: greetingContent,
          mentions: [],
          ignoreUnread: true,
          opKey:
            `op_local_greet_${paired.agent.id}_${isReclaim ? "reclaim" : "join"}_${minuteBucket}` as OperationKey,
        });
        greetedMessageSeq = sent.message.seq;

        const cursorPath = path.join(
          openhuddleDir,
          "cursors",
          `${paired.agent.id.replace(/[^a-zA-Z0-9_-]/g, "_")}.cursors.json`,
        );
        writeProtectedLocalFile(
          cursorPath,
          `${JSON.stringify(
            {
              agentId: paired.agent.id,
              rooms: { [paired.autoJoinedRoomId]: greetedMessageSeq },
              updatedAtIso: new Date().toISOString(),
            },
            null,
            2,
          )}\n`,
        );
      } catch {
        // 预算暂停态下跳过问候，不阻塞守护进程安装
      }
    }

    // 4. 安装并立即拉起操作系统后台常驻 SSE 守护服务（自动注入 PATH 与代理环境变量）
    const daemonRes = this.installDaemonFn({
      cliScriptPath: installedCliPath,
      serverUrl: baseUrl,
      tokenFilePath,
      slug: paired.agent.slug,
    });

    return {
      ok: true,
      agent: paired.agent,
      ...(paired.autoJoinedRoomId !== undefined
        ? { autoJoinedRoomId: paired.autoJoinedRoomId }
        : {}),
      ...(greetedMessageSeq !== undefined ? { greetedMessageSeq } : {}),
      serviceId: daemonRes.serviceId,
    };
  }

  /**
   * 当人类主人删除某个 Agent 时，在本机回环模式下尽力卸载其对应的后台 SSE 监听守护服务，并擦除本地 `.token` 与游标缓存文件。
   *
   * @remarks
   * 严守公网隔离边界：非回环（非 `localhost`/`127.0.0.1`/`::1`）部署下立即返回 `false`，绝不触碰服务端文件系统。
   *
   * @param agent - 已从数据库删除的 Agent 标识快照
   * @returns 若成功停止了本机守护进程或清理了本地凭据文件则返回 `true`
   */
  public cleanupDeletedLocalAgent(agent: {
    readonly id: AgentId;
    readonly slug: string;
  }): boolean {
    if (!isLoopbackServerUrl(this.env.PUBLIC_BASE_URL)) {
      return false;
    }

    const openhuddleDir = path.join(this.homeDir, ".openhuddle");
    const tokensDir = path.join(openhuddleDir, "tokens");
    const matchedTokenFiles = new Set<string>();
    const candidateSlugs = new Set<string>();

    const normalizedAgentSlug = agent.slug
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    if (normalizedAgentSlug.length > 0) {
      candidateSlugs.add(normalizedAgentSlug);
    }

    // 扫描 `~/.openhuddle/tokens/*.token.json` 精准匹配归属于该 `agentId` 的凭据文件（兼容带后缀或改名后的文件）
    if (existsSync(tokensDir)) {
      try {
        for (const entry of readdirSync(tokensDir)) {
          if (!entry.endsWith(".token.json")) {
            continue;
          }
          const metaPath = path.join(tokensDir, entry);
          try {
            const parsed = JSON.parse(readFileSync(metaPath, "utf8")) as Record<string, unknown>;
            if (parsed.agentId === agent.id) {
              const tokenPath = metaPath.slice(0, -".json".length);
              matchedTokenFiles.add(tokenPath);
              const baseSlug = path
                .basename(tokenPath, ".token")
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, "-")
                .replace(/^-+|-+$/g, "");
              if (baseSlug.length > 0) {
                candidateSlugs.add(baseSlug);
              }
              if (typeof parsed.slug === "string" && parsed.slug.trim().length > 0) {
                candidateSlugs.add(
                  parsed.slug
                    .trim()
                    .toLowerCase()
                    .replace(/[^a-z0-9]+/g, "-")
                    .replace(/^-+|-+$/g, ""),
                );
              }
            }
          } catch {
            // 忽略单个损坏元数据文件，继续清理其余条目
          }
        }
      } catch {
        // 忽略目录不可读异常
      }
    }

    let cleanedAny = false;
    const cliCandidatePaths = [path.join(openhuddleDir, "openhuddle.mjs"), this.cliBundlePath];
    const activeCliPath = cliCandidatePaths.find((candidate) => existsSync(candidate));

    if (activeCliPath !== undefined) {
      for (const slug of candidateSlugs) {
        try {
          if (
            this.stopDaemonFn({
              cliScriptPath: activeCliPath,
              slug,
              homeDir: this.homeDir,
            })
          ) {
            cleanedAny = true;
          }
        } catch {
          // 尽力卸载：即使后台服务此前未安装也不阻塞主删除响应
        }
      }
    }

    for (const tokenPath of matchedTokenFiles) {
      try {
        if (existsSync(tokenPath) || existsSync(`${tokenPath}.json`)) {
          cleanedAny = true;
        }
        rmSync(tokenPath, { force: true });
        rmSync(`${tokenPath}.json`, { force: true });
      } catch {
        // 忽略本地文件清理异常
      }
    }

    const safeAgentFileKey = agent.id.replace(/[^a-zA-Z0-9_-]/g, "_");
    const cursorPaths = [
      path.join(openhuddleDir, "cursors", `${safeAgentFileKey}.cursors.json`),
      path.join(openhuddleDir, "cursors", `${safeAgentFileKey}.json`),
    ];
    for (const cursorPath of cursorPaths) {
      try {
        if (existsSync(cursorPath)) {
          cleanedAny = true;
          rmSync(cursorPath, { force: true });
        }
      } catch {
        // 忽略游标缓存清理异常
      }
    }

    return cleanedAny;
  }
}
