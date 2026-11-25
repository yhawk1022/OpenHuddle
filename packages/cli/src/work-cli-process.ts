import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkAgentWorkOutput } from "@openhuddle/core-governance";
import type { AgentPlatform, WorkSliceRole } from "@openhuddle/protocol";
import { runCustomWorkPrompt } from "./custom-work-runner.js";
import {
  resolveAntigravityManagedProxyEnv,
  resolvePresetCliBinary,
  resolveShellWrapperEnvForBinary,
  resolveWindowsNodeShimEntry,
} from "./host-env.js";
import { scrubSensitiveText } from "./secret-scrubber.js";
import type { WakeExecutionTarget } from "./sse-listener.js";
import { runTextWorkspaceTurn } from "./work-text-edits.js";

export interface WorkPromptInput {
  readonly runner?: WakeExecutionTarget | undefined;
  readonly ownedPaths?: readonly string[] | undefined;
  readonly work?:
    | { itemId: string; sliceId: string; role: WorkSliceRole; leaseVersion: number }
    | undefined;
  readonly platform: AgentPlatform;
  readonly cwd: string;
  readonly homeDir: string;
  readonly signal: AbortSignal;
  readonly writable: boolean;
  readonly prompt: string;
}

/** An externally terminated CLI can retry under the server's existing lease budget. */
export class WorkProcessInterruptedError extends Error {
  constructor(signal: NodeJS.Signals) {
    super(`设备执行进程收到 ${signal} 信号，租约到期后将按现有次数限制重试。`);
  }
}

// Model input goes through stdin. Kill the entire CLI process group when a lease is lost.
async function runPromptProcess(
  executable: string,
  args: string[],
  input: WorkPromptInput,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  input.signal.throwIfAborted();
  const windows = process.platform === "win32";
  const shim = windows ? resolveWindowsNodeShimEntry(executable) : undefined;
  if (windows && /\.(cmd|bat)$/i.test(executable) && !shim) {
    throw new Error("此设备需要原生 Agent 可执行文件或标准 npm 启动器");
  }
  return new Promise((resolve, reject) => {
    const child = spawn(shim ? process.execPath : executable, shim ? [shim, ...args] : args, {
      cwd: input.cwd,
      env,
      detached: !windows,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stop = AbortSignal.any([input.signal, AbortSignal.timeout(30 * 60_000)]);
    const terminate = () => {
      if (child.pid === undefined) return;
      try {
        if (windows) {
          const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/T", "/F"], {
            windowsHide: true,
            stdio: "ignore",
          });
          killer.on("error", () => child.kill());
        } else process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill();
      }
    };
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout = (stdout + chunk).slice(-1_048_576);
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-2_000);
    });
    child.once("error", reject);
    child.once("close", (code, terminationSignal) => {
      stop.removeEventListener("abort", terminate);
      if (stop.aborted) reject(new Error("设备执行已中止或超时"));
      else if (code === null && terminationSignal)
        reject(new WorkProcessInterruptedError(terminationSignal));
      else if (code !== 0)
        reject(
          new Error(
            `Agent CLI 退出（${String(code)}）：${scrubSensitiveText(stderr || stdout).slice(-380)}`,
          ),
        );
      else resolve(stdout.trim());
    });
    stop.addEventListener("abort", terminate, { once: true });
    if (stop.aborted) terminate();
    child.stdin.on("error", () => {
      /* closed by a CLI that exited early */
    });
    child.stdin.end(input.prompt);
  });
}

export async function runWorkPrompt(input: WorkPromptInput): Promise<string> {
  if (input.runner?.kind === "custom")
    return runCustomWorkPrompt(input.runner.command, input, runPromptProcess);
  const platform = input.runner?.preset ?? input.platform;
  const writable = input.writable;
  if (
    platform !== "codex" &&
    platform !== "deepseek" &&
    platform !== "claude_code" &&
    platform !== "gemini" &&
    platform !== "antigravity"
  ) {
    throw new Error(`此设备尚未配置 ${platform} 的本地执行命令。`);
  }
  const binary = {
    codex: "codex",
    deepseek: "dsh",
    claude_code: "claude",
    gemini: "gemini",
    antigravity: "agy",
  } as const;
  const executable =
    resolvePresetCliBinary(platform, input.homeDir, process.env.PATH) ??
    resolvePresetCliBinary(platform, input.homeDir);
  if (!executable) throw new Error(`此设备未找到 ${platform} CLI，请安装后重试。`);
  const mode = writable ? "workspace-write" : "read-only";
  const env = {
    ...(platform === "antigravity"
      ? resolveAntigravityManagedProxyEnv(input.homeDir, !process.env.HTTPS_PROXY)
      : {}),
    ...resolveShellWrapperEnvForBinary(input.homeDir, binary[platform]),
    ...process.env,
  };
  for (const key of Object.keys(env)) {
    if (key.startsWith("OPENHUDDLE_")) delete env[key];
  }
  if (platform === "deepseek") {
    env.DSH_PERMISSION_MODE = mode;
    return checkAgentWorkOutput(
      await runPromptProcess(executable, ["--profile", "headless"], input, env),
    );
  }
  const temp = await mkdtemp(join(tmpdir(), "oh-work-output-"));
  try {
    if (platform === "claude_code" || platform === "gemini" || platform === "antigravity") {
      const toolFree = async (prompt: string) => {
        const isolated = { ...input, cwd: temp, prompt };
        if (platform === "claude_code") {
          env.CLAUDECODE = undefined;
          // Claude's safe mode preserves its own authentication and ignores hooks.
          // An empty tools list makes this a text-only model turn.
          return runPromptProcess(
            executable,
            [
              "-p",
              "--safe-mode",
              "--strict-mcp-config",
              "--disable-slash-commands",
              "--no-session-persistence",
              "--setting-sources",
              "user",
              "--output-format",
              "text",
              "--permission-mode",
              "dontAsk",
              "--permission-prompts",
              "none",
              "--tools",
              "",
            ],
            isolated,
            env,
          );
        }
        if (platform === "gemini") {
          const policy = join(temp, "no-tools.toml");
          await writeFile(policy, '[[rule]]\ntoolName = "*"\ndecision = "deny"\npriority = 999\n', {
            mode: 0o600,
          });
          return runPromptProcess(
            executable,
            [
              // This per-process trust flag applies only to our newly-created
              // private scratch directory, where the CLI has no project hooks.
              "--skip-trust",
              "--policy",
              policy,
              "--admin-policy",
              policy,
              "--extensions",
              "none",
              "--allowed-mcp-server-names",
              "__openhuddle_none__",
              "--output-format",
              "text",
              "-p",
              "Answer the work request supplied on stdin without calling any tools.",
            ],
            isolated,
            env,
          );
        }
        const settings = {
          toolPermission: "request-review",
          permissions: {
            allow: [],
            ask: [],
            deny: [
              "read_file(*)",
              "write_file(*)",
              "command(*)",
              "mcp(*)",
              "read_url(*)",
              "execute_url(*)",
              "download_url(*)",
            ],
          },
        };
        const stream = await runPromptProcess(
          executable,
          [
            "--sandbox",
            "--settings",
            JSON.stringify(settings),
            "--disable-slash-commands",
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
          ],
          {
            ...isolated,
            prompt: `${JSON.stringify({ event: "user", message: { content: prompt } })}\n`,
          },
          env,
        );
        for (const line of stream.split("\n").reverse()) {
          if (!line.startsWith("{")) continue;
          const frame = JSON.parse(line);
          if (frame.event !== "result") continue;
          if (frame.result?.status !== "SUCCESS" || typeof frame.result.response !== "string")
            throw new Error(
              scrubSensitiveText(String(frame.result?.error || "Antigravity 未完成本轮执行")).slice(
                -380,
              ),
            );
          return frame.result.response;
        }
        throw new Error("Antigravity 未返回终态回执。");
      };
      return await runTextWorkspaceTurn(input, temp, toolFree);
    }
    const output = join(temp, "result");
    await runPromptProcess(
      executable,
      [
        "-a",
        "never",
        "-c",
        "sandbox_workspace_write.writable_roots=[]",
        "-c",
        "sandbox_workspace_write.exclude_tmpdir_env_var=true",
        "-c",
        "sandbox_workspace_write.exclude_slash_tmp=true",
        "-c",
        "sandbox_workspace_write.network_access=false",
        "-c",
        "mcp_servers={}",
        "-c",
        "notify=[]",
        "exec",
        "--skip-git-repo-check",
        "--ephemeral",
        "-s",
        mode,
        "--color",
        "never",
        "-o",
        output,
        "-",
      ],
      input,
      env,
    );
    return checkAgentWorkOutput((await readFile(output, "utf8")).trim());
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
