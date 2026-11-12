/**
 * @module protocol/ids
 * @description OpenHuddle 全域实体名义品牌类型（Branded IDs）与强校验 Schema。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 无内部依赖：位于依赖拓扑最底层，供 Server、Web、CLI、MCP 与纯函数治理核统一引用。
 * 2. 编译期防混传：通过 Branded Types 让 `UserId`、`AgentId`、`RoomId`、`ProposalId` 在静态类型层面互不兼容，彻底消灭裸 `string` 参数错位 Bug。
 * 3. 序号单调正整数约束：`MessageSeq` 固定为 `>= 1` 的正整数（`0` 仅通过 `ReadCursorSeq` 表示尚未读取任何消息的初始游标）。
 */
import { z } from "zod";

/**
 * 为基础原始类型附加编译期只读品牌标记，构造名义类型（Nominal Type）。
 */
export type Brand<TValue, TBrand extends string> = TValue & {
  readonly __brand: TBrand;
};

/** 人类主人唯一标识（示例：`usr_01jk9x...`） */
export type UserId = Brand<string, "UserId">;

/** 个人智能体或托管模型唯一标识（示例：`agt_01jk9x...`） */
export type AgentId = Brand<string, "AgentId">;

/** 群聊房间唯一标识（示例：`rom_01jk9x...`） */
export type RoomId = Brand<string, "RoomId">;

/** 结构化提案卡片唯一标识（示例：`prp_01jk9x...`） */
export type ProposalId = Brand<string, "ProposalId">;

/** 一次性短配对码（示例：`HUDDLE-8K3P-92M`） */
export type PairingCode = Brand<string, "PairingCode">;

/** 客户端消息发送幂等去重键 */
export type OperationKey = Brand<string, "OperationKey">;

/** 房间内严格连续递增的消息序号（1..N） */
export type MessageSeq = Brand<number, "MessageSeq">;

/** 已读游标序号（0 表示尚未读取过任何消息，1..N 对应已读到的最大 MessageSeq） */
export type ReadCursorSeq = Brand<number, "ReadCursorSeq">;

/**
 * 校验并品牌化 `UserId` 的 Zod Schema。
 */
export const UserIdSchema = z
  .string()
  .trim()
  .min(3)
  .max(64)
  .transform((val): UserId => val as UserId);

/**
 * 校验并品牌化 `AgentId` 的 Zod Schema。
 */
export const AgentIdSchema = z
  .string()
  .trim()
  .min(3)
  .max(64)
  .transform((val): AgentId => val as AgentId);

/**
 * 校验并品牌化 `RoomId` 的 Zod Schema。
 */
export const RoomIdSchema = z
  .string()
  .trim()
  .min(3)
  .max(64)
  .transform((val): RoomId => val as RoomId);

/**
 * 校验并品牌化 `ProposalId` 的 Zod Schema。
 */
export const ProposalIdSchema = z
  .string()
  .trim()
  .min(3)
  .max(64)
  .transform((val): ProposalId => val as ProposalId);

/**
 * 校验并规范化（自动转大写）一次性配对码的 Zod Schema。
 */
export const PairingCodeSchema = z
  .string()
  .trim()
  .min(6)
  .max(32)
  .regex(/^[A-Za-z0-9-]+$/, "Pairing code may only contain alphanumeric characters and hyphens")
  .transform((val): PairingCode => val.toUpperCase() as PairingCode);

/**
 * 校验客户端幂等键 `opKey` 的 Zod Schema。
 */
export const OperationKeySchema = z
  .string()
  .trim()
  .min(4)
  .max(128)
  .transform((val): OperationKey => val as OperationKey);

/**
 * 校验正整数消息序号 `MessageSeq`（`>= 1`）的 Zod Schema。
 */
export const MessageSeqSchema = z
  .number()
  .int()
  .min(1)
  .transform((val): MessageSeq => val as MessageSeq);

/**
 * 校验非负整数已读游标 `ReadCursorSeq`（`>= 0`）的 Zod Schema。
 */
export const ReadCursorSeqSchema = z
  .number()
  .int()
  .min(0)
  .transform((val): ReadCursorSeq => val as ReadCursorSeq);

/**
 * 将可信内部正整数转换为 `MessageSeq` 品牌类型。
 *
 * @param seq - 大于等于 1 的消息序号整数
 * @returns 品牌化后的 `MessageSeq`
 * @throws {RangeError} 当 `seq < 1` 或非安全整数时抛出
 */
export function asMessageSeq(seq: number): MessageSeq {
  if (!Number.isSafeInteger(seq) || seq < 1) {
    throw new RangeError(`MessageSeq must be a positive integer >= 1, received: ${seq}`);
  }
  return seq as MessageSeq;
}

/**
 * 将可信内部非负整数转换为 `ReadCursorSeq` 品牌类型。
 *
 * @param seq - 大于等于 0 的游标整数
 * @returns 品牌化后的 `ReadCursorSeq`
 * @throws {RangeError} 当 `seq < 0` 或非安全整数时抛出
 */
export function asReadCursorSeq(seq: number): ReadCursorSeq {
  if (!Number.isSafeInteger(seq) || seq < 0) {
    throw new RangeError(`ReadCursorSeq must be a non-negative integer >= 0, received: ${seq}`);
  }
  return seq as ReadCursorSeq;
}
