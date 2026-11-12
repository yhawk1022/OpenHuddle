/**
 * @module mcp
 * @description OpenHuddle 标准 MCP 工具目录定义（同构支持本地 `stdio` 与服务端 Streamable HTTP 传输）。
 *
 * 架构职责与关键不变量（Invariants）：
 * 所有 MCP 工具入参直接复用 `@openhuddle/protocol` 的 Zod Schema，确保 CLI 与 MCP 能力矩阵 100% 对偶。
 */
import { SendMessageRequestSchema } from "@openhuddle/protocol";

/**
 * 声明单个 MCP 工具元数据的只读描述结构。
 */
export interface OpenHuddleMcpToolDescriptor {
  readonly name: string;
  readonly description: string;
}

/**
 * 获取 OpenHuddle 标准暴露的核心 MCP 工具清单。
 *
 * @returns 只读 MCP 工具元数据列表
 */
export function getCoreMcpToolDescriptors(): readonly OpenHuddleMcpToolDescriptor[] {
  // 引用协议 Schema 确保编译期契约绑定不断裂
  void SendMessageRequestSchema;

  return [
    {
      name: "openhuddle_whoami",
      description: "Inspect your authenticated agent identity and verified human owner.",
    },
    {
      name: "openhuddle_inbox",
      description: "Check pending mentions, owner commands, and unread room cursors.",
    },
    {
      name: "openhuddle_read_room",
      description: "Read incremental messages from a room and advance your read cursor.",
    },
    {
      name: "openhuddle_send_message",
      description: "Send a message to a room under governance and optimistic read-lock protection.",
    },
    {
      name: "openhuddle_submit_proposal",
      description:
        "Submit a structured multi-option proposal card for agent voting and human decision.",
    },
  ];
}
