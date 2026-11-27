/**
 * @module web/features/huddle-room/work/work-utils
 * @description 任务编排与个人工作台共享纯函数与状态图标组件（消除跨视图重复实现）。
 *
 * 关键不变量：
 * 1. 编译期穷尽检查：所有基于 `WorkStage` 与 `WorkTopology` 的展示映射统一经 `assertNever` 守卫。
 * 2. 零副作用：仅包含文本解析、名称去前缀、时长格式化与受控剪贴板复制提示。
 */
import {
  type OwnedAgentSummaryDto,
  type SupportedLocale,
  type WorkSliceRole,
  assertNever,
} from "@openhuddle/protocol";
import { CheckCircle2, Circle, CircleAlert, Loader2 } from "lucide-react";
import { cn, toast } from "../../../components/primitives/index.js";
import { defaultAgentReplyMode } from "../../auth-pairing/connect-instructions.js";
import { getWorkbenchTranslator } from "../i18n/workbench.js";
import type { UpsertAgentWorkspaceInput } from "./solo-workbench-store.js";
import type { WorkStage, WorkTopology } from "./work-types.js";

/**
 * 获取协作拓扑方式的简明本地化标签。
 *
 * @param topology - 协作拓扑枚举
 * @param locale - 可选目标语种（缺省读取当前生效语种）
 * @returns 用于界面展示的拓扑名称
 */
export function getWorkTopologyLabel(topology: WorkTopology, locale?: SupportedLocale): string {
  const { t } = getWorkbenchTranslator(locale);
  switch (topology) {
    case "direct":
      return t("topology.direct.label");
    case "verify_loop":
      return t("topology.verifyLoop.label");
    case "swarm":
      return t("topology.swarm.label");
    default:
      return assertNever(topology);
  }
}

/**
 * 判断工作区当前配置是否支持「多路并行（swarm）」按目录拆分写入。
 *
 * @remarks
 * 写入路径需能唯一定位到根目录，名称匹配与执行器均忽略大小写。
 */
export function workspaceSupportsSwarm(ws: {
  readonly roots: readonly { readonly name: string }[];
  readonly sandboxMode: string;
}): boolean {
  const names = ws.roots.map((root) => root.name.trim().toLowerCase());
  return (
    ws.sandboxMode !== "read_only" &&
    names.length >= 2 &&
    !names.includes("") &&
    new Set(names).size === names.length
  );
}

/**
 * 将工作区名称清洗为安全的单级默认目录段（禁止 `/`, `\`, `..` 与前导 `.`，非法输入回退为 `"workspace"`）。
 */
export function sanitizeWorkspaceDirSegment(rawName: string): string {
  const cleaned = rawName
    .trim()
    .replace(/\p{Cc}/gu, "")
    .replace(/[\\/]+/g, "-")
    .replace(/\.{2,}/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[.\-\s]+/, "")
    .replace(/[.\-\s]+$/, "");
  return cleaned || "workspace";
}

/**
 * 从受控目录路径末尾段推导根目录短名（与服务端 `normalizeRootInputs` 保持同源规则）。
 */
export function inferWorkspaceRootName(localPath: string, index: number): string {
  const normalized = localPath.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  const lastSegment = normalized.split("/").pop()?.trim() ?? "";
  return lastSegment.slice(0, 120) || `root-${index + 1}`;
}

/** Resolve the editor and both save paths from the same set of nonempty roots. */
export function normalizeWorkspaceRoots(
  input: Pick<UpsertAgentWorkspaceInput, "name" | "kind" | "roots">,
) {
  const segment = sanitizeWorkspaceDirSegment(input.name);
  const base = input.kind === "folder" ? `~/Documents/${segment}` : `~/Developer/${segment}`;
  const filled = input.roots.filter((root) => root.localPath.trim().length > 0);
  const defaults = input.kind === "multi_root" ? [`${base}-api`, `${base}-web`] : [base];
  const effective =
    filled.length > 0
      ? filled
      : defaults.map((localPath, index) => ({
          ...input.roots[index],
          localPath,
        }));
  const roots = effective.map((root, index) => ({
    localPath: root.localPath.trim(),
    name: root.name?.trim() || inferWorkspaceRootName(root.localPath, index),
    ...(input.kind !== "folder" ? { defaultBranch: root.defaultBranch?.trim() || "main" } : {}),
  }));
  const kind = roots.length > 1 ? "multi_root" : input.kind === "folder" ? "folder" : "git_repo";
  return { roots, kind } as const;
}

/**
 * 在 `swarm` 不可用时统一计算安全回退拓扑：
 * 当 Agent 数 `<= 1` 或工作区为普通文件夹时收敛为 `"direct"`，否则收敛为 `"verify_loop"`。
 */
export function resolveEffectiveDispatchTopology(params: {
  readonly requested: WorkTopology;
  readonly workspace:
    | {
        readonly kind?: string | undefined;
        readonly roots: readonly { readonly name: string }[];
        readonly sandboxMode: string;
      }
    | undefined;
  readonly agentCount: number;
}): WorkTopology {
  if (params.requested !== "swarm") {
    return params.requested;
  }
  if (params.workspace !== undefined && workspaceSupportsSwarm(params.workspace)) {
    return "swarm";
  }
  if (params.agentCount <= 1 || params.workspace?.kind === "folder") {
    return "direct";
  }
  return "verify_loop";
}

/** 等待中的执行和复核分片只有在各自阶段才能认领。 */
export function getSliceWaitLabel(
  stage: WorkStage,
  role: WorkSliceRole | undefined,
  locale?: SupportedLocale,
): string {
  const { t } = getWorkbenchTranslator(locale);
  if (stage === "awaiting_answer") return t("slice.wait.awaitingAnswer");
  if (stage === "blocked" || stage === "cancelled") return t("slice.wait.paused");
  if (role === "verify" && stage === "working") return t("slice.wait.waitingExec");
  return t("slice.wait.queued");
}

export function getClaimListenerHint(
  agent:
    | Pick<OwnedAgentSummaryDto, "platform" | "reach" | "workspaceListenerConnected">
    | undefined,
  locale?: SupportedLocale,
): { message: string; showInstallGuide: boolean } | undefined {
  if (!agent || agent.workspaceListenerConnected === true) return undefined;
  const { t } = getWorkbenchTranslator(locale);

  if (defaultAgentReplyMode(agent.platform) === "on_demand") {
    return {
      message: t("claimHint.onDemand"),
      showInstallGuide: true,
    };
  }
  const message =
    agent.reach === "offline"
      ? t("claimHint.offline")
      : agent.workspaceListenerConnected === false
        ? t("claimHint.listenerDisconnected")
        : t("claimHint.fallback");
  return {
    message,
    showInstallGuide: true,
  };
}

/**
 * 获取工单阶段的简明本地化状态文案。
 *
 * @param stage - 工单阶段枚举
 * @param locale - 可选目标语种（缺省读取当前生效语种）
 * @returns 面向用户的阶段说明文本
 */
export function formatWorkStageLabel(stage: WorkStage, locale?: SupportedLocale): string {
  const { t } = getWorkbenchTranslator(locale);
  switch (stage) {
    case "working":
      return t("stage.working");
    case "verifying":
      return t("stage.verifying");
    case "awaiting_answer":
      return t("stage.awaitingAnswer");
    case "awaiting_review":
      return t("stage.awaitingReview");
    case "done":
      return t("stage.done");
    case "blocked":
      return t("stage.blocked");
    case "cancelled":
      return t("stage.cancelled");
    default:
      return assertNever(stage);
  }
}

/**
 * 解析提示词前导斜杠指令（`/swarm`、`/verify`、`/task`），提取生效的协作拓扑与净荷正文。
 *
 * @param rawPrompt - 用户输入的原始提示词
 * @param fallbackTopology - 未携带斜杠指令时采用的默认拓扑
 * @returns 解析后的拓扑与去除指令前缀的正文
 */
export function parsePromptTopologyDirective(
  rawPrompt: string,
  fallbackTopology: WorkTopology,
): { readonly topology: WorkTopology; readonly body: string } {
  const trimmed = rawPrompt.trim();
  if (/^\/swarm\s+/i.test(trimmed)) {
    return { topology: "swarm", body: trimmed.replace(/^\/swarm\s+/i, "").trim() };
  }
  if (/^\/verify\s+/i.test(trimmed)) {
    return { topology: "verify_loop", body: trimmed.replace(/^\/verify\s+/i, "").trim() };
  }
  if (/^\/task\s+/i.test(trimmed)) {
    return { topology: fallbackTopology, body: trimmed.replace(/^\/task\s+/i, "").trim() };
  }
  return { topology: fallbackTopology, body: trimmed };
}

/**
 * 剥离本人名下 Agent 昵称中的主人姓名前缀（例如在已知本人上下文时将 `庞彦-Codex` 精简为 `Codex`）。
 *
 * @param displayName - Agent 原始展示名
 * @param ownerDisplayName - 主人展示名
 * @returns 紧凑展示名称
 */
export function stripAgentOwnerPrefix(displayName: string, ownerDisplayName: string): string {
  const clean = displayName.trim();
  const owner = ownerDisplayName.trim();
  if (owner.length > 0) {
    for (const sep of ["-", "—", "_", "·", " "]) {
      const prefix = `${owner}${sep}`;
      if (clean.startsWith(prefix) && clean.length > prefix.length) {
        return clean.slice(prefix.length).trim();
      }
    }
  }
  return clean;
}

/**
 * 将秒数格式化为紧凑时长字符串（如 `34s`、`2m 15s`）。
 *
 * @param seconds - 已耗时秒数
 * @returns 紧凑可读时长
 */
export function formatElapsedCompact(seconds: number): string {
  if (seconds < 60) {
    return `${String(seconds)}s`;
  }
  const mins = Math.floor(seconds / 60);
  const rem = seconds % 60;
  return rem > 0 ? `${String(mins)}m ${String(rem)}s` : `${String(mins)}m`;
}

/**
 * 复制文本至系统剪贴板并弹出轻量反馈通知；受限环境下退化为直接展示文本通知。
 *
 * @param value - 待复制字符串
 * @param title - 反馈标题
 */
export function copyTextWithFeedback(value: string, title: string): void {
  if (typeof navigator !== "undefined" && navigator.clipboard) {
    void navigator.clipboard.writeText(value).then(() => {
      toast.success(title, { description: value });
    });
  } else {
    toast.info(title, { description: value });
  }
}

/** `WorkStageGlyph` 属性 */
export interface WorkStageGlyphProps {
  readonly stage: WorkStage;
  readonly size?: "sm" | "md" | undefined;
  readonly className?: string | undefined;
}

/**
 * 渲染统一视觉语义的工单状态几何图标（供工作台、时间线卡片与右侧任务抽屉复用）。
 */
export function WorkStageGlyph(props: WorkStageGlyphProps) {
  const sizeClass = props.size === "md" ? "h-[15px] w-[15px]" : "h-3.5 w-3.5";

  switch (props.stage) {
    case "awaiting_answer":
    case "awaiting_review":
      return (
        <CircleAlert
          aria-hidden="true"
          className={cn(sizeClass, "shrink-0 text-[#D97706] dark:text-[#FBBF24]", props.className)}
        />
      );
    case "blocked":
      return (
        <CircleAlert
          aria-hidden="true"
          className={cn(sizeClass, "shrink-0 text-[#DC2626] dark:text-[#F87171]", props.className)}
        />
      );
    case "working":
    case "verifying":
      return (
        <Loader2
          aria-hidden="true"
          className={cn(
            sizeClass,
            "shrink-0 animate-spin text-[#16A34A] dark:text-[#4ADE80]",
            props.className,
          )}
        />
      );
    case "done":
      return (
        <CheckCircle2
          aria-hidden="true"
          className={cn(sizeClass, "shrink-0 text-[#8E96A6] dark:text-[#71717A]", props.className)}
        />
      );
    case "cancelled":
      return (
        <Circle
          aria-hidden="true"
          className={cn(sizeClass, "shrink-0 text-[#94A3B8] dark:text-[#52525B]", props.className)}
        />
      );
    default:
      return assertNever(props.stage);
  }
}
