import type { OwnedAgentSummaryDto } from "@openhuddle/protocol";
import { afterEach, expect, it, vi } from "vitest";
import { OpenHuddleHttpClient } from "../http-client.js";
import { type WakeExecutionTarget, startSseListener } from "../sse-listener.js";
import { WorkProcessInterruptedError } from "../work-cli-process.js";
import { DeviceWorkListener, supportsDeviceWork } from "../work-listener.js";

const agent = {
  id: "agt_worker",
  displayName: "Worker",
  platform: "codex",
  ownerUserId: "usr_owner",
} as OwnedAgentSummaryDto;
const workspace = {
  id: "wsp_test",
  ownerUserId: agent.ownerUserId,
  isOwnedByViewer: true,
  hostMode: "local_machine",
};
const slice = {
  sliceId: "slc_impl",
  assignedAgent: { agentId: agent.id },
  status: "waiting",
  leaseVersion: 0,
  leaseRole: "write",
};
const item = {
  id: "wrk_roomless",
  ownerUserId: agent.ownerUserId,
  workspaceId: workspace.id,
  version: 1,
  stage: "working",
  slices: [slice],
};
const claimed = { ...slice, leaseVersion: 1, leaseOwnerAgentId: agent.id, status: "running" };
const result = { summary: "Done", changedFiles: [], diffRemoved: 0, diffAdded: 0 };
afterEach(() => vi.useRealTimers());

function setup(
  route: (path: string, body: Record<string, unknown>) => Response,
  execute: NonNullable<ConstructorParameters<typeof DeviceWorkListener>[0]["execute"]>,
  recover?: ConstructorParameters<typeof DeviceWorkListener>[0]["recover"],
) {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const client = new OpenHuddleHttpClient({
    serverUrl: "https://huddle.example",
    fetchImpl: async (url, init) => {
      const path = String(url).replace("https://huddle.example/api/v1", "");
      const body = JSON.parse(String(init?.body ?? "{}"));
      calls.push({ path, body });
      return route(path, body);
    },
  });
  return {
    calls,
    listener: new DeviceWorkListener({
      client,
      log: () => {},
      resolveAgent: async () => agent,
      runner: { kind: "preset", preset: "claude_code" },
      execute,
      ...(recover ? { recover } : {}),
    }),
  };
}

it("recovers roomless work, ignores peer and premature verifier slices, and coalesces duplicate SSE hints", async () => {
  const execute = vi.fn(async () => result);
  let completed = false;
  const { listener, calls } = setup((path) => {
    if (path.includes("claimableOnly"))
      return Response.json({
        items: [
          {
            ...item,
            slices: [
              { ...slice, leaseRole: "verify", sliceId: "slc_verify" },
              { ...slice, assignedAgent: { agentId: "agt_peer" } },
              slice,
            ],
          },
        ],
      });
    if (path === "/workspaces") return Response.json({ workspaces: [workspace] });
    if (path.endsWith("/claim"))
      return Response.json({ item: { ...item, version: 2 }, claimedSlice: claimed });
    if (path.endsWith("/complete")) {
      completed = true;
      return Response.json({ item: { ...item, stage: "verifying" } });
    }
    if (path.endsWith(item.id)) return Response.json({ item: { ...item, stage: "verifying" } });
    throw Error(`unexpected ${path}`);
  }, execute);
  try {
    listener.connected();
    const event = JSON.stringify({
      type: "work.updated",
      workItemId: item.id,
      version: 2,
      stage: "working",
    });
    listener.updated(event);
    listener.updated(event);
    await vi.waitFor(() => expect(completed).toBe(true));
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ agent, runner: { kind: "preset", preset: "claude_code" } }),
    );
    expect(
      calls.filter((c) => c.path.endsWith("/claim")).map((c) => c.body.expectedLeaseVersion),
    ).toEqual([0]);
    expect(calls.find((c) => c.path.endsWith("/complete"))?.body.leaseVersion).toBe(1);
  } finally {
    await listener.stop();
  }
});

it("fetches a verification handoff by event id and requests attention with a scrubbed execution error", async () => {
  const verifyItem = { ...item, stage: "verifying", slices: [{ ...slice, leaseRole: "verify" }] };
  const { listener, calls } = setup(
    (path) => {
      if (path.endsWith(item.id)) return Response.json({ item: verifyItem });
      if (path === "/workspaces") return Response.json({ workspaces: [workspace] });
      if (path.endsWith("/claim"))
        return Response.json({
          item: verifyItem,
          claimedSlice: { ...claimed, leaseRole: "verify" },
        });
      if (path.endsWith("/attention"))
        return Response.json({ item: { ...item, stage: "awaiting_answer" } });
      throw Error(`unexpected ${path}`);
    },
    async () => {
      throw Error("missing workspace; oh_agt_0123456789abcdef");
    },
  );
  try {
    listener.updated(
      JSON.stringify({ type: "work.updated", workItemId: item.id, stage: "verifying", version: 3 }),
    );
    await vi.waitFor(() => expect(calls.some((c) => c.path.endsWith("/attention"))).toBe(true));
    const attention = calls.find((c) => c.path.endsWith("/attention"));
    expect(attention?.body).toMatchObject({
      leaseVersion: 1,
      question: expect.stringContaining("missing workspace"),
    });
    expect(attention?.body.question).not.toContain("0123456789abcdef");
    expect(calls.some((c) => c.path.endsWith("/complete"))).toBe(false);
  } finally {
    await listener.stop();
  }
});

it("leaves an externally interrupted device turn for bounded lease recovery", async () => {
  const executed = vi.fn(async () => {
    throw new WorkProcessInterruptedError("SIGTERM");
  });
  const { listener, calls } = setup((path) => {
    if (path.endsWith(item.id)) return Response.json({ item });
    if (path === "/workspaces") return Response.json({ workspaces: [workspace] });
    if (path.endsWith("/claim")) return Response.json({ item, claimedSlice: claimed });
    throw Error(`unexpected ${path}`);
  }, executed);
  try {
    listener.updated(
      JSON.stringify({ type: "work.updated", workItemId: item.id, stage: "working", version: 2 }),
    );
    await vi.waitFor(() => expect(executed).toHaveBeenCalledOnce());
  } finally {
    await listener.stop();
  }
  expect(calls.some((c) => c.path.endsWith("/attention") || c.path.endsWith("/complete"))).toBe(
    false,
  );
});

it("aborts device execution when its lease heartbeat is rejected and never posts a stale result", async () => {
  vi.useFakeTimers();
  let turnSignal: AbortSignal | undefined;
  const { listener, calls } = setup(
    (path) => {
      if (path.includes("claimableOnly")) return Response.json({ items: [item] });
      if (path === "/workspaces") return Response.json({ workspaces: [workspace] });
      if (path.endsWith("/claim")) return Response.json({ item, claimedSlice: claimed });
      if (path.endsWith("/heartbeat")) return Response.json({ ok: false }, { status: 409 });
      throw Error(`unexpected ${path}`);
    },
    async ({ signal }) => {
      turnSignal = signal;
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      return result;
    },
  );
  try {
    listener.connected();
    await vi.advanceTimersByTimeAsync(1);
    expect(turnSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(turnSignal?.aborted).toBe(true);
    expect(calls.some((c) => c.path.endsWith("/complete") || c.path.endsWith("/attention"))).toBe(
      false,
    );
  } finally {
    await listener.stop();
  }
});

it("leaves loopback dispatch to the server and declines foreign workspaces", async () => {
  expect(supportsDeviceWork("http://[::1]:3000")).toBe(false);
  expect(supportsDeviceWork("http://localhost:3000")).toBe(false);
  expect(supportsDeviceWork("https://huddle.example")).toBe(true);
  const execute = vi.fn();
  const { listener, calls } = setup((path) => {
    if (path.includes("claimableOnly")) return Response.json({ items: [item] });
    if (path === "/workspaces")
      return Response.json({ workspaces: [{ ...workspace, ownerUserId: "usr_peer" }] });
    throw Error(`unexpected ${path}`);
  }, execute);
  try {
    listener.connected();
    await vi.waitFor(() => expect(calls.some((c) => c.path === "/workspaces")).toBe(true));
    expect(execute).not.toHaveBeenCalled();
    expect(calls.some((c) => c.path.endsWith("/claim"))).toBe(false);
  } finally {
    await listener.stop();
  }
});

const remoteTargets: WakeExecutionTarget[] = [
  ...(["codex", "deepseek", "gemini", "antigravity", "claude_code"] as const).map((preset) => ({
    kind: "preset" as const,
    preset,
  })),
  { kind: "custom", command: "device-work-adapter" },
];
it.each(remoteTargets)(
  "uses the configured remote runner %o for a Cursor identity and consumes roomless work events",
  async (target) => {
    const paths: string[] = [];
    let advertisesWork = false;
    const stop = new AbortController();
    await startSseListener({
      serverUrl: "https://huddle.example",
      token: "test",
      tokenFilePath: "/tmp/test.token",
      target,
      signal: stop.signal,
      maxReconnectAttempts: 0,
      catchUpInboxOnConnect: false,
      onLog: () => {},
      fetchImpl: async (input, init) => {
        const path = new URL(String(input)).pathname;
        paths.push(path);
        if (path.endsWith("/me"))
          return Response.json({
            callerKind: "agent",
            agent: { ...agent, platform: "cursor" },
            owner: { id: agent.ownerUserId },
          });
        if (path.endsWith("/events")) {
          advertisesWork = new Headers(init?.headers).get("X-OpenHuddle-Work-Listener") === "1";
          const event = {
            type: "work.updated",
            workItemId: item.id,
            version: 1,
            stage: "verifying",
          };
          return new Response(
            new ReadableStream({
              start(stream) {
                stream.enqueue(
                  new TextEncoder().encode(
                    `event: work.updated\ndata: ${JSON.stringify(event)}\n\n`,
                  ),
                );
              },
            }),
          );
        }
        if (path.endsWith("/work-items")) return Response.json({ items: [] });
        if (path.endsWith(item.id)) {
          stop.abort();
          return Response.json({ item: { ...item, stage: "awaiting_review" } });
        }
        throw Error(`unexpected ${path}`);
      },
    });
    expect(advertisesWork).toBe(true);
    expect(paths.some((p) => p.endsWith(item.id))).toBe(true);
    expect(paths.some((p) => p.includes("/rooms/"))).toBe(false);
  },
);

it("sends full review evidence with the claimed writer lease before reporting completion", async () => {
  const { listener, calls } = setup(
    (path, body) => {
      if (path.includes("claimableOnly")) return Response.json({ items: [item] });
      if (path === "/workspaces") return Response.json({ workspaces: [workspace] });
      if (path.endsWith("/claim")) return Response.json({ item, claimedSlice: claimed });
      if (path.endsWith("/review-evidence")) return Response.json({ ok: true, ...body });
      if (path.endsWith("/complete")) return Response.json({ item });
      throw Error(`unexpected ${path}`);
    },
    async ({ saveReviewEvidence }) => {
      if (!saveReviewEvidence) throw Error("missing evidence transport");
      await saveReviewEvidence("actual worker patch");
      return result;
    },
  );
  try {
    listener.connected();
    await vi.waitFor(() => expect(calls.at(-1)?.path.endsWith("/complete")).toBe(true));
    expect(calls.at(-2)).toMatchObject({
      path: `/work-items/${item.id}/slices/${slice.sliceId}/review-evidence`,
      body: { leaseVersion: 1, patch: "actual worker patch" },
    });
  } finally {
    await listener.stop();
  }
});

it.each([1, 2])(
  "checks the independent writer lease when retrieving evidence for verification (stored v%s)",
  async (storedVersion) => {
    const verify = { ...claimed, sliceId: "slc_verify", leaseRole: "verify" };
    const writer = { ...slice, workItemId: item.id, status: "ready", leaseVersion: 2 };
    const verifyItem = {
      ...item,
      stage: "verifying",
      slices: [writer, { ...verify, status: "waiting", leaseVersion: 0 }],
    };
    const { listener, calls } = setup(
      (path) => {
        if (path.includes("claimableOnly")) return Response.json({ items: [verifyItem] });
        if (path === "/workspaces") return Response.json({ workspaces: [workspace] });
        if (path.endsWith("/claim"))
          return Response.json({ item: verifyItem, claimedSlice: verify });
        if (path.endsWith(`/${slice.sliceId}/review-evidence`))
          return Response.json({
            ok: true,
            leaseVersion: storedVersion,
            patch: "actual worker patch",
          });
        if (path.endsWith("/attention") || path.endsWith("/complete"))
          return Response.json({ item: verifyItem });
        throw Error(`unexpected ${path}`);
      },
      async ({ loadReviewEvidence, item: claimedItem }) => {
        const ready = claimedItem.slices.find((s) => s.status === "ready");
        if (!ready || !loadReviewEvidence) throw Error("missing worker evidence");
        expect(await loadReviewEvidence(ready)).toBe("actual worker patch");
        return { ...result, verdict: "passed" };
      },
    );
    try {
      listener.connected();
      const target = storedVersion === writer.leaseVersion ? "/complete" : "/attention";
      await vi.waitFor(() => expect(calls.at(-1)?.path.endsWith(target)).toBe(true));
      if (target === "/attention") expect(calls.at(-1)?.body.question).toContain("不匹配");
    } finally {
      await listener.stop();
    }
  },
);

it.each(["initial-inbox", "attention-event"] as const)(
  "recovers the original device patch on %s without claiming or executing the slice",
  async (trigger) => {
    const previousLease = 3;
    const request = { workItemId: item.id, sliceId: slice.sliceId };
    const recover = vi.fn(async () => "recovered Git patch");
    const execute = vi.fn();
    const { listener, calls } = setup(
      (path, body) => {
        if (path.startsWith("/inbox")) return Response.json({ reviewEvidenceRequests: [request] });
        if (path.endsWith(item.id))
          return Response.json({
            item: {
              ...item,
              stage: "awaiting_answer",
              slices: [
                {
                  ...slice,
                  status: "ready",
                  leaseOwnerAgentId: agent.id,
                  leaseVersion: previousLease,
                },
              ],
            },
          });
        if (path === "/workspaces")
          return Response.json({ workspaces: [{ ...workspace, sandboxMode: "worktree_pool" }] });
        if (path.endsWith("/review-evidence")) return Response.json({ ok: true, ...body });
        throw Error(`unexpected ${path}`);
      },
      execute,
      recover,
    );
    try {
      if (trigger === "initial-inbox") listener.enqueueEvidenceRequests([request]);
      else
        listener.updated(
          JSON.stringify({
            type: "work.updated",
            workItemId: item.id,
            stage: "awaiting_answer",
            version: 5,
          }),
        );
      await vi.waitFor(() =>
        expect(calls.some((c) => c.path.endsWith("/review-evidence"))).toBe(true),
      );
      expect(calls.at(-1)?.body).toEqual({
        leaseVersion: previousLease,
        patch: "recovered Git patch",
      });
      expect(execute).not.toHaveBeenCalled();
      expect(recover).toHaveBeenCalledOnce();
      expect(calls.some((c) => c.path.endsWith("/claim"))).toBe(false);
    } finally {
      await listener.stop();
    }
  },
);
