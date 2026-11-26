import { lstatSync, mkdirSync, realpathSync, rmdirSync, statSync } from "node:fs";
import path from "node:path";

export class WorkspacePathError extends Error {
  constructor(
    message: string,
    readonly invalidInput = false,
  ) {
    super(message);
  }
}

const automationDenied = "请选择当前用户目录下的项目文件夹，系统、隐藏和凭据目录不可用于自动执行。";
const topLevelContainers = new Set([
  "documents",
  "downloads",
  "desktop",
  "developer",
  "pictures",
  "music",
  "movies",
]);

export interface WorkspacePathPlan {
  readonly target: string;
  readonly ancestor: string;
  readonly missingSegments: readonly string[];
}

/** Resolve the deepest existing ancestor before trusting a path that doesn't exist yet. */
export function inspectWorkspacePath(rawPath: string, homeDir: string): WorkspacePathPlan {
  const input = rawPath.trim();
  const expanded =
    input === "~"
      ? homeDir
      : input.startsWith("~/") || input.startsWith("~\\")
        ? path.join(homeDir, input.slice(2))
        : input;
  if (input.includes("\0") || !path.isAbsolute(expanded)) {
    throw new WorkspacePathError("工作区必须使用绝对路径或 ~/ 项目路径。", true);
  }
  let probe = path.resolve(expanded);
  const missingSegments: string[] = [];
  for (;;) {
    let entry: ReturnType<typeof lstatSync>;
    try {
      entry = lstatSync(probe);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT" || path.dirname(probe) === probe) {
        throw new WorkspacePathError("Cannot inspect workspace path.");
      }
      missingSegments.unshift(path.basename(probe));
      probe = path.dirname(probe);
      continue;
    }
    let ancestor: string;
    try {
      ancestor = realpathSync.native(probe);
    } catch {
      throw new WorkspacePathError(
        entry.isSymbolicLink()
          ? "Workspace path contains a broken symbolic link and cannot be mounted."
          : "Cannot resolve workspace path.",
      );
    }
    return { ancestor, missingSegments, target: path.join(ancestor, ...missingSegments) };
  }
}

export function assertAutomatableWorkspacePath(homeDir: string, target: string): void {
  const relative = path.relative(realpathSync.native(homeDir), target);
  const parts = relative.split(path.sep);
  const top = (parts[0] ?? "").toLowerCase();
  if (
    !relative ||
    path.isAbsolute(relative) ||
    parts.some((p) => p.startsWith(".")) ||
    (parts.length === 1 && topLevelContainers.has(top)) ||
    ["library", "appdata", "applications"].includes(top)
  ) {
    throw new WorkspacePathError(automationDenied);
  }
}

/** Only remove directories that are still empty and resolve to the recorded location. */
export function removeEmptyCreatedDirs(createdDirs: readonly string[]): void {
  for (const dir of [...createdDirs].reverse()) {
    try {
      if (realpathSync.native(dir) === dir) rmdirSync(dir);
    } catch {
      // A competing creator can already be using this directory.
    }
  }
}

export function ensureWorkspaceDirectory(plan: WorkspacePathPlan): {
  dir: string;
  created: boolean;
  createdDirs: readonly string[];
} {
  const createdDirs: string[] = [];
  let parent = plan.ancestor;
  try {
    for (const segment of plan.missingSegments) {
      if (realpathSync.native(parent) !== parent) throw new WorkspacePathError(automationDenied);
      const child = path.join(parent, segment);
      try {
        mkdirSync(child, { mode: 0o755 });
        createdDirs.push(child);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
      if (!lstatSync(child).isDirectory() || realpathSync.native(child) !== child) {
        throw new WorkspacePathError(automationDenied);
      }
      parent = child;
    }
    if (realpathSync.native(plan.target) !== plan.target || !statSync(plan.target).isDirectory()) {
      throw new WorkspacePathError("工作区目标不是目录或路径已变化。", true);
    }
    return { dir: plan.target, created: createdDirs.includes(plan.target), createdDirs };
  } catch (err) {
    removeEmptyCreatedDirs(createdDirs);
    throw err;
  }
}
