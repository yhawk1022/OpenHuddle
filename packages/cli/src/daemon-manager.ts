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
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, posix, resolve } from "node:path";
import type { WakeExecutionTarget } from "./sse-listener.js";
import { normalizeServerUrl, sanitizeTokenSlug } from "./token-store.js";

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
 * 可注入的操作系统交互依赖，默认绑定真实 Node.js `spawnSync` / `spawn` / `process.kill`。
 */
export interface DaemonSystemDeps {
  readonly platform: NodeJS.Platform;
  readonly execSyncCommand: (command: string, args: readonly string[]) => CommandExecResult;
  readonly spawnDetachedProcess: (
    nodeBinaryPath: string,
    args: readonly string[],
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
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
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
 * 确保 `NO_PROXY` 列表中始终包含本地回环地址，防止代理软件劫持本地 `localhost:3000` SSE 与 REST 请求。
 *
 * @param existing - 原始 `NO_PROXY` 字符串
 * @returns 合并回环豁免后的逗号分隔字符串
 */
function ensureLoopbackNoProxy(existing: string | undefined): string {
  const required = ["localhost", "127.0.0.1", "::1"];
  const items = (existing ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const lowerSet = new Set(items.map((item) => item.toLowerCase()));
  for (const host of required) {
    if (!lowerSet.has(host)) {
      items.push(host);
      lowerSet.add(host);
    }
  }
  return items.join(",");
}

/**
 * 从当前进程环境变量（及用户 Shell 配置文件回退）提取需要写入后台守护服务的代理与网关环境变量。
 *
 * @param homeDir - 用户主目录（当进程未继承代理变量时用于轻量扫描 `~/.zshrc` 等静态 `export`）
 * @param sourceEnv - 源环境变量字典
 * @returns 去重且补齐回环 `NO_PROXY` 后的键值表
 */
export function collectInheritedDaemonEnvVars(
  homeDir: string,
  sourceEnv: Readonly<NodeJS.ProcessEnv> = process.env,
): Readonly<Record<string, string>> {
  const collected: Record<string, string> = {};

  for (const key of PASSTHROUGH_DAEMON_ENV_KEYS) {
    const val = sourceEnv[key];
    if (typeof val === "string" && val.trim().length > 0) {
      collected[key] = val.trim();
    }
  }

  // 回退兜底：若用户通过非交互式宿主拉起安装导致进程本身未带代理或网关变量，轻量提取常见 Shell RC 中的白名单静态 export
  if (homeDir.trim().length > 0) {
    const rcCandidates = [".zshrc", ".zprofile", ".bashrc", ".bash_profile"];
    const allowedKeysSet = new Set<string>(PASSTHROUGH_DAEMON_ENV_KEYS);
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
    const mergedNoProxy = ensureLoopbackNoProxy(collected.NO_PROXY ?? collected.no_proxy);
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
    spawnDetachedProcess(nodeBinaryPath: string, args: readonly string[]): number | undefined {
      // Windows 零黑框核心机制：detached: true 脱离父进程控制台组，stdio: "ignore" 断开管道引用，
      // windowsHide: true 通知 CreateProcess 附加 CREATE_NO_WINDOW 标志，最后 child.unref() 允许当前 CLI 秒退。
      const child = spawn(nodeBinaryPath, [...args], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env: { ...process.env },
      });
      child.unref();
      return child.pid;
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
 * 将 `NodeJS.Platform` 收窄为受支持的三端守护平台。
 *
 * @param platform - 运行时平台标识
 * @returns 收窄后的平台名
 * @throws {Error} 遇到极罕见非桌面/服务器平台时抛出明确提示
 */
function assertSupportedPlatform(platform: NodeJS.Platform): SupportedDaemonPlatform {
  if (platform === "darwin" || platform === "linux" || platform === "win32") {
    return platform;
  }
  throw new Error(
    `Unsupported OS platform "${platform}" for background service installation. Run "listen run" in foreground instead.`,
  );
}

/**
 * 在 Windows（或按需）静默拉起无窗口后台守护子进程并刷新 PID 锁文件。
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
  const { stdoutPath } = getDaemonLogPaths(spec.homeDir, safeSlug);
  mkdirSync(dirname(stdoutPath), { recursive: true, mode: 0o700 });

  const existingPid = readDaemonPidFile(pidFilePath);
  if (existingPid !== undefined && deps.isPidAlive(existingPid)) {
    deps.terminatePid(existingPid);
  }

  const spawnedPid = deps.spawnDetachedProcess(
    spec.nodeBinaryPath,
    buildDaemonListenNodeArgs(spec),
  );
  if (spawnedPid === undefined || spawnedPid <= 0) {
    throw new Error("Failed to spawn detached OpenHuddle SSE listener daemon process.");
  }

  writeDaemonPidFile(pidFilePath, spawnedPid);
  return { pid: spawnedPid, pidFilePath };
}

/**
 * 安装并立即启动当前操作系统对应的常驻 SSE 唤醒守护服务。
 *
 * @param spec - 守护服务规格
 * @param deps - 可选注入的系统调用依赖
 * @returns 结构化安装结果报告
 */
export function installDaemonService(
  spec: Readonly<DaemonServiceSpec>,
  deps: Readonly<DaemonSystemDeps> = createDefaultDaemonSystemDeps(),
): DaemonControlReport {
  const platform = assertSupportedPlatform(deps.platform);
  const safeSlug = sanitizeTokenSlug(spec.slug);
  const hostEnvPath =
    spec.envPath !== undefined
      ? spec.envPath
      : platform !== "win32" && process.platform !== "win32"
        ? mergePosixPathSegments([
            extractPosixNodeBinDir(spec.nodeBinaryPath),
            process.env.PATH,
            posix.join(resolve(spec.homeDir || homedir()).replace(/\\/g, "/"), ".local", "bin"),
            platform === "darwin" ? "/opt/homebrew/bin" : undefined,
            "/usr/local/bin",
            "/usr/bin",
            "/bin",
            "/usr/sbin",
            "/sbin",
          ])
        : undefined;

  const resolvedHomeDir = resolve(spec.homeDir || homedir());
  const inheritedEnvVars =
    spec.envVars !== undefined
      ? spec.envVars
      : platform !== "win32"
        ? collectInheritedDaemonEnvVars(resolvedHomeDir, process.env)
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
    if (loadRes.exitCode !== 0) {
      throw new Error(`launchctl load failed: ${loadRes.stderr || loadRes.stdout}`);
    }

    return {
      action: "install",
      platform,
      slug: safeSlug,
      running: true,
      serviceId: label,
      configFilePath: plistPath,
      logOutPath: stdoutPath,
      logErrPath: stderrPath,
      detail: `Installed and loaded macOS LaunchAgent ${label}`,
    };
  }

  if (platform === "linux") {
    const unitName = getLinuxSystemdUnitName(safeSlug);
    const unitPath = getLinuxSystemdUnitPath(normalizedSpec.homeDir, safeSlug);
    mkdirSync(dirname(unitPath), { recursive: true, mode: 0o755 });
    writeFileSync(unitPath, buildLinuxSystemdUnit(normalizedSpec), {
      encoding: "utf8",
      mode: 0o600,
    });
    try {
      chmodSync(unitPath, 0o600);
    } catch {
      // 忽略文件系统权限调整异常
    }

    const reloadRes = deps.execSyncCommand("systemctl", ["--user", "daemon-reload"]);
    if (reloadRes.exitCode !== 0) {
      throw new Error(`systemctl --user daemon-reload failed: ${reloadRes.stderr}`);
    }
    const enableRes = deps.execSyncCommand("systemctl", ["--user", "enable", "--now", unitName]);
    if (enableRes.exitCode !== 0) {
      throw new Error(`systemctl --user enable --now failed: ${enableRes.stderr}`);
    }

    return {
      action: "install",
      platform,
      slug: safeSlug,
      running: true,
      serviceId: unitName,
      configFilePath: unitPath,
      logOutPath: stdoutPath,
      logErrPath: stderrPath,
      detail: `Installed and started systemd user service ${unitName}`,
    };
  }

  // win32 分支：注册 ONLOGON 计划任务 + 立即拉起无黑框后台守护进程 + 写入 PID 锁
  const taskName = getWindowsScheduledTaskName(safeSlug);
  const schtasksArgs = buildWindowsSchtasksArgs(normalizedSpec);
  const schtasksRes = deps.execSyncCommand("schtasks", schtasksArgs);
  if (schtasksRes.exitCode !== 0) {
    throw new Error(`schtasks /Create failed: ${schtasksRes.stderr || schtasksRes.stdout}`);
  }

  const { pid, pidFilePath } = spawnDetachedDaemonWorker(normalizedSpec, deps);
  return {
    action: "install",
    platform,
    slug: safeSlug,
    running: true,
    serviceId: taskName,
    pidFilePath,
    pid,
    logOutPath: stdoutPath,
    logErrPath: stderrPath,
    detail: `Registered Windows ONLOGON task "${taskName}" and started hidden daemon (PID ${pid})`,
  };
}

/**
 * 查询指定 `<slug>` 守护服务在当前操作系统上的运行与注册状态。
 *
 * @param params - 包含 `slug` 与 `homeDir` 的查询参数
 * @param deps - 可选注入的系统调用依赖
 * @returns 结构化状态报告
 */
export function getDaemonServiceStatus(
  params: { readonly slug: string; readonly homeDir?: string },
  deps: Readonly<DaemonSystemDeps> = createDefaultDaemonSystemDeps(),
): DaemonControlReport {
  const platform = assertSupportedPlatform(deps.platform);
  const safeSlug = sanitizeTokenSlug(params.slug);
  const baseHome = resolve(params.homeDir ?? homedir());
  const { stdoutPath, stderrPath } = getDaemonLogPaths(baseHome, safeSlug);

  if (platform === "darwin") {
    const label = getMacLaunchdLabel(safeSlug);
    const plistPath = getMacPlistPath(baseHome, safeSlug);
    const listRes = deps.execSyncCommand("launchctl", ["list", label]);
    const running = listRes.exitCode === 0;
    return {
      action: "status",
      platform,
      slug: safeSlug,
      running,
      serviceId: label,
      configFilePath: plistPath,
      logOutPath: stdoutPath,
      logErrPath: stderrPath,
      detail: running
        ? `macOS LaunchAgent ${label} is loaded.`
        : existsSync(plistPath)
          ? `Plist exists at ${plistPath}, but LaunchAgent is not currently loaded.`
          : `LaunchAgent ${label} is not installed.`,
    };
  }

  if (platform === "linux") {
    const unitName = getLinuxSystemdUnitName(safeSlug);
    const unitPath = getLinuxSystemdUnitPath(baseHome, safeSlug);
    const activeRes = deps.execSyncCommand("systemctl", ["--user", "is-active", unitName]);
    const running = activeRes.exitCode === 0 && activeRes.stdout === "active";
    return {
      action: "status",
      platform,
      slug: safeSlug,
      running,
      serviceId: unitName,
      configFilePath: unitPath,
      logOutPath: stdoutPath,
      logErrPath: stderrPath,
      detail: running
        ? `systemd user unit ${unitName} is active.`
        : `systemd user unit ${unitName} state: ${activeRes.stdout || "inactive"}`,
    };
  }

  const taskName = getWindowsScheduledTaskName(safeSlug);
  const pidFilePath = getDaemonPidFilePath(baseHome, safeSlug);
  const recordedPid = readDaemonPidFile(pidFilePath);
  const pidAlive = recordedPid !== undefined && deps.isPidAlive(recordedPid);
  const taskQuery = deps.execSyncCommand("schtasks", ["/Query", "/TN", taskName]);

  return {
    action: "status",
    platform,
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
 * 停止并卸载指定 `<slug>` 的常驻后台守护服务，同时清理孤儿锁文件。
 *
 * @param params - 包含 `slug` 与 `homeDir` 的停止参数
 * @param deps - 可选注入的系统调用依赖
 * @returns 结构化停止报告
 */
export function stopDaemonService(
  params: { readonly slug: string; readonly homeDir?: string },
  deps: Readonly<DaemonSystemDeps> = createDefaultDaemonSystemDeps(),
): DaemonControlReport {
  const platform = assertSupportedPlatform(deps.platform);
  const safeSlug = sanitizeTokenSlug(params.slug);
  const baseHome = resolve(params.homeDir ?? homedir());
  const { stdoutPath, stderrPath } = getDaemonLogPaths(baseHome, safeSlug);

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
    deps.execSyncCommand("systemctl", ["--user", "disable", "--now", unitName]);
    if (existsSync(unitPath)) {
      rmSync(unitPath, { force: true });
    }
    deps.execSyncCommand("systemctl", ["--user", "daemon-reload"]);
    return {
      action: "stop",
      platform,
      slug: safeSlug,
      running: false,
      serviceId: unitName,
      configFilePath: unitPath,
      logOutPath: stdoutPath,
      logErrPath: stderrPath,
      detail: `Stopped and removed systemd user service ${unitName}.`,
    };
  }

  const taskName = getWindowsScheduledTaskName(safeSlug);
  const pidFilePath = getDaemonPidFilePath(baseHome, safeSlug);
  const existingPid = readDaemonPidFile(pidFilePath);
  if (existingPid !== undefined && deps.isPidAlive(existingPid)) {
    deps.terminatePid(existingPid);
  }
  removeDaemonPidFile(pidFilePath);
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
