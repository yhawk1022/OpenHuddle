import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type DeviceWorkInput, executeWorkSlice } from "../execute-work-slice.js";

let homeDir: string;
let repo: string;
let bin: string;

function assignment(): DeviceWorkInput {
  const ownerId = "usr_owner";
  const agent = {
    agentId: "agt_1",
    platform: "codex",
    displayName: "Worker",
    ownerUserId: ownerId,
  };
  const slice = {
    sliceId: "slc_worker",
    workItemId: "wrk_task",
    leaseRole: "write",
    assignedAgent: agent,
    title: "Create index",
    ownedPaths: ["**"],
    steerNotes: [],
    changedFiles: [],
    status: "running",
  };
  return {
    workspace: {
      id: "wsp_test",
      name: "project",
      ownerUserId: ownerId,
      isOwnedByViewer: true,
      hostMode: "local_machine",
      roots: [{ id: "root", name: "project", localPath: "~/projects/project" }],
      sandboxMode: "worktree_pool",
      hooks: {},
    },
    item: {
      id: "wrk_task",
      title: "Test",
      brief: "Create an index",
      ownerUserId: ownerId,
      workspaceId: "wsp_test",
      tier: "worktree_write",
      topology: "verify_loop",
      worktreeBranch: "oh/test",
      slices: [slice],
      diffFiles: [],
    },
    slice,
    agent,
    homeDir,
    signal: new AbortController().signal,
  } as unknown as DeviceWorkInput;
}

function setRoot(task: DeviceWorkInput, localPath: string) {
  task.workspace.roots = task.workspace.roots.map((root) => ({ ...root, localPath }));
}

async function installCli(name: string, body: string) {
  const file = path.join(bin, name);
  await writeFile(file, `#!${process.execPath}\n${body}\n`);
  await chmod(file, 0o700);
}

describe.skipIf(process.platform === "win32")("owner device work execution", () => {
  beforeEach(async () => {
    homeDir = await mkdtemp(path.join(tmpdir(), "oh-executor-test-"));
    repo = path.join(homeDir, "projects", "project");
    bin = path.join(homeDir, "bin");
    await Promise.all([mkdir(bin), mkdir(repo, { recursive: true })]);
    vi.stubEnv("OPENHUDDLE_HOME", path.join(homeDir, ".openhuddle"));
    vi.stubEnv("PATH", bin + path.delimiter + process.env.PATH);
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(homeDir, { recursive: true, force: true });
  });
  it("captures the writer's actual worktree change and independently reviews its diff without a local checkout", async () => {
    execFileSync("git", ["init", "-q"], { cwd: repo });
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
        "seed",
      ],
      { cwd: repo },
    );
    await installCli(
      "codex",
      `
      const fs = require("node:fs");
      const args = process.argv.slice(2);
      if (!args.includes("workspace-write") || !fs.readFileSync(0,"utf8").includes("Create an index")) process.exit(9);
      fs.writeFileSync("打砖块.html", "<p>from worker</p>\\n");
      fs.writeFileSync(args[args.indexOf("-o")+1], "Created 打砖块.html");
    `,
    );
    const task = assignment();
    const written = await executeWorkSlice(task);
    expect(written.changedFiles).toEqual(["打砖块.html"]);
    expect(written.diffFiles?.[0]?.additions).toBe(1);
    await expect(readFile(path.join(repo, "打砖块.html"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(written.provenance?.sessionJsonlPath ?? "", "utf8")).toContain(
      "task_settled",
    );
    await installCli(
      "dsh",
      `
      const fs = require("node:fs");
      const prompt = fs.readFileSync(0,"utf8");
      if (process.env.DSH_PERMISSION_MODE !== "read-only" || !prompt.includes("+<p>from worker</p>")) process.exit(8);
      console.log("The resulting index contains the requested element.\\nVERDICT: PASSED");
    `,
    );
    setRoot(task, "~/unmounted");
    const completed = {
      ...task.slice,
      status: "ready" as const,
      changedFiles: written.changedFiles,
      liveSummary: written.summary,
    };
    task.slice = { ...task.slice, leaseRole: "verify" };
    task.agent = { displayName: "Reviewer", platform: "deepseek" };
    task.item.slices = [completed, task.slice];
    task.item.diffFiles = written.diffFiles ?? [];
    expect(await executeWorkSlice(task)).toMatchObject({ verdict: "passed", changedFiles: [] });
    task.item.diffFiles = [];
    await expect(executeWorkSlice(task)).rejects.toThrow("证据不完整");
  });
  it("leaves the original folder untouched when pooling cannot be honored, and rejects escaped and missing roots", async () => {
    const task = assignment();
    await expect(executeWorkSlice(task)).rejects.toThrow("Git 仓库根目录");
    setRoot(task, "~/missing");
    await expect(executeWorkSlice(task)).rejects.toThrow("此设备上找不到");
    await symlink(tmpdir(), path.join(repo, "outside"));
    setRoot(task, "~/projects/project/outside");
    await expect(executeWorkSlice(task)).rejects.toThrow("当前用户目录");
  });
  it("captures actual in-place writes and never reports empty writes or a guessed verdict", async () => {
    const task = assignment();
    task.workspace.sandboxMode = "in_place";
    await installCli(
      "dsh",
      `
      const fs = require("node:fs");
      fs.readFileSync(0, "utf8");
      if (process.env.DSH_PERMISSION_MODE !== "workspace-write") process.exit(2);
      fs.writeFileSync("index.js","exports.result = true;\\n");
      console.log("Created index.js");
    `,
    );
    task.agent.platform = "deepseek";
    const result = await executeWorkSlice(task);
    expect(result.diffFiles?.[0]?.path).toBe("index.js");
    expect(await readFile(path.join(repo, "index.js"), "utf8")).toContain("true");
    await expect(executeWorkSlice(task)).rejects.toThrow("未检测到");
    task.item.slices = [
      {
        ...task.slice,
        status: "ready",
        liveSummary: "Created index.js",
        changedFiles: ["index.js"],
      },
    ];
    task.item.diffFiles = result.diffFiles ?? [];
    task.slice = { ...task.slice, leaseRole: "verify" };
    await installCli("dsh", "console.log('probably OK');");
    await expect(executeWorkSlice(task)).rejects.toThrow("未返回明确的结论和证据");
  });
});
