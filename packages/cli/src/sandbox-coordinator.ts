/**
 * @module cli/sandbox-coordinator
 * @description 跨环境共享沙箱的执行围栏、租约交棒状态机与互斥命令队列（借鉴 E2B `envd` / ADR-0010 §3.1）。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 真实路径围栏（Realpath Confinement）：递归解析已存在父目录的符号链接真实路径，彻底拦截 `../../` 穿越与软链接指向宿主机敏感目录（如 `/etc`、`~/.ssh`）。
 * 2. Owner-First 跨人边界：`local_machine` 与 `personal_remote` 沙箱仅允许 `hostOwnerUserId` 本人的 Agent 申请租约；仅 `shared_container` 隔离容器在房间显式开启共享后允许同房间协作者申请受限租约。
 * 3. 单写互斥与原子替换：同一沙箱根目录同一时刻至多持有 1 个活跃 `write` 租约；文件写入一律走 `tmp + fsync + rename`，且包管理/编译构建类命令经 FIFO 串行队列防踩踏。
 */
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  realpathSync,
  renameSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

/**
 * 工作区宿主沙箱运行模式。
 */
export type SandboxHostMode = "local_machine" | "personal_remote" | "shared_container";

/**
 * 沙箱租约权限级别。
 * - `write`：独占写锁（允许修改文件与执行构建命令）
 * - `verify`：复核锁（允许读取文件与执行验证命令，禁止修改源码）
 * - `read`：只读观察锁（仅允许读取文件与非破坏性查看）
 */
export type SandboxLeaseRole = "write" | "verify" | "read";

/**
 * 请求进入共享沙箱的调用方身份上下文（由服务端验签后下发）。
 */
export interface SandboxCallerPrincipal {
  readonly agentId: string;
  readonly ownerUserId: string;
  readonly roomId?: string | undefined;
}

/**
 * 已签发的活跃沙箱租约。
 */
export interface SandboxLease {
  readonly leaseId: string;
  readonly targetRoot: string;
  readonly role: SandboxLeaseRole;
  readonly agentId: string;
  readonly ownerUserId: string;
  readonly expiresAtMs: number;
}

/**
 * 沙箱越界或租约冲突结构化异常。
 */
export class SandboxViolationError extends Error {
  public readonly code:
    | "PATH_ESCAPE_DENIED"
    | "CROSS_OWNER_DENIED"
    | "WRITE_LEASE_CONFLICT"
    | "LEASE_ROLE_FORBIDDEN";

  public constructor(
    code:
      | "PATH_ESCAPE_DENIED"
      | "CROSS_OWNER_DENIED"
      | "WRITE_LEASE_CONFLICT"
      | "LEASE_ROLE_FORBIDDEN",
    message: string,
  ) {
    super(message);
    this.name = "SandboxViolationError";
    this.code = code;
  }
}

function resolveCanonicalExistingAncestor(targetPath: string): string {
  const abs = resolve(targetPath);
  if (existsSync(abs)) {
    return realpathSync(abs);
  }
  const parent = dirname(abs);
  if (parent === abs) {
    return abs;
  }
  return join(resolveCanonicalExistingAncestor(parent), basename(abs));
}

function isSubPathOrEqual(canonicalRoot: string, canonicalTarget: string): boolean {
  if (canonicalRoot === canonicalTarget) {
    return true;
  }
  const rel = relative(canonicalRoot, canonicalTarget);
  return rel.length > 0 && !rel.startsWith("..") && !rel.startsWith(sep);
}

/**
 * 校验并解析沙箱内的安全目标路径；若路径逃逸出授权 `allowedRoots`（含通过软链接逃逸），立即抛出 `SandboxViolationError`。
 *
 * @param allowedRoots - 工作区显式授权的目录根列表
 * @param requestedPath - 待访问的目标绝对或相对路径
 * @returns 通过真实路径围栏校验的规范化绝对路径
 * @throws {SandboxViolationError} 当 `requestedPath` 越出所有授权根目录时抛出 `PATH_ESCAPE_DENIED`
 */
export function resolveConfinedSandboxPath(
  allowedRoots: ReadonlyArray<string>,
  requestedPath: string,
): string {
  if (allowedRoots.length === 0) {
    throw new SandboxViolationError("PATH_ESCAPE_DENIED", "No authorized workspace roots mounted.");
  }
  const canonicalRoots = allowedRoots.map((root) => resolveCanonicalExistingAncestor(root));
  const resolvedCandidate = resolve(canonicalRoots[0] ?? process.cwd(), requestedPath);
  const canonicalTarget = resolveCanonicalExistingAncestor(resolvedCandidate);

  const allowed = canonicalRoots.some((root) => isSubPathOrEqual(root, canonicalTarget));
  if (!allowed) {
    throw new SandboxViolationError(
      "PATH_ESCAPE_DENIED",
      `Target path "${requestedPath}" escapes authorized workspace roots.`,
    );
  }
  return canonicalTarget;
}

/**
 * 在受控沙箱目录内执行原子文件写入（`临时文件 -> fsync -> rename`），
 * 确保同一共享沙箱中的其他复核/观察 Agent 绝不会读到半截损坏文件。
 *
 * @param allowedRoots - 工作区授权目录根列表
 * @param targetPath - 目标文件路径
 * @param content - UTF-8 文件完整内容
 * @returns 实际落盘的规范化路径
 */
export function writeAtomicSandboxFile(
  allowedRoots: ReadonlyArray<string>,
  targetPath: string,
  content: string,
): string {
  const safeTarget = resolveConfinedSandboxPath(allowedRoots, targetPath);
  const parentDir = dirname(safeTarget);
  mkdirSync(parentDir, { recursive: true });
  // 创建父目录后再次校验真实路径，防止并发竞态替换软链
  const verifiedTarget = resolveConfinedSandboxPath(allowedRoots, safeTarget);
  const tmpFile = join(
    dirname(verifiedTarget),
    `.oh-sbx-${String(process.pid)}-${Math.random().toString(36).slice(2, 8)}.tmp`,
  );

  const fd = openSync(tmpFile, "w", 0o644);
  try {
    writeSync(fd, content, undefined, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmpFile, verifiedTarget);
  return verifiedTarget;
}

/**
 * 共享沙箱租约与跨主人权限仲裁器。
 */
export class SandboxLeaseManager {
  private readonly hostMode: SandboxHostMode;
  private readonly hostOwnerUserId: string;
  private readonly sharedRoomId: string | null;
  private readonly leases = new Map<string, SandboxLease>();
  private seq = 0;

  public constructor(config: {
    readonly hostMode: SandboxHostMode;
    readonly hostOwnerUserId: string;
    readonly sharedRoomId?: string | undefined;
  }) {
    this.hostMode = config.hostMode;
    this.hostOwnerUserId = config.hostOwnerUserId;
    this.sharedRoomId = config.sharedRoomId ?? null;
  }

  private pruneExpired(nowMs: number): void {
    for (const [id, lease] of this.leases.entries()) {
      if (lease.expiresAtMs <= nowMs) {
        this.leases.delete(id);
      }
    }
  }

  /**
   * 为调用方 Agent 申请指定目录的沙箱租约。
   *
   * @param params - 调用方身份、目标目录、请求角色、当前时间戳与租约时长
   * @returns 签发的 `SandboxLease`
   * @throws {SandboxViolationError} 跨主人越权或写锁冲突时抛出异常
   */
  public acquireLease(params: {
    readonly principal: SandboxCallerPrincipal;
    readonly targetRoot: string;
    readonly role: SandboxLeaseRole;
    readonly nowMs: number;
    readonly ttlMs?: number | undefined;
  }): SandboxLease {
    this.pruneExpired(params.nowMs);

    const isHostOwner = params.principal.ownerUserId === this.hostOwnerUserId;
    if (!isHostOwner) {
      const allowedInSharedContainer =
        this.hostMode === "shared_container" &&
        this.sharedRoomId !== null &&
        params.principal.roomId === this.sharedRoomId;
      if (!allowedInSharedContainer) {
        throw new SandboxViolationError(
          "CROSS_OWNER_DENIED",
          "External participant agents cannot access personal host sandboxes.",
        );
      }
    }

    const normalizedRoot = resolve(params.targetRoot);
    for (const active of this.leases.values()) {
      if (active.targetRoot !== normalizedRoot) {
        continue;
      }
      // 同一目录已有其他 Agent 的写锁时，拒绝新的 write 或 verify 锁（允许同一 Agent 续租）
      if (
        active.agentId !== params.principal.agentId &&
        (active.role === "write" || params.role === "write")
      ) {
        if (params.role === "write" || active.role === "write") {
          throw new SandboxViolationError(
            "WRITE_LEASE_CONFLICT",
            `Sandbox root "${normalizedRoot}" is currently locked by agent "${active.agentId}" (${active.role}).`,
          );
        }
      }
    }

    this.seq += 1;
    const lease: SandboxLease = {
      leaseId: `sbx_lease_${String(this.seq)}`,
      targetRoot: normalizedRoot,
      role: params.role,
      agentId: params.principal.agentId,
      ownerUserId: params.principal.ownerUserId,
      expiresAtMs: params.nowMs + (params.ttlMs ?? 5 * 60_000),
    };
    this.leases.set(lease.leaseId, lease);
    return lease;
  }

  /**
   * 主动释放租约（例如第 1 棒编码完成后立即释放 `write` 锁，0 秒交棒给第 2 棒复核员申请 `verify` 锁）。
   */
  public releaseLease(leaseId: string): void {
    this.leases.delete(leaseId);
  }

  /**
   * 校验某租约是否具备文件修改权限。
   */
  public assertWriteAllowed(leaseId: string, nowMs: number): SandboxLease {
    this.pruneExpired(nowMs);
    const lease = this.leases.get(leaseId);
    if (!lease || lease.role !== "write") {
      throw new SandboxViolationError(
        "LEASE_ROLE_FORBIDDEN",
        "Active write lease is required to modify sandbox files.",
      );
    }
    return lease;
  }
}

const EXCLUSIVE_COMMAND_PATTERNS: ReadonlyArray<RegExp> = [
  /\b(?:pnpm|npm|yarn|bun)\s+(?:install|add|remove|ci|build|verify)\b/i,
  /\bcargo\s+(?:build|check|test|fetch)\b/i,
  /\bgit\s+(?:checkout|switch|merge|rebase|reset|clean|commit)\b/i,
  /\bdrizzle-kit\b/i,
];

/**
 * 判断终端命令是否会修改依赖锁、构建缓存或 Git 索引，需要在同一共享沙箱内串行互斥执行。
 *
 * @param command - 待执行的命令行文本
 * @returns 若需进入独占串行队列则返回 `true`
 */
export function isExclusiveSandboxCommand(command: string): boolean {
  return EXCLUSIVE_COMMAND_PATTERNS.some((re) => re.test(command));
}

/**
 * 共享沙箱命令调度队列（对齐 E2B `envd`）：
 * 互斥构建/安装命令严格按 FIFO 逐条执行，纯只读探测命令直接并发放行。
 */
export class SandboxCommandQueue {
  private tail: Promise<void> = Promise.resolve();

  /**
   * 调度一个命令任务：若属于互斥命令则排队等待前序互斥任务完成；否则立即执行。
   */
  public async run<T>(command: string, task: () => Promise<T>): Promise<T> {
    if (!isExclusiveSandboxCommand(command)) {
      return task();
    }
    const prev = this.tail;
    let releaseCurrent!: () => void;
    this.tail = new Promise<void>((resolveQueue) => {
      releaseCurrent = resolveQueue;
    });
    await prev;
    try {
      return await task();
    } finally {
      releaseCurrent();
    }
  }
}
