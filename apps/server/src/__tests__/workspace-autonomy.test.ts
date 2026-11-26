/**
 * @module server/tests/workspace-autonomy
 * @description 服务端路径安全守卫、自动建目录初始化、拓扑收敛、单仓 Swarm 隔离、unborn HEAD 自愈与执行器瞬态恢复测试。
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type ManagedDatabase, createDatabaseClient, ensureCoreSchema } from "@openhuddle/db";
import type {
  ApiErrorEnvelope,
  CreatePairingCodeResponse,
  PairAgentResponse,
  SingleWorkItemResponse,
  SingleWorkspaceResponse,
  VerifyOtpResponse,
} from "@openhuddle/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServerApp, stopServerAppBackgroundTasks } from "../app.js";
import { parseServerEnv } from "../infra/env.js";
import { AppError } from "../infra/errors.js";
import { InMemoryRealtimeBus } from "../infra/realtime-bus.js";
import { startLocalWorkspaceRunner } from "../modules/workspaces/local-workspace-runner.js";
import {
  assertSafeLocalWorkspacePath,
  ensureAutoCreatableLocalWorkspaceDir,
  inspectAndPrepareLocalWorkspace,
  resolveCanonicalLocalPath,
} from "../modules/workspaces/workspace-fs-guard.js";
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
    body: JSON.stringify({ email, code: reqJson.devOtpCode, displayName }),
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
    body: JSON.stringify({ code, name: displayName, platform }),
  });
  expect(pairRes.status).toBe(201);
  return (await pairRes.json()) as PairAgentResponse;
}

describe("@openhuddle/server — workspace fs guard & auto-creatable dirs", () => {
  let tempRoot: string;
  let homeDir: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(path.join(tmpdir(), "oh-fs-guard-test-"));
    homeDir = path.join(tempRoot, "home");
    mkdirSync(path.join(homeDir, "projects"), { recursive: true });
    mkdirSync(path.join(homeDir, ".ssh"), { recursive: true });
    mkdirSync(path.join(homeDir, "Library"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it.skipIf(process.platform === "win32")(
    "blocks multi-level ancestor symlink escapes to /etc, ~/.ssh, and dangling symlinks while allowing existing external repos",
    () => {
      symlinkSync("/etc", path.join(homeDir, "projects", "etc-link"));
      symlinkSync(path.join(homeDir, ".ssh"), path.join(homeDir, "projects", "ssh-link"));
      symlinkSync(
        "/etc/openhuddle-nonexistent-target",
        path.join(homeDir, "projects", "dangling-link"),
      );

      expect(resolveCanonicalLocalPath("~/projects/etc-link/a/b", homeDir)).toMatch(
        /^(?:\/private)?\/etc\/a\/b$/,
      );
      expect(() => assertSafeLocalWorkspacePath("~/projects/etc-link/a/b", homeDir)).toThrow(
        /System directory/,
      );
      expect(() =>
        assertSafeLocalWorkspacePath("~/projects/ssh-link/deep/nested", homeDir),
      ).toThrow(/Sensitive credential path/);
      expect(() => assertSafeLocalWorkspacePath("~/projects/dangling-link/a/b", homeDir)).toThrow(
        /broken symbolic link/,
      );

      expect(() => assertSafeLocalWorkspacePath("relative/folder", homeDir)).toThrow(/绝对路径/);
      for (const sensitive of ["~/.config", "~/.openhuddle", "~/Library"]) {
        expect(() => assertSafeLocalWorkspacePath(sensitive, homeDir)).toThrow(
          /Sensitive credential path/,
        );
      }
      if (process.platform === "darwin") {
        expect(() => assertSafeLocalWorkspacePath("~/.OpenHuddle/Tokens", homeDir)).toThrow(
          /Sensitive credential path/,
        );
      }

      // Existing compliant repo outside $HOME remains valid
      const externalRepo = path.join(tempRoot, "external-repo");
      mkdirSync(externalRepo, { recursive: true });
      expect(assertSafeLocalWorkspacePath(externalRepo, homeDir)).toContain("external-repo");
    },
  );

  it.skipIf(process.platform === "win32")(
    "enforces strict CLI-aligned rules for ensureAutoCreatableLocalWorkspaceDir and supports multi-level ~/Developer/新项目",
    () => {
      const outside = path.join(tempRoot, "outside-new");
      expect(() => ensureAutoCreatableLocalWorkspaceDir(outside, homeDir)).toThrow(/当前用户目录/);
      expect(existsSync(outside)).toBe(false);

      for (const badPath of [
        "~/Developer",
        "~/Documents",
        "~/.hidden/new-project",
        "~/projects/.secret/sub",
        "~/Library/new-project",
        "~/Applications/demo",
      ]) {
        expect(() => ensureAutoCreatableLocalWorkspaceDir(badPath, homeDir)).toThrow(
          /当前用户目录/,
        );
      }
      expect(existsSync(path.join(homeDir, ".hidden"))).toBe(false);
      expect(existsSync(path.join(homeDir, "Library", "new-project"))).toBe(false);

      const outsideTarget = path.join(tempRoot, "escape-dir");
      mkdirSync(outsideTarget, { recursive: true });
      symlinkSync(outsideTarget, path.join(homeDir, "projects", "escape-link"));
      expect(() =>
        ensureAutoCreatableLocalWorkspaceDir("~/projects/escape-link/nested/proj", homeDir),
      ).toThrow(/当前用户目录/);
      expect(existsSync(path.join(outsideTarget, "nested"))).toBe(false);

      const first = ensureAutoCreatableLocalWorkspaceDir("~/Developer/新项目", homeDir);
      expect(first.created).toBe(true);
      expect(first.createdDirs).toEqual([path.dirname(first.dir), first.dir]);
      expect(existsSync(first.dir)).toBe(true);
      const second = ensureAutoCreatableLocalWorkspaceDir("~/Developer/新项目", homeDir);
      expect(second.created).toBe(false);
      expect(second.createdDirs).toEqual([]);
      expect(second.dir).toBe(first.dir);

      // inspectAndPrepareLocalWorkspace auto-creates multi-level folder workspaces only (not git_repo)
      inspectAndPrepareLocalWorkspace({
        roots: [{ id: "r1", name: "notes", localPath: "~/Documents/sub/notes", isGitRepo: false }],
        kind: "folder",
        sandboxMode: "in_place",
        homeDir,
      });
      expect(existsSync(path.join(homeDir, "Documents", "sub", "notes"))).toBe(true);

      inspectAndPrepareLocalWorkspace({
        roots: [{ id: "r1", name: "later", localPath: "~/Developer/later-git", isGitRepo: true }],
        kind: "git_repo",
        sandboxMode: "worktree_pool",
        homeDir,
      });
      expect(existsSync(path.join(homeDir, "Developer", "later-git"))).toBe(false);
    },
  );
});

describe("@openhuddle/server — topology normalization & LocalWorkspaceRunner self-healing", () => {
  let database: ManagedDatabase;
  let bus: InMemoryRealtimeBus;
  let tempRoot: string;
  let homeDir: string;

  beforeEach(async () => {
    database = createDatabaseClient({ url: "memory://" });
    await ensureCoreSchema(database.db);
    bus = new InMemoryRealtimeBus();
    tempRoot = mkdtempSync(path.join(tmpdir(), "oh-autonomy-runner-"));
    homeDir = path.join(tempRoot, "home");
    mkdirSync(homeDir, { recursive: true });
  });

  afterEach(async () => {
    await bus.close();
    await database.close();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it("normalizes unsupported workspace defaults and rejects single-root in_place swarm items", async () => {
    const app = createServerApp({
      env: parseServerEnv({
        NODE_ENV: "test",
        DATABASE_URL: "memory://",
        ALLOW_DEV_OTP_ECHO: "true",
        LOG_LEVEL: "silent",
      }),
      database,
      realtimeBus: bus,
    });
    const owner = await loginHumanViaOtp(app, "topo@openhuddle.dev", "Owner");
    const w1 = await pairAgentForOwner(app, owner.sessionToken, "W1", "codex");
    const w2 = await pairAgentForOwner(app, owner.sessionToken, "W2", "claude_code");
    const headers = {
      "content-type": "application/json",
      authorization: `Bearer ${owner.sessionToken}`,
    };

    // A plain folder falls back to a direct task even when no verifier is configured.
    const singleWsRes = await app.request("/api/v1/workspaces", {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: "Single In-Place",
        kind: "folder",
        roots: [{ localPath: "~/Developer/single-folder", isGitRepo: false }],
        hostMode: "local_machine",
        sandboxMode: "in_place",
        defaultTopology: "swarm",
      }),
    });
    expect(singleWsRes.status).toBe(201);
    const singleWs = ((await singleWsRes.json()) as SingleWorkspaceResponse).workspace;
    expect(singleWs.defaultTopology).toBe("direct");

    // 2. Multi-root workspace with worktree_pool keeps swarm; switching to read_only or 1 root converges to verify_loop
    const multiWsRes = await app.request("/api/v1/workspaces", {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: "Multi Root",
        kind: "multi_root",
        roots: [
          { name: "api", localPath: "~/Developer/api", isGitRepo: true },
          { name: "web", localPath: "~/Developer/web", isGitRepo: true },
        ],
        hostMode: "local_machine",
        sandboxMode: "worktree_pool",
        defaultTopology: "swarm",
      }),
    });
    expect(multiWsRes.status).toBe(201);
    const multiWs = ((await multiWsRes.json()) as SingleWorkspaceResponse).workspace;
    expect(multiWs.defaultTopology).toBe("swarm");

    const duplicatePatch = await app.request(`/api/v1/workspaces/${multiWs.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        roots: [{ localPath: "~/Developer/app" }, { localPath: "~/Developer/team/app" }],
      }),
    });
    expect(duplicatePatch.status).toBe(200);
    expect(
      ((await duplicatePatch.json()) as SingleWorkspaceResponse).workspace.defaultTopology,
    ).toBe("verify_loop");

    const readonlyPatch = await app.request(`/api/v1/workspaces/${multiWs.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        sandboxMode: "read_only",
        defaultTopology: "swarm",
        roots: multiWs.roots,
      }),
    });
    expect(readonlyPatch.status).toBe(200);
    expect(
      ((await readonlyPatch.json()) as SingleWorkspaceResponse).workspace.defaultTopology,
    ).toBe("verify_loop");

    // 3. createWorkItem with topology="swarm" on single-root in_place rejects with 400 VALIDATION_ERROR
    const badSwarmRes = await app.request("/api/v1/work-items", {
      method: "POST",
      headers,
      body: JSON.stringify({
        workspaceId: singleWs.id,
        brief: "Cannot swarm on single in-place dir",
        topology: "swarm",
        primaryWorkerAgentId: w1.agent.id,
        slices: [
          { title: "A", assignedAgentId: w1.agent.id, leaseRole: "write", ownedPaths: ["a/**"] },
          { title: "B", assignedAgentId: w2.agent.id, leaseRole: "write", ownedPaths: ["b/**"] },
        ],
      }),
    });
    expect(badSwarmRes.status).toBe(400);
    expect(((await badSwarmRes.json()) as ApiErrorEnvelope).error.code).toBe("VALIDATION_ERROR");

    // 4. Single-root worktree_pool still accepts explicit disjoint swarm slices
    const gitWsRes = await app.request("/api/v1/workspaces", {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: "Single Git Pool",
        kind: "git_repo",
        roots: [{ localPath: "~/Developer/git-pool", isGitRepo: true }],
        hostMode: "local_machine",
        sandboxMode: "worktree_pool",
      }),
    });
    const gitWs = ((await gitWsRes.json()) as SingleWorkspaceResponse).workspace;
    const okSwarmRes = await app.request("/api/v1/work-items", {
      method: "POST",
      headers,
      body: JSON.stringify({
        workspaceId: gitWs.id,
        brief: "Swarm in git worktree_pool",
        topology: "swarm",
        primaryWorkerAgentId: w1.agent.id,
        slices: [
          { title: "A", assignedAgentId: w1.agent.id, leaseRole: "write", ownedPaths: ["a/**"] },
          { title: "B", assignedAgentId: w2.agent.id, leaseRole: "write", ownedPaths: ["b/**"] },
        ],
      }),
    });
    expect(okSwarmRes.status).toBe(201);
  });

  it.skipIf(process.platform === "win32")(
    "auto-creates ~/Developer/新项目 with Git init, heals clean unborn HEAD, rejects dirty unborn HEAD, isolates swarm worktrees, and recovers verdict/429",
    async () => {
      const app = createServerApp({
        env: parseServerEnv({
          NODE_ENV: "test",
          PUBLIC_BASE_URL: "http://localhost:3000",
          DATABASE_URL: "memory://",
          ALLOW_DEV_OTP_ECHO: "true",
          LOG_LEVEL: "silent",
        }),
        database,
        realtimeBus: bus,
        localConnectHomeDir: homeDir,
        enableLocalWorkspaceRunner: false,
      });

      const owner = await loginHumanViaOtp(app, "runner-auto@openhuddle.dev", "Auto Owner");
      const w1 = await pairAgentForOwner(app, owner.sessionToken, "Worker 1", "codex");
      const w2 = await pairAgentForOwner(app, owner.sessionToken, "Worker 2", "claude_code");
      const verifier = await pairAgentForOwner(app, owner.sessionToken, "Verifier", "antigravity");
      const headers = {
        "content-type": "application/json",
        authorization: `Bearer ${owner.sessionToken}`,
      };

      const repo = new WorkspacesRepository(database.db);
      const workspacesService = new WorkspacesService({
        repo,
        realtimeBus: bus,
        isLoopbackHost: true,
        localHomeDir: homeDir,
      });

      const observedWorkdirs = new Map<string, string>();
      const verifyAttempts = new Map<string, number>();
      let transientFailOnce = true;
      let swarmReviewPrompt = "";
      let lostLeaseAborted = false;

      const runner = startLocalWorkspaceRunner({
        repo,
        workspacesService,
        homeDir,
        transientRetryDelayMs: 0,
        cliExecutor: async (input) => {
          if (input.prompt.includes("LOSE_LEASE")) {
            await new Promise<void>((_resolve, reject) => {
              input.signal.addEventListener(
                "abort",
                () => {
                  lostLeaseAborted = true;
                  reject(input.signal.reason);
                },
                { once: true },
              );
            });
          }
          if (input.role === "write") {
            if (input.prompt.includes("TRANSIENT_ONCE") && transientFailOnce) {
              transientFailOnce = false;
              throw new Error("codex exited with status 1: HTTP 429 rate limit exceeded");
            }
            const tag = input.agentName;
            observedWorkdirs.set(`${tag}:${input.prompt.slice(0, 60)}`, input.workingDir);
            const filename = tag === "Worker 1" ? "a/one.ts" : "b/two.ts";
            mkdirSync(path.join(input.workingDir, path.dirname(filename)), { recursive: true });
            writeFileSync(path.join(input.workingDir, filename), `export const who = "${tag}";\n`);
            return { summary: `Wrote ${filename}`, commandLabel: "mock-write" };
          }

          if (input.prompt.includes("Swarm isolation check")) {
            swarmReviewPrompt = input.prompt;
            return {
              summary: "Reviewed both write slices",
              verdict: "passed",
              commandLabel: "mock-verify",
            };
          }

          // Verify role: test missing verdict follow-up & Markdown verdict parsing
          const key = input.workingDir;
          const count = (verifyAttempts.get(key) ?? 0) + 1;
          verifyAttempts.set(key, count);
          if (count === 1) {
            return {
              summary: "Checked diff thoroughly, no defects found.",
              commandLabel: "mock-verify",
            };
          }
          expect(input.prompt).toContain("Checked diff thoroughly");
          return {
            summary: "### **VERDICT：PASSED。**",
            commandLabel: "mock-verify",
          };
        },
      });

      const waitStage = async (workItemId: string, expectedStages: readonly string[]) => {
        const deadline = Date.now() + 10_000;
        let current: SingleWorkItemResponse["item"] | undefined;
        while (Date.now() < deadline) {
          const res = await app.request(`/api/v1/work-items/${workItemId}`, {
            headers: { authorization: `Bearer ${owner.sessionToken}` },
          });
          current = ((await res.json()) as SingleWorkItemResponse).item;
          if (expectedStages.includes(current.stage)) return current;
          await new Promise((r) => setTimeout(r, 40));
        }
        throw new Error(
          `Timed out waiting for ${workItemId} stage in [${expectedStages.join(",")}], got ${current?.stage}`,
        );
      };

      const dispatchViaService = async (
        payload: Parameters<WorkspacesService["createWorkItem"]>[1],
      ) =>
        workspacesService.createWorkItem(
          {
            kind: "human",
            userId: owner.user.id,
            displayName: owner.user.displayName,
            email: owner.user.email,
          },
          payload,
        );

      try {
        // 1. Missing ~/Developer/新项目 auto-created on first write + Git init + 429 transient retry + verify verdict follow-up
        writeFileSync(
          path.join(homeDir, "check.sh"),
          [
            "echo '-----BEGIN PRIVATE KEY-----'",
            "echo 'sensitive-hook-output-for-regression'",
            "echo '-----END PRIVATE KEY-----'",
            "test -f a/one.ts",
          ].join("\n"),
        );
        const newWsRes = await app.request("/api/v1/workspaces", {
          method: "POST",
          headers,
          body: JSON.stringify({
            name: "新项目",
            kind: "git_repo",
            roots: [{ localPath: "~/Developer/新项目", defaultBranch: "main" }],
            hooks: { verifyCommand: `sh "${path.join(homeDir, "check.sh")}"` },
            hostMode: "local_machine",
            sandboxMode: "worktree_pool",
          }),
        });
        expect(newWsRes.status).toBe(201);
        const newWs = ((await newWsRes.json()) as SingleWorkspaceResponse).workspace;
        const newProjectDir = path.join(homeDir, "Developer", "新项目");
        expect(existsSync(newProjectDir)).toBe(false);

        const createdItem = await dispatchViaService({
          workspaceId: newWs.id,
          title: "Bootstrap 新项目",
          brief: "TRANSIENT_ONCE create initial files",
          topology: "verify_loop",
          tier: "worktree_write",
          primaryWorkerAgentId: w1.agent.id,
          verifierAgentId: verifier.agent.id,
        });
        const settled = await waitStage(createdItem.id, ["awaiting_review"]);
        expect(existsSync(newProjectDir)).toBe(true);
        expect(
          execFileSync("git", ["rev-parse", "--verify", "HEAD"], {
            cwd: newProjectDir,
            encoding: "utf8",
          }).trim(),
        ).toMatch(/^[0-9a-f]{40}$/);
        expect(settled.review?.verifierNote).toContain("Checked diff thoroughly");

        // 2. Single-repo swarm isolates 2 parallel write slices into distinct worktrees & branches
        const swarmItem = await dispatchViaService({
          workspaceId: newWs.id,
          title: "Swarm isolation check",
          brief: "Run two parallel writers on disjoint paths",
          topology: "swarm",
          tier: "worktree_write",
          primaryWorkerAgentId: w1.agent.id,
          verifierAgentId: verifier.agent.id,
          slices: [
            {
              title: "Part A",
              assignedAgentId: w1.agent.id,
              leaseRole: "write",
              ownedPaths: ["a/**"],
            },
            {
              title: "Part B",
              assignedAgentId: w2.agent.id,
              leaseRole: "write",
              ownedPaths: ["b/**"],
            },
          ],
        });
        const settledSwarm = await waitStage(swarmItem.id, ["awaiting_review"]);
        const branchA = settledSwarm.slices[0]?.worktreeBranch;
        const branchB = settledSwarm.slices[1]?.worktreeBranch;
        expect(branchA).toBeTruthy();
        expect(branchB).toBeTruthy();
        expect(branchA).not.toBe(branchB);
        const swarmDirs = [...observedWorkdirs.entries()]
          .filter(([k]) => k.includes("Swarm isolation check"))
          .map(([, dir]) => dir);
        expect(swarmDirs).toHaveLength(2);
        expect(swarmDirs[0]).not.toBe(swarmDirs[1]);

        expect(swarmReviewPrompt).toContain('export const who = "Worker 1"');
        expect(swarmReviewPrompt).toContain('export const who = "Worker 2"');
        for (const dir of swarmDirs) expect(swarmReviewPrompt).toContain(dir);
        expect(settledSwarm.review?.testCommand).toBeUndefined();
        expect(settledSwarm.review?.testPassed).toBeUndefined();
        expect(settled.review?.testPassed).toBe(true);
        expect(JSON.stringify(settled.trace)).not.toContain("sensitive-hook-output-for-regression");

        const nestedWsRes = await app.request("/api/v1/workspaces", {
          method: "POST",
          headers,
          body: JSON.stringify({
            name: "Nested project",
            kind: "git_repo",
            hostMode: "local_machine",
            sandboxMode: "worktree_pool",
            roots: [{ localPath: "~/Developer/新项目/new/nested" }],
          }),
        });
        const nestedWs = ((await nestedWsRes.json()) as SingleWorkspaceResponse).workspace;
        const nestedItem = await dispatchViaService({
          workspaceId: nestedWs.id,
          brief: "Try a nested repo",
          topology: "direct",
          tier: "worktree_write",
          primaryWorkerAgentId: w1.agent.id,
        });
        expect((await waitStage(nestedItem.id, ["awaiting_answer"])).attention?.question).toContain(
          "仓库根目录",
        );
        expect(existsSync(path.join(newProjectDir, "new"))).toBe(false);

        // 3. Clean unborn HEAD repo heals preserving branch "develop"
        const cleanUnbornDir = path.join(homeDir, "Developer", "clean-unborn");
        mkdirSync(cleanUnbornDir, { recursive: true });
        execFileSync("git", ["init", "-q"], { cwd: cleanUnbornDir });
        execFileSync("git", ["symbolic-ref", "HEAD", "refs/heads/develop"], {
          cwd: cleanUnbornDir,
        });
        const cleanWsRes = await app.request("/api/v1/workspaces", {
          method: "POST",
          headers,
          body: JSON.stringify({
            name: "Clean Unborn",
            kind: "git_repo",
            roots: [{ localPath: "~/Developer/clean-unborn", defaultBranch: "main" }],
            hostMode: "local_machine",
            sandboxMode: "worktree_pool",
          }),
        });
        const cleanWs = ((await cleanWsRes.json()) as SingleWorkspaceResponse).workspace;
        const cleanItem = await dispatchViaService({
          workspaceId: cleanWs.id,
          title: "Clean unborn task",
          brief: "Write into clean unborn repo",
          topology: "direct",
          tier: "worktree_write",
          primaryWorkerAgentId: w1.agent.id,
        });
        await waitStage(cleanItem.id, ["awaiting_review"]);
        expect(
          execFileSync("git", ["symbolic-ref", "--short", "HEAD"], {
            cwd: cleanUnbornDir,
            encoding: "utf8",
          }).trim(),
        ).toBe("develop");

        // 4. Dirty unborn HEAD raises attention without creating a commit
        const dirtyUnbornDir = path.join(homeDir, "Developer", "dirty-unborn");
        mkdirSync(dirtyUnbornDir, { recursive: true });
        execFileSync("git", ["init", "-q"], { cwd: dirtyUnbornDir });
        writeFileSync(path.join(dirtyUnbornDir, "draft.txt"), "uncommitted\n");
        const dirtyWsRes = await app.request("/api/v1/workspaces", {
          method: "POST",
          headers,
          body: JSON.stringify({
            name: "Dirty Unborn",
            kind: "git_repo",
            roots: [{ localPath: "~/Developer/dirty-unborn" }],
            hostMode: "local_machine",
            sandboxMode: "worktree_pool",
          }),
        });
        const dirtyWs = ((await dirtyWsRes.json()) as SingleWorkspaceResponse).workspace;
        const dirtyItem = await dispatchViaService({
          workspaceId: dirtyWs.id,
          title: "Dirty unborn task",
          brief: "Should fail closed on dirty unborn repo",
          topology: "direct",
          tier: "worktree_write",
          primaryWorkerAgentId: w1.agent.id,
        });
        const dirtyPaused = await waitStage(dirtyItem.id, ["awaiting_answer"]);
        expect(dirtyPaused.attention?.question).toContain("未提交文件");
        expect(() =>
          execFileSync("git", ["rev-parse", "--verify", "HEAD"], {
            cwd: dirtyUnbornDir,
            stdio: "ignore",
          }),
        ).toThrow();

        // 5. Existing branch is reused without -B (prior commit preserved) and non-empty conflicting worktree fails closed
        const existingBranchRepo = path.join(homeDir, "Developer", "reuse-branch");
        mkdirSync(existingBranchRepo, { recursive: true });
        execFileSync("git", ["init", "-q"], { cwd: existingBranchRepo });
        execFileSync(
          "git",
          [
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@localhost",
            "commit",
            "--allow-empty",
            "-qm",
            "base",
          ],
          { cwd: existingBranchRepo },
        );
        execFileSync("git", ["checkout", "-qb", "oh/preexisting"], { cwd: existingBranchRepo });
        writeFileSync(path.join(existingBranchRepo, "keep-commit.txt"), "from-branch\n");
        execFileSync("git", ["add", "keep-commit.txt"], { cwd: existingBranchRepo });
        execFileSync(
          "git",
          ["-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-qm", "keep"],
          { cwd: existingBranchRepo },
        );
        execFileSync("git", ["checkout", "-q", "-"], { cwd: existingBranchRepo });

        const reuseWsRes = await app.request("/api/v1/workspaces", {
          method: "POST",
          headers,
          body: JSON.stringify({
            name: "Reuse Branch",
            kind: "git_repo",
            roots: [{ localPath: "~/Developer/reuse-branch" }],
            hostMode: "local_machine",
            sandboxMode: "worktree_pool",
          }),
        });
        const reuseWs = ((await reuseWsRes.json()) as SingleWorkspaceResponse).workspace;
        const reuseItem = await dispatchViaService({
          workspaceId: reuseWs.id,
          title: "Reuse existing branch",
          brief: "Attach existing branch without reset",
          topology: "direct",
          tier: "worktree_write",
          worktreeBranch: "oh/preexisting",
          primaryWorkerAgentId: w1.agent.id,
        });
        await waitStage(reuseItem.id, ["awaiting_review"]);
        const reusedWtDir = path.join(
          homeDir,
          ".openhuddle",
          "worktrees",
          reuseWs.id,
          "oh-preexisting",
        );
        expect(readFileSync(path.join(reusedWtDir, "keep-commit.txt"), "utf8")).toBe(
          "from-branch\n",
        );

        // Non-empty conflicting dir fails closed without deleting files
        const conflictWtDir = path.join(
          homeDir,
          ".openhuddle",
          "worktrees",
          reuseWs.id,
          "oh-conflict-wt",
        );
        mkdirSync(conflictWtDir, { recursive: true });
        writeFileSync(path.join(conflictWtDir, "precious.txt"), "do-not-delete");
        const conflictItem = await dispatchViaService({
          workspaceId: reuseWs.id,
          title: "Conflicting worktree dir",
          brief: "Should fail closed on non-empty conflicting worktree",
          topology: "direct",
          tier: "worktree_write",
          worktreeBranch: "oh/conflict-wt",
          primaryWorkerAgentId: w1.agent.id,
        });
        const conflictPaused = await waitStage(conflictItem.id, ["awaiting_answer"]);
        expect(conflictPaused.attention?.question).toContain("已有工作树与工单分支不一致");
        expect(readFileSync(path.join(conflictWtDir, "precious.txt"), "utf8")).toBe(
          "do-not-delete",
        );

        // 6. Empty leftover worktree dir is cleaned via rmdir and succeeds
        const emptyWtDir = path.join(
          homeDir,
          ".openhuddle",
          "worktrees",
          reuseWs.id,
          "oh-empty-wt",
        );
        mkdirSync(emptyWtDir, { recursive: true });
        const emptyWtItem = await dispatchViaService({
          workspaceId: reuseWs.id,
          title: "Empty leftover worktree dir",
          brief: "Should remove empty leftover dir and create worktree",
          topology: "direct",
          tier: "worktree_write",
          worktreeBranch: "oh/empty-wt",
          primaryWorkerAgentId: w1.agent.id,
        });
        await waitStage(emptyWtItem.id, ["awaiting_review"]);

        // 7. Existing non-Git directory in worktree_pool NEVER gets git init
        const existingPlainDir = path.join(homeDir, "Developer", "existing-plain");
        mkdirSync(existingPlainDir, { recursive: true });
        writeFileSync(path.join(existingPlainDir, "notes.txt"), "keep\n");
        const plainGitWsRes = await app.request("/api/v1/workspaces", {
          method: "POST",
          headers,
          body: JSON.stringify({
            name: "Existing Plain",
            kind: "git_repo",
            roots: [{ localPath: "~/Developer/existing-plain" }],
            hostMode: "local_machine",
            sandboxMode: "worktree_pool",
          }),
        });
        const plainGitWs = ((await plainGitWsRes.json()) as SingleWorkspaceResponse).workspace;
        const plainItem = await dispatchViaService({
          workspaceId: plainGitWs.id,
          title: "Existing plain dir task",
          brief: "Must not run git init on existing non-git folder",
          topology: "direct",
          tier: "worktree_write",
          primaryWorkerAgentId: w1.agent.id,
        });
        await waitStage(plainItem.id, ["awaiting_review"]);
        expect(existsSync(path.join(existingPlainDir, ".git"))).toBe(false);

        const heartbeat = vi
          .spyOn(workspacesService, "heartbeatSlice")
          .mockRejectedValueOnce(
            new AppError({ code: "WORK_LEASE_EXPIRED", statusCode: 409, message: "Lease lost" }),
          );
        try {
          await dispatchViaService({
            workspaceId: cleanWs.id,
            title: "Lose lease",
            brief: "LOSE_LEASE",
            topology: "direct",
            tier: "worktree_write",
            primaryWorkerAgentId: w1.agent.id,
          });
          await vi.waitFor(() => expect(lostLeaseAborted).toBe(true), { timeout: 7000 });
        } finally {
          heartbeat.mockRestore();
        }
      } finally {
        await runner.stop();
        await stopServerAppBackgroundTasks(app);
      }
    },
  );
});
