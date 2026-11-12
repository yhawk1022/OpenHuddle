/**
 * @module web/lib/format
 * @description 平台暖色粉彩头像/徽章元数据映射、自然可达状态文案、时间格式化、2 分钟撤回窗口计算与幂等键生成纯工具库。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 纯确定性无副作用：所有展示映射函数均使用 `assertNever` 对协议枚举做编译期穷尽检查，新增宿主平台或可达状态时编译器自动告警。
 * 2. Pachat 低饱和暖粉彩体系：摒弃高饱和霓虹渐变与廉价紫光阴影，统一采用 `#F4ECDD`、`#FFF1C2`、`#FBE3D9`、`#E1ECFF`、`#E4F4EA`、`#EFEAFF` 等温润纸感底色与克制的暗色对应色。
 * 3. 撤回时效对齐：前端撤回按钮显隐严格对齐后端 120 秒（2 分钟）业务窗口，避免无效点击。
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
 * 获取指定 `AgentPlatform` 的精简名称、Pachat 暖粉彩头像/徽章样式与接入说明。
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
          "border-black/[0.06] bg-[#EFEAFF] text-[#3F3368] dark:border-white/[0.08] dark:bg-[#242030] dark:text-[#D9D0F5]",
        avatarClass:
          "bg-[#EFEAFF] text-[#352A59] ring-1 ring-inset ring-black/[0.06] dark:bg-[#242030] dark:text-[#DFD7F7] dark:ring-white/[0.08]",
        cliHint: "读取 /install.md 自动完成绑定，支持本地 SSE 实时唤醒",
      };
    case "codex":
      return {
        label: "Codex",
        monogram: "CX",
        badgeClass:
          "border-black/[0.06] bg-[#E1ECFF] text-[#244375] dark:border-white/[0.08] dark:bg-[#1B2433] dark:text-[#C7DCFF]",
        avatarClass:
          "bg-[#E1ECFF] text-[#1E3A66] ring-1 ring-inset ring-black/[0.06] dark:bg-[#1B2433] dark:text-[#CFE1FF] dark:ring-white/[0.08]",
        cliHint: "支持零依赖单文件 CLI 监听并自动拉起 Codex 回复群消息",
      };
    case "claude_code":
      return {
        label: "Claude Code",
        monogram: "CC",
        badgeClass:
          "border-black/[0.06] bg-[#F4ECDD] text-[#5C4528] dark:border-white/[0.08] dark:bg-[#2B251D] dark:text-[#E7D3B5]",
        avatarClass:
          "bg-[#F4ECDD] text-[#4A351B] ring-1 ring-inset ring-black/[0.06] dark:bg-[#2B251D] dark:text-[#EAD8BC] dark:ring-white/[0.08]",
        cliHint: "在终端粘贴一句话引导词即可进群，支持后台实时唤醒",
      };
    case "cursor":
      return {
        label: "Cursor",
        monogram: "CR",
        badgeClass:
          "border-black/[0.06] bg-[#FFF1C2] text-[#5C4813] dark:border-white/[0.08] dark:bg-[#2C2718] dark:text-[#F2DF9D]",
        avatarClass:
          "bg-[#FFF1C2] text-[#4F3D0E] ring-1 ring-inset ring-black/[0.06] dark:bg-[#2C2718] dark:text-[#F5E4AA] dark:ring-white/[0.08]",
        cliHint: "支持在 IDE Composer 直接粘贴引导词或挂载 MCP 工具进群",
      };
    case "deepseek":
      return {
        label: "DeepSeek",
        monogram: "DS",
        badgeClass:
          "border-black/[0.06] bg-[#FBE3D9] text-[#663523] dark:border-white/[0.08] dark:bg-[#2E201B] dark:text-[#F2C7B6]",
        avatarClass:
          "bg-[#FBE3D9] text-[#572B1B] ring-1 ring-inset ring-black/[0.06] dark:bg-[#2E201B] dark:text-[#F5CEBF] dark:ring-white/[0.08]",
        cliHint: "擅长交叉核对事实与逻辑推演，支持 CLI 与 MCP 双通道接入",
      };
    case "openclaw":
      return {
        label: "OpenClaw",
        monogram: "OC",
        badgeClass:
          "border-black/[0.06] bg-[#E4F4EA] text-[#215236] dark:border-white/[0.08] dark:bg-[#192920] dark:text-[#BEE3CC]",
        avatarClass:
          "bg-[#E4F4EA] text-[#1B452D] ring-1 ring-inset ring-black/[0.06] dark:bg-[#192920] dark:text-[#C7E8D3] dark:ring-white/[0.08]",
        cliHint: "支持常驻后台守护监听群内 @ 提及与定时巡检",
      };
    case "gemini":
      return {
        label: "Gemini",
        monogram: "GM",
        badgeClass:
          "border-black/[0.06] bg-[#E1ECFF] text-[#244375] dark:border-white/[0.08] dark:bg-[#1B2433] dark:text-[#C7DCFF]",
        avatarClass:
          "bg-[#E1ECFF] text-[#1E3A66] ring-1 ring-inset ring-black/[0.06] dark:bg-[#1B2433] dark:text-[#CFE1FF] dark:ring-white/[0.08]",
        cliHint: "支持在 Gemini CLI 粘贴引导词绑定个人身份进群",
      };
    case "chatgpt":
      return {
        label: "ChatGPT",
        monogram: "GP",
        badgeClass:
          "border-black/[0.06] bg-[#E4F4EA] text-[#215236] dark:border-white/[0.08] dark:bg-[#192920] dark:text-[#BEE3CC]",
        avatarClass:
          "bg-[#E4F4EA] text-[#1B452D] ring-1 ring-inset ring-black/[0.06] dark:bg-[#192920] dark:text-[#C7E8D3] dark:ring-white/[0.08]",
        cliHint: "支持通过 Remote MCP 或桌面端工具连接参与群内讨论",
      };
    case "hosted":
      return {
        label: "Hosted",
        monogram: "AI",
        badgeClass:
          "border-black/[0.06] bg-[#F4ECDD] text-[#5C4528] dark:border-white/[0.08] dark:bg-[#2B251D] dark:text-[#E7D3B5]",
        avatarClass:
          "bg-[#F4ECDD] text-[#4A351B] ring-1 ring-inset ring-black/[0.06] dark:bg-[#2B251D] dark:text-[#EAD8BC] dark:ring-white/[0.08]",
        cliHint: "服务端托管 BYOK 模型角色，无需本地守护即可直接响应",
      };
    case "custom":
      return {
        label: "Custom",
        monogram: "CA",
        badgeClass:
          "border-black/[0.06] bg-[#EFEFF3] text-[#3A3A3C] dark:border-white/[0.08] dark:bg-[#27272A] dark:text-zinc-300",
        avatarClass:
          "bg-[#EFEFF3] text-[#141414] ring-1 ring-inset ring-black/[0.06] dark:bg-[#27272A] dark:text-zinc-200 dark:ring-white/[0.08]",
        cliHint: "支持任意兼容 HTTP、CLI 或 MCP 协议的自定义脚本接入",
      };
    default:
      return assertNever(platform);
  }
}

/**
 * 获取 Agent 在线可达状态（`reach`）的克制指示圆点与自然中文说明。
 *
 * @param reach - Agent 当前实时可达状态（缺省按 `offline` 处理）
 * @returns 圆点颜色（在线使用 `#34C759`）、胶囊类名与自然说明文案
 */
export function getReachVisualMeta(reach: AgentReachState | undefined): ReachVisualMeta {
  const effective = reach ?? "offline";
  switch (effective) {
    case "online_sse":
      return {
        label: "实时在线",
        shortLabel: "在线",
        description: "本地守护已建立实时连接，群内 @ 提及可立即唤醒回复",
        dotClass: "bg-[#34C759]",
        pillClass:
          "border-black/[0.06] bg-[#E4F4EA] text-[#215236] dark:border-white/[0.08] dark:bg-[#192920] dark:text-[#86E0A6]",
      };
    case "hosted_ready":
      return {
        label: "云端在线",
        shortLabel: "在线",
        description: "服务端托管模型已就绪，可随时响应讨论与提案表决",
        dotClass: "bg-[#34C759]",
        pillClass:
          "border-black/[0.06] bg-[#E4F4EA] text-[#215236] dark:border-white/[0.08] dark:bg-[#192920] dark:text-[#86E0A6]",
      };
    case "webhook":
      return {
        label: "Webhook 在线",
        shortLabel: "Webhook",
        description: "通过已注册的 HTTPS Webhook 实时接收房间唤醒事件",
        dotClass: "bg-[#2F6FED]",
        pillClass:
          "border-black/[0.06] bg-[#E1ECFF] text-[#244375] dark:border-white/[0.08] dark:bg-[#1B2433] dark:text-[#9EC5FF]",
      };
    case "polling":
      return {
        label: "定时巡检",
        shortLabel: "巡检中",
        description: "处于周期性收件箱检查模式，将在下次巡检窗口回复",
        dotClass: "bg-[#D99B26] dark:bg-[#E5B34B]",
        pillClass:
          "border-black/[0.06] bg-[#FFF1C2] text-[#5C4813] dark:border-white/[0.08] dark:bg-[#2C2718] dark:text-[#F2DF9D]",
      };
    case "offline":
      return {
        label: "暂不在线",
        shortLabel: "离线",
        description: "当前未检测到活跃的实时连接，可在终端运行 listen 唤醒",
        dotClass: "bg-[#C7C7CC] dark:bg-zinc-600",
        pillClass:
          "border-black/[0.06] bg-[#F5F5F7] text-[#6E6E73] dark:border-white/[0.08] dark:bg-[#1C1C1F] dark:text-zinc-400",
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
