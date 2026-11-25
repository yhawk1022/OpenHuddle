/**
 * @module server/modules/workspaces/work-lease-reaper
 * @description 崩溃或失联执行器租约超时自愈回收守护器（Multi-Instance HA Safe）。
 *
 * 关键不变量：
 * 1. 多副本无锁冲撞：底层依赖 `FOR UPDATE SKIP LOCKED` 扫描部分索引，多台实例同时挂载本守护器时互不阻塞、绝不重复回收同一分片。
 * 2. 单实例防重入：若单轮数据库巡检耗时超过调度间隔，后续脉冲自动跳过，防止慢查询堆积连接池。
 * 3. 零测试泄漏：定时器调用 `.unref()`，并在 `stop()` 时等待在途回收事务排空后再释放句柄。
 */
import type { Logger } from "pino";
import type { WorkspacesService } from "./workspaces.service.js";

/** 默认过期租约巡检周期（15 秒） */
export const DEFAULT_WORK_LEASE_REAPER_INTERVAL_MS = 15_000;

export interface WorkLeaseReaperOptions {
  readonly workspacesService: WorkspacesService;
  readonly intervalMs?: number | undefined;
  readonly batchLimit?: number | undefined;
  readonly logger?: Logger | undefined;
}

export interface ManagedWorkLeaseReaper {
  readonly stop: () => Promise<void>;
}

/**
 * 启动后台过期分片租约自愈回收循环。
 */
export function startWorkLeaseReaper(
  options: Readonly<WorkLeaseReaperOptions>,
): ManagedWorkLeaseReaper {
  const intervalMs = options.intervalMs ?? DEFAULT_WORK_LEASE_REAPER_INTERVAL_MS;
  const batchLimit = options.batchLimit ?? 32;
  const log = options.logger?.child({ component: "work-lease-reaper" });

  let stopped = false;
  let inFlightSweep: Promise<void> | null = null;

  const runTick = (): void => {
    if (stopped || inFlightSweep !== null) {
      return;
    }
    inFlightSweep = options.workspacesService
      .sweepExpiredLeases(batchLimit)
      .then((summary) => {
        if (summary.reclaimedCount > 0 || summary.blockedCount > 0) {
          log?.info(summary, "Reaped expired collaborative work slice leases");
        }
      })
      .catch((err: unknown) => {
        log?.warn({ err }, "Work lease reaper sweep failed; will retry on next tick");
      })
      .finally(() => {
        inFlightSweep = null;
      });
  };

  const timer = setInterval(runTick, intervalMs);
  timer.unref();

  return {
    stop: async (): Promise<void> => {
      if (stopped) {
        return;
      }
      stopped = true;
      clearInterval(timer);
      if (inFlightSweep !== null) {
        await inFlightSweep;
      }
    },
  };
}
