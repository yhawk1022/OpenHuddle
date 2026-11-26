import { execFileSync } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type DeviceWorkInput,
  executeWorkSlice,
  recoverReviewPatch,
} from "../execute-work-slice.js";
import { OpenHuddleApiError } from "../http-client.js";
import { runWorkPrompt } from "../work-cli-process.js";

vi.mock("../work-cli-process.js", () => ({ runWorkPrompt: vi.fn() }));

const file = "artifact.txt";
const content = Array.from({ length: 510 }, (_, i) => `evidence line ${i + 1}\n`).join("");
let homeDir: string;
let repo: string;
let worktree: string;
let writer: DeviceWorkInput;

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" });
}

function asVerifier(
  loadReviewEvidence: NonNullable<DeviceWorkInput["loadReviewEvidence"]>,
): DeviceWorkInput {
  return {
    ...writer,
    slice: {
      ...writer.slice,
      sliceId: "slc_review" as typeof writer.slice.sliceId,
      leaseRole: "verify",
      status: "verifying",
    },
    loadReviewEvidence,
  };
}

describe("recovering review evidence across a listener upgrade", () => {
  beforeEach(async () => {
    homeDir = await mkdtemp(path.join(tmpdir(), "oh-evidence-recovery-"));
    repo = path.join(homeDir, "project");
    await mkdir(repo);
    const backing = path.join(homeDir, "backing-store");
    const alias = path.join(homeDir, "device-data");
    await mkdir(backing);
    await symlink(backing, alias, process.platform === "win32" ? "junction" : "dir");
    vi.stubEnv("OPENHUDDLE_HOME", alias);
    git("init", "-q");
    git(
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@localhost",
      "commit",
      "--allow-empty",
      "-qm",
      "seed",
    );
    const agent = {
      agentId: "agt_writer",
      platform: "codex",
      displayName: "Writer",
      ownerUserId: "usr_owner",
    };
    const slice = {
      sliceId: "slc_write",
      workItemId: "wrk_task",
      leaseRole: "write",
      assignedAgent: agent,
      title: "Write artifact",
      ownedPaths: ["**"],
      steerNotes: [],
      leaseVersion: 3,
      status: "running",
    };
    writer = {
      workspace: {
        id: "wsp_test",
        name: "project",
        ownerUserId: agent.ownerUserId,
        isOwnedByViewer: true,
        hostMode: "local_machine",
        roots: [{ name: "project", localPath: "~/project" }],
        sandboxMode: "worktree_pool",
        hooks: {},
      },
      item: {
        id: slice.workItemId,
        title: "Produce an artifact",
        brief: "Produce an artifact",
        ownerUserId: agent.ownerUserId,
        workspaceId: "wsp_test",
        tier: "worktree_write",
        topology: "verify_loop",
        worktreeBranch: "oh/evidence",
        slices: [slice],
        diffFiles: [],
      },
      slice,
      agent,
      homeDir,
      signal: new AbortController().signal,
    } as unknown as DeviceWorkInput;
    vi.mocked(runWorkPrompt).mockImplementationOnce(async (input) => {
      await writeFile(path.join(input.cwd, file), content);
      return "Wrote all 510 lines.";
    });
    // Model a pre-upgrade writer: it submitted the bounded preview but no evidence attachment.
    const done = await executeWorkSlice(writer);
    worktree = done.provenance?.workingDirectory ?? "";
    expect(worktree).toBeTruthy();
    writer.slice = { ...writer.slice, ...done, status: "ready", liveSummary: done.summary };
    writer.item = { ...writer.item, slices: [writer.slice], diffFiles: done.diffFiles ?? [] };
    expect(writer.item.diffFiles[0]?.lines.some((l) => l.content === "evidence line 510")).toBe(
      false,
    );
    vi.mocked(runWorkPrompt).mockClear();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.mocked(runWorkPrompt).mockReset();
    await rm(homeDir, { recursive: true, force: true });
  });

  it("recovers the complete patch from the writer's original Git worktree and resumes verification after a missing attachment", async () => {
    const responses = vi.fn<NonNullable<DeviceWorkInput["loadReviewEvidence"]>>();
    responses.mockRejectedValueOnce(
      new OpenHuddleApiError({ status: 404, code: "NOT_FOUND", message: "attachment missing" }),
    );
    await expect(executeWorkSlice(asVerifier(responses))).rejects.toThrow(
      `文件 ${file} 的变更证据不完整`,
    );
    expect(runWorkPrompt).not.toHaveBeenCalled();
    const patch = await recoverReviewPatch(writer);
    const canonical = await realpath(worktree);
    expect(canonical).not.toBe(worktree);
    const provenance = writer.slice.provenance;
    if (!provenance) throw new Error("missing original worktree receipt");
    const canonicalReceipt = {
      ...writer.slice,
      provenance: { ...provenance, workingDirectory: canonical },
    };
    expect(await recoverReviewPatch({ ...writer, slice: canonicalReceipt })).toBe(patch);
    expect(patch).toContain("+evidence line 510\n");
    expect(runWorkPrompt).not.toHaveBeenCalled();
    responses.mockResolvedValueOnce(patch);
    vi.mocked(runWorkPrompt).mockImplementationOnce(async (input) => {
      expect(input.prompt).toContain("+evidence line 510");
      expect(input.writable).toBe(false);
      return "Inspected the final line.\nVERDICT: PASSED";
    });
    expect(await executeWorkSlice(asVerifier(responses))).toMatchObject({ verdict: "passed" });
    expect(responses).toHaveBeenCalledTimes(2);
    expect(responses).toHaveBeenCalledWith(writer.slice);
    expect(git("status", "--porcelain")).toBe("");
  });

  it("rejects mismatched receipt paths and content, even when file names and line counts match", async () => {
    const original = writer.slice.provenance;
    if (!original) throw new Error("test writer returned no provenance");
    await expect(
      recoverReviewPatch({
        ...writer,
        slice: { ...writer.slice, provenance: { ...original, workingDirectory: repo } },
      }),
    ).rejects.toThrow("原执行回执路径不同");
    await writeFile(
      path.join(worktree, file),
      content.replace("evidence line 1\n", "altered line 1\n"),
    );
    await expect(recoverReviewPatch(writer)).rejects.toThrow("与原回执不匹配");
    expect(await readFile(path.join(worktree, file), "utf8")).toContain("altered line 1");
  });

  it("does not recreate a missing worktree or change the remaining worktree registrations", async () => {
    git("worktree", "remove", "--force", worktree);
    const before = git("worktree", "list", "--porcelain");
    await expect(recoverReviewPatch(writer)).rejects.toThrow("原工单工作树已不存在");
    await expect(access(worktree)).rejects.toMatchObject({ code: "ENOENT" });
    expect(git("worktree", "list", "--porcelain")).toBe(before);
  });

  it("preserves permission, server and transport failures for the caller with bounded transient retries", async () => {
    const forbidden = new OpenHuddleApiError({
      status: 403,
      code: "FORBIDDEN_WORKSPACE_ACCESS",
      message: "denied",
    });
    const readForbidden = vi.fn().mockRejectedValue(forbidden);
    await expect(executeWorkSlice({ ...asVerifier(readForbidden), retryDelayMs: 0 })).rejects.toBe(
      forbidden,
    );
    expect(readForbidden).toHaveBeenCalledOnce();

    for (const failure of [
      new OpenHuddleApiError({ status: 503, code: "INTERNAL_ERROR", message: "unavailable" }),
      new Error("connection reset"),
    ]) {
      const read = vi.fn().mockRejectedValue(failure);
      await expect(executeWorkSlice({ ...asVerifier(read), retryDelayMs: 0 })).rejects.toBe(
        failure,
      );
      expect(read).toHaveBeenCalledTimes(3);
    }

    const patch = await recoverReviewPatch(writer);
    const flakyRead = vi
      .fn<NonNullable<DeviceWorkInput["loadReviewEvidence"]>>()
      .mockRejectedValueOnce(
        new OpenHuddleApiError({ status: 503, code: "INTERNAL_ERROR", message: "unavailable" }),
      )
      .mockResolvedValueOnce(patch);
    vi.mocked(runWorkPrompt).mockResolvedValueOnce("Verified after retry.\nVERDICT: PASSED");
    expect(await executeWorkSlice({ ...asVerifier(flakyRead), retryDelayMs: 0 })).toMatchObject({
      verdict: "passed",
    });
    expect(flakyRead).toHaveBeenCalledTimes(2);
    expect(runWorkPrompt).toHaveBeenCalledOnce();
  });
});
