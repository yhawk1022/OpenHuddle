/**
 * @module core-governance/secret-redact
 * @description 零 I/O 确定性敏感凭据擦除工具（ADR-0010 §3.3）。
 *
 * 关键不变量：
 * Agent 上报的实时进度摘要、核验批注、变更路径与仓外溯源回执在落库与 SSE 广播前必须经过本模块净化，
 * 确保明文 Token、API Key、私钥块与带凭据的 URL 绝不进入持久化存储或跨端事件流。
 */
import type { WorkSliceProvenance } from "@openhuddle/protocol";

const SECRET_REPLACEMENTS: ReadonlyArray<readonly [RegExp, string]> = [
  [
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    "[REDACTED_PRIVATE_KEY]",
  ],
  [/\boh_agt_[A-Za-z0-9_-]{8,}\b/g, "oh_agt_[REDACTED]"],
  [/\boh_ses_[A-Za-z0-9_-]{8,}\b/g, "oh_ses_[REDACTED]"],
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{12,}\b/g, "sk-[REDACTED]"],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}\b/g, "gh_[REDACTED]"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "github_pat_[REDACTED]"],
  [/\bAIza[0-9A-Za-z_-]{20,}\b/g, "AIza[REDACTED]"],
  [/\bxox[baprs]-[0-9A-Za-z-]{12,}\b/g, "xox-[REDACTED]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "AKIA[REDACTED]"],
  [/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, "$1[REDACTED]"],
  [/(https?:\/\/[^/\s:@]+:)[^/\s@]+(@)/gi, "$1[REDACTED]$2"],
];

/**
 * 擦除任意工单文本中的敏感凭据与密钥片段。
 */
export function scrubWorkText(input: string): string {
  let out = input;
  for (const [pattern, replacement] of SECRET_REPLACEMENTS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/**
 * 净化分片上报的仓外溯源回执字段。
 */
export function scrubWorkProvenance(
  provenance: Readonly<WorkSliceProvenance>,
): WorkSliceProvenance {
  return {
    agentEnvironment: scrubWorkText(provenance.agentEnvironment),
    leaseRole: provenance.leaseRole,
    sessionJsonlPath: scrubWorkText(provenance.sessionJsonlPath),
    rollingMemoryPath: scrubWorkText(provenance.rollingMemoryPath),
    ...(provenance.workingDirectory
      ? { workingDirectory: scrubWorkText(provenance.workingDirectory) }
      : {}),
    gitNotesAttached: provenance.gitNotesAttached,
  };
}
