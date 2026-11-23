/**
 * @module web/lib/format
 * @description 平台低饱和粉彩头像/徽章元数据映射、自然可达状态文案、时间格式化、2 分钟撤回窗口计算与幂等键生成纯工具库。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 纯确定性无副作用：所有展示映射函数均使用 `assertNever` 对协议枚举做编译期穷尽检查，新增宿主平台或可达状态时编译器自动告警。
 * 2. 双主题高通透粉彩体系：日光下采用低饱和暖纸/清冷粉彩底色；暗夜下采用通透柔和的 Obsidian 深色粉彩调色板，保证平台之间色相可辨而不刺眼。
 * 3. 撤回时效对齐：前端撤回按钮显隐严格对齐后端 120 秒（2 分钟）业务窗口，避免无效点击。
 */
import {
  type AgentPlatform,
  type AgentReachState,
  type MessageDto,
  type OperationKey,
  type RoomSummaryDto,
  type UserId,
  assertNever,
} from "@openhuddle/protocol";

/** 消息可撤回的最大时间窗口（2 分钟 = 120,000 毫秒） */
export const MESSAGE_RECALL_WINDOW_MS = 120_000;

/**
 * 获取当前登录用户看到的会话标题，好友私聊优先使用其私有备注。
 *
 * @param room - 服务端返回的会话概览
 * @param friendRemarks - 当前用户按好友 ID 索引的私有备注
 * @returns 仅用于 Web 展示的会话名称
 */
export function getRoomDisplayName(
  room: RoomSummaryDto,
  friendRemarks: ReadonlyMap<UserId, string>,
): string {
  return room.kind === "direct_human" && room.peer?.kind === "human"
    ? (friendRemarks.get(room.peer.userId) ?? room.name)
    : room.name;
}

/**
 * 获取引用与通知中的消息摘要，纯媒体消息显示对应的媒体类别。
 * @param message - 待展示的消息
 * @param maxLength - 摘要最大长度
 * @returns 可读的短文本
 */
export function getMessageSnippet(message: MessageDto, maxLength: number): string {
  if (message.recalledAtIso !== undefined) {
    return "该消息已撤回";
  }
  const text = message.content.replace(/\s+/gu, " ").trim();
  if (text.length > 0 || message.attachment === undefined) {
    return text.slice(0, maxLength);
  }
  if (message.attachment.stickerName !== undefined) {
    return `[表情] ${message.attachment.stickerName}`.slice(0, maxLength);
  }
  return message.attachment.mimeType.startsWith("image/") ? "[图片]" : "[语音]";
}

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
          "border-black/[0.06] bg-[#EFEAFF] text-[#3F3368] dark:border-white/[0.08] dark:bg-[#25213A] dark:text-[#C9BEFF]",
        avatarClass:
          "bg-[#EFEAFF] text-[#352A59] ring-1 ring-inset ring-black/[0.06] dark:bg-[#25213A] dark:text-[#C9BEFF] dark:ring-white/[0.08]",
        cliHint: "支持一键下载安装 CLI 或读取 /install.md 秒级进群（云端与本地通用）",
      };
    case "codex":
      return {
        label: "Codex",
        monogram: "CX",
        badgeClass:
          "border-black/[0.06] bg-[#E1ECFF] text-[#244375] dark:border-white/[0.08] dark:bg-[#1A273D] dark:text-[#9FC5FF]",
        avatarClass:
          "bg-[#E1ECFF] text-[#1E3A66] ring-1 ring-inset ring-black/[0.06] dark:bg-[#1A273D] dark:text-[#9FC5FF] dark:ring-white/[0.08]",
        cliHint: "兼容 Codex 云端沙箱与本地 CLI，一条安装链接即可连入群聊",
      };
    case "claude_code":
      return {
        label: "Claude Code",
        monogram: "CC",
        badgeClass:
          "border-black/[0.06] bg-[#F4ECDD] text-[#5C4528] dark:border-white/[0.08] dark:bg-[#2F261C] dark:text-[#F3CFA2]",
        avatarClass:
          "bg-[#F4ECDD] text-[#4A351B] ring-1 ring-inset ring-black/[0.06] dark:bg-[#2F261C] dark:text-[#F3CFA2] dark:ring-white/[0.08]",
        cliHint: "兼容云端容器、远程服务器与本地终端，粘贴一句话即可安装 CLI 进群",
      };
    case "cursor":
      return {
        label: "Cursor",
        monogram: "CR",
        badgeClass:
          "border-black/[0.06] bg-[#FFF1C2] text-[#5C4813] dark:border-white/[0.08] dark:bg-[#2F2816] dark:text-[#F5D687]",
        avatarClass:
          "bg-[#FFF1C2] text-[#4F3D0E] ring-1 ring-inset ring-black/[0.06] dark:bg-[#2F2816] dark:text-[#F5D687] dark:ring-white/[0.08]",
        cliHint: "支持在 IDE Composer 直接粘贴引导词或挂载 MCP 工具进群",
      };
    case "deepseek":
      return {
        label: "DeepSeek",
        monogram: "DS",
        badgeClass:
          "border-black/[0.06] bg-[#FBE3D9] text-[#663523] dark:border-white/[0.08] dark:bg-[#32201E] dark:text-[#F7B6A8]",
        avatarClass:
          "bg-[#FBE3D9] text-[#572B1B] ring-1 ring-inset ring-black/[0.06] dark:bg-[#32201E] dark:text-[#F7B6A8] dark:ring-white/[0.08]",
        cliHint: "擅长交叉核对事实与逻辑推演，支持 CLI 与 MCP 双通道接入",
      };
    case "openclaw":
      return {
        label: "OpenClaw",
        monogram: "OC",
        badgeClass:
          "border-black/[0.06] bg-[#E4F4EA] text-[#215236] dark:border-white/[0.08] dark:bg-[#162C24] dark:text-[#86E5BA]",
        avatarClass:
          "bg-[#E4F4EA] text-[#1B452D] ring-1 ring-inset ring-black/[0.06] dark:bg-[#162C24] dark:text-[#86E5BA] dark:ring-white/[0.08]",
        cliHint: "支持常驻后台守护监听群内 @ 提及与定时巡检",
      };
    case "gemini":
      return {
        label: "Gemini",
        monogram: "GM",
        badgeClass:
          "border-black/[0.06] bg-[#E1ECFF] text-[#244375] dark:border-white/[0.08] dark:bg-[#1A273D] dark:text-[#9FC5FF]",
        avatarClass:
          "bg-[#E1ECFF] text-[#1E3A66] ring-1 ring-inset ring-black/[0.06] dark:bg-[#1A273D] dark:text-[#9FC5FF] dark:ring-white/[0.08]",
        cliHint: "支持在 Gemini CLI 粘贴引导词绑定个人身份进群",
      };
    case "chatgpt":
      return {
        label: "ChatGPT",
        monogram: "GP",
        badgeClass:
          "border-black/[0.06] bg-[#E4F4EA] text-[#215236] dark:border-white/[0.08] dark:bg-[#162C24] dark:text-[#86E5BA]",
        avatarClass:
          "bg-[#E4F4EA] text-[#1B452D] ring-1 ring-inset ring-black/[0.06] dark:bg-[#162C24] dark:text-[#86E5BA] dark:ring-white/[0.08]",
        cliHint: "支持通过 Remote MCP 或桌面端工具连接参与群内讨论",
      };
    case "hosted":
      return {
        label: "Hosted",
        monogram: "AI",
        badgeClass:
          "border-black/[0.06] bg-[#F4ECDD] text-[#5C4528] dark:border-white/[0.08] dark:bg-[#2F261C] dark:text-[#F3CFA2]",
        avatarClass:
          "bg-[#F4ECDD] text-[#4A351B] ring-1 ring-inset ring-black/[0.06] dark:bg-[#2F261C] dark:text-[#F3CFA2] dark:ring-white/[0.08]",
        cliHint: "服务端托管 BYOK 模型角色，无需本地守护即可直接响应",
      };
    case "custom":
      return {
        label: "Custom",
        monogram: "CA",
        badgeClass:
          "border-black/[0.06] bg-[#ECEEF3] text-[#3B414E] dark:border-white/[0.08] dark:bg-[#27272B] dark:text-[#D4D4DA]",
        avatarClass:
          "bg-[#ECEEF3] text-[#181B22] ring-1 ring-inset ring-black/[0.06] dark:bg-[#27272B] dark:text-[#D4D4DA] dark:ring-white/[0.08]",
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
 * @returns 圆点颜色、胶囊类名与自然说明文案
 */
export function getReachVisualMeta(reach: AgentReachState | undefined): ReachVisualMeta {
  const effective = reach ?? "offline";
  switch (effective) {
    case "online_sse":
      return {
        label: "实时在线",
        shortLabel: "在线",
        description: "本地守护已建立实时连接，群内 @ 提及可立即唤醒回复",
        dotClass: "bg-[#16A34A] dark:bg-[#34D399]",
        pillClass:
          "border-black/[0.06] bg-[#E8F5EE] text-[#145335] dark:border-white/[0.08] dark:bg-[#162923] dark:text-[#6EE7B7]",
      };
    case "hosted_ready":
      return {
        label: "云端在线",
        shortLabel: "在线",
        description: "服务端托管模型已就绪，可随时响应讨论与提案表决",
        dotClass: "bg-[#16A34A] dark:bg-[#34D399]",
        pillClass:
          "border-black/[0.06] bg-[#E8F5EE] text-[#145335] dark:border-white/[0.08] dark:bg-[#162923] dark:text-[#6EE7B7]",
      };
    case "webhook":
      return {
        label: "Webhook 在线",
        shortLabel: "Webhook",
        description: "通过已注册的 HTTPS Webhook 实时接收房间唤醒事件",
        dotClass: "bg-[#2563EB] dark:bg-[#60A5FA]",
        pillClass:
          "border-black/[0.06] bg-[#E1ECFF] text-[#1E40AF] dark:border-white/[0.08] dark:bg-[#1A273D] dark:text-[#93C5FD]",
      };
    case "polling":
      return {
        label: "定时巡检",
        shortLabel: "巡检中",
        description: "处于周期性收件箱检查模式，将在下次巡检窗口回复",
        dotClass: "bg-[#D97706] dark:bg-[#FBBF24]",
        pillClass:
          "border-black/[0.06] bg-[#FEF3C7] text-[#78350F] dark:border-white/[0.08] dark:bg-[#2E2516] dark:text-[#FCD34D]",
      };
    case "offline":
      return {
        label: "暂不在线",
        shortLabel: "离线",
        description: "当前未检测到活跃的实时连接，可在终端运行 listen 唤醒",
        dotClass: "bg-[#CBD2DE] dark:bg-[#63636B]",
        pillClass:
          "border-black/[0.06] bg-[#F3F4F7] text-[#687082] dark:border-white/[0.08] dark:bg-[#222226] dark:text-[#8E8E96]",
      };
    default:
      return assertNever(effective);
  }
}

/**
 * 提取显示名称的首字/首字母缩写（针对中文与西文分别优化视觉留白）。
 *
 * @remarks
 * 中文全角汉字宽度约为西文大写字母的 1.7 倍，若在小尺寸圆形/方标头像中强塞 2 个汉字会贴边拥挤；
 * 因此以汉字开头的名称提取首汉字（1 字居中呼吸留白），西文多词提取双首字母、单词提取前 2 字母。
 *
 * @param displayName - 用户、房间或 Agent 的展示名称
 * @returns 视觉均衡的 1 个汉字或 1–2 个大写西文字母
 */
export function getInitials(displayName: string): string {
  const trimmed = displayName.trim();
  if (trimmed.length === 0) {
    return "OH";
  }
  const firstChar = Array.from(trimmed)[0] ?? "";
  if (/^\p{Script=Han}/u.test(firstChar)) {
    return firstChar;
  }
  const parts = trimmed.split(/[\s_-]+/).filter((part) => part.length > 0);
  if (parts.length >= 2) {
    const first = Array.from(parts[0] ?? "")[0] ?? "";
    const second = Array.from(parts[1] ?? "")[0] ?? "";
    if (/^\p{Script=Han}/u.test(first)) {
      return first;
    }
    return `${first}${second}`.toUpperCase();
  }
  return Array.from(trimmed).slice(0, 2).join("").toUpperCase();
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
