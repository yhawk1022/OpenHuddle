import type { SupportedLocale, WorkTraceEntry } from "@openhuddle/protocol";
import { getWorkbenchTranslator } from "../i18n/workbench.js";
import type { WorkSliceNode, WorkStage } from "./work-types.js";

type WorkTraceGroup = [WorkTraceEntry, ...WorkTraceEntry[]];

// 服务端与 CLI 守护进程回传的追踪消息协议前缀/字面量匹配表（非界面展示文案）
const TRACE_WIRE = {
  leaseClaimed: /* i18n-ignore */ "已认领分片",
  cmdVerify: /* i18n-ignore */ "执行自动化校验命令",
  cmdSetup: /* i18n-ignore */ "执行工作树初始化钩子",
  cmdLaunching: /* i18n-ignore */ "正在启动",
  sandboxQueue: /* i18n-ignore */ "互斥队列",
  reviewRepeated: /* i18n-ignore */ "复核发现交付证据重复",
  reviewFailed: /* i18n-ignore */ "复核未通过",
  reviewManualRework: /* i18n-ignore */ "人工退回修改",
  reviewPassedAwaiting: /* i18n-ignore */ "复核通过，等待人工签收",
  reviewChecksPassed: /* i18n-ignore */ "校验命令通过",
  reviewApproved: /* i18n-ignore */ "人工审核已签收通过",
  steerStopped: /* i18n-ignore */ "人工手动停止了任务执行",
  steerAnswered: /* i18n-ignore */ "已回复澄清问题",
  errorChecksFailed: /* i18n-ignore */ "校验命令未通过",
  handoffCreated: /* i18n-ignore */ "已创建任务并进入执行队列",
  handoffAwaitingAnswer: /* i18n-ignore */ "暂停等待人工确认",
  handoffSliceCompleted: /* i18n-ignore */ "已完成分片",
  handoffPatchReceived: /* i18n-ignore */ "已收到完整变更补丁，恢复独立复核。",
  handoffRequeued: /* i18n-ignore */ "已重置失败/取消状态并重新加入执行队列",
  handoffEscalated: /* i18n-ignore */ "已将任务关联同步至群聊协同",
  handoffAgentDisconnected: /* i18n-ignore */ "设备上的 Agent 进程已中断，分片重新排队。",
  liveRunningChecks: /* i18n-ignore */ "正在运行校验命令",
  livePreparingWorktree: /* i18n-ignore */ "正在准备隔离工作树",
  liveApplyingSteer: /* i18n-ignore */ "正在按补充指令增量调整…",
} as const;

const DIFF_CHANGE_WIRE_RE = /^(?:检测到工作区变更|最终变更)：(\d+) 个文件（\+(\d+) \/ -(\d+)）$/;

export function groupWorkTrace(entries: readonly WorkTraceEntry[]): WorkTraceGroup[] {
  const groups: WorkTraceGroup[] = [];
  for (const entry of entries) {
    const previous = groups.at(-1);
    const first = previous?.[0];
    if (
      previous &&
      first?.kind === "output" &&
      entry.kind === "output" &&
      first.actorName === entry.actorName &&
      first.sliceId === entry.sliceId
    ) {
      previous.push(entry);
    } else {
      groups.push([entry]);
    }
  }
  return groups;
}

export function getTraceSummary(
  entry: WorkTraceEntry,
  count: number,
  locale?: SupportedLocale,
): string {
  const { t, tp } = getWorkbenchTranslator(locale);
  const { message } = entry;
  switch (entry.kind) {
    case "output":
      // The runner can echo a prompt into both message and detail, even for a single line.
      return count > 1 ? tp("trace.outputMulti", count) : t("trace.outputSingle");
    case "lease":
      return message.startsWith(TRACE_WIRE.leaseClaimed)
        ? t("trace.lease.claimed")
        : t("trace.lease.updated");
    case "command":
      if (message.startsWith(TRACE_WIRE.cmdVerify)) return t("trace.command.verify");
      if (message.startsWith(TRACE_WIRE.cmdSetup)) return t("trace.command.setup");
      if (message.startsWith(TRACE_WIRE.cmdLaunching)) return t("trace.command.launching");
      return t("trace.command.recorded");
    case "sandbox":
      return message.includes(TRACE_WIRE.sandboxQueue)
        ? t("trace.sandbox.queued")
        : t("trace.sandbox.updated");
    case "diff": {
      const changes = DIFF_CHANGE_WIRE_RE.exec(message);
      if (
        changes &&
        changes[1] !== undefined &&
        changes[2] !== undefined &&
        changes[3] !== undefined
      ) {
        return tp("trace.diffSummary", Number(changes[1]), {
          added: changes[2],
          deleted: changes[3],
        });
      }
      return t("trace.diff.recorded");
    }
    case "review":
      if (message.startsWith(TRACE_WIRE.reviewRepeated)) return t("trace.review.repeatedEvidence");
      if (
        message.startsWith(TRACE_WIRE.reviewFailed) ||
        message.startsWith(TRACE_WIRE.reviewManualRework)
      )
        return t("trace.review.changesRequested");
      if (message.startsWith(TRACE_WIRE.reviewPassedAwaiting))
        return t("trace.review.passedAwaitingApproval");
      if (message.startsWith(TRACE_WIRE.reviewChecksPassed)) return t("trace.review.checksPassed");
      if (message === TRACE_WIRE.reviewApproved) return t("trace.review.approved");
      return t("trace.review.recorded");
    case "steer":
      if (message === TRACE_WIRE.steerStopped) return t("trace.steer.stoppedManually");
      if (message.startsWith(TRACE_WIRE.steerAnswered)) return t("trace.steer.answered");
      return t("trace.steer.received");
    case "error":
      return message.startsWith(TRACE_WIRE.errorChecksFailed)
        ? t("trace.error.checksFailed")
        : t("trace.error.generic");
    case "handoff":
      if (message.startsWith(TRACE_WIRE.handoffCreated)) return t("trace.handoff.created");
      if (message.startsWith(TRACE_WIRE.handoffAwaitingAnswer))
        return t("trace.handoff.awaitingAnswer");
      if (message.startsWith(TRACE_WIRE.handoffSliceCompleted))
        return t("trace.handoff.sliceCompleted");
      if (message === TRACE_WIRE.handoffPatchReceived) return t("trace.handoff.patchReceived");
      if (message === TRACE_WIRE.handoffRequeued) return t("trace.handoff.requeued");
      if (message === TRACE_WIRE.handoffEscalated) return t("trace.handoff.escalatedToRoom");
      if (message === TRACE_WIRE.handoffAgentDisconnected)
        return t("trace.handoff.agentDisconnected");
      return t("trace.handoff.recorded");
  }
}

export function getSliceProgressSummary(
  slice: WorkSliceNode,
  stage: WorkStage,
  locale?: SupportedLocale,
): string {
  const { t } = getWorkbenchTranslator(locale);
  const verify = slice.leaseRole === "verify";
  switch (slice.status) {
    case "waiting":
      if (stage === "awaiting_answer") return t("progress.waitingAnswer");
      if (stage === "cancelled" || stage === "blocked") return t("progress.paused");
      if (verify && stage === "working") return t("slice.waitingVerifyAfterExec");
      return verify
        ? t("slice.waitingClaimVerify", { agent: slice.worker.displayName })
        : t("slice.waitingClaimExec", { agent: slice.worker.displayName });
    case "running":
      if (slice.liveSummary.startsWith("Claimed lease and preparing workspace."))
        return t("progress.claimedPreparing");
      if (slice.liveSummary.startsWith(TRACE_WIRE.liveRunningChecks))
        return t("progress.runningChecks");
      if (slice.liveSummary.startsWith(TRACE_WIRE.livePreparingWorktree))
        return t("progress.preparingWorktree");
      if (slice.liveSummary === TRACE_WIRE.liveApplyingSteer) return t("progress.applyingSteer");
      return t("progress.working");
    case "verifying":
      return t("progress.verifying");
    case "ready":
      return verify ? t("progress.verifySubmitted") : t("progress.execSubmitted");
    case "blocked":
      if (slice.failureCode === "REPEATED_REVIEW_EVIDENCE") return t("progress.repeatedEvidence");
      return stage === "cancelled" ? t("progress.stopped") : t("progress.blocked");
  }
}
