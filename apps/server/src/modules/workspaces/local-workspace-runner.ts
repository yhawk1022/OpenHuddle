/**
 * @module server/modules/workspaces/local-workspace-runner
 * @description 本机回环模式下的真实工作区执行引擎（`LocalWorkspaceRunner`）。
 *
 * 核心流程与高可用/安全不变量：
 * 1. 严格本机回环与路径安全门禁：仅在 `isLoopbackServerUrl(PUBLIC_BASE_URL)` 为真时启动，仅消费 `hostMode === "local_machine"` 工单，并在执行前通过 `assertSafeLocalWorkspacePath` 拦截系统目录与凭据目录。
 * 2. 双模沙盒并发控制：
 *    - `worktree_pool`（Git 仓库）：按工单分支在 `~/.openhuddle/worktrees/<workspaceId>/<branchSlug>` 创建隔离工作树，写分片与后续独立复核共享同一工作树，支持多工单真并行；
 *    - `in_place`（原地目录 / 普通文件夹）：通过按目录排队的异步单写互斥锁（`acquireDirectoryWriteLock`）串行化写操作，杜绝并发覆写踩踏。
 * 3. Git 与普通文件夹统一 Diff 引擎：Git 仓库采集 `git diff HEAD` + 新增未追踪文件；非 Git 普通文件夹采集执行前后文本快照并生成同构 Unified Diff，确保任意形态工作区均可审阅真实变更。
 * 4. 全链路动态追踪、运行中热纠偏（Mid-Flight Steer）与三层溯源：实时流式推送 `work.trace` SSE，执行期间到达的补充指令自动触发增量修补回合，完工后原子更新仓外 `.jsonl`、定长 `MEMORY.md`（≤200 行）与零污染 `refs/notes/openhuddle`。
 */
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  constants,
  accessSync,
  appendFileSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  writeSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import {
  type AgentAttention,
  WORK_AGENT_STOP_INSTRUCTION,
  WorkAgentAttention,
  checkAgentWorkOutput,
  parseWorkVerdict,
  scrubWorkText,
} from "@openhuddle/core-governance";
import {
  type PlainFolderSnapshot,
  type WorkingTreeDiffSnapshot,
  capturePlainFolderSnapshot,
  collectWorkingTreeDiff,
  diffPlainFolderSnapshots,
  isGitWorkingTree,
  workspaceGitEnv,
  workspaceProcessEnv,
} from "@openhuddle/core-governance/workspace-diff";
import type {
  AgentExecutionTier,
  AgentPlatform,
  AuthenticatedCaller,
  WorkDiffFileDto,
  WorkSliceId,
  WorkSliceRole,
  WorkspaceRootEntry,
} from "@openhuddle/protocol";
import type { Logger } from "pino";
import { AppError } from "../../infra/errors.js";
import {
  assertSafeLocalWorkspacePath,
  ensureAutoCreatableLocalWorkspaceDir,
  removeEmptyCreatedDirs,
} from "./workspace-fs-guard.js";
import type { HydratedWorkItemRecord, HydratedWorkspaceRecord } from "./workspaces.mapper.js";
import type { WorkspacesRepository } from "./workspaces.repo.js";
import type { WorkspacesService } from "./workspaces.service.js";

const execFileAsync = promisify(execFile);

const SLICE_HEARTBEAT_INTERVAL_MS = 3_000;
const OUTPUT_TRACE_FLUSH_MS = 380;
const CLI_TURN_TIMEOUT_MS = 240_000;
const HOOK_COMMAND_TIMEOUT_MS = 120_000;
const MAX_ROLLING_MEMORY_LINES = 200;
const MAX_ROLLING_MEMORY_BYTES = 24 * 1024;
const TRANSIENT_NODE_ERROR_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EPIPE",
]);

function extractErrorCode(err: unknown): string | undefined {
  if (!err || typeof err !== "object") return undefined;
  const direct = (err as { readonly code?: unknown }).code;
  if (typeof direct === "string" && direct.length > 0) return direct;
  const cause = (err as { readonly cause?: unknown }).cause;
  if (cause && typeof cause === "object") {
    const nested = (cause as { readonly code?: unknown }).code;
    if (typeof nested === "string" && nested.length > 0) return nested;
  }
  return undefined;
}

function isTransientCliError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  if (err instanceof WorkAgentAttention) return false;
  if (err instanceof Error && err.name === "AbortError") return false;

  const code = extractErrorCode(err);
  if (code === "ENOENT") return false;

  const message = err instanceof Error ? err.message : "";
  if (
    /ABORTED_BY_OWNER|operation was aborted|\baborted\b/i.test(message) ||
    /\b(?:401|403)\b|invalid[_\s-]?api[_\s-]?key|unauthorized|forbidden|authentication\s+failed|insufficient[_\s-]?quota|\bbilling\b|credit\s+balance|account\s+suspended|permission\s+denied/i.test(
      message,
    ) ||
    /\bENOENT\b|未在本机 PATH 中检测到|工作区|已有工作树|工作分支名称无效|未返回明确的最终判定|未提交文件/i.test(
      message,
    ) ||
    /\b(?:400|402|404|405|409|410|413|415|422)\b/.test(message)
  ) {
    return false;
  }

  if (code && (TRANSIENT_NODE_ERROR_CODES.has(code) || code.startsWith("UND_ERR_"))) {
    return true;
  }

  return /\b(?:429|502|503|504|529)\b|rate[\s_-]?limit|too\s+many\s+requests|overloaded|temporarily\s+unavailable|service\s+unavailable|bad\s+gateway|gateway\s+timeout|fetch\s+failed|socket\s+hang\s+up|connection\s+reset|network\s+error|econnreset|etimedout|econnrefused|eai_again|enetunreach|epipe|und_err_/i.test(
    message,
  );
}

function isRateLimitCliError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : "";
  return /\b429\b|rate[\s_-]?limit|too\s+many\s+requests/i.test(message);
}

async function gitExec(
  cwd: string,
  args: readonly string[],
  signal?: AbortSignal | undefined,
): Promise<string> {
  const result = await execFileAsync(
    "git",
    ["-c", `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`, ...args],
    {
      cwd,
      timeout: 25_000,
      env: workspaceGitEnv(),
      maxBuffer: 1024 * 1024,
      ...(signal !== undefined ? { signal } : {}),
    },
  );
  return result.stdout.trim();
}

async function createEmptyInitialCommit(
  rootDir: string,
  signal?: AbortSignal | undefined,
): Promise<void> {
  await gitExec(
    rootDir,
    [
      "-c",
      "user.name=OpenHuddle",
      "-c",
      "user.email=openhuddle@localhost",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--allow-empty",
      "--no-verify",
      "-qm",
      "Initialize OpenHuddle workspace",
    ],
    signal,
  );
}

async function initializeEmptyGitBase(
  rootDir: string,
  defaultBranch: string | undefined,
  signal?: AbortSignal | undefined,
): Promise<void> {
  const gitDir = path.join(rootDir, ".git");
  mkdirSync(gitDir);
  try {
    await gitExec(rootDir, ["init", "-q", "--template="], signal);
    if (defaultBranch && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(defaultBranch)) {
      const validBranch = await gitExec(
        rootDir,
        ["check-ref-format", "--branch", defaultBranch],
        signal,
      )
        .then(() => true)
        .catch(() => false);
      if (validBranch) {
        await gitExec(rootDir, ["symbolic-ref", "HEAD", `refs/heads/${defaultBranch}`], signal);
      }
    }
    await createEmptyInitialCommit(rootDir, signal);
  } catch (err) {
    rmSync(gitDir, { recursive: true, force: true });
    throw err;
  }
}

export interface LocalCliExecutionInput {
  readonly platform: AgentPlatform;
  readonly agentName: string;
  readonly role: WorkSliceRole;
  readonly tier: AgentExecutionTier;
  readonly workingDir: string;
  readonly prompt: string;
  readonly homeDir: string;
  readonly pathEnv?: string | undefined;
  readonly signal: AbortSignal;
  readonly onOutputLine: (line: string) => void;
}

export interface LocalCliExecutionResult {
  readonly summary: string;
  readonly verdict?: "passed" | "changes_requested" | undefined;
  readonly commandLabel: string;
}

export type LocalCliExecutorFn = (
  input: Readonly<LocalCliExecutionInput>,
) => Promise<LocalCliExecutionResult | { readonly attention: AgentAttention }>;

export interface LocalWorkspaceRunnerDeps {
  readonly repo: WorkspacesRepository;
  readonly workspacesService: WorkspacesService;
  readonly logger?: Logger | undefined;
  readonly homeDir?: string | undefined;
  readonly pathEnv?: string | undefined;
  readonly cliExecutor?: LocalCliExecutorFn | undefined;
  readonly transientRetryDelayMs?: number | undefined;
}

export interface LocalWorkspaceRunnerHandle {
  readonly stop: () => Promise<void>;
}

type SupportedLocalBinary = "codex" | "claude" | "agy" | "gemini";

function sanitizeSegment(raw: string): string {
  const cleaned = raw
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned.length > 0 ? cleaned.slice(0, 72) : "default";
}

function parseSemverTuple(dirName: string): readonly [number, number, number] {
  const parts = dirName.replace(/^v/i, "").split(".");
  return [
    Number.parseInt(parts[0] ?? "0", 10) || 0,
    Number.parseInt(parts[1] ?? "0", 10) || 0,
    Number.parseInt(parts[2] ?? "0", 10) || 0,
  ];
}

function buildCliSearchDirs(homeDir: string, pathEnv?: string | undefined): readonly string[] {
  const sep = process.platform === "win32" ? ";" : ":";
  const nvmDir = path.join(homeDir, ".nvm", "versions", "node");
  const nvmBins: string[] = [];
  if (pathEnv === undefined && existsSync(nvmDir)) {
    try {
      const sorted = readdirSync(nvmDir).sort((a, b) => {
        const [aMaj, aMin, aPat] = parseSemverTuple(a);
        const [bMaj, bMin, bPat] = parseSemverTuple(b);
        if (bMaj !== aMaj) return bMaj - aMaj;
        if (bMin !== aMin) return bMin - aMin;
        return bPat - aPat;
      });
      for (const v of sorted) {
        nvmBins.push(path.join(nvmDir, v, "bin"));
      }
    } catch {
      // 忽略不可读目录
    }
  }

  const raw =
    pathEnv !== undefined
      ? pathEnv.split(sep)
      : [
          path.dirname(process.execPath),
          ...(process.env.PATH ?? "").split(sep),
          ...nvmBins,
          path.join(homeDir, ".claude", "local"),
          path.join(homeDir, ".local", "bin"),
          path.join(homeDir, "Library", "pnpm"),
          path.join(homeDir, ".volta", "bin"),
          path.join(homeDir, ".bun", "bin"),
          ...(process.platform === "darwin"
            ? ["/opt/homebrew/bin", "/usr/local/bin"]
            : ["/usr/local/bin"]),
        ];

  const seen = new Set<string>();
  const out: string[] = [];
  for (const dir of raw) {
    const clean = dir.trim();
    if (clean.length > 0 && !seen.has(clean)) {
      seen.add(clean);
      out.push(clean);
    }
  }
  return out;
}

function findExecutablePath(
  binary: SupportedLocalBinary,
  searchDirs: readonly string[],
): string | undefined {
  const suffixes = process.platform === "win32" ? [".exe", ".cmd", ""] : [""];
  const flag = process.platform === "win32" ? constants.F_OK : constants.X_OK;
  for (const dir of searchDirs) {
    for (const suffix of suffixes) {
      const candidate = path.join(dir, `${binary}${suffix}`);
      try {
        accessSync(candidate, flag);
        return candidate;
      } catch {
        // 尝试下一目录
      }
    }
  }
  return undefined;
}

function selectLocalBinary(
  platform: AgentPlatform,
  searchDirs: readonly string[],
): { readonly binary: SupportedLocalBinary; readonly executablePath: string } | undefined {
  const preferredOrder: readonly SupportedLocalBinary[] = (() => {
    switch (platform) {
      case "codex":
        return ["codex", "claude", "agy", "gemini"];
      case "claude_code":
        return ["claude", "codex", "agy", "gemini"];
      case "antigravity":
        return ["agy", "claude", "codex", "gemini"];
      case "gemini":
        return ["gemini", "claude", "codex", "agy"];
      default:
        return ["claude", "codex", "agy", "gemini"];
    }
  })();

  for (const binary of preferredOrder) {
    const executablePath = findExecutablePath(binary, searchDirs);
    if (executablePath !== undefined) {
      return { binary, executablePath };
    }
  }
  return undefined;
}

function appendProvenanceJsonl(params: {
  readonly homeDir: string;
  readonly agentSlug: string;
  readonly workspaceId: string;
  readonly workItemId: string;
  readonly kind: string;
  readonly summary: string;
  readonly files?: readonly string[] | undefined;
}): string {
  const logPath = path.join(
    params.homeDir,
    ".openhuddle",
    "agents",
    sanitizeSegment(params.agentSlug),
    "sessions",
    sanitizeSegment(params.workspaceId),
    `${sanitizeSegment(params.workItemId)}.jsonl`,
  );
  mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 });
  const record = {
    timestampIso: new Date().toISOString(),
    taskId: params.workItemId,
    workspaceId: params.workspaceId,
    agentSlug: params.agentSlug,
    kind: params.kind,
    summary: scrubWorkText(params.summary),
    ...(params.files !== undefined ? { files: params.files } : {}),
  };
  appendFileSync(logPath, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
  return logPath;
}

function resolveRollingMemoryPath(homeDir: string, agentSlug: string, workspaceId: string): string {
  return path.join(
    homeDir,
    ".openhuddle",
    "agents",
    sanitizeSegment(agentSlug),
    "memory",
    sanitizeSegment(workspaceId),
    "MEMORY.md",
  );
}

function readRollingMemoryContext(
  homeDir: string,
  agentSlug: string,
  workspaceId: string,
): string | undefined {
  const memPath = resolveRollingMemoryPath(homeDir, agentSlug, workspaceId);
  if (!existsSync(memPath)) {
    return undefined;
  }
  try {
    const raw = readFileSync(memPath, "utf8").trim();
    return raw.length > 0 ? raw.slice(0, MAX_ROLLING_MEMORY_BYTES) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 原子更新定长滚动工作区热记忆 `MEMORY.md`（硬上限 ≤ 200 行且 ≤ 24KB，tmp+rename 防撕裂）。
 */
function writeRollingWorkspaceMemory(params: {
  readonly homeDir: string;
  readonly agentSlug: string;
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly workItemId: string;
  readonly title: string;
  readonly summary: string;
  readonly changedFiles: readonly string[];
}): string {
  const memoryPath = resolveRollingMemoryPath(params.homeDir, params.agentSlug, params.workspaceId);
  const existingBlocks: Array<{ readonly taskId: string; readonly text: string }> = [];
  if (existsSync(memoryPath)) {
    try {
      const raw = readFileSync(memoryPath, "utf8");
      const regex = /<!-- oh-entry:([^\s>]+) -->\n([\s\S]*?)\n<!-- \/oh-entry -->/g;
      for (const m of raw.matchAll(regex)) {
        const tid = m[1]?.trim();
        const body = m[2];
        if (tid && body !== undefined) {
          existingBlocks.push({
            taskId: tid,
            text: `<!-- oh-entry:${tid} -->\n${body}\n<!-- /oh-entry -->`,
          });
        }
      }
    } catch {
      // 忽略损坏旧文件
    }
  }

  const safeId = sanitizeSegment(params.workItemId);
  const dateTag = new Date().toISOString().slice(0, 10);
  const entryLines = [
    `<!-- oh-entry:${safeId} -->`,
    `### ${dateTag} · ${scrubWorkText(params.title.replace(/\r?\n/g, " ").trim())} (\`${safeId}\`)`,
    `- 结论：${scrubWorkText(params.summary.replace(/\r?\n/g, " ").trim())}`,
    ...(params.changedFiles.length > 0
      ? [`- 变更：\`${params.changedFiles.slice(0, 6).join(", ")}\``]
      : []),
    "<!-- /oh-entry -->",
  ];
  const freshBlock = { taskId: safeId, text: entryLines.join("\n") };
  const merged = [freshBlock, ...existingBlocks.filter((b) => b.taskId !== safeId)].slice(0, 12);

  const header = [
    `# ${scrubWorkText(params.workspaceName)} · Agent 工作记忆 (${sanitizeSegment(params.agentSlug)})`,
    "",
    "> 由 OpenHuddle 自动滚动维护（上限 200 行，完整记录见同级 sessions/*.jsonl）。",
    "",
  ].join("\n");

  const kept: string[] = [];
  for (const candidate of merged) {
    const trial = `${header}${[...kept, candidate.text].join("\n\n")}\n`;
    if (
      kept.length > 0 &&
      (trial.split("\n").length > MAX_ROLLING_MEMORY_LINES ||
        Buffer.byteLength(trial, "utf8") > MAX_ROLLING_MEMORY_BYTES)
    ) {
      break;
    }
    kept.push(candidate.text);
  }

  const finalContent = `${header}${kept.join("\n\n")}\n`;
  const dir = path.dirname(memoryPath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmpFile = path.join(dir, `.mem-${String(process.pid)}-${randomUUID().slice(0, 8)}.tmp`);
  const fd = openSync(tmpFile, "w", 0o600);
  try {
    writeSync(fd, finalContent, undefined, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmpFile, memoryPath);
  return memoryPath;
}

async function tryAttachGitProvenanceNote(params: {
  readonly repoDir: string;
  readonly workItemId: string;
  readonly workspaceId: string;
  readonly agentSlug: string;
  readonly summary: string;
}): Promise<boolean> {
  if (!(await isGitWorkingTree(params.repoDir))) {
    return false;
  }
  try {
    const payload = JSON.stringify(
      {
        schema: "openhuddle.provenance.v1",
        taskId: params.workItemId,
        workspaceId: params.workspaceId,
        agent: params.agentSlug,
        summary: scrubWorkText(params.summary),
        recordedAtIso: new Date().toISOString(),
      },
      null,
      2,
    );
    await execFileAsync("git", ["notes", "--ref=openhuddle", "add", "-f", "-m", payload, "HEAD"], {
      cwd: params.repoDir,
      timeout: 4_000,
      env: workspaceGitEnv(),
    });
    return true;
  } catch {
    return false;
  }
}

function selectWorkspaceRootForSlice(
  workspace: Readonly<HydratedWorkspaceRecord>,
  ownedPaths: readonly string[],
): WorkspaceRootEntry | undefined {
  if (workspace.roots.length <= 1) {
    return workspace.roots[0];
  }
  for (const pattern of ownedPaths) {
    const topSeg = pattern
      .replace(/^\.?\//, "")
      .split("/")[0]
      ?.trim()
      .toLowerCase();
    if (!topSeg || topSeg === "**" || topSeg === "*") {
      continue;
    }
    const matched = workspace.roots.find(
      (r) => r.name.toLowerCase() === topSeg || r.id.toLowerCase() === topSeg,
    );
    if (matched !== undefined) {
      return matched;
    }
  }
  return workspace.roots[0];
}

function sliceWorktreeLocation(
  homeDir: string,
  workspace: Readonly<HydratedWorkspaceRecord>,
  item: Readonly<HydratedWorkItemRecord>,
  sliceId: WorkSliceId,
  matchedRoot: WorkspaceRootEntry,
) {
  const sliceHash = createHash("sha256").update(sliceId).digest("hex").slice(0, 10);
  const effectiveBranch =
    item.topology === "swarm"
      ? `${item.worktreeBranch.slice(0, 140)}-${sliceHash}`
      : item.worktreeBranch;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(effectiveBranch)) {
    throw new Error("工作分支名称无效。");
  }

  const rootSuffix = workspace.roots.length > 1 ? `-${sanitizeSegment(matchedRoot.name)}` : "";
  const sliceDirSuffix = item.topology === "swarm" ? `-${sliceHash}` : "";
  const worktreeParent = path.join(
    homeDir,
    ".openhuddle",
    "worktrees",
    sanitizeSegment(workspace.id),
  );
  const worktreeDir = path.join(
    worktreeParent,
    `${sanitizeSegment(item.worktreeBranch)}${rootSuffix}${sliceDirSuffix}`,
  );

  return { effectiveBranch, worktreeDir, worktreeParent };
}

function buildExecutionPrompt(params: {
  readonly item: Readonly<HydratedWorkItemRecord>;
  readonly sliceTitle: string;
  readonly role: WorkSliceRole;
  readonly ownedPaths: readonly string[];
  readonly steerNotes: readonly string[];
  readonly rollingMemory?: string | undefined;
  readonly verifyHookReport?: string | undefined;
  readonly diffFiles?: readonly WorkDiffFileDto[] | undefined;
  readonly isFollowUpSteerPass?: boolean | undefined;
}): string {
  const lines: string[] = [
    `# OpenHuddle Workspace Task: ${params.item.title}`,
    "",
    "## Task Brief",
    params.item.brief,
    "",
    `## Assigned Slice (${params.role.toUpperCase()})`,
    `- Slice: ${params.sliceTitle}`,
    `- Allowed Owned Paths: ${params.ownedPaths.join(", ")}`,
  ];

  if (params.steerNotes.length > 0) {
    lines.push(
      "",
      params.isFollowUpSteerPass
        ? "## Urgent Mid-Flight Steering Instructions (Apply Incrementally Now)"
        : "## Human / Rework Steering Notes (Highest Priority)",
    );
    for (const note of params.steerNotes) {
      lines.push(`- ${note}`);
    }
  }

  if (params.rollingMemory !== undefined) {
    lines.push("", "## Recent Workspace Memory (Context)", params.rollingMemory);
  }

  if (params.role === "verify") {
    lines.push(
      "",
      "## Independent Verification Instructions",
      "- Do NOT modify source files. Inspect the working tree changes and verification command results below.",
      "- Check correctness, edge cases, type safety, and adherence to the task brief.",
      ...(params.item.review?.verifierNote
        ? [`Previous review: ${params.item.review.verifierNote}`]
        : []),
    );
    if (params.verifyHookReport !== undefined) {
      lines.push("", "## Automated Verify Hook Result", params.verifyHookReport);
    }
    if (params.diffFiles !== undefined && params.diffFiles.length > 0) {
      lines.push(
        "",
        "## Changed Files Summary",
        ...params.diffFiles.map(
          (f) => `- ${f.path} (+${String(f.additions)} / -${String(f.deletions)})`,
        ),
      );
      if (params.item.topology === "swarm") {
        const diff = params.diffFiles
          .map((file) =>
            [
              `--- ${file.path}`,
              ...file.lines.map(
                (line) =>
                  (line.kind === "add" ? "+" : line.kind === "del" ? "-" : " ") + line.content,
              ),
            ].join("\n"),
          )
          .join("\n");
        lines.push(
          "",
          "## Submitted Diff Preview (inspect the writer directories for the full changes)",
          scrubWorkText(diff).slice(0, 24_000),
        );
      }
    }
  } else if (params.role === "read") {
    lines.push(
      "",
      "## Read-Only Analysis Instructions",
      "- Inspect the workspace without modifying any files and summarize your concrete findings concisely.",
    );
  } else {
    lines.push(
      "",
      "## Implementation Instructions",
      "- Implement the requested changes directly inside this working directory.",
      "- Stay strictly within your Allowed Owned Paths.",
      "- Keep edits clean, minimal, and idiomatic. Summarize what you changed in 2-4 concise sentences at the end.",
    );
  }

  lines.push("", WORK_AGENT_STOP_INSTRUCTION);
  if (params.role === "verify") {
    lines.push(
      "For a completed review give concise findings and end with exactly VERDICT: PASSED or VERDICT: CHANGES_REQUESTED.",
    );
  }
  return lines.join("\n");
}

function summarizeCliOutput(rawOutput: string, fallback: string): string {
  const meaningfulLines = scrubWorkText(rawOutput)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.length > 0 &&
        !line.startsWith("VERDICT:") &&
        !line.startsWith("```") &&
        !line.startsWith("OpenAI Codex"),
    );
  if (meaningfulLines.length === 0) {
    return fallback;
  }
  const tail = meaningfulLines.slice(-3).join(" ");
  return tail.length > 260 ? `${tail.slice(0, 257)}…` : tail;
}

/** Keep each stream's PEM state across lines and trace flushes. */
function streamRedactedLines(stream: Readable, onLine: (line: string) => void): void {
  let insidePrivateKey = false;
  createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY }).on(
    "line",
    (line: string) => {
      if (/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(line)) {
        insidePrivateKey = true;
        onLine("[REDACTED_PRIVATE_KEY]");
      }
      if (insidePrivateKey) {
        if (/-----END [A-Z0-9 ]*PRIVATE KEY-----/.test(line)) insidePrivateKey = false;
        return;
      }
      const clean = scrubWorkText(line.trim());
      if (clean) onLine(clean);
    },
  );
}

async function runShellHookCommand(params: {
  readonly command: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly signal: AbortSignal;
  readonly onOutputLine: (line: string) => void;
}): Promise<{ readonly passed: boolean; readonly outputTail: string }> {
  params.signal.throwIfAborted();
  return new Promise((resolve) => {
    const shellBin = process.platform === "win32" ? "cmd.exe" : "/bin/sh";
    const shellArgs =
      process.platform === "win32" ? ["/d", "/s", "/c", params.command] : ["-lc", params.command];
    const child = spawn(shellBin, shellArgs, {
      cwd: params.cwd,
      env: workspaceProcessEnv(params.env),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    const tailLines: string[] = [];
    const onLine = (line: string): void => {
      tailLines.push(line);
      if (tailLines.length > 24) tailLines.shift();
      params.onOutputLine(line);
    };
    streamRedactedLines(child.stdout, onLine);
    streamRedactedLines(child.stderr, onLine);

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
    }, HOOK_COMMAND_TIMEOUT_MS);

    const onAbort = (): void => {
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, 1_500).unref();
    };
    params.signal.addEventListener("abort", onAbort, { once: true });

    child.on("close", (code) => {
      clearTimeout(timer);
      params.signal.removeEventListener("abort", onAbort);
      resolve({
        passed: code === 0,
        outputTail: tailLines.slice(-12).join("\n"),
      });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      params.signal.removeEventListener("abort", onAbort);
      resolve({
        passed: false,
        outputTail: err.message,
      });
    });
  });
}

async function defaultLocalCliExecutor(
  input: Readonly<LocalCliExecutionInput>,
): Promise<LocalCliExecutionResult> {
  const searchDirs = buildCliSearchDirs(input.homeDir, input.pathEnv);
  const resolved = selectLocalBinary(input.platform, searchDirs);
  if (!resolved) {
    throw new Error(
      "未在本机 PATH 中检测到可用的编程 Agent CLI（claude / codex / agy / gemini）。",
    );
  }

  const isWrite =
    input.role === "write" && input.tier !== "chat_only" && input.tier !== "workspace_read";
  const codexReplyFile =
    resolved.binary === "codex"
      ? path.join(tmpdir(), `oh-work-codex-${randomUUID()}.txt`)
      : undefined;
  const agyTimeoutSec = Math.max(30, Math.floor(CLI_TURN_TIMEOUT_MS / 1_000) - 5);

  const invocation: {
    readonly args: readonly string[];
    readonly stdinText?: string | undefined;
    readonly label: string;
  } = (() => {
    switch (resolved.binary) {
      case "codex":
        return {
          args: [
            "-a",
            "never",
            "exec",
            "--skip-git-repo-check",
            "--ephemeral",
            "-s",
            isWrite ? "workspace-write" : "read-only",
            "--color",
            "never",
            "-o",
            codexReplyFile ?? "",
            "-",
          ],
          stdinText: input.prompt,
          label: `codex exec -s ${isWrite ? "workspace-write" : "read-only"}`,
        };
      case "claude":
        return {
          args: [
            "-p",
            "--output-format",
            "text",
            "--no-session-persistence",
            ...(isWrite ? ["--permission-mode", "acceptEdits"] : []),
            "--permission-prompts",
            "none",
          ],
          stdinText: input.prompt,
          label: `claude -p${isWrite ? " --permission-mode acceptEdits" : ""}`,
        };
      case "agy":
        return {
          args: [
            "--output-format",
            "text",
            "--disable-slash-commands",
            "--print-timeout",
            `${String(agyTimeoutSec)}s`,
            "--print",
            input.prompt,
          ],
          label: "agy --output-format text --print <task>",
        };
      case "gemini":
        return {
          args: [
            "-p",
            isWrite
              ? "Complete the OpenHuddle workspace coding task provided on stdin."
              : "Review and verify the OpenHuddle workspace task provided on stdin.",
            ...(isWrite ? ["--approval-mode", "auto_edit"] : []),
            "-o",
            "text",
          ],
          stdinText: input.prompt,
          label: `gemini -p${isWrite ? " --approval-mode auto_edit" : ""}`,
        };
    }
  })();

  const childEnv: NodeJS.ProcessEnv = {
    ...workspaceProcessEnv(),
    HOME: input.homeDir,
    PATH: searchDirs.join(process.platform === "win32" ? ";" : ":"),
  };
  childEnv.CLAUDECODE = undefined;

  return new Promise((resolve, reject) => {
    const child = spawn(resolved.executablePath, invocation.args, {
      cwd: input.workingDir,
      env: childEnv,
      stdio: [invocation.stdinText !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    if (invocation.stdinText !== undefined && child.stdin) {
      child.stdin.write(invocation.stdinText);
      child.stdin.end();
    }

    let collected = "";
    let stderrTail = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      collected += chunk;
    });
    if (child.stdout) streamRedactedLines(child.stdout, input.onOutputLine);
    if (child.stderr)
      streamRedactedLines(child.stderr, (line) => {
        stderrTail = `${stderrTail}\n${line}`.slice(-2_000);
        input.onOutputLine(line);
      });

    let timedOut = false;
    const onAbort = (): void => {
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, 1_500).unref();
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      onAbort();
    }, CLI_TURN_TIMEOUT_MS);
    input.signal.addEventListener("abort", onAbort, { once: true });

    child.on("error", (err) => {
      clearTimeout(timeout);
      input.signal.removeEventListener("abort", onAbort);
      if (codexReplyFile) rmSync(codexReplyFile, { force: true });
      reject(err);
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      input.signal.removeEventListener("abort", onAbort);

      let finalOutput = collected;
      if (codexReplyFile && existsSync(codexReplyFile)) {
        try {
          const replyText = readFileSync(codexReplyFile, "utf8").trim();
          if (replyText.length > 0) {
            finalOutput = replyText;
          }
        } catch {
          // 回退使用标准输出流
        } finally {
          rmSync(codexReplyFile, { force: true });
        }
      }

      if (input.signal.aborted) {
        reject(new Error("ABORTED_BY_OWNER"));
        return;
      }

      if (timedOut || code !== 0) {
        const detail = scrubWorkText((stderrTail || collected).trim()).slice(-380);
        reject(
          new Error(
            timedOut
              ? "本机 Agent 执行超时。"
              : `${resolved.binary} exited with status ${String(code)}${detail.length > 0 ? `: ${detail}` : ""}`,
          ),
        );
        return;
      }
      try {
        checkAgentWorkOutput(finalOutput);
        if (input.role === "verify") {
          const parsedVerdict = parseWorkVerdict(finalOutput);
          const summarySource = parsedVerdict
            ? finalOutput.slice(0, parsedVerdict.summaryEndIndex)
            : finalOutput;
          const summary = summarizeCliOutput(summarySource, "");
          resolve({
            summary,
            ...(parsedVerdict !== undefined ? { verdict: parsedVerdict.verdict } : {}),
            commandLabel: invocation.label,
          });
          return;
        }
        const summary = summarizeCliOutput(finalOutput, "已完成工作区分片执行。");
        resolve({
          summary,
          commandLabel: invocation.label,
        });
      } catch (err) {
        reject(err);
      }
    });
  });
}

/**
 * 启动本机工作区实时执行器，自动认领、沙盒隔离、流式上报追踪并回写 Unified Diff 与三层仓外记忆。
 */
export function startLocalWorkspaceRunner(
  deps: Readonly<LocalWorkspaceRunnerDeps>,
): LocalWorkspaceRunnerHandle {
  const homeDir = deps.homeDir ?? homedir();
  const runCli = deps.cliExecutor ?? defaultLocalCliExecutor;
  const cliExecutor = async (input: LocalCliExecutionInput): Promise<LocalCliExecutionResult> => {
    const result = await runCli(input);
    if ("attention" in result) throw new WorkAgentAttention(result.attention);
    return result;
  };
  const runCliWithTransientRetry = async (
    input: LocalCliExecutionInput,
  ): Promise<LocalCliExecutionResult> => {
    for (let attempt = 0; ; attempt += 1) {
      if (input.signal.aborted) {
        throw new Error("ABORTED_BY_OWNER");
      }
      try {
        return await cliExecutor(input);
      } catch (err) {
        if (attempt >= 1 || input.signal.aborted || !isTransientCliError(err)) {
          throw err;
        }
        const waitMs = deps.transientRetryDelayMs ?? (isRateLimitCliError(err) ? 5_000 : 3_000);
        if (waitMs > 0) {
          await delay(waitMs, undefined, { signal: input.signal });
        }
      }
    }
  };
  const activeSlices = new Map<
    WorkSliceId,
    {
      readonly controller: AbortController;
      queuedItem?: Readonly<HydratedWorkItemRecord> | undefined;
    }
  >();
  const rootInitChains = new Map<string, Promise<void>>();
  const worktreeInitLocks = new Map<string, Promise<string>>();
  // 原地目录（in_place）单写 FIFO 互斥链：防止多个任务在同一非隔离目录并发写踩踏
  const inPlaceWriteChains = new Map<string, Promise<void>>();
  // 非 Git 普通文件夹按工单缓存首轮写前快照，使后续 verify 分片也能看到完整前后差异
  const folderBaseSnapshots = new Map<string, PlainFolderSnapshot>();
  let stopped = false;

  const withRootInitLock = async <T>(
    rootKey: string,
    signal: AbortSignal,
    fn: () => Promise<T>,
  ): Promise<T> => {
    const predecessor = rootInitChains.get(rootKey);
    let releaseCurrent!: () => void;
    const currentGate = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    const chained = (predecessor ?? Promise.resolve()).then(() => currentGate);
    rootInitChains.set(rootKey, chained);

    try {
      if (predecessor !== undefined) {
        await Promise.race([
          predecessor,
          new Promise<never>((_resolve, reject) => {
            if (signal.aborted) {
              reject(new Error("ABORTED_BY_OWNER"));
              return;
            }
            signal.addEventListener("abort", () => reject(new Error("ABORTED_BY_OWNER")), {
              once: true,
            });
          }),
        ]);
      }
      return await fn();
    } finally {
      releaseCurrent();
      if (rootInitChains.get(rootKey) === chained) {
        rootInitChains.delete(rootKey);
      }
    }
  };

  const acquireDirectoryWriteLock = async (
    dirKey: string,
    signal: AbortSignal,
    onContended: () => Promise<void>,
  ): Promise<() => void> => {
    const predecessor = inPlaceWriteChains.get(dirKey);
    let releaseCurrent!: () => void;
    const currentGate = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    const chained = (predecessor ?? Promise.resolve()).then(() => currentGate);
    inPlaceWriteChains.set(dirKey, chained);

    if (predecessor !== undefined) {
      await onContended();
      await Promise.race([
        predecessor,
        new Promise<never>((_resolve, reject) => {
          if (signal.aborted) {
            reject(new Error("ABORTED_BY_OWNER"));
            return;
          }
          signal.addEventListener("abort", () => reject(new Error("ABORTED_BY_OWNER")), {
            once: true,
          });
        }),
      ]).catch((err) => {
        releaseCurrent();
        if (inPlaceWriteChains.get(dirKey) === chained) {
          inPlaceWriteChains.delete(dirKey);
        }
        throw err;
      });
    }

    return () => {
      releaseCurrent();
      if (inPlaceWriteChains.get(dirKey) === chained) {
        inPlaceWriteChains.delete(dirKey);
      }
    };
  };

  const copyConfiguredEnvFiles = (
    sourceRoot: string,
    worktreeDir: string,
    globs: readonly string[] | undefined,
  ): void => {
    if (!globs || globs.length === 0) {
      return;
    }
    for (const entry of globs) {
      const cleanRel = entry.trim().replace(/^\/+/, "");
      if (cleanRel.length === 0 || cleanRel.includes("..") || cleanRel.includes("*")) {
        continue;
      }
      const src = path.resolve(sourceRoot, cleanRel);
      const dst = path.resolve(worktreeDir, cleanRel);
      if (
        src.startsWith(`${sourceRoot}${path.sep}`) &&
        dst.startsWith(`${worktreeDir}${path.sep}`) &&
        existsSync(src) &&
        !existsSync(dst)
      ) {
        mkdirSync(path.dirname(dst), { recursive: true });
        copyFileSync(src, dst);
      }
    }
  };

  const isValidExistingWorktree = async (
    worktreeDir: string,
    worktreeParent: string,
    repoRoot: string,
    expectedBranch: string,
    signal: AbortSignal,
  ): Promise<boolean> => {
    try {
      const st = lstatSync(worktreeDir);
      if (st.isSymbolicLink() || !st.isDirectory()) return false;
      const destReal = realpathSync(worktreeDir);
      const parentReal = realpathSync(worktreeParent);
      if (destReal !== path.join(parentReal, path.basename(worktreeDir))) return false;
      const toplevel = await gitExec(worktreeDir, ["rev-parse", "--show-toplevel"], signal);
      if (!toplevel || realpathSync(toplevel) !== destReal) return false;
      const [wtCommon, rootCommon, wtBranch] = await Promise.all([
        gitExec(worktreeDir, ["rev-parse", "--path-format=absolute", "--git-common-dir"], signal),
        gitExec(repoRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"], signal),
        gitExec(worktreeDir, ["symbolic-ref", "--short", "HEAD"], signal),
      ]);
      return realpathSync(wtCommon) === realpathSync(rootCommon) && wtBranch === expectedBranch;
    } catch {
      return false;
    }
  };

  const prepareSandboxDir = async (params: {
    readonly workspace: Readonly<HydratedWorkspaceRecord>;
    readonly item: Readonly<HydratedWorkItemRecord>;
    readonly sliceId: WorkSliceId;
    readonly leaseRole: WorkSliceRole;
    readonly ownedPaths: readonly string[];
    readonly actorName: string;
    readonly signal: AbortSignal;
  }): Promise<{
    readonly workingDir: string;
    readonly usedWorktree: boolean;
    readonly isGitRepo: boolean;
    readonly worktreeBranch: string;
  }> => {
    const matchedRoot = selectWorkspaceRootForSlice(params.workspace, params.ownedPaths);
    if (!matchedRoot?.localPath) {
      throw new Error(`工作区「${params.workspace.name}」未配置有效的本地目录路径。`);
    }

    const initialRootDir = assertSafeLocalWorkspacePath(matchedRoot.localPath, homeDir);
    const rootDir = await withRootInitLock(initialRootDir, params.signal, async () => {
      let resolvedRoot = initialRootDir;
      let createdDirs: readonly string[] = [];
      if (!existsSync(resolvedRoot)) {
        if (params.leaseRole !== "write" || params.workspace.sandboxMode === "read_only") {
          throw new Error(`工作区目录不存在：${resolvedRoot}`);
        }
        const ensured = ensureAutoCreatableLocalWorkspaceDir(matchedRoot.localPath ?? "", homeDir);
        resolvedRoot = ensured.dir;
        createdDirs = ensured.createdDirs;
      }

      if (params.workspace.kind !== "folder" && params.workspace.sandboxMode === "worktree_pool") {
        try {
          const toplevel = await gitExec(
            resolvedRoot,
            ["rev-parse", "--show-toplevel"],
            params.signal,
          ).catch((err: unknown) => {
            if (/not a git repository/i.test((err as { stderr?: string }).stderr ?? "")) return "";
            throw err;
          });
          if (toplevel && realpathSync.native(toplevel) !== realpathSync.native(resolvedRoot)) {
            throw new Error("工作区位于已有 Git 仓库内部，请选择仓库根目录或使用原地模式。");
          }
          if (params.leaseRole === "write") {
            if (!toplevel && createdDirs.includes(resolvedRoot)) {
              await initializeEmptyGitBase(resolvedRoot, matchedRoot.defaultBranch, params.signal);
            } else if (toplevel) {
              const hasHead = await gitExec(
                resolvedRoot,
                ["rev-parse", "--verify", "--quiet", "HEAD"],
                params.signal,
              )
                .then(() => true)
                .catch((err: unknown) => {
                  if ((err as { code?: number }).code === 1) return false;
                  throw err;
                });
              if (!hasHead) {
                const [status, tracked] = await Promise.all([
                  gitExec(resolvedRoot, ["status", "--porcelain", "-uall"], params.signal),
                  gitExec(resolvedRoot, ["ls-files"], params.signal),
                ]);
                if (status || tracked) {
                  throw new Error(
                    "Git 仓库尚无初始提交且目录已有未提交文件，请先提交初始 commit 或切换为原地模式。",
                  );
                }
                await createEmptyInitialCommit(resolvedRoot, params.signal);
              }
            }
          }
        } catch (err) {
          removeEmptyCreatedDirs(createdDirs);
          throw err;
        }
      }

      return resolvedRoot;
    });

    const gitRepo = params.workspace.kind !== "folder" && (await isGitWorkingTree(rootDir));
    if (
      params.workspace.sandboxMode !== "worktree_pool" ||
      !gitRepo ||
      params.leaseRole === "read" ||
      (params.leaseRole === "verify" && params.item.topology === "swarm")
    ) {
      return {
        workingDir: rootDir,
        usedWorktree: false,
        isGitRepo: gitRepo,
        worktreeBranch: params.item.worktreeBranch,
      };
    }

    const { effectiveBranch, worktreeDir, worktreeParent } = sliceWorktreeLocation(
      homeDir,
      params.workspace,
      params.item,
      params.sliceId,
      matchedRoot,
    );
    await gitExec(rootDir, ["check-ref-format", "--branch", effectiveBranch], params.signal);

    if (params.leaseRole === "verify") {
      if (
        !(await isValidExistingWorktree(
          worktreeDir,
          worktreeParent,
          rootDir,
          effectiveBranch,
          params.signal,
        ))
      ) {
        throw new Error("未找到写分片的隔离工作树，请恢复工作树后再复核。");
      }
      return {
        workingDir: worktreeDir,
        usedWorktree: true,
        isGitRepo: true,
        worktreeBranch: effectiveBranch,
      };
    }

    const lockKey = worktreeDir;
    const existingInit = worktreeInitLocks.get(lockKey);
    if (existingInit !== undefined) {
      return {
        workingDir: await existingInit,
        usedWorktree: true,
        isGitRepo: true,
        worktreeBranch: effectiveBranch,
      };
    }

    const initTask = (async () => {
      try {
        mkdirSync(worktreeParent, { recursive: true, mode: 0o700 });

        let existingStat: ReturnType<typeof lstatSync> | undefined;
        try {
          existingStat = lstatSync(worktreeDir);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
            throw err;
          }
        }

        if (existingStat !== undefined) {
          if (existingStat.isSymbolicLink() || !existingStat.isDirectory()) {
            throw new Error("已有工作树与工单分支不一致，请检查工作树后重试。");
          }
          if (
            await isValidExistingWorktree(
              worktreeDir,
              worktreeParent,
              rootDir,
              effectiveBranch,
              params.signal,
            )
          ) {
            return worktreeDir;
          }
          const destReal = realpathSync(worktreeDir);
          const parentReal = realpathSync(worktreeParent);
          if (destReal !== path.join(parentReal, path.basename(worktreeDir))) {
            throw new Error("已有工作树与工单分支不一致，请检查工作树后重试。");
          }
          try {
            rmdirSync(worktreeDir);
          } catch {
            throw new Error("已有工作树与工单分支不一致，请检查工作树后重试。");
          }
        }

        await deps.workspacesService.appendLiveTrace({
          workItemId: params.item.id,
          sliceId: params.sliceId,
          actorName: params.actorName,
          kind: "sandbox",
          message: `正在创建隔离 Git Worktree（分支 ${effectiveBranch}）…`,
          liveSummary: `正在准备隔离工作树 ${effectiveBranch}…`,
        });

        await gitExec(rootDir, ["worktree", "prune"], params.signal).catch(() => undefined);
        const branchExists = await gitExec(
          rootDir,
          ["show-ref", "--verify", "--quiet", `refs/heads/${effectiveBranch}`],
          params.signal,
        )
          .then(() => true)
          .catch(() => false);
        if (branchExists) {
          await gitExec(
            rootDir,
            ["worktree", "add", "--", worktreeDir, effectiveBranch],
            params.signal,
          );
          const checkedOutBranch = await gitExec(
            worktreeDir,
            ["symbolic-ref", "--short", "HEAD"],
            params.signal,
          );
          if (checkedOutBranch !== effectiveBranch) {
            throw new Error("已有工作树与工单分支不一致，请检查工作树后重试。");
          }
        } else {
          await gitExec(
            rootDir,
            ["worktree", "add", "-b", effectiveBranch, "--", worktreeDir, "HEAD"],
            params.signal,
          );
        }

        copyConfiguredEnvFiles(rootDir, worktreeDir, params.workspace.hooks.copyEnvGlobs);

        if (params.workspace.hooks.setupCommand) {
          await deps.workspacesService.appendLiveTrace({
            workItemId: params.item.id,
            sliceId: params.sliceId,
            actorName: params.actorName,
            kind: "command",
            message: `执行工作树初始化钩子：${params.workspace.hooks.setupCommand}`,
          });
          await runShellHookCommand({
            command: params.workspace.hooks.setupCommand,
            cwd: worktreeDir,
            env: {
              ...process.env,
              HOME: homeDir,
              PATH: buildCliSearchDirs(homeDir, deps.pathEnv).join(
                process.platform === "win32" ? ";" : ":",
              ),
            },
            signal: params.signal,
            onOutputLine: () => undefined,
          });
        }
        return worktreeDir;
      } finally {
        worktreeInitLocks.delete(lockKey);
      }
    })();

    worktreeInitLocks.set(lockKey, initTask);
    return {
      workingDir: await initTask,
      usedWorktree: true,
      isGitRepo: true,
      worktreeBranch: effectiveBranch,
    };
  };

  const executeSingleSlice = async (
    initialItem: Readonly<HydratedWorkItemRecord>,
    sliceId: WorkSliceId,
  ): Promise<void> => {
    if (stopped || activeSlices.has(sliceId)) {
      return;
    }
    const targetSlice = initialItem.slices.find((s) => s.sliceId === sliceId);
    if (!targetSlice) {
      return;
    }

    const controller = new AbortController();
    let releaseDirLock: (() => void) | undefined;
    activeSlices.set(sliceId, { controller });

    try {
      const [workspace, agentIdentity] = await Promise.all([
        deps.repo.findWorkspaceById(initialItem.workspaceId),
        deps.repo.findAgentIdentityById(targetSlice.assignedAgentId),
      ]);
      if (!workspace || workspace.hostMode !== "local_machine" || !agentIdentity) {
        return;
      }
      if (agentIdentity.ownerUserId !== initialItem.workspaceOwnerUserId) {
        return;
      }

      const agentCaller: AuthenticatedCaller = {
        kind: "agent",
        agentId: agentIdentity.agentId,
        ownerUserId: agentIdentity.ownerUserId,
        displayName: agentIdentity.displayName,
        platform: agentIdentity.platform,
      };

      controller.signal.throwIfAborted();
      const claimed = await deps.workspacesService.claimSlice(
        agentCaller,
        initialItem.id,
        sliceId,
        {
          leaseTtlMs: 90_000,
          agentEnvironment: `local:${agentIdentity.platform}`,
        },
      );
      const leaseVersion = claimed.claimedSlice.leaseVersion;

      appendProvenanceJsonl({
        homeDir,
        agentSlug: agentIdentity.slug,
        workspaceId: workspace.id,
        workItemId: initialItem.id,
        kind: "lease_claimed",
        summary: `Claimed slice ${targetSlice.title} (v${String(leaseVersion)})`,
      });

      let sandbox: {
        readonly workingDir: string;
        readonly usedWorktree: boolean;
        readonly isGitRepo: boolean;
        readonly worktreeBranch: string;
      };
      try {
        sandbox = await prepareSandboxDir({
          workspace,
          item: initialItem,
          sliceId,
          leaseRole: targetSlice.leaseRole,
          ownedPaths: targetSlice.ownedPaths,
          actorName: agentIdentity.displayName,
          signal: controller.signal,
        });
      } catch (sandboxErr) {
        if (controller.signal.aborted) return;
        const reason = sandboxErr instanceof Error ? sandboxErr.message : String(sandboxErr);
        await deps.workspacesService.appendLiveTrace({
          workItemId: initialItem.id,
          sliceId,
          actorName: agentIdentity.displayName,
          kind: "error",
          message: reason,
        });
        await deps.workspacesService.raiseAttention(agentCaller, initialItem.id, sliceId, {
          leaseVersion,
          question: `${reason} 请检查工作区路径后选择下一步操作：`,
          options: ["我已修复工作区目录，继续执行", "先使用只读分析继续"],
        });
        return;
      }

      controller.signal.throwIfAborted();
      if (!sandbox.usedWorktree && targetSlice.leaseRole === "write") {
        releaseDirLock = await acquireDirectoryWriteLock(
          sandbox.workingDir,
          controller.signal,
          async () => {
            await deps.workspacesService.appendLiveTrace({
              workItemId: initialItem.id,
              sliceId,
              actorName: agentIdentity.displayName,
              kind: "sandbox",
              message: "当前目录存在正在执行的原地写任务，已进入单写互斥队列等待…",
              liveSummary: "等待原地目录单写互斥锁释放…",
            });
          },
        );
      }

      const staticSwarmReview =
        initialItem.topology === "swarm" && targetSlice.leaseRole === "verify";
      const folderSnapKey = `${initialItem.id}:${sandbox.workingDir}`;
      if (!staticSwarmReview && !sandbox.isGitRepo && !folderBaseSnapshots.has(folderSnapKey)) {
        folderBaseSnapshots.set(
          folderSnapKey,
          await capturePlainFolderSnapshot(sandbox.workingDir),
        );
      }

      const collectCurrentDiff = async (): Promise<WorkingTreeDiffSnapshot> => {
        if (staticSwarmReview) {
          // This directory is only the reviewer's starting location. Its diff belongs to the owner.
          return { changedFiles: [], diffAdded: 0, diffRemoved: 0, diffFiles: [] };
        }
        if (sandbox.isGitRepo) {
          return collectWorkingTreeDiff(sandbox.workingDir);
        }
        const before = folderBaseSnapshots.get(folderSnapKey) ?? new Map<string, string>();
        const after = await capturePlainFolderSnapshot(sandbox.workingDir);
        return diffPlainFolderSnapshots(before, after);
      };

      // 流式输出聚合缓冲器：按 380ms 窗口合并连续终端行，兼顾实时观感与写入吞吐
      const pendingLines: string[] = [];
      let flushTimer: ReturnType<typeof setTimeout> | null = null;
      const flushOutputTrace = async (): Promise<void> => {
        if (pendingLines.length === 0 || controller.signal.aborted) {
          return;
        }
        const batch = pendingLines.splice(0, pendingLines.length);
        const headline = batch[batch.length - 1] ?? "";
        await deps.workspacesService
          .appendLiveTrace({
            workItemId: initialItem.id,
            sliceId,
            actorName: agentIdentity.displayName,
            kind: "output",
            message: headline.slice(0, 220),
            ...(batch.length > 1 ? { detail: batch.slice(-8).join("\n") } : {}),
            liveSummary: headline.slice(0, 180),
          })
          .catch(() => undefined);
      };

      const pushOutputLine = (line: string): void => {
        pendingLines.push(line);
        if (flushTimer === null) {
          flushTimer = setTimeout(() => {
            flushTimer = null;
            void flushOutputTrace();
          }, OUTPUT_TRACE_FLUSH_MS);
        }
      };

      // 周期性租约续期 + 实时增量 Diff 探测（同时支持 Git 仓库与普通文件夹）
      let lastDiffSignature = "0:0";
      const heartbeatInterval = setInterval(() => {
        if (controller.signal.aborted) return;
        void (async () => {
          const liveDiff = await collectCurrentDiff().catch(() => ({
            changedFiles: [] as readonly string[],
            diffAdded: 0,
            diffRemoved: 0,
            diffFiles: [] as readonly WorkDiffFileDto[],
          }));
          const sig = `${String(liveDiff.diffAdded)}:${String(liveDiff.diffRemoved)}`;
          const diffChanged = sig !== lastDiffSignature && liveDiff.diffFiles.length > 0;
          lastDiffSignature = sig;

          await deps.workspacesService
            .heartbeatSlice(agentCaller, initialItem.id, sliceId, {
              leaseVersion,
              leaseTtlMs: 90_000,
              diffAdded: liveDiff.diffAdded,
              diffRemoved: liveDiff.diffRemoved,
            })
            .catch((err: unknown) => {
              if (
                err instanceof AppError &&
                ([401, 403, 404, 409].includes(err.statusCode) || err.code === "WORK_LEASE_EXPIRED")
              ) {
                controller.abort(err);
              }
            });

          if (diffChanged && !controller.signal.aborted) {
            await deps.workspacesService
              .appendLiveTrace({
                workItemId: initialItem.id,
                sliceId,
                actorName: agentIdentity.displayName,
                kind: "diff",
                message: `检测到工作区变更：${String(liveDiff.diffFiles.length)} 个文件（+${String(liveDiff.diffAdded)} / -${String(liveDiff.diffRemoved)}）`,
                detail: liveDiff.changedFiles.slice(0, 8).join("\n"),
                diffAdded: liveDiff.diffAdded,
                diffRemoved: liveDiff.diffRemoved,
              })
              .catch(() => undefined);
          }
        })();
      }, SLICE_HEARTBEAT_INTERVAL_MS);

      try {
        let verifyHookPassed: boolean | undefined;
        let verifyHookReport: string | undefined;
        let currentDiff = await collectCurrentDiff();

        if (staticSwarmReview) {
          const writeSources: string[] = [];
          for (const writer of initialItem.slices.filter((slice) => slice.leaseRole === "write")) {
            const root = selectWorkspaceRootForSlice(workspace, writer.ownedPaths);
            if (!root?.localPath) throw new Error("写分片缺少可复核的工作目录。");
            let dir = assertSafeLocalWorkspacePath(root.localPath, homeDir);
            if (writer.worktreeBranch && workspace.sandboxMode === "worktree_pool") {
              const loc = sliceWorktreeLocation(
                homeDir,
                workspace,
                initialItem,
                writer.sliceId,
                root,
              );
              if (
                writer.worktreeBranch !== loc.effectiveBranch ||
                !(await isValidExistingWorktree(
                  loc.worktreeDir,
                  loc.worktreeParent,
                  dir,
                  loc.effectiveBranch,
                  controller.signal,
                ))
              ) {
                throw new Error(`写分片「${writer.title}」的工作树不可用，请恢复后复核。`);
              }
              dir = loc.worktreeDir;
            }
            if (!existsSync(dir)) throw new Error(`写分片「${writer.title}」的工作目录不存在。`);
            writeSources.push(
              `- ${writer.title}: ${dir} (files: ${writer.changedFiles.join(", ") || "none reported"})`,
            );
          }
          verifyHookReport = [
            "Static review: inspect each writer's actual files and diffs in the directories below. The base checkout does not contain the combined changes. No automated verify command ran.",
            ...writeSources,
          ].join("\n");
          await deps.workspacesService.appendLiveTrace({
            workItemId: initialItem.id,
            sliceId,
            actorName: agentIdentity.displayName,
            kind: "review",
            message: "多路变更分属不同写分片，本次基于各分片提交的差异进行静态复核。",
          });
        } else if (targetSlice.leaseRole === "verify" && workspace.hooks.verifyCommand) {
          const verifyCmd = workspace.hooks.verifyCommand;
          await deps.workspacesService.appendLiveTrace({
            workItemId: initialItem.id,
            sliceId,
            actorName: agentIdentity.displayName,
            kind: "command",
            message: `执行自动化校验命令：${verifyCmd}`,
            liveSummary: `正在运行校验命令 ${verifyCmd}…`,
          });

          const hookRes = await runShellHookCommand({
            command: verifyCmd,
            cwd: sandbox.workingDir,
            env: {
              ...process.env,
              HOME: homeDir,
              PATH: buildCliSearchDirs(homeDir, deps.pathEnv).join(
                process.platform === "win32" ? ";" : ":",
              ),
            },
            signal: controller.signal,
            onOutputLine: pushOutputLine,
          });
          verifyHookPassed = hookRes.passed;
          verifyHookReport = `Command: ${verifyCmd}\nResult: ${hookRes.passed ? "PASSED (exit 0)" : "FAILED (non-zero exit)"}\nOutput:\n${hookRes.outputTail}`;

          await deps.workspacesService.appendLiveTrace({
            workItemId: initialItem.id,
            sliceId,
            actorName: agentIdentity.displayName,
            kind: hookRes.passed ? "review" : "error",
            message: hookRes.passed ? `校验命令通过：${verifyCmd}` : `校验命令未通过：${verifyCmd}`,
            ...(hookRes.outputTail.length > 0 ? { detail: hookRes.outputTail } : {}),
          });
        }

        const freshItem = await deps.repo.findHydratedWorkItemById(initialItem.id);
        const freshSlice = freshItem?.slices.find((s) => s.sliceId === sliceId) ?? targetSlice;
        const initialSteerCount = freshSlice.steerNotes.length;
        const rollingMemory = readRollingMemoryContext(homeDir, agentIdentity.slug, workspace.id);

        await deps.workspacesService.appendLiveTrace({
          workItemId: initialItem.id,
          sliceId,
          actorName: agentIdentity.displayName,
          kind: "command",
          message:
            targetSlice.leaseRole === "verify"
              ? `正在启动 ${agentIdentity.displayName} 执行独立代码复核…`
              : `正在启动 ${agentIdentity.displayName} 执行分片「${freshSlice.title}」…`,
          detail: sandbox.workingDir,
          liveSummary:
            targetSlice.leaseRole === "verify"
              ? "正在审阅变更与测试结果…"
              : `正在 ${path.basename(sandbox.workingDir)} 中执行任务…`,
        });

        const promptDiffFiles =
          currentDiff.diffFiles.length > 0
            ? currentDiff.diffFiles
            : (freshItem ?? initialItem).diffFiles;
        const prompt = buildExecutionPrompt({
          item: freshItem ?? initialItem,
          sliceTitle: freshSlice.title,
          role: freshSlice.leaseRole,
          ownedPaths: freshSlice.ownedPaths,
          steerNotes: freshSlice.steerNotes,
          rollingMemory,
          verifyHookReport,
          diffFiles: promptDiffFiles,
        });

        let cliResult = await runCliWithTransientRetry({
          platform: agentIdentity.platform,
          agentName: agentIdentity.displayName,
          role: freshSlice.leaseRole,
          tier: (freshItem ?? initialItem).tier,
          workingDir: sandbox.workingDir,
          prompt,
          homeDir,
          pathEnv: deps.pathEnv,
          signal: controller.signal,
          onOutputLine: pushOutputLine,
        });

        if (freshSlice.leaseRole === "verify" && !controller.signal.aborted) {
          if (cliResult.verdict === undefined) {
            const parsedInline = parseWorkVerdict(cliResult.summary);
            if (parsedInline !== undefined) {
              cliResult = {
                ...cliResult,
                summary:
                  cliResult.summary.slice(0, parsedInline.summaryEndIndex).trim() ||
                  "已完成独立代码复核。",
                verdict: parsedInline.verdict,
              };
            }
          }
          if (cliResult.verdict === undefined) {
            const draftSummary = scrubWorkText(cliResult.summary.trim()).slice(-1000);
            const followup = await runCliWithTransientRetry({
              platform: agentIdentity.platform,
              agentName: agentIdentity.displayName,
              role: freshSlice.leaseRole,
              tier: (freshItem ?? initialItem).tier,
              workingDir: sandbox.workingDir,
              prompt: [
                prompt,
                "Your previous independent verification response did not end with a clear final verdict line.",
                ...(draftSummary.length > 0 ? [`Previous review draft:\n${draftSummary}`] : []),
                "Provide a concise summary of your review findings and end the last non-empty line with exactly VERDICT: PASSED or VERDICT: CHANGES_REQUESTED (or use NEEDS_INPUT if owner input is truly required).",
              ].join("\n\n"),
              homeDir,
              pathEnv: deps.pathEnv,
              signal: controller.signal,
              onOutputLine: pushOutputLine,
            });
            const resolvedFollowup =
              followup.verdict !== undefined
                ? { verdict: followup.verdict, summary: followup.summary }
                : (() => {
                    const parsed = parseWorkVerdict(followup.summary);
                    if (!parsed) return undefined;
                    return {
                      verdict: parsed.verdict,
                      summary: followup.summary.slice(0, parsed.summaryEndIndex).trim(),
                    };
                  })();
            if (resolvedFollowup !== undefined) {
              cliResult = {
                summary: resolvedFollowup.summary.trim() || draftSummary || "已完成独立代码复核。",
                verdict: resolvedFollowup.verdict,
                commandLabel: followup.commandLabel,
              };
            }
          }
          if (cliResult.verdict === undefined) {
            throw new Error("复核 Agent 未返回明确的最终判定。");
          }
          if (cliResult.summary.trim().length === 0) {
            cliResult = { ...cliResult, summary: "已完成独立代码复核。" };
          }
        }

        // 检查执行期间人类主人是否注入了新的实时补充指令（Mid-Flight Steer），若有则在同一沙盒目录立即增量落地
        if (freshSlice.leaseRole === "write" && !controller.signal.aborted) {
          const postTurnItem = await deps.repo.findHydratedWorkItemById(initialItem.id);
          const postTurnSlice = postTurnItem?.slices.find((s) => s.sliceId === sliceId);
          const newlyArrivedSteer = postTurnSlice?.steerNotes.slice(initialSteerCount) ?? [];
          if (newlyArrivedSteer.length > 0 && postTurnItem) {
            await deps.workspacesService.appendLiveTrace({
              workItemId: initialItem.id,
              sliceId,
              actorName: agentIdentity.displayName,
              kind: "steer",
              message: `检测到执行期间新增 ${String(newlyArrivedSteer.length)} 条补充指令，正在增量执行调整…`,
              detail: newlyArrivedSteer.join("\n"),
              liveSummary: "正在按补充指令增量调整…",
            });
            cliResult = await runCliWithTransientRetry({
              platform: agentIdentity.platform,
              agentName: agentIdentity.displayName,
              role: freshSlice.leaseRole,
              tier: postTurnItem.tier,
              workingDir: sandbox.workingDir,
              prompt: buildExecutionPrompt({
                item: postTurnItem,
                sliceTitle: freshSlice.title,
                role: freshSlice.leaseRole,
                ownedPaths: freshSlice.ownedPaths,
                steerNotes: newlyArrivedSteer,
                isFollowUpSteerPass: true,
              }),
              homeDir,
              pathEnv: deps.pathEnv,
              signal: controller.signal,
              onOutputLine: pushOutputLine,
            });
          }
        }

        if (flushTimer !== null) {
          clearTimeout(flushTimer);
          flushTimer = null;
        }
        await flushOutputTrace();

        controller.signal.throwIfAborted();
        currentDiff = await collectCurrentDiff();
        controller.signal.throwIfAborted();
        // 心跳周期内未捕捉到的最终变更（短任务常见）在收尾时补记，保证追踪时间线与审阅 Diff 一致
        const finalDiffSignature = `${String(currentDiff.diffAdded)}:${String(currentDiff.diffRemoved)}`;
        if (currentDiff.diffFiles.length > 0 && finalDiffSignature !== lastDiffSignature) {
          lastDiffSignature = finalDiffSignature;
          await deps.workspacesService
            .appendLiveTrace({
              workItemId: initialItem.id,
              sliceId,
              actorName: agentIdentity.displayName,
              kind: "diff",
              message: `最终变更：${String(currentDiff.diffFiles.length)} 个文件（+${String(currentDiff.diffAdded)} / -${String(currentDiff.diffRemoved)}）`,
              detail: currentDiff.changedFiles.slice(0, 8).join("\n"),
              diffAdded: currentDiff.diffAdded,
              diffRemoved: currentDiff.diffRemoved,
            })
            .catch(() => undefined);
        }
        const logPath = appendProvenanceJsonl({
          homeDir,
          agentSlug: agentIdentity.slug,
          workspaceId: workspace.id,
          workItemId: initialItem.id,
          kind: freshSlice.leaseRole === "verify" ? "verify_completed" : "task_settled",
          summary: cliResult.summary,
          files: currentDiff.changedFiles,
        });

        const rollingMemoryPath = writeRollingWorkspaceMemory({
          homeDir,
          agentSlug: agentIdentity.slug,
          workspaceId: workspace.id,
          workspaceName: workspace.name,
          workItemId: initialItem.id,
          title: initialItem.title,
          summary: cliResult.summary,
          changedFiles: currentDiff.changedFiles,
        });

        const gitNotesAttached =
          sandbox.isGitRepo && freshSlice.leaseRole === "write"
            ? await tryAttachGitProvenanceNote({
                repoDir: sandbox.workingDir,
                workItemId: initialItem.id,
                workspaceId: workspace.id,
                agentSlug: agentIdentity.slug,
                summary: cliResult.summary,
              })
            : false;

        const finalVerdict =
          freshSlice.leaseRole === "verify"
            ? verifyHookPassed === false
              ? ("changes_requested" as const)
              : cliResult.verdict
            : undefined;

        await deps.workspacesService.completeSlice(agentCaller, initialItem.id, sliceId, {
          leaseVersion,
          summary: cliResult.summary,
          changedFiles: [...currentDiff.changedFiles],
          diffAdded: currentDiff.diffAdded,
          diffRemoved: currentDiff.diffRemoved,
          diffFiles: currentDiff.diffFiles.map((file) => ({
            ...file,
            lines: [...file.lines],
          })),
          ...(sandbox.usedWorktree ? { worktreeBranch: sandbox.worktreeBranch } : {}),
          ...(verifyHookPassed !== undefined && workspace.hooks.verifyCommand !== undefined
            ? {
                testCommand: workspace.hooks.verifyCommand,
                testPassed: verifyHookPassed,
              }
            : {}),
          ...(finalVerdict !== undefined ? { verdict: finalVerdict } : {}),
          provenance: {
            agentEnvironment:
              `${workspace.hostLabel} · ${agentIdentity.platform} (${cliResult.commandLabel})`.slice(
                0,
                120,
              ),
            leaseRole: freshSlice.leaseRole,
            sessionJsonlPath: logPath,
            rollingMemoryPath,
            gitNotesAttached,
          },
        });
      } catch (execErr) {
        if (flushTimer !== null) {
          clearTimeout(flushTimer);
          flushTimer = null;
        }
        await flushOutputTrace();

        if (controller.signal.aborted) {
          return;
        }
        if (execErr instanceof WorkAgentAttention) {
          await deps.workspacesService.raiseAttention(agentCaller, initialItem.id, sliceId, {
            leaseVersion,
            ...execErr.attention,
          });
          return;
        }
        const errMessage = execErr instanceof Error ? execErr.message : String(execErr);
        await deps.workspacesService
          .appendLiveTrace({
            workItemId: initialItem.id,
            sliceId,
            actorName: agentIdentity.displayName,
            kind: "error",
            message: `执行异常中断：${errMessage}`,
          })
          .catch(() => undefined);

        await deps.workspacesService
          .raiseAttention(agentCaller, initialItem.id, sliceId, {
            leaseVersion,
            question: `本机执行器遇到问题：${errMessage}`,
            options: ["已处理环境问题，重试当前分片", "补充说明后继续"],
          })
          .catch(() => undefined);
      } finally {
        clearInterval(heartbeatInterval);
      }
    } catch (outerErr) {
      deps.logger?.debug(
        { err: outerErr, workItemId: initialItem.id, sliceId },
        "LocalWorkspaceRunner skipped or aborted slice claim",
      );
    } finally {
      releaseDirLock?.();
      const queuedItem = activeSlices.get(sliceId)?.queuedItem;
      activeSlices.delete(sliceId);
      if (queuedItem && !stopped) void executeSingleSlice(queuedItem, sliceId);
    }
  };

  const inspectAndScheduleItem = (item: Readonly<HydratedWorkItemRecord>): void => {
    if (stopped || item.workspaceHostMode !== "local_machine") {
      return;
    }

    if (item.stage === "done" || item.stage === "cancelled") {
      for (const key of folderBaseSnapshots.keys()) {
        if (key.startsWith(`${item.id}:`)) {
          folderBaseSnapshots.delete(key);
        }
      }
    }

    for (const slice of item.slices) {
      const active = activeSlices.get(slice.sliceId);
      if (!active) continue;
      const runnableStage = item.stage === (slice.leaseRole === "verify" ? "verifying" : "working");
      if (!runnableStage) active.controller.abort();
      // A fast resume can requeue a slice while the previous process is still stopping.
      active.queuedItem =
        runnableStage && active.controller.signal.aborted && slice.status === "waiting"
          ? item
          : undefined;
    }

    if (item.stage === "working") {
      for (const slice of item.slices) {
        if (slice.leaseRole !== "verify" && slice.status === "waiting") {
          void executeSingleSlice(item, slice.sliceId);
        }
      }
      return;
    }

    if (item.stage === "verifying") {
      for (const slice of item.slices) {
        if (slice.leaseRole === "verify" && slice.status === "waiting") {
          void executeSingleSlice(item, slice.sliceId);
        }
      }
    }
  };

  const unsubscribe = deps.workspacesService.onWorkItemUpdated((item) => {
    inspectAndScheduleItem(item);
  });

  // 启动恢复扫描：接管进程重启前遗留在 waiting 状态的本机分片
  void deps.repo
    .listActiveLocalMachineWorkItems()
    .then((items) => {
      for (const item of items) {
        inspectAndScheduleItem(item);
      }
    })
    .catch((err: unknown) => {
      deps.logger?.warn({ err }, "LocalWorkspaceRunner startup recovery scan failed");
    });

  return {
    stop: async () => {
      stopped = true;
      unsubscribe();
      for (const active of activeSlices.values()) {
        active.controller.abort();
      }
      activeSlices.clear();
      folderBaseSnapshots.clear();
    },
  };
}
