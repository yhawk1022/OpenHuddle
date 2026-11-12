/**
 * @module server/modules/ai-moderator/service
 * @description 主持人 AI 提案自动提炼引擎（支持 OpenAI 兼容 BYOK 模型接口与无外部密钥确定性离线聚合双模态）。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 强契约校验：无论走远程 LLM `chat/completions` 还是本地确定性观点聚合，返回结构都必须通过 `ProposalDraftSchema.parse` 严格校验后才能入库。
 * 2. 离线与本地演示 100% 可用：当未配置 `AI_API_KEY` 且请求未携带 `apiKey` 时，自动按发言主体聚类最近讨论并生成结构化对比备选方案，确保零外部依赖环境下集成测试与本地自举丝滑可用。
 */
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
    const apiKey = input.request.apiKey ?? this.env.AI_API_KEY;
    if (!apiKey) {
      return buildDeterministicProposalDraft({
        roomName: input.roomName,
        roomTopic: input.roomTopic,
        messages: input.messages,
      });
    }

    const baseUrl = (input.request.baseUrl ?? this.env.AI_BASE_URL).replace(/\/+$/, "");
    const model = input.request.model ?? this.env.AI_MODEL;

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

      const parsedJson: unknown = JSON.parse(rawContent);
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
