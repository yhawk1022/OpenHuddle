import type { MessageDto, MessageSeq, OwnedAgentSummaryDto } from "@openhuddle/protocol";

type AgentIdentity = Pick<OwnedAgentSummaryDto, "id" | "displayName" | "slug">;

function isOwnerRequestForAgent(message: MessageDto, self: AgentIdentity): boolean {
  const agents = message.mentions.filter((mention) => mention.kind === "agent");
  return (
    message.author.kind === "human" &&
    message.author.trustLevel === "owner_command" &&
    (agents.length === 0 || agents.some((mention) => mention.agentId === self.id))
  );
}

export function isOwnerRetryRequest(message: MessageDto, self: AgentIdentity): boolean {
  if (!isOwnerRequestForAgent(message, self) || message.recalledAtIso || message.attachment)
    return false;
  let text = message.content;
  const names = [
    self.displayName,
    self.slug,
    ...message.mentions
      .filter((mention) => mention.kind === "agent" && mention.agentId === self.id)
      .map((mention) => mention.displayName),
  ];
  for (const name of names.sort((a, b) => b.length - a.length)) {
    text = text.replaceAll(`@${name}`, " ");
  }
  return /^(?:(?:请|麻烦)?(?:重试|再试试|再试|重新试|重新生成|再来)(?:一下|一次|一遍)?|(?:please\s+)?(?:retry|try again|redo)(?:\s+please)?)[!！。.]*$/iu.test(
    text.trim(),
  );
}

/** Resolve an owner retry using message identities and reply links, never an agent's prose. */
export async function resolveWakeRetrySource(
  trigger: MessageDto,
  history: readonly MessageDto[],
  self: AgentIdentity,
  loadHistory?: (seq: MessageSeq) => Promise<readonly MessageDto[]>,
): Promise<MessageDto | undefined> {
  if (!isOwnerRetryRequest(trigger, self)) return undefined;
  const bySeq = new Map<MessageSeq, MessageDto>();
  const addPage = (page: readonly MessageDto[]) => {
    for (const msg of page) {
      if (msg.roomId === trigger.roomId && msg.seq < trigger.seq) bySeq.set(msg.seq, msg);
    }
  };
  addPage(history);
  let cursor = trigger;
  let pagesLoaded = 0;
  for (;;) {
    let target: MessageDto | undefined;
    if (cursor.replyToSeq !== undefined) {
      if (cursor.replyToSeq >= cursor.seq) return undefined;
      if (!bySeq.has(cursor.replyToSeq) && loadHistory && pagesLoaded < 3) {
        pagesLoaded++;
        addPage(await loadHistory(cursor.replyToSeq));
      }
      target = bySeq.get(cursor.replyToSeq);
    } else {
      // An unthreaded retry refers to the most recent exchange with this owner.
      // An agent message can point back to a request only through its explicit reply link.
      if (cursor.author.kind !== "human") return undefined;
      for (const msg of bySeq.values()) {
        if (
          msg.seq < cursor.seq &&
          (!target || msg.seq > target.seq) &&
          (msg.author.trustLevel === "owner_command" || msg.author.agentId === self.id)
        )
          target = msg;
      }
    }
    if (!target || target.recalledAtIso) return undefined;
    if (
      target.author.kind === "agent" &&
      target.author.isYou &&
      target.author.agentId === self.id
    ) {
      cursor = target;
      continue;
    }
    if (!isOwnerRequestForAgent(target, self) || target.author.userId !== trigger.author.userId)
      return undefined;
    if (!isOwnerRetryRequest(target, self)) return target;
    cursor = target;
  }
}
