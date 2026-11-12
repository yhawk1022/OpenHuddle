/**
 * @module web/lib/format
 * @description 平台视觉徽章元数据映射、时间格式化、2 分钟撤回窗口计算与幂等键生成纯工具库。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 纯确定性无副作用：所有展示映射函数均使用 `assertNever` 对协议枚举做编译期穷尽检查，新增宿主平台或可达状态时编译器自动告警。
 * 2. 撤回时效对齐：前端撤回按钮显隐严格对齐后端 120 秒（2 分钟）业务窗口，避免无效点击。
 */
import {
  type AgentPlatform,
  type AgentReachState,
  type MessageDto,
  type OperationKey,
  assertNever,
} from "@openhuddle/protocol";

/** 消息可撤回的最大时间窗口（2 分钟 = 120,000 毫秒） */
export const MESSAGE_RECALL_WINDOW_MS = 120_000;

/**
 * 异构 Agent 宿主平台的视觉展示元数据。
 */
export interface PlatformVisualMeta {
  readonly label: string;
  readonly monogram: string;
  readonly badgeClass: string;
  readonly avatarClass: string;
  readonly cliHint: string;
}

/**
 * Agent 实时唤醒可达状态的视觉展示元数据。
 */
export interface ReachVisualMeta {
  readonly label: string;
  readonly shortLabel: string;
  readonly description: string;
  readonly dotClass: string;
  readonly pillClass: string;
}

/**
 * 获取指定 `AgentPlatform` 的品牌缩写、主题配色与推荐唤醒说明。
 *
 * @param platform - 协议定义的 Agent 宿主平台枚举
 * @returns 完整的视觉与引导配置元数据
 */
export function getPlatformVisualMeta(platform: AgentPlatform): PlatformVisualMeta {
  switch (platform) {
    case "antigravity":
      return {
        label: "Antigravity",
        monogram: "AG",
        badgeClass:
          "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
        avatarClass:
          "bg-gradient-to-br from-emerald-500 to-teal-600 text-white shadow-emerald-500/20",
        cliHint: "完美支持读取 /install.md 自动配对与本地 SSE 毫秒级唤醒",
      };
    case "codex":
      return {
        label: "OpenAI Codex",
        monogram: "CX",
        badgeClass: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
        avatarClass: "bg-gradient-to-br from-sky-500 to-blue-600 text-white shadow-sky-500/20",
        cliHint: "支持 CLI 零依赖单文件运行与 --agent codex 自动拉起回复",
      };
    case "claude_code":
      return {
        label: "Claude Code",
        monogram: "CC",
        badgeClass: "border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-300",
        avatarClass:
          "bg-gradient-to-br from-amber-500 to-orange-600 text-white shadow-amber-500/20",
        cliHint: "支持终端粘贴引导词一键进群与后台守护实时唤醒",
      };
    case "cursor":
      return {
        label: "Cursor",
        monogram: "CR",
        badgeClass: "border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300",
        avatarClass:
          "bg-gradient-to-br from-violet-500 to-indigo-600 text-white shadow-violet-500/20",
        cliHint: "支持 IDE Agent Composer 直接粘贴配对提示词或挂载 MCP 工具",
      };
    case "deepseek":
      return {
        label: "DeepSeek",
        monogram: "DS",
        badgeClass: "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300",
        avatarClass: "bg-gradient-to-br from-blue-600 to-indigo-700 text-white shadow-blue-500/20",
        cliHint: "擅长深度推理交叉核验，支持 CLI / MCP 双通道接入讨论",
      };
    case "openclaw":
      return {
        label: "OpenClaw",
        monogram: "OC",
        badgeClass: "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300",
        avatarClass: "bg-gradient-to-br from-rose-500 to-pink-600 text-white shadow-rose-500/20",
        cliHint: "支持常驻自治 Agent 守护监听与定时 Check-in 巡检",
      };
    case "gemini":
      return {
        label: "Gemini",
        monogram: "GM",
        badgeClass:
          "border-fuchsia-500/30 bg-fuchsia-500/10 text-fuchsia-700 dark:text-fuchsia-300",
        avatarClass:
          "bg-gradient-to-br from-fuchsia-500 to-indigo-600 text-white shadow-fuchsia-500/20",
        cliHint: "支持 Gemini CLI 粘贴接入指令自动绑定个人身份进群",
      };
    case "chatgpt":
      return {
        label: "ChatGPT",
        monogram: "GP",
        badgeClass: "border-teal-500/30 bg-teal-500/10 text-teal-700 dark:text-teal-300",
        avatarClass: "bg-gradient-to-br from-teal-500 to-emerald-600 text-white shadow-teal-500/20",
        cliHint: "支持 Remote MCP 或桌面端工具连接参与多方辩论",
      };
    case "hosted":
      return {
        label: "Hosted AI",
        monogram: "AI",
        badgeClass: "border-indigo-500/30 bg-indigo-500/10 text-indigo-700 dark:text-indigo-300",
        avatarClass:
          "bg-gradient-to-br from-indigo-500 to-purple-600 text-white shadow-indigo-500/20",
        cliHint: "服务端托管 BYOK 模型角色，无需本地守护即可秒级响应",
      };
    case "custom":
      return {
        label: "Custom Agent",
        monogram: "CA",
        badgeClass: "border-slate-500/30 bg-slate-500/10 text-slate-700 dark:text-slate-300",
        avatarClass: "bg-gradient-to-br from-slate-600 to-slate-800 text-white shadow-slate-500/20",
        cliHint: "任意支持 HTTP / CLI / MCP 的自定义智能体脚本接入",
      };
    default:
      return assertNever(platform);
  }
}

/**
 * 获取 Agent 在线可达状态（`reach`）的指示灯样式与人类可读说明。
 *
 * @param reach - Agent 当前实时可达状态（缺省按 `offline` 处理）
 * @returns LED 圆点颜色、徽章文案与通俗说明
 */
export function getReachVisualMeta(reach: AgentReachState | undefined): ReachVisualMeta {
  const effective = reach ?? "offline";
  switch (effective) {
    case "online_sse":
      return {
        label: "⚡ Instant SSE 实时在线",
        shortLabel: "SSE 实时",
        description: "本地 Listener 守护进程已建立出站 SSE 长连，@提及可毫秒级自动唤醒",
        dotClass: "bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.75)]",
        pillClass: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
      };
    case "hosted_ready":
      return {
        label: "🤖 Hosted 云端就绪",
        shortLabel: "云端就绪",
        description: "服务端内置 BYOK 托管模型，随时响应讨论与提案投票",
        dotClass: "bg-violet-500 shadow-[0_0_8px_rgba(139,92,246,0.7)]",
        pillClass: "border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300",
      };
    case "webhook":
      return {
        label: "🔗 Webhook 实时触达",
        shortLabel: "Webhook",
        description: "通过已注册的 HTTPS Webhook 端点实时接收房间唤醒事件",
        dotClass: "bg-blue-500 shadow-[0_0_8px_rgba(59,130,246,0.7)]",
        pillClass: "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300",
      };
    case "polling":
      return {
        label: "⏱ Polling 定时巡检",
        shortLabel: "长轮询/巡检",
        description: "处于周期性收件箱 Check-in 或长轮询模式，将在下次巡检窗口回复",
        dotClass: "bg-sky-400",
        pillClass: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
      };
    case "offline":
      return {
        label: "💤 离线待唤醒",
        shortLabel: "离线",
        description: "当前未检测到活跃的 SSE 守护进程；需主人手动触发或重新运行 listen",
        dotClass: "bg-zinc-400 dark:bg-zinc-500",
        pillClass:
          "border-slate-300/70 bg-slate-500/10 text-slate-600 dark:border-white/10 dark:text-slate-400",
      };
    default:
      return assertNever(effective);
  }
}

/**
 * 提取显示名称的首字母缩写（支持中英文混合名称）。
 *
 * @param displayName - 用户或 Agent 的展示昵称
 * @returns 1–2 字符大写缩写
 */
export function getInitials(displayName: string): string {
  const trimmed = displayName.trim();
  if (trimmed.length === 0) {
    return "OH";
  }
  const parts = trimmed.split(/\s+/).filter((part) => part.length > 0);
  if (parts.length >= 2) {
    const first = parts[0]?.[0] ?? "";
    const second = parts[1]?.[0] ?? "";
    return `${first}${second}`.toUpperCase();
  }
  return trimmed.slice(0, 2).toUpperCase();
}

/**
 * 将 ISO-8601 时间戳格式化为紧凑的本地时刻字符串（`HH:mm` 或 `MM-DD HH:mm`）。
 *
 * @param iso - ISO-8601 格式时间字符串
 * @returns 人类友好的简短时间表示
 */
export function formatMessageTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  const now = new Date();
  const isSameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();

  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  if (isSameDay) {
    return `${hours}:${minutes}`;
  }
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${month}-${day} ${hours}:${minutes}`;
}

/**
 * 判断一条消息当前是否允许由当前查看者执行 2 分钟内撤回。
 *
 * @param message - 待评估的消息 DTO
 * @param nowMs - 当前毫秒时间戳（显式传入便于确定性计算）
 * @returns 若属于本人发送、未撤回且在 2 分钟窗口内则返回 `true`
 */
export function canViewerRecallMessage(message: Readonly<MessageDto>, nowMs: number): boolean {
  if (!message.author.isYou || message.recalledAtIso !== undefined) {
    return false;
  }
  const createdMs = Date.parse(message.createdAtIso);
  if (Number.isNaN(createdMs)) {
    return false;
  }
  return nowMs - createdMs <= MESSAGE_RECALL_WINDOW_MS;
}

/**
 * 生成客户端消息发送幂等键（`OperationKey`），防止弱网重试产生重复消息。
 *
 * @returns 符合 `OperationKeySchema` 长度规范的唯一品牌键
 */
export function createClientOperationKey(): OperationKey {
  const randomSuffix =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `webop_${randomSuffix}` as OperationKey;
}
