import { homedir } from "node:os";
import type {
  CompleteWorkSliceBody,
  OwnedAgentSummaryDto,
  WorkItemDto,
  WorkItemId,
  WorkSliceDto,
  WorkSliceId,
  WorkspaceDto,
} from "@openhuddle/protocol";
import { executeWorkSlice, recoverReviewPatch } from "./execute-work-slice.js";
import { OpenHuddleApiError, type OpenHuddleHttpClient } from "./http-client.js";
import { scrubSensitiveText } from "./secret-scrubber.js";
import type { WakeExecutionTarget } from "./sse-listener.js";

import { WorkProcessInterruptedError } from "./work-cli-process.js";

const LEASE_MS = 90_000;
const HEARTBEAT_MS = 20_000;
const REQUEST_MS = 10_000;
const CATCH_UP_MS = 60_000;

interface WorkListenerOptions {
  readonly client: OpenHuddleHttpClient;
  readonly resolveAgent: (signal: AbortSignal) => Promise<OwnedAgentSummaryDto>;
  readonly runner: WakeExecutionTarget;
  readonly log: (line: string) => void;
  readonly homeDir?: string | undefined;
  readonly execute?: typeof executeWorkSlice;
  readonly recover?: typeof recoverReviewPatch;
}

type WorkUpdate = Pick<WorkItemDto, "id" | "stage" | "version">;

export function supportsDeviceWork(serverUrl: string): boolean {
  // Loopback servers already run the in-process LocalWorkspaceRunner.
  const host = new URL(serverUrl).hostname.toLowerCase();
  return !["localhost", "127.0.0.1", "[::1]"].includes(host);
}

function diagnostic(error: unknown): string {
  return scrubSensitiveText(error instanceof Error ? error.message : String(error)).slice(0, 540);
}

/** One device turn at a time. SSE gives prompt delivery; the durable queue covers disconnects. */
export class DeviceWorkListener {
  private readonly lifetime = new AbortController();
  private readonly pendingIds = new Set<WorkItemId>();
  private needsCatchUp = false;
  private needsEvidenceInbox = false;
  private readonly pendingEvidence = new Map<WorkSliceId, WorkItemId>();
  private pump: Promise<void> | undefined;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private active: { item: WorkUpdate; controller: AbortController } | undefined;

  public constructor(private readonly options: WorkListenerOptions) {}

  public connected(): void {
    if (this.lifetime.signal.aborted) return;
    this.requestCatchUp();
    if (!this.pollTimer) {
      this.pollTimer = setInterval(() => this.requestCatchUp(), CATCH_UP_MS);
      this.pollTimer.unref();
    }
  }

  public updated(data: string): void {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(data);
    } catch {
      return;
    }
    if (
      !event ||
      event.type !== "work.updated" ||
      typeof event.workItemId !== "string" ||
      !event.workItemId.startsWith("wrk_") ||
      event.workItemId.length > 64 ||
      typeof event.version !== "number" ||
      !Number.isSafeInteger(event.version) ||
      event.version < 1
    ) {
      return;
    }

    const itemId = event.workItemId as WorkItemId;
    if (this.active?.item.id === itemId) {
      if (event.version <= this.active.item.version) return;
      if (event.stage === this.active.item.stage) return;
      this.active.controller.abort(new Error("Work item changed stage"));
    }
    if (event.stage === "awaiting_answer") {
      this.needsEvidenceInbox = true;
      this.schedule();
    }
    if (event.stage === "working" || event.stage === "verifying") {
      this.pendingIds.add(itemId);
      this.schedule();
    }
  }

  public enqueueEvidenceRequests(
    requests: readonly { workItemId: WorkItemId; sliceId: WorkSliceId }[],
  ): void {
    for (const request of requests) this.pendingEvidence.set(request.sliceId, request.workItemId);
    if (requests.length) this.schedule();
  }

  public async stop(): Promise<void> {
    clearInterval(this.pollTimer);
    this.lifetime.abort();
    this.active?.controller.abort();
    await this.pump;
  }

  private requestCatchUp(): void {
    this.needsCatchUp = true;
    this.schedule();
  }

  private schedule(): void {
    if (this.pump || this.lifetime.signal.aborted) return;
    this.pump = this.drain().finally(() => {
      this.pump = undefined;
      if (this.hasPending()) this.schedule();
    });
  }

  private requestSignal(parent = this.lifetime.signal): AbortSignal {
    return AbortSignal.any([parent, AbortSignal.timeout(REQUEST_MS)]);
  }

  private hasPending(): boolean {
    return (
      this.needsCatchUp ||
      this.needsEvidenceInbox ||
      this.pendingIds.size > 0 ||
      this.pendingEvidence.size > 0
    );
  }

  private async drain(): Promise<void> {
    while (!this.lifetime.signal.aborted && this.hasPending()) {
      try {
        if (this.needsEvidenceInbox) {
          this.needsEvidenceInbox = false;
          const inbox = await this.options.client.getInbox(0, this.requestSignal());
          this.enqueueEvidenceRequests(inbox.reviewEvidenceRequests ?? []);
          continue;
        }
        const recovery = this.pendingEvidence.entries().next().value;
        if (recovery) {
          const [sliceId, itemId] = recovery;
          this.pendingEvidence.delete(sliceId);
          try {
            await this.recoverEvidence(itemId, sliceId);
          } catch (err) {
            this.options.log(`[openhuddle:work:evidence] ${itemId}/${sliceId}: ${diagnostic(err)}`);
          }
          continue;
        }
        const itemId = this.pendingIds.values().next().value;
        let items: WorkItemDto[];
        if (itemId) {
          this.pendingIds.delete(itemId);
          const { item } = await this.options.client.getWorkItem(itemId, this.requestSignal());
          items = [item];
        } else {
          this.needsCatchUp = false;
          ({ items } = await this.options.client.listClaimableWork(this.requestSignal()));
        }
        if (!items.length) continue;
        const agent = await this.options.resolveAgent(this.requestSignal());
        let workspaces: WorkspaceDto[] | undefined;
        for (const item of items) {
          if (item.ownerUserId !== agent.ownerUserId) continue;
          const slices = item.slices.filter(
            (slice) =>
              slice.assignedAgent.agentId === agent.id &&
              slice.status === "waiting" &&
              (slice.leaseRole === "verify"
                ? item.stage === "verifying"
                : item.stage === "working"),
          );
          if (!slices.length) continue;
          workspaces ??= (await this.options.client.listWorkspaces(this.requestSignal()))
            .workspaces;
          const workspace = workspaces.find((entry) => entry.id === item.workspaceId);
          if (
            !workspace?.isOwnedByViewer ||
            workspace.ownerUserId !== agent.ownerUserId ||
            workspace.hostMode !== "local_machine"
          ) {
            continue;
          }
          for (const slice of slices) {
            if (this.lifetime.signal.aborted) return;
            await this.runSlice(item, slice, workspace, agent).catch((err: unknown) => {
              this.options.log(`[openhuddle:work] ${item.id}/${slice.sliceId}: ${diagnostic(err)}`);
            });
          }
        }
      } catch (err) {
        if (!this.lifetime.signal.aborted) {
          this.options.log(`[openhuddle:work:poll] ${diagnostic(err)}`);
        }
      }
    }
  }

  private async recoverEvidence(itemId: WorkItemId, sliceId: WorkSliceId): Promise<void> {
    const { client } = this.options;
    const { item } = await client.getWorkItem(itemId, this.requestSignal());
    if (item.stage !== "awaiting_answer") return;
    const writer = item.slices.find((slice) => slice.sliceId === sliceId);
    if (!writer || writer.status !== "ready" || writer.leaseRole !== "write") return;
    const agent = await this.options.resolveAgent(this.requestSignal());
    if (
      agent.ownerUserId !== item.ownerUserId ||
      writer.leaseOwnerAgentId !== agent.id ||
      writer.assignedAgent.agentId !== agent.id
    )
      return;
    const { workspaces } = await client.listWorkspaces(this.requestSignal());
    const workspace = workspaces.find((ws) => ws.id === item.workspaceId);
    if (
      !workspace?.isOwnedByViewer ||
      workspace.ownerUserId !== agent.ownerUserId ||
      workspace.hostMode !== "local_machine" ||
      workspace.sandboxMode !== "worktree_pool"
    )
      return;
    const patch = await (this.options.recover ?? recoverReviewPatch)({
      item,
      slice: writer,
      agent,
      workspace,
      runner: this.options.runner,
      homeDir: this.options.homeDir ?? homedir(),
      signal: this.lifetime.signal,
    });
    await client.putReviewEvidence(
      itemId,
      sliceId,
      { leaseVersion: writer.leaseVersion, patch },
      this.requestSignal(),
    );
    this.options.log(
      `[openhuddle:work:evidence] recovered ${itemId}/${sliceId} v${writer.leaseVersion}`,
    );
  }

  private async runSlice(
    item: WorkItemDto,
    slice: WorkSliceDto,
    workspace: WorkspaceDto,
    agent: OwnedAgentSummaryDto,
  ): Promise<void> {
    const client = this.options.client;
    const { claimedSlice, item: claimedItem } = await client.claimWorkSlice(
      item.id,
      slice.sliceId,
      {
        expectedLeaseVersion: slice.leaseVersion,
        leaseTtlMs: LEASE_MS,
        agentEnvironment: `device:${this.options.runner.kind === "preset" ? this.options.runner.preset : "custom"}`,
      },
      this.requestSignal(),
    );
    const leaseVersion = claimedSlice.leaseVersion;
    if (
      this.lifetime.signal.aborted ||
      claimedSlice.leaseOwnerAgentId !== agent.id ||
      leaseVersion !== slice.leaseVersion + 1
    ) {
      return;
    }
    const label = `${item.id}/${slice.sliceId} v${leaseVersion}`;
    this.options.log(`[openhuddle:work:claimed] ${label}`);
    const controller = new AbortController();
    this.active = { item: claimedItem, controller };
    const signal = controller.signal;
    let heartbeat: ReturnType<typeof setTimeout> | undefined;
    const renew = async (): Promise<void> => {
      try {
        const update = await client.renewWorkSlice(
          item.id,
          slice.sliceId,
          {
            leaseVersion,
            leaseTtlMs: LEASE_MS,
          },
          this.requestSignal(signal),
        );
        if (update.item.stage !== claimedItem.stage) controller.abort();
        if (!signal.aborted) heartbeat = setTimeout(() => void renew(), HEARTBEAT_MS);
      } catch (err) {
        if (!signal.aborted)
          this.options.log(`[openhuddle:work:lease] ${label}: ${diagnostic(err)}`);
        controller.abort(err);
      }
    };
    heartbeat = setTimeout(() => void renew(), HEARTBEAT_MS);
    try {
      let result: Omit<CompleteWorkSliceBody, "leaseVersion">;
      try {
        result = await (this.options.execute ?? executeWorkSlice)({
          item: claimedItem,
          slice: claimedSlice,
          workspace,
          agent,
          runner: this.options.runner,
          saveReviewEvidence: async (patch) => {
            await client.putReviewEvidence(
              item.id,
              slice.sliceId,
              { leaseVersion, patch },
              this.requestSignal(signal),
            );
          },
          loadReviewEvidence: async (writer) => {
            if (
              writer.workItemId !== item.id ||
              writer.leaseRole === "verify" ||
              writer.status !== "ready"
            ) {
              throw new Error("只可读取本工单已完成执行分片的复核材料。");
            }
            const evidence = await client.getReviewEvidence(
              item.id,
              writer.sliceId,
              this.requestSignal(signal),
            );
            if (
              evidence.leaseVersion !== writer.leaseVersion ||
              typeof evidence.patch !== "string"
            ) {
              throw new Error(
                `分片 ${writer.sliceId} 的复核材料与执行租约 v${writer.leaseVersion} 不匹配。`,
              );
            }
            return evidence.patch;
          },
          homeDir: this.options.homeDir ?? homedir(),
          signal,
        });
      } catch (err) {
        if (err instanceof WorkProcessInterruptedError) {
          this.options.log(`[openhuddle:work:interrupted] ${label}: ${err.message}`);
          return;
        }
        if (!signal.aborted) {
          await client.raiseWorkAttention(
            item.id,
            slice.sliceId,
            {
              leaseVersion,
              question: `设备执行失败：${diagnostic(err)}`,
              options: ["已处理设备或工作区问题，重试", "补充说明后继续"],
            },
            this.requestSignal(signal),
          );
        }
        return;
      }
      if (signal.aborted) return;
      const body = { ...result, leaseVersion };
      try {
        await client.completeWorkSlice(item.id, slice.sliceId, body, this.requestSignal(signal));
      } catch (err) {
        // The server makes completion idempotent for this lease. Retry the receipt, never the CLI turn.
        if (
          signal.aborted ||
          !(err instanceof OpenHuddleApiError) ||
          (err.status > 0 && err.status < 500)
        ) {
          throw err;
        }
        await client.completeWorkSlice(item.id, slice.sliceId, body, this.requestSignal(signal));
      }
      this.options.log(`[openhuddle:work:completed] ${label}`);
    } finally {
      clearTimeout(heartbeat);
      controller.abort();
      this.active = undefined;
    }
  }
}
