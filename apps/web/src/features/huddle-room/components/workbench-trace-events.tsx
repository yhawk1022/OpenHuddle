import type { WorkTraceEntry, WorkTraceKind } from "@openhuddle/protocol";
import {
  ArrowRightLeft,
  Box,
  ChevronRight,
  CircleAlert,
  ClipboardCheck,
  FileDiff,
  ListChecks,
  MessageSquarePlus,
  ScrollText,
  Terminal,
} from "lucide-react";
import { getTraceSummary, groupWorkTrace } from "../work/work-trace-summary.js";
import { stripAgentOwnerPrefix } from "../work/work-utils.js";

const TRACE_ICONS = {
  lease: ListChecks,
  sandbox: Box,
  command: Terminal,
  output: ScrollText,
  diff: FileDiff,
  handoff: ArrowRightLeft,
  steer: MessageSquarePlus,
  review: ClipboardCheck,
  error: CircleAlert,
} satisfies Record<WorkTraceKind, typeof Terminal>;

function formatTraceClock(isoString: string): string {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return "--:--:--";
  return date.toLocaleTimeString("zh-CN", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function WorkbenchTraceEvents({
  entries,
  ownerDisplayName,
}: {
  readonly entries: readonly WorkTraceEntry[];
  readonly ownerDisplayName: string;
}) {
  return (
    <div className="oh-workbench-events">
      {groupWorkTrace(entries).map((group) => {
        const first = group[0];
        const Icon = TRACE_ICONS[first.kind];
        const actor = stripAgentOwnerPrefix(first.actorName, ownerDisplayName);
        const summary = getTraceSummary(first, group.length);
        return (
          <details key={first.id} className="oh-workbench-event" data-kind={first.kind}>
            <summary>
              <Icon aria-hidden="true" className="oh-workbench-event-icon" />
              <span className="oh-workbench-event-summary">
                {actor} · {summary}
              </span>
              <time className="oh-workbench-event-clock" dateTime={first.timestampIso}>
                {formatTraceClock(first.timestampIso)}
              </time>
              <ChevronRight aria-hidden="true" className="oh-workbench-event-chevron" />
            </summary>
            <div className="oh-workbench-event-body">
              {group.map((record) => (
                <div key={record.id}>
                  <time dateTime={record.timestampIso}>
                    {formatTraceClock(record.timestampIso)}
                  </time>
                  <p>{record.message}</p>
                  {record.detail ? <pre>{record.detail}</pre> : null}
                </div>
              ))}
            </div>
          </details>
        );
      })}
    </div>
  );
}
