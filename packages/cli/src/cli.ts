/**
 * @module cli/entry
 * @description OpenHuddle 单文件零依赖 CLI (`openhuddle.mjs`) 命令分发入口。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 零外部运行时依赖：打包后的 `openhuddle.mjs` 仅使用 Node.js 20+ 原生内置模块（`fetch`、`fs`、`path`、`os`、`child_process`），确保任意开发者机器一行 `curl` 即可运行。
 * 2. 同机多 Agent 凭据隔离：默认支持 `--token-file` 独立存储并校验身份，严防同一台主机上多个 Agent（如 Antigravity 与 Codex）误覆盖彼此的 `oh_agt_` 令牌。
 */
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * 解析后的 CLI 命令执行参数。
 */
export interface ParsedCliArgs {
  readonly command: string;
  readonly positionals: readonly string[];
  readonly tokenFilePath: string;
  readonly serverUrl: string;
}

/**
 * 解析命令行参数并确定独立 Token 文件路径。
 *
 * @param argv - 去除 `node` 与脚本名后的原始参数列表
 * @returns 结构化命令参数
 */
export function parseCliArgs(argv: readonly string[]): ParsedCliArgs {
  let tokenFilePath = join(homedir(), ".openhuddle", "tokens", "default.token");
  let serverUrl = process.env.OPENHUDDLE_URL ?? "http://localhost:3000";
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) {
      continue;
    }
    if (arg === "--token-file" && argv[i + 1] !== undefined) {
      tokenFilePath = argv[i + 1] ?? tokenFilePath;
      i++;
      continue;
    }
    if (arg === "--server" && argv[i + 1] !== undefined) {
      serverUrl = argv[i + 1] ?? serverUrl;
      i++;
      continue;
    }
    positionals.push(arg);
  }

  return {
    command: positionals[0] ?? "help",
    positionals: positionals.slice(1),
    tokenFilePath,
    serverUrl,
  };
}

/**
 * 执行 CLI 主流程并返回退出码。
 *
 * @param argv - 原始参数数组
 * @returns 进程退出码（`0` 表示成功）
 */
export async function runCli(argv: readonly string[]): Promise<number> {
  const parsed = parseCliArgs(argv);

  if (parsed.command === "help" || parsed.command === "--help" || parsed.command === "-h") {
    console.log(
      [
        "OpenHuddle CLI v0.1.0",
        "Usage: node openhuddle.mjs <command> [options]",
        "",
        "Commands:",
        "  pair <code> --name <name> --platform <platform>   Bind agent and store isolated token",
        "  whoami                                            Inspect current agent & owner identity",
        "  inbox                                             Fetch pending mentions & unread summary",
        "  read <roomId>                                     Read room messages incrementally",
        "  send <roomId> <content>                           Send message under optimistic read lock",
        "  listen install|status|stop                        Manage macOS/Linux/Windows SSE wake daemon",
      ].join("\n"),
    );
    return 0;
  }

  console.error(
    `Command "${parsed.command}" will be wired in Wave 1 (server=${parsed.serverUrl}).`,
  );
  return 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void runCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
