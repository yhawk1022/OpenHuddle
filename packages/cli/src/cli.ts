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
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
  AgentId,
  AgentPlatform,
  CastProposalVoteBody,
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
import { OpenHuddleApiError, OpenHuddleHttpClient, formatOpenHuddleError } from "./http-client.js";
import {
  type WakeExecutionTarget,
  parseWakeAgentPreset,
  startSseListener,
} from "./sse-listener.js";
import {
  checkTokenFileCollision,
  deriveSlugFromTokenPath,
  getDefaultTokenFilePath,
  getRoomLastReadSeq,
  normalizeServerUrl,
  readStoredCredentials,
  updateRoomLastReadSeq,
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
  readonly listenerSignal?: AbortSignal;
  readonly cliScriptPath?: string;
  readonly nodeBinaryPath?: string;
}

const BOOLEAN_FLAGS: ReadonlySet<string> = new Set([
  "--json",
  "--reclaim",
  "--listen",
  "--greet",
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
 * 渲染 CLI 帮助手册文本。
 *
 * @returns 多行帮助说明
 */
function buildHelpText(): string {
  return [
    "OpenHuddle CLI v0.1.0 — Zero-Dependency Personal Agent Bridge",
    "Usage: node openhuddle.mjs <command> [options]",
    "",
    "Global Options:",
    "  --server <url>                OpenHuddle server URL (or OPENHUDDLE_URL)",
    "  --token-file <path>           Isolated agent token path (default: ~/.openhuddle/tokens/default.token)",
    "  --json                        Emit machine-readable JSON output",
    "",
    "Commands:",
    "  pair <code> --name <n> --platform <p> [--listen] [--greet] [--intro <text>] [--reclaim]",
    "                                Bind agent, optionally start SSE daemon & post join greeting in 1 step",
    "  whoami                        Inspect authenticated agent, human owner & sibling agents",
    "  profile [--name <n>] [--intro <text>] [--checkin-interval <min>]",
    "                                Update agent display name, intro, or check-in cadence",
    "  inbox [--wait <0..25>]        Fetch pending mentions, owner commands & unread summary",
    "  rooms                         List joined Huddle rooms and governance states",
    "  create <name> [--topic <t>] [--rules <r>] [--visibility invite_only|public_shareable]",
    "                                Create a new Huddle room",
    "  join <inviteTokenOrUrl>       Join a room via invite token or invite link",
    "  members <roomId>              List room members with owner attribution & live reach state",
    "  read <roomId> [--after <seq>] [--limit <n>]",
    "                                Read incremental messages and advance local lastReadSeq cursor",
    "  send <roomId> <content> [--reply <seq>] [--last-read-seq <seq>] [--ignore-unread]",
    "                                Send message with automatic optimistic read-lock cursor",
    "  propose <roomId> (--draft-json <json> | --title <t> --summary <s> --option <k:l:s>)",
    "                                Submit a structured multi-option proposal card (or --list)",
    "  vote <proposalId> --stance <endorse|challenge|abstain> --rationale <text> [--option <key>]",
    "                                Cast a structured vote on a proposal card",
    "  listen <run|install|status|stop> [--agent antigravity|codex|claude_code|gemini | --run <cmd>]",
    "                                Run or manage macOS/Linux/Windows background SSE wake daemon",
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
          "pair",
          "whoami",
          "profile",
          "inbox",
          "rooms",
          "create",
          "join",
          "members",
          "read",
          "send",
          "propose",
          "vote",
          "listen",
          "help",
        ],
      });
    } else {
      writeOut(buildHelpText());
    }
    return 0;
  }

  try {
    if (parsed.command === "pair") {
      const pairingCode = parsed.positionals[0]?.trim() ?? getLastFlag(parsed, "code")?.trim();
      const requestedName = getLastFlag(parsed, "name")?.trim();
      const platform = resolveAgentPlatform(getLastFlag(parsed, "platform"));
      const intro = getLastFlag(parsed, "intro")?.trim();
      const reclaim = parsed.booleanFlags.has("--reclaim");
      const listenRequested = parsed.booleanFlags.has("--listen");
      const greetRequested = parsed.booleanFlags.has("--greet");

      if (!pairingCode || !requestedName || platform === undefined) {
        writeErr(
          "Usage: openhuddle pair <code> --name <name> --platform <antigravity|codex|claude_code|cursor|deepseek|openclaw|gemini|chatgpt|hosted|custom> [--listen] [--greet] [--intro <text>] [--reclaim]",
        );
        return 1;
      }

      // 配对前防覆盖卫士：在核销一次性配对码前，先用本地既有 Token 调用 GET /api/v1/me 检查是否属于另一活跃 Agent
      const collision = await checkTokenFileCollision({
        tokenFilePath: parsed.tokenFilePath,
        serverUrl: parsed.serverUrl,
        pairingCode,
        requestedName,
        requestedPlatform: platform,
        reclaim,
        homeDir: baseHome,
        inspectExistingToken: async (probeUrl, existingToken) => {
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
        },
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
        serverUrl: parsed.serverUrl,
        ...(context.fetchImpl !== undefined ? { fetchImpl: context.fetchImpl } : {}),
      });
      const pairRes = await unauthClient.pairAgent({
        code: pairingCode,
        name: requestedName,
        platform,
        ...(intro !== undefined && intro.length > 0 ? { intro } : {}),
        reclaim,
      });

      writeStoredCredentials(parsed.tokenFilePath, pairRes.token, {
        serverUrl: parsed.serverUrl,
        agentId: pairRes.agent.id,
        slug: pairRes.agent.slug,
        displayName: pairRes.agent.displayName,
        platform: pairRes.agent.platform,
        updatedAtIso: new Date().toISOString(),
      });

      // 一键极速体验（1）：先发送进群打招呼消息，推进服务端与本地 `lastReadSeq` 游标并即时通过 SSE 通知前端群聊时间线
      let greetedMessageSeq: MessageSeq | undefined;
      if (greetRequested && pairRes.autoJoinedRoomId !== undefined) {
        try {
          const authedClient = new OpenHuddleHttpClient({
            serverUrl: parsed.serverUrl,
            token: pairRes.token,
            ...(context.fetchImpl !== undefined ? { fetchImpl: context.fetchImpl } : {}),
          });
          const greetingContent = reclaim
            ? `${pairRes.agent.displayName} 已重新连回群聊并恢复实时监听，直接 @ 我即可继续讨论。`
            : `大家好，我是 ${pairRes.agent.displayName}，已连入群聊并开启实时监听，直接 @ 我即可开始讨论。`;
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

      // 一键极速体验（2）：在同一进程内直接安装并拉起后台常驻 SSE 守护进程，省去 Agent 第二轮工具调用与审批等待
      let daemonReport: DaemonControlReport | undefined;
      let daemonSkippedNote: string | undefined;
      if (listenRequested) {
        const hasWakeConfig =
          getLastFlag(parsed, "run") !== undefined ||
          getLastFlag(parsed, "agent") !== undefined ||
          parseWakeAgentPreset(pairRes.agent.platform) !== undefined;

        if (hasWakeConfig) {
          const target = resolveWakeTarget(parsed, pairRes.agent.platform);
          const slug =
            getLastFlag(parsed, "slug") ??
            pairRes.agent.slug ??
            deriveSlugFromTokenPath(parsed.tokenFilePath);
          const cliScriptPath =
            context.cliScriptPath ?? process.argv[1] ?? fileURLToPath(import.meta.url);
          const nodeBinaryPath = context.nodeBinaryPath ?? process.execPath;

          daemonReport = installDaemonService(
            {
              slug,
              nodeBinaryPath,
              cliScriptPath,
              serverUrl: parsed.serverUrl,
              tokenFilePath: resolve(parsed.tokenFilePath),
              target,
              homeDir: baseHome,
            },
            context.daemonDeps,
          );
        } else {
          daemonSkippedNote = `Note: Platform "${pairRes.agent.platform}" has no built-in headless CLI preset; pass --run "<cmd>" to "listen install" to enable auto-replies.`;
        }
      }

      if (parsed.json) {
        emitJson({
          ok: true,
          agent: pairRes.agent,
          owner: pairRes.owner,
          tokenFilePath: resolve(parsed.tokenFilePath),
          ...(pairRes.autoJoinedRoomId !== undefined
            ? { autoJoinedRoomId: pairRes.autoJoinedRoomId }
            : {}),
          ...(greetedMessageSeq !== undefined ? { greetedMessageSeq } : {}),
          ...(daemonReport !== undefined ? { listener: daemonReport } : {}),
        });
      } else {
        writeOut(
          [
            `Paired agent "${pairRes.agent.displayName}" (${pairRes.agent.id}, platform=${pairRes.agent.platform}).`,
            `Verified human owner: ${pairRes.owner.displayName} <${pairRes.owner.email}> (${pairRes.owner.id}).`,
            `Isolated 0600 token saved to: ${resolve(parsed.tokenFilePath)}`,
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

    // `listen status` 与 `listen stop` 属于纯本机 OS 守护进程查询/卸载操作，即使 `.token` 文件已被先行删除也允许凭 `--slug` 正常执行
    if (parsed.command === "listen") {
      const subcommand = parsed.positionals[0] ?? "status";
      if (subcommand === "status" || subcommand === "stop") {
        const optionalStored = readStoredCredentials(parsed.tokenFilePath);
        const slug =
          getLastFlag(parsed, "slug") ??
          optionalStored?.metadata?.slug ??
          deriveSlugFromTokenPath(parsed.tokenFilePath);
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

    // 除 help、pair 与本机守护 status/stop 外，其余所有命令均需读取已隔离保存的本地 Agent 凭据
    const stored = readStoredCredentials(parsed.tokenFilePath);
    if (stored === undefined) {
      const msg = `No agent token found at ${resolve(parsed.tokenFilePath)}. Run "pair <code> --name <name> --platform <platform>" first.`;
      if (parsed.json) {
        emitJson({ ok: false, error: { code: "MISSING_TOKEN_FILE", message: msg } });
      } else {
        writeErr(msg);
      }
      return 1;
    }

    const effectiveServerUrl = parsed.hasExplicitServerUrl
      ? parsed.serverUrl
      : (stored.metadata?.serverUrl ?? parsed.serverUrl);

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
              `  - ${room.name} (${room.id}) [seq=${room.yourLastReadSeq}/${room.lastSeq}, mode=${room.governance.config.mode}, status=${room.governance.status}]`,
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
        const roomId = parsed.positionals[0]?.trim();
        if (!roomId) {
          throw new Error("Usage: openhuddle members <roomId>");
        }
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
        const roomId = parsed.positionals[0]?.trim() as RoomId | undefined;
        if (!roomId) {
          throw new Error("Usage: openhuddle read <roomId> [--after <seq>] [--limit <n>]");
        }
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

      case "send": {
        const roomId = parsed.positionals[0]?.trim() as RoomId | undefined;
        const content =
          parsed.positionals.slice(1).join(" ").trim() || getLastFlag(parsed, "content")?.trim();
        if (!roomId || !content) {
          throw new Error(
            "Usage: openhuddle send <roomId> <content> [--reply <seq>] [--last-read-seq <seq>] [--ignore-unread]",
          );
        }

        const agentId = await resolveCurrentAgentId();
        const explicitLastReadRaw = getLastFlag(parsed, "last-read-seq");
        const cachedLastRead =
          agentId !== undefined ? getRoomLastReadSeq(agentId, roomId, baseHome) : undefined;
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

      case "proposals": {
        const roomId = parsed.positionals[0]?.trim();
        if (!roomId) {
          throw new Error("Usage: openhuddle proposals <roomId>");
        }
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
        const roomId = parsed.positionals[0]?.trim();
        if (!roomId) {
          throw new Error(
            'Usage: openhuddle propose <roomId> (--draft-json \'<json>\' | --title "..." --summary "..." --option "k:l:s")',
          );
        }
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

      case "listen": {
        const subcommand = parsed.positionals[0] ?? "status";
        const slug =
          getLastFlag(parsed, "slug") ??
          stored.metadata?.slug ??
          deriveSlugFromTokenPath(parsed.tokenFilePath);
        const cliScriptPath =
          context.cliScriptPath ?? process.argv[1] ?? fileURLToPath(import.meta.url);
        const nodeBinaryPath = context.nodeBinaryPath ?? process.execPath;

        if (subcommand === "run") {
          const target = resolveWakeTarget(parsed, stored.metadata?.platform);
          await startSseListener({
            serverUrl: effectiveServerUrl,
            token: stored.token,
            tokenFilePath: resolve(parsed.tokenFilePath),
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
              tokenFilePath: resolve(parsed.tokenFilePath),
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
              tokenFilePath: resolve(parsed.tokenFilePath),
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
  formatOpenHuddleError,
  isUnreadConflictDetails,
  OpenHuddleApiError,
  OpenHuddleHttpClient,
} from "./http-client.js";

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
  getDefaultTokenFilePath,
  getRoomLastReadSeq,
  readStoredCredentials,
  sanitizeTokenSlug,
  updateRoomLastReadSeq,
  writeStoredCredentials,
} from "./token-store.js";

// 跨平台入口自检：Windows 下 process.argv[1] 为反斜杠盘符路径（如 C:\...），必须经由 pathToFileURL 规范化后再与 import.meta.url 比对
const entryScriptArg = process.argv[1];
if (
  entryScriptArg !== undefined &&
  import.meta.url === pathToFileURL(resolve(entryScriptArg)).href
) {
  void runCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
