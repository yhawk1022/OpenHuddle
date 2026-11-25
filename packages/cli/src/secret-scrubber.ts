/**
 * @module cli/secret-scrubber
 * @description 本地会话事件流、滚动记忆与跨环境摘要的确定性敏感凭据脱敏器（Client-Side Secret Scrubber）。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 默认零信任落盘（ADR-0010 §3.3）：Agent 在排障过程中极易通过读取 `.env`、打印 HTTP 请求头或异常堆栈回显高敏密钥；
 *    所有落盘至 `~/.openhuddle/`、`git notes` 或上报服务端的文本必须先经过本纯函数清洗。
 * 2. 结构保真脱敏：保留变量名、协议头与令牌前缀（如 `oh_agt_[REDACTED]`、`DATABASE_URL=[REDACTED]`），便于人类排障定位问题而不泄露真实凭据。
 */

interface RedactionRule {
  readonly pattern: RegExp;
  readonly replacement: string;
}

const REDACTION_RULES: ReadonlyArray<RedactionRule> = [
  // 1. OpenHuddle 专属 Agent 令牌与一次性配对令牌
  {
    pattern: /\boh_agt_[A-Za-z0-9_-]{8,}\b/g,
    replacement: "oh_agt_[REDACTED]",
  },
  // 2. 主流模型与云厂商 API 私钥（OpenAI / Anthropic / GitHub / AWS IAM）
  {
    pattern: /\bsk-(?:proj-|ant-[A-Za-z0-9-]+-)?[A-Za-z0-9_-]{12,}\b/g,
    replacement: "sk-[REDACTED]",
  },
  {
    pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g,
    replacement: "gh_[REDACTED]",
  },
  {
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
    replacement: "AKIA[REDACTED]",
  },
  // 3. HTTP Authorization Bearer / Basic 标头
  {
    pattern: /\b(Bearer\s+)[A-Za-z0-9._~+/-]{12,}=*/gi,
    replacement: "$1[REDACTED]",
  },
  // 4. URL 内嵌账号口令（贪婪匹配至最后一个 @host，兼容含 @ 特殊字符的复杂密码）
  {
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:)([^\s/]+)(@[^@\s/]+)/gi,
    replacement: "$1[REDACTED]$3",
  },
  // 5. .env 或命令行敏感键值赋值（保留键名，掩码右侧值）
  {
    pattern:
      /\b([A-Z0-9_]*(?:PASSWORD|PASSWD|SECRET|API_KEY|ACCESS_TOKEN|AUTH_TOKEN|PRIVATE_KEY|CLIENT_SECRET)[A-Z0-9_]*\s*[:=]\s*)(['"]?)[^\s'"\r\n]+\2/gi,
    replacement: "$1[REDACTED]",
  },
];

/**
 * 清洗任意文本中的高敏令牌、API Key、连接串密码与环境变量密钥。
 *
 * @param raw - 原始待记录或待发送文本
 * @returns 脱敏后的安全文本
 */
export function scrubSensitiveText(raw: string): string {
  if (raw.length === 0) {
    return raw;
  }
  let current = raw;
  for (const rule of REDACTION_RULES) {
    current = current.replace(rule.pattern, rule.replacement);
  }
  return current;
}

/**
 * 检测给定文本中是否包含未脱敏的已知敏感凭据模式。
 *
 * @param raw - 待检测字符串
 * @returns 若命中任意敏感规则则返回 `true`
 */
export function containsSensitiveSecret(raw: string): boolean {
  return scrubSensitiveText(raw) !== raw;
}
