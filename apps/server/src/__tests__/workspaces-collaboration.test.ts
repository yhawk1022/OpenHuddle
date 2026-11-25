/**
 * @module server/tests/workspaces-collaboration
 * @description 五维工作区、跨主人路径隐私隔离、并发租约防护与三 Agent 蜂群核验闭环端到端集成测试。
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type ManagedDatabase, createDatabaseClient, ensureCoreSchema } from "@openhuddle/db";
import type {
  ApiErrorEnvelope,
  ClaimWorkSliceResponse,
  CreatePairingCodeResponse,
  ListWorkItemsResponse,
  ListWorkspacesResponse,
  PairAgentResponse,
  RoomDetailDto,
  RoomWorkspacesResponse,
  SingleWorkItemResponse,
  SingleWorkspaceResponse,
  SseEvent,
  VerifyOtpResponse,
} from "@openhuddle/protocol";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServerApp, stopServerAppBackgroundTasks } from "../app.js";
import { parseServerEnv } from "../infra/env.js";
import { InMemoryRealtimeBus, type RealtimeBus } from "../infra/realtime-bus.js";
import { createSystemRouter } from "../modules/system/system.routes.js";
import { startWorkLeaseReaper } from "../modules/workspaces/work-lease-reaper.js";
import { WorkspacesRepository } from "../modules/workspaces/workspaces.repo.js";
import { WorkspacesService } from "../modules/workspaces/workspaces.service.js";

async function loginHumanViaOtp(
  app: ReturnType<typeof createServerApp>,
  email: string,
  displayName: string,
): Promise<VerifyOtpResponse> {
  const reqRes = await app.request("/api/v1/auth/otp/request", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, displayName }),
  });
  expect(reqRes.status).toBe(200);
  const reqJson = (await reqRes.json()) as { ok: true; devOtpCode?: string };

  const verifyRes = await app.request("/api/v1/auth/otp/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email,
      code: reqJson.devOtpCode,
      displayName,
    }),
  });
  expect(verifyRes.status).toBe(200);
  return (await verifyRes.json()) as VerifyOtpResponse;
}

async function pairAgentForOwner(
  app: ReturnType<typeof createServerApp>,
  ownerSessionToken: string,
  displayName: string,
  platform: "codex" | "claude_code" | "antigravity",
): Promise<PairAgentResponse> {
  const codeRes = await app.request("/api/v1/pairing-codes", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${ownerSessionToken}`,
    },
    body: JSON.stringify({ expiresInHours: 1 }),
  });
  expect(codeRes.status).toBe(201);
  const { code } = (await codeRes.json()) as CreatePairingCodeResponse;

  const pairRes = await app.request("/api/v1/pair", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code,
      name: displayName,
      platform,
    }),
  });
  expect(pairRes.status).toBe(201);
  return (await pairRes.json()) as PairAgentResponse;
}

describe("@openhuddle/server — 5D Workspaces & Multi-Agent Collaborative Work", () => {
  let database: ManagedDatabase;
  let bus: InMemoryRealtimeBus;
  let app: ReturnType<typeof createServerApp>;

  beforeEach(async () => {
    database = createDatabaseClient({ url: "memory://" });
    await ensureCoreSchema(database.db);
    bus = new InMemoryRealtimeBus();
    app = createServerApp({
      env: parseServerEnv({
        NODE_ENV: "test",
        DATABASE_URL: "memory://",
        ALLOW_DEV_OTP_ECHO: "true",
        LOG_LEVEL: "silent",
      }),
      database,
      realtimeBus: bus,
    });
  });

  afterEach(async () => {
    await bus.close();
    await database.close();
  });

  it("creates 5D workspaces, binds rooms, and redacts local filesystem paths from external room peers", async () => {
    const alice = await loginHumanViaOtp(app, "alice@openhuddle.dev", "Alice");
    const bob = await loginHumanViaOtp(app, "bob@openhuddle.dev", "Bob");
    const aliceCodex = await pairAgentForOwner(app, alice.sessionToken, "Alice Codex", "codex");

    // Alice creates a local_machine workspace with sensitive local path
    const createWsRes = await app.request("/api/v1/workspaces", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${alice.sessionToken}`,
      },
      body: JSON.stringify({
        name: "OpenHuddle Core",
        kind: "git_repo",
        roots: [
          {
            name: "OpenHuddle",
            localPath: "/Users/alice/PrivateRepos/OpenHuddle",
            defaultBranch: "main",
            remoteSlug: "github.com/openhuddle/openhuddle",
          },
        ],
        hostMode: "local_machine",
        hostLabel: "Alice MacBook Pro",
        sandboxMode: "worktree_pool",
        hooks: {
          verifyCommand: "pnpm verify",
        },
        defaultTopology: "verify_loop",
        defaultWorkerAgentId: aliceCodex.agent.id,
      }),
    });
    expect(createWsRes.status).toBe(201);
    const { workspace: createdWs } = (await createWsRes.json()) as SingleWorkspaceResponse;
    expect(createdWs.roots[0]?.localPath).toBe("/Users/alice/PrivateRepos/OpenHuddle");

    // Agents cannot create or delete workspaces directly
    const agentCreateAttempt = await app.request("/api/v1/workspaces", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${aliceCodex.token}`,
      },
      body: JSON.stringify({
        name: "Unauthorized",
        roots: [{ localPath: "/tmp/x" }],
      }),
    });
    expect(agentCreateAttempt.status).toBe(403);

    // Alice creates a Huddle room, Bob joins via invite token, and Alice binds her workspace
    const roomRes = await app.request("/api/v1/rooms", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${alice.sessionToken}`,
      },
      body: JSON.stringify({
        name: "Federation Room",
        topic: "Cross-owner privacy check",
        rules: "",
        visibility: "invite_only",
        initialAgentIds: [aliceCodex.agent.id],
      }),
    });
    expect(roomRes.status).toBe(201);
    const { room } = (await roomRes.json()) as { ok: true; room: RoomDetailDto };

    const joinRes = await app.request("/api/v1/join", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${bob.sessionToken}`,
      },
      body: JSON.stringify({ inviteToken: room.inviteToken }),
    });
    expect(joinRes.status).toBe(200);

    const bindRes = await app.request(`/api/v1/rooms/${room.id}/workspace-binding`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${alice.sessionToken}`,
      },
      body: JSON.stringify({ workspaceId: createdWs.id }),
    });
    expect(bindRes.status).toBe(200);

    // Alice and Alice's own agent see localPath; Bob (external room member) gets redacted roots!
    const aliceListRes = await app.request("/api/v1/workspaces", {
      headers: { authorization: `Bearer ${aliceCodex.token}` },
    });
    expect(aliceListRes.status).toBe(200);
    const aliceList = (await aliceListRes.json()) as ListWorkspacesResponse;
    expect(aliceList.workspaces[0]?.roots[0]?.localPath).toBe(
      "/Users/alice/PrivateRepos/OpenHuddle",
    );

    const bobRoomWsRes = await app.request(`/api/v1/rooms/${room.id}/workspaces`, {
      headers: { authorization: `Bearer ${bob.sessionToken}` },
    });
    expect(bobRoomWsRes.status).toBe(200);
    const bobRoomWs = (await bobRoomWsRes.json()) as RoomWorkspacesResponse;
    expect(bobRoomWs.workspaces).toHaveLength(1);
    expect(bobRoomWs.workspaces[0]?.isOwnedByViewer).toBe(false);
    expect(bobRoomWs.workspaces[0]?.roots[0]?.localPath).toBeUndefined();
    expect(bobRoomWs.workspaces[0]?.roots[0]?.remoteSlug).toBe("github.com/openhuddle/openhuddle");
  });

  it("orchestrates a 3-agent swarm + independent verifier loop, rejects overlapping paths, fences attention/rework, and enforces human review", async () => {
    const owner = await loginHumanViaOtp(app, "lead@openhuddle.dev", "Tech Lead");
    const codexWorker = await pairAgentForOwner(app, owner.sessionToken, "Codex DB", "codex");
    const claudeWorker = await pairAgentForOwner(
      app,
      owner.sessionToken,
      "Claude API",
      "claude_code",
    );
    const agyVerifier = await pairAgentForOwner(
      app,
      owner.sessionToken,
      "AGY Verifier",
      "antigravity",
    );

    const wsRes = await app.request("/api/v1/workspaces", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${owner.sessionToken}`,
      },
      body: JSON.stringify({
        name: "Monorepo",
        kind: "git_repo",
        roots: [{ localPath: "~/Developer/OpenHuddle", defaultBranch: "main" }],
        hostMode: "local_machine",
        sandboxMode: "worktree_pool",
        hooks: { verifyCommand: "pnpm verify" },
      }),
    });
    const { workspace } = (await wsRes.json()) as SingleWorkspaceResponse;

    const roomRes = await app.request("/api/v1/rooms", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${owner.sessionToken}`,
      },
      body: JSON.stringify({
        name: "Backend Swarm Room",
        topic: "Multi-agent execution",
        rules: "",
        visibility: "invite_only",
        initialAgentIds: [codexWorker.agent.id, claudeWorker.agent.id, agyVerifier.agent.id],
      }),
    });
    const { room } = (await roomRes.json()) as { ok: true; room: RoomDetailDto };

    const agentEventsByTarget = new Map<string, SseEvent[]>();
    for (const ag of [codexWorker.agent, claudeWorker.agent, agyVerifier.agent]) {
      const bucket: SseEvent[] = [];
      agentEventsByTarget.set(ag.id, bucket);
      bus.subscribeAgent(ag.id, (ev) => bucket.push(ev));
    }

    // 1. Overlapping write slices in swarm are rejected with 409 WORK_PATH_CONFLICT
    const conflictRes = await app.request("/api/v1/work-items", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${owner.sessionToken}`,
      },
      body: JSON.stringify({
        workspaceId: workspace.id,
        roomId: room.id,
        brief: "Conflicting swarm",
        topology: "swarm",
        primaryWorkerAgentId: codexWorker.agent.id,
        verifierAgentId: agyVerifier.agent.id,
        slices: [
          {
            title: "All packages",
            assignedAgentId: codexWorker.agent.id,
            leaseRole: "write",
            ownedPaths: ["packages/**"],
          },
          {
            title: "DB package",
            assignedAgentId: claudeWorker.agent.id,
            leaseRole: "write",
            ownedPaths: ["packages/db/src"],
          },
        ],
      }),
    });
    expect(conflictRes.status).toBe(409);
    const conflictErr = (await conflictRes.json()) as ApiErrorEnvelope;
    expect(conflictErr.error.code).toBe("WORK_PATH_CONFLICT");

    // 2. Disjoint swarm with 2 parallel writers + 1 independent verifier succeeds and wakes writers only
    const createWorkRes = await app.request("/api/v1/work-items", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${owner.sessionToken}`,
      },
      body: JSON.stringify({
        workspaceId: workspace.id,
        roomId: room.id,
        title: "Implement Workspace Lease Engine",
        brief:
          "Split DB schema and Hono API across disjoint slices, then run independent verification.",
        topology: "swarm",
        tier: "worktree_write",
        primaryWorkerAgentId: codexWorker.agent.id,
        verifierAgentId: agyVerifier.agent.id,
        slices: [
          {
            title: "DB Schema & DDL",
            assignedAgentId: codexWorker.agent.id,
            leaseRole: "write",
            ownedPaths: ["packages/db"],
          },
          {
            title: "Server Routes & Service",
            assignedAgentId: claudeWorker.agent.id,
            leaseRole: "write",
            ownedPaths: ["apps/server/src/modules/workspaces"],
          },
        ],
      }),
    });
    expect(createWorkRes.status).toBe(201);
    const { item: createdItem } = (await createWorkRes.json()) as SingleWorkItemResponse;
    expect(createdItem.slices).toHaveLength(3);
    expect(createdItem.anchorMessageSeq).toBeGreaterThanOrEqual(1);

    const dbSlice = createdItem.slices[0];
    const apiSlice = createdItem.slices[1];
    const verifySlice = createdItem.slices[2];
    if (!dbSlice || !apiSlice || !verifySlice) {
      throw new Error("Expected 3 slices in swarm item");
    }
    expect(verifySlice.leaseRole).toBe("verify");

    expect(agentEventsByTarget.get(codexWorker.agent.id)?.some((e) => e.type === "wake")).toBe(
      true,
    );
    expect(agentEventsByTarget.get(claudeWorker.agent.id)?.some((e) => e.type === "wake")).toBe(
      true,
    );
    expect(agentEventsByTarget.get(agyVerifier.agent.id)?.some((e) => e.type === "wake")).toBe(
      false,
    );

    // 3. claimableOnly work queue returns createdItem for codexWorker, but empty for agyVerifier (locked until barrier)
    const codexQueueRes = await app.request("/api/v1/work-items?claimableOnly=true", {
      headers: { authorization: `Bearer ${codexWorker.token}` },
    });
    expect(((await codexQueueRes.json()) as ListWorkItemsResponse).items).toHaveLength(1);

    const verifierEarlyQueueRes = await app.request("/api/v1/work-items?claimableOnly=true", {
      headers: { authorization: `Bearer ${agyVerifier.token}` },
    });
    expect(((await verifierEarlyQueueRes.json()) as ListWorkItemsResponse).items).toHaveLength(0);

    // 4. Codex claims Slice 1, heartbeats (with secret scrubbing), pauses for attention, and resumes after owner answer
    const claim1Res = await app.request(
      `/api/v1/work-items/${createdItem.id}/slices/${dbSlice.sliceId}/claim`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${codexWorker.token}`,
        },
        body: JSON.stringify({ agentEnvironment: "Mac Studio" }),
      },
    );
    expect(claim1Res.status).toBe(200);
    const claim1 = (await claim1Res.json()) as ClaimWorkSliceResponse;
    expect(claim1.claimedSlice.leaseVersion).toBe(1);

    const hbRes = await app.request(
      `/api/v1/work-items/${createdItem.id}/slices/${dbSlice.sliceId}/heartbeat`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${codexWorker.token}`,
        },
        body: JSON.stringify({
          leaseVersion: 1,
          liveSummary: "Drafting tables with oh_agt_accidentalTokenLeak999888",
          diffAdded: 35,
        }),
      },
    );
    expect(hbRes.status).toBe(200);
    const hbItem = ((await hbRes.json()) as SingleWorkItemResponse).item;
    expect(hbItem.slices[0]?.liveSummary).toContain("oh_agt_[REDACTED]");
    expect(hbItem.slices[0]?.liveSummary).not.toContain("accidentalTokenLeak999888");

    const askRes = await app.request(
      `/api/v1/work-items/${createdItem.id}/slices/${dbSlice.sliceId}/attention`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${codexWorker.token}`,
        },
        body: JSON.stringify({
          leaseVersion: 1,
          question: "Cascade or set null when deleting default worker agent?",
          options: ["ON DELETE SET NULL", "ON DELETE RESTRICT"],
        }),
      },
    );
    expect(askRes.status).toBe(200);
    expect(((await askRes.json()) as SingleWorkItemResponse).item.stage).toBe("awaiting_answer");

    const answerRes = await app.request(`/api/v1/work-items/${createdItem.id}/attention/answer`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${owner.sessionToken}`,
      },
      body: JSON.stringify({ choice: "ON DELETE SET NULL" }),
    });
    expect(answerRes.status).toBe(200);
    expect(((await answerRes.json()) as SingleWorkItemResponse).item.stage).toBe("working");

    // Codex re-claims Slice 1 (fencing version bumps to 2) and completes
    const reclaim1Res = await app.request(
      `/api/v1/work-items/${createdItem.id}/slices/${dbSlice.sliceId}/claim`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${codexWorker.token}`,
        },
        body: JSON.stringify({}),
      },
    );
    const reclaim1 = (await reclaim1Res.json()) as ClaimWorkSliceResponse;
    expect(reclaim1.claimedSlice.leaseVersion).toBe(2);

    const complete1Res = await app.request(
      `/api/v1/work-items/${createdItem.id}/slices/${dbSlice.sliceId}/complete`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${codexWorker.token}`,
        },
        body: JSON.stringify({
          leaseVersion: 2,
          summary: "Added schema & bootstrap DDL (token sk-proj-1234567890abcdef123456)",
          changedFiles: ["packages/db/src/schema.ts", "packages/db/src/bootstrap.ts"],
          diffAdded: 95,
          diffRemoved: 0,
          provenance: {
            agentEnvironment: "Mac Studio",
            leaseRole: "write",
            sessionJsonlPath: "~/.openhuddle/work-logs/codex.jsonl",
            rollingMemoryPath: "~/.openhuddle/work-logs/MEMORY.md",
            gitNotesAttached: true,
          },
        }),
      },
    );
    expect(complete1Res.status).toBe(200);
    const afterSlice1 = ((await complete1Res.json()) as SingleWorkItemResponse).item;
    expect(afterSlice1.stage).toBe("working");
    expect(afterSlice1.slices[0]?.liveSummary).toContain("sk-[REDACTED]");

    // 5. Claude claims & completes Slice 2 -> swarm barrier unlocks AGY Verifier and sends wake!
    const claim2Res = await app.request(
      `/api/v1/work-items/${createdItem.id}/slices/${apiSlice.sliceId}/claim`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${claudeWorker.token}`,
        },
        body: JSON.stringify({}),
      },
    );
    const claim2 = (await claim2Res.json()) as ClaimWorkSliceResponse;

    const complete2Res = await app.request(
      `/api/v1/work-items/${createdItem.id}/slices/${apiSlice.sliceId}/complete`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${claudeWorker.token}`,
        },
        body: JSON.stringify({
          leaseVersion: claim2.claimedSlice.leaseVersion,
          summary: "Implemented workspaces service and routes",
          changedFiles: ["apps/server/src/modules/workspaces/workspaces.service.ts"],
          diffAdded: 210,
          diffRemoved: 4,
        }),
      },
    );
    expect(complete2Res.status).toBe(200);
    const afterBarrier = ((await complete2Res.json()) as SingleWorkItemResponse).item;
    expect(afterBarrier.stage).toBe("verifying");
    expect(agentEventsByTarget.get(agyVerifier.agent.id)?.some((e) => e.type === "wake")).toBe(
      true,
    );

    // 6. AGY Verifier claims verify slice and passes verification -> lands at awaiting_review
    const claimVerifyRes = await app.request(
      `/api/v1/work-items/${createdItem.id}/slices/${verifySlice.sliceId}/claim`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${agyVerifier.token}`,
        },
        body: JSON.stringify({}),
      },
    );
    expect(claimVerifyRes.status).toBe(200);
    const claimVerify = (await claimVerifyRes.json()) as ClaimWorkSliceResponse;

    const passVerifyRes = await app.request(
      `/api/v1/work-items/${createdItem.id}/slices/${verifySlice.sliceId}/complete`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${agyVerifier.token}`,
        },
        body: JSON.stringify({
          leaseVersion: claimVerify.claimedSlice.leaseVersion,
          summary: "All unit & integration checks passed",
          verdict: "passed",
          testCommand: "pnpm verify",
          testPassed: true,
        }),
      },
    );
    expect(passVerifyRes.status).toBe(200);
    const awaitingReview = ((await passVerifyRes.json()) as SingleWorkItemResponse).item;
    expect(awaitingReview.stage).toBe("awaiting_review");
    expect(awaitingReview.review?.filesChanged).toBe(3);
    expect(awaitingReview.review?.additions).toBe(305);

    // 7. Red-Team ADR-0002: Agents can NEVER self-approve review into done
    const agentApproveAttempt = await app.request(`/api/v1/work-items/${createdItem.id}/review`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${agyVerifier.token}`,
      },
      body: JSON.stringify({ decision: "approve" }),
    });
    expect(agentApproveAttempt.status).toBe(403);

    // 8. Human owner approves -> transitions to done and records decision in room timeline
    const humanApproveRes = await app.request(`/api/v1/work-items/${createdItem.id}/review`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${owner.sessionToken}`,
      },
      body: JSON.stringify({ decision: "approve", note: "LGTM, ready to merge" }),
    });
    expect(humanApproveRes.status).toBe(200);
    const finalItem = ((await humanApproveRes.json()) as SingleWorkItemResponse).item;
    expect(finalItem.stage).toBe("done");
    expect(finalItem.review?.reviewedByUserId).toBe(owner.user.id);
  });

  it("enforces lease fencing on expired takeover and isolates local_machine from external agents while enabling shared_container collaboration", async () => {
    const alice = await loginHumanViaOtp(app, "alice2@openhuddle.dev", "Alice");
    const bob = await loginHumanViaOtp(app, "bob2@openhuddle.dev", "Bob");
    const aliceAgent1 = await pairAgentForOwner(app, alice.sessionToken, "Alice Worker 1", "codex");
    const aliceAgent2 = await pairAgentForOwner(
      app,
      alice.sessionToken,
      "Alice Worker 2",
      "claude_code",
    );
    const bobExternalAgent = await pairAgentForOwner(
      app,
      bob.sessionToken,
      "Bob Cloud Agent",
      "antigravity",
    );

    // Room with Alice, Bob, and all 3 agents
    const roomRes = await app.request("/api/v1/rooms", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${alice.sessionToken}`,
      },
      body: JSON.stringify({
        name: "Cross-Env Sandbox Room",
        topic: "Lease takeover & host isolation",
        rules: "",
        visibility: "invite_only",
        initialAgentIds: [aliceAgent1.agent.id, aliceAgent2.agent.id],
      }),
    });
    const { room } = (await roomRes.json()) as { ok: true; room: RoomDetailDto };

    for (const token of [bob.sessionToken, bobExternalAgent.token]) {
      const jr = await app.request("/api/v1/join", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ inviteToken: room.inviteToken }),
      });
      expect(jr.status).toBe(200);
    }

    // Case A: local_machine workspace -> expired lease can be taken over by sibling Alice Worker 2,
    // NEVER by Bob's external agent, and zombie Alice Worker 1 is fenced off!
    const localWsRes = await app.request("/api/v1/workspaces", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${alice.sessionToken}`,
      },
      body: JSON.stringify({
        name: "Alice Private Mac",
        roots: [{ localPath: "/Users/alice/dev" }],
        hostMode: "local_machine",
        sandboxMode: "worktree_pool",
      }),
    });
    const { workspace: localWs } = (await localWsRes.json()) as SingleWorkspaceResponse;

    const localWorkRes = await app.request("/api/v1/work-items", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${alice.sessionToken}`,
      },
      body: JSON.stringify({
        workspaceId: localWs.id,
        roomId: room.id,
        brief: "Fix race condition",
        topology: "direct",
        primaryWorkerAgentId: aliceAgent1.agent.id,
      }),
    });
    expect(localWorkRes.status).toBe(201);
    const localItem = ((await localWorkRes.json()) as SingleWorkItemResponse).item;
    const sliceId = localItem.slices[0]?.sliceId;
    if (!sliceId) {
      throw new Error("Expected direct slice on localItem");
    }

    // Concurrent race: both Alice Worker 1 and Alice Worker 2 race to claim simultaneously -> only Worker 1 (assigned) wins
    const [r1, r2] = await Promise.all([
      app.request(`/api/v1/work-items/${localItem.id}/slices/${sliceId}/claim`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${aliceAgent1.token}`,
        },
        body: JSON.stringify({ leaseTtlMs: 30_000 }),
      }),
      app.request(`/api/v1/work-items/${localItem.id}/slices/${sliceId}/claim`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${aliceAgent2.token}`,
        },
        body: JSON.stringify({ leaseTtlMs: 30_000 }),
      }),
    ]);
    expect(r1.status).toBe(200);
    expect([403, 409]).toContain(r2.status);

    // Force-expire the active lease in DB to simulate worker crash / network partition
    await database.db.execute(sql`
      UPDATE work_slices
      SET lease_expires_at = NOW() - INTERVAL '10 seconds'
      WHERE id = ${sliceId}
    `);

    // External Bob's agent attempts takeover on local_machine -> strictly blocked (403 FORBIDDEN_WORKSPACE_ACCESS)
    const extTakeoverRes = await app.request(
      `/api/v1/work-items/${localItem.id}/slices/${sliceId}/claim`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${bobExternalAgent.token}`,
        },
        body: JSON.stringify({}),
      },
    );
    expect(extTakeoverRes.status).toBe(403);
    expect(((await extTakeoverRes.json()) as ApiErrorEnvelope).error.code).toBe(
      "FORBIDDEN_WORKSPACE_ACCESS",
    );

    // Sibling Alice Worker 2 takes over expired lease -> bumps leaseVersion to 2
    const siblingTakeoverRes = await app.request(
      `/api/v1/work-items/${localItem.id}/slices/${sliceId}/claim`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${aliceAgent2.token}`,
        },
        body: JSON.stringify({}),
      },
    );
    expect(siblingTakeoverRes.status).toBe(200);
    const takeoverData = (await siblingTakeoverRes.json()) as ClaimWorkSliceResponse;
    expect(takeoverData.claimedSlice.leaseVersion).toBe(2);

    // Zombie Alice Worker 1 wakes up and tries to complete with stale leaseVersion=1 -> fenced off with 409 WORK_LEASE_EXPIRED
    const zombieCompleteRes = await app.request(
      `/api/v1/work-items/${localItem.id}/slices/${sliceId}/complete`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${aliceAgent1.token}`,
        },
        body: JSON.stringify({
          leaseVersion: 1,
          summary: "Late stale write",
        }),
      },
    );
    expect(zombieCompleteRes.status).toBe(409);
    expect(((await zombieCompleteRes.json()) as ApiErrorEnvelope).error.code).toBe(
      "WORK_LEASE_EXPIRED",
    );

    // Case B: shared_container workspace with allowRoomCollaborators=true -> Bob's external agent CAN execute a slice!
    const sharedWsRes = await app.request("/api/v1/workspaces", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${alice.sessionToken}`,
      },
      body: JSON.stringify({
        name: "Team Shared Container",
        roots: [{ localPath: "/workspace/app", remoteSlug: "github.com/team/app" }],
        hostMode: "shared_container",
        allowRoomCollaborators: true,
        sandboxMode: "worktree_pool",
      }),
    });
    const { workspace: sharedWs } = (await sharedWsRes.json()) as SingleWorkspaceResponse;

    const sharedWorkRes = await app.request("/api/v1/work-items", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${alice.sessionToken}`,
      },
      body: JSON.stringify({
        workspaceId: sharedWs.id,
        roomId: room.id,
        brief: "Cross-owner collaborative task in shared container",
        topology: "verify_loop",
        tier: "sandbox_branch_write",
        primaryWorkerAgentId: bobExternalAgent.agent.id,
        verifierAgentId: aliceAgent1.agent.id,
      }),
    });
    expect(sharedWorkRes.status).toBe(201);
    const sharedItem = ((await sharedWorkRes.json()) as SingleWorkItemResponse).item;
    const sharedWriteSliceId = sharedItem.slices[0]?.sliceId;
    if (!sharedWriteSliceId) {
      throw new Error("Expected write slice on sharedItem");
    }

    const bobClaimRes = await app.request(
      `/api/v1/work-items/${sharedItem.id}/slices/${sharedWriteSliceId}/claim`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${bobExternalAgent.token}`,
        },
        body: JSON.stringify({ agentEnvironment: "Cloud Container Worker" }),
      },
    );
    expect(bobClaimRes.status).toBe(200);
    const bobClaim = (await bobClaimRes.json()) as ClaimWorkSliceResponse;
    expect(bobClaim.claimedSlice.leaseVersion).toBe(1);
  });

  it("guarantees HA idempotency, parallel CAS heartbeats, SKIP LOCKED expired-lease self-healing, bus fault isolation, and DB readiness probe", async () => {
    const owner = await loginHumanViaOtp(app, "sre@openhuddle.dev", "Principal SRE");
    const w1 = await pairAgentForOwner(app, owner.sessionToken, "Worker 1", "codex");
    const w2 = await pairAgentForOwner(app, owner.sessionToken, "Worker 2", "claude_code");
    const w3 = await pairAgentForOwner(app, owner.sessionToken, "Worker 3", "antigravity");

    const wsRes = await app.request("/api/v1/workspaces", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${owner.sessionToken}`,
      },
      body: JSON.stringify({
        name: "HA Production Cluster",
        roots: [{ localPath: "~/Developer/OpenHuddle" }],
        hostMode: "local_machine",
        sandboxMode: "worktree_pool",
      }),
    });
    const { workspace } = (await wsRes.json()) as SingleWorkspaceResponse;

    const roomRes = await app.request("/api/v1/rooms", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${owner.sessionToken}`,
      },
      body: JSON.stringify({
        name: "HA Incident Room",
        topic: "Resilience & throughput",
        rules: "",
        visibility: "invite_only",
        initialAgentIds: [w1.agent.id, w2.agent.id, w3.agent.id],
      }),
    });
    const { room } = (await roomRes.json()) as { ok: true; room: RoomDetailDto };

    // 1. Concurrent & retried createWorkItem with identical opKey creates strictly 1 work item and 1 room message
    const createPayload = {
      workspaceId: workspace.id,
      roomId: room.id,
      title: "HA Parallel Swarm",
      brief: "Execute 3 parallel slices under burst heartbeats",
      topology: "swarm",
      primaryWorkerAgentId: w1.agent.id,
      opKey: "op_ha_create_swarm_001",
      slices: [
        {
          title: "Slice A",
          assignedAgentId: w1.agent.id,
          leaseRole: "write",
          ownedPaths: ["packages/protocol"],
        },
        {
          title: "Slice B",
          assignedAgentId: w2.agent.id,
          leaseRole: "write",
          ownedPaths: ["packages/db"],
        },
        {
          title: "Slice C",
          assignedAgentId: w3.agent.id,
          leaseRole: "write",
          ownedPaths: ["apps/server"],
        },
      ],
    };

    const [dup1, dup2, dup3] = await Promise.all([
      app.request("/api/v1/work-items", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${owner.sessionToken}`,
        },
        body: JSON.stringify(createPayload),
      }),
      app.request("/api/v1/work-items", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${owner.sessionToken}`,
        },
        body: JSON.stringify(createPayload),
      }),
      app.request("/api/v1/work-items", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${owner.sessionToken}`,
        },
        body: JSON.stringify(createPayload),
      }),
    ]);
    expect(dup1.status).toBe(201);
    expect(dup2.status).toBe(201);
    expect(dup3.status).toBe(201);

    const id1 = ((await dup1.json()) as SingleWorkItemResponse).item.id;
    const id2 = ((await dup2.json()) as SingleWorkItemResponse).item.id;
    const id3 = ((await dup3.json()) as SingleWorkItemResponse).item.id;
    expect(id1).toBe(id2);
    expect(id2).toBe(id3);

    const msgCheckRes = await app.request(`/api/v1/rooms/${room.id}/messages`, {
      headers: { authorization: `Bearer ${owner.sessionToken}` },
    });
    const msgCheck = (await msgCheckRes.json()) as {
      ok: true;
      messages: ReadonlyArray<{ seq: number }>;
    };
    expect(msgCheck.messages).toHaveLength(1);

    const listRes = await app.request(`/api/v1/work-items?roomId=${room.id}&limit=10`, {
      headers: { authorization: `Bearer ${owner.sessionToken}` },
    });
    const swarmItem = ((await listRes.json()) as ListWorkItemsResponse).items[0];
    const sA = swarmItem?.slices[0];
    const sB = swarmItem?.slices[1];
    const sC = swarmItem?.slices[2];
    if (!swarmItem || !sA || !sB || !sC) {
      throw new Error("Expected 3 slices in HA swarm item");
    }

    // 2. Claim all 3 slices + verify idempotent claim retry does NOT bump leaseVersion or attemptCount
    for (const [slice, worker] of [
      [sA, w1],
      [sB, w2],
      [sC, w3],
    ] as const) {
      const claimRes = await app.request(
        `/api/v1/work-items/${swarmItem.id}/slices/${slice.sliceId}/claim`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${worker.token}`,
          },
          body: JSON.stringify({ leaseTtlMs: 60_000 }),
        },
      );
      expect(claimRes.status).toBe(200);
    }

    const retryClaimARes = await app.request(
      `/api/v1/work-items/${swarmItem.id}/slices/${sA.sliceId}/claim`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${w1.token}`,
        },
        body: JSON.stringify({ leaseTtlMs: 60_000 }),
      },
    );
    expect(retryClaimARes.status).toBe(200);
    const retryClaimA = (await retryClaimARes.json()) as ClaimWorkSliceResponse;
    expect(retryClaimA.claimedSlice.leaseVersion).toBe(1);
    expect(retryClaimA.claimedSlice.attemptCount).toBe(1);

    // 3. Burst 15 parallel CAS heartbeats across all 3 slices simultaneously -> 100% succeed with zero cross-slice lock contention
    const burstHeartbeats = Array.from({ length: 15 }, (_, idx) => {
      const pair =
        idx % 3 === 0
          ? ([sA, w1] as const)
          : idx % 3 === 1
            ? ([sB, w2] as const)
            : ([sC, w3] as const);
      return app.request(`/api/v1/work-items/${swarmItem.id}/slices/${pair[0].sliceId}/heartbeat`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${pair[1].token}`,
        },
        body: JSON.stringify({
          leaseVersion: 1,
          liveSummary: `Parallel progress step #${idx + 1}`,
          diffAdded: idx + 1,
        }),
      });
    });
    const hbResponses = await Promise.all(burstHeartbeats);
    for (const r of hbResponses) {
      expect(r.status).toBe(200);
    }

    // 4. Idempotent completeSlice retry on Slice A returns 200 without false 409 error
    const compARes1 = await app.request(
      `/api/v1/work-items/${swarmItem.id}/slices/${sA.sliceId}/complete`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${w1.token}`,
        },
        body: JSON.stringify({
          leaseVersion: 1,
          summary: "Protocol changes done",
          changedFiles: ["packages/protocol/src/workspaces.ts"],
          diffAdded: 24,
        }),
      },
    );
    expect(compARes1.status).toBe(200);
    const versionAfterFirstComplete = ((await compARes1.json()) as SingleWorkItemResponse).item
      .version;

    const compAResRetry = await app.request(
      `/api/v1/work-items/${swarmItem.id}/slices/${sA.sliceId}/complete`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${w1.token}`,
        },
        body: JSON.stringify({
          leaseVersion: 1,
          summary: "Protocol changes done",
          changedFiles: ["packages/protocol/src/workspaces.ts"],
          diffAdded: 24,
        }),
      },
    );
    expect(compAResRetry.status).toBe(200);
    expect(((await compAResRetry.json()) as SingleWorkItemResponse).item.version).toBe(
      versionAfterFirstComplete,
    );

    // 5. Multi-instance SKIP LOCKED expired-lease self-healing reaper:
    //    - Expire Slice B (attemptCount=1 -> returns to waiting and wakes room agents)
    //    - Expire Slice C with exhausted attempts (attemptCount=3 -> transitions item to blocked)
    const wakesForW2: SseEvent[] = [];
    bus.subscribeAgent(w2.agent.id, (ev) => {
      if (ev.type === "wake") wakesForW2.push(ev);
    });

    await database.db.execute(sql`
      UPDATE work_slices
      SET lease_expires_at = NOW() - INTERVAL '30 seconds'
      WHERE id = ${sB.sliceId}
    `);

    const replica1 = new WorkspacesService({
      repo: new WorkspacesRepository(database.db),
      realtimeBus: bus,
    });
    const replica2 = new WorkspacesService({
      repo: new WorkspacesRepository(database.db),
      realtimeBus: bus,
    });

    const reaperHandle = startWorkLeaseReaper({
      workspacesService: replica1,
      intervalMs: 60_000,
    });
    const [sweep1, sweep2] = await Promise.all([
      replica1.sweepExpiredLeases(16),
      replica2.sweepExpiredLeases(16),
    ]);
    await reaperHandle.stop();

    expect(sweep1.reclaimedCount + sweep2.reclaimedCount).toBe(1);
    expect(wakesForW2.length).toBeGreaterThanOrEqual(1);

    // Exhaust Slice C attempts and verify reaper transitions item into blocked for human intervention
    await database.db.execute(sql`
      UPDATE work_slices
      SET attempt_count = 3, lease_expires_at = NOW() - INTERVAL '30 seconds'
      WHERE id = ${sC.sliceId}
    `);
    const exhaustedSweep = await replica1.sweepExpiredLeases(16);
    expect(exhaustedSweep.blockedCount).toBe(1);

    const blockedCheckRes = await app.request(`/api/v1/work-items/${swarmItem.id}`, {
      headers: { authorization: `Bearer ${owner.sessionToken}` },
    });
    expect(((await blockedCheckRes.json()) as SingleWorkItemResponse).item.stage).toBe("blocked");

    // 6. Post-commit RealtimeBus fault isolation: bus throwing after DB commit never turns 201 into 500
    const brokenBus: RealtimeBus = {
      publishToRoom: async () => {
        throw new Error("Simulated pg_notify socket reset");
      },
      publishToAgent: async () => {
        throw new Error("Simulated pg_notify socket reset");
      },
      publishToUser: async () => {
        throw new Error("Simulated pg_notify socket reset");
      },
      subscribeRoom: () => () => undefined,
      subscribeAgent: () => () => undefined,
      subscribeUser: () => () => undefined,
      getActiveAgentConnectionCount: () => 0,
      evictAgentSubscribers: () => undefined,
      evictUserSubscribers: () => undefined,
      evictRoomSubscribers: () => undefined,
      getTelemetry: () => ({
        activeAgentConnections: 0,
        activeAgentCount: 0,
        activeRoomSubscriptions: 0,
        activeRoomCount: 0,
      }),
      close: async () => undefined,
    };

    const faultTolerantApp = createServerApp({
      env: parseServerEnv({
        NODE_ENV: "test",
        DATABASE_URL: "memory://",
        ALLOW_DEV_OTP_ECHO: "true",
        LOG_LEVEL: "silent",
      }),
      database,
      realtimeBus: brokenBus,
    });

    const resilientDispatchRes = await faultTolerantApp.request("/api/v1/work-items", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${owner.sessionToken}`,
      },
      body: JSON.stringify({
        workspaceId: workspace.id,
        roomId: room.id,
        brief: "Must commit cleanly even when post-commit bus throws",
        topology: "direct",
        primaryWorkerAgentId: w1.agent.id,
      }),
    });
    expect(resilientDispatchRes.status).toBe(201);

    // 7. Health endpoint executes real DB liveness probe (200 healthy, 503 when DB fails)
    const healthyProbe = await app.request("/api/v1/health");
    expect(healthyProbe.status).toBe(200);

    const unhealthySystemRouter = createSystemRouter({
      databaseDriver: "postgres",
      realtimeBusDriver: "postgres",
      pingDatabase: async () => {
        throw new Error("Connection refused");
      },
    });
    const deadProbe = await unhealthySystemRouter.request("/health");
    expect(deadProbe.status).toBe(503);
  });

  it("auto-seeds local repo workspace, runs LocalWorkspaceRunner in isolated Git worktree, streams work.trace SSE, captures unified diffs, and aborts on stop", async () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), "oh-local-runner-e2e-"));
    const tempRepoDir = path.join(tempRoot, "demo-repo");
    const tempHomeDir = path.join(tempRoot, "home");
    mkdirSync(tempRepoDir, { recursive: true });
    mkdirSync(tempHomeDir, { recursive: true });

    execFileSync("git", ["init", "-b", "main"], { cwd: tempRepoDir });
    execFileSync("git", ["config", "user.email", "dev@openhuddle.local"], { cwd: tempRepoDir });
    execFileSync("git", ["config", "user.name", "OpenHuddle Test"], { cwd: tempRepoDir });
    writeFileSync(path.join(tempRepoDir, "README.md"), "# Demo Repo\nInitial line\n", "utf8");
    writeFileSync(
      path.join(tempRepoDir, "package.json"),
      JSON.stringify({ name: "demo-repo", scripts: { typecheck: 'node -e "process.exit(0)"' } }),
      "utf8",
    );
    writeFileSync(path.join(tempRepoDir, "CLAUDE.md"), "# Rules\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: tempRepoDir });
    execFileSync("git", ["commit", "-m", "initial commit"], { cwd: tempRepoDir });

    let holdUntilAbort = false;
    let enteredLongExecutor = false;
    let signalAbortedObserved = false;

    const runnerBus = new InMemoryRealtimeBus();
    const runnerApp = createServerApp({
      env: parseServerEnv({
        NODE_ENV: "test",
        PUBLIC_BASE_URL: "http://localhost:3000",
        DATABASE_URL: "memory://",
        ALLOW_DEV_OTP_ECHO: "true",
        LOG_LEVEL: "silent",
      }),
      database,
      realtimeBus: runnerBus,
      localConnectHomeDir: tempHomeDir,
      defaultLocalWorkspaceRoot: tempRepoDir,
      enableLocalWorkspaceRunner: true,
      localRunnerCliExecutor: async (execInput) => {
        if (holdUntilAbort) {
          enteredLongExecutor = true;
          await new Promise<void>((_resolve, reject) => {
            if (execInput.signal.aborted) {
              signalAbortedObserved = true;
              reject(new Error("ABORTED_BY_OWNER"));
              return;
            }
            execInput.signal.addEventListener(
              "abort",
              () => {
                signalAbortedObserved = true;
                reject(new Error("ABORTED_BY_OWNER"));
              },
              { once: true },
            );
          });
        }

        if (execInput.role === "write") {
          execInput.onOutputLine("Scanning repository structure...");
          writeFileSync(
            path.join(execInput.workingDir, "README.md"),
            "# Demo Repo\nUpdated by real local runner\n",
            "utf8",
          );
          mkdirSync(path.join(execInput.workingDir, "src"), { recursive: true });
          writeFileSync(
            path.join(execInput.workingDir, "src", "runner-feature.ts"),
            "export const runnerActive = true;\n",
            "utf8",
          );
          execInput.onOutputLine("Applied edits to README.md and src/runner-feature.ts");
          return {
            summary: "Implemented runner feature and updated README in isolated worktree.",
            commandLabel: "mock-codex-write",
          };
        }

        execInput.onOutputLine("Verifying unified diff and typecheck hook...");
        expect(execInput.prompt).toContain("src/runner-feature.ts");
        return {
          summary: "All typecheck hooks and diff assertions passed.",
          verdict: "passed",
          commandLabel: "mock-claude-verify",
        };
      },
    });

    try {
      const owner = await loginHumanViaOtp(runnerApp, "local-dev@openhuddle.dev", "Local Dev");
      const worker = await pairAgentForOwner(runnerApp, owner.sessionToken, "Local Codex", "codex");
      const verifier = await pairAgentForOwner(
        runnerApp,
        owner.sessionToken,
        "Local Claude",
        "claude_code",
      );

      const liveTraces: Extract<SseEvent, { readonly type: "work.trace" }>[] = [];
      runnerBus.subscribeUser(owner.user.id, (ev) => {
        if (ev.type === "work.trace") {
          liveTraces.push(ev);
        }
      });

      // 1. First GET /api/v1/workspaces auto-seeds the real local Git repository workspace
      const wsListRes = await runnerApp.request("/api/v1/workspaces", {
        headers: { authorization: `Bearer ${owner.sessionToken}` },
      });
      expect(wsListRes.status).toBe(200);
      const wsList = (await wsListRes.json()) as ListWorkspacesResponse;
      expect(wsList.workspaces).toHaveLength(1);
      const seededWs = wsList.workspaces[0];
      if (!seededWs) {
        throw new Error("Expected auto-seeded local workspace");
      }
      expect(seededWs.id.startsWith("wsp_")).toBe(true);
      expect(seededWs.name).toBe("demo-repo");
      expect(seededWs.hostOnline).toBe(true);
      expect(seededWs.sandboxMode).toBe("worktree_pool");
      expect(seededWs.hooks.verifyCommand).toBe("npm run typecheck");

      // 2. Dispatch a verify_loop task -> LocalWorkspaceRunner automatically claims, creates git worktree, edits files, runs verifyCommand + verifier, and reaches awaiting_review
      const createRes = await runnerApp.request("/api/v1/work-items", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${owner.sessionToken}`,
        },
        body: JSON.stringify({
          workspaceId: seededWs.id,
          title: "Implement local runner feature",
          brief: "Create src/runner-feature.ts and update README.md",
          topology: "verify_loop",
          tier: "worktree_write",
          primaryWorkerAgentId: worker.agent.id,
          verifierAgentId: verifier.agent.id,
        }),
      });
      expect(createRes.status).toBe(201);
      const createdItem = ((await createRes.json()) as SingleWorkItemResponse).item;

      let settledItem = createdItem;
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && settledItem.stage !== "awaiting_review") {
        await new Promise((r) => setTimeout(r, 60));
        const pollRes = await runnerApp.request(`/api/v1/work-items/${createdItem.id}`, {
          headers: { authorization: `Bearer ${owner.sessionToken}` },
        });
        settledItem = ((await pollRes.json()) as SingleWorkItemResponse).item;
      }

      expect(settledItem.stage).toBe("awaiting_review");
      expect(settledItem.review?.testCommand).toBeDefined();
      expect(settledItem.review?.testPassed).toBe(true);
      expect(settledItem.diffFiles.map((f) => f.path).sort()).toEqual([
        "README.md",
        "src/runner-feature.ts",
      ]);
      const featureDiff = settledItem.diffFiles.find((f) => f.path === "src/runner-feature.ts");
      expect(featureDiff?.additions).toBe(1);
      expect(
        featureDiff?.lines.some((l) => l.kind === "add" && l.content.includes("runnerActive")),
      ).toBe(true);

      // Main repo stays untouched because changes happened inside isolated ~/.openhuddle/worktrees/...
      expect(existsSync(path.join(tempRepoDir, "src", "runner-feature.ts"))).toBe(false);

      // Live trace SSE stream and persisted trace_json both captured full execution steps
      expect(liveTraces.length).toBeGreaterThanOrEqual(5);
      const traceKinds = new Set(settledItem.trace.map((t) => t.kind));
      expect(traceKinds.has("lease")).toBe(true);
      expect(traceKinds.has("sandbox")).toBe(true);
      expect(traceKinds.has("command")).toBe(true);
      expect(traceKinds.has("output")).toBe(true);
      expect(traceKinds.has("review")).toBe(true);

      const writeProvenance = settledItem.slices[0]?.provenance;
      expect(writeProvenance?.sessionJsonlPath).toBeDefined();
      expect(writeProvenance?.gitNotesAttached).toBe(true);
      if (writeProvenance) {
        expect(existsSync(writeProvenance.sessionJsonlPath)).toBe(true);
        expect(existsSync(writeProvenance.rollingMemoryPath)).toBe(true);
      }

      // 3. Dispatch a long-running task and stop it mid-flight -> AbortSignal fires immediately
      holdUntilAbort = true;
      const longTaskRes = await runnerApp.request("/api/v1/work-items", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${owner.sessionToken}`,
        },
        body: JSON.stringify({
          workspaceId: seededWs.id,
          title: "Long running cancellable task",
          brief: "Hold until owner clicks stop",
          topology: "direct",
          tier: "worktree_write",
          primaryWorkerAgentId: worker.agent.id,
        }),
      });
      const longItem = ((await longTaskRes.json()) as SingleWorkItemResponse).item;

      const claimWaitDeadline = Date.now() + 4_000;
      while (Date.now() < claimWaitDeadline && !enteredLongExecutor) {
        await new Promise((r) => setTimeout(r, 30));
      }

      const stopRes = await runnerApp.request(`/api/v1/work-items/${longItem.id}/control`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${owner.sessionToken}`,
        },
        body: JSON.stringify({ action: "stop" }),
      });
      expect(stopRes.status).toBe(200);
      expect(((await stopRes.json()) as SingleWorkItemResponse).item.stage).toBe("cancelled");
      expect(signalAbortedObserved).toBe(true);
    } finally {
      await stopServerAppBackgroundTasks(runnerApp);
      await runnerBus.close();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects sensitive system/credential paths, auto-creates plain folder workspaces, serializes concurrent in_place writes, and executes mid-flight steering", async () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), "oh-folder-security-e2e-"));
    const tempHomeDir = path.join(tempRoot, "home");
    mkdirSync(path.join(tempHomeDir, "Documents"), { recursive: true });
    mkdirSync(path.join(tempHomeDir, ".ssh"), { recursive: true });

    const activeConcurrency = { current: 0, maxObserved: 0 };
    const observedPasses: string[] = [];
    let unblockFirstPass: (() => void) | undefined;
    const firstPassEntered = new Promise<void>((resolve) => {
      unblockFirstPass = resolve;
    });
    let pauseFirstPassForSteer = false;
    let releaseSteerHold: (() => void) | undefined;

    const folderBus = new InMemoryRealtimeBus();
    const folderApp = createServerApp({
      env: parseServerEnv({
        NODE_ENV: "test",
        PUBLIC_BASE_URL: "http://localhost:3000",
        DATABASE_URL: "memory://",
        ALLOW_DEV_OTP_ECHO: "true",
        LOG_LEVEL: "silent",
      }),
      database,
      realtimeBus: folderBus,
      localConnectHomeDir: tempHomeDir,
      enableLocalWorkspaceRunner: true,
      localRunnerCliExecutor: async (execInput) => {
        activeConcurrency.current += 1;
        activeConcurrency.maxObserved = Math.max(
          activeConcurrency.maxObserved,
          activeConcurrency.current,
        );
        try {
          const isFollowUp = execInput.prompt.includes("Urgent Mid-Flight Steering Instructions");
          observedPasses.push(isFollowUp ? "steer-followup" : "primary");

          if (pauseFirstPassForSteer && !isFollowUp) {
            unblockFirstPass?.();
            await new Promise<void>((resolve) => {
              releaseSteerHold = resolve;
            });
          } else {
            await new Promise((r) => setTimeout(r, 40));
          }

          const specPath = path.join(execInput.workingDir, "spec.md");
          if (isFollowUp) {
            writeFileSync(specPath, "# Product Spec\nLine 1\nMid-flight steered section\n", "utf8");
            return {
              summary: "Applied mid-flight steering section to spec.md",
              commandLabel: "mock-folder-steer",
            };
          }

          const existing = existsSync(specPath) ? "Appended\n" : "";
          writeFileSync(specPath, `# Product Spec\nLine 1\n${existing}`, "utf8");
          return {
            summary: "Wrote initial product spec.md in plain folder workspace",
            commandLabel: "mock-folder-write",
          };
        } finally {
          activeConcurrency.current -= 1;
        }
      },
    });

    try {
      const owner = await loginHumanViaOtp(folderApp, "folder-owner@openhuddle.dev", "Folder Dev");
      const worker = await pairAgentForOwner(
        folderApp,
        owner.sessionToken,
        "Folder Agent",
        "claude_code",
      );

      // 1. Security Guard: mounting ~/.ssh, ~, or /etc on local_machine is strictly blocked with 403
      for (const forbiddenPath of ["~/.ssh", "~", "/etc"]) {
        const badRes = await folderApp.request("/api/v1/workspaces", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${owner.sessionToken}`,
          },
          body: JSON.stringify({
            name: "Forbidden Workspace",
            kind: "folder",
            hostMode: "local_machine",
            sandboxMode: "in_place",
            roots: [{ localPath: forbiddenPath, isGitRepo: false }],
          }),
        });
        expect(badRes.status).toBe(403);
        expect(((await badRes.json()) as ApiErrorEnvelope).error.code).toBe(
          "FORBIDDEN_WORKSPACE_ACCESS",
        );
      }

      // 2. Plain Folder Workspace creation (exact payload matching user's UI modal: ~/Documents/本地测试)
      const createWsRes = await folderApp.request("/api/v1/workspaces", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${owner.sessionToken}`,
        },
        body: JSON.stringify({
          name: "本地测试",
          kind: "folder",
          hostMode: "local_machine",
          sandboxMode: "in_place",
          defaultTopology: "direct",
          roots: [{ localPath: "~/Documents/本地测试", isGitRepo: false }],
          hooks: {},
        }),
      });
      expect(createWsRes.status).toBe(201);
      const { workspace: folderWs } = (await createWsRes.json()) as SingleWorkspaceResponse;
      expect(folderWs.kind).toBe("folder");
      expect(folderWs.sandboxMode).toBe("in_place");
      expect(existsSync(path.join(tempHomeDir, "Documents", "本地测试"))).toBe(true);

      // 3. Mid-flight steering + plain-folder Unified Diff generation (without Git!)
      pauseFirstPassForSteer = true;
      const steerItemRes = await folderApp.request("/api/v1/work-items", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${owner.sessionToken}`,
        },
        body: JSON.stringify({
          workspaceId: folderWs.id,
          title: "撰写本地测试文档",
          brief: "在普通文件夹内新建 spec.md",
          topology: "direct",
          tier: "worktree_write",
          primaryWorkerAgentId: worker.agent.id,
        }),
      });
      expect(steerItemRes.status).toBe(201);
      const steerItem = ((await steerItemRes.json()) as SingleWorkItemResponse).item;

      await firstPassEntered;
      const injectSteerRes = await folderApp.request(`/api/v1/work-items/${steerItem.id}/steer`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${owner.sessionToken}`,
        },
        body: JSON.stringify({ note: "请补充 Mid-flight steered section 章节" }),
      });
      expect(injectSteerRes.status).toBe(200);
      releaseSteerHold?.();
      pauseFirstPassForSteer = false;

      let settledFolderItem = steerItem;
      const deadline = Date.now() + 8_000;
      while (Date.now() < deadline && settledFolderItem.stage !== "awaiting_review") {
        await new Promise((r) => setTimeout(r, 50));
        const poll = await folderApp.request(`/api/v1/work-items/${steerItem.id}`, {
          headers: { authorization: `Bearer ${owner.sessionToken}` },
        });
        settledFolderItem = ((await poll.json()) as SingleWorkItemResponse).item;
      }

      expect(settledFolderItem.stage).toBe("awaiting_review");
      expect(observedPasses).toEqual(["primary", "steer-followup"]);
      // 普通文件夹未配置校验命令：审阅摘要不得伪造“测试已通过”，且追踪时间线必须含最终 Diff 记录
      expect(settledFolderItem.review?.testCommand).toBeUndefined();
      expect(settledFolderItem.review?.testPassed).toBeUndefined();
      expect(settledFolderItem.trace.some((t) => t.kind === "diff")).toBe(true);
      expect(settledFolderItem.diffFiles).toHaveLength(1);
      expect(settledFolderItem.diffFiles[0]?.path).toBe("spec.md");
      expect(settledFolderItem.diffFiles[0]?.additions).toBe(3);
      expect(
        settledFolderItem.diffFiles[0]?.lines.some(
          (l) => l.kind === "add" && l.content.includes("Mid-flight steered section"),
        ),
      ).toBe(true);

      // 4. Two concurrent in_place tasks on the same directory strictly serialize (maxObserved === 1)
      const worker2 = await pairAgentForOwner(
        folderApp,
        owner.sessionToken,
        "Folder Agent 2",
        "codex",
      );
      const [concurrentA, concurrentB] = await Promise.all([
        folderApp.request("/api/v1/work-items", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${owner.sessionToken}`,
          },
          body: JSON.stringify({
            workspaceId: folderWs.id,
            brief: "Concurrent in-place task A",
            topology: "direct",
            tier: "worktree_write",
            primaryWorkerAgentId: worker.agent.id,
          }),
        }),
        folderApp.request("/api/v1/work-items", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${owner.sessionToken}`,
          },
          body: JSON.stringify({
            workspaceId: folderWs.id,
            brief: "Concurrent in-place task B",
            topology: "direct",
            tier: "worktree_write",
            primaryWorkerAgentId: worker2.agent.id,
          }),
        }),
      ]);
      const idA = ((await concurrentA.json()) as SingleWorkItemResponse).item.id;
      const idB = ((await concurrentB.json()) as SingleWorkItemResponse).item.id;

      const lockDeadline = Date.now() + 8_000;
      while (Date.now() < lockDeadline) {
        const [resA, resB] = await Promise.all([
          folderApp.request(`/api/v1/work-items/${idA}`, {
            headers: { authorization: `Bearer ${owner.sessionToken}` },
          }),
          folderApp.request(`/api/v1/work-items/${idB}`, {
            headers: { authorization: `Bearer ${owner.sessionToken}` },
          }),
        ]);
        const itemA = ((await resA.json()) as SingleWorkItemResponse).item;
        const itemB = ((await resB.json()) as SingleWorkItemResponse).item;
        if (itemA.stage === "awaiting_review" && itemB.stage === "awaiting_review") {
          break;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(activeConcurrency.maxObserved).toBe(1);
    } finally {
      await stopServerAppBackgroundTasks(folderApp);
      await folderBus.close();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
