/**
 * @module server/modules/workspaces/git-diff-parser
 * @description 真实工作目录 `git diff` 采集与 Unified Diff 结构化解析器（零 Shell 拼接）。
 *
 * 关键不变量：
 * 1. 同时覆盖已追踪文件变更（`git diff HEAD`）与新增未追踪文本文件（`git diff --no-index`），确保新建文件也能在工作台审阅面板完整展示。
 * 2. 对单文件行数与总文件数施加硬上限保护，防止巨型锁文件或构建产物撑爆 JSONB 与前端渲染树。
 */
import { execFile } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { scrubWorkText } from "@openhuddle/core-governance";
import type { WorkDiffFileDto, WorkDiffLineDto } from "@openhuddle/protocol";

const execFileAsync = promisify(execFile);

const MAX_DIFF_FILES = 30;
const MAX_LINES_PER_FILE = 450;
const MAX_UNTRACKED_FILE_BYTES = 128 * 1024;

export interface WorkingTreeDiffSnapshot {
  readonly changedFiles: readonly string[];
  readonly diffAdded: number;
  readonly diffRemoved: number;
  readonly diffFiles: readonly WorkDiffFileDto[];
}

/**
 * 将标准 `git diff --no-color -U3` 文本解析为结构化 `WorkDiffFileDto` 列表。
 */
export function parseUnifiedGitDiff(
  rawDiff: string,
  maxFiles = MAX_DIFF_FILES,
  maxLinesPerFile = MAX_LINES_PER_FILE,
): readonly WorkDiffFileDto[] {
  if (rawDiff.trim().length === 0) {
    return [];
  }

  const files: WorkDiffFileDto[] = [];
  const chunks = rawDiff.split(/^diff --git /m).filter((c) => c.trim().length > 0);

  for (const chunk of chunks) {
    if (files.length >= maxFiles) {
      break;
    }
    const rawLines = chunk.split(/\r?\n/);
    const headerLine = rawLines[0] ?? "";
    const plusHeader = rawLines.find((l) => l.startsWith("+++ "));

    let filePath = "";
    if (plusHeader && plusHeader !== "+++ /dev/null") {
      filePath = plusHeader.replace(/^\+\+\+\s+(?:b\/)?/, "").trim();
    } else {
      const matchB = /\sb\/(.+)$/.exec(headerLine);
      filePath = matchB?.[1]?.trim() ?? headerLine.trim();
    }
    filePath = filePath.replace(/^"+|"+$/g, "");
    if (!filePath || filePath === "/dev/null") {
      continue;
    }

    const parsedLines: WorkDiffLineDto[] = [];
    let additions = 0;
    let deletions = 0;
    let oldLine = 0;
    let newLine = 0;
    let inHunk = false;

    for (let i = 1; i < rawLines.length; i++) {
      const line = rawLines[i];
      if (line === undefined) continue;

      if (line.startsWith("@@ ")) {
        const hunkMatch = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
        oldLine = Number.parseInt(hunkMatch?.[1] ?? "1", 10);
        newLine = Number.parseInt(hunkMatch?.[2] ?? "1", 10);
        inHunk = true;
        if (parsedLines.length < maxLinesPerFile) {
          parsedLines.push({
            kind: "hunk",
            content: scrubWorkText(line).slice(0, 4_000),
          });
        }
        continue;
      }

      if (!inHunk || line.startsWith("\\ No newline at end of file")) {
        continue;
      }

      if (line.startsWith("+")) {
        additions += 1;
        if (parsedLines.length < maxLinesPerFile) {
          parsedLines.push({
            kind: "add",
            newLine,
            content: scrubWorkText(line.slice(1)).slice(0, 4_000),
          });
        }
        newLine += 1;
      } else if (line.startsWith("-")) {
        deletions += 1;
        if (parsedLines.length < maxLinesPerFile) {
          parsedLines.push({
            kind: "del",
            oldLine,
            content: scrubWorkText(line.slice(1)).slice(0, 4_000),
          });
        }
        oldLine += 1;
      } else if (line.startsWith(" ")) {
        if (parsedLines.length < maxLinesPerFile) {
          parsedLines.push({
            kind: "context",
            oldLine,
            newLine,
            content: scrubWorkText(line.slice(1)).slice(0, 4_000),
          });
        }
        oldLine += 1;
        newLine += 1;
      }
    }

    if (parsedLines.length > 0 || additions > 0 || deletions > 0) {
      files.push({
        path: filePath.slice(0, 260),
        additions,
        deletions,
        lines: parsedLines,
      });
    }
  }

  return files;
}

/**
 * 探测目录是否为有效的 Git 工作树。
 */
export async function isGitWorkingTree(dirPath: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: dirPath,
      timeout: 4_000,
    });
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

/**
 * 采集指定 Git 工作树相对于 `HEAD` 的全部已修改与新增文件 Diff 快照。
 */
export async function collectWorkingTreeDiff(workingDir: string): Promise<WorkingTreeDiffSnapshot> {
  if (!(await isGitWorkingTree(workingDir))) {
    return { changedFiles: [], diffAdded: 0, diffRemoved: 0, diffFiles: [] };
  }

  let statusOut = "";
  try {
    const res = await execFileAsync("git", ["status", "--porcelain", "-uall"], {
      cwd: workingDir,
      timeout: 6_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    statusOut = res.stdout;
  } catch {
    return { changedFiles: [], diffAdded: 0, diffRemoved: 0, diffFiles: [] };
  }

  const untrackedPaths: string[] = [];
  const allStatusPaths: string[] = [];
  for (const rawLine of statusOut.split(/\r?\n/)) {
    if (rawLine.length < 4) continue;
    const code = rawLine.slice(0, 2);
    const rawRel = rawLine
      .slice(3)
      .trim()
      .replace(/^"+|"+$/g, "");
    const finalRel = rawRel.includes(" -> ") ? (rawRel.split(" -> ").pop() ?? rawRel) : rawRel;
    if (!finalRel) continue;
    allStatusPaths.push(finalRel);
    if (code === "??") {
      untrackedPaths.push(finalRel);
    }
  }

  if (allStatusPaths.length === 0) {
    return { changedFiles: [], diffAdded: 0, diffRemoved: 0, diffFiles: [] };
  }

  let combinedRawDiff = "";
  try {
    const trackedDiff = await execFileAsync("git", ["diff", "--no-color", "-U3", "HEAD"], {
      cwd: workingDir,
      timeout: 8_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    combinedRawDiff += trackedDiff.stdout;
  } catch {
    // 空提交仓库尚无 HEAD 时回退到暂存/工作区直接 diff
    try {
      const fallbackDiff = await execFileAsync("git", ["diff", "--no-color", "-U3"], {
        cwd: workingDir,
        timeout: 6_000,
        maxBuffer: 4 * 1024 * 1024,
      });
      combinedRawDiff += fallbackDiff.stdout;
    } catch {
      // 忽略异常继续采集未追踪文件
    }
  }

  for (const relPath of untrackedPaths.slice(0, 15)) {
    const absFile = path.resolve(workingDir, relPath);
    try {
      const fileStat = await stat(absFile);
      if (!fileStat.isFile() || fileStat.size > MAX_UNTRACKED_FILE_BYTES) {
        continue;
      }
      // `git diff --no-index` 发现差异时退出码为 1，需在 catch 中读取 stdout
      await execFileAsync(
        "git",
        ["diff", "--no-color", "-U3", "--no-index", "--", "/dev/null", relPath],
        {
          cwd: workingDir,
          timeout: 4_000,
          maxBuffer: 512 * 1024,
        },
      );
    } catch (err: unknown) {
      const out =
        typeof err === "object" && err !== null && "stdout" in err
          ? String((err as { readonly stdout?: unknown }).stdout ?? "")
          : "";
      if (out.length > 0 && !out.includes("Binary files ")) {
        combinedRawDiff += `\n${out}`;
      }
    }
  }

  const diffFiles = parseUnifiedGitDiff(combinedRawDiff);
  const diffAdded = diffFiles.reduce((acc, f) => acc + f.additions, 0);
  const diffRemoved = diffFiles.reduce((acc, f) => acc + f.deletions, 0);
  const changedFiles =
    diffFiles.length > 0
      ? diffFiles.map((f) => f.path)
      : [...new Set(allStatusPaths)].slice(0, MAX_DIFF_FILES);

  return {
    changedFiles,
    diffAdded,
    diffRemoved,
    diffFiles,
  };
}

const IGNORED_FOLDER_DIRS: ReadonlySet<string> = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".cache",
  "coverage",
]);

const MAX_SNAPSHOT_FILES = 180;

export type PlainFolderSnapshot = ReadonlyMap<string, string>;

/**
 * 对非 Git 普通文件夹（`kind === "folder"`）采集轻量文本快照（跳过隐藏构建目录、二进制文件与 >128KB 大文件）。
 */
export async function capturePlainFolderSnapshot(rootDir: string): Promise<PlainFolderSnapshot> {
  const snapshot = new Map<string, string>();

  const walk = async (currentDir: string, relPrefix: string): Promise<void> => {
    if (snapshot.size >= MAX_SNAPSHOT_FILES) {
      return;
    }
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (snapshot.size >= MAX_SNAPSHOT_FILES) {
        break;
      }
      if (entry.name === ".DS_Store" || IGNORED_FOLDER_DIRS.has(entry.name)) {
        continue;
      }
      const relPath = relPrefix.length > 0 ? `${relPrefix}/${entry.name}` : entry.name;
      const fullPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        if (!entry.name.startsWith(".")) {
          await walk(fullPath, relPath);
        }
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      try {
        const info = await stat(fullPath);
        if (info.size > MAX_UNTRACKED_FILE_BYTES) {
          continue;
        }
        const buf = await readFile(fullPath);
        if (buf.includes(0)) {
          continue;
        }
        snapshot.set(relPath, buf.toString("utf8"));
      } catch {
        // 忽略并发删除或无权限读取的瞬态文件
      }
    }
  };

  await walk(rootDir, "");
  return snapshot;
}

function buildTextFileDiffDto(
  filePath: string,
  beforeText: string | undefined,
  afterText: string | undefined,
): WorkDiffFileDto | undefined {
  if (beforeText === afterText) {
    return undefined;
  }
  const splitLines = (text: string | undefined): readonly string[] => {
    if (text === undefined || text.length === 0) {
      return [];
    }
    const normalized = text.replace(/\r\n/g, "\n");
    const lines = normalized.endsWith("\n")
      ? normalized.slice(0, -1).split("\n")
      : normalized.split("\n");
    return lines;
  };

  const oldLines = splitLines(beforeText);
  const newLines = splitLines(afterText);

  // 共同前后缀收缩 + 中间变更块输出，保证 O(N) 线性时间生成精确行号 Unified Diff
  let prefixLen = 0;
  while (
    prefixLen < oldLines.length &&
    prefixLen < newLines.length &&
    oldLines[prefixLen] === newLines[prefixLen]
  ) {
    prefixLen += 1;
  }

  let oldSuffix = oldLines.length;
  let newSuffix = newLines.length;
  while (
    oldSuffix > prefixLen &&
    newSuffix > prefixLen &&
    oldLines[oldSuffix - 1] === newLines[newSuffix - 1]
  ) {
    oldSuffix -= 1;
    newSuffix -= 1;
  }

  const ctxStart = Math.max(0, prefixLen - 3);
  const oldCtxEnd = Math.min(oldLines.length, oldSuffix + 3);
  const newCtxEnd = Math.min(newLines.length, newSuffix + 3);

  const lines: WorkDiffLineDto[] = [
    {
      kind: "hunk",
      content: `@@ -${String(oldLines.length === 0 ? 0 : ctxStart + 1)},${String(oldCtxEnd - ctxStart)} +${String(newLines.length === 0 ? 0 : ctxStart + 1)},${String(newCtxEnd - ctxStart)} @@`,
    },
  ];

  for (let i = ctxStart; i < prefixLen && lines.length < MAX_LINES_PER_FILE; i += 1) {
    lines.push({
      kind: "context",
      oldLine: i + 1,
      newLine: i + 1,
      content: scrubWorkText(oldLines[i] ?? ""),
    });
  }

  let additions = 0;
  let deletions = 0;

  for (let i = prefixLen; i < oldSuffix; i += 1) {
    deletions += 1;
    if (lines.length < MAX_LINES_PER_FILE) {
      lines.push({
        kind: "del",
        oldLine: i + 1,
        content: scrubWorkText(oldLines[i] ?? ""),
      });
    }
  }

  for (let i = prefixLen; i < newSuffix; i += 1) {
    additions += 1;
    if (lines.length < MAX_LINES_PER_FILE) {
      lines.push({
        kind: "add",
        newLine: i + 1,
        content: scrubWorkText(newLines[i] ?? ""),
      });
    }
  }

  const trailingLen = Math.min(oldCtxEnd - oldSuffix, newCtxEnd - newSuffix);
  for (let offset = 0; offset < trailingLen && lines.length < MAX_LINES_PER_FILE; offset += 1) {
    lines.push({
      kind: "context",
      oldLine: oldSuffix + offset + 1,
      newLine: newSuffix + offset + 1,
      content: scrubWorkText(newLines[newSuffix + offset] ?? ""),
    });
  }

  return {
    path: filePath.slice(0, 260),
    additions,
    deletions,
    lines,
  };
}

/**
 * 对比非 Git 普通文件夹执行前后的文本快照，输出与 `collectWorkingTreeDiff` 同构的 Unified Diff 结果。
 */
export function diffPlainFolderSnapshots(
  before: PlainFolderSnapshot,
  after: PlainFolderSnapshot,
): WorkingTreeDiffSnapshot {
  const allPaths = [...new Set([...before.keys(), ...after.keys()])].sort((a, b) =>
    a.localeCompare(b),
  );
  const diffFiles: WorkDiffFileDto[] = [];

  for (const relPath of allPaths) {
    if (diffFiles.length >= MAX_DIFF_FILES) {
      break;
    }
    const dto = buildTextFileDiffDto(relPath, before.get(relPath), after.get(relPath));
    if (dto !== undefined) {
      diffFiles.push(dto);
    }
  }

  return {
    changedFiles: diffFiles.map((f) => f.path),
    diffAdded: diffFiles.reduce((sum, f) => sum + f.additions, 0),
    diffRemoved: diffFiles.reduce((sum, f) => sum + f.deletions, 0),
    diffFiles,
  };
}
