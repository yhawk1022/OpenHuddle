/**
 * @module web/lib/agent-capability-prefs
 * @description 个人 Agent 本地工作区能力档位（Tier 0/1/2）、温热会话驻留与原生双模引擎（Orchestrator）前端配置存储。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 单向共享边界：下沉于 `src/lib/`，同时供 `auth-pairing`（接入弹窗）、`components/ui`（Agent 名片）与 `huddle-room`（派活舱、成员能力徽章）无环共享，严守兄弟 feature 不互引铁律。
 * 2. 默认最小权限（Owner-First Tier 0）：任何未由主人显式配置本地工作区的 Agent 默认恒为 `chat_only`（纯讨论，零本地文件读写）；外部主人的 Agent 在 UI 与派活层强制降级展示为只读协作参考。
 */
import { type AgentId, type AgentPlatform, assertNever } from "@openhuddle/protocol";
import { useCallback, useSyncExternalStore } from "react";

/**
 * 本地守护进程可执行能力等级（对齐 Owner-First 三级门禁）。
 * - `chat_only`：Tier 0，仅允许纯文本/Markdown 讨论与提案表态（默认安全态）
 * - `workspace_read`：Tier 1，允许在绑定目录内只读探查与交叉审查（免建 Worktree）
 * - `worktree_write`：Tier 2，允许在隔离 `git worktree` 中执行本人签批的改码与测试工单
 */
export type AgentExecutionTier = "chat_only" | "workspace_read" | "worktree_write";

/**
 * 单个本人名下 Agent 的本地执行与提速偏好配置。
 */
export interface AgentCapabilityPref {
  readonly tier: AgentExecutionTier;
  readonly workspacePath: string;
  /** 是否开启 15 分钟温热会话驻留（复用 `--resume` / 常驻会话命中 KV Cache） */
  readonly warmSessionEnabled: boolean;
  /** 针对支持内置双模切换的宿主（如 Antigravity），是否启用单兵原生 Orchestrator 模式 */
  readonly nativeOrchestratorEnabled: boolean;
}

/**
 * 能力档位对应的视觉徽章元数据。
 */
export interface ExecutionTierBadgeMeta {
  readonly tier: AgentExecutionTier;
  readonly shortLabel: string;
  readonly fullLabel: string;
  readonly description: string;
  readonly cliFlags: string;
  readonly pillClassName: string;
}

const STORAGE_KEY = "openhuddle:agent-capability-prefs:v1";

const DEFAULT_PREF: AgentCapabilityPref = {
  tier: "chat_only",
  workspacePath: "",
  warmSessionEnabled: true,
  nativeOrchestratorEnabled: false,
};

const EMPTY_PREFS_MAP: ReadonlyMap<string, AgentCapabilityPref> = new Map();

let cachedMap: ReadonlyMap<string, AgentCapabilityPref> | null = null;
const listeners = new Set<() => void>();
let storageListenerBound = false;

function ensureCrossTabStorageSync(): void {
  if (storageListenerBound || typeof window === "undefined") {
    return;
  }
  storageListenerBound = true;
  window.addEventListener("storage", (ev) => {
    if (ev.key === STORAGE_KEY || ev.key === null) {
      cachedMap = null;
      for (const listener of listeners) {
        listener();
      }
    }
  });
}

function loadFromStorage(): ReadonlyMap<string, AgentCapabilityPref> {
  if (cachedMap !== null) {
    return cachedMap;
  }
  if (typeof window === "undefined") {
    cachedMap = new Map();
    return cachedMap;
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      cachedMap = new Map();
      return cachedMap;
    }
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      cachedMap = new Map();
      return cachedMap;
    }
    const next = new Map<string, AgentCapabilityPref>();
    for (const [key, val] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof val !== "object" || val === null) {
        continue;
      }
      const record = val as Record<string, unknown>;
      const tier: AgentExecutionTier =
        record.tier === "workspace_read" || record.tier === "worktree_write"
          ? record.tier
          : "chat_only";
      next.set(key, {
        tier,
        workspacePath: typeof record.workspacePath === "string" ? record.workspacePath : "",
        warmSessionEnabled:
          typeof record.warmSessionEnabled === "boolean" ? record.warmSessionEnabled : true,
        nativeOrchestratorEnabled:
          typeof record.nativeOrchestratorEnabled === "boolean"
            ? record.nativeOrchestratorEnabled
            : false,
      });
    }
    cachedMap = next;
    return cachedMap;
  } catch {
    cachedMap = new Map();
    return cachedMap;
  }
}

function persistMap(next: ReadonlyMap<string, AgentCapabilityPref>): void {
  cachedMap = next;
  if (typeof window !== "undefined") {
    try {
      const obj: Record<string, AgentCapabilityPref> = {};
      for (const [k, v] of next.entries()) {
        obj[k] = v;
      }
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
    } catch {
      // 隐私无痕窗口配额受限时仅维持内存态，不阻断交互
    }
  }
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  ensureCrossTabStorageSync();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * 清理内存缓存的能力偏好快照（用于账号登出或测试隔离）。
 */
export function resetAgentCapabilityPrefsMemory(): void {
  cachedMap = null;
  for (const listener of listeners) {
    listener();
  }
}

/**
 * 获取指定能力档位的文案、说明、守护 CLI 参数与双主题胶囊样式。
 *
 * @param tier - 能力档位枚举
 * @returns 用于渲染徽章与配置项的完整视觉描述
 */
export function getExecutionTierMeta(tier: AgentExecutionTier): ExecutionTierBadgeMeta {
  switch (tier) {
    case "chat_only":
      return {
        tier,
        shortLabel: "仅讨论",
        fullLabel: "仅讨论",
        description: "可以聊天和投票，不能读写本地文件。",
        cliFlags: "",
        pillClassName:
          "bg-black/[0.05] text-[#687082] ring-black/[0.05] dark:bg-white/[0.07] dark:text-[#9B9BA3] dark:ring-white/[0.08]",
      };
    case "workspace_read":
      return {
        tier,
        shortLabel: "查看代码",
        fullLabel: "只读访问代码库",
        description: "可以查看代码和审查改动，不能修改文件。",
        cliFlags: "--allow-read",
        pillClassName:
          "bg-[#E1ECFF]/85 text-[#1E40AF] ring-[#2563EB]/15 dark:bg-[#1A273D] dark:text-[#93C5FD] dark:ring-[#60A5FA]/25",
      };
    case "worktree_write":
      return {
        tier,
        shortLabel: "修改代码",
        fullLabel: "在独立工作树中修改代码",
        description: "你批准任务后，Agent 可以在独立的 Git 工作树中修改代码并运行测试。",
        cliFlags: "--allow-worktree",
        pillClassName:
          "bg-[#E6F5EC] text-[#145335] ring-[#16A34A]/18 dark:bg-[#1B2B23] dark:text-[#6EE7B7] dark:ring-[#34D399]/25",
      };
    default:
      return assertNever(tier);
  }
}

/**
 * 读取指定 Agent 的本地能力配置（未配置时返回安全默认项，Antigravity 默认推荐开启原生双模）。
 *
 * @param agentId - 目标 Agent ID（为空时返回默认配置）
 * @param platform - 可选宿主平台，用于推导平台默认提速开关
 * @returns 不可变的能力偏好对象
 */
export function getAgentCapabilityPref(
  agentId: AgentId | string | null | undefined,
  platform?: AgentPlatform | undefined,
): AgentCapabilityPref {
  const map = loadFromStorage();
  if (agentId) {
    const found = map.get(agentId);
    if (found !== undefined) {
      return found;
    }
  }
  return {
    ...DEFAULT_PREF,
    nativeOrchestratorEnabled: platform === "antigravity",
  };
}

/**
 * 更新指定 Agent 的本地能力与提速配置，并广播给所有订阅组件即时刷新徽章。
 *
 * @param agentId - 目标 Agent ID
 * @param patch - 局部更新字段
 * @param platform - 可选平台枚举
 */
export function updateAgentCapabilityPref(
  agentId: AgentId | string,
  patch: Partial<AgentCapabilityPref>,
  platform?: AgentPlatform | undefined,
): void {
  const current = getAgentCapabilityPref(agentId, platform);
  const next = new Map(loadFromStorage());
  next.set(agentId, {
    ...current,
    ...patch,
  });
  persistMap(next);
}

/**
 * 根据用户在接入弹窗中勾选的工作区能力与温热驻留参数，拼接附加给 `openhuddle listen install` 的命令行参数预览。
 *
 * @param pref - 当前编辑中的能力配置
 * @param platform - 当前选择的 Agent 平台
 * @returns 空格分隔的附加 CLI 标志字符串（全默认纯聊天时可精简）
 */
export function formatDaemonCapabilityCliFlags(
  pref: Readonly<AgentCapabilityPref>,
  platform: AgentPlatform,
): string {
  const flags: string[] = [];
  const trimmedPath = pref.workspacePath.trim();
  if (pref.tier !== "chat_only" && trimmedPath.length > 0) {
    flags.push(`--workspace ${JSON.stringify(trimmedPath)}`);
  }
  if (pref.tier === "workspace_read") {
    flags.push("--allow-read");
  } else if (pref.tier === "worktree_write") {
    flags.push("--allow-worktree");
  }
  if (pref.warmSessionEnabled) {
    flags.push("--warm-session 15m");
  }
  if (platform === "antigravity" && pref.nativeOrchestratorEnabled) {
    flags.push('--model "Orchestrator (Carbon)"');
  }
  return flags.join(" ");
}

/**
 * React 订阅 Hook：响应式读取全部个人 Agent 的本地能力配置字典。
 *
 * @returns 只读 `Map<agentId, AgentCapabilityPref>` 及便捷更新回调
 */
export function useAgentCapabilityPrefs(): {
  readonly prefsByAgentId: ReadonlyMap<string, AgentCapabilityPref>;
  readonly getPref: (
    agentId: AgentId | string | null | undefined,
    platform?: AgentPlatform | undefined,
  ) => AgentCapabilityPref;
  readonly setPref: (
    agentId: AgentId | string,
    patch: Partial<AgentCapabilityPref>,
    platform?: AgentPlatform | undefined,
  ) => void;
} {
  const prefsByAgentId = useSyncExternalStore(subscribe, loadFromStorage, () => EMPTY_PREFS_MAP);
  const getPref = useCallback(
    (agentId: AgentId | string | null | undefined, platform?: AgentPlatform | undefined) => {
      if (agentId) {
        const hit = prefsByAgentId.get(agentId);
        if (hit !== undefined) {
          return hit;
        }
      }
      return {
        ...DEFAULT_PREF,
        nativeOrchestratorEnabled: platform === "antigravity",
      };
    },
    [prefsByAgentId],
  );

  return {
    prefsByAgentId,
    getPref,
    setPref: updateAgentCapabilityPref,
  };
}
