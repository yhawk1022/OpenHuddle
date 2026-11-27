/**
 * @module web/features/auth-pairing/connect-instructions
 * @description 将用户选择的回复方式编译成各环境的接入指令。执行端的选择不改变 Agent 身份或平台。
 */
import type {
  AgentId,
  AgentPlatform,
  OwnedAgentSummaryDto,
  SupportedLocale,
} from "@openhuddle/protocol";
import { getOnboardingTranslator } from "./i18n/index.js";

/** 接入端支持无头唤醒的内置 CLI，由 Agent 所在设备实际检查可用性。 */
export const CONNECT_RUNNER_PRESETS = [
  "antigravity",
  "claude_code",
  "codex",
  "deepseek",
  "gemini",
] as const;

/** 身份绑定完成后，由会话按需读写，或使用选定的 CLI 自动回复。 */
export type AgentReplyMode = "on_demand" | (typeof CONNECT_RUNNER_PRESETS)[number];

/** 有内置唤醒执行器的平台保留自动回复默认值，其他平台默认由当前会话收发。 */
export function defaultAgentReplyMode(platform: AgentPlatform): AgentReplyMode {
  return CONNECT_RUNNER_PRESETS.find((preset) => preset === platform) ?? "on_demand";
}

export function isLoopbackOrigin(origin: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(origin);
}

/**
 * 确定所有接入方式使用的签发端。反代后回环地址不可达时，连接链接也要改用页面公网源。
 * @param issuedUrl - 服务端签发的链接，授权位于 URL 片段
 * @param browserOrigin - Web 客户端当前源
 * @returns 有效的链接、安装器源和回环判断
 */
export function resolveAgentConnectEndpoint(
  issuedUrl: string,
  browserOrigin: string,
): { readonly connectUrl: string; readonly serverUrl: string; readonly isLoopback: boolean } {
  const issued = new URL(issuedUrl);
  const isProxied =
    /^https?:\/\//i.test(browserOrigin) &&
    !isLoopbackOrigin(browserOrigin) &&
    isLoopbackOrigin(issued.origin);
  const serverUrl = isProxied ? browserOrigin : issued.origin;
  const connectUrl = `${serverUrl}${issued.pathname}${issued.search}${issued.hash}`;
  return { connectUrl, serverUrl, isLoopback: isLoopbackOrigin(serverUrl) };
}

/**
 * 从账号清单里查找与刚复制的接入指令唯一匹配的新 Agent。列表只证明身份存在，不能充当链接核销回执。
 * @param agents - 当前主人名下的 Agent
 * @param existingAgentIds - 签发请求时已经存在的身份
 * @param copiedIdentity - 复制时固定的名字与宿主平台
 * @returns 唯一匹配的账号身份，没有唯一匹配时返回空值
 */
export function findNewAgentMatchingInstructions(
  agents: ReadonlyArray<OwnedAgentSummaryDto>,
  existingAgentIds: ReadonlySet<AgentId>,
  copiedIdentity: { readonly name: string; readonly platform: AgentPlatform },
): OwnedAgentSummaryDto | null {
  const matching = agents.filter(
    (agent) =>
      !existingAgentIds.has(agent.id) &&
      agent.displayName === copiedIdentity.name &&
      agent.platform === copiedIdentity.platform,
  );
  return matching.length === 1 ? (matching[0] ?? null) : null;
}

function quotePosix(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function quotePowerShell(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * 生成接入指令和单独选择的安装步骤。会话提示词只使用宿主已有且获准的能力。
 * @param input - 已签发链接、Agent 身份、回复方式和可选群聊名称
 * @returns 现有 CLI 命令、HTTP 兑换请求、会话提示词及手动安装步骤
 */
export function buildAgentConnectInstructions(input: {
  readonly connectUrl: string;
  readonly serverUrl: string;
  readonly name: string;
  readonly platform: AgentPlatform;
  readonly replyMode: AgentReplyMode;
  readonly runnerLabel: string | undefined;
  readonly roomName?: string | undefined;
  readonly isLoopback: boolean;
  readonly locale?: SupportedLocale | undefined;
}): {
  readonly posix: string;
  readonly powerShell: string;
  readonly http: string;
  readonly prompt: string;
  readonly installers: ReadonlyArray<{
    readonly id: "posix" | "powershell";
    readonly title: string;
    readonly download: string;
    readonly connect: string;
  }>;
} {
  const {
    connectUrl,
    serverUrl,
    name,
    platform,
    replyMode,
    runnerLabel,
    roomName,
    isLoopback,
    locale,
  } = input;
  const { t } = getOnboardingTranslator(locale);
  const onDemand = replyMode === "on_demand";
  const cliMode = onDemand ? "--no-listen" : `--agent ${replyMode}`;
  const installPowerShellMode = onDemand ? "-NoListen" : `-Agent ${replyMode}`;
  const proxyBypass = isLoopback ? "--noproxy localhost,127.0.0.1 " : "";
  const posixArgs = `connect ${quotePosix(connectUrl)} --name ${quotePosix(name)} --platform ${platform} ${cliMode}`;
  const posix = `openhuddle ${posixArgs}`;
  const powerShell = `openhuddle connect ${quotePowerShell(connectUrl)} --name ${quotePowerShell(name)} --platform ${platform} ${cliMode}`;
  const scope =
    roomName !== undefined ? t("connect.scope.withRoom", { roomName }) : t("connect.scope.noRoom");
  const intent = onDemand
    ? t("connect.intent.onDemand")
    : t("connect.intent.autoReply", {
        runner: runnerLabel ?? replyMode,
        name,
      });
  const httpBody = JSON.stringify({
    connectionToken: new URL(connectUrl).hash.slice(1),
    name,
    platform,
  });
  const http = [
    `POST ${serverUrl}/api/v1/agent-connections/redeem`,
    "Content-Type: application/json",
    "",
    httpBody,
  ].join("\n");
  const usingCli = [
    t("connect.cli.heading"),
    `macOS / Linux\n${posix}`,
    `Windows PowerShell\n${powerShell}`,
    t("connect.cli.sandboxNote"),
    ...(onDemand ? [] : [t("connect.cli.noListenFallback")]),
  ].join("\n\n");
  const usingHttp = [
    t("connect.http.heading"),
    http,
    t("connect.http.instructions", {
      meUrl: `${serverUrl}/api/v1/me`,
      mcpUrl: `${serverUrl}/api/v1/mcp`,
      inboxPath: "/api/v1/inbox",
      messagesPath: "/api/v1/rooms/{roomId}/messages",
    }),
  ].join("\n\n");
  const verification = onDemand
    ? t("connect.verify.onDemand")
    : t("connect.verify.autoReply", {
        readyMarker: "Realtime listener connected.",
      });
  const multimodalUsage = t("connect.multimodal.usage", {
    cliGet: "openhuddle attachment <seq> --room <roomId>",
    mcpGet: "openhuddle_get_attachment",
    httpGet: "GET /api/v1/rooms/{roomId}/messages/{seq}/attachment",
    cliReply: 'openhuddle reply "..." --image <path>',
    mcpSend: "openhuddle_send_message",
  });

  return {
    posix,
    powerShell,
    http,
    installers: [
      {
        id: "posix",
        title: "macOS / Linux",
        download: `openhuddle_installer="$(mktemp)" && curl -fsSL ${proxyBypass}${quotePosix(`${serverUrl}/install.sh`)} -o "$openhuddle_installer" && printf '%s\\n' "$openhuddle_installer"`,
        connect: `sh "$openhuddle_installer" ${posixArgs}`,
      },
      {
        id: "powershell",
        title: "Windows PowerShell",
        download: `$OpenHuddleInstaller = Join-Path ([System.IO.Path]::GetTempPath()) ('openhuddle-' + [guid]::NewGuid().ToString() + '.ps1')\nInvoke-WebRequest -Uri ${quotePowerShell(`${serverUrl}/install.ps1`)} -OutFile $OpenHuddleInstaller -ErrorAction Stop\n$OpenHuddleInstaller`,
        connect: `& $OpenHuddleInstaller -ConnectUrl ${quotePowerShell(connectUrl)} -Name ${quotePowerShell(name)} -Platform ${platform} -Server ${quotePowerShell(serverUrl)} ${installPowerShellMode}`,
      },
    ],
    prompt: [
      t("connect.prompt.intro", { scope, intent }),
      t("connect.prompt.routeChoice"),
      ...(onDemand ? [usingHttp, usingCli] : [usingCli, usingHttp]),
      multimodalUsage,
      t("connect.prompt.noPathFallback"),
      verification,
      t("connect.prompt.trustBoundary", {
        ownerCommandCheck: 'author.trustLevel === "owner_command"',
      }),
    ].join("\n\n"),
  };
}

/**
 * 提供两种 MCP 配置模板。stdio 宿主直接启动进程，必须填写实际绝对路径和本次接入凭据。
 * @param serverUrl - 已验证的接入服务地址
 * @param locale - 可选显式语种（缺省取当前生效语种）
 * @returns 远程 MCP 与本地 stdio 的配置模板
 */
export function buildAgentMcpConfigs(
  serverUrl: string,
  locale?: SupportedLocale,
): {
  readonly remote: string;
  readonly stdio: string;
} {
  const { t } = getOnboardingTranslator(locale);
  const stateDir = t("connect.mcp.stateDirPlaceholder");
  return {
    remote: JSON.stringify(
      {
        mcpServers: {
          openhuddle: {
            url: `${serverUrl}/api/v1/mcp`,
            headers: { Authorization: `Bearer ${t("connect.mcp.tokenPlaceholder")}` },
          },
        },
      },
      null,
      2,
    ),
    stdio: JSON.stringify(
      {
        mcpServers: {
          openhuddle: {
            command: t("connect.mcp.nodePathPlaceholder"),
            args: [
              t("connect.mcp.cliEntryPlaceholder"),
              "mcp",
              "--server",
              serverUrl,
              "--token-file",
              t("connect.mcp.tokenFilePlaceholder"),
            ],
            env: { OPENHUDDLE_HOME: stateDir },
          },
        },
      },
      null,
      2,
    ),
  };
}
