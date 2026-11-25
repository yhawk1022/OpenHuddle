/**
 * @module web/features/huddle-room/work/work-utils
 * @description 任务编排与个人工作台共享纯函数与状态图标组件（消除跨视图重复实现）。
 *
 * 关键不变量：
 * 1. 编译期穷尽检查：所有基于 `WorkStage` 与 `WorkTopology` 的展示映射统一经 `assertNever` 守卫。
 * 2. 零副作用：仅包含文本解析、名称去前缀、时长格式化与受控剪贴板复制提示。
 */
import { assertNever } from "@openhuddle/protocol";
import { CheckCircle2, Circle, CircleAlert, Loader2 } from "lucide-react";
import { cn, toast } from "../../../components/primitives/index.js";
import type { WorkStage, WorkTopology } from "./work-types.js";

/**
 * 获取协作拓扑方式的简明中文标签。
 *
 * @param topology - 协作拓扑枚举
 * @returns 用于界面展示的中文名称
 */
export function getWorkTopologyLabel(topology: WorkTopology): string {
  switch (topology) {
    case "direct":
      return "单人执行";
    case "verify_loop":
      return "双人复核";
    case "swarm":
      return "多路并行";
    default:
      return assertNever(topology);
  }
}

/**
 * 获取工单阶段的简明中文状态文案。
 *
 * @param stage - 工单阶段枚举
 * @returns 面向用户的阶段说明文本
 */
export function formatWorkStageLabel(stage: WorkStage): string {
  switch (stage) {
    case "working":
      return "进行中";
    case "verifying":
      return "复核中";
    case "awaiting_answer":
      return "待确认";
    case "awaiting_review":
      return "待签收";
    case "done":
      return "已完成";
    case "blocked":
      return "已暂停";
    case "cancelled":
      return "已停止";
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
