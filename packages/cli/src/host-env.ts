/**
 * @module cli/host-env
 * @description 本机预设编程 Agent CLI 跨环境路径探测、托管代理提取与 Shell 包装函数环境变量还原模块。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 零 Shell 执行注入风险：所有 `~/.zshrc` / `network-proxy.zsh` 解析均采用纯文本词法提取，仅展开静态 `$HOME` / `~` 与同文件内已赋值的变量引用，绝不调用子 Shell 求值未知脚本。
 * 2. 平台级配置严格按预设隔离：
 *    - Antigravity 2.x 的 `network-proxy.zsh`（因原脚本通过 `$PPID` 仅对 `/Applications/Antigravity.app/*` 注入代理，导致 `launchd` 守护进程裸连报 `FAILED_PRECONDITION: User location is not supported`）仅注入 `antigravity` 预设，绝不污染 `codex` / `claude` 的内网直连网关；
 *    - 用户在 `~/.zshrc` 中通过 `claude() { CLAUDE_CONFIG_DIR="..." command claude "$@"; }` 或 `codex() { CODEX_HOME="..." command codex ...; }` 定义的终端隔离目录，仅按对应预设精准还原。
 * 3. 多版本 Node / 包管理器全覆盖：自动按语义版本降序扫描 `~/.nvm/versions/node/<ver>/bin` 及 `~/.local/bin`、`~/.claude/local`、`~/Library/pnpm` 等目录，消除守护进程与服务端因 Node 版本差异找不到全局 CLI 的盲区。
 */
import { spawnSync } from "node:child_process";
import { constants, accessSync, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** 本机自动唤醒支持的 Agent 平台。 */
export type WakeAgentPreset = "antigravity" | "codex" | "claude_code" | "gemini" | "deepseek";

type PresetCliBinary = "agy" | "codex" | "claude" | "gemini" | "dsh";

/** 只继承给 DeepSeek 守护进程的 Harness 配置环境变量。 */
export const DEEPSEEK_DAEMON_ENV_KEYS = ["DSH_HOME", "DEEPSEEK_API_KEY"] as const;

/**
 * 允许从用户 Shell 包装函数或托管代理配置中安全提取的环境变量白名单。
 */
const ALLOWED_WRAPPER_ENV_KEYS: ReadonlySet<string> = new Set<string>([
  "CLAUDE_CONFIG_DIR",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CODEX_HOME",
  "OPENAI_BASE_URL",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_GENAI_USE_VERTEXAI",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
]);

const SHELL_RC_FILES: readonly string[] = [
  ".zshrc",
  ".zprofile",
  ".zshenv",
  ".bashrc",
  ".bash_profile",
];

/**
 * 解析形如 `v24.17.0` 的语义版本号供降序排序（最新版本优先）。
 */
function parseSemverTuple(dirName: string): readonly [number, number, number] {
  const cleaned = dirName.replace(/^v/i, "");
  const parts = cleaned.split(".");
  const major = Number.parseInt(parts[0] ?? "0", 10);
  const minor = Number.parseInt(parts[1] ?? "0", 10);
  const patch = Number.parseInt(parts[2] ?? "0", 10);
  return [
    Number.isFinite(major) ? major : 0,
    Number.isFinite(minor) ? minor : 0,
    Number.isFinite(patch) ? patch : 0,
  ];
}

/**
 * 确保 `NO_PROXY` 字符串始终包含本机回环地址，防止代理软件劫持本地 `localhost:3000` 通信。
 *
 * @param existing - 原始 `NO_PROXY` 值
 * @returns 补齐 `localhost,127.0.0.1,::1` 后的逗号分隔字符串
 */
export function ensureLoopbackNoProxyValue(existing: string | undefined): string {
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
 * 去除 Shell 赋值右侧首尾成对引号，并安全展开 `$HOME`、`${HOME}`、前导 `~/` 以及已知同作用域变量引用。
 */
function expandStaticShellValue(
  rawValue: string,
  homeDir: string,
  knownVars: Readonly<Record<string, string>>,
): string | undefined {
  let val = rawValue.trim();
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
    val = val.slice(1, -1).trim();
  }
  // 安全护栏：拒绝包含命令替换 `$(...)` 或反引号的动态表达式
  if (val.includes("$(") || val.includes("`")) {
    return undefined;
  }

  if (val === "~") {
    val = homeDir;
  } else if (val.startsWith("~/")) {
    val = join(homeDir, val.slice(2));
  }

  const expanded = val.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (_full, varName: string) => {
    if (varName === "HOME") {
      return homeDir;
    }
    return knownVars[varName] ?? `$${varName}`;
  });

  if (expanded.length === 0 || expanded.includes("$")) {
    return undefined;
  }
  return expanded;
}

/**
 * 扫描用户主目录下常见的 CLI 可执行文件安装目录（含按版本号降序排列的全部 `nvm` Node 版本 `bin` 目录）。
 *
 * @param customHomeDir - 可选覆盖的用户主目录
 * @returns 候选目录绝对路径列表（已过滤重复项）
 */
export function discoverUserCliBinDirs(customHomeDir?: string): readonly string[] {
  const home = (customHomeDir ?? homedir()).trim();
  if (home.length === 0) {
    return [];
  }

  const candidates: string[] = [];

  // 1. 扫描 ~/.nvm/versions/node/*/bin（按语义版本降序，确保全局安装在最新 Node 下的 claude / codex 优先命中）
  const nvmVersionsDir = join(home, ".nvm", "versions", "node");
  if (existsSync(nvmVersionsDir)) {
    try {
      const versionDirs = readdirSync(nvmVersionsDir).sort((a, b) => {
        const [aMaj, aMin, aPat] = parseSemverTuple(a);
        const [bMaj, bMin, bPat] = parseSemverTuple(b);
        if (bMaj !== aMaj) return bMaj - aMaj;
        if (bMin !== aMin) return bMin - aMin;
        return bPat - aPat;
      });
      for (const ver of versionDirs) {
        candidates.push(join(nvmVersionsDir, ver, "bin"));
      }
    } catch {
      // 忽略不可读目录
    }
  }

  // 2. 常见跨包管理器与官方安装器路径
  candidates.push(
    join(home, ".claude", "local"),
    join(home, ".local", "bin"),
    join(home, "Library", "pnpm"),
    join(home, "Library", "pnpm", "bin"),
    join(home, ".local", "share", "pnpm"),
    join(home, ".volta", "bin"),
    join(home, ".bun", "bin"),
    join(home, ".yarn", "bin"),
    join(home, ".cargo", "bin"),
  );

  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const dir of candidates) {
    if (!seen.has(dir)) {
      seen.add(dir);
      deduped.push(dir);
    }
  }
  return deduped;
}

/**
 * 提取 Antigravity 2.x 桌面端写入的托管代理配置文件（如 `~/Library/Application Support/Antigravity/network-proxy.zsh`），
 * 并在无托管配置时可选回退读取 macOS `scutil --proxy` 系统代理。
 *
 * @remarks
 * 真实故障根因：Antigravity 2.x 的 `network-proxy.zsh` 通过 `case "$(ps -p $PPID ...)" in /Applications/Antigravity.app/*)`
 * 仅对 IDE 内部拉起的子 Shell 注入 `HTTP_PROXY`；而 `launchd` 后台守护进程的父进程为 PID 1，导致 `agy` 裸连触发
 * `FAILED_PRECONDITION (code 400): User location is not supported for the API use.`。
 *
 * @param customHomeDir - 可选覆盖的用户主目录
 * @param allowMacSystemProxyFallback - 当未找到托管代理文件时是否回退查询 macOS `scutil --proxy`（默认 `false`）
 * @returns 规范化后的代理环境变量字典（无可用代理时返回空对象）
 */
export function resolveAntigravityManagedProxyEnv(
  customHomeDir?: string,
  allowMacSystemProxyFallback = false,
): Readonly<Record<string, string>> {
  const home = (customHomeDir ?? homedir()).trim();
  const proxyFiles: string[] = [];

  if (home.length > 0) {
    proxyFiles.push(
      join(home, "Library", "Application Support", "Antigravity", "network-proxy.zsh"),
      join(home, ".config", "Antigravity", "network-proxy.zsh"),
    );

    // 同时兼容用户在 ~/.zshrc 中通过 `source "<custom-path>/network-proxy.zsh"` 挂载的自定义路径
    const sourcePattern = /(?:^|[;|&\s])(?:source|\.)\s+["']?([^"'\n#;]+network-proxy\.zsh)["']?/gm;
    for (const rcName of SHELL_RC_FILES) {
      const rcPath = join(home, rcName);
      if (!existsSync(rcPath)) {
        continue;
      }
      try {
        const rcContent = readFileSync(rcPath, "utf8");
        for (const match of rcContent.matchAll(sourcePattern)) {
          const rawPath = match[1];
          if (rawPath !== undefined) {
            const expandedPath = expandStaticShellValue(rawPath, home, {});
            if (expandedPath !== undefined && !proxyFiles.includes(expandedPath)) {
              proxyFiles.push(expandedPath);
            }
          }
        }
      } catch {
        // 忽略不可读 RC 文件
      }
    }
  }

  const parsedVars: Record<string, string> = {};
  const exportLinePattern = /^\s*export\s+([A-Za-z_][A-Za-z0-9_]*)=([^\n#;]+)/gm;

  for (const filePath of proxyFiles) {
    if (!existsSync(filePath)) {
      continue;
    }
    try {
      const content = readFileSync(filePath, "utf8");
      for (const match of content.matchAll(exportLinePattern)) {
        const key = match[1];
        const rawVal = match[2];
        if (key === undefined || rawVal === undefined || !ALLOWED_WRAPPER_ENV_KEYS.has(key)) {
          continue;
        }
        const resolved = expandStaticShellValue(rawVal, home, parsedVars);
        if (resolved !== undefined) {
          parsedVars[key] = resolved;
        }
      }
      if (
        parsedVars.HTTP_PROXY !== undefined ||
        parsedVars.HTTPS_PROXY !== undefined ||
        parsedVars.ALL_PROXY !== undefined ||
        parsedVars.http_proxy !== undefined ||
        parsedVars.https_proxy !== undefined ||
        parsedVars.all_proxy !== undefined
      ) {
        break;
      }
    } catch {
      // 忽略单个配置文件读取错误
    }
  }

  // 可选回退：若未配置 Antigravity 专属代理文件，检查 macOS 系统级 HTTP/HTTPS 代理开关
  if (
    allowMacSystemProxyFallback &&
    process.platform === "darwin" &&
    parsedVars.HTTP_PROXY === undefined &&
    parsedVars.HTTPS_PROXY === undefined &&
    parsedVars.http_proxy === undefined &&
    parsedVars.https_proxy === undefined
  ) {
    try {
      const scutil = spawnSync("/usr/sbin/scutil", ["--proxy"], {
        encoding: "utf8",
        timeout: 1_500,
      });
      if (scutil.status === 0 && typeof scutil.stdout === "string") {
        const httpEnable = /HTTPEnable\s*:\s*1\b/.test(scutil.stdout);
        const httpHost = scutil.stdout.match(/HTTPProxy\s*:\s*(\S+)/)?.[1];
        const httpPort = scutil.stdout.match(/HTTPPort\s*:\s*(\d+)/)?.[1];
        const httpsEnable = /HTTPSEnable\s*:\s*1\b/.test(scutil.stdout);
        const httpsHost = scutil.stdout.match(/HTTPSProxy\s*:\s*(\S+)/)?.[1];
        const httpsPort = scutil.stdout.match(/HTTPSPort\s*:\s*(\d+)/)?.[1];

        if (httpEnable && httpHost !== undefined && httpPort !== undefined) {
          parsedVars.HTTP_PROXY = `http://${httpHost}:${httpPort}`;
        }
        if (httpsEnable && httpsHost !== undefined && httpsPort !== undefined) {
          parsedVars.HTTPS_PROXY = `http://${httpsHost}:${httpsPort}`;
        }
      }
    } catch {
      // 忽略 scutil 不可用异常
    }
  }

  const upperHttp = parsedVars.HTTP_PROXY ?? parsedVars.http_proxy;
  const upperHttps = parsedVars.HTTPS_PROXY ?? parsedVars.https_proxy ?? upperHttp;
  if (
    upperHttp === undefined &&
    upperHttps === undefined &&
    parsedVars.ALL_PROXY === undefined &&
    parsedVars.all_proxy === undefined
  ) {
    return {};
  }

  const normalized: Record<string, string> = { ...parsedVars };
  if (upperHttp !== undefined) {
    normalized.HTTP_PROXY = upperHttp;
    normalized.http_proxy = normalized.http_proxy ?? upperHttp;
  }
  if (upperHttps !== undefined) {
    normalized.HTTPS_PROXY = upperHttps;
    normalized.https_proxy = normalized.https_proxy ?? upperHttps;
  }
  const noProxy = ensureLoopbackNoProxyValue(normalized.NO_PROXY ?? normalized.no_proxy);
  normalized.NO_PROXY = noProxy;
  normalized.no_proxy = noProxy;
  return normalized;
}

/**
 * 从用户的 Shell 启动配置（`~/.zshrc` 等）中还原指定 CLI 二进制的包装函数环境变量（如 `claude()` 中的 `CLAUDE_CONFIG_DIR` 或 `codex()` 中的 `CODEX_HOME`）。
 *
 * @param customHomeDir - 可选覆盖的用户主目录
 * @param binaryName - 目标 CLI 命令名
 * @returns 提取到的安全环境变量键值表
 */
export function resolveShellWrapperEnvForBinary(
  customHomeDir: string | undefined,
  binaryName: PresetCliBinary,
): Readonly<Record<string, string>> {
  const home = (customHomeDir ?? homedir()).trim();
  if (home.length === 0) {
    return {};
  }

  const extracted: Record<string, string> = {};
  const allowedKeys: ReadonlySet<string> =
    binaryName === "dsh"
      ? new Set([...ALLOWED_WRAPPER_ENV_KEYS, ...DEEPSEEK_DAEMON_ENV_KEYS])
      : ALLOWED_WRAPPER_ENV_KEYS;
  const escapedBin = binaryName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // 匹配 `claude() { ... }` 或 `function claude { ... }`
  const fnBlockPattern = new RegExp(
    `(?:^|\\n)\\s*(?:function\\s+${escapedBin}(?:\\s*\\(\\s*\\))?|${escapedBin}\\s*\\(\\s*\\))\\s*\\{([\\s\\S]*?)\\n\\s*\\}`,
    "g",
  );
  const inlineCmdLinePattern = new RegExp(`^([^\\n#]*?)\\bcommand\\s+${escapedBin}\\b`, "gm");
  const keyValTokenPattern = /\b([A-Za-z_][A-Za-z0-9_]*)=("[^"\n]*"|'[^'\n]*'|[^\s"';|&]+)/g;
  const exportInFnPattern = /^\s*export\s+([A-Za-z_][A-Za-z0-9_]*)=([^\n#;]+)/gm;

  for (const rcName of SHELL_RC_FILES) {
    const rcPath = join(home, rcName);
    if (!existsSync(rcPath)) {
      continue;
    }
    try {
      const rcContent = readFileSync(rcPath, "utf8");
      for (const fnMatch of rcContent.matchAll(fnBlockPattern)) {
        const body = fnMatch[1];
        if (body === undefined) {
          continue;
        }

        for (const expMatch of body.matchAll(exportInFnPattern)) {
          const key = expMatch[1];
          const rawVal = expMatch[2];
          if (key !== undefined && rawVal !== undefined && allowedKeys.has(key)) {
            const val = expandStaticShellValue(rawVal, home, extracted);
            if (val !== undefined) {
              extracted[key] ??= val;
            }
          }
        }

        for (const cmdMatch of body.matchAll(inlineCmdLinePattern)) {
          const prefix = cmdMatch[1] ?? "";
          for (const kv of prefix.matchAll(keyValTokenPattern)) {
            const key = kv[1];
            const rawVal = kv[2];
            if (key !== undefined && rawVal !== undefined && allowedKeys.has(key)) {
              const val = expandStaticShellValue(rawVal, home, extracted);
              if (val !== undefined) {
                extracted[key] ??= val;
              }
            }
          }
        }
      }
    } catch {
      // 忽略不可读 RC 文件
    }
  }

  // 兜底自愈：若未显式提取到 CLAUDE_CONFIG_DIR，且默认 ~/.claude 未登录但存在 ~/.claude-cli-api/settings.json，自动对齐
  if (
    binaryName === "claude" &&
    extracted.CLAUDE_CONFIG_DIR === undefined &&
    !existsSync(join(home, ".claude", ".credentials.json")) &&
    existsSync(join(home, ".claude-cli-api", "settings.json"))
  ) {
    extracted.CLAUDE_CONFIG_DIR = join(home, ".claude-cli-api");
  }

  return extracted;
}

/**
 * 将唤醒预设枚举映射为宿主可执行二进制名称。
 */
function presetToBinaryName(preset: WakeAgentPreset): PresetCliBinary {
  switch (preset) {
    case "antigravity":
      return "agy";
    case "codex":
      return "codex";
    case "claude_code":
      return "claude";
    case "gemini":
      return "gemini";
    case "deepseek":
      return "dsh";
  }
}

/**
 * 零子进程探测当前环境（本机终端 / 云端容器 / 远程服务器）是否已安装指定预设的无头 Agent CLI 二进制。
 *
 * @remarks
 * 云端沙箱关键防呆（Why）：
 * 在 Codex Cloud、Claude Web Sandbox、Cursor Cloud 或轻量 Docker 容器中，AI Agent 本身作为宿主会话在容器内执行命令，
 * 容器内部通常并未嵌套安装 `codex` / `claude` / `agy` 可执行文件。配对前先做纯文件系统存在性探测，
 * 可避免启动一个注定报 `ENOENT` 的空壳守护进程向群聊发送报错气泡。
 *
 * @param preset - 待探测的预设平台标识
 * @param customHomeDir - 可选覆盖的用户主目录
 * @param customPathEnv - 可选覆盖的 `PATH` 字符串（供沙箱单测精确隔离）
 * @returns 若在搜索路径上找到可执行文件则返回 `true`
 */
export function isPresetCliBinaryAvailable(
  preset: WakeAgentPreset,
  customHomeDir?: string,
  customPathEnv?: string,
): boolean {
  return findPresetCliBinary(preset, customHomeDir, customPathEnv) !== undefined;
}

/**
 * 解析实际用于唤醒的 DeepSeek Harness 启动器。macOS 桌面端未注册 CLI 时也能运行。
 *
 * @param customHomeDir - 可选覆盖的用户主目录
 * @returns 绝对可执行路径，未安装时返回 `undefined`
 */
export function resolveDeepSeekCliBinary(customHomeDir?: string): string | undefined {
  return findPresetCliBinary("deepseek", customHomeDir);
}

function findPresetCliBinary(
  preset: WakeAgentPreset,
  customHomeDir?: string,
  customPathEnv?: string,
): string | undefined {
  const binaryName = presetToBinaryName(preset);
  const pathSep = process.platform === "win32" ? ";" : ":";
  const envDirs = (process.env.PATH ?? "").split(pathSep);
  if (preset === "deepseek") {
    envDirs.push(dirname(process.execPath));
  } else {
    envDirs.unshift(dirname(process.execPath));
  }
  const rawDirs =
    customPathEnv !== undefined
      ? customPathEnv.split(pathSep)
      : [
          ...envDirs,
          ...discoverUserCliBinDirs(customHomeDir),
          ...(process.platform === "win32"
            ? []
            : ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]),
        ];
  const bundleRelativeDir = "DeepSeek Harness.app/Contents/Resources/runtime/cli/bin";
  if (preset === "deepseek" && process.platform === "darwin" && customPathEnv === undefined) {
    rawDirs.push(
      join(customHomeDir ?? homedir(), "Applications", bundleRelativeDir),
      join("/Applications", bundleRelativeDir),
    );
  }

  const suffixes = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  const accessMode = process.platform === "win32" ? constants.F_OK : constants.X_OK;
  const visited = new Set<string>();

  for (const rawDir of rawDirs) {
    const dir = rawDir.trim();
    if (dir.length === 0 || visited.has(dir)) {
      continue;
    }
    visited.add(dir);
    for (const suffix of suffixes) {
      const candidate = resolve(dir, `${binaryName}${suffix}`);
      try {
        accessSync(candidate, accessMode);
        if (statSync(candidate).isFile()) {
          return candidate;
        }
      } catch {
        // 继续检查下一候选路径
      }
    }
  }
  return undefined;
}
