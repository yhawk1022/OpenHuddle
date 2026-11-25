import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentPlatform } from "@openhuddle/protocol";
import {
  resolvePresetCliBinary,
  resolveShellWrapperEnvForBinary,
  resolveWindowsNodeShimEntry,
} from "./host-env.js";
import { scrubSensitiveText } from "./secret-scrubber.js";

export interface WorkPromptInput {
  readonly platform: AgentPlatform;
  readonly cwd: string;
  readonly homeDir: string;
  readonly signal: AbortSignal;
  readonly writable: boolean;
  readonly prompt: string;
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
    const stop = AbortSignal.any([input.signal, AbortSignal.timeout(240_000)]);
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
      stdout = (stdout + chunk).slice(-65_536);
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-2_000);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      stop.removeEventListener("abort", terminate);
      if (stop.aborted) reject(new Error("设备执行已中止或超时"));
      else if (code !== 0)
        reject(
          new Error(`Agent CLI 退出（${String(code)}）：${scrubSensitiveText(stderr).slice(-380)}`),
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
  const { platform, writable } = input;
  if (platform !== "codex" && platform !== "deepseek") {
    throw new Error(
      `当前监听器尚不支持 ${platform} 的工作区沙箱，请选择 Codex 或 DeepSeek，或使用 MCP 工作区工具认领。`,
    );
  }
  const executable =
    resolvePresetCliBinary(platform, input.homeDir, process.env.PATH) ??
    resolvePresetCliBinary(platform, input.homeDir);
  if (!executable) throw new Error(`此设备未找到 ${platform} CLI，请安装后重试。`);
  const mode = writable ? "workspace-write" : "read-only";
  const env = {
    ...resolveShellWrapperEnvForBinary(input.homeDir, platform === "codex" ? "codex" : "dsh"),
    ...process.env,
  };
  for (const key of Object.keys(env)) {
    if (key.startsWith("OPENHUDDLE_")) delete env[key];
  }
  if (platform === "deepseek") {
    env.DSH_PERMISSION_MODE = mode;
    return runPromptProcess(executable, ["--profile", "headless"], input, env);
  }
  const temp = await mkdtemp(join(tmpdir(), "oh-work-output-"));
  try {
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
    return (await readFile(output, "utf8")).trim();
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
