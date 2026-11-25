import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  collectWorkingTreeDiff,
  diffPlainFolderSnapshots,
} from "@openhuddle/core-governance/workspace-diff";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type DeviceWorkInput, executeWorkSlice } from "../execute-work-slice.js";
import { OpenHuddleApiError } from "../http-client.js";
import { materializeReviewFiles } from "../review-files.js";
import { runWorkPrompt } from "../work-cli-process.js";

vi.mock("../work-cli-process.js", () => ({ runWorkPrompt: vi.fn() }));
let home: string;
let review: string;
const regular = "src/游戏.js";
const original = Buffer.from("console.log(1);\r\nconsole.log('🧱');\nEND");
const hash = (data: Buffer) => createHash("sha256").update(data).digest("hex");
beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "oh-materialize-test-"));
  review = path.join(home, "review");
  await mkdir(review);
  vi.stubEnv("OPENHUDDLE_HOME", path.join(home, "openhuddle-data"));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.mocked(runWorkPrompt).mockReset();
  await rm(home, { recursive: true, force: true });
});

it("reconstructs the exact Git blob while retaining edits to existing files as patch evidence", async () => {
  const repo = path.join(home, "git");
  await mkdir(repo);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo });
  git("init", "-q");
  git("config", "core.autocrlf", "false");
  await writeFile(path.join(repo, "existing.txt"), "old\n");
  git("add", "existing.txt");
  git("-c", "user.name=t", "-c", "user.email=t@localhost", "commit", "-qm", "base");
  await writeFile(path.join(repo, "existing.txt"), "changed\n");
  await mkdir(path.join(repo, "src"));
  await writeFile(path.join(repo, regular), original, { mode: 0o755 });
  await writeFile(path.join(repo, "empty.txt"), "");
  const diff = await collectWorkingTreeDiff(repo, true);
  expect(diff.reviewPatch).toContain("\\ No newline at end of file");
  const manifests = await materializeReviewFiles(review, [
    { sliceId: "slc_git", changedFiles: diff.changedFiles, patch: diff.reviewPatch ?? "" },
  ]);
  expect(manifests).toContainEqual({
    path: "empty.txt",
    sliceId: "slc_git",
    bytes: 0,
    sha256: hash(Buffer.alloc(0)),
  });
  expect(manifests.filter((entry) => entry.path === regular)).toEqual([
    { path: regular, sliceId: "slc_git", bytes: original.length, sha256: hash(original) },
  ]);
  expect(await readFile(path.join(review, regular))).toEqual(original);
  if (process.platform !== "win32")
    expect((await stat(path.join(review, regular))).mode & 0o111).toBe(0);
  await expect(access(path.join(review, "existing.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(diff.reviewPatch).toContain("+changed");
});

it("retains file-folder snapshot EOF, checks blob integrity, and skips colliding writer receipts and unsafe file records", async () => {
  const make = (name: string, value: string) =>
    diffPlainFolderSnapshots(new Map(), new Map([[name, value]]), true).reviewPatch ?? "";
  const a = make("a.txt", "A\n");
  const b = make("nested/b.txt", "B\r\n");
  const c = make("c.txt", "C");
  const patch = [
    a,
    b,
    c,
    make("empty", ""),
    make("../out.txt", "bad"),
    make("link", "elsewhere").replace("new file mode 100644", "new file mode 120000"),
    make("tampered", "initial").replace("+initial", "+altered"),
  ].join("");
  const files = await materializeReviewFiles(review, [
    {
      sliceId: "first",
      patch,
      changedFiles: ["a.txt", "nested/b.txt", "c.txt", "empty", "../out.txt", "link", "tampered"],
    },
    { sliceId: "other", changedFiles: ["a.txt"], patch: a },
  ]);
  expect(files.map((f) => f.path).sort()).toEqual(["c.txt", "empty", "nested/b.txt"]);
  expect(await readFile(path.join(review, "nested/b.txt"), "utf8")).toBe("B\r\n");
  expect(await readFile(path.join(review, "c.txt"), "utf8")).toBe("C");
  expect(await readFile(path.join(review, "empty"), "utf8")).toBe("");
  await expect(access(path.join(home, "out.txt"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("exposes files and provenance to an independent verifier, retains legacy preview-only evidence on 404, and cleans up", async () => {
  const diff = diffPlainFolderSnapshots(new Map(), new Map([[regular, original.toString()]]), true);
  const ownerUserId = "usr_owner";
  const agent = {
    agentId: "agt_review",
    ownerUserId,
    platform: "deepseek",
    displayName: "Reviewer",
  };
  const writer = {
    sliceId: "slc_writer",
    leaseRole: "write",
    status: "ready",
    changedFiles: [regular],
    liveSummary: "Wrote artifact.",
  };
  const verifier = {
    sliceId: "slc_review",
    assignedAgent: agent,
    workItemId: "wrk_test",
    leaseRole: "verify",
    title: "Review",
    ownedPaths: ["**"],
    steerNotes: [],
    leaseVersion: 1,
  };
  const input = {
    item: {
      id: "wrk_test",
      workspaceId: "wsp_test",
      title: "Deliver program",
      brief: "Review the program",
      ownerUserId,
      slices: [writer],
      diffFiles: diff.diffFiles,
    },
    workspace: {
      id: "wsp_test",
      isOwnedByViewer: true,
      ownerUserId,
      hostMode: "local_machine",
      hooks: {},
      name: "project",
    },
    slice: verifier,
    agent,
    homeDir: home,
    signal: new AbortController().signal,
    loadReviewEvidence: async () => diff.reviewPatch,
  } as unknown as DeviceWorkInput;
  let used = "";
  vi.mocked(runWorkPrompt).mockImplementationOnce(async (p) => {
    used = p.cwd;
    expect(p.writable).toBe(false);
    expect(await readFile(path.join(used, regular))).toEqual(original);
    expect(p.prompt).toContain(hash(original));
    expect(p.prompt).toContain("slc_writer");
    expect(p.prompt).toContain("separate review device");
    return "Inspected the submitted files.\nVERDICT: PASSED";
  });
  expect(await executeWorkSlice(input)).toMatchObject({ verdict: "passed" });
  await expect(access(used)).rejects.toMatchObject({ code: "ENOENT" });
  input.loadReviewEvidence = async () => {
    throw new OpenHuddleApiError({
      status: 404,
      code: "NOT_FOUND",
      message: "old attachment unavailable",
    });
  };
  vi.mocked(runWorkPrompt).mockImplementationOnce(async (p) => {
    expect(await readdir(p.cwd)).toEqual([]);
    expect(p.prompt).toContain("+END");
    expect(p.prompt).toContain(regular);
    return "Static-only review.\nVERDICT: CHANGES_REQUESTED";
  });
  expect(await executeWorkSlice(input)).toMatchObject({ verdict: "changes_requested" });
});
