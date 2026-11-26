import { type RaiseWorkAttentionBody, RaiseWorkAttentionBodySchema } from "@openhuddle/protocol";
import { scrubWorkText } from "./secret-redact.js";

const attentionSchema = RaiseWorkAttentionBodySchema.pick({ question: true, options: true });
export type AgentAttention = Omit<RaiseWorkAttentionBody, "leaseVersion">;

export const WORK_AGENT_STOP_INSTRUCTION = [
  "Choose your own completion and stopping criteria from the assigned goal and evidence. Finish when those criteria are met. Continue or request rework only when you can name a concrete next action that makes progress.",
  "For write slices within your ownedPaths, follow repository conventions or make sensible defaults for routine project files, directories, layout, and tooling. Avoid hidden files unless requested. Briefly record key assumptions. Keep read and verify slices read-only. Output NEEDS_INPUT only for required external information, credentials, or permissions that cannot be safely defaulted, materially conflicting requirements, or irreversible destructive or out-of-scope actions.",
  'If you cannot make meaningful progress without new input, stop this slice now. Instead of a completion or verdict, end with one line: NEEDS_INPUT: {"question":"what is blocked and what decision is needed","options":["first actionable choice","second actionable choice"]}. Write the question and 2–5 choices in the owner’s language.',
].join("\n");

export interface ParsedWorkVerdict {
  readonly verdict: "passed" | "changes_requested";
  readonly summaryEndIndex: number;
}

const VERDICT_LINE_REGEX =
  /^[*_`]*VERDICT[*_`\s]*[:：][*_`\s]*(PASSED|CHANGES_REQUESTED)\s*[.。]?[*_`]*[.。]?$/i;

/**
 * 严格仅检查最后一个非空行，容忍常见 Markdown 包装并提取 `VERDICT: PASSED | CHANGES_REQUESTED`。
 */
export function parseWorkVerdict(rawOutput: string): ParsedWorkVerdict | undefined {
  const trimmedEnd = rawOutput.trimEnd();
  if (trimmedEnd.length === 0) return undefined;
  const lastNewline = trimmedEnd.lastIndexOf("\n");
  const lineStart = lastNewline === -1 ? 0 : lastNewline + 1;
  let candidate = trimmedEnd.slice(lineStart).trim();
  if (candidate.length === 0) return undefined;

  for (;;) {
    const stripped = candidate.replace(/^(?:>\s*|#{1,6}\s*|-\s*|\*\s+)/, "").trim();
    if (stripped === candidate) break;
    candidate = stripped;
  }

  const match = VERDICT_LINE_REGEX.exec(candidate);
  if (!match?.[1]) return undefined;
  return {
    verdict: match[1].toUpperCase() === "PASSED" ? "passed" : "changes_requested",
    summaryEndIndex: lineStart,
  };
}

/** A deliberate handoff from an executor to the owner, reported against the current lease. */
export class WorkAgentAttention extends Error {
  readonly attention: AgentAttention;

  constructor(value: unknown) {
    const parsed = attentionSchema.safeParse(value);
    if (!parsed.success) throw new Error("Agent 暂停回执需要一个问题和 2 至 5 个可选答案。");
    const question = scrubWorkText(parsed.data.question);
    super(question);
    this.attention = { question, options: parsed.data.options.map(scrubWorkText) };
  }
}

export function checkAgentWorkOutput(output: string): string {
  const final = output.trimEnd();
  const line = final.slice(final.lastIndexOf("\n") + 1).trim();
  if (!line.startsWith("NEEDS_INPUT:")) return output;
  let value: unknown;
  try {
    value = JSON.parse(line.slice("NEEDS_INPUT:".length));
  } catch {
    throw new Error("Agent 暂停回执的 JSON 格式无效。");
  }
  throw new WorkAgentAttention(value);
}
