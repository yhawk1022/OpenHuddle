/**
 * @module server/modules/ai-moderator/service
 * @description 主持人提案提炼引擎（支持 OpenAI 兼容 BYOK 模型接口与无外部密钥确定性离线聚合双路径）。
 *
 * 关键不变量：
 * 1. 强契约校验：远程模型输出与本地确定性聚合均须通过 `ProposalDraftSchema.parse` 校验后方可入库。
 * 2. 密钥隔离与 SSRF 防护：服务端配置的 `AI_API_KEY` 仅允许发往服务端配置的 `AI_BASE_URL`；调用者自定义 `baseUrl` 时必须自带 BYOK `apiKey`，且严禁指向回环、链路本地云元数据（`169.254.0.0/16`）或内网私网地址。
 * 3. 离线兜底：未配置外部密钥、上游超时或输出不合契约时，自动降级为按发言者聚类的确定性草案生成。
 */
import net from "node:net";
import {
  type ProposalDraft,
  ProposalDraftSchema,
  type ProposalOption,
  type SynthesizeProposalBody,
} from "@openhuddle/protocol";
import type { Logger } from "pino";
import { z } from "zod";
import type { ServerEnv } from "../../infra/env.js";
import type { HydratedRawMessageRecord } from "../messages/messages.repo.js";

const OpenAiChatCompletionResponseSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string().nullable().optional(),
        }),
      }),
    )
    .min(1),
});

/**
 * 构造 `AiModeratorService` 所需的依赖。
 */
export interface AiModeratorServiceDeps {
  readonly env: ServerEnv;
  readonly logger: Logger;
}

/**
 * 执行一次讨论提炼所需的上下文入参。
 */
export interface SynthesizeProposalInput {
  readonly roomName: string;
  readonly roomTopic: string;
  readonly messages: readonly HydratedRawMessageRecord[];
  readonly request: SynthesizeProposalBody;
}

function truncateClean(text: string, maxLen: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLen) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(1, maxLen - 1)).trim()}…`;
}

function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

function isPrivateOrLoopbackHost(rawHostname: string): boolean {
  const host = rawHostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    return true;
  }

  const ipVersion = net.isIP(host);
  if (ipVersion === 4) {
    const octets = host.split(".").map((part) => Number(part));
    const a = octets[0] ?? 0;
    const b = octets[1] ?? 0;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }

  if (ipVersion === 6) {
    return (
      host === "::" ||
      host === "::1" ||
      host.startsWith("fc") ||
      host.startsWith("fd") ||
      host.startsWith("fe8") ||
      host.startsWith("fe9") ||
      host.startsWith("fea") ||
      host.startsWith("feb") ||
      host.startsWith("::ffff:127.") ||
      host.startsWith("::ffff:10.") ||
      host.startsWith("::ffff:192.168.") ||
      host.startsWith("::ffff:169.254.")
    );
  }

  return false;
}

/**
 * 剥离部分 OpenAI 兼容服务商在 JSON 模式外层包裹的 Markdown 代码围栏。
 *
 * @param rawContent - 模型原始返回字符串
 * @returns 适合传入 `JSON.parse` 的净荷字符串
 */
export function stripJsonCodeFence(rawContent: string): string {
  const trimmed = rawContent.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return fenced?.[1]?.trim() ?? trimmed;
}

/**
 * 校验并决议本次提案提炼的远端推理端点与凭据；若触发密钥越界或 SSRF 风险则返回 `null`。
 *
 * @param params - 服务端默认配置与请求级 BYOK 覆盖参数
 * @returns 安全可调用的 `{ baseUrl, apiKey, model }`，不可用或不安全时返回 `null`
 */
export function resolveSafeSynthesisEndpoint(params: {
  readonly configuredBaseUrl: string;
  readonly configuredApiKey?: string | undefined;
  readonly configuredModel: string;
  readonly request: Readonly<SynthesizeProposalBody>;
}): { readonly baseUrl: string; readonly apiKey: string; readonly model: string } | null {
  const defaultBaseUrl = normalizeBaseUrl(params.configuredBaseUrl);
  const requestedBaseUrl =
    params.request.baseUrl !== undefined ? normalizeBaseUrl(params.request.baseUrl) : undefined;
  const effectiveBaseUrl = requestedBaseUrl ?? defaultBaseUrl;
  const isCustomEndpoint = requestedBaseUrl !== undefined && requestedBaseUrl !== defaultBaseUrl;

  // 安全红线 1：客户端自定义 baseUrl 时严禁附带服务端 AI_API_KEY，防止服务端密钥被诱骗外泄至第三方域名
  const apiKey = isCustomEndpoint
    ? params.request.apiKey?.trim()
    : (params.request.apiKey?.trim() ?? params.configuredApiKey?.trim());

  if (!apiKey) {
    return null;
  }

  // 安全红线 2：对调用者传入的自定义 baseUrl 强制校验 HTTPS 协议与公网宿主，阻断内网探测与云元数据 SSRF
  if (isCustomEndpoint) {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(effectiveBaseUrl);
    } catch {
      return null;
    }
    if (
      parsedUrl.protocol !== "https:" ||
      parsedUrl.username.length > 0 ||
      parsedUrl.password.length > 0 ||
      isPrivateOrLoopbackHost(parsedUrl.hostname)
    ) {
      return null;
    }
  }

  return {
    baseUrl: effectiveBaseUrl,
    apiKey,
    model: params.request.model ?? params.configuredModel,
  };
}

/**
 * 在无外部 LLM API Key 时，按参与者聚类最近讨论观点并构造 100% 符合 `ProposalDraftSchema` 的确定性提案草案。
 *
 * @param input - 房间标题、主题与最近有效消息列表
 * @returns 校验通过的 `ProposalDraft`
 */
export function buildDeterministicProposalDraft(
  input: Readonly<{
    roomName: string;
    roomTopic: string;
    messages: readonly HydratedRawMessageRecord[];
  }>,
): ProposalDraft {
  const activeMessages = input.messages.filter(
    (msg) => msg.recalledAt === null && msg.type === "text" && msg.content.trim().length > 0,
  );

  const speakerBuckets = new Map<
    string,
    {
      readonly displayName: string;
      readonly kind: "human" | "agent";
      readonly points: string[];
    }
  >();

  for (const msg of activeMessages) {
    const speakerKey =
      msg.rawAuthor.kind === "human"
        ? `human:${msg.rawAuthor.userId ?? msg.rawAuthor.displayName}`
        : `agent:${msg.rawAuthor.agentId ?? msg.rawAuthor.displayName}`;

    let bucket = speakerBuckets.get(speakerKey);
    if (!bucket) {
      bucket = {
        displayName: msg.rawAuthor.displayName,
        kind: msg.rawAuthor.kind,
        points: [],
      };
      speakerBuckets.set(speakerKey, bucket);
    }
    bucket.points.push(truncateClean(msg.content, 240));
  }

  const groups = Array.from(speakerBuckets.values());
  const options: ProposalOption[] = [];

  for (let i = 0; i < Math.min(groups.length, 5); i++) {
    const group = groups[i];
    if (!group) {
      continue;
    }
    const latestPoint = group.points[group.points.length - 1] ?? "Adopt proposed approach.";
    const optionKey = `option-${i + 1}`;
    options.push({
      optionKey,
      label: truncateClean(`${group.displayName}'s Proposal`, 110),
      summary: truncateClean(latestPoint, 950),
      pros: [
        truncateClean(
          `Incorporates ${group.points.length} contribution(s) from ${group.displayName} (${group.kind}).`,
          280,
        ),
      ],
      cons: ["Requires alignment across remaining participants before execution."],
      risks: ["Scope assumptions should be verified by the human room owner."],
    });
  }

  if (options.length === 0) {
    options.push(
      {
        optionKey: "option-1",
        label: "Proceed with Baseline Execution Plan",
        summary:
          input.roomTopic.trim().length >= 2
            ? truncateClean(input.roomTopic, 950)
            : `Execute primary objective for ${input.roomName}.`,
        pros: ["Clear scope and immediate forward momentum."],
        cons: ["Fewer alternative viewpoints recorded in chat prior to synthesis."],
        risks: ["Edge cases may require follow-up iteration."],
      },
      {
        optionKey: "option-2",
        label: "Request Additional Agent Cross-Checks",
        summary: "Gather one additional round of structured agent feedback before final sign-off.",
        pros: ["Surfaces hidden technical risks early."],
        cons: ["Adds one extra huddle turn before implementation."],
        risks: ["May delay time-sensitive decisions if unconstrained."],
      },
    );
  } else if (options.length === 1) {
    options.push({
      optionKey: "option-2",
      label: "Conservative Phased Rollout",
      summary: "Stage changes incrementally behind human verification checkpoints.",
      pros: ["Minimizes blast radius and preserves easy rollback."],
      cons: ["Slightly slower delivery compared to immediate full rollout."],
      risks: ["Requires maintaining temporary compatibility boundaries."],
    });
  }

  const baseTitle =
    input.roomTopic.trim().length >= 2
      ? `Decision Card: ${input.roomTopic.trim()}`
      : `Decision Card: ${input.roomName.trim()}`;

  const speakerNames = groups.map((g) => g.displayName).join(", ");
  const contextSummary =
    activeMessages.length > 0
      ? truncateClean(
          `Synthesized from ${activeMessages.length} recent huddle message(s) across ${groups.length} participant(s) (${speakerNames}).`,
          1_950,
        )
      : truncateClean(
          `Initial structured decision card prepared for huddle room "${input.roomName}".`,
          1_950,
        );

  const firstOption = options[0];

  return ProposalDraftSchema.parse({
    title: truncateClean(baseTitle, 150),
    contextSummary,
    ...(firstOption !== undefined ? { recommendedOptionKey: firstOption.optionKey } : {}),
    options,
  });
}

/**
 * AI 主持人结构化提案提炼服务。
 */
export class AiModeratorService {
  private readonly env: ServerEnv;
  private readonly logger: Logger;

  /**
   * @param deps - 环境配置与结构化日志器
   */
  public constructor(deps: Readonly<AiModeratorServiceDeps>) {
    this.env = deps.env;
    this.logger = deps.logger.child({ component: "ai-moderator" });
  }

  /**
   * 从房间最近消息提炼结构化提案卡片草稿（配置了 API Key 时调用兼容 OpenAI 的模型，否则回退确定性聚合）。
   *
   * @param input - 房间信息、最近消息窗口与可选 BYOK 模型覆盖参数
   * @returns 严格通过 `ProposalDraftSchema` 校验的提案草稿
   */
  public async synthesizeProposalDraft(
    input: Readonly<SynthesizeProposalInput>,
  ): Promise<ProposalDraft> {
    const endpoint = resolveSafeSynthesisEndpoint({
      configuredBaseUrl: this.env.AI_BASE_URL,
      configuredApiKey: this.env.AI_API_KEY,
      configuredModel: this.env.AI_MODEL,
      request: input.request,
    });
    if (!endpoint) {
      if (input.request.baseUrl !== undefined) {
        this.logger.warn(
          { hasCallerKey: Boolean(input.request.apiKey) },
          "Rejected unsafe or unauthenticated custom AI baseUrl; falling back to deterministic synthesis",
        );
      }
      return buildDeterministicProposalDraft({
        roomName: input.roomName,
        roomTopic: input.roomTopic,
        messages: input.messages,
      });
    }

    const { baseUrl, apiKey, model } = endpoint;

    const transcriptLines = input.messages
      .filter((m) => m.recalledAt === null)
      .map(
        (m) =>
          `[seq=${m.seq}] ${m.rawAuthor.displayName} (${m.rawAuthor.kind}): ${truncateClean(m.content, 600)}`,
      )
      .join("\n");

    const systemPrompt = [
      "You are the neutral OpenHuddle Moderator AI.",
      "Synthesize the multi-agent discussion into a strict JSON object matching this exact schema:",
      '{"title": string, "contextSummary": string, "recommendedOptionKey": string, "options": [{"optionKey": string, "label": string, "summary": string, "pros": string[], "cons": string[], "risks": string[]}]}',
      "Return ONLY raw valid JSON with 2 to 4 concrete options.",
    ].join(" ");

    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          temperature: 0.2,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: systemPrompt },
            {
              role: "user",
              content: `Room: ${input.roomName}\nTopic: ${input.roomTopic}\n\nTranscript:\n${transcriptLines || "(No messages yet)"}`,
            },
          ],
        }),
        signal: AbortSignal.timeout(25_000),
        redirect: "error",
      });

      if (!response.ok) {
        this.logger.warn(
          { status: response.status, baseUrl, model },
          "External AI provider returned non-2xx; falling back to deterministic synthesis",
        );
        return buildDeterministicProposalDraft({
          roomName: input.roomName,
          roomTopic: input.roomTopic,
          messages: input.messages,
        });
      }

      const rawBody: unknown = await response.json();
      const parsedCompletion = OpenAiChatCompletionResponseSchema.parse(rawBody);
      const rawContent = parsedCompletion.choices[0]?.message.content;
      if (!rawContent) {
        throw new Error("Empty completion content returned by provider.");
      }

      const parsedJson: unknown = JSON.parse(stripJsonCodeFence(rawContent));
      return ProposalDraftSchema.parse(parsedJson);
    } catch (err) {
      this.logger.warn(
        { err, baseUrl, model },
        "AI synthesis request or schema validation failed; falling back to deterministic synthesis",
      );
      return buildDeterministicProposalDraft({
        roomName: input.roomName,
        roomTopic: input.roomTopic,
        messages: input.messages,
      });
    }
  }
}
