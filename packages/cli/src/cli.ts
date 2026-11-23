/**
 * @module cli/entry
 * @description OpenHuddle 单文件零依赖跨平台 CLI (`openhuddle.mjs`) 命令解析与主控分发入口。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 零外部运行时依赖：打包后的 `openhuddle.mjs` 仅使用 Node.js 20+ 原生内置模块（`fetch`、`fs`、`path`、`os`、`crypto`、`child_process`、`url`），确保任意开发者机器一行 `curl` 即可运行。
 * 2. 同机多 Agent 凭据隔离：默认支持 `--token-file` 与 `OPENHUDDLE_TOKEN_FILE` 独立存储，并在 `pair` 前调用 `GET /api/v1/me` 拦截跨 Agent 误覆盖。
 * 3. 乐观并发读锁自动衔接：`read` 自动在本地推进房间 `lastReadSeq`，`send` 自动携带该游标并在命中 `409` 时打印漏读上下文。
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
  AgentId,
  AgentPlatform,
  CastProposalVoteBody,
  MessageDto,
  MessageMention,
  MessageSeq,
  OperationKey,
  ProposalDraft,
  ProposalId,
  ProposalOption,
  ProposalVoteStance,
  ReadCursorSeq,
  RoomId,
  RoomVisibility,
  UpdateMeBody,
  UserId,
} from "@openhuddle/protocol";
import {
  type DaemonControlReport,
  type DaemonSystemDeps,
  getDaemonServiceStatus,
  installDaemonService,
  spawnDetachedDaemonWorker,
  stopDaemonService,
} from "./daemon-manager.js";
import { isPresetCliBinaryAvailable } from "./host-env.js";
import { OpenHuddleApiError, OpenHuddleHttpClient, formatOpenHuddleError } from "./http-client.js";
import { runCliMcpStdioServer } from "./mcp-stdio.js";
import {
  type WakeAgentPreset,
  type WakeExecutionTarget,
  parseWakeAgentPreset,
  parseWakeEventFrame,
  readSseFrames,
  startSseListener,
} from "./sse-listener.js";
import {
  checkTokenFileCollision,
  deriveSlugFromTokenPath,
  getDefaultTokenFilePath,
  getRoomLastReadSeq,
  normalizeServerUrl,
  readActiveCliProfile,
  readStoredCredentials,
  rememberDefaultRoomId,
  sanitizeTokenSlug,
  updateRoomLastReadSeq,
  writeActiveCliProfile,
  writeStoredCredentials,
} from "./token-store.js";

/**
 * 解析后的 CLI 命令执行参数。
 */
export interface ParsedCliArgs {
  readonly command: string;
  readonly positionals: readonly string[];
  readonly tokenFilePath: string;
  readonly serverUrl: string;
  readonly hasExplicitTokenFile: boolean;
  readonly hasExplicitServerUrl: boolean;
  readonly json: boolean;
  readonly flags: Readonly<Record<string, readonly string[]>>;
  readonly booleanFlags: ReadonlySet<string>;
}

/**
 * 可注入的 CLI 运行时上下文（默认对接真实进程 `stdout`/`stderr`、全局 `fetch` 与宿主 OS）。
 */
export interface CliExecutionContext {
  readonly homeDir?: string;
  readonly fetchImpl?: typeof fetch;
  readonly stdout?: (line: string) => void;
  readonly stderr?: (line: string) => void;
  readonly daemonDeps?: DaemonSystemDeps;
  readonly hasPresetBinary?: (preset: WakeAgentPreset) => boolean;
  readonly mcpInputStream?: AsyncIterable<string | Buffer>;
  readonly listenerSignal?: AbortSignal;
  readonly cliScriptPath?: string;
  readonly nodeBinaryPath?: string;
}

const BOOLEAN_FLAGS: ReadonlySet<string> = new Set([
  "--json",
  "--reclaim",
  "--listen",
  "--no-listen",
  "--greet",
  "--no-greet",
  "--ignore-unread",
  "--help",
  "-h",
  "--list",
]);

const VALID_PLATFORMS: ReadonlySet<AgentPlatform> = new Set<AgentPlatform>([
  "antigravity",
  "codex",
  "claude_code",
  "cursor",
  "deepseek",
  "openclaw",
  "gemini",
  "chatgpt",
  "hosted",
  "custom",
]);

const VALID_STANCES: ReadonlySet<ProposalVoteStance> = new Set<ProposalVoteStance>([
  "endorse",
  "challenge",
  "abstain",
]);

/**
 * 解析命令行参数并确定独立 Token 文件路径、服务端地址与具名选项。
 *
 * @param argv - 去除 `node` 与脚本名后的原始参数列表
 * @param customHomeDir - 可选的主目录覆盖路径（供单测隔离使用）
 * @returns 结构化命令参数
 */
export function parseCliArgs(argv: readonly string[], customHomeDir?: string): ParsedCliArgs {
  const envTokenFile = process.env.OPENHUDDLE_TOKEN_FILE;
  let tokenFilePath =
    envTokenFile !== undefined && envTokenFile.trim().length > 0
      ? envTokenFile.trim()
      : getDefaultTokenFilePath(customHomeDir);
  let hasExplicitTokenFile = envTokenFile !== undefined && envTokenFile.trim().length > 0;

  const envServerUrl = process.env.OPENHUDDLE_URL;
  let serverUrl =
    envServerUrl !== undefined && envServerUrl.trim().length > 0
      ? normalizeServerUrl(envServerUrl)
      : "http://localhost:3000";
  let hasExplicitServerUrl = envServerUrl !== undefined && envServerUrl.trim().length > 0;

  let json = false;
  const positionals: string[] = [];
  const flagsMutable: Record<string, string[]> = {};
  const booleanFlags = new Set<string>();

  const pushFlag = (key: string, val: string): void => {
    const existing = flagsMutable[key];
    if (existing !== undefined) {
      existing.push(val);
    } else {
      flagsMutable[key] = [val];
    }
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) {
      continue;
    }

    if (arg === "-h" || arg === "--help") {
      booleanFlags.add("--help");
      if (positionals.length === 0) {
        positionals.push("help");
      }
      continue;
    }

    if (arg.startsWith("--")) {
      const eqIdx = arg.indexOf("=");
      const rawFlag = eqIdx === -1 ? arg : arg.slice(0, eqIdx);
      const inlineVal = eqIdx === -1 ? undefined : arg.slice(eqIdx + 1);

      if (BOOLEAN_FLAGS.has(rawFlag) && inlineVal === undefined) {
        booleanFlags.add(rawFlag);
        if (rawFlag === "--json") {
          json = true;
        }
        continue;
      }

      const value = inlineVal ?? argv[i + 1];
      if (inlineVal === undefined && value !== undefined) {
        i += 1;
      }
      if (value !== undefined) {
        const flagName = rawFlag.slice(2);
        pushFlag(flagName, value);
        if (rawFlag === "--token-file") {
          tokenFilePath = value;
          hasExplicitTokenFile = true;
        } else if (rawFlag === "--profile" && !hasExplicitTokenFile) {
          const baseHome = customHomeDir ?? homedir();
          tokenFilePath = join(
            baseHome,
            ".openhuddle",
            "tokens",
            `${sanitizeTokenSlug(value)}.token`,
          );
          hasExplicitTokenFile = true;
        } else if (rawFlag === "--server") {
          serverUrl = normalizeServerUrl(value);
          hasExplicitServerUrl = true;
        }
      }
      continue;
    }

    positionals.push(arg);
  }

  return {
    command: positionals[0] ?? "help",
    positionals: positionals.slice(1),
    tokenFilePath,
    serverUrl,
    hasExplicitTokenFile,
    hasExplicitServerUrl,
    json,
    flags: flagsMutable,
    booleanFlags,
  };
}

/**
 * 读取指定单值命令行标志（取最后一次出现的值）。
 *
 * @param parsed - 解析后的 CLI 参数
 * @param name - 不带 `--` 前缀的标志名
 * @returns 标志字符串值或 `undefined`
 */
function getLastFlag(parsed: Readonly<ParsedCliArgs>, name: string): string | undefined {
  const list = parsed.flags[name];
  if (list === undefined || list.length === 0) {
    return undefined;
  }
  return list[list.length - 1];
}

/**
 * 解析并校验平台枚举（支持 `agy` 与 `claude` 常用简写）。
 *
 * @param raw - 原始平台文本
 * @returns 规范化后的 `AgentPlatform`，不合法返回 `undefined`
 */
function resolveAgentPlatform(raw: string | undefined): AgentPlatform | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === "agy") {
    return "antigravity";
  }
  if (normalized === "claude" || normalized === "claude-code") {
    return "claude_code";
  }
  if (VALID_PLATFORMS.has(normalized as AgentPlatform)) {
    return normalized as AgentPlatform;
  }
  return undefined;
}

/**
 * 从邀请码参数或完整邀请链接中提取纯净的 `inviteToken`。
 *
 * @param rawInput - 原始邀请码或 URL
 * @returns 提取出的邀请令牌
 */
function extractInviteToken(rawInput: string): string {
  const trimmed = rawInput.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const parsedUrl = new URL(trimmed);
      const fromQuery = parsedUrl.searchParams.get("invite") ?? parsedUrl.searchParams.get("token");
      if (fromQuery !== null && fromQuery.trim().length > 0) {
        return fromQuery.trim();
      }
      const segments = parsedUrl.pathname.split("/").filter((seg) => seg.length > 0);
      const tail = segments[segments.length - 1];
      if (tail !== undefined) {
        return tail;
      }
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

/**
 * 解析 `--mention-agent <id:name>` 与 `--mention-human <id:name>` 列表。
 *
 * @param parsed - 解析后的 CLI 参数
 * @returns 符合协议契约的 `MessageMention` 数组
 */
function parseMentionsFromFlags(parsed: Readonly<ParsedCliArgs>): readonly MessageMention[] {
  const mentions: MessageMention[] = [];

  for (const entry of parsed.flags["mention-agent"] ?? []) {
    const sep = entry.indexOf(":");
    const rawId = (sep === -1 ? entry : entry.slice(0, sep)).trim();
    const displayName = (sep === -1 ? entry : entry.slice(sep + 1)).trim() || rawId;
    if (rawId.length > 0) {
      mentions.push({
        kind: "agent",
        agentId: rawId as AgentId,
        displayName,
      });
    }
  }

  for (const entry of parsed.flags["mention-human"] ?? []) {
    const sep = entry.indexOf(":");
    const rawId = (sep === -1 ? entry : entry.slice(0, sep)).trim();
    const displayName = (sep === -1 ? entry : entry.slice(sep + 1)).trim() || rawId;
    if (rawId.length > 0) {
      mentions.push({
        kind: "human",
        userId: rawId as UserId,
        displayName,
      });
    }
  }

  return mentions;
}

/**
 * 解析 `propose` 命令的提案草稿（支持 `--draft-json`、`--draft-file` 或快捷命令行标志）。
 *
 * @param parsed - 解析后的 CLI 参数
 * @returns 校验通过的 `ProposalDraft`
 * @throws {Error} 当必填字段缺失或 JSON 结构不合法时抛出
 */
function buildProposalDraftFromArgs(parsed: Readonly<ParsedCliArgs>): ProposalDraft {
  const draftJsonRaw = getLastFlag(parsed, "draft-json");
  const draftFilePath = getLastFlag(parsed, "draft-file");

  if (draftJsonRaw !== undefined || draftFilePath !== undefined) {
    const jsonSource = draftJsonRaw ?? readFileSync(resolve(draftFilePath ?? ""), "utf8");
    const rawObj: unknown = JSON.parse(jsonSource);
    if (typeof rawObj !== "object" || rawObj === null) {
      throw new Error("Proposal draft JSON must be an object.");
    }
    const rec = rawObj as Record<string, unknown>;
    if (
      typeof rec.title !== "string" ||
      typeof rec.contextSummary !== "string" ||
      !Array.isArray(rec.options) ||
      rec.options.length === 0
    ) {
      throw new Error(
        "Proposal draft JSON requires string `title`, `contextSummary`, and non-empty `options` array.",
      );
    }
    return rawObj as ProposalDraft;
  }

  const title = getLastFlag(parsed, "title")?.trim();
  const contextSummary = getLastFlag(parsed, "summary")?.trim();
  const recommendedOptionKey = getLastFlag(parsed, "recommended")?.trim();
  const rawOptions = parsed.flags.option ?? [];

  if (!title || !contextSummary || rawOptions.length === 0) {
    throw new Error(
      'Missing proposal fields. Pass --draft-json \'<json>\', --draft-file <path>, or --title "..." --summary "..." --option "key:label:summary".',
    );
  }

  const options: ProposalOption[] = rawOptions.map((specStr, idx) => {
    const parts = specStr.split(":");
    const optionKey = (parts[0] ?? "").trim() || `opt_${idx + 1}`;
    const label = (parts[1] ?? "").trim() || optionKey;
    const summary = parts.slice(2).join(":").trim() || label;
    return {
      optionKey,
      label,
      summary,
      pros: [],
      cons: [],
      risks: [],
    };
  });

  return {
    title,
    contextSummary,
    ...(recommendedOptionKey !== undefined && recommendedOptionKey.length > 0
      ? { recommendedOptionKey }
      : {}),
    options,
  };
}

/**
 * 解析 `listen` 子命令所需的唤醒执行目标（`--agent` 预设、`--run` 自定义命令，或自动回退读取配对元数据中的 `platform`）。
 *
 * @param parsed - 解析后的 CLI 参数
 * @param fallbackPlatform - 本地 `.token.json` 元数据中保存的已配对宿主平台（可选）
 * @returns 结构化唤醒执行目标
 * @throws {Error} 当未指定唤醒方式且元数据平台无内置无头预设，或 `--agent` 值不受支持时抛出
 */
function resolveWakeTarget(
  parsed: Readonly<ParsedCliArgs>,
  fallbackPlatform?: AgentPlatform,
): WakeExecutionTarget {
  const customRun = getLastFlag(parsed, "run");
  if (customRun !== undefined && customRun.trim().length > 0) {
    return { kind: "custom", command: customRun.trim() };
  }

  const rawAgent = getLastFlag(parsed, "agent");
  if (rawAgent !== undefined) {
    const preset = parseWakeAgentPreset(rawAgent);
    if (preset === undefined) {
      throw new Error(
        `Unsupported --agent "${rawAgent}". Expected one of: antigravity, codex, claude_code, gemini.`,
      );
    }
    return { kind: "preset", preset };
  }

  // 零标志开箱即用：若用户省略 `--agent`（如直接按 `/install.md` 运行 `listen install --token-file ...`），
  // 自动从配对阶段落盘的 `.token.json` 元数据恢复预设平台。
  if (fallbackPlatform !== undefined) {
    const inferredPreset = parseWakeAgentPreset(fallbackPlatform);
    if (inferredPreset !== undefined) {
      return { kind: "preset", preset: inferredPreset };
    }
    throw new Error(
      `Paired platform "${fallbackPlatform}" requires a custom wake hook. Pass --agent <antigravity|codex|claude_code|gemini> or --run "<shell command>".`,
    );
  }

  throw new Error(
    'Specify either --agent <antigravity|codex|claude_code|gemini> or --run "<shell command>".',
  );
}

/**
 * 从配对码或完整接入 URL（如 `https://huddle.example.com?code=HUDDLE-XXXX`）中提取配对码与可选内嵌服务地址。
 *
 * @param rawInput - 原始配对码或接入链接
 * @returns 配对码与可选解析出的 `serverUrl`
 */
function parseConnectInput(rawInput: string | undefined): {
  readonly code?: string;
  readonly embeddedServerUrl?: string;
  readonly embeddedName?: string;
  readonly embeddedPlatform?: AgentPlatform;
} {
  if (rawInput === undefined || rawInput.trim().length === 0) {
    return {};
  }
  const trimmed = rawInput.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      const queryCode = url.searchParams.get("code")?.trim();
      const queryName = url.searchParams.get("name")?.trim();
      const queryPlatform = resolveAgentPlatform(url.searchParams.get("platform") ?? undefined);
      const pathSegments = url.pathname.split("/").filter((s) => s.length > 0);
      const lastSeg = pathSegments[pathSegments.length - 1];
      const fallbackCode =
        lastSeg !== undefined && /^HUDDLE-/i.test(lastSeg) ? lastSeg.trim() : undefined;
      const finalCode = queryCode && queryCode.length > 0 ? queryCode : fallbackCode;
      return {
        ...(finalCode !== undefined ? { code: finalCode } : {}),
        embeddedServerUrl: normalizeServerUrl(url.origin),
        ...(queryName !== undefined && queryName.length > 0 ? { embeddedName: queryName } : {}),
        ...(queryPlatform !== undefined ? { embeddedPlatform: queryPlatform } : {}),
      };
    } catch {
      return { code: trimmed };
    }
  }
  return { code: trimmed };
}

/**
 * 渲染 CLI 帮助手册文本。
 *
 * @returns 多行帮助说明
 */
function buildHelpText(): string {
  return [
    "OpenHuddle CLI v0.1.0 — Cloud & Cross-Platform Personal Agent Bridge",
    "Usage: openhuddle <command> [options]",
    "",
    "Global Options:",
    "  --server <url>                OpenHuddle server URL (or OPENHUDDLE_URL)",
    "  --token-file <path>           Isolated agent token path (or --profile <slug>)",
    "  --json                        Emit machine-readable JSON output",
    "",
    "Commands:",
    "  connect <codeOrUrl> [--name <n>] [--platform <p>] [--reclaim] [--no-listen] [--no-greet]",
    "                                Agile 1-step connect for cloud containers, remote VMs & local hosts",
    "  pair <code> --name <n> --platform <p> [--listen] [--greet] [--intro <text>] [--reclaim]",
    "                                Bind agent, optionally start SSE daemon & post join greeting in 1 step",
    "  whoami                        Inspect authenticated agent, human owner & sibling agents",
    "  profile [--name <n>] [--intro <text>] [--checkin-interval <min>]",
    "                                Update agent display name, intro, or check-in cadence",
    "  inbox [--wait <0..25>]        Fetch pending mentions, owner commands & unread summary",
    "  wait [--room <id>] [--timeout <1..300>]",
    "                                Block on SSE / long-polling until woken, then read new messages",
    "  rooms                         List joined Huddle rooms and governance states",
    "  create <name> [--topic <t>] [--rules <r>] [--visibility invite_only|public_shareable]",
    "                                Create a new Huddle room",
    "  join <inviteTokenOrUrl>       Join a room via invite token or invite link",
    "  members [roomId]              List room members with owner attribution & live reach state",
    "  read [roomId] [--after <seq>] [--limit <n>]",
    "                                Read incremental messages and advance local lastReadSeq cursor",
    "  reply <content> [--room <id>] [--reply <seq>] [--ignore-unread]",
    "                                Reply to active/default room with automatic read-lock cursor",
    "  send <roomId> <content> [--reply <seq>] [--last-read-seq <seq>] [--ignore-unread]",
    "                                Send message with automatic optimistic read-lock cursor",
    "  propose [roomId] (--draft-json <json> | --title <t> --summary <s> --option <k:l:s>)",
    "                                Submit a structured multi-option proposal card (or --list)",
    "  vote <proposalId> --stance <endorse|challenge|abstain> --rationale <text> [--option <key>]",
    "                                Cast a structured vote on a proposal card",
    "  listen <run|install|status|stop> [--agent antigravity|codex|claude_code|gemini | --run <cmd>]",
    "                                Run or manage macOS/Linux/Windows/Container SSE wake daemon",
    "  mcp                           Start built-in zero-dependency MCP stdio JSON-RPC server",
    "  help                          Show this command reference",
  ].join("\n");
}

/**
 * 执行 CLI 主流程并返回进程退出码。
 *
 * @param argv - 原始参数数组（不含 `node` 与脚本路径）
 * @param context - 可选注入的测试或宿主上下文
 * @returns 进程退出码（`0` 表示成功，非 `0` 表示业务冲突或执行错误）
 */
export async function runCli(
  argv: readonly string[],
  context: Readonly<CliExecutionContext> = {},
): Promise<number> {
  const baseHome = context.homeDir ?? homedir();
  const writeOut = context.stdout ?? ((line: string): void => console.log(line));
  const writeErr = context.stderr ?? ((line: string): void => console.error(line));
  const parsed = parseCliArgs(argv, baseHome);

  const emitJson = (payload: unknown): void => {
    writeOut(JSON.stringify(payload, null, 2));
  };

  if (
    parsed.command === "help" ||
    parsed.command === "--help" ||
    parsed.command === "-h" ||
    parsed.booleanFlags.has("--help")
  ) {
    if (parsed.json) {
      emitJson({
        ok: true,
        version: "0.1.0",
        commands: [
          "connect",
          "pair",
          "whoami",
          "profile",
          "inbox",
          "wait",
          "rooms",
          "create",
          "join",
          "members",
          "read",
          "reply",
          "send",
          "propose",
          "vote",
          "listen",
          "mcp",
          "help",
        ],
      });
    } else {
      writeOut(buildHelpText());
    }
    return 0;
  }

  try {
    if (parsed.command === "pair" || parsed.command === "connect") {
      const isConnect = parsed.command === "connect";
      const parsedInput = parseConnectInput(parsed.positionals[0] ?? getLastFlag(parsed, "code"));
      const pairingCode = parsedInput.code;
      const effectivePairServerUrl = parsed.hasExplicitServerUrl
        ? parsed.serverUrl
        : (parsedInput.embeddedServerUrl ?? parsed.serverUrl);

      const explicitPlatform =
        resolveAgentPlatform(getLastFlag(parsed, "platform")) ?? parsedInput.embeddedPlatform;
      const platform: AgentPlatform | undefined = isConnect
        ? (explicitPlatform ?? "custom")
        : explicitPlatform;

      const explicitName = getLastFlag(parsed, "name")?.trim() ?? parsedInput.embeddedName;
      const requestedName = isConnect
        ? explicitName && explicitName.length > 0
          ? explicitName
          : `Agent-${platform === "custom" ? "Cloud" : platform}-${(pairingCode ?? "0000").slice(-4)}`
        : explicitName;

      const intro = getLastFlag(parsed, "intro")?.trim();
      const reclaim = parsed.booleanFlags.has("--reclaim");
      const listenRequested = isConnect
        ? !parsed.booleanFlags.has("--no-listen")
        : parsed.booleanFlags.has("--listen");
      const greetRequested = isConnect
        ? !parsed.booleanFlags.has("--no-greet")
        : parsed.booleanFlags.has("--greet");

      if (!pairingCode || !requestedName || platform === undefined) {
        writeErr(
          isConnect
            ? "Usage: openhuddle connect <codeOrUrl> [--name <name>] [--platform <platform>] [--server <url>] [--reclaim] [--no-listen] [--no-greet]"
            : "Usage: openhuddle pair <code> --name <name> --platform <antigravity|codex|claude_code|cursor|deepseek|openclaw|gemini|chatgpt|hosted|custom> [--listen] [--greet] [--intro <text>] [--reclaim]",
        );
        return 1;
      }

      const inspectExistingTokenFn = async (probeUrl: string, existingToken: string) => {
        try {
          const probeClient = new OpenHuddleHttpClient({
            serverUrl: probeUrl,
            token: existingToken,
            ...(context.fetchImpl !== undefined ? { fetchImpl: context.fetchImpl } : {}),
          });
          return await probeClient.getMe();
        } catch (err) {
          if (err instanceof OpenHuddleApiError && err.status === 401) {
            return undefined;
          }
          return undefined;
        }
      };

      // `connect` 未显式指定 `--token-file` 时自动按 slug 分配独立凭据路径（被其他活跃 Agent 占用时自动顺延 `-2`, `-3`），彻底免除手工挑选路径
      let targetTokenFilePath = parsed.tokenFilePath;
      if (isConnect && !parsed.hasExplicitTokenFile) {
        const baseSlug = sanitizeTokenSlug(getLastFlag(parsed, "slug") ?? requestedName);
        let candidateSlug = baseSlug;
        let suffixIdx = 2;
        while (suffixIdx <= 20) {
          const candidatePath = join(baseHome, ".openhuddle", "tokens", `${candidateSlug}.token`);
          if (!existsSync(candidatePath)) {
            targetTokenFilePath = candidatePath;
            break;
          }
          const check = await checkTokenFileCollision({
            tokenFilePath: candidatePath,
            serverUrl: effectivePairServerUrl,
            pairingCode,
            requestedName,
            requestedPlatform: platform,
            reclaim,
            homeDir: baseHome,
            inspectExistingToken: inspectExistingTokenFn,
          });
          if (check.status === "clear") {
            targetTokenFilePath = candidatePath;
            break;
          }
          candidateSlug = `${baseSlug}-${suffixIdx}`;
          suffixIdx += 1;
        }
      }

      // 配对前防覆盖卫士：在核销一次性配对码前，先用本地既有 Token 调用 GET /api/v1/me 检查是否属于另一活跃 Agent
      const collision = await checkTokenFileCollision({
        tokenFilePath: targetTokenFilePath,
        serverUrl: effectivePairServerUrl,
        pairingCode,
        requestedName,
        requestedPlatform: platform,
        reclaim,
        homeDir: baseHome,
        inspectExistingToken: inspectExistingTokenFn,
      });

      if (collision.status === "collision") {
        if (parsed.json) {
          emitJson({
            ok: false,
            error: {
              code: "TOKEN_FILE_COLLISION",
              message: collision.message,
              existingAgentId: collision.existingAgentId,
              existingDisplayName: collision.existingDisplayName,
              suggestedTokenFilePath: collision.suggestedDisplayPath,
              suggestedCommand: collision.suggestedCommand,
            },
          });
        } else {
          writeErr(collision.message);
        }
        return 1;
      }

      const unauthClient = new OpenHuddleHttpClient({
        serverUrl: effectivePairServerUrl,
        ...(context.fetchImpl !== undefined ? { fetchImpl: context.fetchImpl } : {}),
      });
      const pairRes = await unauthClient.pairAgent({
        code: pairingCode,
        name: requestedName,
        platform,
        ...(intro !== undefined && intro.length > 0 ? { intro } : {}),
        reclaim,
      });

      const nowIso = new Date().toISOString();
      writeStoredCredentials(targetTokenFilePath, pairRes.token, {
        serverUrl: effectivePairServerUrl,
        agentId: pairRes.agent.id,
        slug: pairRes.agent.slug,
        displayName: pairRes.agent.displayName,
        platform: pairRes.agent.platform,
        ...(pairRes.autoJoinedRoomId !== undefined
          ? { defaultRoomId: pairRes.autoJoinedRoomId }
          : {}),
        updatedAtIso: nowIso,
      });
      writeActiveCliProfile(
        {
          tokenFilePath: resolve(targetTokenFilePath),
          serverUrl: effectivePairServerUrl,
          agentId: pairRes.agent.id,
          slug: pairRes.agent.slug,
          displayName: pairRes.agent.displayName,
          platform: pairRes.agent.platform,
          ...(pairRes.autoJoinedRoomId !== undefined
            ? { defaultRoomId: pairRes.autoJoinedRoomId }
            : {}),
          updatedAtIso: nowIso,
        },
        baseHome,
      );

      // 先判定当前环境是否具备可常驻拉起的本地预设 CLI 或自定义 `--run` 脚本，以便生成准确的报到文案
      const explicitRunCmd = getLastFlag(parsed, "run");
      const explicitAgentPreset = getLastFlag(parsed, "agent");
      const inferredPreset = parseWakeAgentPreset(pairRes.agent.platform);
      const checkPresetBinary =
        context.hasPresetBinary ??
        (context.daemonDeps !== undefined
          ? (): boolean => true
          : (preset: WakeAgentPreset): boolean => isPresetCliBinaryAvailable(preset, baseHome));

      const canStartBackgroundListener =
        listenRequested &&
        (explicitRunCmd !== undefined ||
          explicitAgentPreset !== undefined ||
          (inferredPreset !== undefined && checkPresetBinary(inferredPreset)));

      // 一键极速体验（1）：发送进群打招呼消息，推进服务端与本地 `lastReadSeq` 游标并即时通知前端群聊时间线
      let greetedMessageSeq: MessageSeq | undefined;
      if (greetRequested && pairRes.autoJoinedRoomId !== undefined) {
        try {
          const authedClient = new OpenHuddleHttpClient({
            serverUrl: effectivePairServerUrl,
            token: pairRes.token,
            ...(context.fetchImpl !== undefined ? { fetchImpl: context.fetchImpl } : {}),
          });
          const greetingContent = canStartBackgroundListener
            ? reclaim
              ? `${pairRes.agent.displayName} 已重新连回群聊并恢复实时监听，直接 @ 我即可继续讨论。`
              : `大家好，我是 ${pairRes.agent.displayName}，已连入群聊并开启实时监听，直接 @ 我即可开始讨论。`
            : reclaim
              ? `${pairRes.agent.displayName} 已从当前环境重新连回群聊，随时可通过 CLI 参与讨论。`
              : `大家好，我是 ${pairRes.agent.displayName}，已连入群聊就绪，随时参与讨论与提案协作。`;
          const sentGreeting = await authedClient.sendRoomMessage(pairRes.autoJoinedRoomId, {
            content: greetingContent,
            ignoreUnread: true,
            opKey: `op_greet_${pairRes.agent.id}_${randomUUID()}` as OperationKey,
          });
          greetedMessageSeq = sentGreeting.message.seq;
          updateRoomLastReadSeq(
            pairRes.agent.id,
            pairRes.autoJoinedRoomId,
            sentGreeting.message.seq as unknown as ReadCursorSeq,
            baseHome,
          );
        } catch (greetErr) {
          // 进群打招呼属于非阻塞体验增强（如房间处于预算暂停态返回 429），不应导致已消费口令的 pair 退出码变红
          writeErr(
            `[openhuddle:pair] Auto-greeting skipped: ${
              greetErr instanceof Error ? greetErr.message : String(greetErr)
            }`,
          );
        }
      }

      // 一键极速体验（2）：在具备唤醒目标时启动后台常驻 SSE 守护（自动兼容 systemd/launchd/schtasks 与云端容器脱离进程兜底）
      let daemonReport: DaemonControlReport | undefined;
      let daemonSkippedNote: string | undefined;
      let listenerMode: "daemon" | "on_demand_cli" | "disabled" = listenRequested
        ? "on_demand_cli"
        : "disabled";

      if (listenRequested) {
        if (canStartBackgroundListener) {
          try {
            const target = resolveWakeTarget(parsed, pairRes.agent.platform);
            const slug =
              getLastFlag(parsed, "slug") ??
              pairRes.agent.slug ??
              deriveSlugFromTokenPath(targetTokenFilePath);
            const cliScriptPath =
              context.cliScriptPath ?? process.argv[1] ?? fileURLToPath(import.meta.url);
            const nodeBinaryPath = context.nodeBinaryPath ?? process.execPath;

            daemonReport = installDaemonService(
              {
                slug,
                nodeBinaryPath,
                cliScriptPath,
                serverUrl: effectivePairServerUrl,
                tokenFilePath: resolve(targetTokenFilePath),
                target,
                homeDir: baseHome,
              },
              context.daemonDeps,
            );
            listenerMode = "daemon";
          } catch (daemonErr) {
            // 云端极端受限沙箱（如禁止 fork 后台进程）下绝不废弃已核销的 Token，优雅降级为按需 CLI 模式
            daemonSkippedNote = `Cloud/sandbox fallback: background daemon unavailable (${
              daemonErr instanceof Error ? daemonErr.message : String(daemonErr)
            }); use "openhuddle read", "openhuddle reply", or "openhuddle wait" directly.`;
          }
        } else if (inferredPreset !== undefined) {
          daemonSkippedNote = `Mode: Cloud / interactive CLI ready (no local "${inferredPreset}" binary on PATH; use "openhuddle read", "openhuddle reply", or "openhuddle wait" directly).`;
        } else {
          daemonSkippedNote = `Mode: Interactive CLI ready (use "openhuddle read", "openhuddle reply", or "openhuddle wait"; or pass --run "<cmd>" to "listen install" for custom auto-wake).`;
        }
      }

      if (parsed.json) {
        emitJson({
          ok: true,
          agent: pairRes.agent,
          owner: pairRes.owner,
          serverUrl: effectivePairServerUrl,
          tokenFilePath: resolve(targetTokenFilePath),
          listenerMode,
          ...(pairRes.autoJoinedRoomId !== undefined
            ? { autoJoinedRoomId: pairRes.autoJoinedRoomId }
            : {}),
          ...(greetedMessageSeq !== undefined ? { greetedMessageSeq } : {}),
          ...(daemonReport !== undefined ? { listener: daemonReport } : {}),
          ...(daemonSkippedNote !== undefined ? { note: daemonSkippedNote } : {}),
        });
      } else {
        writeOut(
          [
            `Paired agent "${pairRes.agent.displayName}" (${pairRes.agent.id}, platform=${pairRes.agent.platform}).`,
            `Verified human owner: ${pairRes.owner.displayName} <${pairRes.owner.email}> (${pairRes.owner.id}).`,
            `Isolated 0600 token saved to: ${resolve(targetTokenFilePath)}`,
            ...(pairRes.autoJoinedRoomId !== undefined
              ? [`Auto-joined room: ${pairRes.autoJoinedRoomId}`]
              : []),
            ...(greetedMessageSeq !== undefined && pairRes.autoJoinedRoomId !== undefined
              ? [
                  `Posted arrival greeting #${greetedMessageSeq} in room ${pairRes.autoJoinedRoomId}.`,
                ]
              : []),
            ...(daemonReport !== undefined
              ? [daemonReport.detail, `Logs: ${daemonReport.logOutPath}`]
              : []),
            ...(daemonSkippedNote !== undefined ? [daemonSkippedNote] : []),
          ].join("\n"),
        );
      }
      return 0;
    }

    // 未显式指定 `--token-file` 时优先读取最近一次 `connect`/`pair` 激活的 `active-profile.json`，兼容回退 `default.token`
    const activeProfile = !parsed.hasExplicitTokenFile ? readActiveCliProfile(baseHome) : undefined;
    const effectiveTokenFilePath =
      !parsed.hasExplicitTokenFile && activeProfile !== undefined
        ? activeProfile.tokenFilePath
        : parsed.tokenFilePath;

    // `listen status` 与 `listen stop` 属于纯本机 OS 守护进程查询/卸载操作，即使 `.token` 文件已被先行删除也允许凭 `--slug` 正常执行
    if (parsed.command === "listen") {
      const subcommand = parsed.positionals[0] ?? "status";
      if (subcommand === "status" || subcommand === "stop") {
        const optionalStored = readStoredCredentials(effectiveTokenFilePath);
        const slug =
          getLastFlag(parsed, "slug") ??
          optionalStored?.metadata?.slug ??
          deriveSlugFromTokenPath(effectiveTokenFilePath);
        const report =
          subcommand === "status"
            ? getDaemonServiceStatus({ slug, homeDir: baseHome }, context.daemonDeps)
            : stopDaemonService({ slug, homeDir: baseHome }, context.daemonDeps);
        if (parsed.json) {
          emitJson({ ok: true, ...report });
        } else if (subcommand === "status") {
          writeOut(`${report.detail} (running=${report.running})`);
        } else {
          writeOut(report.detail);
        }
        return 0;
      }
    }

    // 除 help、pair/connect 与本机守护 status/stop 外，其余所有命令均需读取已隔离保存的本地 Agent 凭据
    const stored =
      readStoredCredentials(effectiveTokenFilePath) ??
      (!parsed.hasExplicitTokenFile ? readStoredCredentials(parsed.tokenFilePath) : undefined);
    if (stored === undefined) {
      const msg = `No agent token found at ${resolve(effectiveTokenFilePath)}. Run "openhuddle connect <code> --name <name> --platform <platform>" first.`;
      if (parsed.json) {
        emitJson({ ok: false, error: { code: "MISSING_TOKEN_FILE", message: msg } });
      } else {
        writeErr(msg);
      }
      return 1;
    }

    const effectiveServerUrl = parsed.hasExplicitServerUrl
      ? parsed.serverUrl
      : (stored.metadata?.serverUrl ?? activeProfile?.serverUrl ?? parsed.serverUrl);

    const client = new OpenHuddleHttpClient({
      serverUrl: effectiveServerUrl,
      token: stored.token,
      ...(context.fetchImpl !== undefined ? { fetchImpl: context.fetchImpl } : {}),
    });

    const resolveCurrentAgentId = async (): Promise<AgentId | undefined> => {
      if (stored.metadata?.agentId !== undefined) {
        return stored.metadata.agentId;
      }
      const me = await client.getMe();
      return me.callerKind === "agent" ? me.agent.id : undefined;
    };

    const resolveTargetRoomId = async (explicitRoomCandidate?: string): Promise<RoomId> => {
      const fromArg = explicitRoomCandidate?.trim() || getLastFlag(parsed, "room")?.trim();
      if (fromArg !== undefined && fromArg.length > 0) {
        return fromArg as RoomId;
      }
      const fromEnv = process.env.OPENHUDDLE_ROOM_ID?.trim();
      if (fromEnv !== undefined && fromEnv.length > 0) {
        return fromEnv as RoomId;
      }
      const remembered = stored.metadata?.defaultRoomId ?? activeProfile?.defaultRoomId;
      if (remembered !== undefined) {
        return remembered;
      }
      const roomsRes = await client.listRooms();
      if (roomsRes.rooms.length === 1 && roomsRes.rooms[0] !== undefined) {
        const onlyRoomId = roomsRes.rooms[0].id;
        rememberDefaultRoomId(stored.tokenFilePath, onlyRoomId, baseHome);
        return onlyRoomId;
      }
      if (roomsRes.rooms.length === 0) {
        throw new Error(
          'Your agent has not joined any Huddle room yet. Run "openhuddle join <inviteToken>" first.',
        );
      }
      const roomChoices = roomsRes.rooms.map((r) => `${r.id} (${r.name})`).join(", ");
      throw new Error(`Multiple rooms joined (${roomChoices}). Pass <roomId> or --room <roomId>.`);
    };

    switch (parsed.command) {
      case "whoami": {
        const me = await client.getMe();
        if (parsed.json) {
          emitJson(me);
        } else if (me.callerKind === "agent") {
          writeOut(
            [
              `Agent: ${me.agent.displayName} (${me.agent.id}) [platform=${me.agent.platform}, reach=${me.agent.reach}]`,
              `Owner: ${me.owner.displayName} <${me.owner.email}> (${me.owner.id})`,
              `Sibling Agents (${me.siblingAgents.length}): ${
                me.siblingAgents.map((sib) => `${sib.displayName} (${sib.platform})`).join(", ") ||
                "none"
              }`,
            ].join("\n"),
          );
        } else {
          writeOut(`Human: ${me.user.displayName} <${me.user.email}> (${me.user.id})`);
        }
        return 0;
      }

      case "profile": {
        const displayName = getLastFlag(parsed, "name")?.trim();
        const intro = getLastFlag(parsed, "intro")?.trim();
        const rawInterval = getLastFlag(parsed, "checkin-interval");
        const checkinIntervalMin =
          rawInterval !== undefined ? Number.parseInt(rawInterval, 10) : undefined;

        if (
          checkinIntervalMin !== undefined &&
          (!Number.isSafeInteger(checkinIntervalMin) ||
            checkinIntervalMin < 1 ||
            checkinIntervalMin > 1_440)
        ) {
          throw new Error("--checkin-interval must be an integer between 1 and 1440 minutes.");
        }

        const updateBody: UpdateMeBody = {
          ...(displayName !== undefined && displayName.length > 0 ? { displayName } : {}),
          ...(intro !== undefined ? { intro } : {}),
          ...(checkinIntervalMin !== undefined ? { checkinIntervalMin } : {}),
        };

        const updated = await client.updateProfile(updateBody);
        if (parsed.json) {
          emitJson(updated);
        } else {
          writeOut(
            `Updated profile${updated.agent !== undefined ? ` for "${updated.agent.displayName}" (${updated.agent.id})` : ""}.`,
          );
        }
        return 0;
      }

      case "inbox": {
        const waitRaw = getLastFlag(parsed, "wait");
        const waitSec = waitRaw !== undefined ? Number.parseInt(waitRaw, 10) : 0;
        if (!Number.isSafeInteger(waitSec) || waitSec < 0 || waitSec > 25) {
          throw new Error("--wait must be an integer between 0 and 25 seconds.");
        }
        const inbox = await client.getInbox(waitSec);
        if (parsed.json) {
          emitJson(inbox);
        } else {
          const lines = [
            `Inbox (${inbox.serverTimeIso}): totalUnread=${inbox.totalUnreadMessages}, rooms=${inbox.rooms.length}`,
          ];
          for (const room of inbox.rooms) {
            const badges: string[] = [];
            if (room.hasOwnerCommand) {
              badges.push("OWNER_COMMAND");
            }
            if (room.hasDirectMention) {
              badges.push("DIRECT_MENTION");
            }
            const badgeText = badges.length > 0 ? ` [${badges.join(", ")}]` : "";
            lines.push(
              `  - ${room.roomName} (${room.roomId}): unread=${room.unreadCount} (${room.yourLastReadSeq}->${room.lastSeq}) gov=${room.governanceStatus}${badgeText}`,
            );
          }
          writeOut(lines.join("\n"));
        }
        return 0;
      }

      case "rooms": {
        const res = await client.listRooms();
        if (parsed.json) {
          emitJson(res);
        } else {
          const lines = [`Joined Rooms (${res.rooms.length}):`];
          for (const room of res.rooms) {
            lines.push(
              `  - ${room.name} (${room.id}) [kind=${room.kind}, seq=${room.yourLastReadSeq}/${room.lastSeq}, mode=${room.governance.config.mode}, status=${room.governance.status}]`,
            );
          }
          writeOut(lines.join("\n"));
        }
        return 0;
      }

      case "create": {
        const name = (parsed.positionals[0] ?? getLastFlag(parsed, "name"))?.trim();
        if (!name) {
          throw new Error(
            'Usage: openhuddle create <roomName> [--topic "..."] [--rules "..."] [--visibility invite_only|public_shareable]',
          );
        }
        const topic = getLastFlag(parsed, "topic");
        const rules = getLastFlag(parsed, "rules");
        const rawVisibility = getLastFlag(parsed, "visibility");
        const visibility: RoomVisibility | undefined =
          rawVisibility === "invite_only" || rawVisibility === "public_shareable"
            ? rawVisibility
            : undefined;

        const created = await client.createRoom({
          name,
          ...(topic !== undefined ? { topic } : {}),
          ...(rules !== undefined ? { rules } : {}),
          ...(visibility !== undefined ? { visibility } : {}),
        });
        rememberDefaultRoomId(stored.tokenFilePath, created.room.id, baseHome);

        if (parsed.json) {
          emitJson(created);
        } else {
          const inviteSuffix =
            "inviteToken" in created.room && created.room.inviteToken !== undefined
              ? ` (inviteToken=${created.room.inviteToken})`
              : "";
          writeOut(`Created room "${created.room.name}" (${created.room.id})${inviteSuffix}`);
        }
        return 0;
      }

      case "join": {
        const rawInvite = parsed.positionals[0] ?? getLastFlag(parsed, "invite");
        if (!rawInvite) {
          throw new Error("Usage: openhuddle join <inviteTokenOrUrl>");
        }
        const inviteToken = extractInviteToken(rawInvite);
        const joined = await client.joinRoom(inviteToken);
        rememberDefaultRoomId(stored.tokenFilePath, joined.room.id, baseHome);
        const agentId = await resolveCurrentAgentId();
        if (agentId !== undefined) {
          updateRoomLastReadSeq(agentId, joined.room.id, joined.room.yourLastReadSeq, baseHome);
        }
        if (parsed.json) {
          emitJson(joined);
        } else {
          writeOut(`Joined room "${joined.room.name}" (${joined.room.id}).`);
        }
        return 0;
      }

      case "members": {
        const roomId = await resolveTargetRoomId(parsed.positionals[0]);
        const res = await client.listRoomMembers(roomId);
        if (parsed.json) {
          emitJson(res);
        } else {
          const lines = [`Members in ${roomId} (${res.members.length}):`];
          for (const m of res.members) {
            const detail =
              m.memberKind === "agent"
                ? `agent platform=${m.platform ?? "custom"} reach=${m.reach ?? "offline"} owner="${m.ownerDisplayName}"`
                : "human";
            lines.push(
              `  - ${m.displayName} [${m.role}] (${detail}, lastReadSeq=${m.lastReadSeq})`,
            );
          }
          writeOut(lines.join("\n"));
        }
        return 0;
      }

      case "read": {
        const roomId = await resolveTargetRoomId(parsed.positionals[0]);
        const agentId = await resolveCurrentAgentId();
        const explicitAfterRaw = getLastFlag(parsed, "after");
        const limitRaw = getLastFlag(parsed, "limit");

        const afterSeq =
          explicitAfterRaw !== undefined
            ? Number.parseInt(explicitAfterRaw, 10)
            : agentId !== undefined
              ? getRoomLastReadSeq(agentId, roomId, baseHome)
              : undefined;
        const limit = limitRaw !== undefined ? Number.parseInt(limitRaw, 10) : undefined;

        const res = await client.readRoomMessages(roomId, {
          ...(afterSeq !== undefined && Number.isSafeInteger(afterSeq) ? { afterSeq } : {}),
          ...(limit !== undefined && Number.isSafeInteger(limit) ? { limit } : {}),
        });

        // 游标单调同步：若本次拉取到了新消息，推进至实际读到的最后一条消息 seq；若无新消息则对齐 latestSeq
        if (agentId !== undefined) {
          const highestReadSeq =
            res.messages.length > 0
              ? (Math.max(...res.messages.map((msg) => msg.seq)) as ReadCursorSeq)
              : res.latestSeq;
          updateRoomLastReadSeq(agentId, roomId, highestReadSeq, baseHome);
        }

        if (parsed.json) {
          emitJson(res);
        } else {
          const lines = [
            `Room ${roomId} (latestSeq=${res.latestSeq}, governance=${res.governance.status}, mode=${res.governance.config.mode}):`,
          ];
          if (res.messages.length === 0) {
            lines.push("  (no new messages)");
          } else {
            for (const msg of res.messages) {
              lines.push(
                `  [#${msg.seq}] ${msg.author.displayName} (${msg.author.kind}, trust=${msg.author.trustLevel}): ${msg.content}`,
              );
            }
          }
          writeOut(lines.join("\n"));
        }
        return 0;
      }

      case "reply":
      case "send": {
        const isReplyShortcut = parsed.command === "reply";
        const roomId = isReplyShortcut
          ? await resolveTargetRoomId(getLastFlag(parsed, "room"))
          : (parsed.positionals[0]?.trim() as RoomId | undefined);
        const content = isReplyShortcut
          ? parsed.positionals.join(" ").trim() || getLastFlag(parsed, "content")?.trim()
          : parsed.positionals.slice(1).join(" ").trim() || getLastFlag(parsed, "content")?.trim();

        if (!roomId || !content) {
          throw new Error(
            isReplyShortcut
              ? "Usage: openhuddle reply <content> [--room <roomId>] [--reply <seq>] [--ignore-unread]"
              : "Usage: openhuddle send <roomId> <content> [--reply <seq>] [--last-read-seq <seq>] [--ignore-unread]",
          );
        }

        const agentId = await resolveCurrentAgentId();
        const explicitLastReadRaw = getLastFlag(parsed, "last-read-seq");
        let cachedLastRead =
          agentId !== undefined ? getRoomLastReadSeq(agentId, roomId, baseHome) : undefined;

        // `reply` 快捷指令在临时云端容器首次调用且尚无本地游标时，若未开启 `--ignore-unread`，自动查一次房间当前游标对齐
        if (
          isReplyShortcut &&
          explicitLastReadRaw === undefined &&
          cachedLastRead === undefined &&
          !parsed.booleanFlags.has("--ignore-unread")
        ) {
          const snapshot = await client.readRoomMessages(roomId, { limit: 1 });
          cachedLastRead = snapshot.latestSeq;
          if (agentId !== undefined) {
            updateRoomLastReadSeq(agentId, roomId, snapshot.latestSeq, baseHome);
          }
        }

        const lastReadSeq =
          explicitLastReadRaw !== undefined
            ? (Number.parseInt(explicitLastReadRaw, 10) as ReadCursorSeq)
            : cachedLastRead;

        const replyRaw = getLastFlag(parsed, "reply");
        const replyToSeq =
          replyRaw !== undefined ? (Number.parseInt(replyRaw, 10) as MessageSeq) : undefined;
        const opKey = (getLastFlag(parsed, "op-key") ?? `op_${randomUUID()}`) as OperationKey;
        const mentions = parseMentionsFromFlags(parsed);
        const ignoreUnread = parsed.booleanFlags.has("--ignore-unread");

        const sent = await client.sendRoomMessage(roomId, {
          content,
          ...(replyToSeq !== undefined ? { replyToSeq } : {}),
          ...(mentions.length > 0 ? { mentions } : {}),
          opKey,
          ...(lastReadSeq !== undefined ? { lastReadSeq } : {}),
          ignoreUnread,
        });

        if (agentId !== undefined) {
          updateRoomLastReadSeq(
            agentId,
            roomId,
            sent.message.seq as unknown as ReadCursorSeq,
            baseHome,
          );
        }

        if (parsed.json) {
          emitJson(sent);
        } else {
          writeOut(
            `Sent message #${sent.message.seq} to ${roomId} (governance=${sent.governance.status}, woken=${sent.wokenAgentIds.length}).`,
          );
        }
        return 0;
      }

      case "wait": {
        const timeoutRaw = getLastFlag(parsed, "timeout") ?? getLastFlag(parsed, "wait");
        const timeoutSec = timeoutRaw !== undefined ? Number.parseInt(timeoutRaw, 10) : 30;
        if (!Number.isSafeInteger(timeoutSec) || timeoutSec < 1 || timeoutSec > 300) {
          throw new Error("--timeout must be an integer between 1 and 300 seconds.");
        }
        const explicitRoomFilter = (parsed.positionals[0] ?? getLastFlag(parsed, "room"))?.trim() as
          | RoomId
          | undefined;
        const agentId = await resolveCurrentAgentId();

        const collectUnreadMessages = async (
          candidateRoomIds: readonly RoomId[],
        ): Promise<
          Array<{ readonly roomId: RoomId; readonly messages: readonly MessageDto[] }>
        > => {
          const batches: Array<{
            readonly roomId: RoomId;
            readonly messages: readonly MessageDto[];
          }> = [];
          for (const candidateRoomId of candidateRoomIds) {
            const afterSeq =
              agentId !== undefined
                ? getRoomLastReadSeq(agentId, candidateRoomId, baseHome)
                : undefined;
            const res = await client.readRoomMessages(candidateRoomId, {
              ...(afterSeq !== undefined ? { afterSeq } : {}),
              limit: 50,
            });
            if (agentId !== undefined) {
              const highest =
                res.messages.length > 0
                  ? (Math.max(...res.messages.map((m) => m.seq)) as ReadCursorSeq)
                  : res.latestSeq;
              updateRoomLastReadSeq(agentId, candidateRoomId, highest, baseHome);
            }
            if (res.messages.length > 0) {
              batches.push({ roomId: candidateRoomId, messages: res.messages });
            }
          }
          return batches;
        };

        // 1. 先做一次零等待收件箱快检：若已有未读消息则立即返回，绝不空等
        const initialInbox = await client.getInbox(0);
        const unreadRoomsNow = initialInbox.rooms
          .filter(
            (r) =>
              r.unreadCount > 0 &&
              (explicitRoomFilter === undefined || r.roomId === explicitRoomFilter),
          )
          .map((r) => r.roomId);

        let triggeredReason = "timeout";
        let collected =
          unreadRoomsNow.length > 0 ? await collectUnreadMessages(unreadRoomsNow) : [];

        if (collected.length > 0) {
          triggeredReason = "unread_present";
        } else {
          // 2. 建立带超时的 SSE 监听（若上游网关不支持流式 SSE 则自动回退至 /api/v1/inbox 长轮询）
          const fetchFn = context.fetchImpl ?? globalThis.fetch;
          const waitController = new AbortController();
          const onParentAbort = (): void => waitController.abort();
          context.listenerSignal?.addEventListener("abort", onParentAbort, { once: true });
          const deadlineMs = Date.now() + timeoutSec * 1_000;
          const timer = setTimeout(() => waitController.abort(), timeoutSec * 1_000);
          let wokenRoomId: RoomId | undefined;

          try {
            const sseRes = await fetchFn(`${effectiveServerUrl}/api/v1/events`, {
              method: "GET",
              headers: {
                Authorization: `Bearer ${stored.token}`,
                Accept: "text/event-stream",
                "Cache-Control": "no-cache",
              },
              signal: waitController.signal,
            });
            if (sseRes.ok && sseRes.body !== null) {
              for await (const frame of readSseFrames(sseRes.body, waitController.signal)) {
                const wake = parseWakeEventFrame(frame);
                if (
                  wake !== undefined &&
                  (explicitRoomFilter === undefined || wake.roomId === explicitRoomFilter)
                ) {
                  wokenRoomId = wake.roomId;
                  triggeredReason = wake.reason;
                  waitController.abort();
                  break;
                }
                if (frame.event === "message.created") {
                  try {
                    const parsedEvt = JSON.parse(frame.data) as Record<string, unknown>;
                    const evtRoomId =
                      typeof parsedEvt.roomId === "string"
                        ? (parsedEvt.roomId as RoomId)
                        : undefined;
                    if (
                      evtRoomId !== undefined &&
                      (explicitRoomFilter === undefined || evtRoomId === explicitRoomFilter)
                    ) {
                      wokenRoomId = evtRoomId;
                      triggeredReason = "message.created";
                      waitController.abort();
                      break;
                    }
                  } catch {
                    // 忽略非预期帧
                  }
                }
              }
            } else {
              const remainingSec = Math.max(
                1,
                Math.min(25, Math.ceil((deadlineMs - Date.now()) / 1_000)),
              );
              const polled = await client.getInbox(remainingSec);
              const matched = polled.rooms.find(
                (r) =>
                  r.unreadCount > 0 &&
                  (explicitRoomFilter === undefined || r.roomId === explicitRoomFilter),
              );
              if (matched !== undefined) {
                wokenRoomId = matched.roomId;
                triggeredReason = matched.hasOwnerCommand ? "owner_command" : "inbox_poll";
              }
            }
          } catch {
            // AbortError 代表超时或已捕获事件正常中断；若尚未到截止时间则用长轮询兜底
            const remainingMs = deadlineMs - Date.now();
            if (
              wokenRoomId === undefined &&
              remainingMs > 500 &&
              !context.listenerSignal?.aborted
            ) {
              try {
                const polled = await client.getInbox(
                  Math.max(1, Math.min(25, Math.ceil(remainingMs / 1_000))),
                );
                const matched = polled.rooms.find(
                  (r) =>
                    r.unreadCount > 0 &&
                    (explicitRoomFilter === undefined || r.roomId === explicitRoomFilter),
                );
                if (matched !== undefined) {
                  wokenRoomId = matched.roomId;
                  triggeredReason = matched.hasOwnerCommand ? "owner_command" : "inbox_poll";
                }
              } catch {
                // 忽略兜底轮询中断
              }
            }
          } finally {
            clearTimeout(timer);
            context.listenerSignal?.removeEventListener("abort", onParentAbort);
          }

          if (wokenRoomId !== undefined) {
            collected = await collectUnreadMessages([wokenRoomId]);
          } else if (explicitRoomFilter !== undefined) {
            collected = await collectUnreadMessages([explicitRoomFilter]);
            if (collected.length > 0) {
              triggeredReason = "room_activity";
            }
          }
        }

        if (parsed.json) {
          emitJson({
            ok: true,
            woken: collected.length > 0,
            reason: triggeredReason,
            rooms: collected,
          });
        } else if (collected.length === 0) {
          writeOut(`No new messages within ${timeoutSec}s.`);
        } else {
          const lines: string[] = [`Woken (${triggeredReason}):`];
          for (const batch of collected) {
            lines.push(`Room ${batch.roomId}:`);
            for (const msg of batch.messages) {
              lines.push(
                `  [#${msg.seq}] ${msg.author.displayName} (${msg.author.kind}, trust=${msg.author.trustLevel}): ${msg.content}`,
              );
            }
          }
          writeOut(lines.join("\n"));
        }
        return 0;
      }

      case "proposals": {
        const roomId = await resolveTargetRoomId(parsed.positionals[0]);
        const res = await client.listRoomProposals(roomId);
        if (parsed.json) {
          emitJson(res);
        } else {
          const lines = [`Proposals in ${roomId} (${res.proposals.length}):`];
          for (const prop of res.proposals) {
            lines.push(
              `  - [${prop.status}] ${prop.draft.title} (${prop.id}, votes=${prop.votes.length})`,
            );
          }
          writeOut(lines.join("\n"));
        }
        return 0;
      }

      case "propose": {
        const roomId = await resolveTargetRoomId(parsed.positionals[0]);
        if (parsed.booleanFlags.has("--list")) {
          const listRes = await client.listRoomProposals(roomId);
          if (parsed.json) {
            emitJson(listRes);
          } else {
            writeOut(`Proposals in ${roomId}: ${listRes.proposals.length}`);
          }
          return 0;
        }
        const draft = buildProposalDraftFromArgs(parsed);
        const created = await client.submitProposal(roomId, draft);
        if (parsed.json) {
          emitJson(created);
        } else {
          writeOut(
            `Submitted proposal "${created.proposal.draft.title}" (${created.proposal.id}) at seq #${created.proposal.originMessageSeq}.`,
          );
        }
        return 0;
      }

      case "vote": {
        const proposalId = parsed.positionals[0]?.trim() as ProposalId | undefined;
        const rawStance = getLastFlag(parsed, "stance")?.trim() as ProposalVoteStance | undefined;
        const rationale = getLastFlag(parsed, "rationale")?.trim();
        const preferredOptionKey = getLastFlag(parsed, "option")?.trim();

        if (!proposalId || !rawStance || !VALID_STANCES.has(rawStance) || !rationale) {
          throw new Error(
            'Usage: openhuddle vote <proposalId> --stance <endorse|challenge|abstain> --rationale "..." [--option <key>]',
          );
        }

        const voteBody: CastProposalVoteBody = {
          stance: rawStance,
          rationale,
          ...(preferredOptionKey !== undefined && preferredOptionKey.length > 0
            ? { preferredOptionKey }
            : {}),
        };

        const voted = await client.voteProposal(proposalId, voteBody);
        if (parsed.json) {
          emitJson(voted);
        } else {
          writeOut(
            `Recorded "${rawStance}" vote on proposal ${voted.proposal.id} (total votes=${voted.proposal.votes.length}).`,
          );
        }
        return 0;
      }

      case "mcp": {
        await runCliMcpStdioServer({
          client,
          homeDir: baseHome,
          ...(stored.metadata?.agentId !== undefined
            ? { cachedAgentId: stored.metadata.agentId }
            : {}),
          ...(context.mcpInputStream !== undefined ? { inputStream: context.mcpInputStream } : {}),
          ...(context.stdout !== undefined ? { writeStdoutLine: context.stdout } : {}),
        });
        return 0;
      }

      case "listen": {
        const subcommand = parsed.positionals[0] ?? "status";
        const slug =
          getLastFlag(parsed, "slug") ??
          stored.metadata?.slug ??
          deriveSlugFromTokenPath(stored.tokenFilePath);
        const cliScriptPath =
          context.cliScriptPath ?? process.argv[1] ?? fileURLToPath(import.meta.url);
        const nodeBinaryPath = context.nodeBinaryPath ?? process.execPath;

        if (subcommand === "run") {
          const target = resolveWakeTarget(parsed, stored.metadata?.platform);
          await startSseListener({
            serverUrl: effectiveServerUrl,
            token: stored.token,
            tokenFilePath: resolve(stored.tokenFilePath),
            target,
            cliScriptPath,
            homeDir: baseHome,
            ...(context.listenerSignal !== undefined ? { signal: context.listenerSignal } : {}),
            ...(context.fetchImpl !== undefined ? { fetchImpl: context.fetchImpl } : {}),
            onLog: writeErr,
          });
          return 0;
        }

        if (subcommand === "spawn-detached") {
          const target = resolveWakeTarget(parsed, stored.metadata?.platform);
          const spawned = spawnDetachedDaemonWorker(
            {
              slug,
              nodeBinaryPath,
              cliScriptPath,
              serverUrl: effectiveServerUrl,
              tokenFilePath: resolve(stored.tokenFilePath),
              target,
              homeDir: baseHome,
            },
            context.daemonDeps,
          );
          if (parsed.json) {
            emitJson({ ok: true, ...spawned });
          } else {
            writeOut(`Spawned detached listener PID ${spawned.pid} (${spawned.pidFilePath}).`);
          }
          return 0;
        }

        if (subcommand === "install") {
          const target = resolveWakeTarget(parsed, stored.metadata?.platform);
          const report = installDaemonService(
            {
              slug,
              nodeBinaryPath,
              cliScriptPath,
              serverUrl: effectiveServerUrl,
              tokenFilePath: resolve(stored.tokenFilePath),
              target,
              homeDir: baseHome,
            },
            context.daemonDeps,
          );
          if (parsed.json) {
            emitJson({ ok: true, ...report });
          } else {
            writeOut(
              [
                report.detail,
                ...(report.configFilePath !== undefined
                  ? [`Service config: ${report.configFilePath}`]
                  : []),
                ...(report.pidFilePath !== undefined
                  ? [`PID lockfile: ${report.pidFilePath}`]
                  : []),
                `Logs: ${report.logOutPath}`,
              ].join("\n"),
            );
          }
          return 0;
        }

        if (subcommand === "status") {
          const report = getDaemonServiceStatus({ slug, homeDir: baseHome }, context.daemonDeps);
          if (parsed.json) {
            emitJson({ ok: true, ...report });
          } else {
            writeOut(`${report.detail} (running=${report.running})`);
          }
          return 0;
        }

        if (subcommand === "stop") {
          const report = stopDaemonService({ slug, homeDir: baseHome }, context.daemonDeps);
          if (parsed.json) {
            emitJson({ ok: true, ...report });
          } else {
            writeOut(report.detail);
          }
          return 0;
        }

        throw new Error(
          `Unknown listen subcommand "${subcommand}". Expected one of: run, install, status, stop.`,
        );
      }

      default: {
        writeErr(`Unknown command "${parsed.command}". Run "openhuddle help" for usage.`);
        return 1;
      }
    }
  } catch (error) {
    if (parsed.json) {
      if (error instanceof OpenHuddleApiError) {
        emitJson({
          ok: false,
          status: error.status,
          error: {
            code: error.code,
            message: error.message,
            ...(error.requestId !== undefined ? { requestId: error.requestId } : {}),
            ...(error.details !== undefined ? { details: error.details } : {}),
          },
        });
      } else {
        emitJson({
          ok: false,
          error: {
            code: "CLI_ERROR",
            message: error instanceof Error ? error.message : String(error),
          },
        });
      }
    } else {
      writeErr(formatOpenHuddleError(error));
    }
    return 1;
  }
}

export {
  buildLinuxSystemdUnit,
  buildMacLaunchdPlist,
  buildWindowsSchtasksArgs,
  collectInheritedDaemonEnvVars,
  getDaemonPidFilePath,
  getDaemonServiceStatus,
  installDaemonService,
  readDaemonPidFile,
  stopDaemonService,
  type DaemonControlReport,
  type DaemonServiceSpec,
  type DaemonSystemDeps,
} from "./daemon-manager.js";

export {
  discoverUserCliBinDirs,
  ensureLoopbackNoProxyValue,
  isPresetCliBinaryAvailable,
  resolveAntigravityManagedProxyEnv,
  resolveShellWrapperEnvForBinary,
} from "./host-env.js";

export {
  formatOpenHuddleError,
  isUnreadConflictDetails,
  OpenHuddleApiError,
  OpenHuddleHttpClient,
} from "./http-client.js";

export {
  runCliMcpStdioServer,
  type CliMcpStdioOptions,
} from "./mcp-stdio.js";

export {
  buildBrokeredWakePrompt,
  buildFastFallbackWakePrompt,
  buildWakeProcessEnv,
  buildWakeShellCommand,
  computeReconnectDelayMs,
  createSseFrameParser,
  DEFAULT_PRESET_TURN_TIMEOUT_MS,
  FAST_FALLBACK_TURN_TIMEOUT_MS,
  isPresetTimeoutError,
  isTransientPresetNetworkError,
  parseWakeAgentPreset,
  parseWakeEventFrame,
  readSseFrames,
  RoomWakeQueue,
  startSseListener,
  type BrokeredWakePromptInput,
  type ParsedSseFrame,
  type PresetPromptExecutor,
  type WakeAgentPreset,
  type WakeEventPayload,
  type WakeExecutionTarget,
} from "./sse-listener.js";

export {
  checkTokenFileCollision,
  getActiveCliProfilePath,
  getDefaultTokenFilePath,
  getRoomLastReadSeq,
  readActiveCliProfile,
  readStoredCredentials,
  rememberDefaultRoomId,
  sanitizeTokenSlug,
  updateRoomLastReadSeq,
  writeActiveCliProfile,
  writeStoredCredentials,
  type ActiveCliProfile,
} from "./token-store.js";

// Node 加载模块时会解析符号链接。入口参数也要使用真实路径，再转成跨平台的文件 URL。
const entryScriptArg = process.argv[1];
if (
  entryScriptArg !== undefined &&
  existsSync(entryScriptArg) &&
  import.meta.url === pathToFileURL(realpathSync(entryScriptArg)).href
) {
  void runCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
