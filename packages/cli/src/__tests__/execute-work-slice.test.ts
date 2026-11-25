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
    await expect(executeWorkSlice(task)).rejects.toThrow(/不完整|缺少.*完整/);
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
  it.each([
    ["deepseek", "dsh"],
    ["claude_code", "claude"],
  ] as const)(
    "accepts an explicit stop before %s tries to settle or apply files",
    async (platform, binary) => {
      const task = assignment();
      task.workspace.sandboxMode = "in_place";
      task.agent.platform = platform;
      const question = "本轮缺少验收目标，要验证哪个版本？";
      const options = ["验证移动版", "验证桌面版"];
      const stopReceipt = `NEEDS_INPUT: ${JSON.stringify({ question, options })}`;
      await installCli(
        binary,
        `
      const prompt = require("node:fs").readFileSync(0, "utf8");
      if (!prompt.includes("Choose your own completion and stopping criteria")) process.exit(8);
      console.log(${JSON.stringify(stopReceipt)});
    `,
      );
      await expect(executeWorkSlice(task)).rejects.toMatchObject({
        attention: { question, options },
      });
    },
  );
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
  it.each([
    ["claude_code", "claude"],
    ["gemini", "gemini"],
    ["antigravity", "agy"],
  ] as const)(
    "applies and independently verifies a real file for %s with its local tools disabled",
    async (platform, binary) => {
      const task = assignment();
      task.workspace.sandboxMode = "in_place";
      // The account may use a different public agent platform and a known local preset.
      task.agent.platform = "cursor";
      task.runner = { kind: "preset", preset: platform };
      await writeFile(path.join(repo, "keep.txt"), "before\n");
      await installCli(
        binary,
        `
      const fs=require("node:fs");
      const args=process.argv.slice(2);
      const has=(...xs)=>xs.every(x=>args.includes(x));
      const platform=${JSON.stringify(platform)};
      if (fs.existsSync("keep.txt")) throw Error("model was started in the real workspace");
      if (platform==="claude_code" && !(has("--safe-mode","--strict-mcp-config") && args[args.indexOf("--tools")+1]==="")) process.exit(7);
      if (platform==="gemini" && !(has("--policy","--admin-policy","--skip-trust") && fs.readFileSync(args[args.indexOf("--admin-policy")+1],"utf8").includes('decision = "deny"'))) process.exit(7);
      if (platform==="antigravity" && !(has("--sandbox","--input-format","stream-json") && JSON.parse(args[args.indexOf("--settings")+1]).permissions.deny.includes("command(*)"))) process.exit(7);
      const raw=fs.readFileSync(0,"utf8");const prompt=platform==="antigravity"?JSON.parse(raw).message.content:raw;
      const text=prompt.includes("independent static review") ? "Reviewed keep.txt and artifact.txt.\\nVERDICT: PASSED" :
        JSON.stringify({summary:"Created artifact.txt",files:[{path:"artifact.txt",content:"proof\\n"},{path:"keep.txt",content:"updated\\n"}]});
      console.log(platform==="antigravity" ? JSON.stringify({event:"result",result:{status:"SUCCESS",response:text}}) : text);
    `,
      );
      const written = await executeWorkSlice(task);
      expect(written.changedFiles).toEqual(["artifact.txt", "keep.txt"]);
      expect(await readFile(path.join(repo, "keep.txt"), "utf8")).toBe("updated\n");
      expect(written.provenance?.agentEnvironment).toBe(`device:${platform}`);
      task.item.slices = [
        {
          ...task.slice,
          status: "ready",
          changedFiles: written.changedFiles,
          liveSummary: written.summary,
        },
      ];
      task.item.diffFiles = written.diffFiles ?? [];
      task.slice = { ...task.slice, leaseRole: "verify" };
      expect(await executeWorkSlice(task)).toMatchObject({ verdict: "passed" });
    },
  );
  it("validates all proposed edits before changing any file", async () => {
    const task = assignment();
    task.workspace.sandboxMode = "in_place";
    task.runner = { kind: "preset", preset: "gemini" };
    await writeFile(path.join(repo, "keep.txt"), "unchanged");
    await installCli(
      "gemini",
      'console.log(JSON.stringify({summary:"edit",files:[{path:"keep.txt",content:"changed"},{path:".git/config",content:"forbidden"}]}))',
    );
    await expect(executeWorkSlice(task)).rejects.toThrow("无效的文件变更");
    expect(await readFile(path.join(repo, "keep.txt"), "utf8")).toBe("unchanged");
  });
});
