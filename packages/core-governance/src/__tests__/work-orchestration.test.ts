import type { AgentId, UserId, WorkSliceId } from "@openhuddle/protocol";
import { describe, expect, it } from "vitest";
import {
  MAX_SLICE_ATTEMPTS,
  type OrchestrationItemState,
  type OrchestrationSliceState,
  WORK_AGENT_STOP_INSTRUCTION,
  detectOwnedPathConflicts,
  evaluateHumanReviewDecision,
  evaluateRaiseSliceAttention,
  evaluateSliceClaim,
  evaluateSliceCompletion,
  evaluateSliceHeartbeat,
  evaluateWorkspaceExecutionAccess,
  parseWorkVerdict,
  scrubWorkText,
} from "../index.js";

const OWNER_A = "usr_owner_a" as UserId;
const OWNER_B = "usr_owner_b" as UserId;
const WORKER_1 = "agt_worker_1" as AgentId;
const WORKER_2 = "agt_worker_2" as AgentId;
const VERIFIER = "agt_verifier_1" as AgentId;
const SLICE_1 = "slc_01" as WorkSliceId;
const SLICE_2 = "slc_02" as WorkSliceId;
const SLICE_VERIFY = "slc_verify" as WorkSliceId;

function makeSlice(
  overrides: Partial<OrchestrationSliceState> & { sliceId: WorkSliceId },
): OrchestrationSliceState {
  return {
    orderIndex: 0,
    title: "Implement module",
    leaseRole: "write",
    assignedAgentId: WORKER_1,
    leaseVersion: 0,
    attemptCount: 0,
    ownedPaths: ["packages/db"],
    status: "waiting",
    liveSummary: "",
    diffAdded: 0,
    diffRemoved: 0,
    changedFiles: [],
    steerNotes: [],
    ...overrides,
  };
}

describe("@openhuddle/core-governance — work orchestration & durable leases", () => {
  it("reopens read-only deliveries after owner feedback and retains the latest fifty instructions", () => {
    const slice = makeSlice({
      sliceId: SLICE_1,
      leaseRole: "read",
      status: "ready",
      steerNotes: Array.from({ length: 50 }, (_, i) => `instruction ${i}`),
    });
    const result = evaluateHumanReviewDecision({
      item: {
        topology: "direct",
        worktreeBranch: "oh/analysis",
        stage: "awaiting_review",
        slices: [slice],
      },
      reviewerUserId: OWNER_A,
      decision: "request_changes",
      note: "x".repeat(1000),
      nowMs: 2_000,
    });
    expect(result).toMatchObject({ ok: true, nextStage: "working", wakeAgentIds: [WORKER_1] });
    if (!result.ok) throw Error("Expected owner feedback to reopen the delivery");
    const notes = result.nextSlices[0]?.steerNotes;
    expect(notes).toHaveLength(50);
    expect(notes?.[0]).toBe("instruction 1");
    expect(notes?.at(-1)).toHaveLength(1000);
  });

  it("detects overlapping write paths while allowing disjoint swarm paths and verify slices", () => {
    const clean = detectOwnedPathConflicts([
      { index: 0, title: "DB", leaseRole: "write", ownedPaths: ["packages/db/**"] },
      { index: 1, title: "Web", leaseRole: "write", ownedPaths: ["apps/web/src"] },
      { index: 2, title: "Verify", leaseRole: "verify", ownedPaths: ["**"] },
    ]);
    expect(clean).toEqual([]);

    const nestedOverlap = detectOwnedPathConflicts([
      { index: 0, title: "All Server", leaseRole: "write", ownedPaths: ["apps/server/src"] },
      {
        index: 1,
        title: "Workspaces Module",
        leaseRole: "write",
        ownedPaths: ["apps/server/src/modules/workspaces/routes.ts"],
      },
    ]);
    expect(nestedOverlap).toHaveLength(1);
    expect(nestedOverlap[0]?.firstSliceIndex).toBe(0);
    expect(nestedOverlap[0]?.secondSliceIndex).toBe(1);

    const traversal = detectOwnedPathConflicts([
      { index: 0, title: "Escape", leaseRole: "write", ownedPaths: ["../secrets"] },
    ]);
    expect(traversal).toHaveLength(1);
  });

  it("enforces Owner-First host isolation across local_machine, personal_remote, and shared_container", () => {
    expect(
      evaluateWorkspaceExecutionAccess({
        workspaceOwnerUserId: OWNER_A,
        hostMode: "local_machine",
        sandboxMode: "worktree_pool",
        allowRoomCollaborators: true,
        agentOwnerUserId: OWNER_B,
        isRoomMember: true,
        requestedRole: "write",
        requestedTier: "sandbox_branch_write",
      }).ok,
    ).toBe(false);

    expect(
      evaluateWorkspaceExecutionAccess({
        workspaceOwnerUserId: OWNER_A,
        hostMode: "shared_container",
        sandboxMode: "worktree_pool",
        allowRoomCollaborators: true,
        agentOwnerUserId: OWNER_B,
        isRoomMember: true,
        requestedRole: "write",
        requestedTier: "sandbox_branch_write",
      }).ok,
    ).toBe(true);

    expect(
      evaluateWorkspaceExecutionAccess({
        workspaceOwnerUserId: OWNER_A,
        hostMode: "local_machine",
        sandboxMode: "read_only",
        allowRoomCollaborators: false,
        agentOwnerUserId: OWNER_A,
        isRoomMember: true,
        requestedRole: "write",
        requestedTier: "sandbox_branch_write",
      }).ok,
    ).toBe(false);
  });

  it("fences stale lease versions on heartbeat/completion and supports expired lease takeover", () => {
    const t0 = 1_700_000_000_000;
    const initial = makeSlice({ sliceId: SLICE_1, assignedAgentId: WORKER_1 });

    const claim1 = evaluateSliceClaim({
      itemStage: "working",
      slice: initial,
      callerAgentId: WORKER_1,
      canTakeOverExpiredPeerSlice: true,
      leaseTtlMs: 60_000,
      nowMs: t0,
    });
    expect(claim1.ok).toBe(true);
    if (!claim1.ok) return;
    expect(claim1.nextSlice.leaseVersion).toBe(1);

    // Concurrent claim before expiry is rejected
    const raceClaim = evaluateSliceClaim({
      itemStage: "working",
      slice: claim1.nextSlice,
      callerAgentId: WORKER_2,
      canTakeOverExpiredPeerSlice: true,
      nowMs: t0 + 10_000,
    });
    expect(raceClaim.ok).toBe(false);

    // After TTL expires, sibling/peer agent takes over and bumps fencing version to 2
    const takeover = evaluateSliceClaim({
      itemStage: "working",
      slice: claim1.nextSlice,
      callerAgentId: WORKER_2,
      canTakeOverExpiredPeerSlice: true,
      leaseTtlMs: 60_000,
      nowMs: t0 + 61_000,
    });
    expect(takeover.ok).toBe(true);
    if (!takeover.ok) return;
    expect(takeover.wasExpiredTakeover).toBe(true);
    expect(takeover.nextSlice.leaseVersion).toBe(2);
    expect(takeover.nextSlice.leaseOwnerAgentId).toBe(WORKER_2);

    // Zombie worker_1 presenting stale leaseVersion=1 is fenced off
    const staleHeartbeat = evaluateSliceHeartbeat({
      slice: takeover.nextSlice,
      callerAgentId: WORKER_1,
      leaseVersion: 1,
      nowMs: t0 + 65_000,
    });
    expect(staleHeartbeat).toEqual(
      expect.objectContaining({ ok: false, code: "WORK_LEASE_EXPIRED" }),
    );

    // Exhausting MAX_SLICE_ATTEMPTS blocks further claims
    const exhaustedSlice = { ...takeover.nextSlice, attemptCount: MAX_SLICE_ATTEMPTS };
    const overLimit = evaluateSliceClaim({
      itemStage: "working",
      slice: exhaustedSlice,
      callerAgentId: WORKER_2,
      canTakeOverExpiredPeerSlice: true,
      nowMs: t0 + 150_000,
    });
    expect(overLimit).toEqual(
      expect.objectContaining({ ok: false, code: "WORK_INVALID_TRANSITION" }),
    );
  });

  it("synchronizes swarm slices, hands off to verification, pauses repeated deliveries, and requires human approval", () => {
    const t0 = 1_700_000_000_000;
    const s1 = makeSlice({
      sliceId: SLICE_1,
      orderIndex: 0,
      assignedAgentId: WORKER_1,
      leaseOwnerAgentId: WORKER_1,
      leaseVersion: 1,
      leaseExpiresAtMs: t0 + 60_000,
      status: "running",
      ownedPaths: ["packages/db"],
    });
    const s2 = makeSlice({
      sliceId: SLICE_2,
      orderIndex: 1,
      assignedAgentId: WORKER_2,
      leaseOwnerAgentId: WORKER_2,
      leaseVersion: 1,
      leaseExpiresAtMs: t0 + 60_000,
      status: "running",
      ownedPaths: ["apps/server"],
    });
    const sv = makeSlice({
      sliceId: SLICE_VERIFY,
      orderIndex: 2,
      title: "Independent Verification",
      leaseRole: "verify",
      assignedAgentId: VERIFIER,
      ownedPaths: ["**"],
    });

    const initialItem: OrchestrationItemState = {
      topology: "swarm",
      stage: "working",
      worktreeBranch: "oh/swarm-work",
      slices: [s1, s2, sv],
    };

    // 1. Worker 1 finishes first -> barrier waits for Worker 2
    const step1 = evaluateSliceCompletion({
      item: initialItem,
      targetSliceId: SLICE_1,
      callerAgentId: WORKER_1,
      leaseVersion: 1,
      summary: "Added schema tables (token oh_agt_secretToken123456 redacted)",
      changedFiles: ["packages/db/src/schema.ts"],
      diffAdded: 40,
      diffRemoved: 2,
      nowMs: t0 + 5_000,
    });
    expect(step1.ok).toBe(true);
    if (!step1.ok) return;
    expect(step1.nextStage).toBe("working");
    expect(step1.wakeAgentIds).toEqual([]);
    expect(step1.nextSlices[0]?.liveSummary).toContain("oh_agt_[REDACTED]");

    // 2. Worker 2 finishes -> swarm barrier unlocks verifier and wakes VERIFIER
    const step2 = evaluateSliceCompletion({
      item: { ...initialItem, stage: step1.nextStage, slices: step1.nextSlices },
      targetSliceId: SLICE_2,
      callerAgentId: WORKER_2,
      leaseVersion: 1,
      summary: "Implemented routes",
      changedFiles: ["apps/server/src/app.ts"],
      diffAdded: 85,
      diffRemoved: 5,
      nowMs: t0 + 10_000,
    });
    expect(step2.ok).toBe(true);
    if (!step2.ok) return;
    expect(step2.nextStage).toBe("verifying");
    expect(step2.wakeAgentIds).toEqual([VERIFIER]);
    expect(step2.nextReview?.filesChanged).toBe(2);
    expect(step2.nextReview?.additions).toBe(125);

    // 3. Verifier claims verify slice and requests changes -> reopens write slices and wakes both workers
    const doneS0 = step2.nextSlices[0];
    const doneS1 = step2.nextSlices[1];
    const readyVerify = step2.nextSlices[2];
    const baseReview = step2.nextReview;
    if (!doneS0 || !doneS1 || !readyVerify || !baseReview) {
      throw new Error("Expected hydrated slices and review after swarm barrier");
    }
    // Write slices reported no verification command, so the review must not claim a passing test run
    expect(baseReview.testCommand).toBeUndefined();
    expect(baseReview.testPassed).toBeUndefined();

    const vClaim = evaluateSliceClaim({
      itemStage: step2.nextStage,
      slice: readyVerify,
      callerAgentId: VERIFIER,
      canTakeOverExpiredPeerSlice: false,
      nowMs: t0 + 12_000,
    });
    expect(vClaim.ok).toBe(true);
    if (!vClaim.ok) return;

    const itemDuringVerify: OrchestrationItemState = {
      ...initialItem,
      stage: "verifying",
      slices: [doneS0, doneS1, vClaim.nextSlice],
      review: baseReview,
    };

    const reworkStep = evaluateSliceCompletion({
      item: itemDuringVerify,
      targetSliceId: SLICE_VERIFY,
      callerAgentId: VERIFIER,
      leaseVersion: vClaim.nextSlice.leaseVersion,
      summary: "Missing index on workspace_id",
      changedFiles: [],
      diffAdded: 0,
      diffRemoved: 0,
      verdict: "changes_requested",
      reworkEvidenceKey: "evidence-a",
      testCommand: "pnpm test",
      testPassed: false,
      nowMs: t0 + 15_000,
    });
    expect(reworkStep.ok).toBe(true);
    if (!reworkStep.ok) return;
    expect(reworkStep.nextStage).toBe("working");
    expect(reworkStep.wakeAgentIds).toEqual([WORKER_1, WORKER_2]);
    expect(reworkStep.nextSlices[0]?.steerNotes[0]).toContain("[Verifier #1] Missing index");
    // Monotonic fencing version is preserved across rework so stale completions cannot replay
    expect(reworkStep.nextSlices[0]?.leaseVersion).toBe(1);

    // A later review can keep returning genuinely new work even beyond the old cap.
    const previous = {
      ...baseReview,
      verifyLoopsUsed: 8,
      rejectedEvidenceKeys: ["evidence-a", "evidence-b"],
    };
    const latest = {
      item: { ...itemDuringVerify, review: previous },
      targetSliceId: SLICE_VERIFY,
      callerAgentId: VERIFIER,
      leaseVersion: vClaim.nextSlice.leaseVersion,
      summary: "Different wording for an unresolved defect",
      changedFiles: [],
      diffAdded: 0,
      diffRemoved: 0,
      verdict: "changes_requested" as const,
      nowMs: t0 + 16_000,
    };
    expect(evaluateSliceCompletion({ ...latest, reworkEvidenceKey: "new-code" })).toMatchObject({
      ok: true,
      nextStage: "working",
      nextReview: { verifyLoopsUsed: 9 },
    });
    const tripped = evaluateSliceCompletion({ ...latest, reworkEvidenceKey: "evidence-a" });
    expect(tripped).toMatchObject({ ok: true, nextStage: "blocked", wakeAgentIds: [] });
    if (!tripped.ok) throw Error("Expected a fenced no-progress stop");
    expect(
      evaluateSliceCompletion({
        ...latest,
        item: {
          ...itemDuringVerify,
          stage: tripped.nextStage,
          slices: tripped.nextSlices,
          review: tripped.nextReview,
        },
      }),
    ).toMatchObject({ ok: true, idempotentReplay: true, wakeAgentIds: [] });

    // 5. Passing verification lands at awaiting_review; human approval moves to done
    const passVerify = evaluateSliceCompletion({
      item: itemDuringVerify,
      targetSliceId: SLICE_VERIFY,
      callerAgentId: VERIFIER,
      leaseVersion: vClaim.nextSlice.leaseVersion,
      summary: "All 48 tests green",
      changedFiles: [],
      diffAdded: 0,
      diffRemoved: 0,
      verdict: "passed",
      testCommand: "pnpm verify",
      testPassed: true,
      nowMs: t0 + 18_000,
    });
    expect(passVerify.ok).toBe(true);
    if (!passVerify.ok) return;
    expect(passVerify.nextStage).toBe("awaiting_review");
    expect(passVerify.nextReview?.testCommand).toBe("pnpm verify");
    expect(passVerify.nextReview?.testPassed).toBe(true);

    const approved = evaluateHumanReviewDecision({
      item: {
        ...initialItem,
        stage: passVerify.nextStage,
        slices: passVerify.nextSlices,
        ...(passVerify.nextReview ? { review: passVerify.nextReview } : {}),
      },
      reviewerUserId: OWNER_A,
      decision: "approve",
      note: "Ship it",
      nowMs: t0 + 20_000,
    });
    expect(approved.ok).toBe(true);
    if (!approved.ok) return;
    expect(approved.nextStage).toBe("done");
    expect(approved.nextReview.reviewedByUserId).toBe(OWNER_A);
  });

  it("supports pausing slice on worker attention question and scrubbing credentials", () => {
    const t0 = 1_700_000_000_000;
    const running = makeSlice({
      sliceId: SLICE_1,
      leaseOwnerAgentId: WORKER_1,
      leaseVersion: 1,
      leaseExpiresAtMs: t0 + 60_000,
      status: "running",
    });

    const paused = evaluateRaiseSliceAttention({
      itemStage: "working",
      slice: running,
      callerAgentId: WORKER_1,
      leaseVersion: 1,
      question: "Use Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9 or session cookie?",
      nowMs: t0 + 5_000,
    });
    expect(paused.ok).toBe(true);
    if (!paused.ok) return;
    expect(paused.nextStage).toBe("awaiting_answer");
    expect(paused.nextSlice.status).toBe("waiting");
    expect(paused.nextSlice.leaseExpiresAtMs).toBeUndefined();
    expect(paused.scrubbedQuestion).toContain("Bearer [REDACTED]");
    expect(scrubWorkText("https://admin:supersecret@db.internal:5432/app")).toBe(
      "https://admin:[REDACTED]@db.internal:5432/app",
    );
  });

  it("handles idempotent retries for active slice claims and completed slice submissions", () => {
    const t0 = 1_700_000_000_000;
    const initial = makeSlice({ sliceId: SLICE_1, assignedAgentId: WORKER_1 });

    const firstClaim = evaluateSliceClaim({
      itemStage: "working",
      slice: initial,
      callerAgentId: WORKER_1,
      canTakeOverExpiredPeerSlice: false,
      leaseTtlMs: 60_000,
      nowMs: t0,
    });
    expect(firstClaim.ok).toBe(true);
    if (!firstClaim.ok) return;
    expect(firstClaim.idempotentReplay).toBe(false);
    expect(firstClaim.nextSlice.leaseVersion).toBe(1);
    expect(firstClaim.nextSlice.attemptCount).toBe(1);

    // Same worker retrying claim after network drop gets idempotent lease renewal without bumping version/attempt
    const retryClaim = evaluateSliceClaim({
      itemStage: "working",
      slice: firstClaim.nextSlice,
      callerAgentId: WORKER_1,
      canTakeOverExpiredPeerSlice: false,
      leaseTtlMs: 60_000,
      nowMs: t0 + 5_000,
    });
    expect(retryClaim.ok).toBe(true);
    if (!retryClaim.ok) return;
    expect(retryClaim.idempotentReplay).toBe(true);
    expect(retryClaim.nextSlice.leaseVersion).toBe(1);
    expect(retryClaim.nextSlice.attemptCount).toBe(1);

    // Completing slice once transitions to awaiting_review; retrying complete with same leaseVersion is idempotent
    const baseItem: OrchestrationItemState = {
      topology: "direct",
      stage: "working",
      worktreeBranch: "oh/retry-safe",
      slices: [retryClaim.nextSlice],
    };
    const done1 = evaluateSliceCompletion({
      item: baseItem,
      targetSliceId: SLICE_1,
      callerAgentId: WORKER_1,
      leaseVersion: 1,
      summary: "Done once",
      changedFiles: ["packages/db/src/client.ts"],
      diffAdded: 12,
      diffRemoved: 0,
      nowMs: t0 + 10_000,
    });
    expect(done1.ok).toBe(true);
    if (!done1.ok) return;
    expect(done1.idempotentReplay).toBeUndefined();
    expect(done1.nextStage).toBe("awaiting_review");

    const doneRetry = evaluateSliceCompletion({
      item: {
        ...baseItem,
        stage: done1.nextStage,
        slices: done1.nextSlices,
        ...(done1.nextReview ? { review: done1.nextReview } : {}),
      },
      targetSliceId: SLICE_1,
      callerAgentId: WORKER_1,
      leaseVersion: 1,
      summary: "Done once",
      changedFiles: ["packages/db/src/client.ts"],
      diffAdded: 12,
      diffRemoved: 0,
      nowMs: t0 + 12_000,
    });
    expect(doneRetry.ok).toBe(true);
    if (!doneRetry.ok) return;
    expect(doneRetry.idempotentReplay).toBe(true);
    expect(doneRetry.wakeAgentIds).toEqual([]);
  });

  it("preserves WORK_AGENT_STOP_INSTRUCTION line 1 while adding autonomous hosting guidance and strict NEEDS_INPUT rules", () => {
    const lines = WORK_AGENT_STOP_INSTRUCTION.split("\n");
    expect(lines[0]).toBe(
      "Choose your own completion and stopping criteria from the assigned goal and evidence. Finish when those criteria are met. Continue or request rework only when you can name a concrete next action that makes progress.",
    );
    expect(WORK_AGENT_STOP_INSTRUCTION).toContain("ownedPaths");
    expect(WORK_AGENT_STOP_INSTRUCTION).toContain("NEEDS_INPUT:");
    expect(WORK_AGENT_STOP_INSTRUCTION).toContain("owner’s language");
  });

  it("parses final VERDICT strictly from the last non-empty line while tolerating common Markdown wrappers", () => {
    const passingCases: Array<[string, "passed" | "changes_requested", string]> = [
      ["All checks look solid.\nVERDICT: PASSED", "passed", "All checks look solid."],
      [
        "Missing boundary check.\nVERDICT: CHANGES_REQUESTED",
        "changes_requested",
        "Missing boundary check.",
      ],
      ["Reviewed.\n**VERDICT: PASSED**\n\n", "passed", "Reviewed."],
      ["Reviewed.\r\n__VERDICT: CHANGES_REQUESTED__\r\n", "changes_requested", "Reviewed."],
      ["Reviewed.\n`VERDICT: PASSED`", "passed", "Reviewed."],
      ["Reviewed.\n### **VERDICT：PASSED。**", "passed", "Reviewed."],
      ["Reviewed.\n- **VERDICT**: **CHANGES_REQUESTED**.", "changes_requested", "Reviewed."],
      ["Reviewed.\n* `verdict: passed`", "passed", "Reviewed."],
      ["Reviewed.\n> **VERDICT:** `CHANGES_REQUESTED`。", "changes_requested", "Reviewed."],
      ["VERDICT: PASSED", "passed", ""],
    ];

    for (const [raw, expectedVerdict, expectedSummary] of passingCases) {
      const parsed = parseWorkVerdict(raw);
      expect(parsed, raw).toBeDefined();
      expect(parsed?.verdict, raw).toBe(expectedVerdict);
      expect(raw.slice(0, parsed?.summaryEndIndex).trim(), raw).toBe(expectedSummary);
    }

    const rejectedCases = [
      "",
      "   \n  ",
      "VERDICT: PASSED\nHowever, I noticed a bug in line 42.",
      'Quoted example: "VERDICT: PASSED"\nNeeds further checks.',
      "VERDICT: PASSED (looks good)",
      "I think VERDICT: PASSED",
      "VERDICT: APPROVED",
      "PASSED",
      'NEEDS_INPUT: {"question":"VERDICT: PASSED","options":["A","B"]}',
    ];
    for (const raw of rejectedCases) {
      expect(parseWorkVerdict(raw), raw).toBeUndefined();
    }
  });
});
