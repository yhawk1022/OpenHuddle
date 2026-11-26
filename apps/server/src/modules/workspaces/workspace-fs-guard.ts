/**
 * @module server/modules/workspaces/workspace-fs-guard
 * @description 本机工作区目录安全边界校验（阻断系统目录与凭据目录越权挂载）与真实文件系统元数据探测器。
 *
 * 安全与设计不变量：
 * 1. 最小暴露面：严禁将操作系统根目录（`/`、`/etc`、`/System`、`/usr`）、用户主目录根（`~` 本身）或高危凭据目录（`~/.ssh`、`~/.aws`、`~/.gnupg`、`~/.kube`、`~/.openhuddle/tokens`）注册为工作区。
 * 2. 真实资产探测：在本机回环模式下自动探测目录真实 Git 状态、默认分支、`CLAUDE.md` / `AGENTS.md` 规则文件与 `.agents/skills` 技能数量，杜绝返回虚假占位上下文。
 */
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  WorkspacePathError,
  assertAutomatableWorkspacePath,
  ensureWorkspaceDirectory,
  inspectWorkspacePath,
} from "@openhuddle/core-governance/workspace-path";
export { removeEmptyCreatedDirs } from "@openhuddle/core-governance/workspace-path";
import type {
  WorkspaceContextAssets,
  WorkspaceKind,
  WorkspaceLifecycleHooks,
  WorkspaceRootEntry,
  WorkspaceSandboxMode,
} from "@openhuddle/protocol";
import { AppError } from "../../infra/errors.js";

const RULE_FILE_CANDIDATES: readonly string[] = [
  "CLAUDE.md",
  "AGENTS.md",
  ".cursorrules",
  ".github/copilot-instructions.md",
];

const POSIX_SYSTEM_PREFIXES: readonly string[] = [
  "/etc",
  "/private/etc",
  "/var/root",
  "/private/var/root",
  "/System",
  "/usr",
  "/bin",
  "/sbin",
  "/dev",
  "/proc",
  "/sys",
];

const SENSITIVE_HOME_SUBDIRS: readonly string[] = [
  ".ssh",
  ".gnupg",
  ".aws",
  ".kube",
  ".docker",
  ".npmrc",
  ".netrc",
  ".config",
  ".openhuddle",
  "Library",
];

function withPathErrors<T>(operation: () => T): T {
  try {
    return operation();
  } catch (err) {
    if (!(err instanceof WorkspacePathError)) throw err;
    throw new AppError({
      code: err.invalidInput ? "VALIDATION_ERROR" : "FORBIDDEN_WORKSPACE_ACCESS",
      statusCode: err.invalidInput ? 400 : 403,
      message: err.message,
    });
  }
}

export function resolveCanonicalLocalPath(rawPath: string, homeDir = homedir()): string {
  return withPathErrors(() => inspectWorkspacePath(rawPath, homeDir).target);
}

function comparablePath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "darwin" || process.platform === "win32"
    ? resolved.toLowerCase()
    : resolved;
}

function isSameOrSubpath(candidate: string, base: string): boolean {
  const normCandidate = comparablePath(candidate);
  const normBase = comparablePath(base);
  return normCandidate === normBase || normCandidate.startsWith(`${normBase}${path.sep}`);
}

export function ensureAutoCreatableLocalWorkspaceDir(rawPath: string, homeDir = homedir()) {
  return withPathErrors(() => {
    const plan = inspectWorkspacePath(rawPath, homeDir);
    assertAutomatableWorkspacePath(homeDir, plan.target);
    assertSafeLocalWorkspacePath(plan.target, homeDir);
    return ensureWorkspaceDirectory(plan);
  });
}

/**
 * 校验本机工作区目录是否落在允许的安全项目/文档路径内；命中系统根或敏感凭据目录时立即以 `403 FORBIDDEN_WORKSPACE_ACCESS` 拒绝。
 */
export function assertSafeLocalWorkspacePath(rawPath: string, homeDir = homedir()): string {
  const canonicalHome = existsSync(homeDir) ? realpathSync.native(homeDir) : path.resolve(homeDir);
  const resolved = resolveCanonicalLocalPath(rawPath, canonicalHome);
  const parsedRoot = path.parse(resolved).root;

  if (resolved === parsedRoot) {
    throw new AppError({
      code: "FORBIDDEN_WORKSPACE_ACCESS",
      statusCode: 403,
      message: "Mounting the filesystem root directory as a workspace is forbidden.",
    });
  }

  if (comparablePath(resolved) === comparablePath(canonicalHome)) {
    throw new AppError({
      code: "FORBIDDEN_WORKSPACE_ACCESS",
      statusCode: 403,
      message:
        "Mounting your entire home directory (~) is forbidden; choose a specific project or document folder.",
    });
  }

  if (process.platform !== "win32") {
    for (const sysPrefix of POSIX_SYSTEM_PREFIXES) {
      if (isSameOrSubpath(resolved, sysPrefix)) {
        throw new AppError({
          code: "FORBIDDEN_WORKSPACE_ACCESS",
          statusCode: 403,
          message: `System directory "${sysPrefix}" cannot be mounted as a workspace.`,
        });
      }
    }
  }

  for (const relSensitive of SENSITIVE_HOME_SUBDIRS) {
    const absSensitive = path.join(canonicalHome, relSensitive);
    if (isSameOrSubpath(resolved, absSensitive)) {
      throw new AppError({
        code: "FORBIDDEN_WORKSPACE_ACCESS",
        statusCode: 403,
        message: `Sensitive credential path "~/${relSensitive}" cannot be mounted as a workspace.`,
      });
    }
  }

  return resolved;
}

function readGitHeadBranch(repoDir: string): string | undefined {
  const gitMarker = path.join(repoDir, ".git");
  if (!existsSync(gitMarker)) {
    return undefined;
  }
  try {
    const stat = statSync(gitMarker);
    const gitDir = stat.isDirectory()
      ? gitMarker
      : (() => {
          const pointer = readFileSync(gitMarker, "utf8").trim();
          const prefix = "gitdir:";
          return pointer.startsWith(prefix)
            ? path.resolve(repoDir, pointer.slice(prefix.length).trim())
            : undefined;
        })();
    if (!gitDir) {
      return "main";
    }
    const headPath = path.join(gitDir, "HEAD");
    if (!existsSync(headPath)) {
      return "main";
    }
    const headRaw = readFileSync(headPath, "utf8").trim();
    const refPrefix = "ref: refs/heads/";
    return headRaw.startsWith(refPrefix) ? headRaw.slice(refPrefix.length) : "main";
  } catch {
    return "main";
  }
}

function countInstalledSkills(rootDir: string): number {
  const candidates = [
    path.join(rootDir, ".agents", "skills"),
    path.join(rootDir, ".claude", "skills"),
  ];
  const skillNames = new Set<string>();
  for (const dir of candidates) {
    if (!existsSync(dir)) continue;
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory() && !entry.name.startsWith(".")) {
          skillNames.add(entry.name);
        }
      }
    } catch {
      // 忽略不可读目录
    }
  }
  return skillNames.size;
}

function inferDefaultVerifyCommand(rootDir: string): string | undefined {
  const pkgJsonPath = path.join(rootDir, "package.json");
  if (!existsSync(pkgJsonPath)) {
    return undefined;
  }
  try {
    const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as {
      readonly scripts?: Readonly<Record<string, unknown>>;
    };
    const runner = existsSync(path.join(rootDir, "pnpm-lock.yaml"))
      ? "pnpm"
      : existsSync(path.join(rootDir, "yarn.lock"))
        ? "yarn"
        : "npm run";
    if (typeof pkg.scripts?.typecheck === "string") {
      return `${runner} typecheck`;
    }
    if (typeof pkg.scripts?.test === "string") {
      return runner === "npm run" ? "npm test" : `${runner} test`;
    }
  } catch {
    // 忽略损坏的 package.json
  }
  return undefined;
}

/**
 * 校验并探测本机工作区根目录集合：
 * - 对普通文件夹（`kind === "folder"` 且非只读）在其父目录已存在时自动创建目标文件夹；
 * - 汇总真实 Git 分支、规则文件、技能数量与默认校验命令。
 */
export function inspectAndPrepareLocalWorkspace(params: {
  readonly roots: readonly WorkspaceRootEntry[];
  readonly kind: WorkspaceKind;
  readonly sandboxMode: WorkspaceSandboxMode;
  readonly explicitHooks?: WorkspaceLifecycleHooks | undefined;
  readonly explicitContext?: WorkspaceContextAssets | undefined;
  readonly homeDir?: string | undefined;
}): {
  readonly roots: readonly WorkspaceRootEntry[];
  readonly context: WorkspaceContextAssets;
  readonly hooks: WorkspaceLifecycleHooks;
} {
  const effectiveHome = params.homeDir ?? homedir();
  const discoveredRules = new Set<string>();
  let totalSkills = 0;
  let inferredVerifyCmd: string | undefined;

  const enrichedRoots: WorkspaceRootEntry[] = params.roots.map((root) => {
    const rawPath = root.localPath ?? "";
    let resolved = assertSafeLocalWorkspacePath(rawPath, effectiveHome);

    if (params.kind === "folder" && params.sandboxMode !== "read_only" && !existsSync(resolved)) {
      resolved = ensureAutoCreatableLocalWorkspaceDir(rawPath, effectiveHome).dir;
    }

    const exists = existsSync(resolved);
    const gitBranch = params.kind === "folder" || !exists ? undefined : readGitHeadBranch(resolved);
    const isGitRepo = params.kind === "folder" ? false : gitBranch !== undefined;

    if (exists) {
      for (const candidate of RULE_FILE_CANDIDATES) {
        if (existsSync(path.join(resolved, candidate))) {
          discoveredRules.add(candidate);
        }
      }
      totalSkills += countInstalledSkills(resolved);
      if (inferredVerifyCmd === undefined && isGitRepo) {
        inferredVerifyCmd = inferDefaultVerifyCommand(resolved);
      }
    }

    return {
      ...root,
      localPath: resolved,
      isGitRepo,
      ...(isGitRepo ? { defaultBranch: root.defaultBranch ?? gitBranch ?? "main" } : {}),
    };
  });

  const hooks: WorkspaceLifecycleHooks = {
    ...(params.explicitHooks?.setupCommand !== undefined
      ? { setupCommand: params.explicitHooks.setupCommand }
      : {}),
    ...(params.explicitHooks?.verifyCommand !== undefined
      ? { verifyCommand: params.explicitHooks.verifyCommand }
      : inferredVerifyCmd !== undefined && params.sandboxMode !== "read_only"
        ? { verifyCommand: inferredVerifyCmd }
        : {}),
    ...(params.explicitHooks?.copyEnvGlobs !== undefined
      ? { copyEnvGlobs: [...params.explicitHooks.copyEnvGlobs] }
      : {}),
  };

  const context: WorkspaceContextAssets = params.explicitContext ?? {
    ruleFiles: [...discoveredRules].slice(0, 32),
    skillCount: Math.min(500, totalSkills),
    sharedMemoryActive: true,
  };

  return {
    roots: enrichedRoots,
    context,
    hooks,
  };
}
