import type { WorkPromptInput } from "./work-cli-process.js";

type RunProcess = (
  executable: string,
  args: string[],
  input: WorkPromptInput,
  env: NodeJS.ProcessEnv,
) => Promise<string>;

/**
 * The local --run command is trusted host configuration. Task fields travel only on stdin.
 * Its exit code alone (or a chat reply on stdout) cannot settle a fenced workspace lease.
 */
export async function runCustomWorkPrompt(
  command: string,
  input: WorkPromptInput,
  runProcess: RunProcess,
): Promise<string> {
  const work = input.work;
  if (!work) throw new Error("自定义工作区执行器缺少分片租约信息。");
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("OPENHUDDLE_")) delete env[key];
  }
  env.OPENHUDDLE_EVENT_TYPE = "work.slice";
  const windows = process.platform === "win32";
  const stdout = await runProcess(
    windows ? (process.env.ComSpec ?? "cmd.exe") : "/bin/sh",
    windows ? ["/d", "/s", "/c", command] : ["-c", command],
    {
      ...input,
      prompt: JSON.stringify({
        type: "openhuddle.work.slice",
        ...work,
        writable: input.writable,
        prompt: input.prompt,
      }),
    },
    env,
  );
  let receipt: Record<string, unknown> | undefined;
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (typeof parsed === "object" && parsed !== null) receipt = parsed as Record<string, unknown>;
  } catch {
    // A pre-existing chat adapter can return ordinary text for a wake. Never post it as completed work.
  }
  if (
    !receipt ||
    receipt.type !== "openhuddle.work.result" ||
    receipt.sliceId !== work.sliceId ||
    receipt.leaseVersion !== work.leaseVersion ||
    typeof receipt.summary !== "string" ||
    !receipt.summary.trim()
  ) {
    throw new Error(
      "请让 --run 适配器处理 OPENHUDDLE_EVENT_TYPE=work.slice，并在 stdout 返回本分片的 openhuddle.work.result JSON（sliceId、leaseVersion、summary）。",
    );
  }
  if (work.role !== "verify") return receipt.summary.trim();
  if (receipt.verdict !== "passed" && receipt.verdict !== "changes_requested") {
    throw new Error("自定义复核回执需要明确的 verdict（passed 或 changes_requested）。");
  }
  return `${receipt.summary.trim()}\nVERDICT: ${receipt.verdict.toUpperCase()}`;
}
