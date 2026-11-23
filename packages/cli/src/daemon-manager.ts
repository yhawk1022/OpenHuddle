/**
 * @module cli/daemon-manager
 * @description 跨平台（macOS `launchd` / Linux `systemd --user` / Windows `schtasks` + 无窗口脱离守护）SSE 唤醒服务安装与生命周期控制器。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 纯配置生成与副作用执行解耦：`buildMacLaunchdPlist`、`buildLinuxSystemdUnit` 与 `buildWindowsSchtasksArgs` 均为 100% 确定性纯函数，支持在任意宿主操作系统上交叉单测三端配置。
 * 2. 同机多实例命名空间隔离：服务名称、日志路径与 PID 锁均以后缀 `<slug>`（由 `--token-file` 派生）严格隔离，同一台机器可同时常驻多个异构 Agent 守护进程互不干扰。
 * 3. Windows 零黑框常驻体验：通过 `schtasks /SC ONLOGON` 保障开机自启，并结合 `{ detached: true, stdio: "ignore", windowsHide: true }` + `child.unref()` + `~/.openhuddle/run/<slug>.pid` 实现无终端窗口的毫秒级后台唤醒。
 */
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, posix, resolve } from "node:path";
import {
  DEEPSEEK_DAEMON_ENV_KEYS,
  discoverUserCliBinDirs,
  ensureLoopbackNoProxyValue,
  resolveAntigravityManagedProxyEnv,
  resolveShellWrapperEnvForBinary,
} from "./host-env.js";
import type { WakeExecutionTarget } from "./sse-listener.js";
import {
  type StoredAgentMetadata,
  deriveDaemonSlug,
  normalizeServerUrl,
  sanitizeTokenSlug,
} from "./token-store.js";

/**
 * 支持安装原生后台守护服务的平台判别字面量。
 */
export type SupportedDaemonPlatform = "darwin" | "linux" | "win32";

/**
 * 构建跨平台守护服务定义所需的完整规格参数。
 */
export interface DaemonServiceSpec {
  readonly slug: string;
  readonly nodeBinaryPath: string;
  readonly cliScriptPath: string;
  readonly serverUrl: string;
  readonly tokenFilePath: string;
  readonly target: WakeExecutionTarget;
  readonly homeDir: string;
  readonly envPath?: string;
  readonly envVars?: Readonly<Record<string, string>>;
}

/**
 * 外部系统命令同步执行结果抽象（便于单测注入替身）。
 */
export interface CommandExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * 脱离父进程拉起后台常驻守护子进程时的日志重定向与环境变量选项。
 */
export interface DetachedSpawnOptions {
  readonly stdoutPath?: string;
  readonly stderrPath?: string;
  readonly env?: Readonly<NodeJS.ProcessEnv>;
}

/**
 * 可注入的操作系统交互依赖，默认绑定真实 Node.js `spawnSync` / `spawn` / `process.kill`。
 */
export interface DaemonSystemDeps {
  readonly platform: NodeJS.Platform;
  readonly execSyncCommand: (command: string, args: readonly string[]) => CommandExecResult;
  readonly spawnDetachedProcess: (
    nodeBinaryPath: string,
    args: readonly string[],
    options?: Readonly<DetachedSpawnOptions>,
  ) => number | undefined;
  readonly isPidAlive: (pid: number) => boolean;
  readonly terminatePid: (pid: number) => boolean;
}

/**
 * `listen install | status | stop` 操作统一返回报告。
 */
export interface DaemonControlReport {
  readonly action: "install" | "status" | "stop";
  readonly platform: SupportedDaemonPlatform;
  readonly mode?: "launchd" | "systemd" | "schtasks" | "detached";
  readonly slug: string;
  readonly running: boolean;
  readonly serviceId: string;
  readonly configFilePath?: string;
  readonly pidFilePath?: string;
  readonly pid?: number;
  readonly logOutPath: string;
  readonly logErrPath: string;
  readonly detail: string;
}

/**
 * 构造 macOS LaunchAgent 唯一服务 Label。
 *
 * @param slug - Agent 隔离标识符
 * @returns `dev.openhuddle.listen.<slug>`
 */
export function getMacLaunchdLabel(slug: string): string {
  return `dev.openhuddle.listen.${sanitizeTokenSlug(slug)}`;
}

/**
 * 计算 macOS LaunchAgent `.plist` 文件落盘路径。
 *
 * @param homeDir - 用户主目录
 * @param slug - Agent 隔离标识符
 * @returns `~/Library/LaunchAgents/dev.openhuddle.listen.<slug>.plist`
 */
export function getMacPlistPath(homeDir: string, slug: string): string {
  return join(homeDir, "Library", "LaunchAgents", `${getMacLaunchdLabel(slug)}.plist`);
}

/**
 * 构造 Linux `systemd --user` 服务单元文件名。
 *
 * @param slug - Agent 隔离标识符
 * @returns `openhuddle-listen-<slug>.service`
 */
export function getLinuxSystemdUnitName(slug: string): string {
  return `openhuddle-listen-${sanitizeTokenSlug(slug)}.service`;
}

/**
 * 计算 Linux `systemd --user` 服务单元文件落盘路径。
 *
 * @param homeDir - 用户主目录
 * @param slug - Agent 隔离标识符
 * @returns `~/.config/systemd/user/openhuddle-listen-<slug>.service`
 */
export function getLinuxSystemdUnitPath(homeDir: string, slug: string): string {
  return join(homeDir, ".config", "systemd", "user", getLinuxSystemdUnitName(slug));
}

/**
 * 构造 Windows 计划任务名称。
 *
 * @param slug - Agent 隔离标识符
 * @returns `OpenHuddle\Listen-<slug>`
 */
export function getWindowsScheduledTaskName(slug: string): string {
  return `OpenHuddle\\Listen-${sanitizeTokenSlug(slug)}`;
}

/**
 * 计算守护进程 PID 锁文件路径（`~/.openhuddle/run/<slug>.pid`）。
 *
 * @param homeDir - 用户主目录
 * @param slug - Agent 隔离标识符
 * @returns PID 锁文件绝对路径
 */
export function getDaemonPidFilePath(homeDir: string, slug: string): string {
  return join(homeDir, ".openhuddle", "run", `${sanitizeTokenSlug(slug)}.pid`);
}

/**
 * 计算守护进程标准输出与错误日志路径（`~/.openhuddle/logs/`）。
 *
 * @param homeDir - 用户主目录
 * @param slug - Agent 隔离标识符
 * @returns 包含 `stdoutPath` 与 `stderrPath` 的路径对
 */
export function getDaemonLogPaths(
  homeDir: string,
  slug: string,
): { readonly stdoutPath: string; readonly stderrPath: string } {
  const safeSlug = sanitizeTokenSlug(slug);
  const logsDir = join(homeDir, ".openhuddle", "logs");
  return {
    stdoutPath: join(logsDir, `listen-${safeSlug}.out.log`),
    stderrPath: join(logsDir, `listen-${safeSlug}.err.log`),
  };
}

/**
 * 生成传给 Node.js 执行常驻 `listen run` 的参数向量（不含 `node` 可执行文件本身）。
 *
 * @param spec - 守护服务规格
 * @returns 严格有序的 CLI 参数列表
 */
export function buildDaemonListenNodeArgs(spec: Readonly<DaemonServiceSpec>): readonly string[] {
  const args: string[] = [
    spec.cliScriptPath,
    "listen",
    "run",
    "--server",
    normalizeServerUrl(spec.serverUrl),
    "--token-file",
    spec.tokenFilePath,
  ];
  if (spec.target.kind === "preset") {
    args.push("--agent", spec.target.preset);
  } else {
    args.push("--run", spec.target.command);
  }
  return args;
}

/**
 * 对 XML 文本节点做实体转义，确保自定义 `--run` 中含 `&`、`<`、`>`、`"` 时生成的 plist 合法。
 *
 * @param value - 原始文本
 * @returns XML 安全字符串
 */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * 合并并去重 POSIX 可执行文件搜索路径（`PATH`），确保通过 `nvm` / `fnm` / `volta` / `Homebrew` 安装的
 * `codex`、`claude`、`agy`、`gemini` 在 `launchd` 与 `systemd --user` 最小化环境变量中也能被定位。
 *
 * @param segments - 候选路径片段（可包含冒号分隔列表）
 * @returns 去重后的冒号分隔 `PATH` 字符串
 */
function mergePosixPathSegments(segments: readonly (string | undefined)[]): string {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const rawSegment of segments) {
    if (rawSegment === undefined) {
      continue;
    }
    for (const part of rawSegment.split(":")) {
      const trimmed = part.trim();
      if (trimmed.length === 0 || trimmed === "." || seen.has(trimmed)) {
        continue;
      }
      seen.add(trimmed);
      ordered.push(trimmed);
    }
  }
  return ordered.join(":");
}

/**
 * 守护进程在 `launchd` / `systemd --user` 最小化环境启动时必须透传的网络代理与模型网关环境变量白名单。
 *
 * @remarks
 * 真实故障复盘：macOS `launchd` 默认不加载用户的 `~/.zshrc`，导致 `agy` / `claude` / `gemini` 在需要本地代理（如 `127.0.0.1:7897`）
 * 或自定义网关（`ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL`）的网络环境下静默报 `400 User location is not supported` 或连接超时。
 */
const PASSTHROUGH_DAEMON_ENV_KEYS: readonly string[] = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "OPENAI_BASE_URL",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_GENAI_USE_VERTEXAI",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
  "LANG",
  "LC_ALL",
];

/**
 * 从当前进程环境变量（及用户 Shell 配置文件、托管代理、CLI 包装函数回退）提取需要写入后台守护服务的代理与网关环境变量。
 *
 * @param homeDir - 用户主目录（当进程未继承代理或隔离目录变量时用于扫描 `~/.zshrc` 与 Antigravity 托管代理）
 * @param sourceEnv - 源环境变量字典
 * @param target - 可选目标唤醒预设（用于严格按预设隔离注入 Antigravity 专属代理或 `claude`/`codex` 包装函数变量）
 * @returns 去重且补齐回环 `NO_PROXY` 后的键值表
 */
export function collectInheritedDaemonEnvVars(
  homeDir: string,
  sourceEnv: Readonly<NodeJS.ProcessEnv> = process.env,
  target?: Readonly<WakeExecutionTarget>,
): Readonly<Record<string, string>> {
  const collected: Record<string, string> = {};
  const passthroughKeys =
    target?.kind === "preset" && target.preset === "deepseek"
      ? [...PASSTHROUGH_DAEMON_ENV_KEYS, ...DEEPSEEK_DAEMON_ENV_KEYS]
      : PASSTHROUGH_DAEMON_ENV_KEYS;

  for (const key of passthroughKeys) {
    const val = sourceEnv[key];
    if (typeof val === "string" && val.trim().length > 0) {
      collected[key] = val.trim();
    }
  }

  // 回退兜底：若用户通过非交互式宿主拉起安装导致进程本身未带代理或网关变量，轻量提取常见 Shell RC 中的白名单静态 export
  if (homeDir.trim().length > 0) {
    const rcCandidates = [".zshrc", ".zprofile", ".bashrc", ".bash_profile"];
    const allowedKeysSet = new Set<string>(passthroughKeys);
    const exportPattern = /^\s*export\s+([A-Za-z_][A-Za-z0-9_]*)=([^\n#]+)/gm;
    for (const rcFile of rcCandidates) {
      const fullPath = join(homeDir, rcFile);
      if (!existsSync(fullPath)) {
        continue;
      }
      try {
        const content = readFileSync(fullPath, "utf8");
        for (const match of content.matchAll(exportPattern)) {
          const key = match[1];
          if (key === undefined || !allowedKeysSet.has(key)) {
            continue;
          }
          let rawVal = (match[2] ?? "").trim();
          if (
            (rawVal.startsWith('"') && rawVal.endsWith('"')) ||
            (rawVal.startsWith("'") && rawVal.endsWith("'"))
          ) {
            rawVal = rawVal.slice(1, -1).trim();
          }
          if (rawVal.length > 0 && !rawVal.includes("$")) {
            collected[key] ??= rawVal;
          }
        }
      } catch {
        // 忽略不可读的 RC 文件
      }
    }

    // 按预设精准补充托管代理与 Shell 包装函数隔离变量（防止 Antigravity 专属代理污染内网直连的 codex/claude）
    if (target?.kind === "preset") {
      switch (target.preset) {
        case "antigravity": {
          const agyProxy = resolveAntigravityManagedProxyEnv(homeDir, true);
          for (const [key, val] of Object.entries(agyProxy)) {
            collected[key] ??= val;
          }
          for (const [key, val] of Object.entries(
            resolveShellWrapperEnvForBinary(homeDir, "agy"),
          )) {
            collected[key] ??= val;
          }
          break;
        }
        case "claude_code": {
          for (const [key, val] of Object.entries(
            resolveShellWrapperEnvForBinary(homeDir, "claude"),
          )) {
            collected[key] ??= val;
          }
          break;
        }
        case "codex": {
          for (const [key, val] of Object.entries(
            resolveShellWrapperEnvForBinary(homeDir, "codex"),
          )) {
            collected[key] ??= val;
          }
          break;
        }
        case "gemini": {
          for (const [key, val] of Object.entries(
            resolveShellWrapperEnvForBinary(homeDir, "gemini"),
          )) {
            collected[key] ??= val;
          }
          break;
        }
        case "deepseek": {
          for (const [key, val] of Object.entries(
            resolveShellWrapperEnvForBinary(homeDir, "dsh"),
          )) {
            collected[key] ??= val;
          }
          break;
        }
      }
    }
  }

  const finalHasProxy =
    collected.HTTP_PROXY !== undefined ||
    collected.HTTPS_PROXY !== undefined ||
    collected.ALL_PROXY !== undefined ||
    collected.http_proxy !== undefined ||
    collected.https_proxy !== undefined ||
    collected.all_proxy !== undefined;

  if (finalHasProxy) {
    // 同时补齐大小写代理变量与回环豁免，兼容 Go (`agy`)、Rust (`codex`) 与 Node (`claude` / `gemini`) 不同网络栈
    const upperHttp = collected.HTTP_PROXY ?? collected.http_proxy;
    const upperHttps = collected.HTTPS_PROXY ?? collected.https_proxy ?? upperHttp;
    if (upperHttp !== undefined) {
      collected.HTTP_PROXY = upperHttp;
      collected.http_proxy = collected.http_proxy ?? upperHttp;
    }
    if (upperHttps !== undefined) {
      collected.HTTPS_PROXY = upperHttps;
      collected.https_proxy = collected.https_proxy ?? upperHttps;
    }
    const mergedNoProxy = ensureLoopbackNoProxyValue(collected.NO_PROXY ?? collected.no_proxy);
    collected.NO_PROXY = mergedNoProxy;
    collected.no_proxy = mergedNoProxy;
  }

  return collected;
}

/**
 * 提取 POSIX 风格 `nodeBinaryPath` 所在的 `bin` 目录（如 `/Users/dev/.nvm/versions/node/v24/bin`）。
 *
 * @param nodeBinaryPath - Node.js 可执行文件路径
 * @returns 若为绝对 POSIX 路径则返回父目录，否则返回 `undefined`
 */
function extractPosixNodeBinDir(nodeBinaryPath: string): string | undefined {
  if (!nodeBinaryPath.startsWith("/")) {
    return undefined;
  }
  const dir = posix.dirname(nodeBinaryPath);
  return dir.length > 0 && dir !== "/" ? dir : undefined;
}

/**
 * 生成 macOS `launchd` LaunchAgent XML Plist 内容（纯函数）。
 *
 * @remarks
 * macOS 守护关键细节：
 * 1. `ProgramArguments` 直接向内核 `execvp` 传递参数数组，不经过 Shell 解析，从根源避免带空格路径或引号逃逸。
 * 2. macOS GUI `launchd` 默认 `PATH` 仅含 `/usr/bin:/bin:/usr/sbin:/sbin`，找不到 Homebrew、`nvm` 或用户目录安装的 `agy` / `codex` / `claude` / `gemini`；
 *    因此必须显式前置 `dirname(nodeBinaryPath)` 并注入合并后的 `EnvironmentVariables.PATH`。
 *
 * @param spec - 守护服务规格
 * @returns 完整的 `.plist` XML 文本
 */
export function buildMacLaunchdPlist(spec: Readonly<DaemonServiceSpec>): string {
  const safeSlug = sanitizeTokenSlug(spec.slug);
  const label = getMacLaunchdLabel(safeSlug);
  const { stdoutPath, stderrPath } = getDaemonLogPaths(spec.homeDir, safeSlug);
  const programArgs = [spec.nodeBinaryPath, ...buildDaemonListenNodeArgs(spec)];
  const mergedPath =
    spec.envPath ??
    mergePosixPathSegments([
      extractPosixNodeBinDir(spec.nodeBinaryPath),
      posix.join(spec.homeDir.replace(/\\/g, "/"), ".local", "bin"),
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
    ]);

  const renderedArgs = programArgs
    .map((arg) => `      <string>${escapeXml(arg)}</string>`)
    .join("\n");

  const extraEnvEntries = Object.entries(spec.envVars ?? {})
    .filter(([key, val]) => key !== "PATH" && val.length > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([key, val]) => [
      `      <key>${escapeXml(key)}</key>`,
      `      <string>${escapeXml(val)}</string>`,
    ]);

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "  <dict>",
    "    <key>Label</key>",
    `    <string>${escapeXml(label)}</string>`,
    "    <key>ProgramArguments</key>",
    "    <array>",
    renderedArgs,
    "    </array>",
    "    <key>RunAtLoad</key>",
    "    <true/>",
    "    <key>KeepAlive</key>",
    "    <true/>",
    "    <key>ThrottleInterval</key>",
    "    <integer>5</integer>",
    "    <key>StandardOutPath</key>",
    `    <string>${escapeXml(stdoutPath)}</string>`,
    "    <key>StandardErrorPath</key>",
    `    <string>${escapeXml(stderrPath)}</string>`,
    "    <key>EnvironmentVariables</key>",
    "    <dict>",
    "      <key>PATH</key>",
    `      <string>${escapeXml(mergedPath)}</string>`,
    ...extraEnvEntries,
    "    </dict>",
    "  </dict>",
    "</plist>",
    "",
  ].join("\n");
}

/**
 * 按 `systemd.service(5)` 语法规则转义单个命令行参数（处理 `%` 占位符展开、反斜杠与双引号）。
 *
 * @param arg - 单个原始命令行参数
 * @returns systemd `ExecStart` 安全字符串
 */
function escapeSystemdExecArg(arg: string): string {
  // systemd 会把单元文件中的单 `%` 视为 specifier（如 %h, %u），必须先翻倍为 `%%`
  const escapedPercent = arg.replace(/%/g, "%%");
  if (/^[A-Za-z0-9_./:@=-]+$/.test(escapedPercent)) {
    return escapedPercent;
  }
  const escapedQuotes = escapedPercent.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escapedQuotes}"`;
}

/**
 * 生成 Linux `systemd --user` 服务单元文件内容（纯函数）。
 *
 * @param spec - 守护服务规格
 * @returns 完整的 `.service` INI 文本
 */
export function buildLinuxSystemdUnit(spec: Readonly<DaemonServiceSpec>): string {
  const safeSlug = sanitizeTokenSlug(spec.slug);
  const { stdoutPath, stderrPath } = getDaemonLogPaths(spec.homeDir, safeSlug);
  const execArgs = [spec.nodeBinaryPath, ...buildDaemonListenNodeArgs(spec)]
    .map(escapeSystemdExecArg)
    .join(" ");
  const mergedPath =
    spec.envPath ??
    mergePosixPathSegments([
      extractPosixNodeBinDir(spec.nodeBinaryPath),
      posix.join(spec.homeDir.replace(/\\/g, "/"), ".local", "bin"),
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
    ]);

  const extraEnvLines = Object.entries(spec.envVars ?? {})
    .filter(([key, val]) => key !== "PATH" && val.length > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, val]) => `Environment=${escapeSystemdExecArg(`${key}=${val}`)}`);

  return [
    "[Unit]",
    `Description=OpenHuddle SSE Wake Listener (${safeSlug})`,
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `Environment=${escapeSystemdExecArg(`PATH=${mergedPath}`)}`,
    ...extraEnvLines,
    `ExecStart=${execArgs}`,
    "Restart=always",
    "RestartSec=3",
    `StandardOutput=append:${stdoutPath.replace(/%/g, "%%")}`,
    `StandardError=append:${stderrPath.replace(/%/g, "%%")}`,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

/**
 * 按 Windows `CommandLineToArgvW` 规范包裹单个参数。
 *
 * @param arg - 原始参数
 * @returns Windows 安全命令行片段
 */
function quoteWindowsArg(arg: string): string {
  if (arg.length > 0 && !/[\s"&|<>^()]/.test(arg)) {
    return arg;
  }
  const escaped = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1");
  return `"${escaped}"`;
}

/**
 * 生成 Windows `schtasks.exe` 注册开机登录自启任务（`/SC ONLOGON`）的参数列表（纯函数）。
 *
 * @remarks
 * Windows 守护关键细节：计划任务触发 `listen spawn-detached` 引导子命令，该命令在毫秒内拉起一个
 * `{ detached: true, stdio: "ignore", windowsHide: true }` 的无窗口常驻进程并更新 `~/.openhuddle/run/<slug>.pid` 后立即退出，
 * 避免 `schtasks` 直接持有控制台句柄而在用户桌面留下无法关闭的黑色命令行框。
 *
 * @param spec - 守护服务规格
 * @returns 可直接传给 `spawnSync("schtasks", args)` 的参数数组
 */
export function buildWindowsSchtasksArgs(spec: Readonly<DaemonServiceSpec>): readonly string[] {
  const safeSlug = sanitizeTokenSlug(spec.slug);
  const taskName = getWindowsScheduledTaskName(safeSlug);

  const bootstrapArgs: string[] = [
    spec.nodeBinaryPath,
    spec.cliScriptPath,
    "listen",
    "spawn-detached",
    "--server",
    normalizeServerUrl(spec.serverUrl),
    "--token-file",
    spec.tokenFilePath,
    "--slug",
    safeSlug,
  ];
  if (spec.target.kind === "preset") {
    bootstrapArgs.push("--agent", spec.target.preset);
  } else {
    bootstrapArgs.push("--run", spec.target.command);
  }

  const taskRunCommand = bootstrapArgs.map(quoteWindowsArg).join(" ");
  return ["/Create", "/SC", "ONLOGON", "/TN", taskName, "/TR", taskRunCommand, "/F"];
}

/**
 * 在保留旧服务名称前确认旧监听器使用当前凭据，否则按独立路径分配名称。
 * @param tokenFilePath - 当前 Agent 的本地凭据路径
 * @param metadata - 对应凭据元数据
 * @param homeDir - 当前宿主用户主目录
 * @param deps - 本机守护系统依赖
 * @param requestedSlug - 用户选定的名称，已被其他凭据使用时回到隔离名称
 * @returns 可用于该 Agent 的守护服务名称
 */
export function resolveCredentialDaemonSlug(
  tokenFilePath: string,
  metadata: Readonly<StoredAgentMetadata> | undefined,
  homeDir: string,
  deps = createDefaultDaemonSystemDeps(),
  requestedSlug?: string,
): string {
  const tokenPath = resolve(tokenFilePath);
  const binding = (slug: string): boolean | undefined => {
    const platform = normalizeDaemonPlatform(deps.platform);
    if (platform === "win32") {
      const { exitCode, stdout } = deps.execSyncCommand("schtasks", [
        "/Query",
        "/TN",
        getWindowsScheduledTaskName(slug),
        "/XML",
      ]);
      if (exitCode === 0 && stdout.includes("<Arguments>")) {
        return stdout.includes(`--token-file ${escapeXml(quoteWindowsArg(tokenPath))} `);
      }
      return undefined;
    }

    const configPath =
      platform === "darwin"
        ? getMacPlistPath(homeDir, slug)
        : getLinuxSystemdUnitPath(homeDir, slug);
    if (existsSync(configPath)) {
      const config = readFileSync(configPath, "utf8");
      return platform === "darwin"
        ? config
            .split("\n")
            .map((line) => line.trim())
            .join("\n")
            .includes(`<string>--token-file</string>\n<string>${escapeXml(tokenPath)}</string>`)
        : (config.split("\n").find((line) => line.startsWith("ExecStart=")) ?? "").includes(
            ` --token-file ${escapeSystemdExecArg(tokenPath)} `,
          );
    }

    const pid = readDaemonPidFile(getDaemonPidFilePath(homeDir, slug));
    if (pid !== undefined && deps.isPidAlive(pid)) {
      const { stdout } = deps.execSyncCommand("ps", ["-p", String(pid), "-o", "command="]);
      return stdout.includes(` --token-file ${tokenPath} `);
    }
    return undefined;
  };

  if (requestedSlug !== undefined) {
    const slug = sanitizeTokenSlug(requestedSlug);
    if (binding(slug) !== false) return slug;
  }
  const legacySlug = metadata?.slug;
  if (
    metadata?.daemonSlug === undefined &&
    legacySlug !== undefined &&
    binding(legacySlug) === true
  ) {
    return legacySlug;
  }
  const preferredSlug = metadata?.daemonSlug ?? deriveDaemonSlug(tokenPath, homeDir);
  const preferredBinding = binding(preferredSlug);
  if (preferredBinding === true) return preferredSlug;
  const fallbackSlug = deriveDaemonSlug(tokenPath, homeDir, true);
  const fallbackBinding = binding(fallbackSlug);
  if (fallbackBinding === true) return fallbackSlug;
  if (preferredBinding === undefined) return preferredSlug;
  if (fallbackBinding === undefined) return fallbackSlug;
  throw new Error(`No available listener name for ${tokenPath}. Specify an unused --slug.`);
}

/**
 * 探测某个进程 PID 当前是否仍然存活。
 *
 * @param pid - 正整数进程 ID
 * @returns 进程存在返回 `true`，已退出返回 `false`
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    // 跨平台内核语义：process.kill(pid, 0) 在 macOS/Linux/Windows 下均只探测进程句柄是否存在而不发送终止信号；
    // 若抛出 EPERM 表示进程存在但无权发信号，抛出 ESRCH 表示进程已消亡。
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (
      typeof err === "object" &&
      err !== null &&
      (err as NodeJS.ErrnoException).code === "EPERM"
    ) {
      return true;
    }
    return false;
  }
}

/**
 * 读取 PID 锁文件中的守护进程 PID。
 *
 * @param pidFilePath - PID 锁文件路径
 * @returns 合法正整数 PID，文件不存在或格式非法时返回 `undefined`
 */
export function readDaemonPidFile(pidFilePath: string): number | undefined {
  if (!existsSync(pidFilePath)) {
    return undefined;
  }
  const raw = readFileSync(pidFilePath, "utf8").trim();
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return undefined;
  }
  return parsed;
}

/**
 * 将后台守护进程 PID 写入锁文件（权限 `0o600`）。
 *
 * @param pidFilePath - PID 锁文件路径
 * @param pid - 子进程 PID
 */
export function writeDaemonPidFile(pidFilePath: string, pid: number): void {
  mkdirSync(dirname(pidFilePath), { recursive: true, mode: 0o700 });
  writeFileSync(pidFilePath, `${pid}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(pidFilePath, 0o600);
  } catch {
    // Windows NTFS 安全忽略
  }
}

/**
 * 幂等清理 PID 锁文件。
 *
 * @param pidFilePath - PID 锁文件路径
 */
export function removeDaemonPidFile(pidFilePath: string): void {
  if (existsSync(pidFilePath)) {
    rmSync(pidFilePath, { force: true });
  }
}

/**
 * 构造默认的真实操作系统调用依赖适配器。
 *
 * @returns 绑定当前宿主环境的 `DaemonSystemDeps`
 */
export function createDefaultDaemonSystemDeps(): DaemonSystemDeps {
  return {
    platform: process.platform,
    execSyncCommand(command: string, args: readonly string[]): CommandExecResult {
      const res = spawnSync(command, [...args], {
        encoding: "utf8",
        windowsHide: true,
      });
      return {
        exitCode: res.status ?? (res.error !== undefined ? 1 : 0),
        stdout: (res.stdout ?? "").trim(),
        stderr: res.error !== undefined ? res.error.message : (res.stderr ?? "").trim(),
      };
    },
    spawnDetachedProcess(
      nodeBinaryPath: string,
      args: readonly string[],
      options?: Readonly<DetachedSpawnOptions>,
    ): number | undefined {
      let outFd: number | undefined;
      let errFd: number | undefined;
      try {
        if (options?.stdoutPath !== undefined && options?.stderrPath !== undefined) {
          mkdirSync(dirname(options.stdoutPath), { recursive: true, mode: 0o700 });
          outFd = openSync(options.stdoutPath, "a", 0o600);
          errFd = openSync(options.stderrPath, "a", 0o600);
        }
        // 零黑框与云端容器脱离核心机制：detached: true 脱离父 Shell 会话组，日志直写磁盘文件避免持有父进程管道句柄，
        // windowsHide: true 通知 Windows CreateProcess 附加 CREATE_NO_WINDOW，最后 child.unref() 允许当前 CLI 秒退。
        const child = spawn(nodeBinaryPath, [...args], {
          detached: true,
          stdio: outFd !== undefined && errFd !== undefined ? ["ignore", outFd, errFd] : "ignore",
          windowsHide: true,
          env: {
            ...process.env,
            ...(options?.env ?? {}),
          },
        });
        child.unref();
        return child.pid;
      } finally {
        if (outFd !== undefined) {
          try {
            closeSync(outFd);
          } catch {
            // 忽略关闭异常
          }
        }
        if (errFd !== undefined) {
          try {
            closeSync(errFd);
          } catch {
            // 忽略关闭异常
          }
        }
      }
    },
    isPidAlive: isProcessAlive,
    terminatePid(pid: number): boolean {
      try {
        process.kill(pid);
        return true;
      } catch {
        return false;
      }
    },
  };
}

/**
 * 将 `NodeJS.Platform` 规范化为三端守护平台标识（其余类 Unix 容器/BSD 环境统一按 `linux` 走脱离后台进程兜底）。
 *
 * @param platform - 运行时平台标识
 * @returns 规范化后的平台名
 */
function normalizeDaemonPlatform(platform: NodeJS.Platform): SupportedDaemonPlatform {
  if (platform === "darwin" || platform === "linux" || platform === "win32") {
    return platform;
  }
  return "linux";
}

/**
 * 静默拉起无窗口脱离后台守护子进程（支持云端容器无 `systemd` 场景与 Windows）并刷新 PID 锁文件。
 *
 * @param spec - 守护服务规格
 * @param deps - 可选注入的系统调用依赖
 * @returns 新拉起的后台子进程 PID 及锁文件路径
 */
export function spawnDetachedDaemonWorker(
  spec: Readonly<DaemonServiceSpec>,
  deps: Readonly<DaemonSystemDeps> = createDefaultDaemonSystemDeps(),
): { readonly pid: number; readonly pidFilePath: string } {
  const safeSlug = sanitizeTokenSlug(spec.slug);
  const pidFilePath = getDaemonPidFilePath(spec.homeDir, safeSlug);
  const { stdoutPath, stderrPath } = getDaemonLogPaths(spec.homeDir, safeSlug);
  mkdirSync(dirname(stdoutPath), { recursive: true, mode: 0o700 });

  const existingPid = readDaemonPidFile(pidFilePath);
  if (existingPid !== undefined && deps.isPidAlive(existingPid)) {
    deps.terminatePid(existingPid);
  }

  const mergedEnv: NodeJS.ProcessEnv = {
    ...(spec.envVars ?? {}),
    ...(spec.envPath !== undefined ? { PATH: spec.envPath } : {}),
  };

  const spawnedPid = deps.spawnDetachedProcess(
    spec.nodeBinaryPath,
    buildDaemonListenNodeArgs(spec),
    {
      stdoutPath,
      stderrPath,
      env: mergedEnv,
    },
  );
  if (spawnedPid === undefined || spawnedPid <= 0) {
    throw new Error("Failed to spawn detached OpenHuddle SSE listener daemon process.");
  }

  writeDaemonPidFile(pidFilePath, spawnedPid);
  return { pid: spawnedPid, pidFilePath };
}

/**
 * 安装并立即启动当前运行环境对应的常驻 SSE 唤醒守护服务。
 *
 * @remarks
 * 云端与异构环境自适应降级（Cloud / Container Resilience）：
 * - 在标准桌面/服务器上优先注册原生系统守护（macOS `launchd`、Linux `systemd --user`、Windows `schtasks`）；
 * - 在 Docker 容器、Kubernetes Pod、云端沙箱（无 PID 1 `systemd` 或无 DBus 用户会话）、无 GUI SSH 会话或组策略受限 Windows 中，
 *   自动无感降级为脱离父进程的后台常驻 Worker（`~/.openhuddle/run/<slug>.pid` + 独立日志文件），彻底消除云端 `systemctl` 报错中断配对的问题。
 *
 * @param spec - 守护服务规格
 * @param deps - 可选注入的系统调用依赖
 * @returns 结构化安装结果报告
 */
export function installDaemonService(
  spec: Readonly<DaemonServiceSpec>,
  deps: Readonly<DaemonSystemDeps> = createDefaultDaemonSystemDeps(),
): DaemonControlReport {
  const platform = normalizeDaemonPlatform(deps.platform);
  const safeSlug = sanitizeTokenSlug(spec.slug);
  const resolvedHomeDir = resolve(spec.homeDir || homedir());
  const hostEnvPath =
    spec.envPath !== undefined
      ? spec.envPath
      : platform !== "win32" && process.platform !== "win32"
        ? mergePosixPathSegments([
            extractPosixNodeBinDir(spec.nodeBinaryPath),
            process.env.PATH,
            ...discoverUserCliBinDirs(resolvedHomeDir).map((dir) => dir.replace(/\\/g, "/")),
            posix.join(resolvedHomeDir.replace(/\\/g, "/"), ".local", "bin"),
            platform === "darwin" ? "/opt/homebrew/bin" : undefined,
            "/usr/local/bin",
            "/usr/bin",
            "/bin",
            "/usr/sbin",
            "/sbin",
          ])
        : undefined;

  const inheritedEnvVars =
    spec.envVars !== undefined
      ? spec.envVars
      : platform !== "win32"
        ? collectInheritedDaemonEnvVars(resolvedHomeDir, process.env, spec.target)
        : undefined;

  const normalizedSpec: DaemonServiceSpec = {
    ...spec,
    slug: safeSlug,
    cliScriptPath: resolve(spec.cliScriptPath),
    tokenFilePath: resolve(spec.tokenFilePath),
    homeDir: resolvedHomeDir,
    ...(hostEnvPath !== undefined ? { envPath: hostEnvPath } : {}),
    ...(inheritedEnvVars !== undefined ? { envVars: inheritedEnvVars } : {}),
  };
  const { stdoutPath, stderrPath } = getDaemonLogPaths(normalizedSpec.homeDir, safeSlug);
  mkdirSync(dirname(stdoutPath), { recursive: true, mode: 0o700 });

  if (platform === "darwin") {
    const label = getMacLaunchdLabel(safeSlug);
    const plistPath = getMacPlistPath(normalizedSpec.homeDir, safeSlug);
    mkdirSync(dirname(plistPath), { recursive: true, mode: 0o755 });
    writeFileSync(plistPath, buildMacLaunchdPlist(normalizedSpec), {
      encoding: "utf8",
      mode: 0o600,
    });
    try {
      chmodSync(plistPath, 0o600);
    } catch {
      // 忽略文件系统权限调整异常
    }

    // 幂等重装：先尝试卸载旧实例（忽略未加载错误），再加载最新 plist 配置
    deps.execSyncCommand("launchctl", ["unload", plistPath]);
    const loadRes = deps.execSyncCommand("launchctl", ["load", "-w", plistPath]);
    if (loadRes.exitCode === 0) {
      removeDaemonPidFile(getDaemonPidFilePath(normalizedSpec.homeDir, safeSlug));
      return {
        action: "install",
        platform,
        mode: "launchd",
        slug: safeSlug,
        running: true,
        serviceId: label,
        configFilePath: plistPath,
        logOutPath: stdoutPath,
        logErrPath: stderrPath,
        detail: `Installed and loaded macOS LaunchAgent ${label}`,
      };
    }

    // 无 GUI Aqua 会话（如远程 SSH / CI 云端构建机）时自动降级为后台脱离进程
    const { pid, pidFilePath } = spawnDetachedDaemonWorker(normalizedSpec, deps);
    return {
      action: "install",
      platform,
      mode: "detached",
      slug: safeSlug,
      running: true,
      serviceId: `detached:${safeSlug}`,
      configFilePath: plistPath,
      pidFilePath,
      pid,
      logOutPath: stdoutPath,
      logErrPath: stderrPath,
      detail: `Started detached background SSE listener "${safeSlug}" (PID ${pid}; launchctl unavailable in headless session)`,
    };
  }

  if (platform === "linux") {
    const unitName = getLinuxSystemdUnitName(safeSlug);
    const unitPath = getLinuxSystemdUnitPath(normalizedSpec.homeDir, safeSlug);
    if (deps.platform === "linux") {
      try {
        mkdirSync(dirname(unitPath), { recursive: true, mode: 0o755 });
        writeFileSync(unitPath, buildLinuxSystemdUnit(normalizedSpec), {
          encoding: "utf8",
          mode: 0o600,
        });
        chmodSync(unitPath, 0o600);
      } catch {
        // 容器只读目录或权限受限时忽略单元文件落盘异常，直接进入下方脱离守护兜底
      }

      const reloadRes = deps.execSyncCommand("systemctl", ["--user", "daemon-reload"]);
      if (reloadRes.exitCode === 0) {
        const enableRes = deps.execSyncCommand("systemctl", [
          "--user",
          "enable",
          "--now",
          unitName,
        ]);
        if (enableRes.exitCode === 0) {
          removeDaemonPidFile(getDaemonPidFilePath(normalizedSpec.homeDir, safeSlug));
          return {
            action: "install",
            platform,
            mode: "systemd",
            slug: safeSlug,
            running: true,
            serviceId: unitName,
            configFilePath: unitPath,
            logOutPath: stdoutPath,
            logErrPath: stderrPath,
            detail: `Installed and started systemd user service ${unitName}`,
          };
        }
      }
    }

    // 云端容器 / Docker / Codespaces / 无 systemd 用户总线环境：自动拉起脱离父进程的常驻后台监听进程
    const { pid, pidFilePath } = spawnDetachedDaemonWorker(normalizedSpec, deps);
    return {
      action: "install",
      platform,
      mode: "detached",
      slug: safeSlug,
      running: true,
      serviceId: `detached:${safeSlug}`,
      pidFilePath,
      pid,
      logOutPath: stdoutPath,
      logErrPath: stderrPath,
      detail: `Started cloud/container detached SSE listener "${safeSlug}" (PID ${pid}; systemd --user unavailable)`,
    };
  }

  // win32 分支：尝试注册 ONLOGON 计划任务（若组策略限制则跳过开机自启但仍确保当前后台守护立即运行）
  const taskName = getWindowsScheduledTaskName(safeSlug);
  const schtasksArgs = buildWindowsSchtasksArgs(normalizedSpec);
  const schtasksRes = deps.execSyncCommand("schtasks", schtasksArgs);
  const { pid, pidFilePath } = spawnDetachedDaemonWorker(normalizedSpec, deps);

  return {
    action: "install",
    platform,
    mode: schtasksRes.exitCode === 0 ? "schtasks" : "detached",
    slug: safeSlug,
    running: true,
    serviceId: schtasksRes.exitCode === 0 ? taskName : `detached:${safeSlug}`,
    pidFilePath,
    pid,
    logOutPath: stdoutPath,
    logErrPath: stderrPath,
    detail:
      schtasksRes.exitCode === 0
        ? `Registered Windows ONLOGON task "${taskName}" and started hidden daemon (PID ${pid})`
        : `Started hidden Windows SSE daemon (PID ${pid}; ONLOGON task skipped due to policy)`,
  };
}

/**
 * 查询指定 `<slug>` 守护服务在当前操作系统或云端容器上的运行状态（同时兼容系统级服务与脱离进程 PID 锁）。
 *
 * @param params - 包含 `slug` 与 `homeDir` 的查询参数
 * @param deps - 可选注入的系统调用依赖
 * @returns 结构化状态报告
 */
export function getDaemonServiceStatus(
  params: { readonly slug: string; readonly homeDir?: string },
  deps: Readonly<DaemonSystemDeps> = createDefaultDaemonSystemDeps(),
): DaemonControlReport {
  const platform = normalizeDaemonPlatform(deps.platform);
  const safeSlug = sanitizeTokenSlug(params.slug);
  const baseHome = resolve(params.homeDir ?? homedir());
  const { stdoutPath, stderrPath } = getDaemonLogPaths(baseHome, safeSlug);
  const pidFilePath = getDaemonPidFilePath(baseHome, safeSlug);
  const recordedPid = readDaemonPidFile(pidFilePath);
  const pidAlive = recordedPid !== undefined && deps.isPidAlive(recordedPid);

  if (platform === "darwin") {
    const label = getMacLaunchdLabel(safeSlug);
    const plistPath = getMacPlistPath(baseHome, safeSlug);
    const listRes = deps.execSyncCommand("launchctl", ["list", label]);
    const launchdRunning = listRes.exitCode === 0;
    if (!launchdRunning && pidAlive && recordedPid !== undefined) {
      return {
        action: "status",
        platform,
        mode: "detached",
        slug: safeSlug,
        running: true,
        serviceId: `detached:${safeSlug}`,
        pidFilePath,
        pid: recordedPid,
        logOutPath: stdoutPath,
        logErrPath: stderrPath,
        detail: `Detached SSE listener "${safeSlug}" is running (PID ${recordedPid}).`,
      };
    }
    return {
      action: "status",
      platform,
      mode: "launchd",
      slug: safeSlug,
      running: launchdRunning,
      serviceId: label,
      configFilePath: plistPath,
      logOutPath: stdoutPath,
      logErrPath: stderrPath,
      detail: launchdRunning
        ? `macOS LaunchAgent ${label} is loaded.`
        : existsSync(plistPath)
          ? `Plist exists at ${plistPath}, but LaunchAgent is not currently loaded.`
          : `LaunchAgent ${label} is not installed.`,
    };
  }

  if (platform === "linux") {
    const unitName = getLinuxSystemdUnitName(safeSlug);
    const unitPath = getLinuxSystemdUnitPath(baseHome, safeSlug);
    const activeRes =
      deps.platform === "linux"
        ? deps.execSyncCommand("systemctl", ["--user", "is-active", unitName])
        : { exitCode: 1, stdout: "unavailable", stderr: "" };
    const systemdRunning = activeRes.exitCode === 0 && activeRes.stdout === "active";
    if (!systemdRunning && pidAlive && recordedPid !== undefined) {
      return {
        action: "status",
        platform,
        mode: "detached",
        slug: safeSlug,
        running: true,
        serviceId: `detached:${safeSlug}`,
        pidFilePath,
        pid: recordedPid,
        logOutPath: stdoutPath,
        logErrPath: stderrPath,
        detail: `Detached cloud/container SSE listener "${safeSlug}" is running (PID ${recordedPid}).`,
      };
    }
    return {
      action: "status",
      platform,
      mode: "systemd",
      slug: safeSlug,
      running: systemdRunning,
      serviceId: unitName,
      configFilePath: unitPath,
      logOutPath: stdoutPath,
      logErrPath: stderrPath,
      detail: systemdRunning
        ? `systemd user unit ${unitName} is active.`
        : `systemd user unit ${unitName} state: ${activeRes.stdout || "inactive"}`,
    };
  }

  const taskName = getWindowsScheduledTaskName(safeSlug);
  const taskQuery = deps.execSyncCommand("schtasks", ["/Query", "/TN", taskName]);

  return {
    action: "status",
    platform,
    mode: taskQuery.exitCode === 0 ? "schtasks" : "detached",
    slug: safeSlug,
    running: pidAlive,
    serviceId: taskName,
    pidFilePath,
    ...(recordedPid !== undefined ? { pid: recordedPid } : {}),
    logOutPath: stdoutPath,
    logErrPath: stderrPath,
    detail: pidAlive
      ? `Windows hidden daemon running (PID ${recordedPid}); task "${taskName}" registered=${taskQuery.exitCode === 0}.`
      : `Windows daemon not running; task "${taskName}" registered=${taskQuery.exitCode === 0}.`,
  };
}

/**
 * 停止并卸载指定 `<slug>` 的常驻后台守护服务，同时终止并清理脱离进程 PID 锁文件。
 *
 * @param params - 包含 `slug` 与 `homeDir` 的停止参数
 * @param deps - 可选注入的系统调用依赖
 * @returns 结构化停止报告
 */
export function stopDaemonService(
  params: { readonly slug: string; readonly homeDir?: string },
  deps: Readonly<DaemonSystemDeps> = createDefaultDaemonSystemDeps(),
): DaemonControlReport {
  const platform = normalizeDaemonPlatform(deps.platform);
  const safeSlug = sanitizeTokenSlug(params.slug);
  const baseHome = resolve(params.homeDir ?? homedir());
  const { stdoutPath, stderrPath } = getDaemonLogPaths(baseHome, safeSlug);
  const pidFilePath = getDaemonPidFilePath(baseHome, safeSlug);
  const existingPid = readDaemonPidFile(pidFilePath);
  if (existingPid !== undefined && deps.isPidAlive(existingPid)) {
    deps.terminatePid(existingPid);
  }
  removeDaemonPidFile(pidFilePath);

  if (platform === "darwin") {
    const label = getMacLaunchdLabel(safeSlug);
    const plistPath = getMacPlistPath(baseHome, safeSlug);
    if (existsSync(plistPath)) {
      deps.execSyncCommand("launchctl", ["unload", "-w", plistPath]);
      rmSync(plistPath, { force: true });
    }
    return {
      action: "stop",
      platform,
      slug: safeSlug,
      running: false,
      serviceId: label,
      configFilePath: plistPath,
      logOutPath: stdoutPath,
      logErrPath: stderrPath,
      detail: `Stopped and removed macOS LaunchAgent ${label}.`,
    };
  }

  if (platform === "linux") {
    const unitName = getLinuxSystemdUnitName(safeSlug);
    const unitPath = getLinuxSystemdUnitPath(baseHome, safeSlug);
    if (deps.platform === "linux") {
      deps.execSyncCommand("systemctl", ["--user", "disable", "--now", unitName]);
      if (existsSync(unitPath)) {
        rmSync(unitPath, { force: true });
      }
      deps.execSyncCommand("systemctl", ["--user", "daemon-reload"]);
    }
    return {
      action: "stop",
      platform,
      slug: safeSlug,
      running: false,
      serviceId: unitName,
      configFilePath: unitPath,
      logOutPath: stdoutPath,
      logErrPath: stderrPath,
      detail: `Stopped and removed listener service ${unitName}.`,
    };
  }

  const taskName = getWindowsScheduledTaskName(safeSlug);
  deps.execSyncCommand("schtasks", ["/Delete", "/TN", taskName, "/F"]);

  return {
    action: "stop",
    platform,
    slug: safeSlug,
    running: false,
    serviceId: taskName,
    pidFilePath,
    logOutPath: stdoutPath,
    logErrPath: stderrPath,
    detail: `Stopped Windows daemon and deleted scheduled task "${taskName}".`,
  };
}
