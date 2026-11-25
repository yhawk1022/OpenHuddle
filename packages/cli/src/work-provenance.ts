/**
 * @module cli/work-provenance
 * @description 各 Agent 宿主环境「三层分离」工作记录与溯源引擎（对齐 ADR-0010 业界最佳实践）：
 * 1. 第 1 层（仓外冷全量事件流）：`~/.openhuddle/agents/<slug>/sessions/<workspace>/<task>.jsonl`（原子追加 + 0600 私密权限 + 强制脱敏）；
 * 2. 第 2 层（定长滚动热记忆）：`~/.openhuddle/agents/<slug>/memory/<workspace>/MEMORY.md`（硬上限 ≤ 200 行 / 24KB，tmp+rename 原子替换，根治 Context Rot）；
 * 3. 第 3 层（零污染 Git 代码溯源）：通过 `git notes --ref=openhuddle` 将结构化任务上下文挂载到目标 Commit，保持业务工作树 `git status` 100% 干净。
 */
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { scrubSensitiveText } from "./secret-scrubber.js";

/** Claude Code / ADR-0010 热记忆硬上限：严格不超过 200 行且不超过 24KB，防止上下文膨胀退化 */
export const MAX_ROLLING_MEMORY_LINES = 200;
export const MAX_ROLLING_MEMORY_BYTES = 24 * 1024;
const DEFAULT_MAX_MEMORY_ENTRIES = 12;

/**
 * 仓外会话 JSONL 事件类别。
 */
export type ProvenanceEventKind =
  | "lease_claimed"
  | "file_modified"
  | "command_executed"
  | "steer_received"
  | "attention_resolved"
  | "verify_completed"
  | "task_settled";

/**
 * 单条原子落盘的本地工作事件记录。
 */
export interface TaskSessionEvent {
  readonly timestampIso: string;
  readonly taskId: string;
  readonly workspaceId: string;
  readonly agentSlug: string;
  readonly kind: ProvenanceEventKind;
  readonly summary: string;
  readonly hostEnvironment?: string | undefined;
  readonly roomId?: string | undefined;
  readonly files?: ReadonlyArray<string> | undefined;
  readonly command?: string | undefined;
  readonly exitCode?: number | undefined;
}

/**
 * 写入定长滚动 `MEMORY.md` 的单条精炼任务记忆入参。
 */
export interface RollingMemoryEntryInput {
  readonly openhuddleHome: string;
  readonly agentSlug: string;
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly taskId: string;
  readonly recordedAtIso: string;
  readonly title: string;
  readonly outcomeSummary: string;
  readonly keyDecisions?: ReadonlyArray<string> | undefined;
  readonly touchedFiles?: ReadonlyArray<string> | undefined;
  readonly maxEntries?: number | undefined;
}

/**
 * 挂载到 Git Notes（`refs/notes/openhuddle`）的结构化溯源载荷。
 */
export interface GitProvenanceNoteInput {
  readonly repoDir: string;
  readonly commitRef?: string | undefined;
  readonly taskId: string;
  readonly workspaceId: string;
  readonly agentSlug: string;
  readonly verifierSlug?: string | undefined;
  readonly roomId?: string | undefined;
  readonly summary: string;
  readonly verifyCommand?: string | undefined;
  readonly verifyPassed?: boolean | undefined;
  readonly recordedAtIso: string;
}

function sanitizePathSegment(raw: string): string {
  const cleaned = raw.trim().replace(/[^a-zA-Z0-9._-]/g, "_");
  return cleaned.length > 0 ? cleaned.slice(0, 96) : "default";
}

function ensurePrivateDir(dirPath: string): void {
  mkdirSync(dirPath, { recursive: true, mode: 0o700 });
}

function writeAtomicPrivateFile(targetPath: string, content: string): void {
  const dir = dirname(targetPath);
  ensurePrivateDir(dir);
  const tmpPath = join(
    dir,
    `.oh-mem-${String(process.pid)}-${Math.random().toString(36).slice(2, 8)}.tmp`,
  );
  const fd = openSync(tmpPath, "w", 0o600);
  try {
    writeSync(fd, content, undefined, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmpPath, targetPath);
}

/**
 * 计算某个任务在指定 Agent 本机环境下的仓外会话 JSONL 路径。
 *
 * @param openhuddleHome - 本机 `~/.openhuddle` 根目录
 * @param agentSlug - Agent 唯一短标识
 * @param workspaceId - 工作区标识
 * @param taskId - 任务 ID
 * @returns 仓外 JSONL 文件绝对路径
 */
export function resolveTaskSessionJsonlPath(
  openhuddleHome: string,
  agentSlug: string,
  workspaceId: string,
  taskId: string,
): string {
  return join(
    openhuddleHome,
    "agents",
    sanitizePathSegment(agentSlug),
    "sessions",
    sanitizePathSegment(workspaceId),
    `${sanitizePathSegment(taskId)}.jsonl`,
  );
}

/**
 * 计算指定 Agent 针对某工作区的仓外滚动 `MEMORY.md` 路径。
 *
 * @param openhuddleHome - 本机 `~/.openhuddle` 根目录
 * @param agentSlug - Agent 唯一短标识
 * @param workspaceId - 工作区标识
 * @returns 仓外 `MEMORY.md` 绝对路径
 */
export function resolveRollingMemoryPath(
  openhuddleHome: string,
  agentSlug: string,
  workspaceId: string,
): string {
  return join(
    openhuddleHome,
    "agents",
    sanitizePathSegment(agentSlug),
    "memory",
    sanitizePathSegment(workspaceId),
    "MEMORY.md",
  );
}

/**
 * 向仓外会话事件流原子追加一条已脱敏的结构化事件。
 *
 * @param openhuddleHome - 本机 `~/.openhuddle` 根目录
 * @param event - 待记录的会话事件
 * @returns 写入的目标 JSONL 文件路径
 */
export function appendTaskSessionEvent(openhuddleHome: string, event: TaskSessionEvent): string {
  const filePath = resolveTaskSessionJsonlPath(
    openhuddleHome,
    event.agentSlug,
    event.workspaceId,
    event.taskId,
  );
  ensurePrivateDir(dirname(filePath));

  const scrubbed: TaskSessionEvent = {
    timestampIso: event.timestampIso,
    taskId: event.taskId,
    workspaceId: event.workspaceId,
    agentSlug: event.agentSlug,
    kind: event.kind,
    summary: scrubSensitiveText(event.summary),
    ...(event.hostEnvironment !== undefined
      ? { hostEnvironment: scrubSensitiveText(event.hostEnvironment) }
      : {}),
    ...(event.roomId !== undefined ? { roomId: event.roomId } : {}),
    ...(event.files !== undefined ? { files: event.files.map((f) => scrubSensitiveText(f)) } : {}),
    ...(event.command !== undefined ? { command: scrubSensitiveText(event.command) } : {}),
    ...(event.exitCode !== undefined ? { exitCode: event.exitCode } : {}),
  };

  appendFileSync(filePath, `${JSON.stringify(scrubbed)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return filePath;
}

/**
 * 读取并解析某个任务的本地仓外 JSONL 事件序列（自动跳过极端断电产生的残缺尾行）。
 *
 * @param openhuddleHome - 本机 `~/.openhuddle` 根目录
 * @param agentSlug - Agent 唯一短标识
 * @param workspaceId - 工作区标识
 * @param taskId - 任务 ID
 * @returns 已落盘的事件数组
 */
export function readTaskSessionEvents(
  openhuddleHome: string,
  agentSlug: string,
  workspaceId: string,
  taskId: string,
): ReadonlyArray<TaskSessionEvent> {
  const filePath = resolveTaskSessionJsonlPath(openhuddleHome, agentSlug, workspaceId, taskId);
  if (!existsSync(filePath)) {
    return [];
  }
  const raw = readFileSync(filePath, "utf8");
  const out: TaskSessionEvent[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === "object" && parsed !== null && "taskId" in parsed && "kind" in parsed) {
        out.push(parsed as TaskSessionEvent);
      }
    } catch {
      // 容忍断电导致的末尾残损半行，保证前序事件 100% 可读
    }
  }
  return out;
}

interface ParsedMemoryBlock {
  readonly taskId: string;
  readonly blockText: string;
}

function parseExistingMemoryBlocks(rawMarkdown: string): ReadonlyArray<ParsedMemoryBlock> {
  const regex = /<!-- oh-entry:([^\s>]+) -->\n([\s\S]*?)\n<!-- \/oh-entry -->/g;
  const blocks: ParsedMemoryBlock[] = [];
  for (const match of rawMarkdown.matchAll(regex)) {
    const taskId = match[1]?.trim();
    const body = match[2];
    if (taskId && body !== undefined) {
      blocks.push({
        taskId,
        blockText: `<!-- oh-entry:${taskId} -->\n${body}\n<!-- /oh-entry -->`,
      });
    }
  }
  return blocks;
}

function formatMemoryBlock(input: RollingMemoryEntryInput): ParsedMemoryBlock {
  const safeTaskId = sanitizePathSegment(input.taskId);
  const dateShort = input.recordedAtIso.slice(0, 10);
  const title = scrubSensitiveText(input.title.replace(/\r?\n/g, " ").trim());
  const summary = scrubSensitiveText(input.outcomeSummary.replace(/\r?\n/g, " ").trim());

  const lines: string[] = [
    `<!-- oh-entry:${safeTaskId} -->`,
    `### ${dateShort} · ${title} (\`${safeTaskId}\`)`,
    `- 结论：${summary}`,
  ];

  if (input.keyDecisions && input.keyDecisions.length > 0) {
    const decisions = input.keyDecisions
      .slice(0, 3)
      .map((d) => scrubSensitiveText(d.replace(/\r?\n/g, " ").trim()))
      .join("；");
    lines.push(`- 决策：${decisions}`);
  }

  if (input.touchedFiles && input.touchedFiles.length > 0) {
    const files = input.touchedFiles.slice(0, 5).join(", ");
    const suffix =
      input.touchedFiles.length > 5 ? ` (+${String(input.touchedFiles.length - 5)})` : "";
    lines.push(`- 涉及：\`${files}${suffix}\``);
  }

  lines.push("<!-- /oh-entry -->");
  return {
    taskId: safeTaskId,
    blockText: lines.join("\n"),
  };
}

/**
 * 更新指定 Agent 针对某工作区的定长滚动热记忆 `MEMORY.md`：
 * 新记录置顶、同 `taskId` 幂等覆盖，并严格裁剪至 `≤ 200 行` 且 `≤ 24KB`。
 *
 * @param input - 记忆条目与限额参数
 * @returns 写入后的文档路径、当前保留条数与被滚动淘汰归档的旧条数
 */
export function recordRollingWorkspaceMemory(input: RollingMemoryEntryInput): {
  readonly memoryPath: string;
  readonly keptEntries: number;
  readonly evictedEntries: number;
  readonly lineCount: number;
} {
  const memoryPath = resolveRollingMemoryPath(
    input.openhuddleHome,
    input.agentSlug,
    input.workspaceId,
  );
  const existingBlocks = existsSync(memoryPath)
    ? parseExistingMemoryBlocks(readFileSync(memoryPath, "utf8"))
    : [];

  const freshBlock = formatMemoryBlock(input);
  const deduped = [freshBlock, ...existingBlocks.filter((b) => b.taskId !== freshBlock.taskId)];

  const maxEntries = Math.max(1, input.maxEntries ?? DEFAULT_MAX_MEMORY_ENTRIES);
  const headerLines = [
    `# ${scrubSensitiveText(input.workspaceName)} · Agent 工作记忆 (${sanitizePathSegment(input.agentSlug)})`,
    "",
    "> 由 OpenHuddle 守护进程自动滚动维护（仅保留近期有效上下文，完整历史见同级 sessions/*.jsonl）。",
    "",
  ];

  const kept: ParsedMemoryBlock[] = [];
  for (const candidate of deduped) {
    if (kept.length >= maxEntries) {
      break;
    }
    const trialBlocks = [...kept, candidate];
    const trialContent = `${headerLines.join("\n")}${trialBlocks.map((b) => b.blockText).join("\n\n")}\n`;
    const trialLines = trialContent.split("\n").length;
    const trialBytes = Buffer.byteLength(trialContent, "utf8");

    // 至少保留最新 1 条；从第 2 条起严格执行 200 行与 24KB 双上限裁剪
    if (
      kept.length > 0 &&
      (trialLines > MAX_ROLLING_MEMORY_LINES || trialBytes > MAX_ROLLING_MEMORY_BYTES)
    ) {
      break;
    }
    kept.push(candidate);
  }

  const finalContent = `${headerLines.join("\n")}${kept.map((b) => b.blockText).join("\n\n")}\n`;
  writeAtomicPrivateFile(memoryPath, finalContent);

  return {
    memoryPath,
    keptEntries: kept.length,
    evictedEntries: Math.max(0, deduped.length - kept.length),
    lineCount: finalContent.split("\n").length,
  };
}

/**
 * 将任务溯源元数据挂载到本机 Git 仓库的 `refs/notes/openhuddle` 命名空间，
 * 100% 不污染工作树（`git status` 零脏文件）且不改变 Commit SHA。
 *
 * @param input - 仓库路径、目标 Commit 与任务溯源信息
 */
export function attachGitNoteProvenance(input: GitProvenanceNoteInput): void {
  const targetRef = input.commitRef ?? "HEAD";
  const notePayload = {
    schema: "openhuddle.provenance.v1",
    taskId: input.taskId,
    workspaceId: input.workspaceId,
    agent: input.agentSlug,
    ...(input.verifierSlug !== undefined ? { verifier: input.verifierSlug } : {}),
    ...(input.roomId !== undefined ? { roomId: input.roomId } : {}),
    summary: scrubSensitiveText(input.summary),
    ...(input.verifyCommand !== undefined
      ? { verifyCommand: scrubSensitiveText(input.verifyCommand) }
      : {}),
    ...(input.verifyPassed !== undefined ? { verifyPassed: input.verifyPassed } : {}),
    recordedAtIso: input.recordedAtIso,
  };

  execFileSync(
    "git",
    [
      "notes",
      "--ref=openhuddle",
      "add",
      "-f",
      "-m",
      JSON.stringify(notePayload, null, 2),
      targetRef,
    ],
    {
      cwd: input.repoDir,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

/**
 * 从 `refs/notes/openhuddle` 解析出的强类型溯源记录。
 */
export interface GitProvenanceNoteRecord {
  readonly schema: string;
  readonly taskId: string;
  readonly workspaceId: string;
  readonly agent: string;
  readonly verifier?: string | undefined;
  readonly roomId?: string | undefined;
  readonly summary: string;
  readonly verifyCommand?: string | undefined;
  readonly verifyPassed?: boolean | undefined;
  readonly recordedAtIso: string;
}

/**
 * 从本机 Git 仓库读取指定 Commit 挂载的 `refs/notes/openhuddle` 溯源记录。
 *
 * @param repoDir - Git 仓库根目录
 * @param commitRef - 目标 Commit 引用（默认 `HEAD`）
 * @returns 解析后的强类型溯源对象；若该 Commit 未挂载记录则返回 `null`
 */
export function readGitNoteProvenance(
  repoDir: string,
  commitRef = "HEAD",
): GitProvenanceNoteRecord | null {
  try {
    const raw = execFileSync("git", ["notes", "--ref=openhuddle", "show", commitRef], {
      cwd: repoDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const parsed: unknown = JSON.parse(raw.trim());
    return typeof parsed === "object" && parsed !== null && "taskId" in parsed
      ? (parsed as GitProvenanceNoteRecord)
      : null;
  } catch {
    return null;
  }
}
