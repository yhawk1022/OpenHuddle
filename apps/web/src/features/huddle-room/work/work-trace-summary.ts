import type { WorkTraceEntry } from "@openhuddle/protocol";
import type { WorkSliceNode, WorkStage } from "./work-types.js";

type WorkTraceGroup = [WorkTraceEntry, ...WorkTraceEntry[]];

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

export function getTraceSummary(entry: WorkTraceEntry, count: number): string {
  const { message } = entry;
  switch (entry.kind) {
    case "output":
      // The runner can echo a prompt into both message and detail, even for a single line.
      return count > 1 ? `收到了 ${count} 条执行输出` : "收到了执行输出";
    case "lease":
      return message.startsWith("已认领分片") ? "已领取分配的工作" : "执行分工状态已更新";
    case "command":
      if (message.startsWith("执行自动化校验命令")) return "开始运行自动化检查";
      if (message.startsWith("执行工作树初始化钩子")) return "开始初始化工作目录";
      if (message.startsWith("正在启动")) return "正在启动执行器";
      return "记录了一条执行命令";
    case "sandbox":
      return message.includes("互斥队列") ? "等待工作目录可用" : "工作环境状态已更新";
    case "diff": {
      const changes = /^(?:检测到工作区变更|最终变更)：(\d+) 个文件（\+(\d+) \/ -(\d+)）$/.exec(
        message,
      );
      return changes
        ? `变更了 ${changes[1]} 个文件，新增 ${changes[2]} 行，删除 ${changes[3]} 行`
        : "记录了文件变更";
    }
    case "review":
      if (message.startsWith("复核发现交付证据重复"))
        return "交付内容和验证结果没有变化，已暂停返工";
      if (message.startsWith("复核未通过") || message.startsWith("人工退回修改"))
        return "已退回修改";
      if (message.startsWith("复核通过，等待人工签收")) return "复核通过，等待签收";
      if (message.startsWith("校验命令通过")) return "自动化检查通过";
      if (message === "人工审核已签收通过") return message;
      return "已收到复核记录";
    case "steer":
      if (message === "人工手动停止了任务执行") return message;
      if (message.startsWith("已回复澄清问题")) return "已收到对待确认问题的答复";
      return "已收到补充说明";
    case "error":
      return message.startsWith("校验命令未通过") ? "自动化检查未通过" : "执行遇到问题";
    case "handoff":
      if (message.startsWith("已创建任务并进入执行队列")) return "已创建任务，等待执行";
      if (message.startsWith("暂停等待人工确认")) return "执行已暂停，等待人工确认";
      if (message.startsWith("已完成分片")) return "已完成分配的工作并提交结果";
      if (
        message === "已收到完整变更补丁，恢复独立复核。" ||
        message === "已重置失败/取消状态并重新加入执行队列" ||
        message === "已将任务关联同步至群聊协同" ||
        message === "设备上的 Agent 进程已中断，分片重新排队。"
      )
        return message;
      return "已记录工作交接";
  }
}

export function getSliceProgressSummary(slice: WorkSliceNode, stage: WorkStage): string {
  const verify = slice.leaseRole === "verify";
  switch (slice.status) {
    case "waiting":
      if (stage === "awaiting_answer") return "等待人工答复";
      if (stage === "cancelled" || stage === "blocked") return "任务已暂停";
      if (verify && stage === "working") return "所有执行分片完成后开始复核";
      return `等待 ${slice.worker.displayName} 认领${verify ? "复核" : "执行"}分片`;
    case "running":
      if (slice.liveSummary.startsWith("Claimed lease and preparing workspace."))
        return "已领取工作，正在准备执行环境";
      if (slice.liveSummary.startsWith("正在运行校验命令")) return "正在运行自动化检查";
      if (slice.liveSummary.startsWith("正在准备隔离工作树")) return "正在准备独立工作目录";
      if (slice.liveSummary === "正在按补充指令增量调整…") return "正在按补充说明调整";
      return "正在执行分配的工作";
    case "verifying":
      return "正在复核执行结果";
    case "ready":
      return verify ? "已提交复核结果" : "已提交执行结果";
    case "blocked":
      if (slice.failureCode === "REPEATED_REVIEW_EVIDENCE") return "重复交付相同结果，等待处理";
      return stage === "cancelled" ? "任务已停止" : "执行受阻，等待处理";
  }
}
