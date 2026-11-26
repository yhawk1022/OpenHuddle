import { execFile } from "node:child_process";
/**
 * @module core-governance/workspace-diff
 * @description 真实工作目录 `git diff` 采集与 Unified Diff 结构化解析器（零 Shell 拼接）。
 *
 * 关键不变量：
 * 1. 同时覆盖已追踪文件变更（`git diff HEAD`）与新增未追踪文本文件（`git diff --no-index`），确保新建文件也能在工作台审阅面板完整展示。
 * 2. 对单文件行数与总文件数施加硬上限保护，防止巨型锁文件或构建产物撑爆 JSONB 与前端渲染树。
 */
import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  MAX_REVIEW_EVIDENCE_BYTES,
  type WorkDiffFileDto,
  type WorkDiffLineDto,
} from "@openhuddle/protocol";
import { scrubReviewPatch, scrubWorkText } from "./secret-redact.js";

const execFileAsync = promisify(execFile);

export function workspaceProcessEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...source };
  for (const key of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_COMMON_DIR",
    "GIT_INDEX_FILE",
    "GIT_PREFIX",
    "GIT_CEILING_DIRECTORIES",
  ]) {
    delete env[key];
  }
  return env;
}

export function workspaceGitEnv(): NodeJS.ProcessEnv {
  return { ...workspaceProcessEnv(), LC_ALL: "C" };
}

const MAX_DIFF_FILES = 30;
const MAX_LINES_PER_FILE = 450;
const MAX_UNTRACKED_FILE_BYTES = 128 * 1024;
const EMPTY_GIT_BLOB_IDS = ["sha1", "sha256"].map((algorithm) =>
  createHash(algorithm).update("blob 0\0").digest("hex"),
);

export interface WorkingTreeDiffSnapshot {
  readonly reviewPatch?: string | undefined;
  readonly changedFiles: readonly string[];
  readonly diffAdded: number;
  readonly diffRemoved: number;
  readonly diffFiles: readonly WorkDiffFileDto[];
}

/** A web preview can omit files, lines or the tail of a long line. */
export function hasCompleteDiffPreview(
  paths: readonly string[],
  files: readonly WorkDiffFileDto[],
): boolean {
  return (
    paths.length > 0 &&
    paths.every((path) => {
      const diff = files.find((f) => f.path === path);
      return (
        diff?.lines.some((l) => l.kind === "hunk") &&
        diff.lines.filter((l) => l.kind === "add").length === diff.additions &&
        diff.lines.filter((l) => l.kind === "del").length === diff.deletions &&
        diff.lines.every((l) => l.content.length < 4000)
      );
    })
  );
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

    const creationId = /^new file mode 100(?:644|755)\nindex 0+\.\.([0-9a-f]{7,64})$/m.exec(
      chunk,
    )?.[1];
    const emptyCreation =
      creationId !== undefined && EMPTY_GIT_BLOB_IDS.some((id) => id.startsWith(creationId));
    if (parsedLines.length > 0 || additions > 0 || deletions > 0 || emptyCreation) {
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
      env: workspaceGitEnv(),
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
export async function collectWorkingTreeDiff(
  workingDir: string,
  includeReviewPatch = false,
): Promise<WorkingTreeDiffSnapshot> {
  if (!(await isGitWorkingTree(workingDir))) {
    return { changedFiles: [], diffAdded: 0, diffRemoved: 0, diffFiles: [] };
  }

  let statusOut = "";
  try {
    const res = await execFileAsync("git", ["status", "--porcelain", "-z", "-uall"], {
      cwd: workingDir,
      env: workspaceGitEnv(),
      timeout: 6_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    statusOut = res.stdout;
  } catch {
    return { changedFiles: [], diffAdded: 0, diffRemoved: 0, diffFiles: [] };
  }

  const untrackedPaths: string[] = [];
  const allStatusPaths: string[] = [];
  const entries = statusOut.split("\0");
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry || entry.length < 4) continue;
    const code = entry.slice(0, 2);
    const file = entry.slice(3);
    allStatusPaths.push(file);
    if (code === "??") untrackedPaths.push(file);
    // With -z, a rename/copy record has its original path in the next field.
    if (/[RC]/.test(code)) i++;
  }

  if (allStatusPaths.length === 0) {
    return { changedFiles: [], diffAdded: 0, diffRemoved: 0, diffFiles: [] };
  }

  let combinedRawDiff = "";
  try {
    const trackedDiff = await execFileAsync(
      "git",
      [
        "-c",
        "core.quotepath=false",
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "-U3",
        "HEAD",
      ],
      {
        cwd: workingDir,
        env: workspaceGitEnv(),
        timeout: 8_000,
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    combinedRawDiff += trackedDiff.stdout;
  } catch {
    // 空提交仓库尚无 HEAD 时回退到暂存/工作区直接 diff
    try {
      const fallbackDiff = await execFileAsync(
        "git",
        [
          "-c",
          "core.quotepath=false",
          "diff",
          "--no-ext-diff",
          "--no-textconv",
          "--no-color",
          "-U3",
        ],
        {
          cwd: workingDir,
          env: workspaceGitEnv(),
          timeout: 6_000,
          maxBuffer: 4 * 1024 * 1024,
        },
      );
      combinedRawDiff += fallbackDiff.stdout;
    } catch {
      // 忽略异常继续采集未追踪文件
    }
  }

  for (const relPath of untrackedPaths.slice(0, includeReviewPatch ? 200 : 15)) {
    const absFile = path.resolve(workingDir, relPath);
    try {
      const fileStat = await stat(absFile);
      if (!fileStat.isFile() || fileStat.size > MAX_UNTRACKED_FILE_BYTES) {
        continue;
      }
      // `git diff --no-index` 发现差异时退出码为 1，需在 catch 中读取 stdout
      await execFileAsync(
        "git",
        [
          "-c",
          "core.quotepath=false",
          "diff",
          "--no-ext-diff",
          "--no-textconv",
          "--no-color",
          "-U3",
          "--no-index",
          "--",
          "/dev/null",
          relPath,
        ],
        {
          cwd: workingDir,
          env: workspaceGitEnv(),
          timeout: 4_000,
          maxBuffer: 512 * 1024,
        },
      );
    } catch (err: unknown) {
      const out =
        typeof err === "object" && err !== null && "stdout" in err
          ? String((err as { readonly stdout?: unknown }).stdout ?? "")
          : "";
      if (
        (err as { code?: unknown })?.code === 1 &&
        out.length > 0 &&
        !out.includes("Binary files ")
      ) {
        combinedRawDiff += `\n${out}`;
      }
    }
  }

  const diffFiles = parseUnifiedGitDiff(combinedRawDiff);
  const diffAdded = diffFiles.reduce((acc, f) => acc + f.additions, 0);
  const diffRemoved = diffFiles.reduce((acc, f) => acc + f.deletions, 0);
  const changedFiles = [...new Set(allStatusPaths)].slice(0, 200);

  let reviewPatch: string | undefined;
  if (
    includeReviewPatch &&
    allStatusPaths.length <= 200 &&
    Buffer.byteLength(combinedRawDiff) <= MAX_REVIEW_EVIDENCE_BYTES &&
    (/^new file mode 100(?:644|755)$/m.test(combinedRawDiff) ||
      !hasCompleteDiffPreview(changedFiles, diffFiles))
  ) {
    const paths = new Set(parseUnifiedGitDiff(combinedRawDiff, 200, 0).map((file) => file.path));
    if (changedFiles.every((p) => paths.has(p)))
      reviewPatch = scrubReviewPatch(combinedRawDiff.trimStart());
  }
  return {
    ...(reviewPatch ? { reviewPatch } : {}),
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
  maxLines = MAX_LINES_PER_FILE,
  maxLineLength = 4_000,
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

  for (let i = ctxStart; i < prefixLen && lines.length < maxLines; i += 1) {
    lines.push({
      kind: "context",
      oldLine: i + 1,
      newLine: i + 1,
      content: scrubWorkText(oldLines[i] ?? "").slice(0, maxLineLength),
    });
  }

  let additions = 0;
  let deletions = 0;

  for (let i = prefixLen; i < oldSuffix; i += 1) {
    deletions += 1;
    if (lines.length < maxLines) {
      lines.push({
        kind: "del",
        oldLine: i + 1,
        content: scrubWorkText(oldLines[i] ?? "").slice(0, maxLineLength),
      });
    }
  }

  for (let i = prefixLen; i < newSuffix; i += 1) {
    additions += 1;
    if (lines.length < maxLines) {
      lines.push({
        kind: "add",
        newLine: i + 1,
        content: scrubWorkText(newLines[i] ?? "").slice(0, maxLineLength),
      });
    }
  }

  const trailingLen = Math.min(oldCtxEnd - oldSuffix, newCtxEnd - newSuffix);
  for (let offset = 0; offset < trailingLen && lines.length < maxLines; offset += 1) {
    lines.push({
      kind: "context",
      oldLine: oldSuffix + offset + 1,
      newLine: newSuffix + offset + 1,
      content: scrubWorkText(newLines[newSuffix + offset] ?? "").slice(0, maxLineLength),
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
function newFolderFilePatch(file: string, text: string): string {
  const hash = createHash("sha1")
    .update(`blob ${Buffer.byteLength(text)}\0`)
    .update(text)
    .digest("hex");
  const header = [
    `diff --git a/${file} b/${file}`,
    "new file mode 100644",
    `index 0000000..${hash}`,
  ];
  if (text.length > 0) {
    const lines = text.split("\n");
    const endsWithNewline = text.endsWith("\n");
    if (endsWithNewline) lines.pop();
    header.push("--- /dev/null", `+++ b/${file}\t`, `@@ -0,0 +1,${lines.length} @@`);
    for (const line of lines) header.push(`+${line}`);
    if (!endsWithNewline) header.push("\\ No newline at end of file");
  }
  return `${header.join("\n")}\n`;
}

export function diffPlainFolderSnapshots(
  before: PlainFolderSnapshot,
  after: PlainFolderSnapshot,
  includeReviewPatch = false,
): WorkingTreeDiffSnapshot {
  const allPaths = [...new Set([...before.keys(), ...after.keys()])].sort((a, b) =>
    a.localeCompare(b),
  );
  const diffFiles: WorkDiffFileDto[] = [];

  const changedFiles = allPaths.filter((p) => before.get(p) !== after.get(p));
  for (const relPath of changedFiles.slice(0, MAX_DIFF_FILES)) {
    const dto = buildTextFileDiffDto(relPath, before.get(relPath), after.get(relPath));
    if (dto) diffFiles.push(dto);
  }
  const patchParts: string[] = [];
  if (
    includeReviewPatch &&
    (changedFiles.some((file) => !before.has(file)) ||
      !hasCompleteDiffPreview(changedFiles, diffFiles))
  ) {
    let bytes = 0;
    for (const file of changedFiles) {
      const full = buildTextFileDiffDto(
        file,
        before.get(file),
        after.get(file),
        Number.POSITIVE_INFINITY,
        Number.POSITIVE_INFINITY,
      );
      if (!full) continue;
      const created = after.get(file);
      const text =
        created !== undefined && !before.has(file)
          ? newFolderFilePatch(file, created)
          : [
              `diff --git a/${file} b/${file}`,
              before.has(file) ? `--- a/${file}` : "--- /dev/null",
              after.has(file) ? `+++ b/${file}` : "+++ /dev/null",
              ...full.lines.map(
                (l) => ({ hunk: "", add: "+", del: "-", context: " " })[l.kind] + l.content,
              ),
              "",
            ].join("\n");
      bytes += Buffer.byteLength(text);
      if (bytes > MAX_REVIEW_EVIDENCE_BYTES) {
        patchParts.length = 0;
        break;
      }
      patchParts.push(text);
    }
  }
  return {
    ...(patchParts.length ? { reviewPatch: scrubReviewPatch(patchParts.join("")) } : {}),
    changedFiles,
    diffAdded: diffFiles.reduce((sum, f) => sum + f.additions, 0),
    diffRemoved: diffFiles.reduce((sum, f) => sum + f.deletions, 0),
    diffFiles,
  };
}
